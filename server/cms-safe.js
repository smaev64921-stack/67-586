/** Публичное CMS без секретов. Ключи AI только в process.env. */

/* Тот же шаблон, что в video.js; не импортируем его, чтобы проверка CMS не
   тянула за собой создание папок на диске. */
const RE_VIDEO_URL = /^\/media\/v\/[0-9a-f]{16}\.(mp4|webm)$/;
/* Сколько роликов можно поставить в каталог. Совпадает с MAX_CAT_VIDS в index.html. */
const MAX_CAT_VIDS = 12;
/* Знакомство, 3 слайд: квадраты плитки и сколько фото в каждом. Совпадает
   с ONB3_TILES / ONB3_MAX в index.html. */
const ONB3_TILES = ['s1', 'l1', 's2', 'l2', 's3', 's4'];
const ONB3_MAX = 6;
/* Своё фото (уже base64 — ссылки /media/cms/… восстановлены до проверки)
   или встроенный кадр сайта. Чужие адреса на знакомство не пускаем. */
const RE_ONB_IMG = /^(data:image\/(jpeg|png|webp);base64,|\/onboarding\/[a-z0-9-]+\.(webp|jpe?g|png)$)/;

function tryonServerConfigured() {
  /* Реальная примерка — только через свой эндпоинт (фото уходят туда). */
  return !!String(process.env.TRYON_API_URL || '').trim();
}

function sanitizeTryon(tryon) {
  const t = tryon && typeof tryon === 'object' ? tryon : {};
  return {
    enabled: t.enabled === true,
    maxSide: +t.maxSide || 1280,
    serverConfigured: tryonServerConfigured()
  };
}

function sanitizeCms(cms) {
  if (!cms || typeof cms !== 'object') return cms;
  const out = JSON.parse(JSON.stringify(cms));
  out.tryon = sanitizeTryon(out.tryon);
  /* Витрине надо знать заранее, считает ли сервер доставку по тарифу СДЭК:
     тогда до выбора пункта она пишет «по тарифу СДЭК», а не базовую цену. */
  if (out.shipping && typeof out.shipping === 'object') {
    out.shipping.live = require('./ship-live').enabled(out.shipping);
    out.shipping.liveKeys = require('./cdek').configured();
  }
  return out;
}

/** Перед сохранением CMS с клиента — выкинуть любые секреты. */
function scrubCmsInput(cms) {
  if (!cms || typeof cms !== 'object') return cms;
  const out = JSON.parse(JSON.stringify(cms));
  if (out.tryon && typeof out.tryon === 'object') {
    out.tryon = {
      enabled: out.tryon.enabled === true,
      maxSide: +out.tryon.maxSide || 1280
    };
  }
  /* live вычисляется при каждой отдаче — в базе ему лежать незачем */
  if (out.shipping && typeof out.shipping === 'object') {
    delete out.shipping.live;
    delete out.shipping.liveKeys;
  }
  /* Видео-слайд: в поле video допускаем только ссылку на наш же файл
     /media/v/<хэш>.mp4|webm. Иначе через CMS на витрину можно было бы
     подставить чужой адрес, и каждый покупатель качал бы ролик оттуда. */
  if (Array.isArray(out.slides)) {
    out.slides.forEach((s) => {
      if (!s || typeof s !== 'object') return;
      if (s.video != null && !RE_VIDEO_URL.test(String(s.video))) delete s.video;
      ['vw', 'vh', 'dur', 'size'].forEach((k) => {
        if (s[k] == null) return;
        const n = +s[k];
        if (Number.isFinite(n) && n >= 0) s[k] = n;
        else delete s[k];
      });
    });
  }
  /* Видео каталога: тот же допуск ссылок, что у видео-слайда, и не больше
     MAX_CAT_VIDS роликов — каждый покупатель качает их целиком. */
  if (out.vids != null) {
    out.vids = (Array.isArray(out.vids) ? out.vids : [])
      .filter((v) => v && typeof v === 'object' && RE_VIDEO_URL.test(String(v.video || '')))
      .slice(0, MAX_CAT_VIDS);
    out.vids.forEach((v) => {
      ['id', 'vw', 'vh', 'dur', 'size'].forEach((k) => {
        if (v[k] == null) return;
        const n = +v[k];
        if (Number.isFinite(n) && n >= 0) v[k] = n;
        else delete v[k];
      });
      /* Товар для кнопки «Перейти» под роликом — только номер товара.
         Нет товара (0, пусто, мусор) — поля нет, и кнопки у ролика нет. */
      if (v.pid != null) {
        const n = +v.pid;
        if (Number.isSafeInteger(n) && n > 0) v.pid = n;
        else delete v.pid;
      }
    });
  }
  /* Знакомство: фото квадратов третьего слайда — только свои картинки, до
     ONB3_MAX в квадрате. Пустой квадрат на знакомстве показывает встроенные. */
  if (out.onb != null) {
    const o = out.onb && typeof out.onb === 'object' ? out.onb : {};
    const clean = {};
    if (o.s3 && typeof o.s3 === 'object') {
      clean.s3 = {};
      ONB3_TILES.forEach((k) => {
        const list = Array.isArray(o.s3[k]) ? o.s3[k] : [];
        clean.s3[k] = list.filter((x) => typeof x === 'string' && RE_ONB_IMG.test(x)).slice(0, ONB3_MAX);
      });
    }
    out.onb = clean;
  }
  if (out.sizeCharts != null) out.sizeCharts = cleanSizeCharts(out.sizeCharts);
  return out;
}

/* Таблицы размеров (админка → «Размеры»). У каждой — название, размеры
   (колонки), строки замеров, примечание и товары, в карточках которых она
   открывается. Всё — короткие строки без управляющих символов; товар может
   быть только в одной таблице (первая выигрывает), id таблиц не повторяются.
   Пределы совпадают с SZ_LIMITS в index.html. */
const SZ_LIMITS = { charts: 40, sizes: 12, rows: 16, title: 60, label: 60, val: 20, note: 300, size: 12 };
function szStr(v, max) {
  return String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}
function cleanSizeCharts(list) {
  const usedPid = new Set();
  const usedId = new Set();
  return (Array.isArray(list) ? list : [])
    .filter((t) => t && typeof t === 'object')
    .map((t) => {
      const id = +t.id;
      if (!Number.isSafeInteger(id) || id <= 0 || usedId.has(id)) return null;
      usedId.add(id);
      const sizes = (Array.isArray(t.sizes) ? t.sizes : [])
        .map((s) => szStr(s, SZ_LIMITS.size)).filter(Boolean).slice(0, SZ_LIMITS.sizes);
      const rows = (Array.isArray(t.rows) ? t.rows : [])
        .filter((r) => r && typeof r === 'object')
        .map((r) => ({
          label: szStr(r.label, SZ_LIMITS.label),
          vals: sizes.map((_, i) => szStr(Array.isArray(r.vals) ? r.vals[i] : '', SZ_LIMITS.val))
        }))
        .filter((r) => r.label)
        .slice(0, SZ_LIMITS.rows);
      const pids = [];
      (Array.isArray(t.pids) ? t.pids : []).forEach((x) => {
        const n = +x;
        if (Number.isSafeInteger(n) && n > 0 && !usedPid.has(n)) { usedPid.add(n); pids.push(n); }
      });
      return { id, title: szStr(t.title, SZ_LIMITS.title), note: szStr(t.note, SZ_LIMITS.note), sizes, rows, pids };
    })
    .filter(Boolean)
    .slice(0, SZ_LIMITS.charts);
}

/**
 * Видео с главной переехали в каталог (2026-10-03): ролики из slides
 * переносим в vids, в конец, без повторов по ссылке. Меняет cms на месте,
 * возвращает число перенесённых. Нужна и при запуске (старые данные), и при
 * сохранении: вкладка админки, открытая до обновления, по-прежнему кладёт
 * новое видео в слайды главной.
 */
function moveVideoSlides(cms) {
  if (!cms || typeof cms !== 'object' || !Array.isArray(cms.slides)) return 0;
  const moved = cms.slides.filter((s) => s && typeof s === 'object' && s.video != null);
  if (!moved.length) return 0;
  cms.slides = cms.slides.filter((s) => !moved.includes(s));
  const vids = Array.isArray(cms.vids) ? cms.vids.slice() : [];
  const have = new Set(vids.map((v) => v && v.video));
  moved.forEach((s) => {
    if (!RE_VIDEO_URL.test(String(s.video)) || have.has(s.video)) return;
    have.add(s.video);
    const v = { id: +s.id || Date.now(), video: s.video, img: s.img || '' };
    ['vw', 'vh', 'dur', 'size'].forEach((k) => { if (s[k] != null) v[k] = s[k]; });
    vids.push(v);
  });
  cms.vids = vids.slice(0, MAX_CAT_VIDS);
  return moved.length;
}

module.exports = {
  sanitizeCms,
  scrubCmsInput,
  moveVideoSlides,
  MAX_CAT_VIDS,
  sanitizeTryon,
  tryonServerConfigured
};
