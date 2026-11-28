import { useEffect } from "react";
import "./alert-dialog.css";

/**
 * ===========================================================
 * <AlertDialog> — pop-up thông báo lỗi / cảnh báo (tiếng Anh)
 * ===========================================================
 *
 * Dùng khi một thao tác KHÔNG THÀNH CÔNG (lưu slot bị lỗi, xóa slot bị lỗi…)
 * → thay vì chỉ hiện toast (bay mất) hoặc ghi lỗi nhỏ trong form, ta hiện
 * pop-up rõ ràng với message tiếng Anh dễ hiểu.
 *
 * - `Escape` / click ra ngoài / nút "OK" → đóng.
 * - Không có nút "confirm hành động" — chỉ để user đọc và đóng.
 */
export function AlertDialog({
  open,
  title,
  message,
  tone = "error",
  actionLabel = "Got it",
  onClose,
}: {
  open: boolean;
  /** Tiêu đề pop-up (tiếng Anh). */
  title: string;
  /** Nội dung giải thích (tiếng Anh, dễ hiểu). */
  message: string;
  /** `error` = đỏ (thất bại) · `warn` = vàng (cần chú ý) · `success` = xanh (thành công). */
  tone?: "error" | "warn" | "success";
  /** Nhãn nút đóng. */
  actionLabel?: string;
  onClose: () => void;
}) {
  // Đóng bằng Escape.
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className="sch-modal sch-modal--alert"
      role="presentation"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="sch-modal__panel sch-modal__panel--alert"
        role="alertdialog"
        aria-modal="true"
        aria-label={title}
      >
        <div className="sch-confirm__head">
          <span
            className={`sch-confirm__icon sch-confirm__icon--${tone}`}
            aria-hidden="true"
          >
            <span className="material-symbols-outlined">
              {tone === "error"
                ? "error"
                : tone === "success"
                  ? "check_circle"
                  : "warning"}
            </span>
          </span>
          <h2 className="sch-confirm__title">{title}</h2>
        </div>

        <p className="sch-confirm__message">{message}</p>

        <div className="sch-confirm__actions">
          <button
            type="button"
            className={`sch-btn sch-confirm__confirm${tone === "error" ? " sch-confirm__confirm--danger" : ""}`}
            onClick={onClose}
          >
            {actionLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
