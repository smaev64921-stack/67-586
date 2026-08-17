const crypto = require('crypto');
const { db } = require('./db');
const { getProduct, checkStock, deductStock, restoreStock } = require('./products');
const { createPayment, configured, getPayment, cancelPayment } = require('./yookassa');

const PAY_WAIT_MS = 60 * 60 * 1000;

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

function expireUnpaidOrder(row) {
  if (!row || !awaitingPayRow(row)) return false;
  const created = orderCreatedMs(row);
  if (!created || Date.now() - created < PAY_WAIT_MS) return false;
  const info = db.prepare(`
    DELETE FROM orders
    WHERE id = ? AND status = 'Ожидает оплаты' AND pay_status != 'paid' AND pay_status != 'manual'
  `).run(row.id);
  if (!info.changes) return false;
  if (row.stock_reserved) {
    let items = [];
    try { items = JSON.parse(row.items_json || '[]'); } catch (_) {}
    try { restoreStock(items); } catch (e) { console.warn('expire restore stock', e.message); }
  }
  if (row.yookassa_id) {
    cancelPayment(row.yookassa_id).catch(() => {});
  }
  return true;
}

function expireUnpaidOrders() {
  const rows = db.prepare(`
    SELECT * FROM orders
    WHERE status = 'Ожидает оплаты' AND pay_status != 'paid' AND pay_status != 'manual'
  `).all();
  let n = 0;
  for (const row of rows) {
    if (expireUnpaidOrder(row)) n += 1;
  }
  return n;
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

function shipCost(goodsAfterDiscount, promo) {
  if (isFreeShipPromo(promo)) return 0;
  const s = getCms().shipping || {};
  const pickup = +s.pickup || 190;
  const freeFrom = +s.freeFrom || 0;
  if (freeFrom > 0 && goodsAfterDiscount >= freeFrom) return 0;
  return pickup;
}

async function pushNewOrder(order) {
  try {
    const { notifyOwnerNewOrder, notifyCustomerNewOrder } = require('./telegram-bot');
    await notifyOwnerNewOrder(order);
    await notifyCustomerNewOrder(order);
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

async function createCheckout({ items, guest, pvz, promoCode, user, publicUrl }) {
  if (!user || !user.id) {
    throw Object.assign(new Error('Войдите в аккаунт, чтобы оформить заказ'), { status: 401 });
  }
  if (!items || !items.length) {
    throw Object.assign(new Error('Корзина пуста'), { status: 400 });
  }

  const normalized = items.map((i) => {
    const p = getProduct(i.id);
    if (!p || (!p.on && !(user && user.role === 'admin'))) {
      throw Object.assign(new Error('Товар не найден'), { status: 400 });
    }
    return {
      id: p.id,
      name: p.name,
      img: p.img,
      size: String(i.size || ''),
      qty: Math.max(1, Math.round(+i.qty || 1)),
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
  if (!pvz || !String(pvz.addr || '').trim() || String(pvz.addr).trim().length < 8) {
    throw Object.assign(new Error('Укажите адрес пункта выдачи СДЭК'), { status: 400 });
  }
  const cleanPvz = {
    code: String(pvz.code || 'manual').trim() || 'manual',
    id: String(pvz.id || pvz.code || 'manual').trim() || 'manual',
    type: String(pvz.type || 'PVZ').trim(),
    ownerCode: String(pvz.ownerCode || '').trim(),
    city: String(pvz.city || '').trim(),
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

  const goods = normalized.reduce((s, i) => s + i.price * i.qty, 0);
  const { discount, promo, error: promoErr } = calcPromo(promoCode, goods);
  if (promoErr && promoCode) throw Object.assign(new Error(promoErr), { status: 400 });
  const after = Math.max(0, goods - discount);
  const ship = shipCost(after, promo);
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
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pickup', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    num,
    userId,
    initialStatus,
    initialPay,
    price,
    goods,
    discount,
    ship,
    promo ? promo.code : '',
    name,
    email,
    phone,
    [cleanPvz.city, cleanPvz.addr].filter(Boolean).join(', ') || cleanPvz.addr,
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

  let items = [];
  try { items = JSON.parse(order.items_json || '[]'); } catch (_) {}
  if (!order.stock_reserved) {
    deductStock(items);
    try { db.prepare('UPDATE orders SET stock_reserved = 1 WHERE id = ?').run(order.id); } catch (_) {}
  }

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
  if (!order) return { ok: true, skipped: true };

  if (metaNum && String(order.num) !== metaNum) {
    console.warn('yookassa webhook: orderNum mismatch', paymentId, order.num, metaNum);
    return { ok: false, error: 'order_mismatch' };
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
  const payment = await getPayment(order.yookassa_id);
  if (payment && payment.status === 'succeeded') {
    if (amountsMatch(payment, order)) {
      return markPaid(order, payment.id);
    }
    console.warn('yookassa sync: amount mismatch', order.num, payment.amount, order.price);
  }
  return rowToOrder(db.prepare('SELECT * FROM orders WHERE id = ?').get(order.id));
}

/**
 * Актуальная ссылка на оплату: живой pending — та же,
 * истекший/отменённый платёж — новый, succeeded — помечаем оплаченным.
 */
async function ensurePayment(num, user, accessToken, publicUrl) {
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
  syncCdekOrderStatuses,
  configured
};
