import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { generateRegistrationOptions, verifyRegistrationResponse, generateAuthenticationOptions, verifyAuthenticationResponse } from '@simplewebauthn/server';
import { fail, first, all, json, run, readJson, setAuthCheck } from './common.mjs';

const IDLE = 15 * 60 * 1000, ABSOLUTE = 8 * 60 * 60 * 1000, CHALLENGE = 5 * 60 * 1000;
const NOW_SQL = "CAST((julianday('now')-2440587.5)*86400000 AS INTEGER)";
const digest = value => createHash('sha256').update(value).digest('hex');
const random = () => randomBytes(32).toString('base64url');
const validToken = value => typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value) && Buffer.from(value, 'base64url').toString('base64url') === value;
const same = (a, b) => typeof a === 'string' && typeof b === 'string' && timingSafeEqual(Buffer.from(digest(a)), Buffer.from(digest(b)));
const cookie = (request, name) => (request.headers.get('cookie') || '').split(';').map(value => value.trim()).find(value => value.startsWith(`${name}=`))?.slice(name.length + 1);
function origin(env) {
  try { const url = new URL(env.PUBLIC_ORIGIN); return url.protocol === 'https:' && url.origin === env.PUBLIC_ORIGIN && !url.username && !url.password ? url : null; } catch { return null; }
}
export function authConfigured(env) { return Boolean(origin(env) && /^[a-f0-9]{64}$/i.test(env.AUTH_SECRET || '')); }
function cookieValue(name, value, seconds, path = '/api/admin') { return `${name}=${value}; HttpOnly; Secure; SameSite=Strict; Path=${path}; Max-Age=${seconds}`; }
function response(data, cookies = [], status = 200) {
  const result = json(data, status);
  for (const value of cookies) result.headers.append('Set-Cookie', value);
  return result;
}
function newSession() {
  const token = random(), now = Date.now();
  return { token, hash: digest(token), csrf: randomBytes(32).toString('hex'), createdAt: now, expiresAt: now + ABSOLUTE };
}
function sessionInsert(db, identity) { return db.prepare('INSERT INTO cf_admin_sessions(token_hash,csrf_token,created_at,last_seen_at,expires_at) VALUES(?,?,?,?,?)').bind(identity.hash, identity.csrf, identity.createdAt, identity.createdAt, identity.expiresAt); }
const pruneSessions = db => db.prepare('DELETE FROM cf_admin_sessions WHERE token_hash NOT IN (SELECT token_hash FROM cf_admin_sessions ORDER BY created_at DESC,token_hash LIMIT 50)');
function sessionResponse(identity, extra = {}) { return response({ ok: true, csrf_token: identity.csrf, ...extra }, [cookieValue('sentai_session', identity.token, ABSOLUTE / 1000), cookieValue('sentai_challenge', '', 0, '/api/admin/passkeys')]); }
export async function verifySession(request, env, { touch = true } = {}) {
  if (!authConfigured(env)) return null;
  const token = cookie(request, 'sentai_session');
  if (!validToken(token)) return null;
  const hash = digest(token), now = Date.now();
  const row = touch
    ? await first(env.DB, 'UPDATE cf_admin_sessions SET last_seen_at=? WHERE token_hash=? AND expires_at>? AND last_seen_at>? RETURNING csrf_token,expires_at', now, hash, now, now - IDLE)
    : await first(env.DB, 'SELECT csrf_token,expires_at FROM cf_admin_sessions WHERE token_hash=? AND expires_at>? AND last_seen_at>?', hash, now, now - IDLE);
  return row ? { hash, csrf: row.csrf_token, expiresAt: row.expires_at } : null;
}
export async function assertIdentity(db, identity) {
  const now = Date.now();
  if (!identity || identity.expiresAt <= now || !await first(db, 'SELECT token_hash FROM cf_admin_sessions WHERE token_hash=? AND expires_at>? AND last_seen_at>?', identity.hash, now, now - IDLE)) fail(401, 'Phiên quản trị đã hết hạn. Vui lòng đăng nhập lại.');
  if (identity.expiresAt <= Date.now()) fail(401, 'Phiên quản trị đã hết hạn. Vui lòng đăng nhập lại.');
}
export function checkCSRF(request, identity) {
  const token = request.headers.get('x-csrf-token');
  if (!identity || !/^[a-f0-9]{64}$/.test(token || '') || !same(token, identity.csrf)) fail(403, 'Phiên thao tác không hợp lệ. Tải lại trang rồi thử lại.', 'CSRF_INVALID');
}
export function authorizedDatabase(db, identity) {
  const originals = new WeakMap();
  async function batch(statements) {
    const id = crypto.randomUUID();
    const guard = db.prepare(`INSERT INTO cf_integrity_guard(id,passed) SELECT ?,CASE WHEN EXISTS(
      SELECT 1 FROM cf_admin_sessions WHERE token_hash=? AND expires_at>${NOW_SQL} AND last_seen_at>${NOW_SQL}-${IDLE}) THEN 1 ELSE 0 END`).bind(id, identity.hash);
    try { const results = await db.batch([guard, ...statements.map(s => originals.get(s) || s), db.prepare('DELETE FROM cf_integrity_guard WHERE id=?').bind(id)]); return results.slice(1, -1); }
    catch (error) { await assertIdentity(db, identity); throw error; }
  }
  function wrap(statement, sql) {
    const mutating = !/^\s*(?:SELECT|PRAGMA\s+table_info)\b/i.test(sql);
    const wrapped = {
      bind(...values) { return wrap(statement.bind(...values), sql); },
      async run() { return (await batch([statement]))[0]; },
      async all() { return mutating ? (await batch([statement]))[0] : statement.all(); },
      async first(column) { if (!mutating) return statement.first(column); const row = (await batch([statement]))[0].results?.[0] || null; return column && row ? row[column] : row; },
      async raw(options) { if (mutating) fail(500, 'Không hỗ trợ thao tác dữ liệu này.'); return statement.raw(options); },
    };
    originals.set(wrapped, statement); return wrapped;
  }
  return { prepare: sql => wrap(db.prepare(sql), sql), batch };
}
export async function rateLimit(request, env, kind, limit, windowMs) {
  if (!/^[a-f0-9]{64}$/i.test(env.AUTH_SECRET || '')) fail(503, 'Cửa hàng chưa hoàn tất cấu hình bảo mật.');
  const now = Date.now(), window = Math.floor(now / windowMs);
  const key = `${kind}:${window}:${createHmac('sha256', env.AUTH_SECRET).update(`${window}:${request.headers.get('cf-connecting-ip') || 'local'}`).digest('hex')}`;
  const row = await first(env.DB, `INSERT INTO cf_rate_limits(bucket,count,expires_at) VALUES(?,1,?)
    ON CONFLICT(bucket) DO UPDATE SET count=count+1 WHERE count<=? RETURNING count`, key, (window + 1) * windowMs, limit);
  if (!row || row.count > limit) fail(429, 'Bạn thao tác quá nhanh. Vui lòng thử lại sau.');
}
function guard(db, id, condition, ...args) { return db.prepare(`INSERT INTO cf_integrity_guard(id,passed) SELECT ?,CASE WHEN ${condition} THEN 1 ELSE 0 END`).bind(id, ...args); }
async function redeem(request, env) {
  await rateLimit(request, env, 'admin-grant', 10, 15 * 60000);
  const body = await readJson(request);
  if (!validToken(body.token)) fail(401, 'Liên kết đăng nhập không hợp lệ hoặc đã hết hạn.');
  const hash = digest(body.token), identity = newSession(), guardId = crypto.randomUUID();
  try {
    await env.DB.batch([
      guard(env.DB, guardId, `EXISTS(SELECT 1 FROM cf_admin_grants WHERE token_hash=? AND consumed_at IS NULL AND expires_at>${NOW_SQL})`, hash),
      env.DB.prepare(`UPDATE cf_admin_grants SET consumed_at=${NOW_SQL} WHERE token_hash=?`).bind(hash),
      env.DB.prepare('DELETE FROM cf_auth_challenges'), env.DB.prepare('DELETE FROM cf_admin_sessions'),
      sessionInsert(env.DB, identity), env.DB.prepare('DELETE FROM cf_integrity_guard WHERE id=?').bind(guardId),
    ]);
  } catch (error) {
    const grant = await first(env.DB, 'SELECT expires_at,consumed_at FROM cf_admin_grants WHERE token_hash=?', hash);
    if (!grant || grant.consumed_at != null || grant.expires_at <= Date.now()) fail(401, 'Liên kết đăng nhập không hợp lệ hoặc đã hết hạn.');
    throw error;
  }
  return sessionResponse(identity);
}
async function authenticated(request, env) {
  const identity = await verifySession(request, env);
  if (!identity) fail(401, 'Vui lòng đăng nhập quản trị.');
  if (request.method !== 'GET') checkCSRF(request, identity);
  setAuthCheck(request, () => assertIdentity(env.DB, identity));
  return identity;
}
async function createChallenge(request, env, kind, identity) {
  await rateLimit(request, env, 'passkey-options', 20, 15 * 60000);
  const credentials = await all(env.DB, 'SELECT credential_id,transports FROM cf_passkeys ORDER BY created_at');
  if (kind === 'registration' && credentials.length >= 5) fail(409, 'Đã đủ 5 passkey. Xóa passkey cũ trước khi thêm.');
  if (kind === 'authentication' && !credentials.length) fail(409, 'Chưa có passkey. Mở START-CLOUDFLARE-ADMIN.cmd trên máy của bạn để đăng nhập lần đầu.');
  const rp = origin(env), credentialList = credentials.map(row => ({ id: row.credential_id, transports: JSON.parse(row.transports) }));
  const options = kind === 'registration'
    ? await generateRegistrationOptions({ rpName: 'Sentai Shop', rpID: rp.hostname, userName: 'admin', userDisplayName: 'Chủ cửa hàng Sentai', userID: new TextEncoder().encode('sentai-shop-owner'), attestationType: 'none', excludeCredentials: credentialList,
      authenticatorSelection: { residentKey: 'preferred', userVerification: 'required' }, supportedAlgorithmIDs: [-7, -257], timeout: 60000 })
    : await generateAuthenticationOptions({ rpID: rp.hostname, allowCredentials: credentialList, userVerification: 'required', timeout: 60000 });
  const challengeId = random(), db = identity ? authorizedDatabase(env.DB, identity) : env.DB;
  await run(db, 'INSERT INTO cf_auth_challenges(id_hash,kind,challenge,session_hash,expires_at) VALUES(?,?,?,?,?)', digest(challengeId), kind, options.challenge, identity?.hash || null, Date.now() + CHALLENGE);
  return response({ options }, [cookieValue('sentai_challenge', challengeId, CHALLENGE / 1000, '/api/admin/passkeys')]);
}
async function verifyChallenge(request, env, kind, identity) {
  await rateLimit(request, env, 'passkey-verify', 20, 15 * 60000);
  const body = await readJson(request), rawId = cookie(request, 'sentai_challenge');
  if (!validToken(rawId)) fail(401, 'Phiên xác minh đã hết hạn. Hãy thử lại.');
  const id = digest(rawId), challenge = await first(env.DB, 'SELECT * FROM cf_auth_challenges WHERE id_hash=? AND kind=? AND expires_at>? AND session_hash IS ?', id, kind, Date.now(), identity?.hash || null);
  if (!challenge) fail(401, 'Phiên xác minh đã hết hạn hoặc đã sử dụng.');
  const rp = origin(env), expected = { expectedChallenge: challenge.challenge, expectedOrigin: rp.origin, expectedRPID: rp.hostname, requireUserVerification: true };
  let result, credential;
  try {
    if (kind === 'registration') result = await verifyRegistrationResponse({ ...expected, response: body.response, supportedAlgorithmIDs: [-7, -257] });
    else {
      if (typeof body.response?.id !== 'string' || body.response.id.length > 2048) fail(401, 'Passkey không hợp lệ.');
      credential = await first(env.DB, 'SELECT * FROM cf_passkeys WHERE credential_id=?', body.response.id);
      if (!credential) fail(401, 'Passkey không còn được phép đăng nhập.');
      result = await verifyAuthenticationResponse({ ...expected, response: body.response, credential: { id: credential.credential_id, publicKey: new Uint8Array(Buffer.from(credential.public_key, 'base64url')), counter: credential.counter, transports: JSON.parse(credential.transports) } });
    }
    if (!result.verified) fail(401, 'Không xác minh được passkey.');
  } catch {
    await run(env.DB, 'DELETE FROM cf_auth_challenges WHERE id_hash=?', id);
    fail(401, 'Không xác minh được passkey. Hãy thử lại bằng đúng thiết bị.');
  }
  const guardId = crypto.randomUUID(), db = identity ? authorizedDatabase(env.DB, identity) : env.DB;
  const statements = [guard(db, guardId, `EXISTS(SELECT 1 FROM cf_auth_challenges WHERE id_hash=? AND kind=? AND session_hash IS ? AND expires_at>${NOW_SQL})`, id, kind, identity?.hash || null)];
  let session;
  if (kind === 'registration') {
    const registered = result.registrationInfo.credential;
    const label = typeof body.label === 'string' && body.label.trim() ? body.label.trim().slice(0, 80) : 'Passkey của tôi';
    statements.push(guard(db, `${guardId}-cap`, '(SELECT count(*) FROM cf_passkeys)<5'));
    statements.push(db.prepare('INSERT INTO cf_passkeys(credential_id,public_key,counter,transports,label,created_at) VALUES(?,?,?,?,?,?)').bind(registered.id, Buffer.from(registered.publicKey).toString('base64url'), registered.counter, JSON.stringify(registered.transports || []), label, Date.now()));
    statements.push(db.prepare('DELETE FROM cf_integrity_guard WHERE id=?').bind(`${guardId}-cap`));
  } else {
    session = newSession();
    statements.push(guard(db, `${guardId}-counter`, 'EXISTS(SELECT 1 FROM cf_passkeys WHERE credential_id=? AND counter=? AND public_key=?)', credential.credential_id, credential.counter, credential.public_key));
    statements.push(db.prepare('UPDATE cf_passkeys SET counter=? WHERE credential_id=? AND counter=?').bind(result.authenticationInfo.newCounter, credential.credential_id, credential.counter), sessionInsert(db, session), pruneSessions(db));
    statements.push(db.prepare('DELETE FROM cf_integrity_guard WHERE id=?').bind(`${guardId}-counter`));
  }
  statements.push(db.prepare('DELETE FROM cf_auth_challenges WHERE id_hash=?').bind(id), db.prepare('DELETE FROM cf_integrity_guard WHERE id=?').bind(guardId));
  try { await db.batch(statements); }
  catch (error) { if (identity) await assertIdentity(env.DB, identity); fail(409, 'Phiên xác minh đã thay đổi hoặc passkey đã tồn tại. Hãy thử lại.'); }
  return session ? sessionResponse(session) : response({ ok: true }, [cookieValue('sentai_challenge', '', 0, '/api/admin/passkeys')]);
}
export async function handleAuth(request, env, url) {
  const path = url.pathname;
  if (path === '/api/admin/session' && request.method === 'GET') {
    const identity = await verifySession(request, env), count = authConfigured(env) ? (await first(env.DB, 'SELECT count(*) n FROM cf_passkeys')).n : 0;
    return json({ authenticated: Boolean(identity), enabled: authConfigured(env), setup_allowed: false, auth_mode: 'passkey', passkey_available: count > 0,
      ...(identity ? { csrf_token: identity.csrf, passkey_count: count } : {}) });
  }
  const ours = path === '/api/admin/access' || path === '/api/admin/logout' || path.startsWith('/api/admin/passkeys') || ['/api/admin/login', '/api/admin/setup', '/api/admin/reset'].includes(path);
  if (!ours) return null;
  if (!authConfigured(env)) fail(503, 'Cửa hàng chưa hoàn tất cấu hình đăng nhập.');
  if (['POST', 'DELETE'].includes(request.method) && (request.headers.get('origin') !== origin(env).origin || request.headers.get('sec-fetch-site') === 'cross-site')) fail(403, 'Nguồn yêu cầu không hợp lệ.');
  if (path === '/api/admin/access' && request.method === 'POST') return redeem(request, env);
  if (path === '/api/admin/passkeys/authentication/options' && request.method === 'POST') return createChallenge(request, env, 'authentication', null);
  if (path === '/api/admin/passkeys/authentication/verify' && request.method === 'POST') return verifyChallenge(request, env, 'authentication', null);
  if (['/api/admin/login', '/api/admin/setup', '/api/admin/reset'].includes(path)) fail(403, 'Dùng passkey hoặc liên kết đăng nhập từ máy quản lý cửa hàng.');
  const identity = await authenticated(request, env), db = authorizedDatabase(env.DB, identity);
  if (path === '/api/admin/logout' && request.method === 'POST') {
    await db.batch([db.prepare('DELETE FROM cf_auth_challenges WHERE session_hash=?').bind(identity.hash), db.prepare('DELETE FROM cf_admin_sessions WHERE token_hash=?').bind(identity.hash)]);
    return response({ ok: true }, [cookieValue('sentai_session', '', 0), cookieValue('sentai_challenge', '', 0, '/api/admin/passkeys')]);
  }
  if (path === '/api/admin/passkeys/registration/options' && request.method === 'POST') return createChallenge(request, env, 'registration', identity);
  if (path === '/api/admin/passkeys/registration/verify' && request.method === 'POST') return verifyChallenge(request, env, 'registration', identity);
  if (path === '/api/admin/passkeys' && request.method === 'GET') {
    const passkeys = await all(db, 'SELECT credential_id,label,created_at FROM cf_passkeys ORDER BY created_at');
    await assertIdentity(env.DB, identity); return json({ passkeys });
  }
  const remove = path.match(/^\/api\/admin\/passkeys\/([A-Za-z0-9_-]{1,2048})$/);
  if (remove && request.method === 'DELETE') {
    await db.batch([db.prepare('DELETE FROM cf_passkeys WHERE credential_id=?').bind(remove[1]), db.prepare("DELETE FROM cf_auth_challenges WHERE kind='authentication'"), db.prepare('DELETE FROM cf_admin_sessions WHERE token_hash<>?').bind(identity.hash)]);
    return json({ ok: true });
  }
  fail(404, 'Không tìm thấy chức năng đăng nhập.');
}
