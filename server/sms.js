/**
 * Доставка кода входа по телефону.
 * Numverify — только проверка номера (SMS не отправляет).
 * Код уходит через: Telegram Gateway → otp-providers → SMS.ru → DEV.
 */
function normalizePhone(raw) {
  let d = String(raw || '').replace(/\D/g, '');
  if (d.length === 11 && d[0] === '8') d = '7' + d.slice(1);
  if (d.length === 10) d = '7' + d;
  if (!/^7\d{10}$/.test(d)) return '';
  return d;
}

function formatPhoneDisplay(digits) {
  const d = normalizePhone(digits);
  if (!d) return String(digits || '');
  return `+${d[0]} (${d.slice(1, 4)}) ${d.slice(4, 7)}-${d.slice(7, 9)}-${d.slice(9)}`;
}

function toE164(digits) {
  const d = normalizePhone(digits);
  return d ? `+${d}` : '';
}

function numverifyKey() {
  const id = String(
    process.env.NUMVERIFY_API_KEY ||
    process.env.SMS_MOBIL_API_KEY || /* старый ключ по ошибке клали сюда */
    ''
  ).trim();
  return id && id !== 'change-me' && !/^change/i.test(id) ? id : '';
}

function smsRuKey() {
  const id = String(process.env.SMS_RU_API_ID || '').trim();
  return id && id !== 'change-me' && !/^change/i.test(id) ? id : '';
}

function smsConfigured() {
  /* Numverify не шлёт SMS — для «есть канал доставки» смотрим реальные провайдеры */
  try {
    if (require('./telegram-gateway').configured()) return true;
  } catch (_) {}
  return !!smsRuKey();
}

function isDevSms() {
  return process.env.SMS_DEV === '1' || process.env.SMS_DEV === 'true';
}

/**
 * Numverify: валидация номера (не отправка SMS).
 * Docs: http://apilayer.net/api/validate?access_key=KEY&number=...
 */
async function validatePhoneNumverify(phoneDigits) {
  const key = numverifyKey();
  if (!key) return { ok: true, skipped: true };
  const number = toE164(phoneDigits) || String(phoneDigits || '');
  const url = new URL('http://apilayer.net/api/validate');
  url.searchParams.set('access_key', key);
  url.searchParams.set('number', number);
  url.searchParams.set('country_code', 'RU');
  url.searchParams.set('format', '1');

  const r = await fetch(url.toString());
  const data = await r.json().catch(() => ({}));
  if (data.success === false || data.error) {
    const code = data.error && data.error.code;
    const info = (data.error && data.error.info) || 'Numverify error';
    /* лимит / ключ — не блокируем вход, только предупреждаем */
    if (code === 104 || code === 101 || code === 102) {
      console.warn('Numverify:', info);
      return { ok: true, skipped: true, warn: info, raw: data };
    }
    throw Object.assign(new Error(String(info)), { status: 502, numverify: data });
  }
  if (data.valid === false) {
    throw Object.assign(new Error('Номер недействителен — проверьте и введите снова'), {
      status: 400,
      numverify: data
    });
  }
  return { ok: true, valid: true, raw: data };
}

async function sendViaSmsRu(phoneDigits, text) {
  const apiId = smsRuKey();
  if (!apiId) throw Object.assign(new Error('SMS.ru не настроен'), { status: 503 });
  const to = normalizePhone(phoneDigits);
  const url = new URL('https://sms.ru/sms/send');
  url.searchParams.set('api_id', apiId);
  url.searchParams.set('to', to);
  url.searchParams.set('msg', text);
  url.searchParams.set('json', '1');

  const r = await fetch(url.toString());
  const data = await r.json().catch(() => ({}));
  if (data.status !== 'OK' && data.status_code !== 100) {
    const msg = data.status_text || data.status || 'SMS не отправлено';
    throw Object.assign(new Error(String(msg)), { status: 502, sms: data });
  }
  return { ok: true, provider: 'sms.ru', phone: to, raw: data };
}

async function sendViaGateway(phoneDigits, text) {
  const gw = require('./telegram-gateway');
  if (!gw.configured()) {
    throw Object.assign(new Error('Telegram Gateway не настроен'), { status: 503 });
  }
  const codeMatch = String(text || '').match(/\b(\d{4,8})\b/);
  const code = codeMatch ? codeMatch[1] : '';
  if (!code) throw Object.assign(new Error('Нет кода для Gateway'), { status: 500 });
  const sent = await gw.sendVerificationCode(phoneDigits, code);
  return { ok: true, provider: 'telegram-gateway', phone: normalizePhone(phoneDigits), raw: sent };
}

async function sendSms(phone, text) {
  const to = normalizePhone(phone);
  if (!to) throw Object.assign(new Error('Некорректный номер'), { status: 400 });

  /* 1) проверить номер через Numverify (если ключ есть) */
  try {
    await validatePhoneNumverify(to);
  } catch (e) {
    if (e.status === 400) throw e;
    console.warn('Numverify skip:', e.message);
  }

  const errors = [];

  /* 2) Telegram Gateway — реальная доставка кода */
  try {
    const gw = require('./telegram-gateway');
    if (gw.configured()) {
      return await sendViaGateway(to, text);
    }
  } catch (e) {
    errors.push('Gateway: ' + (e.message || e));
    console.warn('Telegram Gateway fail:', e.message);
  }

  /* 3) пул провайдеров из бота */
  try {
    const providers = require('./otp-providers');
    if (providers.getActive()) {
      const codeMatch = String(text || '').match(/\b(\d{4,8})\b/);
      const code = codeMatch ? codeMatch[1] : '';
      return await providers.sendViaActive(to, code, text);
    }
  } catch (e) {
    if (e.exhausted || e.noProvider || e.status === 502 || e.status === 503) {
      errors.push(e.message);
    } else {
      console.warn('otp-providers send skip:', e.message);
    }
  }

  /* 4) SMS.ru */
  if (smsRuKey()) {
    try {
      return await sendViaSmsRu(to, text);
    } catch (e) {
      errors.push('SMS.ru: ' + (e.message || e));
    }
  }

  if (isDevSms()) {
    console.log(`[SMS DEV] → +${to}: ${text}`);
    return { ok: true, provider: 'dev', phone: to };
  }

  const msg = errors.length
    ? errors[0]
    : 'Нет канала отправки кода. Numverify только проверяет номер — нужен Telegram Gateway или SMS.ru.';
  throw Object.assign(new Error(msg), { status: 502, errors });
}

module.exports = {
  normalizePhone,
  formatPhoneDisplay,
  toE164,
  smsConfigured,
  numverifyKey,
  smsRuKey,
  isDevSms,
  sendSms,
  validatePhoneNumverify
};
