# Đồng bộ Google Calendar: chọn hướng và khoảng ngày (cho Frontend)

Dành cho FE dựng nút **Đồng bộ** với tùy chọn chọn ngày. Các API kết nối (`connect`, `status`, `disconnect`) giữ nguyên, xem `REPO_GUIDE.md` mục API.

## 1. Một API duy nhất

`POST /api/google-calendar/sync` (cần đăng nhập, không có body)

| Tham số query | Bắt buộc | Ý nghĩa |
|---|---|---|
| `from` | Không | **Ngày** bắt đầu, dạng `yyyy-MM-dd` |
| `to` | Không | **Ngày** kết thúc, dạng `yyyy-MM-dd` |
| `direction` | Không | `FromGoogle` (mặc định), `ToGoogle`, `Both` |

- `from` và `to` là **ngày theo múi giờ của người dùng** (cài đặt `PUT /api/me/settings`), cả hai **gồm trọn ngày đó**. FE chỉ cần gửi ngày từ date picker, không cần đổi sang giờ UTC.
- **Chỉ chọn `from`:** từ đầu ngày `from` đến hết mọi lịch về sau (không có hạn trên).
- **Chỉ chọn `to`:** từ đầu đến hết ngày `to`.
- **Chọn cả hai:** từ đầu ngày `from` đến hết ngày `to`. `to` trước `from` thì `400`.
- **Không chọn gì:** hành vi cũ. Kéo từ Google về theo `syncToken` (chỉ lấy phần thay đổi). Khi `direction` là `ToGoogle` hoặc `Both` mà không chọn ngày thì đẩy **mọi** slot đang sống.

Ví dụ:
```
POST /api/google-calendar/sync                                          // như cũ
POST /api/google-calendar/sync?from=2026-11-15                          // từ 15/11 đến hết về sau, Google → METANOIA
POST /api/google-calendar/sync?from=2026-11-15&to=2026-11-30&direction=Both
POST /api/google-calendar/sync?from=2026-11-15&direction=ToGoogle       // chỉ đẩy slot lên Google
```

## 2. Hai chiều làm gì

| Chiều | Làm gì |
|---|---|
| **Google → METANOIA** (`FromGoogle`) | Lấy sự kiện Google trong khoảng về lưu ở METANOIA (hiện trên `GET /api/calendar`). Sự kiện bị xóa bên Google được đánh dấu hủy |
| **METANOIA → Google** (`ToGoogle`) | Đẩy **slot** trong khoảng lên Google thành sự kiện. Chỉ slot `Approved`, `Due`, `InProgress`, `Overrun`. Slot `Proposed` (chưa duyệt), `Done`, `Skipped`, `Missed`, `Postponed`, `Cancelled` không được đẩy |
| **Cả hai** (`Both`) | Kéo về trước, rồi đẩy lên |

Chi tiết chiều đẩy lên:
- Tiêu đề sự kiện là tên task (nếu slot của subtask thì `Tên task - Tên subtask`), mô tả ghi tên dự án.
- Bấm lại nhiều lần **không sinh sự kiện trùng**: slot đã đẩy thì cập nhật sự kiện cũ.
- Slot đã đẩy mà sau đó bị **hủy (`Cancelled`), bỏ qua (`Skipped`) hoặc hoãn (`Postponed`)** thì lần đồng bộ sau xóa sự kiện trên Google. `Done` và `Missed` giữ lại như lịch sử.
- Người dùng xóa sự kiện bên Google thì lần đẩy sau tạo lại.
- Sự kiện METANOIA đẩy lên **không hiện trùng** với slot trên lịch gộp (`GET /api/calendar`).
- Một slot lỗi (Google trả lỗi) không chặn các slot còn lại: slot đó được đánh dấu `syncFailed`, lần sau thử lại.

## 3. Kết quả (200)

```json
{
  "direction": "Both",
  "mode": "Range",
  "rangeFromUtc": "2026-11-14T17:00:00+00:00",
  "rangeToUtc": "2026-11-30T17:00:00+00:00",
  "added": 3, "updated": 1, "cancelled": 0,
  "pushedCreated": 5, "pushedUpdated": 2, "pushedDeleted": 1, "pushFailed": 0,
  "pushErrors": []
}
```
- `mode`: `Incremental` (không chọn ngày, theo `syncToken`) hoặc `Range` (có chọn ngày, lấy đầy đủ trong khoảng).
- `rangeFromUtc`, `rangeToUtc`: khoảng thực tế đã dùng (UTC); `null` nghĩa là không giới hạn phía đó. `rangeToUtc` là **đầu ngày kế tiếp** của `to` (không gồm).
- `added`, `updated`, `cancelled`: phía kéo về. `pushedCreated`, `pushedUpdated`, `pushedDeleted`, `pushFailed`: phía đẩy lên.
- `pushErrors`: tối đa 5 dòng lỗi đầu tiên (slot nào). Có `pushFailed > 0` thì nên báo "Một số slot chưa đồng bộ được, thử lại sau".

## 4. Lỗi

| HTTP | Khi nào |
|---|---|
| 400 | Chưa kết nối Google Calendar; `to` trước `from`; `from`/`to` hoặc `direction` sai định dạng |
| 409 `GOOGLE_RECONNECT_REQUIRED` | Kết nối hết hạn hoặc bị thu hồi: gợi ý người dùng kết nối lại (`GET /api/google-calendar/connect`) |
| 502 `GOOGLE_API_ERROR` | Google lỗi hoặc mất mạng |

## 5. Lưu ý khi làm giao diện

- Date picker `from` có thể để trống; nếu trống thì coi như "đồng bộ như cũ" (hoặc "tất cả" với chiều đẩy lên).
- Nên hỏi/hiện rõ hướng: "Từ Google về", "Từ METANOIA lên Google", "Cả hai". Mặc định `FromGoogle`, đừng tự gửi `ToGoogle`/`Both` khi người dùng chưa chọn: chiều đẩy lên ghi vào lịch Google của họ.
- Chọn ngày thì **không** làm hỏng đồng bộ tự động (webhook): `syncToken` không bị đụng.
- Sự kiện lặp lại (recurring) của Google được lưu như **một sự kiện gốc**, cùng cách với đồng bộ thường; khoảng ngày chỉ quyết định có lấy sự kiện đó về hay không.
- Sau khi đồng bộ xong hãy tải lại `GET /api/calendar` cho khoảng đang xem.
