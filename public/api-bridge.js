/* Canvas — клиент к серверному API */
(function () {
  const TOKEN_KEY = 'lc_jwt';

  function getToken() {
    try { return localStorage.getItem(TOKEN_KEY) || ''; } catch (e) { return ''; }
  }
  function setToken(t) {
    try {
      if (t) localStorage.setItem(TOKEN_KEY, t);
      else localStorage.removeItem(TOKEN_KEY);
    } catch (e) {}
  }

  /* Состояние связи: страница должна честно говорить «сети нет» и
     «связь вернулась», а не молча висеть. Слушатель — в index.html. */
  const SLOW_MS = 3500;
  function netSignal(state, detail) {
    try {
      window.dispatchEvent(new CustomEvent('lc:net', {
        detail: Object.assign({ state: state }, detail || {})
      }));
    } catch (e) {}
  }

  /* На экран — только русский текст. Английское от сервера, прокси или
     хостинга («Cannot convert…», «Bad Gateway», HTML-страница 502) —
     внутреннее: человеку понятная фраза по коду ответа. */
  const RU = /[А-Яа-яЁё]/;
  function httpError(status, data) {
    const raw = String((data && data.error) || '');
    const msg = RU.test(raw) ? raw
      : status === 401 ? 'Войдите в аккаунт и повторите'
      : status === 403 ? 'Нет доступа'
      : status === 404 ? 'Не нашли — обновите страницу'
      : status === 413 ? 'Слишком большой файл'
      : status === 429 ? 'Слишком часто — подождите минуту'
      : status >= 500 ? 'Сбой на сервере — попробуйте ещё раз через минуту'
      : 'Не получилось — попробуйте ещё раз';
    const err = new Error(msg);
    err.raw = raw;
    err.status = status;
    err.data = data;
    return err;
  }

  async function api(path, opts) {
    const o = opts || {};
    const headers = Object.assign({ Accept: 'application/json' }, o.headers || {});
    if (o.body != null && !headers['Content-Type']) headers['Content-Type'] = 'application/json';
    const tok = getToken();
    if (tok) headers.Authorization = 'Bearer ' + tok;
    const started = Date.now();
    let res;
    try {
      res = await fetch(path, {
        method: o.method || 'GET',
        headers,
        credentials: 'same-origin',
        body: o.body != null ? (typeof o.body === 'string' ? o.body : JSON.stringify(o.body)) : undefined
      });
    } catch (e) {
      /* сюда попадают только сетевые сбои: HTTP-ошибки идут ниже */
      netSignal('offline', { path: path });
      const err = new Error('Нет связи с сервером');
      err.offline = true;
      throw err;
    }
    netSignal(Date.now() - started > SLOW_MS ? 'slow' : 'ok', { path: path });
    let data = null;
    try { data = await res.json(); } catch (e) { data = null; }
    if (!res.ok) throw httpError(res.status, data);
    return data;
  }

  /* ------------------------------------------------------------------
     ВИДЕО ДЛЯ ГЛАВНОЙ: оригинал байт в байт, кусками.
     fetch не умеет показывать, сколько уже ушло на сервер, — а ролик на
     сотню мегабайт без полосы прогресса выглядит как зависание. Поэтому
     куски уходят через XMLHttpRequest. Кусок, который оборвался (метро,
     смена вышки), отправляется заново с того байта, где сервер остановился.
     ------------------------------------------------------------------ */
  const MB = 1024 * 1024;
  /* Нет движения дольше этого — соединение считаем мёртвым и повторяем
     кусок. Таймаут на весь кусок не годится: на плохой связи 8 МБ честно
     идут и две минуты. */
  const STALL_MS = 45000;
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  /* у nginx по умолчанию потолок тела — 1 МБ; ниже резать незачем */
  const MIN_CHUNK = 256 * 1024;

  function abortError() {
    const e = new Error('Загрузка отменена');
    e.aborted = true;
    return e;
  }

  function putChunk(id, off, blob, onLoaded, signal) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      let last = Date.now(), dead = false;
      const watch = setInterval(() => {
        if (Date.now() - last > STALL_MS) { dead = true; xhr.abort(); }
      }, 3000);
      const onAbort = () => xhr.abort();
      const done = () => {
        clearInterval(watch);
        if (signal) signal.removeEventListener('abort', onAbort);
      };
      xhr.open('PUT', '/api/admin/video/' + encodeURIComponent(id) + '?off=' + off);
      const tok = getToken();
      if (tok) xhr.setRequestHeader('Authorization', 'Bearer ' + tok);
      xhr.setRequestHeader('Content-Type', 'application/octet-stream');
      xhr.setRequestHeader('Accept', 'application/json');
      xhr.upload.onprogress = (e) => { last = Date.now(); onLoaded(e.loaded); };
      xhr.onload = () => {
        done();
        let data = null;
        try { data = JSON.parse(xhr.responseText); } catch (e) {}
        resolve({ status: xhr.status, data });
      };
      xhr.onerror = () => { done(); reject(new Error('Нет связи с сервером')); };
      xhr.onabort = () => {
        done();
        if (dead) reject(new Error('Связь оборвалась'));
        else reject(abortError());
      };
      if (signal) {
        if (signal.aborted) { done(); reject(abortError()); return; }
        signal.addEventListener('abort', onAbort);
      }
      xhr.send(blob);
    });
  }

  /* Загрузки, брошенные из-за связи: тот же файл, выбранный снова, едет
     дальше с того места, где остановился, а не с нуля. Ключ — имя, размер
     и дата файла: другой ролик с тем же именем сюда не попадёт. */
  const resumable = new Map();
  const fileKey = (f) => [f.name || '', f.size, f.lastModified || 0].join('|');

  /* Ответ, после которого продолжать бессмысленно: файл не тот, места нет,
     прав нет. 408/409/429 — не отказ, а «попробуй ещё раз». */
  const isFinal = (e) => !!(e && e.status && ((e.status >= 400 && e.status < 500
    && e.status !== 408 && e.status !== 409 && e.status !== 429) || e.status === 507));

  /**
   * file → {url, size, type}. onProgress(отправлено, всего).
   * onState({state:'retry', attempt, max, sent, total}) — связь моргнула,
   * повторяем; {state:'ok'} — снова пошло.
   * signal (AbortController) отменяет загрузку и стирает её хвост на сервере.
   */
  async function uploadVideo(file, opts) {
    const o = opts || {};
    const signal = o.signal;
    const size = file.size;
    const key = fileKey(file);
    const MAX_FAILS = 6;
    let off = 0, fails = 0, resyncs = 0, sent = 0, shaky = false;
    const report = (n) => { sent = Math.min(size, n); if (o.onProgress) o.onProgress(sent, size); };
    const state = (s) => { if (o.onState) { try { o.onState(Object.assign({ sent, total: size }, s)); } catch (e) {} } };
    const retry = async () => {
      fails += 1;
      if (fails > MAX_FAILS) {
        const e = new Error('Связь с сервером рвётся — загрузка остановлена. Выберите тот же файл ещё раз — продолжим с того же места, лучше на Wi-Fi.');
        e.network = true;
        throw e;
      }
      shaky = true;
      state({ state: 'retry', attempt: fails + 1, max: MAX_FAILS + 1 });
      await wait(Math.min(15000, 800 * Math.pow(2, fails)));
      if (signal && signal.aborted) throw abortError();
    };
    const ok = () => {
      fails = 0;
      resyncs = 0;
      if (shaky) { shaky = false; state({ state: 'ok' }); }
    };

    let id = resumable.get(key) || '';
    let resumed = !!id;
    let chunk = 8 * MB;
    if (!id) {
      const st = await api('/api/admin/video', { method: 'POST', body: { size, name: file.name || '' } });
      id = st.id;
      chunk = st.chunk || chunk;
    }
    resumable.delete(key);
    try {
      report(0);
      for (;;) {
        while (off < size) {
          if (signal && signal.aborted) throw abortError();
          const from = off;
          const end = Math.min(size, off + chunk);
          let r;
          try {
            r = await putChunk(id, from, file.slice(from, end), (n) => report(from + n), signal);
          } catch (e) {
            if (e.aborted) throw e;
            await retry();
            continue;
          }
          const got = r.data && typeof r.data.got === 'number' ? r.data.got : null;
          if (r.status === 200 && got != null) { off = got; resumed = false; ok(); report(off); continue; }
          /* Сервер на другом байте (оборвался прошлый кусок, потерялся ответ,
             продолжаем брошенную загрузку) — это сверка, а не сбой: в лимит
             попыток не считаем, только не даём ей крутиться бесконечно. */
          if (r.status === 409 && got != null) {
            off = got;
            resumed = false;
            report(off);
            resyncs += 1;
            if (resyncs > 20) await retry();
            else await wait(300);
            continue;
          }
          /* Продолжали брошенную загрузку, а сервер её уже убрал — начинаем
             эту же загрузку заново, без ошибки для владельца. */
          if (r.status === 404 && resumed) {
            resumed = false;
            const st = await api('/api/admin/video', { method: 'POST', body: { size, name: file.name || '' } });
            id = st.id;
            chunk = st.chunk || chunk;
            off = 0;
            continue;
          }
          /* 413 не от нашего сервера (у него ответ JSON), а от прокси хостинга:
             кусок ему велик — режем пополам */
          if (r.status === 413 && !(r.data && r.data.error) && chunk > MIN_CHUNK) {
            chunk = Math.max(MIN_CHUNK, Math.floor(chunk / 2));
            continue;
          }
          /* 408 — прокси или сам Node не дождались тела: кусок на этой связи
             идёт слишком долго, берём поменьше */
          if (r.status === 408) {
            chunk = Math.max(MIN_CHUNK, Math.floor(chunk / 2));
            if (got != null) off = got;
            await retry();
            continue;
          }
          /* кусок дошёл не целиком или прокси моргнул — тот же кусок ещё раз */
          if ((r.status === 400 && got != null) || r.status === 0 || r.status === 502 || r.status === 503 || r.status === 504) {
            if (got != null) off = got;
            await retry();
            continue;
          }
          throw httpError(r.status, r.data);
        }
        /* «Готово» — последний короткий запрос. Его ответ тоже может
           потеряться; сервер повтор принимает и отдаёт ту же ссылку, так что
           повторяем, а не стираем ролик, который уже целиком на сервере. */
        let d = null, back = -1;
        for (;;) {
          if (signal && signal.aborted) throw abortError();
          try {
            d = await api('/api/admin/video/' + encodeURIComponent(id) + '/done', { method: 'POST', body: {} });
            break;
          } catch (e) {
            const got = e && e.data && typeof e.data.got === 'number' ? e.data.got : null;
            /* сервер недосчитался байтов — доотправляем их */
            if (e && e.status === 409 && got != null && got < size) { back = got; break; }
            if (isFinal(e)) throw e;
            await retry();
          }
        }
        if (back >= 0) { off = back; report(off); continue; }
        ok();
        report(size);
        return d;
      }
    } catch (e) {
      if (e && (e.aborted || isFinal(e))) {
        /* хвост незаконченной загрузки не должен лежать на диске сервера */
        window.LC.cancelVideo(id);
      } else {
        /* Связь пропала: DELETE всё равно не дойдёт, а хвост пригодится —
           тот же файл, выбранный снова, продолжит с этого места. Не
           понадобится — сервер сам перестанет держать под него место
           и уберёт его. */
        resumable.set(key, id);
      }
      throw e;
    }
  }

  window.LC = {
    api,
    getToken,
    setToken,
    async health() { return api('/api/health'); },
    /* корзина, избранное и прочие мелочи — общие для всех устройств */
    async getPrefs() { return api('/api/me/prefs'); },
    async savePrefs(data) { return api('/api/me/prefs', { method: 'PUT', body: data }); },
    /* короткие отпечатки данных: по ним видно, надо ли вообще качать каталог */
    async liveVersion() { return api('/api/live-version'); },
    async loadCatalog() {
      const d = await api('/api/catalog');
      return d.products || [];
    },
    async loadCatalogAll() {
      const d = await api('/api/catalog/all');
      return d.products || [];
    },
    async loadCms() {
      const d = await api('/api/cms');
      return d.cms;
    },
    async saveCms(cms) {
      const d = await api('/api/cms', { method: 'PUT', body: cms });
      return d.cms;
    },
    uploadVideo,
    async cancelVideo(id) {
      if (!id) return;
      try { await api('/api/admin/video/' + encodeURIComponent(id), { method: 'DELETE' }); } catch (e) {}
    },
    async me() {
      const d = await api('/api/auth/me');
      return d.user;
    },
    async register(body) {
      const d = await api('/api/auth/register', { method: 'POST', body });
      if (d.token) setToken(d.token);
      return d.user;
    },
    async login(body) {
      const d = await api('/api/auth/login', { method: 'POST', body });
      if (d.token) setToken(d.token);
      return d.user;
    },
    async loginTgAdmin(token) {
      const d = await api('/api/auth/telegram-admin', { method: 'POST', body: { token } });
      if (d.token) setToken(d.token);
      return d.user;
    },
    async logout() {
      try { await api('/api/auth/logout', { method: 'POST', body: {} }); } catch (e) {}
      setToken('');
    },
    /* Сколько будет стоить доставка — считает сервер. Клиент только
       показывает: одна и та же цифра должна попасть и на кнопку,
       и в счёт ЮKassa. */
    async deliveryQuote(body) {
      return api('/api/delivery/quote', { method: 'POST', body });
    },
    async checkout(body) {
      return api('/api/checkout', { method: 'POST', body });
    },
    async cdekCities(params) {
      const q = new URLSearchParams();
      if (typeof params === 'string') q.set('q', params);
      else Object.entries(params || {}).forEach(([k, v]) => {
        if (v !== undefined && v !== null && String(v).trim() !== '') q.set(k, String(v));
      });
      const d = await api('/api/cdek/cities' + (q.toString() ? '?' + q.toString() : ''));
      return d.cities || [];
    },
    async cdekPoints(params) {
      const q = new URLSearchParams();
      Object.entries(params || {}).forEach(([k, v]) => {
        if (v !== undefined && v !== null && String(v).trim() !== '') q.set(k, String(v));
      });
      const d = await api('/api/cdek/deliverypoints' + (q.toString() ? '?' + q.toString() : ''));
      return d.points || [];
    },
    /* Адрес курьера: что за дом под булавкой и подсказки по тексту. */
    async geoReverse(lat, lng) {
      const d = await api('/api/geo/reverse?lat=' + encodeURIComponent(lat) + '&lng=' + encodeURIComponent(lng));
      return d.place || null;
    },
    async geoSearch(q, near) {
      const p = new URLSearchParams({ q: String(q || '') });
      if (near && near.lat && near.lng) { p.set('lat', String(near.lat)); p.set('lng', String(near.lng)); }
      const d = await api('/api/geo/search?' + p.toString());
      return d.items || [];
    },
    /* Push-уведомления: ключ, подписка устройства и отписка. */
    async pushKey() {
      const d = await api('/api/push/key');
      return (d && d.key) || '';
    },
    async pushSubscribe(subscription) {
      return api('/api/push/subscribe', { method: 'POST', body: { subscription } });
    },
    async pushUnsubscribe(endpoint) {
      return api('/api/push/unsubscribe', { method: 'POST', body: { endpoint } });
    },
    async myOrders() {
      const d = await api('/api/orders/mine');
      return d.orders || [];
    },
    async getOrder(num, sync, accessToken) {
      const q = new URLSearchParams();
      if (sync) q.set('sync', '1');
      if (accessToken) q.set('t', accessToken);
      const qs = q.toString();
      const d = await api('/api/orders/' + encodeURIComponent(num) + (qs ? '?' + qs : ''));
      return d.order;
    },
    async cancelOrder(num, accessToken) {
      const d = await api('/api/orders/' + encodeURIComponent(num) + '/cancel', {
        method: 'POST',
        body: { accessToken: accessToken || '' }
      });
      return d.order;
    },
    async returnOrder(num, accessToken) {
      const d = await api('/api/orders/' + encodeURIComponent(num) + '/return', {
        method: 'POST',
        body: { accessToken: accessToken || '' }
      });
      return d.order;
    },
    async tryon(body) {
      return api('/api/tryon', { method: 'POST', body });
    },
    rememberOrderToken(num, token) {
      if (!num || !token) return;
      try { localStorage.setItem('lc_ord_t_' + num, token); } catch (e) {}
      try { sessionStorage.setItem('lc_ord_t_' + num, token); } catch (e) {}
    },
    orderToken(num) {
      try { return sessionStorage.getItem('lc_ord_t_' + num) || localStorage.getItem('lc_ord_t_' + num) || ''; } catch (e) { return ''; }
    },
    async payOrder(num, accessToken) {
      const d = await api('/api/orders/' + encodeURIComponent(num) + '/pay', {
        method: 'POST',
        body: { accessToken: accessToken || '' }
      });
      if (d && d.orderAccessToken) this.rememberOrderToken(num, d.orderAccessToken);
      return d;
    },
    async saveProduct(p) {
      if (p.id) return (await api('/api/admin/products/' + p.id, { method: 'PUT', body: p })).product;
      return (await api('/api/admin/products', { method: 'POST', body: p })).product;
    },
    async removeProduct(id) {
      return api('/api/admin/products/' + id, { method: 'DELETE' });
    },
    async adminUsers() {
      return (await api('/api/admin/users')).users || [];
    },
    async setUserAdmin(email, admin) {
      return (await api('/api/admin/users/role', { method: 'PUT', body: { email, admin } })).user;
    },
    async adminOrders() {
      const d = await api('/api/admin/orders');
      return d.orders || [];
    },
    async patchOrder(num, patch) {
      return (await api('/api/admin/orders/' + encodeURIComponent(num), { method: 'PATCH', body: patch })).order;
    },
    async loadReviews() {
      const d = await api('/api/reviews');
      return d.reviews || [];
    },
    async createReview(body) {
      const d = await api('/api/reviews', { method: 'POST', body });
      return d.review;
    },
    async voteReview(id) {
      const d = await api('/api/reviews/' + encodeURIComponent(id) + '/vote', { method: 'POST', body: {} });
      return d.review;
    },
    async deleteReview(id) {
      return api('/api/reviews/' + encodeURIComponent(id), { method: 'DELETE' });
    },
    async adminReviews() {
      const d = await api('/api/admin/reviews');
      return d.reviews || [];
    },
    async patchReview(id, patch) {
      const d = await api('/api/admin/reviews/' + encodeURIComponent(id), { method: 'PATCH', body: patch });
      return d.review;
    }
  };
})();
