# Focus session: tài liệu cho Frontend

Dành cho FE dựng màn hình **bấm giờ làm việc (Start / Stop)**, **nhắc việc** và **thông báo**.
Đọc kèm `docs/FOCUS_SESSION_GUIDE.md` nếu cần hiểu phía backend. Trang mẫu chạy được: `/focus-test.html` (Development).

## 0. Quy ước chung

- Base URL: backend (`https://<domain-BE>`). Mọi API cần header `Authorization: Bearer <accessToken>`. Hết hạn (401) thì gọi `POST /api/auth/refresh` như các API khác.
- JSON **camelCase**. Enum là **chuỗi** (`"Timer"`, `"Completed"`), cả khi gửi lên lẫn nhận về.
- Thời gian là ISO 8601 UTC (`2026-10-28T10:15:00+00:00`). Hiển thị theo múi giờ người dùng ở FE.
- **Đồng hồ lấy từ server, không từ máy người dùng** (xem mục 3). FE không gửi giờ nào, trừ `self-report`.
- Lỗi:

| HTTP | Thân | Ý nghĩa |
|---|---|---|
| 400 | `{ "message": "..." }` | Dữ liệu sai hoặc trạng thái không cho phép. Hiện `message` cho người dùng |
| 401 | rỗng | Hết phiên |
| 403 | `{ "message", "code": "FOCUS_SESSION_FORBIDDEN" }` | Phiên của người khác |
| 404 | `{ "message" }` | Không tìm thấy hoặc không phải của bạn |
| 409 | `{ "message", "code": "FOCUS_SESSION_CONFLICT", "details": ... }` | Xung đột, xem từng API |

## 1. Các trạng thái FE cần biết

### Trạng thái slot (`status` của slot, hoặc `status` của item `Source = "Slot"` trong `GET /api/calendar`)

| `status` | Nghĩa | FE hiển thị |
|---|---|---|
| `Proposed` | AI hoặc người dùng đề xuất, chưa duyệt | Nút **Duyệt**. Chưa Start được, chưa có nhắc việc |
| `Approved` | Đã duyệt, chưa tới giờ | Có thể Start sớm (xem cảnh báo bên dưới) |
| `Due` | Đến giờ, chờ người dùng bấm Start | **Nút Start nổi bật** |
| `InProgress` | Đang làm | Đồng hồ chạy, nút **Stop** |
| `Overrun` | Quá giờ dự kiến mà vẫn đang làm | Đồng hồ **đỏ**, nút Stop |
| `Done` | Xong | Đã hoàn thành |
| `Missed` | Hết giờ mà chưa từng Start | "Đã bỏ lỡ", vẫn cho Start làm bù |
| `Skipped`, `Cancelled`, `Postponed` | Bỏ qua, hủy, dời | Ẩn hoặc làm mờ |

Hệ thống **không tự bấm giờ**: tới giờ slot chỉ chuyển `Due` và nhắc. Chỉ khi người dùng bấm Start mới có thời gian làm việc thật.

### Loại ghi nhận của một phiên (`captureMethod`)
`Timer` (người dùng tự bấm), `SelfReported` (tự khai báo), `AutoTimeout` (hệ thống tự ngắt vì quá lâu, cần người dùng xác nhận).

### Lý do dừng (`stopReason`)
`Completed` (xong), `Interrupted` (tạm dừng hoặc bị gián đoạn), `Blocked` (bị chặn), `Other`.

**Không có "pause/resume".** "Tạm dừng" là Stop với `Interrupted`; làm tiếp là Start lại (phiên mới). Một slot có nhiều phiên.

## 2. Các API

Đường dẫn gốc: `/api/focus` (đường cũ `/api/FocusSession` vẫn chạy).

### 2.1 `POST /api/focus/start`: bắt đầu làm

Body:
```json
{ "taskId": "…", "scheduleSlotId": "…", "subTaskId": null, "focusTrackId": null }
```
Chỉ `taskId` là bắt buộc. Không gắn `scheduleSlotId` nghĩa là làm việc ngoài lịch.

**201**:
```json
{
  "sessionId": "…",
  "startedAt": "2026-10-28T10:00:00+00:00",
  "captureMethod": "Timer",
  "plannedMinutes": 60,
  "expectedEndAt": "2026-10-28T11:00:00+00:00",
  "startedEarlyMinutes": 0,
  "warning": null
}
```
- `plannedMinutes = 0` nếu không gắn slot.
- `warning = "STARTED_VERY_EARLY"` khi bắt đầu **sớm hơn 2 giờ** so với giờ của slot. Phiên **đã được tạo**; hãy hiện hộp thoại "Bạn đang bắt đầu sớm hơn lịch X phút, đúng không?". Nếu người dùng bấm "Không", gọi Stop ngay.
- `startedEarlyMinutes > 0` (và không có warning): hiện nhẹ "Bắt đầu sớm X phút".

| HTTP | Khi nào | FE làm gì |
|---|---|---|
| **409** | Đã có một phiên đang chạy. `details` chính là phiên đó (cùng dạng với `GET /current`: `sessionId`, `taskTitle`, `elapsedSeconds`...) | Không báo lỗi đỏ. Chuyển sang màn hình phiên đang chạy. Đây là trường hợp mở hai tab |
| 400 | Slot chưa duyệt (`Proposed`), đã `Done` hoặc `Cancelled`; slot không thuộc task; bài nhạc không tồn tại hoặc đã tắt | Hiện `message` |
| 404 | Task hoặc slot không phải của bạn | |

### 2.2 `GET /api/focus/current`: tôi đang làm gì?

**200**:
```json
{
  "sessionId": "…", "taskId": "…", "taskTitle": "Viết báo cáo",
  "scheduleSlotId": "…", "startedAt": "2026-10-28T10:00:00+00:00",
  "elapsedSeconds": 754, "serverTime": "2026-10-28T10:12:34+00:00", "isOverrun": false
}
```
**204** (không có thân): không có phiên nào đang chạy.

Gọi khi: **mở app, tải lại trang, đổi thiết bị, tab được focus lại**, và sau mỗi thông báo SignalR. Đây là nguồn sự thật cho "có phiên đang chạy không".

### 2.3 `POST /api/focus/{sessionId}/stop`: dừng

Body:
```json
{ "stopReason": "Completed", "note": "Đã gửi file cho khách" }
```
`note` tùy chọn.

**200**:
```json
{ "sessionId": "…", "endedAt": "…", "sessionMinutes": 40.5, "taskTotalMinutes": 65.5, "checkInRequired": true }
```
- `sessionMinutes`: phiên vừa dừng. `taskTotalMinutes`: tổng mọi phiên của task (có phần lẻ, làm tròn khi hiển thị).
- `checkInRequired = true` (với `Completed` và `Other`): nên hiện hộp thoại "Bạn thấy thế nào / xong chưa?". `false` (với `Interrupted`, `Blocked`): người dùng sẽ quay lại, không cần hỏi.
- Slot đổi trạng thái: `Completed` thì `Done`; các lý do còn lại thì quay về `Due` (để hiện lại nút Start).

| HTTP | Ý nghĩa |
|---|---|
| 409 | Phiên đã dừng trước đó (bấm hai lần, hai tab). `details.endedAt` là giờ đã dừng. Coi như thành công, tải lại `/current` |
| 403 / 404 | Không phải của bạn / không tồn tại |

### 2.4 `GET /api/focus/pending-confirmation`: phiên cần xác nhận

Phiên mà **hệ thống tự ngắt** (người dùng quên bấm Stop, chạy quá 2 lần thời gian dự kiến) và chưa được xác nhận. Trả mảng (mới nhất trước), rỗng nếu không có:
```json
[{
  "sessionId": "…", "taskId": "…", "taskTitle": "Viết báo cáo", "scheduleSlotId": "…",
  "startedAt": "…", "endedAt": "…", "systemMinutes": 60
}]
```
Gọi khi mở app và khi nhận thông báo `AUTO_TIMEOUT`. Có phần tử thì hiện hộp thoại hỏi "Bạn thực sự làm bao lâu?" (mặc định điền `systemMinutes`).

### 2.5 `POST /api/focus/{sessionId}/confirm`: xác nhận hoặc loại bỏ phiên bị tự ngắt

| Người dùng chọn | Body |
|---|---|
| "Đúng, đã làm đủ" | `{ "confirmed": true }` |
| "Thực ra tôi làm 45 phút" | `{ "confirmed": true, "correctedMinutes": 45 }` |
| "Bỏ phiên này" | `{ "confirmed": false }` |

**200** `{ "message": "..." }`. Chỉ dùng cho phiên lấy từ `pending-confirmation`; phiên khác trả 400. Phiên chưa xác nhận (hoặc bị loại bỏ) **không được tính vào thời gian làm việc thực tế** và không dùng để học. `correctedMinutes` từ 1 đến 1440 và không được làm giờ kết thúc nằm ở tương lai.

### 2.6 `POST /api/focus/self-report`: quên bấm Start

Body (đây là chỗ **duy nhất** FE gửi giờ):
```json
{
  "taskId": "…", "scheduleSlotId": null,
  "startedAt": "2026-10-28T08:00:00Z", "endedAt": "2026-10-28T09:15:00Z",
  "stopReason": "Completed", "note": null
}
```
**201** `{ "sessionId": "…" }`. Hợp lệ khi `endedAt > startedAt`, cả hai không ở tương lai, và dài tối đa 24 giờ; ngược lại 400. Gắn `scheduleSlotId` và `stopReason = "Completed"` thì slot thành `Done`.

### 2.7 `GET /api/focus/{slotId}/time-summary`: tổng kết một slot
(cũng gọi được ở `GET /api/slots/{slotId}/time-summary`)

```json
{
  "plannedMinutes": 60, "actualMinutes": 65.5, "sessionCount": 2,
  "sessions": [
    { "sessionId": "…", "startedAt": "…", "endedAt": "…", "minutes": 25, "captureMethod": "Timer", "stopReason": "Interrupted" }
  ]
}
```
`actualMinutes` chỉ cộng phiên đáng tin (không tính phiên bị tự ngắt chưa xác nhận). Dùng cho màn hình chi tiết slot: "Dự kiến 60, thực tế 65".

## 3. Cách vẽ đồng hồ (quan trọng)

Người dùng có thể đổi giờ máy, nên **không** tính `Date.now() - startedAt`. Làm như sau:

```ts
// Khi nhận /current (hoặc phản hồi 409 của /start):
const baseElapsed = res.elapsedSeconds;     // server tính
const receivedAt = performance.now();       // đồng hồ đơn điệu của trình duyệt, không bị đổi giờ máy ảnh hưởng

// Mỗi giây:
const elapsed = baseElapsed + (performance.now() - receivedAt) / 1000;
const remaining = plannedMinutes * 60 - elapsed;   // âm nghĩa là đã quá giờ
```
- Đồng bộ lại bằng `GET /current` mỗi 15 đến 30 giây và khi tab được focus (`visibilitychange`), để không lệch dần.
- `isOverrun = true` hoặc `remaining < 0`: đổi sang màu cảnh báo.
- `plannedMinutes` lấy từ phản hồi `start`, hoặc từ `proposedMinutes` của slot / của item calendar.

## 4. Thông báo

Có 3 đường, FE nên làm đủ:

| Đường | Khi nào có | Dùng để |
|---|---|---|
| **SignalR** `/hubs/notifications` | Đang mở app | Hiện toast realtime, cập nhật trạng thái slot ngay |
| **Web Push** | Kể cả khi đóng tab | Thông báo của hệ điều hành |
| **Hộp thư** `GET /api/notifications` | Luôn | Xem lại thông báo đã bỏ lỡ, huy hiệu số chưa đọc |

### 4.1 SignalR
```ts
import * as signalR from "@microsoft/signalr";

const connection = new signalR.HubConnectionBuilder()
  .withUrl(`${API}/hubs/notifications`, { accessTokenFactory: () => getAccessToken() })
  .withAutomaticReconnect()
  .build();

connection.on("ReceiveNotification", (message: string, actionType: string, notificationId: string) => {
  // hiện toast; rồi refetch /current, trạng thái slot, hộp thư
});
await connection.start();
```
- Phải gửi JWT qua `accessTokenFactory` (server đọc `access_token` trên query). Token hết hạn thì `stop()` rồi tạo kết nối mới với token mới.
- Domain FE phải nằm trong `Frontend:AllowedOrigins` của backend (backend đã bật `AllowCredentials`).

`actionType` và việc FE nên làm:

| `actionType` | Khi nào | FE làm gì |
|---|---|---|
| `PRE_START_REMINDER` | 15 phút trước giờ | Toast "Sắp đến giờ" |
| `START_PROMPT` | Đến giờ, slot thành `Due` | Toast kèm nút **Start** |
| `NOT_STARTED` | 20 phút sau giờ mà chưa Start | Nhắc lại |
| `NEAR_END` | Còn 10 phút hết giờ dự kiến | Toast "Sắp hết giờ" |
| `OVERRUN` | Quá giờ 15 phút mà phiên vẫn chạy | Toast "Nhớ bấm Stop" |
| `AUTO_TIMEOUT` | Hệ thống tự ngắt phiên | Gọi `pending-confirmation`, mở hộp thoại xác nhận |
| `CHECK_IN` | Hết giờ, đã làm dở nhưng chưa xong | Hỏi "Công việc đã xong chưa?" |
| `MISSED_SLOT` | Hết giờ mà chưa Start | Hiện "Đã bỏ lỡ" |

### 4.2 Web Push
1. `GET /api/notifications/vapid-public-key` lấy `{ publicKey }`.
2. Đăng ký service worker, rồi `registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(publicKey) })`.
3. Gửi `subscription.toJSON()` lên `POST /api/notifications/subscribe`:
   ```json
   { "endpoint": "https://fcm.googleapis.com/...", "keys": { "p256dh": "…", "auth": "…" } }
   ```
4. Hủy: `POST /api/notifications/unsubscribe` với cùng body, rồi `subscription.unsubscribe()`.

Server gửi payload `{ "title", "body", "action" }` (`action` là một giá trị `actionType` ở bảng trên). Service worker mẫu: `wwwroot/sw.js` của backend. Chỉ chạy trên **https** (hoặc localhost). Một người có thể đăng ký nhiều thiết bị.

### 4.3 Hộp thư
| API | Việc làm |
|---|---|
| `GET /api/notifications?unreadOnly=false&take=50` | Danh sách, mới nhất trước (tối đa 100) |
| `POST /api/notifications/{id}/read` | Đánh dấu đã đọc (204) |
| `POST /api/notifications/read-all` | Đánh dấu hết, trả `{ "updated": n }` |

Mỗi phần tử: `id`, `type`, `title`, `message`, `scheduleSlotId`, `sentAt`, `isRead`, `readAt`.
**Lưu ý:** `type` trong hộp thư chỉ là nhóm lớn `SlotReminder` hoặc `MissedSlot` (database giới hạn). Muốn biết chính xác loại nào thì dựa vào `title`, hoặc vào `scheduleSlotId` cộng với trạng thái slot. Loại chi tiết (`actionType`) chỉ có ở SignalR và Web Push.

## 5. Luồng màn hình gợi ý

**A. Khi mở app (và khi tab được focus lại)**
1. `GET /api/focus/current`: có (200) thì hiện thanh phiên đang chạy với đồng hồ.
2. `GET /api/focus/pending-confirmation`: có phần tử thì hiện hộp thoại xác nhận.
3. `GET /api/notifications?unreadOnly=true`: vẽ huy hiệu số chưa đọc.
4. Kết nối SignalR.

**B. Màn lịch (dùng `GET /api/calendar?from=…&to=…`)**
Item có `source = "Slot"` mang `id` (chính là `scheduleSlotId`), `status`, `taskId`, `title` (tên task), `proposedMinutes`, `start`, `end`. Dựa vào `status` ở mục 1 để quyết định nút. Item `source = "Google"` chỉ để xem, không có nút Start.

**C. Bấm Start**
`POST /api/focus/start` với `taskId` + `scheduleSlotId` của item. Xử lý `warning`, rồi vẽ đồng hồ (mục 3). Gặp 409 thì chuyển sang phiên đang chạy.

**D. Bấm Stop hoặc "Tạm dừng"**
Hộp thoại chọn lý do (`Completed`, `Interrupted`, `Blocked`, `Other`) và ghi chú, rồi `POST /{id}/stop`. Dựa vào `checkInRequired` để hỏi thêm hay không. Sau đó refetch lịch để thấy trạng thái slot mới.

**E. Khi người dùng nói "task đã xong hẳn"**
Dừng phiên không tự đánh dấu **task** xong. Muốn đánh dấu, FE gọi `PUT /api/tasks/{taskId}` với `"status": "Done"`. API này là **thay thế toàn bộ**, nên phải gửi lại đủ các trường hiện có của task (`title`, `taskType`, `domainId`, `deadline`, `estimatedMinutes`... lấy từ `GET /api/tasks/{taskId}`). Khi task chuyển sang `Done`, backend báo cho dịch vụ AI để học từ thời gian thực tế. Backend chưa có API đổi nhanh chỉ trạng thái task.

**F. Quên bấm Start**
Nút "Thêm thủ công": chọn task, giờ bắt đầu và kết thúc trong quá khứ, `self-report`.

**G. Màn chi tiết slot**
`GET /api/focus/{slotId}/time-summary`: dự kiến so với thực tế và danh sách các phiên.

## 6. Việc cần thử khi build

- Mở hai tab, Start ở tab 1 rồi Start ở tab 2: tab 2 nhận 409 và phải hiện phiên đang chạy, không báo lỗi.
- Đóng tab giữa chừng rồi mở lại: đồng hồ phải chạy tiếp đúng giờ (nhờ `/current`).
- Đổi giờ máy: đồng hồ không được nhảy.
- Bấm Stop hai lần: lần hai trả 409, không được báo lỗi đỏ.
- Slot `Proposed` bấm Start: 400, nên ẩn nút này.
- Tạo slot `Approved` bắt đầu sau 1 phút, dài 3 phút để thấy đủ chuỗi `Due`, `Overrun`, tự ngắt (tối đa khoảng 6 phút).

## 7. Chưa có (FE đừng chờ)

- API **check-in** (lưu câu trả lời "thấy thế nào"): `checkInRequired` chỉ là gợi ý hiển thị, chưa có chỗ gửi.
- API đổi nhanh trạng thái task (hiện dùng `PUT /api/tasks/{id}` đủ trường).
- Danh sách lịch sử các phiên theo task (chỉ có tổng kết theo slot).
- `GET /api/notifications` chưa có phân trang theo trang, chỉ có `take`.
