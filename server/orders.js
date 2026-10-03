const crypto = require('crypto');
const { db } = require('./db');
const { getProduct, checkStock, deductStock, restoreStock } = require('./products');
const { createPayment, configured, getPayment, lookupPayment, cancelPayment } = require('./yookassa');
const shipLive = require('./ship-live');

/* Сколько ждём оплату. Меньше — быстрее возвращается остаток на склад
   и меньше висит «мёртвых» заказов. Столько же показывает таймер на
   витрине (payUntilMs), их нельзя разводить. */
const PAY_WAIT_MS = 10 * 60 * 1000;

function orderCreatedMs(row) {
  const s = String((row && row.created_at) || '').trim();
  if (!s) return 0;
  const iso = /Z$|[+-]\d{2}:?\d{2}$/.test(s) ? s.replace(' ', 'T') : s.replace(' ', 'T') + 'Z';
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : 0;
}

function awaitingPayRow(row) {
  return !!(row && row.status === 'Ожидает оплаты' && row.pay_status !== 'paid' && row.pay_status !== 'manual');
}

/* Время вышло, а оплаты нет. Раньше строка отсюда УДАЛЯЛАСЬ, и это стоило
   слишком дорого:
     — уведомление от ЮKassa могло опоздать (её вебхук повторяется, а сервер
       перезапускается при каждом выкате) — деньги списаны, а заказа нет;
     — возврат покупателя с оплаты идёт через getOrderByNum, а тот сначала
       чистит просрочку и только потом читает строку: запрос, который должен
       был подтвердить оплату, сам же заказ и уносил;
     — номера выдаются как «последний в таблице плюс один», поэтому после
       удаления они начинали повторяться, и поздний вебхук от стёртого заказа
       мог пометить оплаченным чужой новый.
   Теперь заказ не исчезает, а становится отменённым. Владелец видит его в
   панели, номер занят навсегда, а если оплата всё-таки придёт — markPaid
   поднимет заказ обратно в работу. */
function expireUnpaidOrder(row) {
  if (!row || !awaitingPayRow(row)) return false;
  const created = orderCreatedMs(row);
  if (!created || Date.now() - created < PAY_WAIT_MS) return false;
  const info = db.prepare(`
    UPDATE orders
       SET status = 'Отменён',
           pay_status = 'expired',
           updated_at = datetime('now')
    WHERE id = ? AND status = 'Ожидает оплаты' AND pay_status != 'paid' AND pay_status != 'manual'
  `).run(row.id);
  if (!info.changes) return false;
  /* Склад возвращаем вместе со снятием отметки «товар списан» — одним
     «сравнить и записать». Иначе поздняя оплата (markPaid) решила бы, что
     товар уже списан, и остаток так и остался бы завышен. */
  const rel = db.prepare('UPDATE orders SET stock_reserved = 0 WHERE id = ? AND stock_reserved = 1').run(row.id);
  if (rel.changes === 1) {
    let items = [];
    try { items = JSON.parse(row.items_json || '[]'); } catch (_) {}
    try { restoreStock(items); } catch (e) { console.warn('expire restore stock', e.message); }
  }
  if (row.yookassa_id) {
    cancelPayment(row.yookassa_id).catch(() => {});
  }
  return true;
}

/* Заказ с платежом ЮKassa по таймеру отменяет только минутный обход
   (expireUnpaidOrdersChecked): он сперва спрашивает ЮKassa, не оплачен ли
   заказ. Остальные места, где чистится просрочка, такие заказы не трогают —
   иначе оплаченный заказ, о котором не дошло уведомление, отменился бы
   раньше, чем его успели проверить. */
function expireUnpaidOrders() {
  const rows = db.prepare(`
    SELECT * FROM orders
    WHERE status = 'Ожидает оплаты' AND pay_status != 'paid' AND pay_status != 'manual'
  `).all();
  let n = 0;
  for (const row of rows) {
    if (row.yookassa_id && configured()) continue;
    if (expireUnpaidOrder(row)) n += 1;
  }
  return n;
}

/* Минутный обход неоплаченных — с вопросом к ЮKassa.

   Узнавать об оплате только из уведомлений ЮKassa ненадёжно: адрес
   уведомлений задан в её кабинете и может указывать на старый домен,
   сервер перезапускается при каждом выкате, а покупатель после оплаты
   часто закрывает вкладку и на сайт не возвращается. Тогда оплаченный
   заказ через 10 минут уходил в «Отменён», а деньги оставались списанными.

   Поэтому перед отменой по таймеру спрашиваем ЮKassa сами: оплачен —
   заказ идёт в работу. ЮKassa не ответила — ждём следующей минуты, но не
   дольше PAY_ASK_GRACE_MS, чтобы её сбой не держал остаток на складе вечно.
   И ещё PAY_LATE_HOURS досматриваем отменённые по таймеру: оплату, которую
   покупатель довёл до конца уже после десяти минут, markPaid поднимет
   обратно в работу. */
const PAY_ASK_GRACE_MS = 15 * 60 * 1000;
const PAY_LATE_HOURS = 3;
const PAY_LATE_EVERY_MS = 5 * 60 * 1000;
let payLateLast = 0;

/* Вопрос к ЮKassa: { state: 'ok' | 'not_found' | 'unavailable', payment }. */
async function askPayment(paymentId) {
  try { return await lookupPayment(paymentId); } catch (_) { return { state: 'unavailable', payment: null }; }
}

/* Платёж прошёл и не возвращён. После возврата ЮKassa оставляет статус
   succeeded и лишь добавляет refunded_amount — такой платёж не должен
   поднимать заказ в работу. */
function paymentRefunded(p) {
  return !!(p && p.refunded_amount && parseFloat(p.refunded_amount.value) > 0);
}
function paymentSettled(p, order) {
  return !!p && p.status === 'succeeded' && !paymentRefunded(p) && amountsMatch(p, order);
}

/* Просроченный заказ с платежом и ответ ЮKassa по нему: оплачен — в работу,
   ответила «не оплачен» — отмена с возвратом склада. 'paid' | 'expired' | ''. */
function settleOverdueRow(row, p) {
  if (paymentSettled(p, row)) { markPaid(row, p.id); return 'paid'; }
  const cur = db.prepare('SELECT * FROM orders WHERE id = ?').get(row.id);
  return expireUnpaidOrder(cur) ? 'expired' : '';
}

function overdue(row) {
  const created = orderCreatedMs(row);
  return !!created && Date.now() - created >= PAY_WAIT_MS;
}

/* Таймер на витрине дошёл до нуля, и страница спросила заказ — решаем сразу,
   не дожидаясь минутного обхода: покупатель должен увидеть вещи снова в
   каталоге, как и раньше. ЮKassa не ответила — пусть решит обход. */
async function settleOverdueOrder(num) {
  const row = db.prepare('SELECT * FROM orders WHERE num = ?').get(String(num || ''));
  if (!row || !awaitingPayRow(row) || !row.yookassa_id || !configured() || !overdue(row)) return;
  const a = await askPayment(row.yookassa_id);
  if (a.state !== 'unavailable') settleOverdueRow(row, a.payment);
}

async function expireUnpaidOrdersChecked() {
  if (!configured()) return { expired: expireUnpaidOrders(), paid: 0 };
  let expired = 0;
  let paid = 0;
  /* ЮКасса не ответила — до конца обхода её больше не дёргаем: при зависшем
     API каждый вопрос ждал бы тайм-аута, и обход растягивался бы на часы. */
  let down = false;
  const rows = db.prepare(`
    SELECT * FROM orders
    WHERE status = 'Ожидает оплаты' AND pay_status != 'paid' AND pay_status != 'manual'
  `).all();
  for (const row of rows) {
    if (!overdue(row)) continue;
    if (row.yookassa_id) {
      const a = down ? { state: 'unavailable', payment: null } : await askPayment(row.yookassa_id);
      if (a.state === 'unavailable') {
        down = true;
        const age = Date.now() - orderCreatedMs(row);
        if (age < PAY_WAIT_MS + PAY_ASK_GRACE_MS) continue;
      } else {
        /* not_found — платежа нет, значит и не оплачен: обычная отмена */
        const r = settleOverdueRow(row, a.payment);
        if (r === 'paid') paid += 1;
        if (r === 'expired') expired += 1;
        continue;
      }
    }
    if (expireUnpaidOrder(row)) expired += 1;
  }

  /* Поздние оплаты. Окно — от создания заказа (отменяется он на 10–25-й
     минуте), а не от updated_at: правка заметки в отменённом заказе не
     должна продлевать досмотр. */
  if (!down && Date.now() - payLateLast >= PAY_LATE_EVERY_MS) {
    payLateLast = Date.now();
    const late = db.prepare(`
      SELECT * FROM orders
      WHERE pay_status = 'expired' AND status = 'Отменён' AND yookassa_id != ''
        AND created_at >= datetime('now', ?)
    `).all(`-${PAY_LATE_HOURS * 60 + 25} minutes`);
    for (const row of late) {
      const a = await askPayment(row.yookassa_id);
      if (a.state === 'unavailable') break;
      if (paymentSettled(a.payment, row)) {
        markPaid(row, a.payment.id);
        paid += 1;
      }
    }
  }
  if (paid) console.log(`[PAY] оплату нашли сами, без уведомления ЮKassa: ${paid}`);
  return { expired, paid };
}

function nextOrderNum() {
  const row = db.prepare(`SELECT num FROM orders ORDER BY id DESC LIMIT 1`).get();
  if (!row) return '10001';
  const n = parseInt(row.num, 10);
  return String((Number.isFinite(n) ? n : 10000) + 1);
}

function newAccessToken() {
  return crypto.randomBytes(32).toString('hex');
}

function tokensEqual(a, b) {
  const ba = Buffer.from(String(a || ''), 'utf8');
  const bb = Buffer.from(String(b || ''), 'utf8');
  if (!ba.length || ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

/** Старые заказы: «Оформлен → Оплата». Новые: «Оплата → Оформлен». */
function normalizeCheckoutSteps(steps) {
  if (!Array.isArray(steps) || steps.length < 2) return steps || [];
  const a = steps[0];
  const b = steps[1];
  if (Array.isArray(a) && Array.isArray(b) && a[0] === 'Оформлен' && b[0] === 'Оплата') {
    return [['Оплата', b[1] || ''], ['Оформлен', a[1] || '']].concat(steps.slice(2));
  }
  return steps;
}

function stampStep(steps, name, date) {
  if (!Array.isArray(steps)) return;
  const row = steps.find((s) => Array.isArray(s) && s[0] === name);
  if (row) row[1] = date;
}

function formatOrderDate(createdAt) {
  const s = String(createdAt || '');
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (m) return `${m[3]}.${m[2]}.${m[1]}`;
  const m2 = /^(\d{2})\.(\d{2})\.(\d{4})/.exec(s);
  if (m2) return s.slice(0, 10);
  return s.slice(0, 16).replace('T', ' ') || '';
}

function rowToOrder(row) {
  if (!row) return null;
  let items = [], steps = [], pvz = null;
  try { items = JSON.parse(row.items_json || '[]'); } catch (_) {}
  try { steps = JSON.parse(row.steps_json || '[]'); } catch (_) {}
  try { pvz = row.pvz_json ? JSON.parse(row.pvz_json) : null; } catch (_) {}
  return {
    id: row.id,
    num: row.num,
    date: formatOrderDate(row.created_at),
    status: row.status,
    payStatus: row.pay_status,
    yookassaId: row.yookassa_id,
    confirmationUrl: row.confirmation_url,
    price: row.price,
    goods: row.goods,
    discount: row.discount,
    ship: row.ship,
    shipMode: row.ship_mode,
    promoCode: row.promo_code,
    payName: row.pay_name,
    customerName: row.customer_name,
    email: row.email,
    phone: row.phone,
    addr: row.addr,
    pvz,
    items,
    steps: normalizeCheckoutSteps(steps),
    now: row.step_now,
    tracking: row.tracking || '',
    note: row.note || '',
    guest: !!row.guest,
    userId: row.user_id,
    accessToken: row.access_token || '',
    createdAt: row.created_at,
    payUntil: awaitingPayRow(row) && orderCreatedMs(row) ? orderCreatedMs(row) + PAY_WAIT_MS : null,
    stockReserved: !!row.stock_reserved
  };
}

/** Ответ клиенту: без accessToken / внутренних полей. */
function toPublicOrder(order, { admin = false } = {}) {
  if (!order) return null;
  const o = Object.assign({}, order);
  delete o.accessToken;
  delete o.stockReserved;
  if (!admin) {
    delete o.note;
    delete o.yookassaId;
    /* Ссылку на оплату оставляем только для неоплаченных — чтобы можно было доплатить */
    if (o.payStatus !== 'pending') delete o.confirmationUrl;
  }
  return o;
}

/** Владелец / админ / токен из return URL после оплаты (не по одному email). */
function canAccessOrder(order, user, accessToken) {
  if (!order) return false;
  if (user && user.role === 'admin') return true;
  if (user && order.userId && +order.userId === +user.id) return true;
  if (accessToken && order.accessToken && tokensEqual(accessToken, order.accessToken)) return true;
  return false;
}

function getCms() {
  const row = db.prepare('SELECT data_json FROM cms WHERE id = 1').get();
  if (!row) return { promos: [], shipping: { pickup: 190, freeFrom: 15000 } };
  try { return JSON.parse(row.data_json); } catch (_) { return { promos: [], shipping: {} }; }
}

function saveCms(cms) {
  db.prepare(`UPDATE cms SET data_json = ? WHERE id = 1`).run(JSON.stringify(cms));
}

function isFreeShipPromo(promo) {
  const t = promo && promo.type;
  return t === 'freeship' || t === 'free_ship' || t === 'shipping';
}

function calcPromo(code, goodsSum) {
  const cms = getCms();
  const promo = (cms.promos || []).find(
    (p) => p.on && String(p.code || '').toUpperCase() === String(code || '').toUpperCase()
  );
  if (!promo) return { discount: 0, promo: null, error: code ? 'Промокод не найден' : null };
  if (promo.minSum && goodsSum < promo.minSum) {
    return { discount: 0, promo: null, error: `Минимальная сумма ${promo.minSum} ₽` };
  }
  if (promo.limit && (promo.used || 0) >= promo.limit) {
    return { discount: 0, promo: null, error: 'Промокод исчерпан' };
  }
  let discount = 0;
  if (isFreeShipPromo(promo)) discount = 0;
  else if (promo.type === 'percent') discount = Math.round((goodsSum * (+promo.value || 0)) / 100);
  else discount = Math.min(goodsSum, Math.round(+promo.value || 0));
  return { discount, promo, error: null };
}

/* ==========================================================
   СКОЛЬКО СТОИТ ДОСТАВКА

   Считается только здесь и только на сервере: эта же цифра уходит
   в ЮKassa, поэтому клиент её не присылает, а спрашивает.

   Два способа — до пункта выдачи и курьером до двери — и таблица зон
   в админке, где у каждой зоны свой список городов и своя цена. Первая
   подошедшая зона побеждает: порядок в списке и есть приоритет.
   ========================================================== */

const normRu = (x) => String(x || '').toLowerCase().replace(/ё/g, 'е').trim();

/* Ищем название города как отдельное слово, а не как кусок строки:
   иначе «Орёл» найдётся внутри «Орёл-Изумруд», а «Пермь» — внутри
   «Пермский», и человек уедет по чужому тарифу. */
function mentions(hay, needle) {
  const n = normRu(needle);
  if (n.length < 2) return false;
  const h = normRu(hay);
  let i = h.indexOf(n);
  while (i !== -1) {
    const before = i === 0 ? '' : h[i - 1];
    const after = h[i + n.length] || '';
    const wordChar = (c) => /[a-zа-я0-9]/.test(c);
    if (!wordChar(before) && !wordChar(after)) return true;
    i = h.indexOf(n, i + 1);
  }
  return false;
}

function findZone(place) {
  const zones = (getCms().shipping || {}).zones || [];
  if (!Array.isArray(zones) || !zones.length) return null;
  const hay = [place && place.city, place && place.region, place && place.addr]
    .filter(Boolean).join(' | ');
  if (!hay.trim()) return null;
  return zones.find((z) => {
    const list = Array.isArray(z.match) ? z.match
      : String(z.match || '').split(',').map((v) => v.trim()).filter(Boolean);
    return list.some((m) => mentions(hay, m));
  }) || null;
}

const COURIER = 'courier';

/** Единственный расчёт доставки в проекте. place = {city, region, addr}.
    live — ответ калькулятора СДЭК (server/ship-live.js), если он есть. */
function shipQuote({ mode, place, goodsAfterDiscount, promo, live, liveOn } = {}) {
  const s = getCms().shipping || {};
  const courier = String(mode) === COURIER;
  const zone = findZone(place);

  /* Цена зоны — решение владельца («по Екатеринбургу 0 ₽»), она сильнее
     тарифа СДЭК. Тариф СДЭК сильнее базовой цены: та одна на всю страну. */
  const zoneRaw = zone ? (courier ? zone.courier : zone.pickup) : null;
  const zoneCost = zoneRaw != null && zoneRaw !== '' ? +zoneRaw : NaN;
  const byZone = Number.isFinite(zoneCost) && zoneCost >= 0;
  const byCdek = !byZone && !!(live && live.cost > 0);
  const baseRaw = +(courier ? s.courier : s.pickup);
  const base = byZone ? zoneCost
    : byCdek ? live.cost
    : Number.isFinite(baseRaw) && baseRaw >= 0 ? baseRaw : (courier ? 490 : 190);
  const days = (byCdek && live.days) || (zone && zone.days) ||
    (courier ? s.courierDays : s.pickupDays) || '';

  /* У курьера свой порог бесплатной доставки. Ноль означает «бесплатным
     не бывает»: возить до двери дороже, и общий порог тут не годится. */
  const freeFrom = courier ? (+s.freeFromCourier || 0) : (+s.freeFrom || 0);

  let cost = Math.max(0, Math.round(base));
  let free = '';
  if (isFreeShipPromo(promo)) { cost = 0; free = 'promo'; }
  else if (freeFrom > 0 && +goodsAfterDiscount >= freeFrom) { cost = 0; free = 'sum'; }

  return {
    cost,
    mode: courier ? COURIER : 'pickup',
    zone: zone ? String(zone.name || '') : '',
    days: String(days),
    freeFrom,
    free,
    by: byZone ? 'zone' : byCdek ? 'cdek' : 'base',
    liveOn: !!liveOn
  };
}

/* Тариф СДЭК спрашиваем, только когда он что-то решает: при бесплатной
   доставке и при цене зоны его ответ всё равно не пригодится. СДЭК не
   ответил — остаётся базовая цена, заказ из-за этого не срывается. */
async function shipQuoteLive({ mode, place, cityCode, qty, goodsAfterDiscount, promo } = {}) {
  const s = getCms().shipping || {};
  const liveOn = shipLive.enabled(s);
  const plain = shipQuote({ mode, place, goodsAfterDiscount, promo, liveOn });
  if (!liveOn || plain.free || plain.by === 'zone') return plain;
  if (!cityCode) {
    /* Города ещё нет — нет и цены: базовые 190 ₽ выглядели бы настоящими. */
    if (!String((place && place.city) || '').trim()) plain.noCity = true;
    return plain;
  }
  const live = await shipLive.liveQuote({ mode, cityCode, qty, shipping: s });
  return live ? shipQuote({ mode, place, goodsAfterDiscount, promo, live, liveOn }) : plain;
}

/* Push доходит и до закрытого приложения, и не требует Телеграма. Каналы
   не заменяют друг друга: Телеграм есть у тех, кто подключил бота, push —
   у тех, кто разрешил уведомления. Шлём в оба, лишнего дубля не будет:
   в приложении показывается push, в Телеграме — сообщение бота. */
function pushSafe(fn) {
  try {
    const push = require('./push');
    if (!push.configured()) return;
    Promise.resolve(fn(push)).catch(() => {});
  } catch (_) {}
}

/* Заголовок несёт суть, номер уходит в строку под ним: в шторке телефона
   видно прежде всего заголовок, и «Заказ №10003» там не говорит ничего. */
const PUSH_TITLES = {
  'В обработке': 'Заказ принят',
  'Едет': 'Заказ в пути',
  'Доставка': 'Заказ в пути',
  'Доставлен': 'Заказ доставлен',
  'Отменён': 'Заказ отменён',
  'Возврат': 'Оформлен возврат',
  'Ожидает оплаты': 'Ждём оплату'
};

/** Короткий состав заказа: «Косметичка-чехол и ещё 2». */
function orderItemsLine(order) {
  let items = [];
  try {
    items = Array.isArray(order.items)
      ? order.items
      : JSON.parse((order.items_json) || '[]');
  } catch (_) {}
  if (!items.length) return '';
  const first = String(items[0].name || '').trim();
  if (!first) return '';
  const more = items.length - 1;
  return more > 0 ? first + ' и ещё ' + more : first;
}

/** Фото первой позиции — Android показывает его крупно под текстом. */
function orderImage(order) {
  let items = [];
  try {
    items = Array.isArray(order.items)
      ? order.items
      : JSON.parse((order.items_json) || '[]');
  } catch (_) {}
  const img = items.length ? String(items[0].img || '') : '';
  /* Только свои адреса: data:URL в уведомление не пролезет, чужой хост
     показывать незачем. */
  return img.startsWith('/media/') ? img : '';
}

/** Владельцам — о новом заказе. */
function pushOrderToAdmins(order) {
  if (!order) return;
  const who = order.customerName || order.name || 'Покупатель';
  const what = orderItemsLine(order);
  pushSafe((push) => push.sendToAdmins({
    title: 'Новый заказ · ' + (order.price || 0) + ' ₽',
    body: ['№' + order.num, who, what].filter(Boolean).join(' · '),
    image: orderImage(order),
    tag: 'lc-new-' + order.num,
    url: '/#admin'
  }));
}

/** Покупателю — о смене статуса его заказа. */
function pushOrderToBuyer(order, status) {
  if (!order || order.userId == null) return;
  const st = String(status || order.status || '');
  const what = orderItemsLine(order);
  pushSafe((push) => push.sendToUser(order.userId, {
    title: PUSH_TITLES[st] || ('Заказ · ' + st),
    body: ['№' + order.num, what].filter(Boolean).join(' · '),
    image: orderImage(order),
    tag: 'lc-order-' + order.num,
    url: '/#orders'
  }));
}

async function pushNewOrder(order) {
  try {
    const { notifyOwnerNewOrder, notifyCustomerNewOrder } = require('./telegram-bot');
    await notifyOwnerNewOrder(order);
    await notifyCustomerNewOrder(order);
  } catch (_) {}
  pushOrderToAdmins(order);
}

/* Деньги пришли, а заказ под них не нашёлся — молчать тут нельзя.
   Раньше такой случай оставался строкой в логе, которую никто не читает,
   и владелец узнавал о нём только от покупателя. */
const _anomalySeen = new Set();

async function pushPaymentAnomaly(what, payment, order) {
  try {
    /* ЮKassa повторяет уведомление, пока не получит 200, — сутками. Без этой
       памяти владелец получил бы одну и ту же тревогу десятки раз. Список
       живёт в памяти процесса: после перезапуска напомнить один раз не
       страшно, а вот сыпать повторами страшно. */
    const key = (payment && payment.id) || '';
    if (key) {
      if (_anomalySeen.has(key)) return;
      _anomalySeen.add(key);
    }
    const { sendText } = require('./telegram-bot');
    const { getOwnerChatIds } = require('./tg-owner');
    const paid = payment && payment.amount ? `${payment.amount.value} ${payment.amount.currency}` : '?';
    const text = [
      '⚠️ Оплата пришла, но заказ не сошёлся',
      '',
      what,
      `Платёж: ${(payment && payment.id) || '?'}`,
      `Сумма: ${paid}`,
      order ? `Заказ в базе: №${order.num} на ${order.price} ₽` : 'Заказ в базе не найден',
      '',
      'Проверьте платёж в кабинете ЮKassa и заказ в админке.'
    ].join('\n');
    for (const id of getOwnerChatIds()) {
      try { await sendText(id, text); } catch (_) {}
    }
  } catch (_) {}
}

/** Привязать гостевые заказы с тем же email к аккаунту. */
function claimOrdersForUser(user) {
  if (!user || !user.id || !user.email) return 0;
  const em = String(user.email).trim().toLowerCase();
  if (!em.includes('@') || /@phone\.luxecanvas$/i.test(em) || /@google\.luxecanvas$/i.test(em)) {
    return 0;
  }
  const info = db.prepare(`
    UPDATE orders
    SET user_id = ?, guest = 0, updated_at = datetime('now')
    WHERE user_id IS NULL AND lower(email) = lower(?)
  `).run(user.id, em);
  return info.changes || 0;
}

/* Тот же расчёт, что при оформлении, но ничего не сохраняет: витрина
   спрашивает цену на шаге доставки, чтобы показанная сумма совпала
   с той, что уйдёт в оплату. Товары пересчитываем по своей базе —
   присланной сумме верить нельзя. */
async function quoteForCart({ items, promoCode, delivery, pvz, hint } = {}) {
  /* Больше 50 разных позиций в одной корзине не бывает — а без предела
     открытый маршрут перебирал бы присланный массив любой длины. */
  const list = Array.isArray(items) ? items.slice(0, 50) : [];
  let goods = 0;
  let qty = 0;
  for (const i of list) {
    const p = getProduct(i && i.id);
    if (!p) continue;
    const n = Math.max(1, Math.round(+(i && i.qty) || 1));
    goods += p.price * n;
    qty += Math.min(99, n);
  }
  const { discount, promo } = calcPromo(promoCode, goods);
  const after = Math.max(0, goods - discount);

  const mode = String((delivery && delivery.mode) || 'pickup') === COURIER ? COURIER : 'pickup';

  /* Пункт — по справочнику, как при оформлении: присланным городу и
     адресу верим, только если кода в справочнике нет. */
  let pvzPlace = null;
  let pvzCity = 0;
  if (pvz) {
    pvzPlace = {
      city: String(pvz.city || '').trim(),
      region: String(pvz.region || '').trim(),
      addr: String(pvz.addr || '').trim()
    };
    const code = String(pvz.code || '').trim();
    if (code && code !== 'manual') {
      try {
        const dir = require('./cdek-open');
        const found = dir.deliveryPoints({ q: code, limit: 40 }).find((p) => p.code === code);
        if (found) {
          pvzPlace = { city: found.city, region: found.region, addr: found.addr };
          pvzCity = found.cityCode;
        }
      } catch (_) {}
    }
    if (!pvzCity) pvzCity = shipLive.cityCodeByName(pvzPlace.city, pvzPlace.region);
  }
  const courierPlace = {
    city: String((delivery && delivery.city) || (hint && hint.courierCity) || '').trim(),
    region: '',
    addr: String((delivery && delivery.street) || (hint && hint.courierStreet) || '').trim()
  };
  const courierCity = shipLive.cityCodeByName(courierPlace.city);

  /* Город, который человек смотрит на карте, пока пункт не выбран, — чтобы
     цена появилась сразу после выбора города. Только для показа: при
     оформлении цену считает createCheckout по самому пункту. */
  let hintCity = 0;
  let hintName = '';
  const hc = +(hint && hint.cityCode) || 0;
  if (hc) {
    try {
      const c = require('./cdek-open').cities().find((x) => x.code === hc);
      if (c) { hintCity = c.code; hintName = c.city; }
    } catch (_) {}
  }

  const base = { goodsAfterDiscount: after, promo, qty };
  const pickupArgs = pvzPlace
    ? { mode: 'pickup', place: pvzPlace, cityCode: pvzCity }
    : { mode: 'pickup', place: { city: hintName || courierPlace.city, region: '', addr: '' }, cityCode: hintCity || courierCity };
  /* Курьер без вписанного города — в том же городе, что и пункт: вкладка
     показывает, сколько стоит привезти туда же, только до двери. */
  const courierArgs = courierCity || courierPlace.city
    ? { mode: COURIER, place: courierPlace, cityCode: courierCity }
    : { mode: COURIER, place: { city: (pvzPlace && pvzPlace.city) || hintName, region: '', addr: '' }, cityCode: pvzCity || hintCity };

  const [pick, door] = await Promise.all([
    shipQuoteLive(Object.assign({}, base, pickupArgs)),
    shipQuoteLive(Object.assign({}, base, courierArgs))
  ]);
  const q = mode === COURIER ? door : pick;
  const alt = mode === COURIER ? pick : door;
  return Object.assign({}, q, { goods, discount, total: after + q.cost, alt });
}

async function createCheckout({ items, guest, pvz, delivery, promoCode, user, publicUrl }) {
  if (!user || !user.id) {
    throw Object.assign(new Error('Войдите в аккаунт, чтобы оформить заказ'), { status: 401 });
  }
  if (!items || !items.length) {
    throw Object.assign(new Error('Корзина пуста'), { status: 400 });
  }
  if (items.length > 50) {
    throw Object.assign(new Error('Слишком много позиций в одном заказе'), { status: 400 });
  }

  /* Товар списывается со склада в момент оформления и возвращается, только
     если за 10 минут не оплатили. Без предела один бесплатный аккаунт
     оформлял бы заказ за заказом и держал весь склад «проданным» — живые
     покупатели видели бы «нет в наличии». Три неоплаченных за раз хватает
     любому честному покупателю. Админ тестирует без ограничений. */
  if (!(user && user.role === 'admin')) {
    const pending = db.prepare(`
      SELECT COUNT(*) AS n FROM orders
      WHERE user_id = ? AND status = 'Ожидает оплаты' AND pay_status != 'paid' AND pay_status != 'manual'
    `).get(user.id);
    if (pending && pending.n >= 3) {
      throw Object.assign(new Error('У вас уже есть неоплаченные заказы — оплатите их или подождите 10 минут, пока они отменятся'), { status: 429 });
    }
  }

  const normalized = items.map((i) => {
    const p = getProduct(i.id);
    if (!p || (!p.on && !(user && user.role === 'admin'))) {
      throw Object.assign(new Error('Товар не найден'), { status: 400 });
    }
    /* Размер — только из тех, что есть у товара. Раньше в заказ писалась
       любая присланная строка: и мусорный размер, которого не сошьют, и
       разметка со скриптом, которая потом показывалась владельцу в
       админке. Без размеров (аксессуары) — ONESIZE. */
    const sizes = Array.isArray(p.sizes) ? p.sizes.map(String) : [];
    const want = String(i.size || '').trim();
    const size = sizes.length ? want : 'ONESIZE';
    if (sizes.length && !sizes.includes(size)) {
      throw Object.assign(new Error('Такого размера у товара нет: ' + (p.name || '')), { status: 400 });
    }
    /* Количество — разумное: сотня тысяч штук в одной строке заказа
       бронировала бы весь склад одним запросом. */
    const qty = Math.max(1, Math.min(99, Math.round(+i.qty || 1)));
    return {
      id: p.id,
      name: p.name,
      img: p.img,
      size,
      qty,
      price: p.price
    };
  });

  const stockErr = checkStock(normalized);
  if (stockErr) throw Object.assign(new Error(stockErr), { status: 409 });

  const g = guest || {};
  const adminOrder = !!(user && user.role === 'admin');
  const fallbackName = [user && user.last_name, user && user.name, user && user.middle_name]
    .map((s) => String(s || '').trim()).filter(Boolean).join(' ');
  const name = String(g.name || fallbackName || (adminOrder ? 'Администратор' : '')).trim();
  const phone = String(g.phone || (user && user.phone) || '').trim();
  /* .local в чек не годится: ЮKassa отбивает такой адрес вместе со всем чеком */
  const adminFallbackEmail = String(process.env.ADMIN_EMAIL || '').trim().toLowerCase();
  const email = String(
    g.email || (user && user.email) || (adminOrder ? adminFallbackEmail : '')
  ).trim().toLowerCase();
  if (!adminOrder && !name) throw Object.assign(new Error('Укажите имя'), { status: 400 });
  if (!adminOrder && !phone) throw Object.assign(new Error('Укажите телефон'), { status: 400 });
  if (!email.includes('@')) throw Object.assign(new Error('Укажите email'), { status: 400 });
  const shipMode = String((delivery && delivery.mode) || 'pickup') === COURIER ? COURIER : 'pickup';

  /* Курьером — собираем адрес из полей формы сами. Строку целиком клиенту
     не доверяем: по ней считается тариф, а значит и сумма к оплате. */
  let courierAddr = null;
  if (shipMode === COURIER) {
    const c = delivery || {};
    const city = String(c.city || '').trim();
    const street = String(c.street || '').trim();
    const flat = String(c.flat || '').trim();
    const comment = String(c.comment || '').trim().slice(0, 300);
    if (city.length < 2) throw Object.assign(new Error('Укажите город доставки'), { status: 400 });
    if (street.length < 5) throw Object.assign(new Error('Укажите улицу и дом'), { status: 400 });
    /* Точка с карты — подсказка курьеру, а не адрес: едут по строке. */
    const lat = +c.lat;
    const lng = +c.lng;
    const geoOk = Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180;
    courierAddr = {
      city, street, flat, comment,
      lat: geoOk ? lat : 0,
      lng: geoOk ? lng : 0,
      text: [city, street, flat && ('кв./офис ' + flat)].filter(Boolean).join(', ')
    };
  } else if (!pvz || !String(pvz.addr || '').trim() || String(pvz.addr).trim().length < 8) {
    throw Object.assign(new Error('Укажите адрес пункта выдачи СДЭК'), { status: 400 });
  }

  const cleanPvz = shipMode === COURIER ? {
    code: 'courier',
    id: 'courier',
    type: 'COURIER',
    mode: COURIER,
    city: courierAddr.city,
    cityCode: 0,
    addr: courierAddr.text,
    street: courierAddr.street,
    flat: courierAddr.flat,
    addressComment: courierAddr.comment,
    hours: '',
    lat: courierAddr.lat,
    lng: courierAddr.lng,
    phone: '',
    manual: false
  } : {
    code: String(pvz.code || 'manual').trim() || 'manual',
    id: String(pvz.id || pvz.code || 'manual').trim() || 'manual',
    type: String(pvz.type || 'PVZ').trim(),
    ownerCode: String(pvz.ownerCode || '').trim(),
    city: String(pvz.city || '').trim(),
    region: String(pvz.region || '').trim(),
    cityCode: +pvz.cityCode || 0,
    addr: String(pvz.addr || '').trim(),
    addressComment: String(pvz.addressComment || '').trim(),
    hours: String(pvz.hours || '').trim(),
    lat: Number.isFinite(+pvz.lat) ? +pvz.lat : 0,
    lng: Number.isFinite(+pvz.lng) ? +pvz.lng : 0,
    phone: String(pvz.phone || '').trim(),
    manual: pvz.manual === true || String(pvz.code || '') === 'manual',
    haveCashless: pvz.haveCashless === true,
    haveCash: pvz.haveCash === true,
    allowedCod: pvz.allowedCod === true,
    isHandout: pvz.isHandout !== false,
    isReception: pvz.isReception === true,
    isDressingRoom: pvz.isDressingRoom === true,
    weightMin: +pvz.weightMin || 0,
    weightMax: +pvz.weightMax || 0
  };

  /* Только JWT-user; гостевые заказы привязываются при входе (claim), не по чужому email. */
  let userId = user && user.id ? +user.id : null;
  let asGuest = userId ? 0 : 1;

  /* Пункт выдачи сверяем со справочником по коду и переписываем город,
     регион и адрес его данными. Клиент мог прислать настоящий код
     владивостокского пункта и приписать ему «Екатеринбург», чтобы
     доставка посчиталась по дешёвой зоне. */
  let pvzKnown = false;
  if (shipMode !== COURIER && cleanPvz.code && !cleanPvz.manual) {
    try {
      const dir = require('./cdek-open');
      const found = dir.deliveryPoints({ q: cleanPvz.code, limit: 40 })
        .find((p) => p.code === cleanPvz.code);
      if (found) {
        pvzKnown = true;
        cleanPvz.city = found.city;
        cleanPvz.region = found.region;
        cleanPvz.cityCode = found.cityCode;
        cleanPvz.addr = found.addr;
        cleanPvz.hours = found.hours;
        cleanPvz.lat = found.lat;
        cleanPvz.lng = found.lng;
      }
    } catch (_) { /* справочник не поднялся — считаем по присланному */ }
  }

  const goods = normalized.reduce((s, i) => s + i.price * i.qty, 0);
  const { discount, promo, error: promoErr } = calcPromo(promoCode, goods);
  if (promoErr && promoCode) throw Object.assign(new Error(promoErr), { status: 400 });
  const after = Math.max(0, goods - discount);
  /* Место доставки берём из уже проверенных данных, а не из того, что
     прислал клиент отдельным полем: иначе к владивостокскому пункту
     подставят «Екатеринбург» и уедут по дешёвому тарифу. */
  /* Код города для тарифа СДЭК — тоже только из проверенного: у пункта из
     справочника он свой, у курьера и адреса «руками» ищем по названию. */
  const cityCode = shipMode === COURIER
    ? shipLive.cityCodeByName(cleanPvz.city)
    : pvzKnown ? cleanPvz.cityCode : shipLive.cityCodeByName(cleanPvz.city, cleanPvz.region);
  const quote = await shipQuoteLive({
    mode: shipMode,
    place: { city: cleanPvz.city, region: cleanPvz.region || '', addr: cleanPvz.addr },
    cityCode,
    qty: normalized.reduce((n, i) => n + i.qty, 0),
    goodsAfterDiscount: after,
    promo
  });
  /* Пока ждали ответ СДЭК, другой покупатель мог забрать последний размер.
     Сверяем склад ещё раз: отсюда до списания ожиданий уже нет. */
  const stockLate = checkStock(normalized);
  if (stockLate) throw Object.assign(new Error(stockLate), { status: 409 });
  const ship = quote.cost;
  const price = after + ship;
  const num = nextOrderNum();
  const dd = new Date().toISOString().slice(0, 16).replace('T', ' ');
  const steps = [
    ['Оплата', ''],
    ['Оформлен', dd.slice(5, 10)],
    ['Обработка', ''],
    ['Едет', ''],
    ['Доставлен', '']
  ];

  const accessToken = newAccessToken();
  const ykOn = configured();
  const initialStatus = ykOn ? 'Ожидает оплаты' : 'В обработке';
  const initialPay = ykOn ? 'pending' : 'manual';
  const initialStep = ykOn ? 0 : 2;
  if (!ykOn) {
    stampStep(steps, 'Оплата', dd.slice(5, 10));
    stampStep(steps, 'Обработка', dd.slice(5, 10));
  }

  const info = db.prepare(`
    INSERT INTO orders (
      num, user_id, status, pay_status, price, goods, discount, ship, ship_mode,
      promo_code, customer_name, email, phone, addr, pvz_json, items_json, steps_json, step_now, guest, access_token, pay_name
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    num,
    userId,
    initialStatus,
    initialPay,
    price,
    goods,
    discount,
    ship,
    quote.mode,
    promo ? promo.code : '',
    name,
    email,
    phone,
    /* Курьерский адрес уже собран с городом внутри — второй раз город
       не приклеиваем. */
    shipMode === COURIER
      ? cleanPvz.addr
      : ([cleanPvz.city, cleanPvz.addr].filter(Boolean).join(', ') || cleanPvz.addr),
    JSON.stringify(cleanPvz),
    JSON.stringify(normalized),
    JSON.stringify(steps),
    initialStep,
    asGuest,
    accessToken,
    ykOn ? 'ЮKassa' : 'Без онлайн-оплаты'
  );

  const orderId = info.lastInsertRowid;
  try {
    deductStock(normalized);
    db.prepare('UPDATE orders SET stock_reserved = 1 WHERE id = ?').run(orderId);
  } catch (e) {
    try { db.prepare('DELETE FROM orders WHERE id = ?').run(orderId); } catch (_) {}
    throw e;
  }

  const returnUrl = checkoutReturnUrl(publicUrl, num, accessToken);

  /* Бесплатный заказ (100% промо) — ЮKassa не принимает 0 ₽ */
  if (ykOn && price < 1) {
    const row = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
    const paid = markPaid(row, null);
    return {
      order: toPublicOrder(paid, { admin: false }),
      orderAccessToken: accessToken,
      paymentConfigured: true,
      confirmationUrl: '',
      alreadyPaid: true
    };
  }

  if (!ykOn) {
    const order = rowToOrder(db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId));
    await pushNewOrder(order);
    return {
      order: toPublicOrder(order, { admin: false }),
      orderAccessToken: accessToken,
      paymentConfigured: false,
      message: 'Заказ принят в обработку (онлайн-оплата не подключена)'
    };
  }

  let payment;
  try {
    payment = await createPayment(paymentPayload({
      orderId, num, price, returnUrl, email, phone, items: normalized, discount, ship
    }));
  } catch (e) {
    /* Не оставляем «висящий» заказ без оплаты */
    try {
      restoreStock(normalized);
      db.prepare('DELETE FROM orders WHERE id = ?').run(orderId);
    } catch (_) {}
    throw e;
  }

  const confUrl = payment.confirmation && payment.confirmation.confirmation_url;
  if (!confUrl) {
    try {
      restoreStock(normalized);
      db.prepare('DELETE FROM orders WHERE id = ?').run(orderId);
    } catch (_) {}
    throw Object.assign(new Error('ЮKassa не вернула ссылку на оплату'), { status: 502 });
  }
  db.prepare(`
    UPDATE orders SET yookassa_id = ?, confirmation_url = ?, updated_at = datetime('now') WHERE id = ?
  `).run(payment.id, confUrl, orderId);

  const orderDraft = rowToOrder(db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId));
  /* Уведомление владельцу — после оплаты (markPaid / sync). Здесь только черновик. */

  return {
    order: toPublicOrder(orderDraft, { admin: false }),
    orderAccessToken: accessToken,
    paymentConfigured: true,
    confirmationUrl: confUrl,
    paymentId: payment.id
  };
}

function checkoutReturnUrl(publicUrl, num, accessToken) {
  const base = String(publicUrl || '').replace(/\/$/, '') || 'http://localhost:3000';
  return `${base}/?paid=${encodeURIComponent(num)}&t=${encodeURIComponent(accessToken)}`;
}

function paymentPayload({ orderId, num, price, returnUrl, email, phone, items, discount, ship }) {
  return {
    amount: price,
    description: `Canvas · заказ №${num}`,
    orderNum: num,
    returnUrl,
    metadata: { orderId: String(orderId), orderNum: String(num) },
    email,
    phone,
    items,
    discount,
    ship
  };
}

function amountsMatch(payment, order) {
  const currency = String((payment.amount && payment.amount.currency) || '');
  const paid = Math.round(parseFloat((payment.amount && payment.amount.value) || '0') * 100) / 100;
  const expected = Math.round(Number(order.price) * 100) / 100;
  return currency === 'RUB' && Number.isFinite(paid) && Math.abs(paid - expected) <= 0.009;
}

function markPaid(order, paymentId) {
  if (!order) return order;
  if (order.pay_status === 'paid') {
    return rowToOrder(db.prepare('SELECT * FROM orders WHERE id = ?').get(order.id)) || order;
  }

  /* Кто первый — тот и списывает склад. Второй вызов (webhook + return) не дублирует. */
  const claimed = db.prepare(`
    UPDATE orders SET pay_status = 'paid', updated_at = datetime('now')
    WHERE id = ? AND pay_status != 'paid'
  `).run(order.id);
  if (!claimed.changes) {
    return rowToOrder(db.prepare('SELECT * FROM orders WHERE id = ?').get(order.id));
  }

  /* Склад — по свежей строке, а не по той, что вызывающий прочёл до запроса
     к ЮKassa: за это время минутный обход мог отменить заказ и вернуть
     товар. Флаг ставим «сравнить и записать»: списывает тот, кто его поднял. */
  const fresh = db.prepare('SELECT items_json FROM orders WHERE id = ?').get(order.id) || order;
  let items = [];
  try { items = JSON.parse(fresh.items_json || '[]'); } catch (_) {}
  const take = db.prepare('UPDATE orders SET stock_reserved = 1 WHERE id = ? AND stock_reserved = 0').run(order.id);
  if (take.changes === 1) deductStock(items);

  if (order.promo_code) {
    const cms = getCms();
    const pr = (cms.promos || []).find((x) => String(x.code).toUpperCase() === String(order.promo_code).toUpperCase());
    if (pr) {
      pr.used = (pr.used || 0) + 1;
      saveCms(cms);
    }
  }

  let steps = [];
  try { steps = JSON.parse(order.steps_json || '[]'); } catch (_) {}
  steps = normalizeCheckoutSteps(steps);
  const dd = new Date().toISOString().slice(5, 10);
  stampStep(steps, 'Оплата', dd);

  db.prepare(`
    UPDATE orders SET
      status = 'В обработке',
      yookassa_id = COALESCE(?, yookassa_id),
      steps_json = ?,
      step_now = 2,
      updated_at = datetime('now')
    WHERE id = ?
  `).run(paymentId || null, JSON.stringify(steps), order.id);

  const paid = rowToOrder(db.prepare('SELECT * FROM orders WHERE id = ?').get(order.id));
  /* После реальной оплаты — владельцу и покупателю */
  try {
    const { notifyOwnerNewOrder, notifyCustomerNewOrder } = require('./telegram-bot');
    notifyOwnerNewOrder(paid).catch(() => {});
    notifyCustomerNewOrder(paid).catch(() => {});
    /* Оплата прошла — это и есть момент, когда заказ становится настоящим.
       Владельцу push о новом заказе, покупателю — что заказ принят в работу. */
    pushOrderToAdmins(paid);
    pushOrderToBuyer(paid, 'В обработке');
  } catch (_) {}
  return paid;
}

async function handleWebhook(event) {
  if (!event || !event.object || !event.object.id) return { ok: true };
  const paymentId = String(event.object.id);

  /* Не доверяем телу webhook: статус и сумма только из API ЮKassa. */
  const payment = await getPayment(paymentId);
  if (!payment) {
    console.warn('yookassa webhook: payment not found in API', paymentId);
    return { ok: false, error: 'payment_not_found' };
  }

  let order = db.prepare('SELECT * FROM orders WHERE yookassa_id = ?').get(paymentId);
  const metaNum = payment.metadata && payment.metadata.orderNum
    ? String(payment.metadata.orderNum)
    : '';
  if (!order && metaNum) {
    order = db.prepare('SELECT * FROM orders WHERE num = ?').get(metaNum);
  }
  if (!order) {
    if (payment.status === 'succeeded') {
      pushPaymentAnomaly('Заказа с таким номером в базе нет.', payment, null);
    }
    /* ok:false — чтобы ЮKassa повторила: заказ мог не найтись из-за
       временного сбоя базы, а второй попытки без этого не будет. */
    return { ok: false, error: 'order_not_found' };
  }

  if (metaNum && String(order.num) !== metaNum) {
    console.warn('yookassa webhook: orderNum mismatch', paymentId, order.num, metaNum);
    if (payment.status === 'succeeded') {
      pushPaymentAnomaly(`Платёж указывает на заказ №${metaNum}, а в базе под ним №${order.num}.`, payment, order);
    }
    return { ok: false, error: 'order_mismatch' };
  }

  if (payment.status === 'succeeded' && paymentRefunded(payment)) {
    /* Деньги уже вернули — заказ в работу не поднимаем. */
    return { ok: true };
  }
  if (payment.status === 'succeeded') {
    if (!amountsMatch(payment, order)) {
      console.warn('yookassa webhook: amount mismatch', {
        paymentId,
        paid: payment.amount && payment.amount.value,
        expected: order.price,
        currency: payment.amount && payment.amount.currency,
        order: order.num
      });
      pushPaymentAnomaly('Сумма платежа не совпала с суммой заказа.', payment, order);
      return { ok: false, error: 'amount_mismatch' };
    }
    markPaid(order, paymentId);
  } else if (payment.status === 'canceled' && order.pay_status !== 'paid') {
    /* Не отменяем заказ: покупатель мог закрыть страницу ЮKassa.
       Ссылку сбрасываем — «Оплатить» создаст новый платёж. */
    db.prepare(`
      UPDATE orders SET
        confirmation_url = '',
        updated_at = datetime('now')
      WHERE id = ? AND pay_status != 'paid'
    `).run(order.id);
  }
  return { ok: true };
}

async function syncPaymentStatus(num) {
  const order = db.prepare('SELECT * FROM orders WHERE num = ?').get(num);
  if (!order) return null;
  if (order.pay_status === 'paid') return rowToOrder(order);
  if (!order.yookassa_id) return rowToOrder(order);
  /* askPayment: ЮKassa не ответила — отдаём заказ как есть, а не роняем запрос */
  const payment = (await askPayment(order.yookassa_id)).payment;
  if (payment && payment.status === 'succeeded') {
    if (paymentSettled(payment, order)) {
      return markPaid(order, payment.id);
    }
    console.warn('yookassa sync: amount mismatch or refunded', order.num, payment.amount, order.price);
  }
  return rowToOrder(db.prepare('SELECT * FROM orders WHERE id = ?').get(order.id));
}

/**
 * Актуальная ссылка на оплату: живой pending — та же,
 * истекший/отменённый платёж — новый, succeeded — помечаем оплаченным.
 */
async function ensurePayment(num, user, accessToken, publicUrl) {
  await settleOverdueOrder(num);
  const row = db.prepare('SELECT * FROM orders WHERE num = ?').get(String(num || ''));
  if (!row) throw Object.assign(new Error('Заказ не найден'), { status: 404 });
  const order = rowToOrder(row);
  if (!canAccessOrder(order, user, accessToken)) {
    throw Object.assign(new Error('Нет доступа'), { status: 403 });
  }
  if (row.pay_status === 'paid') {
    return { order: toPublicOrder(order, { admin: !!(user && user.role === 'admin') }), alreadyPaid: true };
  }
  if (row.pay_status === 'manual' || row.status === 'Отменён' || row.status === 'Возврат') {
    throw Object.assign(new Error('Этот заказ нельзя оплатить'), { status: 400 });
  }
  if (!configured()) {
    throw Object.assign(new Error('Онлайн-оплата не подключена'), { status: 503 });
  }
  if (!(Number(row.price) >= 1)) {
    const paid = markPaid(row, null);
    return { order: toPublicOrder(paid, { admin: false }), alreadyPaid: true };
  }

  if (row.yookassa_id) {
    const payment = await getPayment(row.yookassa_id);
    if (payment && payment.status === 'succeeded') {
      if (paymentRefunded(payment)) {
        throw Object.assign(new Error('Оплата по этому заказу возвращена'), { status: 409 });
      }
      if (!amountsMatch(payment, row)) {
        throw Object.assign(new Error('Сумма оплаты не совпадает с заказом'), { status: 409 });
      }
      const paid = markPaid(row, payment.id);
      return { order: toPublicOrder(paid, { admin: false }), alreadyPaid: true };
    }
    const liveUrl = payment && payment.status === 'pending'
      && payment.confirmation && payment.confirmation.confirmation_url;
    if (liveUrl) {
      if (liveUrl !== row.confirmation_url) {
        db.prepare(`
          UPDATE orders SET confirmation_url = ?, updated_at = datetime('now') WHERE id = ?
        `).run(liveUrl, row.id);
      }
      const fresh = rowToOrder(db.prepare('SELECT * FROM orders WHERE id = ?').get(row.id));
      return {
        order: toPublicOrder(fresh, { admin: false }),
        confirmationUrl: liveUrl
      };
    }
  }

  let items = [];
  try { items = JSON.parse(row.items_json || '[]'); } catch (_) {}
  const token = row.access_token || newAccessToken();
  if (!row.access_token) {
    db.prepare('UPDATE orders SET access_token = ? WHERE id = ?').run(token, row.id);
  }
  const returnUrl = checkoutReturnUrl(publicUrl, row.num, token);
  const payment = await createPayment(paymentPayload({
    orderId: row.id,
    num: row.num,
    price: row.price,
    returnUrl,
    email: row.email,
    phone: row.phone,
    items,
    discount: row.discount,
    ship: row.ship
  }));
  const confUrl = payment.confirmation && payment.confirmation.confirmation_url;
  if (!confUrl) {
    throw Object.assign(new Error('ЮKassa не вернула ссылку на оплату'), { status: 502 });
  }
  db.prepare(`
    UPDATE orders SET
      yookassa_id = ?,
      confirmation_url = ?,
      pay_status = 'pending',
      status = 'Ожидает оплаты',
      updated_at = datetime('now')
    WHERE id = ? AND pay_status != 'paid'
  `).run(payment.id, confUrl, row.id);

  const fresh = rowToOrder(db.prepare('SELECT * FROM orders WHERE id = ?').get(row.id));
  return {
    order: toPublicOrder(fresh, { admin: false }),
    confirmationUrl: confUrl,
    orderAccessToken: token
  };
}

function listOrdersForUser(user) {
  if (!user) return [];
  expireUnpaidOrders();
  claimOrdersForUser(user);
  const rows = db.prepare(`
    SELECT * FROM orders WHERE user_id = ? ORDER BY id DESC
  `).all(user.id);
  return rows.map((r) => toPublicOrder(rowToOrder(r), { admin: user.role === 'admin' }));
}

function listAllOrders() {
  expireUnpaidOrders();
  return db.prepare('SELECT * FROM orders ORDER BY id DESC').all()
    .map((r) => toPublicOrder(rowToOrder(r), { admin: true }));
}

function getOrderByNum(num) {
  expireUnpaidOrders();
  return rowToOrder(db.prepare('SELECT * FROM orders WHERE num = ?').get(num));
}

function getOrderRow(num) {
  return db.prepare('SELECT * FROM orders WHERE num = ?').get(num);
}

const SHOP_STATUS_RANK = {
  'Ожидает оплаты': 0,
  'В обработке': 1,
  'Едет': 2,
  'Доставка': 2,
  'Доставлен': 3
};

function statusRank(st) {
  const n = SHOP_STATUS_RANK[String(st || '')];
  return Number.isFinite(n) ? n : -1;
}

function canSyncCdek(row) {
  if (!row) return false;
  if (!isSettledPay(row)) return false;
  if (!String(row.tracking || '').trim()) return false;
  const st = String(row.status || '');
  if (st === 'Отменён' || st === 'Возврат' || st === 'Ожидает оплаты') return false;
  if (st === 'Доставлен') return false;
  return true;
}

function applyOrderAdminPatch(order, patch) {
  const prevStatus = order.status;
  const prevTrack = order.tracking || '';
  const status = patch.status != null ? patch.status : order.status;
  const tracking = patch.tracking != null ? patch.tracking : order.tracking;
  const note = patch.note != null ? patch.note : order.note;
  let step_now = order.step_now;
  let steps = [];
  try { steps = JSON.parse(order.steps_json || '[]'); } catch (_) {}
  steps = normalizeCheckoutSteps(steps);
  const nowLabel = new Date().toISOString().slice(5, 10);
  if (status === 'Ожидает оплаты') step_now = 0;
  if (status === 'В обработке') {
    step_now = 2;
    stampStep(steps, 'Обработка', nowLabel);
  }
  if (status === 'Едет' || status === 'Доставка') {
    step_now = 3;
    stampStep(steps, 'Едет', nowLabel);
  }
  if (status === 'Доставлен') {
    step_now = 4;
    stampStep(steps, 'Доставлен', nowLabel);
  }
  if (status === 'Отменён' || status === 'Возврат') {
    if (order.stock_reserved || (order.pay_status === 'paid' && order.status !== 'Отменён' && order.status !== 'Возврат')) {
      let items = [];
      try { items = JSON.parse(order.items_json || '[]'); } catch (_) {}
      restoreStock(items);
    }
  }
  db.prepare(`
    UPDATE orders SET status = ?, tracking = ?, note = ?, step_now = ?, steps_json = ?, stock_reserved = ?, updated_at = datetime('now') WHERE id = ?
  `).run(
    status,
    tracking || '',
    note || '',
    step_now,
    JSON.stringify(steps),
    (status === 'Отменён' || status === 'Возврат') ? 0 : (order.stock_reserved ? 1 : 0),
    order.id
  );
  const updated = toPublicOrder(getOrderByNum(order.num), { admin: true });
  if (
    updated &&
    isSettledPay(order) &&
    (String(prevStatus) !== String(status) || String(prevTrack) !== String(tracking || ''))
  ) {
    try {
      const { notifyCustomerOrder } = require('./telegram-bot');
      notifyCustomerOrder(updated).catch(() => {});
    } catch (_) {}
    /* Только на смену статуса: трек-номер меняют и молча, дёргать ради
       этого уведомлением незачем. */
    if (String(prevStatus) !== String(status)) pushOrderToBuyer(updated, status);
  }
  return updated;
}

async function syncOrderFromCdek(num) {
  const cdek = require('./cdek');
  if (!cdek.configured()) return null;
  const order = db.prepare('SELECT * FROM orders WHERE num = ?').get(num);
  if (!canSyncCdek(order)) return null;
  const info = await cdek.lookupOrder(order.tracking);
  if (!info || !info.shopStatus) return null;
  if (statusRank(info.shopStatus) <= statusRank(order.status)) return null;
  return applyOrderAdminPatch(order, { status: info.shopStatus });
}

async function syncCdekOrderStatuses() {
  const cdek = require('./cdek');
  if (!cdek.configured()) return 0;
  const rows = db.prepare(`
    SELECT num FROM orders
    WHERE TRIM(IFNULL(tracking, '')) != ''
      AND pay_status IN ('paid', 'manual')
      AND status NOT IN ('Доставлен', 'Отменён', 'Возврат', 'Ожидает оплаты')
    ORDER BY id DESC
    LIMIT 40
  `).all();
  let n = 0;
  for (const row of rows) {
    try {
      const updated = await syncOrderFromCdek(row.num);
      if (updated) n += 1;
    } catch (e) {
      console.warn('cdek status sync', row.num, e && e.message);
    }
  }
  return n;
}

async function updateOrderAdmin(num, patch) {
  const order = db.prepare('SELECT * FROM orders WHERE num = ?').get(num);
  if (!order) return null;
  const updated = applyOrderAdminPatch(order, patch || {});
  try {
    const synced = await syncOrderFromCdek(num);
    if (synced) return synced;
  } catch (e) {
    console.warn('cdek track sync:', e && e.message);
  }
  return updated;
}

function isSettledPay(row) {
  const p = String((row && (row.pay_status || row.payStatus)) || '');
  return p === 'paid' || p === 'manual';
}

/** Отмена покупателем (ожидает оплаты / в обработке). */
function cancelOrderBuyer(num, user, accessToken) {
  const row = db.prepare('SELECT * FROM orders WHERE num = ?').get(String(num || ''));
  if (!row) {
    throw Object.assign(new Error('Заказ не найден'), { status: 404 });
  }
  const order = rowToOrder(row);
  if (!canAccessOrder(order, user, accessToken)) {
    throw Object.assign(new Error('Нет доступа'), { status: 403 });
  }
  if (row.status === 'Отменён' || row.status === 'Возврат') {
    return toPublicOrder(order, { admin: !!(user && user.role === 'admin') });
  }
  if (!['Ожидает оплаты', 'В обработке'].includes(row.status)) {
    throw Object.assign(new Error('Этот заказ уже нельзя отменить'), { status: 400 });
  }
  if (row.stock_reserved || (row.pay_status === 'paid' && row.status !== 'Отменён' && row.status !== 'Возврат')) {
    let items = [];
    try { items = JSON.parse(row.items_json || '[]'); } catch (_) {}
    restoreStock(items);
  }
  const settled = isSettledPay(row);
  const payStatus = row.pay_status === 'pending' ? 'canceled' : row.pay_status;
  db.prepare(`
    UPDATE orders SET
      status = 'Отменён',
      pay_status = ?,
      step_now = 0,
      stock_reserved = 0,
      updated_at = datetime('now')
    WHERE id = ?
  `).run(payStatus, row.id);
  const updated = toPublicOrder(getOrderByNum(row.num), { admin: !!(user && user.role === 'admin') });
  /* Неоплаченный черновик — не заказ. Админу и покупателю писать не о чем. */
  if (settled) {
    try {
      const { notifyOwnerCancelled, notifyCustomerOrder } = require('./telegram-bot');
      notifyOwnerCancelled(updated).catch(() => {});
      notifyCustomerOrder(updated).catch(() => {});
    } catch (_) {}
  }
  return updated;
}

/** Заявка на возврат после доставки. */
function requestReturnBuyer(num, user, accessToken) {
  const row = db.prepare('SELECT * FROM orders WHERE num = ?').get(String(num || ''));
  if (!row) {
    throw Object.assign(new Error('Заказ не найден'), { status: 404 });
  }
  const order = rowToOrder(row);
  if (!canAccessOrder(order, user, accessToken)) {
    throw Object.assign(new Error('Нет доступа'), { status: 403 });
  }
  if (row.status === 'Возврат') {
    return toPublicOrder(order, { admin: !!(user && user.role === 'admin') });
  }
  if (row.status !== 'Доставлен') {
    throw Object.assign(new Error('Возврат доступен только после доставки'), { status: 400 });
  }
  db.prepare(`
    UPDATE orders SET status = 'Возврат', step_now = 0, updated_at = datetime('now') WHERE id = ?
  `).run(row.id);
  const updated = toPublicOrder(getOrderByNum(row.num), { admin: !!(user && user.role === 'admin') });
  try {
    const { notifyCustomerOrder } = require('./telegram-bot');
    notifyCustomerOrder(updated).catch(() => {});
  } catch (_) {}
  return updated;
}

module.exports = {
  shipQuote,
  quoteForCart,
  createCheckout,
  handleWebhook,
  syncPaymentStatus,
  ensurePayment,
  listOrdersForUser,
  listAllOrders,
  getOrderByNum,
  updateOrderAdmin,
  cancelOrderBuyer,
  requestReturnBuyer,
  claimOrdersForUser,
  getCms,
  saveCms,
  rowToOrder,
  toPublicOrder,
  canAccessOrder,
  expireUnpaidOrders,
  expireUnpaidOrdersChecked,
  settleOverdueOrder,
  syncCdekOrderStatuses,
  configured
};
