import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync,readdirSync } from 'node:fs';
import { createCipheriv,createHash,randomBytes,randomUUID } from 'node:crypto';
import { syncCatalog } from '../lib/database.mjs';
import worker from '../cloudflare/worker.mjs';

const migrations=new URL('../cloudflare/migrations/',import.meta.url);
const schema=readdirSync(migrations).filter(name=>name.endsWith('.sql')).sort().map(file=>readFileSync(new URL(file,migrations),'utf8')).join('\n');
function fixture(t) {
  const sqlite=new DatabaseSync(':memory:');sqlite.exec('PRAGMA foreign_keys=ON;'+schema);syncCatalog(sqlite);
  const db={afterRead:null,prepare(sql) {
    const statement={sql,args:[],bind(...args){return {...statement,args};},
      async first(column){const row=sqlite.prepare(sql).get(...this.args)||null;return column&&row?row[column]:row;},
      async all(){const results=sqlite.prepare(sql).all(...this.args);await db.afterRead?.(sql);return {success:true,results};},
      async run(){return {success:true,meta:sqlite.prepare(sql).run(...this.args)};}};return statement;
  },async batch(statements){sqlite.exec('BEGIN IMMEDIATE');try{const results=statements.map(s=>({success:true,results:sqlite.prepare(s.sql).all(...s.args)}));sqlite.exec('COMMIT');return results;}catch(error){sqlite.exec('ROLLBACK');throw error;}}};
  const key=randomBytes(32),iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,iv);
  cipher.setAAD(Buffer.from(JSON.stringify(['sentai-order-data',1,'$key-check','$key-check'])));
  const ciphertext=Buffer.concat([cipher.update('sentai:order-data:v1'),cipher.final()]);
  sqlite.prepare('INSERT INTO data_protection_state(id,key_check) VALUES(1,?)').run('enc:v1:'+Buffer.concat([iv,cipher.getAuthTag(),ciphertext]).toString('base64url'));
  const env={DB:db,AUTH_SECRET:randomBytes(32).toString('hex'),DATA_ENCRYPTION_KEY:key.toString('base64'),
    PUBLIC_ORIGIN:'https://shop.example',ADMIN_EMAIL:'owner@example.com',SHOP_PHONE:'0326931693',
    ASSETS:{async fetch(request){const path=new URL(request.url).pathname;return new Response(['index','admin','product','admin-media','admin-prices','admin-analytics'].some(name=>path===`/${name}.html`)?'<html>fixture</html>':'Missing',{status:path.endsWith('.html')?200:404,headers:{'Content-Type':'text/html'}});}}};
  const token=randomBytes(32).toString('base64url'),now=Date.now();
  sqlite.prepare('INSERT INTO cf_admin_sessions(token_hash,csrf_token,created_at,last_seen_at,expires_at) VALUES(?,?,?,?,?)')
    .run(createHash('sha256').update(token).digest('hex'),randomBytes(32).toString('hex'),now,now,now+8*3600000);
  const pending=[];
  async function api(path,{method='GET',body,headers={},authenticated=false}={}) {
    const request=new Request('https://shop.example'+path,{method,headers:{Origin:'https://shop.example',...(authenticated?{cookie:`sentai_session=${token}`} : {}),...(body===undefined?{}:{'Content-Type':'application/json'}),...headers},...(body===undefined?{}:{body:JSON.stringify(body)})});
    const response=await worker.fetch(request,env,{waitUntil:promise=>pending.push(promise)});
    const text=await response.text();
    await Promise.all(pending.splice(0));
    return {status:response.status,headers:response.headers,body:response.headers.get('content-type')?.includes('application/json')?JSON.parse(text):text};
  }
  t.after(async()=>{await Promise.all(pending);sqlite.close();});
  return {db,sqlite,env,token,api};
}

test('Worker serves public catalogue/deep links and security headers; private API stays closed',async t=>{
  const app=fixture(t),catalog=await app.api('/api/catalog');
  assert.equal(catalog.status,200);assert.equal(catalog.body.products.length,144);
  assert.equal(catalog.headers.get('x-content-type-options'),'nosniff');
  assert.equal(catalog.headers.get('cache-control'),'no-store');
  assert.match(catalog.headers.get('content-security-policy'),/script-src 'self'/);
  const blue=catalog.body.families.find(item=>item.name==='Blue Ressha');
  assert.equal((await app.api(blue.url)).status,200);
  assert.equal((await app.api(blue.url+'?variant=missing')).status,404);
  assert.equal((await app.api('/api/admin/orders')).status,401);
  assert.equal((await app.api('/api/admin/products/sentai-row-2/media',{method:'POST',body:{}})).status,401);
  assert.equal((await app.api('/data/sentai.sqlite')).status,404);
  assert.equal((await app.api('/api/admin/session')).body.authenticated,false);
  assert.equal((await app.api('/api/catalog',{method:'POST',body:{},headers:{Origin:'https://foreign.example'}})).status,403);
  assert.equal((await app.api('/api/catalog',{method:'PUT',body:{}})).status,405);
});

test('Worker accepts persistent hashed session cookie, enforces CSRF and revokes logout token',async t=>{
  const app=fixture(t);
  const session=await app.api('/api/admin/session',{authenticated:true});
  assert.equal(session.body.authenticated,true);assert.match(session.body.csrf_token,/^[a-f0-9]{64}$/);
  assert.equal((await app.api('/api/admin/products',{authenticated:true})).status,200);
  const path='/api/admin/products/sentai-row-2';
  const denied=await app.api(path,{method:'PATCH',body:{price_vnd:234000},authenticated:true});
  assert.equal(denied.status,403);
  const updated=await app.api(path,{method:'PATCH',body:{price_vnd:234000},authenticated:true,headers:{'x-csrf-token':session.body.csrf_token}});
  assert.equal(updated.status,200);assert.equal(updated.body.product.price_vnd,234000);
  assert.equal((await app.api('/api/admin/orders',{headers:{Cookie:`sentai_session=${randomBytes(32).toString('base64url')}`}})).status,401);
  assert.equal((await app.api('/api/admin/logout',{method:'POST',authenticated:true,headers:{'x-csrf-token':session.body.csrf_token}})).status,200);
  assert.equal((await app.api('/api/admin/orders',{authenticated:true})).status,401);
  assert.equal((await app.api('/api/admin/session',{authenticated:true})).body.authenticated,false);
});

test('Worker does not return admin order data if token is revoked during an awaited read',async t=>{
  const app=fixture(t);
  app.db.afterRead=async sql=>{
    if (!sql.startsWith('SELECT * FROM orders')) return;
    app.db.afterRead=null;
    app.sqlite.prepare('DELETE FROM cf_admin_sessions WHERE token_hash=?').run(createHash('sha256').update(app.token).digest('hex'));
  };
  const response=await app.api('/api/admin/orders',{authenticated:true});
  assert.equal(response.status,401);
  assert.equal('orders' in response.body,false);
});

test('Worker consumes local recovery grant once and rotates existing sessions',async t=>{
  const app=fixture(t),grant=randomBytes(32).toString('base64url');
  app.sqlite.prepare('INSERT INTO cf_admin_grants(token_hash,expires_at,consumed_at) VALUES(?,?,NULL)')
    .run(createHash('sha256').update(grant).digest('hex'),Date.now()+20*60000);
  const accepted=await app.api('/api/admin/access',{method:'POST',body:{token:grant}});
  assert.equal(accepted.status,200);assert.match(accepted.body.csrf_token,/^[a-f0-9]{64}$/);
  const cookies=accepted.headers.get('set-cookie');
  assert.match(cookies,/HttpOnly/);assert.match(cookies,/Secure/);assert.match(cookies,/SameSite=Strict/);
  const sessionCookie=cookies.match(/sentai_session=([A-Za-z0-9_-]{43})/)[0];
  assert.equal((await app.api('/api/admin/session',{headers:{Cookie:sessionCookie}})).body.authenticated,true);
  assert.equal((await app.api('/api/admin/orders',{authenticated:true})).status,401);
  assert.equal((await app.api('/api/admin/access',{method:'POST',body:{token:grant}})).status,401);
  assert.equal(app.sqlite.prepare('SELECT count(*) n FROM cf_admin_sessions').get().n,1);
  const stored=app.sqlite.prepare('SELECT token_hash FROM cf_admin_sessions').get().token_hash;
  assert.equal(stored,createHash('sha256').update(sessionCookie.slice('sentai_session='.length)).digest('hex'));
});

test('Worker analytics honors DNT, validates events and keeps statistics private',async t=>{
  const app=fixture(t);
  const event={event_id:randomUUID(),visit_id:randomUUID(),page_type:'home',path:'/'};
  assert.equal((await app.api('/api/analytics/view',{method:'POST',body:event,headers:{DNT:'1'}})).body.accepted,false);
  assert.equal(app.sqlite.prepare('SELECT count(*) n FROM analytics_views').get().n,0);
  assert.equal((await app.api('/api/admin/analytics')).status,401);
});
