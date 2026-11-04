import { spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { ROOT } from './database.mjs';
import { analyzePost, normalizeKeyword } from './price-parser.mjs';

export class PriceError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const fail = (status, message) => { throw new PriceError(status, message); };
const field = (value, label, min, max) => {
  if (typeof value !== 'string' || value.trim().length < min || value.trim().length > max) fail(400, `${label} cần từ ${min} đến ${max} ký tự.`);
  return value.trim();
};
const facebookHosts = new Set(['facebook.com', 'www.facebook.com', 'm.facebook.com', 'web.facebook.com']);
function facebookURL(input) {
  let url;
  try { url = new URL(field(input, 'Link Facebook', 10, 1500)); } catch (error) { if (error instanceof PriceError) throw error; fail(400, 'Link Facebook không hợp lệ.'); }
  if (url.protocol !== 'https:' || !facebookHosts.has(url.hostname) || url.port || url.username || url.password) fail(400, 'Dùng link https://www.facebook.com/groups/...');
  return url;
}
export function canonicalGroupURL(input) {
  const url = facebookURL(input);
  const match = url.pathname.match(/^\/groups\/([A-Za-z0-9._-]{1,120})\/?$/);
  if (!match || ['feed','discover','create','joins','search'].includes(match[1].toLowerCase())) fail(400, 'Dán link trang nhóm, dạng https://www.facebook.com/groups/ten-hoac-id/');
  return `https://www.facebook.com/groups/${match[1]}/`;
}
export function canonicalPostURL(input, groupURL) {
  const url = facebookURL(input);
  const group = new URL(groupURL).pathname.split('/')[2];
  const match = url.pathname.match(/^\/groups\/([A-Za-z0-9._-]+)\/(?:posts|permalink)\/([A-Za-z0-9_-]{1,200})\/?$/);
  if (match && match[1].toLowerCase() === group.toLowerCase()) return `https://www.facebook.com/groups/${group}/posts/${match[2]}/`;
  if (url.pathname === '/permalink.php' && url.searchParams.get('id') === group && /^[A-Za-z0-9_-]{1,200}$/.test(url.searchParams.get('story_fbid') || '')) {
    return `https://www.facebook.com/groups/${group}/posts/${url.searchParams.get('story_fbid')}/`;
  }
  fail(400, 'Link bài phải thuộc đúng nhóm đã chọn, dạng /groups/.../posts/...');
}

async function killTree(proc) {
  if (!proc?.pid || proc.exitCode !== null) return;
  if (process.platform !== 'win32') {
    try { process.kill(-proc.pid, 'SIGKILL'); } catch { proc.kill('SIGKILL'); }
    return;
  }
  await new Promise(accept => {
    const killer = spawn('taskkill', ['/pid', String(proc.pid), '/t', '/f'], { shell: false, windowsHide: true, stdio: 'ignore' });
    killer.once('error', () => { proc.kill(); accept(); });
    killer.once('close', accept);
  });
}

export function createPriceService({ db, directory, python, runner }) {
  const localPython = resolve(ROOT, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  python ||= process.env.PYTHON_PATH || (existsSync(localPython) ? localPython : 'python');
  const profile = resolve(directory, 'facebook-profile');
  const worker = resolve(ROOT, 'scripts/collect_group_posts.py');
  let closed = false, processing = false, loginOpen = false, loginTask = null, workTask = null;
  let capability = null, checkedAt = 0, checking = null;
  let lastMessage = 'Đăng nhập Facebook trên máy này, đóng cửa sổ đăng nhập rồi chọn quét.';
  const children = new Set();
  db.prepare("UPDATE price_scans SET status='failed',error=?,finished_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE status IN ('queued','running')")
    .run('Lượt quét bị gián đoạn khi máy chủ dừng. Chọn quét lại để tiếp tục.');

  function execute(args, { timeout = 150000, onLine } = {}) {
    if (runner) return runner(args, { timeout, onLine });
    return new Promise((accept, reject) => {
      const proc = spawn(python, [worker, ...args], { cwd: ROOT, shell: false, windowsHide: true, detached: process.platform !== 'win32',
        env: { ...process.env, PYTHONIOENCODING: 'utf-8' }, stdio: ['ignore', 'pipe', 'pipe'] });
      children.add(proc);
      let output = '', lineBuffer = '', length = 0, failure = null, termination;
      const stop = () => termination ||= killTree(proc);
      const timer = setTimeout(() => { failure = new PriceError(504, 'Hết thời gian chờ. Kiểm tra cửa sổ đăng nhập và thử lại.'); void stop(); }, timeout);
      proc.stdout.setEncoding('utf8');
      proc.stdout.on('data', chunk => {
        length += Buffer.byteLength(chunk);
        if (length > 4 * 1024 * 1024) { failure = new PriceError(502, 'Kết quả vượt giới hạn cho một lượt quét.'); void stop(); return; }
        output += chunk;
        if (onLine) {
          lineBuffer += chunk;
          const lines = lineBuffer.split('\n'); lineBuffer = lines.pop();
          for (const line of lines) { try { onLine(JSON.parse(line)); } catch { /* Ignore non-protocol lines, never disclose process diagnostics. */ } }
        }
      });
      // Diagnostics may contain private page URLs; never return them to a public response or log.
      proc.stderr.resume();
      proc.once('error', () => { failure = new PriceError(503, 'Chưa chạy được bộ đọc nhóm. Chạy npm run prices:setup trên máy chủ.'); });
      proc.once('close', async code => {
        clearTimeout(timer); if (termination) await termination; children.delete(proc);
        if (failure) return reject(failure);
        const lines = output.trim().split('\n').filter(Boolean);
        let result; try { result = JSON.parse(lines.at(-1) || '{}'); } catch { return reject(new PriceError(502, 'Bộ đọc nhóm chưa trả về kết quả hợp lệ.')); }
        if (code !== 0 && !result.status) return reject(new PriceError(503, 'Bộ đọc nhóm chưa sẵn sàng. Chạy npm run prices:setup và thử lại.'));
        accept(result);
      });
    });
  }
  async function checkCollector() {
    if (capability && Date.now() - checkedAt < 30000) return capability;
    if (checking) return checking;
    checking = execute(['--check'], { timeout: 20000 }).then(result => {
      capability = { available: result.available === true, message: String(result.message || '').slice(0,500) };
      return capability;
    }).catch(() => capability = { available: false, message: 'Chạy npm run prices:setup để cài bộ đọc nhóm.' }).finally(() => { checkedAt = Date.now(); checking = null; });
    return checking;
  }
  const activeGroup = id => {
    const group = typeof id === 'string' && db.prepare('SELECT * FROM price_groups WHERE id=? AND active=1').get(id);
    if (!group) fail(404, 'Không tìm thấy nhóm đang theo dõi.');
    return group;
  };
  const activeKeyword = id => {
    const keyword = typeof id === 'string' && db.prepare('SELECT * FROM price_keywords WHERE id=? AND active=1').get(id);
    if (!keyword) fail(404, 'Không tìm thấy từ khóa đang theo dõi.');
    return keyword;
  };
  function addGroup(body) {
    const name = field(body.name, 'Tên nhóm', 1, 120), url = canonicalGroupURL(body.url);
    const existing = db.prepare('SELECT id,active FROM price_groups WHERE url=? COLLATE NOCASE').get(url);
    if (!existing?.active && db.prepare('SELECT count(*) n FROM price_groups WHERE active=1').get().n >= 30) fail(400, 'Tối đa 30 nhóm đang theo dõi.');
    const id = existing?.id || randomUUID();
    if (existing) db.prepare('UPDATE price_groups SET name=?,active=1 WHERE id=?').run(name,id);
    else db.prepare('INSERT INTO price_groups(id,name,url) VALUES(?,?,?)').run(id,name,url);
    return { group: activeGroup(id) };
  }
  function addKeyword(body) {
    const keyword = field(body.keyword, 'Từ khóa', 2, 120), normalized = normalizeKeyword(keyword);
    if (normalized.length < 2 || !/[\p{L}\p{N}]/u.test(normalized) || /[\u0000-\u001f\u007f]/.test(keyword)) fail(400, 'Từ khóa cần chứa tên hoặc mã sản phẩm trên một dòng.');
    const productId = body.product_id || null;
    if (productId !== null && (typeof productId !== 'string' || !db.prepare('SELECT id FROM products WHERE id=? AND active=1').get(productId))) fail(400, 'Sản phẩm không hợp lệ.');
    const existing = db.prepare('SELECT id,product_id,active FROM price_keywords WHERE normalized=?').get(normalized);
    if (existing && existing.product_id !== productId) fail(409, 'Từ khóa này đã gắn với lựa chọn sản phẩm khác. Dùng từ khóa cụ thể hơn để giữ đúng lịch sử.');
    if (!existing?.active && db.prepare('SELECT count(*) n FROM price_keywords WHERE active=1').get().n >= 200) fail(400, 'Tối đa 200 từ khóa đang theo dõi.');
    const id = existing?.id || randomUUID();
    if (existing) db.prepare('UPDATE price_keywords SET active=1 WHERE id=?').run(id);
    else db.prepare('INSERT INTO price_keywords(id,keyword,normalized,product_id) VALUES(?,?,?,?)').run(id,keyword,normalized,productId);
    return { keyword: activeKeyword(id) };
  }
  function disable(kind, id) {
    const table = kind === 'groups' ? 'price_groups' : 'price_keywords';
    (kind === 'groups' ? activeGroup : activeKeyword)(id);
    db.prepare(`UPDATE ${table} SET active=0 WHERE id=?`).run(id);
    // Retain evidence and past scans; cancel queued jobs that no longer have an active source.
    const column = kind === 'groups' ? 'group_id' : 'keyword_id';
    db.prepare(`UPDATE price_scans SET status='failed',error=?,finished_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE ${column}=? AND status='queued'`).run('Đã ngừng theo dõi nguồn hoặc từ khóa này.',id);
    return { ok: true };
  }
  function observationRow(row) {
    if (!row) return null;
    const { content_hash, ...safe } = row;
    return { ...safe, candidates: JSON.parse(row.candidates), flags: JSON.parse(row.flags) };
  }
  const getObservation = id => observationRow(db.prepare(`SELECT o.*,g.name group_name,k.keyword,p.name product_name FROM price_observations o
    JOIN price_groups g ON g.id=o.group_id JOIN price_keywords k ON k.id=o.keyword_id LEFT JOIN products p ON p.id=o.product_id WHERE o.id=?`).get(id));
  function storePost(group, keyword, post, scanId = null) {
    const text = field(post.text, 'Nội dung bài', 1, 12000);
    const postURL = canonicalPostURL(post.url ?? post.post_url, group.url);
    const parsed = analyzePost(text, keyword.keyword);
    if (!parsed.matched) return null;
    if (post.text_source === 'article') parsed.flags = [...new Set([...parsed.flags,'article_text','needs_review'])];
    if (post.text_truncated === true) { parsed.flags = [...new Set([...parsed.flags,'truncated','needs_review'])]; parsed.price_vnd = null; }
    const publishedText = typeof post.published_text === 'string' ? post.published_text.slice(0,120) : '';
    const publishedAt = typeof post.published_at === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(post.published_at) && Number.isFinite(Date.parse(post.published_at)) ? new Date(post.published_at).toISOString() : null;
    const hash = createHash('sha256').update(text).digest('hex');
    const previous = db.prepare('SELECT id FROM price_observations WHERE group_id=? AND keyword_id=? AND post_url=? AND content_hash=?').get(group.id,keyword.id,postURL,hash);
    if (previous) {
      db.prepare("UPDATE price_observations SET last_seen_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?").run(previous.id);
      return getObservation(previous.id);
    }
    const id = randomUUID();
    db.prepare(`INSERT INTO price_observations(id,group_id,keyword_id,product_id,scan_id,post_url,text,content_hash,price_vnd,candidates,flags,condition,published_text,published_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id,group.id,keyword.id,keyword.product_id,scanId,postURL,text,hash,parsed.price_vnd,
        JSON.stringify(parsed.candidates),JSON.stringify(parsed.flags),parsed.condition,publishedText,publishedAt);
    return getObservation(id);
  }
  function importPost(body) {
    const group = activeGroup(body.group_id), keyword = activeKeyword(body.keyword_id);
    const observation = storePost(group,keyword,body);
    if (!observation) fail(400, 'Nội dung bài chưa chứa đủ các từ trong từ khóa đã chọn.');
    return { observation };
  }
  function review(id, body) {
    if (!getObservation(id)) fail(404, 'Không tìm thấy giá tham khảo.');
    if (!['pending','accepted','ignored'].includes(body.review_status)) fail(400, 'Trạng thái kiểm tra không hợp lệ.');
    db.prepare('UPDATE price_observations SET review_status=? WHERE id=?').run(body.review_status,id);
    return { observation: getObservation(id) };
  }
  async function runQueue() {
    if (closed || processing || loginOpen) return;
    processing = true;
    try {
      while (!closed && !loginOpen) {
        const job = db.prepare("SELECT * FROM price_scans WHERE status='queued' ORDER BY created_at,rowid LIMIT 1").get();
        if (!job) break;
        db.prepare("UPDATE price_scans SET status='running',started_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?").run(job.id);
        try {
          const group = activeGroup(job.group_id), keyword = activeKeyword(job.keyword_id);
          mkdirSync(profile, { recursive: true });
          const result = await execute(['--scan','--profile',profile,'--group',group.url,'--keyword',keyword.keyword,'--max-posts',String(job.max_posts)]);
          if (closed) break;
          if (!['completed','partial','needs_login','failed'].includes(result.status) || !Array.isArray(result.posts)) throw new PriceError(502, 'Bộ đọc trả về dữ liệu không hợp lệ.');
          let postCount = 0, skipped = 0;
          for (const post of result.posts.slice(0,job.max_posts)) {
            try { if (post && storePost(group,keyword,post,job.id)) postCount++; }
            catch (error) { if (error instanceof PriceError) skipped++; else throw error; }
          }
          const status = skipped && result.status === 'completed' ? 'partial' : result.status;
          const message = String(result.message || '').slice(0,600) + (skipped ? ` Bỏ qua ${skipped} bài có link hoặc nội dung không hợp lệ.` : '');
          db.prepare("UPDATE price_scans SET status=?,post_count=?,scanned_count=?,error=?,finished_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?")
            .run(status,postCount,Number.isInteger(result.scanned_count) ? Math.max(0,Math.min(result.scanned_count,10000)) : result.posts.length,message,job.id);
          if (status === 'needs_login') {
            db.prepare("UPDATE price_scans SET status='needs_login',error=?,finished_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE status='queued'")
              .run('Cần đăng nhập Facebook trên máy này, sau đó tạo lượt quét mới.');
            break;
          }
        } catch (error) {
          if (closed) break;
          db.prepare("UPDATE price_scans SET status='failed',error=?,finished_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?")
            .run(error instanceof PriceError ? error.message : 'Không hoàn tất lượt quét. Hãy thử lại sau.',job.id);
        }
      }
    } finally { processing = false; }
  }
  async function enqueue(body, assertAuthorized = () => {}) {
    assertAuthorized();
    if (closed) fail(503, 'Máy chủ đang dừng.');
    if (loginOpen) fail(409, 'Đóng cửa sổ đăng nhập Facebook trước khi quét.');
    if (!(await checkCollector()).available) fail(503, 'Chạy npm run prices:setup để cài bộ đọc nhóm.');
    assertAuthorized();
    if (closed || loginOpen) fail(409, 'Đóng cửa sổ đăng nhập Facebook trước khi quét.');
    const keyword = activeKeyword(body.keyword_id);
    if (!Array.isArray(body.group_ids) || body.group_ids.length < 1 || body.group_ids.length > 3 || new Set(body.group_ids).size !== body.group_ids.length) fail(400, 'Chọn từ 1 đến 3 nhóm khác nhau cho một lượt.');
    const groups = body.group_ids.map(activeGroup);
    const maxPosts = body.max_posts ?? 20;
    if (!Number.isInteger(maxPosts) || maxPosts < 1 || maxPosts > 50) fail(400, 'Giới hạn từ 1 đến 50 bài cho mỗi nhóm.');
    if (db.prepare("SELECT count(*) n FROM price_scans WHERE status IN ('queued','running')").get().n + groups.length > 6) fail(409, 'Hàng đợi đã đủ 6 lượt. Chờ quét xong rồi thử lại.');
    for (const group of groups) if (db.prepare("SELECT id FROM price_scans WHERE group_id=? AND keyword_id=? AND status IN ('queued','running')").get(group.id,keyword.id)) fail(409, 'Nhóm và từ khóa này đã có lượt quét đang chờ.');
    const scans = groups.map(group => ({ id: randomUUID(), group_id:group.id, keyword_id:keyword.id, max_posts:maxPosts, status:'queued' }));
    db.exec('BEGIN IMMEDIATE');
    try {
      for (const scan of scans) db.prepare("INSERT INTO price_scans(id,group_id,keyword_id,max_posts,status) VALUES(?,?,?,?,'queued')").run(scan.id,scan.group_id,scan.keyword_id,scan.max_posts);
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
    if (!processing) workTask = runQueue();
    return { scans };
  }
  async function login(assertAuthorized = () => {}) {
    assertAuthorized();
    if (closed) fail(503, 'Máy chủ đang dừng.');
    if (loginOpen || processing) fail(409, 'Đang có cửa sổ đăng nhập hoặc lượt quét. Chờ hoàn tất rồi thử lại.');
    if (!(await checkCollector()).available) fail(503, 'Chạy npm run prices:setup trước khi đăng nhập Facebook.');
    assertAuthorized();
    // Recheck after asynchronous capability detection to prevent two owners of the browser profile.
    if (loginOpen || processing || closed) fail(409, 'Bộ đọc nhóm đang bận.');
    mkdirSync(profile, { recursive: true });
    loginOpen = true;
    lastMessage = 'Đang mở cửa sổ Facebook trên máy chủ. Đăng nhập, rồi đóng cửa sổ đó trước khi quét.';
    loginTask = execute(['--login','--profile',profile], { timeout:30*60*1000, onLine:event => {
      if (event.type === 'login_open') lastMessage = 'Cửa sổ Facebook đã mở trên máy này. Đăng nhập xong hãy đóng cửa sổ để bắt đầu quét.';
    } }).then(result => {
      lastMessage = result.status === 'failed' ? String(result.message || 'Không mở được Facebook.').slice(0,500) : 'Cửa sổ Facebook đã đóng. Chọn nhóm và từ khóa để thử quét.';
    }).catch(error => { lastMessage = error instanceof PriceError ? error.message : 'Không mở được cửa sổ đăng nhập.'; })
      .finally(() => { loginOpen = false; });
    return { ok: true, message:lastMessage };
  }
  async function snapshot() {
    const status = await checkCollector();
    const groups = db.prepare('SELECT * FROM price_groups WHERE active=1 ORDER BY created_at,id').all();
    const keywords = db.prepare('SELECT k.*,p.name product_name FROM price_keywords k LEFT JOIN products p ON p.id=k.product_id WHERE k.active=1 ORDER BY k.created_at,k.id').all();
    const scans = db.prepare(`SELECT s.*,g.name group_name,k.keyword FROM price_scans s JOIN price_groups g ON g.id=s.group_id JOIN price_keywords k ON k.id=s.keyword_id ORDER BY s.created_at DESC,s.rowid DESC LIMIT 50`).all();
    const observations = db.prepare(`SELECT o.*,g.name group_name,k.keyword,p.name product_name FROM price_observations o
      JOIN price_groups g ON g.id=o.group_id JOIN price_keywords k ON k.id=o.keyword_id LEFT JOIN products p ON p.id=o.product_id ORDER BY o.fetched_at DESC,o.rowid DESC LIMIT 200`).all().map(observationRow);
    return { groups,keywords,scans,observations,observation_total:db.prepare('SELECT count(*) n FROM price_observations').get().n,
      collector:{ ...status,busy:processing,login_open:loginOpen,message:status.available ? lastMessage : status.message },limits:{max_posts:50,max_groups_per_scan:3,observations:200} };
  }
  let closing;
  function close() {
    if (closing) return closing;
    closed = true;
    closing = (async () => {
      await Promise.allSettled([...children].map(killTree));
      await Promise.allSettled([workTask,loginTask,checking].filter(Boolean));
      db.prepare("UPDATE price_scans SET status='failed',error=?,finished_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE status IN ('queued','running')")
        .run('Máy chủ đã dừng. Chọn quét lại để tiếp tục.');
    })();
    return closing;
  }
  return { snapshot,addGroup,addKeyword,disable,enqueue,login,importPost,review,close };
}
