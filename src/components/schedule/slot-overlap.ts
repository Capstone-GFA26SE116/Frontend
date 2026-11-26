import {
  extractOverlaps,
  isSlotOverlapError,
  type SlotOverlapDto,
} from "../../lib/api-client";

/**
 * Tiện ích xử lý lỗi `409 SLOT_OVERLAP` — slot mới chồng lên slot đang
 * chiếm giờ.
 *
 * Luật (spec `FE_CHANGES.md` mục 3):
 *  - Chỉ slot **chiếm giờ** mới chặn: `Approved`, `Due`, `InProgress`,
 *    `Overrun`. Các trạng thái khác (`Proposed`, `Done`, `Skipped`, `Missed`,
 *    `Cancelled`, `Postponed`) không chặn ai và không bị chặn.
 *  - Chặn cứng — không có tham số "xác nhận để vẫn tạo".
 *
 * FE nên báo sớm (so với lịch đang hiển thị), nhưng BE là nơi quyết định.
 */

/** Trạng thái slot chiếm giờ — theo spec mục 3.1. */
export const OVERLAP_BLOCKING_STATUSES = new Set([
  "Approved",
  "Due",
  "InProgress",
  "Overrun",
]);

/** Trạng thái slot **không** chiếm giờ. */
export const OVERLAP_FREE_STATUSES = new Set([
  "Proposed",
  "Done",
  "Skipped",
  "Missed",
  "Cancelled",
  "Postponed",
]);

/** 1 slot chiếm giờ có chồng lên slot đang chiếm giờ khác không. */
export function blocksTime(status: string | null | undefined): boolean {
  if (!status) return false;
  const s = status.trim();
  if (OVERLAP_FREE_STATUSES.has(s)) return false;
  // Chỉ chặn khi nằm trong danh sách chặn cứng → không chặn nhầm trạng thái
  // mới mà BE thêm sau này.
  return OVERLAP_BLOCKING_STATUSES.has(s);
}

/** Khoảng thời gian 2 slot có chồng lên nhau không (chạm đầu mút = không chồng). */
export function rangesOverlap(
  startA: string,
  endA: string,
  startB: string,
  endB: string,
): boolean {
  const a1 = new Date(startA).getTime();
  const a2 = new Date(endA).getTime();
  const b1 = new Date(startB).getTime();
  const b2 = new Date(endB).getTime();
  if ([a1, a2, b1, b2].some((n) => !Number.isFinite(n))) return false;
  // Chạm đầu mút (a2 === b1) → KHÔNG chồng.
  return a1 < b2 && b1 < a2;
}

/**
 * Kiểm tra trước ở FE: slot mới có chồng lên slot nào đang chiếm giờ không.
 *
 * @param existingSlots Các slot đang có của **chính user** (BE chỉ so với
 *                      slot của user đang đăng nhập).
 * @param excludeSlotId Slot đang sửa (loại khỏi so sánh).
 */
export function findLocalOverlaps(
  existingSlots: Array<{
    id: string;
    startTime: string;
    endTime: string;
    status: string;
  }>,
  startTime: string,
  endTime: string,
  excludeSlotId?: string,
): SlotOverlapDto[] {
  const overlaps: SlotOverlapDto[] = [];
  for (const s of existingSlots) {
    if (excludeSlotId && s.id === excludeSlotId) continue;
    if (!blocksTime(s.status)) continue;
    if (!rangesOverlap(startTime, endTime, s.startTime, s.endTime)) continue;
    overlaps.push({
      slotId: s.id,
      taskId: "",
      taskTitle: "",
      status: s.status,
      start: s.startTime,
      end: s.endTime,
    });
  }
  return overlaps;
}

/** Định dạng khoảng giờ ngắn gọn — `08:00 – 09:00`. */
export function fmtOverlapRange(start: string, end: string): string {
  const fmt = (iso: string) => {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "--:--";
    return d.toLocaleTimeString(undefined, {
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
  };
  return `${fmt(start)} – ${fmt(end)}`;
}

/**
 * Tạo message tiếng Anh từ danh sách slot chồng giờ.
 *
 * Dùng cho toast / alert khi BE trả `409 SLOT_OVERLAP`.
 */
export function buildOverlapMessage(
  overlaps: SlotOverlapDto[],
  opts: { taskTitle?: string | null } = {},
): string {
  if (overlaps.length === 0) {
    return "This time overlaps an existing slot. Please choose a different time.";
  }
  const first = overlaps[0];
  const when = fmtOverlapRange(first.start, first.end);
  const title = first.taskTitle?.trim();
  /*
   * Slot của **việc nhóm** (mục 10 của cập nhật BE) → nói rõ để người dùng
   * hiểu mình đang vướng việc chung của nhóm, không phải việc cá nhân.
   */
  const kind = first.groupTaskId ? "group work" : "an existing slot";
  const detail = title
    ? `“${title}” (${first.status}) ${when}`
    : `${kind} (${first.status}) ${when}`;

  const head = opts.taskTitle?.trim()
    ? `“${opts.taskTitle.trim()}” overlaps ${kind}`
    : `This time overlaps ${kind}`;

  const more = overlaps.length > 1 ? ` (+${overlaps.length - 1} more)` : "";

  return `${head}: ${detail}${more}. Please pick a different time.`;
}

/**
 * Kiểm tra 1 lỗi API có phải lỗi chồng giờ không, và rút ra message tiếng Anh.
 *
 * @returns `null` nếu không phải lỗi chồng giờ; ngược lại trả message để hiển thị.
 */
export function describeSlotOverlapError(
  err: {
    status?: number;
    errorCode?: string;
    details?: unknown;
    error?: string;
  },
  opts: { taskTitle?: string | null } = {},
): string | null {
  if (!isSlotOverlapError(err)) return null;
  const overlaps = extractOverlaps(err.details);
  if (overlaps.length === 0) {
    // BE trả 409 nhưng không kèm details → dùng message sẵn có.
    return (
      err.error ??
      "This time overlaps an existing slot. Please choose a different time."
    );
  }
  return buildOverlapMessage(overlaps, opts);
}
