/** Публичное CMS без секретов. Ключи AI только в process.env. */

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
  return out;
}

module.exports = {
  sanitizeCms,
  scrubCmsInput,
  sanitizeTryon,
  tryonServerConfigured
};
