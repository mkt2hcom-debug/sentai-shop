import { openDatabase } from '../lib/database.mjs';
import { createAdminAuth, AdminAuthError } from '../lib/admin-auth.mjs';

let db;
try {
  // Validate configuration before opening SQLite or rotating a recovery token.
  if (process.env.PUBLIC_ORIGIN) {
    throw new Error('Khôi phục này chỉ dùng trên máy chạy web tại localhost. Tạm bỏ PUBLIC_ORIGIN và khởi động lại máy chủ cục bộ trước khi chạy lệnh.');
  }
  const password = process.env.ADMIN_PASSWORD || '';
  if (password.length >= 12) {
    throw new Error('ADMIN_PASSWORD đang được cấu hình trong .env. Muốn đặt lại tài khoản lưu trong SQL, để trống ADMIN_PASSWORD rồi khởi động lại máy chủ trước khi chạy lệnh này.');
  }
  const rawPort = process.env.PORT || '3000';
  const port = Number(rawPort);
  if (!/^\d+$/.test(rawPort) || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('PORT cần là số nguyên từ 1 đến 65535. Sửa PORT trong .env rồi chạy lại.');
  }
  db = openDatabase();
  const auth = createAdminAuth({db, password, username:process.env.ADMIN_USERNAME || 'admin'});
  const recovery = auth.issueRecovery();
  const url = new URL(`http://127.0.0.1:${port}/admin`);
  url.hash = `reset=${encodeURIComponent(recovery.token)}`;
  const expires = new Date(recovery.expires_at).toLocaleString('vi-VN', {
    timeZone:'Asia/Ho_Chi_Minh', dateStyle:'short', timeStyle:'medium'
  });
  console.log('Mở liên kết này trên chính máy đang chạy web để chọn tài khoản và mật khẩu mới:');
  console.log(url.href);
  console.log(`Liên kết dùng một lần, hết hạn lúc ${expires} (giờ Việt Nam).`);
  console.log('Tạo liên kết mới sẽ hủy liên kết cũ. Dữ liệu cửa hàng được giữ nguyên.');
} catch (error) {
  console.error(error instanceof AdminAuthError ? error.message : `Chưa tạo được liên kết khôi phục: ${error.message}`);
  process.exitCode = 1;
} finally {
  db?.close();
}
