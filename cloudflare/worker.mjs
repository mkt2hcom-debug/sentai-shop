import { fail, HttpError, json, first, setAuthCheck } from './common.mjs';
import { verifySession, handleAuth, checkCSRF, assertIdentity, authorizedDatabase, rateLimit } from './auth.mjs';
import { handleCommerce, getProductPage } from './commerce.mjs';
import { handleAnalytics } from './analytics.mjs';
import { handlePrices } from './prices.mjs';
import { handleMedia, cleanupMedia } from './media.mjs';

function secure(response, url, requestId) {
  const headers = new Headers(response.headers);
  const settings = {
    'X-Content-Type-Options':'nosniff', 'Referrer-Policy':'no-referrer', 'X-Frame-Options':'DENY',
    'Cross-Origin-Resource-Policy':'same-origin', 'Cross-Origin-Opener-Policy':'same-origin',
    'Permissions-Policy':'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
    'Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; font-src 'self'; connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
    'X-Request-Id':requestId
  };
  for (const [name, value] of Object.entries(settings)) headers.set(name, value);
  if (url.protocol === 'https:') headers.set('Strict-Transport-Security', 'max-age=31536000');
  if (url.pathname.startsWith('/admin') || url.pathname.startsWith('/api/')) headers.set('Cache-Control', 'no-store');
  return new Response(response.body, {status:response.status, statusText:response.statusText, headers});
}
async function audit(db, path, method, status) {
  if (!path.startsWith('/api/admin/') || !(['POST','PATCH','DELETE'].includes(method) || [401,403,429].includes(status))) return;
  const route = path.match(/^\/api\/admin\/(session|login|logout|setup|reset|products|orders|media|prices|analytics|security)(?:\/|$)/)?.[1] || 'unknown';
  const resource = path.match(/^\/api\/admin\/(?:products|orders|media)\/(sentai-row-\d{1,6}|[a-f0-9-]{36})(?:\/|$)/)?.[1] || route;
  const event = route === 'logout' ? 'auth.logout' : status >= 400 ? 'admin.denied' : 'admin.changed';
  await db.batch([
    db.prepare('INSERT INTO security_events(event,method,resource,status,created_at) VALUES(?,?,?,?,?)').bind(event, method, resource, status, new Date().toISOString()),
    db.prepare('DELETE FROM security_events WHERE id <= (SELECT id FROM security_events ORDER BY id DESC LIMIT 1 OFFSET 10000)')
  ]);
}
async function route(request, env, url) {
  const path = url.pathname;
  if (!['GET','HEAD','POST','PATCH','DELETE'].includes(request.method)) fail(405, 'Phương thức không được hỗ trợ.');
  if (url.protocol !== 'https:' && !['localhost','127.0.0.1','[::1]'].includes(url.hostname)) fail(426, 'Cần kết nối HTTPS.');
  if (env.PUBLIC_ORIGIN && url.origin !== env.PUBLIC_ORIGIN) fail(403, 'Địa chỉ cửa hàng không hợp lệ.');
  if (['POST','PATCH','DELETE'].includes(request.method)) {
    const origin = request.headers.get('origin');
    if (request.headers.get('sec-fetch-site') === 'cross-site' || (origin && origin !== url.origin)) fail(403, 'Nguồn yêu cầu không hợp lệ.');
  }
  if (path === '/api/health' && request.method === 'GET') {
    await first(env.DB, 'SELECT 1 AS ready FROM products LIMIT 1');
    return json({ok:true});
  }
  if (path.startsWith('/api/admin/')) {
    const auth = await handleAuth(request, env, url);
    if (auth) return auth;
    const identity = await verifySession(request, env);
    if (!identity) fail(401, 'Vui lòng đăng nhập quản trị.');
    if (['POST','PATCH','DELETE'].includes(request.method)) checkCSRF(request, identity);
    const check = () => assertIdentity(env.DB, identity);
    setAuthCheck(request, check);
    const adminEnv = {...env, DB:authorizedDatabase(env.DB, identity), assertAuthorized:check};
    if (path === '/api/admin/security/events' && request.method === 'GET') {
      const events = (await adminEnv.DB.prepare('SELECT event,method,resource,status,created_at FROM security_events ORDER BY id DESC LIMIT 100').all()).results;
      await check(); return json({events});
    }
    for (const handler of [handleMedia, handleCommerce, handleAnalytics, handlePrices]) {
      const response = await handler(request, adminEnv, url);
      if (response) { await check(); return response; }
    }
    fail(404, 'Không tìm thấy API quản trị.');
  }
  if (path === '/api/analytics/view' && request.method === 'POST') {
    if (request.headers.get('dnt') !== '1' && request.headers.get('sec-gpc') !== '1' && !/bot\b|crawler|spider|preview|facebookexternalhit/i.test(request.headers.get('user-agent') || '')) await rateLimit(request, env, 'analytics', 300, 60000);
    return handleAnalytics(request, env, url);
  }
  if (path === '/api/orders' && request.method === 'POST') await rateLimit(request, env, 'orders', 30, 3600000);
  const commerce = path.startsWith('/api/') ? await handleCommerce(request, env, url) : null;
  if (commerce) return commerce;
  if (path.startsWith('/api/')) fail(404, 'Không tìm thấy API.');
  if (!['GET','HEAD'].includes(request.method)) fail(405, 'Phương thức không được hỗ trợ.');
  if (path.startsWith('/media/')) return await handleMedia(request, env, url) || json({error:'Không tìm thấy tập tin.'}, 404);
  let decoded;
  try { decoded = decodeURIComponent(path); } catch { fail(400, 'Đường dẫn không hợp lệ.'); }
  if (decoded.includes('\\') || decoded.includes('\0') || decoded.split('/').some(part => part.startsWith('.'))) fail(404, 'Không tìm thấy trang.');
  const product = decoded.match(/^\/products\/([\w-]+)\/?$/);
  if (product && !await getProductPage(env.DB, product[1], url.searchParams.get('variant'))) fail(404, 'Không tìm thấy mẫu hoặc món hàng đã chọn.');
  const target = decoded === '/' ? '/index.html' : ['/admin','/admin/'].includes(decoded) ? '/admin.html'
    : ['/admin/analytics','/admin/analytics/'].includes(decoded) ? '/admin-analytics.html'
    : ['/admin/prices','/admin/prices/'].includes(decoded) ? '/admin-prices.html'
    : /^\/admin\/products\/[\w-]+\/?$/.test(decoded) ? '/admin-media.html'
    : product ? '/product.html' : decoded;
  const assetUrl = new URL(url); assetUrl.pathname = target; assetUrl.search = '';
  return env.ASSETS.fetch(new Request(assetUrl, {method:request.method}));
}
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url), requestId = crypto.randomUUID();
    let response;
    try { response = await route(request, env, url); }
    catch (error) {
      const known = error instanceof HttpError;
      if (!known) console.error('Request failed', requestId, error.name);
      response = json({error:known ? error.message : 'Máy chủ gặp lỗi. Vui lòng thử lại.', ...(known && error.code ? {code:error.code} : {})}, known ? error.status : 500);
    }
    ctx.waitUntil(audit(env.DB, url.pathname, request.method, response.status).catch(() => console.error('Audit unavailable', requestId)));
    return secure(response, url, requestId);
  },
  async scheduled(_controller, env) {
    const now = Date.now();
    await env.DB.batch([
      env.DB.prepare('DELETE FROM cf_rate_limits WHERE expires_at<?').bind(now),
      env.DB.prepare('DELETE FROM cf_revoked_tokens WHERE expires_at<?').bind(now),
      env.DB.prepare('DELETE FROM cf_admin_sessions WHERE expires_at<? OR last_seen_at<?').bind(now,now-900000),
      env.DB.prepare('DELETE FROM cf_admin_grants WHERE expires_at<?').bind(now),
      env.DB.prepare('DELETE FROM cf_auth_challenges WHERE expires_at<?').bind(now)
    ]);
    await cleanupMedia(env);
  }
};
