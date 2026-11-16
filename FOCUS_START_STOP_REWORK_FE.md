# Làm lại chức năng Start / Stop (hướng dẫn cho Frontend)

Tài liệu này dành cho FE **làm lại** màn hình Start / Stop sau khi backend đổi luồng trạng thái.
Nó chỉ nêu **cái gì đổi** và **FE phải làm gì**. Chi tiết từng API (body, mã lỗi, đồng hồ, thông báo) vẫn ở [FOCUS_SESSION_FE.md](FOCUS_SESSION_FE.md). Luật chuyển trạng thái đầy đủ và sơ đồ ở [STATUS_WORKFLOW.md](STATUS_WORKFLOW.md).

Trang mẫu chạy được để xem hành vi thật: `/focus-test.html` (chế độ Development). Mục 8 của trang có nút **Chạy tất cả kịch bản** tự kiểm tra các luật dưới đây.

---

## 1. Cái gì đã đổi (so với bản cũ)

| # | Trước đây | Bây giờ |
|---|---|---|
| 1 | Start / Stop **không** đổi trạng thái task, subtask | Start làm task `InProgress`. Stop `Completed` trên phiên của subtask làm subtask `Done`. Mọi subtask xong thì task **tự `Done`** |
| 2 | `note` khi Stop luôn tùy chọn | `Blocked` và `Other` **bắt buộc `note`**, thiếu thì `400` (phiên vẫn chạy) |
| 3 | Stop `Blocked` đưa slot về `Due` | Stop `Blocked` đưa slot sang **`Postponed`** (đang chờ, hết nhắc "bấm Start") |
| 4 | Slot chỉ có 6 giá trị trong tài liệu | Slot có **10** giá trị: `Proposed`, `Approved`, `Due`, `InProgress`, `Done`, `Skipped`, `Missed`, `Overrun`, `Postponed`, `Cancelled` |
| 5 | Đổi trạng thái tự do (`PUT`) | Mỗi bảng có **bảng chuyển**; bước sai trả `400`, `message` liệt kê bước hợp lệ |
| 6 | `PUT` không gửi `status` có thể đặt lại mặc định | `PUT` **không gửi `status` thì giữ nguyên** |
| 7 | Không có lịch sử phiên theo task | Có `GET /api/focus/task/{taskId}/sessions` |
| 8 | Phiên `AutoTimeout` chưa xác nhận vẫn làm task `InProgress` | **Không tính** cho tới khi người dùng xác nhận |
| 9 | Giai đoạn (milestone) giao `Delivered` không kiểm tra | Còn task dở thì `409` cảnh báo, xác nhận bằng `confirmOpenTasks` (mục 8) |

**Hệ quả quan trọng nhất:** một lần Start / Stop có thể đổi trạng thái của **nhiều bảng**. FE **không tự tính**, sau mỗi thao tác hãy **tải lại** (mục 5).

---

## 2. Việc FE phải làm lại (checklist)

- [ ] Start: gửi đúng body theo ngữ cảnh (mục 3), xử lý `409` và `warning`.
- [ ] Stop: form chọn **lý do dừng**; khi chọn `Blocked` hoặc `Other` thì **bắt buộc nhập ghi chú** (chặn nút Stop từ phía FE, vẫn xử lý `400` từ server).
- [ ] Sau Start và Stop: **tải lại** task, subtask, slot, milestone, phiên (mục 5). Bỏ mọi chỗ tự tính trạng thái ở FE.
- [ ] Hiển thị trạng thái mới: slot `Postponed`, `Cancelled`, `Overrun`; task `Scheduled`; phiên `PendingConfirmation`, `Discarded` (mục 6).
- [ ] Nút đổi trạng thái chỉ hiện **bước hợp lệ** (bảng ở mục 7). Hiện `message` của lỗi `400`.
- [ ] Task hoặc subtask `Done`/`Skipped`: ẩn hoặc vô hiệu nút Start (server trả `400` nếu vẫn gửi).
- [ ] Đồng hồ vẽ theo giờ **server** (`elapsedSeconds`), không dùng giờ máy.
- [ ] Hộp thoại phiên bị tự ngắt (`AUTO_TIMEOUT`): xác nhận, sửa phút, hoặc loại bỏ.
- [ ] Giao giai đoạn: xử lý `409 MILESTONE_HAS_OPEN_TASKS` (mục 8).

---

## 3. Start

`POST /api/focus/start`

| Người dùng bấm Start ở đâu | Body |
|---|---|
| Task, không lịch | `{ "taskId": "…" }` |
| Slot của task | `{ "taskId": "…", "scheduleSlotId": "…" }` |
| Subtask, không lịch | `{ "taskId": "…", "subTaskId": "…" }` |
| Slot của subtask | `{ "taskId": "…", "subTaskId": "…", "scheduleSlotId": "…" }` |

- Task **không có subtask** thì luôn chỉ gửi `taskId` (kèm `scheduleSlotId` nếu theo lịch). Không cần `subTaskId`.
- `focusTrackId` (bài nhạc) là tùy chọn.
- Backend **không tự lấy** `subTaskId` từ slot: slot gắn subtask thì FE phải gửi `subTaskId` đó.

**201:**
```json
{ "sessionId": "…", "startedAt": "…", "captureMethod": "Timer",
  "plannedMinutes": 60, "expectedEndAt": "…", "startedEarlyMinutes": 0, "warning": null }
```
- `warning = "STARTED_VERY_EARLY"` (sớm hơn lịch hơn 2 giờ): phiên **đã được tạo**; hỏi "Bắt đầu sớm X phút, đúng không?", chọn "Không" thì gọi Stop ngay.
- Sau Start: slot (nếu có) thành `InProgress`, task thành `InProgress`, giai đoạn `Planned` tự lên `InProgress`.

| HTTP | Khi nào | FE làm gì |
|---|---|---|
| **409** `FOCUS_SESSION_CONFLICT` | Đang có phiên chạy. `details` là phiên đó (dạng `GET /current`) | Không báo lỗi đỏ; chuyển sang màn hình phiên đang chạy |
| 400 | Task `Done`/`Skipped` ("Hãy mở lại task trước khi làm việc"); subtask `Done`/`Skipped`; subtask không thuộc task; slot chưa duyệt (`Proposed`), đã `Done`/`Skipped`/`Cancelled`; slot không thuộc task; bài nhạc không tồn tại | Hiện `message` |
| 404 | Task hoặc slot không phải của bạn | |

Slot Start được khi ở: `Approved`, `Due`, `InProgress`, `Overrun`, `Missed`, `Postponed`.

---

## 4. Stop

`POST /api/focus/{sessionId}/stop`, **giống hệt cho task và subtask** (không gửi `subTaskId` khi Stop).

```json
{ "stopReason": "Blocked", "note": "Chờ khách gửi tài liệu" }
```

| `stopReason` | `note` | Slot | Subtask của phiên | Task | `checkInRequired` |
|---|---|---|---|---|---|
| `Completed` (xong) | tùy chọn | `Done` | **`Done`** | suy lại; mọi subtask xong thì tự `Done` | `true` |
| `Interrupted` (gián đoạn) | tùy chọn | `Due` | không đổi | `InProgress` | `false` |
| `Blocked` (bị kẹt, chờ khách) | **bắt buộc** | **`Postponed`** | không đổi | `InProgress` | `false` |
| `Other` (lý do khác) | **bắt buộc** | `Due` | không đổi | `InProgress` | `true` |

**200:**
```json
{ "sessionId": "…", "endedAt": "…", "sessionMinutes": 25, "taskTotalMinutes": 35, "checkInRequired": true }
```
- `taskTotalMinutes` là tổng **cả task** (mọi phiên, mọi subtask), không tách theo subtask.
- `checkInRequired = true` nghĩa là nên hỏi "xong chưa / thấy thế nào". Chưa có API lưu câu trả lời, chỉ là gợi ý hiển thị.

**Lưu ý:**
- Task **không có subtask**: Stop `Completed` chỉ đóng **slot**. Task vẫn `InProgress`, người dùng tự bấm `Done` (`PUT /api/tasks/{id}`). FE nên hỏi "Đánh dấu task này là xong?" sau Stop `Completed`.
- Task **có subtask**: Stop `Completed` trên phiên subtask tự đánh dấu subtask `Done`; subtask cuối xong thì task **tự `Done`**. FE không cần gọi `PUT` thêm.

| HTTP | Ý nghĩa |
|---|---|
| 400 | `Blocked` hoặc `Other` mà thiếu `note`. **Phiên vẫn chạy**: giữ form, cho nhập ghi chú |
| 409 | Phiên đã dừng trước đó (bấm hai lần, hai tab). Coi như thành công, tải lại `/current` |
| 403 / 404 | Phiên của người khác / không tồn tại |

---

## 5. Sau Start / Stop: tải lại những gì

Một thao tác có thể đổi nhiều bảng, nên tải lại thay vì tự suy ra.

| Sau | Tải lại |
|---|---|
| Start | `GET /api/focus/current`; `GET /api/tasks/{taskId}`; slot (`GET /api/tasks/{taskId}/schedule-slots` hoặc lịch) |
| Stop | `GET /api/tasks/{taskId}`; `GET /api/tasks/{taskId}/subtasks`; slot; `GET /api/focus/task/{taskId}/sessions`; nếu task thuộc giai đoạn thì `GET /api/milestones/{id}` |
| Nhận thông báo SignalR | `GET /api/focus/current`, slot, hộp thư (job nền có thể đã đổi trạng thái slot) |

Các điểm `GET`:
- `GET /api/focus/current`: **200** có phiên đang chạy (`sessionId`, `taskId`, `taskTitle`, `scheduleSlotId`, `startedAt`, `elapsedSeconds`, `serverTime`, `isOverrun`); **204** không có phiên. Không có `subTaskId`.
- `GET /api/focus/task/{taskId}/sessions`: mọi phiên của task, có `subTaskId` và `state` (mục 6). **Muốn biết phiên đang chạy thuộc subtask nào sau khi tải lại trang**, lấy phiên có `state = "Running"` ở đây.

---

## 6. Trạng thái FE cần hiển thị

### Slot (10 giá trị)
| `status` | Nghĩa | Gợi ý giao diện |
|---|---|---|
| `Proposed` | AI đề xuất, chưa duyệt | Nút **Duyệt**. Chưa Start được |
| `Approved` | Đã duyệt, chưa tới giờ | Start sớm được |
| `Due` | Tới giờ, chờ bấm Start | Nút Start nổi bật |
| `InProgress` | Đang làm | Đồng hồ + nút Stop |
| `Overrun` | Quá giờ dự kiến mà vẫn đang làm | Đồng hồ đỏ + nút Stop |
| `Done` | Xong | Trạng thái chốt |
| `Missed` | Hết giờ mà chưa Start | "Đã bỏ lỡ"; vẫn cho Start bù |
| `Postponed` | Đang chờ (Stop `Blocked`) | "Đang chờ"; cho Start tiếp hoặc xếp lại |
| `Skipped`, `Cancelled` | Bỏ qua, hủy | Làm mờ. Trạng thái chốt |

### Task: `ToDo`, `Scheduled` (có slot đã duyệt), `InProgress`, `Done`, `Skipped`. Subtask: `ToDo`, `Done`, `Skipped`.

### Phiên (`state` của `GET /api/focus/task/{taskId}/sessions`)
| `state` | Nghĩa | Gợi ý |
|---|---|---|
| `Running` | Đang chạy | Đồng hồ |
| `Stopped` | Dừng thường (Timer) hoặc tự khai (SelfReported) | Hiển thị phút |
| `PendingConfirmation` | Hệ thống tự ngắt, chờ người dùng | Nút Xác nhận / Sửa phút / Loại bỏ |
| `Confirmed` | Tự ngắt đã được xác nhận | Hiển thị phút |
| `Discarded` | Tự ngắt bị loại bỏ | Làm mờ, không tính |

`captureMethod`: `Timer` (bấm thật), `SelfReported` (tự khai sau), `AutoTimeout` (hệ thống tự ngắt). Phiên `AutoTimeout` chưa xác nhận **không tính** vào thời gian thực tế và không làm task `InProgress`.

---

## 7. Nút đổi trạng thái chỉ hiện bước hợp lệ

Server là nơi quyết định; bảng này chỉ để FE ẩn nút sai. Trạng thái do hệ thống đổi (slot `Due`, `InProgress`, `Overrun`, `Missed`; task `Scheduled`, `InProgress`) không cần nút tay.

| Đối tượng | Từ | Sang được bằng tay |
|---|---|---|
| Subtask | `ToDo` | `Done`, `Skipped` |
| Subtask | `Done`, `Skipped` | `ToDo` |
| Task | `ToDo`, `Scheduled`, `InProgress` | `Done`, `Skipped` |
| Task | `Done`, `Skipped` | `ToDo` ("Mở lại") |
| Slot | `Proposed` | `Approved`, `Cancelled` |
| Slot | `Approved`, `Due`, `Missed` | `Postponed`, `Skipped`, `Cancelled`, `Done` (và `Approved` khi dời giờ) |
| Slot | `Postponed` | `Approved`, `Skipped`, `Cancelled`, `Done` |
| Slot | `Done`, `Skipped`, `Cancelled` | không có (chốt) |

- Hủy slot: `DELETE /api/schedule-slots/{id}` (trả `200`, slot thành `Cancelled`, không xóa dòng).
- Đóng task (`Done` hoặc `Skipped`) khi còn subtask `ToDo`: subtask đó tự thành `Skipped`, slot chưa diễn ra thành `Cancelled`. **Không đóng được khi còn phiên đang chạy** (`400`, Stop trước). Nên hỏi xác nhận trước khi đóng.
- `PUT` task, subtask, slot, milestone **thay thế toàn bộ**: lấy bản hiện tại bằng `GET`, gửi lại đủ trường, chỉ đổi `status`.

---

## 8. Giao giai đoạn (Milestone `Delivered`) khi còn task dở

`PUT /api/milestones/{id}` với `status = "Delivered"`:
- Còn task chưa `Done`/`Skipped`: **`409`**, `code = "MILESTONE_HAS_OPEN_TASKS"`, `details = { openTaskCount, openSubTaskCount, tasks: [{ id, title, status, openSubTaskCount }] }`. Giai đoạn chưa đổi.
- FE hiện hộp thoại "Còn N task dở, vẫn giao?" kèm danh sách. Chọn **làm tiếp** thì không làm gì. Chọn **vẫn giao** thì gửi lại cùng body kèm **`confirmOpenTasks: true`**; task dở giữ nguyên.
- Mọi task đã xong (hoặc chưa có task) thì giao thẳng, không cần xác nhận.

---

## 9. Mẫu code (TypeScript)

```ts
type StopReason = "Completed" | "Interrupted" | "Blocked" | "Other";
const NOTE_REQUIRED: StopReason[] = ["Blocked", "Other"];

type FocusStartBody = { taskId: string; subTaskId?: string; scheduleSlotId?: string; focusTrackId?: string };

function buildStartBody(task: { id: string }, opt?: { subTaskId?: string; slot?: { id: string; subTaskId?: string | null } }): FocusStartBody {
  const body: FocusStartBody = { taskId: task.id };
  if (opt?.slot) body.scheduleSlotId = opt.slot.id;
  const sub = opt?.slot?.subTaskId ?? opt?.subTaskId;   // backend không tự lấy subTaskId từ slot
  if (sub) body.subTaskId = sub;
  return body;
}

async function start(body: FocusStartBody) {
  const res = await api.post("/api/focus/start", body);
  if (res.status === 409) return goToRunningSession(res.data.details);     // không báo lỗi đỏ
  if (!res.ok) return showError(res.data.message);                          // 400: task/subtask đã đóng, slot không hợp lệ...
  if (res.data.warning === "STARTED_VERY_EARLY") askConfirmEarlyStart(res.data);
  await refetchAfterStart(body.taskId);
}

async function stop(sessionId: string, taskId: string, reason: StopReason, note: string) {
  if (NOTE_REQUIRED.includes(reason) && !note.trim()) return showFieldError("Hãy ghi rõ lý do");   // chặn trước ở FE
  const res = await api.post(`/api/focus/${sessionId}/stop`, { stopReason: reason, note: note || null });
  if (res.status === 409) return refetchCurrent();                           // đã dừng trước đó: coi như thành công
  if (!res.ok) return showError(res.data.message);                           // 400: phiên vẫn chạy, giữ form
  await refetchAfterStop(taskId);                                            // slot, subtask, task, milestone, sessions
  if (reason === "Completed") offerMarkTaskDoneIfNoSubtasks(taskId);
  if (res.data.checkInRequired) openCheckInDialog();
}

// Đồng hồ: theo giờ server, không dùng Date.now() - startedAt
let base = 0, receivedAt = 0;
function onCurrent(cur: { elapsedSeconds: number }) { base = cur.elapsedSeconds; receivedAt = performance.now(); }
const elapsed = () => base + (performance.now() - receivedAt) / 1000;
```

Đồng bộ lại `GET /api/focus/current` mỗi 15 đến 30 giây và khi tab được focus. Chi tiết đồng hồ và thông báo SignalR, Web Push: [FOCUS_SESSION_FE.md](FOCUS_SESSION_FE.md) mục 9 và 10.

---

## 10. Việc cần thử khi build xong

Dùng `/focus-test.html` để so sánh với bản của bạn. Mỗi dòng nên khớp:

| Làm | Kết quả đúng |
|---|---|
| Start task không subtask, không slot | `201`; task `InProgress` |
| Stop `Completed` trên task không subtask | Slot `Done` (nếu có), task **vẫn** `InProgress` |
| Start subtask A, Stop `Completed` | Subtask A `Done`; task vẫn `InProgress` |
| Start subtask B, Stop `Completed` (B là subtask cuối) | Subtask B `Done`; **task tự `Done`** |
| Stop `Blocked` không ghi chú | `400`; phiên vẫn chạy; form giữ nguyên |
| Stop `Blocked` có ghi chú | Slot `Postponed` |
| Stop `Other` có ghi chú | Slot `Due`; `checkInRequired = true` |
| Stop `Interrupted` | Slot `Due`; task `InProgress` |
| Start khi đang có phiên | `409`; mở phiên đang chạy, không báo lỗi đỏ |
| Start task đã `Done` | `400`; nút Start nên bị ẩn |
| Bấm Stop hai lần | Lần hai `409`, không báo lỗi đỏ |
| Đóng task khi đang có phiên chạy | `400`, Stop trước |
| Đóng task còn subtask `ToDo` | Subtask thành `Skipped`; slot chưa diễn ra `Cancelled` |
| Giao giai đoạn còn task dở | `409`; xác nhận thì giao, task dở giữ nguyên |
| Để phiên chạy quá lâu (job nền) | Phiên `PendingConfirmation`; thông báo `AUTO_TIMEOUT`; task chưa lên `InProgress` vì phiên đó |
| Mở lại trang giữa lúc đang làm subtask | Lấy `subTaskId` từ `GET /api/focus/task/{taskId}/sessions` (phiên `Running`) |

---

## 11. Chưa có (FE đừng chờ)

- Tổng thời gian theo **từng subtask** (chỉ có theo task và theo slot).
- `subTaskId` trong `GET /current`, `time-summary`, `pending-confirmation`; `self-report` chưa nhận `subTaskId`.
- API lưu câu trả lời check-in.
- API đổi nhanh trạng thái (dùng `PUT` đủ trường).
