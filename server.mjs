import http from 'node:http';
import { createReadStream, existsSync, statSync, realpathSync } from 'node:fs';
import { resolve, sep, extname, dirname } from 'node:path';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { ROOT, openDatabase, syncCatalog, ensureProductFamilies, getProducts, getProduct, getProductFamilies, getProductPage, getOrder, encryptOrderFields } from './lib/database.mjs';
import { createMediaService, MediaError } from './lib/media.mjs';
import { createPriceService, PriceError } from './lib/prices.mjs';
import { ensureAnalytics, recordAnalyticsView, getAnalytics, AnalyticsError } from './lib/analytics.mjs';
import { createAdminAuth, AdminAuthError } from './lib/admin-auth.mjs';
import { deploymentOrigin,validateTransport,securityHeaders,createSessionStore,ensureSecuritySchema,checkPersistentLoginRate,auditResponse,SecurityError } from './lib/security.mjs';

const PUBLIC = resolve(ROOT, 'public');
class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const fail = (status, message) => { throw new HttpError(status, message); };
const digest = value => createHash('sha256').update(value).digest();
const textField = (value, label, min, max) => {
  if (value == null && min === 0) return '';
  if (typeof value !== 'string' || value.trim().length < min || value.trim().length > max) fail(400, `${label} cần có từ ${min} đến ${max} ký tự.`);
  return value.trim();
};

async function readJson(req) {
  if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] || '')) fail(415, 'Yêu cầu dữ liệu JSON.');
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 65536) fail(413, 'Dữ liệu gửi lên quá lớn.');
    chunks.push(chunk);
  }
  try {
    const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!data || typeof data !== 'object' || Array.isArray(data)) fail(400, 'Dữ liệu không hợp lệ.');
    return data;
  } catch (error) {
    if (error instanceof HttpError) throw error;
    fail(400, 'Dữ liệu JSON không hợp lệ.');
  }
}

function normalizeOrder(body) {
  const c = body.customer;
  if (!c || typeof c !== 'object' || Array.isArray(c)) fail(400, 'Vui lòng điền thông tin nhận hàng.');
  const customer = {
    name: textField(c.name,'Họ tên',2,100),
    phone: textField(c.phone,'Số điện thoại',9,25),
    email: textField(c.email,'Email',0,254),
    address: textField(c.address,'Địa chỉ',10,500),
    note: textField(c.note,'Ghi chú',0,1000)
  };
  if (!/^[+\d\s().-]+$/.test(customer.phone) || !/^\d{9,15}$/.test(customer.phone.replace(/\D/g,''))) fail(400, 'Số điện thoại không hợp lệ.');
  if (customer.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(customer.email)) fail(400, 'Email không hợp lệ.');
  if (!Array.isArray(body.items) || body.items.length < 1 || body.items.length > 40) fail(400, 'Giỏ hàng cần có từ 1 đến 40 sản phẩm.');
  const seen = new Set();
  const items = body.items.map(item => {
    if (!item || typeof item.product_id !== 'string' || item.product_id.length > 100 || !Number.isInteger(item.quantity) || item.quantity < 1 || item.quantity > 20) fail(400, 'Số lượng sản phẩm phải là số nguyên từ 1 đến 20.');
    if (seen.has(item.product_id)) fail(400, 'Sản phẩm bị lặp trong giỏ hàng.');
    seen.add(item.product_id);
    return { product_id: item.product_id, quantity: item.quantity };
  }).sort((a,b)=>a.product_id.localeCompare(b.product_id));
  const idempotencyKey = textField(body.idempotency_key,'Mã yêu cầu',16,100);
  if (!/^[\w-]+$/.test(idempotencyKey)) fail(400,'Mã yêu cầu không hợp lệ.');
  return { customer, items, idempotencyKey, requestHash: digest(JSON.stringify({customer,items})).toString('hex') };
}

export function createApp(options = {}) {
  const publicOrigin = deploymentOrigin(options.publicOrigin ?? process.env.PUBLIC_ORIGIN ?? '');
  const db = options.db || openDatabase(options.dbPath);
  if (!db.prepare('SELECT count(*) n FROM products').get().n) syncCatalog(db, options.catalogPath);
  ensureProductFamilies(db);
  ensureAnalytics(db);
  ensureSecuritySchema(db);
  const auth = createAdminAuth({db,password:options.adminPassword ?? process.env.ADMIN_PASSWORD ?? '',
    username:options.adminUsername ?? process.env.ADMIN_USERNAME ?? 'admin'});
  const adminIsEnabled = () => auth.enabled();
  const configuredPhone = (options.shopPhone ?? process.env.SHOP_PHONE ?? '').trim();
  const shopPhone = /^[+\d\s().-]{9,25}$/.test(configuredPhone) && /^\d{9,15}$/.test(configuredPhone.replace(/\D/g,'')) ? configuredPhone : null;
  const shop = {contact_phone:shopPhone,zalo_url:shopPhone ? `https://zalo.me/${shopPhone.replace(/\D/g,'')}` : null};
  const databasePath = options.dbPath || process.env.DB_PATH;
  const mediaDirectory = options.mediaDirectory || process.env.MEDIA_DIRECTORY || resolve(databasePath && databasePath !== ':memory:' ? dirname(resolve(databasePath)) : resolve(ROOT,'data'),'media');
  const media = createMediaService({db,directory:mediaDirectory,phone:shopPhone,python:options.pythonPath});
  const prices = createPriceService({db,directory:options.pricesDirectory || process.env.PRICES_DIRECTORY || resolve(dirname(mediaDirectory),'prices'),
    python:options.pythonPath,runner:options.priceRunner});
  const sessions = createSessionStore({identity:()=>auth.identity(),now:options.now || Date.now});
  const rates = new Map();
  const checkRate = (req, kind, limit, windowMs) => {
    const now = Date.now();
    for (const [key, value] of rates) if (value.until < now) rates.delete(key);
    const key = `${kind}:${req.socket.remoteAddress}`;
    const rate = rates.get(key) || { count: 0, until: now + windowMs };
    if (rate.count >= limit) fail(429, 'Bạn thao tác quá nhanh. Vui lòng thử lại sau.');
    rate.count++;
    rates.set(key,rate);
  };
  const localAdminRequest = req => {
    if (publicOrigin || req.headers['x-forwarded-for'] || req.headers.forwarded) return false;
    const ip = req.socket.remoteAddress;
    let hostname;
    try { hostname = new URL(`http://${req.headers.host}`).hostname; } catch { return false; }
    return ['127.0.0.1','::1','::ffff:127.0.0.1'].includes(ip) && ['localhost','127.0.0.1','[::1]'].includes(hostname);
  };
  const setupAllowed = req => !adminIsEnabled() && localAdminRequest(req);
  const setSession = (req,res) => {
    const session = sessions.create(req);
    res.setHeader('Set-Cookie',`sentai_session=${session.token}; HttpOnly; SameSite=Strict; Path=/api/admin; Max-Age=${session.maxAge}${req.socket.encrypted || publicOrigin ? '; Secure' : ''}`);
    return session.csrf;
  };
  const writeJson = (res, status, data) => {
    res.writeHead(status, { 'Content-Type':'application/json; charset=utf-8', 'Cache-Control':'no-store' });
    res.end(JSON.stringify(data));
  };
  const publicOrder = order => {
    const {customer_name,customer_phone,customer_email,customer_address,note,...safe} = order;
    return safe;
  };
  const placeOrder = body => {
    const { customer, items, idempotencyKey, requestHash } = normalizeOrder(body);
    db.exec('BEGIN IMMEDIATE');
    try {
      const existing = db.prepare('SELECT id,request_hash FROM orders WHERE idempotency_key=?').get(idempotencyKey);
      if (existing) {
        if (existing.request_hash !== requestHash) fail(409,'Mã yêu cầu đã dùng cho giỏ hàng khác. Vui lòng gửi lại với mã mới.');
        const order = publicOrder(getOrder(db,existing.id));
        db.exec('COMMIT');
        return { order, repeated:true };
      }
      const lines = items.map(item=>{
        const p = getProduct(db,item.product_id);
        if (!p) fail(400,'Có sản phẩm không còn trong danh mục. Vui lòng cập nhật giỏ hàng.');
        if (item.quantity !== 1) fail(400,`${p.family_name} — ${p.unit_label} là một món hàng riêng. Mỗi món chỉ được đặt 1 chiếc; hãy chọn món khác nếu muốn mua thêm.`);
        if (p.availability === 'sold_out') fail(409,`${p.name} đã bán hoặc tạm hết hàng.`);
        if (p.price_vnd == null) fail(409,`${p.name} cần được báo giá trước khi đặt mua.`);
        return {...item,product_name:p.name,unit_price:p.price_vnd,line_total:p.price_vnd*item.quantity,
          family_name:p.family_name,unit_label:p.unit_label,collection_label:p.collection_name,condition_note:p.condition};
      });
      const total = lines.reduce((sum,item)=>sum+item.line_total,0);
      if (!Number.isSafeInteger(total) || total > 20000000000) fail(400,'Giá trị giỏ hàng vượt giới hạn.');
      const id = randomUUID();
      const date = new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Ho_Chi_Minh',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date()).replaceAll('-','');
      const orderNumber = `ST-${date}-${randomBytes(4).toString('hex').toUpperCase()}`;
      const privateFields = encryptOrderFields(db,id,{customer_name:customer.name,customer_phone:customer.phone,
        customer_email:customer.email,customer_address:customer.address,note:customer.note});
      db.prepare(`INSERT INTO orders(id,order_number,idempotency_key,request_hash,customer_name,customer_phone,customer_email,customer_address,note,subtotal,total)
        VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(id,orderNumber,idempotencyKey,requestHash,privateFields.customer_name,privateFields.customer_phone,privateFields.customer_email,privateFields.customer_address,privateFields.note,total,total);
      const insert = db.prepare('INSERT INTO order_items(order_id,product_id,product_name,unit_price,quantity,line_total) VALUES(?,?,?,?,?,?)');
      for (const line of lines) {
        const stored = insert.run(id,line.product_id,line.product_name,line.unit_price,line.quantity,line.line_total);
        db.prepare('INSERT INTO order_item_options(order_item_id,family_name,unit_label,collection_label,condition_note) VALUES(?,?,?,?,?)')
          .run(stored.lastInsertRowid,line.family_name,line.unit_label,line.collection_label,line.condition_note);
      }
      const order = publicOrder(getOrder(db,id));
      db.exec('COMMIT');
      return {order,repeated:false};
    } catch(error) { db.exec('ROLLBACK'); throw error; }
  };

  const server = http.createServer(async (req,res)=>{
    securityHeaders(res,publicOrigin);
    const requestId=randomUUID();res.setHeader('X-Request-Id',requestId);
    try {
      const url = new URL(req.url,'http://localhost');
      const path = url.pathname;
      res.once('finish',()=>{
        try { auditResponse(db,{path,method:req.method,status:res.statusCode}); }
        catch { console.error('Security audit unavailable',requestId); }
      });
      validateTransport(req,publicOrigin);
      if (!['GET','HEAD','POST','PATCH','DELETE'].includes(req.method)) fail(405,'Phương thức không được hỗ trợ.');
      if (['POST','PATCH','DELETE'].includes(req.method)) {
        const expected = publicOrigin || `${req.socket.encrypted ? 'https' : 'http'}://${req.headers.host}`;
        if (req.headers['sec-fetch-site'] === 'cross-site' || (req.headers.origin && req.headers.origin !== expected)) fail(403,'Nguồn yêu cầu không hợp lệ.');
      }
      if (path === '/api/health' && req.method === 'GET') return writeJson(res,200,{ok:true});
      if (path === '/api/analytics/view' && req.method === 'POST') {
        checkRate(req,'analytics',300,60*1000);
        if (req.headers.dnt === '1' || req.headers['sec-gpc'] === '1' || /bot\b|crawler|spider|preview|facebookexternalhit/i.test(req.headers['user-agent'] || '')) {
          return writeJson(res,202,{accepted:false});
        }
        return writeJson(res,202,recordAnalyticsView(db,await readJson(req)));
      }
      if (path === '/api/catalog' && req.method === 'GET') {
        const products = getProducts(db);
        const metadata = JSON.parse(db.prepare("SELECT value FROM shop_metadata WHERE key='catalog'").get()?.value || '{}');
        const families = getProductFamilies(db,products);
        return writeJson(res,200,{products,families,metadata:{...metadata,shop,model_count:families.length,unit_count:products.length}});
      }
      const publicProductMatch = path.match(/^\/api\/products\/([\w-]+)$/);
      if (publicProductMatch && req.method === 'GET') {
        const page = getProductPage(db,publicProductMatch[1],url.searchParams.get('variant'));
        if (!page) fail(404,'Không tìm thấy mẫu hoặc món hàng đã chọn.');
        return writeJson(res,200,{...page,shop});
      }
      if (path === '/api/orders' && req.method === 'POST') {
        checkRate(req,'orders',30,60*60*1000);
        const result = placeOrder(await readJson(req));
        return writeJson(res,result.repeated ? 200 : 201,{order:result.order});
      }
      if (path === '/api/admin/session' && req.method === 'GET') {
        const session=sessions.get(req);
        return writeJson(res,200,{authenticated:Boolean(session),enabled:adminIsEnabled(),setup_allowed:setupAllowed(req),...(session?{csrf_token:session.csrf}:{})});
      }
      if (path === '/api/admin/setup' && req.method === 'POST') {
        if (!setupAllowed(req)) fail(403,'Chỉ được tạo tài khoản lần đầu từ máy chủ tại localhost.');
        checkRate(req,'setup',5,15*60*1000);
        const body = await readJson(req);
        if (!setupAllowed(req)) fail(409,'Tài khoản quản trị đã được thiết lập.');
        const account = await auth.setup(body);
        const csrf = setSession(req,res);
        return writeJson(res,201,{ok:true,...account,csrf_token:csrf});
      }
      if (path === '/api/admin/reset' && req.method === 'POST') {
        if (!localAdminRequest(req)) fail(403,'Mở liên kết khôi phục tại localhost trên máy đang chạy cửa hàng.');
        checkRate(req,'admin-reset',10,15*60*1000);
        const account = await auth.reset(await readJson(req));
        sessions.clear();
        rates.delete(`login:${req.socket.remoteAddress}`);
        db.prepare("DELETE FROM security_limits WHERE bucket='admin-login'").run();
        const csrf=setSession(req,res);
        return writeJson(res,200,{ok:true,...account,csrf_token:csrf});
      }
      if (path === '/api/admin/login' && req.method === 'POST') {
        if (!adminIsEnabled()) fail(503,'Chưa thiết lập mật khẩu quản trị. Mở trang quản trị trên máy chủ để tạo mật khẩu.');
        checkRate(req,'login',10,15*60*1000);
        checkPersistentLoginRate(db);
        const body = await readJson(req);
        if (!await auth.verifyLogin(body)) fail(401,'Tài khoản hoặc mật khẩu không đúng.');
        const csrf=setSession(req,res);
        return writeJson(res,200,{ok:true,csrf_token:csrf});
      }
      if (path.startsWith('/api/admin/')) {
        const session=sessions.get(req);
        if (!session) fail(401,'Vui lòng đăng nhập quản trị.');
        if (['POST','PATCH','DELETE'].includes(req.method)) sessions.checkCSRF(req,session);
        const assertAuthorized = () => {
          // A slow body or capability check must not outlive logout, recovery,
          // credential changes or the session's absolute/idle expiry.
          if (sessions.get(req,{touch:false}) !== session) fail(401,'Phiên quản trị đã hết hạn. Vui lòng đăng nhập lại.');
          if (['POST','PATCH','DELETE'].includes(req.method)) sessions.checkCSRF(req,session);
        };
        const readAdminJson = async () => { const body=await readJson(req); assertAuthorized(); return body; };
        if (path === '/api/admin/logout' && req.method === 'POST') {
          sessions.remove(req);
          res.setHeader('Set-Cookie',`sentai_session=; HttpOnly; SameSite=Strict; Path=/api/admin; Max-Age=0${publicOrigin?'; Secure':''}`);
          return writeJson(res,200,{ok:true});
        }
        if (path === '/api/admin/products' && req.method === 'GET') return writeJson(res,200,{products:getProducts(db)});
        if (path === '/api/admin/analytics' && req.method === 'GET') return writeJson(res,200,getAnalytics(db,url.searchParams));
        if (path === '/api/admin/security/events' && req.method === 'GET') return writeJson(res,200,{events:db.prepare('SELECT event,method,resource,status,created_at FROM security_events ORDER BY id DESC LIMIT 100').all()});
        if (path === '/api/admin/prices' && req.method === 'GET') { const snapshot=await prices.snapshot(); assertAuthorized(); return writeJson(res,200,snapshot); }
        if (path === '/api/admin/prices/groups' && req.method === 'POST') return writeJson(res,201,prices.addGroup(await readAdminJson()));
        if (path === '/api/admin/prices/keywords' && req.method === 'POST') return writeJson(res,201,prices.addKeyword(await readAdminJson()));
        const priceSourceMatch = path.match(/^\/api\/admin\/prices\/(groups|keywords)\/([a-f0-9-]+)$/);
        if (priceSourceMatch && req.method === 'DELETE') return writeJson(res,200,prices.disable(priceSourceMatch[1],priceSourceMatch[2]));
        if (path === '/api/admin/prices/scans' && req.method === 'POST') {
          checkRate(req,'price-scans',30,60*60*1000);
          return writeJson(res,202,await prices.enqueue(await readAdminJson(),assertAuthorized));
        }
        if (path === '/api/admin/prices/login' && req.method === 'POST') {
          let localHost = false;
          try { localHost = ['localhost','127.0.0.1','[::1]'].includes(new URL(`http://${req.headers.host}`).hostname); } catch {}
          if (!localHost || publicOrigin || req.headers['x-forwarded-for'] || req.headers.forwarded || !['127.0.0.1','::1','::ffff:127.0.0.1'].includes(req.socket.remoteAddress)) fail(403,'Mở trang quản trị tại localhost trên máy chủ để đăng nhập Facebook.');
          await readAdminJson();
          checkRate(req,'price-login',10,60*60*1000);
          return writeJson(res,202,await prices.login(assertAuthorized));
        }
        if (path === '/api/admin/prices/import' && req.method === 'POST') return writeJson(res,201,prices.importPost(await readAdminJson()));
        const observationMatch = path.match(/^\/api\/admin\/prices\/observations\/([a-f0-9-]+)$/);
        if (observationMatch && req.method === 'PATCH') return writeJson(res,200,prices.review(observationMatch[1],await readAdminJson()));
        const uploadMatch = path.match(/^\/api\/admin\/products\/([\w-]+)\/media$/);
        if (uploadMatch && req.method === 'POST') {
          checkRate(req,'uploads',120,60*60*1000);
          return writeJson(res,202,await media.upload(req,uploadMatch[1],url,assertAuthorized));
        }
        const mediaMatch = path.match(/^\/api\/admin\/media\/([a-f0-9-]+)$/i);
        if (mediaMatch && req.method === 'DELETE') return writeJson(res,200,media.remove(mediaMatch[1]));
        const productMatch = path.match(/^\/api\/admin\/products\/([^/]+)$/);
        if (productMatch && req.method === 'GET') {
          const details = await media.details(decodeURIComponent(productMatch[1]));
          assertAuthorized();
          const page = getProductPage(db,details.product.id);
          return writeJson(res,200,{...details,family:page.family});
        }
        if (productMatch && req.method === 'PATCH') {
          const id = decodeURIComponent(productMatch[1]);
          const p = db.prepare('SELECT * FROM products WHERE id=? AND active=1').get(id);
          if (!p) fail(404,'Không tìm thấy sản phẩm.');
          const body = await readAdminJson();
          const keys = Object.keys(body);
          if (!keys.length || keys.some(k=>!['price_vnd','availability','unit_label','collection_label','condition_note'].includes(k))) fail(400,'Chỉ được cập nhật giá, tình trạng, tên món và BST.');
          if ('price_vnd' in body && body.price_vnd !== null && (!Number.isInteger(body.price_vnd) || body.price_vnd <= 0 || body.price_vnd > 1000000000)) fail(400,'Giá phải là số nguyên dương, tối đa 1 tỷ đồng, hoặc để trống.');
          if ('availability' in body && !['unknown','available','sold_out'].includes(body.availability)) fail(400,'Tình trạng bán không hợp lệ.');
          const unit = db.prepare('SELECT * FROM product_units WHERE product_id=?').get(id);
          const unitLabel = 'unit_label' in body ? textField(body.unit_label,'Tên món',1,60) : unit.unit_label;
          const collectionLabel = 'collection_label' in body ? textField(body.collection_label,'Tên BST',0,100) : unit.collection_label;
          const conditionNote = 'condition_note' in body ? body.condition_note === null ? null : textField(body.condition_note,'Tình trạng món',0,1000) : unit.condition_note;
          if (db.prepare('SELECT product_id FROM product_units WHERE family_id=? AND product_id<>? AND unit_label=? COLLATE NOCASE').get(unit.family_id,id,unitLabel)) fail(409,'Tên món đã dùng trong mẫu này. Đặt tên khác để phân biệt ảnh và hàng.');
          db.exec('BEGIN IMMEDIATE');
          try {
            db.prepare(`UPDATE products SET price_vnd=?,availability=?,price_overridden=?,availability_overridden=?,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`)
              .run('price_vnd' in body ? body.price_vnd : p.price_vnd,body.availability ?? p.availability,'price_vnd' in body ? 1 : p.price_overridden,'availability' in body ? 1 : p.availability_overridden,id);
            db.prepare("UPDATE product_units SET unit_label=?,collection_label=?,condition_note=?,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE product_id=?")
              .run(unitLabel,collectionLabel,conditionNote,id);
            db.exec('COMMIT');
          } catch(error) { db.exec('ROLLBACK'); throw error; }
          return writeJson(res,200,{product:getProduct(db,id)});
        }
        if (path === '/api/admin/orders' && req.method === 'GET') {
          const orders = db.prepare('SELECT id FROM orders ORDER BY created_at DESC,id DESC').all().map(r=>getOrder(db,r.id));
          return writeJson(res,200,{orders});
        }
        const orderMatch = path.match(/^\/api\/admin\/orders\/([^/]+)$/);
        if (orderMatch && req.method === 'PATCH') {
          const id = decodeURIComponent(orderMatch[1]);
          if (!getOrder(db,id)) fail(404,'Không tìm thấy đơn hàng.');
          const body = await readAdminJson();
          if (Object.keys(body).some(k=>k !== 'status') || !['pending','confirmed','shipping','completed','cancelled'].includes(body.status)) fail(400,'Trạng thái đơn hàng không hợp lệ.');
          db.prepare("UPDATE orders SET status=?,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?").run(body.status,id);
          return writeJson(res,200,{order:getOrder(db,id)});
        }
        fail(404,'Không tìm thấy API quản trị.');
      }
      if (path.startsWith('/api/')) fail(404,'Không tìm thấy API.');
      if (!['GET','HEAD'].includes(req.method)) fail(405,'Phương thức không được hỗ trợ.');
      if (path.startsWith('/media/')) return media.serve(req,res,path);
      let decoded;
      try { decoded = decodeURIComponent(path); } catch { fail(400,'Đường dẫn không hợp lệ.'); }
      if (decoded.includes('\\') || decoded.includes('\0') || decoded.split('/').some(part=>part.startsWith('.'))) fail(404,'Không tìm thấy trang.');
      if (/^\/products\/[\w-]+\/?$/.test(decoded) && !getProductPage(db,decoded.split('/')[2],url.searchParams.get('variant'))) fail(404,'Không tìm thấy mẫu hoặc món hàng đã chọn.');
      const relative = decoded === '/' ? '/index.html' : ['/admin','/admin/'].includes(decoded) ? '/admin.html' :
        ['/admin/analytics','/admin/analytics/'].includes(decoded) ? '/admin-analytics.html' :
        ['/admin/prices','/admin/prices/'].includes(decoded) ? '/admin-prices.html' :
        /^\/products\/[\w-]+\/?$/.test(decoded) ? '/product.html' : /^\/admin\/products\/[\w-]+\/?$/.test(decoded) ? '/admin-media.html' : decoded;
      const fullPath = resolve(PUBLIC,`.${relative}`);
      if (!fullPath.startsWith(PUBLIC + sep) || !existsSync(fullPath) || !statSync(fullPath).isFile()) fail(404,'Không tìm thấy trang.');
      if (!realpathSync(fullPath).startsWith(realpathSync(PUBLIC)+sep)) fail(404,'Không tìm thấy trang.');
      const types = {'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.svg':'image/svg+xml','.jpg':'image/jpeg','.jpeg':'image/jpeg','.png':'image/png','.webp':'image/webp','.gif':'image/gif','.ico':'image/x-icon'};
      const type = types[extname(fullPath).toLowerCase()];
      if (!type) fail(404,'Không tìm thấy tập tin.');
      res.writeHead(200,{'Content-Type':type,'Content-Length':statSync(fullPath).size,'Cache-Control':relative.startsWith('/admin') ? 'no-store' : relative.startsWith('/images/') ? 'public, max-age=86400' : 'no-cache'});
      if (req.method === 'HEAD') return res.end();
      const stream = createReadStream(fullPath);
      stream.on('error',()=>res.destroy());
      stream.pipe(res);
    } catch(error) {
      if (res.headersSent) return res.destroy();
      const known=error instanceof HttpError || error instanceof MediaError || error instanceof PriceError || error instanceof AnalyticsError || error instanceof AdminAuthError || error instanceof SecurityError;
      if (!known) console.error('Request failed:',requestId,error.name);
      writeJson(res,known ? error.status : 500,{error:known ? error.message : 'Máy chủ gặp lỗi. Vui lòng thử lại.',...(error instanceof SecurityError && error.code?{code:error.code}:{})});
    }
  });
  server.requestTimeout = 10*60*1000;
  server.headersTimeout = 15000;
  return {server,db,media,prices,get adminEnabled(){return adminIsEnabled();}};
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (!['127.0.0.1','localhost','::1'].includes(process.env.HOST || '127.0.0.1')) throw new Error('Chỉ bind localhost. Khi public, đặt HTTPS reverse proxy phía trước máy chủ.');
  const {server,db,media,prices,adminEnabled} = createApp();
  const port = Number(process.env.PORT || 3000);
  const host = process.env.HOST || '127.0.0.1';
  server.listen(port,host,()=>{
    console.log(`Sentai Shop: http://${host}:${server.address().port}`);
    console.log(`Quản trị: http://${host}:${server.address().port}/admin (${adminEnabled ? 'đã cấu hình mật khẩu' : 'mở trên máy này để tạo mật khẩu quản trị'})`);
  });
  server.on('error',async error=>{ console.error(`Không thể chạy máy chủ: ${error.message}`); await prices.close(); await media.close(); db.close(); process.exitCode=1; });
  const stop = ()=>server.close(async ()=>{ await prices.close(); await media.close(); db.close(); process.exit(0); });
  process.on('SIGINT',stop);
  process.on('SIGTERM',stop);
}
