# Những thay đổi backend FE cần sửa theo

Tài liệu này gom mọi thay đổi gần đây ảnh hưởng tới FE: cái nào **phá tương thích** (FE phải sửa), cái nào chỉ **thêm** (FE có thể dùng thêm). Chi tiết từng API nằm ở các tài liệu được trỏ tới.

## Tóm tắt nhanh

| # | Thay đổi | Loại | FE phải làm gì |
|---|---|---|---|
| 1 | Đăng nhập trả thêm `isNewUser` | Thêm | Dùng để đưa người mới vào màn hình onboarding |
| 2 | Onboarding bắt buộc gửi múi giờ, đệm, nhắc trước; `overrunLevel` tùy chọn | **Phá** nếu FE đang gọi onboarding cũ | Màn hình hỏi đủ thông tin, gửi đủ trường bắt buộc |
| 3 | Người dùng mới **không còn dự án "Cá nhân"** tự tạo | **Phá** | Cho tạo dự án đầu tiên trước khi tạo việc; xử lý danh sách dự án rỗng |
| 4 | Đổi giờ làm trong cài đặt thì tính lại giờ hiệu quả | Hành vi | Không cần sửa; có thể ghi chú cho người dùng |
| 5 | Slot không được chồng giờ nhau (`409 SLOT_OVERLAP`) | **Phá** (có lỗi mới) | Bắt lỗi 409 khi tạo, sửa slot và duyệt đề xuất |
| 6 | Bỏ hoàn tiền | **Phá** | Xóa màn hình và lời gọi API hoàn tiền; sửa báo cáo doanh thu |
| 7 | Bỏ nhạc tập trung | **Phá** | Xóa chọn bài nhạc, xóa màn admin thư viện nhạc |
| 8 | Bỏ blind test | Không ảnh hưởng | Không có API nào |
| 9 | Tính năng nhóm (đã có), thêm API admin nhóm | Thêm | Xem [GROUP_FE.md](GROUP_FE.md) và mục 9 dưới đây |
| 10 | Chat nhóm: database đã sẵn sàng, **chưa có API** | Thông tin | Chưa làm màn hình chat nhóm |

---

## 1. Luồng đăng nhập, đăng ký, onboarding, trang home

Không có API đăng ký riêng: đăng ký và đăng nhập là **cùng một API**, lần đầu một email đăng nhập Google thì tài khoản được tạo.

```
Mở app
 ├─ có refreshToken?  ──► POST /api/auth/refresh ── thành công ──► bước 4
 │                                              └─ 401 ──► xóa token, về bước 1
 └─ không ──► 1. Đăng nhập Google: POST /api/auth/google
               2. isNewUser = true  ──► màn hình onboarding (bước 3)
               3. isNewUser = false: GET /api/me, nếu onboardingCompleted = false ──► onboarding
               4. Vào home
```

### 1.1 `POST /api/auth/google` (không cần JWT)
Body `{ "idToken": "<Google ID token>" }`. Kết quả (**thêm trường `isNewUser`**):
```json
{ "userId": "…", "email": "…", "fullName": "…", "role": "Freelancer",
  "accessToken": "…", "expiresAtUtc": "…",
  "refreshToken": "…", "refreshTokenExpiresAtUtc": "…",
  "isNewUser": true }
```
- `isNewUser = true` khi tài khoản **vừa được tạo** hoặc **vừa được nhận** (tài khoản Admin tạo sẵn, chủ nhân đăng nhập lần đầu). Đăng nhập thường và `POST /api/auth/refresh` luôn trả `false`.
- Lần đầu, backend tự tạo: user (role `Freelancer`), **gói Miễn phí vô thời hạn**, 24 dòng hồ sơ giờ làm việc. **Không tạo dự án nào.**
- Múi giờ của tài khoản mới là **`UTC` tạm thời**, người dùng chọn thật ở onboarding.
- Lỗi: tài khoản đã bị xóa `400`; email thuộc một tài khoản Google thật khác `400`.

### 1.2 Màn hình onboarding: `POST /api/me/onboarding`
Người dùng **tự chọn** các mục sau. Lấy danh sách loại công việc bằng `GET /api/domains`.

| Trường | Bắt buộc | Gợi ý cho FE |
|---|---|---|
| `timeZone` | **Có** | Tên IANA. Điền sẵn bằng `Intl.DateTimeFormat().resolvedOptions().timeZone`, cho người dùng đổi |
| `workDayStart`, `workDayEnd` | **Có** | Giờ làm từ đến, dạng `"HH:mm:ss"`; giờ kết thúc phải sau giờ bắt đầu |
| `worksOnWeekend` | **Có** | Có làm cuối tuần không |
| `defaultBufferMinutes` | **Có** | 0 đến 120 phút. Điền sẵn 15, người dùng đổi được, nhưng vẫn phải gửi |
| `reminderLeadMinutes` | **Có** | 0 đến 120 phút. Điền sẵn 15 |
| `productiveHours` | Không | Giờ làm hiệu quả, mỗi giá trị 0 đến 23. **Để trống được** |
| `domainIds` | Không | Loại công việc hay làm (phải đang bật). Để trống được |
| `overrunLevel` | Không | `Rarely`, `Sometimes`, `Often`, `Always`. Bỏ trống thì dùng `Sometimes` |

```json
{ "timeZone": "Asia/Ho_Chi_Minh",
  "workDayStart": "08:00:00", "workDayEnd": "18:00:00", "worksOnWeekend": false,
  "defaultBufferMinutes": 15, "reminderLeadMinutes": 15,
  "productiveHours": [9, 10, 14],
  "domainIds": ["<domainId>"],
  "overrunLevel": "Sometimes" }
```
- Thành công trả `MeDto` với `onboardingCompleted = true`. Gọi lại được để sửa câu trả lời, cờ không bao giờ quay về `false`.
- Thiếu `timeZone`, `defaultBufferMinutes` hoặc `reminderLeadMinutes`, múi giờ không tồn tại, số phút ngoài 0 đến 120, giờ kết thúc không sau giờ bắt đầu, loại công việc không tồn tại hoặc đang tắt, `overrunLevel` lạ: **`400`** và **không lưu gì** (onboarding chưa hoàn tất).
- **`overrunLevel` chỉ có tác dụng khi chọn ít nhất một loại công việc.** Nó không có cột riêng, được đổi thành hệ số "làm lố" (1.10, 1.25, 1.50, 1.80) và lưu cho **từng loại công việc được chọn**. Nên hiện câu hỏi này **cùng bước chọn loại công việc** và chỉ hiện khi đã chọn ít nhất một loại.
- Hệ thống tự chấm 24 điểm giờ làm việc hiệu quả từ giờ làm và `productiveHours`: giờ hiệu quả 0.8, trong khung làm việc 0.5, ngoài khung 0.2. Người dùng không phải nhập 24 dòng.

### 1.3 Chặn vào home khi chưa onboarding: FE tự làm
Backend **không chặn** API khi `onboardingCompleted = false`. FE phải tự kiểm tra bằng `GET /api/me` (hoặc `isNewUser`) và không cho vào home cho tới khi `onboardingCompleted = true`. Tài khoản `Admin` nên đi thẳng khu vực quản trị, không bắt onboarding.

### 1.4 Người dùng mới chưa có dự án
`GET /api/projects` trả **mảng rỗng** cho người dùng mới. Home phải có trạng thái trống và nút **"Tạo dự án đầu tiên"** (`POST /api/projects`, tối thiểu `name`). Không tạo được việc khi chưa có dự án. Hạn mức số dự án theo gói đang dùng (xem `GET /api/me/usage`) và áp dụng cho **mọi** dự án mới; người dùng cũ vẫn có dự án "Cá nhân" tạo trước đây (không tính vào hạn mức như trước).

### 1.5 Các API nên gọi để dựng home
| Cần hiện | API |
|---|---|
| Thông tin người dùng, gói, cờ onboarding | `GET /api/me` |
| Hạn mức gói | `GET /api/me/usage` |
| Dự án | `GET /api/projects` (có thể rỗng) |
| Lịch hôm nay, tuần này | `GET /api/calendar?from=&to=` (tối đa 100 ngày) |
| Phiên làm việc đang chạy | `GET /api/focus/current`, `GET /api/focus/pending-confirmation` |
| Thông báo | `GET /api/notifications`, SignalR `/hubs/notifications` |
| Việc nhóm của tôi, nhóm, lời mời | `GET /api/my-group-tasks`, `GET /api/groups`, `GET /api/group-invitations` |

Chưa có API "Hôm nay" hay dashboard riêng: FE ghép từ các API trên.

### 1.6 Giữ phiên và đăng xuất (không đổi)
- Khi API trả `401`: `POST /api/auth/refresh` `{ "refreshToken": "…" }` nhận access token **và refresh token mới**, phải lưu cả hai. Dùng lại refresh token cũ sau hơn 10 giây bị coi là bị đánh cắp và thu hồi mọi phiên.
- `POST /api/auth/logout` `{ "refreshToken": "…", "allDevices": false }` luôn trả `204`.

## 2. Đổi cài đặt: `PUT /api/me/settings`
Không đổi định dạng (đủ 6 trường: `workDayStart`, `workDayEnd`, `worksOnWeekend`, `defaultBufferMinutes`, `reminderLeadMinutes`, `timeZone`). **Hành vi mới:** khi `workDayStart` hoặc `workDayEnd` đổi, backend **tính lại** 24 điểm giờ làm việc theo khung mới (giờ hiệu quả đã khai báo giữ 0.8; dữ liệu do AI học không đổi). FE không cần làm gì thêm.

## 3. Slot không được chồng giờ nhau: `409 SLOT_OVERLAP`

Áp dụng cho **tạo slot**, **sửa slot** và **duyệt đề xuất AI**. Ví dụ: đã có slot 7h-8h, sửa slot khác thành 7h30-9h thì bị chặn; 8h-9h thì được (chạm đầu mút không tính).

### 3.1 Luật
- Chỉ slot **chiếm giờ** mới chặn và bị chặn: `Approved`, `Due`, `InProgress`, `Overrun`. Các trạng thái `Proposed`, `Done`, `Skipped`, `Missed`, `Cancelled`, `Postponed` không chặn ai và không bị chặn.
- So với mọi slot của **chính người dùng**, kể cả khác task hoặc khác dự án. Slot của người khác không liên quan.
- Khi sửa, chỉ kiểm nếu slot vừa **đổi giờ** hoặc vừa **chuyển sang trạng thái chiếm giờ** (ví dụ `Proposed` sang `Approved`). Sửa ghi chú của slot cũ đã lỡ chồng giờ thì không bị chặn.
- **Chặn cứng**, không có tham số "xác nhận để vẫn tạo".
- Chưa kiểm trùng slot tay với sự kiện Google (chỉ kiểm lúc duyệt đề xuất, như trước).

### 3.2 Tạo và sửa slot
`POST /api/tasks/{taskId}/schedule-slots` và `PUT /api/schedule-slots/{slotId}`. Khi chồng giờ nhận **409**, không lưu gì:
```json
{ "message": "Khung giờ này chồng lên 1 slot đang có (\"Họp nhóm\"). ...",
  "code": "SLOT_OVERLAP",
  "details": { "overlaps": [
    { "slotId": "…", "taskId": "…", "taskTitle": "Họp nhóm", "status": "Approved",
      "start": "2026-10-10T07:00:00+00:00", "end": "2026-10-10T08:00:00+00:00" } ] } }
```
FE nên bắt `409` có `code = "SLOT_OVERLAP"`, hiện `details.overlaps` (slot nào đang chiếm giờ) và cho chọn giờ khác. Nên kiểm trước ở FE (so với lịch đang hiển thị) để báo sớm, nhưng backend là nơi quyết định.

### 3.2b Duyệt đề xuất AI: `POST /api/schedule/proposals/{id}/approve`
- Có slot đề xuất chồng giờ lên slot đang có: **409** `SLOT_OVERLAP`, **không đổi gì**. Mỗi phần tử của `details.overlaps` có `slotId`, `taskId`, `taskTitle`, `start`, `end` của slot đề xuất và `with` (slot đang chiếm giờ: `slotId`, `taskId`, `taskTitle`, `status`, `start`, `end`).
- Gọi lại với `?skipConflicts=true`: các slot chồng giờ chuyển `Cancelled`, phần còn lại `Approved`. Kết quả (`ScheduleProposalDto`) có thêm mảng **`skippedOverlaps`** (cùng cấu trúc như trên). Mọi slot đều chồng giờ thì `400`.
- `GET /api/schedule/proposals/{id}/conflicts` có thêm mảng **`overlaps`** (cùng cấu trúc), trả cả khi chưa kết nối Google (`googleCheck = "NotConnected"`), để cảnh báo trước khi bấm Duyệt.
- Nếu có cả trùng Google và chồng slot: lỗi trùng Google (`SCHEDULE_CONFLICT`) được trả trước. Dùng `skipConflicts=true` bỏ cả hai loại.

Chi tiết màn hình duyệt lịch: [SCHEDULE_REVIEW_FE.md](SCHEDULE_REVIEW_FE.md).

## 4. Đã bỏ: hoàn tiền

**Xóa các API sau** (gọi sẽ `404`):

| API đã bỏ |
|---|
| `POST /api/payments/{paymentId}/refunds` |
| `GET /api/refunds`, `GET /api/refunds/{id}` |
| `POST /api/refunds/{id}/approve`, `/reject`, `/complete` |

- **Báo cáo doanh thu** `GET /api/admin/revenue`: **bỏ các trường** `total.refundedAmount`, `total.netRevenue`, `rows[].refunded`, `rows[].net`. Dùng `total.grossRevenue` và `rows[].revenue` (chính là doanh thu thực). Các trường còn lại không đổi.
- Tiền về nhưng đơn không hợp lệ (sai số tiền, về sau khi đã hủy): hệ thống **không** cấp gói và **không** mở yêu cầu hoàn tiền; admin xử lý ngoài hệ thống. FE nên hiện thông báo kiểu "liên hệ hỗ trợ".
- Hủy giao dịch đã thanh toán trả `400` với lời nhắn "…hãy liên hệ hỗ trợ" (không còn nhắc "yêu cầu hoàn tiền").
- Xem [ADMIN_FE.md](ADMIN_FE.md) và [PAYMENT_UNHAPPY_CASES.md](PAYMENT_UNHAPPY_CASES.md) (đã cập nhật).

## 5. Đã bỏ: nhạc tập trung

- `POST /api/focus/start`: **bỏ trường `focusTrackId`**. Body chỉ còn `{ taskId, subTaskId?, scheduleSlotId? }`. Nếu FE vẫn gửi `focusTrackId`, backend bỏ qua (không lỗi).
- **Xóa các API admin:** `GET`, `POST /api/admin/focus-tracks`, `GET`, `PUT /api/admin/focus-tracks/{id}` (gọi sẽ `404`). Xóa màn hình quản lý thư viện nhạc và ô chọn bài nhạc khi bấm giờ.
- Xem [FOCUS_SESSION_FE.md](FOCUS_SESSION_FE.md), [FOCUS_START_STOP_REWORK_FE.md](FOCUS_START_STOP_REWORK_FE.md) (đã cập nhật).

## 6. Đã bỏ: blind test
Chưa từng có API, không ảnh hưởng FE.

## 7. Tài khoản Admin tạo sẵn
`POST /api/admin/users` (Admin tạo tài khoản trước): không còn tạo dự án "Cá nhân"; múi giờ mặc định `UTC` nếu Admin không nhập. Chủ nhân đăng nhập Google lần đầu bằng đúng email sẽ nhận tài khoản, và kết quả đăng nhập có `isNewUser = true` (cần onboarding như người mới).

## 8. Thay đổi nhỏ khác
- Thông báo có thêm `groupId`, `groupTaskId` (cho thông báo nhóm), xem [GROUP_FE.md](GROUP_FE.md).
- Lỗi mới `403 GROUP_FORBIDDEN` và `409 GROUP_ASSIGNEE_BUSY` thuộc nhánh nhóm.

## 9. API admin cho nhóm (mới)
Chỉ role Admin. Hai thao tác ghi bắt buộc header `X-Admin-Reason` (chữ có dấu thì mã hóa bằng `encodeURIComponent`).

| API | Chức năng |
|---|---|
| `GET /api/admin/groups?search=&status=&ownerId=&page=&pageSize=` | Danh sách mọi nhóm (tên nhóm, chủ nhóm, số thành viên, số việc); `status` là `Active` hoặc `Archived` |
| `GET /api/admin/groups/stats` | Số liệu tổng: nhóm, thành viên, việc theo trạng thái, nhóm mới trong 30 ngày, lời mời đang chờ, phiên bấm giờ đang chạy |
| `GET /api/admin/groups/{id}` | Chi tiết: chủ nhóm, thành viên, báo cáo tiến độ |
| `GET /api/admin/groups/{id}/activity?skip=&take=` | Nhật ký hoạt động của nhóm |
| `POST /api/admin/groups/{id}/archive` | Lưu trữ nhóm (cần `X-Admin-Reason`) |
| `POST /api/admin/groups/{id}/restore` | Khôi phục nhóm (cần `X-Admin-Reason`) |

- Admin không cần là thành viên nhưng **không** thấy nội dung bình luận hay lịch cá nhân.
- Lưu trữ hoặc khôi phục ghi nhật ký admin, ghi vào nhật ký nhóm kèm lý do và gửi thông báo `GroupStatusChanged` cho mọi Leader. Thiếu lý do `400`; nhóm đã ở trạng thái đó `400`; không tồn tại `404`.
- Chưa có: đổi Leader bằng quyền Admin, xóa hẳn nhóm.

## 10. Danh sách việc cho FE (checklist)
- [ ] Đăng nhập: đọc `isNewUser`; chưa onboarding thì không vào home.
- [ ] Màn hình onboarding gửi đủ `timeZone`, `workDayStart`, `workDayEnd`, `worksOnWeekend`, `defaultBufferMinutes`, `reminderLeadMinutes`; xử lý `400`.
- [ ] Hỏi `overrunLevel` cùng bước chọn loại công việc, chỉ khi đã chọn loại công việc.
- [ ] Home và màn dự án xử lý danh sách dự án **rỗng**; có nút tạo dự án đầu tiên.
- [ ] Bắt `409 SLOT_OVERLAP` khi tạo, sửa slot và duyệt đề xuất; dùng `details.overlaps`, `skippedOverlaps`, `overlaps` ở màn duyệt lịch.
- [ ] Xóa mọi màn hình và lời gọi API hoàn tiền; sửa báo cáo doanh thu (bỏ 4 trường).
- [ ] Bỏ `focusTrackId` khi bấm giờ; xóa màn hình admin thư viện nhạc.
- [ ] (Admin) thêm màn quản trị nhóm theo mục 9.
