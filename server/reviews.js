const { db } = require('./db');
const { getProduct } = require('./products');
const rev = require('./rev');

/* Отпечаток отзывов в /api/live-version читает только колонки, лежащие ДО
   photos_json: всё, что после, SQLite достаёт через страницы с base64-фото.
   Поэтому фото и прочие «поздние» поля отслеживаются счётчиком. */
function bumpReviews() {
  return rev.bump('reviews');
}

function migrateReviews() {
  const cols = [
    ['sku', "TEXT NOT NULL DEFAULT ''"],
    ['user_id', 'INTEGER'],
    ['size', "TEXT NOT NULL DEFAULT ''"],
    ['fit', 'INTEGER NOT NULL DEFAULT 0'],
    ['photos_json', "TEXT NOT NULL DEFAULT '[]'"],
    ['useful', 'INTEGER NOT NULL DEFAULT 0'],
    ['verified', 'INTEGER NOT NULL DEFAULT 0'],
    ['reply_text', "TEXT NOT NULL DEFAULT ''"],
    ['reply_date', "TEXT NOT NULL DEFAULT ''"]
  ];
  for (const [name, def] of cols) {
    try { db.exec(`ALTER TABLE reviews ADD COLUMN ${name} ${def}`); } catch (_) {}
  }
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS review_votes (
        review_id INTEGER NOT NULL,
        user_id INTEGER NOT NULL,
        PRIMARY KEY (review_id, user_id)
      )
    `);
  } catch (_) {}
}

migrateReviews();

function parsePhotos(raw) {
  let arr = [];
  try { arr = JSON.parse(raw || '[]'); } catch (_) {}
  if (!Array.isArray(arr)) return [];
  return arr
    .map((x) => String(x || '').trim())
    .filter((x) => /^data:image\//i.test(x) || /^https?:\/\//i.test(x))
    .slice(0, 3);
}

function rowToReview(row, { user = null, admin = false } = {}) {
  if (!row) return null;
  const ts = Date.parse(String(row.created_at || '').replace(' ', 'T') + 'Z') || Date.now();
  const email = String(row.user_email || '').trim();
  const mine = !!(user && (
    (+row.user_id && +user.id === +row.user_id) ||
    (email && user.email && email.toLowerCase() === String(user.email).toLowerCase())
  ));
  const voted = !!(user && db.prepare(
    'SELECT 1 FROM review_votes WHERE review_id = ? AND user_id = ?'
  ).get(row.id, user.id));
  const replyText = String(row.reply_text || '').trim();
  return {
    id: row.id,
    pid: row.product_id,
    sku: String(row.sku || '').trim(),
    rating: Math.min(5, Math.max(1, +row.rating || 5)),
    fit: +row.fit || 0,
    size: String(row.size || '').trim(),
    name: String(row.author || 'Покупатель').trim() || 'Покупатель',
    email: admin ? email : '',
    text: String(row.text || ''),
    photos: parsePhotos(row.photos_json),
    ts,
    useful: Math.max(0, +row.useful || 0),
    verified: !!row.verified,
    status: String(row.status || 'ok'),
    reply: replyText ? { text: replyText, date: String(row.reply_date || '').trim() } : null,
    mine,
    voted,
    userId: admin ? (row.user_id || null) : undefined
  };
}

function userBoughtProduct(user, productId) {
  if (!user) return false;
  const rows = db.prepare(`
    SELECT items_json FROM orders
    WHERE status NOT IN ('Отменён', 'Возврат')
      AND pay_status IN ('paid', 'manual')
      AND (user_id = ? OR (? != '' AND lower(email) = lower(?)))
  `).all(user.id, String(user.email || '').trim(), String(user.email || '').trim());
  const pid = +productId;
  for (const row of rows) {
    let items = [];
    try { items = JSON.parse(row.items_json || '[]'); } catch (_) {}
    if ((items || []).some((i) => +i.id === pid)) return true;
  }
  return false;
}

function listReviews(user, { admin = false, productId = null } = {}) {
  const rows = productId
    ? db.prepare('SELECT * FROM reviews WHERE product_id = ? ORDER BY id DESC').all(+productId)
    : db.prepare('SELECT * FROM reviews ORDER BY id DESC').all();
  return rows
    .map((r) => rowToReview(r, { user, admin }))
    .filter((r) => r && (admin || r.status === 'ok' || r.mine));
}

function getReview(id) {
  return db.prepare('SELECT * FROM reviews WHERE id = ?').get(+id);
}

function createReview(user, body) {
  if (!user) throw Object.assign(new Error('Войдите, чтобы оставить отзыв'), { status: 401 });
  const productId = +body.productId || +body.pid;
  const p = getProduct(productId);
  if (!p) throw Object.assign(new Error('Товар не найден'), { status: 404 });
  const sku = String(p.sku || '').trim();
  if (!sku) throw Object.assign(new Error('Не удалось привязать отзыв к товару'), { status: 400 });

  const rating = Math.min(5, Math.max(1, +body.rating || 0));
  if (!rating) throw Object.assign(new Error('Поставьте оценку'), { status: 400 });
  const text = String(body.text || '').trim();
  if (text.length < 15) {
    throw Object.assign(new Error('Расскажите чуть подробнее — минимум 15 символов'), { status: 400 });
  }
  if (text.length > 900) throw Object.assign(new Error('Отзыв слишком длинный'), { status: 400 });

  let cms = { reviews: { moderate: false, buyersOnly: true } };
  try { cms = require('./orders').getCms() || cms; } catch (_) {}
  const cfg = (cms && cms.reviews) || {};
  const buyersOnly = cfg.buyersOnly !== false;
  const bought = userBoughtProduct(user, productId);
  if (buyersOnly && !bought) {
    throw Object.assign(new Error('Отзыв можно оставить после заказа этого товара'), { status: 403 });
  }

  const dup = db.prepare(
    'SELECT id FROM reviews WHERE product_id = ? AND user_id = ?'
  ).get(productId, user.id);
  if (dup) throw Object.assign(new Error('Вы уже оставили отзыв на этот товар'), { status: 409 });

  const photos = parsePhotos(JSON.stringify(body.photos || []));
  const tooBig = photos.some((ph) => ph.length > 2.5e6);
  if (tooBig) throw Object.assign(new Error('Фото слишком тяжёлое — попробуйте другое'), { status: 400 });

  const name = String(body.name || '').trim()
    || [user.name, user.last_name || user.last].filter(Boolean).join(' ').trim()
    || 'Покупатель';
  const status = cfg.moderate ? 'new' : 'ok';
  const info = db.prepare(`
    INSERT INTO reviews (
      product_id, sku, user_id, user_email, author, rating, text, size, fit,
      photos_json, useful, verified, status, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, datetime('now'))
  `).run(
    productId,
    sku,
    user.id,
    String(user.email || '').trim(),
    name.slice(0, 40),
    rating,
    text,
    String(body.size || '').trim().slice(0, 12),
    Math.min(1, Math.max(-1, +body.fit || 0)),
    JSON.stringify(photos),
    bought ? 1 : 0,
    status
  );
  bumpReviews();
  return rowToReview(getReview(info.lastInsertRowid), { user, admin: false });
}

function voteReview(user, id) {
  if (!user) throw Object.assign(new Error('Войдите, чтобы оценить отзыв'), { status: 401 });
  const row = getReview(id);
  if (!row) throw Object.assign(new Error('Отзыв не найден'), { status: 404 });
  if (+row.user_id === +user.id) {
    throw Object.assign(new Error('Это ваш отзыв'), { status: 400 });
  }
  const had = db.prepare(
    'SELECT 1 FROM review_votes WHERE review_id = ? AND user_id = ?'
  ).get(row.id, user.id);
  if (had) {
    db.prepare('DELETE FROM review_votes WHERE review_id = ? AND user_id = ?').run(row.id, user.id);
    db.prepare('UPDATE reviews SET useful = MAX(0, useful - 1) WHERE id = ?').run(row.id);
  } else {
    db.prepare('INSERT INTO review_votes (review_id, user_id) VALUES (?, ?)').run(row.id, user.id);
    db.prepare('UPDATE reviews SET useful = useful + 1 WHERE id = ?').run(row.id);
  }
  bumpReviews();
  return rowToReview(getReview(row.id), { user });
}

function deleteReview(user, id, { admin = false } = {}) {
  const row = getReview(id);
  if (!row) throw Object.assign(new Error('Отзыв не найден'), { status: 404 });
  const mine = user && +row.user_id === +user.id;
  if (!admin && !mine) throw Object.assign(new Error('Нет доступа'), { status: 403 });
  db.prepare('DELETE FROM review_votes WHERE review_id = ?').run(row.id);
  db.prepare('DELETE FROM reviews WHERE id = ?').run(row.id);
  bumpReviews();
  return true;
}

function updateReviewAdmin(id, patch) {
  const row = getReview(id);
  if (!row) throw Object.assign(new Error('Отзыв не найден'), { status: 404 });
  let status = row.status;
  if (patch.status != null) {
    const s = String(patch.status);
    if (['ok', 'new', 'hide'].includes(s)) status = s;
  }
  let replyText = row.reply_text;
  let replyDate = row.reply_date;
  if (patch.reply !== undefined) {
    const t = patch.reply && String(patch.reply.text || patch.reply || '').trim();
    replyText = t || '';
    replyDate = t ? String(patch.reply.date || '').trim() : '';
  }
  db.prepare(`
    UPDATE reviews SET status = ?, reply_text = ?, reply_date = ? WHERE id = ?
  `).run(status, replyText, replyDate, row.id);
  bumpReviews();
  return rowToReview(getReview(row.id), { admin: true });
}

module.exports = {
  listReviews,
  createReview,
  voteReview,
  deleteReview,
  updateReviewAdmin,
  getReview,
  rowToReview
};
