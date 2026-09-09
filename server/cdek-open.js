/* ==========================================================
   ОТКРЫТЫЙ СПРАВОЧНИК ПВЗ СДЭК

   У СДЭК есть два способа узнать пункты выдачи. Первый — API v2
   (server/cdek.js), он точнее и умеет считать тариф, но требует договор
   и ключи. Второй — вот этот: адрес integration.cdek.ru/pvzlist отдаёт
   весь список пунктов по стране без ключей и без регистрации.

   Мы держим оба. Пока ключей нет, карта в оформлении наполняется отсюда,
   и покупатель видит настоящие пункты с настоящими адресами и часами
   работы — а не пустую карту и просьбу вписать адрес руками.

   Список весь целиком — около 16 МБ и 9800 пунктов. Качаем его раз в
   сутки, разбираем (200 мс) и держим в памяти (3 МБ). После этого поиск
   ближайших к человеку — обычный перебор, 10 мс, без сети и без лимитов.
   Скачивать по городу на каждый запрос нельзя: чтобы узнать город, нужен
   тот же справочник.
   ========================================================== */

const fs = require('fs');
const path = require('path');

const URL_XML = process.env.CDEK_PVZLIST_URL
  || 'https://integration.cdek.ru/pvzlist/v1/xml?countryiso=RU&type=PVZ';

/* Тот же каталог, что у базы: на хостинге он может быть смонтирован отдельно. */
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const CACHE_FILE = path.join(DATA_DIR, 'pvz-cdek.json');

/* Сутки: сеть пунктов меняется на единицы точек в неделю, чаще незачем. */
const TTL_MS = 24 * 60 * 60 * 1000;
/* Файл младше этого срока считаем годным даже при неудачной закачке —
   лучше вчерашние адреса, чем пустая карта. */
const STALE_OK_MS = 30 * 24 * 60 * 60 * 1000;

let points = [];
let loadedAt = 0;
let loading = null;

const ENT = { quot: '"', apos: "'", lt: '<', gt: '>', amp: '&', nbsp: ' ' };
function unesc(s) {
  return String(s || '').replace(/&(quot|apos|lt|gt|amp|nbsp|#\d+);/g, (m, k) =>
    k[0] === '#' ? String.fromCharCode(+k.slice(1)) : (ENT[k] || m));
}

/** Точка в том же виде, что отдаёт API v2 — витрина не должна знать разницы. */
function fromXmlAttrs(a) {
  const lat = +a.coordY;
  const lng = +a.coordX;
  return {
    code: unesc(a.Code).trim(),
    name: unesc(a.Name).trim(),
    type: unesc(a.Type || 'PVZ').trim(),
    ownerCode: unesc(a.ownerCode).trim(),
    city: unesc(a.City).trim(),
    cityCode: +a.CityCode || 0,
    region: unesc(a.RegionName).trim(),
    addr: unesc(a.Address).trim(),
    addressComment: unesc(a.AddressComment).trim(),
    hours: unesc(a.WorkTime).trim(),
    workTimeList: [],
    lat,
    lng,
    phone: unesc(a.Phone).trim(),
    note: unesc(a.Note).trim(),
    haveCashless: a.HaveCashless === 'true',
    haveCash: a.HaveCash === 'true',
    allowedCod: a.AllowedCod === 'true',
    isHandout: a.IsHandout !== 'false',
    isReception: a.IsReception === 'true',
    isDressingRoom: a.IsDressingRoom === 'true',
    weightMin: 0,
    weightMax: 0
  };
}

function parseXml(xml) {
  const out = [];
  for (const m of String(xml).matchAll(/<Pvz\b([^>]*?)\/?>/g)) {
    const a = {};
    for (const p of m[1].matchAll(/([\w:]+)="([^"]*)"/g)) a[p[1]] = p[2];
    if (a.Status && a.Status !== 'ACTIVE') continue;
    const pt = fromXmlAttrs(a);
    /* Пункт без координат нельзя поставить на карту, без адреса — нельзя
       положить в заказ. Такие пропускаем молча: их единицы. */
    if (!pt.code || !pt.addr) continue;
    if (!Number.isFinite(pt.lat) || !Number.isFinite(pt.lng)) continue;
    if (!pt.lat && !pt.lng) continue;
    out.push(pt);
  }
  return out;
}

function readCache() {
  try {
    const raw = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    if (!Array.isArray(raw.points) || !raw.points.length) return null;
    return { ts: +raw.ts || 0, points: raw.points };
  } catch (_) { return null; }
}

function writeCache() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(CACHE_FILE, JSON.stringify({ ts: loadedAt, points }));
  } catch (e) {
    console.warn('пвз: не удалось сохранить кэш —', e.message);
  }
}

async function download() {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), 90000);
  if (typeof t.unref === 'function') t.unref();
  try {
    const res = await fetch(URL_XML, {
      signal: ac.signal,
      /* Только User-Agent и только латиницей: кириллицу в заголовке fetch не
         пропустит, а на заголовок Accept этот адрес отвечает 400. */
      headers: { 'User-Agent': 'Canvas-Shop/1.0' }
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const xml = await res.text();
    const list = parseXml(xml);
    if (list.length < 500) throw new Error('подозрительно мало пунктов: ' + list.length);
    return list;
  } finally {
    clearTimeout(t);
  }
}

/** Обновляет список. Никогда не выбрасывает: старые данные лучше никаких. */
async function refresh(force = false) {
  if (loading) return loading;
  if (!force && points.length && Date.now() - loadedAt < TTL_MS) return points;

  loading = (async () => {
    try {
      const list = await download();
      points = list;
      loadedAt = Date.now();
      writeCache();
      console.log(`ПВЗ СДЭК: загружено ${points.length} пунктов (открытый справочник)`);
    } catch (e) {
      console.warn('ПВЗ СДЭК: обновить не удалось —', e.message);
      /* Если в памяти пусто, а на диске есть даже старый файл — берём его.
         Просроченный адрес пункта всё равно полезнее пустой карты. */
      if (!points.length) {
        const c = readCache();
        if (c && Date.now() - c.ts < STALE_OK_MS) {
          points = c.points;
          loadedAt = c.ts;
          console.log(`ПВЗ СДЭК: работаем на кэше от ${new Date(c.ts).toLocaleString('ru')}`);
        }
      }
    } finally {
      loading = null;
    }
    return points;
  })();

  return loading;
}

/** Старт сервера не ждёт закачку: сначала диск, сеть — фоном. */
function boot() {
  const c = readCache();
  if (c) {
    points = c.points;
    loadedAt = c.ts;
    console.log(`ПВЗ СДЭК: ${points.length} пунктов из кэша`);
  }
  refresh().catch(() => {});
  const timer = setInterval(() => refresh().catch(() => {}), TTL_MS);
  if (typeof timer.unref === 'function') timer.unref();
}

function ready() { return points.length > 0; }
function count() { return points.length; }

function distanceKm(a, b) {
  const R = 6371;
  const rad = (d) => d * Math.PI / 180;
  const dLat = rad(+b.lat - +a.lat);
  const dLng = rad(+b.lng - +a.lng);
  const x = Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(+a.lat)) * Math.cos(rad(+b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}

const norm = (s) => String(s || '').toLowerCase().replace(/ё/g, 'е').trim();

/** Города собираем из самих пунктов: отдельного справочника у нас нет. */
function cityIndex() {
  const map = new Map();
  for (const p of points) {
    if (!p.cityCode || !p.city) continue;
    let c = map.get(p.cityCode);
    if (!c) {
      c = { code: p.cityCode, city: p.city, region: p.region, country: 'Россия', countryCode: 'RU', lat: 0, lng: 0, n: 0 };
      map.set(p.cityCode, c);
    }
    /* Координата города — среднее по его пунктам: своей у нас нет,
       а для «покажи мне этот город на карте» такой точности хватает. */
    c.lat += p.lat; c.lng += p.lng; c.n++;
  }
  const out = [];
  for (const c of map.values()) {
    out.push({ ...c, lat: c.lat / c.n, lng: c.lng / c.n, points: c.n });
  }
  return out;
}

let citiesCache = null;
let citiesFor = 0;
function cities() {
  if (!citiesCache || citiesFor !== loadedAt) {
    citiesCache = cityIndex();
    citiesFor = loadedAt;
  }
  return citiesCache;
}

function searchCities(q, { lat, lng } = {}) {
  const needle = norm(q);
  const hasGeo = Number.isFinite(+lat) && Number.isFinite(+lng) && (+lat || +lng);
  let list = cities();

  if (needle.length >= 2) {
    /* Совпадение с начала названия важнее совпадения в середине:
       по запросу «моск» первым должна идти Москва, а не Новомосковск. */
    list = list
      .filter((c) => norm(c.city).includes(needle))
      .sort((a, b) => {
        const sa = norm(a.city).startsWith(needle) ? 0 : 1;
        const sb = norm(b.city).startsWith(needle) ? 0 : 1;
        return sa - sb || b.points - a.points;
      });
  } else if (hasGeo) {
    const me = { lat: +lat, lng: +lng };
    list = list
      .map((c) => ({ ...c, km: distanceKm(me, c) }))
      .sort((a, b) => a.km - b.km);
  } else {
    return [];
  }

  return list.slice(0, 12).map((c) => ({
    code: c.code, city: c.city, region: c.region,
    country: c.country, countryCode: c.countryCode,
    fiasGuid: '', lat: c.lat, lng: c.lng,
    km: c.km != null ? c.km : undefined
  }));
}

function deliveryPoints({ cityCode, lat, lng, q, limit = 80 } = {}) {
  const city = +cityCode || 0;
  const hasGeo = Number.isFinite(+lat) && Number.isFinite(+lng) && (+lat || +lng);
  let list = points;

  if (city) list = list.filter((p) => p.cityCode === city);

  const needle = norm(q);
  if (needle) {
    list = list.filter((p) =>
      [p.city, p.addr, p.name, p.code].some((v) => norm(v).includes(needle)));
  }

  if (hasGeo) {
    const me = { lat: +lat, lng: +lng };
    /* Без города по всей стране перебирать все 9800 точек ради сортировки
       расточительно: сначала грубо отсекаем по квадрату вокруг человека
       и только выжившие считаем по-настоящему. */
    if (!city) {
      const box = 1.2;                        // ~130 км по широте
      const near = list.filter((p) =>
        Math.abs(p.lat - me.lat) < box &&
        Math.abs(p.lng - me.lng) < box / Math.max(0.2, Math.cos(me.lat * Math.PI / 180)));
      if (near.length) list = near;
    }
    list = list.map((p) => ({ ...p, km: distanceKm(me, p) })).sort((a, b) => a.km - b.km);
  } else {
    list = [...list].sort((a, b) => String(a.addr).localeCompare(String(b.addr), 'ru'));
  }

  return list.slice(0, Math.max(1, Math.min(+limit || 80, 200)));
}

/** Город по координатам — для тарифа курьера, когда человек нажал «я здесь». */
function cityAt({ lat, lng }) {
  const near = deliveryPoints({ lat, lng, limit: 1 });
  return near[0] ? { code: near[0].cityCode, city: near[0].city, region: near[0].region } : null;
}

module.exports = {
  boot, refresh, ready, count,
  searchCities, deliveryPoints, cities, cityAt, distanceKm
};
