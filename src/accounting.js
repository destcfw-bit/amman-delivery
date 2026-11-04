const { REACTIONS, normalizePhone, getQuotedId, getReactionTarget, getReaction, getText } = require('./utils');
const { tx } = require('./db');
const { downloadWahaMedia } = require('./waha');

async function groupEnabled(client, groupId) {
  const r = await client.query('SELECT active FROM groups WHERE group_id=$1 LIMIT 1', [groupId]);
  return r.rowCount > 0 && r.rows[0].active === true;
}

function cleanWhatsappName(v='') {
  return String(v||'').trim().replace(/\s+/g,' ').slice(0,120);
}

async function syncCaptainWhatsappName(client, phone, whatsappName='') {
  const p=normalizePhone(phone);
  const n=cleanWhatsappName(whatsappName);
  if(!p||!n)return false;
  const q=await client.query(`SELECT name FROM captains WHERE phone=$1 LIMIT 1`,[p]);
  if(!q.rowCount)return false;
  const current=String(q.rows[0].name||'').trim();
  const placeholder=!current || current===p || /^كابتن\s+0?7\d{8}$/u.test(current);
  await client.query(`
    UPDATE captains
    SET whatsapp_name=$2,
        whatsapp_name_updated_at=now(),
        name=CASE WHEN $3 THEN $2 ELSE name END,
        updated_at=now()
    WHERE phone=$1
  `,[p,n,placeholder]);
  return true;
}

async function findWhatsappMessage(client, groupId, messageId) {
  const id=String(messageId||'').trim();
  if(!groupId||!id)return {rowCount:0,rows:[]};
  return client.query(`
    SELECT *
    FROM whatsapp_messages
    WHERE group_id=$1
      AND (
        message_id=$2
        OR right(message_id,char_length($2))=$2
        OR position($2 in message_id)>0
      )
    ORDER BY CASE
      WHEN message_id=$2 THEN 0
      WHEN right(message_id,char_length($2))=$2 THEN 1
      ELSE 2
    END, created_at DESC
    LIMIT 1
  `,[groupId,id]);
}


async function persistWhatsappMedia(client,groupId,messageId,payload){
  const fm=payload?.messageData?.fileMessageData||{};
  const mediaUrl=String(fm.downloadUrl||fm.url||'').trim();
  if(!mediaUrl)return false;
  try{
    const d=await downloadWahaMedia(mediaUrl,{timeout:12000,maxBytes:16*1024*1024});
    const mime=String(fm.mimeType||d.mimeType||'application/octet-stream').slice(0,160);
    const fileName=String(fm.fileName||'').slice(0,255);
    await client.query(`
      INSERT INTO whatsapp_media(group_id,message_id,mime_type,file_name,file_data,source_url,updated_at)
      VALUES($1,$2,$3,$4,$5,$6,now())
      ON CONFLICT(group_id,message_id) DO UPDATE SET
        mime_type=EXCLUDED.mime_type,
        file_name=EXCLUDED.file_name,
        file_data=EXCLUDED.file_data,
        source_url=EXCLUDED.source_url,
        updated_at=now()
    `,[groupId,messageId,mime,fileName,d.buffer,mediaUrl]);
    return true;
  }catch(e){
    console.warn('WAHA MEDIA SAVE FAILED',groupId,messageId,e.message);
    return false;
  }
}

async function upsertMessage(client, payload) {
  const groupId = payload.senderData?.chatId || '';
  const messageId = payload.idMessage || '';
  const senderPhone = normalizePhone(payload.senderData?.sender || '');
  const senderName = payload.senderData?.senderName || payload.senderData?.senderContactName || '';
  const quoted = getQuotedId(payload);
  if (!groupId || !messageId || !senderPhone) return null;

  await client.query(`
    INSERT INTO whatsapp_messages(group_id,message_id,sender_phone,sender_name,text_body,quoted_message_id,webhook_type,raw)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8)
    ON CONFLICT(group_id,message_id) DO UPDATE SET
      sender_name=EXCLUDED.sender_name,
      text_body=COALESCE(NULLIF(EXCLUDED.text_body,''),whatsapp_messages.text_body),
      quoted_message_id=COALESCE(NULLIF(EXCLUDED.quoted_message_id,''),whatsapp_messages.quoted_message_id),
      raw=EXCLUDED.raw
  `,[groupId,messageId,senderPhone,senderName,getText(payload),quoted,payload.typeWebhook||'',payload]);

  await syncCaptainWhatsappName(client,senderPhone,senderName);
  await persistWhatsappMedia(client,groupId,messageId,payload);

  if (quoted) {
    const original = await findWhatsappMessage(client,groupId,quoted);
    if (original.rowCount) {
      const o = original.rows[0];
      if (o.sender_phone !== senderPhone) {
        const w = await client.query(`SELECT id FROM accounting_weeks WHERE status='open' ORDER BY id DESC LIMIT 1 FOR SHARE`);
        const weekId = w.rows[0]?.id || null;
        await client.query(`
          INSERT INTO claims(group_id,original_message_id,reply_message_id,producer_phone,consumer_phone,producer_name,consumer_name,week_id)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8)
          ON CONFLICT(reply_message_id) DO NOTHING
        `,[groupId,o.message_id,messageId,o.sender_phone,senderPhone,o.sender_name||'',senderName||'',weekId]);
      }
    }
  }
  return true;
}

async function isAuthorizedCancel(client, phone) {
  const r = await client.query(
    'SELECT 1 FROM authorized_numbers WHERE phone=$1 AND active=true LIMIT 1',
    [phone]
  );
  return r.rowCount > 0;
}

async function notifyCaptain(client, phone, kind, title, body='', metadata={}) {
  try { await client.query(`INSERT INTO captain_notifications(captain_phone,kind,title,body,metadata) VALUES($1,$2,$3,$4,$5)`,[phone,kind,title,body,metadata]); } catch(e) {}
}

async function logReaction(client, eventId, claimId, target, reactor, reaction, decision, note='') {
  await client.query(`
    INSERT INTO reaction_log(event_id,claim_id,target_message_id,reactor_phone,reaction,decision,note)
    VALUES($1,$2,$3,$4,$5,$6,$7)
  `,[eventId,claimId,target,reactor,reaction,decision,note]);
}

async function reverseActiveMovements(client, claimId) {
  const active = await client.query(
    `SELECT * FROM movements WHERE claim_id=$1 AND status='active' FOR UPDATE`,
    [claimId]
  );
  for (const m of active.rows) {
    await client.query(
      `UPDATE movements SET status='cancelled',cancelled_at=now() WHERE id=$1`,
      [m.id]
    );
    if (m.direction === 'production') {
      await client.query(`
        INSERT INTO captain_balances(captain_phone,production,consumption,net)
        VALUES($1,0,0,0)
        ON CONFLICT(captain_phone) DO NOTHING`, [m.captain_phone]);
      await client.query(`
        UPDATE captain_balances
        SET production=production-$2, net=(production-$2)-consumption, updated_at=now()
        WHERE captain_phone=$1`, [m.captain_phone, m.amount]);
    } else {
      await client.query(`
        INSERT INTO captain_balances(captain_phone,production,consumption,net)
        VALUES($1,0,0,0)
        ON CONFLICT(captain_phone) DO NOTHING`, [m.captain_phone]);
      await client.query(`
        UPDATE captain_balances
        SET consumption=consumption-$2, net=production-(consumption-$2), updated_at=now()
        WHERE captain_phone=$1`, [m.captain_phone, m.amount]);
    }
  }
}

async function addMovementPair(client, claim, reaction, value) {
  const ver = await client.query(
    `SELECT COALESCE(MAX(version_no),0)+1 AS v FROM movements WHERE claim_id=$1`,
    [claim.id]
  );
  const version = Number(ver.rows[0].v || 1);
  await client.query(`
    INSERT INTO movements(claim_id,direction,captain_phone,amount,reaction,version_no)
    VALUES
      ($1,'production',$2,$4,$5,$6),
      ($1,'consumption',$3,$4,$5,$6)
  `,[claim.id,claim.producer_phone,claim.consumer_phone,value,reaction,version]);

  await client.query(`INSERT INTO captain_balances(captain_phone) VALUES($1) ON CONFLICT DO NOTHING`,[claim.producer_phone]);
  await client.query(`INSERT INTO captain_balances(captain_phone) VALUES($1) ON CONFLICT DO NOTHING`,[claim.consumer_phone]);

  await client.query(`
    UPDATE captain_balances
    SET production=production+$2, net=(production+$2)-consumption, updated_at=now()
    WHERE captain_phone=$1`, [claim.producer_phone,value]);
  await client.query(`
    UPDATE captain_balances
    SET consumption=consumption+$2, net=production-(consumption+$2), updated_at=now()
    WHERE captain_phone=$1`, [claim.consumer_phone,value]);
}


async function missingRegisteredParties(client, claim) {
  const q=await client.query(`SELECT phone FROM captains WHERE phone = ANY($1::text[])`,[[claim.producer_phone,claim.consumer_phone]]);
  const set=new Set(q.rows.map(x=>x.phone));
  return {
    producer:!set.has(claim.producer_phone),
    consumer:!set.has(claim.consumer_phone),
    any:!set.has(claim.producer_phone)||!set.has(claim.consumer_phone)
  };
}

async function reconcilePendingClaimsForPhone(client, phone=null) {
  const params=[]; let filter='';
  if(phone){params.push(phone);filter=`AND (c.producer_phone=$1 OR c.consumer_phone=$1)`;}
  const q=await client.query(`
    SELECT c.* FROM claims c
    JOIN captains p ON p.phone=c.producer_phone
    JOIN captains k ON k.phone=c.consumer_phone
    WHERE c.status='waiting_registration' AND c.current_reaction IS NOT NULL AND c.current_value>0 ${filter}
    ORDER BY c.id FOR UPDATE`,params);
  let applied=0;
  for(const claim of q.rows){
    const mv=await client.query(`SELECT 1 FROM movements WHERE claim_id=$1 AND status='active' LIMIT 1`,[claim.id]);
    if(mv.rowCount) continue;
    await addMovementPair(client,claim,claim.current_reaction,Number(claim.current_value));
    await client.query(`UPDATE claims SET status='active',updated_at=now() WHERE id=$1`,[claim.id]);
    await logReaction(client,null,claim.id,claim.reply_message_id,claim.approved_by||claim.producer_phone,claim.current_reaction,'applied','تم احتساب الحركة بعد تسجيل الرقم الناقص');
    await notifyCaptain(client,claim.producer_phone,'success','تم استكمال احتساب الطلب',`تم احتساب ${Number(claim.current_value).toFixed(2)} د.أ بعد تسجيل الطرف الناقص.`,{claim_id:claim.id});
    await notifyCaptain(client,claim.consumer_phone,'info','تم استكمال احتساب الطلب',`تم احتساب ${Number(claim.current_value).toFixed(2)} د.أ استهلاك بعد تسجيل الطرف الناقص.`,{claim_id:claim.id});
    await enqueueSheetSync(client,claim.id);
    applied++;
  }
  return applied;
}

async function enqueueSheetSync(client, claimId) {
  const claimQ = await client.query(`
    SELECT
      c.*,
      COALESCE(pc.name,c.producer_name,c.producer_phone) AS producer_display_name,
      COALESCE(cc.name,c.consumer_name,c.consumer_phone) AS consumer_display_name,
      COALESCE(g.name,c.group_id) AS group_display_name
    FROM claims c
    LEFT JOIN captains pc ON pc.phone=c.producer_phone
    LEFT JOIN captains cc ON cc.phone=c.consumer_phone
    LEFT JOIN groups g ON g.group_id=c.group_id
    WHERE c.id=$1
  `,[claimId]);

  const claim = claimQ.rows[0] || null;
  const phones = claim ? [claim.producer_phone, claim.consumer_phone] : [];

  const bal = phones.length ? await client.query(`
    SELECT
      b.*,
      COALESCE(c.name,b.captain_phone) AS captain_name
    FROM captain_balances b
    LEFT JOIN captains c ON c.phone=b.captain_phone
    WHERE b.captain_phone = ANY($1::text[])
  `,[phones]) : { rows: [] };

  const payload = { claim, balances: bal.rows };
  const key = `claim:${claimId}:${Date.now()}`;
  await client.query(`
    INSERT INTO sheet_sync_queue(sync_key,kind,payload) VALUES($1,'claim_update',$2)
    ON CONFLICT(sync_key) DO NOTHING`,[key,payload]);
}

// 🚫 from authorized numbers applies to a reply or all claims linked to one original request.
// Always reverse both sides of each ACTIVE accounting movement in the same DB transaction.
async function cancelByAuthorizedReaction(client,eventId,groupId,target,reactor,eventTs){
  if(!(await isAuthorizedCancel(client,reactor))){
    await logReaction(client,eventId,null,target,reactor,'🚫','rejected','الرقم غير مخول للإلغاء');
    return {status:'rejected',message:'cancel not authorized'};
  }
  const replies=await client.query(`SELECT * FROM claims WHERE group_id=$1 AND
      (reply_message_id=$2 OR right(reply_message_id,char_length($2))=$2 OR position($2 in reply_message_id)>0)
      ORDER BY id DESC LIMIT 1 FOR UPDATE`,[groupId,target]);
  const claims=replies.rowCount?replies.rows:(await client.query(`SELECT * FROM claims
      WHERE group_id=$1 AND (original_message_id=$2 OR right(original_message_id,char_length($2))=$2 OR position($2 in original_message_id)>0)
      ORDER BY id FOR UPDATE`,[groupId,target])).rows;
  if(!claims.length){
    await logReaction(client,eventId,null,target,reactor,'🚫','pending','الطلب لم يصل للمحاسبة بعد');
    throw Object.assign(new Error('CLAIM_NOT_READY'),{retryable:true});
  }
  let cancelled=0,closed=0,duplicates=0,stale=0;
  for(const claim of claims){
    if(claim.week_id){
      const w=await client.query('SELECT status FROM accounting_weeks WHERE id=$1',[claim.week_id]);
      if(w.rows[0]?.status==='closed'){
        closed++;await logReaction(client,eventId,claim.id,target,reactor,'🚫','rejected','WEEK_CLOSED_LOCKED');continue;
      }
    }
    if(eventTs&&Number(claim.last_reaction_ts||0)>eventTs){
      stale++;await logReaction(client,eventId,claim.id,target,reactor,'🚫','ignored','حدث إلغاء أقدم من آخر رياكشن');continue;
    }
    if(claim.status==='cancelled'){
      duplicates++;await logReaction(client,eventId,claim.id,target,reactor,'🚫','duplicate','سبق إلغاء هذا الطلب');continue;
    }
    await reverseActiveMovements(client,claim.id);
    await client.query(`UPDATE claims SET status='cancelled',current_reaction='🚫',current_value=0,
       cancelled_by=$2,last_reaction_ts=GREATEST(last_reaction_ts,$3),updated_at=now() WHERE id=$1`,
       [claim.id,reactor,eventTs||0]);
    await logReaction(client,eventId,claim.id,target,reactor,'🚫','cancelled','إلغاء من رقم مخول');
    await notifyCaptain(client,claim.producer_phone,'warning','تم إلغاء الطلب 🚫','أُلغي الطلب من رقم مخول ولم تعد العمولة محسوبة.',{claim_id:claim.id});
    await notifyCaptain(client,claim.consumer_phone,'warning','تم إلغاء الطلب 🚫','أُلغي الطلب من رقم مخول ولم تعد العمولة محسوبة.',{claim_id:claim.id});
    await enqueueSheetSync(client,claim.id);
    cancelled++;
  }
  if(cancelled)return {status:'cancelled',message:'authorized cancellation',cancelled,closed,duplicates,stale};
  return {status:closed?'rejected':'ignored',message:closed?'week already closed':'nothing to cancel',cancelled,closed,duplicates,stale};
}
async function processReaction(client, eventId, payload) {
  const groupId = payload.senderData?.chatId || '';
  const target = getReactionTarget(payload);
  const reaction = getReaction(payload); // empty string = reaction removed
  const reactor = normalizePhone(payload.senderData?.sender || '');
  const eventTs = Number(payload.timestamp || 0);

  if (!groupId || !target || !reactor) {
    return {status:'ignored',message:'reaction incomplete'};
  }

  if(reaction==='🚫')return cancelByAuthorizedReaction(client,eventId,groupId,target,reactor,eventTs);

  let c = await client.query(
    `SELECT * FROM claims
     WHERE group_id=$1 AND (
       reply_message_id=$2
       OR right(reply_message_id,char_length($2))=$2
       OR position($2 in reply_message_id)>0
     )
     ORDER BY CASE
       WHEN reply_message_id=$2 THEN 0
       WHEN right(reply_message_id,char_length($2))=$2 THEN 1
       ELSE 2
     END, id DESC
     LIMIT 1 FOR UPDATE`,
    [groupId,target]
  );

  // Authorized 🚫 may target the original message only if exactly one active/waiting claim exists.
  if (!c.rowCount && reaction === '🚫') {
    c = await client.query(`
      SELECT * FROM claims
      WHERE group_id=$1
        AND status IN ('waiting','active','waiting_registration')
        AND (
          original_message_id=$2
          OR right(original_message_id,char_length($2))=$2
          OR position($2 in original_message_id)>0
        )
      ORDER BY CASE
        WHEN original_message_id=$2 THEN 0
        WHEN right(original_message_id,char_length($2))=$2 THEN 1
        ELSE 2
      END, id DESC
      LIMIT 2 FOR UPDATE
    `,[groupId,target]);

    if (c.rowCount !== 1) {
      await logReaction(client,eventId,null,target,reactor,reaction,'ignored','🚫 على الطلب الأصلي يحتاج طلباً واحداً واضحاً');
      return {status:'ignored',message:'ambiguous original cancel'};
    }
  }

  if (!c.rowCount) {
    // Self-heal missed claim creation (notably WAHA/GOWS replyTo can carry only the bare message id).
    const replyQ=await findWhatsappMessage(client,groupId,target);
    if(replyQ.rowCount && replyQ.rows[0].quoted_message_id){
      const reply=replyQ.rows[0], quoted=reply.quoted_message_id;
      const originalQ=await findWhatsappMessage(client,groupId,quoted);
      if(originalQ.rowCount && originalQ.rows[0].sender_phone!==reply.sender_phone){
        const o=originalQ.rows[0];
        const w=await client.query(`SELECT id FROM accounting_weeks WHERE status='open' ORDER BY id DESC LIMIT 1 FOR SHARE`);
        await client.query(`
          INSERT INTO claims(group_id,original_message_id,reply_message_id,producer_phone,consumer_phone,producer_name,consumer_name,week_id)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8)
          ON CONFLICT(reply_message_id) DO NOTHING
        `,[groupId,o.message_id,reply.message_id,o.sender_phone,reply.sender_phone,o.sender_name||'',reply.sender_name||'',w.rows[0]?.id||null]);
        c=await client.query(
          `SELECT * FROM claims WHERE group_id=$1 AND reply_message_id=$2 LIMIT 1 FOR UPDATE`,
          [groupId,target]
        );
      }
    }
    if(!c.rowCount){
      await logReaction(client,eventId,null,target,reactor,reaction || 'REMOVED','pending','reply/claim not found yet');
      throw Object.assign(new Error('CLAIM_NOT_READY'), { retryable:true });
    }
  }

  const claim = c.rows[0];

  // Closed weekly ledgers are immutable: late reactions cannot rewrite a closed week.
  if (claim.week_id) {
    const wq = await client.query(`SELECT status FROM accounting_weeks WHERE id=$1`,[claim.week_id]);
    if (wq.rowCount && wq.rows[0].status === 'closed') {
      await logReaction(client,eventId,claim.id,target,reactor,reaction || 'REMOVED','rejected','WEEK_CLOSED_LOCKED');
      return {status:'rejected',message:'week already closed'};
    }
  }

  // Ignore an older reaction event that arrives after a newer one.
  if (eventTs && Number(claim.last_reaction_ts || 0) > eventTs) {
    await logReaction(client,eventId,claim.id,target,reactor,reaction || 'REMOVED','ignored','حدث رياكشن أقدم من آخر حالة معتمدة');
    return {status:'ignored',message:'stale reaction event'};
  }

  // Removing the accounting reaction cancels the commission pair immediately.
  // Use approved_by first (the number that actually applied the commission), while
  // keeping producer_phone as a backward-compatible fallback for old claims.
  if (!reaction) {
    const removerAllowed = reactor === normalizePhone(claim.approved_by || '') || reactor === claim.producer_phone;
    if (!removerAllowed) {
      await logReaction(client,eventId,claim.id,target,reactor,'REMOVED','rejected','إزالة الرياكشن مسموحة لصاحب الرياكشن المحاسبي فقط');
      return {status:'rejected',message:'only accounting reaction owner may remove it'};
    }

    if (claim.status === 'waiting_registration' && claim.current_reaction) {
      await client.query(`UPDATE claims SET status='waiting',current_reaction=NULL,current_value=0,approved_by=NULL,cancelled_by=NULL,last_reaction_ts=GREATEST(last_reaction_ts,$2),updated_at=now() WHERE id=$1`,[claim.id,eventTs||0]);
      await logReaction(client,eventId,claim.id,target,reactor,'REMOVED','cancelled','تم إلغاء حركة معلقة بانتظار تسجيل رقم');
      await enqueueSheetSync(client,claim.id);
      return {status:'cancelled',message:'pending registration reaction removed'};
    }

    if (claim.status !== 'active' || !claim.current_reaction) {
      await logReaction(client,eventId,claim.id,target,reactor,'REMOVED','duplicate','لا توجد عمولة نشطة لإلغائها');
      if (eventTs) {
        await client.query(`UPDATE claims SET last_reaction_ts=GREATEST(last_reaction_ts,$2),updated_at=now() WHERE id=$1`,[claim.id,eventTs]);
      }
      return {status:'duplicate',message:'no active commission'};
    }

    await reverseActiveMovements(client, claim.id);
    await client.query(`
      UPDATE claims
      SET status='waiting',
          current_reaction=NULL,
          current_value=0,
          approved_by=NULL,
          cancelled_by=NULL,
          last_reaction_ts=GREATEST(last_reaction_ts,$2),
          updated_at=now()
      WHERE id=$1
    `,[claim.id,eventTs || 0]);

    await logReaction(client,eventId,claim.id,target,reactor,'REMOVED','cancelled','إزالة الرياكشن ألغت الإنتاج والاستهلاك فوراً');
    await notifyCaptain(client,claim.producer_phone,'warning','تم إلغاء عمولة','تمت إزالة الرياكشن وإلغاء الإنتاج المرتبط بالطلب.',{claim_id:claim.id});
    await notifyCaptain(client,claim.consumer_phone,'warning','تم إلغاء عمولة','تمت إزالة الرياكشن وإلغاء الاستهلاك المرتبط بالطلب.',{claim_id:claim.id});
    await enqueueSheetSync(client,claim.id);
    return {status:'cancelled',message:'commission cancelled by reaction removal'};
  }

  if (reaction === '🚫') {
    if (!(await isAuthorizedCancel(client, reactor))) {
      await logReaction(client,eventId,claim.id,target,reactor,reaction,'rejected','الرقم غير مخول للإلغاء');
      return {status:'rejected',message:'cancel not authorized'};
    }

    await reverseActiveMovements(client, claim.id);
    await client.query(`
      UPDATE claims
      SET status='cancelled',
          current_reaction='🚫',
          current_value=0,
          cancelled_by=$2,
          last_reaction_ts=GREATEST(last_reaction_ts,$3),
          updated_at=now()
      WHERE id=$1
    `,[claim.id,reactor,eventTs || 0]);

    await logReaction(client,eventId,claim.id,target,reactor,reaction,'cancelled','إلغاء من رقم مخول');
    await notifyCaptain(client,claim.producer_phone,'warning','تم إلغاء الطلب 🚫','أُلغي الطلب من رقم مخول ولم تعد العمولة محسوبة.',{claim_id:claim.id});
    await notifyCaptain(client,claim.consumer_phone,'warning','تم إلغاء الطلب 🚫','أُلغي الطلب من رقم مخول ولم تعد العمولة محسوبة.',{claim_id:claim.id});
    await enqueueSheetSync(client,claim.id);
    return {status:'cancelled',message:'claim cancelled'};
  }

  const value = REACTIONS[reaction];
  if (value == null) {
    // WhatsApp lets a user CHANGE a reaction without first emitting an empty reaction.
    // If the same number that approved an active commission changes 👍/1-10 to an
    // unsupported emoji, treat that as removal so the old commission never remains.
    const sameApprover = reactor === normalizePhone(claim.approved_by || '') || reactor === claim.producer_phone;
    const hasAccountingState = (claim.status === 'active' || claim.status === 'waiting_registration') && !!claim.current_reaction;
    if (sameApprover && hasAccountingState) {
      if (claim.status === 'active') await reverseActiveMovements(client, claim.id);
      await client.query(`
        UPDATE claims
        SET status='waiting',current_reaction=NULL,current_value=0,approved_by=NULL,cancelled_by=NULL,
            last_reaction_ts=GREATEST(last_reaction_ts,$2),updated_at=now()
        WHERE id=$1
      `,[claim.id,eventTs || 0]);
      await logReaction(client,eventId,claim.id,target,reactor,reaction,'cancelled','تغيير الرياكشن المحاسبي إلى رياكشن غير محاسبي ألغى العمولة');
      await notifyCaptain(client,claim.producer_phone,'warning','تم إلغاء عمولة','تم تغيير الرياكشن وإلغاء الإنتاج المرتبط بالطلب.',{claim_id:claim.id});
      await notifyCaptain(client,claim.consumer_phone,'warning','تم إلغاء عمولة','تم تغيير الرياكشن وإلغاء الاستهلاك المرتبط بالطلب.',{claim_id:claim.id});
      await enqueueSheetSync(client,claim.id);
      return {status:'cancelled',message:'commission cancelled by non-accounting reaction'};
    }
    await logReaction(client,eventId,claim.id,target,reactor,reaction,'ignored','رياكشن غير محاسبي');
    return {status:'ignored',message:'non accounting reaction'};
  }

  if (reactor !== claim.producer_phone) {
    await logReaction(client,eventId,claim.id,target,reactor,reaction,'rejected','الاعتماد فقط من صاحب الطلب الأصلي');
    return {status:'rejected',message:'only original sender may approve'};
  }

  if (claim.status === 'active' && claim.current_reaction === reaction && Number(claim.current_value) === Number(value)) {
    await logReaction(client,eventId,claim.id,target,reactor,reaction,'duplicate','نفس الرياكشن محسوب مسبقاً');
    if (eventTs) {
      await client.query(`UPDATE claims SET last_reaction_ts=GREATEST(last_reaction_ts,$2),updated_at=now() WHERE id=$1`,[claim.id,eventTs]);
    }
    return {status:'duplicate',message:'already applied'};
  }

  const wasActive = claim.status === 'active' && !!claim.current_reaction;
  const oldReaction = claim.current_reaction, oldValue = Number(claim.current_value||0);

  const missing=await missingRegisteredParties(client,claim);
  if(missing.any){
    if(wasActive) await reverseActiveMovements(client,claim.id);
    await client.query(`UPDATE claims SET status='waiting_registration',current_reaction=$2,current_value=$3,approved_by=$4,cancelled_by=NULL,last_reaction_ts=GREATEST(last_reaction_ts,$5),updated_at=now() WHERE id=$1`,[claim.id,reaction,value,reactor,eventTs||0]);
    const note=`رقم غير مسجل — المنتج:${missing.producer?'غير مسجل':'مسجل'} المستهلك:${missing.consumer?'غير مسجل':'مسجل'}`;
    await logReaction(client,eventId,claim.id,target,reactor,reaction,'pending',note);
    await enqueueSheetSync(client,claim.id);
    return {status:'pending_registration',message:'commission held until both parties are registered'};
  }

  await reverseActiveMovements(client, claim.id);
  await addMovementPair(client, claim, reaction, value);
  await client.query(`
    UPDATE claims
    SET status='active',
        current_reaction=$2,
        current_value=$3,
        approved_by=$4,
        cancelled_by=NULL,
        last_reaction_ts=GREATEST(last_reaction_ts,$5),
        updated_at=now()
    WHERE id=$1
  `,[claim.id,reaction,value,reactor,eventTs || 0]);

  await logReaction(client,eventId,claim.id,target,reactor,reaction,'applied',`production +${value} / consumption ${value}`);
  await notifyCaptain(client,claim.producer_phone,'success',wasActive?'تم تعديل العمولة':'تم احتساب إنتاج',wasActive?`تغيرت العمولة من ${oldValue.toFixed(2)} إلى ${Number(value).toFixed(2)} د.أ.`:`تم احتساب ${Number(value).toFixed(2)} د.أ إنتاج على طلبك.`,{claim_id:claim.id,reaction,value,old_reaction:oldReaction,old_value:oldValue});
  await notifyCaptain(client,claim.consumer_phone,'info',wasActive?'تم تعديل العمولة':'تم احتساب استهلاك',wasActive?`تغير الاستهلاك من ${oldValue.toFixed(2)} إلى ${Number(value).toFixed(2)} د.أ.`:`تم احتساب ${Number(value).toFixed(2)} د.أ استهلاك على الطلب الذي أخذته.`,{claim_id:claim.id,reaction,value,old_reaction:oldReaction,old_value:oldValue});
  await enqueueSheetSync(client,claim.id);
  return {status:'applied',message:'accounting applied'};
}

async function processEvent(eventRow) {
  return tx(async client => {
    const payload = eventRow.payload;
    const groupId = payload.senderData?.chatId || '';
    if (!groupId) return {status:'ignored',message:'no group'};
    if (!(await groupEnabled(client,groupId))) return {status:'ignored',message:'group disabled'};

    if (payload.messageData?.typeMessage === 'reactionMessage') {
      return processReaction(client,eventRow.id,payload);
    }
    await upsertMessage(client,payload);
    return {status:'stored',message:'message stored'};
  });
}

module.exports = { processEvent, reconcilePendingClaimsForPhone, enqueueSheetSync };

