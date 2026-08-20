const { db } = require('./db');

/**
 * Счётчик изменений каталога.
 *
 * Фото лежат в БД строками base64, поэтому «прочитать все товары» — это
 * прочитать десятки мегабайт. Чтобы не делать этого на каждый запрос витрины,
 * публичный каталог кэшируется в media.js, а здесь мы отмечаем сам факт
 * записи: любая правка увеличивает rev и сбрасывает кэш. Ещё rev входит в
 * отпечаток /api/live-version — он ловит даже две правки внутри одной секунды,
 * где updated_at (точность до секунды) не меняется. Само значение лежит в БД
 * (server/rev.js), иначе после перезапуска оно обнулялось бы и открытая
 * вкладка могла увидеть прежний отпечаток при других данных.
 */
function bumpRev() {
  try { require('./media').invalidateCatalog(); } catch (_) {}
  return require('./rev').bump('products');
}
function getRev() {
  return require('./rev').read('products');
}

function rowToProduct(row) {
  if (!row) return null;
  let sizes = [];
  let stock = {};
  let gal = [];
  let colors = [];
  try { sizes = JSON.parse(row.sizes_json || '[]'); } catch (_) {}
  try { stock = JSON.parse(row.stock_json || '{}'); } catch (_) {}
  try { gal = JSON.parse(row.gal_json || '[]'); } catch (_) {}
  try { colors = JSON.parse(row.colors_json || '[]'); } catch (_) {}
  return {
    id: row.id,
    name: row.name,
    cat: row.cat,
    gender: row.gender,
    price: row.price,
    old: row.old_price || 0,
    sku: row.sku,
    sizes,
    stock,
    on: !!row.on_sale,
    img: row.img,
    gal: gal.length ? gal : (row.img ? [row.img] : []),
    desc: row.desc_text || '',
    badge: row.badge || '',
    tryon: row.tryon === 1,
    sizeChart: row.size_chart || '',
    colors: Array.isArray(colors) ? colors : []
  };
}

/** Цвета товара: [{name, hex}]. Любые — список задаёт админ. */
function cleanColors(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const c of list) {
    if (!c) continue;
    const hex = String(c.hex || '').trim();
    if (!/^#[0-9a-f]{6}$/i.test(hex)) continue;
    const name = String(c.name || '').trim().slice(0, 32) || hex.toUpperCase();
    if (out.some((x) => x.hex.toLowerCase() === hex.toLowerCase())) continue;
    out.push({ name, hex: hex.toLowerCase() });
    if (out.length >= 20) break;
  }
  return out;
}

function listProducts({ all = false } = {}) {
  const rows = all
    ? db.prepare('SELECT * FROM products ORDER BY id').all()
    : db.prepare('SELECT * FROM products WHERE on_sale = 1 ORDER BY id').all();
  return rows.map(rowToProduct);
}

function getProduct(id) {
  return rowToProduct(db.prepare('SELECT * FROM products WHERE id = ?').get(id));
}

function upsertProduct(p) {
  const sizes = Array.isArray(p.sizes) ? p.sizes : [];
  let stock = p.stock && typeof p.stock === 'object' ? p.stock : {};
  if (!Object.keys(stock).length) {
    stock = Object.fromEntries(sizes.map((s) => [s, 12]));
  }
  const gal = Array.isArray(p.gal) ? p.gal : (p.img ? [p.img] : []);
  const payload = {
    name: String(p.name || '').trim() || 'Товар',
    cat: p.cat || 'Футболки',
    gender: p.gender === 'w' ? 'w' : 'm',
    price: Math.max(0, Math.round(+p.price || 0)),
    old_price: Math.max(0, Math.round(+p.old || 0)),
    sku: String(p.sku || '').trim() || ('LC' + Date.now().toString(36).toUpperCase()),
    sizes_json: JSON.stringify(sizes),
    stock_json: JSON.stringify(stock),
    on_sale: p.on === false ? 0 : 1,
    img: p.img || '',
    gal_json: JSON.stringify(gal),
    desc_text: p.desc || '',
    badge: p.badge || '',
    tryon: p.tryon === true ? 1 : 0,
    size_chart: p.sizeChart || '',
    colors_json: JSON.stringify(cleanColors(p.colors))
  };

  if (p.id) {
    db.prepare(`
      UPDATE products SET
        name=@name, cat=@cat, gender=@gender, price=@price, old_price=@old_price, sku=@sku,
        sizes_json=@sizes_json, stock_json=@stock_json, on_sale=@on_sale, img=@img, gal_json=@gal_json,
        desc_text=@desc_text, badge=@badge, tryon=@tryon, size_chart=@size_chart,
        colors_json=@colors_json, updated_at=datetime('now')
      WHERE id=@id
    `).run({ ...payload, id: +p.id });
    bumpRev();
    return getProduct(+p.id);
  }
  const info = db.prepare(`
    INSERT INTO products (name, cat, gender, price, old_price, sku, sizes_json, stock_json, on_sale, img, gal_json, desc_text, badge, tryon, size_chart, colors_json)
    VALUES (@name, @cat, @gender, @price, @old_price, @sku, @sizes_json, @stock_json, @on_sale, @img, @gal_json, @desc_text, @badge, @tryon, @size_chart, @colors_json)
  `).run(payload);
  bumpRev();
  return getProduct(info.lastInsertRowid);
}

function deleteProduct(id) {
  db.prepare('DELETE FROM products WHERE id = ?').run(id);
  try { db.prepare('DELETE FROM reviews WHERE product_id = ?').run(id); } catch (_) {}
  bumpRev();
}

function deductStock(items) {
  const get = db.prepare('SELECT stock_json FROM products WHERE id = ?');
  const set = db.prepare(`UPDATE products SET stock_json = ?, updated_at = datetime('now') WHERE id = ?`);
  db.exec('BEGIN');
  try {
    for (const it of items) {
      const row = get.get(it.id);
      if (!row) continue;
      let stock = {};
      try { stock = JSON.parse(row.stock_json || '{}'); } catch (_) {}
      const sz = it.size;
      if (stock[sz] == null) continue;
      stock[sz] = Math.max(0, (+stock[sz] || 0) - (+it.qty || 0));
      set.run(JSON.stringify(stock), it.id);
    }
    db.exec('COMMIT');
    bumpRev();
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

function restoreStock(items) {
  const get = db.prepare('SELECT stock_json FROM products WHERE id = ?');
  const set = db.prepare(`UPDATE products SET stock_json = ?, updated_at = datetime('now') WHERE id = ?`);
  db.exec('BEGIN');
  try {
    for (const it of items || []) {
      const row = get.get(it.id);
      if (!row) continue;
      let stock = {};
      try { stock = JSON.parse(row.stock_json || '{}'); } catch (_) {}
      const sz = it.size;
      stock[sz] = Math.max(0, (+stock[sz] || 0) + (+it.qty || 0));
      set.run(JSON.stringify(stock), it.id);
    }
    db.exec('COMMIT');
    bumpRev();
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

function checkStock(items) {
  /* Считаем СУММУ по паре товар+размер, а не по каждой позиции отдельно:
     один размер может лежать в корзине несколькими строками (разные цвета),
     и поштучная проверка пропускала заказ на количество больше остатка. */
  const want = new Map();
  for (const it of items) {
    const key = it.id + '|' + it.size;
    want.set(key, (want.get(key) || 0) + (+it.qty || 0));
  }
  const seen = new Set();
  for (const it of items) {
    const key = it.id + '|' + it.size;
    if (seen.has(key)) continue;
    seen.add(key);
    const p = getProduct(it.id);
    if (!p || !p.on) return `Нет товара: ${it.name || it.id}`;
    const hasStockMap = p.stock && Object.keys(p.stock).length > 0;
    /* Пустой stock = безлимит (как на витрине). Если карта есть — нет размера = 0. */
    if (!hasStockMap) continue;
    const left = p.stock[it.size] != null ? +p.stock[it.size] : 0;
    if (left < want.get(key)) return `Не хватает «${p.name}» размер ${it.size}`;
  }
  return null;
}

module.exports = {
  getRev,
  bumpRev,
  listProducts,
  getProduct,
  upsertProduct,
  deleteProduct,
  deductStock,
  restoreStock,
  checkStock,
  rowToProduct
};
