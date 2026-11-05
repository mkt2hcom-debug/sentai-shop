import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import { fail, textField, readJson, json, all, first } from './common.mjs';

const PRIVATE_FIELDS = ['customer_name','customer_phone','customer_email','customer_address','note'];
const productSelect = `SELECT p.*,u.family_id,u.unit_label,u.collection_label,u.condition_note,f.name family_name
  FROM products p JOIN product_units u ON u.product_id=p.id JOIN product_families f ON f.id=u.family_id`;

export function mediaRecord(row) {
  if (!row) return null;
  const {active,filename,poster_filename,...media}=row;
  return {...media,url:`/media/${row.id}/${filename}`,poster_url:`/media/${row.id}/${poster_filename}`};
}
export async function getMedia(db,id) {
  return (await all(db,"SELECT * FROM product_media WHERE product_id=? AND active=1 AND visible_after<=strftime('%Y-%m-%dT%H:%M:%fZ','now') ORDER BY created_at DESC,id",id)).map(mediaRecord);
}
function productRecord(row,media=[]) {
  if (!row) return null;
  const {price_overridden,availability_overridden,active,condition_note,...product}=row;
  const sourceImages=JSON.parse(product.images);
  const uploadedImages=media.filter(item=>item.kind==='image').map(item=>item.url);
  return {...product,source_condition:product.condition,condition:condition_note??product.condition,condition_note:condition_note??null,
    source_images:sourceImages,uploaded_images:uploadedImages,images:[...uploadedImages,...sourceImages],media,max_quantity:1,
    collection_name:product.collection_label||product.series||'Chưa xếp BST',
    detail_url:`/products/${product.family_id}?variant=${encodeURIComponent(product.id)}`};
}
async function productsFor(db,where,args=[]) {
  // One consistent D1 batch avoids combining product metadata and media from
  // different read-replica snapshots, and has no per-product query loop.
  const results=await db.batch([
    db.prepare(`${productSelect} WHERE p.active=1 ${where} ORDER BY p.source_row,p.id`).bind(...args),
    db.prepare(`SELECT m.* FROM product_media m JOIN products p ON p.id=m.product_id JOIN product_units u ON u.product_id=p.id
      WHERE m.active=1 AND m.visible_after<=strftime('%Y-%m-%dT%H:%M:%fZ','now') AND p.active=1 ${where} ORDER BY m.created_at DESC,m.id`).bind(...args)
  ]);
  const byProduct=new Map();
  for (const row of results[1].results) {
    if (!byProduct.has(row.product_id)) byProduct.set(row.product_id,[]);
    byProduct.get(row.product_id).push(mediaRecord(row));
  }
  return results[0].results.map(row=>productRecord(row,byProduct.get(row.id)||[]));
}
export async function getProducts(db) { return productsFor(db,''); }
export async function getProduct(db,id) { return (await productsFor(db,'AND p.id=?',[id]))[0]||null; }
export async function getProductFamilies(db,products) {
  products??=await getProducts(db);
  const grouped=new Map();
  for (const product of products) {
    if (!grouped.has(product.family_id)) grouped.set(product.family_id,[]);
    grouped.get(product.family_id).push(product);
  }
  return [...grouped].map(([id,variants])=>{
    const live=variants.filter(item=>item.availability!=='sold_out');
    const representative=live.find(item=>item.price_vnd!=null)||live[0]||variants[0];
    const priced=live.filter(item=>item.price_vnd!=null).map(item=>item.price_vnd);
    return {id,name:variants[0].family_name,series:variants[0].series,variants,variant_count:variants.length,
      available_count:live.length,min_price_vnd:priced.length?Math.min(...priced):null,max_price_vnd:priced.length?Math.max(...priced):null,
      has_unpriced:live.some(item=>item.price_vnd==null),images:representative.images,media:representative.media,
      source_row:Math.min(...variants.map(item=>item.source_row)),url:`/products/${id}`,default_variant_id:representative.id,
      collections:[...new Set(variants.map(item=>item.collection_name))]};
  });
}
export async function getProductPage(db,id,variantId) {
  const legacy=await first(db,'SELECT family_id FROM product_units WHERE product_id=?',id);
  const products=await productsFor(db,'AND u.family_id=?',[legacy?.family_id||id]);
  const family=(await getProductFamilies(db,products))[0];
  if (!family) return null;
  const chosenId=variantId||(legacy?id:family.default_variant_id);
  const product=family.variants.find(item=>item.id===chosenId);
  return product?{product,family}:null;
}

function protectionFailure() { fail(503,'Không thể mở dữ liệu đơn hàng an toàn. Kiểm tra khóa mã hóa và bản sao lưu.'); }
function protector(secret) {
  if (typeof secret!=='string') protectionFailure();
  const key=/^[a-f0-9]{64}$/i.test(secret)?Buffer.from(secret,'hex'):
    /^[A-Za-z0-9+/]{43}=$/.test(secret)?Buffer.from(secret,'base64'):null;
  if (!key||key.length!==32) protectionFailure();
  const aad=(id,field)=>Buffer.from(JSON.stringify(['sentai-order-data',1,id,field]));
  return {
    encrypt(id,field,value) {
      try {
        const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,iv,{authTagLength:16});
        cipher.setAAD(aad(id,field));
        const bytes=Buffer.concat([cipher.update(value,'utf8'),cipher.final()]);
        return 'enc:v1:'+Buffer.concat([iv,cipher.getAuthTag(),bytes]).toString('base64url');
      } catch { protectionFailure(); }
    },
    decrypt(id,field,value) {
      try {
        if (typeof value!=='string'||!value.startsWith('enc:v1:')) throw Error();
        const encoded=value.slice(7),bytes=Buffer.from(encoded,'base64url');
        if (!/^[A-Za-z0-9_-]+$/.test(encoded)||bytes.length<28||bytes.toString('base64url')!==encoded) throw Error();
        const cipher=createDecipheriv('aes-256-gcm',key,bytes.subarray(0,12),{authTagLength:16});
        cipher.setAAD(aad(id,field));cipher.setAuthTag(bytes.subarray(12,28));
        return Buffer.concat([cipher.update(bytes.subarray(28)),cipher.final()]).toString('utf8');
      } catch { protectionFailure(); }
    }
  };
}
export async function verifyOrderKey(env) {
  const cipher=protector(env.DATA_ENCRYPTION_KEY);
  const state=await first(env.DB,'SELECT key_check,scrub_required FROM data_protection_state WHERE id=1');
  if (!state||state.scrub_required||cipher.decrypt('$key-check','$key-check',state.key_check)!=='sentai:order-data:v1') protectionFailure();
  return cipher;
}
async function orderRecord(db,row,cipher,includePrivate) {
  if (!row) return null;
  const {idempotency_key,request_hash,...order}=row;
  for (const field of PRIVATE_FIELDS) {
    if (includePrivate) order[field]=cipher.decrypt(order.id,field,order[field]);
    else delete order[field];
  }
  order.items=await all(db,`SELECT i.product_id,i.product_name,i.unit_price,i.quantity,i.line_total,
    o.family_name,o.unit_label,o.collection_label,o.condition_note FROM order_items i LEFT JOIN order_item_options o ON o.order_item_id=i.id
    WHERE i.order_id=? ORDER BY i.id`,order.id);
  return order;
}
export async function getOrder(env,id,{includePrivate=true}={}) {
  const cipher=await verifyOrderKey(env);
  return orderRecord(env.DB,await first(env.DB,'SELECT * FROM orders WHERE id=?',id),cipher,includePrivate);
}

function normalizeOrder(body) {
  const c=body.customer;
  if (!c||typeof c!=='object'||Array.isArray(c)) fail(400,'Vui lòng điền thông tin nhận hàng.');
  const customer={name:textField(c.name,'Họ tên',2,100),phone:textField(c.phone,'Số điện thoại',9,25),
    email:textField(c.email,'Email',0,254),address:textField(c.address,'Địa chỉ',10,500),note:textField(c.note,'Ghi chú',0,1000)};
  if (!/^[+\d\s().-]+$/.test(customer.phone)||!/^\d{9,15}$/.test(customer.phone.replace(/\D/g,''))) fail(400,'Số điện thoại không hợp lệ.');
  if (customer.email&&!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(customer.email)) fail(400,'Email không hợp lệ.');
  if (!Array.isArray(body.items)||body.items.length<1||body.items.length>40) fail(400,'Giỏ hàng cần có từ 1 đến 40 sản phẩm.');
  const seen=new Set();
  const items=body.items.map(item=>{
    if (!item||typeof item.product_id!=='string'||item.product_id.length>100||item.quantity!==1) fail(400,'Mỗi món hàng cũ chỉ được đặt 1 chiếc.');
    if (seen.has(item.product_id)) fail(400,'Sản phẩm bị lặp trong giỏ hàng.');
    seen.add(item.product_id);return {product_id:item.product_id,quantity:1};
  }).sort((a,b)=>a.product_id.localeCompare(b.product_id));
  const idempotencyKey=textField(body.idempotency_key,'Mã yêu cầu',16,100);
  if (!/^[\w-]+$/.test(idempotencyKey)) fail(400,'Mã yêu cầu không hợp lệ.');
  return {customer,items,idempotencyKey,requestHash:createHash('sha256').update(JSON.stringify({customer,items})).digest('hex')};
}
async function placeOrder(env,body) {
  const db=env.DB,{customer,items,idempotencyKey,requestHash}=normalizeOrder(body),cipher=await verifyOrderKey(env);
  const previous=await first(db,'SELECT * FROM orders WHERE idempotency_key=?',idempotencyKey);
  if (previous) {
    if (previous.request_hash!==requestHash) fail(409,'Mã yêu cầu đã dùng cho giỏ hàng khác. Vui lòng gửi lại với mã mới.');
    return {order:await orderRecord(db,previous,cipher,false),repeated:true};
  }
  const selected=await all(db,`${productSelect} WHERE p.id IN (SELECT json_extract(value,'$.product_id') FROM json_each(?))`,JSON.stringify(items));
  const lines=items.map(item=>{
    const p=selected.find(row=>row.id===item.product_id);
    if (!p||!p.active) fail(400,'Có sản phẩm không còn trong danh mục. Vui lòng cập nhật giỏ hàng.');
    if (p.availability==='sold_out') fail(409,`${p.name} đã bán hoặc tạm hết hàng.`);
    if (p.price_vnd==null) fail(409,`${p.name} cần được báo giá trước khi đặt mua.`);
    return {...item,product_name:p.name,unit_price:p.price_vnd,line_total:p.price_vnd,
      family_name:p.family_name,unit_label:p.unit_label,collection_label:p.collection_label||p.series||'Chưa xếp BST',condition_note:p.condition_note??p.condition};
  });
  const total=lines.reduce((sum,line)=>sum+line.line_total,0);
  if (!Number.isSafeInteger(total)||total>20000000000) fail(400,'Giá trị giỏ hàng vượt giới hạn.');
  const id=randomUUID(),guard=randomUUID(),lineJson=JSON.stringify(lines);
  const date=new Date(Date.now()+7*3600000).toISOString().slice(0,10).replaceAll('-','');
  const orderNumber=`ST-${date}-${randomBytes(4).toString('hex').toUpperCase()}`;
  const fields={customer_name:customer.name,customer_phone:customer.phone,customer_email:customer.email,customer_address:customer.address,note:customer.note};
  const encrypted=PRIVATE_FIELDS.map(field=>cipher.encrypt(id,field,fields[field]));
  // All validation that can race with admin edits runs again inside the SAME
  // transactional batch as the order and lines. The CHECK guard rolls back
  // every write on conflict. A concurrent identical retry reuses the winner.
  const statements=[
    db.prepare(`INSERT INTO cf_integrity_guard(id,passed) SELECT ?,CASE WHEN
      EXISTS(SELECT 1 FROM orders WHERE idempotency_key=? AND request_hash<>?) THEN 0
      WHEN EXISTS(SELECT 1 FROM orders WHERE idempotency_key=? AND request_hash=?) THEN 1
      WHEN (SELECT count(*) FROM json_each(?) j JOIN products p ON p.id=json_extract(j.value,'$.product_id')
        JOIN product_units u ON u.product_id=p.id JOIN product_families f ON f.id=u.family_id
        WHERE p.active=1 AND p.availability<>'sold_out' AND p.price_vnd=json_extract(j.value,'$.unit_price')
        AND p.name=json_extract(j.value,'$.product_name') AND f.name=json_extract(j.value,'$.family_name')
        AND u.unit_label=json_extract(j.value,'$.unit_label')
        AND COALESCE(NULLIF(u.collection_label,''),NULLIF(p.series,''),'Chưa xếp BST')=json_extract(j.value,'$.collection_label')
        AND COALESCE(u.condition_note,p.condition)=json_extract(j.value,'$.condition_note'))=? THEN 1 ELSE 0 END`)
      .bind(guard,idempotencyKey,requestHash,idempotencyKey,requestHash,lineJson,lines.length),
    db.prepare(`INSERT INTO orders(id,order_number,idempotency_key,request_hash,customer_name,customer_phone,customer_email,customer_address,note,subtotal,total)
      SELECT ?,?,?,?,?,?,?,?,?,?,? WHERE NOT EXISTS(SELECT 1 FROM orders WHERE idempotency_key=?)`)
      .bind(id,orderNumber,idempotencyKey,requestHash,...encrypted,total,total,idempotencyKey),
    db.prepare(`INSERT INTO order_items(order_id,product_id,product_name,unit_price,quantity,line_total)
      SELECT ?,json_extract(value,'$.product_id'),json_extract(value,'$.product_name'),json_extract(value,'$.unit_price'),1,json_extract(value,'$.line_total')
      FROM json_each(?) WHERE EXISTS(SELECT 1 FROM orders WHERE id=?)`).bind(id,lineJson,id),
    db.prepare(`INSERT INTO order_item_options(order_item_id,family_name,unit_label,collection_label,condition_note)
      SELECT i.id,json_extract(j.value,'$.family_name'),json_extract(j.value,'$.unit_label'),json_extract(j.value,'$.collection_label'),json_extract(j.value,'$.condition_note')
      FROM order_items i JOIN json_each(?) j ON json_extract(j.value,'$.product_id')=i.product_id WHERE i.order_id=?`).bind(lineJson,id),
    db.prepare('DELETE FROM cf_integrity_guard WHERE id=?').bind(guard)
  ];
  try { await db.batch(statements); }
  catch (error) {
    if (/CHECK constraint failed.*passed|UNIQUE constraint failed: orders\./i.test(error.message)) fail(409,'Giỏ hàng hoặc mã yêu cầu đã thay đổi. Vui lòng cập nhật giỏ hàng rồi thử lại.');
    throw error;
  }
  const stored=await first(db,'SELECT * FROM orders WHERE idempotency_key=?',idempotencyKey);
  if (!stored||stored.request_hash!==requestHash) fail(409,'Mã yêu cầu đã dùng cho giỏ hàng khác.');
  return {order:await orderRecord(db,stored,cipher,false),repeated:stored.id!==id};
}

async function updateProduct(db,id,body) {
  const keys=Object.keys(body);
  if (!keys.length||keys.some(key=>!['price_vnd','availability','unit_label','collection_label','condition_note'].includes(key))) fail(400,'Chỉ được cập nhật giá, tình trạng, tên món và BST.');
  if ('price_vnd' in body&&body.price_vnd!==null&&(!Number.isInteger(body.price_vnd)||body.price_vnd<=0||body.price_vnd>1000000000)) fail(400,'Giá phải là số nguyên dương, tối đa 1 tỷ đồng, hoặc để trống.');
  if ('availability' in body&&!['unknown','available','sold_out'].includes(body.availability)) fail(400,'Tình trạng bán không hợp lệ.');
  if ('unit_label' in body) body.unit_label=textField(body.unit_label,'Tên món',1,60);
  if ('collection_label' in body) body.collection_label=textField(body.collection_label,'Tên BST',0,100);
  if ('condition_note' in body&&body.condition_note!==null) body.condition_note=textField(body.condition_note,'Tình trạng món',0,1000);
  if (!await first(db,'SELECT 1 FROM products WHERE id=? AND active=1',id)) fail(404,'Không tìm thấy sản phẩm.');
  const productParts=[],productValues=[],unitParts=[],unitValues=[];
  for (const key of ['price_vnd','availability']) if (key in body) {
    productParts.push(`${key}=?`,`${key==='price_vnd'?'price':'availability'}_overridden=1`);productValues.push(body[key]);
  }
  for (const key of ['unit_label','collection_label','condition_note']) if (key in body) {unitParts.push(`${key}=?`);unitValues.push(body[key]);}
  const updates=[];
  if (productParts.length) updates.push(db.prepare(`UPDATE products SET ${productParts.join(',')},updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=? AND active=1`).bind(...productValues,id));
  if (unitParts.length) updates.push(db.prepare(`UPDATE product_units SET ${unitParts.join(',')},updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE product_id=?`).bind(...unitValues,id));
  try {await db.batch(updates);} catch (error) {
    if (/UNIQUE constraint failed: product_units\./i.test(error.message)) fail(409,'Tên món đã dùng trong mẫu này. Đặt tên khác để phân biệt ảnh và hàng.');
    throw error;
  }
  return getProduct(db,id);
}

export async function handleCommerce(request,env,url) {
  const path=url.pathname,method=request.method,db=env.DB;
  const phone=env.SHOP_PHONE||'0326931693';
  const shop={contact_phone:phone,zalo_url:`https://zalo.me/${phone.replace(/\D/g,'')}`};
  if (path==='/api/catalog'&&method==='GET') {
    const products=await getProducts(db),families=await getProductFamilies(db,products);
    const metadata=JSON.parse((await first(db,"SELECT value FROM shop_metadata WHERE key='catalog'"))?.value||'{}');
    return json({products,families,metadata:{...metadata,shop,model_count:families.length,unit_count:products.length}});
  }
  const publicMatch=path.match(/^\/api\/products\/([\w-]+)$/);
  if (publicMatch&&method==='GET') {
    const page=await getProductPage(db,publicMatch[1],url.searchParams.get('variant'));
    if (!page) fail(404,'Không tìm thấy mẫu hoặc món hàng đã chọn.');
    return json({...page,shop});
  }
  if (path==='/api/orders'&&method==='POST') {
    const result=await placeOrder(env,await readJson(request));
    return json({order:result.order},result.repeated?200:201);
  }
  if (path==='/api/admin/products'&&method==='GET') return json({products:await getProducts(db)});
  const productMatch=path.match(/^\/api\/admin\/products\/([\w-]+)$/);
  if (productMatch&&method==='PATCH') return json({product:await updateProduct(db,productMatch[1],await readJson(request))});
  if (path==='/api/admin/orders'&&method==='GET') {
    const cipher=await verifyOrderKey(env);
    const rows=await all(db,'SELECT * FROM orders ORDER BY created_at DESC,id DESC');
    // Fetch all lines in one query to keep the D1 invocation below 50 queries.
    const lines=await all(db,`SELECT i.order_id,i.product_id,i.product_name,i.unit_price,i.quantity,i.line_total,
      o.family_name,o.unit_label,o.collection_label,o.condition_note FROM order_items i LEFT JOIN order_item_options o ON o.order_item_id=i.id ORDER BY i.id`);
    const byOrder=new Map();
    for (const {order_id,...line} of lines) {if (!byOrder.has(order_id)) byOrder.set(order_id,[]);byOrder.get(order_id).push(line);}
    const orders=rows.map(row=>{
      const {idempotency_key,request_hash,...order}=row;
      for (const field of PRIVATE_FIELDS) order[field]=cipher.decrypt(order.id,field,order[field]);
      return {...order,items:byOrder.get(order.id)||[]};
    });
    return json({orders});
  }
  const orderMatch=path.match(/^\/api\/admin\/orders\/([a-f0-9-]+)$/i);
  if (orderMatch&&method==='PATCH') {
    const body=await readJson(request);
    if (Object.keys(body).some(key=>key!=='status')||!['pending','confirmed','shipping','completed','cancelled'].includes(body.status)) fail(400,'Trạng thái đơn hàng không hợp lệ.');
    const cipher=await verifyOrderKey(env);
    const row=await db.prepare("UPDATE orders SET status=?,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=? RETURNING *").bind(body.status,orderMatch[1]).first();
    if (!row) fail(404,'Không tìm thấy đơn hàng.');
    return json({order:await orderRecord(db,row,cipher,true)});
  }
  return null;
}
