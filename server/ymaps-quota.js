/**
 * Суточная квота Яндекс Карт.
 *
 * Бесплатный тариф JavaScript API — 100 загрузок API в сутки (сутки по
 * Москве). За регулярное превышение Яндекс блокирует ключ без права
 * восстановления, и тогда карты Яндекса на сайте не будет уже никогда.
 * Поэтому считаем загрузки сами: витрина спрашивает «можно?» перед тем,
 * как поднять API, и после YMAPS_DAILY_LIMIT загрузок (по умолчанию 90 —
 * запас на проверку ключа в админке и открытые параллельно вкладки)
 * получает «нет» и до конца суток рисует OpenStreetMap.
 *
 * Счётчик лежит в томе данных: перезапуск при выкатке не обнуляет сутки,
 * иначе в день выкатки можно было бы незаметно уйти за лимит.
 */
const fs = require('fs');
const path = require('path');
const { DATA_DIR } = require('./db');

const FILE = path.join(DATA_DIR, 'ymaps-quota.json');

function limit() {
  const n = parseInt(process.env.YMAPS_DAILY_LIMIT, 10);
  return Number.isFinite(n) && n >= 0 ? n : 90;
}

/** Сутки по Москве (UTC+3, без перехода на летнее время). */
function today() {
  return new Date(Date.now() + 3 * 3600 * 1000).toISOString().slice(0, 10);
}

let state = null;

function load() {
  if (state) return state;
  try {
    state = JSON.parse(fs.readFileSync(FILE, 'utf8')) || {};
  } catch (_) {
    state = {};
  }
  return state;
}

function save() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify(state));
  } catch (_) {
    /* не записалось — счёт живёт в памяти до перезапуска, это лучше, чем ничего */
  }
}

/** Взять одну загрузку на сегодня. ok:false — лимит выбран, рисуем OpenStreetMap. */
function take() {
  const s = load();
  const day = today();
  if (s.day !== day) {
    s.day = day;
    s.used = 0;
  }
  const max = limit();
  if ((s.used || 0) >= max) return { ok: false, used: s.used || 0, limit: max };
  s.used = (s.used || 0) + 1;
  save();
  return { ok: true, used: s.used, limit: max };
}

/** Сколько загрузок ушло сегодня — для админки и отладки. */
function stats() {
  const s = load();
  return { used: s.day === today() ? (s.used || 0) : 0, limit: limit() };
}

module.exports = { take, stats, FILE };
