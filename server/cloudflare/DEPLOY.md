# Deploy license server lên Cloudflare Workers

Miễn phí, chạy 24/7, không cần VPS, không cần IP công khai.
Worker dùng KV để lưu thiết bị, lượt dùng thử và danh sách thu hồi.

> **Đã triển khai mẫu:** Worker `hotanvoice-license` trên Cloudflare, KV binding `HTV`,
> đủ 3 secret `ADMIN_TOKEN`, `LICENSE_SECRET`, `PRIVATE_JWK`.
> URL thật của bản triển khai nằm trong `src/license-server.json`.
> Repo này không chứa giá trị secret hay id tài khoản — hãy tạo KV riêng của bạn.

Các mục dưới đây giữ lại để tham khảo khi cần dựng lại hoặc đổi tài khoản.

## 0. Chuẩn bị

- Tài khoản Cloudflare (gói Free).
- Node.js trên máy để chạy `wrangler`.
- Các giá trị lấy từ `server\node\config.json`:
  - `adminToken`
  - `licenseSecret`
  - `privateJwk` (JSON, **bí mật** — chỉ dán vào secret của Worker)

Cài Wrangler:

```powershell
npm install -g wrangler
wrangler login
```

## 1. Tạo KV namespace

```powershell
cd server\cloudflare
wrangler kv namespace create HTV
```

Lệnh in ra `id = "..."`. Chép id đó vào `wrangler.toml` (mục `id`).

## 2. Khai báo secret

```powershell
wrangler secret put ADMIN_TOKEN      # dán adminToken
wrangler secret put LICENSE_SECRET   # dán licenseSecret (phải trùng keygen)
wrangler secret put PRIVATE_JWK      # dán JSON privateJwk trên MỘT dòng
```

`privateJwk` có dạng:

```json
{"kty":"EC","crv":"P-256","x":"...","y":"...","d":"..."}
```

Chỉ dán đúng một dòng JSON, không thêm chữ nào khác.

> **Cảnh báo:** `ADMIN_TOKEN` phải là chuỗi **khác rỗng**. Nếu secret rỗng,
> mọi request admin sẽ bị Worker từ chối với `503 ADMIN_DISABLED` (fail-closed),
> và nếu code cũ chưa có kiểm tra này thì API quản trị sẽ **mở công khai**.
> Kiểm tra nhanh:
>
> ```powershell
> curl.exe -s -o NUL -w "%{http_code}`n" https://hotanvoice-license.hiyake111.workers.dev/api/admin/licenses
> ```
>
> Phải ra `401`. Ra `200` nghĩa là `ADMIN_TOKEN` đang rỗng hoặc sai — đặt lại ngay.

Cách nhanh để nạp nhiều secret một lần (tránh dán tay):

```powershell
node -e "const c=require('./../node/config.json');const fs=require('fs');fs.writeFileSync(process.env.TEMP+'\\htv-secrets.json',JSON.stringify({ADMIN_TOKEN:c.adminToken,LICENSE_SECRET:c.licenseSecret,PRIVATE_JWK:JSON.stringify(c.privateJwk)}))"
cmd /c "npx wrangler secret bulk %TEMP%\htv-secrets.json"
del "%TEMP%\htv-secrets.json"
```

## 3. Deploy

```powershell
wrangler deploy
```

Kết quả có dạng:

```
https://hotanvoice-license.hiyake111.workers.dev
```

Kiểm tra:

```powershell
Invoke-RestMethod https://hotanvoice-license.hiyake111.workers.dev/api/health
```

Phải trả `ok: true`, `runtime: "cloudflare-worker"`.

## 4. Trỏ app vào Worker

Sửa **cả hai** file (để lần build sau giữ nguyên):

- `app\license-server.json`
- `data\license-server.json`

```json
{
  "url": "https://hotanvoice-license.hiyake111.workers.dev"
}
```

> Đã cập nhật sẵn cả hai file về URL trên. Sau khi sửa phải chép lại
> `data` → `app\resources\app` và build lại ZIP thì bản phát hành mới có tác dụng.

## 5. Tên miền riêng (tùy chọn)

Cloudflare Dashboard → Workers & Pages → chọn Worker →
**Settings → Domains & Routes → Add custom domain**.

Ví dụ `license.tenmien.com`. Cloudflare tự tạo DNS và chứng chỉ HTTPS.
URL này ổn định hơn `workers.dev` và dễ nhớ hơn với khách.

## 6. Kiểm tra nhanh

```powershell
$base = 'https://hotanvoice-license.<tài-khoản>.workers.dev'
$device = 'df81eff133a22fbeb57d19dd499b92b9808ca3964039a949912a6c19316cc23c'
Invoke-RestMethod "$base/api/status?deviceId=$device"
```

Cấp KEY thử (thay `$token` bằng `adminToken`):

```powershell
$h = @{ 'x-admin-token' = $token }
$body = @{ deviceId = $device; plan = 'P'; expires = '000000'; note = 'test' } | ConvertTo-Json
Invoke-RestMethod -Method Post -Uri "$base/api/admin/issue" `
  -Headers $h -ContentType 'application/json' -Body $body
```

Worker chấp nhận một trong hai kiểu xác thực admin:

- `x-admin-token: <adminToken>`
- `Authorization: Bearer <adminToken>`

## 7. Vận hành & giới hạn

- Dữ liệu nằm trong KV. Xem/sửa tại Dashboard → Workers & Pages → KV.
- KV nhất quán trễ khoảng 60 giây giữa các khu vực: thu hồi KEY có thể mất
  tới ~1 phút mới chặn ở mọi nơi.
- Gói Free: khoảng 100.000 lượt đọc/ngày và 1.000 lượt ghi/ngày. Với app
  heartbeat 60 giây/khách, 1.000 khách mở liên tục sẽ vượt giới hạn ghi;
  thực tế nên dùng gói trả phí khi số khách tăng, hoặc tăng chu kỳ heartbeat.
- Rate limit trong Worker là bộ nhớ tạm theo từng instance (best-effort),
  không phải giới hạn toàn cầu.
- Đổi `LICENSE_SECRET`: `wrangler secret put LICENSE_SECRET` lại, đồng thời
  đổi trong keygen. KEY cũ sẽ hết hiệu lực.
- Đổi khóa ký lease: tạo cặp ECDSA mới, `wrangler secret put PRIVATE_JWK`,
  cập nhật public key trong `data\lib\license.js`, build lại app.

## 8. Lỗi thường gặp

| Lỗi | Nguyên nhân |
| --- | --- |
| `KV namespace HTV not found` | Chưa khai báo `[[kv_namespaces]]` hoặc sai `id` |
| `PRIVATE_JWK` lỗi khi ký | Secret không phải JSON một dòng, hoặc thiếu `d` |
| `BAD_KEY` với KEY vừa tạo | `LICENSE_SECRET` của Worker khác keygen |
| `UNAUTHORIZED` khi gọi admin | Sai `ADMIN_TOKEN` hoặc thiếu header |
| `ADMIN_DISABLED` (503) | Secret `ADMIN_TOKEN` rỗng — đặt lại bằng `wrangler secret put` |
| App báo không kết nối | Chưa sửa `license-server.json`, hoặc Worker chưa deploy |
