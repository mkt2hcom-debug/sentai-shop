import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { createApp } from '../server.mjs';
import { ROOT, syncCatalog } from '../lib/database.mjs';

const ADMIN_PASSWORD = 'sentai-media-test-password';
const PHONE = '0326931693';
const localPython = resolve(ROOT,'.venv',process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
const PYTHON = process.env.PYTHON_PATH || (existsSync(localPython) ? localPython : 'python');
let processorReady = false;
try {
  processorReady = JSON.parse(execFileSync(PYTHON,[resolve(ROOT,'scripts/process_media.py'),'--check'],{encoding:'utf8',windowsHide:true,timeout:20000})).ready;
} catch { /* Auth/validation tests still run if optional media dependencies are absent. */ }
const realMedia = {skip:!processorReady,timeout:60000};

async function fixture(t, options = {}) {
  const directory = mkdtempSync(join(tmpdir(),'sentai-media-test-'));
  const dbPath = join(directory,'shop.sqlite');
  const mediaDirectory = join(directory,'private-media');
  const running = [];
  async function launch() {
    const app = createApp({dbPath,mediaDirectory,adminPassword:ADMIN_PASSWORD,shopPhone:PHONE,...options});
    let closed = false;
    await new Promise((accept,reject)=>{app.server.once('error',reject);app.server.listen(0,'127.0.0.1',accept);});
    const base = `http://127.0.0.1:${app.server.address().port}`;
    const api = async (path, {method='GET',body,headers={}}={}) => {
      const response = await fetch(base+path,{method,headers:{...(body === undefined ? {} : {'Content-Type':'application/json'}),...headers},
        ...(body === undefined ? {} : {body:JSON.stringify(body)})});
      return {status:response.status,headers:response.headers,body:await response.json()};
    };
    const close = async()=>{
      if(closed)return;
      closed=true;
      app.server.closeAllConnections();
      await new Promise((accept,reject)=>app.server.close(error=>error ? reject(error) : accept()));
      await app.media.close();
      app.db.close();
    };
    const result={...app,base,api,close,reopen:launch,directory,mediaDirectory};
    running.push(result);
    return result;
  }
  t.after(async()=>{
    for(const app of running)await app.close();
    assert.ok(resolve(directory).startsWith(resolve(tmpdir())+sep));
    assert.ok(directory.includes('sentai-media-test-'));
    rmSync(directory,{recursive:true,force:true});
  });
  return launch();
}

async function login(app,password=ADMIN_PASSWORD) {
  const response=await app.api('/api/admin/login',{method:'POST',body: {username:'admin',password}});
  assert.equal(response.status,200);
  assert.match(response.body.csrf_token,/^[a-f0-9]{64}$/);
  return {Cookie:response.headers.get('set-cookie').split(';')[0],'X-CSRF-Token':response.body.csrf_token};
}

async function upload(app, cookie, bytes, {product='sentai-row-2',kind='image',quality='high',key=randomUUID(),name='product.jpg',mime='image/jpeg'}={}) {
  const response=await fetch(`${app.base}/api/admin/products/${product}/media?kind=${kind}&quality=${quality}`,{
    method:'POST',headers:{'Content-Type':mime,'X-File-Name':encodeURIComponent(name),'X-Upload-Id':key,...cookie},body:bytes
  });
  return {status:response.status,body:await response.json(),key};
}

async function completed(app,cookie,jobId) {
  const deadline=Date.now()+30000;
  while(Date.now()<deadline){
    const response=await app.api('/api/admin/products/sentai-row-2',{headers:cookie});
    assert.equal(response.status,200);
    const job=response.body.jobs.find(job=>job.id===jobId);
    if(job && ['ready','failed'].includes(job.status))return {job,details:response.body};
    await delay(50);
  }
  assert.fail('Media processing did not complete within 30 seconds');
}

function imageFixture(directory) {
  const file=join(directory,'source.jpg');
  execFileSync(PYTHON,['-c',
    "from PIL import Image,ImageDraw;import sys;im=Image.new('RGB',(640,480),'white');ImageDraw.Draw(im).rectangle((80,40,420,330),fill=(180,30,90));im.save(sys.argv[1],quality=96)",file],
  {windowsHide:true,timeout:10000});
  return readFileSync(file);
}

function videoFixture(directory) {
  const file=join(directory,'source.mp4');
  execFileSync(process.env.FFMPEG_PATH || 'ffmpeg',['-hide_banner','-loglevel','error','-y','-f','lavfi','-i','color=c=blue:size=320x180:rate=15',
    '-f','lavfi','-i','sine=frequency=440:sample_rate=44100','-t','1.2','-c:v','libx264','-threads','2','-pix_fmt','yuv420p','-c:a','aac',file],
  {windowsHide:true,timeout:15000});
  return readFileSync(file);
}

test('media upload requires administrator and configured watermark phone', async t=>{
  const app=await fixture(t,{shopPhone:''});
  let response=await upload(app,{},Buffer.from('fake image'));
  assert.equal(response.status,401);
  const cookie=await login(app);
  for (const headers of [{Cookie:cookie.Cookie},{...cookie,'X-CSRF-Token':'0'.repeat(64)}]) {
    response=await upload(app,headers,Buffer.from('fake image'));
    assert.equal(response.status,403);
    assert.equal(response.body.code,'CSRF_INVALID');
  }
  response=await upload(app,cookie,Buffer.from('fake image'));
  assert.equal(response.status,409);
  assert.match(response.body.error,/điện thoại/);
  assert.equal(app.db.prepare('SELECT count(*) n FROM media_jobs').get().n,0);
});

test('real photo upload is watermarked, private-source preserving, idempotent, durable, and removable', realMedia, async t=>{
  let app=await fixture(t);
  let cookie=await login(app);
  const bytes=imageFixture(app.directory);
  const response=await upload(app,cookie,bytes);
  assert.equal(response.status,202);
  const {job,details}=await completed(app,cookie,response.body.job.id);
  assert.equal(job.status,'ready',job.error);
  assert.equal(details.settings.processor_ready,true);
  const media=details.media.find(item=>item.id===job.id);
  assert.equal(media.kind,'image');
  assert.equal(media.watermark,PHONE);
  assert.equal(media.width,640);assert.equal(media.height,480);
  assert.equal(media.original_bytes,bytes.length);
  assert.ok(media.output_bytes>0);
  const source=join(app.mediaDirectory,'originals',`${job.id}.upload`);
  assert.deepEqual(readFileSync(source),bytes,'original bytes are retained privately');
  const output=join(app.mediaDirectory,'processed',job.id,'image.webp');
  const visual=JSON.parse(execFileSync(PYTHON,['-c',
    "from PIL import Image,ImageStat;import json,sys;im=Image.open(sys.argv[1]);crop=im.crop((510,440,610,460)).convert('RGB');print(json.dumps({'mean':sum(ImageStat.Stat(crop).mean)/3,'exif':len(im.getexif()),'format':im.format}))",output],
    {encoding:'utf8',windowsHide:true,timeout:10000}));
  assert.equal(visual.format,'WEBP');assert.equal(visual.exif,0);
  assert.ok(visual.mean<220,'watermark pill is burned over the formerly white image corner');
  const publicDetail=await app.api('/api/products/sentai-row-2');
  assert.equal(publicDetail.body.product.images[0],media.url);
  assert.equal(publicDetail.body.product.media[0].id,job.id);
  const delivered=await fetch(app.base+media.url);
  assert.equal(delivered.status,200);assert.match(delivered.headers.get('content-type'),/image\/webp/);
  assert.deepEqual(Buffer.from(await delivered.arrayBuffer()),readFileSync(output));
  for(const path of [`/media/${job.id}/original.upload`,`/data/media/originals/${job.id}.upload`,`/private-media/originals/${job.id}.upload`]){
    const result=await fetch(app.base+path);assert.equal(result.status,404);await result.arrayBuffer();
  }
  const retry=await upload(app,cookie,bytes,{key:response.key});
  assert.equal(retry.status,202);assert.equal(retry.body.job.id,job.id);
  assert.equal(app.db.prepare('SELECT count(*) n FROM product_media').get().n,1);
  const conflict=await upload(app,cookie,bytes,{key:response.key,product:'sentai-row-3'});
  assert.equal(conflict.status,409);
  syncCatalog(app.db);
  assert.equal((await app.api('/api/products/sentai-row-2')).body.product.media.length,1,'Excel refresh preserves uploads');
  await app.close();app=await app.reopen();cookie=await login(app);
  assert.equal((await app.api('/api/products/sentai-row-2')).body.product.media[0].id,job.id);
  assert.equal((await app.api(`/api/admin/media/${job.id}`,{method:'DELETE',headers:cookie})).status,200);
  assert.equal((await app.api('/api/products/sentai-row-2')).body.product.media.length,0);
  const hidden=await fetch(app.base+media.url);assert.equal(hidden.status,404);await hidden.arrayBuffer();
  assert.deepEqual(readFileSync(source),bytes,'soft removal retains private original');
});

test('real video upload keeps audio, burns watermark, and supports safe byte-range playback', realMedia, async t=>{
  const app=await fixture(t);const cookie=await login(app);
  const response=await upload(app,cookie,videoFixture(app.directory),{kind:'video',name:'clip.mp4',mime:'video/mp4'});
  assert.equal(response.status,202);
  const {job,details}=await completed(app,cookie,response.body.job.id);
  assert.equal(job.status,'ready',job.error);
  const media=details.media.find(item=>item.id===job.id);
  assert.equal(media.width,320);assert.equal(media.height,180);
  assert.ok(Math.abs(media.duration-1.2)<.1);
  const file=join(app.mediaDirectory,'processed',job.id,'video.mp4');
  const probe=JSON.parse(execFileSync(process.env.FFPROBE_PATH || 'ffprobe',['-v','error','-show_streams','-of','json',file],{encoding:'utf8',windowsHide:true,timeout:10000}));
  assert.equal(probe.streams.find(s=>s.codec_type==='video').codec_name,'h264');
  assert.equal(probe.streams.find(s=>s.codec_type==='audio').codec_name,'aac');
  const poster=join(app.mediaDirectory,'processed',job.id,'poster.webp');
  const stamp=JSON.parse(execFileSync(PYTHON,['-c',
    "from PIL import Image;import sys,json;im=Image.open(sys.argv[1]).convert('RGB');print(json.dumps(sum(1 for r,g,b in im.crop((220,152,310,174)).getdata() if min(r,g,b)>150)))",poster],
    {encoding:'utf8',windowsHide:true,timeout:10000}));
  assert.ok(stamp>20,'white phone glyphs are burned into blue video frames');
  const detail=await app.api('/api/products/sentai-row-2');
  assert.equal(detail.body.product.media[0].kind,'video');
  const ranged=await fetch(app.base+media.url,{headers:{Range:'bytes=0-99'}});
  assert.equal(ranged.status,206);assert.equal(ranged.headers.get('content-length'),'100');
  assert.equal(ranged.headers.get('content-range'),`bytes 0-99/${media.output_bytes}`);
  assert.deepEqual(Buffer.from(await ranged.arrayBuffer()),readFileSync(file).subarray(0,100));
  const tail=await fetch(app.base+media.url,{headers:{Range:'bytes=-20'}});
  assert.equal(tail.status,206);assert.deepEqual(Buffer.from(await tail.arrayBuffer()),readFileSync(file).subarray(-20));
  const head=await fetch(app.base+media.url,{method:'HEAD'});
  assert.equal(head.status,200);assert.equal(head.headers.get('content-type'),'video/mp4');assert.equal(head.headers.get('content-length'),String(media.output_bytes));
  assert.equal((await head.arrayBuffer()).byteLength,0);
  for(const range of ['bytes=999999999-','bytes=5-1','bytes=0-2,5-9','bytes=-0']){
    const bad=await fetch(app.base+media.url,{headers:{Range:range}});assert.equal(bad.status,416);await bad.arrayBuffer();
  }
});

test('spoofed image and playlist input fail decoding and never become public media', realMedia, async t=>{
  const app=await fixture(t);const cookie=await login(app);
  for(const input of [
    {kind:'image',name:'fake.jpg',mime:'image/jpeg',data:Buffer.from('<svg onload="alert(1)"></svg>')},
    {kind:'video',name:'fake.mp4',mime:'video/mp4',data:Buffer.from('#EXTM3U\nhttps://example.com/private.ts')}
  ]){
    const response=await upload(app,cookie,input.data,input);assert.equal(response.status,202);
    const {job}=await completed(app,cookie,response.body.job.id);assert.equal(job.status,'failed');assert.ok(job.error);
    assert.equal(app.db.prepare('SELECT count(*) n FROM product_media').get().n,0);
    const hidden=await fetch(`${app.base}/media/${job.id}/${input.kind==='image'?'image.webp':'video.mp4'}`);assert.equal(hidden.status,404);await hidden.arrayBuffer();
    assert.deepEqual(readdirSync(join(app.mediaDirectory,'processed',job.id)),[]);
  }
});

test('initial local administrator setup is single-use, hashed and persists after restart', async t=>{
  let app=await fixture(t,{adminPassword:''});
  assert.deepEqual((await app.api('/api/admin/session')).body,{authenticated:false,enabled:false,setup_allowed:true});
  const blocked=await app.api('/api/admin/setup',{method:'POST',body: {username:'admin',password:ADMIN_PASSWORD},headers:{'X-Forwarded-For':'198.51.100.2'}});
  assert.equal(blocked.status,403);
  assert.equal((await app.api('/api/admin/setup',{method:'POST',body: {username:'admin',password:'short'}})).status,400);
  const result=await app.api('/api/admin/setup',{method:'POST',body: {username:'admin',password:ADMIN_PASSWORD}});
  assert.equal(result.status,201);assert.match(result.headers.get('set-cookie'),/HttpOnly/);
  const row=app.db.prepare('SELECT * FROM admin_credentials WHERE id=1').get();
  assert.match(row.password_hash,/^[a-f0-9]{128}$/);assert.notEqual(row.password_hash,ADMIN_PASSWORD);assert.ok(row.salt.length>=32);
  assert.equal((await app.api('/api/admin/setup',{method:'POST',body: {username:'admin',password:'another-secret-password'}})).status,403);
  await app.close();app=await app.reopen();
  assert.equal((await app.api('/api/admin/session')).body.setup_allowed,false);
  await login(app);
  const publicCatalog=await app.api('/api/catalog');
  assert.equal(JSON.stringify(publicCatalog.body).includes(row.password_hash),false);
  assert.equal((await app.api('/api/admin/login',{method:'POST',body: {username:'admin',password:'incorrect-password'}})).status,401);
});

test('interrupted encode resumes from original and clears only its partial derived output', realMedia, async t=>{
  let app=await fixture(t);const cookie=await login(app);
  const bytes=imageFixture(app.directory);
  const id=randomUUID();
  const original=join(app.mediaDirectory,'originals',`${id}.upload`);writeFileSync(original,bytes);
  const directory=join(app.mediaDirectory,'processed',id);mkdirSync(directory,{recursive:true});
  writeFileSync(join(directory,'image.webp'),'partial encoder output');
  writeFileSync(join(directory,'watermark.png'),'partial watermark');
  app.db.prepare("INSERT INTO media_jobs(id,product_id,upload_key,kind,quality,status,original_name,original_path,original_bytes,watermark) VALUES(?,'sentai-row-2',?,'image','high','processing','interrupted.jpg',?,?,?)")
    .run(id,randomUUID(),`${id}.upload`,bytes.length,PHONE);
  await app.close();app=await app.reopen();const resumedCookie=await login(app);
  const {job}=await completed(app,resumedCookie,id);assert.equal(job.status,'ready',job.error);
  assert.deepEqual(readFileSync(original),bytes);
  assert.ok(readFileSync(join(directory,'image.webp')).length>100);
  assert.equal(existsSync(join(directory,'watermark.png')),false);
});
