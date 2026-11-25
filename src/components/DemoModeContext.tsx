import { useMemo, type ReactNode } from "react";
import { useLocation } from "react-router-dom";
import { isDemoMode } from "../lib/demo-mode";
import { DemoModeContext } from "./demo-mode-state";

/**
 * ============================================================
 * DemoModeProvider — trạng thái "đang xem bản demo" (guest chưa đăng nhập)
 * ============================================================
 *
 * Bật khi: URL bắt đầu bằng `/demo` **và** user chưa đăng nhập.
 *
 * Khi bật:
 * - Mọi request API bị chặn ở tầng `apiFetch` → trả dữ liệu mẫu.
 * - Header hiện banner "Bạn đang xem bản demo" + nút đăng ký.
 *
 * Toàn bộ class prefix `.demo-*`.
 */

export function DemoModeProvider({ children }: { children: ReactNode }) {
  const { pathname } = useLocation();

  const value = useMemo(
    () => ({ active: isDemoMode(pathname) }),
    [pathname],
  );

  return (
    <DemoModeContext.Provider value={value}>
      {children}
    </DemoModeContext.Provider>
  );
}
