const crypto = require('crypto');

const REACTIONS = {
  '👍': 0.25,
  '1️⃣': 0.25,
  '2️⃣': 0.50,
  '3️⃣': 0.75,
  '4️⃣': 1.00,
  '5️⃣': 1.25,
  '6️⃣': 1.50,
  '7️⃣': 1.75,
  '8️⃣': 2.00,
  '9️⃣': 2.25,
  '🔟': 2.50
};

function normalizePhone(v='') {
  const raw=String(v||'').trim();
  // LID is a hidden WhatsApp identifier, NOT a phone number.
  // WAHA integration resolves it through /api/{session}/lids/{lid} first.
  if(/@lid$/i.test(raw)) return '';
  let p = raw
    .replace(/@c\.us$/,'')
    .replace(/@s\.whatsapp\.net$/,'')
    .replace(/\D/g,'');

  // Jordan normalization:
  // 79xxxxxxx  -> 96279xxxxxxx
  // 079xxxxxxx -> 96279xxxxxxx
  // 96279xxxxxxx stays as-is
  if (/^7\d{8}$/.test(p)) p = '962' + p;
  else if (/^07\d{8}$/.test(p)) p = '962' + p.slice(1);

  return p;
}
function normalizeReaction(v='') {
  const original = String(v || '').trim();
  if (!original) return '';

  // WhatsApp may send 👍 with any Fitzpatrick skin-tone modifier.
  // All thumbs-up colour variants are the SAME accounting reaction (0.25 JOD).
  let x = original
    .replace(/[\u{1F3FB}-\u{1F3FF}]/gu, '')
    .replace(/\uFE0F/g, '')
    .trim();

  const map = {
    '1⃣':'1️⃣','1':'1️⃣',
    '2⃣':'2️⃣','2':'2️⃣',
    '3⃣':'3️⃣','3':'3️⃣',
    '4⃣':'4️⃣','4':'4️⃣',
    '5⃣':'5️⃣','5':'5️⃣',
    '6⃣':'6️⃣','6':'6️⃣',
    '7⃣':'7️⃣','7':'7️⃣',
    '8⃣':'8️⃣','8':'8️⃣',
    '9⃣':'9️⃣','9':'9️⃣',
    '🔟':'🔟','10':'🔟',
    '👍':'👍','🚫':'🚫'
  };
  return map[x] || x;
}
function hash(v) {
  return crypto.createHash('sha256').update(String(v)).digest('hex');
}
function dedupKey(payload) {
  const stable = [
    payload.typeWebhook || '',
    payload.idMessage || '',
    payload.timestamp || '',
    payload.senderData?.chatId || '',
    payload.senderData?.sender || '',
    payload.messageData?.typeMessage || '',
    payload.messageData?.quotedMessage?.stanzaId || '',
    payload.messageData?.extendedTextMessageData?.text || ''
  ].join('|');
  return hash(stable);
}
function getQuotedId(payload) {
  const m = payload.messageData || {};
  return m.extendedTextMessageData?.stanzaId
    || m.quotedMessage?.stanzaId
    || m.fileMessageData?.quotedMessage?.stanzaId
    || '';
}
function getReactionTarget(payload) {
  return payload.messageData?.quotedMessage?.stanzaId || '';
}
function getReaction(payload) {
  return normalizeReaction(payload.messageData?.extendedTextMessageData?.text || '');
}
function getText(payload) {
  const m = payload.messageData || {};
  return m.textMessageData?.textMessage
    || m.extendedTextMessageData?.text
    || m.fileMessageData?.caption
    || m.imageMessageData?.caption
    || m.videoMessageData?.caption
    || m.documentMessageData?.caption
    || payload.body
    || payload.caption
    || payload.text
    || '';
}
module.exports = { REACTIONS, normalizePhone, normalizeReaction, hash, dedupKey, getQuotedId, getReactionTarget, getReaction, getText };

