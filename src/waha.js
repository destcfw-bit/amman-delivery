const { normalizePhone } = require('./utils');

let lastGroupRefreshAt=0;
const contactNameCache=new Map();
function cleanDisplayName(v){
  return String(v||'').trim().replace(/\s+/g,' ').slice(0,120);
}
async function getWahaContactName(phone){
  const cfg=wahaConfig();
  const ph=normalizePhone(phone);
  if(!ph)return '';
  const cached=contactNameCache.get(ph);
  if(cached && cached.expiresAt>Date.now())return cached.name;
  let data=null;
  try{
    data=await wahaRequest(`/api/${encodeURIComponent(cfg.session)}/contacts/${encodeURIComponent(ph+'@c.us')}`,{timeout:4500});
  }catch(e){
    try{
      data=await wahaRequest(`/api/contacts?contactId=${encodeURIComponent(ph+'@c.us')}&session=${encodeURIComponent(cfg.session)}`,{timeout:4500});
    }catch(_){data=null}
  }
  const name=cleanDisplayName(data?.pushname||data?.pushName||data?.notifyName||data?.name||data?.shortName||data?.verifiedName||data?.contact?.pushname||data?.contact?.pushName||data?.contact?.name||'');
  contactNameCache.set(ph,{name,expiresAt:Date.now()+30*60*1000});
  return name;
}

function wahaConfig(){
  return {
    // DROPCODE Connect is the primary WhatsApp provider for AMMAN DELIVERY.
    // WAHA_* remains as a backwards-compatible fallback.
    baseUrl:String(
      process.env.DROPCODE_API_URL||
      process.env.WAHA_URL||
      process.env.WAHA_BASE_URL||
      ''
    ).replace(/\/+$/,''),
    session:String(
      process.env.DROPCODE_SESSION_ID||
      process.env.WAHA_SESSION||
      'amman'
    ).trim()||'amman',
    apiKey:String(
      process.env.DROPCODE_API_TOKEN||
      process.env.DROPCODE_API_KEY||
      process.env.WAHA_API_KEY||
      ''
    ).trim(),
    webhookSecret:String(process.env.DROPCODE_WEBHOOK_SECRET||process.env.WAHA_WEBHOOK_SECRET||'').trim()
  };
}

function headers(extra={}){
  const cfg=wahaConfig();
  const h={...extra};
  if(cfg.apiKey)h['X-Api-Key']=cfg.apiKey;
  return h;
}

async function wahaRequest(path,{method='GET',body,timeout=5000,accept='application/json'}={}){
  const cfg=wahaConfig();
  if(!cfg.baseUrl)throw new Error('WAHA_NOT_CONFIGURED');
  const ctrl=new AbortController(),timer=setTimeout(()=>ctrl.abort(),timeout);
  try{
    const init={method,headers:headers({Accept:accept}),signal:ctrl.signal};
    if(body!==undefined){init.headers['Content-Type']='application/json';init.body=JSON.stringify(body);}
    const r=await fetch(cfg.baseUrl+path,init);
    const text=await r.text();
    let data=null;try{data=text?JSON.parse(text):null}catch(_){data=text}
    if(!r.ok){
      const err=new Error(`WAHA_HTTP_${r.status}: ${String(text||'').slice(0,300)}`);
      err.status=r.status;throw err;
    }
    return data;
  }finally{clearTimeout(timer)}
}


function resolveWahaMediaUrl(mediaUrl=''){
  const cfg=wahaConfig();
  const raw=String(mediaUrl||'').trim();
  if(!raw)return '';
  if(raw.startsWith('/'))return cfg.baseUrl+raw;
  try{
    const u=new URL(raw);
    if(['localhost','127.0.0.1','::1'].includes(u.hostname)){
      const b=new URL(cfg.baseUrl);
      return b.origin+u.pathname+u.search;
    }
  }catch(_){}
  return raw;
}

async function downloadWahaMedia(mediaUrl,{timeout=15000,maxBytes=16*1024*1024}={}){
  const url=resolveWahaMediaUrl(mediaUrl);
  if(!url)throw new Error('WAHA_MEDIA_URL_MISSING');
  const ctrl=new AbortController(),timer=setTimeout(()=>ctrl.abort(),timeout);
  try{
    const r=await fetch(url,{headers:headers({Accept:'*/*'}),signal:ctrl.signal});
    if(!r.ok)throw new Error(`WAHA_MEDIA_HTTP_${r.status}`);
    const len=Number(r.headers.get('content-length')||0);
    if(len&&len>maxBytes)throw new Error('WAHA_MEDIA_TOO_LARGE');
    const buf=Buffer.from(await r.arrayBuffer());
    if(buf.length>maxBytes)throw new Error('WAHA_MEDIA_TOO_LARGE');
    return {buffer:buf,mimeType:String(r.headers.get('content-type')||''),sourceUrl:url};
  }finally{clearTimeout(timer)}
}

async function getWahaMessageById(groupId,messageId,{downloadMedia=true}={}){
  const cfg=wahaConfig(),gid=String(groupId||'').trim(),mid=String(messageId||'').trim();
  if(!gid||!mid)throw new Error('WAHA_MESSAGE_ID_REQUIRED');
  const suffix=`?downloadMedia=${downloadMedia?'true':'false'}`;
  try{
    return await wahaRequest(`/api/${encodeURIComponent(cfg.session)}/chats/${encodeURIComponent(gid)}/messages/${encodeURIComponent(mid)}${suffix}`,{timeout:12000});
  }catch(e){
    // GOWS/NOWEB also support chatId=all for bare message ids.
    return wahaRequest(`/api/${encodeURIComponent(cfg.session)}/chats/all/messages/${encodeURIComponent(mid)}${suffix}`,{timeout:12000});
  }
}

async function refreshGroups(){
  const cfg=wahaConfig();
  const now=Date.now();
  if(now-lastGroupRefreshAt<30000)return;
  lastGroupRefreshAt=now;
  try{await wahaRequest(`/api/${encodeURIComponent(cfg.session)}/groups/refresh`,{method:'POST',body:{},timeout:8000});}
  catch(e){console.warn('WAHA groups refresh failed',e.message)}
}

async function resolveWahaJid(jid,db,{allowRefresh=true}={}){
  const cfg=wahaConfig();
  const raw=String(jid||'').trim();
  if(!raw)return '';
  if(!/@lid$/i.test(raw))return normalizePhone(raw);
  const lid=raw.toLowerCase();
  if(db){
    const q=await db.query(`SELECT phone FROM whatsapp_identity_map WHERE provider='waha' AND session_name=$1 AND lid=$2 LIMIT 1`,[cfg.session,lid]);
    if(q.rowCount)return normalizePhone(q.rows[0].phone);
  }
  async function lookup(){
    const data=await wahaRequest(`/api/${encodeURIComponent(cfg.session)}/lids/${encodeURIComponent(lid)}`,{timeout:3500}).catch(e=>{
      if(e.status===404)return null;throw e;
    });
    const phone=normalizePhone(data?.pn||'');
    if(phone&&db){
      await db.query(`INSERT INTO whatsapp_identity_map(provider,session_name,lid,phone,updated_at)
        VALUES('waha',$1,$2,$3,now())
        ON CONFLICT(provider,session_name,lid) DO UPDATE SET phone=EXCLUDED.phone,updated_at=now()`,[cfg.session,lid,phone]);
    }
    return phone;
  }
  let phone=await lookup();
  if(!phone&&allowRefresh){await refreshGroups();phone=await lookup();}
  if(!phone)throw new Error(`WAHA_LID_UNRESOLVED:${lid}`);
  return phone;
}

function groupIdFromPayload(p={}){
  const candidates=[p.from,p.to,p.chatId,p._data?.key?.remoteJid,p._data?.remoteJid];
  return String(candidates.find(x=>String(x||'').endsWith('@g.us'))||'');
}
function senderJidFromPayload(p={},groupId=''){
  const candidates=[p.participant,p.author,p._data?.key?.participant,p._data?.participant,p._data?.author,p.from];
  return String(candidates.find(x=>x&&String(x)!==groupId&&!String(x).endsWith('@g.us'))||'');
}
function eventTimestamp(v){
  let n=Number(v||Date.now()/1000);if(n>1e12)n=Math.floor(n/1000);return Math.floor(n);
}

function messageIdValue(v){
  if(v===null||v===undefined)return '';
  if(typeof v==='string'||typeof v==='number')return String(v);
  if(typeof v==='object'){
    const candidates=[v._serialized,v.serialized,v.id,v.messageId,v.stanzaId,v.key?.id];
    for(const x of candidates){
      if(x===v||x===null||x===undefined)continue;
      const s=messageIdValue(x);
      if(s)return s;
    }
  }
  return '';
}

async function normalizeWahaWebhook(raw,db){
  const event=String(raw?.event||'');
  if(!['message','message.reaction'].includes(event))return null;
  const p=raw.payload||{};
  const groupId=groupIdFromPayload(p);
  if(!groupId)return null;
  const senderJid=senderJidFromPayload(p,groupId);
  const phone=await resolveWahaJid(senderJid,db);
  if(!phone)throw new Error(`WAHA_SENDER_UNRESOLVED:${senderJid}`);
  const senderName=String(p.pushName||p.notifyName||p.senderName||p._data?.notifyName||p._data?.pushName||'');
  const id=messageIdValue(p.id)||messageIdValue(p._data?.id);
  if(!id)return null;
  const base={
    typeWebhook:'WAHA_'+event,
    idMessage:id,
    timestamp:eventTimestamp(p.timestamp||raw.timestamp),
    senderData:{chatId:groupId,sender:`${phone}@c.us`,senderName,senderContactName:senderName},
    _provider:'waha',
    _waha:{session:String(raw.session||''),engine:String(raw.engine||''),rawEvent:event}
  };
  if(event==='message.reaction'){
    const reaction=String(p.reaction?.text??'');
    const target=messageIdValue(p.reaction?.messageId)||messageIdValue(p._data?.reaction?.messageId);
    if(!target)return null;
    base.messageData={
      typeMessage:'reactionMessage',
      quotedMessage:{stanzaId:target},
      extendedTextMessageData:{text:reaction}
    };
    return base;
  }
  const text=String(p.body||p.caption||p.text||p._data?.body||p._data?.caption||p._data?.text||'');
  const quoted=messageIdValue(p.replyTo?.id)
    ||messageIdValue(p._data?.quotedStanzaID)
    ||messageIdValue(p._data?.contextInfo?.stanzaId);
  const rawType=String(p.type||p._data?.type||'').toLowerCase();
  const mediaUrl=String(p.media?.url||p.downloadUrl||p._data?.media?.url||'');
  const mimeType=String(p.mimetype||p.mimeType||p.media?.mimetype||p._data?.mimetype||'');
  const audioLike=rawType==='ptt'||rawType.includes('audio')||rawType.includes('voice');
  const imageLike=rawType.includes('image');
  const videoLike=rawType.includes('video');
  const documentLike=rawType.includes('document')||rawType.includes('file');
  if(audioLike||imageLike||videoLike||documentLike){
    base.messageData={
      typeMessage:audioLike?'audioMessage':imageLike?'imageMessage':videoLike?'videoMessage':'documentMessage',
      quotedMessage:quoted?{stanzaId:quoted}:undefined,
      extendedTextMessageData:quoted?{text,stanzaId:quoted}:undefined,
      fileMessageData:{caption:text,downloadUrl:mediaUrl,mimeType,fileName:String(p.media?.filename||p.filename||p._data?.filename||'')}
    };
  }else{
    base.messageData=quoted
      ?{typeMessage:'extendedTextMessage',extendedTextMessageData:{text,stanzaId:quoted},quotedMessage:{stanzaId:quoted}}
      :{typeMessage:'textMessage',textMessageData:{textMessage:text}};
  }
  return base;
}

async function getWahaSessionStatus(){
  const cfg=wahaConfig();
  return wahaRequest(`/api/sessions/${encodeURIComponent(cfg.session)}`,{timeout:4000});
}

function webhookUrl(){
  const explicit=String(process.env.WAHA_WEBHOOK_PUBLIC_URL||'').trim();
  const host=String(process.env.RAILWAY_PUBLIC_DOMAIN||'').trim();
  return explicit|| (host?`https://${host}/webhooks/waha`:'');
}

async function ensureWahaSession(){
  const cfg=wahaConfig(),url=webhookUrl();
  if(process.env.DROPCODE_API_URL){
    if(!cfg.baseUrl)return {configured:false,reason:'DROPCODE_API_URL_MISSING'};
    const current=await getWahaSessionStatus();
    return {configured:true,created:false,status:current?.status||'unknown',session:cfg.session,provider:'dropcode'};
  }
  const useGlobal=String(process.env.WAHA_USE_GLOBAL_WEBHOOK||'0')==='1';
  if(!cfg.baseUrl)return {configured:false,reason:'WAHA_URL_MISSING'};
  if(!url)return {configured:false,reason:'WEBHOOK_URL_MISSING'};
  const desired={
    url,
    events:['message','message.reaction','session.status'],
    retries:{policy:'linear',delaySeconds:2,attempts:8},
    customHeaders: cfg.webhookSecret ? [{name:'X-ClickPlus-Webhook-Secret',value:cfg.webhookSecret}] : []
  };
  let current=null;
  try{current=await getWahaSessionStatus();}catch(e){if(e.status!==404)throw e}
  if(!current){
    current=await wahaRequest('/api/sessions',{method:'POST',body:{name:cfg.session,start:true,config:{webhooks:useGlobal?[]:[desired]}},timeout:12000});
    if(String(current?.status||'').toUpperCase()==='STOPPED') current=await wahaRequest(`/api/sessions/${encodeURIComponent(cfg.session)}/start`,{method:'POST',body:{},timeout:12000});
    return {configured:true,created:true,status:current?.status||'unknown',session:cfg.session,globalWebhook:useGlobal};
  }
  const hooks=Array.isArray(current.config?.webhooks)?current.config.webhooks:[];
  if(useGlobal){
    const cleaned=hooks.filter(h=>!String(h?.url||'').includes('/webhooks/waha'));
    if(cleaned.length!==hooks.length){
      current=await wahaRequest(`/api/sessions/${encodeURIComponent(cfg.session)}`,{
        method:'PUT',
        body:{name:cfg.session,config:{...(current.config||{}),webhooks:cleaned}},
        timeout:15000
      });
    }
    const st=String(current?.status||'').toUpperCase();
    if(st==='FAILED')current=await wahaRequest(`/api/sessions/${encodeURIComponent(cfg.session)}/restart`,{method:'POST',body:{},timeout:15000});
    else if(st==='STOPPED')current=await wahaRequest(`/api/sessions/${encodeURIComponent(cfg.session)}/start`,{method:'POST',body:{},timeout:12000});
    return {configured:true,created:false,status:current?.status||'unknown',session:cfg.session,webhook:url,globalWebhook:true};
  }
  const match=hooks.some(h=>{
    const eventsOk=['message','message.reaction'].every(x=>(h.events||[]).includes(x));
    const headerOk=!cfg.webhookSecret || (h.customHeaders||[]).some(x=>String(x?.name||'').toLowerCase()==='x-amman-webhook-secret'&&String(x?.value||'')===cfg.webhookSecret);
    return String(h.url||'')===url&&eventsOk&&headerOk;
  });
  if(!match){
    const other=hooks.filter(h=>!String(h.url||'').includes('/webhooks/waha'));
    current=await wahaRequest(`/api/sessions/${encodeURIComponent(cfg.session)}`,{
      method:'PUT',
      body:{name:cfg.session,config:{...(current.config||{}),webhooks:[...other,desired]}},
      timeout:15000
    });
  }
  const status=String(current?.status||'').toUpperCase();
  if(status==='FAILED'){
    current=await wahaRequest(`/api/sessions/${encodeURIComponent(cfg.session)}/restart`,{method:'POST',body:{},timeout:15000});
  }else if(status==='STOPPED'){
    current=await wahaRequest(`/api/sessions/${encodeURIComponent(cfg.session)}/start`,{method:'POST',body:{},timeout:12000});
  }
  return {configured:true,created:false,status:current?.status||'unknown',session:cfg.session,webhook:url};
}

async function getWahaGroupParticipants(groupId,db){
  const cfg=wahaConfig();
  let groupData={};
  let participants=[];
  if(process.env.DROPCODE_API_URL){
    groupData=await wahaRequest(`/api/${encodeURIComponent(cfg.session)}/groups/${encodeURIComponent(groupId)}`,{timeout:7000})||{};
    participants=Array.isArray(groupData?.participants)?groupData.participants:[];
  }else{
    participants=await wahaRequest(`/api/${encodeURIComponent(cfg.session)}/groups/${encodeURIComponent(groupId)}/participants/v2`,{timeout:7000});
    if(!Array.isArray(participants))participants=[];
    if(participants.some(p=>String(p?.id||p?.jid||p?.phoneNumber||'').endsWith('@lid'))){
      await refreshGroups();
      participants=await wahaRequest(`/api/${encodeURIComponent(cfg.session)}/groups/${encodeURIComponent(groupId)}/participants/v2`,{timeout:7000});
      if(!Array.isArray(participants))participants=[];
    }
    try{groupData=await wahaRequest(`/api/${encodeURIComponent(cfg.session)}/groups/${encodeURIComponent(groupId)}`,{timeout:5000})||{}}catch(_){}
  }
  const phones=new Set(),memberMap=new Map();let lidsResolved=0,lidsUnresolved=0;
  const lidPhones=new Map();
  for(const p of participants){
    const lid=String(p?.lid||p?.id||'').trim().toLowerCase();
    const phoneCandidate=[p?.phoneNumber,p?.phoneJid,p?.pn,p?.phone,p?.jid,p?.id].map(v=>String(v||'').trim()).find(v=>v&&!v.endsWith('@lid'));
    if(lid.endsWith('@lid')&&phoneCandidate){const ph=normalizePhone(phoneCandidate);if(/^[0-9]{10,15}$/.test(ph))lidPhones.set(lid,ph);}
  }
  for(const p of participants){
    const raw=String(p?.phoneNumber||p?.phoneJid||p?.pn||p?.phone||p?.id||p?.jid||p?.participant||'').trim();
    if(!raw)continue;
    const lid=String(p?.lid||p?.id||'').trim().toLowerCase();
    let ph='';
    try{
      ph=raw.endsWith('@lid')?(lidPhones.get(raw.toLowerCase())||await resolveWahaJid(raw,db,{allowRefresh:false})):normalizePhone(raw);
      if(!/^[0-9]{10,15}$/.test(ph))ph='';
    }catch(e){console.warn('DropConnect participant unresolved',e.message)}
    if(!ph){lidsUnresolved++;continue;}
    phones.add(ph);
    if(raw.endsWith('@lid')||lid.endsWith('@lid'))lidsResolved++;
    const displayName=cleanDisplayName(p?.pushname||p?.pushName||p?.notifyName||p?.contact?.pushname||p?.contact?.pushName||p?.name||p?.shortName||p?.verifiedName||p?.contact?.name||'');
    if(!memberMap.has(ph)||(!memberMap.get(ph).name&&displayName))memberMap.set(ph,{phone:ph,name:displayName});
  }
  return {name:String(groupData?.subject||groupData?.name||''),phones:[...phones],members:[...memberMap.values()],total:participants.length,lidsResolved,lidsUnresolved};
}

async function sendWahaText(phone,message){
  const cfg=wahaConfig();
  const chatId=`${normalizePhone(phone)}@c.us`;
  return wahaRequest('/api/sendText',{method:'POST',body:{session:cfg.session,chatId,text:String(message||'')},timeout:7000});
}

module.exports={wahaConfig,wahaRequest,resolveWahaJid,normalizeWahaWebhook,ensureWahaSession,getWahaSessionStatus,getWahaGroupParticipants,getWahaContactName,downloadWahaMedia,getWahaMessageById,sendWahaText};

