/**
 * Счётчики изменений данных, переживающие перезапуск сервера.
 *
 * Отпечаток /api/live-version не может опираться на сами картинки: они лежат
 * в БД строками base64, и любое обращение к колонкам после них заставляет
 * SQLite протаскивать мегабайты. Поэтому «всё остальное» (фото, описание,
 * цвета, фото отзывов) отслеживается счётчиком: любая запись увеличивает его
 * на единицу.
 *
 * Хранить счётчик только в памяти нельзя. Иначе после перезапуска он снова
 * начинается с нуля, и открытая вкладка, запомнившая прежнее значение, может
 * увидеть точно такой же отпечаток при других данных — и никогда не обновит
 * каталог. Поэтому значение лежит в таблице meta.
 */
const { db } = require('./db');

db.exec(`CREATE TABLE IF NOT EXISTS meta (
  k TEXT PRIMARY KEY,
  v TEXT NOT NULL
)`);

const cache = new Map();

function read(key) {
  if (cache.has(key)) return cache.get(key);
  let n = 0;
  try {
    const row = db.prepare('SELECT v FROM meta WHERE k = ?').get('rev:' + key);
    n = row ? +row.v || 0 : 0;
  } catch (_) {}
  cache.set(key, n);
  return n;
}

function bump(key) {
  const next = read(key) + 1;
  cache.set(key, next);
  try {
    db.prepare(`INSERT INTO meta (k, v) VALUES (?, ?)
      ON CONFLICT(k) DO UPDATE SET v = excluded.v`).run('rev:' + key, String(next));
  } catch (e) {
    console.warn('rev bump:', e.message);
  }
  return next;
}

module.exports = { read, bump };
