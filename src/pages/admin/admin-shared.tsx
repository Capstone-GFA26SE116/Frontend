import { useEffect } from "react";
import type { ReactNode } from "react";
import type { AdminToastState } from "./admin-constants";

/**
 * Component dùng chung cho khu vực quản trị.
 *
 * Prefix class: `.adm-*` — tuân thủ `DESIGN.md`:
 *   - nền canvas #101010, card #101010 + viền hairline 1px #3d3a39
 *   - accent duy nhất: electric green #00d992 (chỉ cho CTA / trạng thái live)
 *   - số liệu dùng SF Mono, chữ kể chuyện dùng Inter
 *   - bo góc: button/input 6px, card 8px, pill 9999px
 */

/* ================================================================
 * Toast — báo kết quả thao tác
 * ================================================================ */

export function AdminToast({
  toast,
  onClose,
}: {
  toast: AdminToastState;
  onClose: () => void;
}) {
  useEffect(() => {
    if (!toast.visible) return;
    const t = window.setTimeout(onClose, 4200);
    return () => window.clearTimeout(t);
  }, [toast.visible, onClose]);

  if (!toast.visible) return null;

  const icon =
    toast.tone === "success"
      ? "check_circle"
      : toast.tone === "error"
        ? "error"
        : "info";

  return (
    <div
      className={`adm-toast adm-toast--${toast.tone}`}
      role="status"
      aria-live="polite"
    >
      <span className="material-symbols-outlined adm-toast__icon" aria-hidden="true">
        {icon}
      </span>
      <span className="adm-toast__msg">{toast.message}</span>
      <button
        type="button"
        className="adm-toast__close"
        onClick={onClose}
        aria-label="Đóng thông báo"
      >
        <span className="material-symbols-outlined" aria-hidden="true">close</span>
      </button>
    </div>
  );
}

/* ================================================================
 * Modal — Level 3 elevation theo DESIGN.md
 * ================================================================ */

export function AdminModal({
  open,
  title,
  eyebrow,
  onClose,
  children,
  footer,
  wide = false,
}: {
  open: boolean;
  title: string;
  eyebrow?: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
}) {
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className="adm-modal-backdrop"
      role="presentation"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className={`adm-modal${wide ? " adm-modal--wide" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <div className="adm-modal__head">
          <div>
            {eyebrow && <span className="adm-eyebrow">{eyebrow}</span>}
            <h2 className="adm-modal__title">{title}</h2>
          </div>
          <button
            type="button"
            className="adm-icon-btn"
            onClick={onClose}
            aria-label="Đóng"
          >
            <span className="material-symbols-outlined" aria-hidden="true">close</span>
          </button>
        </div>
        <div className="adm-modal__body">{children}</div>
        {footer && <div className="adm-modal__foot">{footer}</div>}
      </div>
    </div>
  );
}

/* ================================================================
 * Reason required — hộp nhập lý do BẮT BUỘC cho thao tác ghi
 * ================================================================ */

export function AdminReasonField({
  value,
  onChange,
  required = true,
  placeholder = "Ví dụ: Điều chỉnh giá gói theo bảng giá Q4",
  error,
  id = "adm-reason",
}: {
  value: string;
  onChange: (v: string) => void;
  required?: boolean;
  placeholder?: string;
  error?: string;
  id?: string;
}) {
  const trimmed = value.trim();
  return (
    <div className="adm-field adm-field--reason">
      <label className="adm-label" htmlFor={id}>
        Lý do thao tác
        {required && <span className="adm-req"> *bắt buộc*</span>}
      </label>
      <textarea
        id={id}
        className={`adm-textarea${error ? " adm-input--error" : ""}`}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        rows={3}
        maxLength={1000}
        aria-invalid={error ? true : undefined}
        aria-describedby={`${id}-hint`}
      />
      <div className="adm-field__meta" id={`${id}-hint`}>
        <span className={error ? "adm-field__error" : "adm-field__hint"}>
          {error ??
            "Lý do được ghi vào nhật ký Admin (tối đa 1000 ký tự). Gửi kèm header X-Admin-Reason."}
        </span>
        <span className="adm-field__count">{trimmed.length}/1000</span>
      </div>
    </div>
  );
}

/* ================================================================
 * Confirm dialog — dùng chung cho các thao tác phá huỷ/khoá
 * ================================================================ */

export function AdminConfirmDialog({
  open,
  title,
  eyebrow,
  message,
  confirmLabel = "Xác nhận",
  danger = false,
  busy = false,
  reasonRequired = false,
  reason = "",
  onReasonChange,
  onConfirm,
  onClose,
}: {
  open: boolean;
  title: string;
  eyebrow?: string;
  message: ReactNode;
  confirmLabel?: string;
  danger?: boolean;
  busy?: boolean;
  reasonRequired?: boolean;
  reason?: string;
  onReasonChange?: (v: string) => void;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const reasonInvalid = reasonRequired && !reason.trim();

  return (
    <AdminModal
      open={open}
      title={title}
      eyebrow={eyebrow}
      onClose={busy ? () => undefined : onClose}
      footer={
        <>
          <button
            type="button"
            className="adm-btn adm-btn--outline"
            onClick={onClose}
            disabled={busy}
          >
            Huỷ
          </button>
          <button
            type="button"
            className={`adm-btn ${danger ? "adm-btn--danger" : "adm-btn--primary"}`}
            onClick={onConfirm}
            disabled={busy || reasonInvalid}
          >
            {busy && (
              <span
                className="material-symbols-outlined adm-spin"
                aria-hidden="true"
              >
                progress_activity
              </span>
            )}
            {confirmLabel}
          </button>
        </>
      }
    >
      <div className="adm-confirm__msg">{message}</div>
      {reasonRequired && onReasonChange && (
        <AdminReasonField value={reason} onChange={onReasonChange} id="adm-confirm-reason" />
      )}
    </AdminModal>
  );
}

/* ================================================================
 * Trạng thái rỗng / loading / lỗi
 * ================================================================ */

export function AdminEmptyState({
  icon = "inbox",
  title,
  hint,
  action,
}: {
  icon?: string;
  title: string;
  hint?: string;
  action?: ReactNode;
}) {
  return (
    <div className="adm-empty">
      <span className="material-symbols-outlined adm-empty__icon" aria-hidden="true">
        {icon}
      </span>
      <p className="adm-empty__title">{title}</p>
      {hint && <p className="adm-empty__hint">{hint}</p>}
      {action}
    </div>
  );
}

export function AdminLoading({ label = "Đang tải dữ liệu…" }: { label?: string }) {
  return (
    <div className="adm-loading" role="status">
      <span className="material-symbols-outlined adm-spin" aria-hidden="true">
        progress_activity
      </span>
      <span>{label}</span>
    </div>
  );
}

export function AdminErrorState({
  message,
  onRetry,
}: {
  message: string;
  onRetry?: () => void;
}) {
  return (
    <div className="adm-error-state" role="alert">
      <span className="material-symbols-outlined" aria-hidden="true">error</span>
      <p>{message}</p>
      {onRetry && (
        <button type="button" className="adm-btn adm-btn--outline" onClick={onRetry}>
          Thử lại
        </button>
      )}
    </div>
  );
}

/* ================================================================
 * Phân trang
 * ================================================================ */

export function AdminPagination({
  page,
  pageSize,
  totalCount,
  onPageChange,
}: {
  page: number;
  pageSize: number;
  totalCount: number;
  onPageChange: (p: number) => void;
}) {
  const totalPages = Math.max(1, Math.ceil(totalCount / Math.max(1, pageSize)));
  if (totalCount === 0) return null;

  const from = (page - 1) * pageSize + 1;
  const to = Math.min(page * pageSize, totalCount);

  return (
    <div className="adm-pagination">
      <span className="adm-pagination__info">
        <span className="adm-mono">{from}</span>–<span className="adm-mono">{to}</span>{" "}
        / <span className="adm-mono">{totalCount}</span>
      </span>
      <div className="adm-pagination__controls">
        <button
          type="button"
          className="adm-btn adm-btn--outline adm-btn--sm"
          onClick={() => onPageChange(page - 1)}
          disabled={page <= 1}
        >
          <span className="material-symbols-outlined" aria-hidden="true">
            chevron_left
          </span>
          Trước
        </button>
        <span className="adm-pagination__page adm-mono">
          {page} / {totalPages}
        </span>
        <button
          type="button"
          className="adm-btn adm-btn--outline adm-btn--sm"
          onClick={() => onPageChange(page + 1)}
          disabled={page >= totalPages}
        >
          Sau
          <span className="material-symbols-outlined" aria-hidden="true">
            chevron_right
          </span>
        </button>
      </div>
    </div>
  );
}

/* ================================================================
 * Pill trạng thái
 * ================================================================ */

export function AdminPill({
  tone = "neutral",
  children,
}: {
  tone?: "neutral" | "success" | "warn" | "danger" | "accent";
  children: ReactNode;
}) {
  return <span className={`adm-pill adm-pill--${tone}`}>{children}</span>;
}
