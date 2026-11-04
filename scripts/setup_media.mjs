import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { ROOT } from '../lib/database.mjs';
const python = resolve(ROOT,'.venv',process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
function run(command,args) {
  const result=spawnSync(command,args,{cwd:ROOT,stdio:'inherit',shell:false,windowsHide:true});
  if(result.error || result.status !== 0) {console.error(result.error?.message || 'Thiết lập media chưa hoàn tất.');process.exit(1);}
}
if(!existsSync(python)) run(process.env.PYTHON_PATH || 'python',['-m','venv','.venv']);
run(python,['-m','pip','install','--disable-pip-version-check','-r','requirements-media.txt']);
run(python,['scripts/process_media.py','--check']);
