import { useEffect } from "react";
import { createPortal } from "react-dom";
import "./confirm-dialog.css";

/**
 * ===========================================================
 * <ConfirmDialog> — hộp thoại xác nhận dùng chung (tiếng Anh).
 * ===========================================================
 *
 * Mọi hành động xóa (milestone, task, subtask, slot…) đều phải hỏi xác nhận
 * TRƯỚC khi gọi API. Component này chỉ lo phần UI:
 *   - `Escape` / click ra ngoài / nút "Cancel" → đóng, KHÔNG gọi API.
 *   - Nút confirm → mới gọi `onConfirm` (component cha mới gọi API).
 *   - `busy` → khoá nút để tránh double-submit khi request đang bay.
 *
 * Render qua `createPortal` để không bị `overflow: hidden` của page cắt mất.
 */
export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel = "Delete",
  cancelLabel = "Cancel",
  busy = false,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  /** Tiêu đề hộp thoại (tiếng Anh). */
  title: string;
  /** Nội dung giải thích (tiếng Anh). */
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Đang gọi API → khoá nút xác nhận. */
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  // Đóng bằng Escape (trừ khi đang busy).
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape" && !busy) onCancel();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, busy, onCancel]);

  if (!open) return null;

  return createPortal(
    <div
      className="cf-backdrop"
      role="presentation"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !busy) onCancel();
      }}
    >
      <div
        className="cf-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-label={title}
      >
        <div className="cf-head">
          <span className="cf-icon" aria-hidden="true">
            <span className="material-symbols-outlined">warning</span>
          </span>
          <h2 className="cf-title">{title}</h2>
        </div>

        <p className="cf-message">{message}</p>

        <div className="cf-actions">
          <button
            type="button"
            className="cf-btn cf-btn--ghost"
            onClick={onCancel}
            disabled={busy}
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            className="cf-btn cf-btn--danger"
            onClick={onConfirm}
            disabled={busy}
          >
            {busy ? "Deleting…" : confirmLabel}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
