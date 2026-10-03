/* ==========================================================
   ЦЕНА ДОСТАВКИ ПО ТАРИФУ СДЭК

   Магазин сдаёт посылки в Екатеринбурге, покупатель забирает их в пункте
   выдачи своего города (или ждёт курьера). Фиксированные 190 ₽ одинаковы
   для соседней улицы и для Владивостока — здесь вместо них спрашиваем
   калькулятор СДЭК: от нашего города до города пункта, с весом заказа.

   Работает, только когда у сервера есть ключи API СДЭК (CDEK_CLIENT_ID и
   CDEK_CLIENT_SECRET). Без ключей, при сбое СДЭК или для города, который
   не нашёлся в справочнике, остаётся прежний расчёт — зоны и базовый
   тариф из админки: заказ не должен срываться из-за чужого сервера.
   ========================================================== */

const cdek = require('./cdek');
const dir = require('./cdek-open');
const { cityQuery, norm } = require('./city-query');

/* Код города СДЭК, откуда уходят посылки. 250 — Екатеринбург. */
const FROM_CITY = () => +process.env.CDEK_FROM_CITY_CODE || 250;
/* 136 — «Посылка склад-склад»: сдаём в отделении, забирают в пункте.
   137 — «Посылка склад-дверь»: сдаём в отделении, везёт курьер. */
const TARIFF = { pickup: 136, courier: 137 };

const ITEM_WEIGHT = 300;   // г: футболка с пакетом
const PACK_WEIGHT = 50;    // г: сама упаковка заказа
const TTL = 6 * 60 * 60 * 1000;
const FAIL_TTL = 2 * 60 * 1000;
const CACHE_MAX = 5000;

const cache = new Map();
const inflight = new Map();

function enabled(shipping) {
  return cdek.configured() && !(shipping && shipping.cdekOff === true);
}

function itemWeight(shipping) {
  const w = Math.round(+(shipping && shipping.itemWeight));
  return Number.isFinite(w) && w >= 50 && w <= 5000 ? w : ITEM_WEIGHT;
}

/* Сложенные вещи в пакете 30×25 см, каждая добавляет ~3 см толщины.
   СДЭК берёт деньги за больший из весов — настоящий или объёмный
   (Д×Ш×В/5000), поэтому размеры нужны не меньше, чем вес. */
function parcel(qty, shipping) {
  const n = Math.max(1, Math.min(99, Math.round(+qty || 1)));
  return [{
    weight: n * itemWeight(shipping) + PACK_WEIGHT,
    length: 30,
    width: 25,
    height: Math.min(60, 3 * n)
  }];
}

/** Код города СДЭК по названию — для курьера и адреса, вписанного руками. */
function cityCodeByName(city, region) {
  const name = norm(cityQuery(city));
  if (name.length < 2) return 0;
  let list;
  try { list = dir.cities().filter((c) => norm(c.city) === name); } catch (_) { return 0; }
  if (!list.length) return 0;
  const reg = norm(region);
  if (reg) {
    const same = list.find((c) => {
      const r = norm(c.region);
      return r && (r === reg || r.includes(reg) || reg.includes(r));
    });
    if (same) return same.code;
  }
  /* Тёзки в разных областях: без подсказки берём крупный — у него больше пунктов. */
  return list.slice().sort((a, b) => b.points - a.points)[0].code;
}

function remember(key, val, ttl) {
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
  cache.set(key, { val, exp: Date.now() + ttl });
}

function plural(n, forms) {
  const a = Math.abs(n) % 100;
  const b = a % 10;
  if (a > 10 && a < 20) return forms[2];
  if (b > 1 && b < 5) return forms[1];
  if (b === 1) return forms[0];
  return forms[2];
}

function daysText(min, max) {
  const lo = Math.max(0, Math.round(+min || 0));
  const hi = Math.max(lo, Math.round(+max || 0));
  if (!hi) return '';
  const word = plural(hi, ['день', 'дня', 'дней']);
  return lo && lo !== hi ? `${lo}–${hi} ${word}` : `${hi} ${word}`;
}

/**
 * Цена СДЭК для заказа: { cost, days, tariff } или null, если считать
 * не по чему или СДЭК не ответил. Ответы держим 6 часов: тарифы меняются
 * редко, а покупатель тычет в пункты одного города десятки раз.
 */
async function liveQuote({ mode, cityCode, qty, shipping } = {}) {
  const to = +cityCode || 0;
  if (!to || !enabled(shipping)) return null;
  const kind = mode === 'courier' ? 'courier' : 'pickup';
  const packages = parcel(qty, shipping);
  const key = [kind, FROM_CITY(), to, packages[0].weight, packages[0].height].join(':');

  const hit = cache.get(key);
  let res;
  if (hit && hit.exp > Date.now()) {
    res = hit.val;
  } else {
    if (!inflight.has(key)) {
      inflight.set(key, cdek.calcTariff({
        fromCode: FROM_CITY(), toCode: to, tariffCode: TARIFF[kind], packages
      }).then((r) => {
        remember(key, r, TTL);
        return r;
      }, (e) => {
        console.warn('СДЭК тариф', key, '—', e && e.message);
        remember(key, null, FAIL_TTL);
        return null;
      }).finally(() => inflight.delete(key)));
    }
    res = await inflight.get(key);
  }
  if (!res) return null;

  /* Наценка (упаковка, дорога до отделения) — после кэша: поменяли её
     в админке — новая цена сразу, без ожидания шести часов. */
  const markup = Math.max(0, Math.round(+(shipping && shipping.cdekMarkup) || 0));
  return {
    cost: Math.ceil(res.sum) + markup,
    days: daysText(res.periodMin, res.periodMax),
    tariff: res.tariff
  };
}

module.exports = { enabled, liveQuote, cityCodeByName, parcel, daysText };
