/**
 * Пул бесплатных OTP/SMS API: лимит (обычно 100), счётчик, активный провайдер.
 * Админ в боте видит расход и переключает на следующий, когда осталось мало.
 *
 * Файл: data/otp-providers.json
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DATA_DIR } = require('./db');

const FILE = path.join(DATA_DIR, 'otp-providers.json');
const DEFAULT_LIMIT = 100;
const DEFAULT_WARN_AT = 90;

function emptyStore() {
  return {
    activeId: null,
    warnAt: DEFAULT_WARN_AT,
    providers: [],
    lastWarn: {} /* id → last warned used count */
  };
}

function load() {
  try {
    const raw = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    if (!raw || typeof raw !== 'object') return emptyStore();
    if (!Array.isArray(raw.providers)) raw.providers = [];
    if (!raw.lastWarn) raw.lastWarn = {};
    if (raw.warnAt == null) raw.warnAt = DEFAULT_WARN_AT;
    return raw;
  } catch (_) {
    return emptyStore();
  }
}

function save(store) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(store, null, 2), 'utf8');
}

function seedFromEnv() {
  const store = load();
  if (store.providers.length) return store;

  const mobilKey = String(process.env.NUMVERIFY_API_KEY || '').trim();
  if (mobilKey && mobilKey !== 'change-me' && !/^change/i.test(mobilKey)) {
    /* Numverify не шлёт SMS — в пул доставки не добавляем */
  }

  const smsId = String(process.env.SMS_RU_API_ID || '').trim();
  if (smsId && smsId !== 'change-me' && !/^change/i.test(smsId)) {
    store.providers.push({
      id: crypto.randomBytes(4).toString('hex'),
      name: 'SMS.ru #1',
      type: 'sms_ru',
      apiKey: smsId,
      limit: +(process.env.OTP_PROVIDER_LIMIT || DEFAULT_LIMIT) || DEFAULT_LIMIT,
      used: 0,
      enabled: true,
      createdAt: new Date().toISOString()
    });
  }

  const gw = String(
    process.env.TELEGRAM_GATEWAY_TOKEN ||
    process.env.GATEWAY_ACCESS_TOKEN ||
    process.env.TG_GATEWAY_TOKEN ||
    ''
  ).trim();
  if (gw && gw.length > 20 && !/^change/i.test(gw)) {
    store.providers.push({
      id: crypto.randomBytes(4).toString('hex'),
      name: 'TG Gateway #1',
      type: 'telegram_gateway',
      apiKey: gw,
      limit: +(process.env.OTP_PROVIDER_LIMIT || DEFAULT_LIMIT) || DEFAULT_LIMIT,
      used: 0,
      enabled: true,
      createdAt: new Date().toISOString()
    });
  }

  if (store.providers.length && !store.activeId) {
    store.activeId = store.providers[0].id;
  }
  if (store.providers.length) save(store);
  return store;
}

function listProviders() {
  return seedFromEnv().providers.slice();
}

function getActive() {
  const store = seedFromEnv();
  if (!store.activeId) return null;
  return store.providers.find((p) => p.id === store.activeId && p.enabled) || null;
}

function findById(id) {
  return load().providers.find((p) => p.id === String(id)) || null;
}

function setWarnAt(n) {
  const store = load();
  store.warnAt = Math.max(1, Math.min(10000, +n || DEFAULT_WARN_AT));
  save(store);
  return store.warnAt;
}

function addProvider({ name, type, apiKey, limit, endpoint, note }) {
  const store = load();
  const id = crypto.randomBytes(4).toString('hex');
  const row = {
    id,
    name: String(name || `API ${store.providers.length + 1}`).trim().slice(0, 64),
    type: String(type || 'custom').trim(),
    apiKey: String(apiKey || '').trim(),
    endpoint: String(endpoint || '').trim(),
    note: String(note || '').trim().slice(0, 200),
    limit: Math.max(1, +(limit || DEFAULT_LIMIT) || DEFAULT_LIMIT),
    used: 0,
    enabled: true,
    createdAt: new Date().toISOString()
  };
  store.providers.push(row);
  if (!store.activeId) store.activeId = id;
  save(store);
  return row;
}

function updateProvider(id, patch = {}) {
  const store = load();
  const p = store.providers.find((x) => x.id === String(id));
  if (!p) return null;
  if (patch.name != null) p.name = String(patch.name).trim().slice(0, 64);
  if (patch.apiKey != null) p.apiKey = String(patch.apiKey).trim();
  if (patch.endpoint != null) p.endpoint = String(patch.endpoint).trim();
  if (patch.limit != null) p.limit = Math.max(1, +patch.limit || p.limit);
  if (patch.used != null) p.used = Math.max(0, +patch.used || 0);
  if (patch.enabled != null) p.enabled = !!patch.enabled;
  if (patch.type != null) p.type = String(patch.type).trim();
  if (patch.note != null) p.note = String(patch.note).trim().slice(0, 200);
  save(store);
  return p;
}

function removeProvider(id) {
  const store = load();
  const before = store.providers.length;
  store.providers = store.providers.filter((p) => p.id !== String(id));
  if (store.activeId === String(id)) {
    store.activeId = store.providers.find((p) => p.enabled)?.id || null;
  }
  delete store.lastWarn[String(id)];
  save(store);
  return before !== store.providers.length;
}

function setActive(id) {
  const store = load();
  const p = store.providers.find((x) => x.id === String(id));
  if (!p) throw Object.assign(new Error('Провайдер не найден'), { status: 404 });
  if (!p.enabled) throw Object.assign(new Error('Провайдер выключен'), { status: 400 });
  store.activeId = p.id;
  save(store);
  return p;
}

function resetUsed(id) {
  const store = load();
  const p = store.providers.find((x) => x.id === String(id));
  if (!p) return null;
  p.used = 0;
  delete store.lastWarn[p.id];
  save(store);
  return p;
}

function leftOf(p) {
  if (!p) return 0;
  return Math.max(0, (+p.limit || 0) - (+p.used || 0));
}

function pctOf(p) {
  if (!p || !p.limit) return 0;
  return Math.min(100, Math.round((100 * (+p.used || 0)) / (+p.limit || 1)));
}

/**
 * +1 к счётчику активного (или указанного) провайдера.
 * Возвращает { provider, warn: bool, exhausted: bool }
 */
function recordUse(providerId) {
  const store = load();
  const id = String(providerId || store.activeId || '');
  const p = store.providers.find((x) => x.id === id);
  if (!p) return { provider: null, warn: false, exhausted: false };

  p.used = (+p.used || 0) + 1;
  const warnAt = +store.warnAt || DEFAULT_WARN_AT;
  const used = p.used;
  const limit = +p.limit || DEFAULT_LIMIT;
  const exhausted = used >= limit;
  const hitWarn = used >= warnAt || used >= limit;
  const last = store.lastWarn[p.id] || 0;
  /* уведомлять при пересечении порога и при каждом +10 после, плюс на лимите */
  let warn = false;
  if (hitWarn && (used === warnAt || used === limit || used - last >= 10 || used > last && used >= limit)) {
    warn = true;
    store.lastWarn[p.id] = used;
  }
  save(store);
  return { provider: p, warn, exhausted, used, limit, left: Math.max(0, limit - used) };
}

function statusText() {
  const store = seedFromEnv();
  const lines = [
    '<b>Квоты бесплатных API</b>',
    `Порог предупреждения: <b>${store.warnAt}</b> из лимита`,
    ''
  ];
  if (!store.providers.length) {
    lines.push('Провайдеров пока нет.');
    lines.push('Добавьте ключ через кнопки ниже или в .env (SMS_MOBIL_API_KEY / SMS_RU_API_ID / TELEGRAM_GATEWAY_TOKEN).');
    return lines.join('\n');
  }
  for (const p of store.providers) {
    const on = store.activeId === p.id ? ' ✅' : '';
    const off = p.enabled ? '' : ' (выкл)';
    lines.push(
      `<b>${esc(p.name)}</b>${on}${off}`,
      `· ${p.type} · <code>${p.used}/${p.limit}</code> (осталось ${leftOf(p)}) · ${pctOf(p)}%`,
      ''
    );
  }
  return lines.join('\n');
}

function esc(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Отправка кода через активный внешний провайдер.
 * Свои типы: sms_mobil | sms_ru | telegram_gateway | custom
 */
async function sendViaActive(phoneDigits, code, text) {
  const p = getActive();
  if (!p) {
    throw Object.assign(new Error('Нет активного OTP-провайдера'), { status: 503, noProvider: true });
  }
  if (leftOf(p) <= 0) {
    throw Object.assign(
      new Error(`Лимит «${p.name}» исчерпан (${p.used}/${p.limit}). Переключите API в боте.`),
      { status: 503, exhausted: true, provider: p }
    );
  }

  const phone = String(phoneDigits || '').replace(/\D/g, '');
  const codeStr = String(code || '').replace(/\D/g, '');
  const msg = text || `Код Canvas: ${codeStr}`;

  if (p.type === 'sms_mobil' || p.type === 'sms_mobile') {
    const e164 = phone.startsWith('7') ? `+${phone}` : `+${phone}`;
    const url = new URL('https://api.smsmobileapi.com/sendsms/');
    url.searchParams.set('apikey', p.apiKey);
    url.searchParams.set('recipients', e164);
    url.searchParams.set('message', msg);
    url.searchParams.set('sendsms', '1');
    const r = await fetch(url.toString());
    const data = await r.json().catch(() => ({}));
    const result = data.result || data;
    const err = result && result.error;
    const ok = err === 0 || err === '0' || err === null || err === '' || err === undefined;
    if (!r.ok || !ok) {
      throw Object.assign(
        new Error(String((result && (result.note || result.message || result.error)) || 'SMS Mobile fail')),
        { status: 502, provider: p }
      );
    }
  } else if (p.type === 'sms_ru') {
    const apiId = p.apiKey;
    const url = new URL('https://sms.ru/sms/send');
    url.searchParams.set('api_id', apiId);
    url.searchParams.set('to', phone);
    url.searchParams.set('msg', msg);
    url.searchParams.set('json', '1');
    const r = await fetch(url.toString());
    const data = await r.json().catch(() => ({}));
    if (data.status !== 'OK' && data.status_code !== 100) {
      throw Object.assign(new Error(String(data.status_text || data.status || 'SMS fail')), {
        status: 502,
        provider: p
      });
    }
  } else if (p.type === 'telegram_gateway') {
    const e164 = phone.startsWith('7') ? `+${phone}` : `+${phone}`;
    const r = await fetch('https://gatewayapi.telegram.org/sendVerificationMessage', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${p.apiKey}`
      },
      body: JSON.stringify({ phone_number: e164, code: codeStr, ttl: 300 })
    });
    const data = await r.json().catch(() => ({}));
    if (!data.ok) {
      throw Object.assign(new Error(String(data.error || 'Gateway fail')), { status: 502, provider: p });
    }
  } else if (p.type === 'custom') {
    const endpoint = p.endpoint;
    if (!endpoint) {
      throw Object.assign(new Error(`У «${p.name}» не задан endpoint`), { status: 503, provider: p });
    }
    const r = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: p.apiKey ? `Bearer ${p.apiKey}` : undefined,
        'X-Api-Key': p.apiKey || undefined
      },
      body: JSON.stringify({ phone, code: codeStr, text: msg })
    });
    if (!r.ok) {
      const t = await r.text().catch(() => '');
      throw Object.assign(new Error(`Custom API ${r.status}: ${t.slice(0, 120)}`), {
        status: 502,
        provider: p
      });
    }
  } else {
    throw Object.assign(new Error(`Неизвестный тип провайдера: ${p.type}`), { status: 500 });
  }

  const usage = recordUse(p.id);
  return { ok: true, provider: p, usage };
}

module.exports = {
  listProviders,
  getActive,
  findById,
  addProvider,
  updateProvider,
  removeProvider,
  setActive,
  resetUsed,
  recordUse,
  setWarnAt,
  leftOf,
  pctOf,
  statusText,
  sendViaActive,
  DEFAULT_LIMIT,
  DEFAULT_WARN_AT,
  FILE
};
