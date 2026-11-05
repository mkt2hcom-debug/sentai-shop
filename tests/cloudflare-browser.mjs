// Run after npm run cf:check. Uses ephemeral local workerd, D1, KV and Chromium.
// No production account, browser profile, database, secret, or screenshots.
import assert from 'node:assert/strict';
import { readFileSync,readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { createCipheriv,createHash,randomBytes } from 'node:crypto';
import { Miniflare,convertV4MiniflareOptions } from 'miniflare';
import { syncCatalog } from '../lib/database.mjs';

async function availablePort(preferred) {
  const check=port=>new Promise((accept,reject)=>{
    const probe=createServer();probe.once('error',reject);
    probe.listen(port,'127.0.0.1',()=>{const actual=probe.address().port;probe.close(()=>accept(actual));});
  });
  try{return await check(preferred);}catch(error){if(error.code!=='EADDRINUSE')throw error;return check(0);}
}
const dataKey=randomBytes(32),grant=randomBytes(32).toString('base64url');
let mf,sql;
try {
  const port=await availablePort(18787),origin=`https://localhost:${port}`;
  mf=new Miniflare(convertV4MiniflareOptions({
    host:'127.0.0.1',port,https:true,modules:true,scriptPath:resolve('dist/cloudflare-worker/worker.js'),compatibilityDate:'2026-11-05',
    d1Databases:['DB'],kvNamespaces:['MEDIA_KV'],
    assets:{directory:resolve('dist/cloudflare-assets'),binding:'ASSETS',run_worker_first:true,
      routerConfig:{has_user_worker:true},assetConfig:{html_handling:'none',not_found_handling:'none'}},
    bindings:{PUBLIC_ORIGIN:origin,SHOP_PHONE:'0326931693',AUTH_SECRET:randomBytes(32).toString('hex'),DATA_ENCRYPTION_KEY:dataKey.toString('hex'),ADMIN_EMAIL:'fixture@example.test'},
    outboundService:async()=>{throw Error('Unexpected external service in isolated browser test');}
  }));
  await mf.ready;
  const db=await mf.getD1Database('DB');sql=new DatabaseSync(':memory:');
  const schema=readdirSync('cloudflare/migrations').filter(name=>name.endsWith('.sql')).sort().map(name=>readFileSync(`cloudflare/migrations/${name}`,'utf8')).join('\n');
  sql.exec(schema);syncCatalog(sql);
  for(const statement of schema.replace(/--[^\n]*/g,'').split(';').map(value=>value.trim()).filter(Boolean)) await db.prepare(statement).run();
  for(const table of ['products','product_families','product_units','shop_metadata']) {
    const rows=sql.prepare(`SELECT * FROM ${table}`).all();
    for(let offset=0;offset<rows.length;offset+=40) await db.batch(rows.slice(offset,offset+40).map(row=>{
      const columns=Object.keys(row);
      return db.prepare(`INSERT INTO ${table}(${columns.map(value=>`"${value}"`).join(',')}) VALUES(${columns.map(()=>'?').join(',')})`).bind(...Object.values(row));
    }));
  }
  const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',dataKey,iv);
  cipher.setAAD(Buffer.from(JSON.stringify(['sentai-order-data',1,'$key-check','$key-check'])));
  const ciphertext=Buffer.concat([cipher.update('sentai:order-data:v1'),cipher.final()]);
  await db.prepare('INSERT INTO data_protection_state(id,key_check,scrub_required) VALUES(1,?,0)').bind('enc:v1:'+Buffer.concat([iv,cipher.getAuthTag(),ciphertext]).toString('base64url')).run();
  await db.prepare('INSERT INTO cf_admin_grants(token_hash,expires_at) VALUES(?,?)').bind(createHash('sha256').update(grant).digest('hex'),Date.now()+20*60000).run();
  const input={origin,bootstrap_url:`${origin}/admin#access=${grant}`};
  const result=await new Promise((accept,reject)=>{
    const python=spawn(resolve('.venv/Scripts/python.exe'),[resolve('tests/cloudflare-browser.py')],{
      cwd:resolve('.'),shell:false,windowsHide:true,env:{...process.env,PYTHONIOENCODING:'utf-8'},stdio:['pipe','pipe','pipe']});
    let stdout='',stderr='';
    const timer=setTimeout(()=>{python.kill();reject(Error('Browser smoke exceeded 120 seconds'));},120000);
    python.stdout.on('data',chunk=>{stdout+=chunk;});python.stderr.on('data',chunk=>{stderr+=chunk;});
    python.once('error',error=>{clearTimeout(timer);reject(error);});
    python.once('close',code=>{clearTimeout(timer);accept({code,stdout,stderr});});
    python.stdin.end(JSON.stringify(input));
  });
  const clean=value=>value.replaceAll(grant,'[redacted]');
  if(result.stdout.trim())console.log(clean(result.stdout.trim()));
  if(result.stderr.trim())console.error(clean(result.stderr.trim()));
  assert.equal(result.code,0,'Browser assertions failed');
  const credentialCount=(await db.prepare('SELECT count(*) n FROM cf_passkeys').first()).n;
  assert.equal(credentialCount,1,'Real WebAuthn registration persisted in local D1');
  assert.equal((await db.prepare('SELECT count(*) n FROM orders').first()).n,0,'Browser smoke must not submit orders');
  console.log('Isolated browser smoke passed; one synthetic passkey, zero orders.');
} catch(error) {
  console.error(String(error.message).replaceAll(grant,'[redacted]'));process.exitCode=1;
} finally {sql?.close();await mf?.dispose();}
