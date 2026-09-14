/* ==========================================================
   СЕКРЕТ СЕРВЕРА

   Раньше подпись сессий брала process.env.JWT_SECRET, а если его нет —
   строку 'dev-only-change-me' прямо из кода. Код лежит в открытом
   репозитории, поэтому любой мог подписать себе токен с id админа и
   войти в админку без пароля. Вебхук бота падал на ту же цепочку
   и дальше на литерал 'luxe-canvas-tg'.

   Теперь публичных запасных строк нет вовсе:
     — задан сильный JWT_SECRET — берём его, ничего не меняется;
     — не задан или это заглушка из .env.example — сервер один раз
       заводит случайный секрет в data/server-secret и дальше живёт
       с ним. Все, кто был в аккаунте, при этом один раз выйдут —
       и вместе с ними любой, кто успел подделать токен.

   Так же уже устроены ключи push-уведомлений (data/vapid.json).
   ========================================================== */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const FILE = path.join(DATA_DIR, 'server-secret');

/* Значения, которые уже опубликованы — в коде, в .env.example, в истории
   git. Подписывать ими что-либо — то же, что не подписывать вовсе. */
const PUBLIC_VALUES = new Set([
  'dev-only-change-me',
  'change-me-to-a-long-random-string',
  'luxe-canvas-tg',
  'change-me-telegram-webhook-secret',
  'changeme123!'
]);

function strong(v) {
  const s = String(v || '').trim();
  if (s.length < 32) return false;
  if (PUBLIC_VALUES.has(s.toLowerCase())) return false;
  return true;
}

let cached = '';
let warned = false;

function serverSecret() {
  if (cached) return cached;

  const env = String(process.env.JWT_SECRET || '').trim();
  if (strong(env)) { cached = env; return cached; }

  if (env && !warned) {
    warned = true;
    console.warn('JWT_SECRET слабый или опубликован — использую свой случайный секрет из data/server-secret');
  }

  try {
    const s = fs.readFileSync(FILE, 'utf8').trim();
    if (strong(s)) { cached = s; return cached; }
  } catch (_) { /* файла ещё нет — заведём */ }

  const s = crypto.randomBytes(48).toString('hex');
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(FILE, s, { mode: 0o600 });
    console.log('Секрет сервера заведён заново: все сессии начнутся с чистого листа');
  } catch (e) {
    /* Не записался — живём с ним до перезапуска. Хуже, чем файл (после
       рестарта все выйдут ещё раз), но несравнимо лучше публичной строки. */
    console.warn('Секрет сервера не сохранился на диск:', e.message);
  }
  cached = s;
  return cached;
}

/** Отдельный секрет под свою задачу, выведенный из общего: утечка одного
 *  не раскрывает другие, и помнить их по отдельности не надо. */
function derive(label) {
  return crypto.createHmac('sha256', serverSecret()).update(String(label)).digest('hex');
}

module.exports = { serverSecret, derive, strong, PUBLIC_VALUES };
