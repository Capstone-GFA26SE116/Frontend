import { useCallback, useEffect, useState } from "react";
import type { ApiErr } from "../../lib/api-client";
import { deleteScheduleSlot } from "../../lib/api-client";
import {
  createGroupScheduleSlot,
  listGroupScheduleSlots,
  type GroupScheduleSlotDto,
} from "../../lib/group-api";
import { fmtGroupDateTime, fmtMinutes } from "./group-logic";
import {
  type GroupErrorDetails,
  type GroupErrorView,
  rawServerMessage,
  toGroupErrorDetails,
  toGroupErrorView,
} from "./group-errors";
import { GroupErrorDialog } from "./GroupErrorDialog";
import "./group-slots.css";

/**
 * ===========================================================
 * <GroupScheduleSlots> — quản lý khung giờ của 1 việc nhóm.
 * ===========================================================
 *
 * Mục 10 của cập nhật BE:
 *  - `POST /api/group-tasks/{taskId}/schedule-slots` → tạo slot nhóm.
 *  - `GET  /api/group-tasks/{taskId}/schedule-slots` → xem slot của việc.
 *  - Sửa / hủy slot nhóm dùng CHUNG `PUT` + `DELETE /api/schedule-slots/{id}`.
 *
 * ⚠️ Slot nhóm cũng bị luật không chồng giờ: BE trả `409 SLOT_OVERLAP` với
 * `details.overlaps[]` — phần tử có `groupTaskId` khi bên chồng là slot
 * nhóm. Ta bắt lỗi này và hiện hộp thoại tiếng Anh giải thích rõ.
 *
 * Giao diện theo DESIGN.md: canvas #101010 · hairline #3d3a39 ·
 * accent #00d992 · card radius 8px · button radius 6px.
 */

export interface GroupScheduleSlotsProps {
  /** Id của việc nhóm (group task). */
  groupTaskId: string;
  /** Tên việc nhóm — hiện trên tiêu đề modal. */
  taskTitle: string;
  /** Tên nhóm — hiện phụ đề modal. */
  groupName?: string | null;
  /** Danh sách việc con để chọn slot gắn vào việc con nào. */
  subTasks?: Array<{ id: string; title: string }>;
  /** Người được giao — mặc định gán slot cho họ. */
  assigneeId?: string | null;
  /** Người đang đăng nhập — chỉ họ mới được tạo/hủy slot của mình. */
  currentUserId?: string | null;
  /** Đã archive nhóm → không cho tạo slot mới. */
  archived?: boolean;
  /** Người dùng có quyền quản lý slot của việc này không. */
  canManage?: boolean;
  /** Gọi lại sau khi slot thay đổi (để BE/focus đồng bộ). */
  onChanged?: () => void;
  /** Báo lỗi ra ngoài (hộp thoại dùng chung của trang nhóm). */
  onError?: (payload: {
    view: GroupErrorView;
    details: GroupErrorDetails;
    raw: string;
  }) => void;
}

/** Trạng thái slot → nhãn tiếng Anh. */
function slotStatusLabel(status: string): string {
  const s = (status ?? "").trim().toLowerCase();
  if (s === "proposed") return "Proposed";
  if (s === "approved") return "Approved";
  if (s === "done") return "Done";
  if (s === "skipped") return "Skipped";
  if (s === "missed") return "Missed";
  if (s === "cancelled") return "Cancelled";
  return status || "—";
}

/** Trạng thái slot → tone màu (theo `taskStatusLabel` của nhóm). */
function slotStatusTone(status: string): string {
  const s = (status ?? "").trim().toLowerCase();
  if (s === "done") return "done";
  if (s === "approved") return "active";
  if (s === "proposed") return "todo";
  if (s === "skipped" || s === "cancelled" || s === "missed") return "skipped";
  return "muted";
}

/** Slot đã huỷ / bỏ lỡ → không Start được nữa. */
function isSlotClosed(status: string): boolean {
  const s = (status ?? "").trim().toLowerCase();
  return s === "cancelled" || s === "skipped" || s === "done";
}

export function GroupScheduleSlots({
  groupTaskId,
  taskTitle,
  groupName,
  subTasks = [],
  assigneeId,
  currentUserId,
  archived = false,
  canManage = false,
  onChanged,
  onError,
}: GroupScheduleSlotsProps) {
  const [slots, setSlots] = useState<GroupScheduleSlotDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [formOpen, setFormOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [form, setForm] = useState({
    start: "",
    end: "",
    subTaskId: "",
    explanation: "",
  });

  /** Hộp thoại lỗi nội bộ (khi trang không truyền `onError`). */
  const [localError, setLocalError] = useState<{
    view: GroupErrorView;
    details: GroupErrorDetails;
    raw: string;
  } | null>(null);

  const reportError = useCallback(
    (res: { ok: false } & Record<string, unknown>, action?: string) => {
      const err = res as ApiErr;
      const payload = {
        view: toGroupErrorView(err, undefined, { action }),
        details: toGroupErrorDetails(err, undefined, {
          formatDate: fmtGroupDateTime,
          formatMinutes: fmtMinutes,
        }),
        raw: rawServerMessage(err, undefined),
      };
      if (onError) onError(payload);
      else setLocalError(payload);
    },
    [onError],
  );

  /** Nạp danh sách slot của việc nhóm. */
  const load = useCallback(async () => {
    if (!groupTaskId) return;
    setLoading(true);
    const res = await listGroupScheduleSlots(groupTaskId);
    setLoading(false);
    if (!res.ok) {
      setSlots([]);
      return;
    }
    setSlots(res.data ?? []);
  }, [groupTaskId]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- data-fetch pattern
    void load();
  }, [load]);

  /** Mở form tạo slot. */
  function openForm() {
    setForm({
      start: "",
      end: "",
      subTaskId: "",
      explanation: "",
    });
    setFormError(null);
    setFormOpen(true);
  }

  /** Tạo slot mới. */
  async function handleCreate(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const start = form.start;
    const end = form.end;
    if (!start || !end) {
      setFormError("Pick a start time and an end time for this slot.");
      return;
    }
    const startMs = new Date(start).getTime();
    const endMs = new Date(end).getTime();
    if (Number.isNaN(startMs) || Number.isNaN(endMs)) {
      setFormError("That time isn't valid. Pick it again.");
      return;
    }
    if (endMs <= startMs) {
      setFormError("The end time has to be after the start time.");
      return;
    }

    setSaving(true);
    setFormError(null);
    const res = await createGroupScheduleSlot(groupTaskId, {
      startTime: new Date(startMs).toISOString(),
      endTime: new Date(endMs).toISOString(),
      groupSubTaskId: form.subTaskId || null,
      explanation: form.explanation.trim() || null,
      isManualOverride: true,
    });
    setSaving(false);

    if (!res.ok) {
      /*
       * 409 SLOT_OVERLAP — khung giờ chồng slot đã có (có thể là slot của
       * việc nhóm khác, `details.overlaps[]` có `groupTaskId`).
       *
       * Ta hiện hộp thoại tiếng Anh liệt kê các khung giờ đang bị chồng.
       */
      reportError(res, "schedule this time slot");
      return;
    }

    setFormOpen(false);
    await load();
    onChanged?.();
  }

  /** Hủy 1 slot nhóm (dùng chung `DELETE /api/schedule-slots/{id}`). */
  async function handleCancel(slotId: string) {
    const res = await deleteScheduleSlot(slotId);
    if (!res.ok) {
      reportError(res, "cancel this time slot");
      return;
    }
    await load();
    onChanged?.();
  }

  /*
   * Ai được quản lý slot?
   *  - Leader: mọi slot của việc.
   *  - Member được giao việc: slot của chính mình (theo `assigneeId`).
   *  - Người khác: chỉ xem.
   */
  const canEditSlot = (slot: GroupScheduleSlotDto): boolean => {
    if (archived) return false;
    if (canManage) return true;
    const owner = slot.userId ?? assigneeId ?? null;
    return !!owner && !!currentUserId && owner === currentUserId;
  };

  return (
    <div className="gsl">
      {/* ---------- Tiêu đề + nút thêm ---------- */}
      <div className="gsl-head">
        <h4 className="gdt-sub-title">
          Schedule
          <span className="gdt-sub-count">{slots.length}</span>
        </h4>
        {!archived && (canManage || (assigneeId && assigneeId === currentUserId)) && (
          <button
            type="button"
            className="gdt-btn gdt-btn--ghost gdt-btn--sm"
            onClick={openForm}
          >
            <span className="material-symbols-outlined gdt-btn-icon">
              add
            </span>
            <span>Add slot</span>
          </button>
        )}
      </div>

      {/* ---------- Danh sách slot ---------- */}
      {loading ? (
        <p className="gdt-empty">Loading schedule slots…</p>
      ) : slots.length === 0 ? (
        <p className="gdt-empty">
          No time slots yet. Add one so this work shows up on everyone's
          calendar.
        </p>
      ) : (
        <ul className="gsl-list">
          {slots.map((s) => {
            const tone = slotStatusTone(s.status);
            const closed = isSlotClosed(s.status);
            return (
              <li
                key={s.id}
                className={`gsl-item${closed ? " gsl-item--closed" : ""}`}
              >
                <div className="gsl-item-main">
                  <span className={`gdt-status gdt-status--${tone} gdt-status--sm`}>
                    {slotStatusLabel(s.status)}
                  </span>
                  <span className="gsl-time">
                    <span className="material-symbols-outlined gdt-btn-icon">
                      schedule
                    </span>
                    {fmtGroupDateTime(s.startTime)} →{" "}
                    {fmtGroupDateTime(s.endTime)}
                  </span>
                  {s.proposedMinutes > 0 && (
                    <span className="gsl-dur">{fmtMinutes(s.proposedMinutes)}</span>
                  )}
                </div>
                <div className="gsl-item-meta">
                  {s.groupSubTaskId && (
                    <span className="gsl-chip">
                      Subtask
                      {subTasks.find((x) => x.id === s.groupSubTaskId)?.title
                        ? ` · ${subTasks.find((x) => x.id === s.groupSubTaskId)?.title}`
                        : ""}
                    </span>
                  )}
                  {s.explanation && <span className="gsl-note">{s.explanation}</span>}
                </div>
                {canEditSlot(s) && (
                  <button
                    type="button"
                    className="gdt-icon-btn gdt-icon-btn--sm"
                    title="Cancel this slot"
                    aria-label="Cancel this slot"
                    onClick={() => void handleCancel(s.id)}
                  >
                    <span className="material-symbols-outlined">close</span>
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {/* ---------- Modal tạo slot ---------- */}
      {formOpen && (
        <div
          className="gdt-modal-backdrop"
          onClick={() => setFormOpen(false)}
          role="presentation"
        >
          <div
            className="gdt-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="gsl-modal-title"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="gdt-modal-head">
              <h2 id="gsl-modal-title" className="gdt-modal-title">
                <span
                  className="material-symbols-outlined gdt-modal-title-icon"
                  aria-hidden="true"
                >
                  event_available
                </span>
                Add a time slot
              </h2>
              <button
                type="button"
                className="gdt-modal-close"
                onClick={() => setFormOpen(false)}
                aria-label="Close"
              >
                <span className="material-symbols-outlined">close</span>
              </button>
            </div>

            <div className="gdt-modal-sub">
              {taskTitle}
              {groupName ? ` · ${groupName}` : ""}
            </div>

            <form className="gdt-form" onSubmit={handleCreate}>
              <div className="gdt-field-row">
                <div className="gdt-field">
                  <label className="gdt-label" htmlFor="gsl-start">
                    Starts
                  </label>
                  <input
                    id="gsl-start"
                    type="datetime-local"
                    className="gdt-input"
                    value={form.start}
                    onChange={(e) =>
                      setForm((f) => ({ ...f, start: e.target.value }))
                    }
                    required
                  />
                </div>
                <div className="gdt-field">
                  <label className="gdt-label" htmlFor="gsl-end">
                    Ends
                  </label>
                  <input
                    id="gsl-end"
                    type="datetime-local"
                    className="gdt-input"
                    value={form.end}
                    onChange={(e) =>
                      setForm((f) => ({ ...f, end: e.target.value }))
                    }
                    required
                  />
                </div>
              </div>

              {subTasks.length > 0 && (
                <div className="gdt-field">
                  <label className="gdt-label" htmlFor="gsl-sub">
                    Subtask (optional)
                  </label>
                  <select
                    id="gsl-sub"
                    className="gdt-select"
                    value={form.subTaskId}
                    onChange={(e) =>
                      setForm((f) => ({ ...f, subTaskId: e.target.value }))
                    }
                  >
                    <option value="">Whole task</option>
                    {subTasks.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.title}
                      </option>
                    ))}
                  </select>
                </div>
              )}

              <div className="gdt-field">
                <label className="gdt-label" htmlFor="gsl-note">
                  Note (optional)
                </label>
                <textarea
                  id="gsl-note"
                  rows={2}
                  maxLength={500}
                  className="gdt-input gdt-input--textarea"
                  placeholder="Why is this time booked?"
                  value={form.explanation}
                  onChange={(e) =>
                    setForm((f) => ({ ...f, explanation: e.target.value }))
                  }
                />
              </div>

              {formError && (
                <p className="gdt-form-error">
                  <span
                    className="material-symbols-outlined"
                    aria-hidden="true"
                  >
                    error
                  </span>
                  {formError}
                </p>
              )}

              <div className="gdt-form-actions">
                <button
                  type="button"
                  className="gdt-btn gdt-btn--ghost"
                  onClick={() => setFormOpen(false)}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="gdt-btn gdt-btn--primary"
                  disabled={saving}
                >
                  {saving ? "Saving…" : "Add slot"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ---------- Hộp thoại lỗi nội bộ ---------- */}
      {onError ? null : (
        <GroupErrorDialog
          error={localError?.view ?? null}
          details={localError?.details ?? null}
          rawMessage={localError?.raw || undefined}
          onClose={() => setLocalError(null)}
        />
      )}
    </div>
  );
}
