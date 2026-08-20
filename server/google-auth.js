/**
 * Google OAuth 2.0 (authorization code).
 * Нужны GOOGLE_CLIENT_ID + GOOGLE_CLIENT_SECRET.
 */
const { resolvePublicUrl } = require('./public-url');

function clientId() {
  return String(process.env.GOOGLE_CLIENT_ID || '').trim();
}
function clientSecret() {
  return String(process.env.GOOGLE_CLIENT_SECRET || '').trim();
}

function configured() {
  return !!(clientId() && clientSecret() && !/^change/i.test(clientId()));
}

function redirectUri() {
  const base = (resolvePublicUrl(process.env.PORT || 3000) || '').replace(/\/$/, '');
  const forced = String(process.env.GOOGLE_REDIRECT_URI || '').trim();
  if (forced) return forced.replace(/\/$/, '');
  return `${base}/api/auth/google/callback`;
}

function authUrl(state) {
  if (!configured()) {
    throw Object.assign(new Error('Google вход не настроен (GOOGLE_CLIENT_ID / SECRET)'), { status: 503 });
  }
  const u = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  u.searchParams.set('client_id', clientId());
  u.searchParams.set('redirect_uri', redirectUri());
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('scope', 'openid email profile');
  u.searchParams.set('access_type', 'online');
  u.searchParams.set('prompt', 'select_account');
  if (state) u.searchParams.set('state', state);
  return u.toString();
}

async function exchangeCode(code) {
  if (!configured()) {
    throw Object.assign(new Error('Google вход не настроен'), { status: 503 });
  }
  const body = new URLSearchParams({
    code: String(code || ''),
    client_id: clientId(),
    client_secret: clientSecret(),
    redirect_uri: redirectUri(),
    grant_type: 'authorization_code'
  });
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok || !data.access_token) {
    throw Object.assign(new Error(data.error_description || data.error || 'Google token error'), { status: 502 });
  }
  return data;
}

async function fetchProfile(accessToken) {
  const r = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
    headers: { Authorization: 'Bearer ' + accessToken }
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok || !data.sub) {
    throw Object.assign(new Error('Не удалось получить профиль Google'), { status: 502 });
  }
  return {
    googleId: String(data.sub),
    email: String(data.email || '').trim().toLowerCase(),
    name: String(data.given_name || data.name || '').trim(),
    last: String(data.family_name || '').trim(),
    emailVerified: !!data.email_verified
  };
}

module.exports = {
  configured,
  authUrl,
  exchangeCode,
  fetchProfile,
  redirectUri,
  clientId
};
