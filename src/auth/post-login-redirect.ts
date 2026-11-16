/**
 * Helper chọn đích điều hướng sau khi đăng nhập thành công.
 *
 * Quy tắc UX (giúp user làm quen sản phẩm trước khi vào app chính):
 *  - Lần đầu sau khi có account: đi tới Landing (/) để xem giới thiệu.
 *  - Những lần sau: đi về trang `from` (deep-link trước đó) hoặc /dashboard.
 *
 * Cờ `hasSeenLanding` lưu ở localStorage, mặc định false cho mọi tài khoản mới.
 * Khi user thực sự mở Landing (effect component Landing chạy) thì set = true.
 */

import { isAdminUser, type User } from "./types";

const STORAGE_KEY = "metanoia.hasSeenLanding";

export function hasSeenLanding(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

export function markLandingSeen(): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, "1");
  } catch {
    /* bỏ qua — localStorage có thể bị chặn ở chế độ privacy */
  }
}

export function resetLandingFlag(): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* bỏ qua */
  }
}

/**
 * Trả về path nên navigate sau khi login thành công.
 *
 * Ưu tiên:
 *  1. Admin (`role = Admin`)  -> `/admin` (vào thẳng khu vực quản trị).
 *  2. Deep-link `from`        -> quay lại đúng trang user đang muốn vào.
 *  3. Lần đầu chưa xem Landing -> `/`.
 *  4. Còn lại                 -> `/dashboard`.
 */
export function getPostLoginPath(
  from: string | undefined,
  user?: Pick<User, "role"> | null,
): string {
  // Tài khoản quản trị luôn vào thẳng /admin — không qua onboarding.
  if (isAdminUser(user)) return "/admin";
  if (from && from !== "/login" && from !== "/register") return from;
  if (!hasSeenLanding()) return "/";
  return "/dashboard";
}
