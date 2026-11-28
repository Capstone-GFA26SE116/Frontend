/**
 * ===========================================================
 * Gợi ý giờ làm việc nhóm (AI) — FR-25
 * ===========================================================
 *
 * Spec: `GROUP_AI_FE (1).md` mục 3.
 *
 * Luồng:
 *   Người được giao bấm "Suggest times" → AI đọc lịch và trả về các khung
 *   giờ trống → người dùng tick → bấm "Add to calendar" → FE gọi Backend
 *   `POST /api/group-tasks/{id}/schedule-slots` **tuần tự** để tạo slot.
 *
 * ⚠️ AI **không** tạo slot và **không** tốn lượt AI.
 * ⚠️ `409 SLOT_OVERLAP` = lịch đã đổi kể từ lúc gợi ý → bỏ qua khung đó
 *    và gọi lại "Suggest times" cho phần còn thiếu.
 *
 * Giao diện theo `DESIGN.md` (prefix `.gai-*` — dùng chung style với tab
 * Chat AI): canvas #101010 · hairline #3d3a39 · accent #00d992.
 */

import { useMemo, useState } from "react";
import type {
  GroupSlotSuggestionDto,
  GroupSlotSuggestionsDto,
  GroupSlotWarningDto,
} from "../../lib/group-ai-api";
import "./group-ai.css";

export interface GroupSlotSuggestionsModalProps {
  /** Tên việc nhóm — hiện ở tiêu đề. */
  taskTitle: string;
  /** Dữ liệu AI trả về. */
  data: GroupSlotSuggestionsDto | null;
  /** Đang gọi AI (hiện spinner trong hộp thoại). */
  loading: boolean;
  /** Đang tạo slot ở Backend. */
  saving: boolean;
  /** Đã tạo được bao nhiêu slot (để báo "2 of 3 added"). */
  addedCount?: number;
  /** Đã bỏ qua bao nhiêu khung vì chồng lịch (409 SLOT_OVERLAP). */
  skippedCount?: number;
  /** Lỗi đã dịch sang tiếng Anh (hiện qua hộp thoại lỗi của trang). */
  onClose: () => void;
  /** Người dùng bấm "Add to calendar" → tạo slot cho các khung đã tick. */
  onAddToCalendar: (slots: GroupSlotSuggestionDto[]) => void;
  /** Gọi lại AI (không tốn lượt). */
  onRetry?: () => void;
}

/** "Wed, 25 Nov, 10:00" — giờ địa phương, gọn gàng. */
function fmtSlotTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const day = d.toLocaleDateString(undefined, {
    weekday: "short",
    day: "numeric",
    month: "short",
  });
  const time = d.toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  return `${day}, ${time}`;
}

/** "60" phút → "1h". */
function fmtSlotMinutes(min: number | null | undefined): string {
  if (min == null || !Number.isFinite(min) || min <= 0) return "";
  if (min < 60) return `${Math.round(min)}m`;
  const h = Math.floor(min / 60);
  const m = Math.round(min % 60);
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

/**
 * Cảnh báo → thông điệp tiếng Anh dễ hiểu.
 *
 * Theo spec mục 3: `no_estimate` · `not_enough_time` · `overdue` ·
 * `beyond_window`.
 */
function warningText(w: GroupSlotWarningDto): string {
  const type = (w.type ?? "").trim().toLowerCase();
  if (type === "no_estimate") {
    return "Some of your subtasks don't have a time estimate yet, so they can't be scheduled. Add an estimate and try again.";
  }
  if (type === "not_enough_time") {
    const need = w.needed_minutes;
    const free = w.free_minutes;
    if (need != null && free != null) {
      return `You don't have enough free time before the deadline — about ${fmtSlotMinutes(need)} of work left but only ${fmtSlotMinutes(free)} free. Try moving the deadline or picking a different task.`;
    }
    return "You don't have enough free time before the deadline to fit all of this work. Try moving the deadline or picking a different task.";
  }
  if (type === "overdue") {
    return "This task is already past its deadline, so AI scheduled it as early as possible.";
  }
  if (type === "beyond_window") {
    return "The deadline is still far away, so AI only scheduled the next 7 days. Run this again later to cover the rest.";
  }
  return w.message ?? "AI couldn't schedule all of this work.";
}

/** Key duy nhất cho 1 khung (start + end + subtask). */
function slotKey(s: GroupSlotSuggestionDto): string {
  return `${s.subtask_id ?? "task"}|${s.start}|${s.end}`;
}

/**
 * Hộp thoại gợi ý giờ làm việc.
 */
export function GroupSlotSuggestionsModal({
  taskTitle,
  data,
  loading,
  saving,
  addedCount = 0,
  skippedCount = 0,
  onClose,
  onAddToCalendar,
  onRetry,
}: GroupSlotSuggestionsModalProps) {
  /** Khung nào đang được tick (mặc định tick hết). */
  const [picked, setPicked] = useState<Record<string, boolean>>({});

  const slots = useMemo(() => data?.slots ?? [], [data]);
  const warnings = useMemo(() => data?.warnings ?? [], [data]);

  /** Khung được tick — mặc định tick tất cả. */
  const selected = useMemo(
    () => slots.filter((s) => picked[slotKey(s)] !== false),
    [slots, picked],
  );

  return (
    <div className="gai-backdrop" role="presentation" onClick={onClose}>
      <div
        className="gai-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="gai-slot-title"
        onClick={(e) => e.stopPropagation()}
      >
        {/* ---------- Đầu ---------- */}
        <div className="gai-head">
          <span className="gai-head-icon" aria-hidden="true">
            <span className="material-symbols-outlined">event_available</span>
          </span>
          <div className="gai-head-text">
            <span className="gai-eyebrow">AI suggestion</span>
            <h2 id="gai-slot-title" className="gai-title">
              {data?.summary || "Giờ trống cho phần việc của bạn"}
            </h2>
            <p className="gai-subtitle">{taskTitle}</p>
          </div>
          <button
            type="button"
            className="gai-close"
            onClick={onClose}
            aria-label="Close"
          >
            <span className="material-symbols-outlined">close</span>
          </button>
        </div>

        {/* ---------- Thân ---------- */}
        <div className="gai-body">
          {loading && (
            <div className="gai-state" role="status">
              <span className="material-symbols-outlined gai-spin">
                progress_activity
              </span>
              <span>AI is finding free time in your calendar…</span>
            </div>
          )}

          {!loading && slots.length === 0 && (
            <div className="gai-state">
              <span className="material-symbols-outlined">event_busy</span>
              <span>
                AI couldn't find any free time for this task. Check the warnings
                below, or add a time slot manually.
              </span>
            </div>
          )}

          {!loading && warnings.length > 0 && (
            <div className="gai-warn-list">
              {warnings.map((w, i) => (
                <div key={i} className="gai-warn">
                  <span className="material-symbols-outlined" aria-hidden="true">
                    warning
                  </span>
                  <span>{warningText(w)}</span>
                </div>
              ))}
            </div>
          )}

          {!loading && slots.length > 0 && (
            <>
              <p className="gai-hint-line">
                AI found {slots.length} free {slots.length === 1 ? "slot" : "slots"}{" "}
                in your working hours. Untick any you don't want.
              </p>
              <ul className="gai-time-list">
                {slots.map((s) => {
                  const key = slotKey(s);
                  const on = picked[key] !== false;
                  return (
                    <li key={key} className="gai-time-item">
                      <label className="gai-time-option">
                        <input
                          type="checkbox"
                          checked={on}
                          disabled={saving}
                          onChange={(e) =>
                            setPicked((prev) => ({ ...prev, [key]: e.target.checked }))
                          }
                        />
                        <span className="gai-time-body">
                          <span className="gai-time-range">
                            {fmtSlotTime(s.start)} → {fmtSlotTime(s.end)}
                            {s.minutes > 0 && (
                              <span className="gai-time-dur">
                                {fmtSlotMinutes(s.minutes)}
                              </span>
                            )}
                          </span>
                          {s.title && (
                            <span className="gai-time-title">{s.title}</span>
                          )}
                          {s.reason && (
                            <span className="gai-time-reason">{s.reason}</span>
                          )}
                        </span>
                      </label>
                    </li>
                  );
                })}
              </ul>
            </>
          )}

          {addedCount > 0 && (
            <div className="gai-note" role="status">
              <span className="material-symbols-outlined" aria-hidden="true">
                check_circle
              </span>
              <span>
                {addedCount} {addedCount === 1 ? "slot was" : "slots were"} added
                to your calendar.
                {skippedCount > 0 &&
                  ` ${skippedCount} ${
                    skippedCount === 1 ? "slot was" : "slots were"
                  } skipped because your calendar changed — run "Suggest times" again for the rest.`}
              </span>
            </div>
          )}
        </div>

        {/* ---------- Chân ---------- */}
        <div className="gai-actions">
          {onRetry && (
            <button
              type="button"
              className="gai-btn gai-btn--ghost"
              onClick={onRetry}
              disabled={loading || saving}
            >
              <span className="material-symbols-outlined" aria-hidden="true">
                refresh
              </span>
              Run again
            </button>
          )}
          <button
            type="button"
            className="gai-btn gai-btn--ghost"
            onClick={onClose}
            disabled={saving}
          >
            Close
          </button>
          <button
            type="button"
            className="gai-btn gai-btn--primary"
            onClick={() => onAddToCalendar(selected)}
            disabled={loading || saving || selected.length === 0}
          >
            {saving ? (
              <>
                <span className="material-symbols-outlined gai-spin" aria-hidden="true">
                  progress_activity
                </span>
                Đang thêm…
              </>
            ) : (
              <>
                <span className="material-symbols-outlined" aria-hidden="true">
                  event_available
                </span>
                Thêm vào lịch
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
