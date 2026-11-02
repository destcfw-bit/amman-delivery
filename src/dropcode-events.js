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
      : {typeMessage:envelope.message?.quotedMessageId?'extendedTextMessage':'textMessage',
        textMessageData:{textMessage:String(envelope.message?.text||'')},
        extendedTextMessageData:{text:String(envelope.message?.text||''),stanzaId:String(envelope.message?.quotedMessageId||'')}}
  };
  return [payload];
}
module.exports = { translate: normalize };

