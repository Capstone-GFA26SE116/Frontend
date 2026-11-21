# API AI cho màn hình (gửi FE)

Nov 20, 2026 · @Hieu

AI service có 22 API mà kết quả hiện lên màn hình, xếp dưới đây theo đúng luồng người dùng đi: nhập file → bàn bạc → lên kế hoạch → áp dụng & xếp lịch → làm việc. Mọi API cần header `Authorization: Bearer <token>` như Backend; thời gian trả về theo múi giờ của user.

Hôm nay, Thống kê, Giờ hiệu quả và Xếp lịch hiện đi qua Backend (Frontend → Backend → AI); các API còn lại FE gọi thẳng AI. Nếu team đổi cách gọi thì báo Hiếu. Chữ **đậm** trong bảng = trường hoặc nút mới từ các bản cập nhật gần đây.

## Luồng màn hình

Người dùng đi theo thứ tự dưới đây; các bước 3–5 lặp lại được (chat vẫn mở sau khi Áp dụng). Màn hình nào không có trong bảng thì xem mục "Các màn khác".

| Bước | Màn hình / thao tác | API gọi | Tốn lượt AI |
| --- | --- | --- | --- |
| 1 | Trang Dự án → **Nhập từ file** | `POST /projects/import/preview` | 1 |
| 2 | Xem trước, sửa/bỏ dự án → **Tạo dự án** | `POST /projects/import` | 0 |
| 2' | Hoặc tạo dự án tay (Backend) → **Chat với AI** | `POST /chat/projects/{project_id}/conversations` | 0 |
| 3 | Mở chat của dự án | `GET /chat/projects/{project_id}/conversations` rồi `GET /chat/conversations/{id}` | 0 |
| 4 | Gõ chat để **bàn bạc** (có thể đính kèm file) | `POST /chat/conversations/{id}/messages` (`mode: "discuss"`) hoặc `.../messages/files` | 1 / tin |
| 5 | Bấm **Lên kế hoạch** / **Cập nhật kế hoạch** | cùng API, `mode: "plan"`, `message: ""` | 1 |
| 6a | Bấm **Áp dụng & xếp lịch** (nút chính) | `POST /chat/conversations/{id}/apply-and-schedule` | 1 (phần xếp lịch) |
| 6b | Hoặc **Chỉ áp dụng** | `POST /chat/conversations/{id}/apply` | 0 |
| 7 | Xem đề xuất lịch → Duyệt (Backend đưa lên Google) | `POST /schedule/propose` khi bấm **Xếp lịch** riêng | 1 |
| 8 | Đang làm mà trễ giờ → **Cần thêm X phút** | `POST /schedule/overrun` | 0 |
| 9 | **Lịch sử chat** (menu) | `GET /chat/conversations?q=` | 0 |

## Nhập file → nhiều dự án

Một file (xlsx, csv, pdf, docx, txt, md, tối đa 20 MB) thành 1–20 dự án, mỗi dự án có sẵn 1 cuộc chat chứa phần nội dung của nó. Gói Free không dùng được bước xem trước.

| API | Gửi | Nhận | Màn hình hiện |
| --- | --- | --- | --- |
| `POST /projects/import/preview` | multipart: `file`, `language` (`vi`/`en`) | `file_name`, `projects[]` {`name`, `description`, `deadline`, `source`, `brief`}, `warnings[]`, `project_limit`, `projects_left` | Danh sách dự án cho sửa tên/hạn/mô tả, bỏ bớt; `source` = nằm ở đâu trong file (vd "Sheet Việc tháng 12, rows 2-3"); nút xem `brief`; cảnh báo nếu số dự án > `projects_left` (`null` = không giới hạn) |
| `POST /projects/import` | JSON `{file_name, language, projects[]}` (danh sách đã sửa) | 201 `projects[]` {`project_id`, `conversation_id`, `name`} | Chuyển vào dự án đầu tiên hoặc về danh sách dự án; mở chat bằng `conversation_id` |

Lỗi riêng: xem trước 422 `{code, file}` khi file không đọc được (`unsupported_type`, `no_text`, `unreadable`, `too_large`); tạo 409 `{code: "project_limit", limit, used, wanted}` → "Gói của bạn còn tạo được limit − used dự án" (không dự án nào được tạo); 422 khi tên rỗng/trùng/quá 150 ký tự hoặc hạn đã qua.

## Chat dự án: bàn bạc → kế hoạch → áp dụng

Mỗi dự án 1 cuộc chat (không có nút "chat mới" kiểu ChatGPT). Ô chat = trò chuyện; nút = lệnh. Gói Free không dùng được chat.

| API | Gửi | Nhận | Màn hình hiện |
| --- | --- | --- | --- |
| `POST /chat/projects/{project_id}/conversations` | — | 201 {`conversation_id`, `title`, `status`, `created_at`} | Mở chat mới cho dự án chưa có chat |
| `GET /chat/projects/{project_id}/conversations` | — | danh sách chat của dự án, mới nhất trước | Lấy chat để mở (thường chỉ 1) |
| `GET /chat/conversations/{id}` | — | `messages[]`, `latest_draft`, `status` | Toàn bộ lịch sử chat khi mở lại |
| `POST /chat/conversations/{id}/messages` | `{message, mode, document_ids?}`; `mode`: `discuss` (ô chat) / `plan` (nút, `message` để trống) | `user_message`, `ai_message` | Tin AI theo `kind` (bảng dưới) |
| `POST /chat/conversations/{id}/messages/files` | multipart: `message`, `mode`, `files[]`, `document_ids[]`; tối đa 3 file/tin | như trên | Đính kèm pdf, docx, txt, md, **xlsx, csv** |
| `POST /chat/conversations/{id}/apply-and-schedule` | `{message_id, milestones?, language}` | 201 {`applied`, `schedule`, `schedule_error`} | Nút chính dưới bản nháp; hiện `schedule` bằng màn đề xuất lịch |
| `POST /chat/conversations/{id}/apply` | `{message_id, milestones?}` | 201 {`milestones[]`, `skipped[]`} | Nút phụ "Chỉ áp dụng" |

Tin của AI (`ai_message`) hiện theo `kind`:

| `kind` | Hiện gì |
| --- | --- |
| `discuss` | `content` (giữ xuống dòng: `white-space: pre-line`, có nút **Sao chép**, dài tối đa 4000 ký tự) + bảng bên phải từ `notes`: Đã rõ (`clear`), Còn thiếu (`missing`), Nên hỏi thêm (`questions`), Rủi ro (`risks`); `ready_to_plan = true` → nút Lên kế hoạch sáng lên |
| `draft` | Bản nháp `draft`: mỗi cột mốc `title`, `deadline`, **`reason`** (vì sao có giai đoạn này); mỗi việc `title`, `domain`, `estimated_minutes`, `reason`, **`subtasks[]`** {`title`, `estimated_minutes`, `reason`} (chỉ việc > 2 giờ); `numbers` (giờ theo thói quen), `warnings[]`, `reminders[]` (cuộc họp → gợi ý tạo task cố định); `applied = true` → nhãn "Đã áp dụng", ẩn nút Áp dụng |
| `question` | Chỉ `content` (AI hỏi lại) |

Sửa tay bản nháp rồi Áp dụng: gửi `milestones[]` {`key`, `title`, `deadline`, `tasks[]` {`key`, `title`, `domain_id`, `estimated_minutes`, `subtasks?`}}. Bỏ `subtasks` = giữ việc con của AI; `[]` = không việc con. Kết quả Áp dụng: `milestones[].reused = true` → hiện "Đã thêm vào cột mốc …" thay vì "Tạo cột mốc"; `skipped[]` = việc trùng đã bỏ.

`schedule_error` sau "Áp dụng & xếp lịch" (việc vẫn đã tạo): `quota_exceeded`, `no_active_plan`, `plan_feature_locked`, `schedule_failed` → hiện "Đã tạo việc, chưa xếp được lịch" + nút **Xếp lịch**.

## Xếp lịch

Code xếp giờ (rải đều các ngày, khối ≤ 3 giờ, xen kẽ dự án, tránh giờ trưa), AI chỉ viết câu lý do. Không gì lên Google Calendar cho tới khi user duyệt (API duyệt là của Backend).

| API | Gửi | Nhận | Màn hình hiện |
| --- | --- | --- | --- |
| `POST /schedule/propose` | `{task_ids?, language}` — **gửi TẤT CẢ task đã chọn trong 1 request**, không gọi song song mỗi task 1 request (sẽ ra slot trùng giờ) | `proposal_id`, `is_feasible`, `missing_minutes`, `explanation`, `slots[]` {`task_id`, `subtask_id`, `start`, `end`, `proposed_minutes`, `explanation`}, `warnings[]` {`type`, `task_id`, `message`, …} | Màn đề xuất: mỗi slot + câu lý do; `explanation` là câu tóm tắt; cảnh báo hiện `message` trên đúng thẻ task theo `task_id` |
| `POST /schedule/overrun` | `{slot_id, extra_minutes (5–480), language}` | `kind`, `extended`, `moves[]`, `not_placed[]`, `past_day_end`, `summary` | Khi user báo "Chưa xong, cần thêm X phút": hiện `summary` + danh sách slot bị dời; user đồng ý thì gọi Backend `PUT /api/schedule-slots/{id}` cho từng slot |

Các loại cảnh báo (`warnings[].type`), chỉ cần hiện `message`:

| `type` | Ý nghĩa |
| --- | --- |
| `not_enough_time` | Không đủ giờ trống trước hạn |
| `overdue` | Task đã quá hạn |
| `day_overloaded` | Ngày `day` nhiều việc hơn mức user hay làm (chỉ nhắc, vẫn duyệt được) |
| `beyond_window` | Việc hạn xa hơn 7 ngày chưa xếp hết; bấm Xếp lịch lại sau |
| `calendar_not_synced` | Google Calendar chưa đồng bộ |

`is_feasible = false` chỉ có nghĩa ít nhất 1 task không kịp; các task khác vẫn có slot → đừng báo "còn thiếu" cho cả danh sách. `proposal_id = null` = không có gì để xếp.

## Lịch sử chat

`GET /chat/conversations?q=&limit=&offset=` trả mọi cuộc chat của user (chat dự án và chat chia nhỏ task), tin mới nhất trước; không tốn lượt AI. `limit` 1–50 (mặc định 20), `offset` 0–1000, `has_more` = còn trang sau.

- Mỗi dòng: `scope` (`project` / `task`), `project.name`, `task.name`, `status`, `applied` (nhãn "Đã áp dụng"), `message_count`, `last_message` {`role`, `preview`, `created_at`}.
- Ô tìm `q` (≤ 100 ký tự): tìm trong tin nhắn, tên dự án, tên task; không phân biệt hoa thường, chưa tìm không dấu. Khớp trong tin → `match` {`message_id`, `snippet`} để tô đậm và cuộn tới đúng tin.
- Bấm 1 dòng: `scope = project` → `GET /chat/conversations/{conversation_id}`; `scope = task` → `GET /chat/tasks/{task.id}`.
- Không có nút "Chat mới" ở trang này.

## Các màn khác

| Màn hình | API | Gửi | Hiện gì | Lượt AI |
| --- | --- | --- | --- | --- |
| Chat chia nhỏ 1 task | `POST /chat/tasks/{task_id}/messages`, `GET /chat/tasks/{task_id}`, `POST /chat/tasks/{task_id}/apply` | `{message}`; áp dụng `{message_id, subtasks?}` | Bản nháp việc con {`title`, `estimated_minutes`, `reason`}, `your_estimate_minutes`, `adjusted_minutes`, `warning`, `similar` | 1 / tin |
| Hôm nay (Dashboard) | `GET /briefing/today` | — | `schedule[]`, `all_day[]`, `top_tasks[]` (kèm `reasons[].text`), `at_risk[]`, `productive_hint`, `has_pending_proposal` | 0 |
| Thống kê | `GET /analytics/overview`, `GET /analytics/breakdown` | `range`, `by`, `limit` | Tỉ lệ hoàn thành, mức hay ước thiếu theo loại việc (`domains[].text`, `trend[]`), `insights[].text`; chia theo khách/dự án/task | 0 |
| Giờ hiệu quả (onboarding, Cài đặt) | `PUT /profile/productive-hours/onboarding`, `GET /profile/productive-hours` | `{blocks}` | `onboarded`, `hours[]` (điểm từng giờ), `top_hours` | 0 |
| Việc tương tự (trong chi tiết task) | `GET /memory/similar?task_id=&limit=` | — | `items[]` {`title`, `ratio`, `finished_at`, `stop_reasons`}, `summary.average_ratio` ("thường lâu gấp X lần") | 0 |
| Trợ lý 3D (Mobile, gói Premium) | `POST /assistant/turn` | `{text, language, history[], selected_id?}` | `reply` (đọc to + hiện), `emotion`, `options[]` (khi cần chọn), `suggestions[]`; `kind = confirm` + `action` → hỏi lại, "Có" thì app gọi Backend | 0–1 |

## Thêm, sửa, xóa bằng tay (Backend)

Mọi thứ AI tạo ra, user đều sửa được bằng tay qua API của **Backend** (tiền tố `/api`), không tốn lượt AI. Mỗi màn chi tiết nên có đủ 4 thao tác: thêm, xem, sửa, xóa.

| Đối tượng | Xem | Thêm | Sửa | Xóa / khác | Trường chính khi gửi |
| --- | --- | --- | --- | --- | --- |
| Dự án | `GET /api/projects`, `GET /api/projects/filter`, `GET /api/projects/{id}`, `GET /api/projects/{id}/progress` | `POST /api/projects` | `PUT /api/projects/{id}` | Không xóa: `POST /api/projects/{id}/archive`, `.../restore` | `Name`, `Description`, `StartDate`, `Deadline`, `ClientId` |
| Cột mốc | `GET /api/projects/{projectId}/milestones`, `GET /api/milestones/{id}` | `POST /api/projects/{projectId}/milestones` | `PUT /api/milestones/{id}` | `DELETE /api/milestones/{id}` | `Name`, `OrderIndex`, `DueDate`, `Status`, `RevisionCount`, `ConfirmOpenTasks` |
| Task | `GET /api/projects/{projectId}/tasks?status=`, `GET /api/tasks/{id}` | `POST /api/projects/{projectId}/tasks` | `PUT /api/tasks/{id}` | `DELETE /api/tasks/{id}` | `Title`, `Description`, `TaskType` (`Flexible` / `Fixed`), `Status`, `DomainId`, `MilestoneId`, `Deadline`, `EstimatedMinutes`, `AiEstimatedMinutes`, `FixedStart`, `FixedEnd` |
| Việc con | `GET /api/tasks/{taskId}/subtasks`, `GET /api/subtasks/{id}` | `POST /api/tasks/{taskId}/subtasks` | `PUT /api/subtasks/{id}` | `DELETE /api/subtasks/{id}` | `Title`, `EstimatedMinutes`, `OrderIndex`, `Status` |
| Khung giờ (lịch) | `GET /api/tasks/{taskId}/schedule-slots`, `GET /api/schedule-slots/{id}`, `.../changes` | `POST /api/tasks/{taskId}/schedule-slots` | `PUT /api/schedule-slots/{id}` (kéo-thả đổi giờ) | `DELETE /api/schedule-slots/{id}` | `SubTaskId`, `StartTime`, `EndTime`, `IsManualOverride`, `Status` |
| Khách hàng | `GET /api/clients`, `GET /api/clients/filter`, `GET /api/clients/{id}` | `POST /api/clients` | `PUT /api/clients/{id}` | `DELETE /api/clients/{id}` | `Name`, `ContactEmail`, `Phone`, `Notes` |
| Tài liệu dự án | `GET /api/projects/{projectId}/documents`, `GET /api/documents/{id}`, `.../download` | `POST /api/projects/{projectId}/documents/files` hoặc `.../links` | `PUT /api/documents/{id}` | `DELETE /api/documents/{id}` | file hoặc link |
| Loại việc (dropdown) | `GET /api/domains` | — | — | — | — |
| Đề xuất lịch | `GET /api/schedule/proposals/pending` | `POST /api/schedule/propose` (Backend chuyển sang AI) | — | Duyệt: `POST /api/schedule/proposals/{id}/approve` | — |

Lưu ý khi làm form:

- **Sửa task: gửi lại nguyên `AiEstimatedMinutes` đang có.** Backend ghi đè trường này theo request; gửi thiếu là mất số của AI và hệ thống học thói quen sai. User chỉ sửa `EstimatedMinutes`.
- Task `Fixed` (cuộc họp) cần `FixedStart`, `FixedEnd`; không được xếp lịch và không học thói quen.
- Đánh dấu xong: `PUT /api/tasks/{id}` với `Status = Done` (Backend sẽ gọi AI để học thói quen).
- Giao cột mốc khi còn task dở: Backend trả 409 kèm danh sách; user xác nhận thì gửi lại với `ConfirmOpenTasks = true`.
- Kéo-thả khung giờ đã duyệt: `PUT` với `IsManualOverride = true`.
- Dự án không xóa được, chỉ lưu trữ; tạo dự án bằng tay cũng bị giới hạn số dự án của gói như khi nhập file.

## Mã lỗi chung

| Mã | Khi nào | Hiện cho người dùng |
| --- | --- | --- |
| 401 | Token sai, hết hạn, tài khoản đã xóa | Đăng nhập lại |
| 403 `plan_feature_locked` (`feature`: `chat` / `assistant`) | Gói Free dùng chat/nhập file; gói không phải Premium dùng trợ lý 3D | "Tính năng này có ở gói cao hơn" + nút nâng cấp; nên ẩn nút từ trước |
| 409 `no_active_plan` | User không có gói đang hoạt động | Nhắc chọn gói |
| 409 `already_applied`, `not_latest_draft`, `project_closed`, `domain_inactive` | Bản nháp đã áp dụng / không phải bản mới nhất / dự án đã đóng / loại việc đã tắt | Tải lại chat, báo ngắn |
| 409 `project_limit` | Nhập file vượt số dự án của gói | Số còn tạo được + nút nâng cấp |
| 422 | Dữ liệu gửi sai; file không đọc được (`{code, file}`) | Báo đúng ô/file sai |
| 429 | Hết lượt AI của gói | "Bạn đã dùng hết lượt AI"; tính năng thủ công vẫn dùng được |
| 502 | AI không trả lời (Gemini và dự phòng đều lỗi) | "AI đang bận, thử lại" + nút Thử lại; không bị trừ lượt |

## API không hiện lên màn hình

FE không cần làm gì với các API này: Backend tự gọi.

- `POST /learning/task-completed` — học thói quen (K) khi task chuyển Done.
- `POST /learning/productive-hours/recompute` — tính lại giờ hiệu quả sau mỗi lần dừng bấm giờ.
- `GET /health`, `GET /me` — kiểm tra dịch vụ và token.

Chi tiết từng trường: mở `/docs` của AI service (Swagger) hoặc hỏi Hiếu; danh sách việc của Web/Mobile nằm trong `docs/open-questions.md` của repo AI.
