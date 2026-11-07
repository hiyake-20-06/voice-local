# Changelog

## 1.0.0 — 2026-11-06

Bản phát hành đầu tiên.

### Tính năng
- Studio TTS tiếng Việt chạy local: Kokoro Vietnamese, VieNeu-TTS v3 Turbo, MOSS-TTS-Nano.
- Nhận dạng giọng nói bằng Whisper.cpp, tạo voice/preset từ audio mẫu.
- 14 voicepack, nghe thử, preset và lịch sử.
- Xuất WAV/MP3 (ffmpeg), chỉnh tốc độ/cao độ.

### License
- KEY HMAC gắn Device ID, hỗ trợ vĩnh viễn hoặc có hạn.
- Lease ECDSA P-256 hạn 7 ngày, xác thực offline bằng public key nhúng.
- Dùng thử 10 phút/ngày do server quyết định.
- Heartbeat 60 giây, thu hồi KEY qua API quản trị.
- Server Cloudflare Worker + KV và server Node.js.

### Bảo mật
- App khách không chứa `LICENSE_SECRET` hay private key.
- Worker fail-closed khi `ADMIN_TOKEN` rỗng.
- Keygen đọc secret từ config (không hardcode trong repo).
