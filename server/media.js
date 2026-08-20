/**
 * Картинки лежат в БД строками `data:image/...;base64,...` — товары в
 * products.img/gal_json, слайды главной в cms.data_json, фото отзывов в
 * reviews.photos_json.
 *
 * Отдавать их внутри JSON дорого: витрина опрашивает каталог и CMS постоянно,
 * и каждый опрос тянул сотни килобайт одних и тех же байтов, которые браузер
 * не может закэшировать. Поэтому наружу вместо base64 уходит короткая ссылка
 * /media/..., а по ней отдаётся настоящий бинарник с вечным кэшем.
 *
 * Адрес содержит хэш содержимого, поэтому:
 *  — ссылку можно кэшировать immutable: сменилось фото — сменился адрес;
 *  — восстановление при сохранении не зависит от порядка (админ может
 *    переставить слайды местами, ссылка всё равно найдёт своё фото).
 */
const crypto = require('crypto');
const { db } = require('./db');

const RE_DATA = /^data:(image\/[a-z0-9.+-]+);base64,([\s\S]+)$/i;
const RE_MEDIA = /^\/media\/(?:p\/(\d+)|cms|rv\/([A-Za-z0-9_-]+)|o\/([A-Za-z0-9_-]+))\/([0-9a-f]{16})\.[a-z0-9]+$/;

const EXT = {
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/avif': 'avif',
  'image/gif': 'gif',
  'image/svg+xml': 'svg'
};

function isDataImage(s) {
  return typeof s === 'string' && s.length > 32 && RE_DATA.test(s);
}

function isMediaUrl(s) {
  return typeof s === 'string' && RE_MEDIA.test(s);
}

function hashOf(dataUrl) {
  return crypto.createHash('sha1').update(String(dataUrl)).digest('hex').slice(0, 16);
}

function decode(dataUrl) {
  const m = RE_DATA.exec(String(dataUrl || ''));
  if (!m) return null;
  const mime = m[1].toLowerCase();
  const buf = Buffer.from(m[2].replace(/\s+/g, ''), 'base64');
  if (!buf.length) return null;
  return { mime, buf };
}

function urlFor(prefix, dataUrl) {
  const d = decode(dataUrl);
  if (!d) return dataUrl;
  return `${prefix}/${hashOf(dataUrl)}.${EXT[d.mime] || 'bin'}`;
}

/* ---------- обход произвольных структур ---------- */

function mapStrings(node, fn) {
  if (typeof node === 'string') return fn(node);
  if (Array.isArray(node)) return node.map((v) => mapStrings(v, fn));
  if (node && typeof node === 'object') {
    const out = {};
    for (const k of Object.keys(node)) out[k] = mapStrings(node[k], fn);
    return out;
  }
  return node;
}

/** hash → исходная data-строка, по всему поддереву. */
function collectImages(node, out = new Map()) {
  if (typeof node === 'string') {
    if (isDataImage(node)) out.set(hashOf(node), node);
    return out;
  }
  if (Array.isArray(node)) {
    node.forEach((v) => collectImages(v, out));
    return out;
  }
  if (node && typeof node === 'object') {
    Object.keys(node).forEach((k) => collectImages(node[k], out));
    return out;
  }
  return out;
}

/** base64 → ссылки. */
function toUrls(node, prefix) {
  return mapStrings(node, (s) => (isDataImage(s) ? urlFor(prefix, s) : s));
}

/**
 * ссылки → base64, по карте hash → data из того, что уже лежит в БД.
 *
 * Если ссылку разрешить не удалось (снимок страницы устарел: фото успели
 * удалить или заменить из другой вкладки), НЕ сохраняем её как есть — иначе
 * в БД вместо картинки навсегда остался бы путь, отдающий 404. Такие ссылки
 * собираем в lost, а вызывающий решает, что делать.
 */
function restore(node, stored, lost) {
  const byHash = collectImages(stored);
  return mapStrings(node, (s) => {
    const m = RE_MEDIA.exec(s);
    if (!m) return s;
    const hit = byHash.get(m[4]);
    if (hit) return hit;
    if (lost) lost.push(s);
    return s;
  });
}

/* ---------- товары ---------- */

function productToPublic(p) {
  if (!p) return p;
  const out = Object.assign({}, p);
  const prefix = `/media/p/${p.id}`;
  if (isDataImage(out.img)) out.img = urlFor(prefix, out.img);
  if (Array.isArray(out.gal)) {
    out.gal = out.gal.map((g) => (isDataImage(g) ? urlFor(prefix, g) : g));
  }
  return out;
}

function productsToPublic(list) {
  return (list || []).map(productToPublic);
}

/**
 * Публичный каталог с кэшем.
 *
 * SELECT * из products тянет вместе с товарами все base64-фото: на 60 товарах
 * это уже больше сотни мегабайт на КАЖДЫЙ запрос, плюс SHA1 по ним ради
 * адресов. Поэтому готовый (лёгкий, без base64) вид товара кэшируем в памяти,
 * а из БД читаем только те строки, которых в кэше ещё нет. Кэш сбрасывает
 * products.bumpRev() при любой записи, так что устареть он не может.
 */
const catalogCache = new Map();

function invalidateCatalog() {
  catalogCache.clear();
}

function publicCatalog({ all = false } = {}) {
  const ids = db.prepare(
    all
      ? 'SELECT id FROM products ORDER BY id'
      : 'SELECT id FROM products WHERE on_sale = 1 ORDER BY id'
  ).all().map((r) => r.id);

  const missing = ids.filter((id) => !catalogCache.has(id));
  if (missing.length) {
    const { rowToProduct } = require('./products');
    const get = db.prepare('SELECT * FROM products WHERE id = ?');
    for (const id of missing) {
      const row = get.get(id);
      if (!row) continue;
      catalogCache.set(id, productToPublic(rowToProduct(row)));
    }
  }
  return ids.map((id) => catalogCache.get(id)).filter(Boolean);
}

/** Товар пришёл из админки: ссылки на уже сохранённые фото вернуть в base64. */
function restoreProductImages(incoming, lost) {
  if (!incoming || !incoming.id) return incoming;
  const row = db.prepare('SELECT img, gal_json FROM products WHERE id = ?').get(+incoming.id);
  if (!row) return incoming;
  let gal = [];
  try { gal = JSON.parse(row.gal_json || '[]'); } catch (_) {}
  return restore(incoming, [row.img, gal], lost);
}

function findProductImage(id, hash) {
  const row = db.prepare('SELECT img, gal_json FROM products WHERE id = ?').get(+id);
  if (!row) return null;
  const all = [row.img];
  try {
    const gal = JSON.parse(row.gal_json || '[]');
    if (Array.isArray(gal)) all.push(...gal);
  } catch (_) {}
  for (const s of all) {
    if (isDataImage(s) && hashOf(s) === hash) return decode(s);
  }
  return null;
}

/* ---------- CMS ---------- */

function cmsToPublic(cms) {
  return toUrls(cms, '/media/cms');
}

function restoreCmsImages(next, current, lost) {
  return restore(next, current, lost);
}

/* Кэш «хэш → картинка» для CMS: без него каждый запрос кадра со страницы
   «О бренде» перечитывал весь data_json, парсил его и считал SHA1 по всем
   фото — десятки миллисекунд блокирующего CPU на КАЖДУЮ картинку.
   Сбрасывается при сохранении CMS (invalidateCms). */
let cmsImgCache = null;

function invalidateCms() {
  cmsImgCache = null;
}

function findCmsImage(hash, cms) {
  if (!cmsImgCache) cmsImgCache = collectImages(cms);
  let hit = cmsImgCache.get(hash);
  if (!hit) {
    /* мимо кэша — возможно, он собран до правки: пересоберём один раз */
    cmsImgCache = collectImages(cms);
    hit = cmsImgCache.get(hash);
  }
  return hit ? decode(hit) : null;
}

/* ---------- отзывы ---------- */

function reviewToPublic(r) {
  if (!r) return r;
  const out = Object.assign({}, r);
  if (Array.isArray(out.photos)) {
    const prefix = `/media/rv/${encodeURIComponent(String(out.id))}`;
    out.photos = out.photos.map((s) => (isDataImage(s) ? urlFor(prefix, s) : s));
  }
  return out;
}

function reviewsToPublic(list) {
  return (list || []).map(reviewToPublic);
}

function findReviewImage(id, hash) {
  let row = null;
  try {
    row = db.prepare('SELECT photos_json FROM reviews WHERE id = ?').get(id);
  } catch (_) {}
  if (!row) return null;
  let photos = [];
  try { photos = JSON.parse(row.photos_json || '[]'); } catch (_) {}
  for (const s of photos) {
    if (isDataImage(s) && hashOf(s) === hash) return decode(s);
  }
  return null;
}

/* ---------- заказы ----------
   В заказе лежит СНИМОК фото товара на момент покупки: карточку потом могут
   отредактировать или удалить, а история заказа должна остаться прежней.
   Поэтому ссылку строим от номера заказа, а не от товара. */

function orderToPublic(o) {
  if (!o || !Array.isArray(o.items)) return o;
  const prefix = `/media/o/${encodeURIComponent(String(o.num))}`;
  return Object.assign({}, o, {
    items: o.items.map((it) => (it && isDataImage(it.img)
      ? Object.assign({}, it, { img: urlFor(prefix, it.img) })
      : it))
  });
}

function ordersToPublic(list) {
  return (list || []).map(orderToPublic);
}

function findOrderImage(num, hash) {
  let row = null;
  try {
    row = db.prepare('SELECT items_json FROM orders WHERE num = ?').get(String(num));
  } catch (_) {}
  if (!row) return null;
  let items = [];
  try { items = JSON.parse(row.items_json || '[]'); } catch (_) {}
  for (const it of items) {
    const src = it && it.img;
    if (isDataImage(src) && hashOf(src) === hash) return decode(src);
  }
  return null;
}

/**
 * Обратное преобразование: ссылка /media/... → исходная data:-строка.
 *
 * Нужно там, где картинку требуется отдать целиком, а не показать в браузере
 * (примерка шлёт фото вещи во внешний сервис — относительный путь ему
 * недоступен). Возвращает исходную строку, если это не наша ссылка.
 */
function resolveMediaUrl(value) {
  const s = String(value || '');
  const m = RE_MEDIA.exec(s);
  if (!m) return s;
  const [, productId, reviewId, orderNum, hash] = m;
  let found = null;
  if (productId) found = findProductImage(productId, hash);
  else if (reviewId) found = findReviewImage(reviewId, hash);
  else if (orderNum) found = findOrderImage(orderNum, hash);
  else {
    try {
      const { getCms } = require('./orders');
      found = findCmsImage(hash, getCms() || {});
    } catch (_) {}
  }
  if (!found) return s;
  return `data:${found.mime};base64,${found.buf.toString('base64')}`;
}

module.exports = {
  resolveMediaUrl,
  invalidateCms,
  publicCatalog,
  invalidateCatalog,
  orderToPublic,
  ordersToPublic,
  findOrderImage,
  isDataImage,
  isMediaUrl,
  hashOf,
  decode,
  productToPublic,
  productsToPublic,
  restoreProductImages,
  findProductImage,
  cmsToPublic,
  restoreCmsImages,
  findCmsImage,
  reviewToPublic,
  reviewsToPublic,
  findReviewImage,
  RE_MEDIA
};
