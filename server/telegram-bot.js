/**
 * Telegram-бот Canvas
 * — одно живое сообщение на экран/заказ (edit; при провале — delete + send)
 * — сообщения пользователя всегда удаляются
 * — владелец: карточка заказа с треком / статусом / «На сайт» (авто-админ)
 * — покупатель: карточка заказа (edit), пуш только «Доставлен»
 */
const fs = require('fs');
const path = require('path');
const { resolvePublicUrl, isValidPublicHttps } = require('./public-url');
const { claimOwner, getOwnerChatId, getOwnerChatIds, isOwnerChat, addOwner, removeOwner } = require('./tg-owner');
const { tryLink, relinkUser, findChatForOrder } = require('./tg-users');
const { DATA_DIR } = require('./db');

const TOKEN = () => String(
  process.env.TELEGRAM_BOT_TOKEN ||
  process.env.BOT_TOKEN ||
  process.env.API_TOKEN ||
  ''
).trim();
const DISABLED = () =>
  process.env.TELEGRAM_DISABLED === '1' ||
  process.env.TELEGRAM_DISABLED === 'true';

const SHOP_URL = () => resolvePublicUrl(process.env.PORT || 3000);
const MSGS_FILE = path.join(DATA_DIR, 'tg-shop-msgs.json');
const ORDER_MSGS_FILE = path.join(DATA_DIR, 'tg-order-msgs.json');
const OWNER_ORDER_MSGS_FILE = path.join(DATA_DIR, 'tg-owner-order-msgs.json');
const DELIVERED_FILE = path.join(DATA_DIR, 'tg-delivered.json');
const OWNER_NOTIFIED_FILE = path.join(DATA_DIR, 'tg-owner-notified.json');
const AWAIT_FILE = path.join(DATA_DIR, 'tg-await.json');
const SUPPORT_FILE = path.join(DATA_DIR, 'tg-support.json');

/** Кому слать запросы оператора (только этот чат). */
const SUPPORT_OPERATOR_CHAT = () =>
  String(process.env.TELEGRAM_SUPPORT_CHAT_ID || '8133757512').trim();

/** Выгрузка/загрузка БД — только этот чат (ты). */
const DATA_OWNER_CHAT = () =>
  String(process.env.TELEGRAM_DATA_OWNER_CHAT_ID || '8133757512').trim();
function isDataOwnerChat(chatId) {
  return String(chatId || '') === DATA_OWNER_CHAT();
}

const WEBHOOK_SECRET = () =>
  String(process.env.TELEGRAM_WEBHOOK_SECRET || process.env.JWT_SECRET || 'luxe-canvas-tg').slice(0, 64);

const STATUS_CODE = {
  p: 'Ожидает оплаты',
  w: 'В обработке',
  e: 'Едет',
  d: 'Доставлен',
  c: 'Отменён',
  r: 'Возврат'
};

let BOT_USERNAME = '';

function api(method, body) {
  const token = TOKEN();
  if (!token) return Promise.reject(new Error('TELEGRAM_BOT_TOKEN missing'));
  return fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {})
  }).then(async (r) => {
    const data = await r.json().catch(() => ({}));
    if (!data.ok) {
      throw Object.assign(new Error(data.description || `Telegram ${method} failed`), { tg: data });
    }
    return data.result;
  });
}

function shopHttps() {
  const shop = SHOP_URL();
  if (!isValidPublicHttps(shop)) return '';
  return shop.replace(/\/$/, '');
}

function money(n) {
  return `${Math.round(+n || 0).toLocaleString('ru-RU')} ₽`;
}

function escHtml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/* Цвет кнопки Bot API не поддерживает: InlineKeyboardButton не знает полей
   style/color и молча их выбрасывает. Раньше здесь проставлялся style —
   на кнопки это не влияло никак. Единственный способ выделить кнопку —
   эмодзи в начале подписи, поэтому оно есть у каждой. */
function urlBtn(text, url) {
  return { text, url };
}

function cbBtn(text, data) {
  return { text, callback_data: String(data).slice(0, 64) };
}

function loadJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) || fallback; } catch (_) { return fallback; }
}
function saveJson(file, data) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
}

function getUiState(chatId) {
  const m = loadJson(MSGS_FILE, {});
  const v = m[String(chatId)];
  if (v == null) return { messageId: null, extras: [] };
  if (typeof v === 'number') return { messageId: v, extras: [] };
  return {
    messageId: v.messageId || null,
    extras: Array.isArray(v.extras) ? v.extras.filter(Boolean) : []
  };
}
function saveUiState(chatId, state) {
  const m = loadJson(MSGS_FILE, {});
  const messageId = state && state.messageId ? Number(state.messageId) : null;
  const extras = [...new Set((state && state.extras) || [])]
    .map((x) => Number(x))
    .filter((id) => id && (!messageId || +id !== +messageId));
  if (!messageId && !extras.length) delete m[String(chatId)];
  else m[String(chatId)] = { messageId, extras };
  saveJson(MSGS_FILE, m);
}
function getMainMsgId(chatId) {
  return getUiState(chatId).messageId || null;
}
function setMainMsgId(chatId, messageId) {
  const st = getUiState(chatId);
  const extras = st.extras.slice();
  if (st.messageId && +st.messageId !== +messageId) extras.push(st.messageId);
  saveUiState(chatId, { messageId, extras });
}
function addExtraMsgId(chatId, messageId) {
  if (!messageId) return;
  const st = getUiState(chatId);
  if (st.messageId && +st.messageId === +messageId) return;
  saveUiState(chatId, {
    messageId: st.messageId,
    extras: st.extras.concat(Number(messageId))
  });
}
function clearMainMsgId(chatId) {
  const m = loadJson(MSGS_FILE, {});
  delete m[String(chatId)];
  saveJson(MSGS_FILE, m);
}
function allTrackedOrderMsgIds(chatId) {
  const ids = new Set();
  const customer = loadJson(ORDER_MSGS_FILE, {})[String(chatId)] || {};
  if (customer && typeof customer === 'object') {
    for (const v of Object.values(customer)) {
      if (v && typeof v !== 'object') ids.add(Number(v));
    }
  }
  const ownerStore = loadJson(OWNER_ORDER_MSGS_FILE, {});
  const ownerByChat = ownerStore[String(chatId)];
  if (ownerByChat && typeof ownerByChat === 'object') {
    for (const v of Object.values(ownerByChat)) {
      if (v && typeof v !== 'object') ids.add(Number(v));
    }
  }
  return ids;
}
function isTrackedOrderMsg(chatId, messageId) {
  if (!messageId) return false;
  return allTrackedOrderMsgIds(chatId).has(Number(messageId));
}

/** Работать с тем сообщением, на которое человек нажал — не с первым в чате.
 *  Карточки заказов не трогаем: иначе /start и «Домой» их стирают. */
function adoptUiMessage(chatId, messageId) {
  if (!messageId) return;
  if (isTrackedOrderMsg(chatId, messageId)) return;
  setMainMsgId(chatId, messageId);
}
async function sweepStaleUi(chatId, keepId) {
  const st = getUiState(chatId);
  const keep = keepId || st.messageId;
  const protectedIds = allTrackedOrderMsgIds(chatId);
  const kill = [...st.extras, st.messageId].filter((id) => {
    if (!id) return false;
    if (keep && +id === +keep) return false;
    if (protectedIds.has(Number(id))) return false;
    return true;
  });
  for (const id of [...new Set(kill)]) {
    await safeDelete(chatId, id);
  }
  saveUiState(chatId, { messageId: keep || null, extras: [] });
}

function getOrderMsgId(chatId, orderNum) {
  const m = loadJson(ORDER_MSGS_FILE, {});
  return (m[String(chatId)] || {})[String(orderNum)] || null;
}
function setOrderMsgId(chatId, orderNum, messageId) {
  const m = loadJson(ORDER_MSGS_FILE, {});
  const key = String(chatId);
  if (!m[key]) m[key] = {};
  m[key][String(orderNum)] = messageId;
  saveJson(ORDER_MSGS_FILE, m);
}

function getOwnerOrderMsgId(chatId, orderNum) {
  const m = loadJson(OWNER_ORDER_MSGS_FILE, {});
  const byChat = m[String(chatId)];
  if (byChat && typeof byChat === 'object') return byChat[String(orderNum)] || null;
  /* старый формат: { orderNum: messageId } */
  if (m[String(orderNum)] && typeof m[String(orderNum)] !== 'object') {
    return m[String(orderNum)] || null;
  }
  return null;
}
function setOwnerOrderMsgId(chatId, orderNum, messageId) {
  const m = loadJson(OWNER_ORDER_MSGS_FILE, {});
  const key = String(chatId);
  if (!m[key] || typeof m[key] !== 'object') m[key] = {};
  m[key][String(orderNum)] = messageId;
  saveJson(OWNER_ORDER_MSGS_FILE, m);
}

function wasDeliveredPushed(orderNum) {
  return !!loadJson(DELIVERED_FILE, {})[String(orderNum)];
}
function markDeliveredPushed(orderNum) {
  const m = loadJson(DELIVERED_FILE, {});
  m[String(orderNum)] = new Date().toISOString();
  saveJson(DELIVERED_FILE, m);
}

function wasOwnerNotified(orderNum) {
  return !!loadJson(OWNER_NOTIFIED_FILE, {})[String(orderNum)];
}
function markOwnerNotified(orderNum) {
  const m = loadJson(OWNER_NOTIFIED_FILE, {});
  m[String(orderNum)] = new Date().toISOString();
  saveJson(OWNER_NOTIFIED_FILE, m);
}

function getAwait(chatId) {
  return loadJson(AWAIT_FILE, {})[String(chatId)] || null;
}
function setAwait(chatId, data) {
  const m = loadJson(AWAIT_FILE, {});
  if (data) m[String(chatId)] = data;
  else delete m[String(chatId)];
  saveJson(AWAIT_FILE, m);
}

/* ===================== ПОДДЕРЖКА (оператор) ===================== */

function loadSupportMap() {
  return loadJson(SUPPORT_FILE, {});
}
function saveSupportMap(m) {
  saveJson(SUPPORT_FILE, m);
}
function getSupport(userChatId) {
  return loadSupportMap()[String(userChatId)] || null;
}
function setSupport(userChatId, data) {
  const m = loadSupportMap();
  if (data) m[String(userChatId)] = data;
  else delete m[String(userChatId)];
  saveSupportMap(m);
}
function findActiveSupportForOperator(opChatId) {
  const m = loadSupportMap();
  const id = String(opChatId);
  for (const s of Object.values(m)) {
    if (s && s.status === 'active' && String(s.operatorChatId) === id) return s;
  }
  return null;
}
function trackSupportMsg(session, side, messageId) {
  if (!session || !messageId) return;
  const key = side === 'op' ? 'opMsgs' : 'userMsgs';
  if (!Array.isArray(session[key])) session[key] = [];
  session[key].push(Number(messageId));
}

async function wipeSupportMessages(session) {
  if (!session) return;
  const userId = session.userChatId;
  const opId = session.operatorChatId;
  for (const mid of session.userMsgs || []) {
    await safeDelete(userId, mid);
  }
  if (opId) {
    for (const mid of session.opMsgs || []) {
      await safeDelete(opId, mid);
    }
  }
  for (const [cid, mid] of Object.entries(session.notifyMsgIds || {})) {
    await safeDelete(cid, mid);
  }
}

async function startSupportRequest(chatId, from = {}) {
  if (isOwnerChat(chatId) || String(chatId) === SUPPORT_OPERATOR_CHAT()) {
    await upsertMain(chatId, {
      text: '👤 Это чат админа. Запросы оператора приходят сюда автоматически.',
      reply_markup: welcomeMarkup(chatId)
    });
    return;
  }

  const existing = getSupport(chatId);
  if (existing && (existing.status === 'waiting' || existing.status === 'active')) {
    const id = await upsertMain(chatId, {
      text: existing.status === 'active'
        ? '💬 Диалог уже открыт — напишите ваш вопрос.'
        : '⏳ Запрос уже отправлен. Оператор скоро ответит — напишите вопрос.',
      reply_markup: existing.status === 'waiting'
        ? { inline_keyboard: [[cbBtn('❌ Отменить', 'sup:cancel')], [cbBtn('🏠 Домой', 'home')]] }
        : { inline_keyboard: [[cbBtn('🏠 Домой', 'home')]] }
    });
    if (id) {
      trackSupportMsg(existing, 'user', id);
      setSupport(chatId, existing);
    }
    return;
  }

  const who = [from.first_name, from.last_name].filter(Boolean).join(' ').trim() || 'Покупатель';
  const uname = from.username ? '@' + from.username : '';

  const waitId = await upsertMain(chatId, {
    text: [
      '💬 <b>Поддержка</b>',
      '',
      'Напишите вопрос — оператор ответит здесь.'
    ].join('\n'),
    reply_markup: {
      inline_keyboard: [[cbBtn('❌ Отменить', 'sup:cancel')], [cbBtn('🏠 Домой', 'home')]]
    }
  });

  const session = {
    status: 'waiting',
    userChatId: String(chatId),
    fromName: who,
    fromUsername: from.username || '',
    operatorChatId: null,
    userMsgs: waitId ? [waitId] : [],
    opMsgs: [],
    pendingTexts: [],
    notifyMsgIds: {},
    panelMsgId: null,
    createdAt: Date.now()
  };
  setSupport(chatId, session);

  const opId = SUPPORT_OPERATOR_CHAT();
  try {
    const n = await sendWithMarkupFallback(opId, {
      text: [
        '🆘 <b>Запрос оператора</b>',
        '',
        escHtml(who) + (uname ? ` · ${escHtml(uname)}` : ''),
        `Чат: <code>${chatId}</code>`,
        '',
        'Нажмите «Открыть», чтобы начать диалог.'
      ].join('\n'),
      reply_markup: {
        inline_keyboard: [[cbBtn('✅ Открыть диалог', `sup:open:${chatId}`)]]
      }
    });
    if (n && n.message_id) {
      session.notifyMsgIds[String(opId)] = n.message_id;
      session.opMsgs.push(n.message_id);
      setSupport(chatId, session);
    }
  } catch (e) {
    console.error('TG support notify:', e.message);
    try {
      await upsertMain(chatId, {
        text: '⚠️ Не удалось связаться с оператором. Попробуйте позже.',
        reply_markup: welcomeMarkup(chatId)
      });
    } catch (_) {}
  }
}

async function cancelSupportRequest(userChatId) {
  const session = getSupport(userChatId);
  if (!session) return false;
  if (session.status === 'active') return false;

  for (const [cid, mid] of Object.entries(session.notifyMsgIds || {})) {
    await safeDelete(cid, mid);
  }
  await wipeSupportMessages(session);
  setSupport(userChatId, null);

  try {
    await showWelcome(userChatId, {});
  } catch (_) {}
  return true;
}

async function openSupportDialog(opChatId, userChatId, notifyMsgId) {
  const session = getSupport(userChatId);
  if (!session || session.status !== 'waiting') {
    return { ok: false, error: 'Запрос уже закрыт или принят' };
  }

  for (const [cid, mid] of Object.entries(session.notifyMsgIds || {})) {
    await safeDelete(cid, mid);
  }
  if (notifyMsgId) await safeDelete(opChatId, notifyMsgId);
  session.notifyMsgIds = {};
  session.opMsgs = (session.opMsgs || []).filter((id) => id !== notifyMsgId);

  session.status = 'active';
  session.operatorChatId = String(opChatId);

  /* убрать кнопку «Отменить» у клиента */
  if (session.userMsgs && session.userMsgs[0]) {
    try {
      await api('editMessageReplyMarkup', {
        chat_id: userChatId,
        message_id: session.userMsgs[0],
        reply_markup: { inline_keyboard: [] }
      });
    } catch (_) {}
  }

  const hello = await sendWithMarkupFallback(userChatId, {
    text: '<b>Оператор:</b>\nЗдравствуйте!'
  });
  trackSupportMsg(session, 'user', hello && hello.message_id);

  for (const t of session.pendingTexts || []) {
    const m = await sendWithMarkupFallback(opChatId, {
      text: `<b>Клиент:</b>\n${escHtml(t)}`
    });
    trackSupportMsg(session, 'op', m && m.message_id);
  }
  session.pendingTexts = [];

  const panel = await sendWithMarkupFallback(opChatId, {
    text: [
      '<b>Диалог открыт</b>',
      escHtml(session.fromName) + (session.fromUsername ? ` · @${escHtml(session.fromUsername)}` : ''),
      '',
      'Пишите сюда — сообщения уйдут клиенту.'
    ].join('\n'),
    reply_markup: {
      inline_keyboard: [[cbBtn('🔚 Завершить диалог', `sup:close:${userChatId}`)]]
    }
  });
  session.panelMsgId = panel && panel.message_id;
  trackSupportMsg(session, 'op', session.panelMsgId);
  setSupport(userChatId, session);
  return { ok: true };
}

async function closeSupportDialog(userChatId) {
  const session = getSupport(userChatId);
  if (!session) return false;

  session.status = 'closing';
  setSupport(userChatId, session);

  let closeMsgId = null;
  try {
    const note = await sendWithMarkupFallback(userChatId, {
      text: 'Диалог с поддержкой закрыт. Если понадобится помощь — снова нажмите «Поддержка».'
    });
    closeMsgId = note && note.message_id;
  } catch (_) {}

  const snapshot = { ...session, userMsgs: [...(session.userMsgs || [])], opMsgs: [...(session.opMsgs || [])] };
  if (closeMsgId) snapshot.userMsgs.push(closeMsgId);

  setTimeout(() => {
    wipeSupportMessages(snapshot).then(() => {
      setSupport(userChatId, null);
    }).catch(() => {
      setSupport(userChatId, null);
    });
  }, 5000);

  return true;
}

/** Сообщения клиента в режиме поддержки. */
async function handleSupportUserMessage(msg) {
  const chatId = msg.chat.id;
  const session = getSupport(chatId);
  if (!session || (session.status !== 'waiting' && session.status !== 'active')) return false;

  const text = String(msg.text || msg.caption || '').trim();
  if (!text || /^\/start\b/i.test(text)) return false;

  trackSupportMsg(session, 'user', msg.message_id);

  if (session.status === 'waiting') {
    session.pendingTexts = session.pendingTexts || [];
    session.pendingTexts.push(text.slice(0, 3500));
    setSupport(chatId, session);
    /* обновим карточку у оператора, если есть */
    const opId = SUPPORT_OPERATOR_CHAT();
    const notifyId = session.notifyMsgIds && session.notifyMsgIds[String(opId)];
    if (notifyId) {
      try {
        await api('editMessageText', {
          chat_id: opId,
          message_id: notifyId,
          text: [
            '<b>Запрос оператора</b>',
            '',
            escHtml(session.fromName) + (session.fromUsername ? ` · @${escHtml(session.fromUsername)}` : ''),
            `Чат: <code>${chatId}</code>`,
            '',
            `<b>Вопрос:</b> ${escHtml(text.slice(0, 500))}`,
            '',
            'Нажмите «Открыть», чтобы начать диалог.'
          ].join('\n'),
          parse_mode: 'HTML',
          reply_markup: {
            inline_keyboard: [[cbBtn('✅ Открыть диалог', `sup:open:${chatId}`)]]
          }
        });
      } catch (_) {}
    }
    return true;
  }

  /* active — пересылаем оператору */
  const opId = session.operatorChatId;
  if (!opId) return true;
  try {
    const m = await sendWithMarkupFallback(opId, {
      text: `<b>Клиент:</b>\n${escHtml(text)}`
    });
    trackSupportMsg(session, 'op', m && m.message_id);
    setSupport(chatId, session);
  } catch (e) {
    console.error('TG support relay→op:', e.message);
  }
  return true;
}

/** Сообщения оператора в активном диалоге. */
async function handleSupportOperatorMessage(msg) {
  const chatId = msg.chat.id;
  if (String(chatId) !== SUPPORT_OPERATOR_CHAT()) return false;

  const session = findActiveSupportForOperator(chatId);
  if (!session) return false;

  const text = String(msg.text || msg.caption || '').trim();
  if (!text || /^\/start\b/i.test(text)) return false;

  trackSupportMsg(session, 'op', msg.message_id);

  try {
    const m = await sendWithMarkupFallback(session.userChatId, {
      text: `<b>Оператор:</b>\n${escHtml(text)}`
    });
    trackSupportMsg(session, 'user', m && m.message_id);
    setSupport(session.userChatId, session);
  } catch (e) {
    console.error('TG support relay→user:', e.message);
  }
  return true;
}

async function safeDelete(chatId, messageId) {
  if (!messageId) return;
  try {
    await api('deleteMessage', { chat_id: chatId, message_id: messageId });
  } catch (_) {}
}

/** /start нельзя тереть сразу — на телефоне Telegram «закрывает» чат с ботом. */
const START_DELETE_MS = Math.max(5000, +(process.env.TG_START_DELETE_MS || 15000));

function scheduleDelete(chatId, messageId, delayMs) {
  if (!messageId) return;
  const wait = Math.max(0, +(delayMs || 0));
  const t = setTimeout(() => {
    safeDelete(chatId, messageId).catch(() => {});
  }, wait);
  if (typeof t.unref === 'function') t.unref();
}

/** Удалить сообщение пользователя /start позже (после ответа бота). */
function scheduleDeleteStart(chatId, messageId) {
  scheduleDelete(chatId, messageId, START_DELETE_MS);
}

/* Сколько живёт ссылка «Админка». Кнопка висит в чате долго, поэтому
   30 минут превращали её в «ссылка устарела» при любом заходе позже. */
const ADMIN_LINK_TTL_MS =
  Math.max(30, +(process.env.TG_ADMIN_LINK_TTL_MIN || 24 * 60)) * 60 * 1000;

function adminCodesFile() {
  const path = require('path');
  const { DATA_DIR } = require('./db');
  return path.join(DATA_DIR, 'tg-admin-codes.json');
}

/**
 * Один живой код на чат. Код не меняется, а продлевается при каждом
 * показе меню — ссылка в старом сообщении бота продолжает работать,
 * пока владелец заходит в бота хотя бы раз за ADMIN_LINK_TTL.
 */
function adminLinkCode(chatId) {
  const fs = require('fs');
  const { issueTgAdminToken } = require('./auth');
  const { DATA_DIR } = require('./db');
  const file = adminCodesFile();
  let map = {};
  try { map = JSON.parse(fs.readFileSync(file, 'utf8')) || {}; } catch (_) {}

  const now = Date.now();
  const id = String(chatId);
  let code = '';
  for (const [k, v] of Object.entries(map)) {
    if (!v || now > (v.exp || 0)) { delete map[k]; continue; }
    if (String(v.chatId || '') !== id) continue;
    if (code) delete map[k];          /* один код на чат */
    else code = k;
  }
  if (!code) code = require('crypto').randomBytes(16).toString('hex');

  map[code] = {
    token: issueTgAdminToken(id, ADMIN_LINK_TTL_MS),
    chatId: id,
    at: now,
    exp: now + ADMIN_LINK_TTL_MS
  };
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(map), 'utf8');
  return code;
}

/**
 * URL сайта из бота. Авто-вход админа — только по явному opts.go === 'admin'.
 * Раньше админ-токен подмешивался в ЛЮБУЮ ссылку владельца: кнопка «Сайт»
 * выкидывала его из личного аккаунта и открывала админку вместо магазина.
 */
function siteUrl(chatId, opts = {}) {
  const shop = shopHttps();
  if (!shop) {
    console.warn('TG siteUrl: нет валидного HTTPS PUBLIC_URL');
    return '';
  }
  const q = new URLSearchParams();
  let wantAdmin = opts.go === 'admin' && isOwnerChat(chatId);
  if (wantAdmin) {
    try {
      q.set('tg_admin', adminLinkCode(chatId));
    } catch (e) {
      console.error('TG siteUrl admin token:', e.message);
      wantAdmin = false;
      q.set('from', 'tg');
    }
  } else {
    q.set('from', 'tg');
  }

  let hash = '';
  if (wantAdmin) hash = '#admin';
  else if (opts.hash) hash = opts.hash.startsWith('#') ? opts.hash : '#' + opts.hash;

  const qs = q.toString();
  return qs ? `${shop}/?${qs}${hash}` : `${shop}/${hash || ''}`;
}

function countOrdersForChat(chatId) {
  try {
    const { getLink } = require('./tg-users');
    const { findById } = require('./auth');
    const { listOrdersForUser } = require('./orders');
    const link = getLink(chatId);
    if (!link || !link.userId) return 0;
    const user = findById(link.userId);
    if (!user) return 0;
    return (listOrdersForUser(user) || []).length;
  } catch (_) {
    return 0;
  }
}

function chatHasLinkedAccount(chatId) {
  try {
    const { getLink } = require('./tg-users');
    const link = getLink(chatId);
    return !!(link && link.userId);
  } catch (_) {
    return false;
  }
}

function etaText() {
  try {
    const { getCms } = require('./orders');
    return String((getCms().shipping && getCms().shipping.pickupDays) || '2–5 дней');
  } catch (_) {
    return '2–5 дней';
  }
}

function statusEmoji(status) {
  const s = String(status || '');
  if (/доставлен/i.test(s)) return '✅';
  if (/едет/i.test(s)) return '🚚';
  if (/отмен/i.test(s)) return '❌';
  if (/возврат/i.test(s)) return '↩️';
  if (/оплат/i.test(s)) return '💳';
  return '📦';
}

function ordersForChat(chatId) {
  try {
    const { getLink } = require('./tg-users');
    const { findById } = require('./auth');
    const { listOrdersForUser, listAllOrders } = require('./orders');
    const link = getLink(chatId);
    if (link && link.userId) {
      const user = findById(link.userId);
      if (user) return listOrdersForUser(user) || [];
    }
    if (link && link.email) {
      const email = String(link.email || '').toLowerCase();
      return (listAllOrders() || []).filter((o) =>
        String(o.email || '').toLowerCase() === email
      );
    }
  } catch (_) {}
  return [];
}

function formatOrdersListText(orders) {
  if (!orders.length) {
    return '📦 <b>Заказов пока нет</b>\n\nОформите заказ на сайте — он появится здесь.';
  }
  const lines = ['📦 <b>Мои заказы</b>', ''];
  for (const o of orders.slice(0, 8)) {
    lines.push(
      `${statusEmoji(o.status)} <b>№${escHtml(o.num)}</b> · ${escHtml(o.status || '—')} · ${money(o.price)}`
    );
  }
  if (orders.length > 8) lines.push('', `Ещё ${orders.length - 8} — на сайте`);
  return lines.join('\n');
}

function ordersListMarkup(orders, chatId) {
  const rows = [];
  for (const o of orders.slice(0, 6)) {
    const label = `${statusEmoji(o.status)} №${o.num} · ${o.status || ''}`.slice(0, 40);
    rows.push([cbBtn(label, `ost:${o.num}`)]);
  }
  const url = siteUrl(chatId, { hash: 'orders' });
  if (url) rows.push([urlBtn('🌐 Все на сайте', url)]);
  rows.push([cbBtn('🏠 Домой', 'home')]);
  return { inline_keyboard: rows };
}

async function showMyOrders(chatId, preferId) {
  const orders = ordersForChat(chatId);
  return upsertMain(chatId, {
    text: formatOrdersListText(orders),
    reply_markup: ordersListMarkup(orders, chatId)
  }, preferId);
}

async function showOwnerOrders(chatId, preferId) {
  const { listAllOrders } = require('./orders');
  const orders = (listAllOrders() || []).slice(0, 12);
  const lines = ['📋 <b>Заказы магазина</b>', ''];
  if (!orders.length) {
    lines.push('Заказов пока нет.');
  } else {
    for (const o of orders) {
      const who = escHtml(o.customerName || 'Гость');
      lines.push(
        `${statusEmoji(o.status)} <b>№${escHtml(o.num)}</b> · ${escHtml(o.status || '—')} · ${money(o.price)}`,
        `   ${who}`
      );
    }
  }
  const rows = orders.slice(0, 10).map((o) => [
    cbBtn(`${statusEmoji(o.status)} №${o.num}`.slice(0, 40), `oopen:${o.num}`)
  ]);
  const url = siteUrl(chatId, { go: 'admin' });
  if (url) rows.push([urlBtn('🌐 Админка', url)]);
  rows.push([cbBtn('🏠 Домой', 'home')]);
  return upsertMain(chatId, {
    text: lines.join('\n'),
    reply_markup: { inline_keyboard: rows }
  }, preferId);
}

function welcomeText() {
  const shop = shopHttps();
  return [
    '👋 <b>Canvas</b>',
    '',
    'Одежда с вниманием к качеству и посадке.',
    '',
    shop
      ? 'Откройте сайт, чтобы посмотреть каталог и оформить заказ.'
      : 'Сайт скоро будет доступен из этого меню.'
  ].join('\n');
}

function welcomeMarkup(chatId) {
  const rows = [];
  const linked = chatHasLinkedAccount(chatId);
  const admin = isOwnerChat(chatId);
  /* Одна подпись на все экраны: раньше их было три разных на одно действие. */
  rows.push([cbBtn('🔑 Код для входа на сайт', 'login_code')]);

  if (admin) {
    rows.push([cbBtn('📋 Заказы', 'owner_orders')]);
  }

  /* «Мои заказы» — только если аккаунт привязан и есть хотя бы 1 заказ */
  if (linked && countOrdersForChat(chatId) > 0) {
    rows.push([cbBtn('📦 Мои заказы', 'my_orders')]);
  }

  rows.push([cbBtn('💬 Поддержка', 'support')]);

  if (admin) {
    rows.push([cbBtn('👥 Админы', 'admins')]);
  }

  const url = siteUrl(chatId);
  if (url) rows.push([urlBtn('🌐 Сайт Canvas', url)]);
  if (admin) {
    const adminUrl = siteUrl(chatId, { go: 'admin' });
    if (adminUrl) rows.push([urlBtn('🛠 Админка', adminUrl)]);
    else if (!url) rows.push([cbBtn('⚠️ Сайт ещё не настроен', 'public_url_hint')]);
  }
  return { inline_keyboard: rows };
}

/** /support, поддержка, помощь — открыть диалог с оператором */
function isSupportCommand(text) {
  const t = String(text || '').trim();
  if (!t) return false;
  if (/^\/(?:support|help|operator)(?:@\w+)?$/i.test(t)) return true;
  if (/^\/?поддержка(?:@\w+)?$/i.test(t)) return true;
  if (/^\/?помощь(?:@\w+)?$/i.test(t)) return true;
  if (/^\/?оператор(?:@\w+)?$/i.test(t)) return true;
  return false;
}

function displayPhone(phone) {
  try {
    const { formatPhoneDisplay, normalizePhone } = require('./sms');
    const n = normalizePhone(phone);
    if (n) return formatPhoneDisplay(n);
  } catch (_) {}
  return String(phone || '').trim() || '—';
}

/** Экран ожидания кода: только «Повторить» + «Назад» (без лишней кнопки). */
function waitingSiteCodeMarkup() {
  return {
    inline_keyboard: [
      [cbBtn('🔄 Прислать новый код', 'login_code_retry')],
      [cbBtn('🏠 Домой', 'home')]
    ]
  };
}

function waitingSiteCodeText(phone) {
  const show = phone
    ? `📱 Номер: <code>${escHtml(displayPhone(phone))}</code>\n\n`
    : '';
  return [
    '🔐 <b>Код для входа на сайт</b>',
    '',
    show + '<b>1.</b> На сайте нажмите «Вход по коду через Telegram»',
    '<b>2.</b> Введите этот номер и запросите код',
    '<b>3.</b> Код придёт сюда — впишите его на сайте',
    '',
    '⏳ Жду запроса с сайта. Код придёт в этот чат сам.',
    '🔒 Код одноразовый, живёт 2 минуты. Никому не пересылайте его.'
  ].join('\n');
}

function deviceCodeText(code, ttlLeft, opts = {}) {
  const sec = Math.max(0, +(ttlLeft || 0));
  const mm = Math.floor(sec / 60);
  const ss = String(sec % 60).padStart(2, '0');
  const title = opts.isNew ? '🆕 Новый код' : '🔑 Код для входа';
  return [
    `<b>${title}</b>`,
    '',
    `<code>${escHtml(code)}</code>`,
    '',
    '👆 Нажмите на цифры, чтобы скопировать, и впишите их на сайте.',
    `⏱ Действует ${mm}:${ss}`,
    '🔒 Никому не пересылайте код — по нему входят в ваш аккаунт.'
  ].join('\n');
}

function deviceCodeExpiredText() {
  /* Раньше здесь было «запросите на сайте, затем нажмите Повторить» — два
     разных способа в одной фразе, будто нужны оба. Нужен любой один. */
  return [
    '⌛ <b>Код истёк</b>',
    '',
    'Этот код больше не подойдёт. Нужен новый — любым способом:',
    '',
    '🔄 нажмите кнопку ниже, и я пришлю его сюда',
    '🌐 или запросите код заново на сайте'
  ].join('\n');
}

function deviceCodeMarkup() {
  return {
    inline_keyboard: [
      [cbBtn('🔄 Прислать новый код', 'login_code_retry')],
      [cbBtn('🏠 Домой', 'home')]
    ]
  };
}

const expireTimers = new Map();
const waitSiteTimers = new Map();

function clearExpireTimer(chatId) {
  const t = expireTimers.get(String(chatId));
  if (t) clearTimeout(t);
  expireTimers.delete(String(chatId));
}

function clearWaitSiteTimer(chatId) {
  const t = waitSiteTimers.get(String(chatId));
  if (t) clearInterval(t);
  waitSiteTimers.delete(String(chatId));
}

function scheduleCodeExpireEdit(chatId, phone, delayMs) {
  const id = String(chatId);
  clearExpireTimer(id);
  const wait = Math.max(1000, delayMs || DEVICE_TTL_FALLBACK());
  const timer = setTimeout(() => {
    expireTimers.delete(id);
    showDeviceCodeExpired(chatId, phone).catch((e) =>
      console.warn('TG code expire edit:', e.message)
    );
  }, wait);
  if (typeof timer.unref === 'function') timer.unref();
  expireTimers.set(id, timer);
}

function DEVICE_TTL_FALLBACK() {
  try {
    return require('./otp').DEVICE_TTL_MS || 120000;
  } catch (_) {
    return 120000;
  }
}

async function showDeviceCodeExpired(chatId, phone) {
  const text = deviceCodeExpiredText();
  const markup = deviceCodeMarkup();
  const id = await editOrReplace(chatId, getMainMsgId(chatId), { text, reply_markup: markup });
  if (id) setMainMsgId(chatId, id);
  if (phone) {
    try {
      const { setDeviceLoginMsgIds, getDevicePending } = require('./otp');
      const pending = getDevicePending(phone);
      if (pending) setDeviceLoginMsgIds(phone, { codeMsgId: id });
    } catch (_) {}
  }
  return id;
}

async function upsertDeviceCodeMessage(chatId, code, ttlLeft, prevMsgId, opts = {}) {
  clearWaitSiteTimer(chatId);
  try {
    const st = getAwait(chatId);
    if (st && (st.type === 'wait_site_code' || st.type === 'login_code_phone')) {
      setAwait(chatId, null);
    }
  } catch (_) {}
  const left = Math.max(0, +(ttlLeft || 0));
  const isNew = !!opts.isNew;
  const text = left > 0 ? deviceCodeText(code, left, { isNew }) : deviceCodeExpiredText();
  const markup = deviceCodeMarkup();

  /* новый код — всегда новое сообщение, старое удаляем */
  if (isNew || opts.forceNew) {
    const oldIds = [...new Set(
      [prevMsgId, getMainMsgId(chatId), opts.prevMsgId]
        .filter(Boolean)
        .map((x) => Number(x))
    )];
    let id = null;
    try {
      const sent = await sendWithMarkupFallback(chatId, { text, reply_markup: markup });
      id = sent && sent.message_id;
    } catch (e) {
      console.error('TG new code send:', e.message);
    }
    if (id) {
      setMainMsgId(chatId, id);
      for (const oid of oldIds) {
        if (+oid !== +id) await safeDelete(chatId, oid);
      }
    } else {
      id = await editOrReplace(chatId, prevMsgId || getMainMsgId(chatId), { text, reply_markup: markup });
      if (id) setMainMsgId(chatId, id);
    }
    if (opts.scheduleExpire !== false && left > 0) {
      scheduleCodeExpireEdit(chatId, opts.phone || '', left * 1000);
    }
    return id;
  }

  const id = await editOrReplace(chatId, prevMsgId || getMainMsgId(chatId), { text, reply_markup: markup });
  if (id) setMainMsgId(chatId, id);
  if (opts.scheduleExpire !== false && left > 0) {
    scheduleCodeExpireEdit(chatId, opts.phone || '', left * 1000);
  }
  return id;
}

async function showWaitingForSiteCode(chatId, phone) {
  const p = String(phone || '').trim();
  setAwait(chatId, { type: 'wait_site_code', phone: p, since: Date.now() });
  const id = await editOrReplace(chatId, getMainMsgId(chatId), {
    text: waitingSiteCodeText(p),
    reply_markup: waitingSiteCodeMarkup()
  });
  if (id) setMainMsgId(chatId, id);
  startWaitSiteCodePoll(chatId, p);
  return id;
}

function startWaitSiteCodePoll(chatId, phone) {
  clearWaitSiteTimer(chatId);
  const id = String(chatId);
  let ticks = 0;
  const timer = setInterval(async () => {
    ticks += 1;
    if (ticks > 90) { /* ~3 мин */
      clearWaitSiteTimer(chatId);
      return;
    }
    const awaitState = getAwait(chatId);
    if (!awaitState || awaitState.type !== 'wait_site_code') {
      clearWaitSiteTimer(chatId);
      return;
    }
    try {
      const { getDevicePending, deliverDeviceLoginCode, setDeviceLoginMsgIds } = require('./otp');
      const { getLink } = require('./tg-users');
      const { findById } = require('./auth');
      const pending = getDevicePending(phone || awaitState.phone);
      if (!pending || !pending.code || pending.status === 'expired') return;
      if (Date.now() > (pending.expiresAt || 0)) return;

      clearWaitSiteTimer(chatId);
      const link = getLink(chatId);
      let userId = link && link.userId;
      if (!userId && phone) {
        try {
          const { findByPhone } = require('./auth');
          const u = findByPhone(phone);
          if (u) userId = u.id;
        } catch (_) {}
      }
      const issued = deliverDeviceLoginCode({
        chatId,
        userId,
        phone: phone || awaitState.phone
      });
      setAwait(chatId, null);
      const codeMsgId = await upsertDeviceCodeMessage(
        chatId,
        issued.code,
        issued.ttlLeft,
        getMainMsgId(chatId),
        { phone: issued.phone, scheduleExpire: true }
      );
      setDeviceLoginMsgIds(issued.phone, { codeMsgId });
    } catch (e) {
      if (e.needSiteRequest || e.status === 404) return;
      console.warn('TG wait site code:', e.message);
    }
  }, 2000);
  if (typeof timer.unref === 'function') timer.unref();
  waitSiteTimers.set(id, timer);
}

async function notifyDeviceLoginSuccess(chatId, meta = {}) {
  if (!chatId) return;
  clearExpireTimer(chatId);
  try {
    if (meta.gotPhoneMsgId) await safeDelete(chatId, meta.gotPhoneMsgId);
  } catch (_) {}

  const shop = shopHttps();
  const url = shop ? `${shop}/?from=tg` : '';
  const text = [
    '✅ <b>Вход успешен</b>',
    '',
    'Вы вошли в аккаунт на сайте.'
  ].join('\n');
  const markup = url
    ? { inline_keyboard: [[urlBtn('🌐 Открыть сайт', url)], [cbBtn('🏠 Домой', 'home')]] }
    : welcomeMarkup(chatId);

  const editId = meta.codeMsgId || getMainMsgId(chatId);
  try {
    const id = await editOrReplace(chatId, editId, { text, reply_markup: markup });
    if (id) setMainMsgId(chatId, id);
  } catch (e) {
    console.error('TG login success edit:', e.message);
  }
}

async function askShareContact(chatId, { title, hint } = {}) {
  const text = [
    title || '<b>Нужен номер Telegram</b>',
    '',
    hint || 'Нажмите кнопку ниже и поделитесь контактом.'
  ].join('\n');
  try {
    const sent = await api('sendMessage', {
      chat_id: chatId,
      text,
      parse_mode: 'HTML',
      reply_markup: {
        keyboard: [[{ text: '📱 Поделиться контактом', request_contact: true }]],
        resize_keyboard: true,
        one_time_keyboard: true
      }
    });
    const id = (sent && sent.message_id) || null;
    if (id) addExtraMsgId(chatId, id);
    return id;
  } catch (e) {
    console.error('TG ask contact:', e.message);
    return null;
  }
}

async function clearShareContactUi(chatId, contactAskMsgId) {
  if (contactAskMsgId) {
    try { await safeDelete(chatId, contactAskMsgId); } catch (_) {}
  }
  try {
    const rm = await api('sendMessage', {
      chat_id: chatId,
      text: '\u200B',
      reply_markup: { remove_keyboard: true }
    });
    if (rm && rm.message_id) scheduleDelete(chatId, rm.message_id, 800);
  } catch (_) {}
}

async function issueLoginCodeForChat(chatId, from = {}) {
  const { getLink } = require('./tg-users');
  const { findById } = require('./auth');
  const { deliverDeviceLoginCode, setDeviceLoginMsgIds, getDevicePending } = require('./otp');

  const link = getLink(chatId);
  let user = null;
  if (link && link.userId) user = findById(link.userId);

  if (!user || !user.phone) {
    const askId = await editOrReplace(chatId, getMainMsgId(chatId), {
      text: [
        '🔑 <b>Вход по коду</b>',
        '',
        'Поделитесь контактом — номер должен совпасть с тем, что указали на сайте.',
        '',
        '<i>Ваши данные хранятся на аккаунте, с которого вы запросили вход.</i>'
      ].join('\n'),
      reply_markup: {
        inline_keyboard: [[cbBtn('🏠 Домой', 'home')]]
      }
    });
    if (askId) setMainMsgId(chatId, askId);

    const contactAskMsgId = await askShareContact(chatId, {
      title: '📱 <b>Поделиться номером</b>',
      hint: 'Нажмите «Поделиться контактом» — так бот узнает ваш Telegram-номер.'
    });
    setAwait(chatId, {
      type: 'login_code_phone',
      contactAskMsgId: contactAskMsgId || null
    });
    return { needContact: true };
  }

  /* уже есть pending с сайта — сразу выдать */
  try {
    const pending = getDevicePending(user.phone);
    if (pending && pending.code && pending.status !== 'expired' && Date.now() <= (pending.expiresAt || 0)) {
      const issued = deliverDeviceLoginCode({
        chatId,
        userId: user.id,
        phone: user.phone
      });
      const codeMsgId = await upsertDeviceCodeMessage(
        chatId,
        issued.code,
        issued.ttlLeft,
        issued.codeMsgId || getMainMsgId(chatId),
        { phone: user.phone, scheduleExpire: true }
      );
      setDeviceLoginMsgIds(user.phone, { codeMsgId });
      return { ok: true, code: issued.code };
    }
  } catch (_) {}

  try {
    const issued = deliverDeviceLoginCode({
      chatId,
      userId: user.id,
      phone: user.phone
    });
    const codeMsgId = await upsertDeviceCodeMessage(
      chatId,
      issued.code,
      issued.ttlLeft,
      issued.codeMsgId || getMainMsgId(chatId),
      { phone: user.phone, scheduleExpire: true }
    );
    setDeviceLoginMsgIds(user.phone, { codeMsgId });
    return { ok: true, code: issued.code };
  } catch (e) {
    const expired = !!(e.expired || /истёк/i.test(String(e.message || '')));
    if (expired) {
      await showDeviceCodeExpired(chatId, user.phone);
      return { ok: false, expired: true };
    }
    if (e.needSiteRequest || e.status === 404) {
      await showWaitingForSiteCode(chatId, user.phone);
      return { ok: false, waiting: true };
    }
    const text = '<b>Не удалось выдать код</b>\n\nЗапросите код на сайте и нажмите «Повторить».';
    const id = await editOrReplace(chatId, getMainMsgId(chatId), {
      text,
      reply_markup: waitingSiteCodeMarkup()
    });
    if (id) setMainMsgId(chatId, id);
    return { ok: false, error: e.message };
  }
}

async function resendLoginCodeForChat(chatId, from = {}) {
  const { getLink } = require('./tg-users');
  const { findById } = require('./auth');
  const {
    renewDeviceLoginFromChat,
    getDevicePending,
    setDeviceLoginMsgIds
  } = require('./otp');

  const link = getLink(chatId);
  const user = link && link.userId ? findById(link.userId) : null;
  let phone = (user && user.phone) || '';
  if (!phone) {
    const st = getAwait(chatId);
    phone = (st && st.phone) || '';
  }
  if (!phone) {
    return issueLoginCodeForChat(chatId, from);
  }

  try {
    const prev = getDevicePending(phone);
    const prevMsgId = (prev && prev.codeMsgId) || getMainMsgId(chatId);
    const out = await renewDeviceLoginFromChat({
      chatId,
      userId: user && user.id,
      phone
    });
    const pending = getDevicePending(phone);
    /* если авто-отправка не сработала — шлём «Новый код» сами */
    if (pending && pending.code && !out.autoSent) {
      const ttlLeft = Math.max(
        1,
        Math.ceil(((pending.expiresAt || Date.now()) - Date.now()) / 1000)
      );
      const codeMsgId = await upsertDeviceCodeMessage(
        chatId,
        pending.code,
        ttlLeft,
        prevMsgId,
        { phone, scheduleExpire: true, isNew: true }
      );
      setDeviceLoginMsgIds(phone, { codeMsgId });
    }
    return { ok: true, renewed: true };
  } catch (e) {
    if (e.needSiteRequest || e.status === 404) {
      await showWaitingForSiteCode(chatId, phone);
      return { ok: false, waiting: true };
    }
    const text = '<b>Не удалось обновить код</b>\n\nЗапросите код на сайте и нажмите «Повторить».';
    const id = await editOrReplace(chatId, getMainMsgId(chatId), {
      text,
      reply_markup: waitingSiteCodeMarkup()
    });
    if (id) setMainMsgId(chatId, id);
    return { ok: false, error: e.message };
  }
}

function shortOrderStatusText(order) {
  if (!order) return 'Заказов пока нет';
  const track = String(order.tracking || '').trim();
  const status = order.status || '—';
  const lines = [`№${order.num}: ${status}`];
  if (track) lines.push(`Трек: ${track}`);
  else if (/едет/i.test(status)) lines.push('Трек появится здесь, когда отправим');
  return lines.join('\n');
}

async function quickOrderStatusForChat(chatId) {
  const { getLink } = require('./tg-users');
  const { findById } = require('./auth');
  const { listOrdersForUser, listAllOrders } = require('./orders');
  const link = getLink(chatId);
  let orders = [];
  if (link && link.userId) {
    const user = findById(link.userId);
    if (user) orders = listOrdersForUser(user) || [];
  }
  if (!orders.length && link && link.email) {
    orders = (listAllOrders() || []).filter((o) =>
      String(o.email || '').toLowerCase() === String(link.email).toLowerCase()
    );
  }
  const active = orders.find((o) => !/доставлен|отмен|возврат/i.test(String(o.status || '')));
  const order = active || orders[0] || null;
  return shortOrderStatusText(order);
}

function connectMarkup(chatId, extraRow) {
  const rows = [];
  if (extraRow) {
    if (Array.isArray(extraRow[0])) rows.push(...extraRow);
    else rows.push(extraRow);
  }
  if (chatHasLinkedAccount(chatId) && countOrdersForChat(chatId) > 0) {
    rows.push([cbBtn('📦 Мои заказы', 'my_orders')]);
  }
  const url = siteUrl(chatId);
  if (url) rows.push([urlBtn('🌐 На сайт', url)]);
  rows.push([cbBtn('🏠 Домой', 'home')]);
  return { inline_keyboard: rows };
}

function alreadyLinkedText() {
  return [
    '🔔 <b>Уведомления уже подключены</b>',
    '',
    'Статусы заказов и сообщение о доставке приходят в этот чат.'
  ].join('\n');
}

function chatTakenText() {
  return [
    '⚠️ <b>Этот Telegram уже привязан к другому аккаунту</b>',
    '',
    'Выйдите из того аккаунта на сайте или напишите в поддержку.'
  ].join('\n');
}

function userTakenText() {
  return [
    '⚠️ <b>Уведомления уже подключены к другому Telegram</b>',
    '',
    'Если это вы — нажмите «Перепривязать к этому чату».'
  ].join('\n');
}

function connectedText() {
  return [
    '✅ <b>Уведомления подключены</b>',
    '',
    'Здесь будут статусы заказов.',
    'Отдельное сообщение придёт, когда заказ доставят.'
  ].join('\n');
}

function formatCustomerOrder(order) {
  const items = (order.items || []).map((i) =>
    `· <b>${escHtml(i.name || 'Товар')}</b>${i.size ? ' · ' + escHtml(i.size) : ''} × ${i.qty || 1}`
  );
  const track = String(order.tracking || '').trim();
  const status = String(order.status || '').trim();
  const paid = String(order.payStatus || order.pay_status || '') === 'paid';
  const cancelled = /отмен/i.test(status);
  const stIcon = statusEmoji(status);
  return [
    `${stIcon} <b>Ваш заказ №${escHtml(order.num)}</b>`,
    status ? `Статус: ${escHtml(status)}` : '',
    '',
    items.length ? items.join('\n') : '· Заказ',
    '',
    `💰 Сумма: <b>${money(order.price)}</b>`,
    cancelled ? '' : `⏱ Срок: ${escHtml(etaText())}`,
    track ? `📍 Трек: <code>${escHtml(track)}</code>` : '',
    cancelled
      ? (paid
        ? '\nВернём ваши деньги в течение дня на ту же карту.'
        : '\nЗаказ отменён.')
      : ''
  ].filter((x) => x !== '').join('\n');
}

function customerOrderMarkup(order, chatId) {
  const rows = [];
  const url = siteUrl(chatId, { hash: 'orders' });
  if (url) rows.push([urlBtn('🌐 Открыть на сайте', url)]);
  return { inline_keyboard: rows };
}

function customerOrderDetailMarkup(order, chatId) {
  const rows = [];
  const url = siteUrl(chatId, { hash: 'orders' });
  if (url) rows.push([urlBtn('🌐 Открыть на сайте', url)]);
  rows.push([cbBtn('⬅️ К заказам', 'my_orders')]);
  rows.push([cbBtn('🏠 Домой', 'home')]);
  return { inline_keyboard: rows };
}

function statusAccent(_status) {
  return '';
}

function ownerOrderTitle(order) {
  const status = String(order.status || '');
  if (/доставлен/i.test(status)) return '✅ <b>Заказ доставлен</b>';
  if (/возврат/i.test(status)) return '↩️ <b>Возврат</b>';
  if (/отмен/i.test(status)) return '❌ <b>Заказ отменён</b>';
  if (wasOwnerNotified(order.num)) return '📦 <b>Заказ</b>';
  return '🆕 <b>Новый заказ</b>';
}

function formatOwnerGoods(order) {
  const items = order.items || [];
  if (!items.length) return '—';
  const lines = items.slice(0, 12).map((i) => {
    const name = escHtml(i.name || 'Товар');
    const size = i.size ? ` · ${escHtml(i.size)}` : '';
    return `${name}${size} × ${i.qty || 1}`;
  });
  if (items.length > 12) lines.push(`…ещё ${items.length - 12}`);
  return lines.join('\n');
}

function formatOwnerPvz(order) {
  const pvz = order.pvz || order.addr || '';
  if (!pvz) return '—';
  if (typeof pvz === 'string') return pvz;
  return [pvz.city, pvz.addr].filter(Boolean).join(', ') || pvz.addr || '—';
}

function formatOwnerOrder(order) {
  const guest = order.guest || {};
  const who = order.customerName || guest.name || '—';
  const phone = order.phone || guest.phone || '—';
  const email = order.email || guest.email || '—';
  const track = String(order.tracking || '').trim();
  const status = order.status || '—';
  const goods = formatOwnerGoods(order);
  const pvz = formatOwnerPvz(order);
  const goodsHtml = goods === '—' ? '—' : goods;
  const goodsLine = goodsHtml.includes('\n')
    ? `<b>Товары:</b>\n${goodsHtml}`
    : `<b>Товары:</b> ${goodsHtml}`;

  return [
    `${ownerOrderTitle(order)} · <code>№${escHtml(order.num)}</code>`,
    '',
    `<b>Сумма:</b> ${money(order.price)}`,
    `<b>Клиент:</b> ${escHtml(who)}`,
    `<b>Телефон:</b> ${escHtml(phone)}`,
    `<b>Email:</b> ${escHtml(email)}`,
    '',
    goodsLine,
    `<b>ПВЗ:</b> ${escHtml(pvz)}`,
    `<b>Статус:</b> ${statusEmoji(status)} ${escHtml(status)}`,
    `<b>Трек:</b> ${track ? `<code>${escHtml(track)}</code>` : '—'}`
  ].join('\n');
}

function ownerOrderMarkup(order, chatId) {
  const num = order.num;
  const status = order.status || '';
  const delivered = /доставлен/i.test(status);
  const cancelled = /отмен/i.test(status);
  const rows = [];

  if (delivered) {
    rows.push([cbBtn('↩️ Возврат', `oset:${num}:r`)]);
    rows.push([cbBtn('📍 Изменить трек', `otrk:${num}`)]);
  } else if (!cancelled) {
    rows.push([
      cbBtn('📍 Указать трек', `otrk:${num}`),
      cbBtn('🔄 Сменить статус', `osts:${num}`)
    ]);
  }

  const url = siteUrl(chatId, { go: 'admin' });
  if (url) rows.push([urlBtn('🌐 Открыть на сайте', url)]);
  return { inline_keyboard: rows };
}

function ownerStatusPickMarkup(order) {
  const num = order.num;
  const delivered = /доставлен/i.test(String(order.status || ''));
  const rows = [];
  if (delivered) {
    rows.push([cbBtn('↩️ Возврат', `oset:${num}:r`)]);
  } else {
    const opts = [
      ['📦 В обработке', 'w'],
      ['🚚 Едет', 'e'],
      ['✅ Доставлен', 'd'],
      ['❌ Отменён', 'c'],
      ['↩️ Возврат', 'r']
    ];
    for (const [label, code] of opts) {
      rows.push([cbBtn(label, `oset:${num}:${code}`)]);
    }
  }
  rows.push([cbBtn('⬅️ Назад', `oback:${num}`)]);
  return { inline_keyboard: rows };
}

function formatDeliveredPush(order) {
  const items = (order.items || []).slice(0, 6).map((i) =>
    `· ${escHtml(i.name || 'Товар')}${i.size ? ' · ' + escHtml(i.size) : ''}`
  );
  return [
    '🎉 <b>Заказ доставлен</b>',
    `№${escHtml(order.num)} · ${money(order.price)}`,
    items.length ? '' : null,
    items.join('\n'),
    '',
    'Спасибо, что выбрали Canvas 🖤'
  ].filter((x) => x != null && x !== undefined).join('\n');
}

/* ---- edit helpers: сначала новое/edit, старое удаляем только после успеха ---- */
async function sendWithMarkupFallback(chatId, { text, reply_markup, silent }) {
  try {
    return await api('sendMessage', {
      chat_id: chatId,
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      disable_notification: !!silent,
      reply_markup
    });
  } catch (e1) {
    /* URL-кнопка сломала отправку (например, невалидный PUBLIC_URL) — шлём без клавиатуры */
    console.error('TG send markup fail:', e1.message);
    try {
      return await api('sendMessage', {
        chat_id: chatId,
        text,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
        disable_notification: !!silent
      });
    } catch (e2) {
      console.error('TG send plain fail:', e2.message);
      throw e2;
    }
  }
}

async function editOrReplace(chatId, messageId, { text, reply_markup, silent }) {
  if (messageId) {
    try {
      await api('editMessageText', {
        chat_id: chatId,
        message_id: messageId,
        text,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
        reply_markup
      });
      return messageId;
    } catch (e) {
      if (/not modified/i.test(String(e.message || ''))) return messageId;
      /* edit не вышел — НЕ удаляем сразу: сначала отправим новое */
    }
  }

  try {
    const sent = await sendWithMarkupFallback(chatId, { text, reply_markup, silent });
    const id = sent && sent.message_id;
    /* старое убираем только когда новое уже в чате */
    if (id && messageId && +id !== +messageId) {
      await safeDelete(chatId, messageId);
    }
    return id;
  } catch (e) {
    console.error('TG editOrReplace:', e.message);
    return messageId || null;
  }
}

async function upsertMain(chatId, { text, reply_markup }, preferId) {
  const target = preferId || getMainMsgId(chatId);
  const id = await editOrReplace(chatId, target, { text, reply_markup });
  if (id) {
    setMainMsgId(chatId, id);
    await sweepStaleUi(chatId, id);
  }
  return id;
}

async function showWelcome(chatId, from = {}, opts = {}) {
  claimOwner(chatId, from);
  /* если уже админ бота и TG привязан к аккаунту — сразу роль admin на сайте */
  if (isOwnerChat(chatId)) {
    try { await promoteChatToSiteAdmin(chatId); } catch (_) {}
  }
  clearWaitSiteTimer(chatId);
  clearExpireTimer(chatId);
  try {
    const sup = getSupport(chatId);
    if (sup && sup.status === 'waiting') {
      for (const [cid, mid] of Object.entries(sup.notifyMsgIds || {})) {
        await safeDelete(cid, mid);
      }
      setSupport(chatId, null);
    }
  } catch (_) {}
  const prevAwait = getAwait(chatId);
  if (prevAwait && prevAwait.contactAskMsgId) {
    await clearShareContactUi(chatId, prevAwait.contactAskMsgId);
  } else {
    setAwait(chatId, null);
    try {
      const rm = await api('sendMessage', {
        chat_id: chatId,
        text: '\u200B',
        reply_markup: { remove_keyboard: true }
      });
      if (rm && rm.message_id) await safeDelete(chatId, rm.message_id);
    } catch (_) {}
  }
  setAwait(chatId, null);

  /* /start — новое сообщение внизу чата, старое меню стираем.
     Кнопка — правим то сообщение, на которое нажали. */
  if (opts.forceNew) {
    const sent = await sendWithMarkupFallback(chatId, {
      text: welcomeText(),
      reply_markup: welcomeMarkup(chatId)
    });
    const id = sent && sent.message_id;
    if (id) {
      setMainMsgId(chatId, id);
      await sweepStaleUi(chatId, id);
    }
    return id;
  }
  return upsertMain(chatId, {
    text: welcomeText(),
    reply_markup: welcomeMarkup(chatId)
  }, opts.preferId);
}

async function refreshCustomerMainMenu(chatId) {
  if (!chatId || isOwnerChat(chatId)) return;
  const mainId = getMainMsgId(chatId);
  if (!mainId) return;
  try {
    await editOrReplace(chatId, mainId, {
      text: welcomeText(),
      reply_markup: welcomeMarkup(chatId)
    });
  } catch (_) {}
}

async function showConnectResult(chatId, kind, userId) {
  if (isOwnerChat(chatId) && (kind === 'ok' || kind === 'already_same' || !kind)) {
    try { await promoteChatToSiteAdmin(chatId); } catch (_) {}
  }
  if (kind === 'already_same') {
    return upsertMain(chatId, {
      text: alreadyLinkedText(),
      reply_markup: connectMarkup(chatId)
    });
  }
  if (kind === 'chat_taken') {
    return upsertMain(chatId, {
      text: chatTakenText(),
      reply_markup: connectMarkup(chatId)
    });
  }
  if (kind === 'user_taken') {
    return upsertMain(chatId, {
      text: userTakenText(),
      reply_markup: connectMarkup(chatId, [
        cbBtn('🔗 Перепривязать к этому чату', `relink:${userId}`)
      ])
    });
  }
  return upsertMain(chatId, {
    text: connectedText(),
    reply_markup: connectMarkup(chatId)
  });
}

/** Карточка покупателя — строго edit одного message_id на заказ. */
async function upsertCustomerOrderCard(order) {
  if (!order || !TOKEN()) return;
  const chatId = findChatForOrder(order);
  if (!chatId) return;
  /* тот же чат = владелец → только админ-карточка, без дубля */
  if (isOwnerChat(chatId)) return;

  const text = formatCustomerOrder(order);
  const markup = customerOrderMarkup(order, chatId);
  const prev = getOrderMsgId(chatId, order.num);
  const id = await editOrReplace(chatId, prev, { text, reply_markup: markup, silent: !!prev });
  if (id) {
    setOrderMsgId(chatId, order.num, id);
    /* если прислали новое — убедимся, что старый id стёрт */
    if (prev && +prev !== +id) {
      try { await safeDelete(chatId, prev); } catch (_) {}
    }
  }
  return id;
}

/** Карточка владельца с кнопками управления (один чат). */
async function upsertOwnerOrderCardForChat(chatId, order, { replaceMain = false, bump = false } = {}) {
  if (!order || !TOKEN() || !chatId) return;

  const text = formatOwnerOrder(order);
  const markup = ownerOrderMarkup(order, chatId);
  const prev = getOwnerOrderMsgId(chatId, order.num);
  const id = await editOrReplace(chatId, bump ? null : prev, {
    text,
    reply_markup: markup,
    silent: !bump && !!prev
  });
  if (id) setOwnerOrderMsgId(chatId, order.num, id);
  if (bump && prev && id && +prev !== +id) {
    try { await safeDelete(chatId, prev); } catch (_) {}
  }
  return id;
}

/** Обновить карточки у всех Telegram-админов. */
async function upsertOwnerOrderCard(order, { replaceMain = false, chatId = null } = {}) {
  if (!order || !TOKEN()) return;
  if (chatId) {
    return upsertOwnerOrderCardForChat(chatId, order, { replaceMain });
  }
  const ids = getOwnerChatIds();
  for (const id of ids) {
    try {
      await upsertOwnerOrderCardForChat(id, order, { replaceMain });
    } catch (e) {
      console.error('TG owner card', id, e.message);
    }
  }
}

function isConfirmedOrder(order) {
  const pay = String((order && (order.payStatus || order.pay_status)) || '');
  return pay === 'paid' || pay === 'manual';
}

async function notifyCustomerOrder(order) {
  if (!order || !isConfirmedOrder(order)) return;
  await upsertCustomerOrderCard(order);
  await upsertOwnerOrderCard(order);

  const delivered = /доставлен/i.test(String(order.status || ''));
  if (!delivered || wasDeliveredPushed(order.num)) return;

  const chatId = findChatForOrder(order);
  if (!chatId || !TOKEN() || isOwnerChat(chatId)) {
    markDeliveredPushed(order.num);
    return;
  }

  const url = siteUrl(chatId, { hash: 'orders' });
  const markup = url
    ? { inline_keyboard: [[urlBtn('🌐 На сайт', url)]] }
    : undefined;
  try {
    await api('sendMessage', {
      chat_id: chatId,
      text: formatDeliveredPush(order),
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      reply_markup: markup
    });
    markDeliveredPushed(order.num);
  } catch (e) {
    console.error('TG delivered push:', e.message);
  }
}

async function notifyCustomerNewOrder(order) {
  if (!order || !isConfirmedOrder(order)) return;
  const chatId = findChatForOrder(order);
  if (chatId && !isOwnerChat(chatId)) {
    /* обновить главное меню: появится «Мои заказы» */
    await refreshCustomerMainMenu(chatId);
  }
  return upsertCustomerOrderCard(order);
}

async function notifyOwnerNewOrder(order) {
  if (!order || !TOKEN() || !isConfirmedOrder(order)) return;
  const chats = getOwnerChatIds();
  if (!chats.length) return;
  const firstTime = !wasOwnerNotified(order.num);
  for (const chat of chats) {
    try {
      await upsertOwnerOrderCardForChat(chat, order, { replaceMain: false });
    } catch (e) {
      console.error('TG owner notify', chat, e.message);
    }
  }
  if (firstTime) markOwnerNotified(order.num);
}

/** Отдельное сообщение — иначе карточка тихо правится и админ ничего не видит. */
async function notifyOwnerCancelled(order) {
  if (!order || !TOKEN() || !isConfirmedOrder(order)) return;
  const chats = getOwnerChatIds();
  if (!chats.length) return;
  await upsertOwnerOrderCard(order);
  const paid = String(order.payStatus || order.pay_status || '') === 'paid';
  const who = escHtml(order.customerName || 'Покупатель');
  const phone = order.phone ? escHtml(order.phone) : '';
  const text = [
    '❌ <b>Покупатель отменил заказ</b>',
    `№${escHtml(String(order.num))} · ${money(order.price)}`,
    '',
    who,
    phone,
    paid ? '\nВерните деньги в течение дня.' : ''
  ].filter((line) => line !== '').join('\n');
  for (const chat of chats) {
    try {
      await sendWithMarkupFallback(chat, {
        text,
        silent: false,
        reply_markup: {
          inline_keyboard: [[cbBtn('📦 Открыть заказ', `oopen:${order.num}`)]]
        }
      });
    } catch (e) {
      console.error('TG owner cancel', chat, e.message);
    }
  }
}

function parseStartPayload(text) {
  const m = /^\/start(?:@\w+)?(?:\s+(.+))?$/i.exec(String(text || '').trim());
  if (!m) return null;
  const raw = String(m[1] || '').trim();
  if (!raw) return { kind: 'start' };
  const uid = /^u(\d+)$/i.exec(raw);
  if (uid) return { kind: 'link', userId: +uid[1] };
  if (/^reg$/i.test(raw)) return { kind: 'reg' };
  if (/^log(?:in)?$/i.test(raw)) return { kind: 'login' };
  if (/^(support|op|help|operator)$/i.test(raw)) return { kind: 'support' };
  const otp = /^c([a-f0-9]{6,16})$/i.exec(raw);
  if (otp) return { kind: 'otp', session: otp[1] };
  return { kind: 'start', payload: raw };
}

async function showRegAskPhone(chatId, from = {}, mode = 'reg') {
  claimOwner(chatId, from);
  const isLogin = mode === 'log';
  const contactAskMsgId = await askShareContact(chatId, {
    title: isLogin ? '<b>Вход в Canvas</b>' : '<b>Регистрация в Canvas</b>',
    hint: 'Нажмите кнопку ниже и поделитесь номером — этого достаточно.'
  });
  setAwait(chatId, {
    type: 'reg_phone',
    mode: isLogin ? 'log' : 'reg',
    contactAskMsgId: contactAskMsgId || null
  });
}

async function handleContactReg(msg) {
  const chatId = msg.chat.id;
  const from = msg.from || {};
  const c = msg.contact;
  if (!c || !c.phone_number) return false;

  /* только свой контакт */
  if (c.user_id && from.id && +c.user_id !== +from.id) {
    await sendWithMarkupFallback(chatId, {
      text: 'Нужен ваш собственный номер — нажмите «Поделиться контактом» ещё раз.'
    });
    return true;
  }

  try {
    const { upsertUserByPhone, issueTgPhoneToken, findByPhone } = require('./auth');
    const { normalizePhone } = require('./sms');
    const { tryLink } = require('./tg-users');
    const awaitState = getAwait(chatId);
    const wantLoginCode = !!(awaitState && awaitState.type === 'login_code_phone');
    const contactAskMsgId = awaitState && awaitState.contactAskMsgId;

    const phoneNorm = normalizePhone(c.phone_number);
    const existed = !!(phoneNorm && findByPhone(phoneNorm));
    const user = upsertUserByPhone({
      phone: c.phone_number,
      name: '',
      last: '',
      via: 'telegram'
    });
    try {
      const link = tryLink(chatId, from, user.id);
      if (link && (link.status === 'chat_taken' || link.status === 'user_taken')) {
        console.warn('TG contact link skipped:', link.status);
      }
    } catch (e) {
      console.warn('TG contact link:', e.message);
    }

    setAwait(chatId, null);
    await clearShareContactUi(chatId, contactAskMsgId);

    /* вход с другого устройства — выдать код или ждать запрос с сайта */
    if (wantLoginCode) {
      try {
        const { deliverDeviceLoginCode, setDeviceLoginMsgIds, getDevicePending } = require('./otp');
        const pending = getDevicePending(c.phone_number);
        if (!pending || !pending.code || pending.status === 'expired') {
          await showWaitingForSiteCode(chatId, c.phone_number);
          return true;
        }
        const issued = deliverDeviceLoginCode({
          chatId,
          userId: user.id,
          phone: c.phone_number
        });
        const codeMsgId = await upsertDeviceCodeMessage(
          chatId,
          issued.code,
          issued.ttlLeft,
          getMainMsgId(chatId),
          { phone: c.phone_number, scheduleExpire: true }
        );
        setDeviceLoginMsgIds(c.phone_number, { codeMsgId });
      } catch (e) {
        console.error('TG device code after contact:', e.message);
        if (e.needSiteRequest || e.status === 404 || e.expired) {
          await showWaitingForSiteCode(chatId, c.phone_number);
        } else {
          const id = await editOrReplace(chatId, getMainMsgId(chatId), {
            text: 'Не удалось выдать код: ' + (e.message || 'ошибка'),
            reply_markup: waitingSiteCodeMarkup()
          });
          if (id) setMainMsgId(chatId, id);
        }
      }
      return true;
    }

    const code = issueTgPhoneToken(c.phone_number, chatId);
    const shop = shopHttps();
    const url = shop ? `${shop}/?tg_phone=${encodeURIComponent(code)}` : '';

    if (!url) {
      const { authLog } = require('./auth-log');
      authLog('public_url_error', { where: 'tg_phone_reg', chatId: String(chatId) });
      console.error('TG phone reg: нет PUBLIC_URL/HTTPS — кнопка входа не создана');
      const id = await editOrReplace(chatId, getMainMsgId(chatId), {
        text: [
          existed ? '<b>С возвращением</b>' : '<b>Вы зарегистрированы</b>',
          '',
          'Аккаунт создан, но ссылка на сайт ещё не настроена (нужен HTTPS PUBLIC_URL).',
          'Откройте сайт магазина вручную и войдите через Telegram снова.'
        ].join('\n')
      });
      if (id) setMainMsgId(chatId, id);
      return true;
    }

    const text = [
      existed ? '<b>С возвращением</b>' : '<b>Вы зарегистрированы</b>',
      '',
      existed
        ? 'Вход выполнен по номеру Telegram.'
        : 'Аккаунт в Canvas создан.',
      '',
      'Чтобы войти с другого устройства:',
      '1) На том устройстве откройте сайт → <b>Вход по коду через Telegram</b>',
      '2) Введите этот номер и нажмите «Запросить код»',
      '3) Здесь нажмите кнопку ниже — придёт код'
    ].join('\n');

    const rows = [];
    if (url) rows.push([urlBtn(existed ? '🌐 Вернуться на сайт' : '🌐 Перейти на сайт', url)]);
    rows.push([cbBtn('🔑 Код для входа на сайт', 'login_code')]);
    rows.push([cbBtn('🏠 Домой', 'home')]);
    const markup = { inline_keyboard: rows };

    let sentId = null;
    try {
      sentId = await editOrReplace(chatId, getMainMsgId(chatId), { text, reply_markup: markup });
    } catch (e) {
      console.error('TG phone button fail:', e.message);
    }
    if (!sentId) {
      try {
        const sent = await sendWithMarkupFallback(chatId, { text, reply_markup: markup });
        sentId = sent && sent.message_id;
      } catch (_) {}
    }
    if (sentId) setMainMsgId(chatId, sentId);

    try {
      require('./auth-log').authLog('login_ok', {
        phone: phoneNorm,
        chatId: String(chatId),
        via: existed ? 'tg_contact_login' : 'tg_contact_reg'
      });
    } catch (_) {}
  } catch (e) {
    console.error('TG contact reg:', e.message);
    try {
      await editOrReplace(chatId, getMainMsgId(chatId), {
        text: 'Не удалось войти: ' + (e.message || 'ошибка')
      });
    } catch (_) {}
  }
  return true;
}

async function handleTrackInput(chatId, text) {
  const awaitState = getAwait(chatId);
  if (!awaitState || awaitState.type !== 'track' || !awaitState.orderNum) return false;
  if (!isOwnerChat(chatId)) {
    setAwait(chatId, null);
    return false;
  }
  setAwait(chatId, null);
  const track = String(text || '').trim().slice(0, 200);
  try {
    const { updateOrderAdmin, getOrderByNum } = require('./orders');
    const updated = await updateOrderAdmin(awaitState.orderNum, { tracking: track });
    const o = updated || getOrderByNum(awaitState.orderNum);
    if (o) await upsertOwnerOrderCard(o);
  } catch (e) {
    console.error('TG track set:', e.message);
  }
  return true;
}

async function promoteChatToSiteAdmin(targetChatId) {
  const { getLink } = require('./tg-users');
  const { promoteUserToAdmin, findById, publicUser } = require('./auth');
  const link = getLink(targetChatId);
  if (!link || !link.userId) {
    return { promoted: false, reason: 'no_link' };
  }
  const before = findById(link.userId);
  if (!before) return { promoted: false, reason: 'no_user' };
  const wasAdmin = before.role === 'admin';
  const user = promoteUserToAdmin(link.userId);
  if (!user) return { promoted: false, reason: 'no_user' };
  return { promoted: true, user: publicUser(user), already: wasAdmin };
}

async function demoteChatFromSiteAdmin(targetChatId) {
  const { getLink } = require('./tg-users');
  const { setUserRole, findById } = require('./auth');
  const link = getLink(targetChatId);
  if (!link || !link.userId) return { demoted: false, reason: 'no_link' };
  const user = findById(link.userId);
  if (!user) return { demoted: false, reason: 'no_user' };
  const adminEmail = String(process.env.ADMIN_EMAIL || '').trim().toLowerCase();
  if (adminEmail && String(user.email || '').toLowerCase() === adminEmail) {
    return { demoted: false, reason: 'primary' };
  }
  if (user.role !== 'admin') return { demoted: false, reason: 'not_admin' };
  setUserRole(user.id, 'user');
  return { demoted: true };
}

function adminsPanelText(viewerChatId) {
  const ids = getOwnerChatIds();
  const lines = [
    '👥 <b>Админы</b>',
    '',
    ids.length ? 'Список (нажмите ❌ чтобы удалить):' : 'Список пуст — добавьте первого.'
  ];
  ids.forEach((id, i) => {
    const you = String(id) === String(viewerChatId) ? ' · вы' : '';
    lines.push(`${i + 1}) <code>${escHtml(id)}</code>${you}`);
  });
  lines.push('', 'Чтобы добавить — нажмите «➕ Добавить» и пришлите Telegram ID.');
  return lines.join('\n');
}

function adminsPanelMarkup(viewerChatId) {
  const ids = getOwnerChatIds();
  const rows = [];
  for (const id of ids.slice(0, 20)) {
    const you = String(id) === String(viewerChatId);
    rows.push([
      cbBtn(
        you ? `👤 ${id} (вы)` : `🗑 Удалить ${id}`,
        you ? 'admins_self' : `admin_del:${id}`
      )
    ]);
  }
  rows.push([cbBtn('➕ Добавить', 'add_admin')]);
  rows.push([cbBtn('🏠 Домой', 'home')]);
  return { inline_keyboard: rows };
}

async function showAdminsPanel(chatId) {
  setAwait(chatId, null);
  return upsertMain(chatId, {
    text: adminsPanelText(chatId),
    reply_markup: adminsPanelMarkup(chatId)
  });
}

async function notifyNewBotAdmin(targetChatId, byChatId) {
  const url = siteUrl(targetChatId, { go: 'admin' });
  const text = [
    '<b>Вам выдали доступ администратора</b>',
    '',
    'Откройте сайт — админ-панель появится в профиле.',
    'Если страница уже открыта, обновите её.'
  ].join('\n');
  const rows = [];
  if (url) rows.push([urlBtn('🌐 Сайт Canvas', url)]);
  try {
    await sendWithMarkupFallback(targetChatId, {
      text,
      reply_markup: rows.length ? { inline_keyboard: rows } : undefined
    });
  } catch (e) {
    console.warn('TG notify new admin:', targetChatId, e.message);
    return false;
  }
  return true;
}

async function handleAddAdminInput(chatId, text) {
  const awaitState = getAwait(chatId);
  if (!awaitState || awaitState.type !== 'add_admin') return false;
  if (!isOwnerChat(chatId)) {
    setAwait(chatId, null);
    return false;
  }

  const raw = String(text || '').trim();
  if (/^(отмена|cancel|нет)$/i.test(raw)) {
    setAwait(chatId, null);
    await showWelcome(chatId, {});
    return true;
  }

  const m = raw.match(/-?\d{5,15}/);
  const targetId = m ? m[0] : '';
  if (!targetId) {
    await upsertMain(chatId, {
      text: [
        '➕ <b>Добавить админа</b>',
        '',
        'Не похоже на ID. Пришлите только цифры, например: <code>5815094886</code>',
        '',
        'Узнать свой ID: @userinfobot'
      ].join('\n'),
      reply_markup: {
        inline_keyboard: [[cbBtn('⬅️ К списку', 'admins')]]
      }
    });
    return true;
  }

  if (String(targetId) === String(chatId)) {
    await showAdminsPanel(chatId);
    await sendWithMarkupFallback(chatId, {
      text: 'Это ваш собственный ID — вы уже админ.'
    });
    return true;
  }

  const added = addOwner(targetId);
  if (!added.ok) {
    await upsertMain(chatId, {
      text: `Не удалось: ${escHtml(added.error || 'ошибка')}`,
      reply_markup: adminsPanelMarkup(chatId)
    });
    setAwait(chatId, null);
    return true;
  }

  const site = await promoteChatToSiteAdmin(targetId);
  const notified = await notifyNewBotAdmin(targetId, chatId);
  setAwait(chatId, null);

  const lines = [
    added.already
      ? `✅ <code>${escHtml(targetId)}</code> уже был в списке.`
      : `✅ Добавлен: <code>${escHtml(targetId)}</code>`,
    ''
  ];
  if (site.promoted) {
    lines.push('На сайте аккаунт повышен до <b>admin</b>.');
  } else if (site.reason === 'no_link') {
    lines.push('Telegram ещё не привязан к аккаунту на сайте — пусть нажмёт /start и «Сайт».');
  }
  if (!notified) {
    lines.push('⚠ Не удалось написать человеку (он ещё не писал боту).');
  }

  await upsertMain(chatId, {
    text: lines.join('\n') + '\n\n' + adminsPanelText(chatId),
    reply_markup: adminsPanelMarkup(chatId)
  });
  return true;
}

async function sendDocumentFile(chatId, filePath, filename, caption) {
  const token = TOKEN();
  if (!token) throw new Error('нет TELEGRAM_BOT_TOKEN');
  if (!fs.existsSync(filePath)) throw new Error('файл не найден: ' + filename);
  const buf = fs.readFileSync(filePath);
  const form = new FormData();
  form.append('chat_id', String(chatId));
  form.append(
    'document',
    new Blob([new Uint8Array(buf)]),
    filename || path.basename(filePath)
  );
  if (caption) form.append('caption', String(caption).slice(0, 1024));
  const r = await fetch(`https://api.telegram.org/bot${token}/sendDocument`, {
    method: 'POST',
    body: form
  });
  const data = await r.json().catch(() => ({}));
  if (!data.ok) {
    throw new Error(data.description || 'Telegram sendDocument failed');
  }
  return data.result;
}

async function downloadTgFile(fileId, destPath) {
  const f = await api('getFile', { file_id: fileId });
  if (!f || !f.file_path) throw new Error('Telegram не отдал путь к файлу');
  if (f.file_size && f.file_size > require('./backup').MAX_IMPORT_BYTES) {
    throw new Error(`Файл слишком большой (${Math.round(f.file_size / 1024 / 1024)} МБ)`);
  }
  const url = `https://api.telegram.org/file/bot${TOKEN()}/${f.file_path}`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Скачивание из Telegram: HTTP ${r.status}`);
  const buf = Buffer.from(await r.arrayBuffer());
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  fs.writeFileSync(destPath, buf);
  return { path: destPath, size: buf.length };
}

function dbPanelText() {
  return [
    '🗄 <b>База сайта</b>',
    '',
    'Только для тебя. Можно скачать текущую базу, поправить товары/заказы офлайн и залить файл обратно.',
    '',
    '<b>Выгрузить</b> — пришлю <code>.db</code> (полная база) и JSON-снимок для просмотра.',
    '<b>Загрузить</b> — пришли <code>.db</code> файлом. Сначала проверю, сделаю страховку, потом заменю. Если что-то не так — откат и текст ошибки.',
    '',
    'После успешной загрузки сервер перезапустится (~несколько секунд).'
  ].join('\n');
}

function dbPanelMarkup() {
  return {
    inline_keyboard: [
      [cbBtn('⬇️ Выгрузить базу', 'db_export')],
      [cbBtn('⬆️ Загрузить базу', 'db_import')],
      [cbBtn('⬅️ Назад', 'db_back')]
    ]
  };
}

async function showDbPanel(chatId) {
  setAwait(chatId, null);
  return upsertMain(chatId, {
    text: dbPanelText(),
    reply_markup: dbPanelMarkup()
  });
}

async function runDbExport(chatId) {
  const { buildExportFiles } = require('./backup');
  await sendWithMarkupFallback(chatId, {
    text: '⏳ Собираю выгрузку…'
  });
  const out = buildExportFiles();
  if (!out.ok) {
    await sendWithMarkupFallback(chatId, {
      text: `❌ <b>Ошибка выгрузки</b>\n\n${escHtml(out.error || 'неизвестно')}`,
      reply_markup: dbPanelMarkup()
    });
    return;
  }
  for (const f of out.files) {
    try {
      await sendDocumentFile(chatId, f.path, f.filename, f.caption);
    } catch (e) {
      await sendWithMarkupFallback(chatId, {
        text: `❌ Не отправился файл <code>${escHtml(f.filename)}</code>\n\nПричина: ${escHtml(e.message || e)}`,
        reply_markup: dbPanelMarkup()
      });
      return;
    }
  }
  await sendWithMarkupFallback(chatId, {
    text: '✅ Выгрузка готова. Файлы выше.',
    reply_markup: dbPanelMarkup()
  });
}

async function beginDbImport(chatId) {
  setAwait(chatId, { type: 'db_import', at: Date.now() });
  await upsertMain(chatId, {
    text: [
      '⬆️ <b>Загрузка базы</b>',
      '',
      'Пришли сюда файл <code>.db</code> (как документ, не сжатый архив).',
      '',
      'Что сделаю:',
      '1) проверю, что это SQLite Canvas',
      '2) сохраню текущую базу как страховку',
      '3) заменю файл',
      '4) если ошибка — верну старую и напишу причину',
      '',
      'Отмена — кнопка ниже.'
    ].join('\n'),
    reply_markup: {
      inline_keyboard: [[cbBtn('❌ Отмена', 'db_panel')]]
    }
  });
}

async function handleDbDocument(msg) {
  /* Выгрузка/загрузка БД из бота отключена */
  return false;
}

async function handleDbDocument_disabled(msg) {
  const chatId = msg.chat.id;
  if (!isDataOwnerChat(chatId)) return false;

  const awaitState = getAwait(chatId);
  const doc = msg.document;
  if (!doc) return false;

  /* только после кнопки «Загрузить базу» — случайный .db не трогает сайт */
  const waiting = !!(awaitState && awaitState.type === 'db_import');
  if (!waiting) return false;

  if (awaitState.at && Date.now() - awaitState.at > 30 * 60 * 1000) {
    setAwait(chatId, null);
    await sendWithMarkupFallback(chatId, {
      text: '❌ Время ожидания файла истекло (30 мин). Нажми «Загрузить базу» ещё раз.',
      reply_markup: dbPanelMarkup()
    });
    return true;
  }

  const name = String(doc.file_name || '');
  const isDb = /\.db$/i.test(name) || /\.sqlite$/i.test(name) ||
    String(doc.mime_type || '').includes('sqlite');

  if (!isDb) {
    await sendWithMarkupFallback(chatId, {
      text: '❌ Нужен файл с расширением <code>.db</code> (база SQLite).\n\nПришлите document, не фото и не архив.',
      reply_markup: dbPanelMarkup()
    });
    return true;
  }

  const { BACKUP_DIR, restoreSqliteFromFile, MAX_IMPORT_BYTES } = require('./backup');
  if (doc.file_size && doc.file_size > MAX_IMPORT_BYTES) {
    await sendWithMarkupFallback(chatId, {
      text: `❌ Файл слишком большой (${Math.round(doc.file_size / 1024 / 1024)} МБ). Лимит ~45 МБ.`,
      reply_markup: dbPanelMarkup()
    });
    return true;
  }

  await sendWithMarkupFallback(chatId, {
    text: `⏳ Принял <code>${escHtml(name || 'file.db')}</code> — проверяю…`
  });

  const tmp = path.join(BACKUP_DIR, `tg-upload-${Date.now()}.db`);
  try {
    await downloadTgFile(doc.file_id, tmp);
  } catch (e) {
    setAwait(chatId, null);
    await sendWithMarkupFallback(chatId, {
      text: `❌ <b>Не скачал файл</b>\n\nПричина: ${escHtml(e.message || e)}`,
      reply_markup: dbPanelMarkup()
    });
    return true;
  }

  let result;
  try {
    result = restoreSqliteFromFile(tmp);
  } catch (e) {
    result = { ok: false, error: e.message || String(e) };
  } finally {
    try { fs.unlinkSync(tmp); } catch (_) {}
  }

  setAwait(chatId, null);

  if (!result.ok) {
    await sendWithMarkupFallback(chatId, {
      text: [
        '❌ <b>База не применена</b>',
        '',
        'Причина:',
        escHtml(result.error || 'неизвестно'),
        '',
        'Старая база на месте (или откатил). Сайт не ломал.'
      ].join('\n'),
      reply_markup: dbPanelMarkup()
    });
    return true;
  }

  const info = result.info || {};
  await sendWithMarkupFallback(chatId, {
    text: [
      '✅ <b>База применена</b>',
      '',
      `Товары: <b>${info.products ?? '—'}</b>`,
      `Заказы: <b>${info.orders ?? '—'}</b>`,
      `Юзеры: <b>${info.users ?? '—'}</b>`,
      result.backup ? `\nСтраховка: <code>${escHtml(path.basename(result.backup))}</code>` : '',
      '',
      'Перезапускаю сервер, чтобы подхватить файл…'
    ].filter(Boolean).join('\n')
  });

  /* рестарт — иначе старое соединение к БД останется в памяти */
  setTimeout(() => {
    console.log('[BACKUP] restart after DB restore by', chatId);
    process.exit(0);
  }, 1200);
  return true;
}

async function handleMessage(msg) {
  if (!msg || !msg.chat) return;
  const chatId = msg.chat.id;
  const from = msg.from || {};
  const text = String(msg.text || msg.caption || '').trim();
  const start = parseStartPayload(text);
  const isStart = !!(start || /^\/start\b/i.test(text));

  try {
    if (msg.contact) {
      await handleContactReg(msg);
      await safeDelete(chatId, msg.message_id);
      return;
    }

    if (msg.document) {
      const handled = await handleDbDocument(msg);
      if (handled) {
        try { await safeDelete(chatId, msg.message_id); } catch (_) {}
        return;
      }
    }

    /* поддержка: оператор ↔ клиент (не удаляем сообщения — сотрём при закрытии) */
    if (text && !isStart && (await handleSupportOperatorMessage(msg))) {
      return;
    }
    if (text && !isStart && (await handleSupportUserMessage(msg))) {
      return;
    }

    /* /start НЕ удаляем сразу — иначе Telegram на телефоне «закрывает» бота. */
    if (text && !isStart && (await handleTrackInput(chatId, text))) {
      await safeDelete(chatId, msg.message_id);
      return;
    }

    if (text && !isStart && (await handleAddAdminInput(chatId, text))) {
      await safeDelete(chatId, msg.message_id);
      return;
    }

    if (!text) {
      await showWelcome(chatId, from, { forceNew: true });
      await safeDelete(chatId, msg.message_id);
      return;
    }

    if (start && start.kind === 'support') {
      await startSupportRequest(chatId, from);
      scheduleDeleteStart(chatId, msg.message_id);
      return;
    }

    if (text && !isStart && isSupportCommand(text)) {
      await startSupportRequest(chatId, from);
      await safeDelete(chatId, msg.message_id);
      return;
    }

    if (start && start.kind === 'otp' && start.session) {
      claimOwner(chatId, from);
      try {
        const { linkOtpSession } = require('./otp');
        const r = await linkOtpSession(start.session, chatId);
        if (!r.ok) {
          await upsertMain(chatId, {
            text: `<b>${escHtml(r.error || 'Сессия не найдена')}</b>\n\nВернитесь на сайт, укажите номер и откройте бота снова.`,
            reply_markup: welcomeMarkup(chatId)
          });
        } else {
          await upsertMain(chatId, {
            text: [
              '✅ <b>Бот подключён</b>',
              '',
              'Вернитесь на сайт Canvas и нажмите «Отправить код».',
              'Код придёт сюда сообщением.'
            ].join('\n'),
            reply_markup: connectMarkup(chatId)
          });
        }
      } catch (e) {
        console.error('TG otp start:', e.message);
      }
      scheduleDeleteStart(chatId, msg.message_id);
      return;
    }

    if (start && start.kind === 'reg') {
      claimOwner(chatId, from);
      await showRegAskPhone(chatId, from, 'reg');
      scheduleDeleteStart(chatId, msg.message_id);
      return;
    }

    if (start && start.kind === 'login') {
      claimOwner(chatId, from);
      await showRegAskPhone(chatId, from, 'log');
      scheduleDeleteStart(chatId, msg.message_id);
      return;
    }

    if (start && start.kind === 'link' && start.userId) {
      claimOwner(chatId, from);
      const result = tryLink(chatId, from, start.userId);
      console.log('TG link', start.userId, '→', chatId, result.status);
      await showConnectResult(chatId, result.status, start.userId);
      scheduleDeleteStart(chatId, msg.message_id);
      return;
    }

    /* обычный /start — новое меню внизу, старые экраны бота стираем */
    if (isStart) {
      await showWelcome(chatId, from, { forceNew: true });
      scheduleDeleteStart(chatId, msg.message_id);
      return;
    }

    await showWelcome(chatId, from, { forceNew: true });
    await safeDelete(chatId, msg.message_id);
  } catch (e) {
    console.error('TG handleMessage:', e.message);
    try {
      await showWelcome(chatId, from, { forceNew: true });
    } catch (e2) {
      console.error('TG recovery welcome:', e2.message);
    }
  }
}

async function handleCallback(cq) {
  if (!cq || !cq.message || !cq.message.chat) return;
  const chatId = cq.message.chat.id;
  const from = cq.from || {};
  const data = String(cq.data || '');
  const msgId = cq.message.message_id;
  /* Всегда правим то сообщение, на которое нажали — не первое в истории чата. */
  adoptUiMessage(chatId, msgId);

  const answer = async (text, alert) => {
    try {
      await api('answerCallbackQuery', {
        callback_query_id: cq.id,
        text,
        show_alert: !!alert
      });
    } catch (_) {}
  };

  if (data === 'home' || data === 'login_code_back' || data === 'admins_back') {
    await answer();
    clearWaitSiteTimer(chatId);
    clearExpireTimer(chatId);
    try {
      const st = getAwait(chatId);
      if (st && st.contactAskMsgId) await clearShareContactUi(chatId, st.contactAskMsgId);
    } catch (_) {}
    setAwait(chatId, null);
    try {
      /* не превращать карточку заказа в меню */
      const preferId = isTrackedOrderMsg(chatId, msgId) ? null : msgId;
      await showWelcome(chatId, from, preferId ? { preferId } : { forceNew: false });
    } catch (e) {
      console.error('TG home:', e.message);
    }
    return;
  }

  if (/^relink:(\d+)$/.test(data)) {
    await answer();
    const userId = +data.split(':')[1];
    const result = relinkUser(chatId, from, userId);
    await showConnectResult(
      chatId,
      result.status === 'ok' ? 'ok' : result.status === 'chat_taken' ? 'chat_taken' : 'user_taken',
      userId
    );
    return;
  }

  if (data === 'db_panel' || data === 'db_back' || data === 'db_export' || data === 'db_import') {
    await answer('Выгрузка и загрузка базы из бота отключены', true);
    setAwait(chatId, null);
    await showWelcome(chatId, from);
    return;
  }

  if (data === 'admins' || data === 'admins_back' || data === 'add_admin_cancel') {
    if (!isOwnerChat(chatId)) {
      await answer('Нет доступа', true);
      return;
    }
    await answer();
    setAwait(chatId, null);
    if (data === 'admins_back') {
      await showWelcome(chatId, from);
      return;
    }
    await showAdminsPanel(chatId);
    return;
  }

  if (data === 'admins_self') {
    await answer('Это вы — удалить себя нельзя', true);
    return;
  }

  if (/^admin_del:(-?\d+)$/.test(data)) {
    if (!isOwnerChat(chatId)) {
      await answer('Нет доступа', true);
      return;
    }
    const targetId = data.split(':')[1];
    const removed = removeOwner(targetId, chatId);
    if (!removed.ok) {
      await answer(removed.error || 'Не удалось', true);
      return;
    }
    await answer('Удалён');
    try {
      await demoteChatFromSiteAdmin(targetId);
    } catch (_) {}
    try {
      await sendWithMarkupFallback(targetId, {
        text: 'ℹ️ Ваш доступ администратора снят.'
      });
    } catch (_) {}
    await showAdminsPanel(chatId);
    return;
  }

  if (data === 'add_admin') {
    if (!isOwnerChat(chatId)) {
      await answer('Нет доступа', true);
      return;
    }
    await answer();
    setAwait(chatId, { type: 'add_admin', at: Date.now() });
    await upsertMain(chatId, {
      text: [
        '➕ <b>Добавить админа</b>',
        '',
        'Пришлите Telegram ID одним сообщением.',
        'Пример: <code>5815094886</code>',
        '',
        'Узнать ID: @userinfobot'
      ].join('\n'),
      reply_markup: {
        inline_keyboard: [[cbBtn('⬅️ К списку', 'admins')]]
      }
    });
    return;
  }

  if (data === 'login_code') {
    await answer();
    try {
      await issueLoginCodeForChat(chatId, from);
    } catch (e) {
      console.error('TG login_code:', e.message);
    }
    return;
  }

  if (data === 'login_code_resend' || data === 'login_code_retry') {
    await answer('Повторяю…');
    try {
      await resendLoginCodeForChat(chatId, from);
    } catch (e) {
      console.error('TG login_code_retry:', e.message);
    }
    return;
  }

  if (data === 'my_orders') {
    try {
      await answer();
      await showMyOrders(chatId, isTrackedOrderMsg(chatId, msgId) ? null : msgId);
    } catch (e) {
      await answer('Не удалось получить заказы', true);
    }
    return;
  }

  if (data === 'owner_orders') {
    if (!isOwnerChat(chatId)) {
      await answer('Нет доступа', true);
      return;
    }
    try {
      await answer();
      await showOwnerOrders(chatId, isTrackedOrderMsg(chatId, msgId) ? null : msgId);
    } catch (e) {
      await answer('Не удалось загрузить заказы', true);
    }
    return;
  }

  if (data === 'public_url_hint') {
    await answer(
      'Задайте PUBLIC_URL=https://ваш-домен в панели хостинга и Redeploy',
      true
    );
    return;
  }

  if (data === 'ost_quick') {
    if (!chatHasLinkedAccount(chatId) || countOrdersForChat(chatId) < 1) {
      await answer('Сначала войдите и оформите заказ', true);
      return;
    }
    try {
      const text = await quickOrderStatusForChat(chatId);
      await answer(text, true);
    } catch (e) {
      await answer('Не удалось получить статус', true);
    }
    return;
  }

  if (data === 'support') {
    await answer();
    await startSupportRequest(chatId, from);
    return;
  }

  if (data === 'sup:cancel') {
    await answer();
    await cancelSupportRequest(chatId);
    return;
  }

  if (/^sup:open:(-?\d+)$/.test(data)) {
    const userChatId = data.split(':')[2];
    if (String(chatId) !== SUPPORT_OPERATOR_CHAT()) {
      await answer('Нет доступа', true);
      return;
    }
    const r = await openSupportDialog(chatId, userChatId, msgId);
    await answer(r.ok ? 'Диалог открыт' : (r.error || 'Не удалось'), !r.ok);
    return;
  }

  if (/^sup:close:(-?\d+)$/.test(data)) {
    const userChatId = data.split(':')[2];
    if (String(chatId) !== SUPPORT_OPERATOR_CHAT()) {
      await answer('Нет доступа', true);
      return;
    }
    const session = getSupport(userChatId);
    if (!session || String(session.operatorChatId) !== String(chatId)) {
      await answer('Диалог не найден', true);
      return;
    }
    await answer('Диалог закрыт');
    await closeSupportDialog(userChatId);
    return;
  }

  if (/^ost:/.test(data)) {
    const num = data.slice(4);
    try {
      const { getOrderByNum } = require('./orders');
      const o = getOrderByNum(num);
      if (!o) {
        await answer('Заказ не найден', true);
        return;
      }
      const mine = ordersForChat(chatId).some((x) => String(x.num) === String(num));
      if (!mine && !isOwnerChat(chatId)) {
        await answer('Нет доступа', true);
        return;
      }
      await answer();
      await upsertMain(chatId, {
        text: formatCustomerOrder(o),
        reply_markup: customerOrderDetailMarkup(o, chatId)
      }, isTrackedOrderMsg(chatId, msgId) ? null : msgId);
    } catch (_) {
      await answer('Заказ не найден', true);
    }
    return;
  }

  /* --- владелец --- */
  if (!isOwnerChat(chatId)) {
    await answer('Нет доступа', true);
    return;
  }

  if (/^oopen:/.test(data)) {
    const num = data.slice(6);
    try {
      const { getOrderByNum } = require('./orders');
      const o = getOrderByNum(num);
      if (!o) {
        await answer('Заказ не найден', true);
        return;
      }
      await answer();
      await upsertOwnerOrderCardForChat(chatId, o, { bump: true });
    } catch (e) {
      await answer(e.message || 'Не удалось открыть', true);
    }
    return;
  }

  if (/^otrk:/.test(data)) {
    const num = data.slice(5);
    setAwait(chatId, { type: 'track', orderNum: num });
    await answer('Пришлите трек или ссылку следующим сообщением');
    try {
      const { getOrderByNum } = require('./orders');
      const o = getOrderByNum(num);
      if (o) {
        await editOrReplace(chatId, msgId, {
          text: formatOwnerOrder(o) + '\n\n<i>Пришлите трек-номер или ссылку одним сообщением.</i>',
          reply_markup: {
            inline_keyboard: [[cbBtn('❌ Отмена', `oback:${num}`)]]
          }
        });
        setOwnerOrderMsgId(chatId, num, msgId);
      }
    } catch (_) {}
    return;
  }

  if (/^osts:/.test(data)) {
    await answer();
    const num = data.slice(5);
    try {
      const { getOrderByNum } = require('./orders');
      const o = getOrderByNum(num);
      if (!o) return;
      await editOrReplace(chatId, msgId, {
        text: formatOwnerOrder(o) + '\n\n<b>Выберите статус:</b>',
        reply_markup: ownerStatusPickMarkup(o)
      });
      setOwnerOrderMsgId(chatId, num, msgId);
    } catch (_) {}
    return;
  }

  if (/^oback:/.test(data)) {
    await answer();
    setAwait(chatId, null);
    const num = data.slice(6);
    try {
      const { getOrderByNum } = require('./orders');
      const o = getOrderByNum(num);
      if (o) await upsertOwnerOrderCardForChat(chatId, o);
    } catch (_) {}
    return;
  }

  if (/^oset:/.test(data)) {
    const parts = data.split(':');
    const num = parts[1];
    const code = parts[2];
    const status = STATUS_CODE[code];
    if (!status) {
      await answer('Неизвестный статус', true);
      return;
    }
    try {
      const { updateOrderAdmin } = require('./orders');
      const updated = await updateOrderAdmin(num, { status });
      await answer(status === 'Доставлен' ? 'Доставлен' : `Статус: ${status}`);
      if (updated) await upsertOwnerOrderCard(updated);
    } catch (e) {
      await answer(e.message || 'Ошибка', true);
    }
  }
}

async function handleUpdate(update) {
  if (update.callback_query) {
    await handleCallback(update.callback_query);
    return;
  }
  const msg = update.message || update.edited_message;
  if (!msg || !msg.chat) return;
  if (msg.from && msg.from.is_bot) return;
  console.log('TG update:', msg.chat.id, msg.text || msg.caption || '(media)');
  await handleMessage(msg);
}

async function setupWebhook(publicUrl) {
  const base = String(publicUrl || '').replace(/\/$/, '');
  if (!base || /localhost|127\.0\.0\.1/i.test(base)) {
    return { mode: 'skip', reason: 'local PUBLIC_URL' };
  }
  const url = String(process.env.WEBHOOK_URL || `${base}/webhook`).replace(/\/$/, '');
  await api('setWebhook', {
    url,
    secret_token: WEBHOOK_SECRET(),
    drop_pending_updates: false,
    allowed_updates: ['message', 'callback_query']
  });
  return { mode: 'webhook', url };
}

let polling = false;
async function startPolling() {
  if (polling) return { mode: 'polling' };
  polling = true;
  try { await api('deleteWebhook', { drop_pending_updates: false }); } catch (_) {}
  let offset = 0;
  const tick = async () => {
    if (!polling || !TOKEN()) return;
    try {
      const updates = await api('getUpdates', {
        offset,
        timeout: 25,
        allowed_updates: ['message', 'callback_query']
      });
      for (const u of updates || []) {
        offset = u.update_id + 1;
        try { await handleUpdate(u); } catch (e) { console.error('TG handle:', e.message); }
      }
    } catch (e) {
      /* warn, а не error: это сбой самого канала связи с Telegram, и
         жаловаться на него через Telegram бессмысленно — сообщение
         уйдёт тем же путём, который сейчас не работает. */
      console.warn('TG poll:', e.message);
      await new Promise((r) => setTimeout(r, 2500));
    }
    if (polling) setImmediate(tick);
  };
  tick();
  return { mode: 'polling' };
}

function stopPolling() { polling = false; }

function verifyWebhookSecret(req) {
  const expected = WEBHOOK_SECRET();
  const got = String(req.get('X-Telegram-Bot-Api-Secret-Token') || '');
  /* Fail-closed: без заголовка или при несовпадении — отказ. */
  if (!expected || !got) return false;
  if (got.length !== expected.length) return false;
  try {
    return require('crypto').timingSafeEqual(Buffer.from(got), Buffer.from(expected));
  } catch (_) {
    return false;
  }
}

async function warnAdminsPublicUrl() {
  const { isValidPublicHttps } = require('./public-url');
  const shop = shopHttps() || SHOP_URL();
  if (isValidPublicHttps(shop)) return;
  const { authLog } = require('./auth-log');
  authLog('public_url_error', { where: 'boot', shop: shop || null });
  const owners = getOwnerChatIds();
  if (!owners.length) return;
  const text = [
    '<b>⚠ Нет HTTPS PUBLIC_URL</b>',
    '',
    'Кнопки «на сайт» и вход по ссылке из бота не работают.',
    'В панели хостинга укажите, например:',
    '<code>PUBLIC_URL=https://ваш-домен.bothost.tech</code>',
    'и сделайте Redeploy.'
  ].join('\n');
  for (const chatId of owners) {
    try {
      await editOrReplace(chatId, getMainMsgId(chatId), {
        text,
        reply_markup: welcomeMarkup(chatId)
      });
    } catch (e) {
      console.warn('TG PUBLIC_URL warn:', e.message);
    }
  }
}

async function boot(publicUrl) {
  if (DISABLED()) {
    console.log('Telegram bot: OFF (TELEGRAM_DISABLED=1)');
    return { mode: 'off' };
  }
  if (!TOKEN()) {
    console.log('Telegram bot: OFF (нет TELEGRAM_BOT_TOKEN)');
    return { mode: 'off' };
  }
  try {
    const me = await api('getMe');
    BOT_USERNAME = me.username || '';
    if (BOT_USERNAME) process.env.TELEGRAM_BOT_USERNAME = BOT_USERNAME;
    const shop = shopHttps() || SHOP_URL();
    const owners = getOwnerChatIds();
    console.log(`Telegram bot: @${BOT_USERNAME} · shop → ${shop || '(нет валидного HTTPS)'} · admins → ${owners.join(', ') || '(первый /start)'}`);

    try {
      await api('setMyCommands', {
        commands: [
          { command: 'start', description: 'Меню бота' },
          { command: 'support', description: 'Поддержка' }
        ]
      });
    } catch (e) {
      console.warn('TG setMyCommands:', e.message);
    }

    const forcePoll =
      process.env.TELEGRAM_POLLING === '1' ||
      process.env.TELEGRAM_POLLING === 'true' ||
      !!process.env.BOT_ID ||
      !!process.env.DOMAIN ||
      /bothost\.(tech|ru)/i.test(shop);

    let mode;
    if (forcePoll || process.env.TELEGRAM_WEBHOOK !== '1') {
      await startPolling();
      console.log('Telegram bot: polling ON');
      mode = { mode: 'polling', username: BOT_USERNAME, shop };
    } else {
      const wh = await setupWebhook(publicUrl);
      if (wh.mode === 'webhook') {
        console.log(`Telegram webhook: ${wh.url}`);
        mode = { mode: 'webhook', username: BOT_USERNAME, url: wh.url, shop };
      } else {
        await startPolling();
        console.log('Telegram bot: polling ON');
        mode = { mode: 'polling', username: BOT_USERNAME, shop };
      }
    }

    setTimeout(() => {
      warnAdminsPublicUrl().catch((e) => console.warn(e.message));
    }, 2500);

    return mode;
  } catch (e) {
    console.error('Telegram bot start failed:', e.message);
    return { mode: 'error', error: e.message };
  }
}

function configured() {
  return !DISABLED() && !!TOKEN();
}

function botUsername() {
  return BOT_USERNAME;
}

/** Простое HTML-сообщение (сброс пароля и т.п.). */
async function sendText(chatId, text, reply_markup) {
  if (!TOKEN() || !chatId) throw new Error('no bot');
  return sendWithMarkupFallback(chatId, { text, reply_markup });
}

module.exports = {
  boot,
  handleUpdate,
  verifyWebhookSecret,
  configured,
  stopPolling,
  notifyCustomerOrder,
  notifyCustomerNewOrder,
  notifyOwnerNewOrder,
  notifyOwnerCancelled,
  upsertCustomerOrderCard,
  upsertOwnerOrderCard,
  notifyDeviceLoginSuccess,
  upsertDeviceCodeMessage,
  botUsername,
  shopHttps,
  sendText,
  siteUrl,
  adminLinkCode
};
