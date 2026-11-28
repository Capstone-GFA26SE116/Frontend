import { useEffect, useState, type ReactNode } from "react";
import type {
  FocusPendingConfirmationItem,
  FocusStopReason,
} from "../../lib/api-client";
import {
  CHECK_IN_OPTIONS,
  CHECK_IN_QUESTIONS,
  formatClock,
  formatMinutes,
  STOP_REASON_HINTS,
  STOP_REASON_LABELS,
  stopReasonNeedsNote,
} from "./focus-logic";
import "./focus.css";

/**
 * ===========================================================
 * Các hộp thoại của Focus Session
 * ===========================================================
 *
 * 1. <EarlyWarningDialog>  — bắt đầu sớm hơn lịch > 2h. Phiên ĐÃ được
 *    tạo → hỏi user có giữ không. "Không" → gọi Stop ngay.
 * 2. <StopReasonDialog>     — chọn lý do dừng + ghi chú.
 * 3. <ConfirmTimeoutDialog>  — phiên bị hệ thống tự ngắt: hỏi "thực sự
 *    làm bao lâu?" (mặc định điền systemMinutes).
 * 4. <SelfReportDialog>     — khai báo giờ đã làm việc (quên bấm Start).
 * 5. <CheckInDialog>        — hỏi "xong chưa?" sau khi stop (BE chưa có API
 *    lưu câu trả lời nên chỉ hiển thị).
 * =========================================================== */

/* ---------- Shell chung ---------- */

/**
 * Khung hộp thoại dùng chung: overlay + panel + head + body + foot.
 *
 * Bấm ra ngoài để đóng (trừ khi `dismissible === false`).
 */
function Dialog({
  eyebrow,
  title,
  icon,
  children,
  footer,
  dismissible = true,
  onClose,
  tone = "default",
}: {
  eyebrow?: string;
  title: string;
  icon?: string;
  children: ReactNode;
  footer?: ReactNode;
  dismissible?: boolean;
  onClose: () => void;
  tone?: "default" | "warn" | "danger";
}) {
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape" && dismissible) onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [dismissible, onClose]);

  return (
    <div
      className="fc-overlay"
      role="presentation"
      onMouseDown={(e) => {
        if (dismissible && e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className={`fc-dialog fc-dialog--${tone}`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <div className="fc-dialog__head">
          {icon && (
            <span className="fc-dialog__icon" aria-hidden="true">
              <span className="material-symbols-outlined">{icon}</span>
            </span>
          )}
          <div className="fc-dialog__headtext">
            {eyebrow && <span className="fc-dialog__eyebrow">{eyebrow}</span>}
            <h2 className="fc-dialog__title">{title}</h2>
          </div>
          {dismissible && (
            <button
              type="button"
              className="fc-dialog__close"
              aria-label="Close"
              onClick={onClose}
            >
              <span className="material-symbols-outlined">close</span>
            </button>
          )}
        </div>

        <div className="fc-dialog__body">{children}</div>

        {footer && <div className="fc-dialog__foot">{footer}</div>}
      </div>
    </div>
  );
}

/* ===========================================================
 * 1. Bắt đầu sớm — STARTED_VERY_EARLY
 * =========================================================== */

export function EarlyWarningDialog({
  startedEarlyMinutes,
  taskTitle,
  onKeep,
  onDiscard,
  busy,
}: {
  /** Số phút bắt đầu sớm. */
  startedEarlyMinutes: number;
  taskTitle: string | null;
  /** Giữ phiên (đã tạo, chỉ cần xác nhận). */
  onKeep: () => void;
  /** Bỏ phiên → gọi Stop ngay. */
  onDiscard: () => void;
  busy: boolean;
}) {
  return (
    <Dialog
      eyebrow="Started early"
      title="You're starting earlier than scheduled"
      icon="schedule"
      tone="warn"
      dismissible={false}
      onClose={() => {}}
      footer={
        <>
          <button
            type="button"
            className="fc-btn fc-btn--ghost"
            onClick={onDiscard}
            disabled={busy}
          >
            Discard this session
          </button>
          <button
            type="button"
            className="fc-btn fc-btn--primary"
            onClick={onKeep}
            disabled={busy}
          >
            Yes, start
          </button>
        </>
      }
    >
      <p className="fc-dialog__text">
        <strong>{taskTitle || "This task"}</strong> is scheduled to start{" "}
        <strong>{formatMinutes(startedEarlyMinutes)}</strong> later than now.
      </p>
      <p className="fc-dialog__hint">
        The focus session has already been created. If you clicked by mistake,
        choose <strong>Discard this session</strong> — it will be stopped
        immediately.
      </p>
    </Dialog>
  );
}

/* ===========================================================
 * 2. Chọn lý do dừng
 * =========================================================== */

export function StopReasonDialog({
  taskTitle,
  elapsedSeconds,
  onConfirm,
  onClose,
  busy,
  serverError,
}: {
  taskTitle: string | null;
  elapsedSeconds: number;
  /** Gửi lý do + ghi chú lên BE. */
  onConfirm: (reason: FocusStopReason, note: string | null) => void;
  onClose: () => void;
  busy: boolean;
  /** Lỗi 400 từ server (vd: thiếu `note`) — phiên vẫn đang chạy. */
  serverError?: string | null;
}) {
  const [reason, setReason] = useState<FocusStopReason>("Completed");
  const [note, setNote] = useState("");
  const [touched, setTouched] = useState(false);

  const reasons: FocusStopReason[] = [
    "Completed",
    "Interrupted",
    "Blocked",
    "Other",
  ];

  /**
   * `note` là **tuỳ chọn** với mọi lý do dừng
   * (spec `FOCUS_SESSION_FE (1).md` mục 5.2: "`note` tùy chọn").
   *
   * Hàm `stopReasonNeedsNote` được giữ lại để sẵn sàng cho BE đổi luật —
   * hiện trả về `false` cho mọi lý do.
   */
  const noteRequired = stopReasonNeedsNote(reason);
  const noteMissing = noteRequired && !note.trim();
  const showNoteError = touched && noteMissing;

  return (
    <Dialog
      eyebrow="End session"
      title="Stop the focus session"
      icon="stop_circle"
      onClose={onClose}
      footer={
        <>
          <button
            type="button"
            className="fc-btn fc-btn--ghost"
            onClick={onClose}
            disabled={busy}
          >
            Cancel
          </button>
          <button
            type="button"
            className="fc-btn fc-btn--primary"
            onClick={() => {
              setTouched(true);
              if (noteRequired && !note.trim()) return;
              onConfirm(reason, note.trim() ? note.trim() : null);
            }}
            disabled={busy || (noteRequired && !note.trim())}
          >
            {busy ? "Saving…" : "Stop session"}
          </button>
        </>
      }
    >
      <div className="fc-dialog__session">
        <span className="fc-dialog__session-title">
          {taskTitle || "Unknown task"}
        </span>
        <span className="fc-dialog__session-time">
          {formatClock(elapsedSeconds)}
        </span>
      </div>

      <p className="fc-dialog__label">Reason for stopping</p>
      <div className="fc-reasons" role="radiogroup" aria-label="Reason for stopping">
        {reasons.map((r) => (
          <button
            key={r}
            type="button"
            role="radio"
            aria-checked={reason === r}
            className={`fc-reason${reason === r ? " fc-reason--active" : ""}`}
            onClick={() => {
              setReason(r);
              setTouched(false);
            }}
            disabled={busy}
          >
            <span className="fc-reason__dot" aria-hidden="true" />
            <span className="fc-reason__body">
              <span className="fc-reason__label">{STOP_REASON_LABELS[r]}</span>
              <span className="fc-reason__hint">{STOP_REASON_HINTS[r]}</span>
            </span>
          </button>
        ))}
      </div>

      <label className="fc-dialog__label" htmlFor="fc-stop-note">
        Note{" "}
        {noteRequired ? (
          <span className="fc-dialog__required">(required)</span>
        ) : (
          <span className="fc-dialog__optional">(optional)</span>
        )}
      </label>
      <input
        id="fc-stop-note"
        type="text"
        className={
          "fc-input" + (showNoteError ? " fc-input--error" : "")
        }
        placeholder={
          noteRequired
            ? "e.g. Waiting for the client to send the document"
            : "e.g. Sent the file to the client"
        }
        value={note}
        onChange={(e) => {
          setNote(e.target.value);
          setTouched(true);
        }}
        disabled={busy}
        maxLength={500}
        aria-invalid={showNoteError}
      />
      {showNoteError && (
        <p className="fc-dialog__field-error" role="alert">
          <span className="material-symbols-outlined">error</span>
          Please describe the reason — this reason requires a note.
        </p>
      )}

      {serverError && (
        <p className="fc-dialog__field-error" role="alert">
          <span className="material-symbols-outlined">error</span>
          {serverError}
        </p>
      )}
    </Dialog>
  );
}

/* ===========================================================
 * 3. Xác nhận phiên bị hệ thống tự ngắt
 * =========================================================== */

export function ConfirmTimeoutDialog({
  item,
  onConfirm,
  onDiscard,
  onClose,
  busy,
}: {
  item: FocusPendingConfirmationItem;
  /** Xác nhận (đã làm đủ) hoặc sửa số phút. */
  onConfirm: (correctedMinutes: number | null) => void;
  /** Loại bỏ phiên này. */
  onDiscard: () => void;
  onClose: () => void;
  busy: boolean;
}) {
  const [minutes, setMinutes] = useState<string>(String(item.systemMinutes));
  const [edited, setEdited] = useState(false);

  const parsed = Number(minutes);
  const valid =
    Number.isFinite(parsed) &&
    parsed >= 1 &&
    parsed <= 1440 &&
    Math.floor(parsed) === parsed;

  return (
    <Dialog
      eyebrow="Auto-ended by the system"
      title="How long did you actually work?"
      icon="timer_off"
      tone="warn"
      onClose={onClose}
      footer={
        <>
          <button
            type="button"
            className="fc-btn fc-btn--danger-ghost"
            onClick={onDiscard}
            disabled={busy}
          >
            Discard this session
          </button>
          <button
            type="button"
            className="fc-btn fc-btn--primary"
            onClick={() => onConfirm(edited && valid ? parsed : null)}
            disabled={busy}
          >
            {busy ? "Saving…" : "Confirm"}
          </button>
        </>
      }
    >
      <p className="fc-dialog__text">
        The focus session for <strong>{item.taskTitle || "this task"}</strong>{" "}
        was ended automatically because it ran too long.
      </p>
      <p className="fc-dialog__hint">
        The system recorded <strong>{formatMinutes(item.systemMinutes)}</strong>.
        This time is <em>not</em> counted as actual work time until you confirm.
      </p>

      <label className="fc-dialog__label" htmlFor="fc-confirm-minutes">
        Actual time (minutes)
      </label>
      <input
        id="fc-confirm-minutes"
        type="number"
        className="fc-input"
        min={1}
        max={1440}
        step={1}
        value={minutes}
        onChange={(e) => {
          setMinutes(e.target.value);
          setEdited(true);
        }}
        disabled={busy}
      />
      {edited && !valid && (
        <p className="fc-dialog__error">
          Minutes must be a whole number from 1 to 1440.
        </p>
      )}
    </Dialog>
  );
}

/* ===========================================================
 * 4. Khai báo giờ đã làm việc (quên bấm Start)
 * =========================================================== */

export function SelfReportDialog({
  taskTitle,
  tasks,
  selectedTaskId,
  onSelectTask,
  onSubmit,
  onClose,
  busy,
}: {
  taskTitle: string | null;
  /** Danh sách task để chọn (bắt buộc cho self-report vì API cần taskId). */
  tasks: Array<{ id: string; title: string }>;
  /** Task đang chọn. */
  selectedTaskId: string;
  /** Đổi task đang chọn. */
  onSelectTask: (taskId: string) => void;
  /** Gửi khoảng thời gian (phút) đã làm. */
  onSubmit: (minutes: number, note: string | null) => void;
  onClose: () => void;
  busy: boolean;
}) {
  const [minutes, setMinutes] = useState("60");
  const [note, setNote] = useState("");

  const parsed = Number(minutes);
  const valid =
    Number.isFinite(parsed) &&
    parsed >= 1 &&
    parsed <= 1440 &&
    Math.floor(parsed) === parsed;

  return (
    <Dialog
      eyebrow="Manual entry"
      title="Add time already worked"
      icon="edit_calendar"
      onClose={onClose}
      footer={
        <>
          <button
            type="button"
            className="fc-btn fc-btn--ghost"
            onClick={onClose}
            disabled={busy}
          >
            Cancel
          </button>
          <button
            type="button"
            className="fc-btn fc-btn--primary"
            onClick={() =>
              onSubmit(parsed, note.trim() ? note.trim() : null)
            }
            disabled={busy || !valid || !selectedTaskId}
          >
            {busy ? "Saving…" : "Record"}
          </button>
        </>
      }
    >
      <p className="fc-dialog__text">
        Forgot to press Start? Record the time you worked on{" "}
        <strong>{taskTitle || "this task"}</strong> so your stats stay accurate.
      </p>

      <label className="fc-dialog__label" htmlFor="fc-self-task">
        Task
      </label>
      {tasks.length === 0 ? (
        <p className="fc-dialog__hint">There are no tasks to record yet.</p>
      ) : (
        <select
          id="fc-self-task"
          className="fc-input fc-select"
          value={selectedTaskId}
          onChange={(e) => onSelectTask(e.target.value)}
          disabled={busy}
        >
          <option value="">— Select a task —</option>
          {tasks.map((t) => (
            <option key={t.id} value={t.id}>
              {t.title}
            </option>
          ))}
        </select>
      )}

      <label className="fc-dialog__label" htmlFor="fc-self-minutes">
        Time worked (minutes)
      </label>
      <input
        id="fc-self-minutes"
        type="number"
        className="fc-input"
        min={1}
        max={1440}
        step={1}
        value={minutes}
        onChange={(e) => setMinutes(e.target.value)}
        disabled={busy}
      />
      {(!Number.isFinite(parsed) || parsed < 1 || parsed > 1440) && (
        <p className="fc-dialog__error">
          Minutes must be a whole number from 1 to 1440.
        </p>
      )}

      <label className="fc-dialog__label" htmlFor="fc-self-note">
        Note <span className="fc-dialog__optional">(optional)</span>
      </label>
      <input
        id="fc-self-note"
        type="text"
        className="fc-input"
        placeholder="e.g. Finished the design draft"
        value={note}
        onChange={(e) => setNote(e.target.value)}
        disabled={busy}
        maxLength={500}
      />
    </Dialog>
  );
}

/* ===========================================================
 * 5. Check-in sau khi dừng
 * =========================================================== */
export function CheckInDialog({
  taskTitle,
  sessionMinutes,
  onClose,
}: {
  taskTitle: string | null;
  /** Số phút của phiên vừa dừng. */
  sessionMinutes: number;
  onClose: () => void;
}) {
  const [picked, setPicked] = useState<string | null>(null);

  return (
    <Dialog
      eyebrow="Quick check-in"
      title={CHECK_IN_QUESTIONS[0]}
      icon="sentiment_satisfied"
      onClose={onClose}
      footer={
        <button
          type="button"
          className="fc-btn fc-btn--primary"
          onClick={onClose}
        >
          {picked ? "Done" : "Skip"}
        </button>
      }
    >
      <p className="fc-dialog__text">
        You just worked for <strong>{formatMinutes(sessionMinutes)}</strong> on{" "}
        <strong>{taskTitle || "this task"}</strong>.
      </p>
      <p className="fc-dialog__hint">
        {CHECK_IN_QUESTIONS[1]}
      </p>
      <div className="fc-chips" role="group" aria-label="Quick rating">
        {CHECK_IN_OPTIONS.map((opt) => (
          <button
            key={opt}
            type="button"
            className={`fc-chip${picked === opt ? " fc-chip--active" : ""}`}
            onClick={() => setPicked(opt)}
          >
            {opt}
          </button>
        ))}
      </div>
    </Dialog>
  );
}

/* ===========================================================
 * 6. Đánh dấu xong sau khi Stop `Completed`
 * ===========================================================
 *
 * ⚠️ BẮT BUỘC theo spec `FOCUS_SESSION_FE (1).md` mục 1 + 6.2 + 6.3:
 *
 *   "Điểm FE hay hiểu sai nhất: **Stop `Completed` chỉ làm slot thành
 *    `Done`**, không đánh dấu task hay subtask xong."
 *
 *   "Sau khi Stop `Completed` trên subtask, hỏi 'Đánh dấu subtask này là
 *    xong?' rồi gọi `PUT` subtask; nếu mọi subtask đã `Done` thì hỏi tiếp
 *    'Đánh dấu cả task là xong?'."
 *
 * Đây là hộp thoại hỏi **1 câu**, không phải hành động tự động — user
 * quyết định.
 * =========================================================== */

export function MarkDoneDialog({
  kind,
  title,
  progress,
  onConfirm,
  onSkip,
  busy,
}: {
  /** true = hỏi về subtask, false = hỏi về task. */
  kind: "subtask" | "task";
  /** Tên subtask / task. */
  title: string | null;
  /**
   * Số subtask đã `Done` / tổng (chỉ dùng cho `kind = "task"`).
   * null = không có thông tin.
   */
  progress?: { done: number; total: number } | null;
  onConfirm: () => void;
  onSkip: () => void;
  busy: boolean;
}) {
  const isSubtask = kind === "subtask";
  return (
    <Dialog
      eyebrow="Mark as complete"
      title={
        isSubtask
          ? "Mark this subtask as done?"
          : "Mark the whole task as done?"
      }
      icon="task_alt"
      onClose={onSkip}
      footer={
        <>
          <button
            type="button"
            className="fc-btn fc-btn--ghost"
            onClick={onSkip}
            disabled={busy}
          >
            No, later
          </button>
          <button
            type="button"
            className="fc-btn fc-btn--primary"
            onClick={onConfirm}
            disabled={busy}
          >
            {busy ? "Saving…" : "Mark as done"}
          </button>
        </>
      }
    >
      <p className="fc-dialog__text">
        <strong>{title || (isSubtask ? "Subtask" : "Task")}</strong> — you just
        stopped the focus session with the reason <em>Completed</em>.
      </p>
      <p className="fc-dialog__hint">
        {isSubtask ? (
          <>
            The slot on your schedule has moved to <em>Completed</em>. Marking
            this subtask as done still needs your confirmation.
          </>
        ) : (
          <>
            The slot on your schedule has moved to <em>Completed</em>. Marking
            the task as done still needs your confirmation.
          </>
        )}
      </p>
      {!isSubtask && progress && progress.total > 0 && (
        <p className="fc-dialog__hint">
          Subtasks done: <strong>{progress.done}/{progress.total}</strong>
          {progress.done === progress.total
            ? " — all of them are done."
            : " — some subtasks are still incomplete."}
        </p>
      )}
    </Dialog>
  );
}
