# FR-08c — Nhập kế hoạch Excel

Trạng thái: Xong trên máy · Branch: `codex/fr08c-excel-plan`

## 0. Mục tiêu

- [x] AC1. Người dùng tải mẫu và đưa workbook vào trang nhập hiện tại.
- [x] AC2. Xem cây dự án, cột mốc, công việc. Có thể sửa trường, chọn lại mã cha hoặc bỏ từng nhánh. Dòng không ghép được xuất hiện trong mục Cần xem cùng vị trí nguồn.
- [x] AC3. Xác nhận đúng số dòng được chọn. Sau khi lưu, hiện kết quả và liên kết tới từng dự án. Thử lại cùng bản xác nhận dùng cùng request ID.
- [x] AC4. Luồng nhập brief có thể mở từ cùng trang.

## 1. Hợp đồng

Dùng `aiFetch` với API `POST /projects/import/plan/preview` và `POST /projects/import/plan`.
Request xác nhận gồm ba danh sách dòng đã chọn và `request_id`. Lỗi `invalid_plan` trả lỗi theo dòng.
Tên cột, giới hạn và xử lý thời hạn theo plan FR-08c của AI.

## 2. Màn hình

- Giữ route và phong cách trang import, thêm chế độ Excel có cấu trúc làm mặc định.
- Cây nhóm theo mã dự án và mã cột mốc. Mã trùng khiến các dòng con xuất hiện trong mục Cần xem cho đến khi sửa.
- Hiện tên file, số dòng sẽ tạo, số chỗ còn lại và lỗi có vị trí nguồn trước khi lưu.

## 3. Kiểm tra

- Build TypeScript/Vite và lint các file sửa.
- Kiểm tra ghép hai cột mốc cùng mã ở hai dự án, dòng mồ côi, bỏ cả nhánh và lưu lại sau lỗi mạng.
- Kiểm tra mẫu tải xuống bằng parser.

## 4. Các bước

- [x] 1. DTO và API client, file mẫu.
- [x] 2. Upload, cây xem trước, sửa và chọn dòng, xác nhận, kết quả.
- [x] 3. Kiểm tra build và các luồng hồi quy.

## 5. Kết quả kiểm tra

- Build TypeScript/Vite và ESLint các file sửa đạt.
- Kiểm tra cây bằng Node xác nhận mã cột mốc có thể lặp ở hai dự án, task mồ côi được nhận diện và bỏ dự án sẽ bỏ các dòng con đã liên kết.
- Parser AI đọc được file mẫu trong `public/`.
- Luồng brief gửi lại nội dung và nguồn đã xem trước. API client nhận được cả phản hồi dạng danh sách và phản hồi có trường `projects`.
