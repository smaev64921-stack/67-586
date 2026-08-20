/**
 * Telegram-админы магазина (пуш «Новый заказ» + кнопки в боте + авто-вход).
 * Не путать с ADMIN_EMAIL на сайте.
 *
 * Источники (объединяются):
 *   TELEGRAM_CHAT_ID / TELEGRAM_CHAT_IDS — через запятую
 *   data/tg-owner.json — chatId или chatIds[]
 *   removedIds[] — удалённые через бота (не возвращаются из env)
 *   первый /start — только если список ещё пуст
 */
const fs = require('fs');
const path = require('path');
const { DATA_DIR } = require('./db');

const FILE = path.join(DATA_DIR, 'tg-owner.json');

function parseIds(raw) {
  return String(raw || '')
    .split(/[,;\s]+/)
    .map((s) => s.trim())
    .filter((s) => s && s !== 'Значение' && !/^change/i.test(s) && /^-?\d+$/.test(s));
}

function envChatIds() {
  const a = parseIds(process.env.TELEGRAM_CHAT_ID);
  const b = parseIds(process.env.TELEGRAM_CHAT_IDS);
  return [...new Set([...a, ...b])];
}

function readStored() {
  try {
    const j = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    if (!j) return null;
    const ids = [];
    if (Array.isArray(j.chatIds)) ids.push(...j.chatIds.map(String));
    if (j.chatId != null && String(j.chatId).trim() !== '') ids.push(String(j.chatId));
    const uniq = [...new Set(parseIds(ids.join(',')))];
    const removedIds = [...new Set(parseIds((j.removedIds || []).join(',')))];
    if (!uniq.length && !removedIds.length) return null;
    return {
      chatId: uniq[0] || '',
      chatIds: uniq,
      removedIds,
      username: j.username || '',
      name: j.name || '',
      at: j.at || ''
    };
  } catch (_) {}
  return null;
}

function writeStored(chatIds, from = {}, removedIds = null) {
  const uniq = [...new Set(parseIds(chatIds.join(',')))];
  const prev = readStored();
  const removed = removedIds != null
    ? [...new Set(parseIds(removedIds.join(',')))]
    : ((prev && prev.removedIds) || []);
  const data = {
    chatId: uniq[0] || '',
    chatIds: uniq,
    removedIds: removed,
    username: (from && from.username) || (prev && prev.username) || '',
    name: from
      ? [from.first_name, from.last_name].filter(Boolean).join(' ').trim()
      : ((prev && prev.name) || ''),
    at: new Date().toISOString()
  };
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(data, null, 2), 'utf8');
  return data;
}

function removedSet() {
  const stored = readStored();
  return new Set((stored && stored.removedIds) || []);
}

/** Все chat_id админов бота (env + файл − удалённые). */
function getOwnerChatIds() {
  const fromEnv = envChatIds();
  const stored = readStored();
  const fromFile = (stored && stored.chatIds) || [];
  const removed = removedSet();
  return [...new Set([...fromEnv, ...fromFile])].filter((id) => !removed.has(String(id)));
}

/** Первый админ (совместимость). */
function getOwnerChatId() {
  return getOwnerChatIds()[0] || '';
}

function isOwnerChat(chatId) {
  const id = String(chatId || '');
  if (!id) return false;
  return getOwnerChatIds().includes(id);
}

/* ---- админы по номеру телефона ----
   Бот получает номер от самого Telegram (кнопка «Поделиться контактом»),
   подделать его в запросе нельзя. Список задаётся в ADMIN_PHONES, например:
   ADMIN_PHONES=+79001234567,+79007654321
   Работает вместе со списком chat_id: достаточно совпасть чему-то одному. */
function normPhone(raw) {
  try {
    return require('./sms').normalizePhone(raw) || '';
  } catch (_) {
    return '';
  }
}

function getOwnerPhones() {
  const raw = String(process.env.ADMIN_PHONES || process.env.TELEGRAM_ADMIN_PHONES || '');
  /* режем только по запятой/точке с запятой: внутри номера бывают пробелы
     и дефисы («+7 900 123-45-67»), и по \s он бы развалился на куски */
  return [...new Set(
    raw.split(/[,;\n]+/).map((s) => normPhone(s)).filter(Boolean)
  )];
}

function isOwnerPhone(phone) {
  const list = getOwnerPhones();
  if (!list.length) return false;
  const p = normPhone(phone);
  return !!p && list.includes(p);
}

function hasOwner() {
  return getOwnerChatIds().length > 0;
}

/**
 * Закрепить первого владельца при /start, если список ещё пуст.
 * Уже известные TELEGRAM_CHAT_ID не перезаписываются.
 */
function claimOwner(chatId, from = {}) {
  const id = String(chatId);
  if (isOwnerChat(id)) {
    return { claimed: false, already: true, chatId: id };
  }
  const existing = getOwnerChatIds();
  if (existing.length) {
    return { claimed: false, already: true, chatId: existing[0] };
  }
  writeStored([id], from, []);
  console.log('Telegram owner claimed:', id, from.username || '');
  return { claimed: true, already: false, chatId: id };
}

/** Добавить админа бота (пишется в data/tg-owner.json, env тоже учитывается). */
function addOwner(chatId, from = {}) {
  const id = String(chatId || '').trim();
  if (!/^-?\d+$/.test(id)) {
    return { ok: false, error: 'Нужен числовой Telegram ID' };
  }
  const stored = readStored();
  const removed = ((stored && stored.removedIds) || []).filter((x) => String(x) !== id);
  const all = getOwnerChatIds();
  if (all.includes(id)) {
    writeStored(all, from, removed);
    return { ok: true, already: true, chatId: id, chatIds: all };
  }
  const next = [...all, id];
  writeStored(next, from, removed);
  return { ok: true, already: false, chatId: id, chatIds: next };
}

/** Убрать админа. Нельзя удалить себя и последнего. */
function removeOwner(chatId, byChatId) {
  const id = String(chatId || '').trim();
  const by = String(byChatId || '').trim();
  if (!/^-?\d+$/.test(id)) {
    return { ok: false, error: 'Нужен числовой Telegram ID' };
  }
  const all = getOwnerChatIds();
  if (!all.includes(id)) {
    return { ok: false, error: 'Этого ID нет в списке админов' };
  }
  if (by && id === by) {
    return { ok: false, error: 'Нельзя удалить самого себя' };
  }
  if (all.length <= 1) {
    return { ok: false, error: 'Нельзя удалить последнего админа' };
  }
  const next = all.filter((x) => String(x) !== id);
  const stored = readStored();
  const removed = [...new Set([...((stored && stored.removedIds) || []), id])];
  writeStored(next, {}, removed);
  return { ok: true, chatId: id, chatIds: next };
}

module.exports = {
  getOwnerChatId,
  getOwnerChatIds,
  isOwnerChat,
  getOwnerPhones,
  isOwnerPhone,
  hasOwner,
  claimOwner,
  addOwner,
  removeOwner,
  FILE
};
