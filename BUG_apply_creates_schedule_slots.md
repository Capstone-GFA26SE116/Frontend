# Bug — `POST /chat/tasks/{task_id}/apply` tự tạo `ScheduleSlot` (vi phạm FR-08b-1 #10)

Trạng thái: Chờ Backend xác nhận & sửa · Ngày: 2026-11-12 · Phía gửi: Frontend

---

## 1. Tóm tắt

Khi user bấm **"Accept & apply subtasks"** trong `/copilot`, hệ thống **tự động tạo schedule slot** (khung giờ) cho task
và ghi thẳng vào calendar — **bỏ qua** toàn bộ bước duyệt khung giờ của người dùng.

Theo hợp đồng `FR-08b-1.md` #10 và workflow `Workflow.md` (MW-05 / MW-06), endpoint `apply` **chỉ được**
tạo `Subtask`. Việc xếp lịch phải đi qua 2 bước riêng có bước duyệt của user:

```
① POST /chat/tasks/{task_id}/apply          → tạo SUBTASK (duyệt subtask)
② POST {AI}/schedule/propose                → AI TÍNH khung giờ (không ghi DB)
③ POST /api/tasks/{taskId}/schedule-slots   → tạo SLOT (duyệt khung giờ) ← chỉ bước này mới vào lịch
```

Hiện tại bước ① đang làm luôn việc của bước ③.

---

## 2. Hành vi mong đợi

| Bước | Hành động | API | Ghi DB |
|---|---|---|---|
| ① | "Accept" (trong `/copilot`) | `POST /chat/tasks/{task_id}/apply` | `Subtask` ✅ |
| ② | "Auto-schedule" (trong `/schedule`) | `POST {AI}/schedule/propose` | **không** ✅ |
| ③ | Tick subtask/slot → "Apply" | `POST /api/tasks/{taskId}/schedule-slots` | `ScheduleSlot` ✅ |

**`apply` không được tạo `ScheduleSlot`.**

> 📌 **Cập nhật FE (2026-11-12)**: nút ở `/copilot` đã đổi từ *"Accept & apply subtasks"* → **"Accept"**,
> và FE **không** tự mở panel đề xuất sau khi Accept. Toàn bộ bước ② + ③ nằm ở `/schedule`:
> bấm **"Auto-schedule"** → AI trả khung giờ (có `subtask_id` cho từng subtask) → user tick → bấm **"Apply"**.

---

## 3. Hành vi thực tế (bug)

| Bước | Hành động | API | Ghi DB |
|---|---|---|---|
| ① | "Accept" | `POST /chat/tasks/{task_id}/apply` | `Subtask` ✅ **+ `ScheduleSlot` ❌** |
| ② | — | — | — |
| ③ | — | — | — |

Kết quả: user **không có cơ hội duyệt khung giờ** — slot đã nằm trong calendar trước khi user kịp thấy đề xuất.

> 📌 **Cập nhật FE (2026-11-12)**: FE đã tự tách bước ② ra khỏi `/copilot` (nút "Accept" giờ chỉ tạo subtask,
> không tự mở proposal). Nhưng nếu BE vẫn tự tạo slot ở bước ① thì slot vẫn xuất hiện trong lịch
> **trước khi** user bấm "Auto-schedule" → "Apply" ở `/schedule`. Bug vẫn cần BE sửa.

---

## 4. Trích dẫn hợp đồng

### `FR-08b-1.md` — Quyết định #10 (mục "Vấn đề & quyết định")

> | 10 | Apply | **Chỉ tạo mới `Milestone` + `Task` (`Flexible`, `ToDo`). Không tạo `ScheduleSlot`** | User bấm "Xếp lịch" (FR-10) sau. |

### `FR-08b-1.md` — Mục tiêu, phần "Ngoài phạm vi"

> **Ngoài phạm vi:** … **tự xếp lịch sau Apply** (user bấm FR-10) …

### `Workflow.md` — MW-05 (bước 13–17)

> 13. Click "Accept & apply subtasks" → 14. `POST /chat/tasks/{task_id}/apply` → **15. Real subtasks written to DB** + a confirmation message injected into the stream

### `Workflow.md` — MW-06 (bước 1–14)

> 1. Click "Đề xuất lịch" → 2. Collect eligible tasks … → 3. For **each** task, issue a separate `POST {AI}/schedule/propose` → … → 8. Render the slots (ticked by default) → 9. User ticks / unticks → 10. Click "Thêm vào lịch" (Add to calendar) → 11. For **each** ticked slot: `POST /api/tasks/{taskId}/schedule-slots` with the **matching** `scheduleProposalId`

---

## 5. Đề xuất sửa

### Phương án A (khuyến nghị) — Bỏ hẳn việc tạo slot khỏi `apply`

`POST /chat/tasks/{task_id}/apply` chỉ tạo `Subtask`. Xoá đoạn code gọi
`POST /api/tasks/{taskId}/schedule-slots` (hoặc tương đương) khỏi luồng apply.

**Lý do:** giữ đúng hợp đồng đã ký (`FR-08b-1` #10), không cần đổi API, FE đã chạy đúng 3 bước.

### Phương án B — Thêm cờ tắt mặc định

Thêm vào `ApplyRequest`:

```json
{
  "message_id": "uuid",
  "subtasks": null,
  "auto_schedule": false
}
```

Mặc định `false`. FE hiện tại gửi `auto_schedule: false`; nếu client cũ không gửi field → coi như `false`.

> ⚠️ Phương án B vẫn giữ được hành vi cũ cho client khác, nhưng **phải** đảm bảo mặc định là `false` — nếu
> mặc định `true` thì bug vẫn xảy ra với mọi client không gửi field.

---

## 6. Ảnh hưởng

| Hạng mục | Ảnh hưởng |
|---|---|
| Người dùng | Mất quyền kiểm soát lịch — slot tự xuất hiện trong calendar, không có bước duyệt |
| Dữ liệu | `ScheduleSlot` có thể trùng với slot mà user sẽ duyệt ở bước ③ (double-booking) |
| `ScheduleProposalId` | Slot tạo tự động không gắn `scheduleProposalId` hợp lệ → khó truy vết nguồn |
| Báo cáo | Số slot trong báo cáo "kế hoạch vs thực tế" lệch với ý định của user |
| Quota AI | `apply` vẫn tốn lượt như đặc tả — **không** phải vấn đề quota |

---

## 7. Kiểm chứng lại từ phía Frontend

Frontend **không** có đường nào tự tạo slot ngoài ý muốn:

- `applyTaskChat()` → `POST {AI}/chat/tasks/{task_id}/apply` (AI service) — không gọi endpoint slot.
- `createScheduleSlot()` → `POST /api/tasks/{taskId}/schedule-slots` (BE) — **chỉ** được gọi từ
  `useScheduleProposal.approve()`, tức là sau khi user tick slot và bấm "Thêm vào lịch".
- Sau `apply`, FE chỉ đọc `GET /api/tasks/{taskId}/schedule-slots` để đồng bộ state — thao tác đọc, không ghi.

→ Khả năng tạo slot tự động nằm ở phía **AI service** (bước ①), không nằm ở Frontend.

---

## 8. Đề xuất test cho Backend

| ID | Tình huống | Kết quả mong đợi |
|---|---|---|
| B1 | Apply 1 task có 3 subtask | Chỉ tạo 3 `Subtask`; `GET /api/tasks/{id}/schedule-slots` → **rỗng** |
| B2 | Apply → sang `/schedule` bấm "Auto-schedule" | `propose` trả về khung giờ **có `subtask_id`** cho từng subtask; chưa có slot nào trong calendar |
| B3 | Tick 2 slot → "Apply" | `GET /api/tasks/{id}/schedule-slots` → đúng 2 slot, `scheduleProposalId` khớp, `subTaskId` đúng |
| B4 | Apply task đã có slot từ lần trước | Không tạo thêm slot; `subtask_id` gắn đúng slot cũ nếu có |
| B5 | Apply không gửi `auto_schedule` (client cũ) | **Không** tạo slot (mặc định phải là tắt) |
| B6 | Task có 3 subtask, đã xếp lịch 1 subtask | Bấm "Auto-schedule" → AI **chỉ** đề xuất cho 2 subtask còn lại |
