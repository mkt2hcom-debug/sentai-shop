import { restoreEncryptedBackup, verifyEncryptedBackup } from '../lib/backup.mjs';

try {
  const args = process.argv.slice(2);
  const options = {};
  let verify = false;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--verify' && !verify) { verify = true; continue; }
    const option = {'--input': 'inputPath', '--output': 'outputDirectory', '--key': 'backupKeyPath'}[arg];
    if (!option || options[option] || !args[index + 1] || args[index + 1].startsWith('--')) throw new Error('Dùng --input <tệp> --output <thư mục mới> [--key <tệp khóa>], hoặc --input <tệp> --verify.');
    options[option] = args[++index];
  }
  if (verify && options.outputDirectory) throw new Error('--verify chỉ kiểm tra; không dùng kèm --output.');
  if (verify) {
    const result = await verifyEncryptedBackup(options);
    console.log(`Bản sao lưu hợp lệ; thời điểm tạo: ${result.createdAt}.`);
  } else {
    const result = await restoreEncryptedBackup(options);
    console.log(`Đã xác thực và giải nén SQL vào: ${result.databasePath}`);
    if (result.orderKeyPath) console.log(`Khóa dữ liệu đơn hàng: ${result.orderKeyPath}`);
    console.log('Dữ liệu website đang chạy không thay đổi. Bản này không gồm hình ảnh/video.');
  }
} catch (error) {
  console.error(`Chưa khôi phục được: ${error.message}`);
  process.exitCode = 1;
}
