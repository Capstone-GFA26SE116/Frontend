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
    label: "Từ Google về",
    hint: "Lấy sự kiện Google trong khoảng để lưu vào METANOIA.",
    icon: "south",
  },
  {
    value: "ToGoogle",
    label: "Từ METANOIA lên",
    hint: "Đẩy các khung giờ đã duyệt lên Google Calendar của bạn.",
    icon: "north",
  },
  {
    value: "Both",
    label: "Cả hai chiều",
    hint: "Kéo sự kiện về trước, rồi đẩy khung giờ lên Google.",
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
  /** Gọi sync với các tuỳ chọn đã chọn. */
  onSubmit: (options: {
    from: string | null;
    to: string | null;
    direction: GoogleCalendarSyncDirection;
  }) => void;
  /** Đóng hộp thoại. */
  onClose: () => void;
}

/* ---------- Component ---------- */

export function GoogleCalendarSyncDialog({
  busy,
  serverError,
  needsReconnect = false,
  onReconnect,
  onSubmit,
  onClose,
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
    if (from && !DATE_RE.test(from)) return "Ngày bắt đầu phải có dạng YYYY-MM-DD.";
    if (to && !DATE_RE.test(to)) return "Ngày kết thúc phải có dạng YYYY-MM-DD.";
    if (from && to && DATE_RE.test(from) && DATE_RE.test(to) && to < from) {
      return "Ngày kết thúc phải sau hoặc bằng ngày bắt đầu.";
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
    if (from && to) return `Từ ${from} đến hết ngày ${to}`;
    if (from) return `Từ đầu ngày ${from} trở đi`;
    if (to) return `Đến hết ngày ${to}`;
    return "Toàn bộ thay đổi kể từ lần đồng bộ gần nhất";
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
        aria-label="Đồng bộ Google Calendar"
      >
        {/* ---------- Head ---------- */}
        <div className="gcs-head">
          <div className="gcs-head-icon">
            <span className="material-symbols-outlined">sync</span>
          </div>
          <div className="gcs-head-text">
            <p className="gcs-eyebrow">Google Calendar</p>
            <h2 className="gcs-title">Đồng bộ lịch</h2>
          </div>
          <button
            type="button"
            className="gcs-close"
            onClick={onClose}
            disabled={busy}
            aria-label="Đóng"
          >
            <span className="material-symbols-outlined">close</span>
          </button>
        </div>

        {/* ---------- Body ---------- */}
        <div className="gcs-body">
          {/* Hướng đồng bộ */}
          <p className="gcs-label">Chiều đồng bộ</p>
          <div className="gcs-directions" role="radiogroup" aria-label="Chiều đồng bộ">
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
                Chiều đẩy lên sẽ ghi vào lịch Google thật của bạn. Chỉ các
                khung giờ ở trạng thái <strong>Đã duyệt</strong>,{" "}
                <strong>Đến giờ</strong>, <strong>Đang làm</strong> hoặc{" "}
                <strong>Quá giờ</strong> mới được đẩy.
              </span>
            </p>
          )}

          {/* Khoảng ngày */}
          <p className="gcs-label">Khoảng ngày</p>
          <p className="gcs-hint">
            Để trống nếu bạn muốn đồng bộ như cũ — chỉ lấy phần thay đổi kể
            từ lần đồng bộ gần nhất.
          </p>
          <div className="gcs-dates">
            <label className="gcs-date">
              <span className="gcs-date-label">Từ ngày</span>
              <input
                type="date"
                className="gcs-input"
                value={from}
                onChange={(e) => setFrom(e.target.value)}
                disabled={busy}
              />
            </label>
            <label className="gcs-date">
              <span className="gcs-date-label">Đến ngày</span>
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
              <span className="gcs-summary-mode">Chế độ đầy đủ trong khoảng</span>
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
              Kết nối lại Google Calendar
            </button>
          )}
        </div>

        {/* ---------- Foot ---------- */}
        <div className="gcs-foot">
          <button
            type="button"
            className="gcs-btn gcs-btn--ghost"
            onClick={onClose}
            disabled={busy}
          >
            Huỷ
          </button>
          <button
            type="button"
            className="gcs-btn gcs-btn--primary"
            onClick={handleSubmit}
            disabled={!canSubmit}
          >
            {busy ? "Đang đồng bộ…" : "Đồng bộ"}
          </button>
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

  /** Nhóm số liệu phía kéo về (Google → METANOIA). */
  const pulled = [
    { label: "Mới", value: result.added },
    { label: "Cập nhật", value: result.updated },
    { label: "Huỷ", value: result.cancelled },
  ];

  /** Nhóm số liệu phía đẩy lên (METANOIA → Google). */
  const pushed = [
    { label: "Tạo mới", value: result.pushedCreated ?? 0 },
    { label: "Cập nhật", value: result.pushedUpdated ?? 0 },
    { label: "Xoá", value: result.pushedDeleted ?? 0 },
    { label: "Lỗi", value: pushFailed },
  ];

  return (
    <div className="gcs-result">
      <div className="gcs-result-group">
        <p className="gcs-result-title">Từ Google về</p>
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
        <p className="gcs-result-title">Từ METANOIA lên</p>
        <div className="gcs-result-stats">
          {pushed.map((s) => (
            <div
              key={s.label}
              className={`gcs-stat${s.label === "Lỗi" && s.value > 0 ? " gcs-stat--bad" : ""}`}
            >
              <span className="gcs-stat-value">{s.value}</span>
              <span className="gcs-stat-label">{s.label}</span>
            </div>
          ))}
        </div>
      </div>

      {pushFailed > 0 && (
        <p className="gcs-warn" role="alert">
          <span className="material-symbols-outlined">warning</span>
          <span>
            Một số slot chưa đồng bộ được, thử lại sau.
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
