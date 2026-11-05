import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { createHash, randomBytes, generateKeyPairSync, sign } from 'node:crypto';
import { isoCBOR } from '@simplewebauthn/server/helpers';
import { authConfigured, verifySession, authorizedDatabase, assertIdentity, checkCSRF, rateLimit, handleAuth } from '../cloudflare/auth.mjs';
import { readJson, setAuthCheck } from '../cloudflare/common.mjs';
import { makeGrant } from '../scripts/cloudflare_admin_link.mjs';

const digest = value => createHash('sha256').update(value).digest('hex');
const b64 = value => Buffer.from(value).toString('base64url');
const config = { PUBLIC_ORIGIN: 'https://shop.example', AUTH_SECRET: 'b'.repeat(64) };
const status = code => error => error.status === code;
function fixture(t) {
  const sqlite = new DatabaseSync(':memory:');
  for (const file of ['0001_schema.sql', '0002_security.sql', '0003_auth.sql']) sqlite.exec(readFileSync(new URL(`../cloudflare/migrations/${file}`, import.meta.url), 'utf8'));
  sqlite.exec('CREATE TABLE mutation_probe(id TEXT PRIMARY KEY,value TEXT)');
  t.after(() => sqlite.close());
  function statement(sql, args = []) {
    const execute = () => {
      const stmt = sqlite.prepare(sql);
      if (stmt.columns().length) return { results: stmt.all(...args).map(row => ({ ...row })), meta: { changes: sqlite.prepare('SELECT changes() n').get().n }, success: true };
      const info = stmt.run(...args);
      return { results: [], meta: { changes: Number(info.changes), last_row_id: Number(info.lastInsertRowid) }, success: true };
    };
    return { bind: (...bindings) => statement(sql, bindings), all: async () => execute(), run: async () => execute(),
      first: async column => { const row = execute().results[0] ?? null; return column ? row?.[column] ?? null : row; }, execute };
  }
  const db = { prepare: statement, batch: async statements => {
    sqlite.exec('BEGIN IMMEDIATE');
    try { const results = statements.map(item => item.execute()); sqlite.exec('COMMIT'); return results; }
    catch (error) { sqlite.exec('ROLLBACK'); throw error; }
  } };
  const env = { ...config, DB: db };
  function request(path, body, { cookie = '', csrf = '', origin = config.PUBLIC_ORIGIN, method = 'POST' } = {}) {
    return new Request(`${config.PUBLIC_ORIGIN}${path}`, { method, headers: { cookie, 'x-csrf-token': csrf, origin, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  }
  async function call(path, body, options) { const req = request(path, body, options); return handleAuth(req, env, new URL(req.url)); }
  function session({ idle = Date.now(), expiry = Date.now() + 8 * 3600000 } = {}) {
    const token = randomBytes(32).toString('base64url'), hash = digest(token), csrf = randomBytes(32).toString('hex');
    sqlite.prepare('INSERT INTO cf_admin_sessions VALUES(?,?,?,?,?)').run(hash, csrf, Date.now(), idle, expiry);
    return { token, hash, csrf, expiresAt: expiry, cookie: `sentai_session=${token}` };
  }
  return { sqlite, db, env, request, call, session };
}
function responseCookie(response, name) { return response.headers.getSetCookie().find(value => value.startsWith(`${name}=`))?.split(';')[0]; }
function virtualKey() {
  const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }), key = pair.publicKey.export({ format: 'jwk' }), credential = randomBytes(32);
  const cose = isoCBOR.encode(new Map([[1, 2], [3, -7], [-1, 1], [-2, new Uint8Array(Buffer.from(key.x, 'base64url'))], [-3, new Uint8Array(Buffer.from(key.y, 'base64url'))]]));
  function client(challenge, type, origin = config.PUBLIC_ORIGIN) { return Buffer.from(JSON.stringify({ type, challenge, origin, crossOrigin: false })); }
  function authData(flags, counter, rpID = 'shop.example') { const count = Buffer.alloc(4); count.writeUInt32BE(counter); return Buffer.concat([createHash('sha256').update(rpID).digest(), Buffer.from([flags]), count]); }
  return {
    id: b64(credential),
    registration(challenge, { origin, flags = 0x45, rpID } = {}) {
      const len = Buffer.alloc(2); len.writeUInt16BE(credential.length);
      const data = Buffer.concat([authData(flags, 0, rpID), Buffer.alloc(16), len, credential, cose]);
      return { id: b64(credential), rawId: b64(credential), type: 'public-key', clientExtensionResults: {}, response: { clientDataJSON: b64(client(challenge, 'webauthn.create', origin)), attestationObject: b64(isoCBOR.encode(new Map([['fmt', 'none'], ['attStmt', new Map()], ['authData', new Uint8Array(data)]]))), transports: ['internal'] } };
    },
    assertion(challenge, counter = 1, { origin, flags = 5, rpID, corrupt = false } = {}) {
      const clientData = client(challenge, 'webauthn.get', origin), data = authData(flags, counter, rpID);
      const signature = sign('sha256', Buffer.concat([data, createHash('sha256').update(clientData).digest()]), pair.privateKey);
      if (corrupt) signature[signature.length - 1] ^= 1;
      return { id: b64(credential), rawId: b64(credential), type: 'public-key', clientExtensionResults: {}, response: { clientDataJSON: b64(clientData), authenticatorData: b64(data), signature: b64(signature), userHandle: b64('sentai-shop-owner') } };
    },
  };
}
async function register(f, owner, key = virtualKey(), overrides) {
  const options = await f.call('/api/admin/passkeys/registration/options', {}, owner), body = await options.json();
  const challengeCookie = responseCookie(options, 'sentai_challenge');
  const verify = () => f.call('/api/admin/passkeys/registration/verify', { response: key.registration(body.options.challenge, overrides), label: 'Thiết bị thử' }, { cookie: `${owner.cookie}; ${challengeCookie}`, csrf: owner.csrf });
  return { key, options: body.options, verify, response: await verify() };
}
async function authentication(f, key, counter = 1, overrides) {
  const options = await f.call('/api/admin/passkeys/authentication/options', {}), body = await options.json();
  const challengeCookie = responseCookie(options, 'sentai_challenge');
  return { options: body.options, verify: () => f.call('/api/admin/passkeys/authentication/verify', { response: key.assertion(body.options.challenge, counter, overrides) }, { cookie: challengeCookie }) };
}

test('local grant has 256 random bits, expires in 20 minutes and SQL stores only its hash', () => {
  const grant = makeGrant(config.PUBLIC_ORIGIN, 1000), token = new URL(grant.link).hash.slice('#access='.length);
  assert.equal(Buffer.from(token, 'base64url').length, 32);
  assert.equal(grant.hash, digest(token));
  assert.equal(grant.expiresAt, 1201000);
  assert.ok(!grant.sql.includes(token));
  assert.throws(() => makeGrant('http://shop.example'));
  assert.throws(() => makeGrant('https://shop.example/path'));
});
test('magic grant is consumed exactly once under concurrency and invalidates previous sessions', async t => {
  const f = fixture(t), old = f.session(), grant = makeGrant(config.PUBLIC_ORIGIN);
  f.sqlite.exec(grant.sql);
  const token = new URL(grant.link).hash.slice('#access='.length);
  const results = await Promise.allSettled([f.call('/api/admin/access', { token }), f.call('/api/admin/access', { token })]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.find(result => result.status === 'rejected').reason.status, 401);
  const response = results.find(result => result.status === 'fulfilled').value;
  const sessionCookie = responseCookie(response, 'sentai_session');
  assert.match(response.headers.getSetCookie()[0], /HttpOnly; Secure; SameSite=Strict; Path=\/api\/admin; Max-Age=28800/);
  assert.ok(await verifySession(f.request('/api/admin/session', undefined, { cookie: sessionCookie, method: 'GET' }), f.env));
  assert.equal(await verifySession(f.request('/api/admin/session', undefined, { cookie: old.cookie, method: 'GET' }), f.env), null);
  assert.equal(f.sqlite.prepare('SELECT count(*) n FROM cf_admin_sessions').get().n, 1);
  assert.equal(f.sqlite.prepare('SELECT count(*) n FROM cf_integrity_guard').get().n, 0);
  await assert.rejects(f.call('/api/admin/access', { token }, { origin: 'https://evil.example' }), status(403));
});
test('sessions expire by idle/absolute time, cookies are exact and raw tokens never enter SQL', async t => {
  const f = fixture(t), active = f.session(), idle = f.session({ idle: Date.now() - 901000 }), expired = f.session({ expiry: Date.now() - 1 });
  assert.equal(authConfigured(f.env), true);
  assert.equal(authConfigured({ ...f.env, AUTH_SECRET: '' }), false);
  for (const owner of [idle, expired]) assert.equal(await verifySession(f.request('/api/admin/session', undefined, { cookie: owner.cookie, method: 'GET' }), f.env), null);
  const identity = await verifySession(f.request('/api/admin/session', undefined, { cookie: active.cookie, method: 'GET' }), f.env);
  assert.equal(identity.hash, active.hash);
  assert.equal(f.sqlite.prepare('SELECT token_hash FROM cf_admin_sessions WHERE token_hash=?').get(active.token), undefined);
  assert.equal(await verifySession(f.request('/api/admin/session', undefined, { cookie: `x${active.cookie}`, method: 'GET' }), f.env), null);
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  const alternate = [...alphabet].map(char => active.token.slice(0, -1) + char).find(token => token !== active.token && Buffer.from(token, 'base64url').equals(Buffer.from(active.token, 'base64url')));
  assert.equal(await verifySession(f.request('/api/admin/session', undefined, { cookie: `sentai_session=${alternate}`, method: 'GET' }), f.env), null);
});
test('CSRF and transaction guards block revoked/expired sessions including delayed JSON bodies', async t => {
  const f = fixture(t), owner = f.session(), guarded = authorizedDatabase(f.db, owner);
  assert.doesNotThrow(() => checkCSRF(f.request('/api/admin/test', {}, owner), owner));
  assert.throws(() => checkCSRF(f.request('/api/admin/test', {}, { ...owner, csrf: 'c'.repeat(64) }), owner), status(403));
  await guarded.prepare("INSERT INTO mutation_probe VALUES('one','first')").run();
  f.sqlite.prepare('DELETE FROM cf_admin_sessions WHERE token_hash=?').run(owner.hash);
  await assert.rejects(guarded.batch([guarded.prepare("INSERT INTO mutation_probe VALUES('two','second')"), guarded.prepare("UPDATE mutation_probe SET value='changed'")]), status(401));
  assert.equal(f.sqlite.prepare('SELECT count(*) n FROM mutation_probe').get().n, 1);
  assert.equal(f.sqlite.prepare('SELECT value FROM mutation_probe').get().value, 'first');
  const second = f.session();
  let controller;
  const req = new Request(`${config.PUBLIC_ORIGIN}/api/admin/test`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: new ReadableStream({ start(value) { controller = value; } }), duplex: 'half' });
  setAuthCheck(req, () => assertIdentity(f.db, second));
  const reading = readJson(req);
  controller.enqueue(new TextEncoder().encode('{"price":'));
  f.sqlite.prepare('DELETE FROM cf_admin_sessions WHERE token_hash=?').run(second.hash);
  controller.enqueue(new TextEncoder().encode('5}')); controller.close();
  await assert.rejects(reading, status(401));
});
test('real ES256 passkey registration/assertion succeeds with UV and rejects replay/counter regression', async t => {
  const f = fixture(t), owner = f.session(), registration = await register(f, owner);
  assert.equal(registration.response.status, 200);
  assert.equal(registration.options.authenticatorSelection.userVerification, 'required');
  assert.equal(registration.options.attestation, 'none');
  await assert.rejects(registration.verify(), status(401));
  const auth = await authentication(f, registration.key, 1), logged = await auth.verify();
  assert.equal(logged.status, 200);
  assert.ok(responseCookie(logged, 'sentai_session'));
  assert.equal(f.sqlite.prepare('SELECT counter FROM cf_passkeys').get().counter, 1);
  await assert.rejects(auth.verify(), status(401));
  const reusedCounter = await authentication(f, registration.key, 1);
  await assert.rejects(reusedCounter.verify(), status(401));
  const fresh = await authentication(f, registration.key, 2);
  assert.equal((await fresh.verify()).status, 200);
});
test('passkeys require exact origin/RP, valid signature and user verification; registration requires session+CSRF', async t => {
  const f = fixture(t), owner = f.session();
  await assert.rejects(f.call('/api/admin/passkeys/registration/options', {}), status(401));
  await assert.rejects(f.call('/api/admin/passkeys/registration/options', {}, { cookie: owner.cookie }), status(403));
  for (const overrides of [{ origin: 'https://evil.example' }, { rpID: 'evil.example' }, { flags: 0x41 }]) await assert.rejects(register(f, owner, virtualKey(), overrides), status(401));
  const { key } = await register(f, owner);
  for (const overrides of [{ origin: 'https://evil.example' }, { rpID: 'evil.example' }, { flags: 1 }, { corrupt: true }]) {
    const auth = await authentication(f, key, 1, overrides); await assert.rejects(auth.verify(), status(401));
  }
  assert.equal(f.sqlite.prepare('SELECT counter FROM cf_passkeys').get().counter, 0);
});
test('passkey limits, challenge/session binding and credential deletion revoke other sessions', async t => {
  const f = fixture(t), owner = f.session(), other = f.session(), key = virtualKey();
  const optionsResponse = await f.call('/api/admin/passkeys/registration/options', {}, owner), options = (await optionsResponse.json()).options;
  const challenge = responseCookie(optionsResponse, 'sentai_challenge');
  await assert.rejects(f.call('/api/admin/passkeys/registration/verify', { response: key.registration(options.challenge) }, { cookie: `${other.cookie}; ${challenge}`, csrf: other.csrf }), status(401));
  const registered = await register(f, owner);
  for (let i = 0; i < 4; i++) f.sqlite.prepare('INSERT INTO cf_passkeys VALUES(?,?,?,?,?,?)').run(`extra${i}`, 'test', 0, '[]', `Extra ${i}`, Date.now());
  await assert.rejects(f.call('/api/admin/passkeys/registration/options', {}, owner), status(409));
  await f.call(`/api/admin/passkeys/${registered.key.id}`, undefined, { ...owner, method: 'DELETE' });
  assert.equal(await verifySession(f.request('/api/admin/session', undefined, { ...other, method: 'GET' }), f.env), null);
  assert.ok(await verifySession(f.request('/api/admin/session', undefined, { ...owner, method: 'GET' }), f.env));
});
test('logout deletes the session and rate limits are atomic without retaining plain IPs', async t => {
  const f = fixture(t), owner = f.session();
  const out = await f.call('/api/admin/logout', {}, owner);
  assert.equal(out.status, 200);
  assert.match(responseCookie(out, 'sentai_session'), /^sentai_session=$/);
  await assert.rejects(assertIdentity(f.db, owner), status(401));
  const req = new Request(`${config.PUBLIC_ORIGIN}/api/orders`, { headers: { 'cf-connecting-ip': '203.0.113.4' } });
  const results = await Promise.allSettled(Array.from({ length: 8 }, () => rateLimit(req, f.env, 'test', 3, 3600000)));
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 3);
  assert.ok(results.filter(result => result.status === 'rejected').every(result => result.reason.status === 429));
  const row = f.sqlite.prepare("SELECT bucket,count FROM cf_rate_limits WHERE bucket LIKE 'test:%'").get();
  assert.equal(row.count, 4);
  assert.ok(!row.bucket.includes('203.0.113.4'));
});
