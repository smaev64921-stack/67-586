/**
 * Российские сети: по ним решаем, показывать ли вход через Google.
 *
 * Решение владельца (18.11.2026): вход через Google есть только у тех, кто
 * зашёл с VPN. Сайт видит адрес, с которого пришёл запрос. Российский —
 * VPN выключен (или настроен пускать российские сайты напрямую), и кнопки
 * нет. Заграничный — VPN включён или человек и правда за границей, и кнопка
 * есть.
 *
 * Список сетей России — открытая статистика RIPE NCC (RIPEstat,
 * country-resource-list): какие блоки адресов выданы российским
 * организациям. Обновляем раз в неделю. Копия лежит в томе данных, чтобы
 * после перезапуска не ждать сети. Списка нет вовсе — ответ «не знаем»,
 * и кнопку не показываем: «только с VPN» важнее, чем «всегда с кнопкой».
 */
const fs = require('fs');
const path = require('path');
const net = require('net');
const { DATA_DIR } = require('./db');

const FILE = path.join(DATA_DIR, 'ru-nets.json');
const SOURCE = 'https://stat.ripe.net/data/country-resource-list/data.json?resource=RU&v4_format=prefix';
const REFRESH_MS = 7 * 24 * 3600 * 1000;
const RETRY_MS = 15 * 60 * 1000;

let v4 = null;        // [[начало, конец], ...] по возрастанию, числа
let v6 = null;        // то же для IPv6, BigInt
let fetchedAt = 0;    // когда список взят у RIPE
let loading = null;
let nextTryAt = 0;

function ip4ToNum(ip) {
  const p = String(ip).split('.');
  if (p.length !== 4) return null;
  let n = 0;
  for (const s of p) {
    const b = Number(s);
    if (!Number.isInteger(b) || b < 0 || b > 255) return null;
    n = n * 256 + b;
  }
  return n;
}

function ip6ToBig(ip) {
  let s = String(ip).toLowerCase();
  const zone = s.indexOf('%');
  if (zone >= 0) s = s.slice(0, zone);
  /* хвост вида ::ffff:1.2.3.4 — последние 32 бита записаны как IPv4 */
  const m = /^(.*:)(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (m) {
    const n = ip4ToNum(m[2]);
    if (n == null) return null;
    s = m[1] + ((n >>> 16) & 0xffff).toString(16) + ':' + (n & 0xffff).toString(16);
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const fill = 8 - head.length - tail.length;
  if (halves.length === 1 ? fill !== 0 : fill < 1) return null;
  const parts = head.concat(Array(halves.length === 2 ? fill : 0).fill('0'), tail);
  let n = 0n;
  for (const h of parts) {
    if (!/^[0-9a-f]{1,4}$/.test(h)) return null;
    n = (n << 16n) + BigInt(parseInt(h, 16));
  }
  return n;
}

/** Префиксы RIPE → отсортированные и слитые диапазоны. */
function buildRanges(prefixes, v6mode) {
  const out = [];
  for (const raw of prefixes || []) {
    const str = String(raw).trim();
    /* RIPEstat иногда отдаёт диапазон «a-b» вместо префикса */
    const dash = str.indexOf('-');
    if (dash > 0 && !v6mode) {
      const a = ip4ToNum(str.slice(0, dash).trim());
      const b = ip4ToNum(str.slice(dash + 1).trim());
      if (a != null && b != null && a <= b) out.push([a, b]);
      continue;
    }
    const [addr, lenStr] = str.split('/');
    const len = Number(lenStr);
    if (v6mode) {
      const base = ip6ToBig(addr);
      if (base == null || !Number.isInteger(len) || len < 0 || len > 128) continue;
      const size = 1n << BigInt(128 - len);
      const start = base - (base % size);
      out.push([start, start + size - 1n]);
    } else {
      const base = ip4ToNum(addr);
      if (base == null || !Number.isInteger(len) || len < 0 || len > 32) continue;
      const size = 2 ** (32 - len);
      const start = base - (base % size);
      out.push([start, start + size - 1]);
    }
  }
  out.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const merged = [];
  for (const r of out) {
    const last = merged[merged.length - 1];
    const one = v6mode ? 1n : 1;
    if (last && r[0] <= last[1] + one) {
      if (r[1] > last[1]) last[1] = r[1];
    } else {
      merged.push([r[0], r[1]]);
    }
  }
  return merged;
}

function inRanges(list, x) {
  let lo = 0;
  let hi = list.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const r = list[mid];
    if (x < r[0]) hi = mid - 1;
    else if (x > r[1]) lo = mid + 1;
    else return true;
  }
  return false;
}

function apply(resources, at) {
  const r4 = buildRanges(resources && resources.ipv4, false);
  const r6 = buildRanges(resources && resources.ipv6, true);
  /* Россия — это тысячи блоков. Пустой или крошечный ответ — сбой RIPE,
     а не правда: им нельзя затирать рабочий список. */
  if (r4.length < 1000) throw new Error('RIPE вернул подозрительно короткий список: ' + r4.length);
  v4 = r4;
  v6 = r6;
  fetchedAt = at;
}

function loadFromDisk() {
  try {
    const d = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    apply(d.resources, +d.fetchedAt || 0);
    return true;
  } catch (_) {
    return false;
  }
}

async function refresh() {
  if (loading) return loading;
  loading = (async () => {
    try {
      const r = await fetch(SOURCE, { signal: AbortSignal.timeout(30000) });
      if (!r.ok) throw new Error('RIPE HTTP ' + r.status);
      const d = await r.json();
      const res = d && d.data && d.data.resources;
      const at = Date.now();
      apply(res, at);
      try {
        fs.mkdirSync(DATA_DIR, { recursive: true });
        fs.writeFileSync(FILE, JSON.stringify({
          fetchedAt: at,
          resources: { ipv4: res.ipv4, ipv6: res.ipv6 }
        }));
      } catch (e) {
        console.warn('ru-nets: не сохранить копию:', e.message);
      }
      console.log(`ru-nets: сети России обновлены (IPv4 ${v4.length}, IPv6 ${v6.length})`);
    } catch (e) {
      nextTryAt = Date.now() + RETRY_MS;
      console.warn('ru-nets: не обновить список сетей RIPE:', e.message);
    } finally {
      loading = null;
    }
  })();
  return loading;
}

/** Старый или пустой список — тихо подтягиваем свежий, не задерживая ответ. */
function ensureFresh() {
  if (!v4) loadFromDisk();
  const stale = !v4 || Date.now() - fetchedAt > REFRESH_MS;
  if (stale && !loading && Date.now() >= nextTryAt) refresh();
}

function normalizeIp(ip) {
  let s = String(ip || '').trim();
  if (/^\[.*\]$/.test(s)) s = s.slice(1, -1);
  if (/^::ffff:\d+\.\d+\.\d+\.\d+$/i.test(s)) s = s.slice(7);
  return s;
}

function isPrivate(ip) {
  return /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|0\.)/.test(ip) ||
    ip === '::1' || /^f[cd][0-9a-f]{2}:/i.test(ip) || /^fe80:/i.test(ip);
}

/**
 * Российский ли адрес.
 * @returns {true|false|null} null — не знаем (списка нет, адрес локальный
 *   или не разобрать)
 */
function isRussianIp(rawIp) {
  ensureFresh();
  const ip = normalizeIp(rawIp);
  if (!ip || isPrivate(ip)) return null;
  const kind = net.isIP(ip);
  if (kind === 4) {
    if (!v4) return null;
    const n = ip4ToNum(ip);
    return n == null ? null : inRanges(v4, n);
  }
  if (kind === 6) {
    if (!v6) return null;
    const n = ip6ToBig(ip);
    return n == null ? null : inRanges(v6, n);
  }
  return null;
}

function status() {
  return {
    ready: !!v4,
    fetchedAt: fetchedAt ? new Date(fetchedAt).toISOString() : '',
    v4: v4 ? v4.length : 0,
    v6: v6 ? v6.length : 0
  };
}

/* Список нужен до первого посетителя: берём с диска, а если его нет или он
   устарел — у RIPE, в фоне. */
function warmUp() {
  ensureFresh();
}

module.exports = { isRussianIp, status, warmUp, refresh, _test: { ip4ToNum, ip6ToBig, buildRanges } };
