# Sentai Shop

Cửa hàng Cloudflare: **https://sentai-shop.mkt2h-sentai.workers.dev**. Mở `START-CLOUDFLARE-ADMIN.cmd` trên máy quản lý để đăng nhập lần đầu và thêm passkey. Hướng dẫn chuyển dữ liệu, cập nhật và media: [Cloudflare](cloudflare/README.md).

[Chạy và chuyển dữ liệu lên Cloudflare Workers/D1](cloudflare/README.md) · [Chuẩn bị ảnh/video trên máy để tải lên Cloudflare](cloudflare/MEDIA.md)

Web bán mô hình Sentai sử dụng dữ liệu và ảnh có sẵn trong `SEntai.xlsx`. Giao diện tiếng Việt phong cách galaxy huyền bí, hỗ trợ điện thoại, máy chủ Node.js và cơ sở dữ liệu **SQLite SQL lưu trên ổ đĩa**. Không cần cài thêm thư viện npm hay máy chủ MySQL.

## Chạy trên máy

Máy cần Node.js từ **22.23.2** trở lên. Phiên bản đang dùng để kiểm thử: 22.23.2. Tại thư mục dự án:

```powershell
cd 'D:\web sentai'
npm start
```

Mở **http://127.0.0.1:3000**. Có thể nhấp đúp `START-SENTAI.cmd`. Nhấn Ctrl+C trong cửa sổ máy chủ để dừng. Nếu cổng 3000 đang dùng, đặt `PORT=3001` trong `.env` và mở địa chỉ tương ứng.

Danh mục và ảnh đã được trích xuất. Lần chạy đầu tự tạo `data/sentai.sqlite`; những lần sau giữ dữ liệu, đơn hàng và thay đổi quản trị. Cảnh báo `ExperimentalWarning: SQLite` trên Node.js 22 là cảnh báo từ API tích hợp của Node, không phải lỗi khởi động. [Tài liệu Node.js SQLite](https://nodejs.org/download/release/latest-jod/docs/api/sqlite.html).

## Quản trị

1. Mở **http://127.0.0.1:3000/admin** ngay trên máy chạy website.
2. Lần đầu, chọn **Tạo tài khoản quản trị**, đặt tên tài khoản và mật khẩu riêng từ 15 đến 128 ký tự rồi xác nhận. Tên tài khoản có 3–40 ký tự, bắt đầu bằng chữ cái, dùng chữ cái không dấu, số, dấu chấm, gạch dưới hoặc gạch ngang. Tên được chuyển về chữ thường; mật khẩu được lưu dưới dạng mã băm trong SQLite.
3. Những lần sau đăng nhập bằng **tài khoản và mật khẩu**. Các cửa hàng đã thiết lập trước khi có ô tài khoản dùng tên **`admin`**, giữ nguyên mật khẩu cũ.

Thiết lập lần đầu chỉ hoạt động trên localhost khi chưa có tài khoản và chưa cấu hình địa chỉ công khai. Khi triển khai máy chủ thật, có thể cấu hình `ADMIN_PASSWORD` (ít nhất 12 ký tự) và `ADMIN_USERNAME` (mặc định `admin`) trong `.env`; cặp này ưu tiên hơn tài khoản trong database. Đây là một tài khoản chủ cửa hàng. Giữ nguyên những cấu hình đang có khi sửa `.env`.

Quản trị cho phép xem đơn và thông tin giao hàng, cập nhật trạng thái đơn, chỉnh giá hoặc bỏ giá để chuyển về chờ báo giá, đánh dấu sản phẩm còn hàng/chưa xác nhận/đã bán, tải ảnh/video và lưu giá tham khảo hội nhóm. API quản trị luôn yêu cầu đăng nhập sau khi thiết lập. Phiên đăng nhập hết hạn sau 15 phút không có yêu cầu được xác thực hoặc tối đa 8 giờ; kết thúc khi đăng xuất, máy chủ khởi động lại hoặc tài khoản được đặt lại.

### Quên mật khẩu

Trên **chính máy chạy website**, nhấp đúp `RESET-ADMIN.cmd`, hoặc chạy:

```powershell
npm run admin:reset
```

Mở liên kết được in ra trong cửa sổ lệnh, chọn tài khoản và mật khẩu mới. Liên kết chỉ dùng một lần, hết hạn sau **20 phút**; tạo liên kết mới sẽ hủy liên kết trước. Link chứa mã khôi phục trong phần `#reset=...`, không gửi mã qua địa chỉ GET. SQL chỉ lưu mã băm của mã khôi phục. Không gửi link này cho người khác.

Web cần đang chạy tại localhost. Nếu đã đặt `PUBLIC_ORIGIN` hoặc `ADMIN_PASSWORD`, lệnh sẽ chỉ cách tạm bỏ cấu hình đó và khởi động lại trước khi khôi phục tài khoản SQL. Nếu đang dùng mật khẩu môi trường, cũng có thể thay trực tiếp `ADMIN_PASSWORD` trong `.env` và khởi động lại. Việc khôi phục giữ nguyên sản phẩm, đơn hàng, ảnh/video và thống kê truy cập; không cần xóa database. Chưa có khôi phục qua email.

## Giá tham khảo từ nhóm Facebook

Mở **http://127.0.0.1:3000/admin/prices**, hoặc chọn **Giá tham khảo hội nhóm** trong quản trị. Tính năng tìm theo từ khóa trong những nhóm cụ thể bạn đã tham gia; không tự tìm hay tham gia nhóm mới.

Thiết lập một lần trên máy có Python 3.10+:

```powershell
npm run prices:setup
```

Lệnh cài Playwright và Chromium vào môi trường Python `.venv` hiện có, giữ bộ xử lý ảnh/video. Sau đó:

1. Chọn **Mở Facebook để đăng nhập**. Tự đăng nhập trong cửa sổ Facebook riêng vừa mở trên máy chạy website; xác minh nếu Facebook yêu cầu. Đóng cửa sổ khi xong. Việc đóng cửa sổ chưa xác nhận đăng nhập thành công; lượt tìm sẽ kiểm tra quyền xem thực tế.
2. Lưu tên và link nhóm dạng `https://www.facebook.com/groups/ID-hoặc-tên/`. Không dùng link chia sẻ rút gọn. Với link bài dùng ID nhóm dạng số, nên lưu nhóm bằng cùng ID để đối chiếu đúng nguồn.
3. Chọn sản phẩm và từ khóa cần tìm, ví dụ `DX Kiramaizin`. Có thể lưu nhiều tên gọi khác thành các từ khóa riêng.
4. Chọn từ 1 đến 3 nhóm, giới hạn 10/20/50 bài mỗi nhóm rồi bấm **Tìm bài & lưu giá**. Các lượt chạy tuần tự; tối đa 6 lượt đang chờ/xử lý. Chưa có lịch quét tự động.
5. Kiểm tra giá, tình trạng, đoạn nội dung và **Mở bài gốc**. Đánh dấu đã kiểm tra/bỏ qua để quản lý tư liệu. Giá bán trong cửa hàng được chỉnh ở trang sản phẩm, không bị tự ghi đè từ bài nhóm.

Bộ đọc dùng trang tìm kiếm nhóm mà tài khoản xem được, chỉ thu thập nội dung bài và đường dẫn cần đối chiếu. Không đăng bài, bình luận, nhắn tin hay thu thập danh sách thành viên. Phiên Facebook được lưu riêng tại `data/prices/facebook-profile`, ngoài thư mục công khai và được loại khỏi Git; không gửi mật khẩu/cookie qua chat hoặc đưa thư mục này lên hosting công khai. Nút đăng nhập chỉ dùng được khi mở quản trị tại localhost trên chính máy chủ. Đóng cửa sổ Facebook trước khi quét để tránh dùng đồng thời một phiên.

Giá `850k`, `1tr2`, `1.200.000đ` được phân tích theo quy tắc tiếng Việt. Tiền cọc, phí ship, combo, bài tìm mua, nhiều giá hoặc ghép tên chưa rõ được tách/đánh dấu để kiểm tra. Bài thiếu giá vẫn được lưu nếu khớp từ khóa. Hiện chỉ đọc giá trong chữ của bài, chưa đọc giá trong ảnh hoặc lấy giá từ bình luận. Cùng bài và nội dung được bỏ trùng; khi bài sửa nội dung, bản quan sát mới được giữ để so sánh. Ngày đăng chưa đọc được thì để trống, không dùng ngày thu thập thay thế.

Facebook có thể chỉ trả một phần kết quả, yêu cầu đăng nhập/xác minh hoặc thay đổi giao diện. Vì vậy trạng thái **Kết quả một phần**, **Cần đăng nhập**, **Không lấy được bài** được hiển thị riêng; kết quả trống không tự được coi là không có bài bán. Mỗi lượt tối đa 50 bài/15 lần cuộn/100 giây đọc; không xác nhận đã tìm hết lịch sử nhóm. Chưa kiểm chứng thu thập trên nhóm thật nếu chưa có link nhóm và phiên đăng nhập của bạn. Có thể dùng **Lưu bài thủ công** để dán nội dung/link thật khi bộ đọc tự động chưa lấy được dữ liệu.

SQL lưu nhóm, từ khóa, các lượt tìm và giá tham khảo trong `price_groups`, `price_keywords`, `price_scans`, `price_observations`. Nội dung bài chỉ có trong API quản trị, không nằm trong danh mục công khai hoặc bản xuất `database/catalog.sql`. Trang hiện tối đa 200 quan sát gần nhất; dữ liệu cũ vẫn nằm trong SQL. Ngừng theo dõi nhóm/từ khóa giữ lịch sử đã thu thập. Lượt quét bị ngắt do máy chủ dừng được đánh dấu thất bại; chủ cửa hàng bấm quét lại khi sẵn sàng.

## Trang chi tiết, ảnh và video

Danh mục hiện có **119 mẫu, gồm 144 món hàng thực tế**. Các món cùng tên hoặc cặp đánh số cuối `01`/`02` được trình bày trong một trang mẫu, ví dụ **Blue Ressha → Món 01 / Món 02**. Cặp đánh số chỉ được gộp khi cùng dòng Sentai và có các số thứ tự tương ứng; số nằm trong tên mẫu hoặc số đơn lẻ được giữ nguyên. Các bản ghi rõ `China`, `Chỉ Đầu`, `Full Box`/`Nobox` vẫn là các mẫu riêng để tránh gộp nhầm phiên bản.

Nhấp ảnh hoặc tên để mở trang mẫu rồi chọn **BST/lô hàng → món hàng**. Mỗi món giữ mã riêng, giá, tình trạng, ảnh/video và trạng thái bán riêng. Link cũ như **http://127.0.0.1:3000/products/sentai-row-84** vẫn mở đúng món đó, rồi chuyển địa chỉ sang trang mẫu có `?variant=sentai-row-84`. Sao chép liên kết và nút Back giữ đúng lựa chọn.

Trong **Quản trị → Sản phẩm → Chỉnh sửa**, hoặc ngay phần thông tin của Media Studio, có thể đặt tên món, **BST/lô hàng** (ví dụ BST tháng 11) và mô tả độ mới, vết xước, phụ kiện, phần hỏng/đã sửa. BST để trống dùng tên dòng Sentai từ danh mục. Không tự suy ra phần trăm độ mới. Các chỉnh sửa này được lưu riêng trong SQL và không mất khi nhập lại Excel.

Giỏ hàng và đơn hàng lưu từng mã món, mỗi món số lượng **1**. Muốn mua hai chiếc cùng mẫu phải chọn hai món khác nhau. Đơn mới giữ bản chụp tên món, BST và tình trạng tại lúc đặt, nên việc sửa mô tả sau đó không đổi thông tin đơn cũ. Đây vẫn là yêu cầu mua chờ cửa hàng xác nhận, chưa có cơ chế giữ chỗ hàng tự động.

Trang chi tiết hiển thị bộ ảnh và khu vực video của **món đang chọn**, có phát/tua video, phóng to ảnh và thêm đúng món vào giỏ. Khi đổi món, video cũ được dừng và toàn bộ media đổi theo mã món; không dùng ảnh/video tải lên của món khác làm dự phòng. Ảnh lấy từ Excel được ghi rõ **Ảnh từ danh mục — chưa xác nhận ảnh thực tế của món**. Khi chưa tải ảnh thực tế, thông báo này được hiển thị ngay trên ảnh danh mục.

Để tải media:

1. Vào **Quản trị → Sản phẩm → Ảnh / video**, hoặc bấm **Quản lý ảnh & video** trong trang chi tiết của món đang chọn.
2. Kiểm tra dòng **Đang quản lý** và **File sẽ thuộc**. Chọn Món 01, Món 02… trong ô chuyển món; mỗi món mở thư viện riêng. Khi đang tải file, ô chuyển món được khóa để giữ đúng đích tải.
3. Chọn hoặc kéo thả ảnh/video thực tế của món đó, nên có ảnh toàn cảnh, phụ kiện và cận cảnh phần trầy/hỏng. Hệ thống hiển thị tiến trình tải, rồi trạng thái nén và chèn watermark.
4. Khi hoàn tất, ảnh/video xuất hiện ở đúng lựa chọn trên trang mẫu. Có thể xem trước hoặc gỡ từng file. SQL `product_media.product_id` luôn gắn với mã món thực tế, không đổi thành mã mẫu.

Số **0326931693** từ `SHOP_PHONE` được đóng trực tiếp vào góc dưới phải của ảnh và mọi khung hình video, không phải lớp chữ của trình duyệt. Ảnh từ Excel không bị ghi đè; watermark áp dụng cho các file tải lên mới. Bản gốc được giữ riêng tại `data/media/originals`, không có đường dẫn công khai.

Hai mức chất lượng:

- **Giữ nét:** ảnh WebP chất lượng 90, cạnh dài tối đa 2560 px; video MP4 H.264 CRF 18, cạnh dài tối đa 1920 px, âm thanh AAC nếu bản gốc có tiếng.
- **Giữ độ phân giải gốc:** giữ kích thước ảnh, video chỉ làm tròn số chẵn cần thiết; ảnh WebP chất lượng 95 và video CRF 17. Vẫn có nén mất dữ liệu ở mức cao, không phải bản sao lossless.

Hệ thống giữ tỷ lệ, xử lý hướng xoay và không phóng lớn nguồn nhỏ. Chất lượng còn phụ thuộc file nguồn; nén không khôi phục được ảnh/video vốn mờ. File đã nén mạnh có thể tăng dung lượng khi thêm watermark; giao diện hiển thị số byte trước và sau thực tế.

Giới hạn: ảnh JPEG/PNG/WebP tĩnh tối đa 25 MB, video MP4/MOV/WebM tối đa 300 MB và 10 phút; mỗi sản phẩm tối đa 60 media tải lên. Ảnh tối đa 80 triệu điểm ảnh, video tối đa 16 triệu điểm ảnh/khung, mỗi chiều ít nhất 64 px. Video HDR/màu rộng cần xuất về SDR Rec.709 trước khi tải để tránh sai màu; ảnh động, HEIC và playlist chưa được hỗ trợ. File giả đuôi hoặc hỏng sẽ bị từ chối. Metadata EXIF/GPS được loại khỏi bản công khai.

Máy hiện tại đã thiết lập bộ xử lý. Khi chuyển sang máy khác, cần Python 3.10+, FFmpeg và FFprobe trong PATH, rồi chạy một lần:

```powershell
npm run media:setup
```

Lệnh tạo môi trường `.venv` riêng và cài Pillow theo `requirements-media.txt`. Có thể đặt `PYTHON_PATH`, `FFMPEG_PATH`, `FFPROBE_PATH` trong `.env` nếu công cụ ở vị trí riêng. Xem [tài liệu định dạng Pillow](https://pillow.readthedocs.io/en/stable/handbook/image-file-formats.html#webp) về chất lượng WebP.

Hàng đợi xử lý tuần tự được lưu trong SQL; tải xong có thể rời trang rồi quay lại. File đang xử lý sẽ được tiếp tục từ bản gốc sau khi máy chủ khởi động lại; file chưa tải xong cần chọn lại. Chỉ chạy một máy chủ trên cùng thư mục media. Gỡ media ẩn bản hiển thị khỏi trang và ngừng phục vụ đường dẫn đó, bản gốc vẫn được giữ để phục hồi.

## Chức năng

- Danh mục 119 mẫu / 144 món, ảnh, chi tiết phụ kiện và tình trạng từ Excel.
- Tìm kiếm, lọc dòng sản phẩm, sắp xếp, xem chi tiết và ảnh.
- Giỏ hàng lưu trong trình duyệt, mỗi món cũ riêng số lượng 1; chọn thêm món khác hoặc xóa món.
- Gửi yêu cầu đặt hàng COD, lưu đơn và các dòng sản phẩm trong SQL.
- Máy chủ tự tính giá từ database; không tin số tiền do trình duyệt gửi lên.
- Gửi lại cùng yêu cầu không tạo đơn trùng; sản phẩm đã bán/chưa báo giá không được đặt mua.
- Quản trị được bảo vệ bằng mật khẩu, cookie HttpOnly, giới hạn đăng nhập và kiểm tra nguồn yêu cầu.

Đây là **yêu cầu đặt hàng chờ cửa hàng xác nhận**. Chưa tích hợp thanh toán trực tuyến, đơn vị vận chuyển hay gửi email/SMS. Mỗi dòng danh mục được quản lý như một món hàng cũ riêng; phí vận chuyển và khả năng giao đúng món cần cửa hàng xác nhận. Chưa tự giữ chỗ hoặc đánh dấu đã bán khi khách vừa gửi yêu cầu. Điền `SHOP_PHONE` trong `.env` và khởi động lại để hiện số điện thoại/Zalo thật cho khách hỏi giá. Khi chưa có thông tin liên hệ, cửa hàng chỉ hiển thị thông báo chờ cập nhật giá.

## Thống kê truy cập

Vào **Quản trị → Thống kê truy cập** (`/admin/analytics`). Chọn khoảng ngày, xem biểu đồ theo **ngày / tháng / năm**, tìm trang hoặc sản phẩm và sắp xếp theo lượt xem, phiên truy cập, lần xem gần nhất hoặc tên. Bảng có ba chế độ: trang, mẫu sản phẩm và từng chiếc riêng.

- Một lượt xem được ghi khi trang cửa hàng tải thành công, mở chi tiết hoặc đổi sang chiếc khác. Gửi lại cùng sự kiện không tăng lượt xem. Trang quản trị, ảnh, video và các lần đọc API không được tính là lượt xem trang.
- Lượt xem sản phẩm là phần lượt xem thuộc trang chi tiết. Hai chiếc cùng mẫu được cộng vào mẫu đó; chế độ từng chiếc vẫn phân biệt ID riêng. Tổng biểu đồ/số tổng theo khoảng ngày; tìm kiếm chỉ lọc bảng xếp hạng.
- Ngày thống kê theo giờ Việt Nam (UTC+7), bao gồm cả ngày bắt đầu và kết thúc. Dữ liệu chỉ có từ khi bật tính năng; các khoảng trống hiển thị 0, không phục dựng lượt truy cập cũ.
- **Phiên truy cập** là mã ngẫu nhiên của trình duyệt, tạo phiên mới sau 30 phút không hoạt động; đây không phải số người duy nhất. Không lưu IP, thông tin liên hệ, referrer hoặc tham số URL trong thống kê. Trình duyệt chặn JavaScript/lưu trữ, bật Do Not Track/Global Privacy Control hoặc chặn theo dõi có thể không được ghi hoặc không gộp phiên đầy đủ.
- Dữ liệu nằm trong các bảng `analytics_*` của SQLite, chỉ quản trị đã đăng nhập được xem báo cáo. `db:export` xuất danh mục, không xuất lịch sử truy cập; sao lưu database thực tế để giữ thống kê.

## Dữ liệu nguồn

Đã nhập 144 dòng sản phẩm từ sheet `mecha`, 122 ảnh gốc với 144 liên kết ảnh. Một số sản phẩm dùng cùng ảnh nguồn. Có 26 sản phẩm có đơn giá (200.000–1.250.000 đồng), 118 sản phẩm chưa có giá và 1 sản phẩm ghi rõ đã bán. Tình trạng vật lý ở cột G được giữ nguyên, không bị hiểu thành số lượng tồn kho. Giá bán lấy **cột I — Đơn giá**, không lấy cột J — Thành tiền.

SKU trùng hoặc thiếu vẫn được giữ lại: mỗi dòng có ID `sentai-row-<số dòng>`, nên không mất sản phẩm. Cần giữ nguyên vị trí, tên, SKU và dòng Sentai của các dòng cũ khi cập nhật Excel. Đồng bộ sẽ dừng và giữ nguyên SQL nếu các định danh này đổi, để tránh gán giá hoặc giỏ hàng cũ sang sản phẩm khác. Có thể sửa giá, mô tả, ảnh và thêm sản phẩm ở cuối danh mục; việc đổi tên/di chuyển sản phẩm đã nhập cần thực hiện di chuyển dữ liệu có chủ đích.

File Excel gốc được giữ nguyên. `data/import-report.json` ghi chi tiết dữ liệu thiếu, SKU trùng, liên kết ảnh và nguồn; `data/catalog.json` chứa danh mục được trích xuất.

Sau khi cập nhật Excel, cần Python 3.10+ và chạy:

```powershell
npm run db:import
```

Importer chỉ dùng thư viện chuẩn Python. Ảnh được lấy từ vị trí neo trong Excel và sao chép nguyên byte; không tải ảnh thay thế từ Internet. Nhập lại giữ nguyên đơn hàng, giá và trạng thái đã sửa trong quản trị. Sản phẩm không còn trong Excel được ẩn khỏi cửa hàng nhưng vẫn tồn tại để giữ lịch sử đơn hàng.

## Cơ sở dữ liệu SQL

- `data/sentai.sqlite`: database thực tế, lưu sản phẩm và đơn hàng.
- `database/schema.sql`: cấu trúc bảng, ràng buộc và chỉ mục.
- `database/catalog.sql`: cấu trúc và dữ liệu danh mục, có thể mở bằng công cụ quản lý SQLite.
- Bảng `products` giữ từng món; `product_families` giữ mẫu, `product_units` lưu liên kết mẫu và thông tin BST/tình trạng. `order_item_options` giữ thông tin lựa chọn tại thời điểm đặt.
- Các bảng khác: `orders`, `order_items`, `shop_metadata`, `product_media`, `media_jobs`, `admin_credentials` và các bảng `price_*` dành riêng cho tham khảo giá quản trị.

Đây là SQL dành cho **SQLite**, không phải cú pháp nhập trực tiếp vào MySQL hoặc SQL Server. Có thể tạo database mới từ `catalog.sql` bằng SQLite CLI:

```text
sqlite3 sentai-new.sqlite ".read database/catalog.sql"
```

Xuất lại danh mục sau khi chỉnh giá trong quản trị:

```powershell
npm run db:export
```

File xuất này chứa danh mục và thông tin media, không chứa mật khẩu quản trị, thông tin khách hàng hay đơn hàng. Khi chuyển máy, cần sao chép thêm các file media tương ứng. Để sao lưu SQL an toàn, dùng lệnh mã hóa bên dưới. Một bản đầy đủ còn cần media và ảnh danh mục; bản SQL không chứa các file này. Không xóa database hoặc khóa mã hóa khi cập nhật mã nguồn.

## Kiểm tra

```powershell
npm run check
npm test
```

Kiểm thử dùng database và thư mục media tạm riêng, kiểm tra đặt hàng, đăng nhập/thiết lập, quyền tải lên, xử lý ảnh/video thật, watermark, tiếp tục hàng đợi, tải trùng và tua video bằng HTTP Range. Cần chạy `npm run media:setup` và có FFmpeg/FFprobe trước các kiểm thử media. Không tạo đơn hoặc media thử trong database bán hàng.

## Cấu trúc

```text
SEntai.xlsx                 File nguồn
server.mjs                  Máy chủ HTTP và API
lib/database.mjs            Truy cập SQL và đồng bộ danh mục
public/                     Giao diện cửa hàng, quản trị, ảnh
database/                   Schema và SQL danh mục
data/                       Danh mục, báo cáo nhập và SQLite
scripts/                    Nhập Excel và xuất SQL
tests/                      Kiểm thử API
```

Máy chủ mặc định chỉ mở trên máy hiện tại (`127.0.0.1`). Khi triển khai lên máy chủ thật, cấu hình HTTPS và `PUBLIC_ORIGIN`, mật khẩu quản trị riêng, thư mục lưu database lâu dài và sao lưu. Mỗi tiến trình dùng một file SQLite; không đặt database trong thư mục `public`. Chưa triển khai lên hosting công khai.


## Bảo mật dữ liệu

Bản này áp dụng một số kiểm soát của [OWASP ASVS 5.0.0](https://asvs.owasp.org/) cho cửa hàng một quản trị viên. Đây là gia cố kỹ thuật đã có kiểm thử, **chưa phải chứng nhận đạt toàn bộ ASVS, ISO 27001 hay tuân thủ pháp luật về dữ liệu**.

- **Thông tin khách:** tên, số điện thoại, email, địa chỉ và ghi chú đơn hàng được mã hóa AES-256-GCM trước khi ghi SQLite. Mỗi giá trị có nonce ngẫu nhiên và được ràng buộc với đơn/trường dữ liệu; dữ liệu bị sửa, mất hoặc sai khóa làm ứng dụng từ chối đọc. Lần mở đầu tự chuyển đơn cũ và dọn bản plaintext trong SQLite/WAL hiện tại. Bản sao cũ trên ổ đĩa vẫn còn. API đặt hàng không trả lại thông tin cá nhân; quản trị đã đăng nhập mới được đọc.
- **Mật khẩu:** tài khoản SQL mới dùng scrypt `N=32768, r=8, p=3`, salt riêng; tối đa 2 tác vụ băm cùng lúc và 8 chờ. Mật khẩu mới 15–128 ký tự, chặn một danh sách ngắn mật khẩu phổ biến. Mật khẩu SQL cũ vẫn đăng nhập được và tự nâng cấp hash sau lần đăng nhập đúng. Giới hạn đăng nhập được lưu SQL để khởi động lại không xóa toàn bộ giới hạn. `ADMIN_PASSWORD` là cấu hình tương thích cũ, vẫn nằm dạng rõ trong `.env`; nên dùng tài khoản SQL. [Hướng dẫn lưu mật khẩu OWASP](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html).
- **Phiên và thao tác:** cookie HttpOnly/SameSite=Strict, Secure khi bật HTTPS; phiên có hạn rỗi 15 phút và hạn tuyệt đối 8 giờ. Các thao tác quản trị yêu cầu CSRF token gắn với phiên, gồm tải file và đăng xuất. Mã khôi phục chỉ dùng một lần trong 20 phút. [Hướng dẫn CSRF OWASP](https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html).
- **HTTP:** kiểm tra Host/Origin, chỉ bind loopback, CSP chặn script bên ngoài/nhúng trang, nosniff, không gửi referrer và không cache phản hồi quản trị. Khi có `PUBLIC_ORIGIN`, chỉ chấp nhận HTTPS hoặc proxy HTTPS trên cùng máy, bật HSTS và cookie Secure. Reverse proxy phải ghi đè `X-Forwarded-Proto=https`, chuyển đúng Host và không public trực tiếp cổng Node.
- **Nhật ký:** bảng `security_events` ghi đăng nhập/đăng xuất/khôi phục, thao tác quản trị và lỗi quyền; chỉ chứa loại sự kiện, phương thức, mã tài nguyên, trạng thái và thời gian. Không ghi body, mật khẩu, token, IP hay thông tin khách. Giữ tối đa 10.000 sự kiện; có API quản trị `GET /api/admin/security/events` để xem 100 sự kiện gần nhất; nhật ký này chưa phải log chống sửa độc lập.
- **File riêng tư:** SQL, khóa, bản gốc media và phiên Facebook ở ngoài `public`; khóa/bản sao không nhận đường dẫn hoặc junction trỏ vào `public`. Đường dẫn tĩnh từ chối symlink thoát khỏi `public`. SQL xuất danh mục không xuất tài khoản, đơn, khóa, nhật ký hoặc thống kê.

Khóa đơn hàng tự tạo tại `data/secrets/order-data.key`, có thể đổi vị trí qua `DATA_ENCRYPTION_KEY_FILE` **trước lần tạo đầu**. Khi chuyển máy phải giữ đúng khóa; không tạo khóa mới để thay khóa đã mất. Mã hóa này không mã hóa toàn bộ SQLite: sản phẩm, thống kê, nội dung bài nhóm, thông tin đơn ngoài 5 trường trên và metadata vẫn đọc được nếu ai đó có file. Khóa nằm trên cùng máy nên không bảo vệ khỏi người chiếm được tài khoản Windows/máy chủ; cần bảo vệ thiết bị, quyền truy cập và bản sao khóa độc lập.

Trên Windows, áp dụng quyền NTFS cho `.env`, `data`, `artifacts`, `backups`:

```powershell
npm run security:permissions
```

Lệnh chỉ cấp quyền cho tài khoản Windows đang chạy, SYSTEM và nhóm Administrators; không thay quyền ngoài các đường dẫn nêu trên. Chạy lại sau khi chép file/bản sao từ nơi khác. Nếu cấu hình DB, media, profile hoặc khóa ở ngoài thư mục dự án, phải đặt quyền tương đương tại các vị trí đó. Các bản SQL dự phòng cũ tại `backups/legacy-plaintext` được hạn chế quyền, **không tự bị xóa hoặc mã hóa lại**. Mã hóa ổ đĩa như BitLocker và tài khoản dịch vụ riêng là phần triển khai của máy chủ.

### Sao lưu và khôi phục

```powershell
npm run db:backup
npm run db:restore -- --input "backups/TEN-FILE.sentai-backup" --verify
npm run db:restore -- --input "backups/TEN-FILE.sentai-backup" --output "D:/recovery/sentai-new"
```

Lệnh backup chụp SQLite cả dữ liệu WAL khi web đang chạy, đóng gói kèm khóa giải mã đơn hàng rồi mã hóa AES-256-GCM; kiểm tra toàn vẹn trước khi báo thành công. File nằm ở `backups/`, khóa sao lưu riêng ở `data/secrets/backup.key` hoặc `BACKUP_ENCRYPTION_KEY_FILE`. Giữ thêm bản sao khóa ở nơi an toàn riêng với archive; mất khóa sao lưu sẽ không đọc được archive. Sao chép cả archive và khóa cùng một nơi không tạo được sự tách biệt khóa.

Restore kiểm tra khóa, dấu xác thực và SQLite trước; chỉ tạo **thư mục đích mới**, thư mục cha phải tồn tại. Có thể truyền `--key "D:/private/backup.key"` khi khôi phục trên máy khác. Không ghi đè database đang bán hàng. Sau khi kiểm tra dữ liệu khôi phục, dừng web trước khi chuyển cấu hình DB/khóa sang bản đó.

Giới hạn hiện tại là **64 MiB cho SQLite**. Backup này gồm SQL và khóa đơn hàng, **không gồm ảnh/video, ảnh Excel, `.env` hoặc phiên Facebook**. Cần sao lưu riêng `data/media` và `public/images/products` vào kho được bảo vệ để phục hồi cả website. Chưa có lịch sao lưu tự động hoặc bản sao ngoài máy.

### Phạm vi kiểm tra và triển khai

`npm run check` kiểm tra cú pháp. `npm test` kiểm tra quyền truy cập/CSRF/phiên, giới hạn đăng nhập, race khi đặt lại mật khẩu, mã hóa và di chuyển đơn, mất/sai khóa, backup bị sửa và restore không ghi đè; kèm các luồng bán hàng và media hiện có. Các kiểm thử chạy trên dữ liệu tạm riêng. Việc này không thay thế kiểm thử xâm nhập độc lập.

Trước khi đưa ra Internet cần HTTPS reverse proxy, sao lưu ngoài máy và quy trình giữ/khôi phục khóa; nếu cần mức đảm bảo cao hơn, bổ sung MFA, giám sát/cảnh báo tập trung và chính sách lưu/xóa dữ liệu phù hợp hoạt động cửa hàng. Hiện website vẫn chạy cục bộ, chưa có MFA, chưa đánh giá toàn bộ ASVS hoặc chứng nhận bên thứ ba.


## GitHub và link chạy thử

GitHub lưu mã nguồn của dự án. **GitHub Pages không phù hợp cửa hàng này**: Pages chỉ phục vụ nội dung tĩnh và không cho dùng làm dịch vụ hosting miễn phí cho website kinh doanh/e-commerce. App cần Node.js, SQLite lưu lâu dài, Python và FFmpeg. [Giới hạn GitHub Pages](https://docs.github.com/en/pages/getting-started-with-github-pages/github-pages-limits).

Repo chỉ chứa mã nguồn, danh mục và ảnh sản phẩm công khai. `.env`, database đang bán hàng, khóa, backup, bản gốc media, phiên Facebook, môi trường Python và Excel nguồn được giữ riêng trên máy. Không dùng `git add -f` với các file này. Nên tạo repo **private**.

### Codespaces: dùng để xem thử

Có sẵn cấu hình `.devcontainer` với Node, Python và FFmpeg. Sau khi đẩy repo, chọn **Code → Codespaces → Create codespace on main**. Terminal trong Codespaces:

```sh
npm run start:codespaces
```

Lệnh tạo đúng `PUBLIC_ORIGIN` HTTPS theo địa chỉ Codespaces, giữ máy chủ ở loopback và không nới kiểm tra nguồn/phiên. Cổng 3000 mặc định riêng tư: mở link trong tab **Ports** để xem bằng tài khoản GitHub của bạn. Chỉ chuyển port sang **Public** khi muốn chia sẻ bản thử; repo vẫn có thể để private. Cần kiểm chứng proxy trên Codespace thật trước khi coi link đã hoạt động; nếu trả 426/403, đừng bỏ các kiểm tra bảo mật để chạy tạm.

Repo không mang theo tài khoản/đơn hàng thật. Để chuyển nguyên cửa hàng, đưa bản backup mã hóa và khóa qua kênh riêng vào Codespace của chính bạn, khôi phục vào thư mục dữ liệu riêng và cấu hình `DB_PATH`/`DATA_ENCRYPTION_KEY_FILE`; không commit các file này. Tài khoản quản trị chỉ tồn tại sau khi chuyển đúng dữ liệu hoặc thiết lập riêng trên môi trường đó. Không mở public khi quản trị chưa được chuẩn bị.

Media ảnh/video có bộ xử lý; nếu cần đọc hội nhóm thì chạy thêm `npm run prices:setup` trong Codespace để cài Playwright/Chromium. Việc đăng nhập Facebook cần môi trường có giao diện trình duyệt, chưa được kiểm chứng trên Codespaces; chức năng lưu bài thủ công vẫn dùng được.

Codespaces là môi trường phát triển, **không phải VPS miễn phí 24/7**: có hạn mức tính toán/lưu trữ, tự dừng khi không hoạt động và dữ liệu có thể bị xóa theo vòng đời Codespace. Kiểm tra quota/budget GitHub trước khi tạo; không thiết lập tự khởi động lặp để né giới hạn. Dữ liệu cần ở `/workspaces` và vẫn phải sao lưu ngoài Codespace. [Vòng đời Codespaces](https://docs.github.com/en/codespaces/about-codespaces/understanding-the-codespace-lifecycle).

Để bán hàng thường xuyên, dùng VPS/hosting hỗ trợ Node và ổ đĩa bền vững, cấu hình HTTPS như phần bảo mật. GitHub Actions chỉ nên chạy kiểm thử hoặc triển khai, không dùng runner làm máy chủ duy trì cửa hàng.
