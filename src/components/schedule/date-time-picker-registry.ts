/**
 * ===========================================================
 * Registry các DateTimePicker đang mở.
 * ===========================================================
 *
 * Mục đích: khi user đang mở popover chọn ngày/giờ mà bấm `Escape`, ta chỉ
 * muốn ĐÓNG popover — KHÔNG muốn đóng modal cha (đang edit slot).
 *
 * Vì mọi listener `Escape` đều đăng ký ở `document`, `stopPropagation()`
 * không chặn được listener khác → ta dùng registry này để modal cha hỏi
 * "có picker nào đang mở không?" rồi bỏ qua.
 */

/** Số picker đang mở. */
let openCount = 0;

/** Có picker nào đang mở không? */
export function isAnyDateTimePickerOpen(): boolean {
  return openCount > 0;
}

/** Gọi khi picker mở. */
export function markDateTimePickerOpen(): void {
  openCount += 1;
}

/** Gọi khi picker đóng. */
export function markDateTimePickerClosed(): void {
  openCount = Math.max(0, openCount - 1);
}
