export class HttpError extends Error {
  constructor(status, message, code) { super(message); this.name = 'HttpError'; this.status = status; this.code = code; }
}
export const fail = (status, message, code) => { throw new HttpError(status, message, code); };
export function textField(value, label, min, max) {
  if (value == null && min === 0) return '';
  if (typeof value !== 'string' || value.trim().length < min || value.trim().length > max) fail(400, `${label} cần có từ ${min} đến ${max} ký tự.`);
  return value.trim();
}
const authChecks = new WeakMap();
export const setAuthCheck = (request, check) => authChecks.set(request, check);
export const assertAuthorized = async request => { await authChecks.get(request)?.(); };
export async function readJson(request) {
  if (!/^application\/json(?:;|$)/i.test(request.headers.get('content-type') || '')) fail(415, 'Yêu cầu dữ liệu JSON.');
  if (Number(request.headers.get('content-length')) > 65536) fail(413, 'Dữ liệu gửi lên quá lớn.');
  const reader = request.body?.getReader();
  let size = 0;
  const chunks = [];
  if (reader) {
    while (true) {
      const {value, done} = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 65536) { await reader.cancel(); fail(413, 'Dữ liệu gửi lên quá lớn.'); }
      chunks.push(value);
    }
  }
  await assertAuthorized(request);
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  let data;
  try { data = JSON.parse(new TextDecoder('utf-8', {fatal:true}).decode(bytes)); }
  catch { fail(400, 'Dữ liệu JSON không hợp lệ.'); }
  if (!data || typeof data !== 'object' || Array.isArray(data)) fail(400, 'Dữ liệu không hợp lệ.');
  return data;
}
export function json(data, status = 200) {
  return new Response(JSON.stringify(data), {status, headers:{'Content-Type':'application/json; charset=utf-8', 'Cache-Control':'no-store'}});
}
export const all = async (db, sql, ...args) => (await db.prepare(sql).bind(...args).all()).results;
export const first = (db, sql, ...args) => db.prepare(sql).bind(...args).first();
export const run = (db, sql, ...args) => db.prepare(sql).bind(...args).run();
