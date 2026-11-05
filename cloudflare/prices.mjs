import { HttpError, fail, textField, readJson, json, all, first, run } from './common.mjs';
import { analyzePost, normalizeKeyword } from '../lib/price-parser.mjs';

const field = (value, label, min, max) => textField(value, label, min, max);
const facebookHosts = new Set(['facebook.com', 'www.facebook.com', 'm.facebook.com', 'web.facebook.com']);
const LOCAL_COLLECTOR = 'Tìm bài tự động và đăng nhập Facebook chạy trên máy của bạn. Trên web này, chọn Lưu bài thủ công để lưu nội dung và giá tham khảo.';
function facebookURL(input) {
  let url;
  try { url = new URL(field(input, 'Link Facebook', 10, 1500)); }
  catch (error) { if (error instanceof HttpError) throw error; fail(400, 'Link Facebook không hợp lệ.'); }
  if (url.protocol !== 'https:' || !facebookHosts.has(url.hostname) || url.port || url.username || url.password) fail(400, 'Dùng link https://www.facebook.com/groups/...');
  return url;
}
export function canonicalGroupURL(input) {
  const url = facebookURL(input);
  const match = url.pathname.match(/^\/groups\/([A-Za-z0-9._-]{1,120})\/?$/);
  if (!match || ['feed', 'discover', 'create', 'joins', 'search'].includes(match[1].toLowerCase())) fail(400, 'Dán link trang nhóm, dạng https://www.facebook.com/groups/ten-hoac-id/');
  return `https://www.facebook.com/groups/${match[1]}/`;
}
export function canonicalPostURL(input, groupURL) {
  const url = facebookURL(input);
  const group = new URL(groupURL).pathname.split('/')[2];
  const match = url.pathname.match(/^\/groups\/([A-Za-z0-9._-]+)\/(?:posts|permalink)\/([A-Za-z0-9_-]{1,200})\/?$/);
  if (match && match[1].toLowerCase() === group.toLowerCase()) return `https://www.facebook.com/groups/${group}/posts/${match[2]}/`;
  if (url.pathname === '/permalink.php' && url.searchParams.get('id') === group && /^[A-Za-z0-9_-]{1,200}$/.test(url.searchParams.get('story_fbid') || '')) return `https://www.facebook.com/groups/${group}/posts/${url.searchParams.get('story_fbid')}/`;
  fail(400, 'Link bài phải thuộc đúng nhóm đã chọn, dạng /groups/.../posts/...');
}
async function activeGroup(db, id) {
  const group = typeof id === 'string' && await first(db, 'SELECT * FROM price_groups WHERE id=? AND active=1', id);
  if (!group) fail(404, 'Không tìm thấy nhóm đang theo dõi.');
  return group;
}
async function activeKeyword(db, id) {
  const keyword = typeof id === 'string' && await first(db, 'SELECT * FROM price_keywords WHERE id=? AND active=1', id);
  if (!keyword) fail(404, 'Không tìm thấy từ khóa đang theo dõi.');
  return keyword;
}
export async function addGroup(db, body) {
  const name = field(body.name, 'Tên nhóm', 1, 120), url = canonicalGroupURL(body.url);
  // The capacity and case-insensitive duplicate checks are performed by the
  // same write statement, so concurrent requests cannot exceed the group cap.
  await run(db, `INSERT INTO price_groups(id,name,url)
    SELECT ?,?,? WHERE (SELECT count(*) FROM price_groups WHERE active=1)<30
      AND NOT EXISTS(SELECT 1 FROM price_groups WHERE url=? COLLATE NOCASE)
    ON CONFLICT DO NOTHING`, crypto.randomUUID(), name, url, url);
  const existing = await first(db, 'SELECT id,active FROM price_groups WHERE url=? COLLATE NOCASE', url);
  if (!existing) fail(400, 'Tối đa 30 nhóm đang theo dõi.');
  const result = await run(db, `UPDATE price_groups SET name=?,active=1 WHERE id=?
    AND (active=1 OR (SELECT count(*) FROM price_groups WHERE active=1)<30)`, name, existing.id);
  if (!result.meta.changes) fail(400, 'Tối đa 30 nhóm đang theo dõi.');
  return { group: await activeGroup(db, existing.id) };
}
export async function addKeyword(db, body) {
  const keyword = field(body.keyword, 'Từ khóa', 2, 120), normalized = normalizeKeyword(keyword);
  if (normalized.length < 2 || !/[\p{L}\p{N}]/u.test(normalized) || /[\u0000-\u001f\u007f]/.test(keyword)) fail(400, 'Từ khóa cần chứa tên hoặc mã sản phẩm trên một dòng.');
  const productId = body.product_id || null;
  if (productId !== null && (typeof productId !== 'string' || !await first(db, 'SELECT id FROM products WHERE id=? AND active=1', productId))) fail(400, 'Sản phẩm không hợp lệ.');
  const before = await first(db, 'SELECT product_id FROM price_keywords WHERE normalized=?', normalized);
  if (before && before.product_id !== productId) fail(409, 'Từ khóa này đã gắn với lựa chọn sản phẩm khác. Dùng từ khóa cụ thể hơn để giữ đúng lịch sử.');
  await run(db, `INSERT INTO price_keywords(id,keyword,normalized,product_id)
    SELECT ?,?,?,? WHERE (SELECT count(*) FROM price_keywords WHERE active=1)<200
      AND (? IS NULL OR EXISTS(SELECT 1 FROM products WHERE id=? AND active=1))
    ON CONFLICT(normalized) DO NOTHING`, crypto.randomUUID(), keyword, normalized, productId, productId, productId);
  const existing = await first(db, 'SELECT id,product_id,active FROM price_keywords WHERE normalized=?', normalized);
  if (!existing) {
    if (productId !== null && !await first(db, 'SELECT id FROM products WHERE id=? AND active=1', productId)) fail(400, 'Sản phẩm không hợp lệ.');
    fail(400, 'Tối đa 200 từ khóa đang theo dõi.');
  }
  if (existing.product_id !== productId) fail(409, 'Từ khóa này đã gắn với lựa chọn sản phẩm khác. Dùng từ khóa cụ thể hơn để giữ đúng lịch sử.');
  const result = await run(db, `UPDATE price_keywords SET active=1 WHERE id=? AND product_id IS ?
    AND (active=1 OR (SELECT count(*) FROM price_keywords WHERE active=1)<200)`, existing.id, productId);
  if (!result.meta.changes) fail(400, 'Tối đa 200 từ khóa đang theo dõi.');
  return { keyword: await activeKeyword(db, existing.id) };
}
export async function disable(db, kind, id) {
  if (!['groups', 'keywords'].includes(kind)) fail(400, 'Nguồn theo dõi không hợp lệ.');
  const table = kind === 'groups' ? 'price_groups' : 'price_keywords';
  await (kind === 'groups' ? activeGroup : activeKeyword)(db, id);
  const column = kind === 'groups' ? 'group_id' : 'keyword_id';
  await db.batch([
    db.prepare(`UPDATE ${table} SET active=0 WHERE id=?`).bind(id),
    db.prepare(`UPDATE price_scans SET status='failed',error=?,finished_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE ${column}=? AND status='queued'`).bind('Đã ngừng theo dõi nguồn hoặc từ khóa này.', id),
  ]);
  return { ok: true };
}
function observationRow(row) {
  if (!row) return null;
  const { content_hash, ...safe } = row;
  return { ...safe, candidates: JSON.parse(row.candidates), flags: JSON.parse(row.flags) };
}
const observationJoin = `SELECT o.*,g.name group_name,k.keyword,p.name product_name FROM price_observations o
  JOIN price_groups g ON g.id=o.group_id JOIN price_keywords k ON k.id=o.keyword_id LEFT JOIN products p ON p.id=o.product_id`;
async function getObservation(db, id) {
  return observationRow(await first(db, `${observationJoin} WHERE o.id=?`, id));
}
export async function importPost(db, body) {
  const group = await activeGroup(db, body.group_id), keyword = await activeKeyword(db, body.keyword_id);
  const text = field(body.text, 'Nội dung bài', 1, 12000);
  const postURL = canonicalPostURL(body.url ?? body.post_url, group.url);
  const parsed = analyzePost(text, keyword.keyword);
  if (!parsed.matched) fail(400, 'Nội dung bài chưa chứa đủ các từ trong từ khóa đã chọn.');
  if (body.text_source === 'article') parsed.flags = [...new Set([...parsed.flags, 'article_text', 'needs_review'])];
  if (body.text_truncated === true) { parsed.flags = [...new Set([...parsed.flags, 'truncated', 'needs_review'])]; parsed.price_vnd = null; }
  const publishedText = typeof body.published_text === 'string' ? body.published_text.slice(0, 120) : '';
  const publishedAt = typeof body.published_at === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(body.published_at) && Number.isFinite(Date.parse(body.published_at)) ? new Date(body.published_at).toISOString() : null;
  const hashBytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
  const hash = Array.from(hashBytes, byte => byte.toString(16).padStart(2, '0')).join('');
  const inserted = await all(db, `INSERT INTO price_observations(id,group_id,keyword_id,product_id,scan_id,post_url,text,content_hash,price_vnd,candidates,flags,condition,published_text,published_at)
    SELECT ?,g.id,k.id,k.product_id,NULL,?,?,?,?,?,?,?,?,?
    FROM price_groups g CROSS JOIN price_keywords k WHERE g.id=? AND k.id=? AND g.active=1 AND k.active=1
    ON CONFLICT(group_id,keyword_id,post_url,content_hash)
      DO UPDATE SET last_seen_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') RETURNING id`,
  crypto.randomUUID(), postURL, text, hash, parsed.price_vnd, JSON.stringify(parsed.candidates), JSON.stringify(parsed.flags), parsed.condition, publishedText, publishedAt, group.id, keyword.id);
  if (!inserted.length) fail(409, 'Nhóm hoặc từ khóa đã ngừng theo dõi. Chọn lại nguồn để lưu bài.');
  return { observation: await getObservation(db, inserted[0].id) };
}
export async function review(db, id, body) {
  if (!['pending', 'accepted', 'ignored'].includes(body.review_status)) fail(400, 'Trạng thái kiểm tra không hợp lệ.');
  const result = await run(db, 'UPDATE price_observations SET review_status=? WHERE id=?', body.review_status, id);
  if (!result.meta.changes) fail(404, 'Không tìm thấy giá tham khảo.');
  return { observation: await getObservation(db, id) };
}
export async function snapshot(db) {
  const [groups, keywords, scans, observations, total] = await db.batch([
    db.prepare('SELECT * FROM price_groups WHERE active=1 ORDER BY created_at,id'),
    db.prepare('SELECT k.*,p.name product_name FROM price_keywords k LEFT JOIN products p ON p.id=k.product_id WHERE k.active=1 ORDER BY k.created_at,k.id'),
    db.prepare('SELECT s.*,g.name group_name,k.keyword FROM price_scans s JOIN price_groups g ON g.id=s.group_id JOIN price_keywords k ON k.id=s.keyword_id ORDER BY s.created_at DESC,s.rowid DESC LIMIT 50'),
    db.prepare(`${observationJoin} ORDER BY o.fetched_at DESC,o.rowid DESC LIMIT 200`),
    db.prepare('SELECT count(*) n FROM price_observations'),
  ]);
  return { groups: groups.results, keywords: keywords.results, scans: scans.results, observations: observations.results.map(observationRow), observation_total: total.results[0].n,
    collector: { available: false, busy: false, login_open: false, local_only: true, message: LOCAL_COLLECTOR },
    limits: { max_posts: 50, max_groups_per_scan: 3, observations: 200 } };
}

// The Worker router authenticates every /api/admin/* request and checks CSRF
// before this handler is invoked. Private research never has a public route.
export async function handlePrices(request, env, url) {
  const path = url.pathname;
  if (path === '/api/admin/prices' && request.method === 'GET') return json(await snapshot(env.DB));
  if (path === '/api/admin/prices/groups' && request.method === 'POST') return json(await addGroup(env.DB, await readJson(request)), 201);
  if (path === '/api/admin/prices/keywords' && request.method === 'POST') return json(await addKeyword(env.DB, await readJson(request)), 201);
  const sourceMatch = path.match(/^\/api\/admin\/prices\/(groups|keywords)\/([a-f0-9-]+)$/);
  if (sourceMatch && request.method === 'DELETE') return json(await disable(env.DB, sourceMatch[1], sourceMatch[2]));
  if (['/api/admin/prices/scans', '/api/admin/prices/login'].includes(path) && request.method === 'POST') fail(501, LOCAL_COLLECTOR);
  if (path === '/api/admin/prices/import' && request.method === 'POST') return json(await importPost(env.DB, await readJson(request)), 201);
  const observationMatch = path.match(/^\/api\/admin\/prices\/observations\/([a-f0-9-]+)$/);
  if (observationMatch && request.method === 'PATCH') return json(await review(env.DB, observationMatch[1], await readJson(request)));
  return null;
}
