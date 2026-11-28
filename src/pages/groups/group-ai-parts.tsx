/**
 * ===========================================================
 * Thành phần dùng chung cho Chat AI của nhóm
 * ===========================================================
 *
 * Tách ra khỏi `GroupAiChatTab.tsx` để dùng được ở 2 nơi:
 *  - Tab "Chat AI" trong `GroupDetail` (bản nháp nằm TRONG khung chat).
 *  - Trang riêng `/groups/:groupId/ai` (bản nháp nằm CỘT PHẢI).
 *
 * Scope class prefix: `.gai-*`.
 */

import { forwardRef, useImperativeHandle, useRef, useState } from "react";
import type { RefObject } from "react";
import type { GroupChatMessageDto } from "../../lib/group-ai-api";
import type { GroupMemberDto } from "../../lib/group-api";
import {
  fmtDeadline,
  fmtMinutes,
  type EditableDraft,
  type EditableMilestone,
  type EditableTask,
} from "./group-ai-logic";

/* ===========================================================
 * 1. Khung chat
 * =========================================================== */

/** Giờ kiểu "14:32" — ngắn gọn cho dòng meta. */
function fmtMsgTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

export interface GroupChatThreadProps {
  messages: GroupChatMessageDto[];
  members: GroupMemberDto[];
  loading: boolean;
  thinking: boolean;
  /** Tin AI gần nhất không có bản nháp dùng được → cảnh báo. */
  planWithoutDraft: GroupChatMessageDto | null;
  /** Đã có bản nháp → nhắc xem ở cột phải. */
  hasDraft: boolean;
  onRegenerate: () => void;
  /** Ref tới vùng cuộn — trang cha tự cuộn xuống cuối. */
  bodyRef?: RefObject<HTMLDivElement | null>;
}

export function GroupChatThread({
  messages,
  members,
  loading,
  thinking,
  planWithoutDraft,
  hasDraft,
  onRegenerate,
  bodyRef,
}: GroupChatThreadProps) {
  return (
    <div className="gai-planner-transcript" ref={bodyRef}>
      {loading && (
        <div className="gai-thinking" role="status">
          <span className="material-symbols-outlined">progress_activity</span>
          <span>Loading conversation…</span>
        </div>
      )}

      {!loading && messages.length === 0 && (
        <div className="gai-state">
          <span className="material-symbols-outlined">auto_awesome</span>
          <span>
            Describe the client brief below. AI will ask what's missing, then
            draft a milestone plan for the group.
          </span>
        </div>
      )}

      {messages.map((m) => (
        <GroupChatMessage
          key={m.message_id}
          message={m}
          members={members}
        />
      ))}

      {thinking && (
        <div className="gai-msg gai-msg--ai" role="status">
          <span className="gai-avatar gai-avatar--ai" aria-hidden="true">
            <span className="material-symbols-outlined">auto_awesome</span>
          </span>
          <div className="gai-msg-col">
            <div className="gai-msg-meta">
              <span className="gai-msg-meta-name">METANOIA AI</span>
              <span className="gai-msg-meta-time">· thinking</span>
            </div>
            <div className="gai-bubble gai-bubble--ai gai-typing">
              <span className="gai-typing-dot" />
              <span className="gai-typing-dot" />
              <span className="gai-typing-dot" />
            </div>
          </div>
        </div>
      )}

      {/*
       * AI trả lời nhưng KHÔNG sinh được bản nháp (chỉ có text).
       * → Báo rõ + cho nút thử lại, thay vì im lặng không hiện gì.
       */}
      {planWithoutDraft && (
        <div className="gai-no-draft" role="alert">
          <span className="material-symbols-outlined" aria-hidden="true">
            error_outline
          </span>
          <div className="gai-no-draft-body">
            <strong>The plan came back empty.</strong>
            <p>
              The AI replied with text only, so there are no milestones, tasks
              or assignees to review. This usually happens when the AI can't
              find enough free time for the team — try again, or move some
              deadlines back.
            </p>
            <button
              type="button"
              className="gai-btn gai-btn--ghost gai-no-draft-btn"
              onClick={onRegenerate}
            >
              <span className="material-symbols-outlined" aria-hidden="true">
                refresh
              </span>
              Generate plan again
            </button>
          </div>
        </div>
      )}

      {hasDraft && (
        <p className="gai-planner-draft-hint">
          <span className="material-symbols-outlined" aria-hidden="true">
            arrow_forward
          </span>
          The plan is on the right — review and apply it there.
        </p>
      )}
    </div>
  );
}

/* ===========================================================
 * 2. 1 tin nhắn
 * =========================================================== */

function GroupChatMessage({
  message,
  members,
}: {
  message: GroupChatMessageDto;
  members: GroupMemberDto[];
}) {
  const isUser = message.role === "user";
  const notes = message.notes;

  /** Chữ cái đầu của tên — dùng làm avatar khi không có tên. */
  const initial = isUser ? "Y" : "A";

  return (
    <div className={"gai-msg " + (isUser ? "gai-msg--user" : "gai-msg--ai")}>
      {isUser ? (
        <span className="gai-avatar" title="You">
          {initial}
        </span>
      ) : (
        <span className="gai-avatar gai-avatar--ai" title="METANOIA AI">
          <span className="material-symbols-outlined" aria-hidden="true">
            auto_awesome
          </span>
        </span>
      )}

      <div className="gai-msg-col">
        <div className="gai-msg-meta">
          <span className="gai-msg-meta-name">
            {isUser ? "You" : "METANOIA AI"}
          </span>
          <span className="gai-msg-meta-time">· {fmtMsgTime(message.created_at)}</span>
        </div>

        {message.content && (
          <div
            className={
              "gai-bubble " + (isUser ? "gai-bubble--user" : "gai-bubble--ai")
            }
          >
            {message.content}
          </div>
        )}

        {notes && (
          <div className="gai-notes">
            <NoteBlock
              variant="clear"
              icon="check_circle"
              title="Clear"
              items={notes.clear}
            />
            <NoteBlock
              variant="missing"
              icon="help"
              title="Missing"
              items={notes.missing}
            />
            <NoteBlock
              variant="questions"
              icon="help_outline"
              title="Ask the client"
              items={notes.questions}
            />
            <NoteBlock
              variant="risks"
              icon="warning"
              title="Risks"
              items={notes.risks}
            />
          </div>
        )}

        {/*
         * Bản nháp cũ (read-only) — bản MỚI NHẤT hiện ở cột phải.
         */}
        {message.draft && (
          <GroupDraftPreview draft={message.draft} members={members} />
        )}
      </div>
    </div>
  );
}

/** 1 khối trong checklist 4 khối. */
function NoteBlock({
  variant,
  icon,
  title,
  items,
}: {
  variant: string;
  icon: string;
  title: string;
  items: string[];
}) {
  if (!items || items.length === 0) return null;
  return (
    <div className={`gai-note-block gai-note-block--${variant}`}>
      <p className="gai-note-block-title">
        <span className="material-symbols-outlined" aria-hidden="true">
          {icon}
        </span>
        {title}
      </p>
      <ul className="gai-note-list">
        {items.map((it, i) => (
          <li key={i}>{it}</li>
        ))}
      </ul>
    </div>
  );
}

/**
 * Xem trước bản nháp (read-only) — thu gọn thành 1 dòng tóm tắt.
 */
function GroupDraftPreview({
  draft,
  members,
}: {
  draft: NonNullable<GroupChatMessageDto["draft"]>;
  members: GroupMemberDto[];
}) {
  const [open, setOpen] = useState(false);

  const msCount = draft.milestones.length;
  const taskCount = draft.milestones.reduce(
    (acc, ms) => acc + (ms.tasks?.length ?? 0),
    0,
  );

  return (
    <div className="gai-draft gai-draft--preview">
      <button
        type="button"
        className="gai-draft-preview-toggle"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <span className="material-symbols-outlined" aria-hidden="true">
          account_tree
        </span>
        <span className="gai-draft-preview-label">Earlier draft plan</span>
        <span className="gai-draft-preview-meta">
          {msCount} {msCount === 1 ? "milestone" : "milestones"} · {taskCount}{" "}
          {taskCount === 1 ? "task" : "tasks"} ·{" "}
          {fmtMinutes(draft.total_estimated_minutes)}
        </span>
        <span
          className="material-symbols-outlined gai-draft-preview-caret"
          aria-hidden="true"
        >
          {open ? "expand_less" : "expand_more"}
        </span>
      </button>

      {open && (
        <div className="gai-draft-preview-body">
          {draft.milestones.map((ms, i) => (
            <div key={ms.key ?? `ms-${i}`} className="gai-milestone">
              <div className="gai-milestone-head">
                <span className="gai-milestone-index">{i + 1}</span>
                <span className="gai-milestone-title">{ms.title}</span>
                {ms.deadline && (
                  <span className="gai-milestone-deadline">
                    <span className="material-symbols-outlined" aria-hidden="true">
                      event
                    </span>
                    {fmtDeadline(ms.deadline)}
                  </span>
                )}
              </div>
              <div className="gai-tasks">
                {ms.tasks.map((t, ti) => (
                  <div key={t.key ?? `t-${ti}`} className="gai-task">
                    <div className="gai-task-head">
                      <span className="gai-task-title">{t.title}</span>
                      {t.domain_name && (
                        <span className="gai-domain">{t.domain_name}</span>
                      )}
                      <span className="gai-est">
                        <span
                          className="material-symbols-outlined"
                          aria-hidden="true"
                        >
                          schedule
                        </span>
                        {fmtMinutes(t.estimated_minutes)}
                      </span>
                    </div>
                    {t.suggested_assignee && (
                      <p className="gai-task-reason">
                        {t.suggested_assignee.user_id
                          ? `Suggested: ${
                              members.find(
                                (m) =>
                                  m.userId === t.suggested_assignee?.user_id,
                              )?.fullName ?? "a team member"
                            }`
                          : "No one is available to take this on yet."}
                        {t.suggested_assignee.reason
                          ? ` — ${t.suggested_assignee.reason}`
                          : ""}
                      </p>
                    )}
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* ===========================================================
 * 3. Cột phải: bản nháp có thể sửa + nút Áp dụng
 * =========================================================== */

/** Handle để trang cha cuộn tới bản nháp khi nó vừa xuất hiện. */
export interface GroupDraftPanelHandle {
  /** Cuộn tới bản nháp (bản nháp vừa được AI sinh ra). */
  scrollToDraft: () => void;
}

export interface GroupDraftPanelProps {
  draft: EditableDraft | null;
  assignable: GroupMemberDto[];
  applying: boolean;
  error: string | null;
  busyConflict?: {
    taskKey: string;
    milestoneKey: string;
    title: string;
    assigneeId: string | null;
  } | null;
  onPatchMilestone: (msKey: string, patch: Partial<EditableMilestone>) => void;
  onPatchTask: (
    msKey: string,
    taskKey: string,
    patch: Partial<EditableTask>,
  ) => void;
  onRestore: () => void;
  onApply: () => void;
  onConfirmConflicts: () => void;
  onDismissConflict: () => void;
}

export const GroupDraftPanel = forwardRef<
  GroupDraftPanelHandle,
  GroupDraftPanelProps
>(function GroupDraftPanel(
  {
    draft,
    assignable,
    applying,
    error,
    busyConflict,
    onPatchMilestone,
    onPatchTask,
    onRestore,
    onApply,
    onConfirmConflicts,
    onDismissConflict,
  },
  ref,
) {
  const rootRef = useRef<HTMLDivElement | null>(null);

  useImperativeHandle(ref, () => ({
    scrollToDraft: () => {
      rootRef.current?.scrollIntoView({ block: "nearest" });
    },
  }));

  /* Số việc / việc con sẽ tạo → hiện tóm tắt cho Leader trước khi duyệt. */
  const taskCount = draft
    ? draft.milestones.reduce((acc, ms) => acc + ms.tasks.length, 0)
    : 0;
  const subtaskCount = draft
    ? draft.milestones.reduce(
        (acc, ms) =>
          acc + ms.tasks.reduce((a, t) => a + t.subtasks.length, 0),
        0,
      )
    : 0;

  /* ---------- Chưa có bản nháp ---------- */
  if (!draft) {
    return (
      <div className="gai-planner-card gai-planner-card--empty">
        <div className="gai-planner-card-head">
          <span
            className="material-symbols-outlined gai-planner-card-icon"
            aria-hidden="true"
          >
            account_tree
          </span>
          <h2 className="gai-planner-card-title">Plan</h2>
        </div>
        <p className="gai-planner-card-sub">
          No plan yet. Paste the client brief in the chat, then press{" "}
          <strong>Draft plan</strong> — the milestones and tasks will appear
          here, ready to review and apply.
        </p>
      </div>
    );
  }

  /* ---------- Bản nháp rỗng ---------- */
  if (draft.milestones.length === 0) {
    return (
      <div className="gai-planner-card gai-planner-card--empty">
        <div className="gai-planner-card-head">
          <span
            className="material-symbols-outlined gai-planner-card-icon"
            aria-hidden="true"
          >
            account_tree
          </span>
          <h2 className="gai-planner-card-title">Plan</h2>
        </div>
        <p className="gai-planner-card-sub">
          The AI replied, but it did not produce any milestones, tasks or
          assignees to review. Generate the plan again — or type what you want
          changed and press Update plan.
        </p>
      </div>
    );
  }

  /* ---------- Bản nháp đầy đủ ---------- */
  return (
    <div className="gai-planner-card gai-planner-card--draft" ref={rootRef}>
      <div className="gai-planner-card-head">
        <span
          className="material-symbols-outlined gai-planner-card-icon gai-planner-card-icon--primary"
          aria-hidden="true"
        >
          account_tree
        </span>
        <h2 className="gai-planner-card-title">
          {draft.applied ? "Plan applied to the group" : "Review this plan"}
        </h2>
        <span className="gai-planner-card-meta">
          {fmtMinutes(draft.totalEstimatedMinutes)} estimated
        </span>
      </div>

      {draft.applied && (
        <div className="gai-planner-applied-chip">
          <span className="material-symbols-outlined" aria-hidden="true">
            check_circle
          </span>
          Applied to the group
        </div>
      )}

      {draft.warnings.length > 0 && (
        <div className="gai-draft-warnings">
          {draft.warnings.map((w, i) => (
            <span key={i} className="gai-draft-warning">
              <span className="material-symbols-outlined" aria-hidden="true">
                warning
              </span>
              {w}
            </span>
          ))}
        </div>
      )}

      {draft.milestones.map((ms, mi) => (
        <div key={ms.key} className="gai-milestone">
          <div className="gai-milestone-head">
            <span className="gai-milestone-index">{mi + 1}</span>
            <input
              className="gai-input"
              value={ms.title}
              onChange={(e) => onPatchMilestone(ms.key, { title: e.target.value })}
              disabled={applying || draft.applied}
              aria-label={`Milestone ${mi + 1} name`}
            />
            <input
              type="date"
              className="gai-input"
              value={ms.deadline}
              onChange={(e) =>
                onPatchMilestone(ms.key, { deadline: e.target.value })
              }
              disabled={applying || draft.applied}
              aria-label={`Milestone ${mi + 1} deadline`}
            />
          </div>

          {ms.reason && <p className="gai-milestone-reason">{ms.reason}</p>}

          <div className="gai-tasks">
            {ms.tasks.map((t) => (
              <div key={t.key} className="gai-task">
                <div className="gai-task-head">
                  <span className="gai-task-title">{t.title}</span>
                  {t.domainName && (
                    <span className="gai-domain">{t.domainName}</span>
                  )}
                </div>

                <div className="gai-task-fields">
                  <div className="gai-field">
                    <label className="gai-field-label">Task name</label>
                    <input
                      className="gai-input"
                      value={t.title}
                      onChange={(e) =>
                        onPatchTask(ms.key, t.key, { title: e.target.value })
                      }
                      disabled={applying || draft.applied}
                    />
                  </div>

                  <div className="gai-field">
                    <label className="gai-field-label">Estimate (min)</label>
                    <input
                      type="number"
                      min={0}
                      step={15}
                      className="gai-input"
                      value={t.estimatedMinutes}
                      onChange={(e) =>
                        onPatchTask(ms.key, t.key, {
                          estimatedMinutes: e.target.value,
                        })
                      }
                      disabled={applying || draft.applied}
                    />
                  </div>

                  <div className="gai-field">
                    <label className="gai-field-label">Assignee</label>
                    <select
                      className="gai-select"
                      value={t.assigneeId ?? ""}
                      onChange={(e) =>
                        onPatchTask(ms.key, t.key, {
                          assigneeId: e.target.value || null,
                        })
                      }
                      disabled={applying || draft.applied}
                    >
                      <option value="">Unassigned</option>
                      {/*
                       * Người AI gợi ý KHÔNG còn trong nhóm → thêm option riêng.
                       */}
                      {t.assigneeId &&
                        !assignable.some((m) => m.userId === t.assigneeId) && (
                          <option value={t.assigneeId}>
                            Former member (no longer in this group)
                          </option>
                        )}
                      {assignable.map((m) => {
                        const isSuggested =
                          t.suggestedAssigneeId === m.userId &&
                          t.assigneeId === m.userId;
                        const role = (m.role ?? "").toLowerCase();
                        const roleLabel =
                          role === "leader" ? "Leader" : "Member";
                        return (
                          <option key={m.userId} value={m.userId}>
                            {m.fullName} · {roleLabel}
                            {isSuggested ? " · AI pick" : ""}
                          </option>
                        );
                      })}
                    </select>
                    {t.suggestedAssigneeId &&
                      t.assigneeId !== t.suggestedAssigneeId && (
                        <button
                          type="button"
                          className="gai-ai-pick-btn"
                          onClick={() =>
                            onPatchTask(ms.key, t.key, {
                              assigneeId: t.suggestedAssigneeId,
                            })
                          }
                          disabled={applying || draft.applied}
                          title="Use the person AI suggested for this task"
                        >
                          <span
                            className="material-symbols-outlined"
                            aria-hidden="true"
                          >
                            auto_awesome
                          </span>
                          Use AI's pick
                        </button>
                      )}
                  </div>
                </div>

                {t.assigneeReason && (
                  <p className="gai-task-reason">{t.assigneeReason}</p>
                )}

                {t.subtasks.length > 0 && (
                  <div className="gai-subtasks">
                    {t.subtasks.map((st, si) => (
                      <div key={si} className="gai-subtask">
                        <span className="gai-subtask-name">{st.title}</span>
                        <span className="gai-subtask-est">
                          {fmtMinutes(Number(st.estimatedMinutes) || 0)}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      ))}

      {/* ---------- Lỗi / xung đột ---------- */}
      {error && (
        <div className="gai-planner-error" role="alert">
          <span className="material-symbols-outlined" aria-hidden="true">
            error_outline
          </span>
          <span>{error}</span>
        </div>
      )}

      {busyConflict && (
        <div className="gai-planner-conflict">
          <p>
            <strong>"{busyConflict.title}"</strong> conflicts with the
            assignee&apos;s fixed time. Assign it anyway?
          </p>
          <div className="gai-planner-conflict-actions">
            <button
              type="button"
              className="gai-btn gai-btn--primary gai-btn--sm"
              onClick={onConfirmConflicts}
              disabled={applying}
            >
              Assign anyway
            </button>
            <button
              type="button"
              className="gai-btn gai-btn--ghost gai-btn--sm"
              onClick={onDismissConflict}
              disabled={applying}
            >
              Pick someone else
            </button>
          </div>
        </div>
      )}

      {/* ---------- Nút Áp dụng ---------- */}
      <div className="gai-draft-actions">
        <span className="gai-draft-summary">
          <span className="material-symbols-outlined" aria-hidden="true">
            flag
          </span>
          {draft.milestones.length}{" "}
          {draft.milestones.length === 1 ? "milestone" : "milestones"}
          <span className="gai-draft-summary-sep">·</span>
          <span className="material-symbols-outlined" aria-hidden="true">
            checklist
          </span>
          {taskCount} {taskCount === 1 ? "task" : "tasks"}
          {subtaskCount > 0 && (
            <>
              <span className="gai-draft-summary-sep">·</span>
              <span className="material-symbols-outlined" aria-hidden="true">
                account_tree
              </span>
              {subtaskCount} {subtaskCount === 1 ? "subtask" : "subtasks"}
            </>
          )}
        </span>
        <button
          type="button"
          className="gai-btn gai-btn--primary gai-apply-btn"
          onClick={onApply}
          disabled={applying || draft.applied}
        >
          <span className="material-symbols-outlined" aria-hidden="true">
            {applying ? "progress_activity" : "check"}
          </span>
          {applying
            ? "Applying…"
            : draft.applied
              ? "Applied to the group"
              : "Apply to group"}
        </button>
        {!draft.applied && (
          <button
            type="button"
            className="gai-btn gai-btn--ghost gai-btn--sm"
            onClick={onRestore}
            disabled={applying}
            title="Discard your edits and use the AI's original plan"
          >
            <span className="material-symbols-outlined" aria-hidden="true">
              undo
            </span>
            Restore
          </button>
        )}
      </div>
    </div>
  );
});
