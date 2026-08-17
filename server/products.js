const { db } = require('./db');

function rowToProduct(row) {
  if (!row) return null;
  let sizes = [];
  let stock = {};
  let gal = [];
  try { sizes = JSON.parse(row.sizes_json || '[]'); } catch (_) {}
  try { stock = JSON.parse(row.stock_json || '{}'); } catch (_) {}
  try { gal = JSON.parse(row.gal_json || '[]'); } catch (_) {}
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
    sizeChart: row.size_chart || ''
  };
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
    size_chart: p.sizeChart || ''
  };

  if (p.id) {
    db.prepare(`
      UPDATE products SET
        name=@name, cat=@cat, gender=@gender, price=@price, old_price=@old_price, sku=@sku,
        sizes_json=@sizes_json, stock_json=@stock_json, on_sale=@on_sale, img=@img, gal_json=@gal_json,
        desc_text=@desc_text, badge=@badge, tryon=@tryon, size_chart=@size_chart, updated_at=datetime('now')
      WHERE id=@id
    `).run({ ...payload, id: +p.id });
    return getProduct(+p.id);
  }
  const info = db.prepare(`
    INSERT INTO products (name, cat, gender, price, old_price, sku, sizes_json, stock_json, on_sale, img, gal_json, desc_text, badge, tryon, size_chart)
    VALUES (@name, @cat, @gender, @price, @old_price, @sku, @sizes_json, @stock_json, @on_sale, @img, @gal_json, @desc_text, @badge, @tryon, @size_chart)
  `).run(payload);
  return getProduct(info.lastInsertRowid);
}

function deleteProduct(id) {
  db.prepare('DELETE FROM products WHERE id = ?').run(id);
  try { db.prepare('DELETE FROM reviews WHERE product_id = ?').run(id); } catch (_) {}
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
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

function checkStock(items) {
  for (const it of items) {
    const p = getProduct(it.id);
    if (!p || !p.on) return `Нет товара: ${it.name || it.id}`;
    const hasStockMap = p.stock && Object.keys(p.stock).length > 0;
    /* Пустой stock = безлимит (как на витрине). Если карта есть — нет размера = 0. */
    if (!hasStockMap) continue;
    const left = p.stock[it.size] != null ? +p.stock[it.size] : 0;
    if (left < (+it.qty || 0)) return `Не хватает «${p.name}» размер ${it.size}`;
  }
  return null;
}

module.exports = {
  listProducts,
  getProduct,
  upsertProduct,
  deleteProduct,
  deductStock,
  restoreStock,
  checkStock,
  rowToProduct
};
