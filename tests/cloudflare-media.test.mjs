import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync,readdirSync,existsSync } from 'node:fs';
import { mkdtemp,readFile,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join,resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { Miniflare,convertV4MiniflareOptions } from 'miniflare';
import { handleMedia,validateManifest,parseMediaRange,MEDIA_PART_BYTES,MEDIA_STORAGE_BYTES,cleanupMedia,mediaQuota } from '../cloudflare/media.mjs';
import { verifyBundle } from '../scripts/publish_cloudflare_media.mjs';
import { getMedia } from '../cloudflare/commerce.mjs';

const digest=data=>createHash('sha256').update(data).digest('hex'),id='sentai-row-84',phone='0326931693';
const image=Buffer.concat([Buffer.from('RIFF'),Buffer.from([24,0,0,0]),Buffer.from('WEBPVP8 '),Buffer.alloc(16)]);
const migrations=readdirSync(new URL('../cloudflare/migrations/',import.meta.url)).filter(name=>name.endsWith('.sql')).sort()
  .map(name=>readFileSync(new URL(`../cloudflare/migrations/${name}`,import.meta.url),'utf8'));
function manifest(product=id){return{version:1,product_id:product,kind:'image',quality:'high',original_name:'real-item.png',original_bytes:500,width:128,height:128,duration:null,watermark:phone,
  files:{main:{name:'image.webp',bytes:image.length,sha256:digest(image),parts:[{bytes:image.length,sha256:digest(image)}]},poster:{name:'poster.webp',bytes:image.length,sha256:digest(image)}}};}
function database(){const sqlite=new DatabaseSync(':memory:');for(const sql of migrations)sqlite.exec(sql);
  sqlite.prepare("INSERT INTO products(id,name,series,source_sheet,source_row,price_vnd) VALUES(?,?,'Toqger','mecha',84,100000)").run(id,'Blue Ressha');
  sqlite.prepare("INSERT INTO product_families(id,name,series,grouping_key) VALUES('blue','Blue Ressha','Toqger','blue')").run();
  sqlite.prepare("INSERT INTO product_units(product_id,family_id,unit_label) VALUES(?,'blue','Món 01')").run(id);
  const statement=(sql,args=[])=>({sql,args,bind(...values){return statement(sql,values);},async first(){return sqlite.prepare(sql).get(...args)||null;},
    async all(){return{results:sqlite.prepare(sql).all(...args)};},async run(){return{meta:{changes:Number(sqlite.prepare(sql).run(...args).changes)}};}});
  const db={prepare:sql=>statement(sql),async batch(statements){sqlite.exec('BEGIN');try{const results=[];for(const s of statements){const result=sqlite.prepare(s.sql);
    results.push(/^\s*(SELECT|WITH)/i.test(s.sql)?{results:result.all(...s.args)}:{meta:{changes:Number(result.run(...s.args).changes)}});}sqlite.exec('COMMIT');return results;}
    catch(error){sqlite.exec('ROLLBACK');throw error;}}};return{db,sqlite};}
function kv(){const objects=new Map();let puts=0,reads=0,deletes=0;return{objects,get puts(){return puts;},get reads(){return reads;},get deletes(){return deletes;},
  async put(key,data){puts++;objects.set(key,Buffer.from(data));},async get(key,options){reads++;const data=objects.get(key);return data?(options?.type==='stream'?new Blob([data]).stream():data.buffer.slice(data.byteOffset,data.byteOffset+data.byteLength)):null;},
  async delete(key){deletes++;objects.delete(key);}};}
function caller(env){return async(path,{method='POST',body={},binary=false}={})=>{const req=new Request(`https://shop.test${path}`,{method,headers:{'Content-Type':binary?'application/octet-stream':'application/json'},
  ...(!['GET','HEAD','DELETE'].includes(method)?{body:binary?body:JSON.stringify(body)}:{})});return handleMedia(req,env,new URL(req.url));};}
function fixture(t,{storage=true}={}){const{db,sqlite}=database();t.after(()=>sqlite.close());const env={DB:db,SHOP_PHONE:phone,...(storage?{MEDIA_KV:kv()}:{})};
  return{env,sqlite,request:caller(env),reveal(uploadId){sqlite.prepare("UPDATE product_media SET visible_after='2000-01-01T00:00:00Z' WHERE id=?").run(uploadId);sqlite.prepare("UPDATE cloud_media_uploads SET visible_after='2000-01-01T00:00:00Z' WHERE id=?").run(uploadId);}};}
async function begin(f,m=manifest()){const response=await f.request(`/api/admin/products/${id}/media/prepared`,{body:m});assert.equal(response.status,201);return(await response.json()).upload.id;}
async function upload(f,uploadId){await f.request(`/api/admin/media/${uploadId}/parts/1?file=main`,{body:image,binary:true});await f.request(`/api/admin/media/${uploadId}/parts/1?file=poster`,{body:image,binary:true});return f.request(`/api/admin/media/${uploadId}/complete`);}

test('KV media remains hidden for65seconds then supports ranges/HEAD and removal deletes files',async t=>{
  const f=fixture(t),uploadId=await begin(f),response=await upload(f,uploadId);assert.equal(response.status,202);const result=await response.json();
  assert.equal(result.media.product_id,id);assert.equal(result.media.watermark,phone);assert.equal((await getMedia(f.env.DB,id)).length,0);
  const pending=await f.request(result.media.url,{method:'GET'});assert.equal(pending.status,503);assert.equal(pending.headers.get('retry-after'),'60');assert.equal(f.env.MEDIA_KV.reads,0);
  f.reveal(uploadId);const details=await(await f.request(`/api/admin/products/${id}`,{method:'GET'})).json();assert.equal(details.media.length,1);assert.equal(details.settings.storage_mode,'kv');
  const req=new Request(`https://shop.test${result.media.url}`,{headers:{Range:'bytes=3-8'}});const served=await handleMedia(req,f.env,new URL(req.url));
  assert.equal(served.status,206);assert.equal(served.headers.get('content-range'),`bytes 3-8/${image.length}`);assert.deepEqual(Buffer.from(await served.arrayBuffer()),image.subarray(3,9));
  const head=await f.request(result.media.url,{method:'HEAD'});assert.equal(head.status,200);assert.equal((await head.arrayBuffer()).byteLength,0);
  await f.request(`/api/admin/media/${uploadId}`,{method:'DELETE'});await assert.rejects(()=>f.request(result.media.url,{method:'GET'}),e=>e.status===404);
  assert.equal(f.env.MEDIA_KV.objects.size,0);assert.ok((await mediaQuota(f.env)).reserved_bytes>0,'deletion propagation still reserves storage');
  f.sqlite.prepare("UPDATE cloud_media_uploads SET release_after='2000-01-01T00:00:00Z' WHERE id=?").run(uploadId);await cleanupMedia(f.env);assert.equal((await mediaQuota(f.env)).reserved_bytes,0);
});
test('manifest pins item, phone, dimensions, names, chunk lengths and200MiB outputcap',()=>{
  assert.equal(validateManifest(manifest(),id,phone).files.main.name,'image.webp');
  for(const change of[m=>m.product_id='sentai-row-85',m=>m.watermark='0999999999',m=>m.files.main.name='../key',m=>m.width=0,
    m=>m.files.main.parts[0].bytes=MEDIA_PART_BYTES+1,m=>m.files.poster.bytes=3*1024*1024,m=>m.original_name='../key',m=>{m.kind='video';m.duration=1;m.files.main.name='video.mp4';m.files.main.bytes=201*1024*1024;}]){
    const value=manifest();change(value);assert.throws(()=>validateManifest(value,id,phone),e=>e.status===400);}
});
test('unconfigured KV and malformed uploads fail without storing files',async t=>{
  const missing=fixture(t,{storage:false}),details=await(await missing.request(`/api/admin/products/${id}`,{method:'GET'})).json();assert.equal(details.settings.prepared_upload_ready,false);await assert.rejects(()=>begin(missing),e=>e.status===503);
  const f=fixture(t),uploadId=await begin(f);await assert.rejects(()=>f.request(`/api/admin/media/${uploadId}/parts/1?file=main`,{body:Buffer.alloc(image.length),binary:true}),e=>e.status===400);
  await assert.rejects(()=>f.request(`/api/admin/media/${uploadId}/parts/1?file=main`,{body:Buffer.alloc(image.length+1),binary:true}),e=>e.status===413);
  await assert.rejects(()=>f.request(`/api/admin/media/${uploadId}/complete`),e=>e.status===409);assert.equal(f.env.MEDIA_KV.puts,0);
});
test('atomic global storage admission does not overbook concurrent uploads',async t=>{
  const f=fixture(t),existing=await begin(f),reserved=image.length*2;
  f.sqlite.prepare('UPDATE cloud_media_uploads SET reserved_bytes=? WHERE id=?').run(MEDIA_STORAGE_BYTES-reserved,existing);
  const attempts=await Promise.allSettled([begin(f),begin(f)]);assert.equal(attempts.filter(r=>r.status==='fulfilled').length,1);assert.equal(attempts.filter(r=>r.status==='rejected'&&r.reason.status===409).length,1);
  assert.equal((await mediaQuota(f.env)).reserved_bytes,MEDIA_STORAGE_BYTES);
});
test('daily operation limit stops puts at800 and does not strand an unstarted write marker',async t=>{
  const f=fixture(t),uploadId=await begin(f);f.sqlite.prepare('INSERT INTO cloud_media_operations(day,count) VALUES(?,799)').run(new Date().toISOString().slice(0,10));
  await f.request(`/api/admin/media/${uploadId}/parts/1?file=main`,{body:image,binary:true});
  await assert.rejects(()=>f.request(`/api/admin/media/${uploadId}/parts/1?file=poster`,{body:image,binary:true}),e=>e.status===429);
  assert.equal(f.env.MEDIA_KV.puts,1);assert.equal((await mediaQuota(f.env)).operations_today,800);
  assert.equal(f.sqlite.prepare('SELECT lease_until FROM cloud_media_objects WHERE upload_id=? AND part_number=0').get(uploadId).lease_until,null);
});
test('late auth expiry rejects bytes before storage',async t=>{
  const f=fixture(t),uploadId=await begin(f);f.env.assertAuthorized=async()=>{const error=new Error('expired');error.status=401;throw error;};
  await assert.rejects(()=>f.request(`/api/admin/media/${uploadId}/parts/1?file=poster`,{body:image,binary:true}),e=>e.status===401);assert.equal(f.env.MEDIA_KV.puts,0);
});
test('cancelled in-flight put cannot be deleted early or release quota and is cleaned once settled',async t=>{
  const f=fixture(t),uploadId=await begin(f);let started,release;const entering=new Promise(resolve=>started=resolve),gate=new Promise(resolve=>release=resolve);const put=f.env.MEDIA_KV.put;
  f.env.MEDIA_KV.put=async(key,body)=>{started();await gate;return put(key,body);};
  const pending=f.request(`/api/admin/media/${uploadId}/parts/1?file=main`,{body:image,binary:true});await entering;
  await f.request(`/api/admin/media/${uploadId}/upload`,{method:'DELETE'});await cleanupMedia(f.env);
  assert.ok((await mediaQuota(f.env)).reserved_bytes>0);assert.equal(f.sqlite.prepare('SELECT state FROM cloud_media_objects WHERE upload_id=? AND part_number=1').get(uploadId).state,'pending');
  release();await assert.rejects(()=>pending,e=>e.status===409);assert.equal(f.env.MEDIA_KV.objects.size,0);
  f.sqlite.prepare("UPDATE cloud_media_uploads SET release_after='2000-01-01T00:00:00Z' WHERE id=?").run(uploadId);await cleanupMedia(f.env);assert.equal((await mediaQuota(f.env)).reserved_bytes,0);
});
test('uncertain writes never expire by time or allow retries to steal markers; reservation remains',async t=>{
  const f=fixture(t),uploadId=await begin(f);f.env.MEDIA_KV.put=async()=>{throw new Error('connection ended before confirmation');};
  await assert.rejects(()=>f.request(`/api/admin/media/${uploadId}/parts/1?file=main`,{body:image,binary:true}),/confirmation/);
  f.sqlite.prepare("UPDATE cloud_media_objects SET lease_until='2000-01-01T00:00:00Z' WHERE upload_id=? AND part_number=1").run(uploadId);
  await assert.rejects(()=>f.request(`/api/admin/media/${uploadId}/parts/1?file=main`,{body:image,binary:true}),e=>e.status===409);
  await f.request(`/api/admin/media/${uploadId}/upload`,{method:'DELETE'});await cleanupMedia(f.env);assert.ok((await mediaQuota(f.env)).reserved_bytes>0);
  assert.equal(f.sqlite.prepare('SELECT state FROM cloud_media_objects WHERE upload_id=? AND part_number=1').get(uploadId).state,'pending');
});
test('failed KV deletes retain quota until every deletion succeeds',async t=>{
  const f=fixture(t),uploadId=await begin(f);await upload(f,uploadId);const remove=f.env.MEDIA_KV.delete;f.env.MEDIA_KV.delete=async()=>{throw new Error('temporary');};
  await f.request(`/api/admin/media/${uploadId}`,{method:'DELETE'});assert.equal(f.env.MEDIA_KV.objects.size,2);assert.ok((await mediaQuota(f.env)).reserved_bytes>0);
  f.env.MEDIA_KV.delete=remove;await cleanupMedia(f.env);assert.equal(f.env.MEDIA_KV.objects.size,0);assert.ok((await mediaQuota(f.env)).reserved_bytes>0);
});
test('missing replicated chunk yields503 and completion retry stays idempotent',async t=>{
  const f=fixture(t),uploadId=await begin(f);await upload(f,uploadId);assert.equal((await f.request(`/api/admin/media/${uploadId}/complete`)).status,200);f.reveal(uploadId);
  const object=f.sqlite.prepare('SELECT object_key FROM cloud_media_objects WHERE upload_id=? AND part_number=1').get(uploadId);f.env.MEDIA_KV.objects.delete(object.object_key);
  const response=await f.request(`/media/${uploadId}/image.webp`,{method:'GET'});assert.equal(response.status,503);assert.equal(response.headers.get('retry-after'),'60');
  assert.equal(f.sqlite.prepare('SELECT count(*) n FROM product_media').get().n,1);
});
test('range parsing rejects multi-range, zero suffix and unsafe offsets',()=>{assert.deepEqual(parseMediaRange('bytes=-4',10),{offset:6,length:4});assert.deepEqual(parseMediaRange('bytes=2-999',10),{offset:2,length:8});
  for(const range of['bytes=0-1,3-4','bytes=-0','bytes=11-','bytes=5-2','bytes=99999999999999999-','bytes=-'])assert.equal(parseMediaRange(range,10),false);});

test('real Miniflare KV/D1 uploads multiple chunks, publishes metadata and streams cross-boundary range',async t=>{
  const mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:'export default {fetch(){return new Response("ok")}}',compatibilityDate:'2026-11-05',kvNamespaces:['MEDIA_KV'],d1Databases:['DB']}));t.after(()=>mf.dispose());
  const db=await mf.getD1Database('DB'),storage=await mf.getKVNamespace('MEDIA_KV');
  for(const schema of migrations)for(const sql of schema.replace(/^\s*--.*$/gm,'').split(';').map(part=>part.trim()).filter(Boolean))await db.prepare(sql).run();
  await db.prepare("INSERT INTO products(id,name,series,source_sheet,source_row,price_vnd) VALUES(?,?,'Toqger','mecha',84,100000)").bind(id,'Blue Ressha').run();
  await db.prepare("INSERT INTO product_families(id,name,series,grouping_key) VALUES('blue','Blue Ressha','Toqger','blue')").run();await db.prepare("INSERT INTO product_units(product_id,family_id,unit_label) VALUES(?,'blue','Món 01')").bind(id).run();
  const env={DB:db,MEDIA_KV:storage,SHOP_PHONE:phone},request=caller(env),data=Buffer.alloc(MEDIA_PART_BYTES+123);image.copy(data);data.fill(99,MEDIA_PART_BYTES);
  const m=manifest();m.files.main={name:'image.webp',bytes:data.length,sha256:digest(data),parts:[{bytes:MEDIA_PART_BYTES,sha256:digest(data.subarray(0,MEDIA_PART_BYTES))},{bytes:123,sha256:digest(data.subarray(MEDIA_PART_BYTES))}]};
  const uploadId=await begin({request},m);await request(`/api/admin/media/${uploadId}/parts/1?file=main`,{body:data.subarray(0,MEDIA_PART_BYTES),binary:true});await request(`/api/admin/media/${uploadId}/parts/2?file=main`,{body:data.subarray(MEDIA_PART_BYTES),binary:true});
  await request(`/api/admin/media/${uploadId}/parts/1?file=poster`,{body:image,binary:true});assert.equal((await request(`/api/admin/media/${uploadId}/complete`)).status,202);
  await db.prepare("UPDATE product_media SET visible_after='2000-01-01T00:00:00Z' WHERE id=?").bind(uploadId).run();
  const ranged=new Request(`https://shop.test/media/${uploadId}/image.webp`,{headers:{Range:`bytes=${MEDIA_PART_BYTES-3}-`}}),response=await handleMedia(ranged,env,new URL(ranged.url));
  assert.equal(response.status,206);assert.deepEqual(Buffer.from(await response.arrayBuffer()),data.subarray(MEDIA_PART_BYTES-3));
  const full=await request(`/media/${uploadId}/image.webp`,{method:'GET'});assert.deepEqual(Buffer.from(await full.arrayBuffer()),data);
  await request(`/api/admin/media/${uploadId}`,{method:'DELETE'});assert.equal((await storage.list({prefix:`sentai-media/v1/${uploadId}/`})).keys.length,0);
});
const python=resolve('.venv',process.platform==='win32'?'Scripts/python.exe':'bin/python');
test('local preparer preserves source and produces a validated watermarked bundle',{skip:!existsSync(python)},async t=>{
  const directory=await mkdtemp(join(tmpdir(),'sentai-cf-media-'));t.after(()=>rm(directory,{recursive:true,force:true}));const source=join(directory,'source.png'),output=join(directory,'prepared');
  const generated=spawnSync(python,['-c','from PIL import Image; import sys; Image.new("RGB",(160,160),(40,90,170)).save(sys.argv[1])',source],{encoding:'utf8'});assert.equal(generated.status,0,generated.stderr);
  const original=await readFile(source),prepared=spawnSync(python,['scripts/prepare_cloudflare_media.py','--input',source,'--output-dir',output,'--product',id],{encoding:'utf8',timeout:30000});assert.equal(prepared.status,0,prepared.stdout+prepared.stderr);
  const result=await verifyBundle(output);assert.equal(result.manifest.watermark,phone);assert.equal(result.manifest.product_id,id);assert.deepEqual(await readFile(source),original);assert.equal(validateManifest(result.manifest,id,phone).kind,'image');
});
