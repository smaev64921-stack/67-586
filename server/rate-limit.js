/**
 * Анти-брут кодов 0000–9999: лимиты по IP и телефону.
 */
const buckets = new Map();

function key(parts) {
  return parts.map((p) => String(p || '')).join('|');
}

function prune(now) {
  if (buckets.size < 2000) return;
  for (const [k, v] of buckets) {
    if (!v || now > (v.resetAt || 0)) buckets.delete(k);
  }
}

/**
 * @returns {{ ok: true, left: number } | { ok: false, waitSec: number, error: string }}
 */
function hit(scope, id, { limit = 10, windowMs = 15 * 60 * 1000, label = 'Слишком много попыток' } = {}) {
  const now = Date.now();
  prune(now);
  const k = key([scope, id]);
  let row = buckets.get(k);
  if (!row || now > row.resetAt) {
    row = { count: 0, resetAt: now + windowMs };
    buckets.set(k, row);
  }
  row.count += 1;
  if (row.count > limit) {
    const waitSec = Math.max(1, Math.ceil((row.resetAt - now) / 1000));
    return {
      ok: false,
      waitSec,
      error: `${label}. Подождите ${waitSec} с`
    };
  }
  return { ok: true, left: Math.max(0, limit - row.count) };
}

/**
 * Адрес клиента для лимитов.
 *
 * Раньше брали ПЕРВЫЙ адрес из X-Forwarded-For — а его пишет сам клиент.
 * Подставил новый адрес в каждый запрос — и каждый запрос шёл с чистым
 * счётчиком: перебор кодов входа, рассылка SMS за счёт магазина, подбор
 * паролей шли без ограничений.
 *
 * Прокси хостинга ДОПИСЫВАЕТ настоящий адрес в конец цепочки, и подделать
 * этот последний адрес клиент не может — всё, что он прислал, остаётся
 * левее. Поэтому берём последний.
 */
function clientIp(req) {
  const chain = String((req && req.headers && req.headers['x-forwarded-for']) || '')
    .split(',').map((x) => x.trim()).filter(Boolean);
  const last = chain.length ? chain[chain.length - 1] : '';
  return last || (req && req.socket && req.socket.remoteAddress) || (req && req.ip) || 'unknown';
}

module.exports = { hit, clientIp };
