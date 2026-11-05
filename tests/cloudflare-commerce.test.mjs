import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { createCipheriv,randomBytes,randomUUID } from 'node:crypto';
import { readFileSync,readdirSync,mkdtempSync,rmSync } from 'node:fs';
import { join,resolve,sep } from 'node:path';
import { tmpdir } from 'node:os';
import { syncCatalog,getProducts as localProducts,getProductFamilies as localFamilies } from '../lib/database.mjs';
import { validateDataProtectionKey } from '../lib/data-protection.mjs';
import { handleCommerce,getProducts,getProductPage,getOrder } from '../cloudflare/commerce.mjs';
import { exportCloudflare } from '../scripts/export_cloudflare.mjs';

const migrations=new URL('../cloudflare/migrations/',import.meta.url);
const schema=readdirSync(migrations).filter(name=>name.endsWith('.sql')).sort().map(name=>readFileSync(new URL(name,migrations),'utf8')).join('\n');
function keyCheck(key) {
  const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,iv,{authTagLength:16});
  cipher.setAAD(Buffer.from(JSON.stringify(['sentai-order-data',1,'$key-check','$key-check'])));
  const ciphertext=Buffer.concat([cipher.update('sentai:order-data:v1','utf8'),cipher.final()]);
  return 'enc:v1:'+Buffer.concat([iv,cipher.getAuthTag(),ciphertext]).toString('base64url');
}
function adapter(sqlite) {
  const d1={beforeBatch:null,queryCount:0,maxParameters:0,
    prepare(sql) {
      const statement={sql,args:[],bind(...args) {
        assert.ok(args.length<=100,'D1 bound-parameter limit');
        d1.maxParameters=Math.max(d1.maxParameters,args.length);
        return {...statement,args};
      },async first(column) {d1.queryCount++;const row=sqlite.prepare(this.sql).get(...this.args);return column?(row?.[column]??null):(row??null);},
      async all() {d1.queryCount++;return {results:sqlite.prepare(this.sql).all(...this.args),success:true};},
      async run() {d1.queryCount++;return {success:true,meta:sqlite.prepare(this.sql).run(...this.args)};}};
      return statement;
    },async batch(statements) {
      if (this.beforeBatch) await this.beforeBatch(statements);
      d1.queryCount++;
      sqlite.exec('BEGIN IMMEDIATE');
      try {
        const result=statements.map(statement=>({success:true,results:sqlite.prepare(statement.sql).all(...statement.args)}));
        sqlite.exec('COMMIT');return result;
      } catch(error) {sqlite.exec('ROLLBACK');throw error;}
    }
  };
  return d1;
}
function fixture(t,{file}={}) {
  const sqlite=new DatabaseSync(file||':memory:');
  sqlite.exec('PRAGMA foreign_keys=ON;'+schema);
  syncCatalog(sqlite);
  const key=randomBytes(32);
  sqlite.prepare('INSERT INTO data_protection_state(id,key_check,scrub_required) VALUES(1,?,0)').run(keyCheck(key));
  const db=adapter(sqlite),env={DB:db,DATA_ENCRYPTION_KEY:key.toString('base64'),SHOP_PHONE:'0326931693'};
  let closed=false;
  const close=()=>{if (!closed) {sqlite.close();closed=true;}};
  t.after(close);
  async function api(path,{method='GET',body}={}) {
    const request=new Request('https://shop.example'+path,{method,...(body===undefined?{}:{headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})});
    const result=await handleCommerce(request,env,new URL(request.url));
    return {status:result.status,body:await result.json()};
  }
  return {sqlite,db,env,key,api,close};
}
function order(overrides={}) {return {customer:{name:'Khách kiểm thử',phone:'0901234567',email:'test@example.com',address:'123 Đường kiểm thử, Thành phố Hồ Chí Minh',note:'Gói cẩn thận'},items:[{product_id:'sentai-row-2',quantity:1}],idempotency_key:randomUUID(),...overrides};}

test('D1 catalogue preserves all local families, physical-item options and media isolation',async t=>{
  const app=fixture(t);
  const expected=localProducts(app.sqlite),actual=await getProducts(app.db);
  assert.deepEqual(actual,expected);
  const catalog=await app.api('/api/catalog');
  assert.equal(catalog.body.products.length,144);assert.equal(catalog.body.families.length,119);
  assert.deepEqual(catalog.body.families,localFamilies(app.sqlite,expected));
  const blue=catalog.body.families.find(item=>item.name==='Blue Ressha');
  assert.equal(blue.variants.length,2);
  const page=await getProductPage(app.db,blue.id,blue.variants[1].id);
  assert.equal(page.product.id,blue.variants[1].id);
  const legacy=await getProductPage(app.db,blue.variants[0].id);
  assert.equal(legacy.product.id,blue.variants[0].id);
  assert.equal(await getProductPage(app.db,blue.id,'sentai-row-2'),null);
  assert.equal(await getProductPage(app.db,'missing'),null);
  const mediaId=randomUUID();
  app.sqlite.prepare(`INSERT INTO product_media(id,product_id,kind,mime_type,filename,poster_filename,width,height,original_name,original_bytes,output_bytes,quality,watermark)
    VALUES(?,?,'image','image/webp','image.webp','poster.webp',100,100,'photo.jpg',100,80,'high','0326931693')`).run(mediaId,blue.variants[1].id);
  const updated=await getProductPage(app.db,blue.id,blue.variants[0].id);
  assert.deepEqual(updated.product.uploaded_images,[]);
  assert.equal(updated.family.variants[1].uploaded_images[0],`/media/${mediaId}/image.webp`);
  app.sqlite.prepare('UPDATE product_media SET visible_after=? WHERE id=?').run(new Date(Date.now()+65000).toISOString(),mediaId);
  const pending=await getProductPage(app.db,blue.id,blue.variants[1].id);
  assert.deepEqual(pending.product.uploaded_images,[]);
});

test('D1 orders preserve encryption format, hidden private response and admin decryption',async t=>{
  const app=fixture(t),body=order();
  const result=await app.api('/api/orders',{method:'POST',body});
  assert.equal(result.status,201);
  const created=result.body.order;
  for (const key of ['customer_name','customer_phone','customer_email','customer_address','note','idempotency_key','request_hash']) assert.equal(key in created,false,key);
  assert.equal(created.items.length,1);
  assert.equal(created.total,app.sqlite.prepare('SELECT price_vnd FROM products WHERE id=?').get('sentai-row-2').price_vnd);
  assert.match(created.order_number,/^ST-\d{8}-[A-F0-9]{8}$/);
  const row=app.sqlite.prepare('SELECT * FROM orders').get();
  assert.match(row.customer_name,/^enc:v1:/);
  assert.equal(JSON.stringify(row).includes(body.customer.name),false);
  // Validate with the EXISTING local implementation, not a duplicate test cipher.
  assert.equal(validateDataProtectionKey(app.sqlite,app.key),true);
  const admin=await app.api('/api/admin/orders');
  assert.equal(admin.body.orders[0].customer_name,body.customer.name);
  assert.equal(admin.body.orders[0].customer_address,body.customer.address);
  assert.equal(admin.body.orders[0].items[0].family_name,created.items[0].family_name);
  const patched=await app.api(`/api/admin/orders/${created.id}`,{method:'PATCH',body:{status:'confirmed'}});
  assert.equal(patched.body.order.status,'confirmed');
  assert.equal(patched.body.order.customer_phone,body.customer.phone);
});

test('D1 identical concurrent requests create exactly one complete order; conflicting replay fails',async t=>{
  const app=fixture(t),body=order();
  const results=await Promise.all([app.api('/api/orders',{method:'POST',body}),app.api('/api/orders',{method:'POST',body})]);
  assert.deepEqual(results.map(result=>result.status).sort(),[200,201]);
  assert.equal(results[0].body.order.id,results[1].body.order.id);
  for (const table of ['orders','order_items','order_item_options']) assert.equal(app.sqlite.prepare(`SELECT count(*) n FROM ${table}`).get().n,1);
  assert.equal(app.sqlite.prepare('SELECT count(*) n FROM cf_integrity_guard').get().n,0);
  const conflict={...body,customer:{...body.customer,note:'Nội dung khác'}};
  await assert.rejects(app.api('/api/orders',{method:'POST',body:conflict}),error=>error.status===409);
});

test('D1 atomic order guard rolls back when price or physical-item condition changes before commit',async t=>{
  for (const mutation of ["UPDATE products SET price_vnd=price_vnd+10000 WHERE id='sentai-row-2'","UPDATE product_units SET condition_note='Có vết xước mới' WHERE product_id='sentai-row-2'"]) {
    const app=fixture(t);
    app.db.beforeBatch=async statements=>{
      if (!statements.some(statement=>statement.sql.includes('INSERT INTO cf_integrity_guard'))) return;
      app.db.beforeBatch=null;app.sqlite.exec(mutation);
    };
    await assert.rejects(app.api('/api/orders',{method:'POST',body:order()}),error=>error.status===409);
    for (const table of ['orders','order_items','order_item_options','cf_integrity_guard']) assert.equal(app.sqlite.prepare(`SELECT count(*) n FROM ${table}`).get().n,0);
  }
});

test('D1 rejects wrong/missing key, tampering and reused ciphertext for another field',async t=>{
  const app=fixture(t);
  const result=await app.api('/api/orders',{method:'POST',body:order()});
  await assert.rejects(getOrder({...app.env,DATA_ENCRYPTION_KEY:randomBytes(32).toString('hex')},result.body.order.id),error=>error.status===503);
  await assert.rejects(getOrder({...app.env,DATA_ENCRYPTION_KEY:undefined},result.body.order.id),error=>error.status===503);
  app.sqlite.exec('UPDATE orders SET customer_phone=customer_name');
  await assert.rejects(app.api('/api/admin/orders'),error=>error.status===503);
});

test('D1 rejects unavailable units/quantities and atomically rolls back duplicate unit-label edits',async t=>{
  const app=fixture(t);
  await assert.rejects(app.api('/api/orders',{method:'POST',body:order({items:[{product_id:'sentai-row-2',quantity:2}]})}),error=>error.status===400);
  app.sqlite.prepare("UPDATE products SET availability='sold_out' WHERE id=?").run('sentai-row-2');
  await assert.rejects(app.api('/api/orders',{method:'POST',body:order()}),error=>error.status===409);
  const blue=(await app.api('/api/catalog')).body.families.find(item=>item.name==='Blue Ressha');
  const [a,b]=blue.variants;
  await assert.rejects(app.api(`/api/admin/products/${b.id}`,{method:'PATCH',body:{unit_label:a.unit_label,price_vnd:123000}}),error=>error.status===409);
  assert.equal(app.sqlite.prepare('SELECT price_vnd FROM products WHERE id=?').get(b.id).price_vnd,b.price_vnd);
  const patched=await app.api(`/api/admin/products/${b.id}`,{method:'PATCH',body:{unit_label:'Chiếc của BST tháng 11',collection_label:'BST 11',condition_note:'Xước nhẹ'}});
  assert.equal(patched.body.product.unit_label,'Chiếc của BST tháng 11');
  assert.equal(patched.body.product.condition,'Xước nhẹ');
  assert.equal(patched.body.product.collection_name,'BST 11');
});

test('D1 maximum forty-item basket uses at most 100 bound parameters per statement',async t=>{
  const app=fixture(t);
  app.sqlite.exec("UPDATE products SET price_vnd=10000,availability='available'");
  const items=app.sqlite.prepare('SELECT id FROM products LIMIT 40').all().map(row=>({product_id:row.id,quantity:1}));
  const result=await app.api('/api/orders',{method:'POST',body:order({items})});
  assert.equal(result.status,201);assert.equal(result.body.order.items.length,40);
  assert.equal(result.body.order.total,400000);
  assert.ok(app.db.maxParameters<=100);
  assert.ok(app.db.queryCount<50);
});

test('Cloudflare snapshot is readonly, preserves encrypted business data and excludes credentials',async t=>{
  const directory=mkdtempSync(join(tmpdir(),'sentai-cloudflare-export-'));
  let app;
  t.after(()=>{app?.close();const absolute=resolve(directory);assert.ok(absolute.startsWith(resolve(tmpdir())+sep));assert.ok(absolute.includes('sentai-cloudflare-export-'));rmSync(absolute,{recursive:true,force:true});});
  const source=join(directory,'source.sqlite'),output=join(directory,'private.sql');app=fixture(t,{file:source});
  const body=order();await app.api('/api/orders',{method:'POST',body});
  app.sqlite.prepare('INSERT INTO admin_credentials(id,password_hash,salt) VALUES(1,?,?)').run('fixture-password-hash','fixture-salt');
  app.sqlite.prepare('INSERT INTO admin_recovery(id,token_hash,expires_at,created_at) VALUES(1,?,?,?)').run('fixture-recovery','2100-01-01','2026-11-01');
  const exported=exportCloudflare({database:source,output}),sql=readFileSync(output,'utf8');
  assert.equal(exported.manifest.tables.products,144);assert.equal(exported.manifest.tables.orders,1);
  for (const forbidden of ['fixture-password-hash','fixture-recovery',body.customer.name,'BEGIN','COMMIT']) assert.equal(sql.includes(forbidden),false,forbidden);
  assert.match(sql,/enc:v1:/);
  const target=new DatabaseSync(':memory:');t.after(()=>target.close());target.exec('PRAGMA foreign_keys=ON;'+schema);target.exec(sql);
  assert.equal(target.prepare('SELECT count(*) n FROM orders').get().n,1);
  assert.equal(target.prepare('SELECT count(*) n FROM admin_credentials').get().n,0);
  assert.equal(validateDataProtectionKey(target,app.key),true);
  assert.equal(app.sqlite.prepare('SELECT password_hash FROM admin_credentials').get().password_hash,'fixture-password-hash');
  assert.throws(()=>exportCloudflare({database:source,output}),/đã tồn tại/);
  assert.throws(()=>exportCloudflare({database:source,output:resolve('public/private.sql')}),/dữ liệu riêng/);
});
