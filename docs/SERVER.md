# License server

Có 2 bản dùng chung một giao thức:

| Bản | Dùng khi | Chạy 24/7 | Cần máy bật |
| --- | --- | --- | --- |
| `server/node/` | Test, VPS, hoặc PC + Cloudflare Tunnel | Nếu đặt trên VPS | Có (nếu chạy trên PC) |
| `server/cloudflare/` | Khách dùng thật, miễn phí | Có | Không |

## 1. Cấu hình

`server/node/config.json` (chép từ `config.example.json`, **không commit**):

| Khóa | Ý nghĩa |
| --- | --- |
| `port` | Cổng HTTP, mặc định 8787 |
| `publicUrl` | URL công khai (dùng khi deploy) |
| `adminToken` | Token gọi API quản trị |
| `licenseSecret` | Secret tạo/kiểm tra KEY, phải trùng keygen |
| `graceDays` | Số ngày dùng offline sau khi kích hoạt (7) |
| `trialMinutes` | Số phút dùng thử mỗi ngày (10) |
| `timezone` | Múi giờ tính "hôm nay" (`Asia/Ho_Chi_Minh`) |
| `dataDir` | Thư mục lưu JSON của bản Node |
| `privateJwk` | Khóa ECDSA P-256 để ký lease (**bí mật**) |

`server/node/public-key.json` là bản công khai tương ứng, dùng để đối chiếu với
public key nhúng trong app (`src/lib/license.js`).

## 2. Chạy server Node

```powershell
cd server\node
node server.js
```

Kiểm tra:

```powershell
Invoke-RestMethod http://127.0.0.1:8787/api/health
```

Trỏ app vào server test mà không sửa file:

```powershell
$env:HOTANVOICE_LICENSE_SERVER = 'http://127.0.0.1:8787'
.\app\hotanvoice.exe
```

## 3. API công khai

| Method | Đường dẫn | Body | Trả về |
| --- | --- | --- | --- |
| GET | `/api/health` | — | `{ ok, runtime, graceDays, trialMinutes }` |
| GET | `/api/status?deviceId=` | — | trạng thái trial trong ngày |
| POST | `/api/activate` | `{ deviceId, key, appVersion }` | lease + license |
| POST | `/api/trial` | `{ deviceId, appVersion }` | lease dùng thử 10 phút |
| POST | `/api/session` | `{ key, deviceId }` hoặc `{ trial:true, deviceId }` | lease gia hạn |

`deviceId` là 64 ký tự hex. Server giới hạn 120 request/phút/IP (best-effort theo instance).

Mã lỗi thường gặp:

| `code` | Nghĩa |
| --- | --- |
| `BAD_DEVICE` | Device ID sai định dạng |
| `BAD_KEY` | KEY sai, hết hạn, hoặc cấp cho máy khác |
| `REVOKED` | KEY/thiết bị đã bị thu hồi |
| `TRIAL_USED` | Hôm nay đã dùng hết 10 phút |
| `TRIAL_EXPIRED` | Phiên dùng thử đã hết |
| `RATE_LIMIT` | Quá nhiều request |

## 4. API quản trị

Gửi `x-admin-token: <adminToken>` (hoặc `Authorization: Bearer <adminToken>`).

| Method | Đường dẫn | Body |
| --- | --- | --- |
| POST | `/api/admin/issue` | `{ deviceId, plan:"P"\|"S"\|"C", expires:"000000"\|"YYMMDD", note }` |
| GET | `/api/admin/licenses` | — |
| POST | `/api/admin/revoke` | `{ deviceId }` hoặc `{ key }`, kèm `reason` |
| POST | `/api/admin/unrevoke` | `{ deviceId }` hoặc `{ key }` |
| POST | `/api/admin/trial-reset` | `{ deviceId }` |
| POST | `/api/admin/trial-expire` | `{ deviceId }` (để test) |

Ví dụ PowerShell:

```powershell
$base  = 'https://<worker>.workers.dev'
$token = '<adminToken>'
$h     = @{ 'x-admin-token' = $token }

# Cấp KEY
$body = @{
  deviceId = 'df81eff133a22fbeb57d19dd499b92b9808ca3964039a949912a6c19316cc23c'
  plan     = 'P'
  expires  = '000000'
  note     = 'Chị Lan - Zalo'
} | ConvertTo-Json
Invoke-RestMethod "$base/api/admin/issue" -Method POST -Headers $h `
  -ContentType 'application/json' -Body $body

# Danh sách thiết bị
Invoke-RestMethod "$base/api/admin/licenses" -Headers $h
```

## 5. Cloudflare Worker

Xem [../server/cloudflare/DEPLOY.md](../server/cloudflare/DEPLOY.md). Tóm tắt:

```bash
cd server/cloudflare
npx wrangler kv namespace create HTV     # chép id vào wrangler.toml
npx wrangler secret put ADMIN_TOKEN
npx wrangler secret put LICENSE_SECRET
npx wrangler secret put PRIVATE_JWK
npx wrangler deploy
```

Nạp nhanh nhiều secret từ `server/node/config.json`:

```powershell
node -e "const c=require('./../node/config.json');const fs=require('fs');fs.writeFileSync(process.env.TEMP+'\\s.json',JSON.stringify({ADMIN_TOKEN:c.adminToken,LICENSE_SECRET:c.licenseSecret,PRIVATE_JWK:JSON.stringify(c.privateJwk)}))"
cmd /c "npx wrangler secret bulk %TEMP%\s.json"
del "%TEMP%\s.json"
```

### Giới hạn gói Free

- ~100.000 lượt đọc/ngày, ~1.000 lượt ghi/ngày.
- Heartbeat 60 giây/khách: 1.000 khách mở liên tục sẽ vượt hạn mức ghi → cân nhắc gói trả phí hoặc tăng chu kỳ.
- KV nhất quán trễ ~60 giây giữa các khu vực.

## 6. Keygen

App nội bộ tạo KEY, dùng chung `LICENSE_SECRET` với server.

```powershell
cd keygen
Copy-Item config.example.json config.json   # điền licenseSecret
npm install
npm start
```

Đóng gói portable: chép `keygen/` vào một Electron runtime tương tự app, đổi tên exe.

Chip **Secret khớp app** hiển thị 12 ký tự đầu SHA-256 của secret — dùng để đối chiếu
với server. Nếu keygen và server khác secret, KEY sinh ra sẽ bị `BAD_KEY`.
