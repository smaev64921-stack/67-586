/**
 * Связка Telegram chat_id ↔ аккаунт на сайте.
 * Жёсткие правила: один chat → один user, один user → один chat
 * (перепривязка только явным relink).
 * Файл: data/tg-users.json
 */
const fs = require('fs');
const path = require('path');
const { DATA_DIR, db } = require('./db');

const FILE = path.join(DATA_DIR, 'tg-users.json');

function load() {
  try { return JSON.parse(fs.readFileSync(FILE, 'utf8')) || {}; } catch (_) { return {}; }
}
function save(map) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(map, null, 2), 'utf8');
}

function enrichEmail(link) {
  if (!link || !link.userId || link.email) return link;
  try {
    const u = db.prepare('SELECT email FROM users WHERE id = ?').get(link.userId);
    if (u && u.email) link.email = String(u.email).toLowerCase();
  } catch (_) {}
  return link;
}

function getLink(chatId) {
  const m = load();
  return m[String(chatId)] || null;
}

function findLinkByUser(userId, email) {
  const map = load();
  const uid = userId != null ? +userId : null;
  const em = String(email || '').trim().toLowerCase();
  for (const link of Object.values(map)) {
    if (!link) continue;
    if (uid && link.userId && +link.userId === uid) return link;
    if (em && link.email && link.email === em) return link;
  }
  return null;
}

function writeLink(chatId, from = {}, payload = {}) {
  const id = String(chatId);
  const map = load();
  const prev = map[id] || {};
  const next = enrichEmail({
    chatId: id,
    userId: payload.userId != null ? +payload.userId : (prev.userId || null),
    email: String(payload.email || prev.email || '').trim().toLowerCase(),
    username: from.username || prev.username || '',
    name: [from.first_name, from.last_name].filter(Boolean).join(' ').trim() || prev.name || '',
    at: new Date().toISOString()
  });
  map[id] = next;
  save(map);
  return next;
}

/**
 * Попытка привязки без перезаписи чужих связей.
 * @returns {{ status: 'ok'|'already_same'|'chat_taken'|'user_taken', link?: object }}
 */
function tryLink(chatId, from = {}, userId) {
  const uid = +userId;
  if (!uid || !Number.isFinite(uid)) {
    return { status: 'invalid' };
  }

  const byChat = getLink(chatId);
  if (byChat && byChat.userId && +byChat.userId === uid) {
    return { status: 'already_same', link: byChat };
  }
  if (byChat && byChat.userId && +byChat.userId !== uid) {
    return { status: 'chat_taken', link: byChat };
  }

  const byUser = findLinkByUser(uid);
  if (byUser && String(byUser.chatId) !== String(chatId)) {
    return { status: 'user_taken', link: byUser };
  }

  const link = writeLink(chatId, from, { userId: uid });
  return { status: 'ok', link };
}

/** Явная перепривязка: снять userId с других chat, привязать к текущему. */
function relinkUser(chatId, from = {}, userId) {
  const uid = +userId;
  if (!uid || !Number.isFinite(uid)) return { status: 'invalid' };

  const map = load();
  const chatKey = String(chatId);

  /* этот chat уже занят другим user — нельзя */
  const existing = map[chatKey];
  if (existing && existing.userId && +existing.userId !== uid) {
    return { status: 'chat_taken', link: existing };
  }

  for (const [key, link] of Object.entries(map)) {
    if (!link) continue;
    if (key === chatKey) continue;
    if (link.userId && +link.userId === uid) delete map[key];
  }
  save(map);

  const link = writeLink(chatId, from, { userId: uid });
  return { status: 'ok', link };
}

/** Совместимость: мягкая запись (используйте tryLink в боте). */
function linkUser(chatId, from = {}, payload = {}) {
  if (payload && payload.userId != null) {
    const r = tryLink(chatId, from, payload.userId);
    if (r.status === 'ok' || r.status === 'already_same') return r.link;
    if (r.status === 'user_taken' || r.status === 'chat_taken') return r.link || getLink(chatId);
  }
  return writeLink(chatId, from, payload || {});
}

/** Найти chat_id покупателя по user_id или email заказа. */
function findChatForOrder(order) {
  if (!order) return '';
  const map = load();
  const email = String(order.email || '').toLowerCase();
  const uid = order.userId != null ? +order.userId : null;
  for (const link of Object.values(map)) {
    if (!link) continue;
    if (uid && link.userId && +link.userId === uid) return String(link.chatId);
    if (email && link.email && link.email === email) return String(link.chatId);
  }
  return '';
}

/**
 * Статус для API: linked + conflict (если chat другого TG уже держит этот аккаунт — с точки зрения UI не нужно;
 * conflict=true когда залогиненный user не linked, но … обычно просто linked).
 */
function telegramStatusForUser(user) {
  if (!user) return { linked: false, conflict: false };
  const link = findLinkByUser(user.id, user.email);
  return {
    linked: !!(link && (link.userId || link.email)),
    conflict: false,
    at: link && link.at ? link.at : null,
    chatId: link ? String(link.chatId) : null
  };
}

module.exports = {
  getLink,
  linkUser,
  tryLink,
  relinkUser,
  findChatForOrder,
  findLinkByUser,
  telegramStatusForUser,
  FILE
};
