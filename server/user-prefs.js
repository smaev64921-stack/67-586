/**
 * Личные мелочи покупателя, общие для всех его устройств.
 *
 * Товары, заказы и сами отзывы и так лежат на сервере. А корзина,
 * избранное, выбранный пункт выдачи и отметки «отзыв полезен» жили
 * только в localStorage — то есть у каждого устройства свои. Человек
 * складывал корзину на телефоне, открывал сайт на компьютере — пусто.
 *
 * Храним одной строкой JSON на пользователя: набор мелкий, меняется
 * часто, отдельные таблицы под него городить незачем.
 */
const { db } = require('./db');

db.exec(`
  CREATE TABLE IF NOT EXISTS user_prefs (
    user_id    INTEGER PRIMARY KEY,
    data_json  TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

/* Потолок на всякий случай: корзина покупателя — это десятки позиций,
   а не мегабайты. Без него один кривой клиент раздует базу. */
const MAX_BYTES = 64 * 1024;
const MAX_LIST = 300;

function clampList(v) {
  return Array.isArray(v) ? v.slice(0, MAX_LIST) : [];
}

/** Пускаем только знакомые поля — клиент не должен класть сюда что попало. */
function sanitize(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const out = {
    cart: clampList(src.cart),
    favs: clampList(src.favs),
    rvVotes: clampList(src.rvVotes),
    pvz: src.pvz && typeof src.pvz === 'object' ? src.pvz : null,
    defaultPvz: src.defaultPvz && typeof src.defaultPvz === 'object' ? src.defaultPvz : null
  };
  const text = JSON.stringify(out);
  if (text.length > MAX_BYTES) {
    throw Object.assign(new Error('Слишком много данных'), { status: 413 });
  }
  return { out, text };
}

function getPrefs(userId) {
  const row = db.prepare('SELECT data_json FROM user_prefs WHERE user_id = ?').get(userId);
  if (!row) return { cart: [], favs: [], rvVotes: [], pvz: null, defaultPvz: null };
  try {
    return sanitize(JSON.parse(row.data_json)).out;
  } catch (_) {
    return { cart: [], favs: [], rvVotes: [], pvz: null, defaultPvz: null };
  }
}

function savePrefs(userId, raw) {
  const { out, text } = sanitize(raw);
  db.prepare(`
    INSERT INTO user_prefs (user_id, data_json, updated_at)
    VALUES (?, ?, datetime('now'))
    ON CONFLICT(user_id) DO UPDATE SET data_json = excluded.data_json, updated_at = datetime('now')
  `).run(userId, text);
  return out;
}

module.exports = { getPrefs, savePrefs };
