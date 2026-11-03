'use strict';
// Native DropCode event.v1 adapter. Never infer a phone number from a WhatsApp LID.
function normalize(envelope, expectedSession) {
  if (!expectedSession || envelope?.schema !== 'dropcode.event.v1' || envelope.session !== expectedSession) return [];
  const action = String(envelope.action || '');
  if (!['message','reaction_added','reaction_removed'].includes(action)) return [];
  // Ignore history sync, self-sent messages and events outside configured groups.
  if (envelope.rawEvent === 'message.history' || envelope.sender?.fromMe || envelope.reaction?.fromMe) return [];
  const groupId = String(envelope.group?.id || '');
  if (!groupId.endsWith('@g.us')) return [];
  const sender = String(envelope.sender?.phoneJid || envelope.sender?.jid || '');
  if (!sender) return []; // unresolved LID is queued for verified lookup by worker
  const reaction = action !== 'message';
  const target = String(envelope.reaction?.targetMessageId || '');
  const id = String(envelope.message?.id || '');
  if (reaction && !target) return [];
  if (!reaction && !id) return [];
  const receivedTs=Math.floor(new Date(envelope.receivedAt||0).getTime()/1000);
  const timestamp = Number(envelope.timestamp || 0) || (Number.isFinite(receivedTs)&&receivedTs>0?receivedTs:0);
  const payload = {
    provider: 'dropcode',
    typeWebhook: 'incomingMessageReceived',
    idMessage: reaction ? target + ':reaction:' + sender + ':' + String(envelope.reaction?.emoji||'removed') + ':' + String(envelope.receivedAt||'') : id,
    timestamp,
    senderData: {chatId:groupId,sender,senderName:String(envelope.sender?.whatsappName||'')},
    messageData: reaction
      ? {typeMessage:'reactionMessage',extendedTextMessageData:{text:action==='reaction_removed'?'':String(envelope.reaction?.emoji||'')},quotedMessage:{stanzaId:target}}
      : (() => {
          const msg=envelope.message||{};
          const media=msg.media||{};
          const kind=String(msg.type||'').toLowerCase();
          const mime=String(media.mimetype||media.mimeType||'');
          const url=String(media.url||'');
          const quoted=String(msg.quotedMessageId||'');
          const text=String(msg.text||'');
          const isAudio=/audio|voice|ptt/.test(kind)||/^audio\//i.test(mime);
          const isImage=/image/.test(kind)||/^image\//i.test(mime);
          const isVideo=/video/.test(kind)||/^video\//i.test(mime);
          const isDocument=/document|file/.test(kind)||/^(application|text)\//i.test(mime);
          if(isAudio||isImage||isVideo||isDocument){
            return {
              typeMessage:isAudio?'audioMessage':isImage?'imageMessage':isVideo?'videoMessage':'documentMessage',
              ...(quoted?{quotedMessage:{stanzaId:quoted},extendedTextMessageData:{text,stanzaId:quoted}}:{}),
              fileMessageData:{
                caption:text,downloadUrl:url,mimeType:mime,
                fileName:String(media.filename||'')
              }
            };
          }
          return {
            typeMessage:quoted?'extendedTextMessage':'textMessage',
            textMessageData:{textMessage:text},
            extendedTextMessageData:{text,stanzaId:quoted}
          };
        })()
  };
  return [payload];
}
module.exports = { translate: normalize };

