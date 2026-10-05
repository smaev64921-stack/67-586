/**
 * Адрес Telegram Bot API.
 *
 * С весны 2026 api.telegram.org из России недоступен, поэтому сервер в Москве
 * ходит к Telegram через ретранслятор за границей (server/tg-relay.js):
 *   TELEGRAM_API_BASE=https://<адрес ретранслятора>/tg
 *   TG_RELAY_KEY=<тот же ключ, что у ретранслятора>
 * Без этих переменных — напрямую, как раньше.
 */
const DIRECT = 'https://api.telegram.org';

function base() {
  return String(process.env.TELEGRAM_API_BASE || '').trim().replace(/\/+$/, '') || DIRECT;
}

function viaRelay() {
  return base() !== DIRECT;
}

/* Ключ ретранслятора едет только к ретранслятору, не в Telegram */
function headers(extra = {}) {
  const key = String(process.env.TG_RELAY_KEY || '').trim();
  return viaRelay() && key ? { ...extra, 'x-relay-key': key } : { ...extra };
}

function botUrl(token, method) {
  return `${base()}/bot${token}/${method}`;
}

function fileUrl(token, filePath) {
  return `${base()}/file/bot${token}/${filePath}`;
}

/* «fetch failed» без причины ничего не говорит — добавляем код (таймаут,
   сброс соединения), чтобы в логе было видно, что именно не так */
function netError(e) {
  const code = e && e.cause && (e.cause.code || e.cause.name);
  return code ? Object.assign(new Error(`${e.message} (${code})`), { cause: e.cause }) : e;
}

module.exports = { base, viaRelay, headers, botUrl, fileUrl, netError };
