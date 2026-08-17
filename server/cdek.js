const CDEK_API_URL = (process.env.CDEK_API_URL || 'https://api.cdek.ru/v2').replace(/\/+$/, '');
const CLIENT_ID = () => String(
  process.env.CDEK_CLIENT_ID ||
  process.env.CDEK_ACCOUNT ||
  process.env.CDEK_ACCOUNT_ID ||
  ''
).trim();
const CLIENT_SECRET = () => String(
  process.env.CDEK_CLIENT_SECRET ||
  process.env.CDEK_SECURE_PASSWORD ||
  process.env.CDEK_SECURE ||
  ''
).trim();

let tokenCache = { token: '', exp: 0 };

function configured() {
  return !!(CLIENT_ID() && CLIENT_SECRET());
}

function timeoutSignal(ms) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ms);
  if (typeof t.unref === 'function') t.unref();
  return ac.signal;
}

async function cdekFetch(path, { method = 'GET', query, body, auth = true, timeout = 12000 } = {}) {
  const url = new URL(CDEK_API_URL + path);
  Object.entries(query || {}).forEach(([k, v]) => {
    if (v !== undefined && v !== null && String(v).trim() !== '') url.searchParams.set(k, String(v));
  });

  const headers = { Accept: 'application/json' };
  let payload;
  if (body instanceof URLSearchParams) {
    headers['Content-Type'] = 'application/x-www-form-urlencoded';
    payload = body.toString();
  } else if (body != null) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  if (auth) headers.Authorization = 'Bearer ' + await getToken();

  let res;
  try {
    res = await fetch(url, {
      method,
      headers,
      body: payload,
      signal: timeoutSignal(timeout)
    });
  } catch (e) {
    const msg = e && e.name === 'AbortError'
      ? 'СДЭК не ответил вовремя'
      : 'Не удалось связаться с API СДЭК';
    throw Object.assign(new Error(msg), { status: 502 });
  }

  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (_) {}

  if (!res.ok) {
    const detail = data && (data.message || data.error || (Array.isArray(data.errors) && data.errors[0] && data.errors[0].message));
    throw Object.assign(new Error(detail || `API СДЭК вернул HTTP ${res.status}`), { status: res.status, data });
  }
  return data;
}

async function getToken() {
  if (!configured()) {
    throw Object.assign(new Error('СДЭК не настроен: нужны CDEK_CLIENT_ID/CDEK_ACCOUNT и CDEK_CLIENT_SECRET/CDEK_SECURE_PASSWORD'), { status: 503 });
  }
  if (tokenCache.token && Date.now() < tokenCache.exp) return tokenCache.token;

  const body = new URLSearchParams();
  body.set('grant_type', 'client_credentials');
  body.set('client_id', CLIENT_ID());
  body.set('client_secret', CLIENT_SECRET());

  const data = await cdekFetch('/oauth/token', {
    method: 'POST',
    body,
    auth: false,
    timeout: 15000
  });
  if (!data || !data.access_token) {
    throw Object.assign(new Error('СДЭК не вернул access_token'), { status: 502 });
  }
  const ttl = Math.max(60, +data.expires_in || 3600);
  tokenCache = {
    token: data.access_token,
    exp: Date.now() + (ttl - 30) * 1000
  };
  return tokenCache.token;
}

function normalizeCity(x) {
  return {
    code: +x.code || +x.city_code || 0,
    city: String(x.city || '').trim(),
    region: String(x.region || '').trim(),
    country: String(x.country || '').trim(),
    countryCode: String(x.country_code || '').trim(),
    fiasGuid: String(x.fias_guid || '').trim(),
    lat: +(x.latitude || (x.location && x.location.latitude)) || 0,
    lng: +(x.longitude || (x.location && x.location.longitude)) || 0
  };
}

function normalizePoint(p) {
  const loc = p.location || {};
  const lat = +(loc.latitude || p.latitude) || 0;
  const lng = +(loc.longitude || p.longitude) || 0;
  const address = String(loc.address_full || loc.address || p.address || '').trim();
  return {
    code: String(p.code || '').trim(),
    name: String(p.name || '').trim(),
    type: String(p.type || 'PVZ').trim(),
    ownerCode: String(p.owner_code || '').trim(),
    city: String(loc.city || '').trim(),
    cityCode: +(loc.city_code || 0) || 0,
    addr: address,
    addressComment: String(p.address_comment || '').trim(),
    hours: String(p.work_time || '').trim(),
    workTimeList: Array.isArray(p.work_time_list) ? p.work_time_list : [],
    lat,
    lng,
    phone: Array.isArray(p.phones) && p.phones[0] ? String(p.phones[0].number || '').trim() : '',
    note: String(p.note || '').trim(),
    haveCashless: p.have_cashless === true,
    haveCash: p.have_cash === true,
    allowedCod: p.allowed_cod === true,
    isHandout: p.is_handout !== false,
    isReception: p.is_reception === true,
    isDressingRoom: p.is_dressing_room === true,
    weightMin: +p.weight_min || 0,
    weightMax: +p.weight_max || 0
  };
}

async function searchCities(q, { lat, lng } = {}) {
  const city = String(q || '').trim();
  const hasGeo = Number.isFinite(+lat) && Number.isFinite(+lng) && +lat !== 0 && +lng !== 0;
  if (city.length < 2 && !hasGeo) return [];
  const data = await cdekFetch('/location/cities', {
    query: {
      city: city || undefined,
      country_codes: 'RU',
      latitude: hasGeo ? +lat : undefined,
      longitude: hasGeo ? +lng : undefined,
      size: 12,
      lang: 'rus'
    }
  });
  return (Array.isArray(data) ? data : [])
    .map(normalizeCity)
    .filter((x) => x.code && x.city)
    .map((x) => hasGeo ? { ...x, km: distanceKm({ lat: +lat, lng: +lng }, x) } : x)
    .sort((a, b) => (a.km || 0) - (b.km || 0))
    .slice(0, 12);
}

async function deliveryPoints({ cityCode, lat, lng, q, limit = 80 } = {}) {
  const query = {
    type: 'PVZ',
    is_handout: true,
    lang: 'rus'
  };

  const city = +cityCode || 0;
  if (city) query.city_code = city;

  const data = await cdekFetch('/deliverypoints', { query });
  let points = (Array.isArray(data) ? data : [])
    .map(normalizePoint)
    .filter((p) => p.code && p.addr && Number.isFinite(p.lat) && Number.isFinite(p.lng));

  const needle = String(q || '').trim().toLowerCase();
  if (needle) {
    points = points.filter((p) =>
      [p.city, p.addr, p.name, p.code].some((v) => String(v || '').toLowerCase().includes(needle))
    );
  }

  const hasGeo = Number.isFinite(+lat) && Number.isFinite(+lng) && +lat !== 0 && +lng !== 0;
  if (hasGeo) {
    const me = { lat: +lat, lng: +lng };
    points = points.map((p) => ({ ...p, km: distanceKm(me, p) }))
      .sort((a, b) => a.km - b.km);
  } else {
    points = points.sort((a, b) => String(a.addr).localeCompare(String(b.addr), 'ru'));
  }

  return points.slice(0, Math.max(1, Math.min(+limit || 80, 200)));
}

function distanceKm(a, b) {
  const R = 6371;
  const rad = (d) => d * Math.PI / 180;
  const dLat = rad(+b.lat - +a.lat);
  const dLng = rad(+b.lng - +a.lng);
  const x = Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(+a.lat)) * Math.cos(rad(+b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}

/** Трек из номера, ссылки СДЭК или UUID заказа. */
function parseTrackRef(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;

  const uuid = s.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  if (uuid) return { uuid: uuid[0] };

  try {
    const u = new URL(s);
    const fromQuery = u.searchParams.get('order_id')
      || u.searchParams.get('orderid')
      || u.searchParams.get('order')
      || u.searchParams.get('cdek_number')
      || u.searchParams.get('number');
    const qDigits = String(fromQuery || '').replace(/\D/g, '');
    if (qDigits.length >= 8 && qDigits.length <= 14) return { cdek_number: qDigits };
  } catch (_) {}

  const digits = s.replace(/\D/g, '');
  if (digits.length >= 8 && digits.length <= 14) return { cdek_number: digits };
  return null;
}

const STATUS_DELIVERED = new Set(['DELIVERED']);
const STATUS_SKIP = new Set(['REMOVED', 'NOT_DELIVERED', 'INVALID']);
const STATUS_PROCESSING = new Set([
  'ACCEPTED',
  'CREATED',
  'RECEIVED_AT_SENDER_WAREHOUSE',
  'RECEIVED_AT_SHIPMENT_WAREHOUSE',
  'READY_FOR_SHIPMENT_IN_SENDER_CITY',
  'RETURNED_TO_SENDER_CITY_WAREHOUSE'
]);
const STATUS_IN_TRANSIT = new Set([
  'TAKEN_BY_TRANSPORTER_FROM_SENDER_CITY',
  'PASSED_TO_CARRIER_AT_SENDING_OFFICE',
  'SENT_TO_TRANSIT_CITY',
  'ACCEPTED_IN_TRANSIT_CITY',
  'ACCEPTED_AT_TRANSIT_WAREHOUSE',
  'RETURNED_TO_TRANSIT_WAREHOUSE',
  'READY_FOR_SHIPMENT_IN_TRANSIT_CITY',
  'TAKEN_BY_TRANSPORTER_FROM_TRANSIT_CITY',
  'PASSED_TO_CARRIER_AT_TRANSIT_OFFICE',
  'SENT_TO_SENDER_CITY',
  'MET_AT_SENDER_CITY',
  'SENT_TO_RECIPIENT_CITY',
  'ARRIVED_AT_RECIPIENT_CITY',
  'ACCEPTED_AT_RECIPIENT_CITY_WAREHOUSE',
  'ACCEPTED_IN_RECIPIENT_CITY',
  'ACCEPTED_AT_PICK_UP_POINT',
  'TAKEN_BY_COURIER',
  'RETURNED_TO_RECIPIENT_CITY_WAREHOUSE',
  'READY_FOR_SHIPMENT_IN_SENDING_CITY',
  'PASSED_TO_CARRIER',
  'POSTOMAT_POSTED',
  'POSTOMAT_SEIZED',
  'POSTOMAT_RECEIVED'
]);

function mapStatusCode(code) {
  const c = String(code || '').trim().toUpperCase();
  if (!c || STATUS_SKIP.has(c)) return null;
  if (STATUS_DELIVERED.has(c)) return 'Доставлен';
  if (STATUS_IN_TRANSIT.has(c)) return 'Едет';
  if (STATUS_PROCESSING.has(c)) return 'В обработке';
  return null;
}

function latestCdekStatus(entity) {
  const list = Array.isArray(entity && entity.statuses) ? entity.statuses : [];
  if (!list.length) return null;
  const sorted = [...list].sort((a, b) => {
    const ta = Date.parse(a && a.date_time) || 0;
    const tb = Date.parse(b && b.date_time) || 0;
    return ta - tb;
  });
  return sorted[sorted.length - 1] || null;
}

/** GET /v2/orders — то же, что SDK orders()->get(). Без ключей не вызывается. */
async function lookupOrder(trackRaw) {
  if (!configured()) return null;
  const ref = parseTrackRef(trackRaw);
  if (!ref) return null;
  let data = null;
  try {
    if (ref.uuid) {
      data = await cdekFetch('/orders/' + encodeURIComponent(ref.uuid));
    } else {
      data = await cdekFetch('/orders', { query: { cdek_number: ref.cdek_number } });
    }
  } catch (e) {
    const st = e && e.status;
    if (st === 404 || st === 400) return null;
    console.warn('cdek order lookup:', e && e.message);
    return null;
  }
  const entity = data && (data.entity || (data.uuid || data.cdek_number ? data : null));
  if (!entity) return null;
  const st = latestCdekStatus(entity);
  return {
    cdekNumber: String(entity.cdek_number || ref.cdek_number || '').trim(),
    uuid: String(entity.uuid || ref.uuid || '').trim(),
    code: st && st.code ? String(st.code) : '',
    name: st && st.name ? String(st.name) : '',
    shopStatus: mapStatusCode(st && st.code)
  };
}

module.exports = {
  configured,
  searchCities,
  deliveryPoints,
  distanceKm,
  parseTrackRef,
  lookupOrder,
  mapStatusCode
};
