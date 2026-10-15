'use strict';
/**
 * Поисковики: у товаров и разделов — свои адреса.
 *
 * Магазин одностраничный, экраны открываются по #якорю (#p=136), а всё после
 * решётки Яндекс и Google не видят — в поиске жила одна главная. Здесь у
 * каждого товара и раздела есть настоящий адрес:
 *
 *   /product/136-pukhovik-zhenskiy   — карточка товара
 *   /catalog/kurtki                  — раздел
 *
 * Сервер отдаёт тот же index.html, но с их собственными <title>, описанием,
 * canonical, превью для соцсетей и разметкой schema.org (Product, цена и
 * наличие), а в <noscript> — текст и ссылки для роботов без JavaScript.
 * Открывшего такой адрес человека скрипт в <head> index.html переводит на
 * привычный #-адрес, и магазин работает как обычно.
 *
 * Карта сайта (/sitemap.xml) перечисляет главную, разделы и товары.
 * Ссылка «Поделиться» ведёт на /product/<id>: в Telegram и ВК превью теперь
 * показывает фото и цену товара, а не общую картинку магазина.
 */
const fs = require('fs');
const path = require('path');
const { db } = require('./db');
const media = require('./media');
const { compress, etagOf, pickEncoding } = require('./compress');

const INDEX_FILE = path.join(__dirname, '..', 'public', 'index.html');

/* Разделы каталога — тот же список и те же адреса, что CATS в public/index.html.
   Новый раздел там — добавить и сюда. */
const SECTIONS = [
  { t: 'Футболки',   slug: 'futbolki',   h1: 'Футболки',                    what: 'базовые футболки из плотного хлопка: оверсайз и прямой крой, пять цветов' },
  { t: 'Кофты',      slug: 'kofty',      h1: 'Худи и кофты',                what: 'худи и кофты базового кроя из плотного трикотажа' },
  { t: 'Куртки',     slug: 'kurtki',     h1: 'Куртки, бомберы и пуховики',  what: 'бомберы, куртки и пуховики на каждый день' },
  { t: 'Аксессуары', slug: 'aksessuary', h1: 'Аксессуары',                  what: 'косметички, чехлы и другие мелочи' }
];
const sectionBySlug = (slug) => SECTIONS.find((s) => s.slug === slug) || null;
const sectionByName = (name) => SECTIONS.find((s) => s.t === name) || null;

const BRAND_FALLBACK = 'Luxe Canvas';
const HOME_TITLE = 'Luxe Canvas — базовая одежда: футболки, худи, куртки';
const ORIGIN_FALLBACK = 'https://luxecanvas.ru';

/* ---------- мелочи ---------- */

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
/* JSON внутри <script>: «<» не должен закрыть тег или открыть комментарий */
const ld = (obj) => JSON.stringify(obj).replace(/</g, '\\u003c');
const xml = (s) => esc(s).replace(/'/g, '&apos;');

const TRANSLIT = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'y', к: 'k',
  л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'ts',
  ч: 'ch', ш: 'sh', щ: 'sch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya'
};
function slugify(name) {
  const s = String(name || '').toLowerCase()
    .split('').map((c) => (TRANSLIT[c] !== undefined ? TRANSLIT[c] : c)).join('')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60).replace(/-+$/g, '');
  return s;
}

/** 1 товар, 2 товара, 5 товаров */
function plural(n, one, few, many) {
  const a = Math.abs(n) % 100, b = a % 10;
  if (a > 10 && a < 20) return many;
  if (b > 1 && b < 5) return few;
  return b === 1 ? one : many;
}

/** 18999 → «18 999» */
const rub = (n) => String(Math.round(+n || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');

function inStock(p) {
  const st = p && p.stock && typeof p.stock === 'object' ? Object.values(p.stock) : [];
  if (!st.length) return true;                       // остатки не ведутся — как в витрине, «есть»
  return st.reduce((s, n) => s + Math.max(0, +n || 0), 0) > 0;
}

function oneLine(s, max) {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max - 1);
  const sp = cut.lastIndexOf(' ');
  return (sp > max * 0.6 ? cut.slice(0, sp) : cut).replace(/[\s,.;:—-]+$/, '') + '…';
}

/** Начало описания целыми предложениями, не длиннее max; одно длинное — с «…» */
function lead(text, max) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  if (!t) return '';
  const sentences = t.match(/[^.!?]+[.!?]+(?:\s|$)|[^.!?]+$/g) || [t];
  let out = '';
  for (const sn of sentences) {
    const next = out + sn;
    if (next.trim().length > max) break;
    out = next;
  }
  return out.trim() || oneLine(t, max);
}

/* ---------- данные ---------- */

function catalog() {
  return media.publicCatalog().filter((p) => p && p.on);
}

function productPath(p) {
  const slug = slugify(p.name);
  return '/product/' + p.id + (slug ? '-' + slug : '');
}

/** Адрес фото для разметки и превью: только то, что можно открыть по ссылке. */
function imageUrls(origin, p, max = 6) {
  const list = [p.img, ...(Array.isArray(p.gal) ? p.gal : [])]
    .filter((u) => typeof u === 'string' && u && !u.startsWith('data:'));
  return [...new Set(list)].slice(0, max)
    .map((u) => (/^https?:\/\//i.test(u) ? u : origin + (u.startsWith('/') ? '' : '/') + u));
}

/** Только http(s); в разметку идёт url.href — опасные символы он кодирует сам */
function safeUrl(u) {
  try {
    const url = new URL(String(u || '').trim());
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : '';
  } catch (_) { return ''; }
}

function socialLinks(getCms) {
  const out = [];
  try {
    const c = (getCms() || {}).contacts || {};
    const soc = c.social && typeof c.social === 'object' ? c.social : {};
    for (const u of [...Object.values(soc), c.telegram]) {
      const ok = safeUrl(u);
      if (ok) out.push(ok);
    }
  } catch (_) {}
  out.push('https://t.me/Luxe_Canvas_bot');
  return [...new Set(out)];
}

function brandName(getCms) {
  try {
    const n = String(((getCms() || {}).brand || {}).name || '').trim();
    return n && n !== 'Canvas' ? n : BRAND_FALLBACK;
  } catch (_) { return BRAND_FALLBACK; }
}

/* ---------- блоки <head> и <noscript> ---------- */

function headBlock({ origin, url, title, description, image, type = 'website', graph, robots }) {
  const rows = [
    `<title>${esc(title)}</title>`,
    `<meta name="description" content="${esc(description)}">`,
    `<link rel="canonical" href="${esc(url)}">`
  ];
  if (robots) rows.push(`<meta name="robots" content="${esc(robots)}">`);
  rows.push(
    `<meta property="og:type" content="${type}">`,
    '<meta property="og:site_name" content="Luxe Canvas">',
    '<meta property="og:locale" content="ru_RU">',
    `<meta property="og:url" content="${esc(url)}">`,
    `<meta property="og:title" content="${esc(title)}">`,
    `<meta property="og:description" content="${esc(description)}">`
  );
  if (image) rows.push(`<meta property="og:image" content="${esc(image)}">`);
  rows.push('<meta name="twitter:card" content="summary_large_image">');
  if (graph) rows.push(`<script type="application/ld+json">\n${ld({ '@context': 'https://schema.org', '@graph': graph })}\n</script>`);
  return rows.join('\n');
}

const crumbs = (origin, items) => ({
  '@type': 'BreadcrumbList',
  itemListElement: items.map(([name, url], i) => ({ '@type': 'ListItem', position: i + 1, name, item: url }))
});

function sectionProducts(list, sec) {
  return list.filter((p) => p.cat === sec.t);
}

function navLinks(list) {
  const rows = SECTIONS.filter((s) => sectionProducts(list, s).length)
    .map((s) => `<li><a href="/catalog/${s.slug}">${esc(s.h1)}</a></li>`);
  return rows.length ? `<nav><h2>Каталог</h2><ul>${rows.join('')}</ul></nav>` : '';
}

function productList(list, origin) {
  if (!list.length) return '';
  return '<ul>' + list.map((p) =>
    `<li><a href="${productPath(p)}">${esc(p.name)}</a> — ${rub(p.price)} ₽${inStock(p) ? '' : ' (нет в наличии)'}</li>`
  ).join('') + '</ul>';
}

const FOOT = '<p>Доставка СДЭК в пункты выдачи и курьером по всей России. Оплата онлайн, лёгкий возврат. ' +
  'Связаться с нами: <a href="https://t.me/Luxe_Canvas_bot">Telegram @Luxe_Canvas_bot</a>.</p>';

function noscript(inner) {
  return `<noscript>\n${inner}\n</noscript>`;
}

/* ---------- страницы ---------- */

function homePage(ctx) {
  const { list, getCms, origin } = ctx;
  /* head главной остаётся из index.html, подменяем только sameAs: ссылки на
     соцсети задаёт владелец в админке */
  return {
    sameAs: socialLinks(getCms),
    body: noscript(
      '<h1>Luxe Canvas — интернет-магазин базовой одежды</h1>\n' +
      '<p>Luxe Canvas (Canvas) — базовая одежда на каждый день: футболки из плотного хлопка, худи, бомберы, ' +
      'пуховики и аксессуары. Цвета: чёрный, шоколад, красный, голубой, молочный.</p>\n' +
      navLinks(list) + '\n' +
      (list.length ? '<h2>Товары</h2>\n' + productList(list, origin) + '\n' : '') +
      '<p>Для работы магазина включите JavaScript в браузере.</p>\n' + FOOT
    )
  };
}

function productPage(ctx, p) {
  const { origin, list, getCms } = ctx;
  const brand = brandName(getCms);
  const url = origin + productPath(p);
  const sec = sectionByName(p.cat);
  const images = imageUrls(origin, p);
  const stock = inStock(p);
  const colors = (Array.isArray(p.colors) ? p.colors : []).map((c) => c && c.name).filter(Boolean);
  const sizes = Array.isArray(p.sizes) ? p.sizes.filter((s) => s && s !== 'ONESIZE') : [];

  const title = `${p.name} — купить за ${rub(p.price)} ₽ | ${brand}`;
  /* своё описание товара — как есть, без повторов названия: оно уже в заголовке */
  const own = lead(p.desc, 110);
  const description = own
    ? `${own.replace(/[.]+$/, '')}. Цена ${rub(p.price)} ₽, доставка СДЭК по России.`
    : `${p.name} от ${brand}: ${(sec ? sec.what : 'базовая одежда')}. Цена ${rub(p.price)} ₽. ` +
      'Доставка СДЭК по России, оплата онлайн, лёгкий возврат.';

  const product = {
    '@type': 'Product',
    '@id': url + '#product',
    name: p.name,
    description: oneLine(p.desc, 500) || description,
    sku: String(p.sku || p.id),
    category: p.cat,
    brand: { '@type': 'Brand', name: brand },
    offers: {
      '@type': 'Offer',
      url,
      priceCurrency: 'RUB',
      price: String(Math.round(+p.price || 0)),
      availability: stock ? 'https://schema.org/InStock' : 'https://schema.org/OutOfStock',
      itemCondition: 'https://schema.org/NewCondition',
      seller: { '@type': 'Organization', name: brand }
    }
  };
  if (images.length) product.image = images;
  if (colors.length) product.color = colors.join(', ');

  const trail = [['Главная', origin + '/']];
  if (sec) trail.push([sec.h1, origin + '/catalog/' + sec.slug]);
  trail.push([p.name, url]);

  const head = headBlock({
    origin, url, title, description, image: images[0], type: 'product',
    graph: [product, crumbs(origin, trail)]
  });

  const same = sec ? sectionProducts(list, sec).filter((x) => x.id !== p.id).slice(0, 8) : [];
  const body = noscript(
    `<h1>${esc(p.name)}</h1>\n` +
    `<p>Цена: ${rub(p.price)} ₽${p.old && p.old > p.price ? ` (было ${rub(p.old)} ₽)` : ''}. ` +
    `${stock ? 'В наличии.' : 'Нет в наличии.'}${p.sku ? ` Артикул: ${esc(p.sku)}.` : ''}</p>\n` +
    (p.desc ? `<p>${esc(oneLine(p.desc, 1200))}</p>\n` : '') +
    (colors.length ? `<p>Цвет: ${esc(colors.join(', '))}.</p>\n` : '') +
    (sizes.length ? `<p>Размеры: ${esc(sizes.join(', '))}.</p>\n` : '') +
    images.slice(0, 3).map((u) => `<img src="${esc(u)}" alt="${esc(p.name)}" width="320">`).join('\n') + '\n' +
    `<p><a href="/">Главная</a>${sec ? ` · <a href="/catalog/${sec.slug}">${esc(sec.h1)}</a>` : ''}</p>\n` +
    (same.length ? `<h2>Ещё в разделе «${esc(sec.h1)}»</h2>\n${productList(same, origin)}\n` : '') +
    '<p>Для заказа включите JavaScript в браузере.</p>\n' + FOOT
  );
  return { head, body };
}

function sectionPage(ctx, sec, items) {
  const { origin, getCms } = ctx;
  const brand = brandName(getCms);
  const url = origin + '/catalog/' + sec.slug;
  const prices = items.map((p) => +p.price || 0).filter((n) => n > 0);
  const from = prices.length ? Math.min(...prices) : 0;
  const title = `${sec.h1} — купить в интернет-магазине | ${brand}`;
  const description = `${brand}: ${sec.what}. ${items.length} ${plural(items.length, 'товар', 'товара', 'товаров')}` +
    `${from ? `, цены от ${rub(from)} ₽` : ''}. Доставка СДЭК по России, оплата онлайн, лёгкий возврат.`;
  const head = headBlock({
    origin, url, title, description, image: items[0] && imageUrls(origin, items[0], 1)[0],
    graph: [
      {
        '@type': 'CollectionPage', '@id': url + '#page', url, name: sec.h1, description,
        mainEntity: {
          '@type': 'ItemList',
          itemListElement: items.map((p, i) => ({ '@type': 'ListItem', position: i + 1, url: origin + productPath(p), name: p.name }))
        }
      },
      crumbs(origin, [['Главная', origin + '/'], [sec.h1, url]])
    ]
  });
  const body = noscript(
    `<h1>${esc(sec.h1)}</h1>\n<p>${esc(description)}</p>\n${productList(items, origin)}\n` +
    '<p><a href="/">Главная</a></p>\n' + navLinks(ctx.list) + '\n' +
    '<p>Для заказа включите JavaScript в браузере.</p>\n' + FOOT
  );
  return { head, body };
}

/* ---------- сборка документа ---------- */

const HEAD_RE = /<!--seo:head-->[\s\S]*?<!--\/seo:head-->/;
const BODY_RE = /<!--seo:body-->[\s\S]*?<!--\/seo:body-->/;

let baseCache = { mtime: 0, text: '' };
function baseHtml() {
  const stat = fs.statSync(INDEX_FILE);
  if (baseCache.mtime !== stat.mtimeMs) baseCache = { mtime: stat.mtimeMs, text: fs.readFileSync(INDEX_FILE, 'utf8') };
  return baseCache.text;
}

function compose({ head, body, sameAs }) {
  let html = baseHtml();
  if (head) html = html.replace(HEAD_RE, () => `<!--seo:head-->\n${head}\n<!--/seo:head-->`);
  if (sameAs) {
    /* внутри <script>: «<» экранируем так же, как в остальной разметке (ld) */
    html = html.replace(/"sameAs":\[[^\]]*\]/, () => `"sameAs":${ld(sameAs)}`);
  }
  if (body) html = html.replace(BODY_RE, () => `<!--seo:body-->\n${body}\n<!--/seo:body-->`);
  return html;
}

/* Сжатые копии держим по отпечатку содержимого: сборка строки дешёвая, а
   brotli на полмегабайта — нет. Копий немного (товары × кодировки). */
const packed = new Map();
function send(req, res, html, status = 200) {
  const raw = Buffer.from(html, 'utf8');
  const etag = etagOf(raw);
  res.status(status);
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Vary', 'Accept-Encoding');
  res.setHeader('ETag', etag);
  if (status === 200 && String(req.headers['if-none-match'] || '').includes(etag)) {
    res.status(304).end();
    return;
  }
  const encoding = pickEncoding(req);
  let body = raw;
  if (encoding) {
    const key = etag + encoding;
    if (!packed.has(key)) {
      if (packed.size > 60) packed.clear();
      packed.set(key, compress(raw, encoding));
    }
    body = packed.get(key);
    res.setHeader('Content-Encoding', encoding);
  }
  res.setHeader('Content-Length', body.length);
  res.end(req.method === 'HEAD' ? undefined : body);
}

/* ---------- подключение ---------- */

function mount(app, { publicUrl, getCms }) {
  const origin = () => {
    const u = String(publicUrl || '').replace(/\/+$/, '');
    return /^https?:\/\//i.test(u) ? u : ORIGIN_FALLBACK;
  };
  const ctx = () => ({ origin: origin(), list: catalog(), getCms });

  const notFound = (req, res) => {
    const c = ctx();
    const head = headBlock({
      origin: c.origin, url: c.origin + '/', title: HOME_TITLE,
      description: 'Такой страницы нет. Luxe Canvas — базовая одежда: футболки, худи, куртки.', robots: 'noindex'
    });
    send(req, res, compose({ head }), 404);
  };

  /* главная */
  const home = (req, res) => {
    try {
      send(req, res, compose(homePage(ctx())));
    } catch (e) {
      console.error('[SEO] главная:', e && e.message);
      res.status(500).end();
    }
  };
  app.get('/', home);
  app.get('/index.html', home);

  /* товар: /product/136 или /product/136-pukhovik-zhenskiy */
  app.get('/product/:key', (req, res) => {
    try {
      const m = /^(\d+)(?:-.*)?$/.exec(req.params.key);
      const c = ctx();
      const p = m && c.list.find((x) => x.id === +m[1]);
      if (!p) return notFound(req, res);
      const want = productPath(p);
      /* другой «хвост» или его нет — один адрес на товар: 301 на основной */
      if (decodeURIComponent(req.path) !== want) {
        const q = req.url.indexOf('?') >= 0 ? req.url.slice(req.url.indexOf('?')) : '';
        return res.redirect(301, want + q);
      }
      send(req, res, compose(productPage(c, p)));
    } catch (e) {
      console.error('[SEO] товар:', e && e.message);
      res.status(500).end();
    }
  });

  /* раздел: /catalog/kurtki */
  app.get('/catalog/:slug', (req, res) => {
    try {
      const sec = sectionBySlug(req.params.slug);
      const c = ctx();
      const items = sec ? sectionProducts(c.list, sec) : [];
      if (!sec || !items.length) return notFound(req, res);
      send(req, res, compose(sectionPage(c, sec, items)));
    } catch (e) {
      console.error('[SEO] раздел:', e && e.message);
      res.status(500).end();
    }
  });

  /* карта сайта */
  app.get('/sitemap.xml', (req, res) => {
    try {
      const c = ctx();
      const dates = new Map(db.prepare('SELECT id, updated_at FROM products WHERE on_sale = 1').all()
        .map((r) => [r.id, String(r.updated_at || '').slice(0, 10)]));
      const today = new Date().toISOString().slice(0, 10);
      const last = [...dates.values()].filter(Boolean).sort().pop() || today;
      const rows = [`  <url><loc>${xml(c.origin + '/')}</loc><lastmod>${last}</lastmod></url>`];
      for (const sec of SECTIONS) {
        const items = sectionProducts(c.list, sec);
        if (!items.length) continue;
        const lm = items.map((p) => dates.get(p.id)).filter(Boolean).sort().pop() || last;
        rows.push(`  <url><loc>${xml(c.origin + '/catalog/' + sec.slug)}</loc><lastmod>${lm}</lastmod></url>`);
      }
      for (const p of c.list) {
        const imgs = imageUrls(c.origin, p, 3).map((u) => `<image:image><image:loc>${xml(u)}</image:loc></image:image>`).join('');
        const lm = dates.get(p.id);
        rows.push(`  <url><loc>${xml(c.origin + productPath(p))}</loc>${lm ? `<lastmod>${lm}</lastmod>` : ''}${imgs}</url>`);
      }
      res.type('application/xml').send(
        '<?xml version="1.0" encoding="UTF-8"?>\n' +
        '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">\n' +
        rows.join('\n') + '\n</urlset>\n'
      );
    } catch (e) {
      console.error('[SEO] sitemap:', e && e.message);
      res.status(500).end();
    }
  });
}

module.exports = { mount, slugify, SECTIONS };
