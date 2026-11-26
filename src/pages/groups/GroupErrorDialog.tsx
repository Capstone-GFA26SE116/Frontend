/**
 * ===========================================================
 * Hộp thoại báo lỗi dùng chung cho nhánh Group.
 * ===========================================================
 *
 * Thay cho toast 3.2s: lỗi cần người dùng đọc và hiểu, nên dùng modal
 * có nút "Close" rõ ràng + dòng gợi ý hành động.
 *
 * Thiết kế theo `DESIGN.md`:
 *  - canvas #101010, hairline #3d3a39, primary #00d992
 *  - card radius 8px, button radius 6px, pill 9999px
 */

import { useEffect, useRef } from "react";
import {
  type GroupErrorDetails,
  type GroupErrorView,
} from "./group-errors";
import "./group-error.css";

const TONE_ICON: Record<GroupErrorView["tone"], string> = {
  error: "error",
  warning: "warning",
  info: "info",
};

export interface GroupErrorDialogProps {
  /** Thông điệp đã dịch sang tiếng Anh. */
  error: GroupErrorView | null;
  /** Danh sách chi tiết (việc còn dở, khoảng bận...). */
  details?: GroupErrorDetails | null;
  /** Thông điệp thô của BE — hiển thị ở dòng "Server details" nhỏ. */
  rawMessage?: string;
  onClose: () => void;
  /** Nhãn nút chính (mặc định "Close"). */
  confirmLabel?: string;
  /** Nút phụ, ví dụ "Retry". */
  onSecondary?: () => void;
  secondaryLabel?: string;
}

/**
 * Modal báo lỗi. Bấm backdrop hoặc nút X để đóng; Escape cũng đóng.
 */
export function GroupErrorDialog({
  error,
  details,
  rawMessage,
  onClose,
  confirmLabel = "Close",
  onSecondary,
  secondaryLabel,
}: GroupErrorDialogProps) {
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

  const lines = details?.lines ?? [];
  const items = details?.items ?? [];

  return (
    <div className="gerr-backdrop" onClick={onClose} role="presentation">
      <div
        className="gerr-modal"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="gerr-title"
        aria-describedby="gerr-message"
        onClick={(e) => e.stopPropagation()}
      >
        {/* ---------- Đầu ---------- */}
        <div className="gerr-head">
          <span className={`gerr-icon gerr-icon--${error.tone}`} aria-hidden="true">
            <span className="material-symbols-outlined">
              {TONE_ICON[error.tone]}
            </span>
          </span>
          <h2 id="gerr-title" className="gerr-title">
            {error.title}
          </h2>
          <button
            type="button"
            className="gerr-close"
            onClick={onClose}
            aria-label="Close"
          >
            <span className="material-symbols-outlined">close</span>
          </button>
        </div>

        {/* ---------- Thân ---------- */}
        <div className="gerr-body">
          <p id="gerr-message" className="gerr-message">
            {error.message}
          </p>

          {error.hint && (
            <div className="gerr-hint">
              <span className="material-symbols-outlined" aria-hidden="true">
                lightbulb
              </span>
              <span>{error.hint}</span>
            </div>
          )}

          {lines.length > 0 && (
            <dl className="gerr-facts">
              {lines.map((l, i) => (
                <div key={i} className="gerr-fact">
                  <dt className="gerr-fact-label">{l.label}</dt>
                  <dd className="gerr-fact-value">{l.value}</dd>
                </div>
              ))}
            </dl>
          )}

          {items.length > 0 && (
            <div className="gerr-section">
              <h3 className="gerr-subtitle">
                {error.code === "GROUP_ASSIGNEE_BUSY"
                  ? "Conflicting time slots"
                  : error.code === "SLOT_OVERLAP"
                    ? "Time slots that are already booked"
                    : "Tasks that are still open"}
              </h3>
              <ul className="gerr-list">
                {items.map((it, i) => (
                  <li key={i} className="gerr-list-item">
                    <span className="gerr-list-title">{it.title}</span>
                    {it.meta && <span className="gerr-list-meta">{it.meta}</span>}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {rawMessage && rawMessage !== error.message && (
            <details className="gerr-raw">
              <summary className="gerr-raw-summary">Server details</summary>
              <p className="gerr-raw-text">{rawMessage}</p>
              {error.code && (
                <p className="gerr-raw-code">
                  Code: <code>{error.code}</code>
                  {error.status ? ` · HTTP ${error.status}` : ""}
                </p>
              )}
            </details>
          )}
        </div>

        {/* ---------- Chân ---------- */}
        <div className="gerr-actions">
          {onSecondary && secondaryLabel && (
            <button
              type="button"
              className="gerr-btn gerr-btn--ghost"
              onClick={onSecondary}
            >
              {secondaryLabel}
            </button>
          )}
          <button
            type="button"
            className="gerr-btn gerr-btn--primary"
            onClick={onClose}
            ref={closeRef}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
