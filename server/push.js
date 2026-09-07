/**
 * Push-уведомления: сообщение доходит, даже когда приложение закрыто.
 *
 * Чем это отличается от того, что было. Раньше приложение само раз в минуту
 * спрашивало сервер и, увидев смену статуса, показывало уведомление. Работает,
 * пока приложение живо — свёрнуто, но не закрыто. Push устроен наоборот: шлём
 * не мы, а служба браузера (у Android это Google, у Safari — Apple). Она держит
 * связь с устройством постоянно и будит service worker, даже если приложение
 * закрыто совсем.
 *
 * КЛЮЧИ. Пара VAPID нигде не регистрируется, это просто ключи, которыми мы
 * подписываем свои отправки. Поэтому не заставляем владельца ничего копировать:
 * берём из окружения, если он их туда положил, иначе из файла в томе данных,
 * иначе генерируем сами и сохраняем. Один раз при первом запуске.
 *
 * ПОДПИСКИ. Разрешив уведомления, браузер выдаёт «адрес» конкретного
 * устройства. Храним его в базе рядом с аккаунтом: у одного человека бывает и
 * телефон, и компьютер, поэтому ключ — сам адрес, а не пользователь.
 * Просроченные адреса служба помечает кодами 404 и 410 — такие вычищаем сразу,
 * иначе список растёт мусором и каждая отправка тратится впустую.
 */
const fs = require('fs');
const path = require('path');

const { db, DATA_DIR } = require('./db');

const KEYS_FILE = path.join(DATA_DIR, 'vapid.json');

let webpush = null;
try {
  webpush = require('web-push');
} catch (e) {
  console.warn('push: библиотека web-push не подключена —', e.message);
}

db.exec(`
  CREATE TABLE IF NOT EXISTS push_subs (
    endpoint   TEXT PRIMARY KEY,
    user_id    INTEGER,
    p256dh     TEXT NOT NULL,
    auth       TEXT NOT NULL,
    ua         TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )
`);

/* ---------------------------------------------------------------- ключи -- */

function readKeys() {
  const fromEnv = {
    publicKey: String(process.env.VAPID_PUBLIC_KEY || '').trim(),
    privateKey: String(process.env.VAPID_PRIVATE_KEY || '').trim()
  };
  if (fromEnv.publicKey && fromEnv.privateKey) return fromEnv;

  try {
    const j = JSON.parse(fs.readFileSync(KEYS_FILE, 'utf8'));
    if (j && j.publicKey && j.privateKey) return j;
  } catch (_) {}

  if (!webpush) return null;
  const fresh = webpush.generateVAPIDKeys();
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(KEYS_FILE, JSON.stringify(fresh, null, 2));
    console.log('push: ключи созданы и сохранены в', KEYS_FILE);
  } catch (e) {
    /* Не записались — работать всё равно можно, но после перезапуска ключи
       сменятся и все выданные подписки станут недействительными. Об этом
       лучше знать заранее, чем гадать, почему уведомления перестали ходить. */
    console.warn('push: ключи созданы, но НЕ сохранены —', e.message);
  }
  return fresh;
}

let keys = null;
function ensureKeys() {
  if (keys) return keys;
  keys = readKeys();
  if (keys && webpush) {
    /* Служба требует контакт на случай, если с нашими отправками что-то не так. */
    const mail = String(process.env.ADMIN_EMAIL || '').trim();
    const subject = mail.includes('@')
      ? 'mailto:' + mail
      : String(process.env.PUBLIC_URL || 'https://example.com').trim();
    try {
      webpush.setVapidDetails(subject, keys.publicKey, keys.privateKey);
    } catch (e) {
      console.warn('push: ключи не приняты —', e.message);
      keys = null;
    }
  }
  return keys;
}

function configured() {
  return !!(webpush && ensureKeys());
}

function publicKey() {
  const k = ensureKeys();
  return k ? k.publicKey : '';
}

/* ------------------------------------------------------------ подписки -- */

function save(sub, userId, ua) {
  if (!sub || !sub.endpoint || !sub.keys || !sub.keys.p256dh || !sub.keys.auth) {
    throw Object.assign(new Error('Подписка неполная'), { status: 400 });
  }
  db.prepare(`
    INSERT INTO push_subs (endpoint, user_id, p256dh, auth, ua)
    VALUES (@endpoint, @user_id, @p256dh, @auth, @ua)
    ON CONFLICT(endpoint) DO UPDATE SET
      user_id = excluded.user_id,
      p256dh  = excluded.p256dh,
      auth    = excluded.auth,
      ua      = excluded.ua
  `).run({
    endpoint: String(sub.endpoint),
    user_id: userId != null ? +userId : null,
    p256dh: String(sub.keys.p256dh),
    auth: String(sub.keys.auth),
    ua: String(ua || '').slice(0, 200)
  });
  return true;
}

function drop(endpoint) {
  if (!endpoint) return false;
  return db.prepare('DELETE FROM push_subs WHERE endpoint = ?').run(String(endpoint)).changes > 0;
}

function rowsForUser(userId) {
  if (userId == null) return [];
  return db.prepare('SELECT * FROM push_subs WHERE user_id = ?').all(+userId);
}

function rowsForAdmins() {
  return db.prepare(`
    SELECT s.* FROM push_subs s
    JOIN users u ON u.id = s.user_id
    WHERE u.role = 'admin'
  `).all();
}

function count() {
  try {
    return db.prepare('SELECT COUNT(*) AS n FROM push_subs').get().n;
  } catch (_) {
    return 0;
  }
}

/* ------------------------------------------------------------- отправка -- */

async function sendToRows(rows, payload) {
  if (!configured() || !rows.length) return { sent: 0, gone: 0 };
  const body = JSON.stringify(payload || {});
  let sent = 0;
  let gone = 0;
  for (const r of rows) {
    const sub = { endpoint: r.endpoint, keys: { p256dh: r.p256dh, auth: r.auth } };
    try {
      await webpush.sendNotification(sub, body, { TTL: 3600, urgency: 'high' });
      sent += 1;
    } catch (e) {
      /* 404 и 410 значат «такого устройства больше нет»: человек снёс
         приложение, сбросил разрешение или почистил данные браузера. Держать
         этот адрес незачем — каждая следующая отправка в него холостая. */
      if (e && (e.statusCode === 404 || e.statusCode === 410)) {
        drop(r.endpoint);
        gone += 1;
      } else {
        console.warn('push: не доставлено —', (e && e.statusCode) || '', (e && e.message) || e);
      }
    }
  }
  return { sent, gone };
}

/** Уведомление конкретному покупателю на все его устройства. */
function sendToUser(userId, payload) {
  return sendToRows(rowsForUser(userId), payload).catch((e) => {
    console.warn('push sendToUser:', e.message);
    return { sent: 0, gone: 0 };
  });
}

/** Уведомление всем админам магазина. */
function sendToAdmins(payload) {
  return sendToRows(rowsForAdmins(), payload).catch((e) => {
    console.warn('push sendToAdmins:', e.message);
    return { sent: 0, gone: 0 };
  });
}

module.exports = { configured, publicKey, save, drop, sendToUser, sendToAdmins, count, KEYS_FILE };
