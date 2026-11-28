import { useEffect, useState } from "react";
import type { GroupFocusStopReason } from "../../lib/group-api";
import {
  GROUP_STOP_REASON_HINTS,
  GROUP_STOP_REASON_LABELS,
  GROUP_STOP_REASONS,
  groupStopReasonNeedsNote,
} from "./group-stop-reasons";
import "./my-group-tasks.css";

/* ===========================================================
 * <GroupStopReasonDialog> — hộp thoại chọn LÝ DO DỪNG phiên nhóm
 * ===========================================================
 *
 * Dùng chung cho:
 *  - Tab "My tasks" trong `/groups/:id` (`GroupMyTasksPanel`).
 *  - Trang `/my-group-tasks` (`MyGroupTasks`).
 *
 * Body gửi lên BE (`POST /api/group-focus/{sessionId}/stop`):
 * ```json
 * { "stopReason": "Completed" | "Interrupted" | "Blocked" | "Other",
 *   "note": "ghi chú (tuỳ chọn)" }
 * ```
 *
 * ⚠️ Theo `GROUP_FE.md`: `note` **bắt buộc** với `Blocked` và `Other`
 * (BE trả `400` nếu thiếu).
 * =========================================================== */

export function GroupStopReasonDialog({
  taskTitle,
  subTaskTitle,
  groupName,
  elapsedLabel,
  onConfirm,
  onClose,
  busy,
  serverError,
}: {
  /** Tên việc nhóm đang ghi giờ. */
  taskTitle: string | null;
  /** Tên việc con (nếu có). */
  subTaskTitle?: string | null;
  /** Tên nhóm. */
  groupName?: string | null;
  /** Chuỗi thời gian đã trôi qua, vd "00:12:30". */
  elapsedLabel?: string | null;
  /** Gửi lý do + ghi chú lên BE. */
  onConfirm: (reason: GroupFocusStopReason, note: string | null) => void;
  onClose: () => void;
  /** Đang gọi API → khoá nút. */
  busy: boolean;
  /** Lỗi 400 từ server (vd: thiếu `note`) — phiên vẫn đang chạy. */
  serverError?: string | null;
}) {
  const [reason, setReason] = useState<GroupFocusStopReason>("Completed");
  const [note, setNote] = useState("");
  const [touched, setTouched] = useState(false);

  /* Escape → đóng hộp thoại. */
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const noteRequired = groupStopReasonNeedsNote(reason);
  const noteMissing = noteRequired && !note.trim();
  const showNoteError = touched && noteMissing;

  return (
    <div
      className="mgt-modal-backdrop"
      onClick={onClose}
      role="presentation"
    >
      <div
        className="mgt-modal mgt-modal--stop"
        role="dialog"
        aria-modal="true"
        aria-labelledby="gdt-stop-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mgt-modal-head">
          <h2 id="gdt-stop-title" className="mgt-modal-title">
            <span
              className="material-symbols-outlined mgt-modal-title-icon"
              aria-hidden="true"
            >
              stop_circle
            </span>
            Stop this focus session
          </h2>
          <button
            type="button"
            className="mgt-modal-close"
            onClick={onClose}
            aria-label="Close"
          >
            <span className="material-symbols-outlined">close</span>
          </button>
        </div>

        {/* ---------- Phiên đang chạy ---------- */}
        <div className="mgt-stop-session">
          <div className="mgt-stop-session-body">
            <span className="mgt-stop-session-title">
              {taskTitle || "Unknown task"}
              {subTaskTitle ? ` · ${subTaskTitle}` : ""}
            </span>
            {groupName && (
              <span className="mgt-stop-session-group">{groupName}</span>
            )}
          </div>
          {elapsedLabel && (
            <span className="mgt-stop-session-clock">{elapsedLabel}</span>
          )}
        </div>

        <div className="mgt-modal-body">
          {/* ---------- Lý do dừng ---------- */}
          <p className="mgt-modal-text mgt-stop-label">Reason for stopping</p>
          <div
            className="mgt-stop-reasons"
            role="radiogroup"
            aria-label="Reason for stopping"
          >
            {GROUP_STOP_REASONS.map((r) => (
              <button
                key={r}
                type="button"
                role="radio"
                aria-checked={reason === r}
                className={`mgt-stop-reason${reason === r ? " mgt-stop-reason--active" : ""}`}
                onClick={() => {
                  setReason(r);
                  setTouched(false);
                }}
                disabled={busy}
              >
                <span className="mgt-stop-reason-dot" aria-hidden="true" />
                <span className="mgt-stop-reason-body">
                  <span className="mgt-stop-reason-label">
                    {GROUP_STOP_REASON_LABELS[r]}
                  </span>
                  <span className="mgt-stop-reason-hint">
                    {GROUP_STOP_REASON_HINTS[r]}
                  </span>
                </span>
              </button>
            ))}
          </div>

          {/* ---------- Ghi chú ---------- */}
          <label className="mgt-stop-label" htmlFor="gdt-stop-note">
            Note{" "}
            {noteRequired ? (
              <span className="mgt-stop-required">(required)</span>
            ) : (
              <span className="mgt-stop-optional">(optional)</span>
            )}
          </label>
          <textarea
            id="gdt-stop-note"
            className={`mgt-textarea${showNoteError ? " mgt-textarea--error" : ""}`}
            placeholder={
              noteRequired
                ? "e.g. Waiting for the client to send the document"
                : "e.g. Sent the file to the client"
            }
            value={note}
            onChange={(e) => {
              setNote(e.target.value);
              if (touched) setTouched(false);
            }}
            rows={3}
            disabled={busy}
          />
          {showNoteError && (
            <p className="mgt-stop-error">
              Please add a short note for this reason.
            </p>
          )}
          {serverError && <p className="mgt-stop-error">{serverError}</p>}
        </div>

        <div className="mgt-form-actions">
          <button
            type="button"
            className="mgt-btn mgt-btn--ghost"
            onClick={onClose}
            disabled={busy}
          >
            Cancel
          </button>
          <button
            type="button"
            className="mgt-btn mgt-btn--primary"
            disabled={busy || noteMissing}
            onClick={() => {
              setTouched(true);
              if (noteRequired && !note.trim()) return;
              onConfirm(reason, note.trim() ? note.trim() : null);
            }}
          >
            {busy ? "Stopping…" : "Stop session"}
          </button>
        </div>
      </div>
    </div>
  );
}
