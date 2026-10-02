/**
 * Разовая замена фото товаров партией из репозитория.
 *
 * Зачем. Фото товаров лежат в БД строками base64, и поменять их можно только
 * через админку — то есть руками владельца. Когда снимков много и все они
 * уже подготовлены (перерезаны, перекрашены), удобнее положить файлы в
 * server/photo-swap/<партия>/ и дать серверу заменить их при запуске.
 *
 * Как устроено. Файл называется <id товара>-<хеш>.<ext>, где хеш — тот, что
 * стоит в адресе /media/p/<id>/<хеш> у снимка, который этот файл заменяет
 * (media.hashOf исходной data-строки). Меняем только снимок, который в базе
 * ровно тот же, что был при подготовке: владелец успел поставить другое
 * фото — его не трогаем и пишем об этом в лог. Перед первой заменой — копия
 * базы (backupSqlite). Партия отмечается в meta и второй раз не запускается,
 * даже если владелец потом вернёт прежний снимок руками.
 *
 * Слайды главной хранятся в CMS ссылками на файлы /home/…: их меняет
 * cms.json партии — {"slides": {"старый адрес": "новый адрес"}}.
 *
 * Откат. В <партия>/was/ лежат прежние снимки под именами <id>-<новый хеш>:
 * скопировать их в новую папку-партию — и они вернутся тем же путём (для
 * слайдов — cms.json с обратными парами; прежние файлы в public/home/ целы).
 *
 * Партии:
 *   2026-10-03-jeans — снимки, где сильно видно джинсы, перерезаны так, что
 *   под футболкой осталась узкая полоска (тот же кадр и цвет, резались из
 *   полноразмерных исходников): 15 фото товаров и пять слайдов главной
 *   (/home/hero-0N.webp → /home/hero-1N.webp).
 */
const fs = require('fs');
const path = require('path');
const { db } = require('./db');
const rev = require('./rev');            /* заодно создаёт таблицу meta */
const media = require('./media');

const DIR = path.join(__dirname, 'photo-swap');
const MIME = { jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', png: 'image/png' };
const RE_FILE = /^(\d+)-([0-9a-f]{16})\.(jpe?g|webp|png)$/i;

function runBatch(name) {
  const key = 'photo-swap:' + name;
  if (db.prepare('SELECT v FROM meta WHERE k = ?').get(key)) return null;
  const dir = path.join(DIR, name);
  const byProduct = new Map();
  for (const f of fs.readdirSync(dir)) {
    const m = RE_FILE.exec(f);
    if (!m) continue;
    const id = +m[1];
    if (!byProduct.has(id)) byProduct.set(id, []);
    byProduct.get(id).push({ file: f, old: m[2].toLowerCase(), mime: MIME[m[3].toLowerCase()] });
  }

  const get = db.prepare('SELECT img, gal_json FROM products WHERE id = ?');
  const put = db.prepare(`UPDATE products SET img = ?, gal_json = ?, updated_at = datetime('now') WHERE id = ?`);
  const report = { swapped: [], skipped: [] };
  let backedUp = false;

  for (const [id, list] of byProduct) {
    const row = get.get(id);
    if (!row) { list.forEach((x) => report.skipped.push(`${x.file}: товара нет`)); continue; }
    let img = row.img || '';
    let gal = [];
    try { gal = JSON.parse(row.gal_json || '[]'); } catch (_) {}
    let changed = false;
    for (const x of list) {
      const data = `data:${x.mime};base64,${fs.readFileSync(path.join(dir, x.file)).toString('base64')}`;
      let hit = false;
      gal = gal.map((g) => {
        if (typeof g === 'string' && media.isDataImage(g) && media.hashOf(g) === x.old) { hit = true; return data; }
        return g;
      });
      if (media.isDataImage(img) && media.hashOf(img) === x.old) { img = data; hit = true; }
      if (hit) { changed = true; report.swapped.push(x.file); }
      else report.skipped.push(`${x.file}: в базе уже другое фото`);
    }
    if (!changed) continue;
    if (!backedUp) {
      require('./backup').backupSqlite('photo-swap ' + name);
      backedUp = true;
    }
    put.run(img, JSON.stringify(gal), id);
  }

  if (report.swapped.length) {
    media.invalidateCatalog();
    rev.bump('products');
  }

  /* Слайды главной: адреса картинок лежат в CMS. cms.json партии —
     {"slides": {"старый адрес": "новый адрес"}}; меняем только слайд, у
     которого адрес ровно старый. */
  const cmsFile = path.join(dir, 'cms.json');
  if (fs.existsSync(cmsFile)) {
    const map = (JSON.parse(fs.readFileSync(cmsFile, 'utf8')).slides) || {};
    const row = db.prepare('SELECT data_json FROM cms WHERE id = 1').get();
    let cms = null;
    try { cms = row ? JSON.parse(row.data_json) : null; } catch (_) {}
    if (cms && Array.isArray(cms.slides)) {
      const left = new Set(Object.keys(map));
      let n = 0;
      cms.slides.forEach((s) => {
        if (s && typeof s.img === 'string' && map[s.img]) { left.delete(s.img); s.img = map[s.img]; n++; }
      });
      if (n) {
        if (!backedUp) { require('./backup').backupSqlite('photo-swap ' + name); backedUp = true; }
        db.prepare('UPDATE cms SET data_json = ? WHERE id = 1').run(JSON.stringify(cms));
        media.invalidateCms();
        report.swapped.push(`слайдов: ${n}`);
      }
      left.forEach((u) => report.skipped.push(`слайд ${u}: в CMS его уже нет`));
    } else {
      report.skipped.push('cms.json: в CMS нет слайдов');
    }
  }
  db.prepare(`INSERT INTO meta (k, v) VALUES (?, ?)
    ON CONFLICT(k) DO UPDATE SET v = excluded.v`)
    .run(key, JSON.stringify({ at: new Date().toISOString(), ...report }));
  return report;
}

/** Все партии по порядку имён. Ошибка одной не роняет запуск сервера. */
function runPhotoSwaps() {
  let names = [];
  try {
    names = fs.readdirSync(DIR, { withFileTypes: true })
      .filter((d) => d.isDirectory()).map((d) => d.name).sort();
  } catch (_) { return; }
  for (const name of names) {
    try {
      const r = runBatch(name);
      if (r) console.log(`[PHOTO-SWAP] ${name}: заменено ${r.swapped.length}, пропущено ${r.skipped.length}`
        + (r.skipped.length ? ' — ' + r.skipped.join('; ') : ''));
    } catch (e) {
      console.warn(`[PHOTO-SWAP] ${name}: не вышло —`, e.message);
    }
  }
}

module.exports = { runPhotoSwaps };
