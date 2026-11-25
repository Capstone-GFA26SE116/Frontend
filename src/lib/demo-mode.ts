/**
 * ============================================================
 * Chế độ DEMO — guest xem trước sản phẩm mà không cần đăng nhập
 * ============================================================
 *
 * Vì sao cần module riêng (không dùng React):
 * - `api-client.ts` cần biết "có bật demo không" **trước khi** gọi network,
 *   nhưng `api-client.ts` không được import từ component (tránh vòng lặp).
 *
 * Quy tắc bật demo:
 * 1. URL hiện tại là trang chủ (`/`) hoặc bắt đầu bằng `/demo`.
 * 2. User **chưa** đăng nhập (không có token trong localStorage).
 *
 * → User đã đăng nhập mở `/` sẽ thấy app THẬT (dùng token của họ),
 *   không phải dữ liệu mẫu. Điều này tránh việc demo ghi đè dữ liệu thật.
 */

/** Tiền tố route demo (URL cũ — redirect về trang chủ `/`). */
export const DEMO_ROUTE_PREFIX = "/demo";

/** Trang chủ — dùng dữ liệu mẫu cho khách chưa đăng nhập. */
export const DEMO_HOME_PATH = "/";

/**
 * Trang bảng giá — cũng dùng dữ liệu mẫu cho khách chưa đăng nhập.
 * BE yêu cầu token cho `GET /api/subscription-plans` → 401 nếu là khách.
 */
export const DEMO_PRICING_PATH = "/pricing";

/** Key session trong localStorage (phải khớp `api-client.ts`). */
const SESSION_KEY = "metanoia:session";

/**
 * `true` nếu đang ở trang demo (trang chủ hoặc route `/demo/*` cũ).
 *
 * `/pricing` cũng nằm trong danh sách này: BE bắt buộc auth cho
 * `GET /api/subscription-plans` (trả 401 cho khách chưa đăng nhập) → không
 * có dữ liệu mẫu thì trang bảng giá trống hoặc báo lỗi cho khách.
 */
export function isDemoPath(pathname: string): boolean {
  if (pathname === DEMO_HOME_PATH) return true;
  if (pathname === DEMO_PRICING_PATH) return true;
  return (
    pathname === DEMO_ROUTE_PREFIX ||
    pathname.startsWith(`${DEMO_ROUTE_PREFIX}/`)
  );
}

/** `true` nếu user đã đăng nhập (có token hợp lệ trong localStorage). */
export function hasSession(): boolean {
  if (typeof window === "undefined") return false;
  try {
    const raw = window.localStorage.getItem(SESSION_KEY);
    if (!raw) return false;
    const s = JSON.parse(raw) as { token?: string };
    return typeof s.token === "string" && s.token.length > 0;
  } catch {
    return false;
  }
}

/**
 * Có bật chế độ demo không.
 *
 * @param pathname Đường dẫn hiện tại (dùng `window.location.pathname` nếu
 *   không truyền).
 */
export function isDemoMode(pathname?: string): boolean {
  const path =
    pathname ??
    (typeof window !== "undefined" ? window.location.pathname : "/");
  if (!isDemoPath(path)) return false;
  /* Đã đăng nhập → dùng app thật, không dùng dữ liệu mẫu. */
  if (hasSession()) return false;
  return true;
}
