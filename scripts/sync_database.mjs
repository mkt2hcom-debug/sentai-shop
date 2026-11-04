import { openDatabase, syncCatalog } from '../lib/database.mjs';
const db = openDatabase();
try { console.log(`Đã đồng bộ ${syncCatalog(db)} sản phẩm vào SQLite; giữ nguyên đơn hàng và giá/trạng thái đã chỉnh trong quản trị.`); }
finally { db.close(); }
await import('./export_database.mjs');
