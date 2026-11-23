# Màn chat AI — đặc tả giao diện cho FE

Cập nhật: 2026-11-22 · Người soạn: Hiếu (AI) · Mockup bấm thử: https://claude.ai/artifact/Ss7chtirziiKEjr6VFLiap#page-chat
(trang "Màn chat AI": 1 khung bấm thử được + 2 khung tĩnh "Bản nháp", "Đã áp dụng").

Màn này gộp 3 việc vào 1 chỗ: xem lại các cuộc chat (trái), chat với AI về 1 dự án (giữa), xem và sửa tay
cấu trúc dự án (phải). Luồng chính: **Bàn bạc → Lên kế hoạch → Áp dụng & xếp lịch → chat tiếp**.

---

## 1. Bố cục

```
┌──────────────┬──────────────────────────────────────┬──────────────────────┐
│ LỊCH SỬ CHAT │ KHUNG CHAT                           │ THÔNG TIN DỰ ÁN      │
│ 264px        │ co giãn (min ~560px)                 │ 400px                │
│              │ header: tên dự án · 3 bước · chế độ  │ tên · khách · hạn    │
│ ô tìm        │──────────────────────────────────────│ thanh tiến độ        │
│ Hôm nay      │ tin nhắn (cuộn)                      │──────────────────────│
│ Tuần này     │                                      │ + Cột mốc            │
│              │                                      │ ▾ Cột mốc 1   + ✎ 🗑 │
│ [Nhập file]  │──────────────────────────────────────│   ☐ Việc      + ✎ 🗑 │
│ [+ Dự án]    │ 📎 [ô nhắn............] Gửi [Lên KH] │     Việc con    ✎ 🗑 │
└──────────────┴──────────────────────────────────────┴──────────────────────┘
```

- Màn hình rộng (≥ 1280px): đủ 3 cột như trên, màn mẫu 1440×900.
- 1024–1279px: cột phải thu thành ngăn kéo, mở bằng nút "Dự án" trên header.
- Điện thoại / Mobile: chỉ khung chat; lịch sử và dự án là 2 màn hoặc 2 tab riêng.

---

## 2. Cột trái — Lịch sử chat

| Thành phần | Mô tả | API |
|---|---|---|
| Ô tìm | Tìm trong nội dung tin nhắn, tên dự án, tên task (không phân biệt hoa thường, chưa tìm không dấu). Gõ xong ~300 ms mới gọi | `GET /chat/conversations?q=&limit=20&offset=` |
| Nhóm "Hôm nay", "Tuần này", "Cũ hơn" | FE tự chia theo `last_message.created_at` | — |
| 1 dòng chat | Tên dự án (đậm nếu đang mở) · giờ tin cuối · dòng xem trước `last_message.preview` (role `assistant` → "AI: …", `user` → "Bạn: …") | cùng API |
| Nhãn | `scope = task` → chữ xanh dương "Task · {task.name}"; `applied = true` → nhãn xanh lá "Đã áp dụng" | cùng API |
| Khi tìm có kết quả trong tin | Hiện `match.snippet`, tô vàng chữ khớp; bấm vào thì cuộn tới `match.message_id` | cùng API |
| Cuộn hết danh sách | `has_more = true` → nút/tải thêm với `offset += 20` | cùng API |
| Bấm 1 dòng | `scope = project` → mở chat dự án `GET /chat/conversations/{conversation_id}`; `scope = task` → `GET /chat/tasks/{task.id}` | |
| Nút "Nhập dự án từ file Excel" | Mở luồng nhập file (mục 6) | |
| Nút "+ Dự án mới" | Form tạo dự án tay (Backend `POST /api/projects`), xong mở chat của dự án đó | |

**Không có nút "Chat mới"**: mỗi dự án đúng 1 cuộc chat. Dự án chưa có chat → gọi `POST /chat/projects/{project_id}/conversations` khi mở.

---

## 3. Cột giữa — Khung chat

### 3.1 Header
- Tên dự án (h1).
- Thanh 3 bước: `① Bàn bạc › ② Kế hoạch › ③ Xếp lịch` — bước hiện tại màu xanh, đậm (xem bảng trạng thái mục 5).
- Công tắc **Chế độ AI**: `Bàn bạc | Lên kế hoạch`.
  - Mặc định sáng "Bàn bạc" (ô chat luôn là trò chuyện).
  - Bấm "Lên kế hoạch" = giống nút xanh dưới cùng (gửi lệnh lập kế hoạch); trong lúc AI đang lập kế hoạch thì ô này sáng.

### 3.2 Tin nhắn
| Loại | Cách hiện |
|---|---|
| Tin của user | Bong bóng phải, nền xanh đậm `#1f3a2a`. Có file đính kèm → chip tên file dưới bong bóng |
| AI `kind = discuss` | Bong bóng trái. `content` giữ xuống dòng (`white-space: pre-line`), nút **Sao chép**. Dưới là thẻ checklist từ `notes`: Đã rõ (`clear`) · Nên hỏi (`questions`) · Rủi ro (`risks`, chữ vàng) · Còn thiếu (`missing`, nếu có). `ready_to_plan = true` → chip xanh "Sẵn sàng lên kế hoạch" |
| AI `kind = question` | Bong bóng trái, chỉ `content` |
| AI `kind = draft` | Thẻ kế hoạch rộng (≤ 720px), mục 3.3 |
| AI đang trả lời | Bong bóng 3 chấm nhấp nháy + chữ "AI đang chia dự án thành cột mốc, việc và việc con…" (khi lập kế hoạch) hoặc "AI đang trả lời…" (khi bàn bạc) |
| Kết quả xếp lịch | Bong bóng trái: `schedule.explanation` + cảnh báo nổi bật (vd ngày quá dày) + nút **Xem & duyệt lịch** (mở màn đề xuất lịch) |

### 3.3 Thẻ kế hoạch (bản nháp)
- Dòng đầu: "Bản nháp: {số} cột mốc · {số} việc · {số} việc con"; đã áp dụng (`applied = true`) → chip "Đã áp dụng".
- Mỗi cột mốc: `title` (đậm) · "hạn {deadline}" · dòng "Vì sao: {reason}".
- Mỗi việc: `title` · "{giờ} · {n} việc con". Bấm việc → mở danh sách `subtasks` (tên · phút · `reason`).
- `numbers`: giờ theo thói quen (vd "4h · thói quen ≈ 5h12"); `warnings[]` hiện dạng dòng vàng; `reminders[]` (cuộc họp) → nút "Tạo task cố định".
- Nút (chỉ khi chưa áp dụng):
  - **Áp dụng & xếp lịch** (chính) → `POST /chat/conversations/{id}/apply-and-schedule` `{message_id, language}`
  - **Chỉ áp dụng** → `POST /chat/conversations/{id}/apply` `{message_id}`
  - (tuỳ chọn) **Sửa trước khi áp dụng** → mở form sửa, gửi kèm `milestones[]`
- Khi đang gọi: thay nút bằng "Đang tạo việc và xếp lịch…" (3 chấm), khóa nút.

### 3.4 Ô nhập
- Nút 📎 đính kèm: pdf, docx, txt, md, **xlsx, csv**; tối đa 3 file/tin, 20 MB/file.
- Ô nhắn: placeholder "Hỏi, bàn bạc, nhờ viết email… (Enter để gửi)". Enter = gửi, Shift+Enter = xuống dòng.
- Nút **Gửi** → `POST /chat/conversations/{id}/messages` `{message, mode: "discuss"}` (có file → `.../messages/files` multipart).
- Nút xanh:
  - chưa có bản nháp: **Lên kế hoạch**; đã có: **Cập nhật kế hoạch**
  - → cùng API, `{message: "", mode: "plan"}` (không cần gõ chữ)
  - đang chờ AI: chữ "Đang lên kế hoạch…", khóa.
- Dòng gợi ý nhỏ dưới ô: "Ô chat = trò chuyện · Nút xanh = lập kế hoạch từ cả cuộc trò chuyện · 1 lượt AI mỗi lần gửi".

---

## 4. Cột phải — Thông tin dự án (thêm / sửa / xóa)

### 4.1 Đầu cột
- Tên dự án, khách, hạn (font mono), nút ✎ sửa dự án (`PUT /api/projects/{id}`).
- Thanh tiến độ: `{việc xong}/{tổng việc} việc xong · {n} cột mốc` (xanh lá).

### 4.2 Cây cột mốc › việc › việc con
| Cấp | Dòng hiện | Nút trên dòng |
|---|---|---|
| Cột mốc | ▸/▾ · tên (đậm) · chip "AI" nếu AI tạo · "hạn dd/mm · n việc" | **+** thêm việc · ✎ sửa · 🗑 xóa |
| Việc (thụt 22px) | ▸/▾ (nếu có việc con) · ☐ ô xong · tên · "4h · 3 con" | **+** thêm việc con · ✎ · 🗑 |
| Việc con (thụt 44px) | tên (chữ nhỏ, xám nhạt) · phút | ✎ · 🗑 |

Hành vi:
- **Thêm**: nút "+ Cột mốc" ở đầu danh sách; "+" trên dòng cha. Dòng mới hiện ngay ở chế độ sửa tên ("Cột mốc mới" / "Việc mới" / "Việc con mới"), cha tự mở ra.
- **Sửa tên**: bấm ✎ → dòng thành ô nhập + **Lưu** / **Hủy** (Enter = Lưu, Esc = Hủy). Sửa phút, hạn, loại việc: form/popover đầy đủ.
- **Xóa**: bấm 🗑 → dòng đổi thành "Xóa việc "…" và 3 mục bên trong?" + **Xóa** (đỏ) / **Hủy**. Không hỏi bằng popup che màn.
- **Xong**: tích ☐ → `PUT /api/tasks/{id}` `Status = Done`; tên gạch ngang, xám; thanh tiến độ cập nhật.
- Mục do AI tạo có chip "AI"; mục user thêm tay không có.
- Trạng thái rỗng: "Chưa có cột mốc nào — Bàn với AI rồi bấm Lên kế hoạch, hoặc tự thêm cột mốc bằng tay."
- Khi có bản nháp chưa áp dụng: khung viền đứt xanh "Bản nháp của AI — chưa áp dụng" liệt kê tên cột mốc (chỉ xem).
- Sau Áp dụng: tải lại cây; mục mới có thể nháy nền 1 lần. `applied.milestones[].reused = true` → toast "Đã thêm vào cột mốc …".

### 4.3 API của cột phải (Backend, tiền tố `/api`, không tốn lượt AI)
| Thao tác | API |
|---|---|
| Tải cây | `GET /api/projects/{id}/milestones`, `GET /api/projects/{id}/tasks`, `GET /api/tasks/{taskId}/subtasks` |
| Cột mốc | `POST /api/projects/{projectId}/milestones` · `PUT /api/milestones/{id}` · `DELETE /api/milestones/{id}` |
| Việc | `POST /api/projects/{projectId}/tasks` · `PUT /api/tasks/{id}` · `DELETE /api/tasks/{id}` |
| Việc con | `POST /api/tasks/{taskId}/subtasks` · `PUT /api/subtasks/{id}` · `DELETE /api/subtasks/{id}` |
| Loại việc (dropdown khi sửa việc) | `GET /api/domains` |

⚠️ **Sửa việc: luôn gửi lại nguyên `AiEstimatedMinutes` đang có.** Backend ghi đè trường này theo request; thiếu là mất số
của AI và hệ thống học thói quen sai. User chỉ sửa `EstimatedMinutes`.
⚠️ Giao cột mốc khi còn việc dở: Backend trả 409 kèm danh sách → hỏi user, đồng ý thì gửi lại `ConfirmOpenTasks = true`.

---

## 5. Trạng thái màn hình (AI chuyển bước)

| Trạng thái | Khi nào | Bước sáng | Giữa | Phải | Nút xanh |
|---|---|---|---|---|---|
| `discuss` | Mặc định, đang bàn | ① | Tin bàn bạc + checklist | Cây hiện tại (hoặc rỗng) | Lên kế hoạch |
| `thinking` | Vừa bấm Lên kế hoạch, chờ API | ② | Bong bóng "Lên kế hoạch" của user + 3 chấm | Như cũ | Đang lên kế hoạch… (khóa) |
| `draft` | API trả `kind = draft`, chưa áp dụng | ② | Thẻ kế hoạch + 2 nút áp dụng | Khung "Bản nháp — chưa áp dụng" | Cập nhật kế hoạch |
| `applying` | Đang gọi apply / apply-and-schedule | ② | Thẻ kế hoạch, nút thành "Đang tạo việc và xếp lịch…" | Như cũ | khóa |
| `applied` | Apply xong | ③ | Thẻ "Đã áp dụng" + tin kết quả xếp lịch | Cây đầy đủ, sửa được | Cập nhật kế hoạch |

- Sau `applied` user vẫn chat tiếp (`discuss`); bấm Cập nhật kế hoạch → bản nháp **chỉ có việc mới** → áp dụng lần nữa.
- Lấy trạng thái khi mở lại chat từ `GET /chat/conversations/{id}`: `latest_draft` có và `applied = false` → `draft`; tin nháp cuối `applied = true` → `applied`; không có nháp → `discuss`.
- Áp dụng & xếp lịch trả `schedule_error` (`quota_exceeded`, `no_active_plan`, `plan_feature_locked`, `schedule_failed`) → vẫn `applied`, tin AI: "Đã tạo việc, chưa xếp được lịch" + nút **Xếp lịch** (`POST /api/schedule/propose` với `task_ids` các việc mới, **gửi tất cả trong 1 request**).

---

## 6. Nhập dự án từ file (nút ở cột trái)

1. Chọn file (xlsx, csv, pdf, docx, txt, md) → `POST /projects/import/preview` (multipart `file`, `language`) → spinner "AI đang đọc file…".
2. Modal xem trước: mỗi dự án 1 thẻ sửa được (tên, hạn, mô tả), `source` (vd "Sheet Việc tháng 12, rows 2-3"), nút "Xem nội dung" (`brief`), nút bỏ. Cảnh báo nếu số dự án > `projects_left`.
3. **Tạo dự án** → `POST /projects/import` → danh sách `{project_id, conversation_id, name}` → cột trái có thêm các chat mới; mở chat dự án đầu tiên (đã có sẵn tin đầu là nội dung từ file).
4. Lỗi: 409 `project_limit` → "Gói của bạn còn tạo được {limit − used} dự án"; 422 file → "Không đọc được file {file}".

---

## 7. Lỗi & trạng thái tải

| Tình huống | Hiện |
|---|---|
| Đang tải lịch sử / cây | Skeleton 4–6 dòng |
| 401 | Về màn đăng nhập |
| 403 `plan_feature_locked` | Thay ô nhập bằng thẻ "Chat AI có ở gói Pro/Premium" + nút nâng cấp; ẩn nút Lên kế hoạch với gói Free |
| 429 | Toast "Bạn đã dùng hết lượt AI của gói" — sửa tay ở cột phải vẫn dùng được |
| 502 | Bong bóng AI lỗi: "AI đang bận, thử lại" + nút **Thử lại** (không bị trừ lượt) |
| 409 `already_applied` / `not_latest_draft` | Tải lại chat, toast ngắn |

---

## 8. Màu & chữ (theo mockup, nền tối)

| Token | Giá trị | Dùng cho |
|---|---|---|
| `--bg` | `#0f1012` | nền trang |
| `--panel` | `#121315` | cột trái, cột phải |
| `--card` | `#1d1f23` | bong bóng AI, thẻ |
| `--field` | `#17181b` | ô nhập, nút phụ |
| `--border` | `#2b2e33` | viền |
| `--text` | `#ececef` | chữ chính |
| `--muted` | `#a1a1aa` | chữ phụ |
| `--accent` | `#4ade80` (chữ trên nền accent `#0b1a10`) | nút chính, bước hiện tại, tiến độ |
| `--user-bubble` | `#1f3a2a` | tin của user |
| `--task-chip` | `#93c5fd` | nhãn chat task |
| `--warn` | `#fbbf24` | rủi ro, cảnh báo |
| `--danger` | `#fca5a5` / viền `#7f1d1d` | xác nhận xóa |

- Font: Inter (chữ), JetBrains Mono (giờ, hạn, số phút). Cỡ: h1 18px, tên dự án cột phải 16px, chữ chat 14px, phụ 12px, nhãn nhóm 11px in hoa.
- Bo góc: thẻ 10–14px, nút 10px, chip 999px.

## 9. Truy cập (a11y)
- Nút chỉ có icon (✎, 🗑, +, ▸) phải có `aria-label` ("Sửa", "Xóa", "Thêm việc", "Mở hoặc thu gọn").
- Ô nhập có `<label>` (ẩn được). Công tắc chế độ dùng `role="group"` + `aria-pressed`.
- Tin AI mới: vùng tin nhắn `aria-live="polite"`.
- Tương phản chữ ≥ 4.5:1 (đã chọn màu theo mức này).

---

Chi tiết từng trường API: tài liệu "API AI cho màn hình (gửi FE)" và Swagger `/docs` của AI service.
