import { createContext, useContext } from "react";
import type { UseNotificationsResult } from "../../hooks/useNotifications";

/**
 * Context thông báo — dùng chung 1 SignalR connection cho toàn app.
 *
 * Provider nằm ở `notifications-context.tsx`; file này chỉ chứa context +
 * hook đọc (để react-refresh không báo lỗi "file export cả component và
 * function").
 */

export const NotificationsContext = createContext<UseNotificationsResult | null>(
  null,
);

/**
 * Đọc state thông báo dùng chung.
 *
 * @throws Nếu dùng ngoài `<NotificationsProvider>`.
 */
export function useNotificationsContext(): UseNotificationsResult {
  const ctx = useContext(NotificationsContext);
  if (!ctx) {
    throw new Error(
      "useNotificationsContext must be used within a <NotificationsProvider>",
    );
  }
  return ctx;
}
