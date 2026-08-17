const bcrypt = require('bcryptjs');
const { db } = require('./db');

function garmentSvg(color) {
  const c = color || '#e6e6e6';
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="800" viewBox="0 0 600 800">
    <rect width="600" height="800" fill="#f0eeeb"/>
    <path d="M180 160 L240 120 L300 150 L360 120 L420 160 L400 220 L360 200 L360 620 L240 620 L240 200 L200 220 Z" fill="${c}" stroke="#111" stroke-width="8" stroke-linejoin="round"/>
  </svg>`;
  return 'data:image/svg+xml;utf8,' + encodeURIComponent(svg);
}

/* Только для распознавания старого демо-каталога (очистка). Новые товары не сидируем. */
const DEMO = [
  { sku: '52445' }, { sku: '29772' }, { sku: '61750' }, { sku: '95319' },
  { sku: '38104' }, { sku: '70233' }, { sku: '18946' }, { sku: '64517' },
  { sku: '41208' }, { sku: '85731' }, { sku: '23670' }, { sku: '57894' }
];
const DEMO_SKUS = new Set(DEMO.map((p) => String(p.sku)));

function defaultCms() {
  return {
    brand: { name: 'Canvas', logo: '' },
    contacts: { telegram: 'https://t.me/Luxe_Canvas_bot', email: '', phone: '' },
    legal: { sellerName: '', inn: '', ogrn: '', address: '', email: '', phone: '' },
    texts: {
      aboutLead: '',
      aboutBody: '',
      historyLead: '',
      historyBody: '',
      shippingNote: 'Доставка в пункты выдачи СДЭК.',
      returnsNote: '',
      homeBanner: '',
      heroBtn: 'Перейти в каталог'
    },
    promos: [],
    shipping: { courier: 490, pickup: 190, freeFrom: 15000, courierDays: '1–3 дня', pickupDays: '2–5 дней' },
    slides: [],
    /* Четыре плашки над «Новинками» на главной */
    usp: {
      on: true,
      items: [
        { ic: 'star', l1: 'Новинки', l2: 'каждую неделю' },
        { ic: 'shield', l1: 'Премиум', l2: 'качество' },
        { ic: 'truck', l1: 'Быстрая', l2: 'доставка' },
        { ic: 'refresh', l1: 'Лёгкий', l2: 'возврат' }
      ]
    },
    customers: {},
    pvz: [],
    sizeChart: '',
    tryon: { enabled: false, maxSide: 1280 }
  };
}

function clearDemoCatalog() {
  const rows = db.prepare('SELECT id, sku FROM products').all();
  if (!rows.length) return 0;
  const onlyDemo = rows.every((r) => DEMO_SKUS.has(String(r.sku || '')));
  if (onlyDemo || process.env.WIPE_CATALOG === '1') {
    db.prepare('DELETE FROM products').run();
    console.log('Cleared catalog:', rows.length, 'products');
    return rows.length;
  }
  return 0;
}

function seedIfEmpty() {
  clearDemoCatalog();
  try { db.prepare('DELETE FROM reviews').run(); } catch (_) {}

  const cmsRow = db.prepare('SELECT id FROM cms WHERE id = 1').get();
  if (!cmsRow) {
    db.prepare('INSERT INTO cms (id, data_json) VALUES (1, ?)').run(JSON.stringify(defaultCms()));
    console.log('Seeded empty CMS');
  }

  const adminEmail = (process.env.ADMIN_EMAIL || 'admin@luxecanvas.ru').trim().toLowerCase();
  const adminPass = process.env.ADMIN_PASSWORD || 'ChangeMe123!';
  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(adminEmail);
  if (!existing) {
    const hash = bcrypt.hashSync(adminPass, 10);
    db.prepare(`
      INSERT INTO users (email, password_hash, name, last_name, role)
      VALUES (?, ?, 'Admin', '', 'admin')
    `).run(adminEmail, hash);
    console.log('Seeded admin:', adminEmail);
  }
}

if (require.main === module) {
  require('dotenv').config();
  seedIfEmpty();
  console.log('Done');
}

module.exports = { seedIfEmpty, defaultCms, garmentSvg, clearDemoCatalog };
