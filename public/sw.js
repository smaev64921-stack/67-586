/* ==========================================================================
   Service worker магазина Canvas.

   ГЛАВНОЕ ПРАВИЛО, от которого здесь всё пляшет: страница и фирменные файлы
   НИКОГДА не отдаются из кэша, пока есть сеть. Мы уже обжигались на кэше —
   логотип заменили, а у всех, кто заходил раньше, ещё неделю висел старый.
   Service worker умеет сделать то же самое, только навсегда и без права
   на ошибку: пока он не обновится, покупатель будет видеть старый магазин.
   Поэтому сеть в приоритете, а кэш — только запасной аэродром для офлайна.

   Из кэша сразу отдаём лишь фото товаров: они лежат по адресам с хешем
   содержимого и под тем же именем не меняются в принципе. Шрифты — почти:
   имена у них постоянные, поэтому им отдельное правило (см. ниже).

   ВЕРСИЯ. Меняется при каждой правке этого файла. На активации всё, что не
   совпадает с текущей версией, стирается — так старый кэш не накапливается.

   ЕСЛИ ЧТО-ТО ПОЙДЁТ НЕ ТАК. Заменить тело файла на
     self.addEventListener('install', () => self.skipWaiting());
     self.addEventListener('activate', async () => {
       await self.registration.unregister();
       (await caches.keys()).forEach((k) => caches.delete(k));
     });
   и выложить. Все установленные копии сами себя снимут при следующем заходе.
   Работает это только потому, что сервер отдаёт /sw.js с no-cache.
   ========================================================================== */

const VERSION = 'canvas-v1';
/* Сколько ждём сеть на переходе, прежде чем показать сохранённую копию.
   Меньше — чаще будет мелькать вчерашняя версия; больше — дольше висит
   заставка на плохой связи. Три с половиной секунды — заметно, но терпимо. */
const SLOW_MS = 3500;
const CACHE = VERSION;

/* Оболочка магазина. Ровно один адрес: приложение одностраничное, и любой
   его экран разбирается на клиенте по хешу. */
const SHELL = '/';

/* Отдельные страницы вне приложения. Их держим под собственными ключами:
   подменять их оболочкой магазина нельзя (см. NAV_PAGES ниже). */
const STANDALONE_PAGES = ['/onboarding.html'];

/* Приятно иметь офлайн, но не обязательно: если что-то не доедет, установка
   всё равно состоится. А вот сама оболочка — обязательна. */
const OPTIONAL = [
  '/api-bridge.js',
  '/logo.png?v=lc2',
  '/logo-white.png?v=lc2',
  '/favicon.svg?v=lc2',
  '/icon-192.png',
  '/manifest.webmanifest',
  '/fonts/onest-var-cyrillic.woff2',
  '/fonts/onest-var-latin.woff2'
].concat(STANDALONE_PAGES);

/** Корень — единственный адрес, за которым стоит оболочка приложения. */
function isShell(url) {
  return url.pathname === '/' || url.pathname === '/index.html';
}

/** Своя страница, у которой должна быть своя офлайн-копия, а не оболочка. */
function isOwnPage(url) {
  return STANDALONE_PAGES.indexOf(url.pathname) !== -1;
}

/** Ответ, который не стыдно положить в кэш. */
function cacheable(res) {
  return res && res.status === 200 && res.type === 'basic';
}

function offlinePage() {
  return new Response(
    '<!doctype html><meta charset="utf-8"><title>Нет сети</title>' +
    '<body style="margin:0;display:grid;place-items:center;height:100vh;' +
    'font:16px system-ui;background:#f4f4f4;color:#0b0b0b">Нет сети. Откройте позже.',
    { headers: { 'Content-Type': 'text/html; charset=utf-8' }, status: 503 }
  );
}

self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    const c = await caches.open(CACHE);
    /* Оболочка обязана лечь в кэш, и её ошибку мы НЕ глушим. Иначе установка
       в лифте или метро пройдёт с пустым кэшем, activate снесёт прежний
       рабочий — и офлайн сломается совсем, вместо того чтобы просто
       отложиться до следующего раза. */
    await c.add(SHELL);
    await Promise.all(OPTIONAL.map((u) => c.add(u).catch(() => {})));
    /* Не ждём закрытия вкладок: страница сама спросит покупателя, обновляться
       ли сейчас, и только тогда пришлёт SKIP_WAITING. */
  })());
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)));
    /* Навигационная предзагрузка: браузер начинает грузить страницу параллельно
       со стартом воркера, иначе первый заход после сна ждёт его пробуждения. */
    if (self.registration.navigationPreload) {
      await self.registration.navigationPreload.enable().catch(() => {});
    }
    await self.clients.claim();
  })());
});

self.addEventListener('message', (e) => {
  if (e.data === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;      /* чужие домены не трогаем */
  if (url.pathname.startsWith('/api/')) return;          /* заказы и каталог — всегда живьём */
  if (url.pathname.startsWith('/media/o/')) return;      /* вложения заказов */
  if (req.headers.has('range')) return;                  /* куски видео кэшировать нечем */

  /* --- фото товаров: имя содержит хеш содержимого, можно смело из кэша --- */
  if (url.pathname.startsWith('/media/')) {
    e.respondWith((async () => {
      const hit = await caches.match(req);
      if (hit) return hit;
      const res = await fetch(req);
      if (cacheable(res)) {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
      }
      return res;
    })());
    return;
  }

  /* --- шрифты: из кэша мгновенно, но следом тихо проверяем обновление ---
     Имена у шрифтов постоянные, без хеша. Пересоберём сабсет под тем же
     именем — при обычном «сначала кэш» покупатель остался бы со старым
     навсегда. Так он увидит новый со второго захода, а не никогда. */
  if (url.pathname.startsWith('/fonts/')) {
    e.respondWith((async () => {
      const hit = await caches.match(req);
      const net = fetch(req).then((res) => {
        if (cacheable(res)) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
        }
        return res;
      }).catch(() => null);
      if (hit) { e.waitUntil(net); return hit; }
      const res = await net;
      return res || offlinePage();
    })());
    return;
  }

  /* --- переходы по страницам: только сеть, кэш лишь когда сети нет --- */
  if (req.mode === 'navigate') {
    e.respondWith((async () => {
      const shell = isShell(url);
      const own = isOwnPage(url);
      try {
        const pre = await e.preloadResponse;
        /* Таймаут обязателен. Без него на плохой связи fetch висит десятки
           секунд, а человек всё это время смотрит на чёрную заставку и думает,
           что приложение зависло. Есть сохранённая копия — показываем её через
           SLOW_MS, а сеть дослушиваем в фоне и обновляем кэш к следующему разу. */
        const saved0 = shell ? await caches.match(SHELL) : null;
        const net = pre ? Promise.resolve(pre) : fetch(req);
        let res;
        if (saved0) {
          const slow = new Promise((r) => setTimeout(() => r(null), SLOW_MS));
          res = await Promise.race([net.catch(() => null), slow]);
          if (!res) {
            e.waitUntil(net.then((r) => {
              if (cacheable(r)) return caches.open(CACHE).then((c) => c.put(SHELL, r.clone()));
            }).catch(() => {}));
            return saved0;
          }
        } else {
          res = await net;
        }
        /* Владелец нажал «Обновить из Git» — сервер перезапускается несколько
           секунд и прокси отдаёт 502. Показывать покупателю страницу ошибки,
           когда у нас лежит рабочая копия магазина, незачем. */
        if (res && res.status >= 500) {
          const saved = await caches.match(shell ? SHELL : req);
          if (saved) return saved;
        }
        if (cacheable(res)) {
          const copy = res.clone();
          /* Кладём ТОЛЬКО известные адреса и каждый под своим ключом.
             Раньше сюда шло `put('/')` для любого перехода — и офлайн-оболочкой
             магазина становилась последняя открытая страница, хоть /reset.html.
             Сервер к тому же отдаёт index.html на любой неизвестный путь, так
             что без этой проверки кэш пух бы от адресов вида /что-угодно. */
          if (shell) caches.open(CACHE).then((c) => c.put(SHELL, copy)).catch(() => {});
          else if (own) caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
        }
        return res;
      } catch (_) {
        /* Оболочку отдаём только за корень. Подставлять её на /onboarding.html
           нельзя: скрипт в шапке магазина, не найдя отметки о знакомстве,
           сам уводит на /onboarding.html — и получалась бы вечная петля. */
        const saved = await caches.match(shell ? SHELL : req);
        return saved || offlinePage();
      }
    })());
    return;
  }

  /* --- всё прочее (знак, иконки, манифест, скрипты): сеть, кэш в запасе --- */
  e.respondWith((async () => {
    try {
      const res = await fetch(req);
      /* Страницу здесь не кладём. Ветка выше уже хранит её единственной копией
         под ключом «/», а сюда попадают адреса вида /?v=1 и /?ping=2 — каждый
         осел бы в кэше отдельной копией на 600 КБ, и хранилище пухло бы вечно. */
      const isHtml = /text\/html/i.test(res.headers.get('content-type') || '');
      if (cacheable(res) && !isHtml) {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
      }
      return res;
    } catch (_) {
      const hit = await caches.match(req);
      if (hit) return hit;
      throw new Error('нет сети и нет копии: ' + url.pathname);
    }
  })());
});
