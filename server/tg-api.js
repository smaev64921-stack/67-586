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

/* Адрес без https:// (легко вставить из панели хостинга без схемы) fetch не
   разбирает и выдаёт ошибку с полным адресом — вместе с токеном бота. Такой
   адрес не берём, пишем об этом один раз и без токена. http — только для
   проверок на своём компьютере. */
let warnedBase = false;
function base() {
  const raw = String(process.env.TELEGRAM_API_BASE || '').trim().replace(/\/+$/, '');
  if (!raw) return DIRECT;
  try {
    const u = new URL(raw);
    const local = /^(localhost|127\.0\.0\.1|\[::1\])$/i.test(u.hostname);
    if (u.protocol === 'https:' || (u.protocol === 'http:' && local)) return raw;
  } catch (_) {}
  if (!warnedBase) {
    warnedBase = true;
    console.warn('TELEGRAM_API_BASE не похож на https://<адрес ретранслятора>/tg — хожу в Telegram напрямую');
  }
  return DIRECT;
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

/* Сколько ждать ответа: getUpdates держит соединение до 25 с, файлы — дольше.
   Без предела зависшее соединение Москва → ретранслятор держало бы бота
   глухим минутами. */
function timeout(method) {
  if (method === 'getUpdates') return AbortSignal.timeout(45 * 1000);
  if (method === 'sendDocument' || method === 'file') return AbortSignal.timeout(120 * 1000);
  return AbortSignal.timeout(20 * 1000);
}

/* «fetch failed» без причины ничего не говорит — добавляем код (таймаут,
   сброс соединения). Токен бота из текста ошибки вырезаем: она уходит в
   журнал и в отчёты об ошибках. */
function redact(s) {
  return String(s).replace(/bot\d+:[A-Za-z0-9_-]+/g, 'bot***');
}
function netError(e) {
  const code = e && (e.name === 'TimeoutError' ? 'таймаут' : e.cause && (e.cause.code || e.cause.name));
  const out = new Error(redact((e && e.message) || e) + (code ? ` (${code})` : ''));
  if (e && e.cause) out.cause = e.cause;
  return out;
}

module.exports = { base, viaRelay, headers, botUrl, fileUrl, timeout, netError, redact };
