import type { GroupFocusStopReason } from "../../lib/group-api";

/* ===========================================================
 * Lý do dừng phiên làm việc của NHÓM — hằng số dùng chung
 * ===========================================================
 *
 * Tách riêng khỏi component để tuân thủ rule `react-refresh`
 * (một file component chỉ export component).
 */

/** Danh sách lý do dừng hợp lệ (thứ tự hiển thị). */
export const GROUP_STOP_REASONS: GroupFocusStopReason[] = [
  "Completed",
  "Interrupted",
  "Blocked",
  "Other",
];

/** Nhãn tiếng Anh cho từng lý do dừng. */
export const GROUP_STOP_REASON_LABELS: Record<GroupFocusStopReason, string> = {
  Completed: "Completed",
  Interrupted: "Interrupted",
  Blocked: "Blocked",
  Other: "Other",
};

/** Mô tả ngắn giúp người dùng hiểu hậu quả. */
export const GROUP_STOP_REASON_HINTS: Record<GroupFocusStopReason, string> = {
  Completed: "I finished the work for this block.",
  Interrupted: "I was interrupted and will continue later.",
  Blocked: "I cannot continue because something is in the way.",
  Other: "Another reason — please describe it below.",
};

/**
 * Lý do dừng này có **bắt buộc** phải có ghi chú không?
 *
 * Theo `GROUP_FE.md` (mục `GroupFocusStopRequestDto`): `note` bắt buộc
 * với `Blocked` và `Other` (BE trả `400` nếu thiếu).
 */
export function groupStopReasonNeedsNote(
  reason: GroupFocusStopReason,
): boolean {
  return reason === "Blocked" || reason === "Other";
}
