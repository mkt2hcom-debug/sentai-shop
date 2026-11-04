import { spawnSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const python = resolve(root, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit', shell: false, windowsHide: true });
  if (result.error || result.status !== 0) {
    console.error('Thiết lập trình đọc nhóm chưa hoàn tất. Kiểm tra Python và kết nối tải thư viện.');
    process.exit(1);
  }
}
if (!existsSync(python)) run(process.env.PYTHON_PATH || 'python', ['-m', 'venv', '.venv']);
run(python, ['-m', 'pip', 'install', '--disable-pip-version-check', '-r', 'requirements-prices.txt']);
run(python, ['-m', 'playwright', 'install', 'chromium']);
run(python, ['scripts/collect_group_posts.py', '--check']);
