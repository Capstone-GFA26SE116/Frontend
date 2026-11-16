# Quản trị (Admin): hướng dẫn cho Frontend

Dành cho FE dựng trang quản trị. Mọi API ở đây cần JWT của tài khoản có role **Admin** (không phải Admin: `403`, chưa đăng nhập: `401`). Chi tiết luật: `REPO_GUIDE.md` mục 7.7 và 18.9 (BR-101 đến BR-111b).

## 1. Header lý do `X-Admin-Reason`

Mọi thao tác **ghi** của Admin đều được ghi vào nhật ký (giá trị cũ và mới, ai làm, lúc nào, lý do). Lý do lấy từ header `X-Admin-Reason` (tối đa 1000 ký tự).

**Bắt buộc có lý do** (thiếu thì `400` với `message` "Thao tác quản trị này cần ghi rõ lý do..." và **không đổi gì**):

| Thao tác | API |
|---|---|
| Sửa gói, tắt gói, xóa gói | `PUT`, `DELETE /api/subscription-plans/{id}` |
| Tạo, sửa, xóa gói đăng ký của người dùng | `POST`, `PUT`, `DELETE /api/user-subscriptions` |
| Tạo, sửa, xóa giao dịch | `POST`, `PUT`, `DELETE /api/payment-transactions` |
| Tạo, sửa, xóa hóa đơn | `POST`, `PUT`, `DELETE /api/invoices` |
| Duyệt, từ chối, hoàn tất hoàn tiền | `POST /api/refunds/{id}/approve`, `reject`, `complete` |
| Xóa người dùng | `DELETE /api/admin/users/{id}` |
| Đổi role người dùng | `PUT /api/admin/users/{id}` khi body có `role` |
| Chạy thật đồng bộ lại trạng thái dữ liệu cũ | `POST /api/admin/status-resync?dryRun=false` |

Các thao tác Admin khác (tạo gói, đổi tên người dùng, thư viện nhạc, domain...) lý do là **tùy chọn**; thiếu thì ghi "Không ghi lý do".

### Cách gửi từ FE

`X-Admin-Reason` là **header HTTP**, không nằm trong body hay query, nên trong định nghĩa OpenAPI của các endpoint cũ nó không phải là một trường thông thường. Swagger của backend đã được bổ sung để hiện ô này (bắt buộc với các thao tác ở bảng trên, tùy chọn với các thao tác ghi khác của Admin); FE cứ làm theo bảng trên và đoạn mã dưới đây, không cần chờ field nào trong body.

**Quan trọng: header HTTP chỉ chứa được ký tự Latin-1.** Nếu lý do có chữ có dấu tiếng Việt ("thay đổi giá") mà gửi thẳng, **trình duyệt từ chối ngay** với lỗi `Failed to execute 'fetch' ... String contains non ISO-8859-1 code point` và request không được gửi đi. Cách xử lý: **mã hóa lý do bằng `encodeURIComponent`** trước khi đặt vào header. Server tự giải mã và ghi nhật ký đúng chữ gốc. Lý do không dấu thì gửi thẳng cũng được.

```ts
// Gọi API Admin có lý do. reason là chữ người dùng nhập (có thể có dấu)
async function adminFetch(url: string, init: RequestInit & { reason?: string } = {}) {
  const { reason, headers, ...rest } = init;
  const h = new Headers(headers);
  h.set("Authorization", `Bearer ${getAccessToken()}`);
  if (reason?.trim()) h.set("X-Admin-Reason", encodeURIComponent(reason.trim()));   // bắt buộc mã hóa
  return fetch(`${API}${url}`, { ...rest, headers: h });
}

// Ví dụ: đổi giá gói
const res = await adminFetch(`/api/subscription-plans/${planId}`, {
  method: "PUT",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(plan),
  reason: "Thay đổi giá theo bảng giá mới",
});
if (res.status === 400) showError((await res.json()).message);   // thiếu lý do hoặc dữ liệu sai: hiện message của server
```

Gợi ý giao diện: hiện hộp nhập "Lý do" (bắt buộc, không cho để trống) trước khi gửi các thao tác ở bảng trên, rồi dùng hàm như trên. Nếu quên gửi, server trả `400` với `message` nói rõ cần header `X-Admin-Reason` và **không thực hiện gì**, nên FE chỉ cần hiện lại hộp nhập. Thư viện HTTP khác (axios, ...) cũng làm tương tự: đặt header `X-Admin-Reason` bằng `encodeURIComponent(reason)`.

## 2. Quản lý gói (`/api/subscription-plans`)

| API | Việc |
|---|---|
| `GET /api/subscription-plans` | Danh sách. **Admin thấy tất cả gói** (kể cả đã tắt); người dùng thường chỉ thấy gói đang bán |
| `GET /api/subscription-plans/{id}` | Chi tiết |
| `POST /api/subscription-plans` | Tạo gói |
| `PUT /api/subscription-plans/{id}` | Sửa (cần lý do) |
| `DELETE /api/subscription-plans/{id}` | Xóa (cần lý do). Gói đã có người dùng hoặc giao dịch thì `400`, hãy tắt (`isActive = false`) thay vì xóa |

Trường: `name` (duy nhất không phân biệt hoa thường, tối đa 50), `price` (đồng, không âm), `durationDays` (lớn hơn 0), `aiCallLimit` (trống là không giới hạn), `projectLimit` (trống là không giới hạn, nếu có thì lớn hơn 0), `storageLimitMb` (lớn hơn 0), `isActive`.

- **Gói Miễn phí** là gói rơi về khi gói trả phí hết hạn và là gói của người đăng ký mới: **không tắt được, không đổi giá khác 0, không xóa được** (`400`). Vẫn sửa được tên và hạn mức.
- **Đổi hạn mức có hiệu lực ngay** với mọi người đang dùng gói đó (số dự án và dung lượng được áp dụng khi tạo mới). Người đang vượt hạn mức mới không bị xóa dữ liệu, chỉ không tạo thêm được.

## 3. Quản lý người dùng (`/api/admin/users`)

| API | Việc |
|---|---|
| `GET /api/admin/users?search=&role=&includeDeleted=&page=&pageSize=` | Danh sách phân trang |
| `GET /api/admin/users/{id}` | Chi tiết (kèm số dự án, task, giao dịch, gói hiện tại) |
| `POST /api/admin/users` | Tạo tài khoản trước khi chủ nhân đăng nhập Google (đăng nhập bằng đúng email sẽ nhận tài khoản) |
| `PUT /api/admin/users/{id}` | Sửa (trường để trống thì giữ nguyên). Đổi `role` cần lý do |
| `DELETE /api/admin/users/{id}` | Khóa (xóa mềm): thu hồi mọi phiên đăng nhập, hủy liên kết Google. Cần lý do |
| `POST /api/admin/users/{id}/restore` | Khôi phục |

- Không xóa hoặc hạ quyền **Admin cuối cùng**; Admin không tự xóa mình qua API này. Chính Admin cuối cùng gọi `DELETE /api/me` cũng bị chặn (`400`).
- Đổi role chỉ có hiệu lực với token mới (token cũ giữ role cũ đến khi hết hạn).

## 4. Báo cáo doanh thu

`GET /api/admin/revenue?groupBy=day|month|plan&from=&to=`

| Tham số | Ý nghĩa |
|---|---|
| `groupBy` | `day` (mặc định), `month` hoặc `plan` |
| `from`, `to` | ISO 8601, gồm `from` không gồm `to`. Mặc định 30 ngày gần nhất, tối đa 366 ngày. `to` phải sau `from` |

Quy ước: doanh thu tính theo **ngày thanh toán** (`PaidAt`) của giao dịch `Succeeded`. Hoàn tiền đã hoàn tất (`Completed`) tính vào kỳ **xử lý xong**. Ngày và tháng theo **giờ UTC**. Tiền là số nguyên đồng.

```json
{
  "from": "2026-03-10T00:00:00+00:00", "to": "2026-03-13T00:00:00+00:00", "groupBy": "day",
  "total": { "grossRevenue": 250000, "refundedAmount": 30000, "netRevenue": 220000,
             "succeededTransactions": 3, "averageOrderValue": 83333, "invoicesIssued": 1, "newPayingUsers": 1 },
  "rows": [ { "key": "2026-03-10", "revenue": 150000, "transactions": 2, "refunded": 0, "net": 150000, "sharePercent": 60.0 },
            { "key": "2026-03-11", "revenue": 0, "transactions": 0, "refunded": 0, "net": 0, "sharePercent": 0 } ],
  "transactionsByStatus": { "Succeeded": 3, "Pending": 1, "Failed": 1, "Cancelled": 0, "Expired": 0 }
}
```
- Theo ngày hoặc tháng, `rows` có **đủ mọi mốc** (kể cả mốc bằng 0) nên vẽ biểu đồ không bị hụt. Theo gói, gói doanh thu cao nhất lên đầu, `key` là tên gói.
- `transactionsByStatus` là số giao dịch **được tạo** trong khoảng, theo từng trạng thái (đủ 5 loại).
- Tính năng hoàn tiền hiện đang tắt (`Payments:RefundsEnabled`), nên `refundedAmount` thường là 0.

### Danh sách giao dịch và hóa đơn (để xem chi tiết dưới báo cáo)
- `GET /api/payment-transactions?status=&userId=&planId=&from=&to=&page=&pageSize=`: lọc theo trạng thái, người dùng, gói, ngày tạo.
- `GET /api/invoices?userId=&from=&to=&search=&page=&pageSize=`: lọc theo người dùng, ngày phát hành, từ khóa (số hóa đơn, tên gói, tên và email thanh toán).
- Không truyền tham số thì trả đầy đủ như trước. Có `page` hoặc `pageSize` thì phân trang (`page` từ 1, `pageSize` 1 đến 100, mặc định 20) và tổng số dòng nằm ở header **`X-Total-Count`**.
- Người dùng thường dùng cùng API này nhưng chỉ thấy của mình, `userId` bị bỏ qua.

## 5. Nhật ký thao tác (`GET /api/admin/audit-logs`)

`?adminId=&targetType=&targetId=&action=&from=&to=&page=&pageSize=` (mới nhất trước).

- `action` có dạng `<Bảng>.<Create|Update|Delete>`, ví dụ `SubscriptionPlan.Update`, `User.Delete`. Riêng đồng bộ trạng thái dữ liệu cũ là `StatusResync.Run`.
- `oldValue`, `newValue` là JSON: với `Update` chỉ gồm các trường **thực sự đổi** (trước và sau); `Create` chỉ có `newValue`; `Delete` chỉ có `oldValue`.
- `reason` là nội dung header `X-Admin-Reason`.
- Nhật ký chỉ đọc: không có API sửa hay xóa nhật ký.
- Chỉ ghi **thay đổi**; không ghi lần đăng nhập hay lần đọc dữ liệu.

## 6. Đồng bộ lại trạng thái dữ liệu cũ

`POST /api/admin/status-resync?dryRun=true|false`: mặc định **chạy thử** (`dryRun = true`, không lưu, trả danh sách thay đổi sẽ xảy ra). Chạy thật (`dryRun=false`) cần lý do và để lại một dòng nhật ký `StatusResync.Run`. Chi tiết: `STATUS_WORKFLOW.md` mục 9.

## 7. Việc cần thử khi build

- Người dùng thường gọi API Admin: `403`. Chưa đăng nhập: `401`.
- Sửa gói không gửi lý do: `400`, giá không đổi. Gửi lý do: `200`, và lý do hiện ở nhật ký.
- Tắt hoặc đổi giá gói Miễn phí: `400`.
- Người dùng thường mở danh sách gói: không thấy gói đã tắt. Admin: thấy.
- Báo cáo doanh thu kỳ không có giao dịch: mọi số bằng 0, `rows` vẫn đủ mốc.
- Khoảng ngày sai (`to` trước `from`, quá 366 ngày), `groupBy` lạ: `400`.
- Lọc giao dịch theo `status=Succeeded`, phân trang `page=2&pageSize=20` và đọc `X-Total-Count`.
