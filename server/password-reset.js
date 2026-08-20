/**
 * Сброс пароля: код в Telegram (если чат привязан) и/или email (если SMTP).
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { DATA_DIR, db } = require('./db');
const { findByEmail, findById, isPlaceholderEmail } = require('./auth');
const { findLinkByUser } = require('./tg-users');
const { smtpConfigured, sendMail } = require('./mail');

const FILE = path.join(DATA_DIR, 'password-resets.json');
const TTL_MS = 20 * 60 * 1000;

function load() {
  try { return JSON.parse(fs.readFileSync(FILE, 'utf8')) || {}; }
  catch (_) { return {}; }
}
function save(map) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(map, null, 2), 'utf8');
}

function genCode() {
  return String(crypto.randomInt(0, 1000000)).padStart(6, '0');
}

async function sendTelegramCode(chatId, code) {
  const telegramBot = require('./telegram-bot');
  if (!telegramBot.configured() || !chatId) return false;
  try {
    await telegramBot.sendText(chatId, [
      '<b>Сброс пароля Canvas</b>',
      '',
      `Код: <code>${code}</code>`,
      '',
      'Введите его на сайте вместе с новым паролем.',
      'Никому не сообщайте код.'
    ].join('\n'));
    return true;
  } catch (e) {
    console.error('password reset TG:', e.message);
    return false;
  }
}

/**
 * @returns {{ ok:true, via:string[], deepLink?:string }}
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
  const map = load();
  map[email] = {
    userId: user.id,
    code,
    attempts: 0,
    at: Date.now(),
    exp: Date.now() + TTL_MS
  };
  save(map);

  const via = [];
  if (chatId) {
    const ok = await sendTelegramCode(chatId, code);
    if (ok) via.push('telegram');
  }
  if (canSmtp) {
    try {
      await sendMail({
        to: email,
        subject: 'Сброс пароля Canvas',
        text: `Код для сброса пароля: ${code}\n\nДействует 20 минут. Если это не вы — просто игнорируйте письмо.`
      });
      via.push('email');
    } catch (e) {
      console.error('password reset mail:', e.message);
    }
  }

  if (!via.length) {
    throw Object.assign(
      new Error('Не удалось отправить код. Подключите бота в «Уведомления» и попробуйте снова.'),
      { status: 502 }
    );
  }

  const out = { ok: true, via, email };
  if (via.includes('telegram') && !via.includes('email')) {
    const bot = require('./telegram-bot').botUsername();
    if (bot) out.deepLink = `tg://resolve?domain=${bot}`;
  }
  return out;
}

function resetPassword({ email: rawEmail, code: rawCode, password }) {
  const email = String(rawEmail || '').trim().toLowerCase();
  const code = String(rawCode || '').replace(/\D/g, '');
  const pass = String(password || '');
  if (!email.includes('@')) throw Object.assign(new Error('Укажите email'), { status: 400 });
  if (code.length < 4) throw Object.assign(new Error('Введите код'), { status: 400 });
  if (pass.length < 6) throw Object.assign(new Error('Пароль минимум 6 символов'), { status: 400 });

  const map = load();
  const row = map[email];
  if (!row) throw Object.assign(new Error('Сначала запросите код'), { status: 400 });
  if (Date.now() > row.exp) {
    delete map[email];
    save(map);
    throw Object.assign(new Error('Код истёк — запросите новый'), { status: 400 });
  }
  row.attempts = (row.attempts || 0) + 1;
  if (row.attempts > 8) {
    delete map[email];
    save(map);
    throw Object.assign(new Error('Слишком много попыток'), { status: 429 });
  }
  if (String(row.code) !== code) {
    save(map);
    throw Object.assign(new Error('Неверный код'), { status: 400 });
  }

  const hash = bcrypt.hashSync(pass, 10);
  db.prepare(`UPDATE users SET password_hash = ? WHERE id = ?`).run(hash, row.userId);
  delete map[email];
  save(map);
  return findById(row.userId);
}

module.exports = {
  requestPasswordReset,
  resetPassword,
  smtpConfigured
};
