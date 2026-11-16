import { useEffect, useMemo, useState } from "react";
import type {
  ScheduleWarningDto,
  SubtaskDto,
  TaskDto,
} from "../lib/api-client";
import {
  PROPOSAL_GROUP_ICONS,
  PROPOSAL_GROUP_LABELS,
  filterProposalGroups,
  fmtMinutes,
  fmtRange,
  groupProposalSlots,
  slotKey,
  summarizeProposal,
  type ProposalFilter,
  type ProposalSlotGroup,
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
  overdue: "Đã quá hạn",
  past_deadline: "Đã quá hạn",
  no_free_slot: "Hết khung giờ trống",
  insufficient_time: "Không đủ thời gian trống",
};

/**
 * 1 dòng cảnh báo của AI.
 *
 * Hiển thị ngay dưới tên task trong nhóm (thay vì gom hết lên đầu panel)
 * để người dùng thấy ngay vấn đề của task đang xét.
 */
function WarningLine({ warning }: { warning: ScheduleWarningDto }) {
  const label = WARNING_LABELS[warning.type] ?? warning.type;
  const hasNumbers = warning.needed_minutes > 0 || warning.free_minutes > 0;
  return (
    <div className="sp-task-warn">
      <span className="material-symbols-outlined sp-icon-16">warning</span>
      <span className="sp-task-warn-text">
        {label}
        {hasNumbers && (
          <span className="sp-task-warn-stat">
            {fmtMinutes(warning.needed_minutes)} / {fmtMinutes(warning.free_minutes)}
          </span>
        )}
        {warning.message && <span className="sp-task-warn-msg">{warning.message}</span>}
      </span>
    </div>
  );
}

/* ---------- Summary chips ---------- */

/**
 * Dải chip tóm tắt kết quả AI.
 *
 * Thay thế "verdict" cũ (1 dòng chung chung) bằng số liệu cụ thể:
 * bao nhiêu task quá hạn / thiếu chỗ / sẵn sàng, tổng số khung giờ và
 * tổng thời lượng đề xuất.
 */
function SummaryChips({
  groups,
  activeFilter,
  onFilter,
  selectedCount,
}: {
  groups: ProposalSlotGroup[];
  activeFilter: ProposalFilter;
  onFilter: (f: ProposalFilter) => void;
  selectedCount: number;
}) {
  const summary = summarizeProposal(groups);

  const chip = (
    kind: ProposalFilter,
    label: string,
    icon: string,
    count: number,
    tone: string,
  ) => {
    const isActive = activeFilter === kind;
    return (
      <button
        type="button"
        className={`sp-chip${isActive ? " sp-chip--on" : ""} ${tone}`}
        onClick={() => onFilter(kind)}
        aria-pressed={isActive}
      >
        <span className="material-symbols-outlined sp-icon-14">{icon}</span>
        <span className="sp-chip-label">{label}</span>
        <span className="sp-chip-count">{count}</span>
      </button>
    );
  };

  return (
    <div className="sp-summary">
      <div className="sp-summary-chips">
        {chip("all", "Tất cả", "apps", summary.totalItems, "sp-chip--all")}
        {chip(
          "overdue",
          PROPOSAL_GROUP_LABELS.overdue,
          PROPOSAL_GROUP_ICONS.overdue,
          summary.counts.overdue,
          "sp-chip--danger",
        )}
        {chip(
          "tight",
          PROPOSAL_GROUP_LABELS.tight,
          PROPOSAL_GROUP_ICONS.tight,
          summary.counts.tight,
          "sp-chip--warn",
        )}
        {chip(
          "ready",
          PROPOSAL_GROUP_LABELS.ready,
          PROPOSAL_GROUP_ICONS.ready,
          summary.counts.ready,
          "sp-chip--ok",
        )}
      </div>
      <p className="sp-summary-meta">
        {summary.totalSubtasks > 0 && `${summary.totalSubtasks} subtask · `}
        {summary.totalSlots} khung giờ · {fmtMinutes(summary.totalMinutes)}
        {selectedCount > 0 && ` · đã chọn ${selectedCount}`}
      </p>
    </div>
  );
}

/* ---------- Task group ---------- */

/**
 * 1 nhóm = 1 task, hoặc 1 subtask (khi AI gắn `subtask_id` cho slot).
 *
 * - **Nhóm cấp task**: tiêu đề = tên task, kèm deadline + warning.
 * - **Nhóm cấp subtask**: tiêu đề = tên subtask, hiện tên task cha ở dưới
 *   (vì nhiều subtask của cùng task nằm cạnh nhau).
 *
 * Cả hai loại đều có checkbox tổng (tick/untick cả nhóm) và các slot con.
 * Nhóm không có slot nào (AI chỉ báo warning) vẫn hiện để user biết
 * việc đó có vấn đề.
 */
function TaskGroup({
  group,
  tasksById,
  excluded,
  approving,
  onToggleSlot,
  onToggleTask,
}: {
  group: ProposalSlotGroup;
  tasksById: Map<string, TaskDto>;
  excluded: Set<string>;
  approving: boolean;
  onToggleSlot: (slot: Parameters<typeof slotKey>[0]) => void;
  onToggleTask: (group: ProposalSlotGroup) => void;
}) {
  const total = group.slots.length;
  const off = group.slots.filter((s) => excluded.has(slotKey(s))).length;
  const allOff = total > 0 && off === total;
  const someOff = off > 0 && off < total;

  const task = tasksById.get(group.taskId);
  const deadline = task?.deadline ? new Date(task.deadline) : null;
  const hasDeadline = deadline && !Number.isNaN(deadline.getTime());

  /** Nhóm cấp subtask → hiện tên subtask; nhóm cấp task → hiện tên task. */
  const isSubtaskGroup = group.subtaskId !== null;
  const heading = isSubtaskGroup
    ? (group.subtaskTitle ?? "Subtask")
    : group.title;

  return (
    <section
      className={`sp-task sp-task--${group.kind}${isSubtaskGroup ? " sp-task--subtask" : ""}`}
    >
      <div className="sp-task-head">
        <label className="sp-check sp-check--task">
          <input
            type="checkbox"
            checked={total > 0 && !allOff}
            ref={(el) => {
              if (el) el.indeterminate = someOff;
            }}
            onChange={() => onToggleTask(group)}
            disabled={total === 0 || approving}
            aria-label={`Chọn tất cả khung giờ của ${heading}`}
          />
          <span className="sp-task-title">{heading}</span>
        </label>

        {/* Badge trạng thái chỉ hiện ở nhóm cấp task — nhóm subtask thừa kế
            trạng thái của task cha, hiện lại ở dòng "task cha" bên dưới. */}
        {!isSubtaskGroup && (
          <span className={`sp-task-badge sp-task-badge--${group.kind}`}>
            <span className="material-symbols-outlined sp-icon-14">
              {PROPOSAL_GROUP_ICONS[group.kind]}
            </span>
            {PROPOSAL_GROUP_LABELS[group.kind]}
          </span>
        )}
      </div>

      {/* Nhóm cấp subtask: hiện task cha + trạng thái + phút ước lượng. */}
      {isSubtaskGroup && (
        <div className="sp-task-parent">
          <span className="material-symbols-outlined sp-icon-16">account_tree</span>
          <span className="sp-task-parent-name">{group.title}</span>
          <span className={`sp-task-parent-kind sp-task-parent-kind--${group.kind}`}>
            {PROPOSAL_GROUP_LABELS[group.kind]}
          </span>
          {hasDeadline && (
            <span
              className={`sp-task-parent-deadline${group.isOverdue ? " sp-task-parent-deadline--late" : ""}`}
            >
              {deadline?.toLocaleDateString("vi-VN", {
                day: "2-digit",
                month: "2-digit",
              })}
            </span>
          )}
          {group.subtaskMinutes != null && group.subtaskMinutes > 0 && (
            <span className="sp-task-parent-min">
              {fmtMinutes(group.subtaskMinutes)}
            </span>
          )}
        </div>
      )}

      {hasDeadline && !isSubtaskGroup && (
        <div className={`sp-task-deadline${group.isOverdue ? " sp-task-deadline--late" : ""}`}>
          <span className="material-symbols-outlined sp-icon-14">event</span>
          Deadline: {deadline.toLocaleString("vi-VN")}
          {group.isOverdue && " (đã qua)"}
        </div>
      )}

      {group.warnings.map((w, i) => (
        <WarningLine key={`${group.taskId}-w-${i}`} warning={w} />
      ))}

      {total === 0 ? (
        <p className="sp-task-empty">AI không tìm được khung giờ trống.</p>
      ) : (
        <ul className="sp-task-slots">
          {group.slots.map((s) => {
            const key = slotKey(s);
            const checked = !excluded.has(key);
            return (
              <li key={key} className={`sp-slot${checked ? "" : " sp-slot--off"}`}>
                <div className="sp-slot-row">
                  <label className="sp-check">
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => onToggleSlot(s)}
                      disabled={approving}
                    />
                    <span className="sp-slot-time">{fmtRange(s.start, s.end)}</span>
                  </label>
                  <span className="sp-slot-dur">{fmtMinutes(s.proposed_minutes)}</span>
                </div>
                {s.explanation && <p className="sp-slot-why">{s.explanation}</p>}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

/* ---------- Body ---------- */

export function ProposalBody({
  hook,
  tasksById,
  subtasksById,
}: {
  hook: UseScheduleProposal;
  tasksById: Map<string, TaskDto>;
  /** Bản đồ subtask để tách slot thành nhóm cấp subtask (optional). */
  subtasksById?: Map<string, SubtaskDto>;
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
  } = hook;

  /** Nhóm lọc đang active (null = xem tất cả). */
  const [filter, setFilter] = useState<ProposalFilter>("all");
  /** Task đang mở rộng phần chi tiết. */
  const [showAll, setShowAll] = useState(false);

  const groups = useMemo(
    () => (proposal ? groupProposalSlots(proposal, tasksById, subtasksById) : []),
    [proposal, tasksById, subtasksById],
  );

  const visibleGroups = useMemo(
    () => filterProposalGroups(groups, filter),
    [groups, filter],
  );

  /** Bật/tắt cả nhóm 1 task. */
  const toggleTask = (group: ProposalSlotGroup) => {
    const allOff = group.slots.every((s) => excluded.has(slotKey(s)));
    for (const s of group.slots) {
      if (allOff) {
        if (excluded.has(slotKey(s))) toggle(s);
      } else if (!excluded.has(slotKey(s))) {
        toggle(s);
      }
    }
  };

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

  if (groups.length === 0) {
    return (
      <div className="sp-state">
        <span className="material-symbols-outlined sp-state-icon">event_busy</span>
        <p>Không tìm được khung giờ trống phù hợp.</p>
      </div>
    );
  }

  // Mỗi nhóm hiện tối đa 4 task; bấm "Xem thêm" để bung phần còn lại.
  const GROUP_PAGE = 4;
  const shownGroups = showAll
    ? visibleGroups
    : visibleGroups.slice(0, GROUP_PAGE);

  return (
    <>
      <SummaryChips
        groups={groups}
        activeFilter={filter}
        onFilter={setFilter}
        selectedCount={selectedSlots.length}
      />

      {error && (
        <div className="sp-inline-error" role="alert">
          <span className="material-symbols-outlined sp-icon-14">error</span>
          {error}
        </div>
      )}

      {shownGroups.length === 0 ? (
        <div className="sp-state">
          <span className="material-symbols-outlined sp-state-icon">filter_alt_off</span>
          <p>Không có việc nào trong nhóm này.</p>
        </div>
      ) : (
        <div className="sp-groups">
          {shownGroups.map((g) => (
            <TaskGroup
              key={g.taskId}
              group={g}
              tasksById={tasksById}
              excluded={excluded}
              approving={approving}
              onToggleSlot={toggle}
              onToggleTask={toggleTask}
            />
          ))}
        </div>
      )}

      {visibleGroups.length > shownGroups.length && (
        <button
          type="button"
          className="sp-more"
          onClick={() => setShowAll(true)}
        >
          Xem thêm {visibleGroups.length - shownGroups.length} việc
        </button>
      )}

      {showAll && visibleGroups.length > GROUP_PAGE && (
        <button type="button" className="sp-more" onClick={() => setShowAll(false)}>
          Thu gọn
        </button>
      )}

      {unscheduledTaskIds.length > 0 && (
        <div className="sp-note">
          <span className="material-symbols-outlined sp-icon-16">info</span>
          {unscheduledTaskIds.length} việc chưa có khung giờ phù hợp.
        </div>
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

  /** Số subtask khác nhau trong các slot đang chọn — để nói rõ Apply sẽ làm gì. */
  const subtaskCount = new Set(
    selectedSlots.map((s) => s.subtask_id).filter(Boolean),
  ).size;

  return (
    <div className="sp-actions">
      <span className="sp-actions-hint">
        {count === 0 ? (
          "Chọn ít nhất 1 khung giờ"
        ) : (
          <>
            <strong>{count}</strong> khung giờ
            {subtaskCount > 0 && ` · ${subtaskCount} subtask`}
          </>
        )}
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
        <span className="material-symbols-outlined sp-icon-20">
          {approving ? "progress_activity" : "check"}
        </span>
        {approving ? "Đang apply…" : "Apply"}
      </button>
    </div>
  );
}

/* ---------- Dialog ---------- */

export function ProposalDialog({
  hook,
  tasksById,
  subtasksById,
  onClose,
  onDone,
}: {
  hook: UseScheduleProposal;
  tasksById: Map<string, TaskDto>;
  /** Bản đồ subtask để tách slot thành nhóm cấp subtask (optional). */
  subtasksById?: Map<string, SubtaskDto>;
  onClose: () => void;
  /** Gọi sau khi apply thành công (vd: nạp lại lịch rồi đóng panel). */
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
            <p className="sp-eyebrow">AI Schedule</p>
            <h2 className="sp-title">Đề xuất lịch</h2>
          </div>
          <button
            type="button"
            className="sp-close"
            onClick={() => {
              close();
              onClose();
            }}
            disabled={approving}
            aria-label="Đóng"
          >
            <span className="material-symbols-outlined">close</span>
          </button>
        </div>

        <div className="sp-body">
          <ProposalBody hook={hook} tasksById={tasksById} subtasksById={subtasksById} />
        </div>

        <ProposalActions hook={hook} onDone={onDone} />
      </div>
    </div>
  );
}
