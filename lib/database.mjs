import { DatabaseSync } from 'node:sqlite';
import { readFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { ensureAdminAuthSchema } from './admin-auth.mjs';
import { DataProtectionError, initializeOrderDataProtection } from './data-protection.mjs';

export const ROOT = fileURLToPath(new URL('../', import.meta.url));
const dataProtectors = new WeakMap();
export function openDatabase(path = process.env.DB_PATH || resolve(ROOT, 'data/sentai.sqlite'), {encryptionKeyPath} = {}) {
  if (path !== ':memory:') mkdirSync(dirname(resolve(path)), { recursive: true });
  const db = new DatabaseSync(path);
  try {
    db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
    db.exec(readFileSync(resolve(ROOT, 'database/schema.sql'), 'utf8'));
    const protector = initializeOrderDataProtection(db, {
      keyPath:encryptionKeyPath ?? (process.env.DATA_ENCRYPTION_KEY_FILE || resolve(dirname(resolve(path)), 'secrets/order-data.key')),
      publicDirectory:resolve(ROOT, 'public'), inMemory:path === ':memory:'
    });
    dataProtectors.set(db, protector);
    ensureAdminAuthSchema(db);
    ensureProductFamilies(db);
    return db;
  } catch (error) { db.close(); throw error; }
}

export function encryptOrderFields(db, orderId, fields) {
  const protector = dataProtectors.get(db);
  if (!protector) throw new DataProtectionError();
  return protector.encryptFields(orderId, fields);
}
export function getDataProtectionInfo(db) {
  const protector = dataProtectors.get(db);
  if (!protector) throw new DataProtectionError();
  return {keyPath:protector.keyPath};
}

export function syncCatalog(db, path = resolve(ROOT, 'data/catalog.json')) {
  const catalog = JSON.parse(readFileSync(path, 'utf8'));
  if (!Array.isArray(catalog.products) || !catalog.products.length) throw new Error('Danh mục trống hoặc không hợp lệ. Chạy npm run db:import.');
  const insert = db.prepare(`INSERT INTO products
    (id,sku,name,series,category,price_vnd,price_original,availability,condition,description,images,source_sheet,source_row,source_total)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
    sku=excluded.sku, name=excluded.name, series=excluded.series, category=excluded.category,
    price_vnd=CASE WHEN products.price_overridden=1 THEN products.price_vnd ELSE excluded.price_vnd END,
    availability=CASE WHEN products.availability_overridden=1 THEN products.availability ELSE excluded.availability END,
    price_original=excluded.price_original,condition=excluded.condition,description=excluded.description,
    images=excluded.images,source_sheet=excluded.source_sheet,source_row=excluded.source_row,source_total=excluded.source_total,
    active=1,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')`);
  db.exec('BEGIN IMMEDIATE');
  try {
    const existingIdentity = db.prepare('SELECT sku,name,series FROM products WHERE id=?');
    for (const p of catalog.products) {
      const previous = existingIdentity.get(p.id);
      if (previous && (previous.sku !== (p.sku || '') || previous.name !== p.name || previous.series !== (p.series || ''))) {
        throw new Error(`Dòng ${p.source_row} đã đổi tên, SKU hoặc dòng sản phẩm. Dừng nhập để tránh gán giá/đơn hàng sang sản phẩm khác. Giữ vị trí và định danh dòng cũ; cần di chuyển dữ liệu có chủ đích nếu muốn đổi định danh.`);
      }
    }
    db.exec('UPDATE products SET active=0');
    for (const p of catalog.products) insert.run(p.id,p.sku || '',p.name,p.series || '',p.category || 'Mecha',p.price_vnd ?? null,
      p.price_original == null ? null : String(p.price_original),p.availability || 'unknown',p.condition || '',p.description || '',
      JSON.stringify(p.images || []),p.source_sheet,p.source_row,p.source_total_original == null ? null : String(p.source_total_original));
    db.prepare('INSERT INTO shop_metadata(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
      .run('catalog',JSON.stringify(catalog.metadata || {}));
    ensureProductFamilies(db);
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
  return catalog.products.length;
}

export function mediaRecord(row) {
  if (!row) return null;
  const { active, filename, poster_filename, ...media } = row;
  return { ...media, url:`/media/${row.id}/${filename}`, poster_url:`/media/${row.id}/${poster_filename}` };
}
export function getMedia(db, productId) {
  return db.prepare('SELECT * FROM product_media WHERE product_id=? AND active=1 ORDER BY created_at DESC,id').all(productId).map(mediaRecord);
}
export function productRecord(row, media = []) {
  if (!row) return null;
  const { price_overridden, availability_overridden, active, condition_note, ...product } = row;
  const sourceImages = JSON.parse(product.images);
  const uploadedImages = media.filter(m=>m.kind === 'image').map(m=>m.url);
  return { ...product, source_condition:product.condition,condition:condition_note ?? product.condition,condition_note:condition_note ?? null,
    source_images:sourceImages,uploaded_images:uploadedImages,images:[...uploadedImages,...sourceImages],media,max_quantity:1,
    collection_name:product.collection_label || product.series || 'Chưa xếp BST',
    detail_url:product.family_id ? `/products/${product.family_id}?variant=${encodeURIComponent(product.id)}` : `/products/${product.id}` };
}
const productSelect = `SELECT p.*,u.family_id,u.unit_label,u.collection_label,u.condition_note,f.name family_name
  FROM products p LEFT JOIN product_units u ON u.product_id=p.id LEFT JOIN product_families f ON f.id=u.family_id`;
export function getProducts(db) {
  const allMedia = db.prepare('SELECT * FROM product_media WHERE active=1 ORDER BY created_at DESC,id').all().map(mediaRecord);
  const byProduct = new Map();
  for (const item of allMedia) { if (!byProduct.has(item.product_id)) byProduct.set(item.product_id,[]); byProduct.get(item.product_id).push(item); }
  return db.prepare(`${productSelect} WHERE p.active=1 ORDER BY p.source_row,p.id`).all().map(p=>productRecord(p,byProduct.get(p.id) || []));
}
export function getProduct(db, id) {
  return productRecord(db.prepare(`${productSelect} WHERE p.id=? AND p.active=1`).get(id),getMedia(db,id));
}

const groupingText = value => String(value || '').normalize('NFC').trim().replace(/\s+/g,' ').toLocaleLowerCase('vi');
const groupingKey = (series,name) => JSON.stringify([groupingText(series),groupingText(name)]);
export function ensureProductFamilies(db) {
  const rows = db.prepare('SELECT id,name,series,source_row FROM products ORDER BY source_row,id').all();
  const numbered = new Map();
  for (const row of rows) {
    const match = row.name.trim().match(/^(.*?)\s+(0[1-9]|[1-9][0-9])$/);
    if (!match) continue;
    const key = groupingKey(row.series,match[1]);
    if (!numbered.has(key)) numbered.set(key,new Set());
    numbered.get(key).add(match[2]);
  }
  const existing = new Map(db.prepare('SELECT product_id,family_id,unit_label FROM product_units').all().map(row=>[row.product_id,row]));
  const labels = new Map();
  for (const row of existing.values()) {
    if (!labels.has(row.family_id)) labels.set(row.family_id,new Set());
    labels.get(row.family_id).add(row.unit_label);
  }
  // Only collapse terminal 01/02 when there is a sibling pair. Numbers elsewhere,
  // lone model numbers, China/partial sets/box editions remain distinct models.
  for (const row of rows) {
    if (existing.has(row.id)) continue;
    let name = row.name.trim().replace(/\s+/g,' '), suffix = null;
    const match = name.match(/^(.*?)\s+(0[1-9]|[1-9][0-9])$/);
    const candidateKey = match ? groupingKey(row.series,match[1]) : '';
    const siblings = numbered.get(candidateKey);
    if (match && siblings?.has('01') && siblings.size > 1) { name = match[1]; suffix = match[2]; }
    const key = groupingKey(row.series,name);
    const id = `model-${createHash('sha256').update(key).digest('hex').slice(0,20)}`;
    db.prepare('INSERT OR IGNORE INTO product_families(id,name,series,grouping_key) VALUES(?,?,?,?)').run(id,name,row.series,key);
    if (!labels.has(id)) labels.set(id,new Set());
    const used = labels.get(id);
    let label = suffix ? `Món ${suffix}` : 'Món 01';
    for (let i=1;used.has(label);i++) label = `Món ${String(i).padStart(2,'0')}`;
    used.add(label);
    db.prepare('INSERT INTO product_units(product_id,family_id,unit_label) VALUES(?,?,?)').run(row.id,id,label);
  }
}

export function getProductFamilies(db, products = getProducts(db)) {
  const grouped = new Map();
  for (const product of products) {
    if (!grouped.has(product.family_id)) grouped.set(product.family_id,[]);
    grouped.get(product.family_id).push(product);
  }
  return [...grouped].map(([id,variants])=>{
    const live = variants.filter(item=>item.availability !== 'sold_out');
    const representative = live.find(item=>item.price_vnd != null) || live[0] || variants[0];
    const priced = live.filter(item=>item.price_vnd != null).map(item=>item.price_vnd);
    return {id,name:variants[0].family_name,series:variants[0].series,variants,variant_count:variants.length,
      available_count:live.length,min_price_vnd:priced.length ? Math.min(...priced) : null,max_price_vnd:priced.length ? Math.max(...priced) : null,
      has_unpriced:live.some(item=>item.price_vnd == null),images:representative.images,media:representative.media,
      source_row:Math.min(...variants.map(item=>item.source_row)),url:`/products/${id}`,default_variant_id:representative.id,
      collections:[...new Set(variants.map(item=>item.collection_name))]};
  });
}
export function getProductPage(db, id, variantId) {
  const products = getProducts(db);
  const legacy = products.find(product=>product.id === id);
  const family = getProductFamilies(db,products).find(item=>item.id === (legacy?.family_id || id));
  if (!family) return null;
  const chosenId = variantId || legacy?.id || family.default_variant_id;
  const product = family.variants.find(item=>item.id === chosenId);
  return product ? {product,family} : null;
}
export function getOrder(db, id) {
  const row = db.prepare('SELECT * FROM orders WHERE id=?').get(id);
  if (!row) return null;
  const { idempotency_key, request_hash, ...order } = row;
  const protector = dataProtectors.get(db);
  if (!protector) throw new DataProtectionError();
  return { ...order, ...protector.decryptFields(id, order), items: db.prepare(`SELECT i.product_id,i.product_name,i.unit_price,i.quantity,i.line_total,
    o.family_name,o.unit_label,o.collection_label,o.condition_note FROM order_items i LEFT JOIN order_item_options o ON o.order_item_id=i.id
    WHERE i.order_id=? ORDER BY i.id`).all(id) };
}
