# FAQ & xử lý sự cố

## Khách hàng

### 1. Dán KEY vào báo "KEY không hợp lệ" / "KEY được cấp cho thiết bị khác"

- Device ID đã đổi (cài lại Windows, đổi máy, đổi hostname) → cấp KEY mới.
- KEY copy thiếu ký tự → copy lại từ Zalo/Gmail, không tự gõ.
- KEY của gói khác máy → kiểm tra đúng 64 ký tự Device ID.

### 2. App báo "Không kết nối được server license"

- Kiểm tra Internet.
- Kiểm tra `license-server.json` cạnh `hotanvoice.exe` có đúng URL HTTPS.
- Server có thể tạm lỗi: chờ 1–2 phút bấm "Thử lại".

### 3. Đang dùng thì bị khóa

- KEY trả phí: đã quá 7 ngày không online → mở mạng để gia hạn.
- Bản dùng thử: hết 10 phút trong ngày → nhập KEY để tiếp tục.
- KEY bị thu hồi → liên hệ quản trị viên.

### 4. Mất mạng có dùng được không?

KEY trả phí: **có**, tối đa 7 ngày kể từ lần xác thực cuối.
Dùng thử: **không**, cần Internet.

### 5. Chuyển sang máy mới

Gửi Device ID mới (nút copy trong popup) để được cấp KEY mới.
KEY cũ vẫn gắn với máy cũ — có thể yêu cầu thu hồi.

### 6. Ổ C mất dữ liệu, cài lại Windows

Device ID thường đổi → cần KEY mới. Sao lưu `hotanvoice-data/` để giữ lịch sử/preset
(không giữ được license).

## Quản trị viên

### 7. Keygen sinh KEY nhưng app báo `BAD_KEY`

`LICENSE_SECRET` trong `keygen/config.json` khác secret trên server.
Đối chiếu chip **Secret khớp app** (12 ký tự) ở sidebar keygen với giá trị tính từ server.

### 8. Worker trả `503 ADMIN_DISABLED`

Secret `ADMIN_TOKEN` đang rỗng. Đặt lại:

```powershell
cmd /c "npx wrangler secret put ADMIN_TOKEN"
```

### 9. Worker trả `UNAUTHORIZED`

Sai token hoặc thiếu header. Dùng `x-admin-token` hoặc `Authorization: Bearer`.

### 10. `KV namespace HTV not found`

Chưa khai báo `[[kv_namespaces]]` trong `wrangler.toml` hoặc sai `id`.

### 11. `PRIVATE_JWK` lỗi khi ký lease

Secret phải là JSON **một dòng**, đủ `kty`, `crv`, `x`, `y`, `d`.

### 12. Thu hồi KEY mà khách vẫn dùng được

Khách đang offline; lease còn hạn tới 7 ngày. Chặn tối đa sau khi lease hết hạn
hoặc khi khách online lại.

### 13. Đổi `LICENSE_SECRET` có phải cấp lại KEY?

Có. Toàn bộ KEY cũ mất hiệu lực ngay sau khi deploy secret mới.

### 14. Có thể giới hạn số máy trên một KEY?

Hiện tại mỗi KEY gắn cứng 1 Device ID. Cần nhiều máy → cấp nhiều KEY,
hoặc mở rộng server để lưu danh sách thiết bị theo KEY.

### 15. Trial bị dùng hết khi test

```powershell
$body = @{ deviceId = '<64 hex>' } | ConvertTo-Json
Invoke-RestMethod "$base/api/admin/trial-reset" -Method POST -Headers $h `
  -ContentType 'application/json' -Body $body
```
