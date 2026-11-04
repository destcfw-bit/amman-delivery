require('dotenv').config();
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const path = require('path');
const multer = require('multer');
const crypto = require('crypto');
const { pool, initDb } = require('./db');
const { translate: translateDropcode } = require('./dropcode-events');
const { dedupKey, normalizePhone } = require('./utils');
const { reconcilePendingClaimsForPhone, enqueueSheetSync } = require('./accounting');
const { wahaConfig, wahaRequest, normalizeWahaWebhook, ensureWahaSession, getWahaSessionStatus, getWahaGroupParticipants, getDropcodeContactNames, downloadWahaMedia, getWahaMessageById, sendWahaText } = require('./waha');

const app = express();
const SITE_MODE=String(process.env.SITE_MODE||'all').trim().toLowerCase();
app.set('trust proxy',1);
app.use(helmet({contentSecurityPolicy:false}));
app.use(cors());
app.use(express.json({limit:'2mb',verify:(req,res,buf)=>{if(req.path==='/webhooks/dropcode'||req.path==='/webhooks/waha')req.rawWebhookBody=Buffer.from(buf);}}));
const upload=multer({storage:multer.memoryStorage(),limits:{fileSize:6*1024*1024},fileFilter:(req,file,cb)=>cb(null,/^image\//i.test(file.mimetype))});
const registrationUploadEngine=multer({storage:multer.memoryStorage(),limits:{fileSize:6*1024*1024,files:3},fileFilter:(req,file,cb)=>cb(null,/^image\/(jpeg|jpg|png|webp|heic|heif)$/i.test(file.mimetype))});
const registrationFields=registrationUploadEngine.fields([{name:'identity',maxCount:1},{name:'vehicle_license',maxCount:1},{name:'payment_proof',maxCount:1}]);
function registrationUpload(req,res,next){registrationFields(req,res,err=>{if(!err)return next();if(err instanceof multer.MulterError&&err.code==='LIMIT_FILE_SIZE')return res.status(413).json({ok:false,error:'FILE_TOO_LARGE'});return res.status(400).json({ok:false,error:'INVALID_UPLOAD'});});}
app.use(express.static(path.join(__dirname,'..','public'),{index:false}));


function ammanOrderNumber(name=''){
  const m=String(name||'').match(/\bT\s*0*(\d+)\b/i);return m?Number(m[1]):Number.MAX_SAFE_INTEGER;
}
function normalizeCaptainName(name=''){
  return String(name||'').trim().replace(/\s+/g,' ').toLocaleLowerCase('ar');
}
async function reconcileForPhones(phones=[]){
  const c=await pool.connect();
  try{await c.query('BEGIN');let total=0;for(const phone of [...new Set(phones.filter(Boolean))])total+=await reconcilePendingClaimsForPhone(c,phone);await c.query('COMMIT');return total}
  catch(e){await c.query('ROLLBACK');throw e}finally{c.release()}
}
async function cleanupStaleWaitingClaims(){
  const c=await pool.connect();
  try{
    await c.query('BEGIN');
    const q=await c.query(`SELECT id,group_id,reply_message_id FROM claims c WHERE c.status='waiting' AND c.current_reaction IS NULL AND c.created_at < now()-interval '24 hours' AND NOT EXISTS(SELECT 1 FROM movements m WHERE m.claim_id=c.id) FOR UPDATE`);
    if(q.rowCount){
      const ids=q.rows.map(x=>x.id);
      await c.query(`DELETE FROM reaction_log WHERE claim_id=ANY($1::bigint[])`,[ids]);
      await c.query(`DELETE FROM claims WHERE id=ANY($1::bigint[])`,[ids]);
      for(const x of q.rows){await c.query(`DELETE FROM whatsapp_messages w WHERE w.group_id=$1 AND w.message_id=$2 AND NOT EXISTS(SELECT 1 FROM claims c WHERE c.group_id=w.group_id AND (c.original_message_id=w.message_id OR c.reply_message_id=w.message_id))`,[x.group_id,x.reply_message_id]);}
      await c.query(`INSERT INTO audit_log(action,details) VALUES('STALE_WAITING_CLAIMS_DELETED',$1)`,[{count:q.rowCount,hours:24}]);
    }
    await c.query('COMMIT');return q.rowCount;
  }catch(e){await c.query('ROLLBACK');throw e}finally{c.release()}
}

function signAdmin() {
  return jwt.sign({role:'admin'},process.env.JWT_SECRET,{expiresIn:'12h'});
}
function auth(req,res,next){
  const h=req.headers.authorization||'';
  try{
    const t=h.startsWith('Bearer ')?h.slice(7):'';
    req.user=jwt.verify(t,process.env.JWT_SECRET); if(req.user.role!=='admin')return res.status(403).json({ok:false,error:'ADMIN_ONLY'}); next();
  }catch(e){res.status(401).json({ok:false,error:'UNAUTHORIZED'});}
}

function signCaptain(phone){
  return jwt.sign({role:'captain',phone},process.env.JWT_SECRET,{expiresIn:'30d'});
}
async function captainAuth(req,res,next){
  const h=req.headers.authorization||'';
  try{
    const t=h.startsWith('Bearer ')?h.slice(7):'';
    const u=jwt.verify(t,process.env.JWT_SECRET);
    if(u.role!=='captain'||!u.phone) throw new Error('CAPTAIN_ONLY');
    const q=await pool.query(`SELECT sessions_invalidated_at FROM captains WHERE phone=$1`,[u.phone]);
    if(!q.rowCount) throw new Error('CAPTAIN_NOT_FOUND');
    const cut=q.rows[0].sessions_invalidated_at;
    if(cut && Number(u.iat||0)*1000 <= new Date(cut).getTime()) throw new Error('SESSION_REVOKED');
    req.user=u; next();
  }catch(e){res.status(401).json({ok:false,error:'CAPTAIN_UNAUTHORIZED'});}
}
function captainRouteAuth(req,res,next){
  captainAuth(req,res,()=>{
    const p=normalizePhone(req.params.phone||'');
    if(p!==req.user.phone)return res.status(403).json({ok:false,error:'CAPTAIN_FORBIDDEN'});
    captainReady(req,res,next);
  });
}
async function captainReady(req,res,next){
  try{
    const q=await pool.query(`SELECT onboarding_completed,password_changed,payment_method FROM captains WHERE phone=$1`,[req.user.phone]);
    if(!q.rowCount)return res.status(404).json({ok:false,error:'CAPTAIN_NOT_FOUND'});
    const x=q.rows[0];
    if(!x.onboarding_completed||!x.password_changed||!x.payment_method)return res.status(403).json({ok:false,error:'ONBOARDING_REQUIRED'});
    next();
  }catch(e){res.status(500).json({ok:false,error:'CAPTAIN_READY_CHECK_FAILED'});}
}
function passwordKey(){
  return crypto.createHash('sha256').update(String(process.env.CAPTAIN_PASSWORD_KEY||process.env.JWT_SECRET||'amman-delivery')).digest();
}
function encryptCaptainPassword(clear){
  const iv=crypto.randomBytes(12), cipher=crypto.createCipheriv('aes-256-gcm',passwordKey(),iv);
  const enc=Buffer.concat([cipher.update(String(clear),'utf8'),cipher.final()]);
  return {cipher:enc.toString('base64'),iv:iv.toString('base64'),tag:cipher.getAuthTag().toString('base64')};
}
function decryptCaptainPassword(row){
  if(row.password_cipher&&row.password_iv&&row.password_tag){
    const d=crypto.createDecipheriv('aes-256-gcm',passwordKey(),Buffer.from(row.password_iv,'base64'));
    d.setAuthTag(Buffer.from(row.password_tag,'base64'));
    return Buffer.concat([d.update(Buffer.from(row.password_cipher,'base64')),d.final()]).toString('utf8');
  }
  return String(row.password||'123456');
}
async function ensureCaptainPasswordSecret(client,row){
  if(row.password_cipher&&row.password_iv&&row.password_tag)return row;
  const clear=String(row.password||'123456'), e=encryptCaptainPassword(clear);
  await client.query(`UPDATE captains SET password_cipher=$2,password_iv=$3,password_tag=$4,password='[encrypted]',updated_at=now() WHERE phone=$1`,[row.phone,e.cipher,e.iv,e.tag]);
  return {...row,password_cipher:e.cipher,password_iv:e.iv,password_tag:e.tag,password:'[encrypted]'};
}
async function setCaptainPassword(client,phone,clear,{changed=true}={}){
  const e=encryptCaptainPassword(clear);
  await client.query(`UPDATE captains SET password_cipher=$2,password_iv=$3,password_tag=$4,password='[encrypted]',password_changed=$5,updated_at=now() WHERE phone=$1`,[phone,e.cipher,e.iv,e.tag,!!changed]);
}

function captainAutoName(phone,whatsappName=''){
  const p=normalizePhone(phone);
  const local=/^9627\d{8}$/.test(p)?('0'+p.slice(3)):p;
  const n=String(whatsappName||'').trim().replace(/\s+/g,' ').slice(0,120);
  return n||`كابتن ${local}`;
}
let autoGroupSyncRunning=false;

// Re-identify recordings received before the DropConnect media adapter update.
// This is read-only and never changes accounting rows or commission calculations.
async function reidentifyLegacyMedia(row){
  const cfg=wahaConfig();
  const mid=String(row.original_stored_message_id||row.original_message_id||'');
  const groupId=String(row.group_id||'');
  if(!cfg.baseUrl||!mid||!groupId)return row;
  try{
    const qs=new URLSearchParams({session:cfg.session,groupId,messageId:mid,limit:'1'});
    const data=await wahaRequest('/api/search/messages?'+qs.toString(),{timeout:3500});
    const entry=(data?.results||[]).find(x=>
      String(x?.unified?.message?.id||x?.payload?.id||'')===mid &&
      String(x?.unified?.group?.id||x?.payload?.chatId||'')===groupId
    );
    const msg=entry?.unified?.message||{};
    const media=msg.media||entry?.payload?.media||{};
    const kind=String(msg.type||media.type||'').toLowerCase();
    const mime=String(media.mimetype||media.mimeType||'').toLowerCase();
    const isAudio=/audio|voice|ptt/.test(kind)||mime.startsWith('audio/');
    const isImage=/image/.test(kind)||mime.startsWith('image/');
    const isVideo=/video/.test(kind)||mime.startsWith('video/');
    if(!isAudio&&!isImage&&!isVideo)return row;
    const typeMessage=isAudio?'audioMessage':isImage?'imageMessage':'videoMessage';
    const old=row.original_raw||{};
    return {...row,original_type:typeMessage,media_mime:mime,
      original_raw:{...old,messageData:{...old.messageData,typeMessage,
        fileMessageData:{...(old.messageData?.fileMessageData||{}),
          downloadUrl:String(media.url||''),mimeType:mime}}}};
  }catch(e){
    console.warn('Legacy media metadata lookup unavailable:',e.message);
    return row;
  }
}
async function recoverWhatsappMedia(groupId,messageId){
  const gid=String(groupId||'').trim(),mid=String(messageId||'').trim();
  if(!gid||!mid)return null;
  let q=await pool.query(`SELECT * FROM whatsapp_media WHERE group_id=$1 AND message_id=$2 LIMIT 1`,[gid,mid]);
  if(q.rowCount)return q.rows[0];
  try{
    let media={};
    // DropConnect's native engine exposes indexed media through search/events,
    // not the legacy WAHA single-message endpoint.
    if(process.env.DROPCODE_API_URL){
      const cfg=wahaConfig();
      const params=new URLSearchParams({session:cfg.session,groupId:gid,messageId:mid,limit:'1'});
      const found=await wahaRequest('/api/search/messages?'+params.toString(),{timeout:10000});
      const entry=(found?.results||[]).find(x=>
        String(x?.unified?.message?.id||x?.payload?.id||'')===mid &&
        String(x?.unified?.group?.id||x?.payload?.chatId||'')===gid
      );
      media=entry?.unified?.message?.media||entry?.payload?.media||{};
    }else{
      const msg=await getWahaMessageById(gid,mid,{downloadMedia:true});
      media=msg?.media||{};
    }
    const url=String(media.url||'').trim();
    if(!url)return null;
    const d=await downloadWahaMedia(url,{timeout:15000,maxBytes:16*1024*1024});
    const mime=String(media.mimetype||media.mimeType||d.mimeType||'application/octet-stream').slice(0,160);
    const fileName=String(media.filename||media.fileName||'').slice(0,255);
    q=await pool.query(`
      INSERT INTO whatsapp_media(group_id,message_id,mime_type,file_name,file_data,source_url,updated_at)
      VALUES($1,$2,$3,$4,$5,$6,now())
      ON CONFLICT(group_id,message_id) DO UPDATE SET
        mime_type=EXCLUDED.mime_type,file_name=EXCLUDED.file_name,file_data=EXCLUDED.file_data,source_url=EXCLUDED.source_url,updated_at=now()
      RETURNING *
    `,[gid,mid,mime,fileName,d.buffer,url]);
    return q.rows[0]||null;
  }catch(e){
    console.warn('WAHA MEDIA RECOVERY FAILED',gid,mid,e.message);
    return null;
  }
}

async function setCaptainPresenceFromPhones(present,source='WAHA_AUTO'){
  const caps=await pool.query(`SELECT phone,active FROM captains`);
  let activated=0,stopped=0,changed=0;
  for(const cap of caps.rows){
    const isPresent=present.has(cap.phone);
    if(isPresent)activated++;else stopped++;
    if(Boolean(cap.active)!==isPresent)changed++;
    await pool.query(`
      UPDATE captains
      SET active=$2,
          status_reason=$3,
          status_checked_at=now(),
          last_group_seen_at=CASE WHEN $2 THEN now() ELSE last_group_seen_at END,
          updated_at=now()
      WHERE phone=$1
    `,[cap.phone,isPresent,isPresent?'موجود في قروب معتمد':'غير موجود في القروبات المعتمدة']);
  }
  if(changed)await audit('AUTO_GROUP_PRESENCE_SYNC',{source,activated,stopped,changed}).catch(()=>{});
  return {activated,stopped,changed};
}

// Restore actual WhatsApp names only for auto-created placeholder captains.
async function refreshCaptainWhatsappNames(){
  const cfg=wahaConfig();
  if(!cfg.baseUrl)throw new Error('DROPCODE_API_URL_MISSING');
  const cached=await getDropcodeContactNames().catch(e=>{console.warn('DropConnect names unavailable',e.message);return new Map();});
  const rows=await pool.query("SELECT phone,name FROM captains WHERE name LIKE 'كابتن %' OR name=phone OR COALESCE(name,'')=''");
  let updated=0,unavailable=0;
  for(const row of rows.rows){
    const phone=normalizePhone(row.phone);
    const placeholder=String(row.name||'').trim();
    if(placeholder && placeholder!==phone && !/^كابتن\s+0?7\d{8}$/u.test(placeholder))continue;
    let name=cached.get(phone)||'';
    if(!name){
      const q=await pool.query("SELECT sender_name FROM whatsapp_messages WHERE sender_phone=$1 AND NULLIF(TRIM(sender_name),'') IS NOT NULL ORDER BY created_at DESC LIMIT 1",[phone]);
      name=String(q.rows[0]?.sender_name||'').trim().slice(0,120);
    }
    if(!name || name===phone || /^كابتن\s+0?7\d{8}$/u.test(name)){unavailable++;continue;}
    const result=await pool.query("UPDATE captains SET name=$2,whatsapp_name=$2,whatsapp_name_updated_at=now(),updated_at=now() WHERE phone=$1 AND (name=$3 OR name=phone)",[phone,name,row.name]);
    updated+=result.rowCount;
  }
  return {checked:rows.rowCount,updated,unavailable,contact_names:cached.size};
}
async function registerResolvedGroupMembers(members=[],source='WAHA_AUTO'){
  const unique=new Map();
  for(const m of members||[]){
    const phone=normalizePhone(m?.phone||m||'');
    if(!phone)continue;
    const name=String(m?.name||'').trim().replace(/\s+/g,' ').slice(0,120);
    if(!unique.has(phone)||(!unique.get(phone).name&&name))unique.set(phone,{phone,name});
  }
  let created=0,updated=0;const createdPhones=[];
  for(const {phone,name} of unique.values()){
    const chosen=captainAutoName(phone,name);
    const ins=await pool.query(`
      INSERT INTO captains(
        name,phone,password,active,onboarding_completed,password_changed,
        status_reason,status_checked_at,last_group_seen_at,whatsapp_name,whatsapp_name_updated_at
      )
      VALUES(
        $1,$2,'[encrypted]',true,false,false,
        'تسجيل تلقائي من قروب واتساب',now(),now(),NULLIF($3,''),CASE WHEN NULLIF($3,'') IS NOT NULL THEN now() END
      )
      ON CONFLICT(phone) DO NOTHING
      RETURNING phone
    `,[chosen,phone,name]);
    if(ins.rowCount){
      await setCaptainPassword(pool,phone,'123456',{changed:false});
      created++;createdPhones.push(phone);
    }else{
      let newName=null;
      if(name){
        const cur=await pool.query(`SELECT name FROM captains WHERE phone=$1 LIMIT 1`,[phone]);
        const currentName=String(cur.rows[0]?.name||'').trim();
        const placeholder=/^كابتن\s+0?7\d{8}$/u.test(currentName)||currentName===phone||!currentName;
        if(placeholder)newName=chosen;
      }
      await pool.query(`
        UPDATE captains
        SET name=COALESCE($2,name),
            whatsapp_name=COALESCE(NULLIF($3,''),whatsapp_name),
            whatsapp_name_updated_at=CASE WHEN NULLIF($3,'') IS NOT NULL THEN now() ELSE whatsapp_name_updated_at END,
            active=true,
            status_reason='موجود في قروب معتمد',
            status_checked_at=now(),
            last_group_seen_at=now(),
            updated_at=now()
        WHERE phone=$1
      `,[phone,newName,name]);
      updated++;
    }
  }
  const reconciled=createdPhones.length?await reconcileForPhones(createdPhones):0;
  if(created||updated)await audit('AUTO_GROUP_CAPTAINS_SYNC',{source,created,updated,reconciled,total:unique.size}).catch(()=>{});
  return {created,updated,reconciled,total:unique.size,phones:[...unique.keys()]};
}
async function syncActiveWahaGroupCaptains({source='WAHA_AUTO'}={}){
  if(autoGroupSyncRunning)return {skipped:true,reason:'ALREADY_RUNNING'};
  autoGroupSyncRunning=true;
  try{
    if(String(process.env.WHATSAPP_PROVIDER||'dropcode').trim().toLowerCase()!=='waha')return {skipped:true,reason:'PROVIDER_NOT_WAHA'};
    const groups=await pool.query(`SELECT group_id,name,active,auto_register_members FROM groups WHERE active=true ORDER BY id`);
    if(!groups.rowCount)return {created:0,updated:0,reconciled:0,total:0,groups:0};
    const present=new Set(),registerMembers=new Map(),details=[];
    for(const group of groups.rows){
      const data=await getWahaGroupParticipants(group.group_id,pool);
      for(const m of (data.members||data.phones.map(phone=>({phone,name:''})))){
        const phone=normalizePhone(m?.phone||''); if(!phone)continue;
        present.add(phone);
        if(group.auto_register_members && (!registerMembers.has(phone)||(!registerMembers.get(phone).name&&m?.name))){
          registerMembers.set(phone,{phone,name:String(m?.name||'')});
        }
      }
      details.push({group_id:group.group_id,name:group.name||data.name||'',participants:data.total,auto_register_members:!!group.auto_register_members,lids_resolved:data.lidsResolved,lids_unresolved:data.lidsUnresolved});
    }
    const result=await registerResolvedGroupMembers([...registerMembers.values()],source);
    const presence=await setCaptainPresenceFromPhones(present,source);
    return {...result,...presence,groups:groups.rowCount,details};
  }finally{autoGroupSyncRunning=false}
}

async function getSystemTransferSettings(client=pool){
  const q=await client.query(`SELECT method_name,account_name,account_number,note,updated_at FROM system_transfer_settings WHERE id=1`);
  return q.rows[0]||{method_name:'',account_name:'',account_number:'',note:'',updated_at:null};
}

async function notifyCaptain(client,phone,kind,title,body='',metadata={}){
  try{await client.query(`INSERT INTO captain_notifications(captain_phone,kind,title,body,metadata) VALUES($1,$2,$3,$4,$5)`,[phone,kind,title,body,metadata]);}catch(e){console.error('CAPTAIN NOTIFICATION ERROR',e.message)}
}

async function sendGreenWhatsAppText(phone,message){
  const cfg=greenConfig();
  if(!cfg.apiUrl||!cfg.id||!cfg.token) throw new Error('GREEN_API_NOT_CONFIGURED');
  const chatId=`${normalizePhone(phone)}@c.us`;
  const url=`${cfg.apiUrl}/waInstance${cfg.id}/sendMessage/${cfg.token}`;
  const r=await fetch(url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({chatId,message})});
  const text=await r.text(); let json={}; try{json=JSON.parse(text)}catch{}
  if(!r.ok||json.error||json.messageData?.error) throw new Error(`GREEN_SEND_FAILED_${r.status}`);
  return json;
}
async function sendWhatsAppText(phone,message){
  const provider=String(process.env.WHATSAPP_PROVIDER||'dropcode').trim().toLowerCase();
  if(provider==='dropcode') return sendWahaText(phone,message);
  return sendGreenWhatsAppText(phone,message);
}


async function audit(action,details={}){
  try{ await pool.query(`INSERT INTO audit_log(action,details) VALUES($1,$2)`,[action,details]); }catch(e){ console.error('AUDIT ERROR',e); }
}
async function getOpenWeek(client=pool){
  let r=await client.query(`SELECT * FROM accounting_weeks WHERE status='open' ORDER BY id DESC LIMIT 1`);
  if(!r.rowCount) r=await client.query(`INSERT INTO accounting_weeks(starts_at,status) VALUES(now(),'open') RETURNING *`);
  return r.rows[0];
}
async function ensureOldBalanceCarry(client,weekId){
  const wq=await client.query(`SELECT id,status FROM accounting_weeks WHERE id=$1 LIMIT 1`,[weekId]);
  if(!wq.rowCount||wq.rows[0].status!=='open')return 0;
  const prev=await client.query(`SELECT id FROM accounting_weeks WHERE status='closed' AND id<$1 ORDER BY id DESC LIMIT 1`,[weekId]);
  if(!prev.rowCount)return 0;
  const ins=await client.query(`INSERT INTO weekly_charges(week_id,captain_phone,charge_type,amount,note,source_settlement_id)
    SELECT $1,s.captain_phone,'old_balance',ABS(s.net),$3,s.id
    FROM weekly_settlements s
    WHERE s.week_id=$2 AND s.net<0 AND s.status NOT IN ('settled','carried_forward')
    ON CONFLICT DO NOTHING
    RETURNING id`,[weekId,prev.rows[0].id,`رصيد قديم من الأسبوع #${prev.rows[0].id}`]);
  return ins.rowCount;
}

async function weeklyRows(weekId){
  await ensureOldBalanceCarry(pool,weekId);
  const r=await pool.query(`
    WITH mov AS (
      SELECT c.phone,
        COALESCE(SUM(CASE WHEN m.status='active' AND m.direction='production' THEN m.amount ELSE 0 END),0) production,
        COALESCE(SUM(CASE WHEN m.status='active' AND m.direction='consumption' THEN m.amount ELSE 0 END),0) consumption
      FROM captains c
      LEFT JOIN claims cl ON cl.week_id=$1
      LEFT JOIN movements m ON m.claim_id=cl.id AND m.captain_phone=c.phone
      GROUP BY c.phone
    ), manual AS (
      SELECT captain_phone,
        COALESCE(SUM(CASE WHEN direction='production' THEN amount ELSE 0 END),0) production_manual,
        COALESCE(SUM(CASE WHEN direction='consumption' THEN amount ELSE 0 END),0) consumption_manual
      FROM manual_movements WHERE week_id=$1 GROUP BY captain_phone
    ), adj AS (
      SELECT captain_phone,
        COALESCE(SUM(CASE WHEN direction='production' THEN amount ELSE 0 END),0) production_adj,
        COALESCE(SUM(CASE WHEN direction='consumption' THEN amount ELSE 0 END),0) consumption_adj
      FROM weekly_adjustments WHERE week_id=$1 GROUP BY captain_phone
    ), corr AS (
      SELECT captain_phone,COALESCE(SUM(delta),0) correction_delta
      FROM weekly_balance_corrections WHERE week_id=$1 GROUP BY captain_phone
    ), ch AS (
      SELECT captain_phone,
        COALESCE(SUM(CASE WHEN charge_type='floor' THEN amount ELSE 0 END),0) floor_fee,
        COALESCE(SUM(CASE WHEN charge_type='old_balance' THEN amount ELSE 0 END),0) old_balance
      FROM weekly_charges WHERE week_id=$1 GROUP BY captain_phone
    )
    SELECT c.name,c.phone,c.active,c.status_reason,c.status_checked_at,c.last_group_seen_at,
      (COALESCE(m.production,0)+COALESCE(mm.production_manual,0)+COALESCE(a.production_adj,0))::numeric production,
      (COALESCE(m.consumption,0)+COALESCE(mm.consumption_manual,0)+COALESCE(a.consumption_adj,0))::numeric consumption,
      COALESCE(ch.floor_fee,0)::numeric floor_fee,
      COALESCE(ch.old_balance,0)::numeric old_balance,
      ((COALESCE(m.production,0)+COALESCE(mm.production_manual,0)+COALESCE(a.production_adj,0))
       -(COALESCE(m.consumption,0)+COALESCE(mm.consumption_manual,0)+COALESCE(a.consumption_adj,0))
       -COALESCE(ch.floor_fee,0)-COALESCE(ch.old_balance,0)+COALESCE(corr.correction_delta,0))::numeric net
    FROM captains c
    LEFT JOIN mov m ON m.phone=c.phone
    LEFT JOIN manual mm ON mm.captain_phone=c.phone
    LEFT JOIN adj a ON a.captain_phone=c.phone
    LEFT JOIN corr ON corr.captain_phone=c.phone
    LEFT JOIN ch ON ch.captain_phone=c.phone
    ORDER BY c.active DESC,c.name ASC
  `,[weekId]);
  return r.rows;
}
function greenConfig(){
  return {
    apiUrl:String(process.env.GREEN_API_URL||process.env.GREEN_BASE_URL||'').replace(/\/+$/,''),
    id:String(process.env.GREEN_ID_INSTANCE||process.env.GREEN_INSTANCE_ID||'').trim(),
    token:String(process.env.GREEN_API_TOKEN_INSTANCE||process.env.GREEN_API_TOKEN||'').trim()
  };
}

app.get('/',(req,res)=>{
  if(SITE_MODE==='admin')return res.redirect(302,'/admin');
  if(SITE_MODE==='captain')return res.redirect(302,'/captain');
  return res.redirect(302,'/captain');
});
app.get('/admin',(req,res)=>{
  if(SITE_MODE==='captain')return res.status(404).send('Not Found');
  res.set('Cache-Control','no-store, no-cache, must-revalidate, proxy-revalidate');res.set('Pragma','no-cache');res.set('Expires','0');res.sendFile(path.join(__dirname,'../public/admin.html'));
});
app.get('/register',(req,res)=>{res.set('Cache-Control','no-store');res.sendFile(path.join(__dirname,'../public/register.html'));});
app.get('/captain-register',(req,res)=>res.redirect(302,'/register'));
app.get('/captain',(req,res)=>{
  if(SITE_MODE==='admin')return res.status(404).send('Not Found');
  res.set('Cache-Control','no-store, no-cache, must-revalidate, proxy-revalidate');res.set('Pragma','no-cache');res.set('Expires','0');res.sendFile(path.join(__dirname,'../public/captain.html'));
});

app.get('/health', async (req,res)=>{
  try{
    const q=await pool.query('SELECT now() AS now');
    res.json({ok:true,service:'AMMAN DELIVERY High Load',db:true,mode:SITE_MODE,time:q.rows[0].now});
  }catch(e){res.status(500).json({ok:false,error:e.message});}
});

// Legacy Green API webhook is disabled: AMMAN DELIVERY accepts DropConnect only.
app.post('/webhooks/green',(_req,res)=>res.status(410).json({ok:false,error:'USE_DROPCODE_WEBHOOK'}));

// A browser can check route reachability without sending or processing any events.
app.get(['/webhooks/dropcode','/webhooks/waha'],(_req,res)=>res.json({ok:true,provider:'dropcode',route:'ready_for_signed_POST',message:'This endpoint receives signed webhook POST requests; GET does not process messages.'}));

app.post(['/webhooks/dropcode','/webhooks/waha'], async (req,res)=>{
  try{
    if(String(process.env.WHATSAPP_PROVIDER||'dropcode').trim().toLowerCase()!=='dropcode')return res.status(204).end();
    const secret=String(process.env.DROPCODE_WEBHOOK_SECRET||'');
    if(!secret){console.error('DROPCODE WEBHOOK REJECTED: SECRET_NOT_CONFIGURED');return res.status(503).json({ok:false,error:'DROPCODE_WEBHOOK_NOT_CONFIGURED'});}
    const signature=String(req.get('x-dropcode-signature')||'');
    const expected='sha256='+crypto.createHmac('sha256',secret).update(req.rawWebhookBody||Buffer.from('')).digest('hex');
    const a=Buffer.from(signature),b=Buffer.from(expected);
    if(a.length!==b.length||!crypto.timingSafeEqual(a,b)){console.warn('DROPCODE WEBHOOK REJECTED: INVALID_SIGNATURE',req.path);return res.status(401).json({ok:false,error:'INVALID_SIGNATURE'});}
    // DropConnect may identify an authorized reactor using a private WhatsApp LID.
    // Resolve via the linked WhatsApp session, never infer a phone from LID digits.
    if(['reaction_added','reaction_removed'].includes(String(req.body?.action||'')) && req.body?.sender && !req.body.sender.phoneJid && /@lid$/i.test(String(req.body.sender.jid||''))){
      try{
        const cfg=wahaConfig();
        const result=await wahaRequest(`/api/${encodeURIComponent(cfg.session)}/check-whatsapp`,
          {method:'POST',body:{chatId:String(req.body.sender.jid)},timeout:5000});
        const verified=normalizePhone(result?.phoneNumber||result?.chatId||'');
        if(!/^\d{10,15}$/.test(verified))throw new Error('LID_PHONE_NOT_VERIFIED');
        req.body.sender.phoneJid=verified+'@s.whatsapp.net';
      }catch(e){
        console.warn('DROPCODE REACTION IDENTITY RESOLUTION RETRY',e.message);
        return res.status(503).json({ok:false,error:'DROPCODE_LID_NOT_RESOLVED'});
      }
    }
    const events=translateDropcode(req.body,String(process.env.DROPCODE_SESSION_ID||'').trim());
    if(!events.length)console.warn('DROPCODE WEBHOOK IGNORED',{route:req.path,schema:String(req.body?.schema||''),action:String(req.body?.action||''),sessionMatch:String(req.body?.session||'')===String(process.env.DROPCODE_SESSION_ID||'').trim()});
    for(const payload of events){
      const key=dedupKey(payload);
      await pool.query(`INSERT INTO event_queue(dedup_key,event_type,payload) VALUES($1,$2,$3) ON CONFLICT(dedup_key) DO NOTHING`,[key,payload.messageData?.typeMessage||'',payload]);
    }
    if(events.length)console.info('DROPCODE WEBHOOK ACCEPTED',{route:req.path,events:events.length,action:String(req.body?.action||''),group:String(req.body?.group?.id||'')});
    return res.status(200).json({ok:true,accepted:events.length});
  }catch(e){console.error('DROPCODE webhook queue error',e);return res.status(500).json({ok:false,error:'WEBHOOK_QUEUE_ERROR'});}
});


const captainRegistrationRate=new Map();
function allowCaptainRegistration(req){
  const key=String(req.ip||req.socket?.remoteAddress||'unknown');
  const now=Date.now(),windowMs=15*60*1000,max=10;
  let x=captainRegistrationRate.get(key);
  if(!x||now-x.startedAt>windowMs)x={startedAt:now,count:0};
  x.count++;captainRegistrationRate.set(key,x);
  if(captainRegistrationRate.size>5000){for(const [k,v] of captainRegistrationRate){if(now-v.startedAt>windowMs)captainRegistrationRate.delete(k)}}
  return x.count<=max;
}

app.post('/api/captain-registration',registrationUpload,async(req,res)=>{
  const c=await pool.connect();
  try{
    if(!allowCaptainRegistration(req))return res.status(429).json({ok:false,error:'TOO_MANY_REQUESTS'});
    if(String(req.body?.website||'').trim())return res.status(400).json({ok:false,error:'INVALID_REQUEST'});
    const name=String(req.body?.name||'').trim().replace(/\s+/g,' ');
    const nameKey=normalizeCaptainName(name);
    const phone=normalizePhone(req.body?.phone);
    const note=String(req.body?.note||'').trim().slice(0,300);
    if(name.length<2)return res.status(400).json({ok:false,error:'NAME_REQUIRED'});
    if(!/^9627\d{8}$/.test(phone))return res.status(400).json({ok:false,error:'INVALID_JORDAN_PHONE'});

    const identity=req.files?.identity?.[0];
    const license=req.files?.vehicle_license?.[0];
    if(!identity||!license)return res.status(400).json({ok:false,error:'DOCUMENTS_REQUIRED'});

    const [capPhone,capName]=await Promise.all([
      pool.query(`SELECT name,phone FROM captains WHERE phone=$1 LIMIT 1`,[phone]),
      pool.query(`SELECT name,phone FROM captains WHERE lower(regexp_replace(btrim(name),'[[:space:]]+',' ','g'))=$1 LIMIT 1`,[nameKey])
    ]);
    if(capPhone.rowCount)return res.status(409).json({ok:false,error:'PHONE_ALREADY_REGISTERED'});
    if(capName.rowCount)return res.status(409).json({ok:false,error:'NAME_ALREADY_REGISTERED'});

    const sameNamePending=await pool.query(`SELECT id,phone FROM captain_registration_requests WHERE status='pending' AND phone<>$1 AND lower(regexp_replace(btrim(name),'[[:space:]]+',' ','g'))=$2 LIMIT 1`,[phone,nameKey]);
    if(sameNamePending.rowCount)return res.status(409).json({ok:false,error:'NAME_REQUEST_EXISTS'});

    const existing=await pool.query(`SELECT id,status FROM captain_registration_requests WHERE phone=$1 LIMIT 1`,[phone]);
    if(existing.rowCount&&existing.rows[0].status==='approved')return res.status(409).json({ok:false,error:'REQUEST_ALREADY_APPROVED'});

    await c.query('BEGIN');
    let row;
    const wasPending=Boolean(existing.rowCount&&existing.rows[0].status==='pending');
    if(existing.rowCount){
      row=(await c.query(`UPDATE captain_registration_requests SET name=$2,note=$3,status='pending',admin_note='',reviewed_by='',reviewed_at=NULL,updated_at=now() WHERE id=$1 RETURNING *`,[existing.rows[0].id,name,note])).rows[0];
    }else{
      row=(await c.query(`INSERT INTO captain_registration_requests(name,phone,note) VALUES($1,$2,$3) RETURNING *`,[name,phone,note])).rows[0];
    }
    for(const [kind,file] of [['identity',identity],['vehicle_license',license]]){
      await c.query(`INSERT INTO captain_registration_files(request_id,file_kind,mime_type,file_name,file_data)
        VALUES($1,$2,$3,$4,$5)
        ON CONFLICT(request_id,file_kind) DO UPDATE SET mime_type=EXCLUDED.mime_type,file_name=EXCLUDED.file_name,file_data=EXCLUDED.file_data,uploaded_at=now()`,
        [row.id,kind,file.mimetype,String(file.originalname||'').slice(0,180),file.buffer]);
    }
    await c.query(`INSERT INTO audit_log(action,details) VALUES('CAPTAIN_REGISTRATION_REQUESTED',$1)`,[{request_id:row.id,name,phone,documents:['identity','vehicle_license'],updated_existing:wasPending}]);
    await c.query('COMMIT');
    res.json({ok:true,status:'pending',request_id:row.id,already_pending:wasPending,updated:wasPending});
  }catch(e){
    try{await c.query('ROLLBACK')}catch{}
    console.error('CAPTAIN REGISTRATION ERROR',e);
    if(e?.code==='23505')return res.status(409).json({ok:false,error:'DUPLICATE_REQUEST'});
    if(e?.code==='LIMIT_FILE_SIZE')return res.status(413).json({ok:false,error:'FILE_TOO_LARGE'});
    res.status(500).json({ok:false,error:'REGISTRATION_FAILED'});
  }finally{c.release()}
});

app.post('/api/admin/login',(req,res)=>{
  const username=String(req.body?.username ?? '').trim();
  const password=String(req.body?.password ?? '').trim();
  const expectedUsername=String(process.env.ADMIN_USERNAME ?? '').trim();
  const expectedPassword=String(process.env.ADMIN_PASSWORD ?? '').trim();

  if(!expectedUsername || !expectedPassword){
    console.error('ADMIN LOGIN CONFIG ERROR: ADMIN_USERNAME or ADMIN_PASSWORD is missing');
    return res.status(500).json({ok:false,error:'ADMIN_LOGIN_NOT_CONFIGURED'});
  }

  if(username !== expectedUsername || password !== expectedPassword){
    console.warn('ADMIN LOGIN REJECTED', {
      usernameMatch: username === expectedUsername,
      passwordMatch: password === expectedPassword,
      receivedUsernameLength: username.length,
      expectedUsernameLength: expectedUsername.length,
      receivedPasswordLength: password.length,
      expectedPasswordLength: expectedPassword.length
    });
    return res.status(401).json({ok:false,error:'INVALID_CREDENTIALS'});
  }

  const token=jwt.sign({role:'admin',username:expectedUsername},process.env.JWT_SECRET,{expiresIn:'12h'});
  console.log('ADMIN LOGIN SUCCESS');
  res.json({ok:true,token});
});

app.get('/api/admin/stats',auth,async(req,res)=>{
  const [q,c,m,b,f,u]=await Promise.all([
    pool.query(`SELECT status,count(*)::int n FROM event_queue GROUP BY status`),
    pool.query(`SELECT status,count(*)::int n FROM claims GROUP BY status`),
    pool.query(`SELECT count(*)::int n FROM movements WHERE status='active'`),
    pool.query(`SELECT count(*)::int n FROM captain_balances`),
    pool.query(`SELECT count(*)::int n FROM event_queue WHERE status='failed'`),
    pool.query(`SELECT COUNT(DISTINCT missing_phone)::int n FROM (SELECT c.producer_phone missing_phone FROM claims c LEFT JOIN captains x ON x.phone=c.producer_phone WHERE x.phone IS NULL AND c.status<>'cancelled' UNION SELECT c.consumer_phone FROM claims c LEFT JOIN captains x ON x.phone=c.consumer_phone WHERE x.phone IS NULL AND c.status<>'cancelled') z`)
  ]);
  res.json({ok:true,queue:q.rows,claims:c.rows,activeMovements:m.rows[0].n,captains:b.rows[0].n,failed:f.rows[0].n,unregistered:u.rows[0].n});
});


app.get('/api/admin/monitor-captains',auth,async(req,res)=>{
  try{
    const w=await getOpenWeek();
    const rows=await weeklyRows(w.id);
    res.json({ok:true,week:w,rows:rows.map(x=>({
      name:x.name,phone:x.phone,active:x.active,status_reason:x.status_reason,
      production:x.production,consumption:x.consumption,balance:x.net,
      floor_fee:x.floor_fee,old_balance:x.old_balance,last_movement:null,last_group_seen_at:x.last_group_seen_at
    }))});
  }catch(e){res.status(500).json({ok:false,error:'MONITOR_CAPTAINS_FAILED',message:e.message});}
});

app.get('/api/admin/balances',auth,async(req,res)=>{
  try{
    const w=await getOpenWeek(); const rows=await weeklyRows(w.id);
    res.json({ok:true,week:w,rows:rows.map(x=>({
      captain_phone:x.phone,name:x.name,production:x.production,consumption:x.consumption,
      floor_fee:x.floor_fee,old_balance:x.old_balance,net:x.net,active:x.active,status_reason:x.status_reason,updated_at:w.starts_at
    }))});
  }catch(e){res.status(500).json({ok:false,error:'BALANCES_FAILED',message:e.message});}
});

app.get('/api/admin/claims',auth,async(req,res)=>{
  const r=await pool.query(`SELECT * FROM claims ORDER BY id DESC LIMIT 300`);
  res.json({ok:true,rows:r.rows});
});

app.get('/api/admin/orders',auth,async(req,res)=>{
  const r=await pool.query(`
    SELECT
      c.id,
      c.created_at,
      c.updated_at,
      c.group_id,
      c.original_message_id,
      c.reply_message_id,
      c.producer_phone,
      COALESCE(pc.name,c.producer_name,'') AS producer_name,
      c.consumer_phone,
      COALESCE(cc.name,c.consumer_name,'') AS consumer_name,
      c.status,
      c.current_reaction,
      c.current_value,
      c.approved_by,
      c.cancelled_by,
      COALESCE(
        NULLIF(om.text_body,''),
        NULLIF(om.raw #>> '{messageData,textMessageData,textMessage}',''),
        NULLIF(om.raw #>> '{messageData,extendedTextMessageData,text}',''),
        NULLIF(om.raw #>> '{messageData,fileMessageData,caption}',''),
        ''
      ) AS original_text,
      COALESCE(om.raw #>> '{messageData,typeMessage}','') AS original_type,
      COALESCE(
        om.raw #>> '{messageData,fileMessageData,downloadUrl}',
        om.raw #>> '{messageData,audioMessageData,downloadUrl}',
        om.raw #>> '{messageData,imageMessageData,downloadUrl}',
        om.raw #>> '{messageData,videoMessageData,downloadUrl}',
        ''
      ) AS original_media_url,
      COALESCE(
        om.raw #>> '{messageData,fileMessageData,mimeType}',
        om.raw #>> '{messageData,audioMessageData,mimeType}',
        om.raw #>> '{messageData,imageMessageData,mimeType}',
        om.raw #>> '{messageData,videoMessageData,mimeType}',
        ''
      ) AS original_mime_type
    FROM claims c
    LEFT JOIN captains pc ON pc.phone=c.producer_phone
    LEFT JOIN captains cc ON cc.phone=c.consumer_phone
    LEFT JOIN LATERAL (
      SELECT wm.*
      FROM whatsapp_messages wm
      WHERE wm.group_id=c.group_id
        AND c.original_message_id<>''
        AND (
          wm.message_id=c.original_message_id
          OR right(wm.message_id,char_length(c.original_message_id))=c.original_message_id
          OR position(c.original_message_id in wm.message_id)>0
        )
      ORDER BY CASE
        WHEN wm.message_id=c.original_message_id THEN 0
        WHEN right(wm.message_id,char_length(c.original_message_id))=c.original_message_id THEN 1
        ELSE 2
      END, wm.created_at DESC
      LIMIT 1
    ) om ON true
    WHERE NOT (c.status='waiting' AND c.current_reaction IS NULL AND c.created_at < now()-interval '24 hours')
    ORDER BY c.id DESC
    LIMIT 300
  `);
  res.json({ok:true,rows:r.rows});
});

app.get('/api/admin/errors',auth,async(req,res)=>{
  const r=await pool.query(`SELECT id,event_type,attempts,last_error,created_at FROM event_queue WHERE status='failed' ORDER BY id DESC LIMIT 200`);
  res.json({ok:true,rows:r.rows});
});


function parseCsv(text=''){
  const rows=[];
  let row=[],cell='',quoted=false;
  for(let i=0;i<text.length;i++){
    const ch=text[i], next=text[i+1];
    if(ch==='"'){
      if(quoted && next==='"'){ cell+='"'; i++; }
      else quoted=!quoted;
    }else if(ch===',' && !quoted){
      row.push(cell); cell='';
    }else if((ch==='\n' || ch==='\r') && !quoted){
      if(ch==='\r' && next==='\n') i++;
      row.push(cell); cell='';
      if(row.some(v=>String(v).trim()!=='')) rows.push(row);
      row=[];
    }else{
      cell+=ch;
    }
  }
  if(cell.length || row.length){
    row.push(cell);
    if(row.some(v=>String(v).trim()!=='')) rows.push(row);
  }
  return rows;
}

app.post('/api/admin/import-captains-sheet',auth,async(req,res)=>{
  try{
    const spreadsheetId=String(process.env.GOOGLE_SHEET_ID || '1IY2uq7jRTEm2mblgkXBYg0A7mUbGroUjfW3UBz9gcxQ').trim();
    const sheetName=String(process.env.GOOGLE_CAPTAINS_SHEET || 'الكباتن').trim();
    const url=`https://docs.google.com/spreadsheets/d/${encodeURIComponent(spreadsheetId)}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent(sheetName)}`;

    const response=await fetch(url,{headers:{'user-agent':'AmmanDelivery/1.0'}});
    if(!response.ok){
      return res.status(502).json({ok:false,error:`SHEET_HTTP_${response.status}`});
    }

    const csv=await response.text();
    const rows=parseCsv(csv);
    if(rows.length<2){
      return res.status(400).json({ok:false,error:'SHEET_EMPTY'});
    }

    const header=rows[0].map(v=>String(v||'').trim());
    const nameIndex=header.findIndex(v=>v==='اسم الكابتن');
    const phoneIndex=header.findIndex(v=>v==='رقم الهاتف');
    if(nameIndex<0 || phoneIndex<0){
      return res.status(400).json({ok:false,error:'REQUIRED_COLUMNS_NOT_FOUND',header});
    }

    let allowedPhones=null,sourceGroups=0;
    if(String(process.env.WHATSAPP_PROVIDER||'dropcode').trim().toLowerCase()==='waha'){
      const src=await pool.query(`SELECT group_id,name FROM groups WHERE active=true AND auto_register_members=true ORDER BY id`);
      if(!src.rowCount)return res.status(409).json({ok:false,error:'NO_AUTO_REGISTER_GROUP'});
      allowedPhones=new Set();sourceGroups=src.rowCount;
      for(const group of src.rows){
        const data=await getWahaGroupParticipants(group.group_id,pool);
        for(const ph of data.phones||[]){const p=normalizePhone(ph);if(p)allowedPhones.add(p);}
      }
    }

    const seen=new Set(),seenNames=new Set();
    let imported=0,updated=0,duplicates=0,name_duplicates=0,invalid=0,skipped_not_in_source_group=0;

    for(const row of rows.slice(1)){
      const name=String(row[nameIndex]||'').trim();
      const phone=normalizePhone(row[phoneIndex]||'');
      if(!name || !phone || phone.length<9){
        invalid++;
        continue;
      }
      if(allowedPhones && !allowedPhones.has(phone)){skipped_not_in_source_group++;continue;}
      const nameKey=normalizeCaptainName(name);
      if(seen.has(phone)){duplicates++;continue;}
      if(seenNames.has(nameKey)){name_duplicates++;continue;}
      const existingName=await pool.query(`SELECT phone FROM captains WHERE lower(regexp_replace(btrim(name),'[[:space:]]+',' ','g'))=$1 AND phone<>$2 LIMIT 1`,[nameKey,phone]);
      if(existingName.rowCount){name_duplicates++;continue;}
      seen.add(phone);seenNames.add(nameKey);

      const existing=await pool.query(`SELECT 1 FROM captains WHERE phone=$1 LIMIT 1`,[phone]);
      await pool.query(`
        INSERT INTO captains(name,phone,password,active)
        VALUES($1,$2,$3,true)
        ON CONFLICT(phone) DO UPDATE SET
          name=EXCLUDED.name,
          updated_at=now()
      `,[name,phone,'123456']);

      if(existing.rowCount) updated++;
      else imported++;
    }

    const reconciled=await reconcileForPhones([...seen]);
    res.json({
      ok:true,
      reconciled,
      spreadsheet_id:spreadsheetId,
      sheet:sheetName,
      total_rows:rows.length-1,
      imported,
      updated,
      duplicates,
      name_duplicates,
      invalid,
      skipped_not_in_source_group,
      source_groups:sourceGroups,
      total_active:imported+updated
    });
  }catch(e){
    console.error('SHEET IMPORT ERROR',e);
    res.status(500).json({ok:false,error:'SHEET_IMPORT_FAILED',message:e.message});
  }
});

app.post('/api/admin/captains',auth,async(req,res)=>{
  const name=String(req.body?.name||'').trim().replace(/\s+/g,' ');
  const nameKey=normalizeCaptainName(name);
  const p=normalizePhone(req.body?.phone);
  const password=String(req.body?.password||'123456');
  const active=req.body?.active!==false;
  if(!name||!p)return res.status(400).json({ok:false,error:'INVALID_CAPTAIN'});
  if(password.length<6)return res.status(400).json({ok:false,error:'PASSWORD_TOO_SHORT'});
  const c=await pool.connect();
  try{
    await c.query('BEGIN');
    const phoneExists=await c.query(`SELECT name,phone FROM captains WHERE phone=$1 LIMIT 1 FOR UPDATE`,[p]);
    if(phoneExists.rowCount){await c.query('ROLLBACK');return res.status(409).json({ok:false,error:'PHONE_EXISTS',captain:phoneExists.rows[0]});}
    const nameExists=await c.query(`SELECT name,phone FROM captains WHERE lower(regexp_replace(btrim(name),'\\s+',' ','g'))=$1 LIMIT 1 FOR UPDATE`,[nameKey]);
    if(nameExists.rowCount){await c.query('ROLLBACK');return res.status(409).json({ok:false,error:'NAME_EXISTS',captain:nameExists.rows[0]});}
    await c.query(`INSERT INTO captains(name,phone,password,active,onboarding_completed,password_changed) VALUES($1,$2,'[encrypted]',$3,false,false)`,[name,p,active]);
    await setCaptainPassword(c,p,password,{changed:password!=='123456'});
    await c.query(`INSERT INTO audit_log(action,details) VALUES('CAPTAIN_ADDED',$1)`,[{phone:p,name,active}]);
    await c.query('COMMIT');
    const reconciled=await reconcileForPhones([p]);
    res.json({ok:true,created:true,reconciled});
  }catch(e){
    try{await c.query('ROLLBACK')}catch{}
    console.error('ADD CAPTAIN ERROR',e);
    if(e?.code==='23505')return res.status(409).json({ok:false,error:'PHONE_EXISTS'});
    res.status(500).json({ok:false,error:'ADD_CAPTAIN_FAILED',message:e.message});
  }finally{c.release();}
});


app.get('/api/admin/captains-duplicates',auth,async(req,res)=>{
  try{
    const r=await pool.query(`SELECT id,name,phone,active,created_at FROM captains ORDER BY id ASC`);
    const phoneMap=new Map(),nameMap=new Map();
    for(const row of r.rows){
      const pk=normalizePhone(row.phone)||String(row.phone||'').trim();
      const nk=normalizeCaptainName(row.name);
      if(pk){if(!phoneMap.has(pk))phoneMap.set(pk,[]);phoneMap.get(pk).push(row);}
      if(nk){if(!nameMap.has(nk))nameMap.set(nk,[]);nameMap.get(nk).push(row);}
    }
    const phone_duplicates=[...phoneMap.entries()].filter(([,rows])=>rows.length>1).map(([key,rows])=>({key,count:rows.length,rows}));
    const name_duplicates=[...nameMap.entries()].filter(([,rows])=>rows.length>1).map(([key,rows])=>({key,count:rows.length,rows}));
    res.json({ok:true,phone_duplicates,name_duplicates,total:phone_duplicates.length+name_duplicates.length});
  }catch(e){res.status(500).json({ok:false,error:'CAPTAIN_DUPLICATES_FAILED',message:e.message});}
});

app.get('/api/admin/groups-list',auth,async(req,res)=>{
  try{
    const r=await pool.query(`SELECT group_id,name,active,auto_register_members FROM groups ORDER BY active DESC,auto_register_members DESC,name ASC,group_id ASC`);
    res.json({ok:true,rows:r.rows});
  }catch(e){
    res.status(500).json({ok:false,error:'GROUPS_LIST_FAILED',message:e.message});
  }
});

app.get('/api/admin/authorized-list',auth,async(req,res)=>{
  try{
    const r=await pool.query(`SELECT phone,name,active FROM authorized_numbers ORDER BY active DESC,name ASC,phone ASC`);
    res.json({ok:true,rows:r.rows});
  }catch(e){
    res.status(500).json({ok:false,error:'AUTHORIZED_LIST_FAILED',message:e.message});
  }
});

app.get('/api/admin/runtime-status',auth,async(req,res)=>{
  try{
    const [dbq,workerQ,groupsQ,queueQ]=await Promise.all([
      pool.query('SELECT now() now'),
      pool.query(`SELECT value,updated_at,(updated_at > now()-interval '45 seconds') AS running FROM runtime_status WHERE key='worker'`),
      pool.query(`SELECT COUNT(*)::int active FROM groups WHERE active=true`),
      pool.query(`SELECT COUNT(*)::int pending FROM event_queue WHERE status IN ('pending','retry','processing')`)
    ]);
    const provider=String(process.env.WHATSAPP_PROVIDER||'dropcode').trim().toLowerCase();
    let whatsapp={provider,configured:false,online:false,state:'not_configured'};
    if(provider==='dropcode'){
      const cfg=wahaConfig(); whatsapp.configured=!!cfg.baseUrl;
      if(whatsapp.configured){
        try{
          const st=await getWahaSessionStatus();
          whatsapp.state=String(st?.status||'unknown');
          whatsapp.online=whatsapp.state.toUpperCase()==='WORKING';
          whatsapp.session=cfg.session;
        }catch(e){ whatsapp.state=String(e?.message||'offline').slice(0,120); }
      }
    }else{
      const cfg=greenConfig(); whatsapp.configured=!!(cfg.apiUrl&&cfg.id&&cfg.token);
      if(whatsapp.configured){
        try{
          const ctrl=new AbortController(); const t=setTimeout(()=>ctrl.abort(),3000);
          const rr=await fetch(`${cfg.apiUrl}/waInstance${encodeURIComponent(cfg.id)}/getStateInstance/${encodeURIComponent(cfg.token)}`,{signal:ctrl.signal});
          clearTimeout(t); const jj=await rr.json().catch(()=>({}));
          whatsapp.state=String(jj.stateInstance||jj.state||'unknown');
          whatsapp.online=rr.ok&&['authorized','online','connected'].includes(whatsapp.state.toLowerCase());
        }catch(e){ whatsapp.state=e?.name==='AbortError'?'timeout':'offline'; }
      }
    }
    res.json({ok:true,db:true,server:true,worker:workerQ.rows[0]||{running:false},whatsapp,groups:Number(groupsQ.rows[0]?.active||0),queue:Number(queueQ.rows[0]?.pending||0),time:dbq.rows[0].now});
  }catch(e){res.status(500).json({ok:false,error:'RUNTIME_STATUS_FAILED',message:e.message});}
});

app.get('/api/admin/dropcode-groups',auth,async(req,res)=>{
  try{
    const base=String(process.env.DROPCODE_API_URL||'').trim().split('?')[0].replace(new RegExp('/+$'),'');
    const session=String(process.env.DROPCODE_SESSION_ID||'').trim();
    const key=String(process.env.DROPCODE_API_KEY||process.env.DROPCODE_API_TOKEN||'').trim();
    if(!base||!session||!key)return res.status(503).json({ok:false,error:'DROPCODE_NOT_CONFIGURED'});
    const response=await fetch(base+'/api/'+encodeURIComponent(session)+'/groups',{headers:{'X-Api-Key':key,'Authorization':'Bearer '+key},signal:AbortSignal.timeout(15000)});
    if(!response.ok)return res.status(502).json({ok:false,error:'DROPCODE_GROUPS_HTTP_'+response.status});
    const raw=await response.json();
    const items=Array.isArray(raw)?raw:Array.isArray(raw.groups)?raw.groups:[];
    const rows=items.map(g=>({group_id:String(g.id?._serialized||g.id||g.groupId||'').trim(),name:String(g.subject||g.name||'').trim()})).filter(g=>g.group_id.endsWith('@g.us'));
    res.json({ok:true,rows});
  }catch(e){console.error('DROPCODE GROUP LIST FAILED',e.message);res.status(502).json({ok:false,error:'DROPCODE_GROUPS_UNAVAILABLE'});}
});

app.get('/api/admin/detected-groups',auth,async(req,res)=>{
  const [events,activeGroups]=await Promise.all([
    pool.query(`SELECT payload,created_at FROM event_queue ORDER BY id DESC LIMIT 1500`),
    pool.query(`SELECT group_id,name,active,auto_register_members FROM groups`)
  ]);

  const activeMap=new Map(activeGroups.rows.map(g=>[String(g.group_id),g]));
  const found=new Map();

  function consider(groupId,name,seenAt){
    groupId=String(groupId||'').trim();
    if(!groupId.endsWith('@g.us')) return;
    const old=found.get(groupId);
    const candidate={
      group_id:groupId,
      name:String(name||'').trim(),
      last_seen:seenAt||null,
      active:!!activeMap.get(groupId)?.active,
      auto_register_members:!!activeMap.get(groupId)?.auto_register_members,
      saved_name:activeMap.get(groupId)?.name||''
    };
    if(!old || (candidate.last_seen && (!old.last_seen || new Date(candidate.last_seen)>new Date(old.last_seen)))){
      found.set(groupId,candidate);
    }else if(old && !old.name && candidate.name){
      old.name=candidate.name;
    }
  }

  for(const row of events.rows){
    const p=row.payload||{};
    const sd=p.senderData||{};
    const md=p.messageData||{};
    const q=md.quotedMessage||{};
    consider(sd.chatId, sd.chatName||sd.chatNameMessage||'', row.created_at);
    consider(p.chatId, p.chatName||'', row.created_at);
    consider(md.chatId, md.chatName||'', row.created_at);
    consider(q.chatId, q.chatName||'', row.created_at);
  }

  for(const g of activeGroups.rows){
    if(!found.has(String(g.group_id))){
      found.set(String(g.group_id),{
        group_id:String(g.group_id),
        name:g.name||'',
        last_seen:null,
        active:!!g.active,
        auto_register_members:!!g.auto_register_members,
        saved_name:g.name||''
      });
    }
  }

  const rows=[...found.values()].sort((a,b)=>{
    if(a.active!==b.active) return a.active?-1:1;
    return new Date(b.last_seen||0)-new Date(a.last_seen||0);
  });
  res.json({ok:true,rows});
});

app.post('/api/admin/groups',auth,async(req,res)=>{
  const {group_id,name='',active=true}=req.body||{};
  if(!group_id)return res.status(400).json({ok:false,error:'group_id required'});
  const requestedSource=req.body?.auto_register_members;
  const hasSource=await pool.query(`SELECT 1 FROM groups WHERE auto_register_members=true LIMIT 1`);
  const source=requestedSource===undefined?!hasSource.rowCount:!!requestedSource;
  await pool.query(`
    INSERT INTO groups(group_id,name,active,auto_register_members) VALUES($1,$2,$3,$4)
    ON CONFLICT(group_id) DO UPDATE SET
      name=EXCLUDED.name,
      active=EXCLUDED.active,
      auto_register_members=CASE WHEN $5 THEN EXCLUDED.auto_register_members ELSE groups.auto_register_members END`,
    [group_id,name,!!active,source,requestedSource!==undefined]);
  res.json({ok:true});
});


app.patch('/api/admin/groups/:groupId',auth,async(req,res)=>{
  try{
    const id=String(req.params.groupId||'');
    const hasActive=Object.prototype.hasOwnProperty.call(req.body||{},'active');
    const hasSource=Object.prototype.hasOwnProperty.call(req.body||{},'auto_register_members');
    const current=await pool.query(`SELECT group_id,name,active,auto_register_members FROM groups WHERE group_id=$1 LIMIT 1`,[id]);
    if(!current.rowCount)return res.status(404).json({ok:false,error:'GROUP_NOT_FOUND'});
    const nextActive=hasActive?!!req.body.active:!!current.rows[0].active;
    const nextSource=hasSource?!!req.body.auto_register_members:!!current.rows[0].auto_register_members;
    if(hasSource&&!nextSource&&current.rows[0].auto_register_members){
      const other=await pool.query(`SELECT 1 FROM groups WHERE auto_register_members=true AND group_id<>$1 LIMIT 1`,[id]);
      if(!other.rowCount)return res.status(409).json({ok:false,error:'LAST_AUTO_REGISTER_GROUP'});
    }
    const q=await pool.query(`UPDATE groups SET active=$2,auto_register_members=$3 WHERE group_id=$1 RETURNING group_id,name,active,auto_register_members`,[id,nextActive,nextSource]);
    await audit('GROUP_SETTINGS_UPDATED',{group_id:id,active:nextActive,auto_register_members:nextSource});
    res.json({ok:true,row:q.rows[0]});
  }catch(e){res.status(500).json({ok:false,error:'GROUP_TOGGLE_FAILED',message:e.message})}
});

app.get('/api/admin/unregistered',auth,async(req,res)=>{
  try{
    const r=await pool.query(`
      WITH u AS (
        SELECT c.producer_phone phone,COALESCE(NULLIF(c.producer_name,''),c.producer_phone) name,c.group_id,c.id claim_id,c.status,c.current_value,c.current_reaction,c.created_at,'producer' role
        FROM claims c LEFT JOIN captains x ON x.phone=c.producer_phone WHERE x.phone IS NULL AND c.status<>'cancelled'
        UNION ALL
        SELECT c.consumer_phone,COALESCE(NULLIF(c.consumer_name,''),c.consumer_phone),c.group_id,c.id,c.status,c.current_value,c.current_reaction,c.created_at,'consumer'
        FROM claims c LEFT JOIN captains x ON x.phone=c.consumer_phone WHERE x.phone IS NULL AND c.status<>'cancelled'
      )
      SELECT phone,MAX(name) name,COUNT(*)::int occurrences,COUNT(*) FILTER(WHERE role='producer')::int producer_count,COUNT(*) FILTER(WHERE role='consumer')::int consumer_count,
        COALESCE(SUM(CASE WHEN role='producer' THEN current_value ELSE 0 END),0)::numeric production_value,
        COALESCE(SUM(CASE WHEN role='consumer' THEN current_value ELSE 0 END),0)::numeric consumption_value,
        MAX(created_at) last_seen,ARRAY_AGG(DISTINCT group_id) groups,ARRAY_AGG(DISTINCT claim_id) claim_ids,
        COUNT(*) FILTER(WHERE status='waiting_registration')::int pending_count,
        COUNT(*) FILTER(WHERE status='active')::int legacy_active_count
      FROM u GROUP BY phone ORDER BY MAX(created_at) DESC`);
    const legacy=await pool.query(`SELECT COUNT(DISTINCT c.id)::int n FROM claims c LEFT JOIN captains p ON p.phone=c.producer_phone LEFT JOIN captains k ON k.phone=c.consumer_phone WHERE c.status='active' AND (p.phone IS NULL OR k.phone IS NULL)`);
    res.json({ok:true,rows:r.rows,legacy_active:legacy.rows[0].n});
  }catch(e){res.status(500).json({ok:false,error:'UNREGISTERED_FAILED',message:e.message})}
});

app.post('/api/admin/unregistered/:phone/register',auth,async(req,res)=>{
  try{const phone=normalizePhone(req.params.phone),name=String(req.body?.name||phone).trim().replace(/\s+/g,' '),nameKey=normalizeCaptainName(name);if(!phone)return res.status(400).json({ok:false,error:'PHONE_REQUIRED'});const pe=await pool.query(`SELECT name,phone FROM captains WHERE phone=$1 LIMIT 1`,[phone]);if(pe.rowCount)return res.status(409).json({ok:false,error:'PHONE_EXISTS',captain:pe.rows[0]});const ne=await pool.query(`SELECT name,phone FROM captains WHERE lower(regexp_replace(btrim(name),'[[:space:]]+',' ','g'))=$1 LIMIT 1`,[nameKey]);if(ne.rowCount)return res.status(409).json({ok:false,error:'NAME_EXISTS',captain:ne.rows[0]});await pool.query(`INSERT INTO captains(name,phone,password,active,status_reason) VALUES($1,$2,'123456',true,'تم تسجيله من الأرقام غير المسجلة')`,[name,phone]);const reconciled=await reconcileForPhones([phone]);await audit('UNREGISTERED_PHONE_REGISTERED',{phone,name,reconciled});res.json({ok:true,reconciled})}catch(e){res.status(500).json({ok:false,error:'REGISTER_UNKNOWN_FAILED',message:e.message})}
});

app.post('/api/admin/unregistered/:phone/link',auth,async(req,res)=>{
  const c=await pool.connect();
  try{const source=normalizePhone(req.params.phone),target=normalizePhone(req.body?.target_phone);if(!source||!target)return res.status(400).json({ok:false,error:'PHONES_REQUIRED'});await c.query('BEGIN');if(!(await c.query(`SELECT 1 FROM captains WHERE phone=$1`,[target])).rowCount){await c.query('ROLLBACK');return res.status(404).json({ok:false,error:'TARGET_CAPTAIN_NOT_FOUND'})}
    await c.query(`UPDATE claims SET producer_phone=$2,updated_at=now() WHERE producer_phone=$1 AND status='waiting_registration' AND consumer_phone<>$2`,[source,target]);
    await c.query(`UPDATE claims SET consumer_phone=$2,updated_at=now() WHERE consumer_phone=$1 AND status='waiting_registration' AND producer_phone<>$2`,[source,target]);
    await c.query(`UPDATE movements SET captain_phone=$2 WHERE captain_phone=$1 AND claim_id IN (SELECT id FROM claims WHERE status='waiting_registration')`,[source,target]);await c.query('COMMIT');const reconciled=await reconcileForPhones([target]);await audit('UNREGISTERED_PHONE_LINKED',{source,target,reconciled});res.json({ok:true,reconciled})
  }catch(e){await c.query('ROLLBACK');res.status(500).json({ok:false,error:'LINK_UNKNOWN_FAILED',message:e.message})}finally{c.release()}
});

app.post('/api/admin/integrity/repair-unregistered',auth,async(req,res)=>{
  const c=await pool.connect();
  try{await c.query('BEGIN');const q=await c.query(`SELECT cl.* FROM claims cl LEFT JOIN captains p ON p.phone=cl.producer_phone LEFT JOIN captains k ON k.phone=cl.consumer_phone WHERE cl.status='active' AND (p.phone IS NULL OR k.phone IS NULL) FOR UPDATE`);let repaired=0;
    for(const cl of q.rows){const mv=await c.query(`SELECT * FROM movements WHERE claim_id=$1 AND status='active' FOR UPDATE`,[cl.id]);for(const m of mv.rows){await c.query(`UPDATE movements SET status='cancelled',cancelled_at=now() WHERE id=$1`,[m.id]);if(m.direction==='production')await c.query(`UPDATE captain_balances SET production=GREATEST(0,production-$2),net=GREATEST(0,production-$2)-consumption,updated_at=now() WHERE captain_phone=$1`,[m.captain_phone,m.amount]);else await c.query(`UPDATE captain_balances SET consumption=GREATEST(0,consumption-$2),net=production-GREATEST(0,consumption-$2),updated_at=now() WHERE captain_phone=$1`,[m.captain_phone,m.amount]);}
      await c.query(`UPDATE claims SET status='waiting_registration',updated_at=now() WHERE id=$1`,[cl.id]);await enqueueSheetSync(c,cl.id);repaired++;}
    await c.query(`INSERT INTO audit_log(action,details) VALUES('LEGACY_UNREGISTERED_REPAIRED',$1)`,[{repaired}]);await c.query('COMMIT');res.json({ok:true,repaired})
  }catch(e){await c.query('ROLLBACK');res.status(500).json({ok:false,error:'INTEGRITY_REPAIR_FAILED',message:e.message})}finally{c.release()}
});

app.post('/api/admin/cleanup/waiting',auth,async(req,res)=>{try{const deleted=await cleanupStaleWaitingClaims();res.json({ok:true,deleted})}catch(e){res.status(500).json({ok:false,error:'WAITING_CLEANUP_FAILED',message:e.message})}});

app.post('/api/admin/authorized-cancel',auth,async(req,res)=>{
  const {phone,name='',active=true}=req.body||{};
  const p=normalizePhone(phone);
  if(!p)return res.status(400).json({ok:false,error:'phone required'});
  await pool.query(`
    INSERT INTO authorized_numbers(phone,name,active) VALUES($1,$2,$3)
    ON CONFLICT(phone) DO UPDATE SET name=EXCLUDED.name,active=EXCLUDED.active`,
    [p,name,!!active]);
  res.json({ok:true});
});



app.get('/api/admin/captain-registrations',auth,async(req,res)=>{
  try{
    const r=await pool.query(`SELECT r.*,
      EXISTS(SELECT 1 FROM captain_registration_files f WHERE f.request_id=r.id AND f.file_kind='identity') identity_image,
      EXISTS(SELECT 1 FROM captain_registration_files f WHERE f.request_id=r.id AND f.file_kind='vehicle_license') vehicle_license_image,
      EXISTS(SELECT 1 FROM captain_registration_files f WHERE f.request_id=r.id AND f.file_kind='payment_proof') payment_proof_image
      FROM captain_registration_requests r
      ORDER BY CASE status WHEN 'pending' THEN 0 WHEN 'approved' THEN 1 ELSE 2 END,created_at DESC LIMIT 300`);
    res.json({ok:true,rows:r.rows,pending_count:r.rows.filter(x=>x.status==='pending').length});
  }catch(e){res.status(500).json({ok:false,error:'REGISTRATIONS_LIST_FAILED',message:e.message})}
});

app.get('/api/admin/captain-registrations/:id/file/:kind',auth,async(req,res)=>{
  try{
    const kind=String(req.params.kind||'');
    if(!['identity','vehicle_license','payment_proof'].includes(kind))return res.status(400).end();
    const r=await pool.query(`SELECT mime_type,file_name,file_data FROM captain_registration_files WHERE request_id=$1 AND file_kind=$2`,[req.params.id,kind]);
    if(!r.rowCount)return res.status(404).end();
    res.setHeader('content-type',r.rows[0].mime_type||'application/octet-stream');
    res.setHeader('cache-control','no-store');
    res.setHeader('x-content-type-options','nosniff');
    res.send(r.rows[0].file_data);
  }catch(e){res.status(500).end()}
});

app.patch('/api/admin/captain-registrations/:id',auth,async(req,res)=>{
  const c=await pool.connect();
  try{
    await c.query('BEGIN');
    const q=await c.query(`SELECT * FROM captain_registration_requests WHERE id=$1 FOR UPDATE`,[req.params.id]);
    if(!q.rowCount){await c.query('ROLLBACK');return res.status(404).json({ok:false,error:'REQUEST_NOT_FOUND'})}
    const current=q.rows[0];
    if(current.status!=='pending'){await c.query('ROLLBACK');return res.status(409).json({ok:false,error:'REQUEST_NOT_PENDING'})}
    const name=String(req.body?.name||'').trim().replace(/\s+/g,' '),nameKey=normalizeCaptainName(name);
    const phone=normalizePhone(req.body?.phone);
    const note=String(req.body?.note||'').trim().slice(0,300);
    if(name.length<2){await c.query('ROLLBACK');return res.status(400).json({ok:false,error:'NAME_REQUIRED'})}
    if(!/^9627\d{8}$/.test(phone)){await c.query('ROLLBACK');return res.status(400).json({ok:false,error:'INVALID_JORDAN_PHONE'})}
    const pe=await c.query(`SELECT name,phone FROM captains WHERE phone=$1 LIMIT 1`,[phone]);
    if(pe.rowCount){await c.query('ROLLBACK');return res.status(409).json({ok:false,error:'PHONE_EXISTS',captain:pe.rows[0]})}
    const ne=await c.query(`SELECT name,phone FROM captains WHERE lower(regexp_replace(btrim(name),'[[:space:]]+',' ','g'))=$1 LIMIT 1`,[nameKey]);
    if(ne.rowCount){await c.query('ROLLBACK');return res.status(409).json({ok:false,error:'NAME_EXISTS',captain:ne.rows[0]})}
    const rp=await c.query(`SELECT id FROM captain_registration_requests WHERE id<>$1 AND phone=$2 LIMIT 1`,[current.id,phone]);
    if(rp.rowCount){await c.query('ROLLBACK');return res.status(409).json({ok:false,error:'REQUEST_PHONE_EXISTS'})}
    const rn=await c.query(`SELECT id,phone FROM captain_registration_requests WHERE id<>$1 AND status='pending' AND lower(regexp_replace(btrim(name),'[[:space:]]+',' ','g'))=$2 LIMIT 1`,[current.id,nameKey]);
    if(rn.rowCount){await c.query('ROLLBACK');return res.status(409).json({ok:false,error:'NAME_REQUEST_EXISTS'})}
    const updated=(await c.query(`UPDATE captain_registration_requests SET name=$2,phone=$3,note=$4,updated_at=now() WHERE id=$1 RETURNING *`,[current.id,name,phone,note])).rows[0];
    await c.query(`INSERT INTO audit_log(action,details) VALUES('CAPTAIN_REGISTRATION_EDITED',$1)`,[{request_id:current.id,before:{name:current.name,phone:current.phone,note:current.note},after:{name,phone,note},by:String(req.user?.username||'admin')}]);
    await c.query('COMMIT');
    res.json({ok:true,row:updated});
  }catch(e){
    try{await c.query('ROLLBACK')}catch{}
    if(e?.code==='23505')return res.status(409).json({ok:false,error:'REQUEST_PHONE_EXISTS'});
    res.status(500).json({ok:false,error:'REGISTRATION_EDIT_FAILED',message:e.message});
  }finally{c.release()}
});

app.post('/api/admin/captain-registrations/:id/approve',auth,async(req,res)=>{
  const c=await pool.connect();
  try{
    await c.query('BEGIN');
    const q=await c.query(`SELECT * FROM captain_registration_requests WHERE id=$1 FOR UPDATE`,[req.params.id]);
    if(!q.rowCount){await c.query('ROLLBACK');return res.status(404).json({ok:false,error:'REQUEST_NOT_FOUND'})}
    const r=q.rows[0];
    if(r.status!=='pending'){await c.query('ROLLBACK');return res.status(409).json({ok:false,error:'REQUEST_NOT_PENDING'})}
    const docs=await c.query(`SELECT file_kind FROM captain_registration_files WHERE request_id=$1`,[r.id]);
    const kinds=new Set(docs.rows.map(x=>x.file_kind));
    if(!['identity','vehicle_license'].every(k=>kinds.has(k))){await c.query('ROLLBACK');return res.status(409).json({ok:false,error:'DOCUMENTS_REQUIRED'})}
    const name=String(r.name||'').trim().replace(/\s+/g,' '),nameKey=normalizeCaptainName(name),phone=normalizePhone(r.phone);
    const pe=await c.query(`SELECT name,phone FROM captains WHERE phone=$1 LIMIT 1 FOR UPDATE`,[phone]);
    if(pe.rowCount){await c.query('ROLLBACK');return res.status(409).json({ok:false,error:'PHONE_EXISTS',captain:pe.rows[0]})}
    const ne=await c.query(`SELECT name,phone FROM captains WHERE lower(regexp_replace(btrim(name),'\\s+',' ','g'))=$1 LIMIT 1 FOR UPDATE`,[nameKey]);
    if(ne.rowCount){await c.query('ROLLBACK');return res.status(409).json({ok:false,error:'NAME_EXISTS',captain:ne.rows[0]})}
    await c.query(`INSERT INTO captains(name,phone,password,active,onboarding_completed,password_changed,status_reason,status_checked_at) VALUES($1,$2,'[encrypted]',true,false,false,'تمت الموافقة على طلب تسجيل جديد',now())`,[name,phone]);
    await setCaptainPassword(c,phone,'123456',{changed:false});
    await c.query(`UPDATE captain_registration_requests SET status='approved',reviewed_by=$2,reviewed_at=now(),updated_at=now(),admin_note='' WHERE id=$1`,[r.id,String(req.user?.username||'admin')]);
    await c.query(`INSERT INTO audit_log(action,details) VALUES('CAPTAIN_REGISTRATION_APPROVED',$1)`,[{request_id:r.id,name,phone}]);
    await c.query('COMMIT');
    const reconciled=await reconcileForPhones([phone]);
    res.json({ok:true,phone,name,reconciled});
  }catch(e){
    try{await c.query('ROLLBACK')}catch{}
    console.error('CAPTAIN REGISTRATION APPROVE ERROR',e);
    res.status(500).json({ok:false,error:'REGISTRATION_APPROVE_FAILED',message:e.message});
  }finally{c.release()}
});

app.post('/api/admin/captain-registrations/:id/reject',auth,async(req,res)=>{
  try{
    const note=String(req.body?.note||'').trim().slice(0,500);
    const q=await pool.query(`UPDATE captain_registration_requests SET status='rejected',admin_note=$2,reviewed_by=$3,reviewed_at=now(),updated_at=now() WHERE id=$1 AND status='pending' RETURNING *`,[req.params.id,note,String(req.user?.username||'admin')]);
    if(!q.rowCount)return res.status(409).json({ok:false,error:'REQUEST_NOT_PENDING'});
    await audit('CAPTAIN_REGISTRATION_REJECTED',{request_id:q.rows[0].id,name:q.rows[0].name,phone:q.rows[0].phone,note});
    res.json({ok:true});
  }catch(e){res.status(500).json({ok:false,error:'REGISTRATION_REJECT_FAILED',message:e.message})}
});


// V3.5.5 — Global transfer-to-system settings (shown to every captain)
app.get('/api/admin/system-transfer-settings',auth,async(req,res)=>{
  try{res.json({ok:true,data:await getSystemTransferSettings()})}
  catch(e){res.status(500).json({ok:false,error:'SYSTEM_TRANSFER_SETTINGS_FAILED',message:e.message})}
});
app.patch('/api/admin/system-transfer-settings',auth,async(req,res)=>{
  try{
    const methodName=String(req.body?.method_name||'').trim().slice(0,80);
    const accountName=String(req.body?.account_name||'').trim().slice(0,120);
    const accountNumber=String(req.body?.account_number||'').trim().slice(0,120);
    const note=String(req.body?.note||'').trim().slice(0,500);
    if(!methodName||!accountName||!accountNumber)return res.status(400).json({ok:false,error:'SYSTEM_TRANSFER_FIELDS_REQUIRED'});
    const q=await pool.query(`INSERT INTO system_transfer_settings(id,method_name,account_name,account_number,note,updated_at)
      VALUES(1,$1,$2,$3,$4,now()) ON CONFLICT(id) DO UPDATE SET method_name=EXCLUDED.method_name,account_name=EXCLUDED.account_name,account_number=EXCLUDED.account_number,note=EXCLUDED.note,updated_at=now() RETURNING method_name,account_name,account_number,note,updated_at`,[methodName,accountName,accountNumber,note]);
    await audit('SYSTEM_TRANSFER_SETTINGS_UPDATED',{method_name:methodName,account_name:accountName,account_number:accountNumber,note});
    res.json({ok:true,data:q.rows[0]});
  }catch(e){res.status(500).json({ok:false,error:'SYSTEM_TRANSFER_SETTINGS_UPDATE_FAILED',message:e.message})}
});

async function ensureCaptainExemptions(){await pool.query(`CREATE TABLE IF NOT EXISTS captain_charge_exemptions (captain_phone TEXT PRIMARY KEY REFERENCES captains(phone) ON UPDATE CASCADE ON DELETE CASCADE, floor_exempt BOOLEAN NOT NULL DEFAULT FALSE, deduction_exempt BOOLEAN NOT NULL DEFAULT FALSE, updated_at TIMESTAMPTZ NOT NULL DEFAULT now())`)}
app.put('/api/admin/captains/:phone/exemption',auth,async(req,res)=>{try{await ensureCaptainExemptions();const phone=normalizePhone(req.params.phone),floor=req.body?.floor_exempt,deduction=req.body?.deduction_exempt;if(!phone||typeof floor!=='boolean'||typeof deduction!=='boolean')return res.status(400).json({ok:false,error:'INVALID_EXEMPTION'});const q=await pool.query(`INSERT INTO captain_charge_exemptions(captain_phone,floor_exempt,deduction_exempt) SELECT phone,$2,$3 FROM captains WHERE phone=$1 ON CONFLICT(captain_phone) DO UPDATE SET floor_exempt=EXCLUDED.floor_exempt,deduction_exempt=EXCLUDED.deduction_exempt,updated_at=now() RETURNING *`,[phone,floor,deduction]);if(!q.rowCount)return res.status(404).json({ok:false,error:'CAPTAIN_NOT_FOUND'});await audit('CAPTAIN_EXEMPTION_CHANGED',{phone,floor_exempt:floor,deduction_exempt:deduction});res.json({ok:true,row:q.rows[0]})}catch(e){res.status(500).json({ok:false,error:'EXEMPTION_SAVE_FAILED',message:e.message})}});
// Read-only UTF-8 CSV export opens in Excel (no new dependencies).
app.get('/api/admin/export-captains',auth,async(req,res)=>{
  try{
    const q=await pool.query('SELECT name,phone,active,status_reason,payment_method,payment_details,created_at FROM captains ORDER BY active DESC,name ASC');
    const headings=['اسم الكابتن','رقم الهاتف','الحالة','سبب الحالة','طريقة التحويل','تفاصيل التحويل','تاريخ الإضافة'];
    const quote=v=>'"'+String(v??'').replace(/"/g,'""').replace(/^[=+@-]/,m=>"'"+m)+'"';
    const lines=[headings.map(quote).join(',')];
    for(const r of q.rows)lines.push([r.name,r.phone,r.active?'فعال':'موقوف',r.status_reason,r.payment_method,r.payment_details,r.created_at?new Date(r.created_at).toISOString():''].map(quote).join(','));
    res.setHeader('Content-Type','text/csv; charset=utf-8');
    res.setHeader('Content-Disposition','attachment; filename="Captains_Export.csv"');
    res.setHeader('Cache-Control','no-store');
    res.send('\\uFEFF'.replace('\\uFEFF','\uFEFF')+lines.join('\\r\\n'.replace('\\r\\n','\r\n')));
  }catch(e){res.status(500).json({ok:false,error:'CAPTAINS_EXPORT_FAILED'});}
});

app.get('/api/admin/captains-list',auth,async(req,res)=>{
  await ensureCaptainExemptions();
  const r=await pool.query(`SELECT captains.id,captains.name,captains.phone,captains.active,captains.status_reason,captains.status_checked_at,captains.last_group_seen_at,captains.password_changed,captains.onboarding_completed,captains.payment_method,captains.payment_details,captains.payment_updated_at,captains.last_login_at,captains.created_at,captains.updated_at,COALESCE(e.floor_exempt,false) floor_exempt,COALESCE(e.deduction_exempt,false) deduction_exempt FROM captains LEFT JOIN captain_charge_exemptions e ON e.captain_phone=captains.phone ORDER BY captains.active DESC, CASE WHEN captains.name ~* '^[[:space:]]*T[[:space:]]*[0-9]+' THEN regexp_replace(captains.name,'[^0-9]','','g')::bigint ELSE 9223372036854775807 END, captains.name ASC`);
  res.json({ok:true,rows:r.rows});
});

app.patch('/api/admin/captains/:phone',auth,async(req,res)=>{
  const oldPhone=normalizePhone(req.params.phone), newPhone=normalizePhone(req.body?.phone||oldPhone);
  const name=String(req.body?.name||'').trim().replace(/\s+/g,' '), nameKey=normalizeCaptainName(name); const active=req.body?.active;
  const paymentMethod=req.body?.payment_method===undefined?null:String(req.body?.payment_method||'').trim();
  const paymentDetails=req.body?.payment_details===undefined?null:(req.body?.payment_details&&typeof req.body.payment_details==='object'?req.body.payment_details:{});
  const allowedPaymentMethods=['','cliq','wallet','bank','cash','other'];
  if(paymentMethod!==null&&!allowedPaymentMethods.includes(paymentMethod))return res.status(400).json({ok:false,error:'INVALID_PAYMENT_METHOD'});
  if(!oldPhone||!newPhone||!name)return res.status(400).json({ok:false,error:'INVALID_CAPTAIN'});
  const c=await pool.connect();
  try{
    await c.query('BEGIN');
    const current=await c.query(`SELECT name,phone FROM captains WHERE phone=$1 FOR UPDATE`,[oldPhone]);
    if(!current.rowCount){await c.query('ROLLBACK');return res.status(404).json({ok:false,error:'CAPTAIN_NOT_FOUND'});}
    const phoneDup=await c.query(`SELECT name,phone FROM captains WHERE phone=$1 AND phone<>$2 LIMIT 1 FOR UPDATE`,[newPhone,oldPhone]);
    if(phoneDup.rowCount){await c.query('ROLLBACK');return res.status(409).json({ok:false,error:'PHONE_EXISTS',captain:phoneDup.rows[0]});}
    const nameDup=await c.query(`SELECT name,phone FROM captains WHERE phone<>$1 AND lower(regexp_replace(btrim(name),'\\s+',' ','g'))=$2 LIMIT 1 FOR UPDATE`,[oldPhone,nameKey]);
    if(nameDup.rowCount){await c.query('ROLLBACK');return res.status(409).json({ok:false,error:'NAME_EXISTS',captain:nameDup.rows[0]});}
    await c.query(`UPDATE captains SET name=$2,phone=$3,active=COALESCE($4,active),
      payment_method=CASE WHEN $5::text IS NULL THEN payment_method ELSE $5 END,
      payment_details=CASE WHEN $5::text IS NULL THEN payment_details ELSE COALESCE($6::jsonb,'{}'::jsonb) END,
      payment_updated_at=CASE WHEN $5::text IS NULL THEN payment_updated_at ELSE now() END,
      status_reason=CASE WHEN $4::boolean IS NULL THEN status_reason WHEN $4 THEN 'تفعيل يدوي' ELSE 'إيقاف يدوي' END,updated_at=now()
      WHERE phone=$1`,[oldPhone,name,newPhone,typeof active==='boolean'?active:null,paymentMethod,paymentDetails===null?null:JSON.stringify(paymentDetails)]);
    if(oldPhone!==newPhone){
      await c.query(`UPDATE captain_balances SET captain_phone=$2 WHERE captain_phone=$1`,[oldPhone,newPhone]);
      await c.query(`UPDATE claims SET producer_phone=$2 WHERE producer_phone=$1`,[oldPhone,newPhone]);
      await c.query(`UPDATE claims SET consumer_phone=$2 WHERE consumer_phone=$1`,[oldPhone,newPhone]);
      await c.query(`UPDATE movements SET captain_phone=$2 WHERE captain_phone=$1`,[oldPhone,newPhone]);
      await c.query(`UPDATE weekly_charges SET captain_phone=$2 WHERE captain_phone=$1`,[oldPhone,newPhone]);
      await c.query(`UPDATE weekly_adjustments SET captain_phone=$2 WHERE captain_phone=$1`,[oldPhone,newPhone]);
      await c.query(`UPDATE manual_movements SET captain_phone=$2 WHERE captain_phone=$1`,[oldPhone,newPhone]);
      await c.query(`UPDATE weekly_balance_corrections SET captain_phone=$2 WHERE captain_phone=$1`,[oldPhone,newPhone]);
      await c.query(`UPDATE weekly_settlements SET captain_phone=$2 WHERE captain_phone=$1`,[oldPhone,newPhone]);
    }
    await c.query('COMMIT');
    await audit('CAPTAIN_UPDATED',{oldPhone,newPhone,name,active,payment_method:paymentMethod,payment_details:paymentDetails}).catch(()=>{});
    res.json({ok:true,payment_method:paymentMethod,payment_details:paymentDetails});
  }catch(e){try{await c.query('ROLLBACK')}catch{};if(e?.code==='23505')return res.status(409).json({ok:false,error:'PHONE_EXISTS'});res.status(500).json({ok:false,error:'CAPTAIN_UPDATE_FAILED',message:e.message});}finally{c.release();}
});

app.delete('/api/admin/captains/:phone',auth,async(req,res)=>{
  const p=normalizePhone(req.params.phone);
  if(!p)return res.status(400).json({ok:false,error:'PHONE_REQUIRED'});
  const c=await pool.connect();
  try{
    await c.query('BEGIN');
    const cap=await c.query(`SELECT name,phone FROM captains WHERE phone=$1 FOR UPDATE`,[p]);
    if(!cap.rowCount){await c.query('ROLLBACK');return res.status(404).json({ok:false,error:'CAPTAIN_NOT_FOUND'});}
    const claims=await c.query(`SELECT DISTINCT id FROM claims WHERE producer_phone=$1 OR consumer_phone=$1 FOR UPDATE`,[p]);
    const claimIds=claims.rows.map(x=>x.id);
    if(claimIds.length){
      await c.query(`UPDATE movements SET status='cancelled',cancelled_at=COALESCE(cancelled_at,now()) WHERE claim_id=ANY($1::bigint[]) AND status='active'`,[claimIds]);
      await c.query(`UPDATE claims SET status='cancelled',cancelled_by='admin_delete',updated_at=now() WHERE id=ANY($1::bigint[])`,[claimIds]);
      await c.query(`DELETE FROM sheet_sync_queue WHERE claim_id=ANY($1::bigint[])`,[claimIds]);
      await c.query(`DELETE FROM reaction_log WHERE claim_id=ANY($1::bigint[])`,[claimIds]);
      await c.query(`DELETE FROM whatsapp_messages w WHERE NOT EXISTS(SELECT 1 FROM claims cl WHERE cl.group_id=w.group_id AND (cl.original_message_id=w.message_id OR cl.reply_message_id=w.message_id)) AND w.sender_phone=$2`,[claimIds,p]);
      await c.query(`DELETE FROM claims WHERE id=ANY($1::bigint[])`,[claimIds]);
    }
    await c.query(`DELETE FROM captain_balances WHERE captain_phone=$1`,[p]);
    await c.query(`DELETE FROM weekly_charges WHERE captain_phone=$1`,[p]);
    await c.query(`DELETE FROM weekly_adjustments WHERE captain_phone=$1`,[p]);
    await c.query(`DELETE FROM weekly_balance_corrections WHERE captain_phone=$1`,[p]);
    await c.query(`DELETE FROM manual_movements WHERE captain_phone=$1`,[p]);
    await c.query(`DELETE FROM weekly_settlements WHERE captain_phone=$1`,[p]);
    await c.query(`DELETE FROM captain_notifications WHERE captain_phone=$1`,[p]);
    await c.query(`DELETE FROM captain_objections WHERE captain_phone=$1`,[p]);
    await c.query(`DELETE FROM captain_password_recovery WHERE captain_phone=$1`,[p]);
    await c.query(`DELETE FROM captain_login_log WHERE captain_phone=$1`,[p]);
    await c.query(`DELETE FROM support_tickets WHERE captain_phone=$1`,[p]);
    await c.query(`DELETE FROM captains WHERE phone=$1`,[p]);
    await c.query(`INSERT INTO audit_log(action,details) VALUES('CAPTAIN_DELETED',$1)`,[{phone:p,name:cap.rows[0].name,claims_deleted:claimIds.length}]);
    await c.query('COMMIT');
    res.json({ok:true,claims_deleted:claimIds.length});
  }catch(e){await c.query('ROLLBACK');console.error('DELETE CAPTAIN ERROR',e);res.status(500).json({ok:false,error:'CAPTAIN_DELETE_FAILED',message:e.message});}finally{c.release();}
});

app.post('/api/admin/weekly/manual-movement',auth,async(req,res)=>{
  try{
    const w=await getOpenWeek(), phone=normalizePhone(req.body?.phone), direction=String(req.body?.direction||''), orderCount=Number(req.body?.order_count||0), note=String(req.body?.note||'').trim();
    if(!phone||!['production','consumption'].includes(direction)||!Number.isInteger(orderCount)||orderCount<1||orderCount>100000)return res.status(400).json({ok:false,error:'INVALID_ORDER_COUNT'});
    if(!(await pool.query(`SELECT 1 FROM captains WHERE phone=$1`,[phone])).rowCount)return res.status(404).json({ok:false,error:'CAPTAIN_NOT_FOUND'});
    const amount=Number((orderCount*0.25).toFixed(3));
    const q=await pool.query(`INSERT INTO manual_movements(week_id,captain_phone,direction,product_name,product_id,amount,note,order_count) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,[w.id,phone,direction,'عدد أوردرات يدوي',String(orderCount),amount,note,orderCount]);
    await audit('MANUAL_ORDER_COUNT_ADDED',{week_id:w.id,id:q.rows[0].id,phone,direction,order_count:orderCount,rate:0.25,amount,note});
    res.json({ok:true,row:q.rows[0],rate:0.25});
  }catch(e){res.status(500).json({ok:false,error:'MANUAL_MOVEMENT_FAILED',message:e.message});}
});

app.get('/api/admin/weekly/manual-movements',auth,async(req,res)=>{try{const w=await getOpenWeek();const r=await pool.query(`SELECT m.*,c.name FROM manual_movements m LEFT JOIN captains c ON c.phone=m.captain_phone WHERE m.week_id=$1 ORDER BY m.id DESC`,[w.id]);res.json({ok:true,rows:r.rows})}catch(e){res.status(500).json({ok:false,error:'MANUAL_MOVEMENTS_FAILED'})}});

app.delete('/api/admin/weekly/manual-movement/:id',auth,async(req,res)=>{try{const w=await getOpenWeek();const r=await pool.query(`DELETE FROM manual_movements WHERE id=$1 AND week_id=$2 RETURNING *`,[req.params.id,w.id]);if(!r.rowCount)return res.status(404).json({ok:false,error:'NOT_FOUND'});await audit('MANUAL_MOVEMENT_DELETED',{id:Number(req.params.id),week_id:w.id});res.json({ok:true})}catch(e){res.status(500).json({ok:false,error:'MANUAL_MOVEMENT_DELETE_FAILED'})}});

app.post('/api/admin/weekly/balance-correction',auth,async(req,res)=>{
  try{
    const w=await getOpenWeek(), phone=normalizePhone(req.body?.phone), target=Number(req.body?.target_net), note=String(req.body?.note||'').trim();
    if(!phone||!Number.isFinite(target))return res.status(400).json({ok:false,error:'INVALID_BALANCE_CORRECTION'});
    if(!(await pool.query(`SELECT 1 FROM captains WHERE phone=$1`,[phone])).rowCount)return res.status(404).json({ok:false,error:'CAPTAIN_NOT_FOUND'});
    const rows=await weeklyRows(w.id), current=rows.find(x=>x.phone===phone);
    if(!current)return res.status(404).json({ok:false,error:'CAPTAIN_NOT_FOUND'});
    const previous=Number(current.net||0),delta=target-previous;
    if(Math.abs(delta)<0.0005)return res.status(400).json({ok:false,error:'NO_BALANCE_CHANGE'});
    const q=await pool.query(`INSERT INTO weekly_balance_corrections(week_id,captain_phone,previous_net,target_net,delta,note) VALUES($1,$2,$3,$4,$5,$6) RETURNING *`,[w.id,phone,previous,target,delta,note]);
    await audit('WEEKLY_BALANCE_CORRECTED',{week_id:w.id,phone,previous,target,delta,note,id:q.rows[0].id});res.json({ok:true,row:q.rows[0]});
  }catch(e){res.status(500).json({ok:false,error:'BALANCE_CORRECTION_FAILED',message:e.message});}
});

app.get('/api/admin/weekly/balance-corrections',auth,async(req,res)=>{try{const w=await getOpenWeek();const r=await pool.query(`SELECT b.*,c.name FROM weekly_balance_corrections b LEFT JOIN captains c ON c.phone=b.captain_phone WHERE b.week_id=$1 ORDER BY b.id DESC`,[w.id]);res.json({ok:true,rows:r.rows})}catch(e){res.status(500).json({ok:false,error:'BALANCE_CORRECTIONS_FAILED'})}});

app.get('/api/admin/daily-ledger',auth,async(req,res)=>{
  try{
    const rows=await pool.query(`
      WITH today_moves AS (
        SELECT
          m.id,m.claim_id,m.direction,m.captain_phone,m.amount,m.reaction,
          m.status,m.version_no,m.created_at
        FROM movements m
        WHERE m.status='active'
          AND m.created_at >= ((now() AT TIME ZONE 'Asia/Amman')::date AT TIME ZONE 'Asia/Amman')
          AND m.created_at < (((now() AT TIME ZONE 'Asia/Amman')::date + interval '1 day') AT TIME ZONE 'Asia/Amman')
      ),
      claim_moves AS (
        SELECT
          c.id claim_id,
          c.group_id,
          c.original_message_id,
          c.reply_message_id,
          c.producer_phone,
          COALESCE(pc.name,c.producer_name,c.producer_phone) producer_name,
          c.consumer_phone,
          COALESCE(cc.name,c.consumer_name,c.consumer_phone) consumer_name,
          c.status claim_status,
          c.current_reaction,
          c.current_value,
          c.approved_by,
          MIN(tm.created_at) applied_at,
          COALESCE(SUM(CASE WHEN tm.direction='production' THEN tm.amount ELSE 0 END),0) production,
          COALESCE(SUM(CASE WHEN tm.direction='consumption' THEN tm.amount ELSE 0 END),0) consumption
        FROM today_moves tm
        JOIN claims c ON c.id=tm.claim_id
        LEFT JOIN captains pc ON pc.phone=c.producer_phone
        LEFT JOIN captains cc ON cc.phone=c.consumer_phone
        GROUP BY c.id,pc.name,cc.name
      )
      SELECT *
      FROM claim_moves
      ORDER BY applied_at DESC,claim_id DESC
      LIMIT 1000
    `);

    const pending=await pool.query(`
      SELECT
        c.id claim_id,
        c.group_id,
        c.producer_phone,
        COALESCE(pc.name,c.producer_name,c.producer_phone) producer_name,
        c.consumer_phone,
        COALESCE(cc.name,c.consumer_name,c.consumer_phone) consumer_name,
        c.current_reaction,
        c.current_value,
        c.updated_at
      FROM claims c
      LEFT JOIN captains pc ON pc.phone=c.producer_phone
      LEFT JOIN captains cc ON cc.phone=c.consumer_phone
      WHERE c.status='waiting_registration'
        AND c.updated_at >= ((now() AT TIME ZONE 'Asia/Amman')::date AT TIME ZONE 'Asia/Amman')
        AND c.updated_at < (((now() AT TIME ZONE 'Asia/Amman')::date + interval '1 day') AT TIME ZONE 'Asia/Amman')
      ORDER BY c.updated_at DESC
      LIMIT 500
    `);

    const summary=rows.rows.reduce((a,x)=>{
      a.orders++;
      a.production+=Number(x.production||0);
      a.consumption+=Number(x.consumption||0);
      return a;
    },{orders:0,production:0,consumption:0});

    res.set('Cache-Control','no-store');
    res.json({
      ok:true,
      date:new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Amman',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date()),
      timezone:'Asia/Amman',
      summary:{...summary,pending_registration:pending.rowCount},
      rows:rows.rows,
      pending:pending.rows
    });
  }catch(e){
    res.status(500).json({ok:false,error:'DAILY_LEDGER_FAILED',message:e.message});
  }
});

app.get('/api/admin/weekly/current',auth,async(req,res)=>{
  try{
    const w=await getOpenWeek(); const rows=await weeklyRows(w.id);
    const totals=rows.reduce((a,x)=>{
      const production=Number(x.production||0),consumption=Number(x.consumption||0),floor=Number(x.floor_fee||0),old=Number(x.old_balance||0),n=Number(x.net||0);
      a.production+=production;a.consumption+=consumption;a.floor+=floor;a.oldBalance+=old;
      // Final net is kept for settlement. For the dashboard we also expose the CURRENT-WEEK
      // balance before old debt, so old balances can be shown in their own dedicated section.
      const currentNet=n+old;
      if(currentNet>0)a.currentToCaptains+=currentNet;
      if(currentNet<0)a.currentFromCaptains+=Math.abs(currentNet);
      if(n>0)a.toCaptains+=n;if(n<0)a.fromCaptains+=Math.abs(n);
      return a;
    },{production:0,consumption:0,floor:0,oldBalance:0,currentToCaptains:0,currentFromCaptains:0,toCaptains:0,fromCaptains:0});
    res.json({ok:true,week:w,rows,totals});
  }catch(e){res.status(500).json({ok:false,error:'WEEKLY_CURRENT_FAILED',message:e.message});}
});

// All currently-unpaid historical balances, across every closed week.
// We take the latest payable settlement per captain because older settlements that were
// consolidated forward are history-only and must never be counted twice.
app.get('/api/admin/weekly/old-balances',auth,async(req,res)=>{
  try{
    const r=await pool.query(`
      WITH latest_payable AS (
        SELECT DISTINCT ON (s.captain_phone)
          s.id,s.week_id,s.captain_phone,s.captain_name,s.net,s.old_balance,s.status,s.updated_at,
          w.starts_at,w.closed_at
        FROM weekly_settlements s
        JOIN accounting_weeks w ON w.id=s.week_id
        WHERE w.status='closed' AND w.trashed_at IS NULL
          AND s.net<0
          AND s.status NOT IN ('settled','carried_forward')
        ORDER BY s.captain_phone,s.week_id DESC,s.id DESC
      )
      SELECT * FROM latest_payable
      ORDER BY week_id ASC,captain_name ASC`);
    const rows=r.rows.map(x=>({...x,amount:Math.abs(Number(x.net||0))}));
    const total=rows.reduce((a,x)=>a+Number(x.amount||0),0);
    const captains=new Set(rows.map(x=>x.captain_phone)).size;
    res.set('Cache-Control','no-store');
    res.json({ok:true,rows,total,count:rows.length,captains});
  }catch(e){
    res.status(500).json({ok:false,error:'OLD_BALANCES_FAILED',message:e.message});
  }
});

app.post('/api/admin/weekly/floor',auth,async(req,res)=>{
  await ensureCaptainExemptions();
  const c=await pool.connect();
  try{
    await c.query('BEGIN'); const w=await getOpenWeek(c);
    if(w.floor_applied_at){await c.query('ROLLBACK');return res.status(409).json({ok:false,error:'FLOOR_ALREADY_APPLIED'});}
    const amount=Number(req.body?.amount??0.50);
    if(!Number.isFinite(amount)||amount<=0){await c.query('ROLLBACK');return res.status(400).json({ok:false,error:'INVALID_FLOOR'});}
    const ins=await c.query(`INSERT INTO weekly_charges(week_id,captain_phone,charge_type,amount,note)
      SELECT $1,cp.phone,'floor',$2,'أرضية أسبوعية' FROM captains cp WHERE cp.active=true AND NOT EXISTS (SELECT 1 FROM captain_charge_exemptions ex WHERE ex.captain_phone=cp.phone AND ex.floor_exempt=true)
      ON CONFLICT(week_id,captain_phone,charge_type) DO NOTHING RETURNING captain_phone`,[w.id,amount]);
    await c.query(`UPDATE accounting_weeks SET floor_amount=$2,floor_applied_at=now() WHERE id=$1`,[w.id,amount]);
    for(const r of ins.rows) await notifyCaptain(c,r.captain_phone,'info','تمت إضافة الأرضية الأسبوعية',`تم خصم أرضية ${amount.toFixed(2)} د.أ للأسبوع #${w.id}.`,{week_id:w.id,amount});
    await c.query(`INSERT INTO audit_log(action,details) VALUES('WEEKLY_FLOOR_APPLIED',$1)`,[{week_id:w.id,amount,count:ins.rowCount}]);
    await c.query('COMMIT'); res.json({ok:true,week_id:w.id,amount,count:ins.rowCount});
  }catch(e){await c.query('ROLLBACK');res.status(500).json({ok:false,error:'FLOOR_FAILED',message:e.message});}finally{c.release();}
});


app.post('/api/admin/weekly/floor/complete',auth,async(req,res)=>{
  await ensureCaptainExemptions();
  const c=await pool.connect();
  try{
    await c.query('BEGIN');
    const w=await getOpenWeek(c);
    const amount=w.floor_applied_at?Number(w.floor_amount||0.50):0.50;
    if(!Number.isFinite(amount)||amount<=0){await c.query('ROLLBACK');return res.status(400).json({ok:false,error:'INVALID_FLOOR'});}
    const eligible=await c.query(`SELECT COUNT(*)::int n FROM captains cp WHERE cp.active=true AND NOT EXISTS (SELECT 1 FROM captain_charge_exemptions ex WHERE ex.captain_phone=cp.phone AND ex.floor_exempt=true)`);
    const already=await c.query(`SELECT COUNT(*)::int n FROM weekly_charges WHERE week_id=$1 AND charge_type='floor'`,[w.id]);
    const ins=await c.query(`INSERT INTO weekly_charges(week_id,captain_phone,charge_type,amount,note)
      SELECT $1,cp.phone,'floor',$2,'استكمال الأرضية الأسبوعية'
      FROM captains cp
      WHERE cp.active=true
        AND NOT EXISTS (SELECT 1 FROM captain_charge_exemptions ex WHERE ex.captain_phone=cp.phone AND ex.floor_exempt=true)
        AND NOT EXISTS (
          SELECT 1 FROM weekly_charges wc
          WHERE wc.week_id=$1 AND wc.captain_phone=cp.phone AND wc.charge_type='floor'
        )
      ON CONFLICT(week_id,captain_phone,charge_type) DO NOTHING
      RETURNING captain_phone`,[w.id,amount]);
    await c.query(`UPDATE accounting_weeks SET floor_amount=$2,floor_applied_at=COALESCE(floor_applied_at,now()) WHERE id=$1`,[w.id,amount]);
    for(const r of ins.rows){
      await notifyCaptain(c,r.captain_phone,'info','تم استكمال الأرضية الأسبوعية',`تم خصم أرضية ${amount.toFixed(2)} د.أ للأسبوع #${w.id}.`,{week_id:w.id,amount,repair:true});
    }
    await c.query(`INSERT INTO audit_log(action,details) VALUES('WEEKLY_FLOOR_COMPLETED',$1)`,[{
      week_id:w.id,amount,eligible:Number(eligible.rows[0]?.n||0),already_before:Number(already.rows[0]?.n||0),added:ins.rowCount
    }]);
    await c.query('COMMIT');
    res.json({ok:true,week_id:w.id,amount,eligible:Number(eligible.rows[0]?.n||0),already:Number(already.rows[0]?.n||0),added:ins.rowCount});
  }catch(e){
    try{await c.query('ROLLBACK')}catch(_){}
    res.status(500).json({ok:false,error:'FLOOR_COMPLETE_FAILED',message:e.message});
  }finally{c.release();}
});

app.post('/api/admin/weekly/adjustments',auth,async(req,res)=>{
  try{
    const w=await getOpenWeek(), phone=normalizePhone(req.body?.phone), direction=String(req.body?.direction||''), amount=Number(req.body?.amount||0), note=String(req.body?.note||'').trim();
    if(!phone||!['production','consumption'].includes(direction)||!Number.isFinite(amount)||amount<=0)return res.status(400).json({ok:false,error:'INVALID_ADJUSTMENT'});
    if(!(await pool.query(`SELECT 1 FROM captains WHERE phone=$1`,[phone])).rowCount)return res.status(404).json({ok:false,error:'CAPTAIN_NOT_FOUND'});
    await pool.query(`INSERT INTO weekly_adjustments(week_id,captain_phone,direction,amount,note) VALUES($1,$2,$3,$4,$5)`,[w.id,phone,direction,amount,note]);
    await audit('WEEKLY_ADJUSTMENT_ADDED',{week_id:w.id,phone,direction,amount,note}); res.json({ok:true});
  }catch(e){res.status(500).json({ok:false,error:'ADJUSTMENT_FAILED',message:e.message});}
});
app.get('/api/admin/weekly/adjustments',auth,async(req,res)=>{
  const w=await getOpenWeek();
  const r=await pool.query(`SELECT a.*,c.name FROM weekly_adjustments a LEFT JOIN captains c ON c.phone=a.captain_phone WHERE a.week_id=$1 ORDER BY a.id DESC`,[w.id]);
  res.json({ok:true,rows:r.rows});
});
app.delete('/api/admin/weekly/adjustments/:id',auth,async(req,res)=>{
  const w=await getOpenWeek(); const r=await pool.query(`DELETE FROM weekly_adjustments WHERE id=$1 AND week_id=$2 RETURNING *`,[req.params.id,w.id]);
  if(!r.rowCount)return res.status(404).json({ok:false,error:'NOT_FOUND'});
  await audit('WEEKLY_ADJUSTMENT_DELETED',{id:req.params.id,week_id:w.id}); res.json({ok:true});
});

app.post('/api/admin/weekly/close',auth,async(req,res)=>{
  const c=await pool.connect();
  try{
    await c.query('BEGIN');
    await c.query('SELECT pg_advisory_xact_lock(250025)');
    const wq=await c.query(`SELECT * FROM accounting_weeks WHERE status='open' ORDER BY id DESC LIMIT 1 FOR UPDATE`);
    if(!wq.rowCount){await c.query('ROLLBACK');return res.status(409).json({ok:false,error:'NO_OPEN_WEEK'});}
    const w=wq.rows[0];
    if(Number(req.body?.expected_week_id)!==Number(w.id)){await c.query('ROLLBACK');return res.status(409).json({ok:false,error:'WEEK_CHANGED',message:'الأسبوع تغيّر؛ حدّث البيانات قبل التسكير.'});}
    // Backfill the immediately previous unpaid week as old balance, including when this
    // feature is deployed in the middle of an already-open week.
    await ensureOldBalanceCarry(c,w.id);
    // If an older settlement was paid during this open week, its carried old-balance charge
    // should already be removed by mark-received. This cleanup protects against legacy rows.
    await c.query(`DELETE FROM weekly_charges wc
      USING weekly_settlements s
      WHERE wc.week_id=$1 AND wc.charge_type='old_balance'
        AND wc.source_settlement_id=s.id AND s.status='settled'`,[w.id]);
    const rowsQ=await c.query(`
      WITH mov AS (
        SELECT cp.phone,
          COALESCE(SUM(CASE WHEN m.status='active' AND m.direction='production' THEN m.amount ELSE 0 END),0) production,
          COALESCE(SUM(CASE WHEN m.status='active' AND m.direction='consumption' THEN m.amount ELSE 0 END),0) consumption
        FROM captains cp LEFT JOIN claims cl ON cl.week_id=$1 LEFT JOIN movements m ON m.claim_id=cl.id AND m.captain_phone=cp.phone GROUP BY cp.phone
      ), manual AS (
        SELECT captain_phone,COALESCE(SUM(CASE WHEN direction='production' THEN amount ELSE 0 END),0) production_manual,
          COALESCE(SUM(CASE WHEN direction='consumption' THEN amount ELSE 0 END),0) consumption_manual
        FROM manual_movements WHERE week_id=$1 GROUP BY captain_phone
      ), adj AS (
        SELECT captain_phone,COALESCE(SUM(CASE WHEN direction='production' THEN amount ELSE 0 END),0) production_adj,
          COALESCE(SUM(CASE WHEN direction='consumption' THEN amount ELSE 0 END),0) consumption_adj
        FROM weekly_adjustments WHERE week_id=$1 GROUP BY captain_phone
      ), corr AS (SELECT captain_phone,COALESCE(SUM(delta),0) delta FROM weekly_balance_corrections WHERE week_id=$1 GROUP BY captain_phone), ch AS (
        SELECT captain_phone,
          COALESCE(SUM(CASE WHEN charge_type='floor' THEN amount ELSE 0 END),0) floor_fee,
          COALESCE(SUM(CASE WHEN charge_type='old_balance' THEN amount ELSE 0 END),0) old_balance
        FROM weekly_charges WHERE week_id=$1 GROUP BY captain_phone
      )
      SELECT cp.name,cp.phone,COALESCE(m.production,0)+COALESCE(mm.production_manual,0)+COALESCE(a.production_adj,0) production,
        COALESCE(m.consumption,0)+COALESCE(mm.consumption_manual,0)+COALESCE(a.consumption_adj,0) consumption,
        COALESCE(ch.floor_fee,0) floor_fee,COALESCE(ch.old_balance,0) old_balance,COALESCE(corr.delta,0) correction_delta
      FROM captains cp LEFT JOIN mov m ON m.phone=cp.phone LEFT JOIN manual mm ON mm.captain_phone=cp.phone LEFT JOIN adj a ON a.captain_phone=cp.phone LEFT JOIN corr ON corr.captain_phone=cp.phone LEFT JOIN ch ON ch.captain_phone=cp.phone
    `,[w.id]);
    // Any unpaid debt that entered THIS week as "old balance" is now consolidated into
    // this week's settlement. The older settlement becomes history-only (carried_forward)
    // so the same debt can never be collected twice.
    const carriedPrev=await c.query(`UPDATE weekly_settlements s
      SET status='carried_forward',updated_at=now()
      FROM weekly_charges wc
      WHERE wc.week_id=$1 AND wc.charge_type='old_balance'
        AND wc.source_settlement_id=s.id AND s.status<>'settled' AND s.status<>'carried_forward'
      RETURNING s.id,s.captain_phone`,[w.id]);

    for(const x of rowsQ.rows){
      const oldBalance=Number(x.old_balance||0);
      const net=Number(x.production)-Number(x.consumption)-Number(x.floor_fee)-oldBalance+Number(x.correction_delta||0);
      const status=Math.abs(net)<0.0005?'settled':'pending';
      await c.query(`INSERT INTO weekly_settlements(week_id,captain_phone,captain_name,production,consumption,floor_fee,old_balance,net,status)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)
        ON CONFLICT(week_id,captain_phone) DO UPDATE SET captain_name=EXCLUDED.captain_name,production=EXCLUDED.production,
        consumption=EXCLUDED.consumption,floor_fee=EXCLUDED.floor_fee,old_balance=EXCLUDED.old_balance,
        net=EXCLUDED.net,status=EXCLUDED.status,updated_at=now()`,
        [w.id,x.phone,x.name,x.production,x.consumption,x.floor_fee,oldBalance,net,status]);
    }
    await c.query(`UPDATE accounting_weeks SET status='closed',closed_at=now() WHERE id=$1`,[w.id]);
    const nw=await c.query(`INSERT INTO accounting_weeks(starts_at,status) VALUES(now(),'open') RETURNING *`);

    // Negative unsettled balances are mirrored into the NEW open week as one idempotent
    // charge named "old_balance". The source settlement stays payable during the new week.
    // If it gets paid, mark-received removes this charge immediately. If it stays unpaid
    // until the next close, it is consolidated and the source settlement becomes carried_forward.
    const carry=await c.query(`INSERT INTO weekly_charges(week_id,captain_phone,charge_type,amount,note,source_settlement_id)
      SELECT $2,s.captain_phone,'old_balance',ABS(s.net),$3,s.id
      FROM weekly_settlements s
      WHERE s.week_id=$1 AND s.net<0 AND s.status='pending'
      ON CONFLICT DO NOTHING
      RETURNING captain_phone,amount,source_settlement_id`,[w.id,nw.rows[0].id,`رصيد قديم من الأسبوع #${w.id}`]);

    for(const x of rowsQ.rows){
      const oldBalance=Number(x.old_balance||0);
      const net=Number(x.production)-Number(x.consumption)-Number(x.floor_fee)-oldBalance+Number(x.correction_delta||0);
      await notifyCaptain(c,x.phone,'info','تم إغلاق الجرد الأسبوعي',
        net>0?`إلك ${net.toFixed(2)} د.أ في الأسبوع #${w.id}.`:
        net<0?`عليك ${Math.abs(net).toFixed(2)} د.أ في الأسبوع #${w.id}. ظهر المبلغ في الأسبوع الجديد كرصد قديم حتى تتم التسوية.`:
        `الأسبوع #${w.id} متعادل.`,
        {week_id:w.id,net,old_balance:oldBalance,new_week_id:nw.rows[0].id});
    }
    await c.query(`INSERT INTO audit_log(action,details) VALUES('WEEK_CLOSED',$1)`,[{
      closed_week_id:w.id,new_week_id:nw.rows[0].id,count:rowsQ.rowCount,
      old_balances_carried:carry.rowCount,previous_settlements_consolidated:carriedPrev.rowCount
    }]);
    await c.query('COMMIT'); res.json({
      ok:true,closed_week_id:w.id,new_week:nw.rows[0],settlements:rowsQ.rowCount,
      old_balances_carried:carry.rowCount,previous_settlements_consolidated:carriedPrev.rowCount
    });
  }catch(e){await c.query('ROLLBACK');res.status(500).json({ok:false,error:'WEEK_CLOSE_FAILED',message:e.message});}finally{c.release();}
});

app.get('/api/admin/weekly/archive',auth,async(req,res)=>{
  const r=await pool.query(`SELECT w.*,COUNT(s.id)::int captains,
    COALESCE(SUM(CASE WHEN s.net>0 THEN s.net ELSE 0 END),0)::numeric to_captains,
    COALESCE(SUM(CASE WHEN s.net<0 THEN -s.net ELSE 0 END),0)::numeric from_captains,
    COALESCE(SUM(s.floor_fee),0)::numeric floor_total,COUNT(*) FILTER (WHERE s.status NOT IN ('settled','carried_forward'))::int pending
    FROM accounting_weeks w LEFT JOIN weekly_settlements s ON s.week_id=w.id WHERE w.status='closed' AND w.trashed_at IS NULL
    GROUP BY w.id ORDER BY w.id DESC LIMIT 100`);
  res.json({ok:true,rows:r.rows});
});
// Trash is a visibility-only change. Never cascade-delete settlements or adjust balances.
app.get('/api/admin/weekly/trash',auth,async(req,res)=>{
  try{const q=await pool.query(`SELECT id,starts_at,closed_at,trashed_at FROM accounting_weeks WHERE status='closed' AND trashed_at IS NOT NULL ORDER BY trashed_at DESC LIMIT 200`);res.json({ok:true,rows:q.rows});}
  catch(e){res.status(500).json({ok:false,error:'TRASH_LOAD_FAILED'});}
});
app.post('/api/admin/weekly/:id/trash',auth,async(req,res)=>{
  try{
    const q=await pool.query(`UPDATE accounting_weeks SET trashed_at=now() WHERE id=$1 AND status='closed' AND trashed_at IS NULL RETURNING id`,[req.params.id]);
    if(!q.rowCount)return res.status(409).json({ok:false,error:'WEEK_NOT_AVAILABLE'});
    await audit('WEEK_MOVED_TO_TRASH',{week_id:Number(req.params.id)});
    res.json({ok:true});
  }catch(e){res.status(500).json({ok:false,error:'WEEK_TRASH_FAILED'});}
});
app.post('/api/admin/weekly/:id/restore',auth,async(req,res)=>{
  try{
    const q=await pool.query(`UPDATE accounting_weeks SET trashed_at=NULL WHERE id=$1 AND status='closed' AND trashed_at IS NOT NULL RETURNING id`,[req.params.id]);
    if(!q.rowCount)return res.status(409).json({ok:false,error:'WEEK_NOT_IN_TRASH'});
    await audit('WEEK_RESTORED_FROM_TRASH',{week_id:Number(req.params.id)});
    res.json({ok:true});
  }catch(e){res.status(500).json({ok:false,error:'WEEK_RESTORE_FAILED'});}
});
app.get('/api/admin/weekly/:weekId/settlements',auth,async(req,res)=>{
  res.set('Cache-Control','no-store, no-cache, must-revalidate, proxy-revalidate');
  const r=await pool.query(`SELECT s.*,c.payment_method,c.payment_details,c.onboarding_completed,
    EXISTS(SELECT 1 FROM settlement_proofs p WHERE p.settlement_id=s.id AND p.direction='captain_to_admin') captain_proof,
    EXISTS(SELECT 1 FROM settlement_proofs p WHERE p.settlement_id=s.id AND p.direction='admin_to_captain') admin_proof
    FROM weekly_settlements s LEFT JOIN captains c ON c.phone=s.captain_phone WHERE s.week_id=$1 ORDER BY s.net DESC,s.captain_name ASC`,[req.params.weekId]);
  res.json({ok:true,rows:r.rows});
});
app.post('/api/admin/weekly/settlements/:id/mark-received',auth,async(req,res)=>{
  const c=await pool.connect();
  let settled=null,hadProof=false,clearedCarry=null;
  try{
    await c.query('BEGIN');
    const q=await c.query(`SELECT * FROM weekly_settlements WHERE id=$1 FOR UPDATE`,[req.params.id]);
    if(!q.rowCount){await c.query('ROLLBACK');return res.status(404).json({ok:false,error:'NOT_FOUND'});}
    const s=q.rows[0];
    if(Number(s.net)>=0){await c.query('ROLLBACK');return res.status(400).json({ok:false,error:'SETTLEMENT_NOT_OWED_BY_CAPTAIN'});}
    const currentStatus=String(s.status||'').toLowerCase();
    if(currentStatus==='carried_forward'){await c.query('ROLLBACK');return res.status(409).json({ok:false,error:'SETTLEMENT_CARRIED_FORWARD',message:'هذا الرصيد تم ترحيله ودمجه في أسبوع أحدث.'});}
    if(currentStatus==='settled'){await c.query('ROLLBACK');return res.json({ok:true,already:true,moved_to_completed:true,status:'settled'});}

    const proof=await c.query(`SELECT 1 FROM settlement_proofs WHERE settlement_id=$1 AND direction='captain_to_admin'`,[s.id]);
    hadProof=proof.rowCount>0;
    const upd=await c.query(`UPDATE weekly_settlements
      SET status='settled',admin_confirmed_at=now(),updated_at=now()
      WHERE id=$1
      RETURNING id,week_id,captain_phone,captain_name,net,status,admin_confirmed_at`,[s.id]);
    settled=upd.rows[0];
    await c.query(`DELETE FROM settlement_proofs WHERE settlement_id=$1 AND direction='captain_to_admin'`,[s.id]);
    const cleared=await c.query(`DELETE FROM weekly_charges wc
      USING accounting_weeks w
      WHERE wc.source_settlement_id=$1 AND wc.charge_type='old_balance'
        AND wc.week_id=w.id AND w.status='open'
      RETURNING wc.week_id,wc.amount`,[s.id]);
    clearedCarry=cleared.rows[0]||null;

    // IMPORTANT: commit the financial state FIRST. Any notification/audit problem after this
    // point must never undo "تم الاستلام". A failed SQL statement inside a PostgreSQL
    // transaction marks the whole transaction aborted even if JS catches the exception.
    await c.query('COMMIT');
  }catch(e){
    try{await c.query('ROLLBACK')}catch(_){}
    return res.status(500).json({ok:false,error:'MARK_RECEIVED_FAILED',message:e.message});
  }finally{c.release();}

  // Post-commit side effects only.
  try{await notifyCaptain(pool,settled.captain_phone,'success','تم استلام حوالتك','أكدت الإدارة استلام المبلغ وتمت التسوية.',{settlement_id:settled.id,amount:Math.abs(Number(settled.net))});}catch(e){console.error('SETTLEMENT NOTIFY ERROR',e.message)}
  try{await audit('CAPTAIN_PAYMENT_RECEIVED',{
    settlement_id:settled.id,phone:settled.captain_phone,amount:Math.abs(Number(settled.net)),had_proof:hadProof,
    cleared_old_balance:clearedCarry?Number(clearedCarry.amount):0,cleared_from_week:clearedCarry?Number(clearedCarry.week_id):null
  });}catch(e){console.error('SETTLEMENT AUDIT ERROR',e.message)}
  res.set('Cache-Control','no-store');
  res.json({ok:true,moved_to_completed:true,had_proof:hadProof,status:'settled',row:settled,
    cleared_old_balance:clearedCarry?Number(clearedCarry.amount):0,cleared_from_week:clearedCarry?Number(clearedCarry.week_id):null});
});
app.post('/api/admin/weekly/settlements/:id/transfer-proof',auth,upload.single('proof'),async(req,res)=>{
  try{
    if(!req.file)return res.status(400).json({ok:false,error:'IMAGE_REQUIRED'});
    const q=await pool.query(`SELECT * FROM weekly_settlements WHERE id=$1`,[req.params.id]);
    if(!q.rowCount)return res.status(404).json({ok:false,error:'NOT_FOUND'});
    const s=q.rows[0]; if(Number(s.net)<=0)return res.status(400).json({ok:false,error:'SETTLEMENT_NOT_OWED_TO_CAPTAIN'});
    await pool.query(`INSERT INTO settlement_proofs(settlement_id,direction,mime_type,file_name,file_data,uploaded_by)
      VALUES($1,'admin_to_captain',$2,$3,$4,'admin')
      ON CONFLICT(settlement_id,direction) DO UPDATE SET mime_type=EXCLUDED.mime_type,file_name=EXCLUDED.file_name,
      file_data=EXCLUDED.file_data,uploaded_by='admin',created_at=now()`,[s.id,req.file.mimetype,req.file.originalname,req.file.buffer]);
    await pool.query(`UPDATE weekly_settlements SET status='awaiting_captain_confirmation',updated_at=now() WHERE id=$1`,[s.id]);
    await notifyCaptain(pool,s.captain_phone,'success','تم تحويل مستحقاتك',`رفعت الإدارة إثبات تحويل ${Number(s.net).toFixed(2)} د.أ. افتح التسوية وأكد الوصول.`,{settlement_id:s.id,amount:Number(s.net)});
    await audit('ADMIN_TRANSFER_PROOF_UPLOADED',{settlement_id:s.id,phone:s.captain_phone,amount:Number(s.net)}); res.json({ok:true});
  }catch(e){res.status(500).json({ok:false,error:'PROOF_UPLOAD_FAILED',message:e.message});}
});
app.get('/api/admin/weekly/settlements/:id/proof/:direction',auth,async(req,res)=>{
  const dir=req.params.direction;if(!['captain_to_admin','admin_to_captain'].includes(dir))return res.status(400).end();
  const r=await pool.query(`SELECT mime_type,file_name,file_data FROM settlement_proofs WHERE settlement_id=$1 AND direction=$2`,[req.params.id,dir]);
  if(!r.rowCount)return res.status(404).end();res.setHeader('content-type',r.rows[0].mime_type);res.setHeader('cache-control','no-store');res.send(r.rows[0].file_data);
});

async function ensureNegativeGroupRemovalTable(){
  await pool.query(`
    CREATE TABLE IF NOT EXISTS negative_group_removals(
      id BIGSERIAL PRIMARY KEY,
      captain_phone TEXT NOT NULL,
      group_id TEXT NOT NULL,
      group_name TEXT NOT NULL DEFAULT '',
      removed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      restored_at TIMESTAMPTZ,
      restore_status TEXT NOT NULL DEFAULT '',
      last_error TEXT NOT NULL DEFAULT ''
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS negative_group_removals_phone_idx ON negative_group_removals(captain_phone,restored_at)`);
}

function dcParticipantPhone(p={}){
  for(const raw of [p.phoneNumber,p.pn,p.phone,p.id,p.jid]){
    const s=String(raw||'').trim();
    if(!s||s.endsWith('@lid'))continue;
    const ph=normalizePhone(s);
    if(/^9627\d{8}$/.test(ph))return ph;
  }
  return '';
}

function dcParticipantId(p={}){
  return String(p.id||p.jid||p.participant||p.chatId||'').trim();
}

app.get('/api/admin/negative-carry-candidates',auth,async(req,res)=>{
  try{
    const w=await getOpenWeek();
    const rows=await weeklyRows(w.id);
    const candidates=rows
      .filter(x=>Number(x.old_balance||0)>0 && Number(x.net||0)<0 && Boolean(x.active))
      .map(x=>({
        name:x.name,
        phone:x.phone,
        old_balance:Number(x.old_balance||0),
        current_net:Number(x.net||0),
        current_week_production:Number(x.production||0),
        current_week_consumption:Number(x.consumption||0),
        active:Boolean(x.active),
        status_reason:x.status_reason||''
      }))
      .sort((a,b)=>ammanOrderNumber(a.name)-ammanOrderNumber(b.name)||String(a.name||'').localeCompare(String(b.name||''),'ar'));
    res.set('Cache-Control','no-store');
    res.json({ok:true,week:{id:w.id,starts_at:w.starts_at},count:candidates.length,rows:candidates});
  }catch(e){
    res.status(500).json({ok:false,error:'NEGATIVE_CARRY_CANDIDATES_FAILED',message:e.message});
  }
});

app.get('/api/admin/negative-carry-removed',auth,async(req,res)=>{
  try{
    await ensureNegativeGroupRemovalTable();
    const w=await getOpenWeek();
    const weekly=await weeklyRows(w.id);
    const byPhone=new Map(weekly.map(x=>[x.phone,x]));
    const q=await pool.query(`
      SELECT ngr.captain_phone,
             max(c.name) captain_name,
             min(ngr.removed_at) removed_at,
             json_agg(json_build_object(
               'id',ngr.id,
               'group_id',ngr.group_id,
               'group_name',ngr.group_name,
               'removed_at',ngr.removed_at
             ) ORDER BY ngr.removed_at) FILTER (WHERE ngr.restored_at IS NULL) groups
      FROM negative_group_removals ngr
      LEFT JOIN captains c ON c.phone=ngr.captain_phone
      WHERE ngr.restored_at IS NULL
      GROUP BY ngr.captain_phone
      ORDER BY min(ngr.removed_at) DESC
    `);
    const rows=q.rows.map(r=>{
      const wk=byPhone.get(r.captain_phone)||{};
      return {
        phone:r.captain_phone,
        name:r.captain_name||wk.name||r.captain_phone,
        removed_at:r.removed_at,
        current_net:Number(wk.net||0),
        can_restore:true,
        groups:Array.isArray(r.groups)?r.groups:[]
      };
    });
    res.set('Cache-Control','no-store');
    res.json({ok:true,week:{id:w.id,starts_at:w.starts_at},count:rows.length,rows});
  }catch(e){
    res.status(500).json({ok:false,error:'NEGATIVE_REMOVED_LIST_FAILED',message:e.message});
  }
});

app.post('/api/admin/negative-carry-remove',auth,async(req,res)=>{
  try{
    await ensureNegativeGroupRemovalTable();
    if(!process.env.DROPCODE_API_URL||!process.env.DROPCODE_SESSION_ID||!process.env.DROPCODE_API_TOKEN){
      return res.status(400).json({ok:false,error:'DROPCODE_GROUP_REMOVE_NOT_CONFIGURED'});
    }

    const requested=Array.isArray(req.body?.phones)?req.body.phones:[];
    const phones=[...new Set(requested.map(normalizePhone).filter(p=>/^9627\d{8}$/.test(p)))];
    if(!phones.length)return res.status(400).json({ok:false,error:'NO_CAPTAINS_SELECTED'});
    if(phones.length>5)return res.status(400).json({ok:false,error:'MAX_5_CAPTAINS_PER_RUN'});

    const w=await getOpenWeek();
    const weekly=await weeklyRows(w.id);
    const eligible=new Map(
      weekly.filter(x=>Number(x.old_balance||0)>0 && Number(x.net||0)<0 && Boolean(x.active)).map(x=>[x.phone,x])
    );
    const selected=phones.filter(p=>eligible.has(p));
    const noLongerEligible=phones.filter(p=>!eligible.has(p));
    if(!selected.length)return res.status(409).json({ok:false,error:'NO_LONGER_NEGATIVE',no_longer_eligible:noLongerEligible});

    const groups=(await pool.query(`SELECT group_id,name FROM groups WHERE active=true ORDER BY id`)).rows;
    if(!groups.length)return res.status(400).json({ok:false,error:'NO_ACTIVE_GROUPS'});

    const cfg=wahaConfig();
    const delayMs=Math.max(7000,Math.min(20000,Number(process.env.WHATSAPP_GROUP_REMOVE_DELAY_MS||9000)));
    const maxActions=Math.max(1,Math.min(12,Number(process.env.WHATSAPP_GROUP_REMOVE_MAX_ACTIONS||8)));
    const results=[];
    let actions=0,halted=false,haltReason='';

    for(const phone of selected){
      const cap=eligible.get(phone);
      let captainFailed=false;
      for(const group of groups){
        if(halted||actions>=maxActions)break;
        try{
          const meta=await wahaRequest(`/api/${encodeURIComponent(cfg.session)}/groups/${encodeURIComponent(group.group_id)}`,{timeout:20000});
          const participants=Array.isArray(meta?.participants)?meta.participants:[];
          const member=participants.find(p=>dcParticipantPhone(p)===phone);
          if(!member){
            results.push({phone,name:cap.name,group_id:group.group_id,group_name:group.name||meta?.subject||'',status:'not_in_group'});
            continue;
          }
          const role=String(member.admin||member.role||'').toLowerCase();
          if(role==='admin'||role==='superadmin'||member.isAdmin===true||member.isSuperAdmin===true){
            captainFailed=true;
            results.push({phone,name:cap.name,group_id:group.group_id,group_name:group.name||meta?.subject||'',status:'skipped_group_admin'});
            continue;
          }
          const participant=dcParticipantId(member);
          if(!participant){
            captainFailed=true;
            results.push({phone,name:cap.name,group_id:group.group_id,group_name:group.name||meta?.subject||'',status:'participant_id_unresolved'});
            continue;
          }

          await wahaRequest(
            `/api/${encodeURIComponent(cfg.session)}/groups/${encodeURIComponent(group.group_id)}/participants/remove`,
            {method:'POST',body:{participants:[participant]},timeout:22000}
          );

          actions++;
          const groupName=group.name||meta?.subject||'';
          results.push({phone,name:cap.name,group_id:group.group_id,group_name:groupName,status:'removed'});
          await pool.query(
            `INSERT INTO negative_group_removals(captain_phone,group_id,group_name) VALUES($1,$2,$3)`,
            [phone,group.group_id,groupName]
          );
          if(actions<maxActions)await new Promise(r=>setTimeout(r,delayMs));
        }catch(e){
          captainFailed=true;
          const status=Number(e?.status||0);
          const err=String(e?.message||e).slice(0,260);
          results.push({phone,name:cap.name,group_id:group.group_id,group_name:group.name||'',status:'failed',error:err});
          if(status===429||status===401||status===403){
            halted=true;haltReason=`HTTP_${status}`;break;
          }
        }
      }

      const capRows=results.filter(x=>x.phone===phone);
      const hasRemoval=capRows.some(x=>x.status==='removed');
      const hasBlockingFailure=capRows.some(x=>['failed','participant_id_unresolved','skipped_group_admin'].includes(x.status));
      if(!halted&&!captainFailed&&!hasBlockingFailure&&hasRemoval){
        await pool.query(
          `UPDATE captains
           SET active=false,status_reason='تمت إزالته يدوياً بسبب رصيد سالب مرحّل',
               status_checked_at=now(),updated_at=now()
           WHERE phone=$1`,
          [phone]
        );
      }
    }

    const summary={
      selected:selected.length,
      removed:results.filter(x=>x.status==='removed').length,
      not_in_group:results.filter(x=>x.status==='not_in_group').length,
      skipped_admin:results.filter(x=>x.status==='skipped_group_admin').length,
      failed:results.filter(x=>x.status==='failed'||x.status==='participant_id_unresolved').length,
      actions,max_actions:maxActions,delay_ms:delayMs,halted,halt_reason:haltReason
    };
    await audit('NEGATIVE_CARRY_GROUP_REMOVAL',{week_id:w.id,phones:selected,no_longer_eligible:noLongerEligible,summary,results});
    res.json({ok:true,week_id:w.id,summary,no_longer_eligible:noLongerEligible,results});
  }catch(e){
    res.status(500).json({ok:false,error:'NEGATIVE_CARRY_REMOVE_FAILED',message:e.message});
  }
});

app.post('/api/admin/negative-carry-restore',auth,async(req,res)=>{
  try{
    await ensureNegativeGroupRemovalTable();
    if(!process.env.DROPCODE_API_URL||!process.env.DROPCODE_SESSION_ID||!process.env.DROPCODE_API_TOKEN){
      return res.status(400).json({ok:false,error:'DROPCODE_GROUP_RESTORE_NOT_CONFIGURED'});
    }
    const phone=normalizePhone(req.body?.phone||'');
    if(!/^9627\d{8}$/.test(phone))return res.status(400).json({ok:false,error:'INVALID_CAPTAIN_PHONE'});

    const removed=await pool.query(`
      SELECT id,group_id,group_name FROM negative_group_removals
      WHERE captain_phone=$1 AND restored_at IS NULL
      ORDER BY removed_at,id
    `,[phone]);
    if(!removed.rowCount)return res.status(404).json({ok:false,error:'NO_REMOVED_GROUPS'});

    const cfg=wahaConfig();
    const delayMs=Math.max(7000,Math.min(20000,Number(process.env.WHATSAPP_GROUP_RESTORE_DELAY_MS||9000)));
    const maxActions=Math.max(1,Math.min(8,Number(process.env.WHATSAPP_GROUP_RESTORE_MAX_ACTIONS||5)));
    const results=[];
    let actions=0,halted=false,haltReason='';

    for(const row of removed.rows){
      if(halted||actions>=maxActions)break;
      try{
        const meta=await wahaRequest(`/api/${encodeURIComponent(cfg.session)}/groups/${encodeURIComponent(row.group_id)}`,{timeout:20000});
        const participants=Array.isArray(meta?.participants)?meta.participants:[];
        const already=participants.some(p=>dcParticipantPhone(p)===phone);
        if(already){
          await pool.query(`UPDATE negative_group_removals SET restored_at=now(),restore_status='already_in_group',last_error='' WHERE id=$1`,[row.id]);
          results.push({group_id:row.group_id,group_name:row.group_name,status:'already_in_group'});
          continue;
        }

        await wahaRequest(
          `/api/${encodeURIComponent(cfg.session)}/groups/${encodeURIComponent(row.group_id)}/participants/add`,
          {method:'POST',body:{participants:[phone+'@s.whatsapp.net']},timeout:22000}
        );
        actions++;
        await pool.query(`UPDATE negative_group_removals SET restored_at=now(),restore_status='restored',last_error='' WHERE id=$1`,[row.id]);
        results.push({group_id:row.group_id,group_name:row.group_name,status:'restored'});
        if(actions<maxActions)await new Promise(r=>setTimeout(r,delayMs));
      }catch(e){
        const status=Number(e?.status||0),err=String(e?.message||e).slice(0,260);
        await pool.query(`UPDATE negative_group_removals SET restore_status='failed',last_error=$2 WHERE id=$1`,[row.id,err]);
        results.push({group_id:row.group_id,group_name:row.group_name,status:'failed',error:err});
        if(status===429||status===401||status===403){
          halted=true;haltReason=`HTTP_${status}`;break;
        }
      }
    }

    const left=await pool.query(`SELECT count(*)::int count FROM negative_group_removals WHERE captain_phone=$1 AND restored_at IS NULL`,[phone]);
    const remaining=Number(left.rows[0]?.count||0);
    if(remaining===0&&!halted){
      await pool.query(
        `UPDATE captains SET active=true,status_reason='تمت إعادته يدوياً للقروبات',
           status_checked_at=now(),last_group_seen_at=now(),updated_at=now()
         WHERE phone=$1`,
        [phone]
      );
      await notifyCaptain(pool,phone,'success','تمت إعادة تفعيل حسابك','تمت إعادتك للقروبات.',{active:true});
    }

    const summary={
      restored:results.filter(x=>x.status==='restored').length,
      already_in_group:results.filter(x=>x.status==='already_in_group').length,
      failed:results.filter(x=>x.status==='failed').length,
      remaining,actions,max_actions:maxActions,delay_ms:delayMs,halted,halt_reason:haltReason
    };
    await audit('NEGATIVE_CARRY_GROUP_RESTORE',{phone,summary,results});
    res.json({ok:true,phone,summary,results});
  }catch(e){
    res.status(500).json({ok:false,error:'NEGATIVE_CARRY_RESTORE_FAILED',message:e.message});
  }
});

app.post('/api/admin/refresh-whatsapp-names',auth,async(req,res)=>{
  try{
    const data=await refreshCaptainWhatsappNames();
    res.json({ok:true,...data});
  }catch(e){res.status(502).json({ok:false,error:'WHATSAPP_NAMES_REFRESH_FAILED',message:e.message});}
});
app.post('/api/admin/check-group-members',auth,async(req,res)=>{
  try{
    const provider=String(process.env.WHATSAPP_PROVIDER||'dropcode').trim().toLowerCase();
    const g=await pool.query(`SELECT group_id,name,auto_register_members FROM groups WHERE active=true ORDER BY id`);
    if(!g.rowCount)return res.status(400).json({ok:false,error:'NO_ACTIVE_GROUPS'});
    const present=new Set(),details=[],resolvedMembers=new Map();
    const contactNames=provider==='dropcode' ? await getDropcodeContactNames().catch(()=>new Map()) : new Map();
    if(provider==='dropcode'){
      const wc=wahaConfig(); if(!wc.baseUrl)return res.status(400).json({ok:false,error:'WAHA_NOT_CONFIGURED'});
      for(const group of g.rows){
        const data=await getWahaGroupParticipants(group.group_id,pool);
        if(Number(data.lidsUnresolved||0)>0)return res.status(409).json({ok:false,error:'DROPCODE_UNRESOLVED_LIDS',unresolved:data.lidsUnresolved,message:'أرقام بعض الأعضاء غير معروفة؛ لم يتم تغيير حالة أي كابتن'});
        if(!Number(data.total||0) || !Array.isArray(data.phones) || !data.phones.length){
          return res.status(503).json({ok:false,error:'DROPCODE_GROUP_MEMBERS_UNAVAILABLE',group_id:group.group_id,message:'تعذر التحقق من أعضاء القروب؛ لم يتم تغيير حالة أي كابتن'});
        }
        for(const ph of data.phones) if(ph) present.add(ph);
        if(group.auto_register_members){
          for(const m of (data.members||[])){const ph=normalizePhone(m?.phone||'');if(ph&&(!resolvedMembers.has(ph)||!resolvedMembers.get(ph).name))resolvedMembers.set(ph,{phone:ph,name:String(m?.name||contactNames.get(ph)||'')});}
        }
        details.push({group_id:group.group_id,name:group.name||data.name||'',participants:data.total,auto_register_members:!!group.auto_register_members,lids_resolved:data.lidsResolved,lids_unresolved:data.lidsUnresolved});
      }
    }else{
      const cfg=greenConfig(); if(!cfg.apiUrl||!cfg.id||!cfg.token)return res.status(400).json({ok:false,error:'GREEN_GROUP_CHECK_NOT_CONFIGURED'});
      for(const group of g.rows){
        const url=`${cfg.apiUrl}/waInstance${encodeURIComponent(cfg.id)}/getGroupData/${encodeURIComponent(cfg.token)}`;
        const rr=await fetch(url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({groupId:group.group_id})});
        const text=await rr.text(); if(!rr.ok)throw new Error(`GREEN group ${group.group_id} HTTP ${rr.status}: ${text.slice(0,300)}`);
        let data;try{data=JSON.parse(text)}catch(_){throw new Error(`GREEN invalid JSON for ${group.group_id}`)}
        const participants=Array.isArray(data.participants)?data.participants:[];
        for(const p of participants){const ph=normalizePhone(String(p.phoneNumber||p.id||''));if(ph)present.add(ph);}
        details.push({group_id:group.group_id,name:group.name||data.subject||'',participants:participants.length});
      }
    }
    const autoRegister=provider==='dropcode'?await registerResolvedGroupMembers([...resolvedMembers.values()],'ADMIN_GROUP_SCAN'):{created:0,updated:0,reconciled:0,total:0};
    const caps=await pool.query(`SELECT phone,active FROM captains`);let active=0,stopped=0;
    for(const cap of caps.rows){
      const isPresent=present.has(cap.phone);if(isPresent)active++;else stopped++;
      await pool.query(`UPDATE captains SET active=$2,status_reason=$3,status_checked_at=now(),
        last_group_seen_at=CASE WHEN $2 THEN now() ELSE last_group_seen_at END,updated_at=now() WHERE phone=$1`,
        [cap.phone,isPresent,isPresent?'موجود في قروب معتمد':'غير موجود في القروبات المعتمدة']);
      if(Boolean(cap.active)!==isPresent) await notifyCaptain(pool,cap.phone,isPresent?'success':'warning',isPresent?'تم تفعيل حسابك':'تم إيقاف حسابك',isPresent?'أنت موجود في قروب معتمد حسب آخر فحص.':'لم يتم العثور عليك في القروبات المعتمدة حسب آخر فحص.',{active:isPresent});
    }
    await pool.query(`INSERT INTO captain_status_checks(active_groups,active_captains,stopped_captains,details) VALUES($1,$2,$3,$4)`,[g.rowCount,active,stopped,details]);
    await audit('GROUP_MEMBERS_CHECK',{provider,groups:g.rowCount,active,stopped,details});
    res.json({ok:true,provider,groups:g.rowCount,active,stopped,details,auto_register:autoRegister});
  }catch(e){res.status(502).json({ok:false,error:'GROUP_MEMBER_CHECK_FAILED',message:e.message});}
});

app.get('/api/admin/waha/status',auth,async(req,res)=>{
  try{const cfg=wahaConfig();const data=await getWahaSessionStatus();res.json({ok:true,provider:'waha',configured:!!cfg.baseUrl,session:cfg.session,status:data?.status||'unknown',me:data?.me||null});}
  catch(e){res.status(502).json({ok:false,error:'WAHA_STATUS_FAILED',message:e.message});}
});
app.get('/api/admin/waha/qr',auth,async(req,res)=>{
  try{
    const cfg=wahaConfig(); if(!cfg.baseUrl)return res.status(400).json({ok:false,error:'WAHA_NOT_CONFIGURED'});
    const headers={Accept:'application/json'}; if(cfg.apiKey)headers['X-Api-Key']=cfg.apiKey;
    const rr=await fetch(`${cfg.baseUrl}/api/${encodeURIComponent(cfg.session)}/auth/qr`,{headers});
    const text=await rr.text(); res.status(rr.status).type(rr.headers.get('content-type')||'application/json').send(text);
  }catch(e){res.status(502).json({ok:false,error:'WAHA_QR_FAILED',message:e.message});}
});

app.get('/api/admin/audit',auth,async(req,res)=>{
  const r=await pool.query(`SELECT id,action,details,created_at FROM audit_log ORDER BY id DESC LIMIT 300`);res.json({ok:true,rows:r.rows});
});
app.post('/api/admin/weekly/:id/reopen',auth,async(req,res)=>{
  const c=await pool.connect();
  try{
    await c.query('BEGIN');
    const target=await c.query(`SELECT * FROM accounting_weeks WHERE id=$1 AND status='closed' FOR UPDATE`,[req.params.id]);
    if(!target.rowCount){await c.query('ROLLBACK');return res.status(404).json({ok:false,error:'CLOSED_WEEK_NOT_FOUND'});}
    const latest=await c.query(`SELECT id FROM accounting_weeks WHERE status='closed' ORDER BY id DESC LIMIT 1`);
    if(Number(latest.rows[0]?.id)!==Number(req.params.id)){await c.query('ROLLBACK');return res.status(409).json({ok:false,error:'ONLY_LATEST_WEEK_CAN_REOPEN'});}
    const open=await c.query(`SELECT * FROM accounting_weeks WHERE status='open' ORDER BY id DESC LIMIT 1 FOR UPDATE`);
    if(open.rowCount){
      const oq=await c.query(`SELECT
        (SELECT COUNT(*) FROM claims WHERE week_id=$1)
        +(SELECT COUNT(*) FROM weekly_charges WHERE week_id=$1 AND charge_type<>'old_balance')
        +(SELECT COUNT(*) FROM weekly_adjustments WHERE week_id=$1)
        +(SELECT COUNT(*) FROM manual_movements WHERE week_id=$1)
        +(SELECT COUNT(*) FROM weekly_balance_corrections WHERE week_id=$1) n`,[open.rows[0].id]);
      if(Number(oq.rows[0].n)>0){await c.query('ROLLBACK');return res.status(409).json({ok:false,error:'NEW_WEEK_HAS_ACTIVITY'});}
      await c.query(`DELETE FROM accounting_weeks WHERE id=$1`,[open.rows[0].id]);
    }
    await c.query(`DELETE FROM weekly_settlements WHERE week_id=$1`,[req.params.id]);
    await c.query(`UPDATE accounting_weeks SET status='open',closed_at=NULL WHERE id=$1`,[req.params.id]);
    await c.query(`INSERT INTO audit_log(action,details) VALUES('WEEK_REOPENED',$1)`,[{week_id:Number(req.params.id)}]);
    await c.query('COMMIT');res.json({ok:true});
  }catch(e){await c.query('ROLLBACK');res.status(500).json({ok:false,error:'WEEK_REOPEN_FAILED',message:e.message});}finally{c.release();}
});

app.get('/api/captain/:phone',captainRouteAuth,async(req,res)=>{
  try{
    const p=normalizePhone(req.params.phone), w=await getOpenWeek(), rows=await weeklyRows(w.id), x=rows.find(v=>v.phone===p);
    if(!x)return res.status(404).json({ok:false,error:'CAPTAIN_NOT_FOUND'});
    const latest=await pool.query(`
      SELECT s.*,w.starts_at,w.closed_at,
        EXISTS(SELECT 1 FROM settlement_proofs pr WHERE pr.settlement_id=s.id AND pr.direction='admin_to_captain') admin_proof,
        EXISTS(SELECT 1 FROM settlement_proofs pr WHERE pr.settlement_id=s.id AND pr.direction='captain_to_admin') captain_proof
      FROM weekly_settlements s JOIN accounting_weeks w ON w.id=s.week_id
      WHERE s.captain_phone=$1 ORDER BY w.closed_at DESC NULLS LAST,s.id DESC LIMIT 1`,[p]);
    res.json({ok:true,data:{captain_phone:x.phone,name:x.name,production:x.production,consumption:x.consumption,floor_fee:x.floor_fee,old_balance:x.old_balance,net:x.net,active:x.active,status_reason:x.status_reason,last_group_seen_at:x.last_group_seen_at,week:w,latest_settlement:latest.rows[0]||null}});
  }catch(e){res.status(500).json({ok:false,error:'CAPTAIN_SUMMARY_FAILED',message:e.message});}
});

app.get('/api/captain/:phone/movements',captainRouteAuth,async(req,res)=>{
  try{
    const p=normalizePhone(req.params.phone), w=await getOpenWeek();
    const cap=await pool.query(`SELECT 1 FROM captains WHERE phone=$1`,[p]);
    if(!cap.rowCount)return res.status(404).json({ok:false,error:'CAPTAIN_NOT_FOUND'});
    const r=await pool.query(`
      SELECT * FROM (
        SELECT m.id,m.claim_id,m.direction,m.amount,m.status,m.created_at,m.cancelled_at,
          cl.group_id,cl.producer_name,cl.producer_phone,cl.consumer_name,cl.consumer_phone,cl.current_reaction AS reaction_emoji,cl.current_value,cl.status AS claim_status,
          COALESCE(NULLIF(om.text_body,''),om.raw #>> '{messageData,textMessageData,textMessage}',om.raw #>> '{messageData,extendedTextMessageData,text}',om.raw #>> '{messageData,fileMessageData,caption}','') AS original_text,
          COALESCE(NULLIF(rm.text_body,''),rm.raw #>> '{messageData,textMessageData,textMessage}',rm.raw #>> '{messageData,extendedTextMessageData,text}',rm.raw #>> '{messageData,fileMessageData,caption}','') AS reply_text,
          COALESCE(g.name,cl.group_id) AS group_name, NULL::text AS product_name, NULL::text AS product_id, NULL::text AS manual_note, false AS is_manual
        FROM movements m
        JOIN claims cl ON cl.id=m.claim_id
        LEFT JOIN LATERAL (
          SELECT wm.*
          FROM whatsapp_messages wm
          WHERE wm.group_id=cl.group_id
            AND cl.original_message_id<>''
            AND (
              wm.message_id=cl.original_message_id
              OR right(wm.message_id,char_length(cl.original_message_id))=cl.original_message_id
              OR position(cl.original_message_id in wm.message_id)>0
            )
          ORDER BY CASE
            WHEN wm.message_id=cl.original_message_id THEN 0
            WHEN right(wm.message_id,char_length(cl.original_message_id))=cl.original_message_id THEN 1
            ELSE 2
          END, wm.created_at DESC
          LIMIT 1
        ) om ON true
        LEFT JOIN LATERAL (
          SELECT wm.*
          FROM whatsapp_messages wm
          WHERE wm.group_id=cl.group_id
            AND cl.reply_message_id<>''
            AND (
              wm.message_id=cl.reply_message_id
              OR right(wm.message_id,char_length(cl.reply_message_id))=cl.reply_message_id
              OR position(cl.reply_message_id in wm.message_id)>0
            )
          ORDER BY CASE
            WHEN wm.message_id=cl.reply_message_id THEN 0
            WHEN right(wm.message_id,char_length(cl.reply_message_id))=cl.reply_message_id THEN 1
            ELSE 2
          END, wm.created_at DESC
          LIMIT 1
        ) rm ON true
        LEFT JOIN groups g ON g.group_id=cl.group_id
        WHERE m.captain_phone=$1 AND cl.week_id=$2
        UNION ALL
        SELECT mm.id,NULL::bigint,mm.direction,mm.amount,'active',mm.created_at,NULL::timestamptz,
          NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,'إضافة يدوية من الإدارة',NULL,NULL,NULL,mm.product_name,mm.product_id,mm.note,true
        FROM manual_movements mm WHERE mm.captain_phone=$1 AND mm.week_id=$2
      ) z ORDER BY created_at DESC LIMIT 150`,[p,w.id]);
    res.json({ok:true,week:w,rows:r.rows});
  }catch(e){res.status(500).json({ok:false,error:'CAPTAIN_MOVEMENTS_FAILED',message:e.message});}
});

app.get('/api/captain/:phone/settlements',captainRouteAuth,async(req,res)=>{
  try{
    const p=normalizePhone(req.params.phone);
    const cap=await pool.query(`SELECT name,active,status_reason FROM captains WHERE phone=$1`,[p]);
    if(!cap.rowCount)return res.status(404).json({ok:false,error:'CAPTAIN_NOT_FOUND'});
    const r=await pool.query(`
      SELECT s.*,w.starts_at,w.closed_at,
        EXISTS(SELECT 1 FROM settlement_proofs pr WHERE pr.settlement_id=s.id AND pr.direction='admin_to_captain') admin_proof,
        EXISTS(SELECT 1 FROM settlement_proofs pr WHERE pr.settlement_id=s.id AND pr.direction='captain_to_admin') captain_proof
      FROM weekly_settlements s JOIN accounting_weeks w ON w.id=s.week_id
      WHERE s.captain_phone=$1 ORDER BY w.closed_at DESC NULLS LAST,s.id DESC LIMIT 100`,[p]);
    res.json({ok:true,captain:cap.rows[0],rows:r.rows});
  }catch(e){res.status(500).json({ok:false,error:'CAPTAIN_SETTLEMENTS_FAILED',message:e.message});}
});

app.post('/api/captain/:phone/settlements/:id/proof',captainRouteAuth,upload.single('proof'),async(req,res)=>{
  try{
    const p=normalizePhone(req.params.phone);
    if(!req.file)return res.status(400).json({ok:false,error:'IMAGE_REQUIRED'});
    const q=await pool.query(`SELECT * FROM weekly_settlements WHERE id=$1 AND captain_phone=$2`,[req.params.id,p]);
    if(!q.rowCount)return res.status(404).json({ok:false,error:'SETTLEMENT_NOT_FOUND'});
    const st=q.rows[0];
    if(Number(st.net)>=0)return res.status(400).json({ok:false,error:'SETTLEMENT_NOT_OWED_BY_CAPTAIN'});
    if(st.status==='settled')return res.status(409).json({ok:false,error:'SETTLEMENT_ALREADY_SETTLED'});if(st.status==='carried_forward')return res.status(409).json({ok:false,error:'SETTLEMENT_CARRIED_FORWARD'});
    await pool.query(`
      INSERT INTO settlement_proofs(settlement_id,direction,mime_type,file_name,file_data,uploaded_by)
      VALUES($1,'captain_to_admin',$2,$3,$4,'captain')
      ON CONFLICT(settlement_id,direction) DO UPDATE SET mime_type=EXCLUDED.mime_type,file_name=EXCLUDED.file_name,
        file_data=EXCLUDED.file_data,uploaded_by='captain',created_at=now()`,[st.id,req.file.mimetype,req.file.originalname,req.file.buffer]);
    await pool.query(`UPDATE weekly_settlements SET status='captain_uploaded_proof',updated_at=now() WHERE id=$1`,[st.id]);
    await audit('CAPTAIN_TRANSFER_PROOF_UPLOADED',{settlement_id:st.id,phone:p,amount:Math.abs(Number(st.net))});
    res.json({ok:true});
  }catch(e){res.status(500).json({ok:false,error:'CAPTAIN_PROOF_UPLOAD_FAILED',message:e.message});}
});

app.get('/api/captain/:phone/settlements/:id/proof',captainRouteAuth,async(req,res)=>{
  try{
    const p=normalizePhone(req.params.phone);
    const q=await pool.query(`SELECT id FROM weekly_settlements WHERE id=$1 AND captain_phone=$2`,[req.params.id,p]);
    if(!q.rowCount)return res.status(404).end();
    const r=await pool.query(`SELECT mime_type,file_name,file_data FROM settlement_proofs WHERE settlement_id=$1 AND direction='admin_to_captain'`,[req.params.id]);
    if(!r.rowCount)return res.status(404).end();
    res.setHeader('content-type',r.rows[0].mime_type);res.setHeader('cache-control','no-store');res.send(r.rows[0].file_data);
  }catch(e){res.status(500).end();}
});

app.post('/api/captain/:phone/settlements/:id/received',captainRouteAuth,async(req,res)=>{
  const c=await pool.connect(); let settled=null;
  try{
    const p=normalizePhone(req.params.phone);await c.query('BEGIN');
    const q=await c.query(`SELECT * FROM weekly_settlements WHERE id=$1 AND captain_phone=$2 FOR UPDATE`,[req.params.id,p]);
    if(!q.rowCount){await c.query('ROLLBACK');return res.status(404).json({ok:false,error:'SETTLEMENT_NOT_FOUND'});}
    const st=q.rows[0];
    if(Number(st.net)<=0){await c.query('ROLLBACK');return res.status(400).json({ok:false,error:'SETTLEMENT_NOT_OWED_TO_CAPTAIN'});}
    if(st.status==='settled'){await c.query('ROLLBACK');return res.json({ok:true,already:true,status:'settled'});}
    const proof=await c.query(`SELECT 1 FROM settlement_proofs WHERE settlement_id=$1 AND direction='admin_to_captain'`,[st.id]);
    if(!proof.rowCount){await c.query('ROLLBACK');return res.status(409).json({ok:false,error:'ADMIN_PROOF_REQUIRED'});}
    const upd=await c.query(`UPDATE weekly_settlements SET status='settled',captain_confirmed_at=now(),updated_at=now() WHERE id=$1 RETURNING *`,[st.id]);
    settled=upd.rows[0];
    await c.query(`DELETE FROM settlement_proofs WHERE settlement_id=$1 AND direction='admin_to_captain'`,[st.id]);
    await c.query('COMMIT');
  }catch(e){try{await c.query('ROLLBACK')}catch(_){ }return res.status(500).json({ok:false,error:'CAPTAIN_RECEIPT_FAILED',message:e.message});}finally{c.release();}
  try{await audit('CAPTAIN_CONFIRMED_RECEIPT',{settlement_id:settled.id,phone:settled.captain_phone,amount:Number(settled.net)});}catch(e){console.error('CAPTAIN RECEIPT AUDIT ERROR',e.message)}
  res.set('Cache-Control','no-store');res.json({ok:true,status:'settled'});
});


// ============================================================
// V3.2 CAPTAIN PORTAL — authenticated APIs
// ============================================================


app.post('/api/captain-auth/login',async(req,res)=>{
  try{
    const phone=normalizePhone(req.body?.phone||''), password=String(req.body?.password||'');
    if(!phone||!password)return res.status(400).json({ok:false,error:'PHONE_PASSWORD_REQUIRED'});
    let q=await pool.query(`SELECT * FROM captains WHERE phone=$1 LIMIT 1`,[phone]);
    if(!q.rowCount)return res.status(401).json({ok:false,error:'INVALID_CAPTAIN_CREDENTIALS'});
    let row=await ensureCaptainPasswordSecret(pool,q.rows[0]);
    let clear=''; try{clear=decryptCaptainPassword(row)}catch(e){return res.status(500).json({ok:false,error:'CAPTAIN_PASSWORD_DECRYPT_FAILED'});}
    if(clear!==password)return res.status(401).json({ok:false,error:'INVALID_CAPTAIN_CREDENTIALS'});
    await pool.query(`UPDATE captains SET last_login_at=now() WHERE phone=$1`,[phone]);
    const needsOnboarding=!row.onboarding_completed || !row.password_changed || !row.payment_method;
    await pool.query(`INSERT INTO captain_login_log(captain_phone,ip,user_agent) VALUES($1,$2,$3)`,[phone,req.ip,String(req.headers['user-agent']||'').slice(0,500)]).catch(()=>{});
    res.json({ok:true,token:signCaptain(phone),needs_onboarding:needsOnboarding,captain:{name:row.name,phone:row.phone,active:row.active}});
  }catch(e){res.status(500).json({ok:false,error:'CAPTAIN_LOGIN_FAILED',message:e.message});}
});

app.post('/api/captain-auth/onboarding',captainAuth,async(req,res)=>{
  try{
    const phone=req.user.phone, newPassword=String(req.body?.new_password||''), confirmPassword=String(req.body?.confirm_password||'');
    const paymentMethod=String(req.body?.payment_method||'').trim(), details=req.body?.payment_details||{};
    if(newPassword.length<6)return res.status(400).json({ok:false,error:'PASSWORD_TOO_SHORT'});
    if(newPassword==='123456')return res.status(400).json({ok:false,error:'DEFAULT_PASSWORD_NOT_ALLOWED'});
    if(newPassword!==confirmPassword)return res.status(400).json({ok:false,error:'PASSWORD_CONFIRM_MISMATCH'});
    if(!['cliq','wallet','bank','cash','other'].includes(paymentMethod))return res.status(400).json({ok:false,error:'PAYMENT_METHOD_REQUIRED'});
    if(typeof details!=='object'||Array.isArray(details))return res.status(400).json({ok:false,error:'PAYMENT_DETAILS_INVALID'});
    const c=await pool.connect();
    try{
      await c.query('BEGIN'); await setCaptainPassword(c,phone,newPassword,{changed:true});
      await c.query(`UPDATE captains SET onboarding_completed=true,payment_method=$2,payment_details=$3,payment_updated_at=now(),updated_at=now() WHERE phone=$1`,[phone,paymentMethod,details]);
      await notifyCaptain(c,phone,'success','تم تجهيز حسابك','تم تغيير كلمة السر وحفظ طريقة التحويل بنجاح.');
      await c.query(`INSERT INTO audit_log(action,details) VALUES('CAPTAIN_ONBOARDING_COMPLETED',$1)`,[{phone,payment_method:paymentMethod}]);
      await c.query('COMMIT');
    }catch(e){await c.query('ROLLBACK');throw e}finally{c.release()}
    res.json({ok:true,token:signCaptain(phone)});
  }catch(e){res.status(500).json({ok:false,error:'CAPTAIN_ONBOARDING_FAILED',message:e.message});}
});

app.get('/api/captain-auth/me',captainAuth,captainReady,async(req,res)=>{
  try{
    const p=req.user.phone, w=await getOpenWeek(), rows=await weeklyRows(w.id), x=rows.find(v=>v.phone===p);
    const cq=await pool.query(`SELECT name,phone,active,status_reason,status_checked_at,last_group_seen_at,password_changed,onboarding_completed,payment_method,payment_details,payment_updated_at,last_login_at FROM captains WHERE phone=$1`,[p]);
    if(!cq.rowCount||!x)return res.status(404).json({ok:false,error:'CAPTAIN_NOT_FOUND'});
    const latest=await pool.query(`SELECT s.*,w.starts_at,w.closed_at,
      EXISTS(SELECT 1 FROM settlement_proofs pr WHERE pr.settlement_id=s.id AND pr.direction='admin_to_captain') admin_proof,
      EXISTS(SELECT 1 FROM settlement_proofs pr WHERE pr.settlement_id=s.id AND pr.direction='captain_to_admin') captain_proof
      FROM weekly_settlements s JOIN accounting_weeks w ON w.id=s.week_id WHERE s.captain_phone=$1 ORDER BY w.closed_at DESC NULLS LAST,s.id DESC LIMIT 1`,[p]);
    const systemTransfer=await getSystemTransferSettings();
    res.json({ok:true,data:{...cq.rows[0],production:x.production,consumption:x.consumption,floor_fee:x.floor_fee,old_balance:x.old_balance,net:x.net,week:w,latest_settlement:latest.rows[0]||null,system_transfer:systemTransfer}});
  }catch(e){res.status(500).json({ok:false,error:'CAPTAIN_ME_FAILED',message:e.message});}
});

app.get('/api/captain-auth/movements',captainAuth,captainReady,async(req,res)=>{
  try{
    const p=req.user.phone; let weekId=Number(req.query.week_id||0); if(!weekId)weekId=(await getOpenWeek()).id;
    const r=await pool.query(`
      SELECT m.id,m.claim_id,m.direction,m.amount,m.reaction,m.status,m.version_no,m.created_at,m.cancelled_at,
        cl.week_id,cl.group_id,cl.original_message_id,cl.reply_message_id,cl.producer_name,cl.producer_phone,cl.consumer_name,cl.consumer_phone,
        cl.status AS claim_status,cl.current_reaction,cl.current_value,cl.updated_at AS claim_updated_at,
        om.message_id AS original_stored_message_id,
        COALESCE(om.raw #>> '{messageData,typeMessage}','') AS original_type,
        COALESCE(NULLIF(om.text_body,''),om.raw #>> '{messageData,textMessageData,textMessage}',om.raw #>> '{messageData,extendedTextMessageData,text}',om.raw #>> '{messageData,fileMessageData,caption}','') AS original_text,
        om.raw AS original_raw,
        COALESCE(NULLIF(rm.text_body,''),rm.raw #>> '{messageData,textMessageData,textMessage}',rm.raw #>> '{messageData,extendedTextMessageData,text}',rm.raw #>> '{messageData,fileMessageData,caption}','') AS reply_text,
        med.mime_type AS media_mime,
        COALESCE(g.name,cl.group_id) AS group_name
      FROM movements m JOIN claims cl ON cl.id=m.claim_id
      LEFT JOIN LATERAL (
        SELECT wm.*
        FROM whatsapp_messages wm
        WHERE wm.group_id=cl.group_id
          AND cl.original_message_id<>''
          AND (
            wm.message_id=cl.original_message_id
            OR right(wm.message_id,char_length(cl.original_message_id))=cl.original_message_id
            OR position(cl.original_message_id in wm.message_id)>0
          )
        ORDER BY CASE
          WHEN wm.message_id=cl.original_message_id THEN 0
          WHEN right(wm.message_id,char_length(cl.original_message_id))=cl.original_message_id THEN 1
          ELSE 2
        END, wm.created_at DESC
        LIMIT 1
      ) om ON true
      LEFT JOIN LATERAL (
        SELECT wm.*
        FROM whatsapp_messages wm
        WHERE wm.group_id=cl.group_id
          AND cl.reply_message_id<>''
          AND (
            wm.message_id=cl.reply_message_id
            OR right(wm.message_id,char_length(cl.reply_message_id))=cl.reply_message_id
            OR position(cl.reply_message_id in wm.message_id)>0
          )
        ORDER BY CASE
          WHEN wm.message_id=cl.reply_message_id THEN 0
          WHEN right(wm.message_id,char_length(cl.reply_message_id))=cl.reply_message_id THEN 1
          ELSE 2
        END, wm.created_at DESC
        LIMIT 1
      ) rm ON true
      LEFT JOIN whatsapp_media med ON med.group_id=cl.group_id AND med.message_id=om.message_id
      LEFT JOIN groups g ON g.group_id=cl.group_id
      WHERE m.captain_phone=$1 AND cl.week_id=$2 ORDER BY m.created_at DESC,m.id DESC LIMIT 500`,[p,weekId]);
    // Only probe up to 12 older, textless message records per request.
    // Normal records are served without extra DropConnect API calls.
    const probes=r.rows.filter(row=>row.original_raw && !row.original_text &&
      !/audio|image|video|document|file/i.test(String(row.original_type||'')) &&
      !row.media_mime).slice(0,12);
    const recovered=new Map();
    await Promise.all(probes.map(async row=>{
      const fixed=await reidentifyLegacyMedia(row);
      recovered.set(row.id,fixed);
    }));
    const rows=r.rows.map(original=>{
      const row=recovered.get(original.id)||original;
      const messageId=String(row.original_stored_message_id||row.original_message_id||'');
      const typ=String(row.original_type||row.original_raw?.messageData?.typeMessage||'').toLowerCase();
      const mime=String(row.media_mime||row.original_raw?.messageData?.audioMessageData?.mimeType||row.original_raw?.messageData?.audioMessageData?.mimetype||row.original_raw?.messageData?.fileMessageData?.mimeType||row.original_raw?.messageData?.fileMessageData?.mimetype||'').toLowerCase();
      const isMedia=typ.includes('audio')||typ.includes('image')||typ.includes('video')||typ.includes('document')||typ.includes('file')||/^audio\//.test(mime)||/^image\//.test(mime)||/^video\//.test(mime)||!!row.original_raw?.messageData?.fileMessageData?.downloadUrl||!!row.original_raw?.messageData?.audioMessageData?.downloadUrl;
      let media_proxy_url='';
      if(messageId&&isMedia){
        const mediaToken=jwt.sign({role:'captain_media',phone:p,group_id:row.group_id,message_id:messageId},process.env.JWT_SECRET,{expiresIn:'12h'});
        media_proxy_url='/api/captain-media/'+encodeURIComponent(mediaToken);
      }
      return {...row,media_proxy_url};
    });
    res.json({ok:true,week_id:weekId,rows});
  }catch(e){res.status(500).json({ok:false,error:'CAPTAIN_MOVEMENTS_FAILED',message:e.message});}
});

app.get('/api/captain-media/:token',async(req,res)=>{
  try{
    const t=String(req.params.token||'');
    const u=jwt.verify(t,process.env.JWT_SECRET);
    if(u.role!=='captain_media'||!u.phone||!u.group_id||!u.message_id)return res.status(403).end();
    const allowed=await pool.query(`
      SELECT 1 FROM claims
      WHERE group_id=$1
        AND (producer_phone=$2 OR consumer_phone=$2)
        AND (
          original_message_id=$3
          OR right($3,char_length(original_message_id))=original_message_id
          OR position(original_message_id in $3)>0
        )
      LIMIT 1
    `,[u.group_id,u.phone,u.message_id]);
    if(!allowed.rowCount)return res.status(403).end();
    const media=await recoverWhatsappMedia(u.group_id,u.message_id);
    if(!media)return res.status(404).end();
    const buf=Buffer.isBuffer(media.file_data)?media.file_data:Buffer.from(media.file_data||[]);
    const mime=String(media.mime_type||'application/octet-stream');
    res.setHeader('content-type',mime);
    res.setHeader('content-disposition','inline');
    res.setHeader('accept-ranges','bytes');
    res.setHeader('cache-control','private, max-age=3600');
    const range=req.headers.range;
    if(range&&buf.length){
      const m=String(range).match(/bytes=(\d*)-(\d*)/);
      if(m){
        let start=m[1]?Number(m[1]):0,end=m[2]?Number(m[2]):buf.length-1;
        if(!Number.isFinite(start)||start<0)start=0;if(!Number.isFinite(end)||end>=buf.length)end=buf.length-1;
        if(start>end||start>=buf.length)return res.status(416).end();
        res.status(206);
        res.setHeader('content-range',`bytes ${start}-${end}/${buf.length}`);
        res.setHeader('content-length',end-start+1);
        return res.end(buf.subarray(start,end+1));
      }
    }
    res.setHeader('content-length',buf.length);
    res.end(buf);
  }catch(e){
    if(e?.name==='TokenExpiredError'||e?.name==='JsonWebTokenError')return res.status(401).end();
    console.error('CAPTAIN MEDIA ERROR',e.message);res.status(500).end();
  }
});

app.get('/api/captain-auth/settlements',captainAuth,captainReady,async(req,res)=>{
  try{
    const p=req.user.phone, r=await pool.query(`SELECT s.*,w.starts_at,w.closed_at,
      EXISTS(SELECT 1 FROM settlement_proofs pr WHERE pr.settlement_id=s.id AND pr.direction='admin_to_captain') admin_proof,
      EXISTS(SELECT 1 FROM settlement_proofs pr WHERE pr.settlement_id=s.id AND pr.direction='captain_to_admin') captain_proof
      FROM weekly_settlements s JOIN accounting_weeks w ON w.id=s.week_id WHERE s.captain_phone=$1 ORDER BY w.closed_at DESC NULLS LAST,s.id DESC LIMIT 100`,[p]);
    res.json({ok:true,rows:r.rows});
  }catch(e){res.status(500).json({ok:false,error:'CAPTAIN_SETTLEMENTS_FAILED',message:e.message});}
});

app.post('/api/captain-auth/settlements/:id/proof',captainAuth,captainReady,upload.single('proof'),async(req,res)=>{
  try{
    const p=req.user.phone;if(!req.file)return res.status(400).json({ok:false,error:'IMAGE_REQUIRED'});
    const q=await pool.query(`SELECT * FROM weekly_settlements WHERE id=$1 AND captain_phone=$2`,[req.params.id,p]);if(!q.rowCount)return res.status(404).json({ok:false,error:'SETTLEMENT_NOT_FOUND'});
    const st=q.rows[0];if(Number(st.net)>=0)return res.status(400).json({ok:false,error:'SETTLEMENT_NOT_OWED_BY_CAPTAIN'});if(st.status==='settled')return res.status(409).json({ok:false,error:'SETTLEMENT_ALREADY_SETTLED'});if(st.status==='carried_forward')return res.status(409).json({ok:false,error:'SETTLEMENT_CARRIED_FORWARD'});
    await pool.query(`INSERT INTO settlement_proofs(settlement_id,direction,mime_type,file_name,file_data,uploaded_by) VALUES($1,'captain_to_admin',$2,$3,$4,'captain') ON CONFLICT(settlement_id,direction) DO UPDATE SET mime_type=EXCLUDED.mime_type,file_name=EXCLUDED.file_name,file_data=EXCLUDED.file_data,uploaded_by='captain',created_at=now()`,[st.id,req.file.mimetype,req.file.originalname,req.file.buffer]);
    await pool.query(`UPDATE weekly_settlements SET status='captain_uploaded_proof',updated_at=now() WHERE id=$1`,[st.id]);
    await audit('CAPTAIN_TRANSFER_PROOF_UPLOADED',{settlement_id:st.id,phone:p,amount:Math.abs(Number(st.net))});res.json({ok:true});
  }catch(e){res.status(500).json({ok:false,error:'CAPTAIN_PROOF_UPLOAD_FAILED',message:e.message});}
});
app.get('/api/captain-auth/settlements/:id/proof',captainAuth,captainReady,async(req,res)=>{
  try{const p=req.user.phone;const q=await pool.query(`SELECT id FROM weekly_settlements WHERE id=$1 AND captain_phone=$2`,[req.params.id,p]);if(!q.rowCount)return res.status(404).end();const r=await pool.query(`SELECT mime_type,file_data FROM settlement_proofs WHERE settlement_id=$1 AND direction='admin_to_captain'`,[req.params.id]);if(!r.rowCount)return res.status(404).end();res.setHeader('content-type',r.rows[0].mime_type);res.setHeader('cache-control','no-store');res.send(r.rows[0].file_data)}catch(e){res.status(500).end()}
});
app.post('/api/captain-auth/settlements/:id/received',captainAuth,captainReady,async(req,res)=>{
  const c=await pool.connect(); let settled=null;
  try{
    const p=req.user.phone; await c.query('BEGIN');
    const q=await c.query(`SELECT * FROM weekly_settlements WHERE id=$1 AND captain_phone=$2 FOR UPDATE`,[req.params.id,p]);
    if(!q.rowCount){await c.query('ROLLBACK');return res.status(404).json({ok:false,error:'SETTLEMENT_NOT_FOUND'});}
    const st=q.rows[0];
    if(Number(st.net)<=0){await c.query('ROLLBACK');return res.status(400).json({ok:false,error:'SETTLEMENT_NOT_OWED_TO_CAPTAIN'});}
    if(String(st.status||'').toLowerCase()==='settled'){await c.query('ROLLBACK');return res.json({ok:true,already:true,status:'settled'});}
    const proof=await c.query(`SELECT 1 FROM settlement_proofs WHERE settlement_id=$1 AND direction='admin_to_captain'`,[st.id]);
    if(!proof.rowCount){await c.query('ROLLBACK');return res.status(409).json({ok:false,error:'ADMIN_PROOF_REQUIRED'});}
    const upd=await c.query(`UPDATE weekly_settlements SET status='settled',captain_confirmed_at=now(),updated_at=now() WHERE id=$1 RETURNING *`,[st.id]);
    settled=upd.rows[0];
    await c.query(`DELETE FROM settlement_proofs WHERE settlement_id=$1 AND direction='admin_to_captain'`,[st.id]);
    await c.query('COMMIT');
  }catch(e){try{await c.query('ROLLBACK')}catch(_){ }return res.status(500).json({ok:false,error:'CAPTAIN_RECEIPT_FAILED',message:e.message});}finally{c.release();}
  // Side effects after commit so a notification/audit failure can never roll back the settlement.
  try{await notifyCaptain(pool,settled.captain_phone,'success','تمت تسوية الأسبوع',`تم تأكيد وصول ${Number(settled.net).toFixed(2)} د.أ.`);}catch(e){console.error('CAPTAIN RECEIPT NOTIFY ERROR',e.message)}
  try{await audit('CAPTAIN_CONFIRMED_RECEIPT',{settlement_id:settled.id,phone:settled.captain_phone,amount:Number(settled.net)});}catch(e){console.error('CAPTAIN RECEIPT AUDIT ERROR',e.message)}
  res.set('Cache-Control','no-store');res.json({ok:true,status:'settled'});
});

app.patch('/api/captain-auth/profile',captainAuth,captainReady,async(req,res)=>{
  try{const p=req.user.phone,method=String(req.body?.payment_method||'').trim(),details=req.body?.payment_details||{};if(!['cliq','wallet','bank','cash','other'].includes(method))return res.status(400).json({ok:false,error:'PAYMENT_METHOD_REQUIRED'});await pool.query(`UPDATE captains SET payment_method=$2,payment_details=$3,payment_updated_at=now(),updated_at=now() WHERE phone=$1`,[p,method,details]);await audit('CAPTAIN_PAYMENT_METHOD_UPDATED',{phone:p,payment_method:method});res.json({ok:true})}catch(e){res.status(500).json({ok:false,error:'PROFILE_UPDATE_FAILED',message:e.message})}
});
app.post('/api/captain-auth/change-password',captainAuth,captainReady,async(req,res)=>{
  try{const p=req.user.phone,current=String(req.body?.current_password||''),next=String(req.body?.new_password||'');const q=await pool.query(`SELECT * FROM captains WHERE phone=$1`,[p]);if(!q.rowCount)return res.status(404).json({ok:false,error:'CAPTAIN_NOT_FOUND'});const row=await ensureCaptainPasswordSecret(pool,q.rows[0]);if(decryptCaptainPassword(row)!==current)return res.status(400).json({ok:false,error:'CURRENT_PASSWORD_WRONG'});if(next.length<6||next==='123456')return res.status(400).json({ok:false,error:'NEW_PASSWORD_INVALID'});await setCaptainPassword(pool,p,next,{changed:true});await audit('CAPTAIN_PASSWORD_CHANGED',{phone:p});res.json({ok:true})}catch(e){res.status(500).json({ok:false,error:'PASSWORD_CHANGE_FAILED',message:e.message})}
});

app.get('/api/captain-auth/notifications',captainAuth,captainReady,async(req,res)=>{try{const r=await pool.query(`SELECT * FROM captain_notifications WHERE captain_phone=$1 ORDER BY created_at DESC LIMIT 100`,[req.user.phone]);res.json({ok:true,rows:r.rows})}catch(e){res.status(500).json({ok:false,error:'NOTIFICATIONS_FAILED'})}});
app.post('/api/captain-auth/notifications/read',captainAuth,captainReady,async(req,res)=>{try{await pool.query(`UPDATE captain_notifications SET is_read=true WHERE captain_phone=$1`,[req.user.phone]);res.json({ok:true})}catch(e){res.status(500).json({ok:false,error:'NOTIFICATIONS_READ_FAILED'})}});
app.get('/api/captain-auth/objections',captainAuth,captainReady,async(req,res)=>{try{const r=await pool.query(`SELECT o.*,c.current_reaction,c.current_value FROM captain_objections o LEFT JOIN claims c ON c.id=o.claim_id WHERE o.captain_phone=$1 ORDER BY o.created_at DESC LIMIT 100`,[req.user.phone]);res.json({ok:true,rows:r.rows})}catch(e){res.status(500).json({ok:false,error:'OBJECTIONS_FAILED'})}});
app.post('/api/captain-auth/objections',captainAuth,captainReady,async(req,res)=>{try{const p=req.user.phone,mid=Number(req.body?.movement_id||0),reason=String(req.body?.reason||'').trim();if(!mid||reason.length<3)return res.status(400).json({ok:false,error:'MOVEMENT_REASON_REQUIRED'});const m=await pool.query(`SELECT m.id,m.claim_id FROM movements m WHERE m.id=$1 AND m.captain_phone=$2`,[mid,p]);if(!m.rowCount)return res.status(404).json({ok:false,error:'MOVEMENT_NOT_FOUND'});const dup=await pool.query(`SELECT id FROM captain_objections WHERE captain_phone=$1 AND movement_id=$2 AND status IN ('open','reviewing')`,[p,mid]);if(dup.rowCount)return res.status(409).json({ok:false,error:'OBJECTION_ALREADY_OPEN'});const q=await pool.query(`INSERT INTO captain_objections(captain_phone,claim_id,movement_id,reason) VALUES($1,$2,$3,$4) RETURNING *`,[p,m.rows[0].claim_id,mid,reason]);await audit('CAPTAIN_OBJECTION_OPENED',{phone:p,movement_id:mid,claim_id:m.rows[0].claim_id});res.json({ok:true,row:q.rows[0]})}catch(e){res.status(500).json({ok:false,error:'OBJECTION_CREATE_FAILED',message:e.message})}});

// Admin helpers for captain credentials/payment/objections
app.get('/api/admin/captains/:phone/access',auth,async(req,res)=>{
  try{
    const p=normalizePhone(req.params.phone);
    const q=await pool.query(`SELECT * FROM captains WHERE phone=$1`,[p]);
    if(!q.rowCount)return res.status(404).json({ok:false,error:'CAPTAIN_NOT_FOUND'});
    let row=q.rows[0], clearPassword=null, passwordReadable=false, passwordIssue=null;
    try{
      row=await ensureCaptainPasswordSecret(pool,row);
      clearPassword=decryptCaptainPassword(row);
      passwordReadable=true;
    }catch(err){
      // A legacy/corrupted encrypted password must not block the admin from
      // opening the captain record. The reset-password endpoint can repair it.
      passwordIssue=String(err?.message||'PASSWORD_DECRYPT_FAILED');
      console.error('CAPTAIN PASSWORD READ ERROR',p,passwordIssue);
    }
    res.json({ok:true,data:{
      name:row.name,phone:row.phone,
      password:passwordReadable?clearPassword:null,
      password_readable:passwordReadable,
      password_issue:passwordIssue,
      password_changed:row.password_changed,onboarding_completed:row.onboarding_completed,
      payment_method:row.payment_method,payment_details:row.payment_details,
      payment_updated_at:row.payment_updated_at,last_login_at:row.last_login_at
    }});
  }catch(e){res.status(500).json({ok:false,error:'CAPTAIN_ACCESS_FAILED',message:e.message})}
});

app.post('/api/captain-auth/forgot/request', async (req,res)=>res.status(410).json({ok:false,error:'PASSWORD_RECOVERY_DISABLED',message:'استرجاع كلمة السر عبر واتساب والكود ملغي حالياً. تواصل مع الإدارة.'}));
app.post('/api/captain-auth/forgot/verify', async (req,res)=>res.status(410).json({ok:false,error:'PASSWORD_RECOVERY_DISABLED',message:'استرجاع كلمة السر عبر واتساب والكود ملغي حالياً. تواصل مع الإدارة.'}));
app.post('/api/captain-auth/forgot/reset', async (req,res)=>res.status(410).json({ok:false,error:'PASSWORD_RECOVERY_DISABLED',message:'استرجاع كلمة السر عبر واتساب والكود ملغي حالياً. تواصل مع الإدارة.'}));
app.post('/api/admin/captains/:phone/reset-password',auth,async(req,res)=>{
  const c=await pool.connect();
  try{
    const p=normalizePhone(req.params.phone),pw=String(req.body?.password||'123456').trim();
    if(!p)return res.status(400).json({ok:false,error:'PHONE_REQUIRED'});
    if(pw.length<6)return res.status(400).json({ok:false,error:'PASSWORD_TOO_SHORT'});
    await c.query('BEGIN');
    const exists=await c.query(`SELECT name FROM captains WHERE phone=$1 FOR UPDATE`,[p]);
    if(!exists.rowCount){await c.query('ROLLBACK');return res.status(404).json({ok:false,error:'CAPTAIN_NOT_FOUND'});}
    const isDefault=pw==='123456';
    await setCaptainPassword(c,p,pw,{changed:!isDefault});
    await c.query(`UPDATE captains SET onboarding_completed=CASE WHEN $2 THEN false ELSE onboarding_completed END,session_version=session_version+1,sessions_invalidated_at=now(),updated_at=now() WHERE phone=$1`,[p,isDefault]);
    await c.query('COMMIT');
    await audit('ADMIN_CAPTAIN_PASSWORD_RESET',{phone:p,default:isDefault}).catch(()=>{});
    res.json({ok:true,password:pw,default:isDefault,sessions_invalidated:true});
  }catch(e){try{await c.query('ROLLBACK')}catch(_){}res.status(500).json({ok:false,error:'RESET_PASSWORD_FAILED',message:e.message})}
  finally{c.release()}
});
app.get('/api/admin/objections',auth,async(req,res)=>{try{const r=await pool.query(`SELECT o.*,c.name AS captain_name,cl.producer_name,cl.consumer_name,cl.current_reaction,cl.current_value FROM captain_objections o LEFT JOIN captains c ON c.phone=o.captain_phone LEFT JOIN claims cl ON cl.id=o.claim_id ORDER BY CASE WHEN o.status IN ('open','reviewing') THEN 0 ELSE 1 END,o.created_at DESC LIMIT 300`);res.json({ok:true,rows:r.rows})}catch(e){res.status(500).json({ok:false,error:'ADMIN_OBJECTIONS_FAILED'})}});
app.patch('/api/admin/objections/:id',auth,async(req,res)=>{try{const status=String(req.body?.status||''),note=String(req.body?.admin_note||'');if(!['open','reviewing','resolved','rejected'].includes(status))return res.status(400).json({ok:false,error:'INVALID_STATUS'});const q=await pool.query(`UPDATE captain_objections SET status=$2,admin_note=$3,updated_at=now() WHERE id=$1 RETURNING *`,[req.params.id,status,note]);if(!q.rowCount)return res.status(404).json({ok:false,error:'OBJECTION_NOT_FOUND'});await notifyCaptain(pool,q.rows[0].captain_phone,status==='resolved'?'success':'info','تم تحديث اعتراضك',note||`حالة الاعتراض: ${status}`,{objection_id:q.rows[0].id});await audit('ADMIN_OBJECTION_UPDATED',{id:Number(req.params.id),status});res.json({ok:true,row:q.rows[0]})}catch(e){res.status(500).json({ok:false,error:'OBJECTION_UPDATE_FAILED'})}});



// V3.2.4 — announcements, support center, PWA/security helpers
app.get('/api/captain-auth/announcements',captainAuth,captainReady,async(req,res)=>{try{const r=await pool.query(`SELECT * FROM announcements WHERE active=true AND (expires_at IS NULL OR expires_at>now()) ORDER BY important DESC,created_at DESC LIMIT 20`);res.json({ok:true,rows:r.rows})}catch(e){res.status(500).json({ok:false,error:'ANNOUNCEMENTS_FAILED'})}});
app.get('/api/captain-auth/support',captainAuth,captainReady,async(req,res)=>{try{const r=await pool.query(`SELECT * FROM support_tickets WHERE captain_phone=$1 ORDER BY created_at DESC LIMIT 100`,[req.user.phone]);res.json({ok:true,rows:r.rows})}catch(e){res.status(500).json({ok:false,error:'SUPPORT_FAILED'})}});
app.post('/api/captain-auth/support',captainAuth,captainReady,async(req,res)=>{try{const p=req.user.phone,category=String(req.body?.category||'general'),subject=String(req.body?.subject||'').trim(),body=String(req.body?.body||'').trim(),movement_id=req.body?.movement_id||null,settlement_id=req.body?.settlement_id||null;if(subject.length<2||body.length<3)return res.status(400).json({ok:false,error:'SUPPORT_DETAILS_REQUIRED'});const q=await pool.query(`INSERT INTO support_tickets(captain_phone,category,subject,body,movement_id,settlement_id) VALUES($1,$2,$3,$4,$5,$6) RETURNING *`,[p,category,subject,body,movement_id,settlement_id]);await audit('CAPTAIN_SUPPORT_TICKET',{phone:p,id:q.rows[0].id,category});res.json({ok:true,row:q.rows[0]})}catch(e){res.status(500).json({ok:false,error:'SUPPORT_CREATE_FAILED',message:e.message})}});
app.get('/api/captain-auth/security',captainAuth,captainReady,async(req,res)=>{try{const r=await pool.query(`SELECT created_at,ip,user_agent FROM captain_login_log WHERE captain_phone=$1 ORDER BY created_at DESC LIMIT 10`,[req.user.phone]);res.json({ok:true,rows:r.rows})}catch(e){res.status(500).json({ok:false,error:'SECURITY_LOG_FAILED'})}});
app.post('/api/captain-auth/logout-all',captainAuth,captainReady,async(req,res)=>{try{await pool.query(`UPDATE captains SET session_version=session_version+1,sessions_invalidated_at=now(),updated_at=now() WHERE phone=$1`,[req.user.phone]);await audit('CAPTAIN_LOGOUT_ALL',{phone:req.user.phone});res.json({ok:true})}catch(e){res.status(500).json({ok:false,error:'LOGOUT_ALL_FAILED'})}});
app.get('/api/admin/announcements',auth,async(req,res)=>{try{const r=await pool.query(`SELECT * FROM announcements ORDER BY created_at DESC LIMIT 100`);res.json({ok:true,rows:r.rows})}catch(e){res.status(500).json({ok:false,error:'ADMIN_ANNOUNCEMENTS_FAILED'})}});
app.post('/api/admin/announcements',auth,async(req,res)=>{try{const title=String(req.body?.title||'').trim(),body=String(req.body?.body||'').trim(),important=!!req.body?.important;if(!title||!body)return res.status(400).json({ok:false,error:'TITLE_BODY_REQUIRED'});const q=await pool.query(`INSERT INTO announcements(title,body,important) VALUES($1,$2,$3) RETURNING *`,[title,body,important]);await audit('ADMIN_ANNOUNCEMENT_CREATED',{id:q.rows[0].id});res.json({ok:true,row:q.rows[0]})}catch(e){res.status(500).json({ok:false,error:'ANNOUNCEMENT_CREATE_FAILED'})}});
app.patch('/api/admin/announcements/:id',auth,async(req,res)=>{try{const active=!!req.body?.active;const q=await pool.query(`UPDATE announcements SET active=$2 WHERE id=$1 RETURNING *`,[req.params.id,active]);res.json({ok:!!q.rowCount,row:q.rows[0]})}catch(e){res.status(500).json({ok:false,error:'ANNOUNCEMENT_UPDATE_FAILED'})}});
app.get('/api/admin/support',auth,async(req,res)=>{try{const r=await pool.query(`SELECT t.*,c.name captain_name FROM support_tickets t LEFT JOIN captains c ON c.phone=t.captain_phone ORDER BY CASE WHEN t.status='open' THEN 0 ELSE 1 END,t.created_at DESC LIMIT 300`);res.json({ok:true,rows:r.rows})}catch(e){res.status(500).json({ok:false,error:'ADMIN_SUPPORT_FAILED'})}});
app.patch('/api/admin/support/:id',auth,async(req,res)=>{try{const status=String(req.body?.status||'reviewing'),note=String(req.body?.admin_note||'');if(!['open','reviewing','resolved','rejected'].includes(status))return res.status(400).json({ok:false,error:'INVALID_STATUS'});const q=await pool.query(`UPDATE support_tickets SET status=$2,admin_note=$3,updated_at=now() WHERE id=$1 RETURNING *`,[req.params.id,status,note]);if(q.rowCount)await notifyCaptain(pool,q.rows[0].captain_phone,'info','تحديث طلب الدعم',note||`الحالة: ${status}`,{ticket_id:q.rows[0].id});res.json({ok:!!q.rowCount,row:q.rows[0]})}catch(e){res.status(500).json({ok:false,error:'SUPPORT_UPDATE_FAILED'})}});

const port=Number(process.env.PORT||3000);
(async()=>{
  await initDb();
  try{const n=await cleanupStaleWaitingClaims();if(n)console.log(`AMMAN DELIVERY cleanup removed ${n} stale waiting claims`)}catch(e){console.error('WAITING CLEANUP STARTUP ERROR',e.message)}
  setInterval(()=>cleanupStaleWaitingClaims().catch(e=>console.error('WAITING CLEANUP ERROR',e.message)),60*60*1000).unref();
  app.listen(port,()=>console.log(`AMMAN DELIVERY API listening on ${port}`));
  if(SITE_MODE!=='captain' && String(process.env.WHATSAPP_PROVIDER||'dropcode').toLowerCase()==='waha' && String(process.env.WAHA_AUTOCONFIG||'0')==='1'){
    setTimeout(()=>ensureWahaSession().then(x=>console.log('WAHA autoconfig',x)).catch(e=>console.error('WAHA AUTOCONFIG ERROR',e.message)),1200).unref();
  }
  if(SITE_MODE!=='captain' && String(process.env.AUTO_REGISTER_GROUP_MEMBERS||'1')==='1'){
    const every=Math.max(60000,Number(process.env.AUTO_GROUP_SYNC_MS||300000));
    setTimeout(()=>syncActiveWahaGroupCaptains({source:'STARTUP_AUTO'}).then(x=>console.log('AUTO GROUP CAPTAINS',x)).catch(e=>console.error('AUTO GROUP CAPTAINS ERROR',e.message)),8000).unref();
    setInterval(()=>syncActiveWahaGroupCaptains({source:'PERIODIC_AUTO'}).then(x=>console.log('AUTO GROUP CAPTAINS',x)).catch(e=>console.error('AUTO GROUP CAPTAINS ERROR',e.message)),every).unref();
  }
})().catch(e=>{console.error(e);process.exit(1);});

