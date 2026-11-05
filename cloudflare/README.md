# Chuyển Sentai sang Cloudflare

Cửa hàng: **https://sentai-shop.mkt2h-sentai.workers.dev**. Bản triển khai ngày 06/11/2026 dùng dữ liệu từ Codespaces: 144 sản phẩm, 119 mẫu và 21 lượt xem tại lúc chuyển. Quản trị lần đầu: mở `START-CLOUDFLARE-ADMIN.cmd`, sau đó thêm passkey trong trang quản trị.

Bản này dùng **Workers + Static Assets** cho website/API, **D1 SQL** cho dữ liệu và **Workers KV** cho media đã xử lý. Ảnh danh mục đi cùng website. Ảnh/video mới được nén và đóng số điện thoại trên máy trước khi tải lên. Phương án này không cần nhập thông tin thanh toán; giữ tài khoản ở gói Free. Bản Node.js cục bộ vẫn chạy bằng `npm start`, giữ SQLite và cách đăng nhập hiện có.

Cấu hình công khai `wrangler.jsonc` là mẫu. ID database/namespace giữ chỗ phải được thay bằng ID tài nguyên thật trong cấu hình riêng trước khi triển khai. Hai bản Node và cloud không tự đồng bộ dữ liệu.

## Giới hạn miễn phí

Static Assets có yêu cầu phục vụ miễn phí; API Workers Free có hạn mức **100.000 yêu cầu/ngày, 10 ms CPU/yêu cầu**. D1 Free có **500 MB mỗi database, 5 GB tổng**, cùng hạn mức đọc/ghi. Đây là phương án ưu tiên miễn phí trong hạn mức, không phải hosting không giới hạn hoặc cam kết SLA. Xem [Workers](https://developers.cloudflare.com/workers/platform/limits/), [Static Assets](https://developers.cloudflare.com/workers/static-assets/billing-and-limitations/) và [D1](https://developers.cloudflare.com/d1/platform/pricing/).

KV Free có **1 GB toàn tài khoản**, 100.000 lượt đọc, 1.000 lượt ghi và 1.000 lượt xóa mỗi ngày. Một lần xem video có thể đọc nhiều phần. Ứng dụng giới hạn **900 MiB dung lượng giữ chỗ**, ảnh tối đa 25 MiB và **video đã xử lý tối đa 200 MiB**; mỗi phần tải 5 MiB. Dữ liệu ứng dụng khác trong tài khoản có thể làm hết hạn mức sớm hơn. Không tự nâng gói khi chạm giới hạn. Xem [giới hạn KV](https://developers.cloudflare.com/kv/platform/limits/) và [cách tính lượt thao tác](https://developers.cloudflare.com/kv/platform/pricing/).

## Kiểm tra trên máy

Chạy trong thư mục dự án với Node.js phù hợp `package.json`:

```powershell
npm ci
npm run cf:build
npm run cf:check
node --test tests/cloudflare-*.test.mjs
```

`cf:build` chỉ đóng gói nội dung công khai vào `dist/cloudflare-assets`; không đưa SQL, khóa hoặc file gốc lên website. `cf:check` chạy Wrangler `deploy --dry-run`, không triển khai thật.

Sau khi có snapshot riêng theo bước bên dưới, tạo database thử nghiệm cục bộ:

```powershell
npx wrangler d1 migrations apply sentai-shop --local --persist-to data/cloudflare-dev
npx wrangler d1 execute sentai-shop --local --persist-to data/cloudflare-dev --file data/cloudflare/snapshot.sql
npm run cf:dev
```

Nhập một lần vào database trống. Dữ liệu Wrangler cục bộ ở `data/cloudflare-dev`, tách khỏi `data/sentai.sqlite`. Cấu hình bí mật thử nghiệm đặt trong `.dev.vars` đã loại khỏi Git. Không có cờ bỏ qua đăng nhập để dùng trên production. Trang quản trị Node tại cổng 3000 vẫn dùng được như trước.

## Chọn đúng dữ liệu nguồn

Chọn database đang nhận cập nhật mới nhất, không lấy bản SQL trong Git làm bản sao dữ liệu vận hành. Nếu cửa hàng đang chạy Codespaces, nguồn hiện tại là `/workspaces/sentai-shop/data/live/sentai.sqlite`; khóa tương ứng là `data/live/secrets/order-data.key` trên cùng Codespace. Nguồn trên máy mặc định là `data/sentai.sqlite` và `data/secrets/order-data.key`.

Sao lưu nguồn trước khi chuyển. Hoàn tất các lượt xử lý media/quét đang chờ, rồi tạm dừng nhận và sửa dữ liệu tại nguồn trong lần chốt. Chạy exporter trên chính database được chọn; ví dụ nguồn cục bộ:

```powershell
npm run cf:export -- --database data/sentai.sqlite --output data/cloudflare/snapshot.sql
```

Lệnh đọc snapshot nhất quán, không sửa database hoặc tạo khóa mới. File SQL và file `.manifest.json` kèm số dòng/checksum nằm trong thư mục riêng đã loại khỏi Git. Exporter từ chối ghi đè, xuất vào `public`, dữ liệu đơn hàng chưa mã hóa, tên món trùng hoặc các công việc chưa xong.

Snapshot giữ sản phẩm, các chiếc/BST, đơn hàng đã mã hóa, thống kê và lịch sử giá; không chuyển mật khẩu quản trị, mã khôi phục hay phiên đăng nhập. File media và khóa không nằm trong snapshot. Nếu nguồn đã có media, phải đối chiếu và chuyển các file sang định dạng lưu của bản cloud trước khi chuyển link; nhập dòng `product_media` không tự tải file lên KV. Giữ bản gốc và backup nguồn để phục hồi.

## Cấu hình tài khoản và quản trị

Tạo bản sao `wrangler.local.jsonc` từ `wrangler.jsonc` nếu chưa có. File này đã loại khỏi Git; dùng nó cho `account_id`, tên Worker và các ID thật của binding `DB`, `MEDIA_KV`. Không đưa email, token hoặc khóa vào cấu hình công khai.

Đăng nhập và tạo D1 khi đã sẵn sàng dùng tài khoản của chủ cửa hàng:

```powershell
npx wrangler login
npx wrangler whoami
npx wrangler d1 create sentai-shop --config wrangler.local.jsonc
npx wrangler kv namespace create MEDIA_KV --config wrangler.local.jsonc
```

Ghi ID D1 và namespace trả về vào binding `DB`, `MEDIA_KV` trong `wrangler.local.jsonc`. Giữ Workers Free; không thêm dịch vụ yêu cầu checkout. Cấu hình các giá trị sau bằng Worker secrets; `.dev.vars` chỉ dành cho chạy thử trên máy:

| Giá trị | Nội dung |
| --- | --- |
| `AUTH_SECRET` | 32 byte ngẫu nhiên, biểu diễn thành 64 ký tự hex; dùng cho CSRF và giới hạn yêu cầu. |
| `DATA_ENCRYPTION_KEY` | **Đúng khóa 32 byte của database nguồn**, biểu diễn hex 64 ký tự hoặc base64 chuẩn. Không tạo khóa thay thế cho dữ liệu đã có. |
| `ADMIN_EMAIL` | Nhãn tài khoản chủ cửa hàng; không phải cơ chế gửi mã xác minh email. |
| `PUBLIC_ORIGIN` | Địa chỉ HTTPS chính xác của cửa hàng, không có dấu `/` cuối; dùng kiểm tra origin của passkey và yêu cầu. |

Ví dụ lệnh nạp một secret qua lời nhắc, không đặt giá trị trong dòng lệnh:

```powershell
npx wrangler secret put AUTH_SECRET --config wrangler.local.jsonc
```

Nạp các secret còn lại tương tự, hoặc dùng luồng nạp từ file riêng tư. Khóa đơn hàng được kiểm tra với sentinel mã hóa trong SQL; thiếu/sai khóa khiến API đơn hàng từ chối hoạt động. Không in khóa, đưa lên Git hoặc gửi vào chat.

Chủ tài khoản Cloudflare chạy công cụ `scripts/cloudflare_admin_link.mjs` trên máy để tạo liên kết thiết lập/khôi phục. Liên kết mở trong trình duyệt, chỉ dùng **một lần trong 20 phút**; mã không được in ra log. Không có đăng ký quản trị công khai hoặc khôi phục chỉ bằng cách nhập email.

```powershell
node scripts/cloudflare_admin_link.mjs --config wrangler.local.jsonc --origin https://HOST-CUA-HANG
```

Thay địa chỉ bằng origin thật. Lệnh mặc định ghi vào D1 thật; `--local` dành cho database thử nghiệm cục bộ. Có thể đặt `PUBLIC_ORIGIN` trong `vars` của cấu hình riêng đã loại khỏi Git để dùng `START-CLOUDFLARE-ADMIN.cmd` mà không cần nhập địa chỉ mỗi lần.

Mở liên kết rồi đăng ký passkey trên thiết bị của chủ cửa hàng. Những lần sau vào `/admin`, dùng passkey với Windows Hello, vân tay hoặc cơ chế xác minh của thiết bị. Khi mất passkey, chủ tài khoản chạy lại công cụ khôi phục. Email chỉ là nhãn tài khoản; ứng dụng không gửi OTP/email. Tài khoản SQL cũ vẫn thuộc bản Node cục bộ.

Phiên được lưu trong D1 bằng mã băm, cookie HttpOnly; hết hạn sau 15 phút không hoạt động hoặc tối đa 8 giờ. Các thao tác sửa cần CSRF, kiểm tra phiên hết hạn/thu hồi trong cùng giao dịch SQL. API không có phiên hợp lệ trả JSON 401.

## Nhập và triển khai

Áp dụng schema vào **database D1 đích trống**, rồi nhập snapshot đã chốt:

```powershell
npx wrangler d1 migrations apply sentai-shop --remote --config wrangler.local.jsonc
npx wrangler d1 execute sentai-shop --remote --config wrangler.local.jsonc --file data/cloudflare/snapshot.sql
npm run cf:build
npx wrangler deploy --dry-run --config wrangler.local.jsonc
npx wrangler deploy --config wrangler.local.jsonc
```

Không chạy lại snapshot lên database đang có dữ liệu hoặc đã nhập dở; kiểm tra trạng thái trước, dùng đích trống mới nếu cần. Giữ database/backup nguồn để phục hồi. Không cho hai bản độc lập cùng nhận đơn rồi giả định chúng tự đồng bộ.

Chỉ chuyển link cửa hàng sau khi kiểm tra catalog/chiếc/BST, ảnh thực tế, đăng ký và đăng nhập passkey, API quản trị 401 khi chưa đăng nhập, đặt đơn thử và thống kê. Đánh dấu đơn kiểm thử là đã hủy. Nếu dùng video, kiểm tra cả tải lên và tua trên điện thoại. KV chỉ được phục vụ qua Worker sau khi kiểm tra sản phẩm/media còn hoạt động.

Xem [chuẩn bị và tải media](MEDIA.md): nén/đóng watermark trên máy, chọn bộ manifest + ảnh/video + poster cho đúng mã chiếc. Video tải theo phần **5 MiB**, đầu ra tối đa **200 MiB**; giữ nguyên hai mức chất lượng hiện có, không tự giảm chất lượng để ép file vượt giới hạn. Python/FFmpeg và bộ quét Facebook không chạy trên Workers; giá tham khảo có thể nhập thủ công trên cloud, còn việc quét nhóm tiếp tục thực hiện trên máy.

KV đồng bộ theo thời gian. Media mới được giữ chờ ít nhất 65 giây trước khi xuất hiện; đây không phải bảo đảm file đã tới mọi vùng. Khi một phần chưa sẵn sàng, máy chủ trả lỗi tạm thời để trình duyệt thử lại, không trả video thiếu byte. Xem [tính nhất quán KV](https://developers.cloudflare.com/kv/concepts/how-kv-works/).

D1, KV và khóa phải được sao lưu riêng. Lệnh backup SQLite cũ không tự sao lưu bản cloud; theo dõi hạn mức trong dashboard và thử phục hồi trước khi dựa vào bản sao lưu cho dữ liệu thật.
