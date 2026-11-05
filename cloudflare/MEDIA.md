# Ảnh và video miễn phí trên Cloudflare

Ảnh danh mục đi cùng website. Media mới được nén và đóng số **0326931693** trên máy, rồi tải qua **Quản trị → sản phẩm → Ảnh / video**. Cloudflare không chạy Python/FFmpeg. Bản này dùng **Workers KV Free**, không cần R2 hay thông tin thanh toán.

Trong thư mục dự án, chạy bằng Python đã cài Pillow và FFmpeg:

```powershell
.\.venv\Scripts\python.exe scripts\prepare_cloudflare_media.py --input "D:\Video\blue-ressha.mp4" --product sentai-row-84
```

Đổi `--product` thành mã của đúng chiếc đang quản lý. Mặc định giữ nét (ảnh WebP 90, video H.264 CRF 18); thêm `--quality original` để giữ độ phân giải với WebP 95 / CRF 17. Không phóng lớn nguồn nhỏ; nén vẫn có mất dữ liệu. Số điện thoại được đóng vào pixel ảnh và từng khung hình; metadata nguồn không được đưa vào bản công khai.

Lệnh in ra thư mục kết quả trong `data/cloudflare-media/`. Trên trang quản lý đúng chiếc, chọn cùng lúc **manifest.json**, **image.webp** hoặc **video.mp4**, và **poster.webp**. Mỗi lượt một bộ file. Website kiểm tra mã sản phẩm, số đóng dấu, kích thước và SHA-256 từng phần. File gốc ở lại máy; chỉ bản đã xử lý và ảnh xem trước được tải lên.

Ảnh nguồn tối đa 25 MiB, video nguồn tối đa 300 MiB và 10 phút. **Bản đã xử lý tối đa 25 MiB cho ảnh, 200 MiB cho video**, tải theo phần 5 MiB. File quá lớn được báo lỗi; công cụ không tự hạ chất lượng thêm. Video lớn cần nguồn ngắn hơn hoặc tự xuất lại trước khi xử lý.

KV đồng bộ giữa các vị trí theo thời gian. Website chờ ít nhất **65 giây sau khi tải đủ file** trước khi đưa media vào danh mục. Nếu phần file chưa sẵn sàng tại nơi truy cập, đường dẫn trả `503` với `Retry-After: 60`, không trả giả `404`. File chưa tải xong không được đọc để tránh cache kết quả vắng mặt. Dữ liệu đã có được cache nội bộ KV tối thiểu 60 giây, nhưng đường dẫn ứng dụng luôn kiểm tra D1 và không cache phản hồi công khai.

Kho có giới hạn ứng dụng **900 MiB được dành chỗ**, tính cả file đang tải, poster, file đã gỡ đang chờ dọn và lượt tải chưa xác minh. Đây là khoảng đệm dưới hạn mức KV Free **1 GB trên toàn tài khoản**; không dùng phần còn lại của tài khoản cho ứng dụng khác mà không tính lại giới hạn. Trang media hiển thị số byte đã lưu, đã dành chỗ và hạn mức. Một video 200 MiB cần tối đa 40 lượt đọc KV khi tải toàn bộ; tua chỉ đọc phần liên quan. KV Free có **100.000 lượt đọc/ngày**, vì vậy nhiều lần xem video có thể hết hạn mức dù dung lượng còn trống. Không có bảo đảm CPU10ms cho mọi video trên môi trường thật.

Ứng dụng dừng nhận thao tác ghi/xóa khi tổng lượt đã dành trong ngày UTC đạt **800**, để chừa khoảng đệm dưới hạn mức KV Free. Ngày mới bắt đầu lúc **07:00 giờ Việt Nam**. Thao tác thất bại vẫn tính vào giới hạn dự phòng này. Các giới hạn được kiểm tra bằng D1 trong giao dịch, nên các lượt tải đồng thời không vượt phần dung lượng đã dành. Nguồn: [KV pricing](https://developers.cloudflare.com/kv/platform/pricing/), [KV limits](https://developers.cloudflare.com/kv/platform/limits/).

Gỡ media ẩn ngay khỏi sản phẩm. Dọn kho xóa các phần đã tải và poster; chỉ trả lại phần dung lượng sau khi mọi lệnh xóa đã thành công và chờ thêm 65 giây. Dùng nút **Dọn file đã gỡ**, API quản trị `POST /api/admin/media/cleanup`, hoặc tác vụ dọn định kỳ. Mỗi lượt dọn xử lý tối đa 10 phần. Lượt tải bị bỏ dở quá 24 giờ được đánh dấu để dọn.

Nếu Worker dừng hoặc mất quyền giữa lúc ghi file vào KV, hệ thống giữ một dấu ghi đang thực hiện và giữ nguyên phần dung lượng. **Dấu này không tự hết hạn:** chỉ thời gian trôi qua không đủ để chứng minh lệnh ghi đã kết thúc. Việc giữ chỗ có thể cần quản trị kiểm tra thủ công khi một lượt tải bị ngắt; không xóa dấu hoặc trả lại dung lượng khi chưa xác minh. Cách này tránh file đến muộn xuất hiện lại sau khi đã dọn. Bản gốc trên máy luôn được giữ.

Binding cần có tên `MEDIA_KV`; D1 cần các migration `0004_kv_media.sql` và `0005_kv_write_markers.sql`. Nếu chưa kết nối KV, cửa hàng và ảnh danh mục vẫn hoạt động, còn giao diện tải media hiển thị chưa kết nối kho.

CLI tùy chọn `scripts/publish_cloudflare_media.mjs --bundle THƯ_MỤC --url https://CỬA_HÀNG` dùng phiên quản trị từ biến môi trường `SENTAI_SESSION_TOKEN`, gửi cookie `sentai_session` và kiểm tra CSRF như giao diện web. Không truyền token trong dòng lệnh, Git hoặc chat. Cách thông thường là đăng nhập bằng passkey và tải trực tiếp trên trang quản lý media.
