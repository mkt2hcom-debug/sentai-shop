import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export class SecurityError extends Error {
  constructor(status,message,code) { super(message); this.name='SecurityError';this.status=status;this.code=code; }
}
const digest = value => createHash('sha256').update(String(value)).digest();
const localAddress = value => ['127.0.0.1','::1','::ffff:127.0.0.1'].includes(value);
const localHost = value => ['127.0.0.1','localhost','[::1]'].includes(value);

export function deploymentOrigin(value='') {
  if (!value) return '';
  let url;
  try { url=new URL(value); } catch { throw new Error('PUBLIC_ORIGIN phải là địa chỉ HTTPS hợp lệ.'); }
  if (url.protocol!=='https:' || url.username || url.password || url.pathname!=='/' || url.search || url.hash) throw new Error('PUBLIC_ORIGIN chỉ được chứa HTTPS và tên miền, không có đường dẫn hoặc thông tin đăng nhập.');
  return url.origin;
}
export function validateTransport(req,origin) {
  let host;
  try { host=new URL(`http://${req.headers.host}`).hostname; } catch { throw new SecurityError(400,'Địa chỉ máy chủ không hợp lệ.'); }
  if (!origin) {
    if (!localAddress(req.socket.remoteAddress) || !localHost(host)) throw new SecurityError(403,'Cửa hàng đang ở chế độ cục bộ. Cần cấu hình HTTPS trước khi truy cập từ mạng.');
    return;
  }
  if (host!==new URL(origin).hostname && !localHost(host)) throw new SecurityError(403,'Tên miền yêu cầu không hợp lệ.');
  if (!req.socket.encrypted && !(localAddress(req.socket.remoteAddress) && req.headers['x-forwarded-proto']==='https')) throw new SecurityError(426,'Cần kết nối HTTPS qua proxy cục bộ đã cấu hình.');
}
export function securityHeaders(res,origin) {
  res.setHeader('X-Content-Type-Options','nosniff');
  res.setHeader('Referrer-Policy','no-referrer');
  res.setHeader('X-Frame-Options','DENY');
  res.setHeader('Cross-Origin-Resource-Policy','same-origin');
  res.setHeader('Cross-Origin-Opener-Policy','same-origin');
  res.setHeader('Permissions-Policy','camera=(), microphone=(), geolocation=(), payment=(), usb=()');
  res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; font-src 'self'; connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'"+(origin?'; upgrade-insecure-requests':''));
  if (origin) res.setHeader('Strict-Transport-Security','max-age=31536000');
}

export function createSessionStore({identity,now=Date.now,idleMs=15*60*1000,absoluteMs=8*60*60*1000}={}) {
  const sessions=new Map();
  const tokenFrom = req => (req.headers.cookie || '').split(';').map(value=>value.trim()).find(value=>value.startsWith('sentai_session='))?.slice(15) || '';
  const tokenKey = token => digest(token).toString('hex');
  function clean() { const at=now();for (const [key,value] of sessions) if (value.expires<=at || value.lastSeen+idleMs<=at) sessions.delete(key); }
  return {
    create(req) {
      clean();
      const previous=tokenFrom(req);if(previous)sessions.delete(tokenKey(previous));
      while(sessions.size>=50)sessions.delete(sessions.keys().next().value);
      const token=randomBytes(32).toString('hex'),csrf=randomBytes(32).toString('hex'),at=now();
      sessions.set(tokenKey(token),{identity:identity(),expires:at+absoluteMs,lastSeen:at,csrf});
      return {token,csrf,maxAge:Math.floor(absoluteMs/1000)};
    },
    get(req,{touch=true}={}) {
      clean();const token=tokenFrom(req);if(!/^[a-f0-9]{64}$/.test(token))return null;
      const key=tokenKey(token),session=sessions.get(key);
      if(!session || !session.identity || session.identity!==identity()){sessions.delete(key);return null;}
      if(touch)session.lastSeen=now();
      return session;
    },
    checkCSRF(req,session) {
      const value=req.headers['x-csrf-token'];
      if(typeof value!=='string' || !/^[a-f0-9]{64}$/.test(value) || !timingSafeEqual(digest(value),digest(session.csrf))) throw new SecurityError(403,'Phiên thao tác không hợp lệ. Tải lại trang rồi thử lại.','CSRF_INVALID');
    },
    remove(req){sessions.delete(tokenKey(tokenFrom(req)));},
    clear(){sessions.clear();}
  };
}

export function ensureSecuritySchema(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS security_events (
    id INTEGER PRIMARY KEY, event TEXT NOT NULL, method TEXT NOT NULL, resource TEXT NOT NULL,
    status INTEGER NOT NULL, created_at TEXT NOT NULL
  );CREATE INDEX IF NOT EXISTS security_events_created_idx ON security_events(created_at);
  CREATE TABLE IF NOT EXISTS security_limits (bucket TEXT PRIMARY KEY,count INTEGER NOT NULL,expires_at INTEGER NOT NULL);`);
}
export function checkPersistentLoginRate(db,now=Date.now()) {
  const row=db.prepare("SELECT * FROM security_limits WHERE bucket='admin-login'").get();
  if(row && row.expires_at>now && row.count>=30)throw new SecurityError(429,'Đăng nhập quá nhiều lần. Vui lòng thử lại sau 15 phút.');
  db.prepare(`INSERT INTO security_limits(bucket,count,expires_at) VALUES('admin-login',1,?)
    ON CONFLICT(bucket) DO UPDATE SET count=CASE WHEN expires_at<=? THEN 1 ELSE count+1 END,
    expires_at=CASE WHEN expires_at<=? THEN excluded.expires_at ELSE expires_at END`).run(now+15*60*1000,now,now);
}
export function auditResponse(db,{path,method,status,now=Date.now()}) {
  if(!path.startsWith('/api/admin/') || !(['POST','PATCH','DELETE'].includes(method) || [401,403,429].includes(status)))return;
  const route=path.match(/^\/api\/admin\/(session|login|logout|setup|reset|products|orders|media|prices|analytics|security)(?:\/|$)/)?.[1] || 'unknown';
  const event=['login','logout','setup','reset'].includes(route)?`auth.${route}`:status>=400?'admin.denied':'admin.changed';
  const resource=path.match(/^\/api\/admin\/(?:products|orders|media)\/(sentai-row-\d{1,6}|[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})(?:\/|$)/)?.[1] || route;
  db.prepare('INSERT INTO security_events(event,method,resource,status,created_at) VALUES(?,?,?,?,?)').run(event,method,resource,status,new Date(now).toISOString());
  // Retain the newest 10,000 events without allowing denied-request floods to
  // grow the audit table indefinitely. IDs avoid timestamp ordering ambiguity.
  db.exec('DELETE FROM security_events WHERE id <= (SELECT id FROM security_events ORDER BY id DESC LIMIT 1 OFFSET 10000)');
}
