/**
 * Видео на главной: загрузка из админки и отдача на витрину.
 *
 * Почему не как фото. Фото живут base64-строкой внутри CMS в БД — для
 * картинки на полтора мегабайта это терпимо. Ролик на сотню мегабайт так
 * хранить нельзя: каждое сохранение админки гоняло бы его туда-обратно,
 * а бэкап базы распух бы в разы. Поэтому видео лежит обычным файлом в
 * DATA_DIR/media/v/, а в CMS — только короткая ссылка /media/v/<хэш>.<ext>.
 *
 * Качество. Сервер НИЧЕГО не пережимает: файл сохраняется байт в байт
 * таким, каким его выбрал владелец. Именно это он и просил — «чтобы
 * качество не терялось».
 *
 * Загрузка кусками по 8 МБ. Один запрос на 300 МБ не доходит: у Node
 * стоит requestTimeout 300 с, у прокси хостинга свои лимиты, а телефон
 * на мобильной связи рвёт соединение посреди файла. Кусок, который
 * оборвался, просто отправляется заново — с того байта, где сервер
 * остановился, а не с начала ролика. Каждый кусок пишется на диск
 * потоком: в памяти сервера ролик не копится.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { pipeline } = require('stream/promises');
const { Transform } = require('stream');
const { DATA_DIR } = require('./db');

const VIDEO_DIR = path.join(DATA_DIR, 'media', 'v');
const UP_DIR = path.join(VIDEO_DIR, '.up');
const GC_FILE = path.join(VIDEO_DIR, '.gc.json');

const MB = 1024 * 1024;
const MAX_BYTES = Math.max(1, +process.env.VIDEO_MAX_MB || 300) * MB;
/* Сколько места на диске оставляем нетронутым. Видео не стоит того, чтобы
   у SQLite кончилось место посреди записи заказа. */
const RESERVE = Math.max(0, +(process.env.VIDEO_RESERVE_MB ?? 512)) * MB;
const CHUNK = Math.floor(Math.max(64 * 1024, (+process.env.VIDEO_CHUNK_MB || 8) * MB));
const CHUNK_MAX = Math.max(CHUNK, 16 * MB);
/* Незаконченная загрузка живёт сутки: дольше — значит, её бросили. */
const STALE_UP_MS = 24 * 3600e3;
/* Загрузка, в которую не пришло ни байта, брошена наверняка (вкладку
   закрыли сразу после выбора файла) — ей и часа хватит. */
const EMPTY_UP_MS = 3600e3;
/* Готовую загрузку помним час: если ответ на «готово» потерялся по дороге,
   повторный запрос получит ту же ссылку, а не «начните заново». */
const DONE_KEEP_MS = 3600e3;
/* Место на диске обещаем только живым загрузкам. Клиент сам считает связь
   мёртвой через 45 с без движения, так что 15 минут тишины — это уже не
   загрузка, а брошенный хвост, и держать под него сотни мегабайт незачем. */
const ACTIVE_MS = 15 * 60e3;
/* Кусок без единого байта дольше этого обрываем сами. Должно быть меньше,
   чем STALL_MS клиента (45 с): к моменту его повтора старый запрос уже
   закрыт и не держит загрузку занятой. */
const CHUNK_IDLE_MS = 30e3;
/* Ролик, на который CMS больше не ссылается, удаляем не сразу, а через
   неделю. Бэкап базы хранится ~5 суток: восстановили вчерашнюю базу —
   её видео должны быть на месте. */
const GC_GRACE_MS = 7 * 24 * 3600e3;

const RE_FILE = /^[0-9a-f]{16}\.(mp4|webm)$/;
const RE_URL = /^\/media\/v\/[0-9a-f]{16}\.(mp4|webm)$/;
const RE_UP = /^[0-9a-f]{24}$/;

function ensureDirs() {
  fs.mkdirSync(UP_DIR, { recursive: true });
}

function mb(n) {
  return Math.max(1, Math.round(n / MB));
}

function err(status, message, extra) {
  const e = new Error(message);
  e.status = status;
  if (extra) e.data = extra;
  return e;
}

/* ---------- что за файл ---------- */

/* Бренды ISO-BMFF, которые видео не являются: фото HEIC/AVIF с айфона и
   аудио M4A тоже начинаются с ftyp. Без этого списка «видео» оказалось бы
   картинкой, а слайд — чёрным прямоугольником. */
const NOT_VIDEO_BRANDS = new Set([
  'heic', 'heix', 'hevc', 'heim', 'heis', 'hevm', 'hevs', 'mif1', 'msf1',
  'avif', 'avis', 'M4A ', 'M4B ', 'M4P ', 'crx '
]);

/**
 * Тип по первым байтам, а не по имени файла и не по тому, что сказал
 * браузер: расширение переименовывается за секунду.
 * MOV сохраняем как .mp4 — внутри тот же контейнер ISO-BMFF, а Firefox
 * отказывается играть всё, что пришло с типом video/quicktime.
 */
function sniff(head) {
  if (!head || head.length < 12) return null;
  const box = head.toString('latin1', 4, 8);
  if (box === 'ftyp') {
    const brand = head.toString('latin1', 8, 12);
    if (NOT_VIDEO_BRANDS.has(brand)) return null;
    return { ext: 'mp4', type: 'video/mp4' };
  }
  /* старые .mov из QuickTime начинаются сразу с moov/mdat, без ftyp */
  if (box === 'moov' || box === 'mdat' || box === 'wide') return { ext: 'mp4', type: 'video/mp4' };
  if (head.readUInt32BE(0) === 0x1A45DFA3) {
    /* .mkv тоже EBML, но Safari его не играет — берём только WebM */
    if (head.includes(Buffer.from('webm', 'latin1'))) return { ext: 'webm', type: 'video/webm' };
    return null;
  }
  return null;
}

/* ---------- незаконченные загрузки ---------- */

const partPath = (id) => path.join(UP_DIR, id + '.part');
const metaPath = (id) => path.join(UP_DIR, id + '.json');

function readMeta(id) {
  if (!RE_UP.test(String(id || ''))) return null;
  try { return JSON.parse(fs.readFileSync(metaPath(id), 'utf8')); } catch (_) { return null; }
}

function rmQuiet(p) {
  try { fs.unlinkSync(p); } catch (_) {}
}

function dropUpload(id) {
  rmQuiet(partPath(id));
  rmQuiet(metaPath(id));
  hashes.delete(id);
}

function sizeOf(p) {
  try { return fs.statSync(p).size; } catch (_) { return -1; }
}

/* Хэш считаем прямо на лету, пока куски пишутся на диск, — тогда в конце
   не надо перечитывать 300 МБ. Состояние только в памяти: перезапуск
   сервера посреди загрузки — не беда, в конце дочитаем файл заново. */
const hashes = new Map();   // id → { h: Hash, at: байт, до которого посчитан }
/* id → { req, have, settled }: кто сейчас пишет кусок. Сам запрос держим,
   чтобы его можно было оборвать, когда клиент пришёл с повтором. */
const busy = new Map();
const cancelled = new Set(); // отменили, пока шёл кусок, — стереть, когда он закончится

function mtimeOf(p) {
  try { return fs.statSync(p).mtimeMs; } catch (_) { return 0; }
}

function pruneStale() {
  ensureDirs();
  const now = Date.now();
  let names = [];
  try { names = fs.readdirSync(UP_DIR); } catch (_) { return; }
  for (const n of names) {
    const p = path.join(UP_DIR, n);
    const id = n.split('.')[0];
    if (busy.has(id)) continue;
    try {
      const age = now - fs.statSync(p).mtimeMs;
      let dead = age > STALE_UP_MS;
      if (!dead && n.endsWith('.json')) {
        const m = readMeta(id);
        /* готовая: файл уже переехал в media/v, осталась только справка */
        if (m && m.done) dead = age > DONE_KEEP_MS;
        /* пустая: начали и ни одного байта */
        else if (m && sizeOf(partPath(id)) === 0) dead = age > EMPTY_UP_MS;
      }
      if (dead) {
        if (n.endsWith('.json')) dropUpload(id);
        else rmQuiet(p);
      }
    } catch (_) {}
  }
}

/* Незаконченные загрузки: сколько ещё допишут живые (их байтов на диске
   пока нет, но место обещано) и какие давно стоят. */
function uploadsState() {
  const now = Date.now();
  const out = { pending: 0, list: [] };
  let names = [];
  try { names = fs.readdirSync(UP_DIR); } catch (_) { return out; }
  for (const n of names) {
    if (!n.endsWith('.json')) continue;
    const id = n.slice(0, -5);
    const m = readMeta(id);
    if (!m || m.done) continue;
    const left = Math.max(0, (+m.size || 0) - Math.max(0, sizeOf(partPath(id))));
    const quiet = busy.has(id) ? 0 : now - mtimeOf(metaPath(id));
    if (quiet < ACTIVE_MS) out.pending += left;
    out.list.push({ id, user: m.user, quiet });
  }
  return out;
}

function freeBytes() {
  try {
    const st = fs.statfsSync(VIDEO_DIR);
    return Number(st.bavail) * Number(st.bsize);
  } catch (_) {
    return Infinity;   // не умеем узнать — не мешаем загрузке
  }
}

function noSpaceText(free, pending) {
  const left = free - RESERVE;
  /* Не хватает только из-за места, обещанного другим загрузкам, — так и
     говорим: сжимать ролик тут бесполезно, надо дождаться или отменить их. */
  if (pending > 0 && left >= MB) {
    return `Сейчас загружается ещё одно видео (осталось ${mb(pending)} МБ) — вместе они не помещаются на сервер. `
      + 'Дождитесь конца той загрузки или закройте её и попробуйте снова.';
  }
  return (left >= MB
    ? `На сервере свободно ${Math.floor(left / MB)} МБ — ролик не поместится. `
    : 'На сервере почти не осталось места — ролик не поместится. ')
    + 'Сожмите видео или удалите старые ролики с главной.';
}

/* ---------- маршруты ---------- */

/** POST /api/admin/video {size, name} → {id, chunk, max} */
function start(req, res) {
  const size = Math.floor(+((req.body || {}).size) || 0);
  if (size <= 0) return res.status(400).json({ error: 'Пустой файл' });
  if (size > MAX_BYTES) {
    return res.status(413).json({
      error: `Видео ${mb(size)} МБ — больше ${mb(MAX_BYTES)} МБ. Сократите ролик или сохраните его в меньшем размере (1080p хватает с запасом).`
    });
  }
  pruneStale();
  let free = freeBytes();
  let ups = uploadsState();
  if (free - ups.pending - size < RESERVE) {
    /* Места не хватает, а у этого же владельца лежат стоящие загрузки:
       закрыл вкладку, у телефона пропала связь. Раз он начинает новую —
       старые хвосты ему уже не нужны, освобождаем их место. */
    const mine = ups.list.filter(u => u.user === req.user.id && u.quiet > 3 * 60e3);
    if (mine.length) {
      mine.forEach(u => dropUpload(u.id));
      free = freeBytes();
      ups = uploadsState();
    }
  }
  if (free - ups.pending - size < RESERVE) {
    const tipped = free - size >= RESERVE;
    return res.status(507).json({ error: tipped ? noSpaceText(free, ups.pending) : noSpaceText(free - ups.pending, 0) });
  }
  const id = crypto.randomBytes(12).toString('hex');
  const name = String((req.body || {}).name || '').slice(0, 120);
  try {
    fs.writeFileSync(partPath(id), Buffer.alloc(0), { flag: 'wx' });
    fs.writeFileSync(metaPath(id), JSON.stringify({ size, name, at: Date.now(), user: req.user.id }));
  } catch (e) {
    dropUpload(id);
    if (e.code === 'ENOSPC') return res.status(507).json({ error: noSpaceText(0) });
    throw e;
  }
  hashes.set(id, { h: crypto.createHash('sha256'), at: 0 });
  res.json({ id, chunk: CHUNK, max: MAX_BYTES });
}

/** PUT /api/admin/video/:id?off=N, тело — сырые байты куска. */
async function chunk(req, res) {
  const id = String(req.params.id || '');
  if (!readMeta(id)) return res.status(404).json({ error: 'Загрузка устарела — начните заново' });
  const prev = busy.get(id);
  if (prev) {
    /* Пришёл повтор, а прошлый кусок ещё «идёт». Значит, клиент его уже
       бросил: телефон сменил вышку, и соединение умерло без FIN/RST. Node
       держал бы такой запрос до requestTimeout (300 с), и все повторы за это
       время получали бы 409 — клиент сдавался бы и терял всю загрузку.
       Обрываем старый сами и ждём, пока он отрежет свой недописанный хвост. */
    prev.req.destroy();
    await prev.settled;
    const again = busy.get(id);
    if (again) return res.status(409).json({ error: 'Кусок уже загружается', got: again.have });
  }
  const meta = readMeta(id);
  if (!meta) return res.status(404).json({ error: 'Загрузка устарела — начните заново' });
  /* уже собрана (ответ на «готово» потерялся) — пусть клиент идёт за ссылкой */
  if (meta.done) return res.status(409).json({ error: 'Видео уже загружено', got: meta.size });
  const part = partPath(id);
  const have = sizeOf(part);
  if (have < 0) return res.status(404).json({ error: 'Загрузка устарела — начните заново' });
  const off = Math.floor(+req.query.off);
  /* Клиент думает, что сервер на другом байте (оборвался прошлый кусок
     или ответ на него потерялся) — говорим, откуда продолжать. */
  if (off !== have) return res.status(409).json({ error: 'Не тот кусок', got: have });
  const len = +req.headers['content-length'];
  if (!(len > 0)) return res.status(411).json({ error: 'Нет длины куска' });
  if (len > CHUNK_MAX || have + len > meta.size) {
    return res.status(413).json({ error: 'Кусок больше, чем ждали', got: have });
  }

  let release;
  const mine = { req, have, settled: new Promise((r) => { release = r; }) };
  busy.set(id, mine);
  const st = hashes.get(id);
  /* Если кусок оборвётся, хэш нужно откатить вместе с файлом */
  const hashOk = st && st.at === have;
  const before = hashOk ? st.h.copy() : null;
  let seen = 0;
  /* Своя проверка тишины, а не req.setTimeout: тот ставит таймаут на сокет,
     а сокет после ответа живёт дальше (keep-alive) и унёс бы его в чужие
     запросы. */
  let lastByte = Date.now();
  const idle = setInterval(() => {
    if (Date.now() - lastByte > CHUNK_IDLE_MS) req.destroy();
  }, 5000);
  idle.unref?.();
  const guard = new Transform({
    transform(buf, _enc, cb) {
      lastByte = Date.now();
      seen += buf.length;
      if (seen > len) return cb(err(413, 'Кусок больше, чем заявлен'));
      if (hashOk) st.h.update(buf);
      cb(null, buf);
    }
  });
  try {
    await pipeline(req, guard, fs.createWriteStream(part, { flags: 'a' }));
    if (seen !== len) throw err(400, 'Кусок дошёл не целиком');
    if (hashOk) st.at = have + len;
    else hashes.delete(id);
    /* таймстамп меты — «загрузка жива», иначе уборка решит, что её бросили */
    try { fs.utimesSync(metaPath(id), new Date(), new Date()); } catch (_) {}
    res.json({ got: have + len });
  } catch (e) {
    /* Обрезаем недописанный хвост: следующая попытка начнётся с чистого
       края, и в файл не попадёт половина куска. */
    try { fs.truncateSync(part, have); } catch (_) {}
    if (hashOk) { st.h = before; st.at = have; }
    /* клиент уже ушёл — отвечать некому, но и вреда от ответа нет */
    if (res.headersSent) return;
    if (e.code === 'ENOSPC') {
      return res.status(507).json({ error: 'На сервере закончилось место — ролик не сохранился. Удалите старые видео с главной или сожмите этот.', got: have });
    }
    if (e.status) return res.status(e.status).json({ error: e.message, got: have });
    /* соединение оборвалось — клиент повторит этот кусок */
    res.status(400).json({ error: 'Кусок не дошёл — повторите', got: have });
  } finally {
    clearInterval(idle);
    if (busy.get(id) === mine) busy.delete(id);
    if (cancelled.delete(id)) dropUpload(id);
    release();
  }
}

function hashFile(p) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    fs.createReadStream(p)
      .on('data', (b) => h.update(b))
      .on('error', reject)
      .on('end', () => resolve(h.digest('hex')));
  });
}

/** POST /api/admin/video/:id/done → {url, size, type} */
async function finish(req, res) {
  const id = String(req.params.id || '');
  const meta = readMeta(id);
  if (!meta) return res.status(404).json({ error: 'Загрузка устарела — начните заново' });
  /* Повтор «готово»: первый ответ потерялся по дороге, а файл уже на месте.
     Отдаём ту же ссылку — иначе ролик лежал бы на сервере, а владелец
     получил бы «начните заново». */
  if (meta.done) return res.json(meta.done);
  const cur = busy.get(id);
  if (cur) return res.status(409).json({ error: 'Последний кусок ещё грузится', got: cur.have });
  const part = partPath(id);
  const have = sizeOf(part);
  if (have !== meta.size) return res.status(409).json({ error: 'Файл дошёл не целиком', got: Math.max(0, have) });

  const head = Buffer.alloc(64);
  let fd = null;
  try {
    fd = fs.openSync(part, 'r');
    fs.readSync(fd, head, 0, 64, 0);
  } finally {
    if (fd != null) fs.closeSync(fd);
  }
  const kind = sniff(head);
  if (!kind) {
    dropUpload(id);
    return res.status(415).json({ error: 'Это не видео MP4, MOV или WebM. Сохраните ролик в MP4 (H.264) и загрузите снова.' });
  }

  /* Пока собираем файл, повтор куска не должен его трогать: обрывать тут
     нечего (destroy — пустышка), он просто дождётся конца сборки. */
  let release;
  const mine = { req: { destroy() {} }, have, settled: new Promise((r) => { release = r; }) };
  busy.set(id, mine);
  try {
    const st = hashes.get(id);
    hashes.delete(id);
    const hex = st && st.at === have ? st.h.digest('hex') : await hashFile(part);
    /* имя — по содержимому: тот же ролик второй раз не займёт места,
       а ссылку можно кэшировать навсегда */
    const name = hex.slice(0, 16) + '.' + kind.ext;
    const dest = path.join(VIDEO_DIR, name);
    if (fs.existsSync(dest)) rmQuiet(part);
    else fs.renameSync(part, dest);
    forgetGc(name);
    const result = { url: '/media/v/' + name, size: have, type: kind.type };
    /* мету не стираем, а помечаем готовой — для повторного «готово»;
       уборка снимет её через час (DONE_KEEP_MS) */
    try {
      fs.writeFileSync(metaPath(id), JSON.stringify(Object.assign({}, meta, { done: result, doneAt: Date.now() })));
    } catch (_) {
      rmQuiet(metaPath(id));
    }
    res.json(result);
  } finally {
    if (busy.get(id) === mine) busy.delete(id);
    /* отмена во время сборки: файл уже собран и мог понадобиться слайду —
       стираем только хвосты, сам ролик подберёт обычная уборка */
    if (cancelled.delete(id)) {
      const m = readMeta(id);
      if (m && m.done) rmQuiet(partPath(id));
      else dropUpload(id);
    }
    release();
  }
}

/** DELETE /api/admin/video/:id — отмена загрузки */
function cancel(req, res) {
  const id = String(req.params.id || '');
  if (!RE_UP.test(id)) return res.json({ ok: true });
  /* Уже собранный ролик отменой не стираем: клиент мог не дождаться ответа
     на «готово» и решить, что всё пропало, а повтор вернёт ссылку. Ненужный
     файл потом снимет уборка (на него не сошлётся CMS). */
  const m = readMeta(id);
  if (m && m.done) return res.json({ ok: true });
  /* Отмена обычно приходит, пока сервер ещё дописывает оборванный кусок:
     стирать файл из-под открытой записи нельзя — сотрём сразу после неё. */
  const cur = busy.get(id);
  if (cur) {
    cancelled.add(id);
    cur.req.destroy();   // ждать конца куска незачем — он больше не нужен
  } else {
    dropUpload(id);
  }
  res.json({ ok: true });
}

/** GET /media/v/:file — с поддержкой Range: без неё iPhone видео не играет вовсе. */
function serve(req, res) {
  const file = String(req.params.file || '');
  if (!RE_FILE.test(file)) return res.status(404).end();
  /* Ролик с нашего домена: если когда-нибудь подсунут что-то похожее на
     страницу, исполнить в нашем окне оно ничего не сможет */
  res.setHeader('Content-Security-Policy', "default-src 'none'; media-src 'self'; sandbox");
  res.sendFile(file, {
    root: VIDEO_DIR,
    dotfiles: 'deny',
    acceptRanges: true,
    maxAge: 365 * 24 * 3600e3,
    immutable: true
  }, (e) => {
    if (e && !res.headersSent) res.status(e.status || 404).end();
  });
}

/* ---------- уборка ---------- */

function readGc() {
  try { return JSON.parse(fs.readFileSync(GC_FILE, 'utf8')) || {}; } catch (_) { return {}; }
}
function writeGc(map) {
  try { fs.writeFileSync(GC_FILE, JSON.stringify(map)); } catch (_) {}
}
function forgetGc(name) {
  const map = readGc();
  if (map[name]) { delete map[name]; writeGc(map); }
}

/**
 * Удаляет ролики, на которые CMS не ссылается уже неделю, и брошенные
 * загрузки старше суток. Неделя, а не «сразу»: владелец мог убрать видео
 * по ошибке и откатить базу из бэкапа — файл должен ещё лежать.
 * Проверяем по тексту всей CMS, а не по слайдам: вдруг ссылку когда-нибудь
 * поставят и в другой блок — удалять её ролик будет нельзя.
 */
function gc(readCms) {
  try {
    pruneStale();
    const cms = readCms();
    /* CMS не прочиталась (битый JSON, пустая база) — это не повод считать
       ролики ненужными: уборку просто пропускаем */
    if (!cms || typeof cms !== 'object' || !Array.isArray(cms.slides)) return { removed: 0, waiting: 0, skipped: true };
    const text = JSON.stringify(cms);
    const now = Date.now();
    const map = readGc();
    const next = {};
    let removed = 0;
    for (const n of fs.readdirSync(VIDEO_DIR)) {
      if (!RE_FILE.test(n)) continue;
      if (text.includes('/media/v/' + n)) continue;
      const since = +map[n] || now;
      if (now - since >= GC_GRACE_MS) {
        rmQuiet(path.join(VIDEO_DIR, n));
        removed++;
      } else {
        next[n] = since;
      }
    }
    writeGc(next);
    if (removed) console.log(`Видео: удалено старых роликов — ${removed}`);
    return { removed, waiting: Object.keys(next).length };
  } catch (e) {
    console.warn('Видео, уборка:', e.message);
    return { removed: 0, waiting: 0 };
  }
}

/* Обёртка для express 4: ошибка в async-обработчике иначе повисла бы
   необработанным промисом вместо ответа 500. */
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

ensureDirs();

module.exports = {
  VIDEO_DIR,
  RE_URL,
  MAX_BYTES,
  sniff,
  start,
  chunk: wrap(chunk),
  finish: wrap(finish),
  cancel,
  serve,
  gc
};
