import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { closeSync, constants, existsSync, fchmodSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';

export const ORDER_PRIVATE_FIELDS = Object.freeze(['customer_name', 'customer_phone', 'customer_email', 'customer_address', 'note']);
const PREFIX = 'enc:v1:';
const CHECK_VALUE = 'sentai:order-data:v1';
const CHECK_ID = '$key-check';
const CHECK_FIELD = '$key-check';

export class DataProtectionError extends Error {
  constructor() {
    super('Không thể mở dữ liệu đơn hàng an toàn. Kiểm tra khóa mã hóa và bản sao lưu.');
    this.name = 'DataProtectionError';
    this.code = 'DATA_PROTECTION_FAILED';
  }
}
const failure = () => new DataProtectionError();
const encrypted = value => typeof value === 'string' && value.startsWith('enc:');
const aad = (orderId, field) => Buffer.from(JSON.stringify(['sentai-order-data', 1, orderId, field]), 'utf8');

function cipherFor(key) {
  if (!Buffer.isBuffer(key) || key.length !== 32) throw failure();
  return {
    seal(orderId, field, value) {
      if (typeof orderId !== 'string' || !orderId || typeof value !== 'string') throw failure();
      try {
        const iv = randomBytes(12);
        const cipher = createCipheriv('aes-256-gcm', key, iv, {authTagLength:16});
        cipher.setAAD(aad(orderId, field));
        const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
        return PREFIX + Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString('base64url');
      } catch { throw failure(); }
    },
    unseal(orderId, field, value) {
      try {
        if (typeof value !== 'string' || !value.startsWith(PREFIX)) throw failure();
        const encoded = value.slice(PREFIX.length);
        if (!/^[A-Za-z0-9_-]+$/.test(encoded)) throw failure();
        const bytes = Buffer.from(encoded, 'base64url');
        if (bytes.length < 28 || bytes.toString('base64url') !== encoded) throw failure();
        const decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12), {authTagLength:16});
        decipher.setAAD(aad(orderId, field));
        decipher.setAuthTag(bytes.subarray(12, 28));
        return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString('utf8');
      } catch { throw failure(); }
    }
  };
}

function resolvedWithExistingParent(path) {
  let ancestor = resolve(path);
  const missing = [];
  while (!existsSync(ancestor)) {
    const parent = dirname(ancestor);
    if (parent === ancestor) throw failure();
    missing.unshift(basename(ancestor));
    ancestor = parent;
  }
  return resolve(realpathSync(ancestor), ...missing);
}
function isWithin(directory, path) {
  const part = relative(directory, path);
  return part === '' || (!isAbsolute(part) && part !== '..' && !part.startsWith(`..${sep}`));
}
function safeKeyPath(path, publicDirectory) {
  if (typeof path !== 'string' || !path) throw failure();
  const requested = resolve(path);
  const actual = resolvedWithExistingParent(requested);
  const publicActual = resolvedWithExistingParent(publicDirectory);
  if (isWithin(resolve(publicDirectory), requested) || isWithin(publicActual, actual)) throw failure();
  // Reject a key-file symlink even when its target happens to be outside public.
  if (existsSync(requested) && lstatSync(requested).isSymbolicLink()) throw failure();
  return actual;
}
function loadKey(path) {
  let descriptor;
  try {
    descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    const stat = fstatSync(descriptor);
    if (!stat.isFile() || stat.size !== 32) throw failure();
    fchmodSync(descriptor, 0o600);
    const key = readFileSync(descriptor);
    if (key.length !== 32) throw failure();
    return key;
  } finally { if (descriptor !== undefined) closeSync(descriptor); }
}
function persistentKey(path, publicDirectory, requireExisting) {
  try {
    let keyPath = safeKeyPath(path, publicDirectory);
    if (!existsSync(keyPath)) {
      if (requireExisting) throw failure();
      mkdirSync(dirname(keyPath), {recursive:true, mode:0o700});
      keyPath = safeKeyPath(path, publicDirectory);
      let descriptor;
      try {
        descriptor = openSync(keyPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW || 0), 0o600);
        writeFileSync(descriptor, randomBytes(32));
        fsyncSync(descriptor);
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
      } finally { if (descriptor !== undefined) closeSync(descriptor); }
    }
    return {keyPath, key:loadKey(keyPath)};
  } catch { throw failure(); }
}

function protectionState(db) {
  if (!db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='data_protection_state'").get()) return null;
  return db.prepare('SELECT * FROM data_protection_state WHERE id=1').get() || null;
}
function privateRows(db) {
  return db.prepare(`SELECT id,${ORDER_PRIVATE_FIELDS.join(',')} FROM orders`).all();
}
function verifyState(cipher, state) {
  if (state && cipher.unseal(CHECK_ID, CHECK_FIELD, state.key_check) !== CHECK_VALUE) throw failure();
}

// For encrypted backup verification: strictly read-only and never generates a key.
export function validateDataProtectionKey(db, keyBytes) {
  try {
    const cipher = cipherFor(keyBytes);
    const state = protectionState(db);
    verifyState(cipher, state);
    for (const row of privateRows(db)) {
      for (const field of ORDER_PRIVATE_FIELDS) {
        if (state || encrypted(row[field])) cipher.unseal(row.id, field, row[field]);
      }
    }
    return true;
  } catch { throw failure(); }
}

export function initializeOrderDataProtection(db, {keyPath, publicDirectory, inMemory = false}) {
  try {
    const existingState = protectionState(db);
    const hasEncryptedRows = privateRows(db).some(row => ORDER_PRIVATE_FIELDS.some(field => encrypted(row[field])));
    const material = inMemory ? {keyPath:null, key:randomBytes(32)} : persistentKey(keyPath, publicDirectory, Boolean(existingState || hasEncryptedRows));
    const cipher = cipherFor(material.key);
    let scrubRequired = false;
    db.exec('PRAGMA secure_delete=ON; BEGIN IMMEDIATE');
    try {
      const state = protectionState(db);
      verifyState(cipher, state);
      scrubRequired = Boolean(state?.scrub_required);
      const update = db.prepare(`UPDATE orders SET ${ORDER_PRIVATE_FIELDS.map(field => `${field}=?`).join(',')} WHERE id=?`);
      for (const row of privateRows(db)) {
        let changed = false;
        const values = ORDER_PRIVATE_FIELDS.map(field => {
          if (state || encrypted(row[field])) {
            cipher.unseal(row.id, field, row[field]);
            return row[field];
          }
          changed = true;
          return cipher.seal(row.id, field, row[field]);
        });
        if (changed) { update.run(...values, row.id); scrubRequired = true; }
      }
      db.exec(`CREATE TABLE IF NOT EXISTS data_protection_state (
        id INTEGER PRIMARY KEY CHECK(id=1), key_check TEXT NOT NULL,
        scrub_required INTEGER NOT NULL DEFAULT 0 CHECK(scrub_required IN (0,1))
      )`);
      if (!state) db.prepare('INSERT INTO data_protection_state(id,key_check,scrub_required) VALUES(1,?,?)')
        .run(cipher.seal(CHECK_ID, CHECK_FIELD, CHECK_VALUE), Number(scrubRequired));
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
    if (scrubRequired) {
      // Remove legacy plaintext from free pages and old WAL frames. The flag makes
      // cleanup retry after an interrupted first migration, including a busy WAL.
      if (db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get().busy) throw failure();
      db.exec('VACUUM');
      if (db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get().busy) throw failure();
      db.exec('UPDATE data_protection_state SET scrub_required=0 WHERE id=1');
      if (db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get().busy) throw failure();
    }
    return {
      keyPath:material.keyPath,
      encryptFields(orderId, fields) {
        return Object.fromEntries(ORDER_PRIVATE_FIELDS.map(field => [field, cipher.seal(orderId, field, fields[field] ?? '')]));
      },
      decryptFields(orderId, fields) {
        return Object.fromEntries(ORDER_PRIVATE_FIELDS.map(field => [field, cipher.unseal(orderId, field, fields[field])]));
      }
    };
  } catch { throw failure(); }
}
