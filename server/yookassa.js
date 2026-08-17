const { randomUUID } = require('crypto');

function configured() {
  return !!(process.env.YOOKASSA_SHOP_ID && process.env.YOOKASSA_SECRET);
}

function moneyStr(n) {
  const v = Math.round(Number(n) * 100) / 100;
  if (!Number.isFinite(v)) return '0.00';
  return v.toFixed(2);
}

function vatCode() {
  const n = parseInt(process.env.YOOKASSA_VAT_CODE || '1', 10);
  return n >= 1 && n <= 12 ? n : 1;
}

function taxSystemCode() {
  const n = parseInt(process.env.YOOKASSA_TAX_SYSTEM || '', 10);
  return n >= 1 && n <= 6 ? n : null;
}

function receiptEnabled() {
  const v = String(process.env.YOOKASSA_RECEIPT || '1').trim().toLowerCase();
  return v !== '0' && v !== 'false' && v !== 'off';
}

/** Телефон для чека ЮKassa: 11 цифр, начинается с 7. */
function receiptPhone(phone) {
  let d = String(phone || '').replace(/\D/g, '');
  if (d.length === 11 && d.startsWith('8')) d = '7' + d.slice(1);
  if (d.length === 10) d = '7' + d;
  if (d.length === 11 && d.startsWith('7')) return d;
  return '';
}

/**
 * Позиции чека: сумма строк = amount (товары − скидка + доставка).
 * Скидка размазывается по товарам, остаток — на последнюю позицию.
 */
function buildReceiptItems({ items, discount, ship, amount }) {
  const list = Array.isArray(items) ? items.filter((i) => i && (+i.qty || 0) > 0) : [];
  const goods = list.reduce((s, i) => s + (+i.price || 0) * (+i.qty || 0), 0);
  const disc = Math.max(0, Math.round(+discount || 0));
  const shipAmt = Math.max(0, Math.round(+ship || 0));
  const vat = vatCode();
  const out = [];
  let leftDisc = disc;

  list.forEach((it, idx) => {
    const line = Math.round((+it.price || 0) * (+it.qty || 0));
    let take = 0;
    if (idx === list.length - 1) take = leftDisc;
    else if (goods > 0) take = Math.round(disc * (line / goods));
    take = Math.min(line, Math.max(0, take));
    leftDisc -= take;
    const after = Math.max(0, line - take);
    if (after <= 0) return;
    const name = String(it.name || 'Товар').replace(/\s+/g, ' ').trim().slice(0, 128);
    out.push({
      description: name || 'Товар',
      quantity: Number(it.qty).toFixed(2),
      amount: { value: moneyStr(after), currency: 'RUB' },
      vat_code: vat,
      payment_mode: 'full_payment',
      payment_subject: 'commodity'
    });
  });

  if (shipAmt > 0) {
    out.push({
      description: 'Доставка СДЭК',
      quantity: '1.00',
      amount: { value: moneyStr(shipAmt), currency: 'RUB' },
      vat_code: vat,
      payment_mode: 'full_payment',
      payment_subject: 'service'
    });
  }

  const sum = out.reduce((s, i) => s + Math.round(parseFloat(i.amount.value) * 100), 0);
  const need = Math.round(Number(amount) * 100);
  if (out.length && sum !== need && out[out.length - 1]) {
    const last = out[out.length - 1];
    const lastCents = Math.round(parseFloat(last.amount.value) * 100) + (need - sum);
    if (lastCents > 0) last.amount.value = moneyStr(lastCents / 100);
  }

  return out.filter((i) => parseFloat(i.amount.value) > 0);
}

function buildReceipt({ email, phone, items, discount, ship, amount }) {
  const customer = {};
  const em = String(email || '').trim().toLowerCase();
  if (em.includes('@')) customer.email = em;
  const ph = receiptPhone(phone);
  if (ph) customer.phone = ph;
  if (!customer.email && !customer.phone) return null;

  const receiptItems = buildReceiptItems({ items, discount, ship, amount });
  if (!receiptItems.length) return null;

  const receipt = { customer, items: receiptItems };
  const tax = taxSystemCode();
  if (tax) receipt.tax_system_code = tax;
  return receipt;
}

function authHeader() {
  const shopId = process.env.YOOKASSA_SHOP_ID;
  const secret = process.env.YOOKASSA_SECRET;
  return 'Basic ' + Buffer.from(`${shopId}:${secret}`).toString('base64');
}

function receiptRejected(data) {
  const blob = JSON.stringify(data || {}).toLowerCase();
  return /receipt/.test(blob) && (
    /not required|не треб|не нужн|cannot be specified|не должен|лишн/.test(blob)
  );
}

async function postPayment(body, idempotenceKey) {
  return fetch('https://api.yookassa.ru/v3/payments', {
    method: 'POST',
    headers: {
      Authorization: authHeader(),
      'Content-Type': 'application/json',
      'Idempotence-Key': idempotenceKey
    },
    body: JSON.stringify(body)
  });
}

async function createPayment({
  amount,
  description,
  orderNum,
  returnUrl,
  metadata,
  email,
  phone,
  items,
  discount,
  ship
}) {
  if (!configured()) {
    const err = new Error('ЮKassa не настроена: укажите YOOKASSA_SHOP_ID и YOOKASSA_SECRET в .env');
    err.status = 503;
    err.code = 'YOOKASSA_NOT_CONFIGURED';
    throw err;
  }

  const value = moneyStr(amount);
  if (!(parseFloat(value) >= 1)) {
    const err = new Error('Сумма оплаты слишком маленькая');
    err.status = 400;
    throw err;
  }

  const body = {
    amount: { value, currency: 'RUB' },
    capture: true,
    confirmation: {
      type: 'redirect',
      return_url: returnUrl
    },
    description: String(description || `Заказ №${orderNum}`).slice(0, 128),
    metadata: Object.assign({ orderNum: String(orderNum) }, metadata || {}),
    expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString()
  };

  const receipt = receiptEnabled()
    ? buildReceipt({ email, phone, items, discount, ship, amount: parseFloat(value) })
    : null;
  if (receipt) body.receipt = receipt;

  const key = randomUUID();
  let res = await postPayment(body, key);
  let data = await res.json().catch(() => ({}));

  /* Тестовый магазин без 54-ФЗ иногда отклоняет чек — повторяем без него. */
  if (!res.ok && body.receipt && receiptRejected(data)) {
    delete body.receipt;
    res = await postPayment(body, randomUUID());
    data = await res.json().catch(() => ({}));
  }

  if (!res.ok) {
    const msg = (data && data.description) || (data && data.message) || 'Ошибка ЮKassa';
    const err = new Error(msg);
    err.status = 502;
    err.details = data;
    throw err;
  }
  return data;
}

async function getPayment(paymentId) {
  if (!configured() || !paymentId) return null;
  const res = await fetch(`https://api.yookassa.ru/v3/payments/${encodeURIComponent(paymentId)}`, {
    headers: { Authorization: authHeader() }
  });
  if (!res.ok) return null;
  return res.json();
}

async function cancelPayment(paymentId) {
  if (!configured() || !paymentId) return null;
  try {
    const res = await fetch(`https://api.yookassa.ru/v3/payments/${encodeURIComponent(paymentId)}/cancel`, {
      method: 'POST',
      headers: {
        Authorization: authHeader(),
        'Idempotence-Key': randomUUID(),
        'Content-Type': 'application/json'
      },
      body: '{}'
    });
    if (!res.ok) return null;
    return res.json();
  } catch (_) {
    return null;
  }
}

module.exports = {
  configured,
  createPayment,
  getPayment,
  cancelPayment,
  moneyStr,
  receiptPhone,
  buildReceipt
};
