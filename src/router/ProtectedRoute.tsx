import { Navigate, Outlet, useLocation } from "react-router-dom";
import type { ReactNode } from "react";
import { useAuth } from "../auth/AuthContext";
import { isAdminUser } from "../auth/types";
import { readOnboarding } from "../pages/onboarding/storage";

/**
 * Bảo vệ route yêu cầu đăng nhập.
 *
 * - Nếu chưa đọc xong localStorage -> hiển thị spinner (tránh flash redirect).
 * - Nếu chưa đăng nhập -> chuyển sang /login, nhớ lại trang đang muốn vào
 *   qua `state.from` để sau khi login xong quay lại đúng chỗ.
 * - Nếu đã đăng nhập nhưng CHƯA hoàn tất onboarding -> chuyển sang /onboarding.
 *   (Cho phép user vào thẳng /onboarding hoặc /logout khi đang ở trong này.)
 */
export function ProtectedRoute({ children }: { children?: ReactNode }) {
  const { user, isAuthenticated, isReady, onboardingCompleted } = useAuth();
  const location = useLocation();

  if (!isReady) {
    return (
      <div className="flex min-h-screen items-center justify-center text-sm text-slate-500">
        Đang tải...
      </div>
    );
  }

  if (!isAuthenticated) {
    return (
      <Navigate
        to="/login"
        replace
        state={{ from: location.pathname + location.search }}
      />
    );
  }

  // Onboarding gate: nếu chưa hoàn tất -> đẩy sang /onboarding.
  // (tránh đệ quy bằng cách kiểm tra path hiện tại)
  //
  // ⚠️ Ngoại lệ: các trang kết quả thanh toán (/payment/*) KHÔNG bị gate.
  // User có thể mua gói ngay khi đăng nhập Google lần đầu (chưa onboarding),
  // rồi PayOS redirect về — nếu gate ở đây, họ sẽ bị đẩy sang /onboarding
  // và không thấy kết quả thanh toán.
  const isPaymentResult = location.pathname.startsWith("/payment/");

  // ⚠️ Admin KHÔNG bị gate onboarding: tài khoản quản trị đi thẳng vào
  // /admin và không cần thiết lập lịch cá nhân.
  const isAdmin = isAdminUser(user);

  /*
   * Nguồn cờ onboarding:
   *   1. `GET /api/me` → `onboardingCompleted` (nguồn chính, xuyên session).
   *   2. Fallback localStorage (`readOnboarding()`) — CHỈ dùng khi BE **chưa
   *      cho biết** trạng thái (`onboardingCompleted === undefined`).
   *
   * ⚠️ Vì sao KHÔNG dùng `||` (điều kiện OR):
   *
   *   const needsOnboarding =
   *     onboardingCompleted === false || readOnboarding() === null;   // ← SAI
   *
   * Màn onboarding hiện tại lưu bằng `POST /api/me/onboarding` (BE), KHÔNG
   * ghi localStorage cũ (`metanoia:onboarding` của màn mock role/sectors/goals
   * đã bị thay thế). Vì vậy `readOnboarding()` **luôn trả null** → điều kiện
   * OR luôn `true` → sau khi user bấm "Finish setup" thành công, `navigate()`
   * tới `/dashboard` lại bị đẩy về `/onboarding` → **kẹt vĩnh viễn**, kể cả
   * khi F5 (vì `GET /api/me` trả `onboardingCompleted: true` nhưng nhánh OR
   * vẫn bị `readOnboarding() === null` kéo về `true`).
   *
   * Cách sửa: fallback localStorage chỉ áp dụng khi **chưa biết** trạng thái
   * từ BE. Khi BE đã trả `true`/`false` thì BE là nguồn sự thật duy nhất.
   *
   * BE **không** chặn API khi chưa onboarding → FE phải tự gate.
   * Spec: `FE_CHANGES.md` mục 1.3.
   */
  const needsOnboarding =
    onboardingCompleted === false ||
    (onboardingCompleted === undefined && readOnboarding() === null);

  if (
    !location.pathname.startsWith("/onboarding") &&
    !location.pathname.startsWith("/logout") &&
    !isPaymentResult &&
    !isAdmin &&
    needsOnboarding
  ) {
    return <Navigate to="/onboarding" replace />;
  }

  // Có children -> render trực tiếp (dùng cho wrap layout).
  // Không có children -> render <Outlet /> cho route lồng nhau.
  return children ? <>{children}</> : <Outlet />;
}

/**
 * Bảo vệ khu vực quản trị — chỉ tài khoản có role `Admin`.
 *
 * BE cũng chặn ở tầng API (403 với user thường), nhưng FE chặn sớm để
 * không lộ UI admin cho user không có quyền.
 */
export function AdminRoute({ children }: { children?: ReactNode }) {
  const { user, isAuthenticated, isReady } = useAuth();
  const location = useLocation();

  if (!isReady) {
    return (
      <div className="flex min-h-screen items-center justify-center text-sm text-slate-500">
        Đang tải...
      </div>
    );
  }

  if (!isAuthenticated) {
    return (
      <Navigate
        to="/login"
        replace
        state={{ from: location.pathname + location.search }}
      />
    );
  }

  if (!isAdminUser(user)) {
    return <Navigate to="/dashboard" replace />;
  }

  return children ? <>{children}</> : <Outlet />;
}

/**
 * Đã đăng nhập rồi thì không cho vào lại /login hoặc /register
 * -> tự chuyển sang /dashboard.
 *
 * Riêng tài khoản Admin -> chuyển thẳng sang /admin.
 */
export function RedirectIfAuthenticated({
  children,
}: {
  children: React.ReactNode;
}) {
  const { user, isAuthenticated, isReady } = useAuth();
  if (!isReady) {
    return (
      <div className="flex min-h-screen items-center justify-center text-sm text-slate-500">
        Đang tải...
      </div>
    );
  }
  if (isAuthenticated) {
    return (
      <Navigate to={isAdminUser(user) ? "/admin" : "/dashboard"} replace />
    );
  }
  return <>{children}</>;
}