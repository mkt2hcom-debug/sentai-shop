import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { request as requestHTTP } from 'node:http';
import { test } from 'node:test';
import { createApp } from '../server.mjs';
import { ROOT, syncCatalog, getOrder } from '../lib/database.mjs';
import { createAdminAuth } from '../lib/admin-auth.mjs';

const ADMIN_PASSWORD = 'sentai-test-admin-password';
const SOURCE = JSON.parse(readFileSync(resolve(ROOT, 'data/catalog.json'), 'utf8'));

async function fixture(t, options = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'sentai-test-'));
  const dbPath = join(directory, 'shop.sqlite');
  const running = [];
  async function launch() {
    const app = createApp({ dbPath, adminPassword: ADMIN_PASSWORD, ...options });
    let closed = false;
    await new Promise((accept, reject) => {
      app.server.once('error', reject);
      app.server.listen(0, '127.0.0.1', accept);
    });
    const base = `http://127.0.0.1:${app.server.address().port}`;
    const close = async () => {
      if (closed) return;
      closed = true;
      app.server.closeAllConnections();
      await new Promise((accept, reject) => app.server.close(error => error ? reject(error) : accept()));
      await app.media.close();
      app.db.close();
    };
    const api = async (path, { method = 'GET', body, headers = {} } = {}) => {
      const response = await fetch(base + path, {
        method,
        headers: { ...(options.publicOrigin ? {'X-Forwarded-Proto':'https'} : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return { status: response.status, headers: response.headers, body: await response.json() };
    };
    const state = { ...app, base, api, close, reopen: launch, directory };
    running.push(state);
    return state;
  }
  t.after(async () => {
    for (const state of running) await state.close();
    // Only delete the unique test directory created above, never project data.
    assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep));
    assert.ok(directory.includes('sentai-test-'));
    rmSync(directory, { recursive: true, force: true });
  });
  return launch();
}

function orderRequest(overrides = {}) {
  return {
    customer: {
      name: 'Khách thử nghiệm', phone: '0901234567', email: 'test@example.com',
      address: '123 Đường thử nghiệm, Quận 1, TP. Hồ Chí Minh', note: 'Đơn kiểm thử',
    },
    items: [{ product_id: 'sentai-row-2', quantity: 1 }],
    idempotency_key: randomUUID(),
    ...overrides,
  };
}

async function login(app) {
  const response = await app.api('/api/admin/login', { method: 'POST', body: {username:'admin',password: ADMIN_PASSWORD } });
  assert.equal(response.status, 200);
  const header = response.headers.get('set-cookie');
  assert.match(header, /HttpOnly/);
  assert.match(header, /SameSite=Strict/);
  assert.match(header, /Path=\/api\/admin/);
  assert.match(response.body.csrf_token,/^[a-f0-9]{64}$/);
  return { Cookie: header.split(';')[0], 'X-CSRF-Token':response.body.csrf_token };
}

test('account login requires a username and local one-time recovery revokes old sessions without losing shop data', async t => {
  const app = await fixture(t,{adminPassword:''});
  const setup = await app.api('/api/admin/setup',{method:'POST',body:{username:'admin',password:ADMIN_PASSWORD}});
  assert.equal(setup.status,201);
  const oldSession = {Cookie:setup.headers.get('set-cookie').split(';')[0],'X-CSRF-Token':setup.body.csrf_token};
  assert.equal((await app.api('/api/admin/login',{method:'POST',body:{password:ADMIN_PASSWORD}})).status,401);
  assert.equal((await app.api('/api/admin/login',{method:'POST',body:{username:'another-user',password:ADMIN_PASSWORD}})).status,401);
  assert.equal((await app.api('/api/admin/login',{method:'POST',body:{username:' ADMIN ',password:ADMIN_PASSWORD}})).status,200);
  const order = await app.api('/api/orders',{method:'POST',body:orderRequest()});
  assert.equal(order.status,201);
  const products = app.db.prepare('SELECT * FROM products ORDER BY id').all();
  const account = createAdminAuth({db:app.db});
  const recovery = account.issueRecovery();
  const body = {token:recovery.token,username:'shop.owner',password:'new-private-owner-password'};
  for (const headers of [{Origin:'https://foreign.invalid'},{'X-Forwarded-For':'203.0.113.1'},{Forwarded:'for=203.0.113.1'}]) {
    assert.equal((await app.api('/api/admin/reset',{method:'POST',headers,body})).status,403,JSON.stringify(headers));
  }
  // fetch normalizes Host; use an actual HTTP request to verify host validation.
  const foreignHost = await new Promise((resolve,reject)=>{
    const request = requestHTTP(app.base+'/api/admin/reset',{method:'POST',headers:{Host:'foreign.invalid','Content-Type':'application/json'}},response=>{
      response.resume();response.on('end',()=>resolve(response.statusCode));
    });
    request.on('error',reject);request.end(JSON.stringify(body));
  });
  assert.equal(foreignHost,403);
  assert.equal((await app.api('/api/admin/reset',{method:'POST',body:{...body,token:'X'.repeat(43)}})).status,401);
  assert.equal((await app.api('/api/admin/orders',{headers:oldSession})).status,200,'issuing a reset link does not reset the account yet');
  const result = await app.api('/api/admin/reset',{method:'POST',body});
  assert.equal(result.status,200);
  assert.equal(result.body.username,'shop.owner');
  const newSession = {Cookie:result.headers.get('set-cookie').split(';')[0],'X-CSRF-Token':result.body.csrf_token};
  assert.equal((await app.api('/api/admin/orders',{headers:oldSession})).status,401);
  assert.equal((await app.api('/api/admin/orders',{headers:newSession})).body.orders.length,1);
  assert.equal((await app.api('/api/admin/reset',{method:'POST',body})).status,401,'used token cannot be replayed');
  assert.equal((await app.api('/api/admin/login',{method:'POST',body:{username:'admin',password:ADMIN_PASSWORD}})).status,401);
  assert.equal((await app.api('/api/admin/login',{method:'POST',body:{username:body.username,password:body.password}})).status,200);
  assert.deepEqual(app.db.prepare('SELECT * FROM products ORDER BY id').all(),products);
  assert.equal(app.db.prepare('SELECT COUNT(*) n FROM admin_recovery').get().n,0);
  await app.close();
  const reopened = await app.reopen();
  assert.equal((await reopened.api('/api/admin/login',{method:'POST',body:{username:body.username,password:body.password}})).status,200);
  assert.equal(reopened.db.prepare('SELECT COUNT(*) n FROM orders').get().n,1);
});

test('administrator recovery is unavailable on public-origin deployment and invalidates sessions changed through local SQL recovery', async t => {
  const publicApp = await fixture(t,{adminPassword:'',publicOrigin:'https://sentai.example'});
  const publicAccount = createAdminAuth({db:publicApp.db});
  await publicAccount.setup({username:'admin',password:ADMIN_PASSWORD});
  const recovery = publicAccount.issueRecovery();
  assert.equal((await publicApp.api('/api/admin/reset',{method:'POST',headers:{Origin:'https://sentai.example'},body:{token:recovery.token,username:'admin',password:'another-local-password'}})).status,403);
  const app = await fixture(t,{adminPassword:''});
  const account = createAdminAuth({db:app.db});
  await account.setup({username:'admin',password:ADMIN_PASSWORD});
  const headers = await login(app);
  const token = account.issueRecovery().token;
  await account.reset({token,username:'admin',password:'changed-by-owner-locally'});
  assert.equal((await app.api('/api/admin/session',{headers})).body.authenticated,false);
  assert.equal((await app.api('/api/admin/products',{headers})).status,401);
});

test('analytics accepts anonymous views once, protects reports and keeps page/product counts separate', async t => {
  const app = await fixture(t);
  const visit = randomUUID();
  const home = {event_id:randomUUID(),visit_id:visit,page_type:'home'};
  const first = {event_id:randomUUID(),visit_id:visit,page_type:'product',product_id:'sentai-row-84'};
  const second = {...first,event_id:randomUUID(),product_id:'sentai-row-85'};
  for (const body of [home,first,second,second]) {
    const result = await app.api('/api/analytics/view',{method:'POST',body});
    assert.equal(result.status,202);
    assert.equal(result.body.accepted,true);
  }
  assert.equal((await app.api('/api/admin/analytics')).status,401);
  const headers = await login(app);
  const report = await app.api('/api/admin/analytics?group=products&sort=views&direction=desc',{headers});
  assert.equal(report.status,200);
  assert.deepEqual(report.body.summary,{page_views:3,product_views:2,visits:1});
  assert.equal(report.body.total_rows,1);
  assert.equal(report.body.rows[0].name,'Blue Ressha');
  assert.equal(report.body.rows[0].views,2);
  const units = await app.api('/api/admin/analytics?group=units',{headers});
  assert.deepEqual(new Set(units.body.rows.map(row=>row.product_id)),new Set(['sentai-row-84','sentai-row-85']));
  const pages = await app.api('/api/admin/analytics?group=pages',{headers});
  assert.equal(pages.body.total_rows,2);
  assert.ok(pages.body.rows.some(row=>row.path === '/'));
  assert.match(report.headers.get('cache-control'),/no-store/);
  assert.equal((await app.api('/api/analytics/view',{method:'POST',body:{...first,event_id:randomUUID()},headers:{Origin:'https://another-site.invalid'}})).status,403);
  assert.equal((await app.api('/api/analytics/view',{method:'POST',body:{...first,event_id:randomUUID()},headers:{'Sec-Fetch-Site':'cross-site'}})).status,403);
  assert.equal((await app.api('/api/analytics/view',{method:'POST',body:{...first,event_id:randomUUID(),product_id:'missing-product'}})).status,404);
  assert.equal((await app.api('/api/admin/analytics?from=2026-02-30',{headers})).status,400);
  assert.equal((await app.api('/api/admin/analytics?sort=views%3BDROP%20TABLE%20products',{headers})).status,400);
  for (const ignoreHeaders of [{'DNT':'1'},{'Sec-GPC':'1'},{'User-Agent':'ExampleBot/1.0'}]) {
    const ignored = await app.api('/api/analytics/view',{method:'POST',body:{...home,event_id:randomUUID()},headers:ignoreHeaders});
    assert.equal(ignored.status,202);
    assert.equal(ignored.body.accepted,false);
  }
  await app.api('/api/catalog');
  await app.api('/api/products/sentai-row-84');
  assert.equal((await fetch(app.base+'/',{method:'HEAD'})).status,200);
  assert.equal((await fetch(app.base+'/admin/analytics')).status,200);
  assert.equal((await app.api('/api/admin/analytics',{headers})).body.summary.page_views,3,'API, static requests and excluded clients do not add views');
  assert.equal(app.db.prepare('SELECT COUNT(*) n FROM products').get().n,144);
  assert.equal(app.db.prepare('SELECT COUNT(*) n FROM orders').get().n,0);
  await app.close();
  const reopened = await app.reopen();
  const restored = await reopened.api('/api/admin/analytics',{headers:await login(reopened)});
  assert.deepEqual(restored.body.summary,report.body.summary);
  assert.equal(restored.body.started_at,report.body.started_at);
});

test('analytics ingestion is rate limited independently of authenticated report access', async t => {
  const app = await fixture(t);
  const body = {event_id:randomUUID(),visit_id:randomUUID(),page_type:'home'};
  for (let i=0;i<300;i++) assert.equal((await app.api('/api/analytics/view',{method:'POST',body})).status,202);
  assert.equal((await app.api('/api/analytics/view',{method:'POST',body})).status,429);
  const report = await app.api('/api/admin/analytics',{headers:await login(app)});
  assert.equal(report.status,200);
  assert.equal(report.body.summary.page_views,1);
});

test('SQL catalog preserves all source products, unit prices, condition and embedded images', async t => {
  const app = await fixture(t);
  const health = await app.api('/api/health');
  assert.equal(health.status, 200);
  assert.equal(health.body.ok, true);
  const response = await app.api('/api/catalog');
  assert.equal(response.status, 200);
  assert.equal(response.body.products.length, 144);
  assert.equal(new Set(response.body.products.map(p => p.id)).size, 144);
  assert.equal(response.body.metadata.source_sha256, SOURCE.metadata.source_sha256);
  for (const original of SOURCE.products) {
    const actual = response.body.products.find(p => p.id === original.id);
    for (const key of ['name', 'series', 'condition', 'description', 'price_vnd', 'availability', 'source_sheet', 'source_row']) {
      assert.deepEqual(actual[key], original[key], `${original.id}.${key}`);
    }
    assert.deepEqual(actual.images, original.images);
    for (const image of actual.images) assert.ok(readFileSync(resolve(ROOT, 'public', '.' + image)).length > 0);
  }
  const first = response.body.products.find(p => p.id === 'sentai-row-2');
  assert.equal(first.price_vnd, 600000, 'use unit price I, not the 1,200,000 total in J');
  const sold = response.body.products.find(p => p.id === 'sentai-row-26');
  assert.equal(sold.availability, 'sold_out');
  assert.equal(sold.price_vnd, 660000);
  assert.equal(response.body.products.filter(p => p.price_vnd === null).length, 118);
  const photo = await fetch(app.base + first.images[0]);
  assert.equal(photo.status, 200);
  assert.match(photo.headers.get('content-type'), /^image\//);
  assert.deepEqual(Buffer.from(await photo.arrayBuffer()), readFileSync(resolve(ROOT, 'public', '.' + first.images[0])));
});

test('checkout calculates price on server, stores SQL snapshots, and survives restart', async t => {
  const app = await fixture(t);
  const payload = orderRequest({
    total: 1, subtotal: 1, status: 'completed', payment_method: 'paid',
    items: [{ product_id: 'sentai-row-2', quantity: 1, unit_price: 1, line_total: 1 },{ product_id: 'sentai-row-3', quantity: 1, unit_price: 1, line_total: 1 }],
  });
  const response = await app.api('/api/orders', { method: 'POST', body: payload });
  assert.equal(response.status, 201);
  const order = response.body.order;
  assert.equal(order.total, 1200000);
  assert.equal(order.subtotal, 1200000);
  assert.equal(order.items[0].unit_price, 600000);
  assert.equal(order.items[0].line_total, 600000);
  assert.equal(order.status, 'pending');
  assert.equal(order.payment_method, 'cod');
  assert.match(order.order_number, /^ST-\d{8}-[A-F0-9]{8}$/);
  for (const key of ['customer_name', 'customer_phone', 'customer_email', 'customer_address', 'note', 'request_hash', 'idempotency_key']) {
    assert.equal(Object.hasOwn(order, key), false, `${key} must not leak in public response`);
  }
  const stored = app.db.prepare('SELECT customer_name,customer_phone,customer_email,customer_address,note FROM orders WHERE id=?').get(order.id);
  for (const [key,value] of Object.entries(stored)) assert.match(value,/^enc:v1:/,`${key} must be encrypted in SQL`);
  const decrypted = getOrder(app.db,order.id);
  for (const [field,source] of Object.entries({customer_name:'name',customer_phone:'phone',customer_email:'email',customer_address:'address',note:'note'})) {
    assert.equal(decrypted[field],payload.customer[source]);
  }
  assert.equal(app.db.prepare('SELECT COUNT(*) n FROM order_items WHERE order_id=?').get(order.id).n, 2);
  await app.close();
  const reopened = await app.reopen();
  assert.equal(reopened.db.prepare('SELECT total FROM orders WHERE id=?').get(order.id).total, 1200000);
  const retry = await reopened.api('/api/orders', { method: 'POST', body: payload });
  assert.equal(retry.status, 200);
  assert.equal(retry.body.order.id, order.id);
  for (const key of ['customer_name','customer_phone','customer_email','customer_address','note','request_hash','idempotency_key']) assert.equal(Object.hasOwn(retry.body.order,key),false);
  assert.equal(getOrder(reopened.db,order.id).customer_phone,payload.customer.phone);
});

test('idempotency retries do not duplicate orders and conflicting payloads are rejected', async t => {
  const app = await fixture(t);
  const payload = orderRequest();
  const first = await app.api('/api/orders', { method: 'POST', body: payload });
  const repeated = await app.api('/api/orders', { method: 'POST', body: payload });
  assert.equal(first.status, 201);
  assert.equal(repeated.status, 200);
  assert.equal(first.body.order.id, repeated.body.order.id);
  const conflict = await app.api('/api/orders', {
    method: 'POST', body: { ...payload, items: [{ product_id: 'sentai-row-2', quantity: 3 }] },
  });
  assert.equal(conflict.status, 409);
  assert.equal(app.db.prepare('SELECT COUNT(*) n FROM orders').get().n, 1);
  assert.equal(app.db.prepare('SELECT COUNT(*) n FROM order_items').get().n, 1);
});

test('unpriced, sold, missing, and invalid quantity items reject without partial SQL writes', async t => {
  const app = await fixture(t);
  const invalid = [
    { items: [{ product_id: 'sentai-row-20', quantity: 1 }], status: 409 },
    { items: [{ product_id: 'sentai-row-26', quantity: 1 }], status: 409 },
    { items: [{ product_id: 'missing-product', quantity: 1 }], status: 400 },
    ...[-1, 0, 1.5, 2, 21, '1'].map(quantity => ({ items: [{ product_id: 'sentai-row-2', quantity }], status: 400 })),
    { items: [{ product_id: 'sentai-row-2', quantity: 1 }, { product_id: 'sentai-row-2', quantity: 2 }], status: 400 },
    { items: [], status: 400 },
    { items: [{ product_id: 'sentai-row-2', quantity: 1 }, { product_id: 'sentai-row-20', quantity: 1 }], status: 409 },
  ];
  for (const scenario of invalid) {
    const response = await app.api('/api/orders', { method: 'POST', body: orderRequest({ items: scenario.items }) });
    assert.equal(response.status, scenario.status, JSON.stringify(scenario.items));
    assert.equal(app.db.prepare('SELECT COUNT(*) n FROM orders').get().n, 0);
    assert.equal(app.db.prepare('SELECT COUNT(*) n FROM order_items').get().n, 0);
  }
  const valid = await app.api('/api/orders', { method: 'POST', body: orderRequest() });
  assert.equal(valid.status, 201, 'failed transactions must leave the database usable');
});

test('customer validation and JSON content type are enforced', async t => {
  const app = await fixture(t);
  for (const patch of [{ name: '' }, { phone: 'abcdefghij' }, { phone: '123' }, { address: 'short' }, { email: 'invalid-email' }]) {
    const payload = orderRequest();
    Object.assign(payload.customer, patch);
    const response = await app.api('/api/orders', { method: 'POST', body: payload });
    assert.equal(response.status, 400);
  }
  const malformed = await fetch(app.base + '/api/orders', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{broken',
  });
  assert.equal(malformed.status, 400);
  const text = await fetch(app.base + '/api/orders', {
    method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: JSON.stringify(orderRequest()),
  });
  assert.equal(text.status, 415);
  assert.equal(app.db.prepare('SELECT COUNT(*) n FROM orders').get().n, 0);
});

test('admin requires authentication, issues protected session, and revokes it on logout', async t => {
  const app = await fixture(t);
  assert.equal((await app.api('/api/admin/orders')).status, 401);
  assert.equal((await app.api('/api/admin/products')).status, 401);
  assert.equal((await app.api('/api/admin/products/sentai-row-2', { method: 'PATCH', body: { price_vnd: 1 } })).status, 401);
  assert.deepEqual((await app.api('/api/admin/session')).body, { authenticated: false, enabled: true, setup_allowed: false });
  const wrong = await app.api('/api/admin/login', { method: 'POST', body: {username:'admin',password: 'incorrect-password' } });
  assert.equal(wrong.status, 401);
  assert.equal(wrong.headers.get('set-cookie'), null);
  const headers = await login(app);
  assert.equal((await app.api('/api/admin/session', { headers })).body.authenticated, true);
  assert.equal((await app.api('/api/admin/products', { headers })).status, 200);
  const logout = await app.api('/api/admin/logout', { method: 'POST', headers });
  assert.equal(logout.status, 200);
  assert.match(logout.headers.get('set-cookie'), /Max-Age=0/);
  assert.equal((await app.api('/api/admin/orders', { headers })).status, 401);
  assert.equal((await app.api('/api/admin/session', { headers })).body.authenticated, false);
});

test('admin product price and availability validation persists and survives catalog refresh', async t => {
  const app = await fixture(t);
  const headers = await login(app);
  const endpoint = '/api/admin/products/sentai-row-2';
  const changed = await app.api(endpoint, { method: 'PATCH', headers, body: { price_vnd: 750000, availability: 'available' } });
  assert.equal(changed.status, 200);
  assert.equal(changed.body.product.price_vnd, 750000);
  assert.equal(changed.body.product.availability, 'available');
  for (const body of [
    { price_vnd: -1 }, { price_vnd: 0 }, { price_vnd: 1.5 }, { price_vnd: '500000' },
    { price_vnd: 1000000001 }, { availability: 'invented' }, { name: 'Unauthorized edit' }, {},
  ]) {
    assert.equal((await app.api(endpoint, { method: 'PATCH', headers, body })).status, 400, JSON.stringify(body));
  }
  assert.equal(app.db.prepare('SELECT price_vnd FROM products WHERE id=?').get('sentai-row-2').price_vnd, 750000);
  const cleared = await app.api(endpoint, { method: 'PATCH', headers, body: { price_vnd: null, availability: 'sold_out' } });
  assert.equal(cleared.status, 200);
  assert.equal(cleared.body.product.price_vnd, null);
  syncCatalog(app.db);
  const refreshed = (await app.api('/api/catalog')).body.products.find(p => p.id === 'sentai-row-2');
  assert.equal(refreshed.price_vnd, null);
  assert.equal(refreshed.availability, 'sold_out');
  assert.equal((await app.api('/api/admin/products/nonexistent', { method: 'PATCH', headers, body: { price_vnd: 10 } })).status, 404);
});

test('admin mutations require the session CSRF token and audit excludes credentials and customer data', async t => {
  const app = await fixture(t);
  const headers = await login(app);
  const secondSession = await login(app);
  const session = await app.api('/api/admin/session',{headers:{Cookie:headers.Cookie}});
  assert.equal(session.status,200);
  assert.equal(session.body.csrf_token,headers['X-CSRF-Token']);
  assert.match(session.headers.get('cache-control'),/no-store/);
  const endpoint = '/api/admin/products/sentai-row-2';
  const before = app.db.prepare('SELECT * FROM products WHERE id=?').get('sentai-row-2');
  for (const supplied of [
    {Cookie:headers.Cookie},
    {...headers,'X-CSRF-Token':'invalid'},
    {...headers,'X-CSRF-Token':'0'.repeat(64)},
    {...headers,'X-CSRF-Token':secondSession['X-CSRF-Token']}
  ]) {
    const blocked = await app.api(endpoint,{method:'PATCH',headers:supplied,body:{price_vnd:777777}});
    assert.equal(blocked.status,403);
    assert.equal(blocked.body.code,'CSRF_INVALID');
    assert.deepEqual(app.db.prepare('SELECT * FROM products WHERE id=?').get('sentai-row-2'),before);
  }
  assert.equal((await app.api('/api/admin/logout',{method:'POST',headers:{Cookie:headers.Cookie}})).status,403);
  assert.equal((await app.api('/api/admin/session',{headers})).body.authenticated,true,'rejected logout preserves the session');
  const changed = await app.api(endpoint,{method:'PATCH',headers:{Cookie:headers.Cookie,'X-CSRF-Token':session.body.csrf_token},body:{price_vnd:777777}});
  assert.equal(changed.status,200);
  assert.equal(changed.body.product.price_vnd,777777);
  const payload = orderRequest();
  const created = await app.api('/api/orders',{method:'POST',body:payload});
  assert.equal(created.status,201);
  assert.equal((await app.api('/api/admin/security/events')).status,401);
  const audit = await app.api('/api/admin/security/events',{headers});
  assert.equal(audit.status,200);
  assert.match(audit.headers.get('cache-control'),/no-store/);
  assert.ok(audit.body.events.some(event=>event.event === 'auth.login' && event.status === 200));
  assert.ok(audit.body.events.some(event=>event.event === 'admin.denied' && event.resource === 'sentai-row-2' && event.status === 403));
  assert.ok(audit.body.events.some(event=>event.event === 'admin.changed' && event.resource === 'sentai-row-2' && event.status === 200));
  const serialized = JSON.stringify(audit.body);
  for (const secret of [ADMIN_PASSWORD,headers.Cookie,headers['X-CSRF-Token'],...Object.values(payload.customer)]) {
    assert.equal(serialized.includes(secret),false,'audit must exclude secrets and customer fields');
  }
  assert.equal((await app.api('/api/admin/logout',{method:'POST',headers})).status,200);
  assert.equal((await app.api(endpoint,{method:'PATCH',headers,body:{price_vnd:888888}})).status,401);
});

test('admin order status updates retain immutable ordered prices and customer details', async t => {
  const app = await fixture(t);
  const created = await app.api('/api/orders', { method: 'POST', body: orderRequest() });
  const id = created.body.order.id;
  const headers = await login(app);
  await app.api('/api/admin/products/sentai-row-2', { method: 'PATCH', headers, body: { price_vnd: 999999 } });
  for (const status of ['confirmed', 'shipping', 'completed', 'cancelled']) {
    const response = await app.api(`/api/admin/orders/${id}`, { method: 'PATCH', headers, body: { status } });
    assert.equal(response.status, 200);
    assert.equal(response.body.order.status, status);
    assert.equal(response.body.order.total, 600000);
    assert.equal(response.body.order.items[0].unit_price, 600000);
    assert.equal(response.body.order.customer_phone, '0901234567');
  }
  assert.equal((await app.api(`/api/admin/orders/${id}`, { method: 'PATCH', headers, body: { status: 'paid' } })).status, 400);
  assert.equal((await app.api(`/api/admin/orders/${id}`, { method: 'PATCH', headers, body: { status: 'pending', total: 1 } })).status, 400);
  const list = await app.api('/api/admin/orders', { headers });
  assert.equal(list.status, 200);
  assert.equal(list.body.orders.length, 1);
  assert.equal(list.body.orders[0].status, 'cancelled');
});

test('reordered workbook identities cannot inherit an existing override or corrupt stored orders', async t => {
  const app = await fixture(t);
  const headers = await login(app);
  assert.equal((await app.api('/api/admin/products/sentai-row-2', {
    method: 'PATCH', headers, body: { price_vnd: 123456, availability: 'available' },
  })).status, 200);
  const placed = await app.api('/api/orders', { method: 'POST', body: orderRequest() });
  assert.equal(placed.status, 201);
  assert.equal(placed.body.order.total, 123456);
  const productsBefore = app.db.prepare('SELECT * FROM products ORDER BY id').all();
  const ordersBefore = app.db.prepare('SELECT * FROM orders ORDER BY id').all();
  const itemsBefore = app.db.prepare('SELECT * FROM order_items ORDER BY id').all();
  const metadataBefore = app.db.prepare('SELECT * FROM shop_metadata ORDER BY key').all();
  const changed = structuredClone(SOURCE);
  const first = changed.products.findIndex(p => p.id === 'sentai-row-2');
  const second = changed.products.findIndex(p => p.id === 'sentai-row-24');
  const a = changed.products[first];
  const b = changed.products[second];
  changed.products[first] = { ...b, id: a.id, source_row: a.source_row };
  changed.products[second] = { ...a, id: b.id, source_row: b.source_row };
  const path = join(app.directory, 'reordered-catalog.json');
  writeFileSync(path, JSON.stringify(changed));
  assert.throws(() => syncCatalog(app.db, path), /Dòng 2.*đổi tên, SKU hoặc dòng sản phẩm/);
  assert.deepEqual(app.db.prepare('SELECT * FROM products ORDER BY id').all(), productsBefore);
  assert.deepEqual(app.db.prepare('SELECT * FROM orders ORDER BY id').all(), ordersBefore);
  assert.deepEqual(app.db.prepare('SELECT * FROM order_items ORDER BY id').all(), itemsBefore);
  assert.deepEqual(app.db.prepare('SELECT * FROM shop_metadata ORDER BY key').all(), metadataBefore);
  assert.equal(app.db.prepare('SELECT COUNT(*) n FROM products WHERE active=1').get().n, 144);
  assert.equal(syncCatalog(app.db), 144, 'a rejected import must leave the database usable');
  const original = app.db.prepare('SELECT name,price_vnd FROM products WHERE id=?').get('sentai-row-2');
  assert.equal(original.name, 'DX King Express 01');
  assert.equal(original.price_vnd, 123456);
});

test('cross-origin mutations are blocked and HTTPS deployments use secure admin cookies', async t => {
  const app = await fixture(t, { publicOrigin: 'https://sentai.example' });
  const unencrypted = await fetch(app.base+'/api/health');
  assert.equal(unencrypted.status,426);
  await unencrypted.json();
  assert.equal((await app.api('/api/health',{headers:{'X-Forwarded-Proto':'http'}})).status,426);
  for (const headers of [{ Origin: 'https://attacker.example' }, { 'Sec-Fetch-Site': 'cross-site' }]) {
    assert.equal((await app.api('/api/orders', { method: 'POST', headers, body: orderRequest() })).status, 403);
    assert.equal((await app.api('/api/admin/login', { method: 'POST', headers, body: {username:'admin',password: ADMIN_PASSWORD } })).status, 403);
  }
  const response = await app.api('/api/admin/login', {
    method: 'POST', headers: { Origin: 'https://sentai.example' }, body: {username:'admin',password: ADMIN_PASSWORD },
  });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('set-cookie'), /; Secure/);
  assert.equal(response.headers.get('strict-transport-security'),'max-age=31536000');
  assert.match(response.headers.get('content-security-policy'),/upgrade-insecure-requests/);
  assert.equal(app.db.prepare('SELECT COUNT(*) n FROM orders').get().n, 0);
});

test('short or absent admin password disables administrator login', async t => {
  const app = await fixture(t, { adminPassword: '' });
  assert.equal(app.adminEnabled, false);
  assert.deepEqual((await app.api('/api/admin/session')).body, { authenticated: false, enabled: false, setup_allowed: true });
  assert.equal((await app.api('/api/admin/login', { method: 'POST', body: {username:'admin',password: '' } })).status, 503);
  assert.equal((await app.api('/api/admin/orders')).status, 401);
});

test('static server never exposes workbook, SQL database, environment, or traversal targets', async t => {
  const app = await fixture(t);
  for (const path of [
    '/SEntai.xlsx', '/data/sentai.sqlite', '/data/catalog.json', '/database/schema.sql', '/server.mjs',
    '/.env', '/%2eenv', '/..%2fSEntai.xlsx', '/%2e%2e%5cSEntai.xlsx', '/images/%2e%2e/%2e%2e/.env',
    '/images/%00photo.jpg',
  ]) {
    const response = await fetch(app.base + path);
    assert.equal(response.status, 404, path);
    assert.match(response.headers.get('content-type'), /application\/json/);
  }
  const response = await fetch(app.base + '/api/health');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(response.headers.get('x-frame-options'), 'DENY');
  assert.match(response.headers.get('content-security-policy'), /default-src 'self'/);
  assert.match(response.headers.get('content-security-policy'), /object-src 'none'/);
  assert.match(response.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.equal(response.headers.get('referrer-policy'),'no-referrer');
  assert.equal(response.headers.get('cross-origin-resource-policy'),'same-origin');
  assert.equal(response.headers.get('cross-origin-opener-policy'),'same-origin');
  assert.match(response.headers.get('permissions-policy'),/camera=\(\)/);
});
