const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const DB_PATH = process.env.DB_PATH || path.join(DATA_DIR, 'shop.db');

fs.mkdirSync(DATA_DIR, { recursive: true });

let db = new DatabaseSync(DB_PATH);

function migrate() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT NOT NULL UNIQUE COLLATE NOCASE,
      password_hash TEXT NOT NULL,
      name TEXT NOT NULL DEFAULT '',
      last_name TEXT NOT NULL DEFAULT '',
      middle_name TEXT NOT NULL DEFAULT '',
      phone TEXT NOT NULL DEFAULT '',
      google_id TEXT,
      role TEXT NOT NULL DEFAULT 'user',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS products (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      cat TEXT NOT NULL DEFAULT 'Футболки',
      gender TEXT NOT NULL DEFAULT 'm',
      price INTEGER NOT NULL DEFAULT 0,
      old_price INTEGER NOT NULL DEFAULT 0,
      sku TEXT NOT NULL DEFAULT '',
      sizes_json TEXT NOT NULL DEFAULT '[]',
      stock_json TEXT NOT NULL DEFAULT '{}',
      on_sale INTEGER NOT NULL DEFAULT 1,
      img TEXT NOT NULL DEFAULT '',
      gal_json TEXT NOT NULL DEFAULT '[]',
      desc_text TEXT NOT NULL DEFAULT '',
      badge TEXT NOT NULL DEFAULT '',
      tryon INTEGER NOT NULL DEFAULT 0,
      size_chart TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS cms (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      data_json TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      num TEXT NOT NULL UNIQUE,
      user_id INTEGER,
      status TEXT NOT NULL DEFAULT 'Ожидает оплаты',
      pay_status TEXT NOT NULL DEFAULT 'pending',
      yookassa_id TEXT,
      confirmation_url TEXT,
      price INTEGER NOT NULL DEFAULT 0,
      goods INTEGER NOT NULL DEFAULT 0,
      discount INTEGER NOT NULL DEFAULT 0,
      ship INTEGER NOT NULL DEFAULT 0,
      ship_mode TEXT NOT NULL DEFAULT 'pickup',
      promo_code TEXT NOT NULL DEFAULT '',
      pay_name TEXT NOT NULL DEFAULT 'ЮKassa',
      customer_name TEXT NOT NULL DEFAULT '',
      email TEXT NOT NULL DEFAULT '',
      phone TEXT NOT NULL DEFAULT '',
      addr TEXT NOT NULL DEFAULT '',
      pvz_json TEXT,
      items_json TEXT NOT NULL DEFAULT '[]',
      steps_json TEXT NOT NULL DEFAULT '[]',
      step_now INTEGER NOT NULL DEFAULT 0,
      tracking TEXT NOT NULL DEFAULT '',
      note TEXT NOT NULL DEFAULT '',
      guest INTEGER NOT NULL DEFAULT 1,
      access_token TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS reviews (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      product_id INTEGER NOT NULL,
      user_email TEXT NOT NULL DEFAULT '',
      author TEXT NOT NULL DEFAULT '',
      rating INTEGER NOT NULL DEFAULT 5,
      text TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
}

migrate();

/* Мягкие миграции для уже существующих БД */
try { db.exec('ALTER TABLE orders ADD COLUMN access_token TEXT'); } catch (_) {}
try { db.exec('ALTER TABLE orders ADD COLUMN stock_reserved INTEGER NOT NULL DEFAULT 0'); } catch (_) {}
try { db.exec('ALTER TABLE products ADD COLUMN size_chart TEXT NOT NULL DEFAULT \'\''); } catch (_) {}
try { db.exec("ALTER TABLE products ADD COLUMN colors_json TEXT NOT NULL DEFAULT '[]'"); } catch (_) {}
try { db.exec('ALTER TABLE users ADD COLUMN middle_name TEXT NOT NULL DEFAULT \'\''); } catch (_) {}
try { db.exec('ALTER TABLE users ADD COLUMN google_id TEXT'); } catch (_) {}
try { db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_google_id ON users(google_id) WHERE google_id IS NOT NULL AND google_id != \'\''); } catch (_) {}
try { db.exec("ALTER TABLE reviews ADD COLUMN sku TEXT NOT NULL DEFAULT ''"); } catch (_) {}
try { db.exec('ALTER TABLE reviews ADD COLUMN user_id INTEGER'); } catch (_) {}
try { db.exec("ALTER TABLE reviews ADD COLUMN size TEXT NOT NULL DEFAULT ''"); } catch (_) {}
try { db.exec('ALTER TABLE reviews ADD COLUMN fit INTEGER NOT NULL DEFAULT 0'); } catch (_) {}
try { db.exec("ALTER TABLE reviews ADD COLUMN photos_json TEXT NOT NULL DEFAULT '[]'"); } catch (_) {}
try { db.exec('ALTER TABLE reviews ADD COLUMN useful INTEGER NOT NULL DEFAULT 0'); } catch (_) {}
try { db.exec('ALTER TABLE reviews ADD COLUMN verified INTEGER NOT NULL DEFAULT 0'); } catch (_) {}
try { db.exec("ALTER TABLE reviews ADD COLUMN reply_text TEXT NOT NULL DEFAULT ''"); } catch (_) {}
try { db.exec("ALTER TABLE reviews ADD COLUMN reply_date TEXT NOT NULL DEFAULT ''"); } catch (_) {}
try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS review_votes (
      review_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      PRIMARY KEY (review_id, user_id)
    )
  `);
} catch (_) {}

function closeDb() {
  try { db.close(); } catch (_) {}
}

function reopenDb() {
  try { db.close(); } catch (_) {}
  db = new DatabaseSync(DB_PATH);
  module.exports.db = db;
  return db;
}

module.exports = { db, DB_PATH, DATA_DIR, closeDb, reopenDb };
