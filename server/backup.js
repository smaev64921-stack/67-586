/**
 * Бэкап / выгрузка / безопасное восстановление SQLite (shop.db).
 */
const fs = require('fs');
const path = require('path');
const { DB_PATH, DATA_DIR } = require('./db');

const BACKUP_DIR = path.join(DATA_DIR, 'backups');
const KEEP = Math.max(3, +(process.env.DB_BACKUP_KEEP || 14));
const INTERVAL_MS = Math.max(
  60 * 60 * 1000,
  (+(process.env.DB_BACKUP_HOURS || 6) || 6) * 60 * 60 * 1000
);
const MAX_IMPORT_BYTES = 45 * 1024 * 1024;

let timer = null;

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return [
    d.getFullYear(),
    p(d.getMonth() + 1),
    p(d.getDate()),
    '-',
    p(d.getHours()),
    p(d.getMinutes()),
    p(d.getSeconds())
  ].join('');
}

function pruneOld() {
  let files = [];
  try {
    files = fs.readdirSync(BACKUP_DIR)
      .filter((f) => /^shop-.*\.db$/i.test(f) || /^pre-restore-.*\.db$/i.test(f))
      .map((f) => ({ f, t: fs.statSync(path.join(BACKUP_DIR, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t);
  } catch (_) {
    return;
  }
  for (const x of files.slice(KEEP + 5)) {
    try { fs.unlinkSync(path.join(BACKUP_DIR, x.f)); } catch (_) {}
  }
}

function backupSqlite(reason = 'schedule') {
  try {
    if (!fs.existsSync(DB_PATH)) {
      console.warn('[BACKUP] нет файла БД:', DB_PATH);
      return null;
    }
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    const dest = path.join(BACKUP_DIR, `shop-${stamp()}.db`);
    fs.copyFileSync(DB_PATH, dest);
    pruneOld();
    console.log(`[BACKUP] ${reason} → ${dest}`);
    return dest;
  } catch (e) {
    console.error('[BACKUP] fail:', e.message);
    return null;
  }
}

function startBackupSchedule() {
  if (timer) return;
  if (process.env.DB_BACKUP === '0' || process.env.DB_BACKUP === 'false') {
    console.log('[BACKUP] OFF (DB_BACKUP=0)');
    return;
  }
  backupSqlite('boot');
  timer = setInterval(() => backupSqlite('schedule'), INTERVAL_MS);
  if (typeof timer.unref === 'function') timer.unref();
  console.log(`[BACKUP] every ${Math.round(INTERVAL_MS / 3600000)}h · keep ${KEEP}`);
}

/** Проверка, что файл — валидная БД магазина. */
function validateSqliteFile(filePath) {
  try {
    if (!filePath || !fs.existsSync(filePath)) {
      return { ok: false, error: 'Файл не найден на диске' };
    }
    const st = fs.statSync(filePath);
    if (!st.isFile()) return { ok: false, error: 'Это не файл' };
    if (st.size < 200) return { ok: false, error: 'Файл слишком маленький — это не база SQLite' };
    if (st.size > MAX_IMPORT_BYTES) {
      return { ok: false, error: `Файл больше ${Math.round(MAX_IMPORT_BYTES / 1024 / 1024)} МБ — Telegram/сервер не примет` };
    }

    const fd = fs.openSync(filePath, 'r');
    const head = Buffer.alloc(16);
    fs.readSync(fd, head, 0, 16, 0);
    fs.closeSync(fd);
    if (head.toString('utf8', 0, 15) !== 'SQLite format 3') {
      return { ok: false, error: 'Файл не SQLite. Нужен именно shop.db (заголовок «SQLite format 3»)' };
    }

    const { DatabaseSync } = require('node:sqlite');
    let test;
    try {
      test = new DatabaseSync(filePath, { readOnly: true });
    } catch (e) {
      return { ok: false, error: 'Не открывается как SQLite: ' + (e.message || e) };
    }

    try {
      const tables = test.prepare(
        `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`
      ).all().map((r) => String(r.name));

      const need = ['products', 'users', 'orders'];
      const missing = need.filter((t) => !tables.includes(t));
      if (missing.length) {
        return {
          ok: false,
          error: `В базе нет обязательных таблиц: ${missing.join(', ')}. Это не база Canvas.`
        };
      }

      const products = +(test.prepare('SELECT COUNT(*) AS c FROM products').get().c || 0);
      const users = +(test.prepare('SELECT COUNT(*) AS c FROM users').get().c || 0);
      const orders = +(test.prepare('SELECT COUNT(*) AS c FROM orders').get().c || 0);
      let cms = 0;
      if (tables.includes('cms')) {
        try { cms = +(test.prepare('SELECT COUNT(*) AS c FROM cms').get().c || 0); } catch (_) {}
      }

      return {
        ok: true,
        size: st.size,
        products,
        users,
        orders,
        cms,
        tables
      };
    } catch (e) {
      return { ok: false, error: 'Ошибка чтения таблиц: ' + (e.message || e) };
    } finally {
      try { test.close(); } catch (_) {}
    }
  } catch (e) {
    return { ok: false, error: 'Проверка файла: ' + (e.message || e) };
  }
}

/**
 * Собрать файлы для выгрузки в бот.
 * @returns {{ ok: true, files: Array<{path,filename,caption}> } | { ok:false, error }}
 */
function buildExportFiles() {
  try {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    const tag = stamp();
    const files = [];

    if (!fs.existsSync(DB_PATH)) {
      return { ok: false, error: 'На сервере нет shop.db — нечего выгружать' };
    }

    const dbCopy = path.join(BACKUP_DIR, `export-shop-${tag}.db`);
    fs.copyFileSync(DB_PATH, dbCopy);
    const check = validateSqliteFile(dbCopy);
    if (!check.ok) {
      try { fs.unlinkSync(dbCopy); } catch (_) {}
      return { ok: false, error: 'Текущая БД повреждена, выгрузка отменена: ' + check.error };
    }

    files.push({
      path: dbCopy,
      filename: `luxe-shop-${tag}.db`,
      caption: [
        '🗄 База сайта (shop.db)',
        `Товары: ${check.products} · Заказы: ${check.orders} · Юзеры: ${check.users}`,
        '',
        'Чтобы применить правки: в боте → «Загрузить БД» → пришлите этот файл.'
      ].join('\n')
    });

    /* удобные JSON-снимки (не для полного restore, только посмотреть/править глазами) */
    try {
      const { listProducts } = require('./products');
      const { getCms, listAllOrders } = require('./orders');
      const snap = {
        exportedAt: new Date().toISOString(),
        products: listProducts({ all: true }) || [],
        cms: getCms() || {},
        ordersCount: (listAllOrders() || []).length
      };
      const jsonPath = path.join(BACKUP_DIR, `export-snap-${tag}.json`);
      fs.writeFileSync(jsonPath, JSON.stringify(snap, null, 2), 'utf8');
      files.push({
        path: jsonPath,
        filename: `luxe-snap-${tag}.json`,
        caption: '📄 Снимок каталога/CMS (для просмотра). Восстановление — только через .db файл.'
      });
    } catch (e) {
      console.warn('[BACKUP] json snap:', e.message);
    }

    return { ok: true, files, meta: check };
  } catch (e) {
    return { ok: false, error: 'Не удалось собрать выгрузку: ' + (e.message || e) };
  }
}

/**
 * Безопасно заменить shop.db. После успеха — нужен рестарт процесса.
 * @returns {{ ok, error?, backup?, info?, restart?: boolean }}
 */
function restoreSqliteFromFile(incomingPath) {
  const check = validateSqliteFile(incomingPath);
  if (!check.ok) return { ok: false, error: check.error };

  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const safety = path.join(BACKUP_DIR, `pre-restore-${stamp()}.db`);

  try {
    if (fs.existsSync(DB_PATH)) {
      fs.copyFileSync(DB_PATH, safety);
    }
  } catch (e) {
    return { ok: false, error: 'Не удалось сохранить страховку текущей БД: ' + (e.message || e) };
  }

  /* закрыть открытое соединение, иначе файл может быть залочен */
  try {
    const dbMod = require('./db');
    if (typeof dbMod.closeDb === 'function') dbMod.closeDb();
  } catch (e) {
    return {
      ok: false,
      error: 'Не удалось закрыть текущую БД перед заменой: ' + (e.message || e)
    };
  }

  const incoming = path.join(BACKUP_DIR, `incoming-${stamp()}.db`);
  const prevLive = path.join(BACKUP_DIR, `replaced-${stamp()}.db`);

  try {
    fs.copyFileSync(incomingPath, incoming);

    if (fs.existsSync(DB_PATH)) {
      try { fs.renameSync(DB_PATH, prevLive); } catch (_) {
        fs.copyFileSync(DB_PATH, prevLive);
        fs.unlinkSync(DB_PATH);
      }
    }

    fs.copyFileSync(incoming, DB_PATH);

    /* быстрая проверка уже на боевом пути */
    const again = validateSqliteFile(DB_PATH);
    if (!again.ok) {
      /* откат */
      try {
        if (fs.existsSync(DB_PATH)) fs.unlinkSync(DB_PATH);
        if (fs.existsSync(safety)) fs.copyFileSync(safety, DB_PATH);
        else if (fs.existsSync(prevLive)) fs.copyFileSync(prevLive, DB_PATH);
      } catch (re) {
        return {
          ok: false,
          error: `Новая БД битая (${again.error}). Откат тоже не удался: ${re.message}. Страховка: ${safety}`
        };
      }
      try {
        const dbMod = require('./db');
        if (typeof dbMod.reopenDb === 'function') dbMod.reopenDb();
      } catch (_) {}
      return { ok: false, error: `Новая БД не прошла проверку: ${again.error}. Откатил на старую.` };
    }

    return {
      ok: true,
      restart: true,
      backup: safety,
      info: again
    };
  } catch (e) {
    /* откат при любой ошибке записи */
    try {
      if (fs.existsSync(safety) && !fs.existsSync(DB_PATH)) {
        fs.copyFileSync(safety, DB_PATH);
      } else if (fs.existsSync(safety)) {
        try { fs.unlinkSync(DB_PATH); } catch (_) {}
        fs.copyFileSync(safety, DB_PATH);
      }
    } catch (_) {}
    try {
      const dbMod = require('./db');
      if (typeof dbMod.reopenDb === 'function') dbMod.reopenDb();
    } catch (_) {}
    return { ok: false, error: 'Замена файла не удалась: ' + (e.message || e) };
  }
}

module.exports = {
  backupSqlite,
  startBackupSchedule,
  BACKUP_DIR,
  validateSqliteFile,
  buildExportFiles,
  restoreSqliteFromFile,
  MAX_IMPORT_BYTES
};
