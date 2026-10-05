/**
 * Ретранслятор Telegram Bot API для сервера магазина в России.
 *
 * С весны 2026 api.telegram.org из России недоступен: бот молчит, уведомления
 * о заказах не уходят. Этот сервер стоит за границей (Bothost, Нидерланды) и
 * просто передаёт запросы магазина в Telegram и ответы обратно. Магазина и
 * базы здесь нет; ничего не хранится, в журнал пишутся только сбои — без
 * адресов (в них токен бота) и без содержимого (в уведомлениях ПДн).
 *
 * Запуск — тот же репозиторий, переменные:
 *   TG_RELAY_ONLY=1
 *   TG_RELAY_KEY=<длинный случайный ключ, от 32 символов>
 * У магазина: TELEGRAM_API_BASE=https://<адрес этого сервера>/tg и тот же
 * TG_RELAY_KEY. Без ключа в заголовке x-relay-key запрос отклоняется, так
 * что открытым прокси к Telegram сервер не становится.
 */
const http = require('http');
const https = require('https');
const crypto = require('crypto');

const PORT = +process.env.PORT || 3000;
/* для проверок — подставной Telegram; в работе всегда api.telegram.org */
const UPSTREAM = new URL(process.env.TG_RELAY_UPSTREAM || 'https://api.telegram.org');
const PATH_RE = /^\/tg(\/(?:file\/)?bot\d{3,}:[A-Za-z0-9_-]{20,}\/[A-Za-z0-9_\-./]*)(\?[^#\s]*)?$/;
const UPSTREAM_TIMEOUT_MS = 120 * 1000;

function key() {
  const k = String(process.env.TG_RELAY_KEY || '').trim();
  return k.length >= 32 ? k : '';
}

function sameKey(given) {
  const k = key();
  if (!k || typeof given !== 'string') return false;
  const a = Buffer.from(k);
  const b = Buffer.from(given);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/* перебор ключа: после 30 неверных попыток за 10 минут — пауза для адреса */
const fails = new Map();
function clientIp(req) {
  return String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || '';
}
function tooManyFails(ip) {
  const f = fails.get(ip);
  if (!f) return false;
  if (Date.now() - f.at > 10 * 60 * 1000) { fails.delete(ip); return false; }
  return f.n >= 30;
}
function noteFail(ip) {
  const f = fails.get(ip);
  if (!f || Date.now() - f.at > 10 * 60 * 1000) fails.set(ip, { n: 1, at: Date.now() });
  else f.n++;
  if (fails.size > 5000) fails.clear();
}

function reply(res, status, description) {
  if (res.headersSent) return res.destroy();
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify({ ok: false, error_code: status, description }));
}

function handle(req, res) {
  if (req.url === '/' || req.url === '/health') {
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
    return res.end(key() ? 'ok' : 'relay: TG_RELAY_KEY не задан');
  }
  const m = PATH_RE.exec(req.url || '');
  if (!m || m[1].includes('..') || !['GET', 'POST'].includes(req.method)) return reply(res, 404, 'Not Found');
  const ip = clientIp(req);
  if (tooManyFails(ip)) return reply(res, 429, 'relay: слишком много неверных ключей');
  if (!sameKey(req.headers['x-relay-key'])) {
    noteFail(ip);
    return reply(res, 403, 'relay: неверный ключ');
  }

  const headers = {};
  for (const h of ['content-type', 'content-length']) if (req.headers[h]) headers[h] = req.headers[h];
  const lib = UPSTREAM.protocol === 'http:' ? http : https;
  const up = lib.request({
    protocol: UPSTREAM.protocol,
    hostname: UPSTREAM.hostname,
    port: UPSTREAM.port || undefined,
    method: req.method,
    path: m[1] + (m[2] || ''),
    headers,
    timeout: UPSTREAM_TIMEOUT_MS
  }, (ur) => {
    const out = {};
    for (const h of ['content-type', 'content-length', 'content-disposition']) if (ur.headers[h]) out[h] = ur.headers[h];
    res.writeHead(ur.statusCode || 502, out);
    ur.pipe(res);
  });
  up.on('timeout', () => up.destroy(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })));
  up.on('error', (e) => {
    console.warn('relay: Telegram недоступен —', e.code || e.message);
    reply(res, 502, 'relay: Telegram недоступен (' + (e.code || 'error') + ')');
  });
  req.on('aborted', () => up.destroy());
  req.pipe(up);
}

function start() {
  if (!key()) console.warn('relay: TG_RELAY_KEY не задан или короче 32 символов — все запросы будут отклонены');
  const server = http.createServer(handle);
  server.requestTimeout = 0;           // getUpdates держит соединение до 25 с
  server.headersTimeout = 30 * 1000;
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`Telegram relay → ${UPSTREAM.origin}, порт ${PORT}`);
  });
  return server;
}

module.exports = { start, PATH_RE };
