import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export function codespacesEnvironment(environment = process.env) {
  if (environment.CODESPACES !== 'true') throw new Error('Lệnh này chỉ dùng trong GitHub Codespaces. Trên máy hiện tại dùng npm start.');
  const name = environment.CODESPACE_NAME;
  const domain = environment.GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN;
  const port = environment.PORT || '3000';
  if (typeof port !== 'string' || !/^[1-9]\d{0,4}$/.test(port) || Number(port) > 65535) throw new Error('PORT cần là số từ 1 đến 65535.');
  if (typeof name !== 'string' || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(name) || name.length + port.length + 1 > 63) {
    throw new Error('CODESPACE_NAME không phải tên Codespace hợp lệ.');
  }
  if (typeof domain !== 'string' || domain.length > 253 || !domain.endsWith('.github.dev') ||
      !domain.split('.').every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) {
    throw new Error('GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN cần là tên miền chuyển tiếp GitHub hợp lệ.');
  }
  const hostname = `${name}-${port}.${domain}`;
  if (hostname.length > 253) throw new Error('Tên miền chuyển tiếp quá dài.');
  return {...environment, HOST:'127.0.0.1', PORT:port, PUBLIC_ORIGIN:`https://${hostname}`};
}

function start() {
  const environment = codespacesEnvironment();
  console.log(`Địa chỉ chuyển tiếp dự kiến: ${environment.PUBLIC_ORIGIN}`);
  console.log('Bản chạy thử Codespaces; máy chủ dừng khi Codespace dừng. Cổng mặc định chỉ chủ tài khoản xem được.');
  // Keep the same loopback/TLS/Host checks as production. The Codespaces relay
  // must supply its HTTPS forwarding header; an incompatible relay fails closed.
  const child = spawn(process.execPath, [resolve(ROOT, 'server.mjs')], {
    cwd:ROOT, env:environment, stdio:'inherit', shell:false, windowsHide:true
  });
  const stop = signal => { if (!child.killed) child.kill(signal); };
  const interrupt = () => stop('SIGINT');
  const terminate = () => stop('SIGTERM');
  process.on('SIGINT', interrupt);
  process.on('SIGTERM', terminate);
  child.once('error', () => { console.error('Không khởi động được máy chủ Codespaces.'); process.exitCode = 1; });
  child.once('exit', (code, signal) => {
    process.removeListener('SIGINT', interrupt);
    process.removeListener('SIGTERM', terminate);
    process.exitCode = code ?? (signal === 'SIGINT' ? 130 : signal === 'SIGTERM' ? 143 : 1);
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { start(); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
