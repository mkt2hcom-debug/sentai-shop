import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { createApp } from '../server.mjs';
import { openDatabase, syncCatalog, getProduct, getProductFamilies, getProductPage, ensureProductFamilies } from '../lib/database.mjs';

test('model grouping keeps all physical items and distinguishes editions and genuine model numbers',()=>{
  const db=openDatabase(':memory:');
  try {
    syncCatalog(db);
    const families=getProductFamilies(db);
    assert.equal(families.length,119);
    assert.equal(families.reduce((n,f)=>n+f.variants.length,0),144);
    const blue=families.find(f=>f.name==='Blue Ressha');
    assert.deepEqual(blue.variants.map(v=>v.id),['sentai-row-84','sentai-row-85']);
    assert.deepEqual(blue.variants.map(v=>v.unit_label),['Món 01','Món 02']);
    assert.ok(families.find(f=>f.name==='Blue Ressha China').id!==blue.id);
    assert.ok(families.some(f=>f.name==='Gokaiger Pat Striker Machine 02'));
    assert.ok(families.some(f=>f.name==='Red Ressha Chỉ Đầu'));
    assert.equal(families.find(f=>f.name==='DX Gosei Ground').variants.length,3);
    assert.ok(db.prepare('SELECT grouping_key FROM product_families').all().every(f=>!f.grouping_key.includes('\0')));
    const before=db.prepare('SELECT * FROM product_units ORDER BY product_id').all();
    ensureProductFamilies(db);
    assert.deepEqual(db.prepare('SELECT * FROM product_units ORDER BY product_id').all(),before);
  } finally { db.close(); }
});

test('unit page and media remain separate after grouping even when two items share a source photo',()=>{
  const db=openDatabase(':memory:');
  try {
    syncCatalog(db);
    const first=getProduct(db,'sentai-row-84'), second=getProduct(db,'sentai-row-85');
    const add=(productId,kind)=>{
      const id=randomUUID();
      db.prepare(`INSERT INTO product_media(id,product_id,kind,mime_type,filename,poster_filename,width,height,duration,original_name,original_bytes,output_bytes,quality,watermark)
        VALUES(?,?,?,?,?,'poster.webp',320,240,?,?,100,80,'high','0326931693')`)
        .run(id,productId,kind,kind==='video'?'video/mp4':'image/webp',kind==='video'?'video.mp4':'image.webp',kind==='video'?2:null,kind+'.test');
      return id;
    };
    const image1=add(first.id,'image'),video1=add(first.id,'video'),image2=add(second.id,'image');
    const page1=getProductPage(db,first.family_id,first.id),page2=getProductPage(db,first.family_id,second.id);
    assert.deepEqual(new Set(page1.product.media.map(m=>m.id)),new Set([image1,video1]));
    assert.deepEqual(page2.product.media.map(m=>m.id),[image2]);
    assert.equal(page2.product.media.filter(m=>m.kind==='video').length,0);
    assert.ok(page1.product.uploaded_images[0].includes(image1));
    assert.ok(page2.product.uploaded_images[0].includes(image2));
    assert.deepEqual(page1.product.source_images,first.source_images);
    assert.equal(getProductPage(db,second.id).product.id,second.id,'old links still select the same physical item');
    assert.equal(getProductPage(db,first.family_id,'sentai-row-86'),null,'a China item cannot be selected inside the original model');
  } finally { db.close(); }
});

async function fixture(t) {
  const directory=mkdtempSync(join(tmpdir(),'sentai-unit-test-'));
  const app=createApp({dbPath:join(directory,'shop.sqlite'),adminPassword:'temporary-unit-test-password'});
  await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
  const base=`http://127.0.0.1:${app.server.address().port}`;
  let cookie='', csrf='';
  const api=async(path,{method='GET',body}={})=>{
    const res=await fetch(base+path,{method,headers:{Cookie:cookie,...(csrf?{'X-CSRF-Token':csrf}:{}),...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});
    return {status:res.status,body:await res.json(),headers:res.headers};
  };
  const logged=await api('/api/admin/login',{method:'POST',body: {username:'admin',password:'temporary-unit-test-password'}});
  assert.equal(logged.status,200);
  assert.match(logged.body.csrf_token,/^[a-f0-9]{64}$/);
  cookie=logged.headers.get('set-cookie').split(';')[0];
  csrf=logged.body.csrf_token;
  t.after(async()=>{
    app.server.closeAllConnections();await new Promise(resolve=>app.server.close(resolve));
    await app.prices.close();await app.media.close();app.db.close();
    assert.ok(resolve(directory).startsWith(resolve(tmpdir())+sep) && directory.includes('sentai-unit-test-'));
    rmSync(directory,{recursive:true,force:true});
  });
  return {...app,api,base};
}

test('per-item BST, condition and pricing survive import; checkout snapshots exact separate items',async t=>{
  const app=await fixture(t);
  const first='sentai-row-84',second='sentai-row-85';
  const edit=async(id,body)=>app.api(`/api/admin/products/${id}`,{method:'PATCH',body});
  assert.equal((await edit(first,{price_vnd:250000,unit_label:'Món A',collection_label:'BST tháng 11',condition_note:'Trầy nhẹ bên trái'})).status,200);
  assert.equal((await edit(second,{price_vnd:300000,unit_label:'Món B',collection_label:'BST cũ',condition_note:'Đủ phụ kiện, nguyên vẹn'})).status,200);
  assert.equal((await edit(second,{unit_label:'Món A',price_vnd:999999})).status,409);
  assert.equal(getProduct(app.db,second).price_vnd,300000,'invalid label must not partly update price');
  syncCatalog(app.db);
  assert.equal(getProduct(app.db,first).condition,'Trầy nhẹ bên trái');
  assert.equal(getProduct(app.db,first).collection_label,'BST tháng 11');
  assert.equal(getProduct(app.db,first).price_vnd,250000);
  const family=getProduct(app.db,first).family_id;
  const detail=await app.api(`/api/products/${family}?variant=${second}`);
  assert.equal(detail.body.product.id,second);
  assert.deepEqual(new Set(detail.body.family.collections),new Set(['BST tháng 11','BST cũ']));
  assert.equal((await app.api(`/api/products/${family}?variant=sentai-row-86`)).status,404);
  const orderBody={customer:{name:'Khách kiểm thử',phone:'0901234567',address:'123 Đường Kiểm Thử, Việt Nam'},items:[{product_id:first,quantity:1},{product_id:second,quantity:1}],idempotency_key:randomUUID()};
  const created=await app.api('/api/orders',{method:'POST',body:orderBody});
  assert.equal(created.status,201);
  assert.equal(created.body.order.total,550000);
  assert.equal(created.body.order.items.length,2);
  assert.deepEqual(created.body.order.items.map(i=>i.unit_label),['Món A','Món B']);
  assert.deepEqual(created.body.order.items.map(i=>i.condition_note),['Trầy nhẹ bên trái','Đủ phụ kiện, nguyên vẹn']);
  await edit(first,{unit_label:'Món A mới',collection_label:'BST khác',condition_note:'Đã thay mô tả',availability:'sold_out'});
  const orders=(await app.api('/api/admin/orders')).body.orders;
  assert.equal(orders[0].items[0].unit_label,'Món A');
  assert.equal(orders[0].items[0].condition_note,'Trầy nhẹ bên trái');
  assert.equal(getProductPage(app.db,family).product.id,second,'default selection avoids sold item');
  assert.equal((await app.api('/api/orders',{method:'POST',body:{...orderBody,idempotency_key:randomUUID(),items:[{product_id:second,quantity:2}]}})).status,400);
  assert.equal((await app.api('/api/orders',{method:'POST',body:{...orderBody,idempotency_key:randomUUID(),items:[{product_id:family,quantity:1}]}})).status,400);
  await edit(second,{condition_note:null});
  assert.equal(getProduct(app.db,second).condition,getProduct(app.db,second).source_condition);
});
