import type { ReactNode } from "react";
import { useAuth } from "../../auth/AuthContext";
import { useNotifications } from "../../hooks/useNotifications";
import { NotificationsContext } from "./notifications-context-state";

/**
 * ============================================================
 * Provider cho thông báo.
 * ============================================================
 *
 * Vì sao cần Context:
 *  - `useNotifications` mở 1 SignalR hub connection. Gọi hook ở 2 nơi
 *    (header + trang /notifications) sẽ mở 2 connection → nhận trùng thông
 *    báo, tốn băng thông, và badge có thể lệch.
 *  - Vì vậy chỉ 1 instance được tạo ở provider và các trang con đọc qua
 *    `useNotificationsContext()`.
 *
 * Provider tự biết user đã đăng nhập hay chưa (qua `useAuth`) nên chỉ
 * mở connection khi cần thiết.
 */

export function NotificationsProvider({ children }: { children: ReactNode }) {
  const { isAuthenticated } = useAuth();
  const value = useNotifications(isAuthenticated);
  return (
    <NotificationsContext.Provider value={value}>
      {children}
    </NotificationsContext.Provider>
  );
}
