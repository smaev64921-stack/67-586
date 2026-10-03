/* ==========================================================
   АДРЕС ПО ТОЧКЕ НА КАРТЕ И ПОДСКАЗКИ АДРЕСА

   Для курьера: человек двигает карту под булавкой — подставляем улицу
   и дом; печатает адрес — показываем подсказки. Источники открытые, на
   данных OpenStreetMap и без ключей: Nominatim — адрес по точке, Photon —
   подсказки по тексту.

   Ходим к ним с сервера, а не с телефона покупателя: у Nominatim правило
   «не чаще раза в секунду и с подписью приложения». Сервер держит
   очередь и кэш, а если очередь длинная — спрашивает Photon.
   ========================================================== */

const UA = 'LuxeCanvas/1.0 (+https://luxecanvas.ru)';
const NOMINATIM = 'https://nominatim.openstreetmap.org';
const PHOTON = 'https://photon.komoot.io';

const DAY = 24 * 60 * 60 * 1000;
const CACHE_MAX = 4000;
const cache = new Map();

function remember(key, val, ttl) {
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
  cache.set(key, { val, exp: Date.now() + ttl });
}
function recall(key) {
  const hit = cache.get(key);
  return hit && hit.exp > Date.now() ? hit : null;
}

async function getJson(url, timeout = 6000) {
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, Accept: 'application/json', 'Accept-Language': 'ru' },
    signal: AbortSignal.timeout(timeout)
  });
  if (!res.ok) throw Object.assign(new Error('geo HTTP ' + res.status), { status: res.status });
  return res.json();
}

/* Очередь к Nominatim: между запросами не меньше 1,1 секунды. */
let nomNext = 0;
let nomWaiting = 0;
async function nominatim(path) {
  if (nomWaiting >= 4) throw new Error('nominatim busy');
  nomWaiting++;
  try {
    const wait = Math.max(0, nomNext - Date.now());
    nomNext = Math.max(nomNext, Date.now()) + 1100;
    if (wait) await new Promise((r) => setTimeout(r, wait));
    return await getJson(NOMINATIM + path);
  } finally {
    nomWaiting--;
  }
}

const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();

function place({ city, street, house, region, lat, lng }) {
  city = clean(city); street = clean(street); house = clean(house); region = clean(region);
  return {
    city, street, house, region,
    addr: street ? (house ? `${street}, ${house}` : street) : '',
    lat: +(+lat).toFixed(6), lng: +(+lng).toFixed(6)
  };
}

function fromNominatim(j, lat, lng) {
  const a = (j && j.address) || {};
  return place({
    city: a.city || a.town || a.village || a.hamlet || a.municipality || a.county,
    street: a.road || a.pedestrian || a.residential || a.footway || a.square || a.path,
    house: a.house_number,
    region: a.state,
    lat, lng
  });
}

function fromPhoton(f, lat, lng) {
  const p = (f && f.properties) || {};
  const c = (f && f.geometry && f.geometry.coordinates) || [];
  const isStreet = p.type === 'street' || p.osm_key === 'highway';
  return place({
    city: p.city || p.town || p.village || p.locality || p.county,
    street: p.street || (isStreet ? p.name : ''),
    house: p.housenumber,
    region: p.state,
    lat: c[1] != null ? c[1] : lat,
    lng: c[0] != null ? c[0] : lng
  });
}

/** Адрес точки: { city, street, house, region, addr, lat, lng } или null. */
async function reverse(lat, lng) {
  const key = 'r:' + (+lat).toFixed(5) + ',' + (+lng).toFixed(5);
  const hit = recall(key);
  if (hit) return hit.val;
  let out = null;
  try {
    const j = await nominatim(`/reverse?format=jsonv2&lat=${+lat}&lon=${+lng}&zoom=18&addressdetails=1&accept-language=ru`);
    out = fromNominatim(j, lat, lng);
  } catch (e) {
    console.warn('geo reverse nominatim:', e.message);
  }
  if (!out || (!out.street && !out.city)) {
    try {
      const j = await getJson(`${PHOTON}/reverse?lat=${+lat}&lon=${+lng}&limit=1&lang=default`);
      const f = j && Array.isArray(j.features) ? j.features[0] : null;
      if (f) out = Object.assign(fromPhoton(f, lat, lng), { lat: +(+lat).toFixed(6), lng: +(+lng).toFixed(6) });
    } catch (e) {
      console.warn('geo reverse photon:', e.message);
    }
  }
  if (out && (out.street || out.city)) {
    remember(key, out, DAY);
    return out;
  }
  return null;
}

/** Подсказки адреса по тексту — ближе к точке lat/lng, если она есть. */
async function search(q, { lat, lng } = {}) {
  const text = clean(q).slice(0, 120);
  if (text.length < 3) return [];
  const near = Number.isFinite(+lat) && Number.isFinite(+lng) && (+lat || +lng);
  const key = 's:' + text.toLowerCase() + (near ? '@' + (+lat).toFixed(1) + ',' + (+lng).toFixed(1) : '');
  const hit = recall(key);
  if (hit) return hit.val;
  const u = new URL(PHOTON + '/api/');
  u.searchParams.set('q', text);
  u.searchParams.set('limit', '10');
  u.searchParams.set('lang', 'default');
  ['house', 'street'].forEach((l) => u.searchParams.append('layer', l));
  if (near) {
    u.searchParams.set('lat', String(+lat));
    u.searchParams.set('lon', String(+lng));
  }
  const j = await getJson(u.toString());
  const seen = new Set();
  const list = (Array.isArray(j && j.features) ? j.features : [])
    .filter((f) => f && f.properties && f.properties.countrycode === 'RU')
    .map((f) => fromPhoton(f))
    .filter((p) => p.street && p.city)
    .filter((p) => {
      const k = [p.city, p.addr].join('|').toLowerCase();
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .slice(0, 6);
  remember(key, list, 60 * 60 * 1000);
  return list;
}

module.exports = { reverse, search };
