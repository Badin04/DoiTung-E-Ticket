'use strict';
// QR payload is 46 ASCII bytes: DT<24 hex>|YYMMDDHHmmss|YYMMDD
// The dates are a convenient embedded copy. Server database is the authority.
const TOKEN_RE = /^DT[A-F0-9]{24}$/;
const QR_RE = /^(DT[A-F0-9]{24})\|(\d{12})\|(\d{6})$/;
function bangkokParts(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) throw new Error('Invalid purchase timestamp');
  const fields = new Intl.DateTimeFormat('en-GB', {
    timeZone:'Asia/Bangkok', year:'numeric', month:'2-digit', day:'2-digit',
    hour:'2-digit', minute:'2-digit', second:'2-digit', hourCycle:'h23',
  }).formatToParts(date);
  const parts = Object.fromEntries(fields.filter(p=>p.type!=='literal').map(p=>[p.type,p.value]));
  return {
    purchaseDate: `${parts.year}-${parts.month}-${parts.day}`,
    purchaseTime: `${parts.hour}:${parts.minute}:${parts.second}`,
    compactPurchase: `${parts.year.slice(-2)}${parts.month}${parts.day}${parts.hour}${parts.minute}${parts.second}`,
  };
}
function ticketQrText(token, paidAt, visitDate) {
  if (!TOKEN_RE.test(token) || !/^20\d{2}-\d{2}-\d{2}$/.test(visitDate)) throw new Error('Invalid QR ticket data');
  const text = `${token}|${bangkokParts(paidAt).compactPurchase}|${visitDate.slice(2).replaceAll('-','')}`;
  if (Buffer.byteLength(text,'utf8') > 53) throw new Error('QR payload overflow');
  return text;
}
function parseTicketQr(input) {
  const raw = String(input || '').trim().toUpperCase();
  if (TOKEN_RE.test(raw)) return {token:raw, compactPurchase:null, compactVisit:null, legacy:true};
  const m=raw.match(QR_RE);
  if (!m) return null;
  return {token:m[1],compactPurchase:m[2],compactVisit:m[3],legacy:false};
}
function matchesTicketRecord(parsed, paidAt, visitDate) {
  if (parsed.legacy) return true;
  return parsed.compactPurchase===bangkokParts(paidAt).compactPurchase &&
    parsed.compactVisit===visitDate.slice(2).replaceAll('-','');
}
module.exports = {bangkokParts,ticketQrText,parseTicketQr,matchesTicketRecord};
