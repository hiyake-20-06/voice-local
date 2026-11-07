# Hệ thống license

## 1. Tổng quan

```
 Khách                         Server (Cloudflare Worker)            App
   │  gửi Device ID                    │                              │
   │ ─────────────────────────────►     │  admin cấp KEY (keygen)      │
   │  nhận KEY                          │                              │
   │  dán KEY vào app ──────────────────────────────────────────────►  │
   │                                    │ ◄── POST /api/activate ────── │
   │                                    │  kiểm tra HMAC + revoke       │
   │                                    │  ký lease ECDSA 7 ngày        │
   │                                    │ ──── lease ────────────────►  │
   │                                    │                               │ xác thực bằng public key
   │                                    │ ◄── POST /api/session (60s) ── │
```

App **không giữ** `LICENSE_SECRET`. App chỉ giữ **public key ECDSA** để kiểm tra lease.

## 2. Cấu trúc KEY

```
HTV1-DS8QS-07S00-0000P-R2A52-2ES0B
└┬─┘ └────────── 25 ký tự Base32 ──────────┘
 │   ┌────────┬────────┬──┬──────────┐
 │   │ dev(8) │hạn (6) │P │ chữ ký(10)│
 │   └────────┴────────┴──┴──────────┘
 tiền tố
```

| Thành phần | Ý nghĩa | Cách kiểm tra |
| --- | --- | --- |
| `dev` (8) | `HMAC-SHA256(LICENSE_SECRET, deviceId)` lấy 8 ký tự Base32 | Server tính lại từ Device ID gửi lên → **khóa cứng vào máy** |
| `hạn` (6) | `YYMMDD` hoặc `000000` = vĩnh viễn | So với hôm nay theo giờ `Asia/Ho_Chi_Minh` |
| gói (1) | `P` Cá nhân, `S` Studio, `C` Thương mại | Chỉ nhận P/S/C |
| chữ ký (10) | `HMAC-SHA256(secret, "key:" + dev + hạn + gói)` | Không có secret → không thể tạo KEY giả |

Bảng chữ Base32 (Crockford, bỏ `I L O U`): `0123456789ABCDEFGHJKMNPQRSTVWXYZ`.

## 3. Device ID

- 64 ký tự hex = `SHA-256(hostname | UUID máy | MachineGuid)`.
- Đổi máy, đổi Windows, đổi hostname → Device ID đổi → cần KEY mới.
- App hiển thị dạng rút gọn 16 ký tự (`DF81-EFF1-33A2-2FBE`) và có nút copy **đầy đủ 64 ký tự**.

## 4. Lease ECDSA

Server ký payload bằng `PRIVATE_JWK` (ECDSA P-256, SHA-256, chữ ký raw `r||s`):

```json
{
  "v": 1,
  "dev": "<deviceId 64 hex>",
  "plan": "P",
  "licenseExpires": "000000",
  "trial": false,
  "trialUntil": null,
  "graceDays": 7,
  "trialMinutes": 10,
  "issuedAt": 1793976290853,
  "validUntil": 1794581090853
}
```

Token = `base64url(payload) + "." + base64url(signature)`.

App kiểm tra:
1. Chữ ký hợp lệ với public key nhúng.
2. `payload.dev === deviceId()` của máy.
3. `validUntil > now`.

→ Sửa `license.json` để kéo dài hạn: **bị từ chối**.
→ Copy `license.json` sang máy khác: **bị từ chối** (dev khác).

## 5. Vòng đời

| Trạng thái | Điều kiện | Hành vi app |
| --- | --- | --- |
| Chưa kích hoạt | Không có lease hợp lệ | Hiện popup nhập KEY / dùng thử |
| Đã kích hoạt | Lease còn hạn | Dùng bình thường |
| Offline trong hạn | Không gọi được server, lease còn hạn | Vẫn dùng, hiện chip "offline" |
| Hết lease | `validUntil < now` | Yêu cầu online lại (popup) |
| Bị thu hồi | `revoked:dev:*` hoặc `revoked:key:*` | Chặn ở `/api/session` kế tiếp |
| Trial | `trial:true`, server còn hạn 10 phút | Dùng, tự khóa khi hết |

## 6. Heartbeat

- App gọi `/api/session` mỗi **60 giây** khi đang mở.
- Thành công → gia hạn lease thêm 7 ngày (trượt).
- Thất bại do mạng → giữ lease cũ, chuyển chip offline.
- Thất bại do `REVOKED` / `BAD_KEY` → khóa ngay.

## 7. Dùng thử

- 1 lần/ngày/thiết bị, **10 phút**, server giữ trong KV (`trial:<deviceId>`).
- Không cần KEY, không cần đăng ký.
- App làm mới mỗi **2 phút**; mất mạng quá 2 phút → khóa.
- Hết 10 phút → popup hiện lại yêu cầu nhập KEY.
- Admin có thể reset: `POST /api/admin/trial-reset`.

## 8. Thu hồi

```powershell
# Thu hồi theo thiết bị
$body = @{ deviceId = '<64 hex>'; reason = 'refund' } | ConvertTo-Json
Invoke-RestMethod "$base/api/admin/revoke" -Method POST -Headers $h `
  -ContentType 'application/json' -Body $body
```

- Hiệu lực tối đa 60 giây nếu app đang online.
- Nếu khách offline: chặn ở lần online kế tiếp, muộn nhất khi lease hết hạn (7 ngày).
- Bỏ thu hồi: `/api/admin/unrevoke`.

## 9. Đổi secret / khóa

| Tình huống | Việc phải làm |
| --- | --- |
| Lộ `LICENSE_SECRET` | Đổi secret trên Worker + `keygen/config.json`; deploy; **cấp lại KEY cho toàn bộ khách** |
| Lộ `PRIVATE_JWK` | Tạo cặp ECDSA mới; đổi `PRIVATE_JWK`; cập nhật public key trong `src/lib/license.js`; build lại app |
| Lộ `ADMIN_TOKEN` | `wrangler secret put ADMIN_TOKEN` với giá trị mới |

> Worker được thiết kế **fail-closed**: nếu `ADMIN_TOKEN` rỗng, toàn bộ `/api/admin/*`
> trả `503 ADMIN_DISABLED`.
