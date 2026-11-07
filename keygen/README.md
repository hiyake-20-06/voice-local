# hotanvoice Keygen (nội bộ)

Công cụ cấp KEY license cho hotanvoice. **Không phát hành cho khách hàng.**

## Cài đặt

```powershell
cd keygen
Copy-Item config.example.json config.json
# mở config.json, điền licenseSecret trùng với server license
npm install
npm start
```

`config.json` đã nằm trong `.gitignore`. Không commit, không gửi file này cho ai.

Có thể đặt secret qua biến môi trường thay cho file:

```powershell
$env:HOTANVOICE_LICENSE_SECRET = 'HTV1-...'
npm start
```

Thứ tự tìm secret: biến môi trường → `keygen/config.json` → `server/node/config.json`.

## Cách cấp KEY

1. Khách mở app, bấm nút copy cạnh **Device ID** để lấy chuỗi 64 ký tự hex.
2. Dán vào ô **Device ID của khách** (ô đếm phải hiện `64/64 ký tự`).
3. Ghi chú tên khách (để tra lịch sử).
4. Chọn loại: Cá nhân (`P`), Studio (`S`), Thương mại (`C`).
5. Chọn hạn: Vĩnh viễn (`000000`) hoặc ngày hết hạn.
6. Bấm **Sinh KEY** → **Sao chép KEY** → gửi khách.

## Đối chiếu secret

Sidebar hiển thị **Fingerprint secret** = 12 ký tự đầu SHA-256 của `LICENSE_SECRET`.
Giá trị này phải khớp với secret đang dùng trên server license. Nếu lệch, KEY sinh ra
sẽ bị server từ chối với mã `BAD_KEY`.

## Dữ liệu

- `keygen-data/issued.json` — 500 KEY gần nhất (đã gitignore).
- Xóa lịch sử **không** làm KEY mất hiệu lực.

## Đóng gói portable

Chép thư mục này vào `resources/app/` của một Electron runtime (v31.x), đổi tên exe
thành `hotanvoice-keygen.exe`, rồi **không** phân phối thư mục đó.
