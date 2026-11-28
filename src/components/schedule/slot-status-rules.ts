import { toSlotPhase } from "../focus/focus-logic";

/**
 * ===========================================================
 * Quy tắc trạng thái slot khi người dùng SỬA (reschedule)
 * ===========================================================
 *
 * Nguyên tắc: **người dùng KHÔNG tự chọn trạng thái slot**.
 *
 * - Slot bị `Missed` (hết giờ mà chưa kịp làm) → sau khi người dùng sửa
 *   giờ và không bị trùng slot nào → tự động thành `Approved` (đã duyệt,
 *   chưa tới giờ → máy sẽ tự chuyển `Due` khi tới giờ).
 * - Các trạng thái còn lại do **máy** tự quản lý:
 *   - `Proposed`  — chờ duyệt (duyệt đề xuất AI).
 *   - `Done` / `Skipped` / `Cancelled` — trạng thái kết thúc, không mở lại.
 *   - `InProgress` / `Overrun` — đang có phiên làm việc chạy.
 *   → Ta KHÔNG gửi `status` trong body PUT → BE giữ nguyên giá trị cũ.
 */

/** Trạng thái sau khi sửa = `Approved` (slot đã duyệt, chưa tới giờ). */
export const RESCHEDULED_SLOT_STATUS = "Approved";

/** Slot đang có phiên làm việc chạy → không được sửa. */
const RUNNING_STATUSES = new Set(["InProgress", "Overrun"]);

/**
 * Slot "còn sống" — sửa giờ xong thì hệ thống set lại `Approved`.
 *
 * Gồm cả `Approved` (đã duyệt sẵn) và `Due` / `Postponed` (đã tới giờ /
 * đã dời nhưng chưa làm) → sau khi dời giờ thì quay về `Approved` cho tới
 * khi máy tự set `Due` ở giờ mới.
 */
const RESCHEDULABLE_STATUSES = new Set([
  "Approved",
  "Due",
  "Missed",
  "Postponed",
]);

export type SlotStatusPlan =
  /** Gửi `status` mới lên BE. */
  | { mode: "set"; status: "Approved" }
  /** Không gửi `status` → BE giữ nguyên trạng thái hiện tại. */
  | { mode: "keep" }
  /** Không cho sửa (đang có phiên chạy). */
  | { mode: "block"; reason: string };

/**
 * Tính trạng thái slot sau khi người dùng sửa giờ.
 *
 * @param currentStatus Trạng thái hiện tại của slot (BE trả string tự do).
 */
export function planSlotStatusOnEdit(
  currentStatus: string | null | undefined,
): SlotStatusPlan {
  const phase = toSlotPhase(currentStatus);

  if (RUNNING_STATUSES.has(phase)) {
    return {
      mode: "block",
      reason:
        phase === "Overrun"
          ? "This time block is over its planned end and a focus session is still running. Stop the session first, then you can move it."
          : "A focus session is currently running on this time block. Stop the session first, then you can move it.",
    };
  }

  if (RESCHEDULABLE_STATUSES.has(phase)) {
    return { mode: "set", status: RESCHEDULED_SLOT_STATUS };
  }

  // `Proposed` / `Done` / `Skipped` / `Cancelled` / lạ → máy tự quản lý.
  return { mode: "keep" };
}

/**
 * Nhãn tiếng Anh dễ hiểu cho trạng thái slot (dùng trong UI, không dùng
 * để quyết định logic).
 */
export function slotStatusDisplayLabel(status: string | null | undefined): string {
  switch (toSlotPhase(status)) {
    case "Proposed":
      return "Waiting for approval";
    case "Approved":
      return "Approved";
    case "Due":
      return "Ready to start";
    case "InProgress":
      return "In progress";
    case "Overrun":
      return "Over time";
    case "Done":
      return "Completed";
    case "Missed":
      return "Missed";
    case "Skipped":
      return "Skipped";
    case "Cancelled":
      return "Cancelled";
    case "Postponed":
      return "Moved";
    default:
      return status?.trim() || "Unknown";
  }
}
