import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { scryptSync } from 'node:crypto';
import { createAdminAuth, ensureAdminAuthSchema, AdminAuthError } from '../lib/admin-auth.mjs';
import { openDatabase } from '../lib/database.mjs';

const PASSWORD = 'a-private-owner-password';
const NEXT_PASSWORD = 'a-new-private-owner-password';
const LEGACY_PASSWORD = 'old-secret12';
const START = '2026-11-04T10:00:00.000Z';
const SCRYPT_V2 = {N:32768,r:8,p:3,maxmem:64 * 1024 * 1024};
const status = code => error => error instanceof AdminAuthError && error.status === code;
function fixture(t, options = {}) {
  const db = openDatabase(':memory:');
  t.after(() => db.close());
  return {db,auth:createAdminAuth({db,...options})};
}
function setup(auth, username = 'admin') { return auth.setup({username,password:PASSWORD}); }
function legacyCredential(db) {
  const salt = '00112233445566778899aabbccddeeff';
  const passwordHash = scryptSync(LEGACY_PASSWORD,salt,64).toString('hex');
  db.prepare("INSERT INTO admin_credentials(id,username,password_hash,salt,password_version,created_at) VALUES(1,'admin',?,?,1,?)").run(passwordHash,salt,START);
  return db.prepare('SELECT * FROM admin_credentials').get();
}

test('legacy migration preserves shop data, recovery token and credentials until a correct login upgrades the hash', async t => {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec("CREATE TABLE admin_credentials(id INTEGER PRIMARY KEY,password_hash TEXT NOT NULL,salt TEXT NOT NULL,created_at TEXT NOT NULL); CREATE TABLE shop_data(id INTEGER PRIMARY KEY,payload TEXT NOT NULL); INSERT INTO shop_data VALUES(1,'keep products, orders and media');");
  const salt = '00112233445566778899aabbccddeeff';
  const storedHash = scryptSync(LEGACY_PASSWORD,salt,64).toString('hex');
  db.prepare('INSERT INTO admin_credentials VALUES(1,?,?,?)').run(storedHash,salt,START);
  ensureAdminAuthSchema(db);
  db.prepare('INSERT INTO admin_recovery VALUES(1,?,?,?)').run('a'.repeat(64),'2026-11-04T10:20:00.000Z',START);
  const recovery = db.prepare('SELECT * FROM admin_recovery').get();
  ensureAdminAuthSchema(db);
  const row = db.prepare('SELECT * FROM admin_credentials').get();
  assert.equal(row.username,'admin');
  assert.equal(row.password_version,1);
  assert.equal(row.password_hash,storedHash);
  assert.equal(row.salt,salt);
  assert.equal(row.created_at,START);
  const auth = createAdminAuth({db});
  const before = auth.identity();
  assert.equal(auth.enabled(),true);
  assert.equal(await auth.verifyLogin({password:LEGACY_PASSWORD}),false);
  assert.equal(await auth.verifyLogin({username:'other',password:LEGACY_PASSWORD}),false);
  assert.equal(await auth.verifyLogin({username:'admin',password:'wrong'}),false);
  assert.deepEqual(db.prepare('SELECT * FROM admin_credentials').get(),row);
  assert.equal(await auth.verifyLogin({username:' ADMIN ',password:LEGACY_PASSWORD}),true,'existing 12-character passwords remain valid');
  const upgraded = db.prepare('SELECT * FROM admin_credentials').get();
  assert.equal(upgraded.password_version,2);
  assert.notEqual(upgraded.salt,salt);
  assert.equal(upgraded.password_hash,scryptSync(LEGACY_PASSWORD,upgraded.salt,64,SCRYPT_V2).toString('hex'));
  assert.equal(upgraded.created_at,START);
  assert.notEqual(auth.identity(),before,'upgrades revoke sessions bound to the old credential');
  assert.equal(await auth.verifyLogin({username:'admin',password:LEGACY_PASSWORD}),true);
  assert.deepEqual(db.prepare('SELECT * FROM admin_credentials').get(),upgraded,'current hashes are not changed on every login');
  assert.equal(db.prepare('SELECT payload FROM shop_data').get().payload,'keep products, orders and media');
  assert.deepEqual(db.prepare('SELECT * FROM admin_recovery').get(),recovery);
});

test('setup validates account and password, stores recommended scrypt parameters and refuses a second owner', async t => {
  const {db,auth} = fixture(t);
  assert.equal(auth.enabled(),false);
  assert.equal(auth.identity(),null);
  assert.equal(await auth.verifyLogin({username:'admin',password:PASSWORD}),false);
  for (const username of ['', 'ab','1admin','áccount','admin space','a'.repeat(41),null,4]) {
    await assert.rejects(() => auth.setup({username,password:PASSWORD}),status(400));
  }
  for (const password of ['', 'short','a'.repeat(14),'a'.repeat(129),'😀'.repeat(8),'passwordpassword','123456789012345',null,123]) {
    await assert.rejects(() => auth.setup({username:'admin',password}),status(400));
  }
  assert.equal(db.prepare('SELECT count(*) n FROM admin_credentials').get().n,0);
  assert.deepEqual(await auth.setup({username:' Owner.Shop-1 ',password:PASSWORD}),{username:'owner.shop-1'});
  const row = db.prepare('SELECT * FROM admin_credentials').get();
  assert.equal(row.username,'owner.shop-1');
  assert.equal(row.password_version,2);
  assert.match(row.password_hash,/^[a-f0-9]{128}$/);
  assert.match(row.salt,/^[a-f0-9]{32}$/);
  assert.equal(row.password_hash,scryptSync(PASSWORD,row.salt,64,SCRYPT_V2).toString('hex'));
  assert.notEqual(row.password_hash,scryptSync(PASSWORD,row.salt,64).toString('hex'));
  assert.equal(JSON.stringify(row).includes(PASSWORD),false);
  assert.equal(await auth.verifyLogin({username:'OWNER.SHOP-1',password:PASSWORD}),true);
  for (const body of [{password:PASSWORD},{username:'different',password:PASSWORD},{username:'owner.shop-1',password:'wrong'},null,[],{}]) {
    assert.equal(await auth.verifyLogin(body),false);
  }
  await assert.rejects(() => setup(auth,'other'),status(403));
  assert.match(auth.identity(),/^[a-f0-9]{64}$/);
});

test('new passwords allow Unicode and spaces without composition requirements', async t => {
  const {auth} = fixture(t);
  const password = 'một buổi chiều xanh';
  await auth.setup({username:'admin',password});
  assert.equal(await auth.verifyLogin({username:'admin',password}),true);
  assert.equal(await auth.verifyLogin({username:'admin',password:password.toUpperCase()}),false);
});

test('recovery token is hashed, one-use and leaves the old account active until successful reset', async t => {
  const {db,auth} = fixture(t);
  await setup(auth);
  const before = auth.identity();
  const first = auth.issueRecovery({now:START});
  assert.match(first.token,/^[A-Za-z0-9_-]{43}$/);
  assert.equal(first.expires_at,'2026-11-04T10:20:00.000Z');
  assert.equal(auth.identity(),before);
  assert.equal(await auth.verifyLogin({username:'admin',password:PASSWORD}),true);
  const recovery = db.prepare('SELECT * FROM admin_recovery').get();
  assert.match(recovery.token_hash,/^[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(recovery).includes(first.token),false);
  assert.deepEqual(await auth.reset({token:first.token,username:' New.Owner ',password:NEXT_PASSWORD},{now:'2026-11-04T10:19:59.999Z'}),{username:'new.owner'});
  assert.notEqual(auth.identity(),before,'existing sessions can detect a changed credential identity');
  assert.equal(await auth.verifyLogin({username:'admin',password:PASSWORD}),false);
  assert.equal(await auth.verifyLogin({username:'new.owner',password:NEXT_PASSWORD}),true);
  assert.equal(db.prepare('SELECT count(*) n FROM admin_recovery').get().n,0);
  await assert.rejects(() => auth.reset({token:first.token,username:'admin',password:PASSWORD},{now:'2026-11-04T10:19:59.999Z'}),status(401));
  assert.equal(createAdminAuth({db}).identity(),auth.identity());
});

test('rotated, invalid and expired recovery links never change credentials or consume a valid token', async t => {
  const {db,auth} = fixture(t);
  await setup(auth);
  const identity = auth.identity();
  const first = auth.issueRecovery({now:START});
  const second = auth.issueRecovery({now:'2026-11-04T10:01:00.000Z'});
  assert.notEqual(first.token,second.token);
  const tokenRow = db.prepare('SELECT * FROM admin_recovery').get();
  const body = token => ({token,username:'recovered',password:NEXT_PASSWORD});
  for (const token of [first.token,'bad','a'.repeat(43),null]) {
    await assert.rejects(() => auth.reset(body(token),{now:'2026-11-04T10:02:00.000Z'}),status(401));
  }
  await assert.rejects(() => auth.reset({...body(second.token),password:'short'},{now:'2026-11-04T10:02:00.000Z'}),status(400));
  await assert.rejects(() => auth.reset(body(second.token),{now:second.expires_at}),status(410));
  assert.equal(auth.identity(),identity);
  assert.deepEqual(db.prepare('SELECT * FROM admin_recovery').get(),tokenRow);
  assert.equal(await auth.verifyLogin({username:'admin',password:PASSWORD}),true);
  assert.equal(db.prepare('SELECT count(*) n FROM admin_recovery').get().n,1);
  const third = auth.issueRecovery({now:'2026-11-04T10:30:00.000Z'});
  assert.deepEqual(await auth.reset(body(third.token),{now:'2026-11-04T10:31:00.000Z'}),{username:'recovered'});
});

test('a failed credential update rolls back the reset transaction and preserves its recovery link', async t => {
  const {db,auth} = fixture(t);
  await setup(auth);
  const identity = auth.identity();
  const link = auth.issueRecovery({now:START});
  db.exec("CREATE TRIGGER refuse_reset BEFORE UPDATE ON admin_credentials BEGIN SELECT RAISE(ABORT,'test write failure'); END;");
  const body = {token:link.token,username:'newowner',password:NEXT_PASSWORD};
  await assert.rejects(() => auth.reset(body,{now:START}),/test write failure/);
  assert.equal(auth.identity(),identity);
  assert.equal(db.prepare('SELECT count(*) n FROM admin_recovery').get().n,1);
  db.exec('DROP TRIGGER refuse_reset');
  assert.deepEqual(await auth.reset(body,{now:START}),{username:'newowner'});
  assert.equal(db.prepare('SELECT count(*) n FROM admin_recovery').get().n,0);
});

test('environment credentials retain priority and block SQL recovery until override removal', async t => {
  const {db,auth} = fixture(t);
  assert.throws(() => auth.issueRecovery(),status(409));
  await setup(auth);
  const before = db.prepare('SELECT * FROM admin_credentials').get();
  const existing = auth.issueRecovery({now:START});
  const environment = createAdminAuth({db,password:NEXT_PASSWORD,username:' Environment.Admin '});
  assert.equal(environment.enabled(),true);
  assert.equal(await environment.verifyLogin({username:'environment.admin',password:NEXT_PASSWORD}),true);
  assert.equal(await environment.verifyLogin({username:'admin',password:PASSWORD}),false);
  assert.notEqual(environment.identity(),auth.identity());
  assert.equal(createAdminAuth({db,password:NEXT_PASSWORD,username:'environment.admin'}).identity(),environment.identity());
  assert.throws(() => environment.issueRecovery(),status(409));
  await assert.rejects(() => environment.reset({token:existing.token,username:'newowner',password:NEXT_PASSWORD}),status(409));
  await assert.rejects(() => setup(environment),status(403));
  assert.deepEqual(db.prepare('SELECT * FROM admin_credentials').get(),before);
  assert.equal(db.prepare('SELECT count(*) n FROM admin_recovery').get().n,1);
  assert.equal(await createAdminAuth({db,password:'short'}).verifyLogin({username:'admin',password:PASSWORD}),true);
  assert.equal(await createAdminAuth({db,password:LEGACY_PASSWORD}).verifyLogin({username:'admin',password:LEGACY_PASSWORD}),true);
  assert.throws(() => createAdminAuth({db,password:PASSWORD,username:'not valid'}),status(503));
});

test('concurrent setup hashes outside SQL transactions and creates only one owner', async t => {
  const {db,auth} = fixture(t);
  const first = setup(auth,'first');
  db.exec('BEGIN IMMEDIATE');
  db.exec('ROLLBACK');
  const second = setup(auth,'second');
  const results = await Promise.allSettled([first,second]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length,1);
  assert.equal(results.filter(result => result.status === 'rejected' && status(403)(result.reason)).length,1);
  assert.equal(db.prepare('SELECT count(*) n FROM admin_credentials').get().n,1);
});

test('a credential changed while login hashes is rejected, including changes to the hash version', async t => {
  const {db,auth} = fixture(t);
  await setup(auth);
  const pending = auth.verifyLogin({username:'admin',password:PASSWORD});
  db.prepare('UPDATE admin_credentials SET username=?').run('renamed');
  assert.equal(await pending,false);
  assert.equal(await auth.verifyLogin({username:'renamed',password:PASSWORD}),true);
  const identity = auth.identity();
  db.exec('UPDATE admin_credentials SET password_version=99');
  assert.notEqual(auth.identity(),identity);
  assert.equal(await auth.verifyLogin({username:'renamed',password:PASSWORD}),false,'unknown hash parameters fail closed');
});

test('legacy upgrade uses compare-and-swap and cannot overwrite a reset during the second hash', async t => {
  const {db} = fixture(t);
  const before = legacyCredential(db);
  let reads = 0;
  let changed = false;
  const observedDb = {
    exec:sql => db.exec(sql),
    prepare(sql) {
      const statement = db.prepare(sql);
      if (sql === 'SELECT * FROM admin_credentials WHERE id=1') {
        return {get() {
          const value = statement.get();
          if (++reads === 2) setImmediate(() => {
            db.prepare('UPDATE admin_credentials SET username=?').run('reset.owner');
            changed = true;
          });
          return value;
        }};
      }
      return statement;
    }
  };
  const auth = createAdminAuth({db:observedDb});
  assert.equal(await auth.verifyLogin({username:'admin',password:LEGACY_PASSWORD}),false);
  assert.equal(changed,true);
  const after = db.prepare('SELECT * FROM admin_credentials').get();
  assert.equal(after.username,'reset.owner');
  assert.equal(after.password_hash,before.password_hash);
  assert.equal(after.salt,before.salt);
  assert.equal(after.password_version,1);
});

test('reset checks token rotation and expiry again after hashing without holding a transaction', async t => {
  const {db,auth} = fixture(t);
  await setup(auth);
  const before = auth.identity();
  const first = auth.issueRecovery();
  const pending = auth.reset({token:first.token,username:'newowner',password:NEXT_PASSWORD});
  db.exec('BEGIN IMMEDIATE');
  db.exec('ROLLBACK');
  const replacement = auth.issueRecovery();
  const replacementRow = db.prepare('SELECT * FROM admin_recovery').get();
  await assert.rejects(pending,status(401));
  assert.equal(auth.identity(),before);
  assert.deepEqual(db.prepare('SELECT * FROM admin_recovery').get(),replacementRow);
  const expiring = auth.reset({token:replacement.token,username:'newowner',password:NEXT_PASSWORD});
  db.prepare('UPDATE admin_recovery SET expires_at=?').run(START);
  await assert.rejects(expiring,status(410));
  assert.equal(auth.identity(),before);
  assert.equal(db.prepare('SELECT count(*) n FROM admin_recovery').get().n,1);
});

test('simultaneous reset requests consume the recovery link only once', async t => {
  const {db,auth} = fixture(t);
  await setup(auth);
  const {token} = auth.issueRecovery({now:START});
  const results = await Promise.allSettled([
    auth.reset({token,username:'first',password:PASSWORD},{now:START}),
    auth.reset({token,username:'second',password:NEXT_PASSWORD},{now:START})
  ]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length,1);
  assert.equal(results.filter(result => result.status === 'rejected' && status(401)(result.reason)).length,1);
  assert.equal(db.prepare('SELECT count(*) n FROM admin_recovery').get().n,0);
  const username = results.find(result => result.status === 'fulfilled').value.username;
  assert.equal(await auth.verifyLogin({username,password:username === 'first' ? PASSWORD : NEXT_PASSWORD}),true);
});

test('reset does not recreate an account removed while its password is hashing', async t => {
  const {db,auth} = fixture(t);
  await setup(auth);
  const {token} = auth.issueRecovery({now:START});
  const pending = auth.reset({token,username:'newowner',password:NEXT_PASSWORD},{now:START});
  db.exec('DELETE FROM admin_credentials');
  await assert.rejects(pending,status(409));
  assert.equal(auth.enabled(),false);
  assert.equal(db.prepare('SELECT count(*) n FROM admin_recovery').get().n,1);
});

test('hash concurrency is bounded and leaves the event loop responsive', async t => {
  const {auth} = fixture(t);
  await setup(auth);
  let timerRan = false;
  let completedHashes = 0;
  const timer = new Promise(resolve => setImmediate(() => { timerRan = true; resolve(); }));
  const pending = Array.from({length:11},() => auth.verifyLogin({username:'admin',password:PASSWORD}).then(value => { completedHashes++; return value; }));
  const settled = Promise.allSettled(pending);
  await timer;
  assert.equal(timerRan,true);
  assert.equal(completedHashes,0,'the event loop runs while password jobs are still processing');
  const results = await settled;
  assert.equal(results.filter(result => result.status === 'fulfilled' && result.value === true).length,10);
  assert.equal(results.filter(result => result.status === 'rejected' && status(503)(result.reason)).length,1);
  assert.equal(await auth.verifyLogin({username:'admin',password:PASSWORD}),true,'hash permits are released after the queue drains');
});
