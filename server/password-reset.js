/**
 * Сброс пароля.
 *
 * Два пути от одного письма, и оба ведут в одну запись:
 *   1) «Получить код» на странице /reset — 6 цифр вводятся руками на сайте
 *      (нужен, когда почта открыта на телефоне, а сайт — на компьютере);
 *   2) «Перейти на сайт» — страница меняет токен из письма на одноразовый
 *      билет, сайт проверяет его сам и сразу просит новый пароль.
 *
 * Кода в самом письме нет: он выдаётся только по нажатию на странице. Так
 * подсмотренный из-за плеча предпросмотр письма ничего не даёт.
 * Telegram — исключение: там переписка и так за паролем устройства.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { DATA_DIR, db } = require('./db');
const { findByEmail, findById, isPlaceholderEmail } = require('./auth');
const { findLinkByUser } = require('./tg-users');
const { smtpConfigured, sendMail } = require('./mail');
const { resetEmail } = require('./mail-templates');
const { isValidPublicHttps } = require('./public-url');

const FILE = path.join(DATA_DIR, 'password-resets.json');
const TTL_MS = 20 * 60 * 1000;
const TTL_MIN = Math.round(TTL_MS / 60000);
/* Билет живёт меньше ссылки: его уже держит открытая вкладка сайта. */
const TICKET_TTL_MS = 15 * 60 * 1000;
const MAX_CODE_TRIES = 8;
/* Сколько раз можно показать код по одной ссылке — от перебора чужой ссылки */
const MAX_REVEALS = 5;

function load() {
  try { return JSON.parse(fs.readFileSync(FILE, 'utf8')) || {}; }
  catch (_) { return {}; }
}
function save(map) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(map, null, 2), 'utf8');
}

/** Просроченные записи не должны лежать в файле годами. */
function sweep(map) {
  const now = Date.now();
  let dirty = false;
  for (const key of Object.keys(map)) {
    if (!map[key] || now > (map[key].exp || 0)) {
      delete map[key];
      dirty = true;
    }
  }
  return dirty;
}

function genCode() {
  return String(crypto.randomInt(0, 1000000)).padStart(6, '0');
}
function genToken() {
  return crypto.randomBytes(24).toString('base64url');
}

/** Сравнение секретов без утечки времени. */
function sameSecret(a, b) {
  const x = Buffer.from(String(a || ''), 'utf8');
  const y = Buffer.from(String(b || ''), 'utf8');
  if (!x.length || x.length !== y.length) return false;
  return crypto.timingSafeEqual(x, y);
}

/** k****v@mail.ru — на странице должно быть видно, о чьём аккаунте речь. */
function maskEmail(email) {
  const s = String(email || '');
  const at = s.indexOf('@');
  if (at < 1) return s;
  const name = s.slice(0, at);
  const dom = s.slice(at);
  if (name.length <= 2) return name[0] + '*'.repeat(3) + dom;
  return name[0] + '*'.repeat(Math.min(6, name.length - 2)) + name[name.length - 1] + dom;
}

function siteUrl() {
  const raw = String(process.env.PUBLIC_URL || '').replace(/\/$/, '');
  return raw;
}
/** Ссылка из письма имеет смысл только на реальном HTTPS-домене. */
function resetLink(token) {
  const base = siteUrl();
  if (!isValidPublicHttps(base)) return '';
  return `${base}/reset?t=${encodeURIComponent(token)}`;
}

/**
 * Логотип для шапки письма. Прикладываем файлом (cid:), а не ссылкой:
 * внешние картинки Gmail и Outlook по умолчанию не грузят, и шапка была бы
 * пустой. Знак белый — фон шапки чёрный. Файла нет → письмо просто
 * нарисует текстовую надпись, ничего не сломается.
 */
const LOGO_CID = 'brandmark';
let logoCache;
function logoAttachment() {
  if (logoCache !== undefined) return logoCache;
  try {
    const p = path.join(__dirname, '..', 'public', 'logo-white.png');
    logoCache = [{
      filename: 'logo.png',
      content: fs.readFileSync(p),
      contentType: 'image/png',
      cid: LOGO_CID
    }];
  } catch (_) {
    logoCache = null;
  }
  return logoCache;
}

function brandName() {
  try {
    const row = db.prepare('SELECT data_json FROM cms WHERE id = 1').get();
    const cms = row && row.data_json ? JSON.parse(row.data_json) : null;
    const n = cms && cms.brand && String(cms.brand.name || '').trim();
    if (n) return n;
  } catch (_) {}
  return 'Canvas';
}

/** Записи лежат по email — ищем по секрету перебором, их всегда единицы. */
function findBy(map, field, value) {
  if (!value) return null;
  for (const email of Object.keys(map)) {
    const row = map[email];
    if (row && sameSecret(row[field], value)) return { email, row };
  }
  return null;
}

function expired(row) {
  return !row || Date.now() > (row.exp || 0);
}

async function sendTelegramCode(chatId, code, link) {
  const telegramBot = require('./telegram-bot');
  if (!telegramBot.configured() || !chatId) return false;
  try {
    const lines = [
      `<b>Смена пароля ${brandName()}</b>`,
      '',
      `Код: <code>${code}</code>`,
      '',
      `Действует ${TTL_MIN} минут. Введите его на сайте вместе с новым паролем.`,
      'Если это были не вы — просто не отвечайте, пароль останется прежним.'
    ];
    const markup = link
      ? { inline_keyboard: [[{ text: 'Сменить пароль', url: link }]] }
      : undefined;
    await telegramBot.sendText(chatId, lines.join('\n'), markup);
    return true;
  } catch (e) {
    console.error('password reset TG:', e.message);
    return false;
  }
}

/**
 * @returns {{ ok:true, via:string[], email:string, deepLink?:string }}
 */
async function requestPasswordReset(rawEmail) {
  const email = String(rawEmail || '').trim().toLowerCase();
  if (!email.includes('@') || isPlaceholderEmail(email)) {
    throw Object.assign(new Error('Укажите email аккаунта'), { status: 400 });
  }

  const user = findByEmail(email);
  /* не палим, есть ли аккаунт — но для UX честнее сказать если нет */
  if (!user) {
    throw Object.assign(new Error('Аккаунт с таким email не найден'), { status: 404 });
  }

  const link = findLinkByUser(user.id, user.email);
  const chatId = link && link.chatId ? String(link.chatId) : '';
  const canSmtp = smtpConfigured();

  if (!chatId && !canSmtp) {
    throw Object.assign(
      new Error('Сброс пароля: подключите Telegram в «Уведомления» или настройте SMTP на сервере'),
      { status: 503, needTelegram: true }
    );
  }

  const code = genCode();
  const token = genToken();
  const url = resetLink(token);
  const map = load();
  sweep(map);
  map[email] = {
    userId: user.id,
    code,
    token,
    attempts: 0,
    reveals: 0,
    ticket: '',
    ticketExp: 0,
    at: Date.now(),
    exp: Date.now() + TTL_MS
  };
  save(map);

  const via = [];
  if (chatId) {
    const ok = await sendTelegramCode(chatId, code, url);
    if (ok) via.push('telegram');
  }
  let mailErr = '';
  if (canSmtp) {
    try {
      const brand = brandName();
      /* Без публичного домена ссылка из письма никуда не ведёт — тогда
         единственный рабочий вариант это код прямо в письме. */
      const logo = logoAttachment();
      const mail = resetEmail({
        brand,
        link: url,
        code: url ? '' : code,
        ttlMin: TTL_MIN,
        siteUrl: isValidPublicHttps(siteUrl()) ? siteUrl() : '',
        logoCid: logo ? LOGO_CID : ''
      });
      await sendMail({
        to: email,
        brand,
        subject: mail.subject,
        text: mail.text,
        html: mail.html,
        attachments: logo || undefined
      });
      via.push('email');
    } catch (e) {
      mailErr = e.message || '';
      console.error('password reset mail:', mailErr);
    }
  }

  if (!via.length) {
    /* Владельцу магазина настоящая причина нужна в логах, а покупателю —
       понятный следующий шаг: бот ему не поможет, если почта сломана. */
    if (mailErr) console.error('ПОЧТА НЕ РАБОТАЕТ · сброс пароля не отправлен:', mailErr);
    throw Object.assign(
      new Error(
        chatId
          ? 'Не удалось отправить код. Попробуйте ещё раз через минуту.'
          : 'Письмо не отправилось. Войдите через Telegram или напишите нам — поможем вручную.'
      ),
      { status: 502 }
    );
  }

  const out = { ok: true, via, email, link: !!url };
  if (via.includes('telegram') && !via.includes('email')) {
    const bot = require('./telegram-bot').botUsername();
    if (bot) out.deepLink = `tg://resolve?domain=${bot}`;
  }
  return out;
}

function badLink() {
  return Object.assign(new Error('Ссылка устарела — запросите смену пароля заново'), { status: 410 });
}

/** Страница /reset при загрузке: чей это аккаунт и сколько осталось времени. */
function openResetLink(token) {
  const map = load();
  const found = findBy(map, 'token', String(token || ''));
  if (!found || expired(found.row)) throw badLink();
  return {
    ok: true,
    brand: brandName(),
    emailMask: maskEmail(found.email),
    expiresAt: found.row.exp,
    ttlMin: TTL_MIN,
    site: siteUrl()
  };
}

/** Кнопка «Получить код» — код отдаём только здесь и только по ссылке. */
function revealCode(token) {
  const map = load();
  const found = findBy(map, 'token', String(token || ''));
  if (!found || expired(found.row)) throw badLink();
  found.row.reveals = (found.row.reveals || 0) + 1;
  if (found.row.reveals > MAX_REVEALS) {
    delete map[found.email];
    save(map);
    throw Object.assign(new Error('Код показан слишком много раз — запросите смену пароля заново'), { status: 429 });
  }
  save(map);
  return {
    ok: true,
    code: found.row.code,
    emailMask: maskEmail(found.email),
    expiresAt: found.row.exp
  };
}

/** Кнопка «Перейти на сайт» — одноразовый билет вместо ручного кода. */
function issueTicket(token) {
  const map = load();
  const found = findBy(map, 'token', String(token || ''));
  if (!found || expired(found.row)) throw badLink();
  const ticket = genToken();
  found.row.ticket = ticket;
  found.row.ticketExp = Math.min(found.row.exp, Date.now() + TICKET_TTL_MS);
  save(map);
  return { ok: true, ticket, site: siteUrl(), emailMask: maskEmail(found.email) };
}

/** Сайт спрашивает: этот билет ещё живой и чей он? Билет не тратим. */
function checkTicket(ticket) {
  const map = load();
  const found = findBy(map, 'ticket', String(ticket || ''));
  if (!found || expired(found.row) || Date.now() > (found.row.ticketExp || 0)) throw badLink();
  return {
    ok: true,
    email: found.email,
    emailMask: maskEmail(found.email),
    expiresAt: Math.min(found.row.exp, found.row.ticketExp)
  };
}

function applyNewPassword(map, email, row, password) {
  const pass = String(password || '');
  if (pass.length < 6) throw Object.assign(new Error('Пароль минимум 6 символов'), { status: 400 });
  const hash = bcrypt.hashSync(pass, 10);
  db.prepare(`UPDATE users SET password_hash = ? WHERE id = ?`).run(hash, row.userId);
  delete map[email];
  save(map);
  return findById(row.userId);
}

/**
 * Сохранение нового пароля. Либо билетом со страницы письма, либо парой
 * email + код, введённая руками.
 */
function resetPassword({ email: rawEmail, code: rawCode, ticket, password }) {
  const map = load();

  if (ticket) {
    const found = findBy(map, 'ticket', String(ticket));
    if (!found || expired(found.row) || Date.now() > (found.row.ticketExp || 0)) throw badLink();
    return applyNewPassword(map, found.email, found.row, password);
  }

  const email = String(rawEmail || '').trim().toLowerCase();
  const code = String(rawCode || '').replace(/\D/g, '');
  if (!email.includes('@')) throw Object.assign(new Error('Укажите email'), { status: 400 });
  if (code.length < 4) throw Object.assign(new Error('Введите код'), { status: 400 });
  if (String(password || '').length < 6) {
    throw Object.assign(new Error('Пароль минимум 6 символов'), { status: 400 });
  }

  const row = map[email];
  if (!row) throw Object.assign(new Error('Сначала запросите код'), { status: 400 });
  if (expired(row)) {
    delete map[email];
    save(map);
    throw Object.assign(new Error('Код истёк — запросите новый'), { status: 400 });
  }
  row.attempts = (row.attempts || 0) + 1;
  if (row.attempts > MAX_CODE_TRIES) {
    delete map[email];
    save(map);
    throw Object.assign(new Error('Слишком много попыток'), { status: 429 });
  }
  if (!sameSecret(row.code, code)) {
    save(map);
    throw Object.assign(new Error('Неверный код'), { status: 400 });
  }

  return applyNewPassword(map, email, row, password);
}

module.exports = {
  requestPasswordReset,
  resetPassword,
  openResetLink,
  revealCode,
  issueTicket,
  checkTicket,
  smtpConfigured
};
