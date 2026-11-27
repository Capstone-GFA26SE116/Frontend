import { useEffect } from "react";

/**
 * ===========================================================
 * <ScheduleConfirmDialog> — hộp thoại xác nhận dùng chung cho trang lịch.
 * ===========================================================
 *
 * Yêu cầu: mọi hành động xóa (slot, khung giờ…) phải hỏi xác nhận TRƯỚC
 * khi gọi API. Toàn bộ nội dung hiển thị bằng **tiếng Anh** (chuẩn của
 * trang /schedule).
 *
 * - `Escape` / click ra ngoài / nút "Cancel" → đóng, KHÔNG xóa.
 * - Nút "Delete slot" → mới gọi `onConfirm`.
 * - `busy` → khoá nút để tránh double-submit khi request đang bay.
 */
export function ScheduleConfirmDialog({
  open,
  title,
  message,
  confirmLabel = "Delete slot",
  cancelLabel = "Cancel",
  busy = false,
  tone = "danger",
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
  /** `danger` = hành động xóa (nền đỏ), `warn` = cảnh báo. */
  tone?: "danger" | "warn";
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

  return (
    <div
      className="sch-modal sch-modal--confirm"
      role="presentation"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !busy) onCancel();
      }}
    >
      <div
        className="sch-modal__panel sch-modal__panel--confirm"
        role="alertdialog"
        aria-modal="true"
        aria-label={title}
      >
        <div className="sch-confirm__head">
          <span
            className={`sch-confirm__icon sch-confirm__icon--${tone}`}
            aria-hidden="true"
          >
            <span className="material-symbols-outlined">delete</span>
          </span>
          <h2 className="sch-confirm__title">{title}</h2>
        </div>

        <p className="sch-confirm__message">{message}</p>

        <div className="sch-confirm__actions">
          <button
            type="button"
            className="sch-btn sch-btn--soft"
            onClick={onCancel}
            disabled={busy}
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            className={`sch-btn sch-confirm__confirm${tone === "danger" ? " sch-confirm__confirm--danger" : ""}`}
            onClick={onConfirm}
            disabled={busy}
          >
            {busy ? "Deleting…" : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
