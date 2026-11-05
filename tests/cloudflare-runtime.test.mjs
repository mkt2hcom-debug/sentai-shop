import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createHash, createCipheriv, randomBytes, randomUUID } from 'node:crypto';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { syncCatalog } from '../lib/database.mjs';

// This suite uses the actual workerd + D1 + R2 emulators. Build the Worker first:
// npm run cf:check && node --test tests/cloudflare-runtime.test.mjs
test('Workers runtime serves the shop, protects admin and persists encrypted orders in D1', {timeout:90000}, async t => {
  const dataKey = randomBytes(32), authKey = randomBytes(32).toString('hex');
  const compiled = await build({entryPoints:['cloudflare/worker.mjs'], bundle:true, write:false, format:'esm', platform:'neutral',
    mainFields:['browser','module','main'],conditions:['workerd','worker','browser'],external:['node:*','cloudflare:*'],target:'es2022'});
  const mf = new Miniflare(convertV4MiniflareOptions({
    modules:true, script:compiled.outputFiles[0].text, compatibilityDate:'2026-11-05',
    d1Databases:['DB'], kvNamespaces:['MEDIA_KV'],
    assets:{directory:resolve('public'), binding:'ASSETS', run_worker_first:true, routerConfig:{has_user_worker:true}, assetConfig:{html_handling:'none',not_found_handling:'none'}},
    bindings:{SHOP_PHONE:'0326931693', AUTH_SECRET:authKey, DATA_ENCRYPTION_KEY:dataKey.toString('hex'),
      PUBLIC_ORIGIN:'https://sentai.test', ADMIN_EMAIL:'owner@example.com'},
    outboundService:async () => { throw Error('No external service is needed'); }
  }));
  t.after(() => mf.dispose());
  const db = await mf.getD1Database('DB');
  const sql = new DatabaseSync(':memory:');
  t.after(() => sql.close());
  const schema = readdirSync('cloudflare/migrations').filter(name=>name.endsWith('.sql')).sort().map(name => readFileSync(`cloudflare/migrations/${name}`, 'utf8')).join('\n');
  sql.exec(schema); syncCatalog(sql);
  for (const statement of schema.replace(/--[^\n]*/g, '').split(';').map(s=>s.trim()).filter(Boolean)) await db.prepare(statement).run();
  for (const table of ['products','product_families','product_units','shop_metadata']) {
    const rows = sql.prepare(`SELECT * FROM ${table}`).all();
    for (let offset=0; offset<rows.length; offset+=40) await db.batch(rows.slice(offset, offset+40).map(row => {
      const columns = Object.keys(row);
      return db.prepare(`INSERT INTO ${table}(${columns.map(x=>`"${x}"`).join(',')}) VALUES(${columns.map(()=>'?').join(',')})`).bind(...Object.values(row));
    }));
  }
  const iv=randomBytes(12), cipher=createCipheriv('aes-256-gcm',dataKey,iv);
  cipher.setAAD(Buffer.from(JSON.stringify(['sentai-order-data',1,'$key-check','$key-check'])));
  const ciphertext=Buffer.concat([cipher.update('sentai:order-data:v1'),cipher.final()]);
  await db.prepare('INSERT INTO data_protection_state(id,key_check,scrub_required) VALUES(1,?,0)').bind('enc:v1:'+Buffer.concat([iv,cipher.getAuthTag(),ciphertext]).toString('base64url')).run();
  const req = (path, options={}) => mf.dispatchFetch(`https://sentai.test${path}`,options);
  let response=await req('/api/catalog'); assert.equal(response.status,200,await response.clone().text());
  const catalog=await response.json(); assert.equal(catalog.products.length,144); assert.equal(catalog.families.length,119);
  const blue=catalog.families.find(p=>p.name==='Blue Ressha'); assert.equal(blue.variants.length,2);
  response=await req(`/api/products/${blue.id}?variant=sentai-row-85`); assert.equal((await response.json()).product.id,'sentai-row-85');
  response=await req(`/products/${blue.id}?variant=sentai-row-85`); assert.equal(response.status,200); assert.match(await response.text(),/product\.js/);
  response=await req('/'); assert.equal(response.status,200); assert.ok(response.headers.get('content-security-policy'));
  for (const path of ['/api/admin/orders','/api/admin/products','/api/admin/analytics','/api/admin/prices']) assert.equal((await req(path)).status,401);
  for (const path of ['/.env','/data/sentai.sqlite','/cloudflare/auth.mjs','/database/catalog.sql']) assert.equal((await req(path)).status,404);
  const grant=randomBytes(32).toString('base64url');
  await db.prepare('INSERT INTO cf_admin_grants(token_hash,expires_at) VALUES(?,?)').bind(createHash('sha256').update(grant).digest('hex'),Date.now()+120000).run();
  response=await req('/api/admin/access',{method:'POST',headers:{'content-type':'application/json',origin:'https://sentai.test'},body:JSON.stringify({token:grant})});
  assert.equal(response.status,200,await response.clone().text());
  const cookie=response.headers.get('set-cookie').match(/sentai_session=[^;]+/)[0];
  const headers={cookie,'content-type':'application/json',origin:'https://sentai.test'};
  response=await req('/api/admin/session',{headers}); assert.equal(response.status,200);
  const session=await response.json(); assert.equal(session.authenticated,true); assert.match(session.csrf_token,/^[a-f0-9]{64}$/);
  response=await req('/api/admin/products/sentai-row-2',{method:'PATCH',headers,body:JSON.stringify({price_vnd:350000})}); assert.equal(response.status,403);
  headers['x-csrf-token']=session.csrf_token;
  response=await req('/api/admin/products/sentai-row-2',{method:'PATCH',headers,body:JSON.stringify({price_vnd:350000})}); assert.equal(response.status,200);
  const order={customer:{name:'Khách kiểm thử',phone:'0901234567',email:'',address:'123 địa chỉ kiểm thử',note:''},items:[{product_id:'sentai-row-2',quantity:1}],idempotency_key:randomUUID()};
  response=await req('/api/orders',{method:'POST',headers:{'content-type':'application/json',origin:'https://sentai.test'},body:JSON.stringify(order)});
  const placed=await response.json(); assert.equal(response.status,201,JSON.stringify(placed)); assert.equal(placed.order.total,350000); assert.equal(placed.order.customer_phone,undefined);
  assert.match((await db.prepare('SELECT customer_phone FROM orders WHERE id=?').bind(placed.order.id).first()).customer_phone,/^enc:v1:/);
  response=await req('/api/admin/orders',{headers}); assert.equal(response.status,200); assert.equal((await response.json()).orders[0].customer_phone,'0901234567');
  response=await req('/api/admin/analytics',{headers}); assert.equal(response.status,200);
  response=await req('/api/admin/prices',{headers}); assert.equal(response.status,200);
  response=await req('/api/admin/products/sentai-row-2',{headers}); assert.equal(response.status,200); assert.equal((await response.json()).settings.prepared_upload_ready,true);
  response=await req('/api/admin/logout',{method:'POST',headers,body:'{}'}); assert.equal(response.status,200);
  assert.equal((await req('/api/admin/orders',{headers})).status,401);
  assert.equal((await db.prepare('SELECT count(*) n FROM cf_integrity_guard').first()).n,0);
});
