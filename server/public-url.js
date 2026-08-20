/**
 * Публичный HTTPS-адрес магазина.
 * На Bothost/Render — только реальный домен с точкой (example.com, xxx.onrender.com).
 * «luxecanvas» без TLD → невалидно, Telegram такие URL отклоняет.
 */
function strip(u) {
  return String(u || '').trim().replace(/\/$/, '');
}

function isLocal(u) {
  return !u || /localhost|127\.0\.0\.1/i.test(u);
}

/** Hostname с точкой (TLD или поддомен). Без точки Telegram даёт Wrong HTTP URL. */
function hostLooksPublic(host) {
  const h = String(host || '').toLowerCase();
  if (!h || isLocal(h)) return false;
  if (!h.includes('.')) return false;
  if (/\s/.test(h)) return false;
  return true;
}

function isValidPublicHttps(u) {
  const s = strip(u);
  if (!s || !/^https:\/\//i.test(s)) return false;
  try {
    const url = new URL(s);
    if (url.protocol !== 'https:') return false;
    return hostLooksPublic(url.hostname);
  } catch (_) {
    return false;
  }
}

function fromWebhookUrl(wh) {
  const s = strip(wh);
  if (!s) return '';
  try {
    const url = new URL(s);
    if (url.protocol !== 'https:') return '';
    if (!hostLooksPublic(url.hostname)) return '';
    return url.origin;
  } catch (_) {
    const m = s.match(/^(https:\/\/[^/\s]+)/i);
    return m && isValidPublicHttps(m[1]) ? m[1] : '';
  }
}

function fromDomain(domain) {
  const raw = strip(domain);
  if (!raw) return '';
  const d = raw.replace(/^https?:\/\//i, '').replace(/\/.*$/, '');
  if (!d || isLocal(d) || !hostLooksPublic(d)) return '';
  return `https://${d}`;
}

function resolvePublicUrl(port = 3000) {
  /* localhost в .env не должен перекрывать DOMAIN на Bothost/Render */
  const rawPublic = strip(process.env.PUBLIC_URL);
  const publicCandidate = isLocal(rawPublic) ? '' : rawPublic;

  const candidates = [
    publicCandidate,
    strip(process.env.TELEGRAM_SHOP_URL),
    fromDomain(process.env.DOMAIN),
    fromWebhookUrl(process.env.WEBHOOK_URL)
  ]
    .map((u) => {
      if (!u) return '';
      if (/^https:\/\//i.test(u)) return u.replace(/\/$/, '');
      if (/^http:\/\//i.test(u) && isLocal(u)) return '';
      if (hostLooksPublic(u.replace(/^https?:\/\//i, '').split('/')[0])) {
        if (/^https?:\/\//i.test(u)) {
          try {
            const url = new URL(u);
            if (url.protocol === 'https:' && hostLooksPublic(url.hostname)) {
              return url.origin;
            }
          } catch (_) {}
          return '';
        }
        return `https://${u.replace(/\/$/, '')}`;
      }
      return '';
    })
    .filter((u) => isValidPublicHttps(u));

  if (candidates[0]) return candidates[0];

  return `http://localhost:${port}`;
}

function logPublicUrlDebug(resolved) {
  console.log('Public URL resolve:', {
    resolved,
    PUBLIC_URL: process.env.PUBLIC_URL || '(нет)',
    DOMAIN: process.env.DOMAIN || '(нет)',
    WEBHOOK_URL: process.env.WEBHOOK_URL || '(нет)',
    valid: isValidPublicHttps(resolved)
  });
  if (!isValidPublicHttps(resolved)) {
    console.warn(
      'Нет валидного PUBLIC_URL для кнопок Telegram.\n' +
      'Нужен полный HTTPS-домен, например:\n' +
      '  PUBLIC_URL=https://luxecanvas.onrender.com\n' +
      'Сейчас DOMAIN/PUBLIC_URL без точки (типа «luxecanvas») — Telegram отклоняет как Wrong HTTP URL.\n' +
      'Укажи реальный адрес сайта в панели хостинга и Redeploy.'
    );
    try {
      require('./auth-log').authLog('public_url_error', { where: 'resolve', resolved });
    } catch (_) {}
  }
}

module.exports = {
  resolvePublicUrl,
  isLocal,
  isValidPublicHttps,
  logPublicUrlDebug
};
