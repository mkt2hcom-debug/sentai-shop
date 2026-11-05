import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { readFile, writeFile, mkdir, unlink, lstat } from 'node:fs/promises';
import { resolve, dirname, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { spawn } from 'node:child_process';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
function parseConfig(text) {
  // Strip JSONC comments and trailing commas without changing quoted strings.
  let output = '', quoted = false, escaped = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quoted) { output += char; if (escaped) escaped = false; else if (char === '\\') escaped = true; else if (char === '"') quoted = false; continue; }
    if (char === '"') { quoted = true; output += char; continue; }
    if (char === '/' && text[i + 1] === '/') { while (i < text.length && text[i] !== '\n') i++; output += '\n'; continue; }
    if (char === '/' && text[i + 1] === '*') { i += 2; while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++; i++; continue; }
    if (char === ',' && /^[\s]*[}\]]/.test(text.slice(i + 1))) continue;
    output += char;
  }
  return JSON.parse(output);
}
export function makeGrant(publicOrigin, now = Date.now()) {
  const url = new URL(publicOrigin);
  if (url.protocol !== 'https:' || url.origin !== publicOrigin || url.username || url.password) throw new Error('Địa chỉ cửa hàng phải là HTTPS, không chứa đường dẫn.');
  const token = randomBytes(32).toString('base64url'), hash = createHash('sha256').update(token).digest('hex'), expiresAt = now + 20 * 60000;
  return { link: `${url.origin}/admin#access=${token}`, hash, expiresAt,
    sql: `DELETE FROM cf_admin_grants;\nINSERT INTO cf_admin_grants(token_hash,expires_at,consumed_at) VALUES('${hash}',${expiresAt},NULL);\n` };
}
async function safeDirectory(path) {
  for (let current = resolve(path); ; current = dirname(current)) {
    try { if ((await lstat(current)).isSymbolicLink()) throw new Error('Không dùng junction hoặc symlink cho file đăng nhập tạm.'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (dirname(current) === current) break;
  }
  await mkdir(path, { recursive: true, mode: 0o700 });
}
function execute(command, args, input) {
  return new Promise((accept, reject) => {
    const child = spawn(command, args, { cwd: ROOT, shell: false, windowsHide: true, stdio: ['pipe', 'ignore', 'ignore'], env: { ...process.env, WRANGLER_SEND_METRICS: 'false' } });
    child.once('error', () => reject(new Error('Không chạy được công cụ đăng nhập.')));
    child.once('close', code => code === 0 ? accept() : reject(new Error('Chưa hoàn tất. Kiểm tra đăng nhập Wrangler và cấu hình Cloudflare.')));
    child.stdin.on('error', () => {}); child.stdin.end(input || '');
  });
}
export async function main(args = process.argv.slice(2)) {
  const { values } = parseArgs({ args, options: { config: { type: 'string', default: 'wrangler.local.jsonc' }, origin: { type: 'string' }, local: { type: 'boolean', default: false }, help: { type: 'boolean', default: false } } });
  if (values.help) { console.log('node scripts/cloudflare_admin_link.mjs [--config wrangler.local.jsonc] [--origin https://your-shop.workers.dev] [--local]\nTạo liên kết một lần, hết hạn 20 phút, tự mở trình duyệt. Mặc định dùng D1 thật (--remote). --origin mặc định lấy PUBLIC_ORIGIN từ môi trường hoặc vars trong config. Không in liên kết/mã đăng nhập.'); return; }
  const configPath = resolve(ROOT, values.config), config = parseConfig(await readFile(configPath, 'utf8'));
  const binding = config.d1_databases?.find(item => item.binding === 'DB');
  if (!binding) throw new Error('Cấu hình chưa có D1 binding DB.');
  const grant = makeGrant(values.origin || process.env.PUBLIC_ORIGIN || config.vars?.PUBLIC_ORIGIN);
  const directory = resolve(ROOT, 'data/cloudflare'); await safeDirectory(directory);
  const file = resolve(directory, `admin-grant-${randomUUID()}.sql`);
  if (!file.startsWith(directory + sep)) throw new Error('Đường dẫn tạm không hợp lệ.');
  await writeFile(file, grant.sql, { mode: 0o600, flag: 'wx' });
  try {
    await execute(process.execPath, [resolve(ROOT, 'node_modules/wrangler/bin/wrangler.js'), 'd1', 'execute', 'DB', '--config', configPath, '--file', file, ...(values.local ? ['--local', '--persist-to', resolve(ROOT, 'data/cloudflare-dev')] : ['--remote'])]);
  } finally { await unlink(file); }
  if (process.platform === 'win32') await execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '$sentaiAdminUrl = [Console]::In.ReadToEnd(); Start-Process -FilePath $sentaiAdminUrl'], grant.link);
  else await execute(process.platform === 'darwin' ? 'open' : 'xdg-open', [grant.link]);
  console.log('Đã mở trang quản trị. Liên kết dùng một lần và hết hạn sau 20 phút. Thêm passkey trong trang để đăng nhập lần sau.');
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch(error => { console.error(error instanceof TypeError ? 'Chưa có địa chỉ cửa hàng. Dùng --origin https://your-shop.workers.dev.' : error.message); process.exitCode = 1; });
