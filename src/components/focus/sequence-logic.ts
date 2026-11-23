/**
 * ============================================================
 * Luật "làm trước - làm sau" cho trang /schedule.
 * ============================================================
 *
 * Ý tưởng: trên lịch có nhiều task/subtask đều có thể bấm Start, nhưng
 * người dùng chỉ nên làm theo đúng thứ tự thời gian — cái nào có lịch
 * sớm hơn thì làm trước, cái nào có lịch sau thì chưa được làm.
 *
 * ⚠️ Đây là luật **chỉ ở FE**:
 *   - BE hiện KHÔNG có luật thứ tự này. BE chỉ chặn "1 người chỉ chạy
 *     1 phiên" (409 `FOCUS_SESSION_CONFLICT`).
 *   - Nên nếu gọi API trực tiếp thì BE vẫn nhận. Luật này chỉ là "tay
 *     chặn" ở giao diện để người dùng không làm lộn xộn.
 *
 * Hai tầng luật (cùng áp dụng, theo OR):
 *   1. TOÀN LỊCH — trong tất cả việc còn dở đang hiện, chỉ việc có giờ
 *      bắt đầu SỚM NHẤT được Start.
 *   2. TỪNG NGÀY  — trong mỗi cột ngày, chỉ việc sớm nhất của ngày đó
 *      được Start.
 *
 * Một việc được Start khi nó khớp ít nhất một trong hai tầng. Nhờ vậy
 * người dùng vẫn làm được việc của hôm nay mà không phải dọn xong
 * hôm qua trước.
 *
 * Mở khoá: việc trước đó đã `Done` hoặc `Skipped` → việc sau được phép.
 */

import type { FocusSlotPhase } from "./focus-logic";

/* ===========================================================
 * Kiểu dữ liệu
 * =========================================================== */

/**
 * Một việc có thể xếp thứ tự (task hoặc subtask).
 */
export interface SequencedItem {
  /** Khoá ổn định để đối chiếu giữa các lần render. */
  key: string;
  /** Tên hiển thị — dùng cho tooltip "phải làm X trước". */
  title: string;
  /** Thời điểm bắt đầu (epoch ms). */
  startAt: number;
  /** Ngày của việc (đầu ngày, epoch ms) — dùng cho luật theo ngày. */
  dayAt: number;
  /**
   * Việc này còn dở chưa (`Done`/`Skipped` = đã xong).
   * Việc đã xong KHÔNG được Start (BE trả 400) và cũng không chặn việc sau.
   */
  isPending: boolean;
  /** Việc này đang chạy (slot `InProgress`) → hiện nút Stop, không Start. */
  isRunning: boolean;
}

/**
 * Kết quả tính luật: việc nào được phép Start, việc nào bị chặn và bị
 * chặn bởi ai.
 */
export interface SequenceGate {
  /** Key của việc được phép Start theo luật TOÀN LỊCH. */
  globalAllowedKey: string | null;
  /** Key của việc được phép Start theo luật TỪNG NGÀY (theo từng ngày). */
  dayAllowedKeys: Map<number, string>;
  /** Với mỗi việc bị chặn: key của việc phải làm trước. */
  blockedBy: Map<string, string>;
}

/* ===========================================================
 * Hàm tính luật
 * =========================================================== */

/**
 * Tính luật "làm trước - làm sau".
 *
 * @param items Danh sách việc đã biết giờ bắt đầu + trạng thái.
 */
export function computeSequenceGate(items: SequencedItem[]): SequenceGate {
  const gate: SequenceGate = {
    globalAllowedKey: null,
    dayAllowedKeys: new Map(),
    blockedBy: new Map(),
  };

  // Chỉ việc CÒN DỞ mới tham gia luật. Việc đã xong không chặn ai,
  // và việc đang chạy thì hiện nút Stop nên không cần Start.
  const pending = items
    .filter((i) => i.isPending && !i.isRunning)
    .sort((a, b) => a.startAt - b.startAt);

  if (pending.length === 0) return gate;

  // Tầng 1: sớm nhất toàn lịch.
  gate.globalAllowedKey = pending[0].key;

  // Tầng 2: sớm nhất trong từng ngày.
  for (const it of pending) {
    if (!gate.dayAllowedKeys.has(it.dayAt)) {
      gate.dayAllowedKeys.set(it.dayAt, it.key);
    }
  }

  // Việc nào không khớp tầng nào → bị chặn. Cho biết phải làm ai trước.
  //
  // Ưu tiên chỉ ra việc CÙNG NGÀY (gần nhất, dễ hành động hơn); nếu
  // không có việc nào cùng ngày thì chỉ ra việc sớm nhất toàn lịch.
  for (const it of pending) {
    if (it.key === gate.globalAllowedKey) continue;
    if (gate.dayAllowedKeys.get(it.dayAt) === it.key) continue;

    const sameDay = pending.find(
      (p) => p.dayAt === it.dayAt && p.key !== it.key && p.startAt < it.startAt,
    );
    const blocker = sameDay ?? pending.find((p) => p.key !== it.key);
    if (blocker) gate.blockedBy.set(it.key, blocker.key);
  }

  return gate;
}

/**
 * Việc này có được phép Start không?
 *
 * @param gate Kết quả `computeSequenceGate`.
 * @param key  Key của việc cần kiểm tra.
 * @param dayAt Ngày của việc (đầu ngày, epoch ms) — cho luật theo ngày.
 */
export function isItemAllowed(
  gate: SequenceGate,
  key: string,
  dayAt: number,
): boolean {
  if (gate.globalAllowedKey === key) return true;
  return gate.dayAllowedKeys.get(dayAt) === key;
}

/**
 * Tên việc phải làm trước (để hiện trong tooltip).
 *
 * @param items Danh sách việc (để tra tên theo key).
 */
export function findBlockerTitle(
  items: SequencedItem[],
  key: string,
): string | null {
  const blockerKey = items.find((i) => i.key === key);
  if (!blockerKey) return null;
  return blockerKey.title;
}

/* ===========================================================
 * Thông điệp cho người dùng
 * =========================================================== */

/**
 * Nội dung tooltip khi việc bị chặn bởi việc khác.
 *
 * ⚠️ Thông điệp hiển thị cho NGƯỜI DÙNG → dùng **tiếng Anh**.
 */
export function blockedTooltip(
  blockerTitle: string | null,
  blockerTitleFallback = "an earlier task",
): string {
  const who = blockerTitle?.trim() || blockerTitleFallback;
  return `Finish "${who}" first — you can't start a later task while an earlier one is still open.`;
}

/* ===========================================================
 * Tiện ích suy ra trạng thái từ dữ liệu lịch
 * =========================================================== */

/** Slot này đang chạy không (→ hiện nút Stop)? */
export function isRunningPhase(phase: FocusSlotPhase): boolean {
  return phase === "InProgress" || phase === "Overrun";
}
