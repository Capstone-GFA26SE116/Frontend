/**
 * ===========================================================
 * Hộp thoại báo lỗi — Project Detail.
 * ===========================================================
 *
 * Thay cho toast 3.2s: lỗi cần người dùng đọc và hiểu, nên dùng modal
 * có nút "Close" rõ ràng + dòng gợi ý hành động.
 *
 * Thiết kế theo `DESIGN.md`:
 *  - canvas #101010, hairline #3d3a39, primary #00d992
 *  - card radius 8px, button radius 6px
 */

import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import type { ProjectErrorView } from "./project-errors";
import "./project-error.css";

const TONE_ICON: Record<ProjectErrorView["tone"], string> = {
  error: "error",
  warning: "warning",
  info: "info",
};

export interface ProjectErrorDialogProps {
  /** Thông điệp đã dịch sang tiếng Anh. */
  error: ProjectErrorView | null;
  /** Danh sách mục chi tiết (VD: các task còn dở). */
  items?: { title: string; meta?: string }[];
  /** Tiêu đề nhóm danh sách chi tiết. */
  itemsTitle?: string;
  /** Thông điệp thô của BE — hiển thị ở dòng "Server details" nhỏ. */
  rawMessage?: string;
  onClose: () => void;
  /** Nhãn nút chính (mặc định "Close"). */
  confirmLabel?: string;
  /** Nút phụ, ví dụ "Retry". */
  onSecondary?: () => void;
  secondaryLabel?: string;
  /** Nhãn nút chính khi là hành động nguy hiểm (VD: "Deliver anyway"). */
  confirmDanger?: boolean;
  /**
   * Hành động của nút chính. Mặc định = đóng hộp thoại.
   * Khi có (VD: "Deliver anyway") nút chính gọi hành động này thay vì đóng.
   */
  onConfirm?: () => void;
}

/**
 * Modal báo lỗi. Bấm backdrop hoặc nút X để đóng; Escape cũng đóng.
 */
export function ProjectErrorDialog({
  error,
  items,
  itemsTitle,
  rawMessage,
  onClose,
  confirmLabel = "Close",
  onSecondary,
  secondaryLabel,
  confirmDanger = false,
  onConfirm,
}: ProjectErrorDialogProps) {
  const closeRef = useRef<HTMLButtonElement>(null);

  // Đóng bằng Escape + đưa focus vào nút chính khi mở.
  useEffect(() => {
    if (!error) return;
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [error, onClose]);

  if (!error) return null;

  const list = items ?? [];

  return createPortal(
    <div className="perr-backdrop" onClick={onClose} role="presentation">
      <div
        className="perr-modal"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="perr-title"
        aria-describedby="perr-message"
        onClick={(e) => e.stopPropagation()}
      >
        {/* ---------- Đầu ---------- */}
        <div className="perr-head">
          <span
            className={`perr-icon perr-icon--${error.tone}`}
            aria-hidden="true"
          >
            <span className="material-symbols-outlined">
              {TONE_ICON[error.tone]}
            </span>
          </span>
          <h2 id="perr-title" className="perr-title">
            {error.title}
          </h2>
          <button
            type="button"
            className="perr-close"
            onClick={onClose}
            aria-label="Close"
          >
            <span className="material-symbols-outlined">close</span>
          </button>
        </div>

        {/* ---------- Thân ---------- */}
        <div className="perr-body">
          <p id="perr-message" className="perr-message">
            {error.message}
          </p>

          {error.hint && (
            <div className="perr-hint">
              <span className="material-symbols-outlined" aria-hidden="true">
                lightbulb
              </span>
              <span>{error.hint}</span>
            </div>
          )}

          {list.length > 0 && (
            <div className="perr-section">
              {itemsTitle && <h3 className="perr-subtitle">{itemsTitle}</h3>}
              <ul className="perr-list">
                {list.map((it, i) => (
                  <li key={i} className="perr-list-item">
                    <span className="perr-list-title">{it.title}</span>
                    {it.meta && <span className="perr-list-meta">{it.meta}</span>}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {rawMessage && rawMessage !== error.message && (
            <details className="perr-raw">
              <summary className="perr-raw-summary">Server details</summary>
              <p className="perr-raw-text">{rawMessage}</p>
              {error.code && (
                <p className="perr-raw-code">
                  Code: <code>{error.code}</code>
                  {error.status ? ` · HTTP ${error.status}` : ""}
                </p>
              )}
            </details>
          )}
        </div>

        {/* ---------- Chân ---------- */}
        <div className="perr-actions">
          {onSecondary && secondaryLabel && (
            <button
              type="button"
              className="perr-btn perr-btn--ghost"
              onClick={onSecondary}
            >
              {secondaryLabel}
            </button>
          )}
          <button
            type="button"
            className={
              confirmDanger
                ? "perr-btn perr-btn--danger"
                : "perr-btn perr-btn--primary"
            }
            onClick={onConfirm ?? onClose}
            ref={closeRef}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
