import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { relative, resolve, sep } from 'node:path';
import { auditResponse, checkPersistentLoginRate, createSessionStore, deploymentOrigin, ensureSecuritySchema,
  securityHeaders, SecurityError, validateTransport } from '../lib/security.mjs';

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const rejected = status => error => error instanceof SecurityError && error.status === status;
const request = (token = '', extra = {}) => ({headers:{...(token ? {cookie:`sentai_session=${token}`} : {}), ...extra}});
function sessions() {
  let at = Date.parse('2026-11-04T10:00:00Z'), identity = 'owner-credential-v1';
  const store = createSessionStore({identity:() => identity, now:() => at});
  return {store, advance(ms) { at += ms; }, identity(value) { identity = value; }};
}
function transport({host = 'localhost:3000', address = '127.0.0.1', encrypted = false, headers = {}} = {}) {
  return {headers:{host, ...headers}, socket:{remoteAddress:address, encrypted}};
}
function memoryDatabase(t) {
  const db = new DatabaseSync(':memory:');
  ensureSecuritySchema(db);
  t.after(() => db.close());
  return db;
}

test('session tokens are random credentials; hashes, malformed cookies and other cookie names never authenticate', () => {
  const {store} = sessions();
  const first = store.create(request()), second = store.create(request());
  assert.match(first.token, /^[a-f0-9]{64}$/);
  assert.match(first.csrf, /^[a-f0-9]{64}$/);
  assert.notEqual(first.token, second.token);
  assert.notEqual(first.csrf, second.csrf);
  assert.notEqual(first.token, first.csrf);
  assert.equal(first.maxAge, 8 * 60 * 60);
  assert.ok(store.get(request(first.token)));
  const hash = createHash('sha256').update(first.token).digest('hex');
  for (const value of ['', 'wrong', first.token.toUpperCase(), `${first.token}0`, hash, encodeURIComponent(`${first.token};`)]) {
    assert.equal(store.get(request(value)), null);
  }
  assert.equal(store.get({headers:{cookie:`other_session=${first.token}`}}), null);
  assert.ok(store.get({headers:{cookie:`other=ignored; sentai_session=${first.token}; theme=dark`}}));
});

test('session expires at 15 minutes idle and a read without touch does not extend it', () => {
  const fixture = sessions();
  const token = fixture.store.create(request()).token;
  fixture.advance(15 * MINUTE - 1);
  assert.ok(fixture.store.get(request(token), {touch:false}));
  fixture.advance(1);
  assert.equal(fixture.store.get(request(token)), null);
  assert.equal(fixture.store.get(request(token)), null);
});

test('activity extends idle timeout but never the absolute 8 hour lifetime', () => {
  const fixture = sessions();
  const token = fixture.store.create(request()).token;
  for (let elapsed = 10 * MINUTE; elapsed < 8 * HOUR; elapsed += 10 * MINUTE) {
    fixture.advance(10 * MINUTE);
    assert.ok(fixture.store.get(request(token)));
  }
  fixture.advance(10 * MINUTE - 1);
  assert.ok(fixture.store.get(request(token)));
  fixture.advance(1);
  assert.equal(fixture.store.get(request(token)), null);
});

test('reauthentication rotates the existing session and CSRF token while logout invalidates only that session', () => {
  const {store} = sessions();
  const first = store.create(request()), otherDevice = store.create(request());
  const replacement = store.create(request(first.token));
  assert.notEqual(replacement.token, first.token);
  assert.notEqual(replacement.csrf, first.csrf);
  assert.equal(store.get(request(first.token)), null);
  assert.ok(store.get(request(replacement.token)));
  store.remove(request(replacement.token));
  assert.equal(store.get(request(replacement.token)), null);
  assert.ok(store.get(request(otherDevice.token)));
  store.clear();
  assert.equal(store.get(request(otherDevice.token)), null);
});

test('changing or removing the credential identity revokes sessions immediately', () => {
  const fixture = sessions();
  const old = fixture.store.create(request());
  fixture.identity('owner-credential-v2');
  assert.equal(fixture.store.get(request(old.token)), null);
  const current = fixture.store.create(request());
  assert.ok(fixture.store.get(request(current.token)));
  fixture.identity(null);
  assert.equal(fixture.store.get(request(current.token)), null);
  const unconfigured = fixture.store.create(request());
  assert.equal(fixture.store.get(request(unconfigured.token)), null);
});

test('CSRF requires the exact token bound to the authenticated session', () => {
  const {store} = sessions();
  const first = store.create(request()), second = store.create(request());
  const session = store.get(request(first.token));
  assert.doesNotThrow(() => store.checkCSRF(request(first.token, {'x-csrf-token':first.csrf}), session));
  for (const csrf of [undefined, '', 'short', first.token, second.csrf, first.csrf.toUpperCase(), `${first.csrf}0`, [first.csrf]]) {
    assert.throws(() => store.checkCSRF(request(first.token, {'x-csrf-token':csrf}), session), error =>
      rejected(403)(error) && error.code === 'CSRF_INVALID');
  }
});

test('session capacity is bounded and a fresh login evicts the oldest session', () => {
  const {store} = sessions();
  const tokens = Array.from({length:51}, () => store.create(request()).token);
  assert.equal(store.get(request(tokens[0])), null);
  assert.ok(store.get(request(tokens[1])));
  assert.ok(store.get(request(tokens[50])));
});

test('login limiter enforces its boundary and retains the count across a database restart', t => {
  const root = mkdtempSync(resolve(tmpdir(), 'sentai-security-tests-'));
  const databases = [];
  t.after(() => {
    for (const db of databases) { try { db.close(); } catch {} }
    const child = relative(resolve(tmpdir()), root);
    assert.ok(child && child !== '..' && !child.startsWith(`..${sep}`));
    assert.ok(root.startsWith(resolve(tmpdir(), 'sentai-security-tests-')));
    rmSync(root, {recursive:true, force:true});
  });
  const path = resolve(root, 'security.sqlite');
  const start = Date.parse('2026-11-04T10:00:00Z');
  let db = new DatabaseSync(path); databases.push(db); ensureSecuritySchema(db);
  for (let i = 0; i < 15; i++) checkPersistentLoginRate(db, start);
  db.close();
  db = new DatabaseSync(path); databases.push(db); ensureSecuritySchema(db);
  for (let i = 0; i < 15; i++) checkPersistentLoginRate(db, start + MINUTE);
  assert.throws(() => checkPersistentLoginRate(db, start + MINUTE), rejected(429));
  assert.throws(() => checkPersistentLoginRate(db, start + 15 * MINUTE - 1), rejected(429));
  assert.equal(db.prepare("SELECT count FROM security_limits WHERE bucket='admin-login'").get().count, 30);
  checkPersistentLoginRate(db, start + 15 * MINUTE);
  const renewed = db.prepare("SELECT count,expires_at FROM security_limits WHERE bucket='admin-login'").get();
  assert.equal(renewed.count, 1);
  assert.equal(renewed.expires_at, start + 30 * MINUTE);
});

test('audit records administrative changes and denials without request bodies, query strings, cookies or credentials', t => {
  const db = memoryDatabase(t);
  const secrets = ['private-password-value', 'private-customer@example.test', 'secret-cookie-value', 'secret-recovery-token'];
  auditResponse(db, {path:`/api/admin/login?password=${secrets[0]}`, method:'POST', status:401,
    body:{email:secrets[1],token:secrets[3]}, headers:{cookie:secrets[2]}, now:0});
  auditResponse(db, {path:'/api/admin/reset', method:'POST', status:200, body:{token:secrets[3]}, now:1});
  auditResponse(db, {path:`/api/admin/orders/order-123?email=${secrets[1]}`, method:'PATCH', status:200, now:2});
  auditResponse(db, {path:'/api/admin/products/sentai-row-84/media', method:'POST', status:202, now:3});
  auditResponse(db, {path:'/api/admin/orders', method:'GET', status:401, now:4});
  auditResponse(db, {path:'/api/admin/analytics', method:'GET', status:200, now:5});
  auditResponse(db, {path:'/api/orders', method:'POST', status:201, now:6});
  auditResponse(db, {path:'/', method:'GET', status:200, now:7});
  const rows = db.prepare('SELECT * FROM security_events ORDER BY id').all();
  assert.equal(rows.length, 5);
  const serialized = JSON.stringify(rows);
  for (const secret of secrets) assert.equal(serialized.includes(secret), false);
  assert.equal(rows[1].event, 'auth.reset');
  assert.equal(rows[3].resource, 'sentai-row-84');
  assert.equal(rows[4].event, 'admin.denied');
  assert.equal(rows[0].created_at, new Date(0).toISOString());
  assert.deepEqual(Object.keys(rows[0]), ['id','event','method','resource','status','created_at']);
});

test('audit drops arbitrary identifiers supplied through fake resource URLs', t => {
  const db = memoryDatabase(t);
  for (const path of ['/api/admin/orders/0912345678','/api/admin/products/private-password-value','/api/admin/media/customer_email']) {
    auditResponse(db,{path,method:'PATCH',status:401});
  }
  assert.deepEqual(db.prepare('SELECT resource FROM security_events ORDER BY id').all().map(row=>row.resource),['orders','products','media']);
});

test('deployment origin accepts HTTPS origins only and normalizes the domain', () => {
  assert.equal(deploymentOrigin(), '');
  assert.equal(deploymentOrigin('https://SHOP.example:443/'), 'https://shop.example');
  assert.equal(deploymentOrigin('https://shop.example:8443'), 'https://shop.example:8443');
  for (const value of ['http://shop.example', 'ftp://shop.example', 'not-a-url', 'https://user:password@shop.example',
    'https://shop.example/admin', 'https://shop.example/?token=secret', 'https://shop.example/#secret']) {
    assert.throws(() => deploymentOrigin(value));
  }
});

test('audit retention keeps exactly the newest 10,000 events even when timestamps are identical', t => {
  const db = memoryDatabase(t);
  const insert = db.prepare('INSERT INTO security_events(event,method,resource,status,created_at) VALUES(?,?,?,?,?)');
  db.exec('BEGIN');
  for (let i = 0; i < 10000; i++) insert.run('auth.login','POST',`event-${i}`,401,'2026-11-04T10:00:00.000Z');
  db.exec('COMMIT');
  auditResponse(db, {path:'/api/admin/login',method:'POST',status:401,now:0});
  assert.equal(db.prepare('SELECT count(*) n FROM security_events').get().n, 10000);
  assert.equal(db.prepare('SELECT resource FROM security_events ORDER BY id LIMIT 1').get().resource, 'event-1');
  assert.equal(db.prepare('SELECT resource FROM security_events ORDER BY id DESC LIMIT 1').get().resource, 'login');
  auditResponse(db, {path:'/api/admin/logout',method:'POST',status:200,now:0});
  assert.equal(db.prepare('SELECT count(*) n FROM security_events').get().n, 10000);
  assert.equal(db.prepare('SELECT resource FROM security_events ORDER BY id LIMIT 1').get().resource, 'event-2');
});

test('local transport rejects non-loopback clients and DNS rebinding hostnames', () => {
  for (const [host, address] of [['localhost:3000','127.0.0.1'], ['127.0.0.1:3000','::ffff:127.0.0.1'], ['[::1]:3000','::1']]) {
    assert.doesNotThrow(() => validateTransport(transport({host,address}), ''));
  }
  for (const options of [
    {host:'attacker.example:3000'}, {host:'localhost.attacker.example:3000'},
    {address:'192.168.1.20'}, {address:'203.0.113.25',headers:{'x-forwarded-for':'127.0.0.1'}},
    {host:'127.0.0.1.attacker.example',headers:{'x-forwarded-host':'localhost'}}
  ]) assert.throws(() => validateTransport(transport(options), ''), rejected(403));
  assert.throws(() => validateTransport(transport({host:'[invalid-ipv6'}), ''), rejected(400));
});

test('public transport requires TLS or HTTPS forwarded by a loopback proxy and rejects an unrelated hostname', () => {
  const origin = 'https://shop.example';
  assert.doesNotThrow(() => validateTransport(transport({host:'shop.example',address:'203.0.113.25',encrypted:true}), origin));
  for (const address of ['127.0.0.1','::1','::ffff:127.0.0.1']) {
    assert.doesNotThrow(() => validateTransport(transport({host:'shop.example',address,headers:{'x-forwarded-proto':'https'}}), origin));
  }
  for (const options of [
    {host:'shop.example'},
    {host:'shop.example',address:'203.0.113.25',headers:{'x-forwarded-proto':'https'}},
    {host:'shop.example',headers:{'x-forwarded-proto':'http'}},
    {host:'shop.example',headers:{'x-forwarded-proto':'https,http'}},
    {host:'shop.example',headers:{forwarded:'proto=https'}}
  ]) assert.throws(() => validateTransport(transport(options), origin), rejected(426));
  assert.throws(() => validateTransport(transport({host:'attacker.example',encrypted:true}), origin), rejected(403));
});

test('security headers constrain scripts, embeds, frames, referrers and browser permissions; HSTS is HTTPS-only', () => {
  for (const origin of ['', 'https://shop.example']) {
    const headers = new Map();
    securityHeaders({setHeader(name,value) { headers.set(name.toLowerCase(), value); }}, origin);
    assert.equal(headers.get('x-content-type-options'), 'nosniff');
    assert.equal(headers.get('referrer-policy'), 'no-referrer');
    assert.equal(headers.get('x-frame-options'), 'DENY');
    assert.equal(headers.get('cross-origin-resource-policy'), 'same-origin');
    assert.equal(headers.get('cross-origin-opener-policy'), 'same-origin');
    assert.match(headers.get('permissions-policy'), /camera=\(\).*microphone=\(\).*geolocation=\(\)/);
    const csp = headers.get('content-security-policy');
    assert.match(csp, /(?:^|; )script-src 'self'(?:;|$)/);
    assert.match(csp, /object-src 'none'/);
    assert.match(csp, /frame-ancestors 'none'/);
    assert.match(csp, /form-action 'self'/);
    assert.doesNotMatch(csp, /unsafe-eval/);
    if (origin) {
      assert.equal(headers.get('strict-transport-security'), 'max-age=31536000');
      assert.match(csp, /upgrade-insecure-requests/);
    } else {
      assert.equal(headers.has('strict-transport-security'), false);
      assert.doesNotMatch(csp, /upgrade-insecure-requests/);
    }
  }
});
