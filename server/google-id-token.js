/**
 * Проверка ID-токена Google (Google Identity Services).
 *
 * Зачем отдельно от google-auth.js: классический OAuth требует секретный
 * ключ приложения на сервере. Здесь он не нужен вообще — браузер получает
 * от Google подписанный ID-токен, а сервер проверяет подпись публичными
 * ключами Google. Секрета в проекте не появляется, а вход работает так же.
 *
 * Что проверяем (без этого токен ничего не стоит):
 *   - подпись RS256 ключом из https://www.googleapis.com/oauth2/v3/certs;
 *   - aud === наш GOOGLE_CLIENT_ID (иначе подойдёт токен чужого сайта);
 *   - iss — действительно Google;
 *   - срок годности ещё не вышел.
 */
const crypto = require('crypto');

const CERTS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
const ISSUERS = ['accounts.google.com', 'https://accounts.google.com'];
/* небольшой запас на расхождение часов сервера и Google */
const CLOCK_SKEW_SEC = 120;

let certsCache = { keys: null, until: 0 };

function clientId() {
  return String(process.env.GOOGLE_CLIENT_ID || '').trim();
}

function configured() {
  return !!clientId();
}

/** Публичные ключи Google. Держим в памяти на час — они меняются редко. */
async function googleKeys() {
  if (certsCache.keys && Date.now() < certsCache.until) return certsCache.keys;
  const r = await fetch(CERTS_URL);
  if (!r.ok) throw Object.assign(new Error('Не получить ключи Google'), { status: 502 });
  const data = await r.json();
  const keys = Array.isArray(data.keys) ? data.keys : [];
  if (!keys.length) throw Object.assign(new Error('Google вернул пустой список ключей'), { status: 502 });
  /* Cache-Control от Google подсказывает, сколько ключи живут */
  const cc = String(r.headers.get('cache-control') || '');
  const m = /max-age=(\d+)/i.exec(cc);
  const ttl = m ? Math.min(+m[1], 3600) : 3600;
  certsCache = { keys, until: Date.now() + ttl * 1000 };
  return keys;
}

function b64urlToBuf(s) {
  return Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

function decodePart(s) {
  try { return JSON.parse(b64urlToBuf(s).toString('utf8')); }
  catch (_) { return null; }
}

/**
 * @returns {{googleId, email, name, last, emailVerified}}
 */
async function verifyIdToken(idToken) {
  if (!configured()) {
    throw Object.assign(new Error('Google вход не настроен (GOOGLE_CLIENT_ID)'), { status: 503 });
  }
  const parts = String(idToken || '').split('.');
  if (parts.length !== 3) {
    throw Object.assign(new Error('Некорректный токен Google'), { status: 400 });
  }
  const [h, p, sig] = parts;
  const header = decodePart(h);
  const payload = decodePart(p);
  if (!header || !payload) {
    throw Object.assign(new Error('Не разобрать токен Google'), { status: 400 });
  }
  if (header.alg !== 'RS256') {
    throw Object.assign(new Error('Неожиданный алгоритм подписи'), { status: 400 });
  }

  const keys = await googleKeys();
  const jwk = keys.find((k) => k.kid === header.kid);
  if (!jwk) {
    /* ключ могли только что заменить — сбрасываем кэш и пробуем ещё раз */
    certsCache = { keys: null, until: 0 };
    const fresh = await googleKeys();
    const again = fresh.find((k) => k.kid === header.kid);
    if (!again) throw Object.assign(new Error('Ключ подписи Google не найден'), { status: 401 });
    return verifyWith(again, h, p, sig, payload);
  }
  return verifyWith(jwk, h, p, sig, payload);
}

function verifyWith(jwk, h, p, sig, payload) {
  const key = crypto.createPublicKey({ key: jwk, format: 'jwk' });
  const ok = crypto.verify(
    'RSA-SHA256',
    Buffer.from(h + '.' + p),
    key,
    b64urlToBuf(sig)
  );
  if (!ok) throw Object.assign(new Error('Подпись Google не сошлась'), { status: 401 });

  if (payload.aud !== clientId()) {
    throw Object.assign(new Error('Токен выдан для другого приложения'), { status: 401 });
  }
  if (!ISSUERS.includes(String(payload.iss))) {
    throw Object.assign(new Error('Токен не от Google'), { status: 401 });
  }
  const now = Math.floor(Date.now() / 1000);
  if (!payload.exp || now > +payload.exp + CLOCK_SKEW_SEC) {
    throw Object.assign(new Error('Токен Google истёк'), { status: 401 });
  }
  if (payload.nbf && now + CLOCK_SKEW_SEC < +payload.nbf) {
    throw Object.assign(new Error('Токен Google ещё не действует'), { status: 401 });
  }
  if (!payload.sub) {
    throw Object.assign(new Error('В токене нет идентификатора'), { status: 401 });
  }

  return {
    googleId: String(payload.sub),
    email: String(payload.email || '').trim().toLowerCase(),
    name: String(payload.given_name || payload.name || '').trim(),
    last: String(payload.family_name || '').trim(),
    emailVerified: payload.email_verified !== false
  };
}

module.exports = { configured, verifyIdToken, clientId };
