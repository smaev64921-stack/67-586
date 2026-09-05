require('dotenv').config();
const path = require('path');
const express = require('express');
const cors = require('cors');
const { seedIfEmpty, defaultCms } = require('./seed');
const { db } = require('./db');
const {
  register, login, signUser, publicUser,
  authOptional, authRequired, adminRequired,
  setAuthCookie, clearAuthCookie,
  redeemTgAdminToken, redeemTgPhoneToken, upsertUserByPhone, updateProfile,
  upsertGoogleUser, linkOwnerChat
} = require('./auth');
const googleAuth = require('./google-auth');
const googleIdToken = require('./google-id-token');
const userPrefs = require('./user-prefs');
const {
  requestPasswordReset, resetPassword, smtpConfigured,
  openResetLink, revealCode, issueTicket, checkTicket
} = require('./password-reset');
const {
  listProducts, getProduct, upsertProduct, deleteProduct, getRev
} = require('./products');
const {
  createCheckout, handleWebhook, syncPaymentStatus, ensurePayment,
  listOrdersForUser, listAllOrders, getOrderByNum, updateOrderAdmin,
  cancelOrderBuyer, requestReturnBuyer,
  claimOrdersForUser, getCms, saveCms, toPublicOrder, canAccessOrder,
  expireUnpaidOrders, syncCdekOrderStatuses
} = require('./orders');
const yookassa = require('./yookassa');
const { sanitizeCms, scrubCmsInput, tryonServerConfigured } = require('./cms-safe');
const { runTryon } = require('./tryon');
const telegramBot = require('./telegram-bot');
const { resolvePublicUrl, logPublicUrlDebug, isValidPublicHttps, isLocal } = require('./public-url');
const { authLog } = require('./auth-log');
const errors = require('./error-report');
/* Ставим ловушки до всего остального: ошибка при запуске тоже должна дойти. */
errors.installProcessHooks();
errors.installConsoleHook();
const { startBackupSchedule } = require('./backup');
const { hit, clientIp } = require('./rate-limit');
const cdek = require('./cdek');
const reviews = require('./reviews');
const media = require('./media');
const { jsonCompression, serveTextFile } = require('./compress');

seedIfEmpty();

/* Старые «Ожидает оплаты» без ЮKassa — это не оплата, а принятый заказ */
(() => {
  try {
    if (yookassa.configured()) return;
    const info = db.prepare(`
      UPDATE orders
      SET status = 'В обработке',
          pay_status = 'manual',
          pay_name = CASE WHEN pay_name = 'ЮKassa' THEN 'Без онлайн-оплаты' ELSE pay_name END,
          step_now = CASE WHEN step_now < 2 THEN 2 ELSE step_now END,
          updated_at = datetime('now')
      WHERE status = 'Ожидает оплаты'
        AND pay_status = 'pending'
        AND (yookassa_id IS NULL OR yookassa_id = '')
    `).run();
    if (info.changes) console.log('Fixed unpaid-looking orders without ЮKassa:', info.changes);
  } catch (e) {
    console.warn('order status migrate:', e.message);
  }
})();

/* Убрать ключи из старых записей CMS в БД */
(() => {
  try {
    const cms = getCms();
    if (cms && cms.tryon && (cms.tryon.apiKey || cms.tryon.apiUrl)) {
      saveCms(scrubCmsInput(cms));
      console.log('Scrubbed tryon secrets from CMS store');
    }
  } catch (_) {}
})();

const app = express();
const PORT = +process.env.PORT || 3000;
const PUBLIC_URL = resolvePublicUrl(PORT);
process.env.PUBLIC_URL = PUBLIC_URL;
logPublicUrlDebug(PUBLIC_URL);
if (!isValidPublicHttps(PUBLIC_URL)) {
  authLog('public_url_error', { where: 'boot', publicUrl: PUBLIC_URL });
}

function corsAllowedOrigins() {
  const set = new Set();
  const add = (u) => {
    const s = String(u || '').trim().replace(/\/$/, '');
    if (!s) return;
    try {
      const url = new URL(s);
      set.add(url.origin);
    } catch (_) {
      set.add(s);
    }
  };
  add(PUBLIC_URL);
  add(process.env.CORS_ORIGIN);
  String(process.env.CORS_ORIGINS || '')
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean)
    .forEach(add);
  /* локальная разработка */
  add('http://localhost:' + PORT);
  add('http://127.0.0.1:' + PORT);
  return set;
}
const CORS_ORIGINS = corsAllowedOrigins();
app.use(cors({
  origin(origin, cb) {
    if (!origin) return cb(null, true);
    try {
      const o = new URL(origin).origin;
      if (CORS_ORIGINS.has(o)) return cb(null, true);
    } catch (_) {}
    return cb(null, false);
  },
  credentials: true
}));
app.use(express.json({ limit: '15mb' }));
app.use(jsonCompression());
app.use(authOptional);

async function telegramWebhookHandler(req, res) {
  try {
    if (!telegramBot.configured()) return res.sendStatus(404);
    if (!telegramBot.verifyWebhookSecret(req)) return res.sendStatus(401);
    await telegramBot.handleUpdate(req.body || {});
    res.json({ ok: true });
  } catch (e) {
    console.error('telegram webhook:', e.message);
    res.sendStatus(200);
  }
}

/* Bothost ждёт /webhook и /health; оставляем и старые пути */
app.post('/webhook', telegramWebhookHandler);
app.post('/api/telegram/webhook', telegramWebhookHandler);

function healthPayload() {
  let telegramGateway = false;
  try { telegramGateway = require('./telegram-gateway').configured(); } catch (_) {}
  return {
    ok: true,
    brand: 'Canvas',
    publicUrl: PUBLIC_URL,
    yookassa: yookassa.configured(),
    telegram: telegramBot.configured(),
    telegramBot: telegramBot.botUsername() || '',
    telegramGateway,
    google: googleAuth.configured() || googleIdToken.configured(),
    /* публичный идентификатор — по нему браузер рисует кнопку Google */
    googleClientId: googleIdToken.clientId(),
    smtp: smtpConfigured(),
    tryon: tryonServerConfigured(),
    cdek: cdek.configured(),
    time: new Date().toISOString()
  };
}

app.get('/health', (_req, res) => {
  res.json(healthPayload());
});

app.get('/api/health', (_req, res) => {
  res.json(healthPayload());
});

/* -------- отпечаток данных для «живого» опроса --------
   Витрина раньше раз в секунду качала весь каталог и раз в пять — всю CMS
   вместе с фото, просто чтобы сравнить и почти всегда ничего не менять.
   Теперь она сначала спрашивает эти короткие отпечатки и лезет за данными,
   только если что-то действительно изменилось. */
function sha(text) {
  return require('crypto').createHash('sha1').update(String(text)).digest('hex').slice(0, 16);
}

/** Отпечаток по СОДЕРЖИМОМУ, а не по updated_at: время в SQLite с точностью
 *  до секунды, и две правки подряд давали одинаковый штамп — вторая не доехала
 *  бы до витрины. Вместо самих картинок берём их длину: и дёшево, и меняется
 *  при любой замене фото. */
function stamp(sql) {
  try {
    const rows = db.prepare(sql).all();
    return sha(rows.map((r) => Object.values(r).join('')).join(''));
  } catch (_) {
    return '';
  }
}

app.get('/api/live-version', (_req, res) => {
  let cms = '';
  try {
    const row = db.prepare('SELECT data_json FROM cms WHERE id = 1').get();
    cms = sha((row && row.data_json) || '');
  } catch (_) {}
  res.setHeader('Cache-Control', 'no-store');
  res.json({
    /* Берём только колонки, которые в таблице идут ДО img/gal_json: всё, что
       после них, SQLite достаёт, протаскиваясь через страницы переполнения с
       base64 — на сотне товаров это сотни мегабайт чтения на каждый опрос.
       Любую другую правку (фото, описание, наличие) ловит счётчик записей
       products.getRev(), он же различает две правки внутри одной секунды. */
    products: stamp(`SELECT id, name, cat, gender, price, old_price, sku, sizes_json,
        stock_json, on_sale
      FROM products ORDER BY id`) + '.' + getRev(),
    /* Та же осторожность, что и с товарами: в таблице reviews photos_json идёт
       раньше useful/verified/reply_*, поэтому берём только колонки ДО фото,
       а остальное отслеживает счётчик отзывов. */
    reviews: stamp(`SELECT id, product_id, user_email, author, rating, text,
        status, created_at, sku, user_id, size, fit
      FROM reviews ORDER BY id`) + '.' + require('./rev').read('reviews'),
    cms
  });
});

/* -------- catalog -------- */
app.get('/api/catalog', (_req, res) => {
  res.json({ products: media.publicCatalog({ all: false }) });
});

app.get('/api/catalog/all', adminRequired, (_req, res) => {
  res.json({ products: media.publicCatalog({ all: true }) });
});

app.get('/api/catalog/:id', (req, res) => {
  const p = getProduct(+req.params.id);
  if (!p) return res.status(404).json({ error: 'Не найден' });
  if (!p.on && !(req.user && req.user.role === 'admin')) {
    return res.status(404).json({ error: 'Не найден' });
  }
  res.json({ product: media.productToPublic(p) });
});

const STALE_PHOTO = 'Карточка открыта давно: часть фото уже изменили в другом месте. Обновите страницу и повторите.';

app.post('/api/admin/products', adminRequired, (req, res) => {
  try {
    const lost = [];
    const incoming = media.restoreProductImages(req.body || {}, lost);
    if (lost.length) return res.status(409).json({ error: STALE_PHOTO, code: 'PHOTO_STALE' });
    const product = upsertProduct(incoming);
    res.json({ product: media.productToPublic(product) });
  } catch (e) {
    res.status(400).json({ error: e.message || 'Ошибка' });
  }
});

app.put('/api/admin/products/:id', adminRequired, (req, res) => {
  try {
    const lost = [];
    const incoming = media.restoreProductImages({ ...(req.body || {}), id: +req.params.id }, lost);
    /* проверяем ДО записи: иначе битая ссылка уже осела бы в БД */
    if (lost.length) return res.status(409).json({ error: STALE_PHOTO, code: 'PHOTO_STALE' });
    const product = upsertProduct(incoming);
    res.json({ product: media.productToPublic(product) });
  } catch (e) {
    res.status(400).json({ error: e.message || 'Ошибка' });
  }
});

app.delete('/api/admin/products/:id', adminRequired, (req, res) => {
  deleteProduct(+req.params.id);
  res.json({ ok: true });
});

/* -------- cms (без секретов на клиент) -------- */
app.get('/api/cms', (_req, res) => {
  res.json({ cms: media.cmsToPublic(sanitizeCms(getCms() || defaultCms())) });
});

app.put('/api/cms', adminRequired, (req, res) => {
  const cur = getCms() || defaultCms();
  /* с витрины фото приходят ссылками /media/... — вернуть им исходный base64,
     иначе сохранение админки затёрло бы сами картинки адресами */
  const lost = [];
  const body = scrubCmsInput(media.restoreCmsImages(req.body || {}, cur, lost));
  /* Ссылка, которой в текущей CMS уже нет: страница админки открыта давно, а
     фото за это время заменили или удалили из другой вкладки. Сохранять
     нельзя — в БД вместо картинки лёг бы битый путь. */
  if (lost.length) {
    return res.status(409).json({
      error: 'Страница админки устарела: часть фото уже изменили в другом месте. Обновите страницу и повторите.',
      code: 'CMS_STALE'
    });
  }
  const next = Object.assign({}, cur, body);
  if (body.brand) next.brand = Object.assign({}, cur.brand, body.brand);
  if (body.contacts) next.contacts = Object.assign({}, cur.contacts, body.contacts);
  if (body.legal) next.legal = Object.assign({}, cur.legal, body.legal);
  if (body.texts) next.texts = Object.assign({}, cur.texts, body.texts);
  if (body.shipping) next.shipping = Object.assign({}, cur.shipping, body.shipping);
  if (body.tryon) next.tryon = Object.assign({}, cur.tryon || {}, body.tryon);
  /* на всякий случай ещё раз вычистить секреты */
  const clean = scrubCmsInput(next);
  saveCms(clean);
  media.invalidateCms();
  res.json({ cms: media.cmsToPublic(sanitizeCms(clean)) });
});

/* -------- отзывы -------- */
app.get('/api/reviews', (req, res) => {
  const productId = req.query.productId || req.query.pid || null;
  res.json({ reviews: media.reviewsToPublic(reviews.listReviews(req.user, { productId })) });
});

app.post('/api/reviews', authRequired, (req, res) => {
  try {
    const rl = hit('review-create', clientIp(req), { limit: 8, windowMs: 60 * 60 * 1000, label: 'Слишком много отзывов' });
    if (!rl.ok) return res.status(429).json({ error: rl.error });
    const review = reviews.createReview(req.user, req.body || {});
    res.json({ review: media.reviewToPublic(review) });
  } catch (e) {
    res.status(e.status || 400).json({ error: e.message || 'Не удалось сохранить отзыв' });
  }
});

app.post('/api/reviews/:id/vote', authRequired, (req, res) => {
  try {
    const review = reviews.voteReview(req.user, req.params.id);
    res.json({ review: media.reviewToPublic(review) });
  } catch (e) {
    res.status(e.status || 400).json({ error: e.message || 'Не удалось оценить отзыв' });
  }
});

app.delete('/api/reviews/:id', authRequired, (req, res) => {
  try {
    reviews.deleteReview(req.user, req.params.id, { admin: req.user.role === 'admin' });
    res.json({ ok: true });
  } catch (e) {
    res.status(e.status || 400).json({ error: e.message || 'Не удалось удалить отзыв' });
  }
});

app.get('/api/admin/reviews', adminRequired, (req, res) => {
  res.json({ reviews: media.reviewsToPublic(reviews.listReviews(req.user, { admin: true })) });
});

app.patch('/api/admin/reviews/:id', adminRequired, (req, res) => {
  try {
    const review = reviews.updateReviewAdmin(req.params.id, req.body || {});
    res.json({ review: media.reviewToPublic(review) });
  } catch (e) {
    res.status(e.status || 400).json({ error: e.message || 'Ошибка' });
  }
});

app.delete('/api/admin/reviews/:id', adminRequired, (req, res) => {
  try {
    reviews.deleteReview(req.user, req.params.id, { admin: true });
    res.json({ ok: true });
  } catch (e) {
    res.status(e.status || 400).json({ error: e.message || 'Ошибка' });
  }
});

/* -------- CDEK pickup points -------- */
app.get('/api/cdek/cities', async (req, res) => {
  try {
    const q = String(req.query.q || '').trim();
    const hasGeo = req.query.lat && req.query.lng;
    if (q.length < 2 && !hasGeo) return res.json({ cities: [] });
    const cities = await cdek.searchCities(q, {
      lat: req.query.lat,
      lng: req.query.lng
    });
    res.json({ cities });
  } catch (e) {
    res.status(e.status || 502).json({ error: e.message || 'Ошибка API СДЭК' });
  }
});

app.get('/api/cdek/deliverypoints', async (req, res) => {
  try {
    const points = await cdek.deliveryPoints({
      cityCode: req.query.city_code,
      lat: req.query.lat,
      lng: req.query.lng,
      q: req.query.q,
      limit: req.query.limit
    });
    res.json({ points });
  } catch (e) {
    res.status(e.status || 502).json({ error: e.message || 'Ошибка API СДЭК' });
  }
});

/* -------- try-on: ключи только на сервере -------- */
app.post('/api/tryon', authRequired, async (req, res) => {
  try {
    const rl = hit('tryon', `${req.user.id}|${clientIp(req)}`, {
      limit: 15,
      windowMs: 60 * 60 * 1000,
      label: 'Слишком много примерок'
    });
    if (!rl.ok) return res.status(429).json({ error: rl.error });
    const out = await runTryon({
      personImage: req.body && req.body.personImage,
      /* с витрины фото вещи приходит ссылкой /media/... — внешнему сервису
         примерки относительный путь недоступен, отдаём саму картинку */
      garmentImage: media.resolveMediaUrl(req.body && req.body.garmentImage),
      productId: req.body && req.body.productId,
      productName: req.body && req.body.productName,
      brand: req.body && req.body.brand
    });
    res.json(out);
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message, code: e.code });
  }
});

function authRateLimit(scope, limit) {
  return (req, res, next) => {
    const rl = hit(scope, clientIp(req), {
      limit,
      windowMs: 15 * 60 * 1000,
      label: 'Слишком много попыток'
    });
    if (!rl.ok) return res.status(429).json({ error: rl.error });
    next();
  };
}

/* -------- ошибки из браузера --------
   Страница сама присылает сюда свои сбои: без этого поломка в JS видна
   только покупателю, который просто уйдёт и ничего не скажет. */
app.post('/api/client-error', authRateLimit('client-error', 30), (req, res) => {
  const b = req.body || {};
  const msg = String(b.message || '').trim();
  /* пустое и запредельное не принимаем: эндпоинт открытый */
  if (msg && msg.length < 2000) {
    errors.report('client', { message: msg, stack: String(b.stack || '').slice(0, 2000) }, {
      page: String(b.page || '').slice(0, 300),
      browser: String(req.headers['user-agent'] || '').slice(0, 200),
      ip: clientIp(req),
      user: String(b.user || '').slice(0, 120)
    });
  }
  res.json({ ok: true });
});

/* -------- auth -------- */
app.post('/api/auth/register', authRateLimit('auth-register', 8), (req, res) => {
  try {
    const user = register(req.body || {});
    claimOrdersForUser(user);
    const token = signUser(user);
    setAuthCookie(res, token);
    res.json({ user: publicUser(user), token });
  } catch (e) {
    res.status(e.status || 400).json({ error: e.message });
  }
});

app.post('/api/auth/login', authRateLimit('auth-login', 20), (req, res) => {
  try {
    const user = login(req.body || {});
    claimOrdersForUser(user);
    const token = signUser(user);
    setAuthCookie(res, token);
    res.json({ user: publicUser(user), token });
  } catch (e) {
    res.status(e.status || 401).json({ error: e.message });
  }
});

app.post('/api/auth/forgot', authRateLimit('auth-forgot', 8), async (req, res) => {
  try {
    const out = await requestPasswordReset(req.body && req.body.email);
    res.json(out);
  } catch (e) {
    res.status(e.status || 400).json({
      error: e.message,
      needTelegram: !!e.needTelegram,
      smtp: smtpConfigured()
    });
  }
});

/* -------- страница из письма (/reset?t=…) --------
   Токен из письма сам по себе пароль не меняет: им можно только показать
   код или получить одноразовый билет. Пароль меняется отдельным запросом. */
const resetLinkRoute = (scope, limit, run) =>
  [authRateLimit(scope, limit), (req, res) => {
    try {
      res.json(run(req.body || {}));
    } catch (e) {
      res.status(e.status || 400).json({ error: e.message });
    }
  }];

app.post('/api/auth/reset/open', ...resetLinkRoute('reset-open', 40, (b) => openResetLink(b.token)));
app.post('/api/auth/reset/code', ...resetLinkRoute('reset-code', 20, (b) => revealCode(b.token)));
app.post('/api/auth/reset/ticket', ...resetLinkRoute('reset-ticket', 20, (b) => issueTicket(b.token)));
app.post('/api/auth/reset/check', ...resetLinkRoute('reset-check', 30, (b) => checkTicket(b.ticket)));

app.post('/api/auth/reset', authRateLimit('auth-reset', 12), (req, res) => {
  try {
    const body = req.body || {};
    const user = resetPassword({
      email: body.email,
      code: body.code,
      ticket: body.ticket,
      password: body.password
    });
    claimOrdersForUser(user);
    const token = signUser(user);
    setAuthCookie(res, token);
    res.json({ user: publicUser(user), token, ok: true });
  } catch (e) {
    res.status(e.status || 400).json({ error: e.message });
  }
});

const OAUTH_STATE_COOKIE = 'lc_oauth_state';

app.get('/api/auth/google', (req, res) => {
  try {
    if (!googleAuth.configured()) {
      return res.redirect('/?auth_err=' + encodeURIComponent('Google не настроен: GOOGLE_CLIENT_ID и GOOGLE_CLIENT_SECRET'));
    }
    const state = require('crypto').randomBytes(16).toString('hex');
    const secure = String(PUBLIC_URL || '').startsWith('https');
    res.setHeader(
      'Set-Cookie',
      `${OAUTH_STATE_COOKIE}=${encodeURIComponent(state)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=600${secure ? '; Secure' : ''}`
    );
    res.redirect(googleAuth.authUrl(state));
  } catch (e) {
    res.redirect('/?auth_err=' + encodeURIComponent(e.message || 'Google ошибка'));
  }
});

app.get('/api/auth/google/callback', async (req, res) => {
  try {
    const code = String(req.query.code || '');
    const state = String(req.query.state || '');
    const cookie = String(req.headers.cookie || '');
    const m = cookie.match(new RegExp('(?:^|; )' + OAUTH_STATE_COOKIE + '=([^;]+)'));
    const expected = m ? decodeURIComponent(m[1]) : '';
    res.setHeader('Set-Cookie', `${OAUTH_STATE_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
    if (!code) {
      return res.redirect('/?auth_err=' + encodeURIComponent('Google: нет кода'));
    }
    if (!state || !expected || state !== expected) {
      return res.redirect('/?auth_err=' + encodeURIComponent('Google: неверный state'));
    }
    const tokens = await googleAuth.exchangeCode(code);
    const profile = await googleAuth.fetchProfile(tokens.access_token);
    if (!profile.email && !profile.googleId) {
      return res.redirect('/?auth_err=' + encodeURIComponent('Google не вернул email'));
    }
    if (profile.email && profile.emailVerified === false) {
      return res.redirect('/?auth_err=' + encodeURIComponent('Подтвердите email в Google'));
    }
    const user = upsertGoogleUser(profile);
    claimOrdersForUser(user);
    const token = signUser(user);
    setAuthCookie(res, token);
    /* токен в hash — SPA подхватит на клиенте */
    res.redirect('/#google_token=' + encodeURIComponent(token));
  } catch (e) {
    console.error('Google callback:', e.message);
    res.redirect('/?auth_err=' + encodeURIComponent(e.message || 'Google ошибка'));
  }
});

/* Вход через кнопку Google (Identity Services).
   Браузер присылает подписанный ID-токен, сервер проверяет подпись
   публичными ключами Google. Секретный ключ приложения тут не нужен. */
app.post('/api/auth/google/token', authRateLimit('google-token', 30), async (req, res) => {
  try {
    const profile = await googleIdToken.verifyIdToken((req.body || {}).credential);
    if (!profile.emailVerified) {
      return res.status(403).json({ error: 'Подтвердите email в Google' });
    }
    const user = upsertGoogleUser(profile);
    claimOrdersForUser(user);
    const token = signUser(user);
    setAuthCookie(res, token);
    res.json({ user: publicUser(user), token });
  } catch (e) {
    res.status(e.status || 401).json({ error: e.message || 'Google вход не удался' });
  }
});

/* -------- корзина, избранное и прочие мелочи покупателя --------
   Лежат на сервере, чтобы один аккаунт видел одно и то же с телефона
   и с компьютера. Товары, заказы и отзывы синхронизировались и раньше,
   а это оставалось только в браузере. */
app.get('/api/me/prefs', authRequired, (req, res) => {
  try {
    res.json(userPrefs.getPrefs(req.user.id));
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

app.put('/api/me/prefs', authRequired, (req, res) => {
  try {
    res.json(userPrefs.savePrefs(req.user.id, req.body || {}));
  } catch (e) {
    res.status(e.status || 400).json({ error: e.message });
  }
});

app.post('/api/auth/logout', (_req, res) => {
  clearAuthCookie(res);
  res.json({ ok: true });
});

/* ---- телефон + OTP через бота ---- */
app.post('/api/auth/phone/start', async (req, res) => {
  try {
    const { startPhoneAuth } = require('./otp');
    const out = await startPhoneAuth(req.body && req.body.phone);
    res.json(out);
  } catch (e) {
    res.status(e.status || 400).json({ error: e.message });
  }
});

app.post('/api/auth/phone/send', async (req, res) => {
  try {
    const { sendPhoneCode } = require('./otp');
    const out = await sendPhoneCode(req.body && req.body.phone);
    res.json(out);
  } catch (e) {
    res.status(e.status || 400).json({
      error: e.message,
      needOpenBot: !!e.needOpenBot
    });
  }
});

app.get('/api/auth/phone/status', (req, res) => {
  try {
    const { phoneAuthStatus } = require('./otp');
    res.json(phoneAuthStatus(req.query && req.query.phone));
  } catch (e) {
    res.status(400).json({ error: e.message, linked: false });
  }
});

/* совместимость со старым клиентом */
app.post('/api/auth/phone/send-legacy-start', async (req, res) => {
  try {
    const { startPhoneAuth } = require('./otp');
    const out = await startPhoneAuth(req.body && req.body.phone);
    res.json(out);
  } catch (e) {
    res.status(e.status || 400).json({ error: e.message });
  }
});

app.post('/api/auth/phone/verify', (req, res) => {
  try {
    const { verifyOtp } = require('./otp');
    const body = req.body || {};
    const { phone, chatId } = verifyOtp(body.phone, body.code);
    let user = upsertUserByPhone({
      phone,
      name: body.name,
      last: body.last,
      via: 'telegram-otp'
    });
    claimOrdersForUser(user);
    user = linkOwnerChat(chatId, user, phone);
    const token = signUser(user);
    setAuthCookie(res, token);
    res.json({ user: publicUser(user), token, ok: true });
  } catch (e) {
    res.status(e.status || 400).json({ error: e.message, wrong: !!e.wrong });
  }
});

/** Запрос кода: сайт помечает номер как ожидающий (2 мин). */
app.post('/api/auth/device-code/request', async (req, res) => {
  try {
    const { requestDeviceLogin } = require('./otp');
    const ip = clientIp(req);
    const out = await requestDeviceLogin(req.body && req.body.phone, { ip, via: 'site' });
    res.json(out);
  } catch (e) {
    authLog('code_request_error', { error: e.message, ip: clientIp(req) });
    res.status(e.status || 400).json(Object.assign({ error: e.message }, e.payload || {}));
  }
});

/** Вход по коду с другого устройства. */
app.post('/api/auth/device-code', async (req, res) => {
  try {
    const { verifyDeviceLoginCode } = require('./otp');
    const { findById, findByPhone } = require('./auth');
    const body = req.body || {};
    const ip = clientIp(req);
    const lim = hit('device-verify-route', ip, {
      limit: 40,
      windowMs: 15 * 60 * 1000,
      label: 'Слишком много попыток'
    });
    if (!lim.ok) {
      authLog('login_fail', { reason: 'route_rate', ip });
      return res.status(429).json({ error: lim.error });
    }
    const meta = verifyDeviceLoginCode(body.code, body.phone, { ip });
    const { phone, userId, chatId, gotPhoneMsgId, codeMsgId } = meta;
    let user = null;
    if (userId) user = findById(userId);
    if (!user && phone) user = findByPhone(phone);
    if (!user && phone) {
      user = upsertUserByPhone({ phone, via: 'device-code' });
    }
    if (!user) {
      authLog('login_fail', { phone, reason: 'user_not_found', ip });
      return res.status(400).json({ error: 'Аккаунт не найден — запросите код снова', wrong: true });
    }
    claimOrdersForUser(user);
    user = linkOwnerChat(chatId, user, phone);
    try {
      await telegramBot.notifyDeviceLoginSuccess(chatId, { gotPhoneMsgId, codeMsgId });
    } catch (e) {
      console.warn('device-code success notify:', e.message);
    }
    const isNew = !String(user.name || '').trim() || !String(user.last_name || '').trim();
    const token = signUser(user);
    setAuthCookie(res, token);
    res.json({ user: publicUser(user), token, ok: true, isNew });
  } catch (e) {
    res.status(e.status || 400).json({ error: e.message, wrong: !!e.wrong });
  }
});

/** Вход по ссылке после регистрации через Telegram (контакт). */
app.post('/api/auth/telegram-phone', (req, res) => {
  try {
    const tokenIn = String((req.body && req.body.token) || '').trim();
    const user = redeemTgPhoneToken(tokenIn);
    const isNew = !String(user.name || '').trim() || !String(user.last_name || '').trim();
    claimOrdersForUser(user);
    const token = signUser(user);
    setAuthCookie(res, token);
    res.json({ user: publicUser(user), token, isNew });
  } catch (e) {
    res.status(e.status || 400).json({ error: e.message });
  }
});

app.get('/api/auth/me', (req, res) => {
  if (!req.user) return res.json({ user: null });
  res.json({ user: publicUser(req.user) });
});

app.put('/api/auth/profile', authRequired, (req, res) => {
  try {
    const body = req.body || {};
    const user = updateProfile(req.user.id, {
      name: body.name,
      last: body.last,
      middle: body.middle,
      email: body.email,
      phone: body.phone
    });
    const token = signUser(user);
    setAuthCookie(res, token);
    res.json({ user: publicUser(user), token, ok: true });
  } catch (e) {
    res.status(e.status || 400).json({ error: e.message });
  }
});

app.get('/api/auth/telegram', (req, res) => {
  const bot = telegramBot.botUsername() || '';
  if (!req.user) return res.json({ linked: false, conflict: false, bot });
  const { telegramStatusForUser } = require('./tg-users');
  const st = telegramStatusForUser(req.user);
  res.json({
    linked: st.linked,
    conflict: !!st.conflict,
    bot,
    at: st.at || null
  });
});

/** Авто-вход в ADMIN_EMAIL по одноразовой ссылке из бота (только владелец TELEGRAM_CHAT_ID). */
app.post('/api/auth/telegram-admin', (req, res) => {
  try {
    const token = String((req.body && req.body.token) || req.query.t || '').trim();
    const user = redeemTgAdminToken(token);
    const jwt = signUser(user);
    setAuthCookie(res, jwt);
    res.json({ user: publicUser(user), token: jwt });
  } catch (e) {
    res.status(e.status || 400).json({ error: e.message });
  }
});

function shopUrlFromRequest(req) {
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || '')
    .split(',')[0].trim();
  if (!host) return PUBLIC_URL;
  const xfProto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
  let proto = xfProto || (req.secure ? 'https' : 'http');
  if (!/localhost|127\.0\.0\.1/i.test(host) && proto === 'http') proto = 'https';
  const origin = `${proto}://${host}`.replace(/\/$/, '');
  if (/localhost|127\.0\.0\.1/i.test(host)) return origin;
  if (/^https:\/\//i.test(origin)) return origin;
  return PUBLIC_URL;
}

/* -------- checkout / orders -------- */
app.post('/api/checkout', authRequired, async (req, res) => {
  try {
    const result = await createCheckout({
      items: req.body.items,
      guest: req.body.guest,
      pvz: req.body.pvz,
      promoCode: req.body.promoCode,
      user: req.user,
      publicUrl: shopUrlFromRequest(req)
    });
    res.json(result.order ? Object.assign({}, result, { order: media.orderToPublic(result.order) }) : result);
  } catch (e) {
    res.status(e.status || 400).json({ error: e.message, code: e.code });
  }
});

app.post('/api/yookassa/webhook', async (req, res) => {
  try {
    const out = await handleWebhook(req.body);
    if (out && out.error === 'payment_not_found') {
      return res.status(503).json(out);
    }
    res.json(out);
  } catch (e) {
    console.error('webhook', e);
    res.status(503).json({ ok: false, error: 'webhook failed' });
  }
});

app.post('/api/orders/:num/pay', authOptional, async (req, res) => {
  try {
    const accessToken = String(
      (req.body && req.body.accessToken) || req.query.t || req.headers['x-order-token'] || ''
    );
    const result = await ensurePayment(
      req.params.num,
      req.user,
      accessToken,
      shopUrlFromRequest(req)
    );
    res.json(result && result.order ? Object.assign({}, result, { order: media.orderToPublic(result.order) }) : result);
  } catch (e) {
    res.status(e.status || 400).json({ error: e.message });
  }
});

app.get('/api/orders/mine', authRequired, (req, res) => {
  res.json({ orders: media.ordersToPublic(listOrdersForUser(req.user)) });
});

app.get('/api/orders/:num', authOptional, async (req, res) => {
  const num = String(req.params.num || '');
  let order = getOrderByNum(num);
  if (!order) return res.status(404).json({ error: 'Не найден' });

  const accessToken = String(req.query.t || req.headers['x-order-token'] || '');
  if (!canAccessOrder(order, req.user, accessToken)) {
    return res.status(403).json({ error: 'Нет доступа' });
  }

  const isAdmin = !!(req.user && req.user.role === 'admin');
  if (req.query.sync === '1' || order.payStatus === 'pending') {
    order = (await syncPaymentStatus(order.num)) || order;
  }
  res.json({ order: media.orderToPublic(toPublicOrder(order, { admin: isAdmin })) });
});

app.post('/api/orders/:num/cancel', authOptional, (req, res) => {
  try {
    const accessToken = String(
      (req.body && req.body.accessToken) || req.query.t || req.headers['x-order-token'] || ''
    );
    const order = cancelOrderBuyer(req.params.num, req.user, accessToken);
    res.json({ order: media.orderToPublic(order) });
  } catch (e) {
    res.status(e.status || 400).json({ error: e.message });
  }
});

app.post('/api/orders/:num/return', authOptional, (req, res) => {
  try {
    const accessToken = String(
      (req.body && req.body.accessToken) || req.query.t || req.headers['x-order-token'] || ''
    );
    const order = requestReturnBuyer(req.params.num, req.user, accessToken);
    res.json({ order: media.orderToPublic(order) });
  } catch (e) {
    res.status(e.status || 400).json({ error: e.message });
  }
});

app.get('/api/admin/orders', adminRequired, (_req, res) => {
  res.json({ orders: media.ordersToPublic(listAllOrders()) });
});

app.patch('/api/admin/orders/:num', adminRequired, async (req, res) => {
  try {
    const order = await updateOrderAdmin(req.params.num, req.body || {});
    if (!order) return res.status(404).json({ error: 'Не найден' });
    res.json({ order: media.orderToPublic(order) });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message || 'Ошибка' });
  }
});

app.get('/api/admin/customers', adminRequired, (_req, res) => {
  const orders = listAllOrders();
  const map = {};
  for (const o of orders) {
    const key = (o.email || o.phone || o.customerName || 'guest').toLowerCase();
    if (!map[key]) {
      map[key] = { name: o.customerName, email: o.email, phone: o.phone, orders: 0, sum: 0 };
    }
    map[key].orders += 1;
    map[key].sum += o.price || 0;
  }
  res.json({ customers: Object.values(map) });
});

/* -------- картинки из БД отдельными файлами --------
   Внутри JSON лежал base64: браузер не мог его кэшировать и качал заново при
   каждом опросе. Теперь в JSON только адрес с хэшем содержимого, а сам файл
   отдаётся один раз и живёт в кэше навсегда. */
const IMMUTABLE = 'public, max-age=31536000, immutable';

function sendImage(res, found) {
  if (!found) return res.status(404).end();
  res.setHeader('Content-Type', found.mime);
  res.setHeader('Cache-Control', IMMUTABLE);
  res.setHeader('Content-Length', found.buf.length);
  res.end(found.buf);
}

app.get('/media/p/:id/:file', (req, res) => {
  const hash = String(req.params.file).split('.')[0];
  sendImage(res, media.findProductImage(req.params.id, hash));
});

app.get('/media/cms/:file', (req, res) => {
  const hash = String(req.params.file).split('.')[0];
  sendImage(res, media.findCmsImage(hash, sanitizeCms(getCms() || defaultCms())));
});

app.get('/media/rv/:id/:file', (req, res) => {
  const hash = String(req.params.file).split('.')[0];
  sendImage(res, media.findReviewImage(req.params.id, hash));
});

app.get('/media/o/:num/:file', (req, res) => {
  const hash = String(req.params.file).split('.')[0];
  sendImage(res, media.findOrderImage(req.params.num, hash));
});

/* static */
const publicDir = path.join(__dirname, '..', 'public');
const indexHandler = serveTextFile(path.join(publicDir, 'index.html'));
app.get('/', indexHandler);
app.get('/index.html', indexHandler);
app.get('/api-bridge.js', serveTextFile(path.join(publicDir, 'api-bridge.js')));
app.use(express.static(publicDir, {
  extensions: ['html'],
  /* Картинки товаров лежат под именами с хешем и правда не меняются — их держим
     в кэше долго. HTML перепроверяем всегда, иначе правки не доедут до покупателя.
     А вот знак бренда — исключение, и на нём мы уже обожглись: он лежит под
     постоянным именем /logo.png, файл заменили, но у всех, кто заходил раньше,
     ещё неделю показывался старый. Такие файлы обязаны перепроверяться; с ETag
     это стоит одного ответа «не изменилось» на 22 КБ картинки. */
  setHeaders(res, filePath) {
    const p = String(filePath).replace(/\\/g, '/');
    const alwaysCheck =
      /\.html?$/i.test(p) ||
      /\/(logo|logo-white|apple-touch-icon)\.png$/i.test(p) ||
      /\/favicon\.svg$/i.test(p);
    res.setHeader('Cache-Control', alwaysCheck ? 'no-cache' : 'public, max-age=604800');
  }
}));
/* Браузер сам просит эти адреса на каждой странице. Своего файла у них
   не было, и каждый такой запрос проваливался в catch-all ниже, получая
   весь index.html — 567 КБ вместо иконки, да ещё и по два раза за загрузку. */
app.get('/favicon.ico', (_req, res) => {
  res.setHeader('Cache-Control', 'public, max-age=604800');
  res.status(204).end();
});
app.get('/robots.txt', (_req, res) => {
  res.type('text/plain').send('User-agent: *\nAllow: /\n');
});

/* Всё, что похоже на файл (есть расширение), но до сюда долетело — значит
   такого файла нет. Отдаём 404, а не страницу: иначе опечатка в пути или
   иконка, которую браузер ищет сам, стоят покупателю полмегабайта трафика. */
const FILE_LIKE = /\.[a-z0-9]{1,8}$/i;
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  if (FILE_LIKE.test(req.path)) return res.status(404).end();
  indexHandler(req, res);
});

app.use((err, req, res, _next) => {
  /* console.error перехвачен, но там нет ни адреса, ни пользователя —
     поэтому шлём отдельно, с контекстом запроса. */
  process.stderr.write('[500] ' + (err && err.stack ? err.stack : err) + '\n');
  errors.report('express', err, {
    method: req.method,
    url: req.originalUrl || req.url,
    status: 500,
    ip: clientIp(req),
    user: req.user ? `${req.user.id} · ${req.user.email || ''}` : ''
  });
  res.status(500).json({ error: 'Серверная ошибка' });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Canvas → ${PUBLIC_URL}`);
  console.log(`Listening 0.0.0.0:${PORT}`);
  console.log(`DB ready · ЮKassa: ${yookassa.configured() ? 'ON' : 'OFF (keys missing)'} · СДЭК: ${cdek.configured() ? 'ON' : 'OFF'}`);
  const mailMod = require('./mail');
  console.log(`Почта: ${mailMod.mailMode()}`);
  mailMod.mailWarnings().forEach((line) => console.warn(line));
  console.log(
    `Ошибки → ${errors.enabled() ? 'Telegram, чат ' + errors.chatId() : 'только data/errors.log'}`
  );
  startBackupSchedule();
  /* На запуске с локальным адресом бота не поднимаем.
     Иначе он идёт за обновлениями тем же токеном, что и рабочий сервер, и
     Telegram начинает отдавать их то одному, то другому: владельцу летит
     поток «ошибка на сервере», а живой бот отвечает покупателям через раз.
     TELEGRAM_POLLING=1 оставляет возможность поднять его вручную. */
  const botForced = String(process.env.TELEGRAM_POLLING || '') === '1';
  if (isLocal(PUBLIC_URL) && !botForced) {
    console.log(`Telegram: бот не запущен — локальный адрес ${PUBLIC_URL}`);
  } else {
    telegramBot.boot(PUBLIC_URL).catch((e) => console.error(e));
  }
  let lastCdekSync = 0;
  const tick = () => {
    try { expireUnpaidOrders(); } catch (e) { console.warn('expire unpaid:', e.message); }
    if (!cdek.configured()) return;
    if (Date.now() - lastCdekSync < 5 * 60 * 1000) return;
    lastCdekSync = Date.now();
    syncCdekOrderStatuses().catch((e) => console.warn('cdek status sync:', e.message));
  };
  tick();
  setInterval(tick, 60 * 1000).unref?.();
});
