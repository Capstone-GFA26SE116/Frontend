import { useEffect, useState } from "react";
import {
  reportOverrun,
  updateScheduleSlot,
  type OverrunResponse,
} from "../../lib/api-client";
import { describeSlotOverlapError } from "../schedule/slot-overlap";
import { CenterToasts, useCenterToast } from "../Toast";
import "./overrun-dialog.css";

/**
 * ===========================================================
 * <OverrunDialog> — "Chưa xong, cần thêm X phút"
 * ===========================================================
 *
 * Theo spec BE (API AI cho màn hình, bước 8):
 *
 *   `POST /schedule/overrun` {slot_id, extra_minutes (5–480), language}
 *     → {kind, extended, moves[], not_placed[], past_day_end, summary}
 *
 * AI **chỉ tính** cách kéo dài / dời slot — không ghi vào DB. User đồng ý
 * thì FE gọi Backend `PUT /api/schedule-slots/{id}` cho từng slot trong
 * `moves` (đặt `isManualOverride = true` vì đây là thay đổi thủ công).
 *
 * Không có API để apply cho slot chính (khi `extended = true` nghĩa là
 * kéo dài slot đang chạy) → slot đó được Backend ghi khi focus stop,
 * nên ta chỉ apply các slot trong `moves`.
 */

export interface OverrunDialogProps {
  /** Slot đang chạy (null = đóng dialog). */
  slotId: string | null;
  /** Tên task — hiện cho context. */
  taskTitle?: string | null;
  /** Số phút dự kiến của slot (để gợi ý mặc định). */
  plannedMinutes?: number | null;
  onClose: () => void;
  /** Gọi sau khi apply thành công → refetch lịch. */
  onApplied?: () => void;
}

/** Mốc thêm phút gợi ý: bội số của 15 trong khoảng 15–120. */
const QUICK_MINUTES = [15, 30, 45, 60, 90, 120];

export function OverrunDialog({
  slotId,
  taskTitle,
  plannedMinutes,
  onClose,
  onApplied,
}: OverrunDialogProps) {
  const [extraMinutes, setExtraMinutes] = useState(30);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<OverrunResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [applying, setApplying] = useState(false);
  const [toasts, toast] = useCenterToast();
  const toastDismiss = toast.dismiss;

  // Escape để đóng (trừ khi đang gọi API).
  useEffect(() => {
    if (!slotId) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !loading && !applying) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [slotId, loading, applying, onClose]);

  if (!slotId) return null;

  /** Bước 1: hỏi AI xem nên kéo dài hay dời. */
  async function handleAsk() {
    setLoading(true);
    setError(null);
    const res = await reportOverrun({
      slot_id: slotId!,
      extra_minutes: extraMinutes,
      language: "en",
    });
    setLoading(false);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    setResult(res.data);
  }

  /** Bước 2: user đồng ý → ghi các slot bị dời qua Backend. */
  async function handleApply() {
    if (!result) return;
    const moves = result.moves ?? [];
    if (moves.length === 0) {
      // Không có slot nào bị dời (chỉ kéo dài chính slot này) → coi như xong.
      toast.success(
        "Recorded",
        result.summary ?? "Slot duration updated.",
      );
      onApplied?.();
      onClose();
      return;
    }
    setApplying(true);
    setError(null);
    let failed = 0;
    /** Message chồng giờ đầu tiên (BE trả 409 `SLOT_OVERLAP`). */
    let firstOverlapMsg: string | null = null;
    for (const mv of moves) {
      const res = await updateScheduleSlot(mv.slot_id, {
        startTime: mv.new_start,
        endTime: mv.new_end,
        isManualOverride: true,
        explanation: mv.explanation ?? "Extended due to overrun",
      });
      if (!res.ok) {
        failed += 1;
        /*
         * ⚠️ `409 SLOT_OVERLAP` — giờ mới chồng lên slot đang chiếm giờ.
         * Spec: `FE_CHANGES.md` mục 3.2.
         */
        if (!firstOverlapMsg) {
          firstOverlapMsg = describeSlotOverlapError(res) ?? res.error;
        }
      }
    }
    setApplying(false);
    if (failed > 0) {
      toast.error(
        firstOverlapMsg ? "Time slot overlaps" : "Update incomplete",
        firstOverlapMsg ??
          `${failed}/${moves.length} time slots couldn't be updated.`,
      );
    } else {
      toast.success(
        "Schedule updated",
        `${moves.length} time slots were moved.`,
      );
    }
    onApplied?.();
    onClose();
  }

  return (
    <div
      className="ov-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !loading && !applying) onClose();
      }}
    >
      <div
        className="ov-panel"
        role="dialog"
        aria-modal="true"
        aria-label="Need more time"
      >
        <div className="ov-head">
          <div className="ov-head-icon">
            <span className="material-symbols-outlined">more_time</span>
          </div>
          <div className="ov-head-text">
            <p className="ov-eyebrow">Not finished</p>
            <h2 className="ov-title">How many more minutes?</h2>
          </div>
          <button
            type="button"
            className="ov-close"
            onClick={onClose}
            disabled={loading || applying}
            aria-label="Close"
          >
            <span className="material-symbols-outlined">close</span>
          </button>
        </div>

        <div className="ov-body">
          {taskTitle && (
            <p className="ov-task">
              <span className="material-symbols-outlined ov-icon-16">task_alt</span>
              {taskTitle}
              {plannedMinutes ? ` · planned ${plannedMinutes} min` : ""}
            </p>
          )}

          {error && (
            <div className="ov-error" role="alert">
              <span className="material-symbols-outlined ov-icon-16">error</span>
              {error}
            </div>
          )}

          {!result && (
            <>
              <label className="ov-label" htmlFor="ov-minutes">
                Extra minutes needed
                <span className="ov-value">{extraMinutes} min</span>
              </label>
              <input
                id="ov-minutes"
                type="range"
                className="ov-range"
                min={5}
                max={480}
                step={5}
                value={extraMinutes}
                onChange={(e) => setExtraMinutes(Number(e.target.value))}
              />
              <div className="ov-quick">
                {QUICK_MINUTES.map((m) => (
                  <button
                    key={m}
                    type="button"
                    className={`ov-chip${extraMinutes === m ? " ov-chip--on" : ""}`}
                    onClick={() => setExtraMinutes(m)}
                  >
                    +{m}′
                  </button>
                ))}
              </div>
            </>
          )}

          {result && (
            <div className="ov-result">
              {result.summary && <p className="ov-summary">{result.summary}</p>}

              {result.kind === "none" && (
                <p className="ov-note">
                  <span className="material-symbols-outlined ov-icon-16">
                    info
                  </span>
                  AI couldn't find a way to resolve this. Try a different number of minutes.
                </p>
              )}

              {result.past_day_end && (
                <p className="ov-note ov-note--warn">
                  <span className="material-symbols-outlined ov-icon-16">
                    warning
                  </span>
                  This will extend past the end of your working day.
                </p>
              )}

              {result.moves.length > 0 && (
                <>
                  <p className="ov-sub">The following time slots will be moved:</p>
                  <ul className="ov-moves">
                    {result.moves.map((mv) => (
                      <li key={mv.slot_id} className="ov-move">
                        <span className="ov-move-time">
                          {fmtTime(mv.old_start)} → {fmtTime(mv.new_start)}
                        </span>
                        {mv.explanation && (
                          <span className="ov-move-why">{mv.explanation}</span>
                        )}
                      </li>
                    ))}
                  </ul>
                </>
              )}

              {result.not_placed.length > 0 && (
                <>
                  <p className="ov-sub">Couldn't be rescheduled:</p>
                  <ul className="ov-notplaced">
                    {result.not_placed.map((np) => (
                      <li key={np.slot_id} className="ov-move">
                        {np.reason ?? "No free time slot found."}
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </div>
          )}
        </div>

        <div className="ov-actions">
          {result ? (
            <>
              <button
                type="button"
                className="ov-btn ov-btn--ghost"
                onClick={() => setResult(null)}
                disabled={applying}
              >
                Change minutes
              </button>
              <button
                type="button"
                className="ov-btn ov-btn--primary"
                onClick={() => void handleApply()}
                disabled={applying || result.kind === "none"}
              >
                <span className="material-symbols-outlined ov-icon-20">
                  {applying ? "progress_activity" : "check"}
                </span>
                {applying ? "Updating…" : "Apply"}
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                className="ov-btn ov-btn--ghost"
                onClick={onClose}
                disabled={loading}
              >
                Cancel
              </button>
              <button
                type="button"
                className="ov-btn ov-btn--primary"
                onClick={() => void handleAsk()}
                disabled={loading}
              >
                <span className="material-symbols-outlined ov-icon-20">
                  {loading ? "progress_activity" : "auto_awesome"}
                </span>
                {loading ? "Calculating…" : "Calculate extension"}
              </button>
            </>
          )}
        </div>
      </div>
      <CenterToasts toasts={toasts} onDismiss={toastDismiss} />
    </div>
  );
}

/** "09:30" từ ISO string. */
function fmtTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
  });
}
