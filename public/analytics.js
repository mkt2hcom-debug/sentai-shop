'use strict';

(() => {
  const sessionKey = 'sentai-analytics-session-v1';
  const sessionLifetime = 30 * 60 * 1000;
  const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  let memorySession = null;
  let currentView = null;
  let lastTrackedKey = '';
  let restoring = false;
  let lastActivityWrite = 0;

  function permitted() {
    return navigator.globalPrivacyControl !== true
      && !['1', 'yes'].includes(String(navigator.doNotTrack || window.doNotTrack || '').toLowerCase())
      && !/bot|crawler|spider|facebookexternalhit|preview/i.test(navigator.userAgent || '');
  }
  function uuid() {
    try {
      if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
      const bytes = crypto.getRandomValues(new Uint8Array(16));
      bytes[6] = (bytes[6] & 15) | 64;
      bytes[8] = (bytes[8] & 63) | 128;
      const hex = [...bytes].map(value => value.toString(16).padStart(2, '0')).join('');
      return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
    } catch { return null; }
  }
  function validSession(value, now) {
    return value && uuidPattern.test(value.id) && Number.isFinite(value.last_seen)
      && value.last_seen <= now && now - value.last_seen < sessionLifetime;
  }
  function readSession(now) {
    try {
      const stored = JSON.parse(localStorage.getItem(sessionKey) || 'null');
      if (validSession(stored, now)) return stored;
    } catch { /* Storage can be unavailable in a private browser. */ }
    return validSession(memorySession, now) ? memorySession : null;
  }
  function saveSession(session) {
    memorySession = session;
    try { localStorage.setItem(sessionKey, JSON.stringify(session)); } catch { /* Keep an in-memory session. */ }
  }
  function visitId() {
    const now = Date.now();
    const session = readSession(now) || {id: uuid(), last_seen: now};
    if (!session.id) return null;
    session.last_seen = now;
    saveSession(session);
    lastActivityWrite = now;
    return session.id;
  }
  function matchesPage(view) {
    if (view.page_type === 'home') return location.pathname === '/' || location.pathname === '/index.html';
    if (!/^\/products\/[\w-]+\/?$/.test(location.pathname)) return false;
    const selected = new URLSearchParams(location.search).get('variant');
    return !selected || selected === view.product_id;
  }
  async function send(payload, retried = false) {
    if (!permitted()) return;
    let retry = false;
    try {
      const response = await fetch('/api/analytics/view', {
        method: 'POST', credentials: 'same-origin', keepalive: true,
        headers: {'Content-Type': 'application/json'}, body: JSON.stringify(payload)
      });
      retry = response.status >= 500;
    } catch { retry = true; }
    // A retry is the same event, so the SQL unique key prevents double counting.
    if (retry && !retried) setTimeout(() => { void send(payload, true); }, 1200);
  }
  function flush() {
    try {
      if (!currentView || document.visibilityState !== 'visible' || document.prerendering || !permitted() || !matchesPage(currentView)) return;
      const key = `${currentView.page_type}:${currentView.product_id || ''}`;
      if (key === lastTrackedKey && !restoring) return;
      const eventId = uuid();
      const sessionId = visitId();
      if (!eventId || !sessionId) return;
      lastTrackedKey = key;
      restoring = false;
      void send({event_id: eventId, visit_id: sessionId, ...currentView});
    } catch { /* Analytics must never interrupt shopping. */ }
  }
  function view(pageType, productId) {
    try {
      if (!permitted() || !['home', 'product'].includes(pageType)) return;
      if (pageType === 'product' && (typeof productId !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(productId))) return;
      currentView = pageType === 'home' ? {page_type: 'home'} : {page_type: 'product', product_id: productId};
      flush();
    } catch { /* Optional, first-party measurement only. */ }
  }
  function activity() {
    if (!currentView || !permitted() || document.visibilityState !== 'visible') return;
    const now = Date.now();
    if (now - lastActivityWrite < 60000) return;
    lastActivityWrite = now;
    const session = readSession(now);
    if (session) saveSession({...session, last_seen: now});
  }
  window.SentaiAnalytics = Object.freeze({
    view,
    clear() { currentView = null; restoring = false; }
  });
  document.addEventListener('visibilitychange', flush);
  document.addEventListener('prerenderingchange', flush);
  window.addEventListener('pageshow', event => {
    if (!event.persisted || !currentView) return;
    restoring = true;
    // Allow the page's popstate handler to restore the selected physical item first.
    setTimeout(flush, 0);
  });
  for (const name of ['pointerdown', 'keydown', 'scroll']) document.addEventListener(name, activity, {passive: true, capture: true});
})();
