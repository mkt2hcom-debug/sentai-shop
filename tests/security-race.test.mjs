import assert from 'node:assert/strict';
import { test } from 'node:test';
import { request as httpRequest } from 'node:http';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { relative, resolve, sep } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createApp } from '../server.mjs';
import { createAdminAuth } from '../lib/admin-auth.mjs';

const PASSWORD = 'security-race-owner-password';
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes,no) => { resolve=yes; reject=no; });
  return {promise,resolve,reject};
}
async function fixture(t, options = {}) {
  const directory = mkdtempSync(resolve(tmpdir(), 'sentai-security-race-'));
  const mediaDirectory = resolve(directory,'media');
  const app = createApp({dbPath:resolve(directory,'shop.sqlite'), mediaDirectory,
    pricesDirectory:resolve(directory,'prices'), adminPassword:PASSWORD, shopPhone:'0326931693', ...options});
  t.after(async () => {
    app.server.closeAllConnections();
    await new Promise(accept => app.server.close(accept));
    await app.prices.close();
    await app.media.close();
    app.db.close();
    const child = relative(resolve(tmpdir()),directory);
    assert.ok(child && child !== '..' && !child.startsWith(`..${sep}`));
    assert.ok(directory.startsWith(resolve(tmpdir(),'sentai-security-race-')));
    rmSync(directory,{recursive:true,force:true});
  });
  await new Promise((accept,reject) => { app.server.once('error',reject); app.server.listen(0,'127.0.0.1',accept); });
  const base = `http://127.0.0.1:${app.server.address().port}`;
  async function api(path,{method='GET',headers={},body}={}) {
    const response = await fetch(base+path,{method,headers:{...(body === undefined ? {} : {'Content-Type':'application/json'}),...headers},
      ...(body === undefined ? {} : {body:JSON.stringify(body)})});
    return {status:response.status,headers:response.headers,body:await response.json()};
  }
  async function login() {
    const response = await api('/api/admin/login',{method:'POST',body:{username:'admin',password:PASSWORD}});
    assert.equal(response.status,200);
    return {Cookie:response.headers.get('set-cookie').split(';')[0],'X-CSRF-Token':response.body.csrf_token};
  }
  return {...app,base,api,login,directory,mediaDirectory};
}
async function slowRequest(t, app, path, {method='PATCH', headers, body}) {
  const bytes = Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body));
  const observed = deferred(), response = deferred();
  const observe = request => {
    if (request.url !== path || request.method !== method) return;
    app.server.off('request',observe);
    observed.resolve();
  };
  app.server.on('request',observe);
  const request = httpRequest(app.base+path,{method,headers:{'Content-Type':'application/json','Content-Length':bytes.length,...headers}}, reply => {
    const chunks=[];
    reply.on('data',chunk=>chunks.push(chunk));
    reply.on('end',()=>{
      try { response.resolve({status:reply.statusCode,body:JSON.parse(Buffer.concat(chunks).toString('utf8'))}); }
      catch(error) { response.reject(error); }
    });
  });
  request.on('error',error=>{observed.reject(error);response.reject(error);});
  // Install a rejection observer even while the response is intentionally held.
  response.promise.catch(()=>{});
  t.after(()=>{app.server.off('request',observe);request.destroy();});
  request.write(bytes.subarray(0,1));
  await observed.promise;
  return {finish() { request.end(bytes.subarray(1)); return response.promise; }};
}

test('logout revokes a PATCH whose body was admitted before logout but completed afterwards', {timeout:10000}, async t => {
  const app = await fixture(t);
  const headers = await app.login();
  const before = app.db.prepare('SELECT price_vnd FROM products WHERE id=?').get('sentai-row-2').price_vnd;
  const pending = await slowRequest(t,app,'/api/admin/products/sentai-row-2',{headers,body:{price_vnd:123456}});
  assert.equal((await app.api('/api/admin/logout',{method:'POST',headers,body:{}})).status,200);
  assert.equal((await pending.finish()).status,401);
  assert.equal(app.db.prepare('SELECT price_vnd FROM products WHERE id=?').get('sentai-row-2').price_vnd,before);
});

test('credential recovery revokes a pending price research mutation without storing the submitted group', {timeout:10000}, async t => {
  const app = await fixture(t,{adminPassword:''});
  const account = createAdminAuth({db:app.db});
  await account.setup({username:'admin',password:PASSWORD});
  const headers = await app.login();
  const pending = await slowRequest(t,app,'/api/admin/prices/groups',{method:'POST',headers,
    body:{name:'Private test group',url:'https://www.facebook.com/groups/securitytestgroup/'}});
  const recovery = account.issueRecovery();
  assert.equal((await app.api('/api/admin/reset',{method:'POST',body:{token:recovery.token,username:'admin',password:'replacement-owner-passphrase'}})).status,200);
  assert.equal((await pending.finish()).status,401);
  assert.equal(app.db.prepare('SELECT count(*) n FROM price_groups').get().n,0);
});

test('a pending mutation cannot extend a session after its idle timeout', {timeout:10000}, async t => {
  let now = Date.now();
  const app = await fixture(t,{now:()=>now});
  const headers = await app.login();
  const before = app.db.prepare('SELECT availability FROM products WHERE id=?').get('sentai-row-2').availability;
  const pending = await slowRequest(t,app,'/api/admin/products/sentai-row-2',{headers,body:{availability:'sold_out'}});
  now += 15*60*1000;
  assert.equal((await pending.finish()).status,401);
  assert.equal(app.db.prepare('SELECT availability FROM products WHERE id=?').get('sentai-row-2').availability,before);
});

test('a revoked upload removes partial originals and is never queued or published', {timeout:20000}, async t => {
  const app = await fixture(t);
  const headers = await app.login();
  const capability = await app.media.details('sentai-row-2');
  if (!capability.settings.image_ready) { t.skip('Optional image processor is unavailable'); return; }
  const uploadId = randomUUID();
  const pending = await slowRequest(t,app,'/api/admin/products/sentai-row-2/media?kind=image',{method:'POST',headers:{...headers,
    'Content-Type':'image/jpeg','X-File-Name':'private-test.jpg','X-Upload-Id':uploadId},body:Buffer.from('partial private image bytes')});
  const temporary = resolve(app.mediaDirectory,'tmp');
  const deadline = Date.now()+5000;
  let partial = false;
  while (Date.now() < deadline) {
    partial = readdirSync(temporary).some(name => existsSync(resolve(temporary,name)) && statSync(resolve(temporary,name)).size > 0);
    if (partial) break;
    await delay(10);
  }
  assert.equal(partial,true,'the upload must have reached temporary storage before revocation');
  assert.equal((await app.api('/api/admin/logout',{method:'POST',headers,body:{}})).status,200);
  assert.equal((await pending.finish()).status,401);
  assert.equal(app.db.prepare('SELECT count(*) n FROM media_jobs WHERE upload_key=?').get(uploadId).n,0);
  assert.equal(app.db.prepare('SELECT count(*) n FROM product_media').get().n,0);
  assert.deepEqual(readdirSync(temporary),[]);
  assert.deepEqual(readdirSync(resolve(app.mediaDirectory,'originals')),[]);
  assert.deepEqual(readdirSync(resolve(app.mediaDirectory,'processed')),[]);
});

for (const operation of ['scan','login','snapshot']) {
  test(`revocation during collector discovery blocks ${operation} before side effects or private response`, {timeout:10000}, async t => {
    const started = deferred(), release = deferred(), calls = [];
    t.after(()=>release.resolve({available:true}));
    const app = await fixture(t,{priceRunner:async args => {
      calls.push(args);
      if (args.includes('--check')) { started.resolve(); return release.promise; }
      return {status:'completed',posts:[]};
    }});
    const headers = await app.login();
    const group = app.prices.addGroup({name:'Secret research group',url:'https://www.facebook.com/groups/racetest/'}).group;
    const keyword = app.prices.addKeyword({keyword:'Blue Ressha'}).keyword;
    const pending = operation === 'scan'
      ? app.api('/api/admin/prices/scans',{method:'POST',headers,body:{group_ids:[group.id],keyword_id:keyword.id,max_posts:1}})
      : operation === 'login' ? app.api('/api/admin/prices/login',{method:'POST',headers,body:{}})
        : app.api('/api/admin/prices',{headers});
    await started.promise;
    assert.equal((await app.api('/api/admin/logout',{method:'POST',headers,body:{}})).status,200);
    release.resolve({available:true});
    const result = await pending;
    assert.equal(result.status,401);
    assert.equal(JSON.stringify(result.body).includes(group.name),false);
    assert.equal(app.db.prepare('SELECT count(*) n FROM price_scans').get().n,0);
    assert.deepEqual(calls,[['--check']]);
    assert.equal(existsSync(resolve(app.directory,'prices/facebook-profile')),false);
  });
}
