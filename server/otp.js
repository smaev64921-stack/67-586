/**
 * Вход через Telegram-бота.
 *
 * A) сайт → номер → бот → код (phone OTP)
 * B) сайт «нет TG на устройстве» → в боте «Вход по коду» → 4 цифры на сайте
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DATA_DIR } = require('./db');
const { normalizePhone } = require('./sms');

const FILE = path.join(DATA_DIR, 'otp-codes.json');
const TTL_MS = 10 * 60 * 1000;
const DEVICE_TTL_MS = 2 * 60 * 1000; /* вход с другого устройства — 2 минуты */
const COOLDOWN_MS = 20 * 1000;

function load() {
  try {
    return JSON.parse(fs.readFileSync(FILE, 'utf8')) || { byPhone: {}, bySession: {}, byDeviceCode: {} };
  } catch (_) {
    return { byPhone: {}, bySession: {}, byDeviceCode: {} };
  }
}
function saveData(data) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(data, null, 2), 'utf8');
}

function genCode() {
  return String(crypto.randomInt(0, 10000)).padStart(4, '0');
}
function genSession() {
  return crypto.randomBytes(4).toString('hex');
}

function botToken() {
  return String(
    process.env.TELEGRAM_BOT_TOKEN ||
    process.env.BOT_TOKEN ||
    process.env.API_TOKEN ||
    ''
  ).trim();
}

async function resolveBotUsername() {
  const cached = String(process.env.TELEGRAM_BOT_USERNAME || '').replace(/^@/, '').trim();
  if (cached) return cached;
  const token = botToken();
  if (!token) return '';
  try {
    const r = await fetch(`https://api.telegram.org/bot${token}/getMe`);
    const d = await r.json().catch(() => ({}));
    const u = (d.result && d.result.username) || '';
    if (u) process.env.TELEGRAM_BOT_USERNAME = u;
    return u;
  } catch (_) {
    return '';
  }
}

async function botDeepLink(session) {
  const u = await resolveBotUsername();
  if (!u) return '';
  return `tg://resolve?domain=${u}&start=c${session}`;
}

function pruneDeviceCodes(data) {
  if (!data.byDeviceCode) data.byDeviceCode = {};
  if (!data.byDevicePending) data.byDevicePending = {};
  const now = Date.now();
  for (const [k, v] of Object.entries(data.byDeviceCode)) {
    if (!v || now > (v.expiresAt || 0)) delete data.byDeviceCode[k];
  }
  for (const [k, v] of Object.entries(data.byDevicePending)) {
    if (!v) {
      delete data.byDevicePending[k];
      continue;
    }
    /* держим expired ещё 30 мин — чтобы бот мог показать «запросить ещё раз» */
    const soft = (v.expiresAt || 0) + 30 * 60 * 1000;
    if (now > soft) delete data.byDevicePending[k];
    else if (now > (v.expiresAt || 0) && v.status !== 'expired') {
      v.status = 'expired';
    }
  }
}

const SMS_LOGIN_TTL_MS = 5 * 60 * 1000; /* если когда-нибудь снова SMS */

/**
 * Сайт: вход по коду через Telegram-бота.
 * Номер помечается как «ждёт код» на 2 минуты.
 */
async function requestDeviceLogin(rawPhone, opts = {}) {
  const { authLog } = require('./auth-log');
  const { hit } = require('./rate-limit');
  const phone = normalizePhone(rawPhone);
  if (!phone) throw Object.assign(new Error('Введите номер +7…'), { status: 400 });
  if (!botToken()) {
    throw Object.assign(new Error('Бот не настроен (TELEGRAM_BOT_TOKEN)'), { status: 503 });
  }

  const ip = opts.ip || '';
  if (ip) {
    const lim = hit('device-req-ip', ip, { limit: 20, windowMs: 15 * 60 * 1000, label: 'Слишком много запросов кода' });
    if (!lim.ok) throw Object.assign(new Error(lim.error), { status: 429 });
  }
  const phLim = hit('device-req-phone', phone, { limit: 8, windowMs: 60 * 60 * 1000, label: 'Лимит запросов кода на номер' });
  if (!phLim.ok) throw Object.assign(new Error(phLim.error), { status: 429 });

  const data = load();
  if (!data.byDevicePending) data.byDevicePending = {};
  if (!data.byDeviceCode) data.byDeviceCode = {};
  pruneDeviceCodes(data);

  const prev = data.byDevicePending[phone];
  if (prev && prev.requestedAt && Date.now() - prev.requestedAt < COOLDOWN_MS) {
    const wait = Math.ceil((COOLDOWN_MS - (Date.now() - prev.requestedAt)) / 1000);
    authLog('code_request_cooldown', { phone, wait });
    /* Новый код не выдаём, но предыдущий обычно ещё жив. Сообщаем это клиенту:
       иначе он покажет «подождите» и не откроет поле, а вводить-то есть что. */
    const leftMs = Math.max(0, (prev.expiresAt || 0) - Date.now());
    throw Object.assign(new Error(`Подождите ${wait} с`), {
      status: 429,
      payload: {
        cooldown: wait,
        pending: leftMs > 0,
        ttl: Math.ceil(leftMs / 1000),
        digits: 4,
        phone,
        autoSent: !!prev.delivered,
        bot: (await resolveBotUsername()) || ''
      }
    });
  }

  for (const [k, v] of Object.entries(data.byDeviceCode)) {
    if (v && v.phone === phone) delete data.byDeviceCode[k];
  }

  let userId = null;
  try {
    const { findByPhone } = require('./auth');
    const u = findByPhone(phone);
    if (u) userId = u.id;
  } catch (_) {}

  let code = genCode();
  let guard = 0;
  while (data.byDeviceCode[code] && guard < 20) {
    code = genCode();
    guard += 1;
  }

  const now = Date.now();
  const row = {
    phone,
    code,
    status: 'waiting',
    chatId: (prev && prev.chatId) || findChatByPhone(phone) || opts.chatId || null,
    userId: userId || opts.userId || null,
    gotPhoneMsgId: null,
    codeMsgId: (prev && prev.codeMsgId) || null,
    requestedAt: now,
    createdAt: now,
    expiresAt: now + DEVICE_TTL_MS,
    attempts: 0,
    delivered: false,
    via: 'telegram'
  };
  data.byDevicePending[phone] = row;
  data.byDeviceCode[code] = {
    phone,
    chatId: row.chatId,
    userId: row.userId,
    expiresAt: row.expiresAt,
    attempts: 0
  };
  saveData(data);
  authLog('code_request', { phone, chatId: row.chatId || null, via: opts.via || 'site' });

  let autoSent = false;
  if (row.chatId) {
    try {
      const tg = require('./telegram-bot');
      if (typeof tg.upsertDeviceCodeMessage === 'function') {
        const codeMsgId = await tg.upsertDeviceCodeMessage(
          row.chatId,
          code,
          Math.floor(DEVICE_TTL_MS / 1000),
          row.codeMsgId,
          {
            phone,
            scheduleExpire: true,
            isNew: !!(prev && prev.codeMsgId) || opts.via === 'bot_resend'
          }
        );
        if (codeMsgId) {
          autoSent = true;
          pendingFixDelivered(phone);
          setDeviceLoginMsgIds(phone, { codeMsgId });
          authLog('code_issue', { phone, chatId: row.chatId, auto: true });
        }
      }
    } catch (e) {
      console.warn('device auto-send via bot:', e.message);
    }
    if (!autoSent) {
      const msgId = await sendCodeToChat(row.chatId, code);
      if (msgId) {
        autoSent = true;
        pendingFixDelivered(phone);
        setDeviceLoginMsgIds(phone, { codeMsgId: msgId });
        authLog('code_issue', { phone, chatId: row.chatId, auto: true, fallback: true });
      }
    }
  }

  const bot = await resolveBotUsername();
  return {
    ok: true,
    phone,
    ttl: Math.floor(DEVICE_TTL_MS / 1000),
    cooldown: Math.floor(COOLDOWN_MS / 1000),
    digits: 4,
    bot: bot || '',
    waiting: true,
    status: autoSent ? 'delivered' : 'waiting',
    autoSent,
    via: 'telegram',
    needOpenBot: !autoSent,
    code: opts.returnCode ? code : undefined
  };
}

/**
 * Бот: выдать новый код после истечения 2 мин (без повторного запроса на сайте).
 */
async function renewDeviceLoginFromChat({ chatId, userId, phone }) {
  const p = normalizePhone(phone);
  if (!p) throw Object.assign(new Error('Нужен номер'), { status: 400, needContact: true });
  return requestDeviceLogin(p, { chatId: String(chatId || ''), userId, via: 'bot_resend' });
}

function pendingFixDelivered(phone) {
  const data = load();
  const pending = data.byDevicePending && data.byDevicePending[phone];
  if (!pending) return;
  pending.delivered = true;
  pending.status = 'delivered';
  saveData(data);
}

function getDevicePending(rawPhone) {
  const phone = normalizePhone(rawPhone);
  if (!phone) return null;
  const data = load();
  pruneDeviceCodes(data);
  saveData(data);
  return (data.byDevicePending && data.byDevicePending[phone]) || null;
}

/**
 * Бот: выдать код, только если на сайте уже запросили для этого номера.
 */
function deliverDeviceLoginCode({ chatId, userId, phone }) {
  const p = phone ? normalizePhone(phone) : '';
  if (!p) {
    throw Object.assign(new Error('Нужен номер телефона'), { status: 400, needContact: true });
  }

  const data = load();
  if (!data.byDevicePending) data.byDevicePending = {};
  if (!data.byDeviceCode) data.byDeviceCode = {};
  pruneDeviceCodes(data);

  const pending = data.byDevicePending[p];
  if (!pending || !pending.code) {
    throw Object.assign(
      new Error('Сначала запросите код на сайте (Нет Telegram на этом устройстве)'),
      { status: 404, needSiteRequest: true }
    );
  }
  if (Date.now() > (pending.expiresAt || 0)) {
    delete data.byDevicePending[p];
    if (pending.code) delete data.byDeviceCode[pending.code];
    saveData(data);
    throw Object.assign(new Error('Код истёк — запросите новый на сайте'), { status: 400, expired: true });
  }

  pending.chatId = String(chatId || '');
  pending.userId = userId != null ? +userId : pending.userId;
  pending.delivered = true;
  pending.status = 'delivered';

  const codeRow = data.byDeviceCode[pending.code];
  if (codeRow) {
    codeRow.chatId = pending.chatId;
    codeRow.userId = pending.userId;
  }
  saveData(data);

  try {
    require('./auth-log').authLog('code_issue', { phone: p, chatId: pending.chatId, via: 'bot' });
  } catch (_) {}

  return {
    code: pending.code,
    phone: p,
    userId: pending.userId,
    expiresAt: pending.expiresAt,
    ttlLeft: Math.max(0, Math.ceil((pending.expiresAt - Date.now()) / 1000)),
    gotPhoneMsgId: pending.gotPhoneMsgId || null,
    codeMsgId: pending.codeMsgId || null
  };
}

function setDeviceLoginMsgIds(phone, ids = {}) {
  const p = normalizePhone(phone);
  if (!p) return;
  const data = load();
  const pending = data.byDevicePending && data.byDevicePending[p];
  if (!pending) return;
  if (ids.gotPhoneMsgId != null) pending.gotPhoneMsgId = ids.gotPhoneMsgId;
  if (ids.codeMsgId != null) pending.codeMsgId = ids.codeMsgId;
  saveData(data);
}

/**
 * Бот «Вход по коду» (legacy name) — только через pending на сайте.
 */
function issueDeviceLoginCode({ chatId, userId, phone }) {
  return deliverDeviceLoginCode({ chatId, userId, phone });
}

function verifyDeviceLoginCode(rawCode, rawPhone, opts = {}) {
  const { authLog } = require('./auth-log');
  const { hit } = require('./rate-limit');
  const code = String(rawCode || '').replace(/\D/g, '');
  const phone = normalizePhone(rawPhone);
  if (!phone) {
    throw Object.assign(new Error('Укажите номер телефона'), { status: 400 });
  }
  if (code.length !== 4) {
    throw Object.assign(new Error('Введите 4 цифры кода'), { status: 400, wrong: true });
  }

  const ip = opts.ip || '';
  if (ip) {
    const lim = hit('device-verify-ip', ip, {
      limit: 30,
      windowMs: 15 * 60 * 1000,
      label: 'Слишком много попыток входа'
    });
    if (!lim.ok) {
      authLog('login_fail', { phone, reason: 'ip_rate', ip });
      throw Object.assign(new Error(lim.error), { status: 429 });
    }
  }
  const phLim = hit('device-verify-phone', phone, {
    limit: 12,
    windowMs: 15 * 60 * 1000,
    label: 'Слишком много попыток кода'
  });
  if (!phLim.ok) {
    authLog('login_fail', { phone, reason: 'phone_rate' });
    throw Object.assign(new Error(phLim.error), { status: 429 });
  }

  const data = load();
  if (!data.byDeviceCode) data.byDeviceCode = {};
  if (!data.byDevicePending) data.byDevicePending = {};
  pruneDeviceCodes(data);

  const pending = data.byDevicePending[phone];
  const row = data.byDeviceCode[code];

  if (!pending || !row || row.phone !== phone || pending.code !== code) {
    if (pending) {
      pending.attempts = (pending.attempts || 0) + 1;
      if (pending.attempts > 5) {
        if (pending.code) delete data.byDeviceCode[pending.code];
        delete data.byDevicePending[phone];
        saveData(data);
        authLog('login_fail', { phone, reason: 'too_many_attempts' });
        throw Object.assign(new Error('Слишком много попыток — запросите новый код'), { status: 429 });
      }
      saveData(data);
    }
    authLog('login_fail', { phone, reason: 'wrong_code' });
    throw Object.assign(new Error('Неверный код'), { status: 400, wrong: true });
  }

  if (Date.now() > (row.expiresAt || pending.expiresAt || 0) || pending.status === 'expired') {
    pending.status = 'expired';
    delete data.byDeviceCode[code];
    saveData(data);
    authLog('login_fail', { phone, reason: 'expired' });
    throw Object.assign(new Error('Код истёк — запросите новый'), { status: 400, expired: true });
  }

  const meta = {
    ok: true,
    phone,
    userId: pending.userId || row.userId || null,
    chatId: pending.chatId || row.chatId || null,
    gotPhoneMsgId: pending.gotPhoneMsgId || null,
    codeMsgId: pending.codeMsgId || null
  };

  delete data.byDeviceCode[code];
  delete data.byDevicePending[phone];
  saveData(data);
  authLog('login_ok', { phone, chatId: meta.chatId || null, via: 'device-code' });
  return meta;
}

async function sendCodeToChat(chatId, code) {
  const token = botToken();
  if (!token || !chatId) return null;
  const text = [
    '<b>Вход по коду</b>',
    '',
    `Ваш код: <code>${code}</code>`,
    '',
    'Введите эти 4 цифры на сайте.',
    '',
    '<i>Ваши данные хранятся на аккаунте, с которого вы запросили вход.</i>',
    '',
    'Код действует 2 мин. Никому его не сообщайте.'
  ].join('\n');
  try {
    const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: 'HTML'
      })
    });
    const data = await r.json().catch(() => ({}));
    if (data && data.ok && data.result && data.result.message_id) {
      return data.result.message_id;
    }
    return null;
  } catch (e) {
    console.error('OTP bot send:', e.message);
    return null;
  }
}

function findChatByPhone(phone) {
  const p = normalizePhone(phone);
  if (!p) return '';
  try {
    const { findByPhone } = require('./auth');
    const { findLinkByUser } = require('./tg-users');
    const user = findByPhone(p);
    if (user) {
      const link = findLinkByUser(user.id, user.email);
      if (link && link.chatId) return String(link.chatId);
    }
  } catch (_) {}
  const data = load();
  const row = data.byPhone && data.byPhone[p];
  if (row && row.chatId) return String(row.chatId);
  return '';
}

function getRow(phone) {
  const data = load();
  return (data.byPhone && data.byPhone[phone]) || null;
}

async function startPhoneAuth(rawPhone) {
  const phone = normalizePhone(rawPhone);
  if (!phone) throw Object.assign(new Error('Введите номер +7…'), { status: 400 });
  if (!botToken()) {
    throw Object.assign(new Error('Бот не настроен (TELEGRAM_BOT_TOKEN)'), { status: 503 });
  }

  const data = load();
  if (!data.byPhone) data.byPhone = {};
  if (!data.bySession) data.bySession = {};

  const prev = data.byPhone[phone];
  if (prev && prev.session && data.bySession[prev.session]) {
    delete data.bySession[prev.session];
  }

  const code = genCode();
  const session = genSession();
  const knownChat = findChatByPhone(phone) || (prev && prev.chatId) || null;

  data.byPhone[phone] = {
    code,
    session,
    attempts: 0,
    sentAt: 0,
    createdAt: Date.now(),
    expiresAt: Date.now() + TTL_MS,
    chatId: knownChat,
    linked: !!knownChat,
    delivered: false,
    via: null
  };
  data.bySession[session] = phone;
  saveData(data);

  const bot = await resolveBotUsername();
  const deepLink = await botDeepLink(session);

  return {
    ok: true,
    phone,
    session,
    ttl: Math.floor(TTL_MS / 1000),
    digits: 4,
    bot: bot || '',
    deepLink: deepLink || (bot ? `tg://resolve?domain=${bot}` : ''),
    linked: !!knownChat,
    needOpenBot: !knownChat,
    via: 'telegram-bot'
  };
}

async function linkOtpSession(session, chatId) {
  const sid = String(session || '').replace(/^c/i, '').trim().toLowerCase();
  if (!sid) return { ok: false, error: 'Сессия не найдена' };

  const data = load();
  const phone = data.bySession && data.bySession[sid];
  if (!phone) return { ok: false, error: 'Код устарел — вернитесь на сайт и начните снова' };

  const row = data.byPhone[phone];
  if (!row || Date.now() > row.expiresAt) {
    return { ok: false, error: 'Сессия истекла — начните вход на сайте заново' };
  }

  row.chatId = String(chatId);
  row.linked = true;
  saveData(data);
  return { ok: true, phone, linked: true };
}

async function deliverOtpBySession(session, chatId) {
  return linkOtpSession(session, chatId);
}

async function sendPhoneCode(rawPhone) {
  const phone = normalizePhone(rawPhone);
  if (!phone) throw Object.assign(new Error('Введите номер +7…'), { status: 400 });

  const data = load();
  const row = data.byPhone && data.byPhone[phone];
  if (!row) {
    throw Object.assign(new Error('Сначала укажите номер на сайте'), { status: 400 });
  }
  if (Date.now() > row.expiresAt) {
    throw Object.assign(new Error('Сессия истекла — начните снова'), { status: 400 });
  }
  if (row.sentAt && Date.now() - row.sentAt < COOLDOWN_MS) {
    const wait = Math.ceil((COOLDOWN_MS - (Date.now() - row.sentAt)) / 1000);
    throw Object.assign(new Error(`Подождите ${wait} с`), { status: 429 });
  }

  let chatId = row.chatId || findChatByPhone(phone);
  if (!chatId) {
    throw Object.assign(
      new Error('Сначала откройте бота по кнопке и нажмите Start'),
      { status: 409, needOpenBot: true }
    );
  }

  row.code = genCode();
  row.attempts = 0;
  const sent = await sendCodeToChat(chatId, row.code);
  if (!sent) {
    throw Object.assign(new Error('Не удалось отправить код в Telegram'), { status: 502 });
  }

  row.chatId = String(chatId);
  row.linked = true;
  row.delivered = true;
  row.sentAt = Date.now();
  row.via = 'telegram-bot';
  row.expiresAt = Date.now() + TTL_MS;
  saveData(data);

  const out = {
    ok: true,
    phone,
    delivered: true,
    linked: true,
    via: 'telegram-bot',
    ttl: Math.floor(TTL_MS / 1000)
  };
  if (process.env.SMS_DEV === '1' || process.env.SMS_DEV === 'true') {
    out.devCode = row.code;
    console.log(`[OTP DEV] +${phone} → ${row.code}`);
  }
  return out;
}

function phoneAuthStatus(rawPhone) {
  const phone = normalizePhone(rawPhone);
  if (!phone) return { ok: false, linked: false };
  const row = getRow(phone);
  if (!row || Date.now() > row.expiresAt) {
    return { ok: false, linked: false, expired: true };
  }
  return {
    ok: true,
    linked: !!(row.linked && row.chatId),
    delivered: !!row.delivered,
    phone
  };
}

function verifyOtp(rawPhone, rawCode) {
  const phone = normalizePhone(rawPhone);
  const code = String(rawCode || '').replace(/\D/g, '');
  if (!phone) throw Object.assign(new Error('Некорректный номер'), { status: 400 });
  if (code.length !== 4) throw Object.assign(new Error('Введите 4 цифры кода'), { status: 400 });

  const data = load();
  const row = data.byPhone && data.byPhone[phone];
  if (!row) throw Object.assign(new Error('Сначала запросите код'), { status: 400 });
  if (Date.now() > row.expiresAt) {
    if (row.session && data.bySession) delete data.bySession[row.session];
    delete data.byPhone[phone];
    saveData(data);
    throw Object.assign(new Error('Код истёк — запросите новый'), { status: 400 });
  }
  if (!row.delivered) {
    throw Object.assign(new Error('Сначала нажмите «Отправить код»'), { status: 400 });
  }
  row.attempts = (row.attempts || 0) + 1;
  if (row.attempts > 5) {
    if (row.session && data.bySession) delete data.bySession[row.session];
    delete data.byPhone[phone];
    saveData(data);
    throw Object.assign(new Error('Слишком много попыток — запросите новый код'), { status: 429 });
  }
  if (row.code !== code) {
    saveData(data);
    throw Object.assign(new Error('Неверный код'), { status: 400, wrong: true });
  }

  const chatId = row.chatId || null;
  if (row.session && data.bySession) delete data.bySession[row.session];
  delete data.byPhone[phone];
  saveData(data);

  return { phone, ok: true, chatId };
}

async function requestOtp(rawPhone) {
  return startPhoneAuth(rawPhone);
}

module.exports = {
  startPhoneAuth,
  sendPhoneCode,
  phoneAuthStatus,
  linkOtpSession,
  deliverOtpBySession,
  verifyOtp,
  requestOtp,
  requestDeviceLogin,
  renewDeviceLoginFromChat,
  deliverDeviceLoginCode,
  issueDeviceLoginCode,
  verifyDeviceLoginCode,
  setDeviceLoginMsgIds,
  getDevicePending,
  DEVICE_TTL_MS,
  FILE
};
