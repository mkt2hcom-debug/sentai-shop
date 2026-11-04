import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import {
  closeSync, constants, existsSync, fsyncSync, fstatSync, lstatSync, mkdirSync,
  mkdtempSync, openSync, readFileSync, readdirSync, realpathSync, rmSync,
  rmdirSync, statSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync, backup } from 'node:sqlite';
import { validateDataProtectionKey } from './data-protection.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const PUBLIC_DIRECTORY = resolve(ROOT, 'public');
const MAGIC = Buffer.from('SENTAI-BACKUP\0\x01', 'binary');
const IV_BYTES = 12;
const TAG_BYTES = 16;
const MAX_DATABASE_BYTES = 64 * 1024 * 1024;
const MAX_ARCHIVE_BYTES = Math.ceil(MAX_DATABASE_BYTES / 3) * 4 + 8192;
const ORDER_FIELDS = ['customer_name', 'customer_phone', 'customer_email', 'customer_address', 'note'];

export class BackupError extends Error {
  constructor(message) { super(message); this.name = 'BackupError'; }
}

function containedBy(parent, target) {
  const rel = relative(parent, target);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) && !isAbsolute(rel));
}

// Resolve existing ancestors as well: a junction into public must not bypass this check.
function physicalPath(path) {
  const absolute = resolve(path);
  if (existsSync(absolute)) return realpathSync(absolute);
  const parent = dirname(absolute);
  if (parent === absolute) return absolute;
  return join(physicalPath(parent), basename(absolute));
}

function privatePath(path, label) {
  const absolute = resolve(path);
  if (containedBy(PUBLIC_DIRECTORY, absolute) || containedBy(physicalPath(PUBLIC_DIRECTORY), physicalPath(absolute))) {
    throw new BackupError(`${label} phải nằm ngoài thư mục public.`);
  }
  return absolute;
}

function readBounded(path, maxBytes, label) {
  if (lstatSync(path).isSymbolicLink()) throw new BackupError(`${label} không được là liên kết tượng trưng.`);
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    const info = fstatSync(fd);
    if (!info.isFile() || info.size < 1 || info.size > maxBytes) throw new BackupError(`${label} có kích thước không hợp lệ.`);
    const data = readFileSync(fd);
    if (data.length > maxBytes) throw new BackupError(`${label} vượt quá dung lượng cho phép.`);
    return data;
  } finally { closeSync(fd); }
}

function readKey(path) {
  const key = readBounded(privatePath(path, 'Khóa mã hóa'), 32, 'Khóa mã hóa');
  if (key.length !== 32) throw new BackupError('Khóa mã hóa phải có đúng 32 byte.');
  return key;
}

function writeExclusive(path, bytes) {
  const fd = openSync(path, 'wx', 0o600);
  let complete = false;
  try { writeFileSync(fd, bytes); fsyncSync(fd); complete = true; }
  finally { closeSync(fd); if (!complete) unlinkSync(path); }
}

function loadBackupKey(path, outputDirectory) {
  if (existsSync(path)) return readKey(path);
  if (existsSync(outputDirectory) && readdirSync(outputDirectory).some(name => name.endsWith('.sentai-backup'))) {
    throw new BackupError('Đã có bản sao lưu nhưng thiếu khóa. Khôi phục khóa sao lưu cũ trước khi tạo bản mới.');
  }
  mkdirSync(dirname(path), {recursive: true, mode: 0o700});
  const key = randomBytes(32);
  try { writeExclusive(path, key); return key; }
  catch (error) {
    key.fill(0);
    if (error.code === 'EEXIST') return readKey(path);
    throw error;
  }
}

function temporaryDirectory() { return mkdtempSync(join(tmpdir(), 'sentai-backup-')); }

function cleanTemporaryDirectory(path) {
  const absolute = resolve(path);
  if (dirname(absolute) !== resolve(tmpdir()) || !basename(absolute).startsWith('sentai-backup-') || lstatSync(absolute).isSymbolicLink()) {
    throw new BackupError('Không thể xác minh thư mục tạm để dọn dẹp.');
  }
  rmSync(absolute, {recursive: true, force: true});
}

function hasEncryptedOrders(db) {
  if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='data_protection_state'").get()) {
    if (db.prepare('SELECT 1 FROM data_protection_state WHERE id=1').get()) return true;
  }
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='orders'").get()) return false;
  const present = new Set(db.prepare('PRAGMA table_info(orders)').all().map(row => row.name));
  const conditions = ORDER_FIELDS.filter(field => present.has(field)).map(field => `substr("${field}",1,4)='enc:'`);
  return conditions.length > 0 && Boolean(db.prepare(`SELECT 1 FROM orders WHERE ${conditions.join(' OR ')} LIMIT 1`).get());
}

function inspectDatabase(path, orderKey = null) {
  const db = new DatabaseSync(path, {readOnly: true});
  try {
    const check = db.prepare('PRAGMA integrity_check').all();
    if (check.length !== 1 || Object.values(check[0])[0] !== 'ok') throw new BackupError('Bản sao SQLite không vượt qua kiểm tra toàn vẹn.');
    const requiresOrderKey = hasEncryptedOrders(db);
    if (requiresOrderKey && orderKey) validateDataProtectionKey(db, orderKey);
    return {requiresOrderKey};
  } finally { db.close(); }
}

function encryptPayload(payload, key) {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv, {authTagLength: TAG_BYTES});
  cipher.setAAD(MAGIC);
  const plaintext = Buffer.from(JSON.stringify(payload));
  try {
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return Buffer.concat([MAGIC, iv, cipher.getAuthTag(), ciphertext]);
  } finally { plaintext.fill(0); }
}

function decodeBase64(value, maxBytes, label) {
  if (typeof value !== 'string' || value.length > Math.ceil(maxBytes / 3) * 4 || value.length % 4 !== 0 || /[^A-Za-z0-9+/=]/.test(value)) {
    throw new BackupError(`${label} trong bản sao lưu không hợp lệ.`);
  }
  const data = Buffer.from(value, 'base64');
  if (!data.length || data.length > maxBytes || data.toString('base64') !== value) throw new BackupError(`${label} trong bản sao lưu không hợp lệ.`);
  return data;
}

function decryptPayload(archive, key) {
  const offset = MAGIC.length;
  if (archive.length <= offset + IV_BYTES + TAG_BYTES || archive.length > MAX_ARCHIVE_BYTES || !archive.subarray(0, offset).equals(MAGIC)) {
    throw new BackupError('Định dạng hoặc phiên bản bản sao lưu không hợp lệ.');
  }
  const decipher = createDecipheriv('aes-256-gcm', key, archive.subarray(offset, offset + IV_BYTES), {authTagLength: TAG_BYTES});
  decipher.setAAD(MAGIC);
  decipher.setAuthTag(archive.subarray(offset + IV_BYTES, offset + IV_BYTES + TAG_BYTES));
  let plaintext;
  try {
    plaintext = Buffer.concat([decipher.update(archive.subarray(offset + IV_BYTES + TAG_BYTES)), decipher.final()]);
  } catch { throw new BackupError('Không xác thực được bản sao lưu: khóa sai hoặc tệp đã bị thay đổi.'); }
  try {
    const payload = JSON.parse(plaintext.toString('utf8'));
    if (payload?.version !== 1 || typeof payload.createdAt !== 'string' || !Number.isFinite(Date.parse(payload.createdAt))) throw new BackupError('Thông tin bản sao lưu không hợp lệ.');
    const database = decodeBase64(payload.database, MAX_DATABASE_BYTES, 'SQLite');
    const orderKey = payload.orderKey === null ? null : decodeBase64(payload.orderKey, 32, 'Khóa dữ liệu đơn hàng');
    if (orderKey && orderKey.length !== 32) throw new BackupError('Khóa dữ liệu đơn hàng không hợp lệ.');
    return {createdAt: payload.createdAt, database, orderKey};
  } catch (error) {
    if (error instanceof BackupError) throw error;
    throw new BackupError('Nội dung bản sao lưu không hợp lệ.');
  } finally { plaintext.fill(0); }
}

function validatePayload(payload, temporaryPath) {
  writeExclusive(temporaryPath, payload.database);
  const {requiresOrderKey} = inspectDatabase(temporaryPath, payload.orderKey);
  if (requiresOrderKey && !payload.orderKey) throw new BackupError('Bản sao lưu thiếu khóa giải mã dữ liệu đơn hàng.');
}

function paths(options) {
  const databasePath = privatePath(options.databasePath || process.env.DB_PATH || resolve(ROOT, 'data/sentai.sqlite'), 'SQLite');
  return {
    databasePath,
    backupKeyPath: privatePath(options.backupKeyPath || process.env.BACKUP_ENCRYPTION_KEY_FILE || resolve(dirname(databasePath), 'secrets/backup.key'), 'Khóa sao lưu'),
    orderKeyPath: privatePath(options.orderKeyPath || process.env.DATA_ENCRYPTION_KEY_FILE || resolve(dirname(databasePath), 'secrets/order-data.key'), 'Khóa dữ liệu đơn hàng'),
  };
}

/** SQL + its order-decryption key only; media files are not part of this archive. */
export async function createEncryptedBackup(options = {}) {
  const {databasePath, backupKeyPath, orderKeyPath} = paths(options);
  const outputDirectory = privatePath(options.outputDirectory || resolve(ROOT, 'backups'), 'Thư mục sao lưu');
  if (containedBy(physicalPath(outputDirectory), physicalPath(backupKeyPath))) throw new BackupError('Khóa sao lưu phải được lưu riêng, ngoài thư mục chứa bản sao lưu.');
  if (!statSync(databasePath).isFile()) throw new BackupError('Không tìm thấy tệp SQLite.');
  const temporary = temporaryDirectory();
  let key;
  let orderKey;
  let decrypted;
  let outputPath;
  let outputCreated = false;
  try {
    const snapshotPath = join(temporary, 'snapshot.sqlite');
    const db = new DatabaseSync(databasePath, {readOnly: true});
    try { db.exec('PRAGMA busy_timeout=5000'); await backup(db, snapshotPath); }
    finally { db.close(); }
    if (existsSync(orderKeyPath)) orderKey = readKey(orderKeyPath);
    const {requiresOrderKey} = inspectDatabase(snapshotPath, orderKey);
    if (requiresOrderKey && !orderKey) throw new BackupError('Thiếu khóa dữ liệu đơn hàng; chưa tạo bản sao lưu.');
    const database = readBounded(snapshotPath, MAX_DATABASE_BYTES, 'SQLite (giới hạn 64 MiB)');
    key = loadBackupKey(backupKeyPath, outputDirectory);
    const createdAt = new Date().toISOString();
    const archive = encryptPayload({version: 1, createdAt, database: database.toString('base64'), orderKey: orderKey?.toString('base64') || null}, key);
    database.fill(0);
    mkdirSync(outputDirectory, {recursive: true, mode: 0o700});
    outputPath = join(outputDirectory, `sentai-${createdAt.replace(/[:.]/g, '-')}-${randomUUID()}.sentai-backup`);
    writeExclusive(outputPath, archive);
    outputCreated = true;
    decrypted = decryptPayload(readBounded(outputPath, MAX_ARCHIVE_BYTES, 'Bản sao lưu'), key);
    validatePayload(decrypted, join(temporary, 'verified.sqlite'));
    return {path: outputPath, createdAt, databaseBytes: decrypted.database.length, includesOrderKey: Boolean(decrypted.orderKey), verified: true};
  } catch (error) {
    if (outputCreated && outputPath && dirname(outputPath) === outputDirectory) unlinkSync(outputPath);
    throw error;
  } finally {
    key?.fill(0); orderKey?.fill(0); decrypted?.orderKey?.fill(0); decrypted?.database?.fill(0);
    cleanTemporaryDirectory(temporary);
  }
}

/** Authenticates and checks SQLite without extracting to a persistent directory. */
export async function verifyEncryptedBackup(options = {}) {
  if (!options.inputPath) throw new BackupError('Cần đường dẫn bản sao lưu.');
  const {backupKeyPath} = paths(options);
  const key = readKey(backupKeyPath);
  const temporary = temporaryDirectory();
  let payload;
  try {
    payload = decryptPayload(readBounded(resolve(options.inputPath), MAX_ARCHIVE_BYTES, 'Bản sao lưu'), key);
    validatePayload(payload, join(temporary, 'verified.sqlite'));
    return {createdAt: payload.createdAt, databaseBytes: payload.database.length, includesOrderKey: Boolean(payload.orderKey), verified: true};
  } finally { key.fill(0); payload?.orderKey?.fill(0); payload?.database?.fill(0); cleanTemporaryDirectory(temporary); }
}

/** Extracts only into a new directory. Never overwrites or switches the live shop. */
export async function restoreEncryptedBackup(options = {}) {
  if (!options.inputPath || !options.outputDirectory) throw new BackupError('Cần --input và --output; thư mục đích phải chưa tồn tại.');
  const outputDirectory = privatePath(options.outputDirectory, 'Thư mục khôi phục');
  if (existsSync(outputDirectory)) throw new BackupError('Thư mục khôi phục đã tồn tại; không ghi đè dữ liệu.');
  const {backupKeyPath} = paths(options);
  const key = readKey(backupKeyPath);
  const temporary = temporaryDirectory();
  let payload;
  let outputCreated = false;
  const createdFiles = [];
  let secretsCreated = false;
  try {
    payload = decryptPayload(readBounded(resolve(options.inputPath), MAX_ARCHIVE_BYTES, 'Bản sao lưu'), key);
    validatePayload(payload, join(temporary, 'verified.sqlite'));
    mkdirSync(outputDirectory, {mode: 0o700});
    outputCreated = true;
    const databasePath = join(outputDirectory, 'sentai.sqlite');
    writeExclusive(databasePath, payload.database);
    createdFiles.push(databasePath);
    let orderKeyPath = null;
    if (payload.orderKey) {
      const secretsPath = join(outputDirectory, 'secrets');
      mkdirSync(secretsPath, {mode: 0o700});
      secretsCreated = true;
      orderKeyPath = join(secretsPath, 'order-data.key');
      writeExclusive(orderKeyPath, payload.orderKey);
      createdFiles.push(orderKeyPath);
    }
    return {directory: outputDirectory, databasePath, orderKeyPath, createdAt: payload.createdAt, verified: true};
  } catch (error) {
    if (outputCreated && !lstatSync(outputDirectory).isSymbolicLink()) {
      for (const path of createdFiles.reverse()) {
        if (containedBy(outputDirectory, resolve(path))) unlinkSync(path);
      }
      if (secretsCreated) rmdirSync(join(outputDirectory, 'secrets'));
      rmdirSync(outputDirectory);
    }
    throw error;
  } finally { key.fill(0); payload?.orderKey?.fill(0); payload?.database?.fill(0); cleanTemporaryDirectory(temporary); }
}
