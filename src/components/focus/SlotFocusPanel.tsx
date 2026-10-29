import { useEffect, useState } from "react";
import { getFocusTimeSummary, type FocusTimeSummaryResponse } from "../../lib/api-client";
import { formatMinutes } from "./focus-logic";
import { useFocusActions } from "./focus-context";
import { SlotFocusActions } from "./SlotFocusActions";
import "./focus.css";

/**
 * ===========================================================
 * <SlotFocusPanel> — khối "Phiên làm việc" trong modal chi tiết slot.
 * ===========================================================
 *
 * Hiển thị:
 *  • Nút Start / Stop (theo trạng thái slot).
 *  • Tổng kết thời gian: planned vs actual + số phiên.
 *  • Danh sách các phiên đã làm (giờ bắt đầu, phút, lý do dừng).
 *
 * Dữ liệu từ `GET /api/focus/{slotId}/time-summary`.
 */

export interface SlotFocusPanelProps {
  slotId: string | null;
  taskId: string | null;
  subTaskId?: string | null;
  status: string | null | undefined;
  plannedMinutes?: number;
  /** Refetch lịch sau khi slot đổi trạng thái. */
  onChanged?: () => void;
}

export function SlotFocusPanel({
  slotId,
  taskId,
  subTaskId,
  status,
  plannedMinutes,
  onChanged,
}: SlotFocusPanelProps) {
  const { currentSlotId, hasActiveSession } = useFocusActions();
  const [summary, setSummary] = useState<FocusTimeSummaryResponse | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!slotId) return;
    let cancelled = false;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- data-fetch pattern
    setLoading(true);
    void getFocusTimeSummary(slotId).then((res) => {
      if (cancelled) return;
      setLoading(false);
      if (res.ok) setSummary(res.data);
    });
    return () => {
      cancelled = true;
    };
  }, [slotId]);

  if (!slotId || !taskId) return null;

  const sessions = summary?.sessions ?? [];
  const hasData = !!summary && summary.sessionCount > 0;
  /** Slot này không phải slot đang chạy mà vẫn có phiên khác → chặn Start. */
  const blockedByOtherSession = hasActiveSession && currentSlotId !== slotId;

  return (
    <section className="fc-panel">
      <header className="fc-panel__head">
        <span className="material-symbols-outlined">timer</span>
        <span className="fc-panel__title">Phiên làm việc</span>
      </header>

      <SlotFocusActions
        slotId={slotId}
        taskId={taskId}
        subTaskId={subTaskId}
        status={status}
        plannedMinutes={plannedMinutes}
        blockedByOtherSession={blockedByOtherSession}
        onChanged={onChanged}
      />

      {loading && !hasData ? (
        <p className="fc-panel__hint">Đang tải tổng kết…</p>
      ) : hasData && summary ? (
        <>
          <div className="fc-panel__stats">
            <div className="fc-panel__stat">
              <span className="fc-panel__stat-label">Kế hoạch</span>
              <span className="fc-panel__stat-value">
                {formatMinutes(summary.plannedMinutes)}
              </span>
            </div>
            <div className="fc-panel__stat">
              <span className="fc-panel__stat-label">Thực tế</span>
              <span className="fc-panel__stat-value fc-panel__stat-value--accent">
                {formatMinutes(summary.actualMinutes)}
              </span>
            </div>
            <div className="fc-panel__stat">
              <span className="fc-panel__stat-label">Số phiên</span>
              <span className="fc-panel__stat-value">{summary.sessionCount}</span>
            </div>
          </div>

          {sessions.length > 0 && (
            <ul className="fc-panel__sessions">
              {sessions.map((s) => (
                <li key={s.sessionId} className="fc-panel__session">
                  <span className="fc-panel__session-time">
                    {new Date(s.startedAt).toLocaleTimeString(undefined, {
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                  </span>
                  <span className="fc-panel__session-min">
                    {formatMinutes(s.minutes)}
                  </span>
                  <span className="fc-panel__session-reason">
                    {s.captureMethod === "SelfReported"
                      ? "Tự khai"
                      : s.captureMethod === "AutoTimeout"
                        ? "Tự ngắt"
                        : (s.stopReason ?? "")}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </>
      ) : (
        <p className="fc-panel__hint">
          Chưa có phiên làm việc nào cho slot này.
        </p>
      )}
    </section>
  );
}
