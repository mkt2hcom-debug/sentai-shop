import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { createApp } from '../server.mjs';
import { canonicalGroupURL, canonicalPostURL } from '../lib/prices.mjs';

const PASSWORD = 'reference-price-test-password';
const GROUP = 'https://www.facebook.com/groups/sentai.testing/';
const POST = `${GROUP}posts/123456789/`;
async function fixture(t, runner = async args => args.includes('--check') ? {available:true,message:'Test collector'} : {status:'partial',message:'Giới hạn thử nghiệm',posts:[],scanned_count:0}) {
  const directory = mkdtempSync(join(tmpdir(),'sentai-prices-test-'));
  const app = createApp({ dbPath:join(directory,'shop.sqlite'),adminPassword:PASSWORD,priceRunner:runner });
  await new Promise(resolve => app.server.listen(0,'127.0.0.1',resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  let cookie, csrf;
  const api = async (path, {method='GET',body,auth=true,headers={}}={}) => {
    const response = await fetch(base+path,{method,headers:{...(cookie && auth ? {Cookie:cookie,'X-CSRF-Token':csrf}:{}),...(body === undefined ? {} : {'Content-Type':'application/json'}),...headers},...(body === undefined ? {} : {body:JSON.stringify(body)})});
    return {status:response.status,body:await response.json(),headers:response.headers};
  };
  const logged = await api('/api/admin/login',{method:'POST',body: {username:'admin',password:PASSWORD}});
  assert.equal(logged.status,200);
  assert.match(logged.body.csrf_token,/^[a-f0-9]{64}$/);
  cookie = logged.headers.get('set-cookie').split(';')[0];
  csrf = logged.body.csrf_token;
  t.after(async () => {
    app.server.closeAllConnections();
    await new Promise(resolve => app.server.close(resolve));
    await app.prices.close(); await app.media.close(); app.db.close();
    assert.ok(resolve(directory).startsWith(resolve(tmpdir())+sep) && directory.includes('sentai-prices-test-'));
    rmSync(directory,{recursive:true,force:true});
  });
  async function seed() {
    const group = await api('/api/admin/prices/groups',{method:'POST',body:{name:'Nhóm kiểm thử',url:GROUP}});
    const keyword = await api('/api/admin/prices/keywords',{method:'POST',body:{keyword:'DX Kiramaizin',product_id:'sentai-row-2'}});
    assert.equal(group.status,201); assert.equal(keyword.status,201);
    return {group_id:group.body.group.id,keyword_id:keyword.body.keyword.id};
  }
  return {...app,base,api,seed};
}
async function settled(app) {
  for (let i=0;i<80;i++) {
    const response=await app.api('/api/admin/prices');
    if (!response.body.scans.some(s=>['queued','running'].includes(s.status))) return response.body;
    await new Promise(resolve=>setTimeout(resolve,20));
  }
  assert.fail('Test collector did not settle');
}

test('Facebook source allowlist and canonical post identity reject unrelated destinations',()=>{
  assert.equal(canonicalGroupURL('https://m.facebook.com/groups/sentai.testing?ref=share'),GROUP);
  assert.equal(canonicalPostURL(`${GROUP}permalink/123456789/?ref=share`,GROUP),POST);
  for (const value of ['https://facebook.com.evil.test/groups/1/','file:///groups/1','https://user:pass@facebook.com/groups/1','https://facebook.com:8000/groups/1','https://facebook.com/groups/search','https://facebook.com/groups/a/posts/b']) assert.throws(()=>canonicalGroupURL(value));
  assert.throws(()=>canonicalPostURL('https://www.facebook.com/groups/another/posts/123/',GROUP));
});

test('admin-only price evidence supports dedupe, changed-post history, review and private source removal',async t=>{
  const app=await fixture(t);
  assert.equal((await app.api('/api/admin/prices',{auth:false})).status,401);
  assert.equal((await app.api('/api/admin/prices/groups',{method:'POST',body:{name:'Bad',url:GROUP},headers:{Origin:'https://example.org'}})).status,403);
  const ids=await app.seed();
  const originalPrice=app.db.prepare('SELECT price_vnd FROM products WHERE id=?').get('sentai-row-2').price_vnd;
  const body={...ids,post_url:POST,text:'DX Kiramaizin fullbox giá 850k',published_text:'2 giờ'};
  const first=await app.api('/api/admin/prices/import',{method:'POST',body});
  assert.equal(first.status,201);
  assert.equal(first.body.observation.price_vnd,850000);
  assert.equal(first.body.observation.published_at,null);
  assert.equal(first.body.observation.published_text,'2 giờ');
  const repeated=await app.api('/api/admin/prices/import',{method:'POST',body:{...body,post_url:POST+'?ref=share'}});
  assert.equal(first.body.observation.id,repeated.body.observation.id);
  const changed=await app.api('/api/admin/prices/import',{method:'POST',body:{...body,text:'DX Kiramaizin fullbox giá 900k'}});
  assert.notEqual(changed.body.observation.id,first.body.observation.id);
  assert.equal((await app.api('/api/admin/prices/import',{method:'POST',body:{...body,post_url:'https://www.facebook.com/groups/other/posts/123/'}})).status,400);
  assert.equal((await app.api('/api/admin/prices/import',{method:'POST',body:{...body,text:'Món khác 700k'}})).status,400);
  const reviewed=await app.api(`/api/admin/prices/observations/${first.body.observation.id}`,{method:'PATCH',body:{review_status:'accepted'}});
  assert.equal(reviewed.body.observation.review_status,'accepted');
  assert.equal(app.db.prepare('SELECT price_vnd FROM products WHERE id=?').get('sentai-row-2').price_vnd,originalPrice);
  const publicCatalog=await app.api('/api/catalog',{auth:false});
  assert.ok(!JSON.stringify(publicCatalog.body).includes('sentai.testing'));
  assert.equal((await fetch(app.base+'/data/prices/facebook-profile/Preferences')).status,404);
  assert.equal((await app.api(`/api/admin/prices/groups/${ids.group_id}`,{method:'DELETE'})).status,200);
  let snapshot=(await app.api('/api/admin/prices')).body;
  assert.equal(snapshot.groups.length,0); assert.equal(snapshot.observations.length,2);
  await app.api('/api/admin/prices/groups',{method:'POST',body:{name:'Tên nhóm mới',url:GROUP}});
  snapshot=(await app.api('/api/admin/prices')).body;
  assert.equal(snapshot.groups[0].id,ids.group_id);
});

test('bounded scan writes matching posts, rejects foreign group links, preserves partial status and evidence flags',async t=>{
  const calls=[];
  const app=await fixture(t,async args=>{
    if(args.includes('--check')) return {available:true,message:'Ready'};
    calls.push(args);
    return {status:'partial',message:'Đã đạt giới hạn bài.',scanned_count:3,posts:[
      {url:POST,text:'DX Kiramaizin giá 1tr2',text_source:'article'},
      {url:GROUP+'posts/987/',text:'Sản phẩm khác 800k'},
      {url:'https://www.facebook.com/groups/other/posts/123/',text:'DX Kiramaizin giá 500k'}
    ]};
  });
  const ids=await app.seed();
  const result=await app.api('/api/admin/prices/scans',{method:'POST',body:{group_ids:[ids.group_id],keyword_id:ids.keyword_id,max_posts:10}});
  assert.equal(result.status,202);
  const data=await settled(app);
  assert.equal(data.scans[0].status,'partial');
  assert.equal(data.scans[0].post_count,1);
  assert.equal(data.observations.length,1);
  assert.equal(data.observations[0].price_vnd,1200000);
  assert.ok(data.observations[0].flags.includes('article_text'));
  assert.ok(data.observations[0].flags.includes('needs_review'));
  assert.equal(calls[0][calls[0].indexOf('--group')+1],GROUP);
  assert.equal(calls[0][calls[0].indexOf('--max-posts')+1],'10');
  assert.equal((await app.api('/api/admin/prices/scans',{method:'POST',body:{group_ids:[ids.group_id],keyword_id:ids.keyword_id,max_posts:51}})).status,400);
});

test('expired Facebook session marks queued scans needs_login without treating them as zero-result successes',async t=>{
  let calls=0;
  const app=await fixture(t,async args=>{
    if(args.includes('--check')) return {available:true};
    calls++;
    return {status:'needs_login',message:'Cần đăng nhập',posts:[],scanned_count:0};
  });
  const ids=await app.seed();
  const group2=(await app.api('/api/admin/prices/groups',{method:'POST',body:{name:'Nhóm hai',url:'https://www.facebook.com/groups/sentai.second/'}})).body.group;
  await app.api('/api/admin/prices/scans',{method:'POST',body:{group_ids:[ids.group_id,group2.id],keyword_id:ids.keyword_id}});
  const data=await settled(app);
  assert.equal(calls,1); assert.equal(data.scans.length,2);
  assert.ok(data.scans.every(s=>s.status==='needs_login'));
  assert.equal(data.observations.length,0);
});

test('Facebook login is local-only and blocks scans until its browser closes',async t=>{
  let release;
  const app=await fixture(t,async (args,options)=>{
    if(args.includes('--check')) return {available:true};
    if(args.includes('--login')) { options.onLine?.({type:'login_open'}); return new Promise(resolve=>release=()=>resolve({type:'login_closed'})); }
    return {status:'partial',posts:[],scanned_count:0};
  });
  const ids=await app.seed();
  assert.equal((await app.api('/api/admin/prices/login',{method:'POST',body:{},headers:{'X-Forwarded-For':'192.0.2.5'}})).status,403);
  const opened=await app.api('/api/admin/prices/login',{method:'POST',body:{}});
  assert.equal(opened.status,202);
  try {
    assert.equal((await app.api('/api/admin/prices')).body.collector.login_open,true);
    assert.equal((await app.api('/api/admin/prices/scans',{method:'POST',body:{group_ids:[ids.group_id],keyword_id:ids.keyword_id}})).status,409);
    assert.equal((await app.api('/api/admin/prices/login',{method:'POST',body:{}})).status,409);
  } finally { release(); }
});
