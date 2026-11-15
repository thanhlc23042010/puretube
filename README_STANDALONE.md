# PureTube — Hướng dẫn Chạy Độc Lập 100% Trên 4G/5G (Không Cần Bật PC)

## 1. Kiến trúc học hỏi từ `YouTube M (.apk)` & `YouTubePlus (.ipa)`
Sau khi phân tích kỹ thuật bên trong 2 tệp trong thư mục Downloads:
- **`YouTube M_v21.30.216-MP_v2.2.0_.apk`**: Bản vá Morphe/ReVanced trên nền YouTube Android chính chủ (`classes*.dex` chứa `SpoofVideoStreamsPatch`, `AuthUtils`, `ExoPlayerInterface`).
- **`YouTubePlus 21.44.4.ipa`**: Bản YouTube iOS `v21.44.4` tiêm `CydiaSubstrate.framework` + `YTLite.dylib` + `YouFixPlaybackIssues.dylib` (can thiệp `YTDirectPlaybackClient` & `YTInnertubeSession` để lấy luồng trực tiếp qua 4G/5G) + `sideloadkeychainfix.dylib` + `YouPiP.dylib`.

PureTube v2.1 áp dụng trực tiếp mô hình **InnerTube Spoofing không cần máy chủ trung gian**:
1. **Nhanh hơn 5–8x** ngay trên cả PC lẫn Cloud nhờ bộ trích xuất trực tiếp `IOS InnerTube + visitorData` (`~350ms` thay vì chờ `yt-dlp`).
2. **Tích hợp Cầu Nối Native Android (Java) & iOS (Swift)** trong `mobile/plugins/puretube-native/` + `frontend/js/standalone-bridge.js`, giúp app PureTube tự gọi trực tiếp `youtubei/v1/player`, `search`, `next`, `FEhistory`, SponsorBlock, Google Translate & Lồng tiếng Tiếng Việt bằng chính sóng **4G/5G của điện thoại — KHÔNG cần bật PC và KHÔNG cần Cloud**.

---

## 2. Cách cài và sử dụng không cần bật PC ngay bây giờ

### Cách A: Tự động xuất file `PureTube-Android.apk` & `PureTube-iOS-Unsigned.ipa` miễn phí (GitHub Actions)
Vì máy tính Windows không có sẵn Apple Xcode (để biên dịch file `.ipa` iOS) và Android SDK, dự án đã cấu hình sẵn workflow tại `.github/workflows/build-mobile.yml`:
1. Tạo 1 repo GitHub mới rồi `git push` toàn bộ thư mục `puretube` lên GitHub.
2. Vào tab **Actions** trên GitHub -> chọn workflow **Build PureTube Standalone Mobile Apps (APK & IPA)** -> bấm **Run workflow**.
3. Sau ~4 phút, tải 2 thành phẩm ngay ở mục **Artifacts**:
   - `PureTube-Android-APK` -> cài thẳng lên mọi máy Android, chạy 4G/5G độc lập hoàn toàn.
   - `PureTube-iOS-Unsigned-IPA` -> cài lên iPhone qua **SideStore / AltStore / Sideloadly / ESign / LiveContainer**.

### Cách B: Triển khai Cloud 24/7 Miễn Phí (Khuyên dùng cho iPhone PWA để KHÔNG BAO GIỜ hết hạn chứng chỉ 7 ngày!)
Mọi file `.ipa` cài ngoài App Store trên iPhone (kể cả `YouTubePlus.ipa`) đều cần gia hạn mỗi 7 ngày nếu không có tài khoản Apple Developer trả phí ($99/năm). Cách khắc phục triệt để nhất:
1. Đưa thư mục `puretube` lên **Render.com** (hỗ trợ sẵn `Dockerfile` & `render.yaml`) hoặc **Hugging Face Spaces (Docker)** miễn phí 24/7.
2. Mở link HTTPS của bạn trên **iPhone Safari** -> bấm **Chia sẻ** -> **Thêm vào Màn hình chính** (hoặc dán link đó vào **Cài đặt → Máy chủ Cloud 24/7** trong PureTube).
3. Dùng vĩnh viễn mọi lúc mọi nơi qua 4G/5G khi đã tắt máy tính, giữ nguyên giọng đọc Neural **Hoài My / Nam Minh**, tải MP3/MP4 1080p, đồng bộ tài khoản Google!

### Cách C: Cài 2 file APK / IPA tham khảo có sẵn trong Downloads
Mở hộp thoại **Mở trên iPhone / Android (mã QR)** trong PureTube để quét mã QR tải trực tiếp `YouTube M` (Android) và `YouTubePlus` (iPhone) qua Wi-Fi sang điện thoại (2 app này cũng chạy 4G/5G không cần PC, nhưng không có tính năng AI Lồng tiếng Tiếng Việt cho mọi video nước ngoài như PureTube).
