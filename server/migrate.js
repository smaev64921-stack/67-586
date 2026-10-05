/**
 * Переезд магазина на другой сервер без потери данных (Bothost:
 * Нидерланды → Москва — данные граждан РФ должны храниться в России,
 * ч. 5 ст. 18 152-ФЗ).
 *
 * Старый сервер отдаёт папку данных одним потоком, новый при первом запуске
 * сам её забирает — напрямую по HTTPS, без Telegram и сторонних сервисов.
 * Включается одной переменной на обоих серверах, только на время переезда:
 *   MIGRATE_TOKEN=<длинный случайный ключ, от 32 символов>
 * Новый сервер (папка данных пустая) сам забирает всё с MIGRATE_FROM, по
 * умолчанию — https://luxecanvas.ru, куда пока смотрит домен. Старый (база
 * есть) только отдаёт. После переезда переменную удалить.
 *
 * Что переносится: снимок базы (VACUUM INTO — целостный, даже если в этот
 * момент идёт запись), все файлы папки данных (ключи входа и push, привязки
 * Telegram, видео каталога…). Не переносятся журналы (*.log) и старые
 * резервные копии — они не нужны для работы, а лишние ПДн незачем возить.
 *
 * Формат потока: для каждого файла 4 байта длины заголовка (BE), заголовок
 * JSON {p, n, h} (путь, размер, sha256), затем n байт файла; в конце
 * заголовок {end:true, count}.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const MARKER = path.join(DATA_DIR, 'migrated.json');
const SNAP = path.join(DATA_DIR, '.migrate-snap.db');
const INBOX = path.join(DATA_DIR, '.migrate-in');
const DB_NAME = 'shop.db';
const PENDING = path.join(DATA_DIR, 'migrate-pending.json');
const DEFAULT_FROM = 'https://luxecanvas.ru';

function token() {
  const t = String(process.env.MIGRATE_TOKEN || '').trim();
  return t.length >= 32 ? t : '';
}

function sameToken(given) {
  const want = token();
  const a = Buffer.from(String(given || ''));
  const b = Buffer.from(want);
  return !!want && a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** Файлы папки данных, которые нужны на новом сервере. */
function listDataFiles(dir = DATA_DIR, rel = '') {
  let out = [];
  let names = [];
  try { names = fs.readdirSync(path.join(dir, rel)); } catch (_) { return out; }
  for (const name of names) {
    const r = rel ? rel + '/' + name : name;
    if (!rel && (name === 'backups' || name.startsWith('.migrate') || name === 'migrated.json' || name === 'migrate-pending.json')) continue;
    if (!rel && /^shop\.db(-journal|-wal|-shm)?$/.test(name)) continue;
    if (/\.log(\.\d+)?$/.test(name)) continue;
    const full = path.join(dir, r);
    let st;
    try { st = fs.statSync(full); } catch (_) { continue; }
    if (st.isDirectory()) out = out.concat(listDataFiles(dir, r));
    else if (st.isFile()) out.push(r);
  }
  return out;
}

function sha256File(file) {
  const h = crypto.createHash('sha256');
  const fd = fs.openSync(file, 'r');
  const buf = Buffer.alloc(1024 * 1024);
  try {
    let n;
    while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) h.update(buf.subarray(0, n));
  } finally {
    fs.closeSync(fd);
  }
  return h.digest('hex');
}

function headerChunk(obj) {
  const json = Buffer.from(JSON.stringify(obj), 'utf8');
  const len = Buffer.alloc(4);
  len.writeUInt32BE(json.length, 0);
  return Buffer.concat([len, json]);
}

/* ===================== старый сервер: отдать ===================== */

/** GET /api/migrate/export — только с ключом из MIGRATE_TOKEN. */
function exportHandler(db, { hit, clientIp } = {}) {
  return async (req, res) => {
    if (!token()) return res.status(404).json({ error: 'Not found' });
    const ip = clientIp ? clientIp(req) : '';
    if (hit) {
      const lim = hit('migrate-export', ip, { limit: 10, windowMs: 15 * 60 * 1000, label: 'Слишком часто' });
      if (!lim.ok) return res.status(429).json({ error: lim.error });
    }
    const given = String(req.headers['x-migrate-token'] || '');
    if (!sameToken(given)) {
      console.warn('[MIGRATE] неверный ключ, ip', ip);
      return res.status(403).json({ error: 'Нет доступа' });
    }
    try {
      try { fs.unlinkSync(SNAP); } catch (_) {}
      /* целостный снимок базы, даже если в этот момент идёт запись */
      db.exec(`VACUUM INTO '${SNAP.replace(/'/g, "''")}'`);
      const files = [{ p: DB_NAME, full: SNAP }].concat(
        listDataFiles().map((p) => ({ p, full: path.join(DATA_DIR, p) })));
      res.status(200);
      res.setHeader('Content-Type', 'application/octet-stream');
      res.setHeader('Cache-Control', 'no-store');
      let count = 0;
      let bytes = 0;
      for (const f of files) {
        const n = fs.statSync(f.full).size;
        const h = sha256File(f.full);
        res.write(headerChunk({ p: f.p, n, h }));
        await new Promise((resolve, reject) => {
          const rs = fs.createReadStream(f.full);
          rs.on('error', reject);
          rs.on('end', resolve);
          rs.pipe(res, { end: false });
        });
        count++;
        bytes += n;
      }
      res.end(headerChunk({ end: true, count }));
      console.log(`[MIGRATE] отдано файлов: ${count}, ${Math.round(bytes / 1024)} КБ, ip ${ip}`);
    } catch (e) {
      console.error('[MIGRATE] export fail:', e.message);
      if (!res.headersSent) res.status(500).json({ error: 'Не удалось собрать выгрузку' });
      else res.destroy(e);
    } finally {
      try { fs.unlinkSync(SNAP); } catch (_) {}
    }
  };
}

/* ===================== новый сервер: забрать ===================== */

function safeRel(p) {
  const s = String(p || '');
  if (!s || s.includes('\0') || path.isAbsolute(s) || s.split(/[\\/]/).some((x) => x === '..' || x === '')) return null;
  return s;
}

function checkSqlite(file) {
  const fd = fs.openSync(file, 'r');
  const head = Buffer.alloc(16);
  fs.readSync(fd, head, 0, 16, 0);
  fs.closeSync(fd);
  if (head.toString('utf8', 0, 15) !== 'SQLite format 3') throw new Error('shop.db — не SQLite');
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const t = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name);
    for (const need of ['products', 'users', 'cms', 'orders']) {
      if (!t.includes(need)) throw new Error('в shop.db нет таблицы ' + need);
    }
    return {
      products: db.prepare('SELECT COUNT(*) c FROM products').get().c,
      users: db.prepare('SELECT COUNT(*) c FROM users').get().c,
      orders: db.prepare('SELECT COUNT(*) c FROM orders').get().c
    };
  } finally {
    db.close();
  }
}

/* Откуда забирать. Явный MIGRATE_FROM — всегда. Без него — только на новом
   сервере: базы ещё нет (или прошлая попытка сорвалась), тогда с домена,
   который пока смотрит на старый. Старый сервер (база есть) ничего не тянет. */
function pullSource() {
  if (!token() || fs.existsSync(MARKER)) return '';
  const explicit = String(process.env.MIGRATE_FROM || '').trim().replace(/\/+$/, '');
  if (explicit) return explicit;
  const fresh = !fs.existsSync(path.join(DATA_DIR, DB_NAME)) || fs.existsSync(PENDING);
  return fresh ? DEFAULT_FROM : '';
}

async function pull() {
  const from = pullSource();
  if (!from) return { skipped: 'не нужно (нет ключа, уже перенесено или это старый сервер)' };
  if (!/^https:\/\//i.test(from) && !/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/i.test(from)) {
    throw new Error('MIGRATE_FROM должен начинаться с https://');
  }
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.rmSync(INBOX, { recursive: true, force: true });
  fs.mkdirSync(INBOX, { recursive: true });

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 15 * 60 * 1000);
  const res = await fetch(from + '/api/migrate/export', {
    headers: { 'x-migrate-token': token() },
    signal: ctl.signal
  });
  if (res.status !== 200) {
    clearTimeout(timer);
    throw new Error('старый сервер ответил ' + res.status);
  }

  /* разбор потока: заголовок → байты файла → следующий заголовок */
  const got = [];
  let buf = Buffer.alloc(0);
  let cur = null;      // { p, n, h, left, ws, hash }
  let ended = null;
  const { Readable } = require('stream');
  const stream = Readable.fromWeb(res.body);
  const writeChunk = (ws, chunk) => new Promise((resolve, reject) => {
    if (ws.write(chunk)) return resolve();
    ws.once('drain', resolve);
    ws.once('error', reject);
  });
  const closeFile = async () => {
    await new Promise((resolve, reject) => { cur.ws.end(); cur.ws.on('finish', resolve); cur.ws.on('error', reject); });
    if (cur.hash.digest('hex') !== cur.h) throw new Error('не совпала контрольная сумма ' + cur.p);
    got.push({ p: cur.p, n: cur.n });
    cur = null;
  };
  try {
    for await (const chunk of stream) {
      buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
      while (buf.length) {
        if (cur) {
          const take = Math.min(cur.left, buf.length);
          const part = buf.subarray(0, take);
          cur.hash.update(part);
          await writeChunk(cur.ws, part);
          cur.left -= take;
          buf = buf.subarray(take);
          if (cur.left === 0) await closeFile();
          continue;
        }
        if (ended) throw new Error('лишние данные после конца выгрузки');
        if (buf.length < 4) break;
        const len = buf.readUInt32BE(0);
        if (len > 64 * 1024) throw new Error('битый заголовок');
        if (buf.length < 4 + len) break;
        const head = JSON.parse(buf.subarray(4, 4 + len).toString('utf8'));
        buf = buf.subarray(4 + len);
        if (head.end) { ended = head; continue; }
        const rel = safeRel(head.p);
        if (!rel || !(head.n >= 0) || !/^[a-f0-9]{64}$/.test(String(head.h))) throw new Error('битый заголовок файла');
        const dest = path.join(INBOX, rel);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        cur = { p: rel, n: head.n, h: head.h, left: head.n, ws: fs.createWriteStream(dest), hash: crypto.createHash('sha256') };
        if (cur.left === 0) await closeFile();
      }
    }
  } finally {
    clearTimeout(timer);
  }
  if (cur) throw new Error('поток оборвался на файле ' + cur.p);
  if (!ended || ended.count !== got.length) throw new Error('выгрузка неполная');
  if (!got.some((f) => f.p === DB_NAME)) throw new Error('в выгрузке нет базы');
  const stats = checkSqlite(path.join(INBOX, DB_NAME));

  /* всё проверено — кладём на место; прежнюю (пустую) базу сохраняем рядом */
  const live = path.join(DATA_DIR, DB_NAME);
  if (fs.existsSync(live)) {
    const bak = path.join(DATA_DIR, 'backups');
    fs.mkdirSync(bak, { recursive: true });
    fs.copyFileSync(live, path.join(bak, 'pre-migrate-' + Date.now() + '.db'));
  }
  for (const sfx of ['-journal', '-wal', '-shm']) { try { fs.unlinkSync(live + sfx); } catch (_) {} }
  for (const f of got) {
    const dest = path.join(DATA_DIR, f.p);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.renameSync(path.join(INBOX, f.p), dest);
  }
  fs.rmSync(INBOX, { recursive: true, force: true });
  const summary = { at: new Date().toISOString(), from, files: got.length, bytes: got.reduce((s, f) => s + f.n, 0), ...stats };
  fs.writeFileSync(MARKER, JSON.stringify(summary, null, 1));
  try { fs.unlinkSync(PENDING); } catch (_) {}
  return summary;
}

/** Вызывается из server/index.js до открытия базы — синхронно, отдельным процессом. */
function pullBeforeBoot() {
  if (!pullSource()) return;
  try {
    require('child_process').execFileSync(process.execPath, [__filename, '--pull'], {
      stdio: 'inherit',
      timeout: 16 * 60 * 1000
    });
  } catch (e) {
    /* не вышло (старый ещё не обновлён, сеть) — отметка «повторить»: при
       следующем запуске заберём снова, даже если пустая база уже создана */
    console.error('[MIGRATE] перенос не удался, сервер стартует как есть:', e.message);
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(PENDING, JSON.stringify({ at: new Date().toISOString(), error: String(e.message || e) }));
    } catch (_) {}
  }
}

if (require.main === module && process.argv.includes('--pull')) {
  pull().then((r) => {
    console.log('[MIGRATE]', r.skipped ? 'пропущено: ' + r.skipped : 'готово: ' + JSON.stringify(r));
  }).catch((e) => {
    console.error('[MIGRATE] ошибка:', e.message);
    try { fs.rmSync(INBOX, { recursive: true, force: true }); } catch (_) {}
    process.exit(1);
  });
}

/* Новый сервер, пока на нём MIGRATE_TOKEN, не забирает обновления бота:
   старый ещё работает с тем же токеном, а два сервера, опрашивающих
   Telegram, отвечают покупателям через раз. Отправка уведомлений при этом
   идёт. Ключ удалили после переключения домена — бот поднимается здесь. */
function holdTelegram() {
  return !!token() && (fs.existsSync(MARKER) || fs.existsSync(PENDING));
}

module.exports = { exportHandler, pullBeforeBoot, pullSource, listDataFiles, holdTelegram };
