/** Публичное CMS без секретов. Ключи AI только в process.env. */

/* Тот же шаблон, что в video.js; не импортируем его, чтобы проверка CMS не
   тянула за собой создание папок на диске. */
const RE_VIDEO_URL = /^\/media\/v\/[0-9a-f]{16}\.(mp4|webm)$/;
/* Сколько роликов можно поставить в каталог. Совпадает с MAX_CAT_VIDS в index.html. */
const MAX_CAT_VIDS = 12;

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
    });
  }
  return out;
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
