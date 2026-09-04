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
    if (!res.ok) {
      const err = new Error((data && data.error) || ('Ошибка ' + res.status));
      err.status = res.status;
      err.data = data;
      throw err;
    }
    return data;
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
