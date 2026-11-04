import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { randomBytes } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, relative, resolve, sep } from 'node:path';
import { execFileSync } from 'node:child_process';
import { encryptOrderFields, getDataProtectionInfo, getOrder, openDatabase, ROOT } from '../lib/database.mjs';
import { DataProtectionError, initializeOrderDataProtection, ORDER_PRIVATE_FIELDS, validateDataProtectionKey } from '../lib/data-protection.mjs';

const PRIVATE = Object.freeze({customer_name:'Nguyễn Hải - khách riêng tư', customer_phone:'0912345678',
  customer_email:'private-customer@example.test', customer_address:'123 Đường Bí Mật, TP Hồ Chí Minh', note:'Gọi trước khi giao cho anh Hải'});
const schema = readFileSync(resolve(ROOT, 'database/schema.sql'), 'utf8');
const protectedError = error => error instanceof DataProtectionError && error.code === 'DATA_PROTECTION_FAILED'
  && !JSON.stringify(error).includes(PRIVATE.customer_phone) && !error.message.includes('enc:');

function sandbox(t) {
  const path = mkdtempSync(resolve(tmpdir(), 'sentai-data-protection-'));
  const databases = [];
  t.after(() => {
    for (const db of databases) { try { db.close(); } catch {} }
    const child = relative(resolve(tmpdir()), resolve(path));
    assert.ok(child && child !== '..' && !child.startsWith(`..${sep}`));
    assert.ok(path.startsWith(resolve(tmpdir(), 'sentai-data-protection-')));
    rmSync(path, {recursive:true, force:true});
  });
  return {path, database:resolve(path, 'shop.sqlite'), key:resolve(path, 'secrets/order-data.key'),
    keep(db) { databases.push(db); return db; }};
}
function insertOrder(db, id, fields = PRIVATE) {
  db.prepare(`INSERT INTO orders(id,order_number,idempotency_key,request_hash,${ORDER_PRIVATE_FIELDS.join(',')},subtotal,total,status,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,100000,100000,'confirmed','2026-10-01T04:00:00Z','2026-10-02T04:00:00Z')`)
    .run(id, `SENTAI-${id}`, `idempotent-${id}`, `hash-${id}`, ...ORDER_PRIVATE_FIELDS.map(field => fields[field]));
}
function insertProduct(db) {
  db.exec(`INSERT INTO products(id,name,series,source_sheet,source_row) VALUES('test-product','Blue Ressha','TOQGER','Sheet1',84)`);
}
function legacyDatabase(box) {
  const db = box.keep(new DatabaseSync(box.database));
  db.exec(schema);
  return db;
}
function rawPrivate(db, id = 'one') {
  return db.prepare(`SELECT ${ORDER_PRIVATE_FIELDS.join(',')} FROM orders WHERE id=?`).get(id);
}

test('new orders encrypt every private field with random nonces and decrypt only through getOrder', t => {
  const db = openDatabase(':memory:');
  t.after(() => db.close());
  const first = encryptOrderFields(db, 'one', PRIVATE);
  const second = encryptOrderFields(db, 'one', PRIVATE);
  for (const field of ORDER_PRIVATE_FIELDS) {
    assert.match(first[field], /^enc:v1:[A-Za-z0-9_-]+$/);
    assert.notEqual(first[field], second[field]);
    assert.equal(first[field].includes(PRIVATE[field]), false);
  }
  insertOrder(db, 'one', first);
  const order = getOrder(db, 'one');
  for (const field of ORDER_PRIVATE_FIELDS) assert.equal(order[field], PRIVATE[field]);
  assert.equal(order.request_hash, undefined);
  assert.equal(order.idempotency_key, undefined);
  assert.equal(getOrder(db, 'missing'), null);
  assert.deepEqual(getDataProtectionInfo(db), {keyPath:null});
  assert.deepEqual(ORDER_PRIVATE_FIELDS.map(field => rawPrivate(db)[field]), ORDER_PRIVATE_FIELDS.map(field => first[field]));
});

test('persistent key survives restart and empty optional fields are also authenticated', t => {
  const box = sandbox(t);
  let db = box.keep(openDatabase(box.database));
  const fields = {...PRIVATE, customer_email:'', note:''};
  insertOrder(db, 'one', encryptOrderFields(db, 'one', fields));
  assert.equal(readFileSync(box.key).length, 32);
  if (process.platform !== 'win32') assert.equal(statSync(box.key).mode & 0o777, 0o600);
  assert.equal(getDataProtectionInfo(db).keyPath, box.key);
  const before = rawPrivate(db);
  db.close();
  db = box.keep(openDatabase(box.database));
  assert.deepEqual(rawPrivate(db), before, 'startup does not reencrypt existing records');
  for (const field of ORDER_PRIVATE_FIELDS) assert.equal(getOrder(db, 'one')[field], fields[field]);
  assert.equal(validateDataProtectionKey(db, readFileSync(box.key)), true);
});

test('legacy migration preserves orders, items, idempotency, credentials and recovery while removing plaintext pages', t => {
  const box = sandbox(t);
  let db = legacyDatabase(box);
  db.exec('PRAGMA journal_mode=WAL');
  insertProduct(db);
  insertOrder(db, 'one');
  db.exec(`INSERT INTO order_items(id,order_id,product_id,product_name,unit_price,quantity,line_total)
    VALUES(1,'one','test-product','Blue Ressha',100000,1,100000);
    INSERT INTO order_item_options VALUES(1,'Blue Ressha','Món 02','Bộ sưu tập xanh','Đã dùng, đủ đồ');
    INSERT INTO admin_credentials(id,username,password_hash,salt) VALUES(1,'owner','keep-hash','keep-salt');
    INSERT INTO admin_recovery(id,token_hash,expires_at,created_at) VALUES(1,'keep-recovery','2026-11-05T00:00:00Z','2026-11-04T00:00:00Z')`);
  const originalOrder = db.prepare('SELECT * FROM orders WHERE id=?').get('one');
  const items = db.prepare('SELECT * FROM order_items').all();
  const options = db.prepare('SELECT * FROM order_item_options').all();
  const account = db.prepare('SELECT username,password_hash,salt,created_at FROM admin_credentials').get();
  const recovery = db.prepare('SELECT * FROM admin_recovery').get();
  db.close();
  db = box.keep(openDatabase(box.database));
  const current = db.prepare('SELECT * FROM orders WHERE id=?').get('one');
  for (const [field, value] of Object.entries(originalOrder)) {
    if (ORDER_PRIVATE_FIELDS.includes(field)) {
      assert.match(current[field], /^enc:v1:/);
      assert.equal(getOrder(db, 'one')[field], value);
    } else assert.equal(current[field], value);
  }
  assert.deepEqual(db.prepare('SELECT * FROM order_items').all(), items);
  assert.deepEqual(db.prepare('SELECT * FROM order_item_options').all(), options);
  assert.deepEqual(db.prepare('SELECT username,password_hash,salt,created_at FROM admin_credentials').get(), account);
  assert.deepEqual(db.prepare('SELECT * FROM admin_recovery').get(), recovery);
  assert.equal(db.prepare('SELECT scrub_required FROM data_protection_state').get().scrub_required, 0);
  assert.equal(db.prepare('PRAGMA quick_check').get().quick_check, 'ok');
  db.close();
  for (const path of [box.database, `${box.database}-wal`]) {
    if (!existsSync(path)) continue;
    const bytes = readFileSync(path);
    for (const value of Object.values(PRIVATE)) assert.equal(bytes.includes(Buffer.from(value)), false, 'legacy plaintext is absent from database and WAL bytes');
  }
});

test('ciphertext tampering, unsupported envelopes and plaintext substitution fail closed', t => {
  const db = openDatabase(':memory:');
  t.after(() => db.close());
  const fields = encryptOrderFields(db, 'one', PRIVATE);
  insertOrder(db, 'one', fields);
  const bytes = Buffer.from(fields.customer_phone.slice('enc:v1:'.length), 'base64url');
  bytes[bytes.length - 1] ^= 1;
  for (const replacement of [`enc:v1:${bytes.toString('base64url')}`, 'enc:v2:unsupported', 'enc:v1:not+base64', PRIVATE.customer_phone, '']) {
    db.prepare('UPDATE orders SET customer_phone=? WHERE id=?').run(replacement, 'one');
    assert.throws(() => getOrder(db, 'one'), protectedError);
  }
});

test('authenticated context rejects copied fields and orders, even under the same key', t => {
  const db = openDatabase(':memory:');
  t.after(() => db.close());
  const one = encryptOrderFields(db, 'one', PRIVATE);
  const two = encryptOrderFields(db, 'two', PRIVATE);
  insertOrder(db, 'one', one);
  insertOrder(db, 'two', two);
  db.prepare('UPDATE orders SET customer_phone=? WHERE id=?').run(one.customer_name, 'one');
  assert.throws(() => getOrder(db, 'one'), protectedError);
  db.prepare('UPDATE orders SET customer_phone=? WHERE id=?').run(one.customer_phone, 'two');
  assert.throws(() => getOrder(db, 'two'), protectedError);
});

test('missing, corrupted or wrong key never regenerates a key for protected data, including an empty shop', t => {
  for (const populated of [false, true]) {
    const box = sandbox(t);
    const db = box.keep(openDatabase(box.database));
    if (populated) insertOrder(db, 'one', encryptOrderFields(db, 'one', PRIVATE));
    const goodKey = readFileSync(box.key);
    assert.throws(() => validateDataProtectionKey(db, randomBytes(32)), protectedError);
    db.close();
    for (const badKey of [Buffer.alloc(0), randomBytes(12), randomBytes(32), randomBytes(64)]) {
      writeFileSync(box.key, badKey);
      assert.throws(() => openDatabase(box.database), protectedError);
      assert.deepEqual(readFileSync(box.key), badKey);
    }
    const missingPath = resolve(box.path, 'missing-key');
    assert.throws(() => openDatabase(box.database, {encryptionKeyPath:missingPath}), protectedError);
    assert.equal(existsSync(missingPath), false);
    writeFileSync(box.key, goodKey);
    const reopened = box.keep(openDatabase(box.database));
    assert.equal(validateDataProtectionKey(reopened, goodKey), true);
    if (populated) assert.equal(getOrder(reopened, 'one').customer_phone, PRIVATE.customer_phone);
  }
});

test('startup rejects plaintext or damaged ciphertext after migration, instead of silently trusting new plaintext', t => {
  const box = sandbox(t);
  const db = box.keep(openDatabase(box.database));
  insertOrder(db, 'one', encryptOrderFields(db, 'one', PRIVATE));
  const valid = rawPrivate(db).customer_name;
  db.prepare('UPDATE orders SET customer_name=? WHERE id=?').run(PRIVATE.customer_name, 'one');
  db.close();
  assert.throws(() => openDatabase(box.database), protectedError);
  const raw = box.keep(new DatabaseSync(box.database));
  raw.prepare('UPDATE orders SET customer_name=? WHERE id=?').run(`${valid}bad`, 'one');
  assert.throws(() => openDatabase(box.database), protectedError);
});

test('encrypted legacy rows without a migration marker still require the original key', t => {
  const box = sandbox(t);
  const db = box.keep(openDatabase(box.database));
  insertOrder(db, 'one', encryptOrderFields(db, 'one', PRIVATE));
  db.exec('DROP TABLE data_protection_state');
  db.close();
  const missingPath = resolve(box.path, 'different-key');
  assert.throws(() => openDatabase(box.database, {encryptionKeyPath:missingPath}), protectedError);
  assert.equal(existsSync(missingPath), false);
  const reopened = box.keep(openDatabase(box.database));
  assert.equal(getOrder(reopened, 'one').customer_address, PRIVATE.customer_address);
  assert.equal(reopened.prepare('SELECT count(*) n FROM data_protection_state').get().n, 1);
});

test('an explicit key location takes precedence over the environment while an empty environment uses the default', t => {
  const box = sandbox(t);
  const before = process.env.DATA_ENCRYPTION_KEY_FILE;
  try {
    process.env.DATA_ENCRYPTION_KEY_FILE = '';
    const defaultDb = box.keep(openDatabase(box.database));
    assert.equal(getDataProtectionInfo(defaultDb).keyPath, box.key);
    defaultDb.close();
    const environmentKey = resolve(box.path, 'environment.key');
    process.env.DATA_ENCRYPTION_KEY_FILE = environmentKey;
    const explicitDb = box.keep(openDatabase(box.database, {encryptionKeyPath:box.key}));
    assert.equal(getDataProtectionInfo(explicitDb).keyPath, box.key);
    assert.equal(existsSync(environmentKey), false);
    const environmentDb = box.keep(openDatabase(resolve(box.path, 'other.sqlite')));
    assert.equal(getDataProtectionInfo(environmentDb).keyPath, environmentKey);
    assert.equal(readFileSync(environmentKey).length, 32);
  } finally {
    if (before === undefined) delete process.env.DATA_ENCRYPTION_KEY_FILE;
    else process.env.DATA_ENCRYPTION_KEY_FILE = before;
  }
});

test('key paths inside public or through a junction into public are rejected before key creation', t => {
  const box = sandbox(t);
  const publicDirectory = resolve(box.path, 'public');
  mkdirSync(publicDirectory);
  const db = box.keep(new DatabaseSync(':memory:'));
  db.exec(schema);
  const inside = resolve(publicDirectory, 'keys/order.key');
  assert.throws(() => initializeOrderDataProtection(db, {keyPath:inside, publicDirectory}), protectedError);
  assert.equal(existsSync(inside), false);
  const alias = resolve(box.path, 'public-alias');
  try { symlinkSync(publicDirectory, alias, process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) { if (error.code === 'EPERM') { t.diagnostic('OS does not allow junction creation'); return; } throw error; }
  const viaAlias = resolve(alias, 'order.key');
  assert.throws(() => initializeOrderDataProtection(db, {keyPath:viaAlias, publicDirectory}), protectedError);
  assert.equal(existsSync(viaAlias), false);
});

test('failed legacy validation rolls back other plaintext rows and leaves ciphertext unchanged', t => {
  const box = sandbox(t);
  const key = randomBytes(32);
  mkdirSync(dirname(box.key), {recursive:true});
  writeFileSync(box.key, key, {mode:0o600});
  const db = legacyDatabase(box);
  insertOrder(db, 'one');
  insertOrder(db, 'two', {...PRIVATE, customer_phone:'enc:v1:invalid'});
  const before = db.prepare('SELECT * FROM orders ORDER BY id').all();
  db.close();
  assert.throws(() => openDatabase(box.database), protectedError);
  const raw = box.keep(new DatabaseSync(box.database));
  assert.deepEqual(raw.prepare('SELECT * FROM orders ORDER BY id').all(), before);
  assert.deepEqual(readFileSync(box.key), key);
  assert.equal(raw.prepare("SELECT 1 FROM sqlite_schema WHERE name='data_protection_state'").get(), undefined);
});

test('catalog export contains catalog only and never customer data, encrypted order rows or key material', t => {
  const box = sandbox(t);
  const db = box.keep(openDatabase(box.database));
  insertProduct(db);
  insertOrder(db, 'one', encryptOrderFields(db, 'one', PRIVATE));
  const ciphertext = rawPrivate(db).customer_name;
  db.close();
  // Run the real export in an isolated project copy so its fixed output path is safe.
  for (const file of ['scripts/export_database.mjs', 'lib/database.mjs', 'lib/data-protection.mjs', 'lib/admin-auth.mjs', 'database/schema.sql']) {
    const destination = resolve(box.path, file);
    mkdirSync(dirname(destination), {recursive:true});
    copyFileSync(resolve(ROOT, file), destination);
  }
  execFileSync(process.execPath, ['scripts/export_database.mjs'], {
    cwd:box.path, env:{...process.env, DB_PATH:box.database, DATA_ENCRYPTION_KEY_FILE:box.key}, stdio:'pipe'
  });
  const sql = readFileSync(resolve(box.path, 'database/catalog.sql'), 'utf8');
  assert.match(sql, /INSERT OR IGNORE INTO products/);
  for (const value of [...Object.values(PRIVATE), ciphertext, readFileSync(box.key).toString('base64')]) assert.equal(sql.includes(value), false);
  assert.doesNotMatch(sql, /INSERT(?: OR IGNORE)? INTO (?:orders|admin_credentials|admin_recovery|data_protection_state)/);
});
