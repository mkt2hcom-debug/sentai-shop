import { mkdir, readdir, readFile, writeFile, copyFile, lstat, rm } from 'node:fs/promises';
import { resolve, join, relative, extname, sep, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const source = join(root, 'public'), target = join(root, 'dist', 'cloudflare-assets');
const allowed = new Set(['.html','.js','.css','.svg','.jpg','.jpeg','.png','.webp','.gif','.ico','.woff','.woff2']);
async function safeTree(path) {
  for (const entry of await readdir(path, {withFileTypes:true})) {
    const full = join(path, entry.name);
    if (entry.isSymbolicLink() || (await lstat(full)).isSymbolicLink()) throw new Error('Không đóng gói liên kết filesystem.');
    if (entry.isDirectory()) await safeTree(full);
  }
}
if (target !== resolve(root, 'dist', 'cloudflare-assets') || !target.startsWith(root + sep)) throw new Error('Đường dẫn build không hợp lệ.');
for (let ancestor = dirname(target); ancestor !== dirname(root); ancestor = dirname(ancestor)) {
  try { if ((await lstat(ancestor)).isSymbolicLink()) throw new Error('Không build qua junction hoặc symlink.'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}
try {
  if ((await lstat(target)).isSymbolicLink()) throw new Error('Thư mục build không được là liên kết.');
  await safeTree(target);
  await rm(target, {recursive:true});
} catch (error) { if (error.code !== 'ENOENT') throw error; }
await mkdir(target, {recursive:true});
let count = 0;
async function copy(dir) {
  for (const entry of await readdir(dir, {withFileTypes:true})) {
    if (entry.name.startsWith('.')) throw new Error('Có file ẩn trong thư mục công khai.');
    const full = join(dir, entry.name), out = join(target, relative(source, full));
    if (entry.isSymbolicLink()) throw new Error('Không đóng gói symlink.');
    if (entry.isDirectory()) { await mkdir(out, {recursive:true}); await copy(full); }
    else {
      if (!allowed.has(extname(entry.name))) throw new Error(`Định dạng không được phép: ${entry.name}`);
      if ((await lstat(full)).size > 25 * 1024 * 1024) throw new Error('Asset vượt 25 MiB.');
      await copyFile(full, out); count++;
    }
  }
}
await copy(source);
await copyFile(join(root, 'cloudflare', 'admin-media-local.js'), join(target, 'admin-media.js'));
await copyFile(join(root, 'cloudflare', 'admin-passkey.js'), join(target, 'admin-passkey.js'));
const adminHtml = await readFile(join(target, 'admin.html'), 'utf8');
await writeFile(join(target, 'admin.html'), adminHtml.replace('<meta charset="utf-8">', '<meta charset="utf-8">\n  <script src="/admin-passkey.js"></script>'));
await mkdir(join(target, 'vendor'), {recursive:true});
const { build } = await import('esbuild');
await build({entryPoints:[join(root,'node_modules/@simplewebauthn/browser/esm/index.js')], bundle:true, format:'esm', minify:true,
  outfile:join(target,'vendor/simplewebauthn-browser.js'), platform:'browser', target:'es2022'});
const headers = `/*
  X-Content-Type-Options: nosniff
  Referrer-Policy: no-referrer
  X-Frame-Options: DENY
  Cross-Origin-Resource-Policy: same-origin
  Cross-Origin-Opener-Policy: same-origin
  Strict-Transport-Security: max-age=31536000
  Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=(), usb=()
  Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; font-src 'self'; connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'
/admin*
  Cache-Control: no-store
/images/*
  Cache-Control: public, max-age=86400
`;
await writeFile(join(target, '_headers'), headers);
console.log(`Cloudflare assets: ${count} file; source public only, no database or keys.`);
