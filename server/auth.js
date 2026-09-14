const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { db } = require('./db');

/* Подпись сессий — только сильным секретом, без публичной запасной строки.
   Подробности и почему — в server/secrets.js. */
const { serverSecret, PUBLIC_VALUES } = require('./secrets');
const JWT_SECRET = () => serverSecret();
const JWT_VERIFY = { algorithms: ['HS256'] };
const COOKIE = 'lc_token';

function signUser(user) {
  return jwt.sign(
    { id: user.id, email: user.email, role: user.role, v: (user.token_ver | 0) },
    JWT_SECRET(),
    { algorithm: 'HS256', expiresIn: '30d' }
  );
}

function isPlaceholderEmail(email) {
  const em = String(email || '').trim();
  return /@phone\.luxecanvas$/i.test(em) || /@google\.luxecanvas$/i.test(em);
}

function publicUser(row) {
  if (!row) return null;
  const rawEmail = String(row.email || '').trim();
  const email = isPlaceholderEmail(rawEmail) ? '' : rawEmail;
  return {
    id: row.id,
    email,
    name: row.name || '',
    last: row.last_name || '',
    middle: row.middle_name || '',
    phone: row.phone || '',
    admin: row.role === 'admin'
  };
}

function findByEmail(email) {
  return db.prepare('SELECT * FROM users WHERE email = ?').get(String(email || '').trim().toLowerCase());
}

function findById(id) {
  return db.prepare('SELECT * FROM users WHERE id = ?').get(id);
}

function findByGoogleId(googleId) {
  const gid = String(googleId || '').trim();
  if (!gid) return null;
  return db.prepare('SELECT * FROM users WHERE google_id = ?').get(gid);
}

/** Вход / регистрация через Google. */
function upsertGoogleUser({ googleId, email, name, last, emailVerified }) {
  const gid = String(googleId || '').trim();
  if (!gid) throw Object.assign(new Error('Нет Google ID'), { status: 400 });

  let row = findByGoogleId(gid);
  if (row) return row;

  const em = String(email || '').trim().toLowerCase();
  /* К существующему аккаунту по почте привязываем, только если Google
     подтвердил, что почта принадлежит этому человеку. */
  if (emailVerified !== false && em && em.includes('@') && !isPlaceholderEmail(em)) {
    row = findByEmail(em);
    if (row) {
      /* Предзахват. Почту при регистрации у нас не подтверждают, поэтому
         злоумышленник мог заранее завести аккаунт на чужой адрес со своим
         паролем. Когда настоящий владелец входит через Google, он
         попадал в этот аккаунт, а пароль злоумышленника продолжал
         работать — и тот видел все его заказы и адреса.

         Google только что доказал, чья это почта. Значит, пароль, заданный
         неизвестно кем, больше не действует, а все выданные сессии
         отзываются. Настоящий владелец при желании задаст пароль заново
         через «Забыли пароль» — письмо придёт ему. */
      const lockedPass = bcrypt.hashSync(require('crypto').randomBytes(24).toString('hex'), 10);
      db.prepare(`UPDATE users SET google_id = ?, password_hash = ?, token_ver = token_ver + 1 WHERE id = ?`)
        .run(gid, lockedPass, row.id);
      if (name && !row.name) {
        db.prepare(`UPDATE users SET name = ? WHERE id = ?`).run(String(name).trim(), row.id);
      }
      if (last && !row.last_name) {
        db.prepare(`UPDATE users SET last_name = ? WHERE id = ?`).run(String(last).trim(), row.id);
      }
      return findById(row.id);
    }
  }

  /* Неподтверждённая почта — не наша забота, чья она: новый аккаунт живёт
     на служебном адресе. Иначе ветка ниже («крайне редко») находила по этой
     почте чужой аккаунт и привязывала Google к нему — в обход проверки выше. */
  const finalEmail = (emailVerified !== false && em && em.includes('@'))
    ? em
    : `g${gid}@google.luxecanvas`;
  if (findByEmail(finalEmail)) {
    /* крайне редко */
    const existing = findByEmail(finalEmail);
    db.prepare(`UPDATE users SET google_id = ? WHERE id = ?`).run(gid, existing.id);
    return findById(existing.id);
  }

  const adminEmail = (process.env.ADMIN_EMAIL || '').trim().toLowerCase();
  const role = adminEmail && finalEmail === adminEmail ? 'admin' : 'user';
  const hash = bcrypt.hashSync(cryptoRandomPass(), 10);
  const info = db.prepare(`
    INSERT INTO users (email, password_hash, name, last_name, middle_name, phone, role, google_id)
    VALUES (?, ?, ?, ?, '', '', ?, ?)
  `).run(
    finalEmail,
    hash,
    String(name || '').trim() || 'Покупатель',
    String(last || '').trim(),
    role,
    gid
  );
  return findById(info.lastInsertRowid);
}

function register({ email, password, name, last, phone }) {
  const em = String(email || '').trim().toLowerCase();
  if (!em.includes('@')) throw Object.assign(new Error('Некорректный email'), { status: 400 });
  if (String(password || '').length < 6) throw Object.assign(new Error('Пароль минимум 6 символов'), { status: 400 });
  if (findByEmail(em)) throw Object.assign(new Error('Этот email уже зарегистрирован'), { status: 409 });

  const adminEmail = (process.env.ADMIN_EMAIL || '').trim().toLowerCase();
  /* Только ADMIN_EMAIL из .env; #ADMIN в имени больше не повышает права. */
  let cleanName = String(name || '').trim().replace(/#\s*ADMIN\b/gi, '').replace(/\s+/g, ' ').trim();
  const role = adminEmail && em === adminEmail ? 'admin' : 'user';

  const hash = bcrypt.hashSync(password, 10);
  const info = db.prepare(`
    INSERT INTO users (email, password_hash, name, last_name, phone, role)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(em, hash, cleanName, String(last || '').trim(), String(phone || '').trim(), role);

  return findById(info.lastInsertRowid);
}

function login({ email, password }) {
  const row = findByEmail(email);
  if (!row || !bcrypt.compareSync(String(password || ''), row.password_hash)) {
    throw Object.assign(new Error('Неверный email или пароль'), { status: 401 });
  }
  /* Пароль админа по умолчанию напечатан в коде и в .env.example, а те
     лежат в открытом репозитории. Кто прочитал — тот вошёл в админку.
     Поэтому такой пароль больше не открывает ничего: владелец входит
     ссылкой из бота или задаёт новый через ADMIN_PASSWORD. */
  if (row.role === 'admin' && PUBLIC_VALUES.has(String(password || '').trim().toLowerCase())) {
    throw Object.assign(
      new Error('Этот пароль опубликован и больше не действует. Войдите в админку ссылкой из Telegram-бота или задайте новый пароль в ADMIN_PASSWORD.'),
      { status: 403, code: 'PUBLIC_ADMIN_PASSWORD' }
    );
  }
  return row;
}

function readToken(req) {
  const hdr = req.headers.authorization || '';
  if (hdr.startsWith('Bearer ')) return hdr.slice(7);
  const cookie = req.headers.cookie || '';
  const m = cookie.match(new RegExp('(?:^|; )' + COOKIE + '=([^;]+)'));
  return m ? decodeURIComponent(m[1]) : null;
}

function authOptional(req, _res, next) {
  req.user = null;
  const token = readToken(req);
  if (token) {
    try {
      const payload = jwt.verify(token, JWT_SECRET(), JWT_VERIFY);
      const row = findById(payload.id);
      /* Токен старой версии отозван. У токенов, выданных до появления
         версии, поля v нет — это 0, и они живут до первого отзыва. */
      if (row && (payload.v | 0) === (row.token_ver | 0)) req.user = row;
    } catch (_) {}
  }
  next();
}

function authRequired(req, res, next) {
  authOptional(req, res, () => {
    if (!req.user) return res.status(401).json({ error: 'Нужен вход' });
    next();
  });
}

function adminRequired(req, res, next) {
  authRequired(req, res, () => {
    if (!req.user || req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Нет доступа' });
    }
    next();
  });
}

function setAuthCookie(res, token) {
  const secure = String(process.env.PUBLIC_URL || '').startsWith('https');
  res.setHeader(
    'Set-Cookie',
    `${COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${30 * 86400}${secure ? '; Secure' : ''}`
  );
}

function clearAuthCookie(res) {
  res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

/** Гарантировать пользователя ADMIN_EMAIL с ролью admin. */
function ensureAdminUser() {
  const adminEmail = (process.env.ADMIN_EMAIL || 'admin@luxecanvas.ru').trim().toLowerCase();
  /* Пароль из переменной берём, только если он не из опубликованных.
     Иначе админ заводится со случайным паролем, который никто не знает:
     войти можно ссылкой из бота, а пароль — задать потом. */
  const envPass = String(process.env.ADMIN_PASSWORD || '').trim();
  const ownPass = envPass && !PUBLIC_VALUES.has(envPass.toLowerCase()) ? envPass : '';
  const adminPass = ownPass || require('crypto').randomBytes(24).toString('base64url');
  let row = findByEmail(adminEmail);
  /* Уже заведённый админ с опубликованным паролем: владелец задал свой в
     ADMIN_PASSWORD — ставим его. Раньше хэш писался только при создании,
     и заданный потом пароль не менял ничего. */
  if (row && ownPass && bcrypt.compareSync('ChangeMe123!', row.password_hash || '')) {
    db.prepare('UPDATE users SET password_hash = ?, token_ver = token_ver + 1 WHERE id = ?').run(bcrypt.hashSync(ownPass, 10), row.id);
    console.log('Пароль админа по умолчанию заменён на ADMIN_PASSWORD');
    row = findById(row.id);
  }
  if (!row) {
    const hash = bcrypt.hashSync(adminPass, 10);
    const info = db.prepare(`
      INSERT INTO users (email, password_hash, name, last_name, phone, role)
      VALUES (?, ?, 'Admin', '', '', 'admin')
    `).run(adminEmail, hash);
    row = findById(info.lastInsertRowid);
  } else if (row.role !== 'admin') {
    db.prepare(`UPDATE users SET role = 'admin' WHERE id = ?`).run(row.id);
    row = findById(row.id);
  }
  return row;
}

/** Токен входа в админку с бота (для TELEGRAM_CHAT_ID админов).
 *  Срок жизни задаёт бот: кнопка «Админка» висит в чате долго,
 *  и 30 минут превращали её в «ссылка устарела» при каждом заходе. */
function issueTgAdminToken(chatId, ttlMs) {
  const sec = Math.max(300, Math.round((+ttlMs || 30 * 60 * 1000) / 1000));
  return jwt.sign(
    { purpose: 'tg-admin', chatId: String(chatId) },
    JWT_SECRET(),
    { algorithm: 'HS256', expiresIn: sec }
  );
}

function redeemTgAdminToken(token) {
  const { isOwnerChat } = require('./tg-owner');
  let raw = String(token || '').trim();
  if (!raw) {
    throw Object.assign(new Error('Ссылка устарела — откройте бота и нажмите «🛠 Админка» ещё раз'), { status: 401 });
  }

  const finish = (chatId) => {
    if (!isOwnerChat(chatId)) {
      throw Object.assign(new Error('Нет доступа'), { status: 403 });
    }
    /* Привязанный аккаунт → admin; иначе общий ADMIN_EMAIL */
    try {
      const { getLink } = require('./tg-users');
      const link = getLink(chatId);
      if (link && link.userId) {
        const user = promoteUserToAdmin(link.userId);
        if (user && user.role === 'admin') return user;
      }
    } catch (e) {
      console.warn('TG admin promote:', e.message);
    }
    return ensureAdminUser();
  };

  /* короткий код из кнопки бота — действует до exp, можно открыть несколько раз
     (Telegram/превью не «сжигают» одноразовый вход) */
  if (/^[a-f0-9]{32}$/i.test(raw)) {
    const fs = require('fs');
    const path = require('path');
    const { DATA_DIR } = require('./db');
    const file = path.join(DATA_DIR, 'tg-admin-codes.json');
    let map = {};
    try { map = JSON.parse(fs.readFileSync(file, 'utf8')) || {}; } catch (_) {}
    const codeKey = Object.keys(map).find((k) => k.toLowerCase() === raw.toLowerCase());
    const row = codeKey ? map[codeKey] : null;
    if (!row || !row.token || Date.now() > (row.exp || 0)) {
      throw Object.assign(new Error('Ссылка устарела — откройте бота и нажмите «🛠 Админка» ещё раз'), { status: 401 });
    }
    const jwtToken = row.token;
    let payload;
    try {
      payload = jwt.verify(jwtToken, JWT_SECRET(), JWT_VERIFY);
    } catch (_) {
      throw Object.assign(new Error('Ссылка устарела — откройте бота и нажмите «🛠 Админка» ещё раз'), { status: 401 });
    }
    if (!payload || payload.purpose !== 'tg-admin' || !payload.chatId) {
      throw Object.assign(new Error('Неверная ссылка'), { status: 401 });
    }
    row.usedAt = Date.now();
    map[codeKey] = row;
    try { fs.writeFileSync(file, JSON.stringify(map), 'utf8'); } catch (_) {}
    return finish(payload.chatId);
  }

  let payload;
  try {
    payload = jwt.verify(raw, JWT_SECRET(), JWT_VERIFY);
  } catch (_) {
    throw Object.assign(new Error('Ссылка устарела — откройте бота и нажмите «🛠 Админка» ещё раз'), { status: 401 });
  }
  if (!payload || payload.purpose !== 'tg-admin' || !payload.chatId) {
    throw Object.assign(new Error('Неверная ссылка'), { status: 401 });
  }
  return finish(payload.chatId);
}

/**
 * Аккаунт по номеру — только среди ПОДТВЕРЖДЁННЫХ номеров.
 *
 * Все вызовы — это маршрутизация входа: чей аккаунт открыть и куда слать
 * код. Раньше годился любой номер из профиля, а его можно вписать без
 * проверки и без уникальности — и перехватить вход настоящего владельца.
 */
function findByPhone(phone) {
  const { normalizePhone } = require('./sms');
  const p = normalizePhone(phone);
  if (!p) return null;
  const rows = db.prepare(`SELECT * FROM users WHERE phone_verified = 1 AND phone IS NOT NULL AND trim(phone) != '' ORDER BY id`).all();
  for (const row of rows) {
    if (normalizePhone(row.phone) === p) return row;
  }
  return null;
}

function phoneEmail(phone) {
  const { normalizePhone } = require('./sms');
  return `p${normalizePhone(phone)}@phone.luxecanvas`;
}

/** Создать / найти пользователя по телефону (после OTP или Telegram contact). */
function upsertUserByPhone({ phone, name, last, middle, via }) {
  const { normalizePhone, formatPhoneDisplay } = require('./sms');
  const p = normalizePhone(phone);
  if (!p) throw Object.assign(new Error('Некорректный номер'), { status: 400 });

  let row = findByPhone(p);
  if (row) {
    /* имя/фамилию пользователь заполняет сам в профиле — не затираем */
    return row;
  }

  const em = phoneEmail(p);
  if (findByEmail(em)) {
    const existing = findByEmail(em);
    db.prepare(`UPDATE users SET phone = ?, phone_verified = 1 WHERE id = ?`).run(formatPhoneDisplay(p), existing.id);
    return findById(existing.id);
  }

  const hash = bcrypt.hashSync(cryptoRandomPass(), 10);
  const display = formatPhoneDisplay(p);
  /* email-заглушка только внутри БД (UNIQUE). На сайт не отдаём. */
  const info = db.prepare(`
    INSERT INTO users (email, password_hash, name, last_name, middle_name, phone, role, phone_verified)
    VALUES (?, ?, ?, ?, ?, ?, 'user', 1)
  `).run(
    em,
    hash,
    String(name || '').trim(),
    String(last || '').trim(),
    String(middle || '').trim(),
    display
  );
  const created = findById(info.lastInsertRowid);
  console.log('User by phone:', display, via || 'otp');
  return created;
}

/** Обновить ФИО + email из «Личные данные». Телефон не меняем. */
function updateProfile(userId, { name, last, middle, email, phone }) {
  const row = findById(userId);
  if (!row) throw Object.assign(new Error('Пользователь не найден'), { status: 404 });

  const cleanName = String(name || '').trim();
  const cleanLast = String(last || '').trim();
  const cleanMiddle = String(middle || '').trim();
  if (!cleanName) throw Object.assign(new Error('Укажите имя'), { status: 400 });
  if (!cleanLast) throw Object.assign(new Error('Укажите фамилию'), { status: 400 });

  let nextEmail = String(email || '').trim().toLowerCase();
  if (!nextEmail || !nextEmail.includes('@') || !nextEmail.includes('.')) {
    throw Object.assign(new Error('Укажите корректный email'), { status: 400 });
  }
  if (isPlaceholderEmail(nextEmail)) {
    throw Object.assign(new Error('Укажите свой email'), { status: 400 });
  }

  const taken = findByEmail(nextEmail);
  if (taken && +taken.id !== +userId) {
    throw Object.assign(new Error('Этот email уже занят'), { status: 409 });
  }

  const cleanPhone = String(phone != null ? phone : row.phone || '').trim();
  const phoneDigits = cleanPhone.replace(/\D/g, '');
  if (cleanPhone && phoneDigits.length < 10) {
    throw Object.assign(new Error('Укажите корректный телефон'), { status: 400 });
  }

  const { normalizePhone } = require('./sms');
  const nextNorm = cleanPhone ? normalizePhone(cleanPhone) : '';
  const prevNorm = row.phone ? normalizePhone(row.phone) : '';
  const phoneChanged = nextNorm !== prevNorm;

  /* Номер, который уже подтверждён в чужом аккаунте, вписать нельзя: это
     и есть способ перехватить чужой вход по телефону. */
  if (phoneChanged && nextNorm) {
    const owner = findByPhone(nextNorm);
    if (owner && +owner.id !== +userId) {
      throw Object.assign(new Error('Этот номер уже привязан к другому аккаунту'), { status: 409 });
    }
  }

  /* Вписанный руками номер — только контакт для курьера. Входить по нему
     и получать коды можно после подтверждения через Telegram, поэтому
     смена номера снимает отметку. Тот же номер — отметка остаётся. */
  db.prepare(`
    UPDATE users
    SET name = ?, last_name = ?, middle_name = ?, email = ?, phone = ?,
        phone_verified = CASE WHEN ? THEN 0 ELSE phone_verified END
    WHERE id = ?
  `).run(cleanName, cleanLast, cleanMiddle, nextEmail, cleanPhone, phoneChanged ? 1 : 0, userId);

  return findById(userId);
}

function cryptoRandomPass() {
  return require('crypto').randomBytes(24).toString('hex');
}

/** Короткий код входа после регистрации через TG-контакт (кнопка в боте). */
function issueTgPhoneToken(phone, chatId) {
  const { normalizePhone } = require('./sms');
  const p = normalizePhone(phone);
  if (!p) throw Object.assign(new Error('Некорректный номер'), { status: 400 });

  const full = jwt.sign(
    { purpose: 'tg-phone', phone: p, chatId: String(chatId || '') },
    JWT_SECRET(),
    { algorithm: 'HS256', expiresIn: '15m' }
  );

  /* короткий код — длинный JWT в URL-кнопке Telegram часто ломает отправку */
  const fs = require('fs');
  const path = require('path');
  const { DATA_DIR } = require('./db');
  const file = path.join(DATA_DIR, 'tg-phone-codes.json');
  const code = require('crypto').randomBytes(16).toString('hex');
  let map = {};
  try { map = JSON.parse(fs.readFileSync(file, 'utf8')) || {}; } catch (_) {}
  const now = Date.now();
  for (const [k, v] of Object.entries(map)) {
    if (!v || now > (v.exp || 0)) delete map[k];
  }
  map[code] = { token: full, at: now, exp: now + 15 * 60 * 1000 };
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(map), 'utf8');
  return code;
}

function redeemTgPhoneToken(token) {
  let raw = String(token || '').trim();
  if (!raw) {
    throw Object.assign(new Error('Ссылка устарела — откройте снова из бота'), { status: 401 });
  }

  if (/^[a-f0-9]{32}$/i.test(raw)) {
    const fs = require('fs');
    const path = require('path');
    const { DATA_DIR } = require('./db');
    const file = path.join(DATA_DIR, 'tg-phone-codes.json');
    let map = {};
    try { map = JSON.parse(fs.readFileSync(file, 'utf8')) || {}; } catch (_) {}
    const code = raw;
    const row = map[code];
    if (!row || !row.token || Date.now() > (row.exp || 0)) {
      throw Object.assign(new Error('Ссылка устарела — откройте снова из бота'), { status: 401 });
    }
    raw = row.token;
    delete map[code];
    try { fs.writeFileSync(file, JSON.stringify(map), 'utf8'); } catch (_) {}
  }

  let payload;
  try {
    payload = jwt.verify(raw, JWT_SECRET(), JWT_VERIFY);
  } catch (_) {
    throw Object.assign(new Error('Ссылка устарела — откройте снова из бота'), { status: 401 });
  }
  if (!payload || payload.purpose !== 'tg-phone' || !payload.phone) {
    throw Object.assign(new Error('Неверная ссылка'), { status: 401 });
  }
  const user = upsertUserByPhone({ phone: payload.phone, via: 'telegram' });
  return linkOwnerChat(payload.chatId, user, payload.phone);
}

/** Выдать / снять роль admin у пользователя сайта. */
function setUserRole(userId, role) {
  const id = +userId;
  if (!id) return null;
  const r = role === 'admin' ? 'admin' : 'user';
  const row = findById(id);
  if (!row) return null;
  if (row.role === r) return row;
  db.prepare(`UPDATE users SET role = ? WHERE id = ?`).run(r, id);
  return findById(id);
}

function promoteUserToAdmin(userId) {
  return setUserRole(userId, 'admin');
}

/**
 * Привязать чат Telegram к аккаунту и, если это админ магазина, сразу выдать
 * роль admin. Без этого первый вход через бота создавал обычного
 * пользователя, и админка появлялась только после следующего /start.
 *
 * Признаком админа считаем ДВА независимых источника, оба приходят от самого
 * Telegram, а не из тела запроса:
 *   - chat_id в списке владельцев бота;
 *   - номер телефона в ADMIN_PHONES.
 *
 * verifiedPhone — номер, который только что подтвердил Telegram в этом же
 * входе. Брать user.phone из БД нельзя: его можно поменять в «Личных
 * данных», и тогда любой покупатель, вписавший себе номер админа, получил бы
 * права. По той же причине привязка чата засчитывается только при статусе
 * ok / already_same: если чат уже занят другим аккаунтом, tryLink ничего не
 * пишет, и повышать вошедшего нельзя.
 */
function linkOwnerChat(chatId, user, verifiedPhone) {
  if (!user || !user.id) return user;
  const id = String(chatId || '');
  let linked = false;
  if (id) {
    try {
      const r = require('./tg-users').tryLink(id, {}, user.id);
      linked = r && (r.status === 'ok' || r.status === 'already_same');
      if (!linked && r && r.status) {
        console.warn('TG link skipped:', r.status, 'chat', id, 'user', user.id);
      }
    } catch (e) {
      console.warn('TG link:', e.message);
    }
  }
  try {
    const { isOwnerChat, isOwnerPhone } = require('./tg-owner');
    const byChat = linked && isOwnerChat(id);
    const byPhone = verifiedPhone != null && isOwnerPhone(verifiedPhone);
    if ((byChat || byPhone) && user.role !== 'admin') {
      const promoted = promoteUserToAdmin(user.id);
      if (promoted) {
        console.log('Telegram admin →', promoted.email, byChat ? '(chat ' + id + ')' : '(по номеру)');
        return promoted;
      }
    }
  } catch (e) {
    console.warn('TG admin promote:', e.message);
  }
  return user;
}

module.exports = {
  signUser,
  publicUser,
  register,
  login,
  authOptional,
  authRequired,
  adminRequired,
  setAuthCookie,
  clearAuthCookie,
  findByEmail,
  findById,
  findByPhone,
  findByGoogleId,
  upsertUserByPhone,
  upsertGoogleUser,
  updateProfile,
  setUserRole,
  promoteUserToAdmin,
  linkOwnerChat,
  ensureAdminUser,
  issueTgAdminToken,
  redeemTgAdminToken,
  issueTgPhoneToken,
  redeemTgPhoneToken,
  isPlaceholderEmail,
  COOKIE
};
