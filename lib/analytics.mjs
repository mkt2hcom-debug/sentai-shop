const DAY = 86400000;
const VN_OFFSET = 7 * 60 * 60 * 1000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ID = /^[a-zA-Z0-9_-]{1,100}$/;
const normalize = value => String(value).normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/gi, 'd').toLocaleLowerCase('vi');
const collator = new Intl.Collator('vi', {numeric:true, sensitivity:'base'});

export class AnalyticsError extends Error {
  constructor(status, message) { super(message); this.name = 'AnalyticsError'; this.status = status; }
}
const fail = (status, message) => { throw new AnalyticsError(status, message); };
const timestamp = now => {
  const date = new Date(now ?? Date.now());
  if (!Number.isFinite(date.getTime())) throw new TypeError('Invalid analytics clock.');
  return date.toISOString();
};

export function ensureAnalytics(db, {now} = {}) {
  db.prepare('INSERT OR IGNORE INTO analytics_meta(id,started_at) VALUES(1,?)').run(timestamp(now));
  return db.prepare('SELECT started_at FROM analytics_meta WHERE id=1').get().started_at;
}

function validateEvent(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) fail(400, 'Lượt xem không hợp lệ.');
  if (Object.keys(body).some(key => !['event_id','visit_id','page_type','product_id'].includes(key))) fail(400, 'Lượt xem chứa thông tin không được hỗ trợ.');
  if (typeof body.event_id !== 'string' || !UUID.test(body.event_id) || typeof body.visit_id !== 'string' || !UUID.test(body.visit_id)) fail(400, 'Mã lượt xem hoặc phiên truy cập không hợp lệ.');
  if (!['home','product'].includes(body.page_type)) fail(400, 'Trang không hỗ trợ thống kê.');
  if (body.page_type === 'home' && body.product_id != null) fail(400, 'Trang chủ không có lựa chọn sản phẩm.');
  if (body.page_type === 'product' && (typeof body.product_id !== 'string' || !ID.test(body.product_id))) fail(400, 'Sản phẩm không hợp lệ.');
  return {event_id:body.event_id.toLowerCase(),visit_id:body.visit_id.toLowerCase(),page_type:body.page_type,product_id:body.page_type === 'product' ? body.product_id : null};
}

export function recordAnalyticsView(db, body, {now} = {}) {
  const event = validateEvent(body);
  const getExisting = db.prepare('SELECT visit_id,page_type,product_id FROM analytics_views WHERE event_id=?');
  const repeated = existing => {
    if (existing.visit_id !== event.visit_id || existing.page_type !== event.page_type || existing.product_id !== event.product_id) fail(409, 'Mã lượt xem đã được dùng cho dữ liệu khác.');
    return {accepted:true,repeated:true};
  };
  const existing = getExisting.get(event.event_id);
  if (existing) return repeated(existing);
  let family = null, name = 'Trang chủ', path = '/', label = '';
  if (event.page_type === 'product') {
    const product = db.prepare(`SELECT u.family_id,u.unit_label,f.name FROM products p
      JOIN product_units u ON u.product_id=p.id JOIN product_families f ON f.id=u.family_id
      WHERE p.id=? AND p.active=1`).get(event.product_id);
    if (!product) fail(404, 'Không tìm thấy sản phẩm để ghi nhận lượt xem.');
    family = product.family_id; name = product.name; label = product.unit_label;
    path = `/products/${family}`;
  }
  const result = db.prepare(`INSERT INTO analytics_views(event_id,visit_id,page_type,path,family_id,product_id,name,unit_label,created_at)
    VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(event_id) DO NOTHING`)
    .run(event.event_id,event.visit_id,event.page_type,path,family,event.product_id,name,label,timestamp(now));
  if (!result.changes) return repeated(getExisting.get(event.event_id));
  return {accepted:true,repeated:false};
}

function dateValue(value, label) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) fail(400, `${label} cần có dạng YYYY-MM-DD.`);
  const number = Date.parse(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(number) || new Date(number).toISOString().slice(0,10) !== value || Number(value.slice(0,4)) < 1970 || Number(value.slice(0,4)) > 9998) fail(400, `${label} không hợp lệ.`);
  return number;
}
const dayText = value => new Date(value).toISOString().slice(0,10);
function enumeration(params, key, allowed, fallback) {
  const value = params.get(key) ?? fallback;
  if (!allowed.includes(value)) fail(400, `Bộ lọc ${key} không hợp lệ.`);
  return value;
}
function integer(params, key, min, max, fallback) {
  const value = params.get(key);
  if (value == null) return fallback;
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < min || Number(value) > max) fail(400, `Bộ lọc ${key} cần nằm trong khoảng ${min}–${max}.`);
  return Number(value);
}
function filtersFrom(params, now) {
  if (!(params instanceof URLSearchParams)) throw new TypeError('Analytics filters must be URLSearchParams.');
  const today = dayText(Date.parse(timestamp(now)) + VN_OFFSET);
  const to = params.get('to') ?? today;
  const toDay = dateValue(to, 'Ngày kết thúc');
  const from = params.get('from') ?? dayText(toDay - 29 * DAY);
  const fromDay = dateValue(from, 'Ngày bắt đầu');
  if (fromDay > toDay) fail(400, 'Ngày bắt đầu phải trước hoặc bằng ngày kết thúc.');
  if ((toDay - fromDay) / DAY + 1 > 3660) fail(400, 'Mỗi lần thống kê tối đa 3.660 ngày.');
  const sort = enumeration(params, 'sort', ['views','visits','last_view','name'], 'views');
  const search = (params.get('search') ?? '').trim();
  if (search.length > 100) fail(400, 'Từ khóa tìm kiếm tối đa 100 ký tự.');
  return {from,to,bucket:enumeration(params,'bucket',['day','month','year'],'day'),
    group:enumeration(params,'group',['pages','products','units'],'products'),sort,
    direction:enumeration(params,'direction',['asc','desc'],sort === 'name' ? 'asc' : 'desc'),search,
    limit:integer(params,'limit',1,100,20),offset:integer(params,'offset',0,1000000,0)};
}
function periods(from, to, bucket) {
  const result = [];
  let cursor = Date.parse(`${from}T00:00:00.000Z`);
  const end = Date.parse(`${to}T00:00:00.000Z`);
  if (bucket === 'month') cursor = Date.UTC(new Date(cursor).getUTCFullYear(),new Date(cursor).getUTCMonth(),1);
  if (bucket === 'year') cursor = Date.UTC(new Date(cursor).getUTCFullYear(),0,1);
  while (cursor <= end) {
    const date = new Date(cursor);
    result.push(date.toISOString().slice(0,bucket === 'day' ? 10 : bucket === 'month' ? 7 : 4));
    if (bucket === 'day') cursor += DAY;
    else if (bucket === 'month') cursor = Date.UTC(date.getUTCFullYear(),date.getUTCMonth()+1,1);
    else cursor = Date.UTC(date.getUTCFullYear()+1,0,1);
  }
  return result;
}

export function getAnalytics(db, params = new URLSearchParams(), {now} = {}) {
  const filters = filtersFrom(params, now);
  const start = new Date(Date.parse(`${filters.from}T00:00:00.000Z`) - VN_OFFSET).toISOString();
  const end = new Date(Date.parse(`${filters.to}T00:00:00.000Z`) + DAY - VN_OFFSET).toISOString();
  const where = 'created_at >= ? AND created_at < ?';
  const summary = db.prepare(`SELECT count(*) page_views,coalesce(sum(page_type='product'),0) product_views,count(DISTINCT visit_id) visits
    FROM analytics_views WHERE ${where}`).get(start,end);
  const pattern = {day:'%Y-%m-%d',month:'%Y-%m',year:'%Y'}[filters.bucket];
  const buckets = db.prepare(`SELECT strftime(?,created_at,'+7 hours') period,count(*) views,
    coalesce(sum(page_type='product'),0) product_views,count(DISTINCT visit_id) visits
    FROM analytics_views WHERE ${where} GROUP BY period ORDER BY period`).all(pattern,start,end);
  const byPeriod = new Map(buckets.map(row => [row.period,row]));
  const timeline = periods(filters.from,filters.to,filters.bucket).map(period => byPeriod.get(period) || {period,views:0,product_views:0,visits:0});
  // Only fixed identifiers enter SQL. Search/sorting happen over grouped rows,
  // so a query never accidentally changes the summary or per-row view totals.
  const groupKey = {pages:'path',products:'family_id',units:'product_id'}[filters.group];
  const typeFilter = filters.group === 'pages' ? '' : "AND page_type='product'";
  const grouped = db.prepare(`WITH ranked AS (
    SELECT *,${groupKey} group_key,row_number() OVER (PARTITION BY ${groupKey} ORDER BY created_at DESC,event_id DESC) recent
      FROM analytics_views WHERE ${where} ${typeFilter}
    ), totals AS (
      SELECT group_key,count(*) views,count(DISTINCT visit_id) visits,max(created_at) last_view FROM ranked GROUP BY group_key
    ) SELECT t.group_key id,t.views,t.visits,t.last_view,r.name,r.path,r.page_type,r.family_id,r.product_id,r.unit_label
      FROM totals t JOIN ranked r ON r.group_key=t.group_key AND r.recent=1`).all(start,end);
  let rows = grouped.map(row => ({id:row.id,name:filters.group === 'units' ? `${row.name} · ${row.unit_label}` : row.name,
    path:filters.group === 'units' ? `${row.path}?variant=${encodeURIComponent(row.product_id)}` : row.path,
    page_type:row.page_type,family_id:row.family_id,product_id:filters.group === 'units' ? row.product_id : null,
    views:row.views,visits:row.visits,last_view:row.last_view}));
  if (filters.search) {
    const search = normalize(filters.search);
    rows = rows.filter(row => normalize(`${row.name} ${row.id}`).includes(search));
  }
  const direction = filters.direction === 'asc' ? 1 : -1;
  rows.sort((a,b) => {
    const difference = ['views','visits'].includes(filters.sort) ? a[filters.sort] - b[filters.sort]
      : filters.sort === 'last_view' ? a.last_view.localeCompare(b.last_view) : collator.compare(a.name,b.name);
    return difference * direction || collator.compare(a.name,b.name) || a.id.localeCompare(b.id);
  });
  return {timezone:'Asia/Ho_Chi_Minh',started_at:db.prepare('SELECT started_at FROM analytics_meta WHERE id=1').get()?.started_at || null,
    filters,summary,timeline,rows:rows.slice(filters.offset,filters.offset+filters.limit),total_rows:rows.length};
}
