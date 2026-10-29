import { useEffect, useRef } from "react";
import { CenterToasts, useCenterToast } from "../Toast";
import { ACTION_TYPE_MESSAGES } from "./focus-logic";
import { useNotificationsContext } from "./notifications-context-state";
import "./focus.css";

/**
 * ===========================================================
 * <NotificationToaster> — bắn toast khi nhận thông báo realtime (SignalR).
 * ===========================================================
 *
 * Theo spec, mỗi `actionType` có hành vi khác nhau:
 *
 *   • `START_PROMPT` / `PRE_START_REMINDER` → toast thông thường.
 *   • `NOT_STARTED` / `MISSED_SLOT`         → toast cảnh báo.
 *   • `NEAR_END` / `OVERRUN`                → toast cảnh báo nghiêm trọng.
 *   • `AUTO_TIMEOUT`                       → toast cảnh báo + user cần
 *                                             xác nhận phiên (đã có dialog).
 *   • `CHECK_IN`                           → toast thông thường.
 *
 * Vì `Toast.tsx` chỉ có 3 loại (success/error/info), ta dùng `error` cho
 * các case cảnh báo nghiêm trọng và `info` cho phần còn lại.
 *
 * ⚠️ Component này đọc state từ `NotificationsProvider` (thay vì tự gọi hook)
 * để chỉ có MỘT SignalR connection cho cả app — gọi `useNotifications` ở 2
 * nơi sẽ mở 2 hub connection và nhận trùng thông báo.
 */

/** Loại toast nên dùng cho 1 actionType. */
function toastKindFor(actionType: string): "success" | "error" | "info" {
  switch (actionType) {
    case "NOT_STARTED":
    case "MISSED_SLOT":
    case "NEAR_END":
    case "OVERRUN":
    case "AUTO_TIMEOUT":
      return "error";
    default:
      return "info";
  }
}

/** Tiêu đề toast theo actionType. */
function titleFor(actionType: string): string {
  switch (actionType) {
    case "PRE_START_REMINDER":
      return "Sắp đến giờ";
    case "START_PROMPT":
      return "Đến giờ làm việc";
    case "NOT_STARTED":
      return "Bạn chưa bắt đầu";
    case "NEAR_END":
      return "Sắp hết giờ";
    case "OVERRUN":
      return "Đã quá giờ";
    case "AUTO_TIMEOUT":
      return "Hệ thống đã tự ngắt";
    case "CHECK_IN":
      return "Kiểm tra nhanh";
    case "MISSED_SLOT":
      return "Bạn đã bỏ lỡ slot";
    default:
      return "Thông báo mới";
  }
}

export function NotificationToaster() {
  const [toasts, toast] = useCenterToast();
  const notif = useNotificationsContext();
  /** Id tín hiệu đã xử lý — tránh bắn toast trùng khi re-render. */
  const handledRef = useRef<string | null>(null);

  useEffect(() => {
    const signal = notif.lastSignal;
    if (!signal) return;
    // Mỗi tín hiệu chỉ bắn 1 lần.
    const key =
      signal.notificationId || `${signal.actionType}-${signal.message}`;
    if (handledRef.current === key) return;
    handledRef.current = key;

    toast.show(
      toastKindFor(signal.actionType),
      titleFor(signal.actionType),
      signal.message || ACTION_TYPE_MESSAGES[signal.actionType],
    );
  }, [notif.lastSignal, toast]);

  return <CenterToasts toasts={toasts} onDismiss={toast.dismiss} />;
}
