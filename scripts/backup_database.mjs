import { createEncryptedBackup } from '../lib/backup.mjs';

try {
  if (process.argv.length > 2) throw new Error('Lệnh này đọc DB_PATH, DATA_ENCRYPTION_KEY_FILE và BACKUP_ENCRYPTION_KEY_FILE từ .env; không nhận tham số khác.');
  const result = await createEncryptedBackup();
  console.log(`Đã mã hóa và kiểm tra bản sao SQL: ${result.path}`);
  console.log(result.includesOrderKey ? 'Đã kèm khóa giải mã dữ liệu đơn hàng trong tệp mã hóa.' : 'Database chưa sử dụng khóa mã hóa dữ liệu đơn hàng.');
  console.log('Giữ riêng khóa sao lưu ở nơi an toàn. Bản này không gồm hình ảnh/video.');
} catch (error) {
  console.error(`Chưa sao lưu được: ${error.message}`);
  process.exitCode = 1;
}
