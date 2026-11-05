import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { openDatabase, syncCatalog } from '../lib/database.mjs';
import { recordAnalyticsView, getAnalytics, handleAnalytics } from '../cloudflare/analytics.mjs';
import { addGroup, addKeyword, importPost, review, disable, snapshot, canonicalGroupURL, canonicalPostURL, handlePrices } from '../cloudflare/prices.mjs';

// Execute the actual migration SQL against SQLite, preserving D1's asynchronous
// statement contract and atomic batch semantics without touching live data.
function fixture(t) {
  const sqlite = openDatabase(':memory:');
  syncCatalog(sqlite);
  t.after(() => sqlite.close());
  function statement(sql, args = []) {
    const execute = () => {
      const stmt = sqlite.prepare(sql);
      if (stmt.columns().length) {
        const results = stmt.all(...args).map(row => ({ ...row }));
        return { results, success: true, meta: { changes: /^\s*(?:SELECT|WITH)/i.test(sql) ? 0 : sqlite.prepare('SELECT changes() n').get().n } };
      }
      const info = stmt.run(...args);
      return { results: [], success: true, meta: { changes: Number(info.changes), last_row_id: Number(info.lastInsertRowid) } };
    };
    return { bind: (...bindings) => statement(sql, bindings), all: async () => execute(), run: async () => execute(),
      first: async column => { const row = execute().results[0] ?? null; return column ? row?.[column] ?? null : row; }, execute };
  }
  const db = { prepare: statement, batch: async statements => {
    sqlite.exec('BEGIN IMMEDIATE');
    try { const results = statements.map(item => item.execute()); sqlite.exec('COMMIT'); return results; }
    catch (error) { sqlite.exec('ROLLBACK'); throw error; }
  } };
  return { db, sqlite };
}
const status = code => error => error.status === code;
const event = (productId = null, visitId = randomUUID()) => ({ event_id: randomUUID(), visit_id: visitId, page_type: productId ? 'product' : 'home', ...(productId ? { product_id: productId } : {}) });
const report = (db, filters = {}) => getAnalytics(db, new URLSearchParams({ from: '2026-11-01', to: '2026-11-30', ...filters }));
const request = (path, body, headers = {}) => new Request(`https://shop.example${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

test('D1 analytics preserves unit identity, rejects forged fields, and handles concurrent event retries', async t => {
  const { db, sqlite } = fixture(t);
  const body = event('sentai-row-84');
  const results = await Promise.all([recordAnalyticsView(db, body, { now: '2026-11-04T00:00:00Z' }), recordAnalyticsView(db, body)]);
  assert.equal(results.filter(result => !result.repeated).length, 1);
  assert.equal(results.filter(result => result.repeated).length, 1);
  const row = sqlite.prepare('SELECT * FROM analytics_views').get();
  assert.equal(row.name, 'Blue Ressha');
  assert.equal(row.product_id, 'sentai-row-84');
  assert.equal(row.unit_label, 'Món 01');
  assert.equal(row.path, `/products/${row.family_id}`);
  await assert.rejects(recordAnalyticsView(db, { ...body, product_id: 'sentai-row-85' }), status(409));
  await assert.rejects(recordAnalyticsView(db, { ...body, visit_id: randomUUID() }), status(409));
  for (const extra of [{ path: '/admin' }, { created_at: '2000-01-01' }, { family_id: 'fake' }]) await assert.rejects(recordAnalyticsView(db, { ...event('sentai-row-84'), ...extra }), status(400));
  sqlite.prepare('UPDATE products SET active=0 WHERE id=?').run('sentai-row-84');
  assert.equal((await recordAnalyticsView(db, body)).repeated, true);
  await assert.rejects(recordAnalyticsView(db, event('sentai-row-84')), status(404));
  assert.equal(sqlite.prepare('SELECT count(*) n FROM analytics_views').get().n, 1);
});

test('D1 analytics retains Vietnam calendar buckets, family/unit distinction and sorted filtered totals', async t => {
  const { db } = fixture(t), a = randomUUID(), b = randomUUID();
  for (const [id, visit, time] of [[null, a, '2026-12-31T16:59:59.999Z'], ['sentai-row-84', a, '2026-12-31T17:00:00Z'], ['sentai-row-85', b, '2027-01-01T16:59:59.999Z'], [null, b, '2027-01-01T17:00:00Z']]) await recordAnalyticsView(db, event(id, visit), { now: time });
  const days = await report(db, { from: '2026-12-31', to: '2027-01-02', bucket: 'day' });
  assert.deepEqual(days.summary, { page_views: 4, product_views: 2, visits: 2 });
  assert.deepEqual(days.timeline.map(row => [row.period, row.views, row.visits]), [['2026-12-31', 1, 1], ['2027-01-01', 2, 2], ['2027-01-02', 1, 1]]);
  assert.equal(days.rows.length, 1);
  assert.equal(days.rows[0].name, 'Blue Ressha');
  assert.equal(days.rows[0].views, 2);
  const units = await report(db, { from: '2026-12-31', to: '2027-01-02', group: 'units', search: 'mon 02' });
  assert.equal(units.total_rows, 1);
  assert.equal(units.rows[0].product_id, 'sentai-row-85');
  assert.equal(units.summary.page_views, 4);
  const months = await report(db, { from: '2026-12-01', to: '2027-02-28', bucket: 'month' });
  assert.deepEqual(months.timeline.map(row => row.views), [1, 3, 0]);
  const years = await report(db, { from: '2025-01-01', to: '2027-12-31', bucket: 'year' });
  assert.deepEqual(years.timeline.map(row => row.views), [0, 1, 3]);
  const names = await report(db, { from: '2026-12-31', to: '2027-01-02', group: 'units', sort: 'name', direction: 'desc', limit: '1', offset: '1' });
  assert.equal(names.total_rows, 2);
  assert.equal(names.rows[0].product_id, 'sentai-row-84');
  assert.equal((await report(db, { from: '2026-12-31', to: '2027-01-02', search: "' OR 1=1 --" })).total_rows, 0);
});

test('D1 analytics rejects bad filters and honors privacy headers before any database write', async t => {
  const { db, sqlite } = fixture(t);
  for (const filters of [{ from: '2026-02-30' }, { sort: 'views;DELETE' }, { group: 'orders' }, { bucket: 'week' }, { limit: '101' }, { direction: 'up' }, { offset: '-1' }, { from: '2000-01-01', to: '2026-11-01' }]) await assert.rejects(report(db, filters), status(400));
  for (const headers of [{ dnt: '1' }, { 'sec-gpc': '1' }, { 'user-agent': 'Googlebot' }, { 'user-agent': 'facebookexternalhit/1.1' }]) {
    const req = request('/api/analytics/view', event(), headers);
    const response = await handleAnalytics(req, { DB: db }, new URL(req.url));
    assert.equal(response.status, 202);
    assert.deepEqual(await response.json(), { accepted: false });
  }
  assert.equal(sqlite.prepare('SELECT count(*) n FROM analytics_views').get().n, 0);
  const req = request('/api/analytics/view', event());
  assert.equal((await handleAnalytics(req, { DB: db }, new URL(req.url))).status, 202);
  assert.equal(sqlite.prepare('SELECT count(*) n FROM analytics_views').get().n, 1);
  assert.equal(await handleAnalytics(new Request('https://shop.example/api/orders'), { DB: db }, new URL('https://shop.example/api/orders')), null);
});

test('D1 price sources enforce URL ownership, case-insensitive deduplication and concurrent capacity', async t => {
  const { db, sqlite } = fixture(t);
  assert.equal(canonicalGroupURL('https://m.facebook.com/groups/Sentai?ref=share'), 'https://www.facebook.com/groups/Sentai/');
  assert.equal(canonicalPostURL('https://facebook.com/groups/sentai/permalink/123/', 'https://www.facebook.com/groups/Sentai/'), 'https://www.facebook.com/groups/Sentai/posts/123/');
  for (const url of ['https://facebook.com.evil/groups/123/', 'http://facebook.com/groups/123/', 'https://user:pass@facebook.com/groups/123/', 'https://facebook.com/groups/feed/']) assert.throws(() => canonicalGroupURL(url), status(400));
  assert.throws(() => canonicalPostURL('https://facebook.com/groups/other/posts/1', 'https://facebook.com/groups/Sentai/'), status(400));
  const groups = await Promise.all([addGroup(db, { name: 'Sentai', url: 'https://facebook.com/groups/Sentai/' }), addGroup(db, { name: 'Sentai 2', url: 'https://facebook.com/groups/sentai/' })]);
  assert.equal(groups[0].group.id, groups[1].group.id);
  assert.equal(sqlite.prepare('SELECT count(*) n FROM price_groups').get().n, 1);
  const results = await Promise.allSettled(Array.from({ length: 31 }, (_, i) => addGroup(db, { name: `Nhóm ${i}`, url: `https://facebook.com/groups/group${i}/` })));
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 29);
  assert.equal(sqlite.prepare('SELECT count(*) n FROM price_groups WHERE active=1').get().n, 30);
  await disable(db, 'groups', groups[0].group.id);
  await addGroup(db, { name: 'Mới', url: 'https://facebook.com/groups/newgroup/' });
  await assert.rejects(addGroup(db, { name: 'Kích hoạt', url: 'https://facebook.com/groups/Sentai/' }), status(400));
});

test('D1 price keywords cannot rebind evidence and concurrent adds respect the 200-keyword cap', async t => {
  const { db, sqlite } = fixture(t);
  const keyword = await addKeyword(db, { keyword: 'Blue Ressha', product_id: 'sentai-row-84' });
  await assert.rejects(addKeyword(db, { keyword: 'blue ressha', product_id: 'sentai-row-85' }), status(409));
  const readded = await addKeyword(db, { keyword: 'BLUE RESSHA', product_id: 'sentai-row-84' });
  assert.equal(readded.keyword.id, keyword.keyword.id);
  const results = await Promise.allSettled(Array.from({ length: 201 }, (_, i) => addKeyword(db, { keyword: `Model ${i}` })));
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 199);
  assert.equal(sqlite.prepare('SELECT count(*) n FROM price_keywords WHERE active=1').get().n, 200);
  await assert.rejects(addKeyword(db, { keyword: 'Missing', product_id: 'missing' }), status(400));
});

test('D1 manual price imports preserve evidence/history, deduplicate races and never overwrite sale prices', async t => {
  const { db, sqlite } = fixture(t);
  const { group } = await addGroup(db, { name: 'Sentai', url: 'https://www.facebook.com/groups/123/' });
  const { keyword } = await addKeyword(db, { keyword: 'Blue Ressha', product_id: 'sentai-row-84' });
  const before = sqlite.prepare('SELECT price_vnd FROM products WHERE id=?').get('sentai-row-84').price_vnd;
  const post = { group_id: group.id, keyword_id: keyword.id, post_url: 'https://www.facebook.com/groups/123/posts/456/', text: 'Bán Blue Ressha giá 850k, đủ đồ đẹp.' };
  const imports = await Promise.all([importPost(db, post), importPost(db, post)]);
  assert.equal(imports[0].observation.id, imports[1].observation.id);
  assert.equal(imports[0].observation.price_vnd, 850000);
  assert.equal('content_hash' in imports[0].observation, false);
  assert.ok(Array.isArray(imports[0].observation.candidates));
  await review(db, imports[0].observation.id, { review_status: 'accepted' });
  assert.equal((await importPost(db, post)).observation.review_status, 'accepted');
  const revised = await importPost(db, { ...post, text: 'Bán Blue Ressha giá 800k, đủ đồ đẹp.' });
  assert.notEqual(revised.observation.id, imports[0].observation.id);
  assert.equal(revised.observation.price_vnd, 800000);
  await assert.rejects(importPost(db, { ...post, post_url: 'https://www.facebook.com/groups/other/posts/456/' }), status(400));
  await assert.rejects(importPost(db, { ...post, text: 'Bán mẫu khác 200k.' }), status(400));
  assert.equal(sqlite.prepare('SELECT price_vnd FROM products WHERE id=?').get('sentai-row-84').price_vnd, before);
  await disable(db, 'groups', group.id);
  const data = await snapshot(db);
  assert.equal(data.groups.length, 0);
  assert.equal(data.observation_total, 2);
  assert.equal(data.observations.length, 2);
  assert.equal(data.collector.available, false);
  assert.equal(data.collector.local_only, true);
  await assert.rejects(importPost(db, post), status(404));
});

test('Cloudflare collector operations report local-only capability and never create fake scans', async t => {
  const { db, sqlite } = fixture(t);
  for (const path of ['/api/admin/prices/scans', '/api/admin/prices/login']) {
    const req = request(path, {});
    await assert.rejects(handlePrices(req, { DB: db }, new URL(req.url)), status(501));
  }
  assert.equal(sqlite.prepare('SELECT count(*) n FROM price_scans').get().n, 0);
  const req = new Request('https://shop.example/api/admin/prices');
  const response = await handlePrices(req, { DB: db }, new URL(req.url));
  assert.equal(response.status, 200);
  assert.equal((await response.json()).collector.available, false);
  assert.equal(await handlePrices(new Request('https://shop.example/api/prices'), { DB: db }, new URL('https://shop.example/api/prices')), null);
});
