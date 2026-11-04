import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ROOT, openDatabase, syncCatalog, getProduct } from '../lib/database.mjs';
import { AnalyticsError, ensureAnalytics, recordAnalyticsView, getAnalytics } from '../lib/analytics.mjs';

function fixture(t) {
  const db = openDatabase(':memory:');
  syncCatalog(db);
  ensureAnalytics(db,{now:'2024-01-01T00:00:00.000Z'});
  t.after(() => db.close());
  return db;
}
const query = (db,params={}) => getAnalytics(db,new URLSearchParams({from:'2026-11-01',to:'2026-11-30',...params}));
const view = (db, productId=null, visitId=randomUUID(), now='2026-11-04T05:00:00.000Z') => {
  const body = {event_id:randomUUID(),visit_id:visitId,page_type:productId ? 'product' : 'home',...(productId ? {product_id:productId} : {})};
  return {...body,...recordAnalyticsView(db,body,{now})};
};
function status(code) {
  return error => error instanceof AnalyticsError && error.status === code;
}

test('analytics migration is additive and preserves first measurement time and existing shop data', t => {
  const db = fixture(t);
  db.prepare('UPDATE products SET price_vnd=123000,price_overridden=1 WHERE id=?').run('sentai-row-84');
  const before = db.prepare('SELECT * FROM products ORDER BY id').all();
  view(db,'sentai-row-84');
  db.exec(readFileSync(resolve(ROOT,'database/schema.sql'),'utf8'));
  const start = ensureAnalytics(db,{now:'2026-11-04T01:00:00Z'});
  assert.equal(start,'2024-01-01T00:00:00.000Z');
  assert.deepEqual(db.prepare('SELECT * FROM products ORDER BY id').all(),before);
  assert.equal(db.prepare('SELECT count(*) n FROM analytics_views').get().n,1);
  const columns = db.prepare('PRAGMA table_info(analytics_views)').all().map(row => row.name);
  assert.ok(!columns.some(name => /ip|email|phone|referrer|user_agent|customer/.test(name)));
});

test('server resolves product identity and event retries are idempotent without trusting supplied URLs or timestamps', t => {
  const db = fixture(t);
  const product = getProduct(db,'sentai-row-84');
  const first = view(db,product.id);
  assert.equal(first.repeated,false);
  const body = {event_id:first.event_id.toUpperCase(),visit_id:first.visit_id.toUpperCase(),page_type:'product',product_id:product.id};
  assert.deepEqual(recordAnalyticsView(db,body,{now:'2026-12-01T00:00:00Z'}),{accepted:true,repeated:true});
  let row = db.prepare('SELECT * FROM analytics_views').get();
  assert.equal(row.family_id,product.family_id);
  assert.equal(row.path,`/products/${product.family_id}`);
  assert.equal(row.name,'Blue Ressha');
  assert.equal(row.unit_label,'Món 01');
  assert.equal(row.created_at,'2026-11-04T05:00:00.000Z');
  assert.throws(() => recordAnalyticsView(db,{...body,product_id:'sentai-row-85'}),status(409));
  assert.throws(() => recordAnalyticsView(db,{...body,visit_id:randomUUID()}),status(409));
  for (const extra of [{path:'/admin'},{created_at:'2000-01-01'},{name:'Injected name'},{family_id:'fake'}]) {
    assert.throws(() => recordAnalyticsView(db,{...body,event_id:randomUUID(),...extra}),status(400));
  }
  for (const invalid of [null,[],{}, {...body,event_id:'bad'}, {...body,visit_id:'bad'}, {...body,page_type:'admin'}, {...body,product_id:'../../admin'}, {...body,page_type:'home'}]) {
    assert.throws(() => recordAnalyticsView(db,invalid),status(400));
  }
  assert.throws(() => recordAnalyticsView(db,{...body,event_id:randomUUID(),product_id:'missing'}),status(404));
  db.prepare('UPDATE products SET active=0 WHERE id=?').run(product.id);
  assert.equal(recordAnalyticsView(db,body).repeated,true,'a retry remains accepted after an item was deactivated');
  assert.throws(() => recordAnalyticsView(db,{...body,event_id:randomUUID()}),status(404));
  row = db.prepare('SELECT count(*) n FROM analytics_views').get();
  assert.equal(row.n,1);
});

test('Vietnam midnight, month and year boundaries use inclusive local date ranges and zero-filled buckets', t => {
  const db = fixture(t), a = randomUUID(), b = randomUUID();
  view(db,null,a,'2026-12-31T16:59:59.999Z');
  view(db,'sentai-row-84',a,'2026-12-31T17:00:00.000Z');
  view(db,'sentai-row-85',b,'2027-01-01T16:59:59.999Z');
  view(db,null,b,'2027-01-01T17:00:00.000Z');
  const days = query(db,{from:'2026-12-31',to:'2027-01-02',bucket:'day'});
  assert.deepEqual({...days.summary},{page_views:4,product_views:2,visits:2});
  assert.deepEqual(days.timeline.map(row => [row.period,row.views,row.product_views,row.visits]),[
    ['2026-12-31',1,0,1],['2027-01-01',2,2,2],['2027-01-02',1,0,1]
  ]);
  assert.equal(days.timeline.reduce((sum,row) => sum+row.views,0),days.summary.page_views);
  assert.notEqual(days.timeline.reduce((sum,row) => sum+row.visits,0),days.summary.visits,'distinct visits are recomputed for the whole range');
  const months = query(db,{from:'2026-12-01',to:'2027-02-28',bucket:'month'});
  assert.deepEqual(months.timeline.map(row => [row.period,row.views]),[['2026-12',1],['2027-01',3],['2027-02',0]]);
  const partial = query(db,{from:'2026-12-31',to:'2027-01-01',bucket:'month'});
  assert.deepEqual(partial.timeline.map(row => row.views),[1,2],'month buckets respect partial range boundaries');
  const years = query(db,{from:'2025-01-01',to:'2027-12-31',bucket:'year'});
  assert.deepEqual(years.timeline.map(row => [row.period,row.views]),[['2025',0],['2026',1],['2027',3]]);
  assert.equal(query(db,{from:'2027-01-01',to:'2027-01-01'}).summary.page_views,2);
});

test('leap days, empty periods and default dates use the Vietnam clock', t => {
  const db = fixture(t);
  view(db,null,randomUUID(),'2024-02-28T17:00:00.000Z');
  const leap = query(db,{from:'2024-02-28',to:'2024-03-01'});
  assert.deepEqual(leap.timeline.map(row => [row.period,row.views]),[['2024-02-28',0],['2024-02-29',1],['2024-03-01',0]]);
  const empty = query(db,{from:'2026-11-01',to:'2026-11-03'});
  assert.deepEqual({...empty.summary},{page_views:0,product_views:0,visits:0});
  assert.equal(empty.timeline.length,3);
  assert.deepEqual(empty.rows,[]);
  assert.equal(empty.total_rows,0);
  const defaults = getAnalytics(db,new URLSearchParams(),{now:'2026-11-04T17:00:00.000Z'});
  assert.equal(defaults.filters.to,'2026-11-05');
  assert.equal(defaults.filters.from,'2026-10-07');
  assert.equal(defaults.timeline.length,30);
  assert.equal(defaults.timezone,'Asia/Ho_Chi_Minh');
});

test('page, product family and physical unit rankings aggregate separately with stable sorting and pagination', t => {
  const db = fixture(t), a = randomUUID(), b = randomUUID();
  view(db,null,a);
  view(db,'sentai-row-84',a);
  view(db,'sentai-row-84',a,'2026-11-05T05:00:00Z');
  view(db,'sentai-row-85',b,'2026-11-06T05:00:00Z');
  view(db,'sentai-row-2',a,'2026-11-07T05:00:00Z');
  const ranked = query(db);
  assert.equal(ranked.rows.length,2);
  assert.deepEqual(ranked.rows.map(row => [row.name,row.views,row.visits]),[['Blue Ressha',3,2],['DX King Express',1,1]]);
  assert.equal(ranked.rows[0].last_view,'2026-11-06T05:00:00.000Z');
  assert.equal(ranked.rows[0].product_id,null);
  const units = query(db,{group:'units'});
  assert.deepEqual(units.rows.map(row => row.product_id),['sentai-row-84','sentai-row-85','sentai-row-2']);
  assert.equal(units.rows[0].views,2);
  assert.equal(units.rows[0].name,'Blue Ressha · Món 01');
  assert.ok(units.rows[0].path.endsWith('?variant=sentai-row-84'));
  const pages = query(db,{group:'pages'});
  assert.equal(pages.total_rows,3);
  assert.equal(pages.rows.find(row => row.id === '/').name,'Trang chủ');
  assert.equal(pages.rows.reduce((sum,row) => sum+row.views,0),pages.summary.page_views);
  assert.deepEqual(query(db,{sort:'views',direction:'asc'}).rows.map(row => row.name),['DX King Express','Blue Ressha']);
  assert.equal(query(db,{sort:'last_view',direction:'desc'}).rows[0].name,'DX King Express');
  assert.equal(query(db,{sort:'visits',direction:'desc'}).rows[0].name,'Blue Ressha');
  assert.equal(query(db,{sort:'name',direction:'desc'}).rows[0].name,'DX King Express');
  const page2 = query(db,{limit:'1',offset:'1'});
  assert.equal(page2.total_rows,2);
  assert.equal(page2.rows.length,1);
  assert.equal(page2.rows[0].name,'DX King Express');
  assert.deepEqual(query(db,{offset:'100'}).rows,[]);
  const found = query(db,{group:'units',search:'mon 02'});
  assert.equal(found.total_rows,1);
  assert.equal(found.rows[0].product_id,'sentai-row-85');
  assert.equal(found.summary.page_views,5,'ranking search does not alter total summary');
  assert.equal(query(db,{search:"%' OR 1=1 --"}).total_rows,0);
});

test('invalid dates, ranges, sort fields and pagination are rejected before SQL', t => {
  const db = fixture(t);
  const invalid = [
    {from:'2023-02-29'}, {from:'2026-02-30'}, {to:'2026-13-01'}, {to:'2026-11-1'},
    {from:'2026-12-01',to:'2026-11-01'}, {from:'1969-12-31'}, {to:'9999-01-01'},
    {from:'2000-01-01',to:'2026-11-04'}, {from:''}, {bucket:'week'}, {group:'orders'},
    {sort:'views; DELETE FROM products'}, {direction:'descending'}, {limit:'0'}, {limit:'101'},
    {limit:'1.5'}, {limit:''}, {offset:'-1'}, {offset:'1000001'}, {search:'a'.repeat(101)}
  ];
  for (const params of invalid) assert.throws(() => query(db,params),status(400),JSON.stringify(params));
  assert.equal(db.prepare('SELECT count(*) n FROM products').get().n,144);
});
