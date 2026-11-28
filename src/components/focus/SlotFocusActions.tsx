import { useEffect, useState } from "react";
import { getTask, listSubtasks } from "../../lib/api-client";
import { useFocusActions } from "./focus-context";
import {
  buildFocusStartBody,
  canStartSlot,
  isClosedStatus,
  isSlotDimmed,
  isSlotFaded,
  isSlotRunning,
  slotPhaseLabel,
  toSlotPhase,
} from "./focus-logic";
import { OverrunDialog } from "./OverrunDialog";
import "./focus.css";

/**
 * ===========================================================
 * <SlotFocusActions> — nút Start / Stop cho 1 schedule slot.
 * ===========================================================
 *
 * Quy tắc hiển thị theo spec FOCUS_START_STOP_REWORK_FE.md mục 3 + 6:
 *
 *   • `Proposed`  → KHÔNG có nút Start (chỉ xem, chưa duyệt → BE trả 400).
 *   • `Approved`  → có nút Start (cho phép bắt đầu sớm).
 *   • `Due`       → nút Start nổi bật.
 *   • `InProgress`→ nút Stop.
 *   • `Overrun`   → nút Stop (màu cảnh báo).
 *   • `Missed`    → có nút Start (làm bù).
 *   • `Postponed` → làm mờ nhưng VẪN Start được (BE cho phép).
 *   • `Done`      → không nút.
 *   • `Skipped` / `Cancelled` → ẩn hoặc làm mờ, không Start.
 *
 * ⚠️ MỚI (spec mục 2 + mục 3): Start trên task/subtask đã `Done`/`Skipped`
 * → BE trả 400 ("Hãy mở lại task trước khi làm việc"). Ta tra trạng thái
 * task (và subtask của slot) để **ẩn nút Start** — nhưng vẫn xử lý 400
 * từ server nếu trạng thái đổi giữa lúc render và lúc bấm.
 *
 * Slot đang chạy ở tab khác vẫn hiện "Stop" — vì `GET /api/focus/current`
 * là nguồn sự thật toàn cục, không phụ thuộc slot nào được bấm.
 */

export interface SlotFocusActionsProps {
  /** Id của slot (null = không gắn slot → không Start được). */
  slotId: string | null;
  /** Id của task — bắt buộc cho `POST /api/focus/start`. */
  taskId: string | null;
  /**
   * Id của subtask mà slot này gắn với.
   *
   * ⚠️ Phải là `subTaskId` **của slot**, không phải của event. Spec mục 6.1:
   * "Slot gắn subtask nhưng không gửi `subTaskId` khi Start → Phiên **không**
   * có subtask. Backend **không tự lấy** `subTaskId` từ slot."
   *
   * Với event gộp nhiều slot của 1 task, `event.subTaskId` là `null` → nếu ta
   * dùng nó thì phiên sẽ mất nhãn subtask. Luôn truyền subtask của slot.
   */
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
  /** Tên task — hiện trong dialog "Cần thêm phút". */
  taskTitle?: string | null;
  /**
   * Lý do bị chặn (tiếng Anh) — VD: "Finish 'X' first".
   *
   * Khi có giá trị: nút Start **vẫn hiện** nhưng bị disable, và tooltip
   * giải thích lý do. Đây là luật "làm trước - làm sau" của trang lịch
   * (chỉ ở FE, xem `sequence-logic.ts`).
   */
  blockedReason?: string | null;
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
  taskTitle,
  blockedReason,
}: SlotFocusActionsProps) {
  const { start, openStopDialog, busy } = useFocusActions();
  const phase = toSlotPhase(status);

  /** Mở dialog "Cần thêm X phút" (spec BE bước 8). */
  const [overrunOpen, setOverrunOpen] = useState(false);

  /*
   * Trạng thái task (và subtask của slot) — dùng để ẩn nút Start khi
   * task/subtask đã `Done`/`Skipped` (spec mục 3: BE trả 400).
   *
   * `null` = chưa biết (đang tải) → vẫn cho Start (BE sẽ báo lỗi nếu sai).
   */
  const [taskClosed, setTaskClosed] = useState<boolean | null>(null);
  const [subTaskClosed, setSubTaskClosed] = useState<boolean | null>(null);

  useEffect(() => {
    if (!taskId) {
      // Không có task → không cần tra cứu gì. State đã là `null` mặc định
      // nên không cần setState đồng bộ (tránh lint set-state-in-effect).
      return;
    }
    let cancelled = false;
    void (async () => {
      const res = await getTask(taskId);
      if (cancelled) return;
      setTaskClosed(res.ok ? isClosedStatus(res.data.status) : null);

      // Chỉ cần tra subtask khi slot thực sự gắn 1 subtask.
      if (!subTaskId) {
        setSubTaskClosed(null);
        return;
      }
      const subs = await listSubtasks(taskId);
      if (cancelled) return;
      if (!subs.ok) {
        setSubTaskClosed(null);
        return;
      }
      const sub = subs.data.find((s) => s.id === subTaskId);
      setSubTaskClosed(sub ? isClosedStatus(sub.status) : null);
    })();
    return () => {
      cancelled = true;
    };
  }, [taskId, subTaskId]);

  // Không có slot → không Start được (BE yêu cầu taskId, slotId là optional
  // nhưng start ngoài lịch không có ý nghĩa trong UI này).
  if (!slotId || !taskId) return null;

  /*
   * Narrow vào biến cục bộ: `slotId` / `taskId` là `string | null` ở props,
   * nhưng đã được guard ở trên → trong closure TS không tự narrow.
   */
  const slot: { id: string; subTaskId: string | null } = {
    id: slotId,
    subTaskId: subTaskId ?? null,
  };
  const task = taskId;

  // Slot đã ẩn mờ → không hiện gì.
  if (isSlotDimmed(phase)) return null;

  const running = isSlotRunning(phase);
  const startable = canStartSlot(phase);

  /*
   * Task/subtask đã đóng → ẩn nút Start.
   *
   * Spec mục 2 + mục 3: "Task hoặc subtask `Done`/`Skipped`: ẩn hoặc vô hiệu
   * nút Start (server trả `400` nếu vẫn gửi)."
   */
  const closed = taskClosed === true || subTaskClosed === true;

  // Không có hành động nào phù hợp (VD: Done, Proposed).
  if (!running && (!startable || closed)) return null;

  async function handleStart() {
    // Body theo spec mục 7: subtask lấy TỪ SLOT (backend không tự lấy).
    await start(buildFocusStartBody(task, slot));
    onChanged?.();
  }

  function handleStop() {
    openStopDialog();
  }

  if (running) {
    return (
      <>
        <button
          type="button"
          className={`fc-slot-btn fc-slot-btn--stop${compact ? " fc-slot-btn--compact" : ""}`}
          onClick={handleStop}
          disabled={busy}
          title={phase === "Overrun" ? "You're over time — click to stop" : "Stop the focus session"}
        >
          <span className="material-symbols-outlined">stop_circle</span>
          <span>{phase === "Overrun" ? "Overrun — Stop" : "Stop"}</span>
        </button>

        {/* Spec BE bước 8: "Đang làm mà trễ giờ → Cần thêm X phút". */}
        <button
          type="button"
          className={`fc-slot-btn fc-slot-btn--overrun${compact ? " fc-slot-btn--compact" : ""}`}
          onClick={() => setOverrunOpen(true)}
          disabled={busy}
          title="Not finished — need more time"
        >
          <span className="material-symbols-outlined">more_time</span>
          <span>Add minutes</span>
        </button>

        <OverrunDialog
          /* `key` gồm cả cờ mở → mỗi lần mở lại là 1 instance mới,
             state (phút đã chọn, kết quả AI) không bị giữ lại từ lần trước. */
          key={`${slotId}-${overrunOpen ? "open" : "closed"}`}
          slotId={overrunOpen ? slotId : null}
          taskTitle={taskTitle}
          plannedMinutes={plannedMinutes}
          onClose={() => setOverrunOpen(false)}
          onApplied={onChanged}
        />
      </>
    );
  }

  // Đang có phiên khác chạy → không cho Start (BE sẽ trả 409).
  if (blockedByOtherSession) {
    return (
      <span
        className={`fc-slot-note${compact ? " fc-slot-note--compact" : ""}`}
        title="Another focus session is already running"
      >
        <span className="material-symbols-outlined">info</span>
        <span>Another session running</span>
      </span>
    );
  }

  const label =
    phase === "Missed"
      ? "Make up"
      : phase === "Approved"
        ? "Start early"
        : phase === "Postponed"
          ? "Redo"
          : "Start";

  const faded = isSlotFaded(phase);

  /*
   * Bị chặn bởi luật "làm trước - làm sau" (chỉ ở FE).
   *
   * → VẪN hiện nút Start nhưng disable + tooltip giải thích. Người dùng
   *   thấy rõ là có việc, chỉ là chưa được phép làm chưa.
   */
  if (blockedReason) {
    return (
      <button
        type="button"
        className={`fc-slot-btn fc-slot-btn--start fc-slot-btn--blocked${compact ? " fc-slot-btn--compact" : ""}`}
        disabled
        title={blockedReason}
      >
        <span className="material-symbols-outlined">lock</span>
        <span>{label}</span>
        <span className="fc-slot-btn__status">{slotPhaseLabel(phase)}</span>
      </button>
    );
  }

  return (
    <button
      type="button"
      className={`fc-slot-btn fc-slot-btn--start${faded ? " fc-slot-btn--faded" : ""}${compact ? " fc-slot-btn--compact" : ""}`}
      onClick={() => void handleStart()}
      disabled={busy}
      title={
        plannedMinutes
          ? `Start the focus session (${plannedMinutes} min)`
          : "Start the focus session"
      }
    >
      <span className="material-symbols-outlined">play_circle</span>
      <span>{label}</span>
      <span className="fc-slot-btn__status">{slotPhaseLabel(phase)}</span>
    </button>
  );
}
