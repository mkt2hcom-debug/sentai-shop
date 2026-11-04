import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createCipheriv, randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { createEncryptedBackup, restoreEncryptedBackup, verifyEncryptedBackup } from '../lib/backup.mjs';
import { initializeOrderDataProtection } from '../lib/data-protection.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const PRIVATE_FIELDS = ['customer_name', 'customer_phone', 'customer_email', 'customer_address', 'note'];
const CUSTOMER = ['Khách riêng tư 73951', '0912345678', 'private-customer@example.invalid', 'Địa chỉ bí mật 73951', 'Ghi chú riêng của khách'];
const WAL_PRODUCT = 'PRODUCT ONLY IN WAL 482729';

function fixture(t, {encrypted = true} = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'sentai-backup-test-'));
  const databasePath = join(directory, 'sentai.sqlite');
  const orderKeyPath = join(directory, 'secrets', 'order-data.key');
  const backupKeyPath = join(directory, 'secrets', 'backup.key');
  const outputDirectory = join(directory, 'backups');
  const db = new DatabaseSync(databasePath);
  t.after(() => {
    db.close();
    const absolute = resolve(directory);
    assert.equal(dirname(absolute), resolve(tmpdir()));
    assert.ok(basename(absolute).startsWith('sentai-backup-test-'));
    assert.equal(lstatSync(absolute).isSymbolicLink(), false);
    rmSync(absolute, {recursive: true, force: true});
  });
  db.exec(`PRAGMA journal_mode=WAL;
    CREATE TABLE products(id INTEGER PRIMARY KEY,name TEXT NOT NULL);
    CREATE TABLE orders(id TEXT PRIMARY KEY,customer_name TEXT NOT NULL,customer_phone TEXT NOT NULL,
      customer_email TEXT NOT NULL,customer_address TEXT NOT NULL,note TEXT NOT NULL);`);
  db.prepare('INSERT INTO orders VALUES(?,?,?,?,?,?)').run('order-1', ...CUSTOMER);
  if (encrypted) initializeOrderDataProtection(db, {keyPath: orderKeyPath, publicDirectory: join(ROOT, 'public')});
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  db.prepare('INSERT INTO products(name) VALUES(?)').run(WAL_PRODUCT);
  const options = {databasePath, orderKeyPath, backupKeyPath, outputDirectory};
  return {directory, db, ...options, options};
}

test('backup includes committed WAL, authenticates SQLite and restores the matching order key', async t => {
  const f = fixture(t);
  const originalKey = readFileSync(f.orderKeyPath);
  assert.ok(statSync(`${f.databasePath}-wal`).size > 0);
  assert.equal(readFileSync(f.databasePath).includes(Buffer.from(WAL_PRODUCT)), false);
  const result = await createEncryptedBackup(f.options);
  assert.equal(result.verified, true);
  assert.equal(result.includesOrderKey, true);
  const archive = readFileSync(result.path);
  for (const value of [...CUSTOMER, WAL_PRODUCT, 'SQLite format 3']) assert.equal(archive.includes(Buffer.from(value)), false);
  assert.equal(archive.includes(originalKey), false);
  const verified = await verifyEncryptedBackup({...f.options, inputPath: result.path});
  assert.equal(verified.createdAt, result.createdAt);
  const restored = await restoreEncryptedBackup({...f.options, inputPath: result.path, outputDirectory: join(f.directory, 'restored')});
  assert.deepEqual(readFileSync(restored.orderKeyPath), originalKey);
  const recovered = new DatabaseSync(restored.databasePath);
  try {
    assert.equal(recovered.prepare('SELECT name FROM products').get().name, WAL_PRODUCT);
    const protector = initializeOrderDataProtection(recovered, {keyPath: restored.orderKeyPath, publicDirectory: join(ROOT, 'public')});
    const row = recovered.prepare('SELECT * FROM orders').get();
    assert.ok(row.customer_name.startsWith('enc:'));
    assert.deepEqual(Object.values(protector.decryptFields(row.id, row)), CUSTOMER);
  } finally { recovered.close(); }
  assert.equal(existsSync(join(restored.directory, 'public')), false);
  if (process.platform !== 'win32') assert.equal(statSync(result.path).mode & 0o777, 0o600);
});

test('each backup uses fresh encryption and preserves its persistent backup key', async t => {
  const f = fixture(t);
  const first = await createEncryptedBackup(f.options);
  const key = readFileSync(f.backupKeyPath);
  const second = await createEncryptedBackup(f.options);
  assert.equal(key.length, 32);
  assert.deepEqual(readFileSync(f.backupKeyPath), key);
  assert.notEqual(first.path, second.path);
  assert.notDeepEqual(readFileSync(first.path), readFileSync(second.path));
  assert.deepEqual(readdirSync(f.outputDirectory).sort(), [basename(first.path), basename(second.path)].sort());
});

test('tampered archives and the wrong backup key fail before any restore directory is created', async t => {
  const f = fixture(t);
  const result = await createEncryptedBackup(f.options);
  const corrupted = readFileSync(result.path);
  corrupted[corrupted.length - 1] ^= 1;
  const corruptPath = join(f.directory, 'corrupted.sentai-backup');
  writeFileSync(corruptPath, corrupted);
  const outputDirectory = join(f.directory, 'rejected');
  await assert.rejects(restoreEncryptedBackup({...f.options, inputPath: corruptPath, outputDirectory}), /khóa sai|thay đổi/);
  assert.equal(existsSync(outputDirectory), false);
  const wrongKey = join(f.directory, 'wrong.key');
  writeFileSync(wrongKey, randomBytes(32));
  await assert.rejects(restoreEncryptedBackup({...f.options, inputPath: result.path, outputDirectory, backupKeyPath: wrongKey}), /khóa sai|thay đổi/);
  assert.equal(existsSync(outputDirectory), false);
  await assert.rejects(verifyEncryptedBackup({...f.options, inputPath: corruptPath}), /khóa sai|thay đổi/);
});

test('restore never overwrites an existing directory or the live database', async t => {
  const f = fixture(t);
  const result = await createEncryptedBackup(f.options);
  const before = readFileSync(f.databasePath);
  const orderKey = readFileSync(f.orderKeyPath);
  await assert.rejects(restoreEncryptedBackup({...f.options, inputPath: result.path, outputDirectory: f.directory}), /đã tồn tại/);
  assert.deepEqual(readFileSync(f.databasePath), before);
  assert.deepEqual(readFileSync(f.orderKeyPath), orderKey);
  assert.equal(f.db.prepare('SELECT name FROM products').get().name, WAL_PRODUCT);
});

test('an authenticated payload with corrupt SQLite is rejected before creating restore output', async t => {
  const f = fixture(t);
  await createEncryptedBackup(f.options);
  const header = Buffer.from('SENTAI-BACKUP\0\x01', 'binary');
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', readFileSync(f.backupKeyPath), iv, {authTagLength: 16});
  cipher.setAAD(header);
  const content = JSON.stringify({version: 1, createdAt: new Date().toISOString(), database: Buffer.from('Not a valid SQLite database').toString('base64'), orderKey: null});
  const ciphertext = Buffer.concat([cipher.update(content), cipher.final()]);
  const path = join(f.directory, 'invalid-database.sentai-backup');
  writeFileSync(path, Buffer.concat([header, iv, cipher.getAuthTag(), ciphertext]));
  const target = join(f.directory, 'rejected-corrupt-database');
  await assert.rejects(restoreEncryptedBackup({...f.options, inputPath: path, outputDirectory: target}));
  assert.equal(existsSync(target), false);
});

test('legacy databases without an order key are encrypted in the backup and restore explicitly without one', async t => {
  const f = fixture(t, {encrypted: false});
  const result = await createEncryptedBackup(f.options);
  assert.equal(result.includesOrderKey, false);
  const archive = readFileSync(result.path);
  for (const value of CUSTOMER) assert.equal(archive.includes(Buffer.from(value)), false);
  const restored = await restoreEncryptedBackup({...f.options, inputPath: result.path, outputDirectory: join(f.directory, 'legacy')});
  assert.equal(restored.orderKeyPath, null);
  const db = new DatabaseSync(restored.databasePath, {readOnly: true});
  try { assert.deepEqual(PRIVATE_FIELDS.map(field => db.prepare('SELECT * FROM orders').get()[field]), CUSTOMER); }
  finally { db.close(); }
});

test('a protected database cannot be backed up with a missing or incorrect order key', async t => {
  const f = fixture(t);
  unlinkSync(f.orderKeyPath);
  await assert.rejects(createEncryptedBackup(f.options), /Thiếu khóa/);
  assert.equal(existsSync(f.backupKeyPath), false);
  assert.equal(existsSync(f.outputDirectory), false);
  writeFileSync(f.orderKeyPath, randomBytes(32));
  await assert.rejects(createEncryptedBackup(f.options), /Không thể mở dữ liệu/);
  assert.equal(existsSync(f.outputDirectory), false);
});

test('the key sentinel requires its order key even with no orders', async t => {
  const f = fixture(t);
  f.db.exec('DELETE FROM orders');
  unlinkSync(f.orderKeyPath);
  await assert.rejects(createEncryptedBackup(f.options), /Thiếu khóa/);
});

test('public paths and junctions cannot be used for keys, archives or restored data', async t => {
  const f = fixture(t);
  const publicPath = join(ROOT, 'public');
  await assert.rejects(createEncryptedBackup({...f.options, backupKeyPath: join(publicPath, 'rejected-backup.key')}), /ngoài thư mục public/);
  await assert.rejects(createEncryptedBackup({...f.options, orderKeyPath: join(publicPath, 'rejected-order.key')}), /ngoài thư mục public/);
  await assert.rejects(createEncryptedBackup({...f.options, outputDirectory: publicPath}), /ngoài thư mục public/);
  const alias = join(f.directory, 'public-alias');
  symlinkSync(publicPath, alias, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(createEncryptedBackup({...f.options, backupKeyPath: join(alias, 'rejected-backup.key')}), /ngoài thư mục public/);
  const result = await createEncryptedBackup(f.options);
  await assert.rejects(restoreEncryptedBackup({...f.options, inputPath: result.path, outputDirectory: join(alias, 'restore-rejected')}), /ngoài thư mục public/);
  assert.equal(existsSync(join(publicPath, 'rejected-backup.key')), false);
  assert.equal(existsSync(join(publicPath, 'restore-rejected')), false);
});

test('the backup key cannot be stored in its archive directory', async t => {
  const f = fixture(t);
  await assert.rejects(createEncryptedBackup({...f.options, backupKeyPath: join(f.outputDirectory, 'backup.key')}), /lưu riêng/);
  assert.equal(existsSync(f.outputDirectory), false);
});

test('a missing existing backup key is not silently replaced', async t => {
  const f = fixture(t);
  const result = await createEncryptedBackup(f.options);
  unlinkSync(f.backupKeyPath);
  await assert.rejects(createEncryptedBackup(f.options), /thiếu khóa/);
  assert.equal(existsSync(f.backupKeyPath), false);
  assert.deepEqual(readdirSync(f.outputDirectory), [basename(result.path)]);
});

test('CLI verify and extract work without replacing any live database', async t => {
  const f = fixture(t);
  const result = await createEncryptedBackup(f.options);
  const script = join(ROOT, 'scripts', 'restore_backup.mjs');
  const verify = spawnSync(process.execPath, [script, '--input', result.path, '--key', f.backupKeyPath, '--verify'], {encoding: 'utf8', windowsHide: true});
  assert.equal(verify.status, 0, verify.stderr);
  assert.match(verify.stdout, /hợp lệ/);
  const target = join(f.directory, 'cli-restored');
  const restore = spawnSync(process.execPath, [script, '--input', result.path, '--key', f.backupKeyPath, '--output', target], {encoding: 'utf8', windowsHide: true});
  assert.equal(restore.status, 0, restore.stderr);
  assert.ok(existsSync(join(target, 'sentai.sqlite')));
  assert.deepEqual(readFileSync(join(target, 'secrets', 'order-data.key')), readFileSync(f.orderKeyPath));
  const refuse = spawnSync(process.execPath, [script, '--input', result.path, '--key', f.backupKeyPath, '--output', target], {encoding: 'utf8', windowsHide: true});
  assert.equal(refuse.status, 1);
  assert.match(refuse.stderr, /đã tồn tại/);
});
