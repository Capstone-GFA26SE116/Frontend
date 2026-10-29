import { useFocusActions } from "./focus-context";
import {
  canStartSlot,
  isSlotDimmed,
  isSlotRunning,
  slotPhaseLabel,
  toSlotPhase,
} from "./focus-logic";
import "./focus.css";

/**
 * ===========================================================
 * <SlotFocusActions> — nút Start / Stop cho 1 schedule slot.
 * ===========================================================
 *
 * Quy tắc hiển thị theo spec FOCUS_SESSION_FE.md (mục 1 — trạng thái slot):
 *
 *   • `Proposed`  → KHÔNG có nút Start (chỉ xem, chưa duyệt).
 *   • `Approved`  → có nút Start (cho phép bắt đầu sớm).
 *   • `Due`       → nút Start nổi bật.
 *   • `InProgress`→ nút Stop.
 *   • `Overrun`   → nút Stop (màu cảnh báo).
 *   • `Missed`    → có nút Start (làm bù).
 *   • `Done`      → không nút.
 *   • `Skipped` / `Cancelled` / `Postponed` → ẩn hoặc làm mờ.
 *
 * Slot đang chạy ở tab khác vẫn hiện "Stop" — vì `GET /api/focus/current`
 * là nguồn sự thật toàn cục, không phụ thuộc slot nào được bấm.
 */

export interface SlotFocusActionsProps {
  /** Id của slot (null = không gắn slot → không Start được). */
  slotId: string | null;
  /** Id của task — bắt buộc cho `POST /api/focus/start`. */
  taskId: string | null;
  /** Id của subtask (nếu slot thuộc subtask). */
  subTaskId?: string | null;
  /** Status của slot (BE trả string tự do). */
  status: string | null | undefined;
  /** Phút dự kiến của slot — dùng cho mốc đồng hồ. */
  plannedMinutes?: number;
  /** Đã có phiên khác đang chạy (chặn Start). */
  blockedByOtherSession?: boolean;
  /** Kích thước nhỏ (dùng trong chip lịch). */
  compact?: boolean;
  /** Callback sau khi slot đổi trạng thái → refetch lịch. */
  onChanged?: () => void;
}

export function SlotFocusActions({
  slotId,
  taskId,
  subTaskId,
  status,
  plannedMinutes,
  blockedByOtherSession,
  compact,
  onChanged,
}: SlotFocusActionsProps) {
  const { start, openStopDialog, busy } = useFocusActions();
  const phase = toSlotPhase(status);

  // Không có slot → không Start được (BE yêu cầu taskId, slotId là optional
  // nhưng start ngoài lịch không có ý nghĩa trong UI này).
  if (!slotId || !taskId) return null;

  // Slot đã ẩn mờ → không hiện gì.
  if (isSlotDimmed(phase)) return null;

  const running = isSlotRunning(phase);
  const startable = canStartSlot(phase);

  // Không có hành động nào phù hợp (VD: Done, Proposed).
  if (!running && !startable) return null;

  async function handleStart() {
    await start({
      taskId: taskId!,
      scheduleSlotId: slotId,
      subTaskId: subTaskId ?? null,
    });
    onChanged?.();
  }

  function handleStop() {
    openStopDialog();
  }

  if (running) {
    return (
      <button
        type="button"
        className={`fc-slot-btn fc-slot-btn--stop${compact ? " fc-slot-btn--compact" : ""}`}
        onClick={handleStop}
        disabled={busy}
        title={phase === "Overrun" ? "Đã quá giờ — bấm để dừng" : "Dừng phiên làm việc"}
      >
        <span className="material-symbols-outlined">stop_circle</span>
        <span>{phase === "Overrun" ? "Quá giờ — Dừng" : "Dừng"}</span>
      </button>
    );
  }

  // Đang có phiên khác chạy → không cho Start (BE sẽ trả 409).
  if (blockedByOtherSession) {
    return (
      <span
        className={`fc-slot-note${compact ? " fc-slot-note--compact" : ""}`}
        title="Bạn đang có phiên làm việc khác đang chạy"
      >
        <span className="material-symbols-outlined">info</span>
        <span>Đang có phiên khác</span>
      </span>
    );
  }

  const label =
    phase === "Missed"
      ? "Làm bù"
      : phase === "Approved"
        ? "Bắt đầu sớm"
        : "Bắt đầu";

  return (
    <button
      type="button"
      className={`fc-slot-btn fc-slot-btn--start${compact ? " fc-slot-btn--compact" : ""}`}
      onClick={() => void handleStart()}
      disabled={busy}
      title={
        plannedMinutes
          ? `Bắt đầu phiên làm việc (${plannedMinutes} phút)`
          : "Bắt đầu phiên làm việc"
      }
    >
      <span className="material-symbols-outlined">play_circle</span>
      <span>{label}</span>
      <span className="fc-slot-btn__status">{slotPhaseLabel(phase)}</span>
    </button>
  );
}
