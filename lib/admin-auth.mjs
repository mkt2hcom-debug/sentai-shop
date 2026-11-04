import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

const USERNAME = /^[a-z][a-z0-9._-]{2,39}$/;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const RECOVERY_MS = 20 * 60 * 1000;
const PASSWORD_VERSION = 2;
const SCRYPT_OPTIONS = {
  1: {N:16384,r:8,p:1,maxmem:64 * 1024 * 1024},
  2: {N:32768,r:8,p:3,maxmem:64 * 1024 * 1024}
};
const COMMON_PASSWORDS = new Set([
  'passwordpassword','passwordpassword1','123456789012345','1234567890123456',
  '12345678901234567890','qwertyuiopasdfgh','qwertyuiopasdfghjkl',
  'letmeinletmeinletmein','adminadminadmin','iloveyouiloveyou',
  '111111111111111','000000000000000'
]);
// Two memory-hard jobs at once, with a bounded queue shared across auth instances.
let activeHashes = 0;
const waitingHashes = [];
const hash = value => createHash('sha256').update(value).digest();
const normalizeUsername = value => typeof value === 'string' ? value.trim().toLowerCase() : '';
const sameText = (a, b) => timingSafeEqual(hash(String(a)), hash(String(b)));

export class AdminAuthError extends Error {
  constructor(status, message) { super(message); this.name = 'AdminAuthError'; this.status = status; }
}
const fail = (status, message) => { throw new AdminAuthError(status, message); };
const clock = now => {
  const time = new Date(now ?? Date.now()).getTime();
  if (!Number.isFinite(time)) throw new TypeError('Invalid administrator recovery clock.');
  return time;
};

async function passwordDigest(password, salt, version) {
  if (activeHashes >= 2) {
    await new Promise((resolve, reject) => {
      if (waitingHashes.length >= 8) reject(new AdminAuthError(503, 'Đang xử lý nhiều yêu cầu đăng nhập. Vui lòng thử lại sau.'));
      else waitingHashes.push(resolve);
    });
  } else activeHashes++;
  try {
    return await new Promise((resolve, reject) => {
      scrypt(password,salt,64,SCRYPT_OPTIONS[version],(error, key) => error ? reject(error) : resolve(key));
    });
  } finally {
    const next = waitingHashes.shift();
    if (next) next();
    else activeHashes--;
  }
}

async function prepareCredential(value) {
  const salt = randomBytes(16).toString('hex');
  const digest = await passwordDigest(value.password,salt,PASSWORD_VERSION);
  return {username:value.username,passwordHash:digest.toString('hex'),salt};
}

const sameCredential = (a, b) => Boolean(a && b && a.username === b.username &&
  a.password_hash === b.password_hash && a.salt === b.salt && a.password_version === b.password_version);

export function ensureAdminAuthSchema(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS admin_credentials (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    username TEXT NOT NULL DEFAULT 'admin',
    password_hash TEXT NOT NULL,
    salt TEXT NOT NULL,
    password_version INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );`);
  if (!db.prepare('PRAGMA table_info(admin_credentials)').all().some(column => column.name === 'username')) {
    db.exec("ALTER TABLE admin_credentials ADD COLUMN username TEXT NOT NULL DEFAULT 'admin'");
  }
  if (!db.prepare('PRAGMA table_info(admin_credentials)').all().some(column => column.name === 'password_version')) {
    db.exec('ALTER TABLE admin_credentials ADD COLUMN password_version INTEGER NOT NULL DEFAULT 1');
  }
  db.exec(`CREATE TABLE IF NOT EXISTS admin_recovery (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    token_hash TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL
  );`);
}

function credentials(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) fail(400, 'Thông tin tài khoản không hợp lệ.');
  const username = normalizeUsername(body.username);
  if (!USERNAME.test(username)) fail(400, 'Tài khoản cần 3–40 ký tự, bắt đầu bằng chữ; chỉ dùng chữ không dấu, số, dấu chấm, gạch dưới hoặc gạch ngang.');
  if (typeof body.password !== 'string' || body.password.length > 256) fail(400, 'Mật khẩu cần từ 15 đến 128 ký tự.');
  const length = Array.from(body.password).length;
  if (length < 15 || length > 128) fail(400, 'Mật khẩu cần từ 15 đến 128 ký tự.');
  if (COMMON_PASSWORDS.has(body.password.toLowerCase())) fail(400, 'Mật khẩu này quá phổ biến. Hãy chọn một cụm từ riêng, dài từ 15 ký tự.');
  return {username,password:body.password};
}

export function createAdminAuth({db, password = '', username = 'admin'}) {
  ensureAdminAuthSchema(db);
  const override = typeof password === 'string' && password.length >= 12;
  const configuredUsername = normalizeUsername(username);
  if (override && !USERNAME.test(configuredUsername)) fail(503, 'ADMIN_USERNAME cần 3–40 ký tự hợp lệ và bắt đầu bằng chữ.');
  const saved = () => db.prepare('SELECT * FROM admin_credentials WHERE id=1').get();
  const noOverride = () => {
    if (override) fail(409, 'Đang dùng ADMIN_PASSWORD trong cấu hình. Để trống ADMIN_PASSWORD và khởi động lại máy chủ trước khi đặt lại tài khoản trong SQL.');
  };
  const writeCredential = ({username,passwordHash,salt}) => {
    db.prepare(`INSERT INTO admin_credentials(id,username,password_hash,salt,password_version) VALUES(1,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET username=excluded.username,password_hash=excluded.password_hash,salt=excluded.salt,password_version=excluded.password_version`)
      .run(username,passwordHash,salt,PASSWORD_VERSION);
  };
  const validRecovery = (token, now) => {
    const recovery = db.prepare('SELECT * FROM admin_recovery WHERE id=1').get();
    if (!recovery || !/^[a-f0-9]{64}$/i.test(recovery.token_hash) || !timingSafeEqual(hash(token),Buffer.from(recovery.token_hash,'hex'))) fail(401, 'Liên kết đặt lại không hợp lệ hoặc đã được sử dụng.');
    const expiry = Date.parse(recovery.expires_at);
    if (!Number.isFinite(expiry) || expiry <= clock(now)) fail(410, 'Liên kết đặt lại đã hết hạn. Chạy lại lệnh khôi phục trên máy chủ.');
    return recovery;
  };

  return {
    enabled() { return override || Boolean(saved()); },
    identity() {
      if (override) return hash(JSON.stringify(['environment',configuredUsername,password])).toString('hex');
      const row = saved();
      return row ? hash(JSON.stringify(['database',row.username,row.password_hash,row.salt,row.password_version])).toString('hex') : null;
    },
    async verifyLogin(body) {
      if (!body || typeof body !== 'object' || Array.isArray(body) || typeof body.password !== 'string' || body.password.length > 1024) return false;
      const name = normalizeUsername(body.username);
      if (!USERNAME.test(name)) return false;
      if (override) {
        const validPassword = sameText(body.password,password);
        return sameText(name,configuredUsername) && validPassword;
      }
      const row = saved();
      if (!row || !Object.hasOwn(SCRYPT_OPTIONS,row.password_version) || !/^[a-f0-9]{128}$/i.test(row.password_hash) || !/^[a-f0-9]{32}$/i.test(row.salt)) return false;
      const suppliedPassword = body.password;
      const digest = await passwordDigest(suppliedPassword,row.salt,row.password_version);
      if (!timingSafeEqual(digest,Buffer.from(row.password_hash,'hex')) || !sameText(name,row.username) || !sameCredential(row,saved())) return false;
      if (row.password_version === PASSWORD_VERSION) return true;
      // Upgrade only the exact credential verified above; a reset must win a race.
      const upgraded = await prepareCredential({username:row.username,password:suppliedPassword});
      const result = db.prepare(`UPDATE admin_credentials SET password_hash=?,salt=?,password_version=?
        WHERE id=1 AND username=? AND password_hash=? AND salt=? AND password_version=?`)
        .run(upgraded.passwordHash,upgraded.salt,PASSWORD_VERSION,row.username,row.password_hash,row.salt,row.password_version);
      return result.changes === 1;
    },
    async setup(body) {
      const value = credentials(body);
      if (override || saved()) fail(403, 'Tài khoản quản trị đã được thiết lập.');
      const prepared = await prepareCredential(value);
      db.exec('BEGIN IMMEDIATE');
      try {
        if (override || saved()) fail(403, 'Tài khoản quản trị đã được thiết lập.');
        writeCredential(prepared);
        db.exec('COMMIT');
      } catch (error) { db.exec('ROLLBACK'); throw error; }
      return {username:value.username};
    },
    issueRecovery({now} = {}) {
      noOverride();
      if (!saved()) fail(409, 'Chưa có tài khoản quản trị. Mở /admin trên máy chủ để thiết lập lần đầu.');
      const current = clock(now);
      const token = randomBytes(32).toString('base64url');
      const expiresAt = new Date(current + RECOVERY_MS).toISOString();
      db.prepare(`INSERT INTO admin_recovery(id,token_hash,expires_at,created_at) VALUES(1,?,?,?)
        ON CONFLICT(id) DO UPDATE SET token_hash=excluded.token_hash,expires_at=excluded.expires_at,created_at=excluded.created_at`)
        .run(hash(token).toString('hex'),expiresAt,new Date(current).toISOString());
      return {token,expires_at:expiresAt};
    },
    async reset(body, {now} = {}) {
      noOverride();
      const value = credentials(body);
      if (typeof body.token !== 'string' || !TOKEN.test(body.token)) fail(401, 'Liên kết đặt lại không hợp lệ hoặc đã được sử dụng.');
      const token = body.token;
      const recovery = validRecovery(token,now);
      if (!saved()) fail(409, 'Tài khoản quản trị không còn tồn tại.');
      const prepared = await prepareCredential(value);
      db.exec('BEGIN IMMEDIATE');
      try {
        const current = validRecovery(token,now);
        if (current.token_hash !== recovery.token_hash || current.expires_at !== recovery.expires_at || current.created_at !== recovery.created_at) fail(401, 'Liên kết đặt lại không hợp lệ hoặc đã được sử dụng.');
        if (!saved()) fail(409, 'Tài khoản quản trị không còn tồn tại.');
        writeCredential(prepared);
        db.prepare('DELETE FROM admin_recovery WHERE id=1').run();
        db.exec('COMMIT');
      } catch (error) { db.exec('ROLLBACK'); throw error; }
      return {username:value.username};
    }
  };
}
