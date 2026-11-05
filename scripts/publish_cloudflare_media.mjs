import { readFile, open, stat, realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, dirname, join, basename } from 'node:path';
import { pathToFileURL } from 'node:url';
import { validateManifest } from '../cloudflare/media.mjs';

const PART_BYTES = 5 * 1024 * 1024;
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
export async function verifyBundle(directory) {
  const folder=await realpath(resolve(directory));
  const manifestPath=join(folder,'manifest.json');
  if ((await stat(manifestPath)).size > 65536 || dirname(await realpath(manifestPath)) !== folder) throw new Error('Manifest không hợp lệ.');
  const parsed=JSON.parse(await readFile(manifestPath,'utf8'));
  const manifest=validateManifest(parsed,parsed?.product_id,parsed?.watermark);
  const expected=manifest.kind === 'image' ? 'image.webp' : 'video.mp4';
  if (manifest.files?.main?.name !== expected || manifest.files?.poster?.name !== 'poster.webp') throw new Error('Tên file không hợp lệ.');
  for (const name of ['main','poster']) {
    const metadata=manifest.files[name], path=join(folder,metadata.name);
    if (basename(metadata.name) !== metadata.name || dirname(await realpath(path)) !== folder || (await stat(path)).size !== metadata.bytes) throw new Error('File bị thay đổi hoặc nằm ngoài bộ tải lên.');
    const handle=await open(path,'r'), whole=createHash('sha256');
    try {
      let offset=0,index=0;
      while (offset < metadata.bytes) {
        const length=Math.min(PART_BYTES,metadata.bytes-offset), buffer=Buffer.alloc(length);
        let received=0;
        while (received < length) {const result=await handle.read(buffer,received,length-received,offset+received);if(!result.bytesRead)throw new Error('File chưa đầy đủ.');received+=result.bytesRead;}
        whole.update(buffer);
        if (name === 'main' && (metadata.parts?.[index]?.bytes !== length || digest(buffer) !== metadata.parts[index].sha256)) throw new Error('Một phần của file đã thay đổi.');
        index++;offset+=length;
      }
      if (whole.digest('hex') !== metadata.sha256 || (name === 'main' && metadata.parts.length !== index)) throw new Error('Mã kiểm tra file không khớp.');
    } finally {await handle.close();}
  }
  return {folder,manifest};
}

export async function publishBundle(directory,origin,token) {
  const url=new URL(origin);
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1','localhost','[::1]'].includes(url.hostname))) || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('Dùng địa chỉ gốc HTTPS của cửa hàng.');
  if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) throw new Error('Thiếu SENTAI_SESSION_TOKEN hợp lệ. Cách thông thường: tải bộ file qua trang quản lý sản phẩm sau khi đăng nhập.');
  const {folder,manifest}=await verifyBundle(directory);
  const sessionResponse=await fetch(new URL('/api/admin/session',url),{headers:{Cookie:`sentai_session=${token}`},redirect:'error',signal:AbortSignal.timeout(30000)});
  const session=await sessionResponse.json().catch(()=>({}));
  if (!sessionResponse.ok || !session.authenticated || !/^[a-f0-9]{64}$/.test(session.csrf_token)) throw new Error('Phiên quản trị đã hết hạn. Đăng nhập lại hoặc dùng trang quản lý media.');
  const request=async (path,{method='POST',body={},binary=false}={})=>{
    const response=await fetch(new URL(path,url),{method,redirect:'error',headers:{Cookie:`sentai_session=${token}`,
      Origin:url.origin,'X-CSRF-Token':session.csrf_token,
      'Content-Type':binary?'application/octet-stream':'application/json'},body:method==='DELETE'?undefined:binary?body:JSON.stringify(body),signal:AbortSignal.timeout(120000)});
    const data=await response.json().catch(()=>({}));
    if (!response.ok) throw new Error(data.error || `Tải lên thất bại (${response.status}).`);
    return data;
  };
  const {upload}=await request(`/api/admin/products/${encodeURIComponent(manifest.product_id)}/media/prepared`,{body:manifest});
  if (!upload || !/^[a-f0-9-]{36}$/.test(upload.id) || upload.part_bytes !== PART_BYTES) throw new Error('Máy chủ trả về lượt tải không hợp lệ.');
  const handle=await open(join(folder,manifest.files.main.name),'r');
  try {
    for(let index=0;index<manifest.files.main.parts.length;index++) {
      const part=manifest.files.main.parts[index], buffer=Buffer.alloc(part.bytes);
      const {bytesRead}=await handle.read(buffer,0,part.bytes,index*PART_BYTES);
      if (bytesRead !== part.bytes || digest(buffer) !== part.sha256) throw new Error('File đã thay đổi khi tải.');
      await request(`/api/admin/media/${upload.id}/parts/${index+1}?file=main`,{body:buffer,binary:true});
      console.log(`Đã tải phần ${index+1}/${manifest.files.main.parts.length}.`);
    }
    const poster=await readFile(join(folder,'poster.webp'));
    if (digest(poster) !== manifest.files.poster.sha256) throw new Error('Ảnh xem trước đã thay đổi.');
    await request(`/api/admin/media/${upload.id}/parts/1?file=poster`,{body:poster,binary:true});
    const result=await request(`/api/admin/media/${upload.id}/complete`);
    return {ok:true,product_id:manifest.product_id,media_id:result.media?.id,visible_after:result.visible_after||result.media?.visible_after};
  } catch (error) {
    await request(`/api/admin/media/${upload.id}/upload`,{method:'DELETE'}).catch(()=>{});
    throw error;
  } finally {await handle.close();}
}

async function main() {
  const options=new Map();
  for(let index=2;index<process.argv.length;index+=2) {
    if (!['--bundle','--url'].includes(process.argv[index]) || !process.argv[index+1]) throw new Error('Dùng --bundle THƯ_MỤC --url https://địa-chỉ-cửa-hàng');
    options.set(process.argv[index],process.argv[index+1]);
  }
  if (!options.get('--bundle') || !options.get('--url')) throw new Error('Dùng --bundle THƯ_MỤC --url https://địa-chỉ-cửa-hàng');
  console.log(JSON.stringify(await publishBundle(options.get('--bundle'),options.get('--url'),process.env.SENTAI_SESSION_TOKEN)));
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch(error=>{console.error(error.message);process.exitCode=1;});
