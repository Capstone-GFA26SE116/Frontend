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
              aria-label="Đóng"
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
      eyebrow="Bắt đầu sớm"
      title="Bạn đang bắt đầu sớm hơn lịch"
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
            Bỏ phiên này
          </button>
          <button
            type="button"
            className="fc-btn fc-btn--primary"
            onClick={onKeep}
            disabled={busy}
          >
            Vâng, bắt đầu
          </button>
        </>
      }
    >
      <p className="fc-dialog__text">
        <strong>{taskTitle || "Task này"}</strong> được lên lịch bắt đầu muộn hơn{" "}
        <strong>{formatMinutes(startedEarlyMinutes)}</strong> so với bây giờ.
      </p>
      <p className="fc-dialog__hint">
        Phiên làm việc đã được tạo. Nếu bạn bấm nhầm, hãy chọn{" "}
        <strong>Bỏ phiên này</strong> — phiên sẽ được dừng ngay.
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
}: {
  taskTitle: string | null;
  elapsedSeconds: number;
  /** Gửi lý do + ghi chú lên BE. */
  onConfirm: (reason: FocusStopReason, note: string | null) => void;
  onClose: () => void;
  busy: boolean;
}) {
  const [reason, setReason] = useState<FocusStopReason>("Completed");
  const [note, setNote] = useState("");

  const reasons: FocusStopReason[] = [
    "Completed",
    "Interrupted",
    "Blocked",
    "Other",
  ];

  return (
    <Dialog
      eyebrow="Kết thúc phiên"
      title="Dừng phiên làm việc"
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
            Huỷ
          </button>
          <button
            type="button"
            className="fc-btn fc-btn--primary"
            onClick={() =>
              onConfirm(reason, note.trim() ? note.trim() : null)
            }
            disabled={busy}
          >
            {busy ? "Đang lưu…" : "Dừng phiên"}
          </button>
        </>
      }
    >
      <div className="fc-dialog__session">
        <span className="fc-dialog__session-title">
          {taskTitle || "Không rõ task"}
        </span>
        <span className="fc-dialog__session-time">
          {formatClock(elapsedSeconds)}
        </span>
      </div>

      <p className="fc-dialog__label">Lý do dừng</p>
      <div className="fc-reasons" role="radiogroup" aria-label="Lý do dừng">
        {reasons.map((r) => (
          <button
            key={r}
            type="button"
            role="radio"
            aria-checked={reason === r}
            className={`fc-reason${reason === r ? " fc-reason--active" : ""}`}
            onClick={() => setReason(r)}
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
        Ghi chú <span className="fc-dialog__optional">(tuỳ chọn)</span>
      </label>
      <input
        id="fc-stop-note"
        type="text"
        className="fc-input"
        placeholder="VD: Đã gửi file cho khách"
        value={note}
        onChange={(e) => setNote(e.target.value)}
        disabled={busy}
        maxLength={500}
      />
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
      eyebrow="Hệ thống đã tự ngắt"
      title="Bạn thực sự làm bao lâu?"
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
            Bỏ phiên này
          </button>
          <button
            type="button"
            className="fc-btn fc-btn--primary"
            onClick={() => onConfirm(edited && valid ? parsed : null)}
            disabled={busy}
          >
            {busy ? "Đang lưu…" : "Xác nhận"}
          </button>
        </>
      }
    >
      <p className="fc-dialog__text">
        Phiên làm việc cho <strong>{item.taskTitle || "task"}</strong> đã bị hệ
        thống tự ngắt vì kéo dài quá lâu.
      </p>
      <p className="fc-dialog__hint">
        Hệ thống ghi nhận <strong>{formatMinutes(item.systemMinutes)}</strong>. Số
        này <em>chưa</em> được tính vào thời gian làm việc thực tế cho tới khi
        bạn xác nhận.
      </p>

      <label className="fc-dialog__label" htmlFor="fc-confirm-minutes">
        Thời gian thực tế (phút)
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
          Số phút phải là số nguyên từ 1 đến 1440.
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
      eyebrow="Bổ sung thủ công"
      title="Thêm giờ đã làm việc"
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
            Huỷ
          </button>
          <button
            type="button"
            className="fc-btn fc-btn--primary"
            onClick={() =>
              onSubmit(parsed, note.trim() ? note.trim() : null)
            }
            disabled={busy || !valid || !selectedTaskId}
          >
            {busy ? "Đang lưu…" : "Ghi nhận"}
          </button>
        </>
      }
    >
      <p className="fc-dialog__text">
        Bạn quên bấm Start? Ghi nhận thời gian đã làm cho{" "}
        <strong>{taskTitle || "task"}</strong> để thống kê chính xác.
      </p>

      <label className="fc-dialog__label" htmlFor="fc-self-task">
        Task
      </label>
      {tasks.length === 0 ? (
        <p className="fc-dialog__hint">Chưa có task nào để ghi nhận.</p>
      ) : (
        <select
          id="fc-self-task"
          className="fc-input fc-select"
          value={selectedTaskId}
          onChange={(e) => onSelectTask(e.target.value)}
          disabled={busy}
        >
          <option value="">— Chọn task —</option>
          {tasks.map((t) => (
            <option key={t.id} value={t.id}>
              {t.title}
            </option>
          ))}
        </select>
      )}

      <label className="fc-dialog__label" htmlFor="fc-self-minutes">
        Thời gian đã làm (phút)
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
          Số phút phải là số nguyên từ 1 đến 1440.
        </p>
      )}

      <label className="fc-dialog__label" htmlFor="fc-self-note">
        Ghi chú <span className="fc-dialog__optional">(tuỳ chọn)</span>
      </label>
      <input
        id="fc-self-note"
        type="text"
        className="fc-input"
        placeholder="VD: Hoàn thành phần thiết kế"
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
      eyebrow="Kiểm tra nhanh"
      title={CHECK_IN_QUESTIONS[0]}
      icon="sentiment_satisfied"
      onClose={onClose}
      footer={
        <button
          type="button"
          className="fc-btn fc-btn--primary"
          onClick={onClose}
        >
          {picked ? "Xong" : "Bỏ qua"}
        </button>
      }
    >
      <p className="fc-dialog__text">
        Bạn vừa làm <strong>{formatMinutes(sessionMinutes)}</strong> cho{" "}
        <strong>{taskTitle || "task"}</strong>.
      </p>
      <p className="fc-dialog__hint">
        {CHECK_IN_QUESTIONS[1]}
      </p>
      <div className="fc-chips" role="group" aria-label="Đánh giá nhanh">
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
