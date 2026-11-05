import { DatabaseSync } from 'node:sqlite';
import { existsSync, lstatSync, realpathSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, basename, resolve, relative, isAbsolute, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';

const ROOT=fileURLToPath(new URL('../',import.meta.url));
// An explicit allowlist prevents newly introduced secret/session tables from
// silently entering a deployment artifact. Existing private fields stay encrypted.
export const EXPORT_TABLES=Object.freeze([
  'products','product_families','product_units','shop_metadata','data_protection_state',
  'orders','order_items','order_item_options','media_jobs','product_media',
  'price_groups','price_keywords','price_scans','price_observations',
  'analytics_meta','analytics_views','security_events'
]);
const PRIVATE_FIELDS=['customer_name','customer_phone','customer_email','customer_address','note'];
function inside(directory,path) {
  const part=relative(resolve(directory),resolve(path));
  return part===''||(!isAbsolute(part)&&part!=='..'&&!part.startsWith(`..${sep}`));
}
function checkedPath(path) {
  const requested=resolve(path);
  let current=requested;
  while (true) {
    if (existsSync(current)&&lstatSync(current).isSymbolicLink()) throw new Error('Không dùng symlink/junction trong đường dẫn xuất dữ liệu.');
    const parent=dirname(current);
    if (parent===current) break;
    current=parent;
  }
  let ancestor=requested,remaining=[];
  while (!existsSync(ancestor)) {remaining.unshift(basename(ancestor));ancestor=dirname(ancestor);}
  return resolve(realpathSync(ancestor),...remaining);
}
function destinationPath(path) {
  const target=checkedPath(path),root=realpathSync(ROOT);
  if (inside(root,target)&&!inside(resolve(root,'data/cloudflare'),target)&&!inside(resolve(root,'backups/cloudflare'),target)) {
    throw new Error('Bản SQL chứa dữ liệu riêng: trong dự án chỉ xuất vào data/cloudflare hoặc backups/cloudflare (đã loại khỏi Git).');
  }
  if (inside(resolve(root,'public'),target)) throw new Error('Không xuất dữ liệu riêng vào public.');
  if (!target.endsWith('.sql')) throw new Error('Đường dẫn xuất cần có đuôi .sql.');
  if (existsSync(target)||existsSync(`${target}.manifest.json`)) throw new Error('File xuất đã tồn tại. Chọn tên mới để giữ bản trước.');
  return target;
}
function sqlValue(value) {
  if (value===null) return 'NULL';
  if (typeof value==='number') {if (!Number.isFinite(value)) throw new Error('Giá trị SQL không hợp lệ.');return String(value);}
  if (typeof value==='bigint') return String(value);
  if (value instanceof Uint8Array) return `X'${Buffer.from(value).toString('hex')}'`;
  if (typeof value==='string') {
    if (value.includes('\0')) return `CAST(X'${Buffer.from(value,'utf8').toString('hex')}' AS TEXT)`;
    return `'${value.replaceAll("'","''")}'`;
  }
  throw new Error('Kiểu giá trị SQL không hỗ trợ.');
}
export function exportCloudflare({database,output}) {
  if (!database||!output) throw new Error('Cần --database đường-dẫn.sqlite và --output đường-dẫn.sql.');
  const source=checkedPath(database),target=destinationPath(output);
  if (!lstatSync(source).isFile()) throw new Error('Database nguồn không phải tập tin.');
  const db=new DatabaseSync(source,{readOnly:true});
  let sql,manifest;
  try {
    // A readonly snapshot includes a live WAL consistently without checkpoint,
    // schema upgrades, secret-key creation or any change to the source database.
    db.exec('BEGIN');
    const tables=new Set(db.prepare("SELECT name FROM sqlite_schema WHERE type='table'").all().map(row=>row.name));
    for (const name of EXPORT_TABLES) if (!tables.has(name)) throw new Error(`Database thiếu bảng ${name}; cập nhật ứng dụng cục bộ trước khi xuất.`);
    if (db.prepare('PRAGMA foreign_key_check').all().length) throw new Error('Database có tham chiếu SQL không hợp lệ.');
    const state=db.prepare('SELECT key_check,scrub_required FROM data_protection_state WHERE id=1').get();
    if (!state||state.scrub_required||!/^enc:v1:[A-Za-z0-9_-]+$/.test(state.key_check)) throw new Error('Database chưa hoàn tất bảo vệ dữ liệu đơn hàng.');
    for (const row of db.prepare(`SELECT ${PRIVATE_FIELDS.join(',')} FROM orders`).iterate()) {
      if (PRIVATE_FIELDS.some(field=>!/^enc:v1:[A-Za-z0-9_-]+$/.test(row[field]))) throw new Error('Đơn hàng còn dữ liệu riêng chưa mã hóa; từ chối xuất.');
    }
    if (db.prepare("SELECT 1 FROM media_jobs WHERE status IN ('uploading','queued','processing') LIMIT 1").get()||
        db.prepare("SELECT 1 FROM price_scans WHERE status IN ('queued','running') LIMIT 1").get()) {
      throw new Error('Còn lượt tải/xử lý/quét đang chờ. Hoàn tất hoặc hủy trên máy nguồn trước khi chuyển dữ liệu.');
    }
    if (db.prepare('SELECT 1 FROM product_units GROUP BY family_id,unit_label COLLATE NOCASE HAVING count(*)>1 LIMIT 1').get()) throw new Error('Có tên món trùng trong cùng mẫu. Đổi tên trước khi chuyển.');
    const lines=['-- PRIVATE migration snapshot. Never commit or serve this file.','-- Apply 0001+ schema migrations to an EMPTY D1 database before this import.'];
    manifest={format:'sentai-cloudflare-snapshot-v1',created_at:new Date().toISOString(),tables:{},excluded:['admin_credentials','admin_recovery','security_limits','cloud upload drafts','secrets and media file bytes']};
    let byteLength=0;
    for (const name of EXPORT_TABLES) {
      const columns=db.prepare(`PRAGMA table_info("${name}")`).all().map(row=>row.name);
      const query=`SELECT * FROM "${name}"${name==='shop_metadata'?" WHERE key='catalog'":''}`;
      let count=0;
      for (const row of db.prepare(query).iterate()) {
        const statement=`INSERT INTO "${name}" (${columns.map(column=>`"${column}"`).join(',')}) VALUES (${columns.map(column=>sqlValue(row[column])).join(',')});`;
        const size=Buffer.byteLength(statement,'utf8');
        if (size>96000) throw new Error(`Một dòng trong bảng ${name} vượt giới hạn câu lệnh D1. Cần chuyển bằng API có tham số.`);
        byteLength+=size+1;
        if (byteLength>64*1024*1024) throw new Error('Snapshot vượt 64 MB. Cần xuất theo lô trước khi chuyển.');
        lines.push(statement);count++;
      }
      manifest.tables[name]=count;
    }
    db.exec('COMMIT');
    sql=lines.join('\n')+'\n';
    manifest.bytes=Buffer.byteLength(sql,'utf8');
    manifest.sha256=createHash('sha256').update(sql).digest('hex');
  } finally {db.close();}
  mkdirSync(dirname(target),{recursive:true,mode:0o700});
  // Re-check created parents; never follow a changed/replaced junction.
  if (checkedPath(target)!==target) throw new Error('Đường dẫn xuất đã thay đổi.');
  writeFileSync(target,sql,{flag:'wx',mode:0o600});
  writeFileSync(`${target}.manifest.json`,JSON.stringify(manifest,null,2)+'\n',{flag:'wx',mode:0o600});
  return {file:target,manifest};
}
function main() {
  const args=process.argv.slice(2),options={};
  for (let index=0;index<args.length;index+=2) {
    if (!['--database','--output'].includes(args[index])||!args[index+1]||args[index+1].startsWith('--')) throw new Error('Dùng: node scripts/export_cloudflare.mjs --database data/sentai.sqlite --output data/cloudflare/snapshot.sql');
    const key=args[index].slice(2);
    if (options[key]) throw new Error(`Tham số ${args[index]} bị lặp.`);
    options[key]=args[index+1];
  }
  const result=exportCloudflare(options);
  console.log(JSON.stringify({file:result.file,...result.manifest},null,2));
}
if (process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href) {
  try {main();} catch(error) {console.error(error.message);process.exitCode=1;}
}
