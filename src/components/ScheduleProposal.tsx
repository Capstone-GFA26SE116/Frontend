import { useEffect, useState } from "react";
import type {
  ScheduleWarningDto,
  TaskDto,
} from "../lib/api-client";
import {
  fmtMinutes,
  fmtRange,
  slotKey,
  type UseScheduleProposal,
} from "./schedule-proposal-logic";
import "./schedule-proposal.css";

/* ===========================================================
 * AI Schedule Proposal — UI dùng chung cho /schedule và /copilot
 *
 * Luồng: bấm nút → POST /schedule/propose → hiện khung giờ AI đề xuất →
 * người dùng tick từng slot → duyệt → ghi vào calendar.
 *
 * API không tự ghi gì vào calendar (contract của backend) nên mỗi slot được
 * duyệt gọi `createScheduleSlot` kèm `scheduleProposalId` — logic nằm ở
 * `useScheduleProposal` trong ./schedule-proposal-logic.ts.
 *
 * Hook/helper được import trực tiếp từ `schedule-proposal-logic` để file này
 * chỉ chứa component (giữ react-refresh hoạt động bình thường khi dev).
 * =========================================================== */

/* ---------- Warning group ---------- */

/** Nhãn tiếng Việt cho `warning.type` do AI trả về. */
const WARNING_LABELS: Record<string, string> = {
  not_enough_time: "Không đủ thời gian trống",
  overdue: "Task đã quá hạn",
  past_deadline: "Task đã quá hạn",
  no_free_slot: "Không còn khung giờ trống",
  insufficient_time: "Không đủ thời gian trống",
};

/** ---------- Warning group ---------- */

function WarningGroup({
  warnings,
  tasksById,
}: {
  warnings: ScheduleWarningDto[];
  tasksById: Map<string, TaskDto>;
}) {
  if (warnings.length === 0) return null;
  return (
    <ul className="sp-warn-list">
      {warnings.map((w, i) => {
        const label = WARNING_LABELS[w.type];
        // AI có thể trả 0 cho cả 2 khi warning mang tính chất thông báo
        // (ví dụ task quá hạn) — lúc đó dòng số liệu chỉ toàn dấu gạch, vô nghĩa.
        const hasNumbers = w.needed_minutes > 0 || w.free_minutes > 0;
        return (
          <li key={`${w.task_id}-${i}`} className="sp-warn">
            <span className="material-symbols-outlined sp-warn-icon">warning</span>
            <div className="sp-warn-body">
              <strong>{tasksById.get(w.task_id)?.title ?? "Task"}</strong>
              <span className="sp-warn-type">{label ?? w.type}</span>
              {/* Deadline để user tự kiểm chứng AI có đọc đúng không. */}
              {(() => {
                const task = tasksById.get(w.task_id);
                if (!task?.deadline) return null;
                const dl = new Date(task.deadline);
                if (Number.isNaN(dl.getTime())) return null;
                const overdue = dl.getTime() < Date.now();
                return (
                  <span className={`sp-warn-deadline${overdue ? " sp-warn-deadline--late" : ""}`}>
                    Deadline: {dl.toLocaleString("vi-VN")}
                    {overdue ? " (đã qua)" : ""}
                  </span>
                );
              })()}
              {w.message && <span className="sp-warn-msg">{w.message}</span>}
              {hasNumbers && (
                <span className="sp-warn-stat">
                  Cần {fmtMinutes(w.needed_minutes)} · chỉ còn {fmtMinutes(w.free_minutes)} trống
                </span>
              )}
            </div>
          </li>
        );
      })}
    </ul>
  );
}

/* ---------- Body ---------- */

export function ProposalBody({
  hook,
  tasksById,
}: {
  hook: UseScheduleProposal;
  tasksById: Map<string, TaskDto>;
}) {
  const {
    proposal,
    loading,
    approving,
    error,
    excluded,
    selectedSlots,
    unscheduledTaskIds,
    toggle,
    toggleAll,
  } = hook;
  const [showAll, setShowAll] = useState(false);

  if (loading) {
    return (
      <div className="sp-state" role="status">
        <span className="material-symbols-outlined sp-state-icon sp-state-icon--spin">
          progress_activity
        </span>
        <p>AI đang tính lịch…</p>
      </div>
    );
  }

  if (!proposal) {
    if (!error) return null;
    return (
      <div className="sp-state sp-state--error" role="alert">
        <span className="material-symbols-outlined sp-state-icon">error</span>
        <p>{error}</p>
      </div>
    );
  }

  const slots = proposal.slots ?? [];
  const warnings = proposal.warnings ?? [];
  const visibleSlots = showAll ? slots : slots.slice(0, 8);

  return (
    <>
      {/* Kết luận của AI — luôn hiện, kể cả khi không khả thi. */}
      <div className={`sp-verdict${proposal.is_feasible ? "" : " sp-verdict--warn"}`}>
        <span className="material-symbols-outlined sp-verdict-icon">
          {proposal.is_feasible ? "task_alt" : "warning"}
        </span>
        <div>
          <strong>
            {proposal.is_feasible
              ? "Đủ chỗ cho lịch này"
              : "Chưa đủ thời gian — vẫn có thể xếp phần đủ được"}
          </strong>
          {!proposal.is_feasible && proposal.missing_minutes > 0 && (
            <span className="sp-verdict-missing">
              Còn thiếu {fmtMinutes(proposal.missing_minutes)} so với ước lượng của bạn.
            </span>
          )}
          {proposal.explanation && <p className="sp-verdict-text">{proposal.explanation}</p>}
        </div>
      </div>

      {error && (
        <div className="sp-inline-error" role="alert">
          <span className="material-symbols-outlined sp-icon-14">error</span>
          {error}
        </div>
      )}

      {warnings.length > 0 && <WarningGroup warnings={warnings} tasksById={tasksById} />}

      {slots.length === 0 ? (
        <div className="sp-state">
          <span className="material-symbols-outlined sp-state-icon">event_busy</span>
          <p>AI không tìm được khung giờ trống phù hợp cho các task này.</p>
        </div>
      ) : (
        <>
          <div className="sp-list-head">
            <label className="sp-check">
              <input
                type="checkbox"
                checked={selectedSlots.length === slots.length}
                onChange={(e) => toggleAll(e.currentTarget.checked)}
                disabled={approving}
              />
              <span>
                {selectedSlots.length}/{slots.length} khung giờ
              </span>
            </label>
          </div>

          <ul className="sp-list">
            {visibleSlots.map((s) => {
              const key = slotKey(s);
              const checked = !excluded.has(key);
              return (
                <li key={key} className={`sp-slot${checked ? "" : " sp-slot--off"}`}>
                  <label className="sp-check">
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => toggle(s)}
                      disabled={approving}
                    />
                    <span className="sp-slot-title">
                      {tasksById.get(s.task_id)?.title ?? "Task"}
                    </span>
                  </label>
                  <div className="sp-slot-meta">
                    <span className="material-symbols-outlined sp-icon-14">schedule</span>
                    {fmtRange(s.start, s.end)}
                    <span className="sp-slot-dur">{fmtMinutes(s.proposed_minutes)}</span>
                  </div>
                  {s.explanation && <p className="sp-slot-why">{s.explanation}</p>}
                </li>
              );
            })}
          </ul>

          {slots.length > 8 && (
            <button
              type="button"
              className="sp-more"
              onClick={() => setShowAll((v) => !v)}
              disabled={approving}
            >
              {showAll ? "Thu gọn" : `Xem thêm ${slots.length - 8} khung giờ`}
            </button>
          )}

          {unscheduledTaskIds.length > 0 && (
            <div className="sp-note">
              <span className="material-symbols-outlined sp-icon-14">info</span>
              {unscheduledTaskIds.length} task được AI nhắc tới nhưng chưa có khung giờ nào.
            </div>
          )}
        </>
      )}
    </>
  );
}

/* ---------- Actions ---------- */

export function ProposalActions({
  hook,
  onDone,
}: {
  hook: UseScheduleProposal;
  onDone?: () => void | Promise<void>;
}) {
  const { proposal, selectedSlots, approving, approve } = hook;
  if (!proposal) return null;
  const count = selectedSlots.length;
  return (
    <div className="sp-actions">
      <span className="sp-actions-hint">
        {count === 0 ? "Chọn ít nhất 1 khung giờ" : `Sẽ thêm ${count} khung giờ vào lịch`}
      </span>
      <button
        type="button"
        className="sp-btn sp-btn--primary"
        onClick={async () => {
          const n = await approve();
          if (n > 0) await onDone?.();
        }}
        disabled={approving || count === 0}
      >
        <span className="material-symbols-outlined sp-icon-18">
          {approving ? "progress_activity" : "check"}
        </span>
        {approving ? "Đang thêm…" : "Thêm vào lịch"}
      </button>
    </div>
  );
}

/* ---------- Dialog ---------- */

export function ProposalDialog({
  hook,
  tasksById,
  onClose,
  onDone,
}: {
  hook: UseScheduleProposal;
  tasksById: Map<string, TaskDto>;
  onClose: () => void;
  /** Gọi sau khi duyệt thành công (vd: nạp lại lịch rồi đóng panel). */
  onDone?: () => void | Promise<void>;
}) {
  const { close, approving, proposal, loading, error } = hook;

  // Escape để đóng (không đóng khi đang ghi để tránh mất kết quả).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !approving) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [approving, onClose]);

  if (!proposal && !loading && !error) return null;

  return (
    <div
      className="sp-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !approving) onClose();
      }}
    >
      <div
        className="sp-panel"
        role="dialog"
        aria-modal="true"
        aria-label="AI schedule proposal"
      >
        <div className="sp-head">
          <div className="sp-head-icon">
            <span className="material-symbols-outlined">auto_awesome</span>
          </div>
          <div className="sp-head-text">
            <h2 className="sp-title">AI đề xuất lịch</h2>
            <p className="sp-sub">
              Xem trước các khung giờ AI sắp xếp. Chưa có gì được thêm vào lịch cho tới khi bạn duyệt.
            </p>
          </div>
          <button
            type="button"
            className="sp-close"
            onClick={() => {
              close();
              onClose();
            }}
            disabled={approving}
            aria-label="Close"
          >
            <span className="material-symbols-outlined">close</span>
          </button>
        </div>

        <div className="sp-body">
          <ProposalBody hook={hook} tasksById={tasksById} />
        </div>

        <ProposalActions hook={hook} onDone={onDone} />
      </div>
    </div>
  );
}