import { useEffect, useState } from "react";

/**
 * Lời chào theo giờ Việt Nam (Asia/Ho_Chi_Minh).
 *
 * Mục đích: hiển thị lời chào đúng thời điểm thật — "Chào buổi sáng /
 * buổi chiều / buổi tối" — thay vì hard-code một lời chào cố định.
 *
 * Ranh giới giờ (giờ Việt Nam, UTC+7):
 *   05:00 – 11:00  → buổi sáng
 *   11:00 – 17:00  → buổi chiều
 *   17:00 – 22:00  → buổi tối
 *   22:00 – 05:00  → buổi đêm
 *
 * Lưu ý: luôn đọc giờ theo timezone `Asia/Ho_Chi_Minh`, không phụ thuộc
 * timezone của máy người dùng → kết quả nhất quán cho mọi người xem.
 */

/** Múi giờ cố định của Việt Nam. */
export const VN_TIME_ZONE = "Asia/Ho_Chi_Minh";

/** Các nhánh lời chào. */
export type GreetingPeriod = "morning" | "afternoon" | "evening" | "night";

/** Nhãn tiếng Việt cho từng nhánh. */
const PERIOD_LABEL: Record<GreetingPeriod, string> = {
  morning: "Chào buổi sáng",
  afternoon: "Chào buổi chiều",
  evening: "Chào buổi tối",
  night: "Chào buổi đêm",
};

/**
 * Xác định nhánh lời chào từ giờ Việt Nam hiện tại.
 *
 * Dùng `Intl.DateTimeFormat` với `timeZone` cố định nên không bị lệch
 * khi máy người dùng đặt ở timezone khác.
 */
export function getVietnamesePeriod(date: Date = new Date()): GreetingPeriod {
  let hour: number;
  try {
    const hourPart = new Intl.DateTimeFormat("en-US", {
      timeZone: VN_TIME_ZONE,
      hour: "numeric",
      hourCycle: "h23",
    }).formatToParts(date);

    const raw = hourPart.find((p) => p.type === "hour")?.value ?? "0";
    hour = Number.parseInt(raw, 10);
    if (Number.isNaN(hour)) hour = 0;
  } catch {
    // Fallback khi runtime không hỗ trợ Intl timezone → dùng giờ local.
    hour = date.getHours();
  }

  if (hour >= 5 && hour < 11) return "morning";
  if (hour >= 11 && hour < 17) return "afternoon";
  if (hour >= 17 && hour < 22) return "evening";
  return "night";
}

/**
 * Hook trả về lời chào hiện tại.
 *
 * Cập nhật mỗi phút để không bị stale khi người dùng để tab mở lâu —
 * việc re-render được kích hoạt bởi `tick` tăng mỗi phút, còn giá trị
 * lời chào được derive trực tiếp (không setState trong effect).
 *
 * @param name Tên hiển thị. Bỏ trống → chỉ hiện lời chào, không có dấu phẩy.
 */
export function useVietnameseGreeting(name?: string): string {
  // Bộ đếm đơn vị phút — chỉ dùng để ép re-render định kỳ.
  const [tick, setTick] = useState(0);

  useEffect(() => {
    const timer = window.setInterval(() => setTick((t) => t + 1), 60_000);
    return () => window.clearInterval(timer);
  }, []);

  // `tick` là dependency của effect trên; giá trị trả về được derive
  // ở render nên luôn khớp với thời điểm hiện tại.
  void tick;

  const label = PERIOD_LABEL[getVietnamesePeriod()];
  const clean = (name ?? "").trim();
  return clean ? `${label}, ${clean}` : label;
}
