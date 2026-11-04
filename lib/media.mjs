import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync, statSync, unlinkSync, openSync, closeSync, readFileSync, writeFileSync } from 'node:fs';
import { open, rename, unlink } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { ROOT, getMedia, getProduct } from './database.mjs';

const IMAGE_LIMIT = 25 * 1024 * 1024;
const VIDEO_LIMIT = 300 * 1024 * 1024;
const WORKER = resolve(ROOT, 'scripts/process_media.py');
const validID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
export class MediaError extends Error {
  constructor(status,message) { super(message); this.status = status; this.publicMessage = true; }
}
const fail = (status,message)=>{throw new MediaError(status,message);};
const safeUnlink = async path => { try { await unlink(path); } catch (error) { if (error.code !== 'ENOENT') throw error; } };

const localPython = resolve(ROOT,'.venv',process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
export function createMediaService({db,directory,phone,python = process.env.PYTHON_PATH || (existsSync(localPython) ? localPython : 'python')}) {
  const root = resolve(directory);
  const originals = join(root,'originals');
  const temporary = join(root,'tmp');
  const processed = join(root,'processed');
  for (const folder of [root,originals,temporary,processed]) mkdirSync(folder,{recursive:true});
  const lockPath=join(root,'worker.lock');
  const lockToken=randomUUID();
  function acquireLock() {
    try {
      const fd=openSync(lockPath,'wx');
      try {writeFileSync(fd,JSON.stringify({pid:process.pid,token:lockToken}));} finally {closeSync(fd);}
    } catch(error) {
      if(error.code !== 'EEXIST') throw error;
      let owner;
      try {owner=JSON.parse(readFileSync(lockPath,'utf8'));} catch {fail(503,'Khóa xử lý media không đọc được. Kiểm tra máy chủ trước khi khởi động lại.');}
      let alive=true;
      try {process.kill(owner.pid,0);} catch(error) {if(error.code === 'ESRCH') alive=false;}
      if(alive) fail(503,'Một máy chủ khác đang sử dụng thư mục media này. Hãy dùng máy chủ đang chạy hoặc dừng nó trước.');
      unlinkSync(lockPath);
      acquireLock();
    }
  }
  acquireLock();
  let closing = false;
  let busy = false;
  let pending = null;
  let child = null;
  let stopChild = null;
  let capabilities = null;
  let capabilityCheckedAt = 0;
  let checking = null;
  const now = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";

  function killProcessTree(proc) {
    if (!proc?.pid) return Promise.resolve();
    if (process.platform !== 'win32') {
      try { process.kill(-proc.pid,'SIGKILL'); } catch(error) { if(error.code !== 'ESRCH') proc.kill('SIGKILL'); }
      return Promise.resolve();
    }
    return new Promise(accept=>{
      const killer=spawn('taskkill',['/pid',String(proc.pid),'/t','/f'],{windowsHide:true,shell:false,stdio:'ignore'});
      killer.once('error',()=>{proc.kill();accept();});
      killer.once('close',()=>accept());
    });
  }
  function runPython(args, timeoutMs) {
    return new Promise((accept,reject)=>{
      const proc = spawn(python,[WORKER,...args],{shell:false,windowsHide:true,detached:process.platform !== 'win32',env:{...process.env,PYTHONIOENCODING:'utf-8'},stdio:['ignore','pipe','pipe']});
      let stdout = '', stderr = '', settled = false, timedOut = false, termination = null;
      const stop=()=>termination ||= killProcessTree(proc);
      if (!args.includes('--check')) {child = proc;stopChild = stop;}
      const finish = (error,result)=>{
        if (settled) return;
        settled = true; clearTimeout(timer);
        if (child === proc) {child = null;stopChild = null;}
        error ? reject(error) : accept(result);
      };
      const timer = setTimeout(()=>{timedOut=true;stop();},timeoutMs);
      proc.stdout.on('data',chunk=>{stdout = (stdout+chunk.toString('utf8')).slice(-65536);});
      proc.stderr.on('data',chunk=>{stderr = (stderr+chunk.toString('utf8')).slice(-4096);});
      proc.once('error',()=>finish(new Error('Không chạy được Python. Kiểm tra Python và requirements-media.txt trên máy chủ.')));
      proc.once('close',async code=>{
        if(termination) await termination;
        if(timedOut) return finish(new Error('Xử lý quá thời gian cho phép. Vui lòng thử video ngắn hơn.'));
        let result;
        try { result = JSON.parse(stdout.trim().split(/\r?\n/).filter(Boolean).at(-1) || '{}'); } catch { return finish(new Error('Bộ xử lý media trả về dữ liệu không hợp lệ.')); }
        if (code !== 0 || result.error) return finish(new Error(typeof result.error === 'string' ? result.error : 'Không thể xử lý tập tin này. Kiểm tra định dạng và thử lại.'));
        finish(null,result);
      });
    });
  }

  async function checkProcessor() {
    if (capabilities && Date.now()-capabilityCheckedAt < 60000) return capabilities;
    if (checking) return checking;
    checking = runPython(['--check'],15000).then(result=>{
      capabilities = result;
      capabilityCheckedAt = Date.now();
      return result;
    }).catch(error=>{
      capabilities = {ready:false,image_ready:false,video_ready:false,message:error.message};
      capabilityCheckedAt = Date.now();
      return capabilities;
    }).finally(()=>{checking=null;});
    return checking;
  }

  function jobRecord(row) {
    if (!row) return null;
    const { original_path,upload_key,watermark,...job } = row;
    return {...job,media_id:row.status === 'ready' ? row.id : null};
  }
  function jobById(id) { return jobRecord(db.prepare('SELECT * FROM media_jobs WHERE id=?').get(id)); }
  function getJobs(productId) {
    return db.prepare('SELECT * FROM media_jobs WHERE product_id=? ORDER BY created_at DESC,id DESC LIMIT 60').all(productId).map(jobRecord);
  }
  async function details(productId) {
    const product = getProduct(db,productId);
    if (!product) fail(404,'Không tìm thấy sản phẩm.');
    const availability = await checkProcessor();
    return {product,media:getMedia(db,productId),jobs:getJobs(productId),settings:{
      phone,quality_options:['high','original'],max_image_bytes:IMAGE_LIMIT,max_video_bytes:VIDEO_LIMIT,
      max_duration_seconds:600,processor_ready:Boolean(availability.ready),
      image_ready:Boolean(availability.image_ready ?? availability.ready),video_ready:Boolean(availability.video_ready ?? availability.ready),
      processor_message:availability.message || (availability.ready ? '' : 'Cần cài công cụ xử lý media trên máy chủ.')
    }};
  }

  async function processQueue() {
    if (busy || closing) return;
    busy = true;
    try {
      while (!closing) {
        const job = db.prepare("SELECT * FROM media_jobs WHERE status='queued' ORDER BY created_at,id LIMIT 1").get();
        if (!job) break;
        const outputDir = join(processed,job.id);
        try {
          if (!validID.test(job.id) || !/^[a-f0-9-]{36}\.upload$/i.test(job.original_path)) throw new Error('Đường dẫn media không hợp lệ.');
          db.prepare(`UPDATE media_jobs SET status='processing',error=NULL,updated_at=${now} WHERE id=?`).run(job.id);
          mkdirSync(outputDir,{recursive:true});
          // A stopped encode can leave these generated files; clear only this job's outputs.
          for (const name of ['image.webp','video.mp4','poster.webp','watermark.png','poster.png']) await safeUnlink(join(outputDir,name));
          // Only generated filenames are passed to the decoder; uploads never become shell text.
          const result = await runPython(['--input',join(originals,job.original_path),'--output-dir',outputDir,
            '--kind',job.kind,'--phone',job.watermark,'--quality',job.quality],16*60*1000);
          if (closing) break;
          const expectedName = job.kind === 'image' ? 'image.webp' : 'video.mp4';
          const expectedMime = job.kind === 'image' ? 'image/webp' : 'video/mp4';
          if (result.filename !== expectedName || result.poster_filename !== 'poster.webp' || result.mime_type !== expectedMime ||
              !Number.isInteger(result.width) || !Number.isInteger(result.height) || result.width <= 0 || result.height <= 0 ||
              !existsSync(join(outputDir,expectedName)) || !existsSync(join(outputDir,'poster.webp'))) throw new Error('Bản media xử lý chưa đầy đủ. Vui lòng tải lại tập tin.');
          const bytes = statSync(join(outputDir,expectedName)).size;
          if (!bytes || bytes > 1024*1024*1024) throw new Error('Dung lượng bản xử lý không hợp lệ.');
          db.exec('BEGIN IMMEDIATE');
          try {
            db.prepare(`INSERT INTO product_media(id,product_id,kind,mime_type,filename,poster_filename,width,height,duration,original_name,original_bytes,output_bytes,quality,watermark)
              VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(job.id,job.product_id,job.kind,expectedMime,expectedName,'poster.webp',result.width,result.height,
                Number.isFinite(result.duration) ? result.duration : null,job.original_name,job.original_bytes,bytes,job.quality,job.watermark);
            db.prepare(`UPDATE media_jobs SET status='ready',error=NULL,updated_at=${now} WHERE id=?`).run(job.id);
            db.exec('COMMIT');
          } catch(error) {db.exec('ROLLBACK'); throw error;}
        } catch(error) {
          if (closing) break;
          db.prepare(`UPDATE media_jobs SET status='failed',error=?,updated_at=${now} WHERE id=?`).run(error.message.slice(0,700),job.id);
          // Keep the source private for recovery; unfinished derived files are never served.
        }
      }
    } finally {busy=false;}
  }
  function schedule() {
    if (!closing && !pending) {
      pending = new Promise(accept=>setImmediate(accept)).then(processQueue).catch(error=>console.error('Media queue:',error.message)).finally(()=>{pending=null;});
    }
  }

  async function upload(req, productId, url, assertAuthorized = () => {}) {
    let authorizationError = null;
    const checkAuthorization = () => {
      try { assertAuthorized(); } catch (error) { authorizationError=error; throw error; }
    };
    checkAuthorization();
    if (closing) fail(503,'Máy chủ đang khởi động lại. Vui lòng thử lại.');
    if (!getProduct(db,productId)) fail(404,'Không tìm thấy sản phẩm.');
    if (!phone) fail(409,'Cần cấu hình số điện thoại cửa hàng trước khi chèn watermark.');
    const kind = url.searchParams.get('kind');
    const quality = url.searchParams.get('quality') || 'high';
    if (!['image','video'].includes(kind) || !['high','original'].includes(quality)) fail(400,'Loại tập tin hoặc mức chất lượng không hợp lệ.');
    const limit = kind === 'image' ? IMAGE_LIMIT : VIDEO_LIMIT;
    const contentLength = Number(req.headers['content-length']);
    if (Number.isFinite(contentLength) && contentLength > limit) fail(413,kind === 'image' ? 'Ảnh tối đa 25 MB.' : 'Video tối đa 300 MB.');
    const mime = (req.headers['content-type'] || '').split(';')[0].toLowerCase();
    const allowed = kind === 'image' ? ['image/jpeg','image/png','image/webp','application/octet-stream'] : ['video/mp4','video/quicktime','video/webm','application/octet-stream'];
    if (!allowed.includes(mime)) fail(415,'Chỉ hỗ trợ ảnh JPEG, PNG, WebP và video MP4, MOV, WebM.');
    const key = req.headers['x-upload-id'];
    if (typeof key !== 'string' || !/^[\w-]{16,100}$/.test(key)) fail(400,'Thiếu mã tải lên hợp lệ.');
    let originalName;
    try { originalName=decodeURIComponent(req.headers['x-file-name'] || '').replaceAll('\\','/').split('/').at(-1).replace(/[\x00-\x1f\x7f]/g,'').slice(0,180); }
    catch { fail(400,'Tên tập tin không hợp lệ.'); }
    if (!originalName) fail(400,'Thiếu tên tập tin.');
    const previous = db.prepare('SELECT * FROM media_jobs WHERE upload_key=?').get(key);
    if (previous) {
      if (previous.product_id !== productId || previous.kind !== kind || previous.quality !== quality || previous.original_name !== originalName) fail(409,'Mã tải lên đã dùng cho tập tin khác.');
      if (previous.status === 'uploading') fail(409,'Tập tin này đang được tải lên. Vui lòng chờ.');
      req.resume();
      return {job:jobRecord(previous)};
    }
    if (db.prepare("SELECT count(*) n FROM media_jobs WHERE status IN ('uploading','queued','processing')").get().n >= 20) fail(429,'Hàng đợi đang đầy. Vui lòng chờ các tập tin trước hoàn tất.');
    const count = db.prepare('SELECT count(*) n FROM product_media WHERE product_id=? AND active=1').get(productId).n +
      db.prepare("SELECT count(*) n FROM media_jobs WHERE product_id=? AND status IN ('uploading','queued','processing')").get(productId).n;
    if (count >= 60) fail(409,'Mỗi sản phẩm tối đa 60 ảnh/video. Hãy gỡ bớt media trước khi tải thêm.');
    const availability = await checkProcessor();
    checkAuthorization();
    if (!(availability[`${kind}_ready`] ?? availability.ready)) fail(503,availability.message || 'Bộ xử lý media chưa sẵn sàng trên máy chủ.');
    // Re-check after async capability discovery to keep upload admission bounded.
    if (db.prepare('SELECT id FROM media_jobs WHERE upload_key=?').get(key)) fail(409,'Yêu cầu tải lên này đã được nhận.');
    if (db.prepare("SELECT count(*) n FROM media_jobs WHERE status IN ('uploading','queued','processing')").get().n >= 20) fail(429,'Hàng đợi đang đầy. Vui lòng chờ.');
    const admitted=db.prepare('SELECT count(*) n FROM product_media WHERE product_id=? AND active=1').get(productId).n + db.prepare("SELECT count(*) n FROM media_jobs WHERE product_id=? AND status IN ('uploading','queued','processing')").get(productId).n;
    if (admitted>=60) fail(409,'Mỗi sản phẩm tối đa 60 ảnh/video.');
    const id = randomUUID();
    const originalPath = `${id}.upload`;
    const tmp = join(temporary,`${id}.part`);
    db.prepare(`INSERT INTO media_jobs(id,product_id,upload_key,kind,quality,status,original_name,original_path,watermark) VALUES(?,?,?,?,?,'uploading',?,?,?)`)
      .run(id,productId,key,kind,quality,originalName,originalPath,phone);
    let handle;
    let size = 0;
    let moved = false;
    try {
      handle = await open(tmp,'wx');
      checkAuthorization();
      // Keep the socket available for the 401 response when authorization is
      // revoked mid-stream; the catch path drains and discards remaining bytes.
      for await (const chunk of req.iterator({destroyOnReturn:false})) {
        checkAuthorization();
        size += chunk.length;
        if (size > limit) fail(413,kind === 'image' ? 'Ảnh vượt quá 25 MB.' : 'Video vượt quá 300 MB.');
        let offset=0;
        while(offset<chunk.length) {const result=await handle.write(chunk,offset,chunk.length-offset);offset+=result.bytesWritten;}
      }
      await handle.close(); handle=null;
      checkAuthorization();
      if (!size || (Number.isFinite(contentLength) && contentLength !== size)) fail(400,'Tập tin tải lên chưa đầy đủ. Vui lòng tải lại.');
      await rename(tmp,join(originals,originalPath));
      moved = true;
      checkAuthorization();
      db.prepare(`UPDATE media_jobs SET original_bytes=?,status='queued',updated_at=${now} WHERE id=?`).run(size,id);
      schedule();
      return {job:jobById(id)};
    } catch(error) {
      if (handle) await handle.close().catch(()=>{});
      await safeUnlink(tmp).catch(()=>{});
      if (moved) await safeUnlink(join(originals,originalPath)).catch(()=>{});
      if (authorizationError === error) {
        req.resume();
        db.prepare('DELETE FROM media_jobs WHERE id=?').run(id);
        throw error;
      }
      db.prepare(`UPDATE media_jobs SET status='failed',error=?,updated_at=${now} WHERE id=?`).run('Tải lên bị gián đoạn hoặc tập tin không hợp lệ. Hãy chọn lại tập tin.',id);
      if (error instanceof MediaError) throw error;
      fail(400,'Tải lên bị gián đoạn. Vui lòng chọn lại tập tin.');
    }
  }

  function remove(id) {
    if (!validID.test(id)) fail(404,'Không tìm thấy media.');
    const result = db.prepare('UPDATE product_media SET active=0 WHERE id=? AND active=1').run(id);
    if (!result.changes) fail(404,'Không tìm thấy media.');
    return {ok:true};
  }
  function serve(req,res,path) {
    const match = path.match(/^\/media\/([a-f0-9-]{36})\/(image\.webp|video\.mp4|poster\.webp)$/i);
    if (!match || !validID.test(match[1])) fail(404,'Không tìm thấy media.');
    const record = db.prepare('SELECT m.* FROM product_media m JOIN products p ON p.id=m.product_id WHERE m.id=? AND m.active=1 AND p.active=1').get(match[1]);
    if (!record || ![record.filename,record.poster_filename].includes(match[2])) fail(404,'Không tìm thấy media.');
    const file = join(processed,record.id,match[2]);
    if (!existsSync(file)) fail(404,'Tập tin media không còn trên máy chủ.');
    const size = statSync(file).size;
    let start=0,end=size-1,status=200;
    const headers={'Content-Type':match[2].endsWith('.mp4') ? 'video/mp4' : 'image/webp','Accept-Ranges':'bytes','Cache-Control':'public, max-age=3600','Content-Length':size};
    if (req.headers.range) {
      const parts = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
      if (!parts || (!parts[1] && !parts[2])) {res.writeHead(416,{'Content-Range':`bytes */${size}`});res.end();return;}
      if (!parts[1]) {const suffix=Number(parts[2]);start=Math.max(0,size-suffix);}
      else {start=Number(parts[1]);if(parts[2])end=Math.min(Number(parts[2]),size-1);}
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start<0 || start>=size || end<start) {res.writeHead(416,{'Content-Range':`bytes */${size}`});res.end();return;}
      status=206;headers['Content-Range']=`bytes ${start}-${end}/${size}`;headers['Content-Length']=end-start+1;
    }
    res.writeHead(status,headers);
    if (req.method === 'HEAD') return res.end();
    const stream=createReadStream(file,{start,end});
    stream.on('error',()=>res.destroy());
    res.on('close',()=>stream.destroy());
    stream.pipe(res);
  }

  // Interrupted encodes resume from private originals after a normal restart.
  db.prepare(`UPDATE media_jobs SET status='queued',updated_at=${now} WHERE status='processing'`).run();
  const abandoned=db.prepare("SELECT id FROM media_jobs WHERE status='uploading'").all();
  for(const job of abandoned) {
    const file=join(temporary,`${job.id}.part`);
    if(validID.test(job.id) && existsSync(file)) unlinkSync(file);
  }
  db.prepare(`UPDATE media_jobs SET status='failed',error='Tải lên bị gián đoạn khi máy chủ dừng. Vui lòng chọn lại tập tin.',updated_at=${now} WHERE status='uploading'`).run();
  if(db.prepare("SELECT id FROM media_jobs WHERE status='queued' LIMIT 1").get()) schedule();
  async function close() {
    closing=true;
    if(stopChild) await stopChild();
    if(pending) await pending;
    if(checking) await checking;
    try {if(JSON.parse(readFileSync(lockPath,'utf8')).token === lockToken) unlinkSync(lockPath);} catch(error) {if(error.code !== 'ENOENT') console.error('Media lock:',error.message);}
  }
  return {upload,details,serve,remove,close,getJobs,checkProcessor};
}
