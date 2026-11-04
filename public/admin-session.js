'use strict';

// The CSRF secret is bound to the HttpOnly session and stays in page memory.
(() => {
  let token = '';
  let pending = null;
  const valid = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
  async function learn(response) {
    if (response.status === 401) token = '';
    if (response.ok) {
      const body = await response.clone().json().catch(() => ({}));
      if (valid(body.csrf_token)) token = body.csrf_token;
      else if (body.authenticated === false) token = '';
    }
    return response;
  }
  async function csrfToken() {
    if (token) return token;
    if (!pending) pending = (async () => {
      await learn(await fetch('/api/admin/session', {credentials:'same-origin',cache:'no-store'}));
      return token;
    })().finally(() => { pending = null; });
    return pending;
  }
  async function adminFetch(path, options = {}) {
    const url = new URL(path, location.origin);
    if (url.origin !== location.origin || !url.pathname.startsWith('/api/admin/')) throw new Error('Địa chỉ quản trị không hợp lệ.');
    const method = (options.method || 'GET').toUpperCase();
    const headers = new Headers(options.headers);
    if (['POST','PATCH','DELETE'].includes(method) && !['/api/admin/login','/api/admin/setup','/api/admin/reset'].includes(url.pathname)) {
      headers.set('X-CSRF-Token', await csrfToken());
    }
    const response = await fetch(url, {...options,method,headers,credentials:'same-origin',cache:'no-store'});
    if (['/api/admin/session','/api/admin/login','/api/admin/setup','/api/admin/reset'].includes(url.pathname) || response.status === 401) await learn(response);
    if (url.pathname === '/api/admin/logout' && response.ok) token = '';
    if (response.status === 403) token = '';
    return response;
  }
  window.SentaiAdmin = Object.freeze({fetch:adminFetch,csrfToken});
})();
