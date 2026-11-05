import { fail, readJson, json, all, first, run } from './common.mjs';
import { getProduct, getProductPage } from './commerce.mjs';

export const MEDIA_PART_BYTES=5*1024*1024;
export const MEDIA_STORAGE_BYTES=900*1024*1024;
export const MEDIA_OUTPUT_BYTES=200*1024*1024;
const IMAGE_BYTES=25*1024*1024,VIDEO_BYTES=300*1024*1024,POSTER_BYTES=2*1024*1024;
const DAY=86400000,PROPAGATION_MS=65000,OPERATIONS_PER_DAY=800;
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const hash=/^[a-f0-9]{64}$/;
const cleanName=value=>typeof value==='string'&&value.length>0&&value.length<=180&&!/[\\/\x00-\x1f\x7f]/.test(value);
const bytes=(value,max)=>Number.isSafeInteger(value)&&value>0&&value<=max;
const invalid=()=>fail(400,'Bộ file đã xử lý không hợp lệ. Hãy tạo lại bằng công cụ chuẩn bị media trên máy.');
const stamp=()=>new Date().toISOString();
const changes=result=>Number(result.meta?.changes??result.changes??0);
const objectKey=(id,number,sha)=>`sentai-media/v1/${id}/${number}-${sha}`;

export function validateManifest(value,productId,phone) {
  if(!value||value.version!==1||value.product_id!==productId||!/^[\w-]{1,100}$/.test(productId)||
    !['image','video'].includes(value.kind)||!['high','original'].includes(value.quality)||!cleanName(value.original_name)||
    !phone||value.watermark!==phone||!/^\+?\d{9,15}$/.test(phone)||
    !bytes(value.original_bytes,value.kind==='image'?IMAGE_BYTES:VIDEO_BYTES)||
    !Number.isInteger(value.width)||!Number.isInteger(value.height)||Math.min(value.width,value.height)<64||
    value.width*value.height>(value.kind==='image'?80000000:16777216)||
    (value.kind==='video'&&(!Number.isFinite(value.duration)||value.duration<=0||value.duration>601)))invalid();
  const main=value.files?.main,poster=value.files?.poster,filename=value.kind==='image'?'image.webp':'video.mp4';
  if(!main||main.name!==filename||!bytes(main.bytes,value.kind==='image'?IMAGE_BYTES:MEDIA_OUTPUT_BYTES)||
    !hash.test(main.sha256)||!Array.isArray(main.parts)||main.parts.length!==Math.ceil(main.bytes/MEDIA_PART_BYTES)||
    !poster||poster.name!=='poster.webp'||!bytes(poster.bytes,POSTER_BYTES)||!hash.test(poster.sha256))invalid();
  for(let index=0;index<main.parts.length;index++){
    const part=main.parts[index];
    if(!part||part.bytes!==Math.min(MEDIA_PART_BYTES,main.bytes-index*MEDIA_PART_BYTES)||!hash.test(part.sha256))invalid();
  }
  return {version:1,product_id:productId,kind:value.kind,quality:value.quality,original_name:value.original_name,
    original_bytes:value.original_bytes,width:value.width,height:value.height,duration:value.kind==='video'?value.duration:null,watermark:phone,
    files:{main:{name:filename,bytes:main.bytes,sha256:main.sha256,parts:main.parts.map(p=>({bytes:p.bytes,sha256:p.sha256}))},
      poster:{name:'poster.webp',bytes:poster.bytes,sha256:poster.sha256}}};
}
function mediaRecord(row){if(!row)return null;const{active,filename,poster_filename,...record}=row;return{...record,url:`/media/${row.id}/${filename}`,poster_url:`/media/${row.id}/${poster_filename}`};}
async function readyMedia(db,id){return mediaRecord(await first(db,'SELECT * FROM product_media WHERE id=? AND active=1',id));}
function configured(env){if(!env.MEDIA_KV)fail(503,'Chưa kết nối kho ảnh/video miễn phí. Ảnh danh mục vẫn hiển thị bình thường.');}
async function draft(env,id,{allowReady=false}={}){
  const row=await first(env.DB,'SELECT * FROM cloud_media_uploads WHERE id=?',id);
  if(!row||!uuid.test(id))fail(404,'Không tìm thấy lượt tải media.');
  if(row.state!=='uploading'&&!(allowReady&&row.state==='ready'))fail(409,'Lượt tải này đã kết thúc. Hãy tạo lượt mới.');
  if(row.state==='uploading'&&Date.now()-Date.parse(row.created_at)>DAY)fail(410,'Lượt tải đã hết hạn sau 24 giờ. Hãy chọn lại bộ file.');
  return{...row,manifest:validateManifest(JSON.parse(row.manifest),row.product_id,env.SHOP_PHONE||'0326931693')};
}
export async function mediaQuota(env){
  const row=await first(env.DB,'SELECT coalesce(sum(reserved_bytes),0) reserved_bytes FROM cloud_media_uploads');
  const stored=await first(env.DB,"SELECT coalesce(sum(size),0) stored_bytes FROM cloud_media_objects WHERE state='stored'");
  const operations=await first(env.DB,'SELECT count FROM cloud_media_operations WHERE day=?',stamp().slice(0,10));
  return{reserved_bytes:row.reserved_bytes,stored_bytes:stored.stored_bytes,capacity_bytes:MEDIA_STORAGE_BYTES,
    operations_today:operations?.count||0,operations_daily_limit:OPERATIONS_PER_DAY};
}
async function reserveOperations(env,count){
  const result=await run(env.DB,`INSERT INTO cloud_media_operations(day,count) VALUES(?,?)
    ON CONFLICT(day) DO UPDATE SET count=count+excluded.count WHERE count+excluded.count<=?`,stamp().slice(0,10),count,OPERATIONS_PER_DAY);
  if(!changes(result))fail(429,'Đã dùng hết lượt tải/dọn media hôm nay. Thử lại sau 07:00 sáng giờ Việt Nam.');
}
async function boundedBody(request,expected){
  const length=request.headers.get('content-length');if(length!=null&&Number(length)!==expected)fail(400,'Dung lượng phần tải lên không khớp.');
  const reader=request.body?.getReader();if(!reader)fail(400,'Thiếu dữ liệu tập tin.');
  const output=new Uint8Array(expected);let offset=0;
  try{for(;;){const{value,done}=await reader.read();if(done)break;if(offset+value.byteLength>expected){await reader.cancel();fail(413,'Phần tải lên vượt dung lượng cho phép.');}output.set(value,offset);offset+=value.byteLength;}}
  finally{reader.releaseLock();}if(offset!==expected)fail(400,'Phần tải lên chưa đầy đủ.');return output;
}
const sha256=async data=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',data)),byte=>byte.toString(16).padStart(2,'0')).join('');
function checkMagic(data,kind){const ascii=(start,end)=>String.fromCharCode(...data.subarray(start,end));
  if(kind==='image'?!(data.length>=16&&ascii(0,4)==='RIFF'&&ascii(8,12)==='WEBP'):!(data.length>=16&&ascii(4,8)==='ftyp'))fail(415,'Chỉ nhận WebP hoặc MP4 đã được công cụ trên máy xử lý.');}

async function begin(request,env,productId){
  configured(env);if(!await getProduct(env.DB,productId))fail(404,'Không tìm thấy sản phẩm.');
  const manifest=validateManifest(await readJson(request),productId,env.SHOP_PHONE||'0326931693');
  const id=crypto.randomUUID(),reserved=manifest.files.main.bytes+manifest.files.poster.bytes,cutoff=new Date(Date.now()-DAY).toISOString();
  // Conditional admission and the complete object ledger are one transaction.
  // Drafts, inactive files and cleanup pending files all retain their reservation.
  const statements=[env.DB.prepare(`INSERT INTO cloud_media_uploads(id,product_id,manifest,upload_id,state,reserved_bytes)
    SELECT ?,?,?,?,'uploading',? WHERE EXISTS(SELECT 1 FROM products WHERE id=? AND active=1)
    AND (SELECT coalesce(sum(reserved_bytes),0) FROM cloud_media_uploads)+?<=?
    AND (SELECT count(*) FROM product_media WHERE product_id=? AND active=1)
      +(SELECT count(*) FROM cloud_media_uploads WHERE product_id=? AND state='uploading' AND created_at>?)<60
    AND (SELECT count(*) FROM cloud_media_uploads WHERE state='uploading' AND created_at>?)<20`)
    .bind(id,productId,JSON.stringify(manifest),id,reserved,productId,reserved,MEDIA_STORAGE_BYTES,productId,productId,cutoff,cutoff)];
  const objects=[{number:0,...manifest.files.poster},...manifest.files.main.parts.map((part,index)=>({number:index+1,...part}))];
  for(const object of objects)statements.push(env.DB.prepare(`INSERT INTO cloud_media_objects(upload_id,part_number,object_key,size,sha256,state)
    SELECT ?,?,?,?,?,'pending' WHERE EXISTS(SELECT 1 FROM cloud_media_uploads WHERE id=?)`)
    .bind(id,object.number,objectKey(id,object.number,object.sha256),object.bytes,object.sha256,id));
  await env.assertAuthorized?.();const results=await env.DB.batch(statements);
  if(!changes(results[0]))fail(409,'Kho media miễn phí không còn đủ chỗ, hoặc đã đạt giới hạn số file/lượt tải. Gỡ file rồi chờ dọn kho trước khi thử lại.');
  return json({upload:{id,part_bytes:MEDIA_PART_BYTES,parts:manifest.files.main.parts.length},quota:await mediaQuota(env)},201);
}
async function uploadPart(request,env,id,number,url){
  configured(env);const row=await draft(env,id),m=row.manifest,poster=url.searchParams.get('file')==='poster';
  if(!['main','poster'].includes(url.searchParams.get('file'))||!Number.isSafeInteger(number)||number<1||(poster?number!==1:number>m.files.main.parts.length))fail(400,'Phần tải lên không hợp lệ.');
  const expected=poster?m.files.poster:m.files.main.parts[number-1],body=await boundedBody(request,expected.bytes);
  if(await sha256(body)!==expected.sha256)fail(400,'File đã thay đổi hoặc tải lên bị lỗi. Hãy chọn đúng bộ file đã chuẩn bị.');
  if(poster||number===1)checkMagic(body,poster?'image':m.kind);
  await env.assertAuthorized?.();await draft(env,id);
  const object=await first(env.DB,'SELECT * FROM cloud_media_objects WHERE upload_id=? AND part_number=?',id,poster?0:number);
  if(!object||object.state==='deleted')fail(409,'Lượt tải đã bị dọn.');
  if(object.state==='stored')return json({ok:true,part_number:number,repeated:true});
  // Despite its historical column name this is a non-expiring in-flight marker.
  // A Worker can stop before recording whether KV.put settled; time alone never
  // proves it is safe to delete the key or return its reserved capacity.
  const writeToken=crypto.randomUUID();
  const lease=await run(env.DB,`UPDATE cloud_media_objects SET lease_until=? WHERE upload_id=? AND part_number=? AND state='pending'
    AND lease_until IS NULL AND EXISTS(SELECT 1 FROM cloud_media_uploads WHERE id=? AND state='uploading')`,writeToken,id,poster?0:number,id);
  if(!changes(lease))fail(409,'Phần này đang tải hoặc cần kiểm tra lần tải bị ngắt. Dung lượng được giữ lại cho đến khi xác minh xong.');
  try{await reserveOperations(env,1);}catch(error){
    // No KV call was made, so this reservation marker can safely be cleared.
    await run(env.DB,'UPDATE cloud_media_objects SET lease_until=NULL WHERE upload_id=? AND part_number=? AND lease_until=?',id,poster?0:number,writeToken);
    throw error;
  }
  // IDs and content hashes make every key immutable; retries write identical data.
  await env.MEDIA_KV.put(object.object_key,body);
  await env.assertAuthorized?.();
  const saved=await run(env.DB,`UPDATE cloud_media_objects SET state='stored',lease_until=NULL WHERE upload_id=? AND part_number=? AND state='pending'
    AND lease_until=? AND EXISTS(SELECT 1 FROM cloud_media_uploads WHERE id=? AND state='uploading')`,id,poster?0:number,writeToken,id);
  if(!changes(saved)){
    // A cancelled in-flight write is still reserved. Release its lease only after
    // put() settled, so cleanup cannot delete-before-put and leak an orphan.
    await run(env.DB,'UPDATE cloud_media_objects SET lease_until=NULL WHERE upload_id=? AND part_number=? AND lease_until=?',id,poster?0:number,writeToken);
    const current=await first(env.DB,'SELECT state FROM cloud_media_objects WHERE upload_id=? AND part_number=?',id,poster?0:number);
    if(current?.state!=='stored'){await tryCleanup(env);fail(409,'Lượt tải đã bị hủy.');}
  }
  return json({ok:true,part_number:number});
}
async function complete(request,env,id){
  configured(env);await readJson(request);const row=await draft(env,id,{allowReady:true}),m=row.manifest;
  if(row.state==='ready'){const media=await readyMedia(env.DB,id);if(!media)fail(409,'Media đã bị gỡ.');return json({media,job:{id,status:Date.parse(media.visible_after)>Date.now()?'queued':'ready',media_id:id}});}
  const count=await first(env.DB,"SELECT count(*) n FROM cloud_media_objects WHERE upload_id=? AND state='stored'",id);
  if(count.n!==m.files.main.parts.length+1)fail(409,'Chưa tải đủ file và ảnh xem trước.');
  const visibleAfter=new Date(Date.now()+PROPAGATION_MS).toISOString();await env.assertAuthorized?.();
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO product_media(id,product_id,kind,mime_type,filename,poster_filename,width,height,duration,original_name,original_bytes,output_bytes,quality,watermark,visible_after)
      SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM cloud_media_uploads WHERE id=? AND state='uploading')
      AND EXISTS(SELECT 1 FROM products WHERE id=? AND active=1) ON CONFLICT(id) DO NOTHING`).bind(id,row.product_id,m.kind,m.kind==='image'?'image/webp':'video/mp4',
      m.files.main.name,'poster.webp',m.width,m.height,m.duration,m.original_name,m.original_bytes,m.files.main.bytes,m.quality,m.watermark,visibleAfter,id,row.product_id),
    env.DB.prepare("UPDATE cloud_media_uploads SET state='ready',visible_after=? WHERE id=? AND state='uploading' AND EXISTS(SELECT 1 FROM product_media WHERE id=? AND active=1)").bind(visibleAfter,id,id)
  ]);
  const media=await readyMedia(env.DB,id);if(!media)fail(409,'Lượt tải đã bị hủy hoặc sản phẩm đã ngừng hoạt động.');
  return json({media,job:{id,status:'queued',media_id:id},visible_after:visibleAfter},202);
}

// Bounded cleanup runs via hourly cron or an authenticated admin action.
// Reservations survive errors and a final propagation grace after deletion.
export async function cleanupMedia(env,{limit=10}={}){
  if(!env.MEDIA_KV)return{deleted:0,pending:false};
  limit=Math.max(1,Math.min(10,Number(limit)||10));const now=stamp(),cutoff=new Date(Date.now()-DAY).toISOString();
  await run(env.DB,"UPDATE cloud_media_uploads SET state='failed' WHERE state='uploading' AND created_at<?",cutoff);
  const pending=await all(env.DB,`SELECT o.* FROM cloud_media_objects o JOIN cloud_media_uploads u ON u.id=o.upload_id
    WHERE o.state<>'deleted' AND u.state='failed' AND o.lease_until IS NULL ORDER BY u.created_at,o.part_number LIMIT ?`,limit);
  let deleted=0;
  if(pending.length){
    await reserveOperations(env,pending.length);
    const results=await Promise.allSettled(pending.map(object=>env.MEDIA_KV.delete(object.object_key)));
    const done=pending.filter((_,index)=>results[index].status==='fulfilled');deleted=done.length;
    if(done.length)await env.DB.batch(done.map(object=>env.DB.prepare("UPDATE cloud_media_objects SET state='deleted' WHERE upload_id=? AND part_number=?").bind(object.upload_id,object.part_number)));
  }
  await run(env.DB,`UPDATE cloud_media_uploads SET release_after=? WHERE state='failed' AND reserved_bytes>0 AND release_after IS NULL
    AND NOT EXISTS(SELECT 1 FROM cloud_media_objects o WHERE o.upload_id=cloud_media_uploads.id AND o.state<>'deleted')`,new Date(Date.now()+PROPAGATION_MS).toISOString());
  await run(env.DB,`UPDATE cloud_media_uploads SET reserved_bytes=0 WHERE state='failed' AND reserved_bytes>0 AND release_after IS NOT NULL AND release_after<=?
    AND NOT EXISTS(SELECT 1 FROM cloud_media_objects o WHERE o.upload_id=cloud_media_uploads.id AND (o.state<>'deleted' OR o.lease_until IS NOT NULL))`,now);
  const left=await first(env.DB,"SELECT count(*) n FROM cloud_media_uploads WHERE state='failed' AND reserved_bytes>0");
  return{deleted,pending:left.n>0,quota:await mediaQuota(env)};
}
async function tryCleanup(env){try{return await cleanupMedia(env);}catch{return{deleted:0,pending:true};}}

export function parseMediaRange(header,size){
  if(!header)return null;const match=/^bytes=(\d*)-(\d*)$/.exec(header);if(!match||(!match[1]&&!match[2]))return false;
  let start=0,end=size-1;
  if(!match[1]){const suffix=Number(match[2]);if(!Number.isSafeInteger(suffix)||suffix<=0)return false;start=Math.max(0,size-suffix);}
  else{start=Number(match[1]);if(match[2])end=Math.min(Number(match[2]),size-1);}
  if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start<0||start>=size||end<start)return false;
  return{offset:start,length:end-start+1};
}
const unavailable=()=>new Response('Media đang đồng bộ. Vui lòng thử lại.',{status:503,headers:{'Retry-After':'60','Cache-Control':'no-store','Content-Type':'text/plain; charset=utf-8'}});
async function serve(request,env,id,name){
  const record=await first(env.DB,'SELECT m.* FROM product_media m JOIN products p ON p.id=m.product_id WHERE m.id=? AND m.active=1 AND p.active=1',id);
  if(!record||![record.filename,record.poster_filename].includes(name))fail(404,'Không tìm thấy media.');
  if(!env.MEDIA_KV||Date.parse(record.visible_after)>Date.now())return unavailable();
  const objects=await all(env.DB,"SELECT * FROM cloud_media_objects WHERE upload_id=? AND state='stored' ORDER BY part_number",id);
  const poster=name==='poster.webp',parts=objects.filter(o=>poster?o.part_number===0:o.part_number>0),size=parts.reduce((sum,o)=>sum+o.size,0);
  if(!parts.length||(!poster&&(size!==record.output_bytes||parts.some((part,index)=>part.part_number!==index+1))))return unavailable();
  const etag=`"${id}-${poster?'poster':'main'}"`;
  const headers=new Headers({'Content-Type':name==='video.mp4'?'video/mp4':'image/webp','Accept-Ranges':'bytes','Cache-Control':'private, no-store',
    'X-Content-Type-Options':'nosniff','Content-Length':String(size),'ETag':etag,'Content-Disposition':`inline; filename="${name}"`});
  const ifRange=request.headers.get('if-range'),range=parseMediaRange(ifRange&&ifRange!==etag?null:request.headers.get('range'),size);
  if(range===false)return new Response(null,{status:416,headers:{'Content-Range':`bytes */${size}`,'Cache-Control':'no-store'}});
  if(!range&&request.headers.get('if-none-match')===etag)return new Response(null,{status:304,headers});
  if(range){headers.set('Content-Length',String(range.length));headers.set('Content-Range',`bytes ${range.offset}-${range.offset+range.length-1}/${size}`);}
  if(request.method==='HEAD')return new Response(null,{status:range?206:200,headers});
  const start=range?.offset||0,end=range?start+range.length:size;
  const selected=[];let position=0;
  for(const part of parts){const next=position+part.size;if(next>start&&position<end)selected.push({part,from:Math.max(0,start-position),to:Math.min(part.size,end-position)});position=next;}
  // Each get is awaited before the next. The platform counts connections waiting
  // for response headers, not the returned body streams. Open bodies without
  // consuming them to detect missing chunks before sending HTTP status headers.
  const streams=[];
  for(const segment of selected){const stream=await env.MEDIA_KV.get(segment.part.object_key,{type:'stream',cacheTtl:60});
    if(!stream){await Promise.allSettled(streams.map(item=>item.stream.cancel()));return unavailable();}streams.push({...segment,stream});}
  let index=0,reader=null,seen=0,cancelled=false;
  const cancel=async()=>{cancelled=true;const active=reader;reader=null;if(active){await active.cancel().catch(()=>{});active.releaseLock();}
    await Promise.allSettled(streams.slice(index+(active?1:0)).map(item=>item.stream.cancel().catch(()=>{})));};
  const body=new ReadableStream({
    async pull(controller){try{while(index<streams.length&&!cancelled){const item=streams[index];if(!reader){reader=item.stream.getReader();seen=0;}
      const{value,done}=await reader.read();if(done){reader.releaseLock();reader=null;if(seen!==item.part.size)throw new Error('Media part incomplete');index++;continue;}
      const before=seen;seen+=value.byteLength;if(seen>item.part.size)throw new Error('Media part size mismatch');
      const from=Math.max(item.from-before,0),to=Math.min(item.to-before,value.byteLength);if(to>from){controller.enqueue(value.subarray(from,to));return;}}
      if(!cancelled)controller.close();}catch(error){controller.error(error);await cancel();}},cancel});
  return new Response(body,{status:range?206:200,headers});
}

export async function handleMedia(request,env,url){
  const path=url.pathname,publicMatch=path.match(/^\/media\/([a-f0-9-]{36})\/(image\.webp|video\.mp4|poster\.webp)$/);
  if(path.startsWith('/media/')){if(!publicMatch||!uuid.test(publicMatch[1]))fail(404,'Không tìm thấy media.');if(!['GET','HEAD'].includes(request.method))fail(405,'Phương thức không được hỗ trợ.');return serve(request,env,publicMatch[1],publicMatch[2]);}
  if(path==='/api/admin/media/cleanup'&&request.method==='POST'){await readJson(request);return json(await cleanupMedia(env));}
  if(path==='/api/admin/media/quota'&&request.method==='GET')return json(await mediaQuota(env));
  const details=path.match(/^\/api\/admin\/products\/([\w-]+)$/);
  if(details&&request.method==='GET'){
    const product=await getProduct(env.DB,details[1]);if(!product)fail(404,'Không tìm thấy sản phẩm.');const page=await getProductPage(env.DB,product.id);
    const drafts=await all(env.DB,"SELECT id,state,manifest,visible_after,created_at FROM cloud_media_uploads WHERE product_id=? AND state<>'failed' ORDER BY created_at DESC LIMIT 60",product.id);
    const jobs=drafts.map(row=>({id:row.id,original_name:JSON.parse(row.manifest).original_name,status:row.state==='uploading'?'uploading':Date.parse(row.visible_after)>Date.now()?'queued':'ready',created_at:row.created_at}));
    return json({product,family:page.family,media:product.media,jobs,settings:{phone:env.SHOP_PHONE||'0326931693',quality_options:['high','original'],max_image_bytes:IMAGE_BYTES,max_video_bytes:MEDIA_OUTPUT_BYTES,max_duration_seconds:600,
      processor_ready:false,image_ready:false,video_ready:false,prepared_upload_ready:Boolean(env.MEDIA_KV),processing_mode:'local',storage_mode:'kv',quota:await mediaQuota(env),
      processor_message:env.MEDIA_KV?'Nén và đóng số điện thoại trên máy, sau đó chọn bộ file đã xử lý để tải lên.':'Chưa kết nối kho ảnh/video miễn phí. Ảnh danh mục vẫn hiển thị bình thường.'}});
  }
  const init=path.match(/^\/api\/admin\/products\/([\w-]+)\/media\/prepared$/);if(init&&request.method==='POST')return begin(request,env,init[1]);
  const part=path.match(/^\/api\/admin\/media\/([a-f0-9-]{36})\/parts\/(\d+)$/);if(part&&request.method==='POST'&&uuid.test(part[1]))return uploadPart(request,env,part[1],Number(part[2]),url);
  const done=path.match(/^\/api\/admin\/media\/([a-f0-9-]{36})\/complete$/);if(done&&request.method==='POST'&&uuid.test(done[1]))return complete(request,env,done[1]);
  const cancel=path.match(/^\/api\/admin\/media\/([a-f0-9-]{36})\/upload$/);
  if(cancel&&request.method==='DELETE'&&uuid.test(cancel[1])){configured(env);const result=await run(env.DB,"UPDATE cloud_media_uploads SET state='failed' WHERE id=? AND state='uploading'",cancel[1]);if(!changes(result))fail(404,'Không tìm thấy lượt tải đang chờ.');return json({ok:true,cleanup:await tryCleanup(env)});}
  const remove=path.match(/^\/api\/admin\/media\/([a-f0-9-]{36})$/);
  if(remove&&request.method==='DELETE'&&uuid.test(remove[1])){
    const result=await env.DB.batch([env.DB.prepare('UPDATE product_media SET active=0 WHERE id=? AND active=1').bind(remove[1]),
      env.DB.prepare("UPDATE cloud_media_uploads SET state='failed' WHERE id=? AND EXISTS(SELECT 1 FROM product_media WHERE id=? AND active=0)").bind(remove[1],remove[1])]);
    if(!changes(result[0]))fail(404,'Không tìm thấy media.');return json({ok:true,cleanup:await tryCleanup(env)});
  }
  if(/^\/api\/admin\/products\/[\w-]+\/media$/.test(path)&&request.method==='POST')fail(409,'Bản Cloudflare nhận bộ file đã nén và đóng watermark trên máy. Hãy tải lại trang quản lý media.');
  return null;
}
