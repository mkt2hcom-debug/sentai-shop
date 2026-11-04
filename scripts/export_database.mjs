import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ROOT, openDatabase, syncCatalog } from '../lib/database.mjs';
const db = openDatabase();
try {
  if (!db.prepare('SELECT count(*) n FROM products').get().n) syncCatalog(db);
  const quote = value => value == null ? 'NULL' : typeof value === 'number' ? String(value) : `'${String(value).replaceAll("'", "''")}'`;
  let sql = '-- SQLite: schema + catalog. Không xuất dữ liệu cá nhân hoặc đơn hàng.\n' + readFileSync(resolve(ROOT,'database/schema.sql'),'utf8') + '\nBEGIN TRANSACTION;\n';
  for (const table of ['products','product_families','product_units','shop_metadata','product_media']) {
    for (const row of db.prepare(`SELECT * FROM ${table}`).all()) {
      sql += `INSERT OR IGNORE INTO ${table} (${Object.keys(row).map(k=>`"${k}"`).join(',')}) VALUES (${Object.values(row).map(quote).join(',')});\n`;
    }
  }
  sql += 'COMMIT;\n';
  writeFileSync(resolve(ROOT,'database/catalog.sql'),sql);
  console.log('Đã xuất database/catalog.sql (cấu trúc SQL và danh mục sản phẩm).');
} finally { db.close(); }
