# Tài liệu dự án (Project documents): tài liệu cho Frontend

Dành cho FE dựng chức năng **kho tài liệu của dự án**: tải file lên, thêm liên kết, xem danh sách, lọc, tải về, sửa, xóa.
Mọi API cần header `Authorization: Bearer <accessToken>` (hết hạn thì `POST /api/auth/refresh` như các API khác).

---

## 1. Khái niệm

- Mỗi tài liệu **thuộc một dự án** (`projectId`) và người dùng chỉ thấy tài liệu của dự án của mình.
- Có **hai loại** (`sourceType`):

| `sourceType` | Là gì | Có file để tải? |
|---|---|---|
| `File` | File tải lên từ máy (tối đa **20 MB**) | Có, qua `GET /api/documents/{id}/download` |
| `Link` | Đường dẫn tới nơi khác (Google Drive, Figma, Notion...) | Không. FE mở thẳng `linkUrl` |

- Mỗi tài liệu có **`tag`** để phân loại: `Brief` (yêu cầu của khách), `Contract` (hợp đồng), `Design` (thiết kế), `Other` (mặc định).
- Tìm theo **tên** (`search`) và lọc theo `tag`, `sourceType`, `projectId`.

## 2. Quy ước chung

- JSON **camelCase**. Thời gian là ISO 8601 UTC.
- Lỗi:

| HTTP | Thân | Ý nghĩa |
|---|---|---|
| 400 | `{ "message": "..." }` | Dữ liệu sai (tag lạ, file quá lớn, link sai...). Hiện `message` cho người dùng |
| 401 | rỗng | Hết phiên |
| 403 | rỗng | Xem tài liệu của người khác mà không phải Admin |
| 404 | `{ "message": "..." }` | Không tìm thấy hoặc không phải của bạn (cả dự án lẫn tài liệu) |

## 3. Dữ liệu trả về

**Tài liệu** (`ProjectDocumentDto`), trả ở các API một dự án và API theo id:
```json
{
  "id": "…", "projectId": "…", "name": "Hop dong.pdf",
  "sourceType": "File", "linkUrl": null, "sizeBytes": 183204,
  "tag": "Contract", "uploadedAt": "2026-11-08T09:30:00+00:00"
}
```
- `File`: có `sizeBytes`, `linkUrl = null`. `Link`: có `linkUrl`, `sizeBytes = null`.
- `name` là tên hiển thị **và là tên file khi tải về** (xem mục 7).

**Tài liệu trong danh sách gom nhiều dự án** (`ProjectDocumentListItemDto`): như trên, **thêm**:
```json
{ "...": "...", "projectName": "Website", "userId": "<chủ dự án>" }
```

```ts
type DocTag = "Brief" | "Contract" | "Design" | "Other";
type DocSource = "File" | "Link";

interface ProjectDocument {
  id: string; projectId: string; name: string;
  sourceType: DocSource; linkUrl: string | null; sizeBytes: number | null;
  tag: DocTag; uploadedAt: string;
}
interface ProjectDocumentListItem extends ProjectDocument { projectName: string; userId: string; }
interface Paged<T> { items: T[]; page: number; pageSize: number; totalCount: number; }
```

## 4. Danh sách API

| API | Việc làm | Quyền |
|---|---|---|
| `GET /api/projects/{projectId}/documents` | Tài liệu **của một dự án** | Chủ dự án |
| `GET /api/documents/by-project/{projectId}` | Giống hệt API trên (đường dẫn thứ hai) | Chủ dự án |
| `GET /api/documents` | Tài liệu **của tôi qua mọi dự án** | Đăng nhập |
| `GET /api/documents/by-user/{userId}` | Tài liệu của **một người dùng** | Chính mình; người khác chỉ **Admin** |
| `GET /api/documents/all` | Tài liệu của **mọi người dùng**, có phân trang | Chỉ **Admin** |
| `POST /api/projects/{projectId}/documents/files` | **Tải file lên** | Chủ dự án |
| `POST /api/projects/{projectId}/documents/links` | **Thêm liên kết** | Chủ dự án |
| `GET /api/documents/{documentId}` | Xem một tài liệu | Chủ tài liệu |
| `PUT /api/documents/{documentId}` | Sửa tên, tag, hoặc link | Chủ tài liệu |
| `DELETE /api/documents/{documentId}` | Xóa | Chủ tài liệu |
| `GET /api/documents/{documentId}/download` | Tải file về (chỉ loại `File`) | Chủ tài liệu |

## 5. Bộ lọc của các API danh sách

Tất cả đều là query string, **tùy chọn**, kết hợp được với nhau:

| Tham số | Áp dụng cho | Ý nghĩa |
|---|---|---|
| `search` | mọi API danh sách | Tên **chứa** chuỗi, không phân biệt hoa thường. Chỉ tìm trong **tên**, không tìm trong nội dung file hay URL |
| `tag` | mọi API danh sách | `Brief`, `Contract`, `Design`, `Other`. Sai giá trị: 400 |
| `sourceType` | `/api/documents`, `/by-user`, `/all` | `File` hoặc `Link`. Sai giá trị: 400 |
| `projectId` | `/api/documents`, `/by-user`, `/all` | Chỉ trong một dự án |
| `userId` | `/all` | Chỉ của một người dùng |
| `page`, `pageSize` | `/all` | `page` từ 1 (mặc định 1), `pageSize` từ 1 đến 100 (mặc định 20); sai thì 400 |

Kết quả sắp **mới nhất trước**. Chỉ `/all` có phân trang, các API còn lại trả hết (mảng JSON).

Ví dụ: lấy các file hợp đồng có tên chứa "hop" ở mọi dự án của tôi:
`GET /api/documents?tag=Contract&sourceType=File&search=hop`

**Phản hồi của `/all`:**
```json
{ "items": [ /* ProjectDocumentListItem */ ], "page": 1, "pageSize": 20, "totalCount": 57 }
```

## 6. Chi tiết từng thao tác

### 6.1 Tải file lên: `POST /api/projects/{projectId}/documents/files`
Gửi `multipart/form-data`:

| Trường form | Bắt buộc | Ý nghĩa |
|---|---|---|
| `File` | **Có** | File cần tải (viết hoa chữ `F`) |
| `Name` | Không | Tên hiển thị. Bỏ trống thì lấy **tên file gốc** |
| `Tag` | Không | `Brief`, `Contract`, `Design`, `Other`. Bỏ trống thì `Other` |

**201** trả `ProjectDocument`. Lỗi:

| HTTP | Khi nào |
|---|---|
| 400 | File rỗng (0 byte) hoặc **lớn hơn 20 MB**; `Name` quá 255 ký tự; `Tag` sai |
| 413 | Request vượt khoảng 21 MB (bị chặn trước khi vào xử lý) |
| 404 | Dự án không phải của bạn |

Nên **kiểm tra ngay ở FE**: `file.size > 20 * 1024 * 1024` thì báo lỗi, khỏi gửi lên.

### 6.2 Thêm liên kết: `POST /api/projects/{projectId}/documents/links`
```json
{ "name": "Brief Figma", "tag": "Design", "linkUrl": "https://figma.com/file/abc" }
```
- `linkUrl` **bắt buộc**, phải là `http` hoặc `https` hợp lệ, tối đa 2000 ký tự.
- `name` **nên luôn gửi**. Nếu bỏ trống, backend lấy phần cuối của URL làm tên; URL kết thúc bằng `/` thì tên rỗng và bị **400**.
- **201** trả `ProjectDocument` (`sourceType = "Link"`).

### 6.3 Sửa: `PUT /api/documents/{documentId}`
```json
{ "name": "Hợp đồng v2.pdf", "tag": "Contract" }
```
- **Chỉ trường nào gửi lên mới được đổi** (không như `PUT` thay thế toàn bộ ở API khác). Bỏ trường = giữ nguyên.
- Có thể đổi `name`, `tag`, và `linkUrl` (**chỉ với loại `Link`**; gửi `linkUrl` cho tài liệu `File` thì 400).
- **Không đổi được nội dung file**: muốn thay file thì xóa rồi tải lại.
- **200** trả `ProjectDocument` đã cập nhật.

### 6.4 Xóa: `DELETE /api/documents/{documentId}`
**204** (không thân). Xóa tài liệu và file đi kèm (nếu là `File`).

### 6.5 Tải file về: `GET /api/documents/{documentId}/download`
- Trả nội dung file (`application/octet-stream`, tên file lấy từ `name`).
- Loại `Link` gọi API này thì **400** ("là liên kết, không có file để tải về"): với link, FE mở thẳng `linkUrl`.
- **404** với thông báo "File không còn trong kho lưu trữ" khi dòng tài liệu còn nhưng file đã mất ở server: hiện thông báo "Hãy tải file lên lại".
- API cần header `Authorization`, nên **không dùng thẻ `<a href>` trực tiếp** (trình duyệt không gửi được header). Làm như mục 8.

## 7. Điều cần biết về tên file

Tên file khi tải về chính là `name`. Nếu người dùng đổi `name` thành "Hop dong" (không có đuôi) thì file tải về **không có đuôi** (`.pdf`). Khi cho sửa tên, FE nên **giữ đuôi file** hoặc cảnh báo.

## 8. Mã mẫu

**Danh sách (có lọc):**
```ts
async function listMyDocuments(f: { projectId?: string; search?: string; tag?: DocTag; sourceType?: DocSource } = {}) {
  const q = new URLSearchParams(Object.entries(f).filter(([, v]) => v) as [string, string][]);
  const res = await fetch(`${API}/api/documents?${q}`, { headers: { Authorization: `Bearer ${token()}` } });
  if (!res.ok) throw new Error((await res.json()).message ?? res.statusText);
  return (await res.json()) as ProjectDocumentListItem[];
}
```

**Tải file lên** (đừng tự đặt `Content-Type`, trình duyệt tự thêm `boundary`):
```ts
async function uploadFile(projectId: string, file: File, name?: string, tag?: DocTag) {
  if (file.size > 20 * 1024 * 1024) throw new Error("File tối đa 20 MB.");
  const form = new FormData();
  form.append("File", file);                 // viết hoa chữ F
  if (name) form.append("Name", name);
  if (tag) form.append("Tag", tag);
  const res = await fetch(`${API}/api/projects/${projectId}/documents/files`, {
    method: "POST", headers: { Authorization: `Bearer ${token()}` }, body: form,
  });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).message ?? `Lỗi ${res.status}`);
  return (await res.json()) as ProjectDocument;
}
```

**Thêm liên kết:**
```ts
await fetch(`${API}/api/projects/${projectId}/documents/links`, {
  method: "POST",
  headers: { Authorization: `Bearer ${token()}`, "Content-Type": "application/json" },
  body: JSON.stringify({ name: "Brief Figma", tag: "Design", linkUrl: "https://figma.com/file/abc" }),
});
```

**Tải về** (gửi kèm token rồi lưu thành file):
```ts
async function downloadDocument(doc: ProjectDocument) {
  const res = await fetch(`${API}/api/documents/${doc.id}/download`, { headers: { Authorization: `Bearer ${token()}` } });
  if (res.status === 404) throw new Error("File không còn trong kho lưu trữ. Hãy tải file lên lại.");
  if (!res.ok) throw new Error((await res.json()).message ?? `Lỗi ${res.status}`);
  const url = URL.createObjectURL(await res.blob());
  const a = Object.assign(document.createElement("a"), { href: url, download: doc.name });
  document.body.append(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
}
```

**Sửa tên hoặc tag:** `PUT /api/documents/{id}` với `{ name?, tag? }` (chỉ gửi trường cần đổi).

## 9. Luồng màn hình gợi ý

**A. Tab "Tài liệu" trong trang dự án**
`GET /api/projects/{projectId}/documents`, có ô tìm theo tên (`search`) và bộ chọn tag (`tag`). Mỗi dòng: biểu tượng theo `sourceType`, tên, tag (nhãn màu), dung lượng (với File, đổi `sizeBytes` ra KB hoặc MB), ngày `uploadedAt`, các nút: **Tải về** (File) hoặc **Mở liên kết** (Link, mở `linkUrl` ở tab mới), **Đổi tên/tag**, **Xóa** (có hộp thoại xác nhận).

**B. Trang "Tất cả tài liệu của tôi"**
`GET /api/documents` kèm bộ lọc `tag`, `sourceType`, `projectId`, `search`. Nhóm theo `projectName`; bấm vào tên dự án để chuyển tới dự án (có `projectId`).

**C. Thêm tài liệu**
Hai nút: "Tải file lên" (chọn file, tên, tag) và "Thêm liên kết" (tên, URL, tag). Hiển thị tiến trình khi tải file lớn, và khóa nút tới khi xong. Sau khi `201`, thêm tài liệu vào đầu danh sách (hoặc tải lại danh sách).

**D. Admin**
- Xem tài liệu của một người: `GET /api/documents/by-user/{userId}`.
- Xem toàn hệ thống: `GET /api/documents/all?page=1&pageSize=20` (kèm `userId`, `tag`, `search`...). Dùng `totalCount` để vẽ phân trang.
- Người thường gọi API của người khác sẽ nhận **403**: ẩn các trang này với người không phải Admin.

## 10. Việc cần thử khi build

- Tải file 1 byte đến đúng 20 MB: thành công. Tải file hơn 20 MB: báo lỗi (ưu tiên chặn ở FE).
- Tải file rồi tải về: nội dung phải giống file gốc. Đổi tên không có đuôi rồi tải về: kiểm tra tên file.
- Thêm link sai (`ftp://...`, chuỗi không phải URL): 400 và hiển thị `message`.
- `search` có chữ hoa chữ thường lẫn lộn, có dấu tiếng Việt.
- Lọc kết hợp: `tag` + `sourceType` + `search` + `projectId`.
- Xóa một tài liệu rồi tải lại danh sách: dòng đã mất.
- Gọi API của người khác (đổi `userId` hoặc `documentId`): người thường nhận 403 hoặc 404, không bao giờ thấy dữ liệu.
- Hai tài khoản: tài khoản A không thấy tài liệu của B trong `/api/documents`.

## 11. Chưa có (FE đừng chờ)

- Tìm theo **nội dung** file hoặc theo URL của link (chỉ tìm theo tên).
- Xem trước (preview) và liên kết chia sẻ công khai: file chỉ tải về được qua API có token.
- Phân trang cho `GET /api/documents` và `GET /api/projects/{id}/documents` (trả hết một lần; chỉ `/all` có phân trang).
- Thay nội dung file của một tài liệu có sẵn (xóa rồi tải lại).
- Tải nhiều file một lần (gọi API tải lên nhiều lần, mỗi lần một file).
- Giới hạn tổng dung lượng theo gói của người dùng: hiện chỉ giới hạn **20 MB mỗi file**.
