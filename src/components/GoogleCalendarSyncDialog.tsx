import { useEffect, useMemo, useState } from "react";
import type {
  GoogleCalendarSyncDirection,
  GoogleCalendarSyncResultDto,
} from "../lib/api-client";
import "./google-calendar-sync.css";

/**
 * ===========================================================
 * <GoogleCalendarSyncDialog> — hộp thoại đồng bộ Google Calendar.
 * ===========================================================
 *
 * Theo spec `GOOGLE_CALENDAR_SYNC_FE.md`:
 *
 *  1. **Một API duy nhất** `POST /api/google-calendar/sync` với query:
 *     `from`, `to` (ngày `yyyy-MM-dd` theo múi giờ user), `direction`.
 *     - Chỉ chọn `from` → từ đầu ngày `from` đến hết về sau (không hạn trên).
 *     - Chỉ chọn `to`   → từ đầu đến hết ngày `to`.
 *     - Cả hai          → từ đầu ngày `from` đến hết ngày `to`.
 *     - Không chọn gì   → hành vi cũ (incremental theo `syncToken`).
 *
 *  2. **Hướng** phải hỏi rõ (spec mục 5):
 *     - `FromGoogle` (mặc định): Google → METANOIA.
 *     - `ToGoogle`: METANOIA → Google (ghi vào lịch Google của user!).
 *     - `Both`: kéo về trước, rồi đẩy lên.
 *
 *  3. **Kết quả** hiển thị cả 2 nhóm số liệu (kéo về + đẩy lên), và báo
 *     "Một số slot chưa đồng bộ được" nếu `pushFailed > 0`.
 *
 *  4. **Lỗi**:
 *     - 400 → chưa kết nối / `to` trước `from` / sai định dạng.
 *     - 409 `GOOGLE_RECONNECT_REQUIRED` → gợi ý kết nối lại.
 *     - 502 `GOOGLE_API_ERROR` → Google lỗi hoặc mất mạng.
 */

/* ---------- Hằng số ---------- */

/** `yyyy-MM-dd` — ngày theo múi giờ người dùng (BE tự quy đổi sang UTC). */
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Hướng đồng bộ — nhãn + mô tả cho UI. */
const DIRECTION_OPTIONS: Array<{
  value: GoogleCalendarSyncDirection;
  label: string;
  hint: string;
  icon: string;
}> = [
  {
    value: "FromGoogle",
    label: "From Google",
    hint: "Pull Google events in the range and save them to METANOIA.",
    icon: "south",
  },
  {
    value: "ToGoogle",
    label: "To Google",
    hint: "Push your approved time blocks up to your Google Calendar.",
    icon: "north",
  },
  {
    value: "Both",
    label: "Both ways",
    hint: "Pull events in first, then push your time blocks up to Google.",
    icon: "swap_vert",
  },
];

/* ---------- Props ---------- */

export interface GoogleCalendarSyncDialogProps {
  /** true khi đang gọi API. */
  busy: boolean;
  /** Lỗi 400 từ server (VD: `to` trước `from`). */
  serverError?: string | null;
  /**
   * Hiển thị nút "Kết nối lại Google" (khi BE trả 409
   * `GOOGLE_RECONNECT_REQUIRED` — token hết hạn/bị thu hồi).
   */
  needsReconnect?: boolean;
  /** Bấm "Kết nối lại" → bắt đầu lại OAuth. */
  onReconnect?: () => void;
  /**
   * Kết quả sync vừa rồi.
   *
   * Khi có giá trị → dialog chuyển sang chế độ **xem kết quả**: hiển thị số
   * liệu kéo về + đẩy lên, kèm `pushErrors` (spec mục 3: tối đa 5 dòng lỗi
   * đầu tiên) để user biết chính xác slot nào lỗi và vì sao.
   */
  result?: GoogleCalendarSyncResultDto | null;
  /** Gọi sync với các tuỳ chọn đã chọn. */
  onSubmit: (options: {
    from: string | null;
    to: string | null;
    direction: GoogleCalendarSyncDirection;
  }) => void;
  /** Đóng hộp thoại. */
  onClose: () => void;
  /** Đóng hộp thoại & quay lại form chọn hướng (từ chế độ kết quả). */
  onBack?: () => void;
}

/* ---------- Component ---------- */

export function GoogleCalendarSyncDialog({
  busy,
  serverError,
  needsReconnect = false,
  onReconnect,
  result = null,
  onSubmit,
  onClose,
  onBack,
}: GoogleCalendarSyncDialogProps) {
  /**
   * Hướng đồng bộ — mặc định `FromGoogle`.
   *
   * ⚠️ Spec mục 5: *"Mặc định `FromGoogle`, đừng tự gửi `ToGoogle`/`Both`
   * khi người dùng chưa chọn: chiều đẩy lên ghi vào lịch Google của họ."*
   */
  const [direction, setDirection] = useState<GoogleCalendarSyncDirection>(
    "FromGoogle",
  );
  /** Ngày bắt đầu (để trống được). */
  const [from, setFrom] = useState("");
  /** Ngày kết thúc (để trống được). */
  const [to, setTo] = useState("");

  /** Đóng bằng Escape (trừ khi đang bận). */
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape" && !busy) onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [busy, onClose]);

  /**
   * Kiểm tra ngày trước khi gửi.
   *
   * - Sai định dạng → "Ngày phải có dạng YYYY-MM-DD."
   * - `to` trước `from` → BE trả 400, ta chặn trước cho UX tốt.
   */
  const dateError = useMemo(() => {
    if (from && !DATE_RE.test(from)) return "The start date must be in YYYY-MM-DD format.";
    if (to && !DATE_RE.test(to)) return "The end date must be in YYYY-MM-DD format.";
    if (from && to && DATE_RE.test(from) && DATE_RE.test(to) && to < from) {
      return "The end date must be on or after the start date.";
    }
    return null;
  }, [from, to]);

  const canSubmit = !busy && !dateError;

  function handleSubmit() {
    if (!canSubmit) return;
    onSubmit({
      // Rỗng → null → không gửi param (BE coi như không giới hạn phía đó).
      from: from.trim() || null,
      to: to.trim() || null,
      direction,
    });
  }

  /** Mô tả khoảng ngày đang chọn (để user thấy rõ mình đang đồng bộ gì). */
  const rangeLabel = useMemo(() => {
    if (from && to) return `From ${from} to the end of ${to}`;
    if (from) return `From the start of ${from} onwards`;
    if (to) return `Up to the end of ${to}`;
    return "All changes since the last sync";
  }, [from, to]);

  const isRange = !!(from || to);

  return (
    <div
      className="gcs-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !busy) onClose();
      }}
    >
      <div
        className="gcs-panel"
        role="dialog"
        aria-modal="true"
        aria-label="Sync Google Calendar"
      >
        {/* ---------- Head ---------- */}
        <div className="gcs-head">
          <div className="gcs-head-icon">
            <span className="material-symbols-outlined">sync</span>
          </div>
          <div className="gcs-head-text">
            <p className="gcs-eyebrow">Google Calendar</p>
            <h2 className="gcs-title">Sync calendar</h2>
          </div>
          <button
            type="button"
            className="gcs-close"
            onClick={onClose}
            disabled={busy}
            aria-label="Close"
          >
            <span className="material-symbols-outlined">close</span>
          </button>
        </div>

        {/* ---------- Body ---------- */}
        <div className="gcs-body">
          {/* Chế độ xem kết quả (sau khi sync xong) */}
          {result ? (
            <>
              <GoogleCalendarSyncResult result={result} />
              {onBack && (
                <button
                  type="button"
                  className="gcs-btn gcs-btn--ghost gcs-btn--full"
                  onClick={onBack}
                  disabled={busy}
                >
                  <span className="material-symbols-outlined gcs-icon-14">
                    tune
                  </span>
                  Change direction / date range
                </button>
              )}
            </>
          ) : (
            <>
          {/* Hướng đồng bộ */}
          <p className="gcs-label">Sync direction</p>
          <div className="gcs-directions" role="radiogroup" aria-label="Sync direction">
            {DIRECTION_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                type="button"
                role="radio"
                aria-checked={direction === opt.value}
                className={`gcs-dir${direction === opt.value ? " gcs-dir--on" : ""}`}
                onClick={() => setDirection(opt.value)}
                disabled={busy}
              >
                <span className="gcs-dir-icon" aria-hidden="true">
                  <span className="material-symbols-outlined">{opt.icon}</span>
                </span>
                <span className="gcs-dir-text">
                  <span className="gcs-dir-label">{opt.label}</span>
                  <span className="gcs-dir-hint">{opt.hint}</span>
                </span>
                <span className="gcs-dir-dot" aria-hidden="true" />
              </button>
            ))}
          </div>

          {/* Cảnh báo chiều đẩy lên ghi vào lịch Google thật */}
          {direction !== "FromGoogle" && (
            <p className="gcs-note">
              <span className="material-symbols-outlined">info</span>
              <span>
                Pushing up writes to your real Google Calendar. Only blocks in{" "}
                <strong>Approved</strong>, <strong>Due</strong>,{" "}
                <strong>In Progress</strong> or <strong>Overrun</strong> status
                can be pushed.
              </span>
            </p>
          )}

          {/* Khoảng ngày */}
          <p className="gcs-label">Date range</p>
          <p className="gcs-hint">
            Leave blank to sync as before — only pulling the changes since your
            last sync.
          </p>
          <div className="gcs-dates">
            <label className="gcs-date">
              <span className="gcs-date-label">From</span>
              <input
                type="date"
                className="gcs-input"
                value={from}
                onChange={(e) => setFrom(e.target.value)}
                disabled={busy}
              />
            </label>
            <label className="gcs-date">
              <span className="gcs-date-label">To</span>
              <input
                type="date"
                className="gcs-input"
                value={to}
                onChange={(e) => setTo(e.target.value)}
                disabled={busy}
              />
            </label>
          </div>

          {/* Tóm tắt khoảng */}
          <p className="gcs-summary">
            <span className="material-symbols-outlined gcs-icon-14">
              calendar_month
            </span>
            <span>{rangeLabel}</span>
            {isRange && (
              <span className="gcs-summary-mode">Full range mode</span>
            )}
          </p>

          {/* Lỗi */}
          {dateError && (
            <p className="gcs-error" role="alert">
              <span className="material-symbols-outlined">error</span>
              {dateError}
            </p>
          )}
          {serverError && (
            <p className="gcs-error" role="alert">
              <span className="material-symbols-outlined">error</span>
              {serverError}
            </p>
          )}

          {/* Kết nối hết hạn → gợi ý kết nối lại Google (spec mục 4) */}
          {needsReconnect && (
            <button
              type="button"
              className="gcs-btn gcs-btn--ghost gcs-btn--full"
              onClick={() => onReconnect?.()}
              disabled={busy}
            >
              <span className="material-symbols-outlined gcs-icon-14">link</span>
              Reconnect Google Calendar
            </button>
          )}
            </>
          )}
        </div>

        {/* ---------- Foot ---------- */}
        <div className="gcs-foot">
          {result ? (
            <button
              type="button"
              className="gcs-btn gcs-btn--primary"
              onClick={onClose}
              disabled={busy}
            >
              Close
            </button>
          ) : (
            <>
              <button
                type="button"
                className="gcs-btn gcs-btn--ghost"
                onClick={onClose}
                disabled={busy}
              >
                Cancel
              </button>
              <button
                type="button"
                className="gcs-btn gcs-btn--primary"
                onClick={handleSubmit}
                disabled={!canSubmit}
              >
                {busy ? "Syncing…" : "Sync"}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/* ===========================================================
 * Kết quả đồng bộ — hiển thị sau khi sync thành công.
 * ===========================================================
 */

/**
 * Bảng tóm tắt kết quả (kéo về + đẩy lên).
 *
 * Spec mục 3:
 *   - `added`, `updated`, `cancelled`: phía kéo về.
 *   - `pushedCreated`, `pushedUpdated`, `pushedDeleted`, `pushFailed`: phía đẩy lên.
 *   - `pushErrors`: tối đa 5 dòng lỗi đầu tiên.
 *   - Có `pushFailed > 0` → báo "Một số slot chưa đồng bộ được, thử lại sau".
 */
export function GoogleCalendarSyncResult({
  result,
}: {
  result: GoogleCalendarSyncResultDto;
}) {
  const pushFailed = result.pushFailed ?? 0;
  const pushErrors = result.pushErrors ?? [];
  const pushedCreated = result.pushedCreated ?? 0;
  const pushedUpdated = result.pushedUpdated ?? 0;
  const pushedDeleted = result.pushedDeleted ?? 0;

  /** Nhóm số liệu phía kéo về (Google → METANOIA). */
  const pulled = [
    { label: "Added", value: result.added },
    { label: "Updated", value: result.updated },
    { label: "Cancelled", value: result.cancelled },
  ];

  /** Nhóm số liệu phía đẩy lên (METANOIA → Google). */
  const pushed = [
    { label: "Created", value: pushedCreated },
    { label: "Updated", value: pushedUpdated },
    { label: "Deleted", value: pushedDeleted },
    { label: "Errors", value: pushFailed },
  ];

  /**
   * Chiều đồng bộ thực tế BE đã dùng.
   *
   * Nếu khác `FromGoogle` mà **không có slot nào được đẩy lên** và cũng
   * không lỗi → gần như chắc chắn là do các slot trong khoảng đều ở trạng
   * thái không đủ điều kiện (`Proposed`, `Done`, `Skipped`...). Theo spec
   * mục 2 chỉ `Approved`, `Due`, `InProgress`, `Overrun` mới được đẩy.
   */
  const pushedNothing =
    (result.direction === "ToGoogle" || result.direction === "Both") &&
    pushedCreated === 0 &&
    pushedUpdated === 0 &&
    pushedDeleted === 0 &&
    pushFailed === 0;

  /** Nhãn khoảng thực tế BE đã dùng (UTC → hiển thị). */
  const rangeText = (() => {
    const from = result.rangeFromUtc
      ? new Date(result.rangeFromUtc).toLocaleString()
      : null;
    const to = result.rangeToUtc
      ? new Date(result.rangeToUtc).toLocaleString()
      : null;
    if (from && to) return `${from} → ${to}`;
    if (from) return `from ${from}`;
    if (to) return `to ${to}`;
    return null;
  })();

  return (
    <div className="gcs-result">
      {/* Metadata: chiều + chế độ + khoảng thực tế */}
      <div className="gcs-result-meta">
        {result.direction && (
          <span className="gcs-meta-chip">
            {result.direction === "FromGoogle"
              ? "From Google"
              : result.direction === "ToGoogle"
                ? "To Google"
                : "Both ways"}
          </span>
        )}
        {result.mode && (
          <span className="gcs-meta-chip">
            {result.mode === "Range" ? "By date range" : "Changes only"}
          </span>
        )}
        {rangeText && <span className="gcs-meta-chip gcs-meta-chip--muted">{rangeText}</span>}
      </div>

      <div className="gcs-result-group">
        <p className="gcs-result-title">From Google</p>
        <div className="gcs-result-stats">
          {pulled.map((s) => (
            <div key={s.label} className="gcs-stat">
              <span className="gcs-stat-value">{s.value}</span>
              <span className="gcs-stat-label">{s.label}</span>
            </div>
          ))}
        </div>
      </div>

      <div className="gcs-result-group">
        <p className="gcs-result-title">To Google</p>
        <div className="gcs-result-stats">
          {pushed.map((s) => (
            <div
              key={s.label}
              className={`gcs-stat${s.label === "Errors" && s.value > 0 ? " gcs-stat--bad" : ""}`}
            >
              <span className="gcs-stat-value">{s.value}</span>
              <span className="gcs-stat-label">{s.label}</span>
            </div>
          ))}
        </div>
      </div>

      {/* Đẩy lên nhưng không có gì được đẩy → giải thích lý do */}
      {pushedNothing && (
        <p className="gcs-note">
          <span className="material-symbols-outlined">info</span>
          <span>
            No time blocks were pushed. Only blocks in{" "}
            <strong>Approved</strong>, <strong>Due</strong>,{" "}
            <strong>In Progress</strong> or <strong>Overrun</strong> status can
            be pushed — blocks still <strong>Pending approval</strong> are
            skipped.
          </span>
        </p>
      )}

      {pushFailed > 0 && (
        <p className="gcs-warn" role="alert">
          <span className="material-symbols-outlined">warning</span>
          <span>
            Some slots couldn't be synced. Please try again later.
            {pushErrors.length > 0 && (
              <span className="gcs-warn-list">
                {pushErrors.map((err, i) => (
                  <span key={i} className="gcs-warn-item">
                    {err}
                  </span>
                ))}
              </span>
            )}
          </span>
        </p>
      )}
    </div>
  );
}
