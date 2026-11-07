# Build & phát hành

## 1. Chạy dev

```powershell
cd src
npm install
npm start
```

`npm install` cài Electron 31, onnxruntime-node, ffmpeg-static, `@lambda_x/sptk`,
`read-vietnamese-number`. Model AI phải chép tay vào `src/assets/model/` (xem README).

Kiểm tra cú pháp toàn bộ:

```powershell
cd src
npm run lint
```

## 2. Cấu trúc bản portable

Bản phát hành là Electron runtime + source **không đóng gói asar**:

```
app/
├─ hotanvoice.exe
├─ ... (Electron runtime: dll, pak, locales)
├─ license-server.json          ← URL server license
└─ resources/
   └─ app/                      ← toàn bộ nội dung src/
      ├─ main.js
      ├─ preload.js
      ├─ renderer/
      ├─ lib/
      ├─ node/
      ├─ node_modules/
      ├─ assets/
      └─ package.json
```

App đọc/ghi dữ liệu cạnh file exe:

```
app/hotanvoice-data/
├─ license.json      lease đã xác thực
├─ history.json
├─ presets.json
├─ outputs/          WAV + MP3
└─ custom-voices/
```

## 3. Quy trình build

```powershell
# 1. Đồng bộ source vào app
robocopy src app\resources\app /E /MT:16

# 2. Chép cấu hình server license ra cạnh exe
Copy-Item src\license-server.json app\license-server.json -Force
```

Chuẩn bị Electron runtime (chỉ lần đầu):

1. Tải `electron-v31.7.7-win32-x64.zip`.
2. Giải nén vào `app/`.
3. Đổi `electron.exe` → `hotanvoice.exe`.
4. Đổi icon/metadata (tùy chọn): `rcedit hotanvoice.exe --set-icon src\assets\icon.ico`.

## 4. Đóng ZIP phát hành

Yêu cầu: ZIP **không** chứa dữ liệu người dùng, log, hay server/keygen.

Có thể dùng script PowerShell:

```powershell
$src = 'app'
$zip = 'app\hotanvoice-v1.0-portable.zip'
if (Test-Path $zip) { Remove-Item $zip -Force }

Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$stream = [IO.File]::Open($zip, [IO.FileMode]::Create)
$archive = New-Object IO.Compression.ZipArchive($stream, [IO.Compression.ZipArchiveMode]::Create)

Get-ChildItem $src -Recurse -File | Where-Object {
  $_.FullName -notlike '*\hotanvoice-data\*' -and
  $_.Extension -notin '.zip', '.log'
} | ForEach-Object {
  $rel = $_.FullName.Substring((Resolve-Path $src).Path.Length + 1).Replace('\', '/')
  $entry = $archive.CreateEntry("hotanvoice/$rel", [IO.Compression.CompressionLevel]::Optimal)
  $entry.LastWriteTime = $_.LastWriteTime
  $out = $entry.Open()
  $in = [IO.File]::OpenRead($_.FullName)
  $in.CopyTo($out)
  $in.Close(); $out.Close()
}

$archive.Dispose(); $stream.Close()
```

## 5. Checklist trước khi phát hành

- [ ] `src\license-server.json` trỏ đúng URL HTTPS của server.
- [ ] `app\license-server.json` giống hệt file trên.
- [ ] Không có `config.json`, `PRIVATE_JWK`, `LICENSE_SECRET` trong `app/`.
- [ ] Đã đổi `ADMIN_TOKEN` và `LICENSE_SECRET` khỏi giá trị mặc định.
- [ ] Test: cài mới → trial 10 phút → nhập KEY → tắt mạng → vẫn chạy → bật mạng → heartbeat OK.
- [ ] Test: KEY của máy khác bị từ chối (`KEY được cấp cho thiết bị khác`).
- [ ] Xóa `app\hotanvoice-data\` và `*.log` trước khi nén.

## 6. Cập nhật bản mới

1. Sửa source trong `src/`.
2. Tăng `version` trong `src/package.json`.
3. Build lại theo mục 3–4.
4. Khách chỉ cần thay thư mục `app/`, giữ lại `hotanvoice-data/` để không mất lịch sử.
