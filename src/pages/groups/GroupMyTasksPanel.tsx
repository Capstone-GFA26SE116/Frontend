import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  createGroupComment,
  getCurrentGroupFocus,
  getGroupTaskTime,
  listGroupComments,
  listGroupScheduleSlots,
  listGroupSubTasks,
  startGroupFocus,
  stopGroupFocus,
  type GroupCommentDto,
  type GroupFocusCurrentDto,
  type GroupFocusStopReason,
  type GroupScheduleSlotDto,
  type GroupSubTaskDto,
  type GroupTaskDto,
  type GroupTaskTimeDto,
} from "../../lib/group-api";
import type { ApiErr } from "../../lib/api-client";
import {
  fmtGroupDateTime,
  fmtMinutes,
  isOpenGroupTask,
  priorityLabel,
  priorityTone,
  taskStatusLabel,
} from "./group-logic";
import { GroupErrorDialog } from "./GroupErrorDialog";
import { GroupStopReasonDialog } from "./GroupStopReasonDialog";
import {
  type GroupErrorDetails,
  type GroupErrorView,
  rawServerMessage,
  toGroupErrorDetails,
  toGroupErrorView,
} from "./group-errors";
import "./my-group-tasks.css";

/* ===========================================================
 * <GroupMyTasksPanel> — tab "My tasks" của trang chi tiết nhóm
 * ===========================================================
 *
 * Hiển thị các việc **của tôi** trong nhóm hiện tại, kèm nút "Start"
 * (bấm giờ):
 *   - Việc CÓ slot nhóm → mở hộp thoại chọn slot → gửi `scheduleSlotId`.
 *   - Việc KHÔNG có slot → gọi thẳng `POST /api/group-tasks/{id}/focus/start`.
 *
 * ⚠️ BE bắt buộc `subTaskId` khi việc CÓ việc con (400 nếu thiếu) →
 * hộp thoại cũng cho chọn việc con.
 *
 * API:
 *  - GET  /api/group-tasks/{id}/subtasks
 *  - GET  /api/group-tasks/{id}/schedule-slots
 *  - GET  /api/group-focus/current
 *  - POST /api/group-tasks/{id}/focus/start
 *  - POST /api/group-focus/{sessionId}/stop
 * =========================================================== */

/** Chu kỳ resync đồng hồ về server (ms). */
const RESYNC_MS = 20_000;

/**
 * Slot đã huỷ / bỏ lỡ / xong → không chọn được khi bấm Start.
 */
function isClosedSlotStatus(status: string): boolean {
  const s = (status ?? "").trim().toLowerCase();
  return s === "cancelled" || s === "skipped" || s === "done";
}

/** Định dạng giây → "HH:MM:SS" (đồng hồ phiên làm việc). */
function fmtElapsedSeconds(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(h)}:${pad(m)}:${pad(sec)}`;
}

export function GroupMyTasksPanel({
  groupId,
  tasks,
  onTaskStatusChange,
}: {
  /** Id của nhóm đang xem. */
  groupId: string;
  /** Việc **của tôi** trong nhóm (cha đã lọc sẵn ở trang cha). */
  tasks: GroupTaskDto[];
  /**
   * Báo lên trang cha khi status của việc vừa đổi (sau khi Stop phiên) →
   * trang cha patch vào state `tasks` để cả tab "Tasks" và "My tasks" cập
   * nhật ngay, không phải reload trang.
   */
  onTaskStatusChange?: (taskId: string, status: string) => void;
}) {
  /* ---------- Slot của từng việc ---------- */
  const [slotsByTask, setSlotsByTask] = useState<
    Record<string, GroupScheduleSlotDto[]>
  >({});

  /** Việc con của từng việc: `groupTaskId -> subTask[]`. */
  const [subsByTask, setSubsByTask] = useState<
    Record<string, GroupSubTaskDto[]>
  >({});

  /* ---------- Phiên đang chạy ---------- */
  const [current, setCurrent] = useState<GroupFocusCurrentDto | null>(null);
  const [starting, setStarting] = useState(false);
  const [stopping, setStopping] = useState(false);

  /**
   * Đồng hồ đếm ngược của phiên đang chạy.
   *
   * `anchorRef` giữ mốc (elapsed, thời điểm) → tick 1s cộng thêm `drift`
   * để đồng hồ mượt (không bị nhảy theo mỗi lần resync 20s từ server).
   */
  const [elapsed, setElapsed] = useState(0);
  const anchorRef = useRef<{ elapsed: number; at: number } | null>(null);

  /* ---------- Hộp thoại chọn lý do dừng ---------- */
  /** Hộp thoại lý do dừng đang mở? */
  const [stopDialogOpen, setStopDialogOpen] = useState(false);
  /** Lỗi khi gửi Stop (400 từ BE) — hiển thị trong hộp thoại. */
  const [stopError, setStopError] = useState<string | null>(null);

  /* ---------- Hộp thoại chọn slot + việc con ---------- */
  const [pickerFor, setPickerFor] = useState<string | null>(null);
  const [slotPickerValue, setSlotPickerValue] = useState("");
  const [subPickerValue, setSubPickerValue] = useState("");

  /* ---------- Hộp thoại lỗi (tiếng Anh) ---------- */
  const [errorDialog, setErrorDialog] = useState<{
    view: GroupErrorView;
    details: GroupErrorDetails;
    raw: string;
  } | null>(null);

  /**
   * Hiện việc đã xong / bị bỏ qua không?
   *
   * Mặc định TẮT → tab "My tasks" chỉ hiện việc **đang mở** (ToDo /
   * InProgress), tránh lẫn task cũ đã xong.
   */
  const [showClosed, setShowClosed] = useState(false);

  /* ---------- Hộp thoại chi tiết việc ---------- */
  /** Id việc đang mở trong modal chi tiết. */
  const [detailFor, setDetailFor] = useState<string | null>(null);
  /** Bình luận của việc đang mở. */
  const [detailComments, setDetailComments] = useState<GroupCommentDto[]>([]);
  /** Thống kê thời gian đã dành cho việc. */
  const [detailTime, setDetailTime] = useState<GroupTaskTimeDto | null>(null);
  /** Nội dung bình luận đang soạn. */
  const [detailDraft, setDetailDraft] = useState("");
  /** Đang tải dữ liệu modal. */
  const [detailLoading, setDetailLoading] = useState(false);

  /** Việc hiển thị theo bộ lọc "đóng" của người dùng. */
  const visibleTasks = useMemo(
    () =>
      showClosed ? tasks : tasks.filter((t) => isOpenGroupTask(t.status)),
    [tasks, showClosed],
  );

  const showApiError = useCallback(
    (res: { ok: false } & Record<string, unknown>, action?: string) => {
      const err = res as ApiErr;
      setErrorDialog({
        view: toGroupErrorView(err, undefined, { action }),
        details: toGroupErrorDetails(err, undefined, {
          formatDate: fmtGroupDateTime,
          formatMinutes: fmtMinutes,
        }),
        raw: rawServerMessage(err, undefined),
      });
    },
    [],
  );

  /* ---------- Nạp slot + việc con của các việc ---------- */
  const loadDetails = useCallback(async (taskIds: string[]) => {
    const slotMap: Record<string, GroupScheduleSlotDto[]> = {};
    const subMap: Record<string, GroupSubTaskDto[]> = {};
    for (const id of taskIds) {
      const [sRes, subRes] = await Promise.all([
        listGroupScheduleSlots(id),
        listGroupSubTasks(id),
      ]);
      if (sRes.ok) slotMap[id] = sRes.data ?? [];
      if (subRes.ok) subMap[id] = subRes.data ?? [];
    }
    setSlotsByTask((prev) => ({ ...prev, ...slotMap }));
    setSubsByTask((prev) => ({ ...prev, ...subMap }));
  }, []);

  useEffect(() => {
    if (tasks.length === 0) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- data-fetch pattern
    void loadDetails(tasks.map((t) => t.id));
  }, [tasks, loadDetails]);

  /* ---------- Phiên đang chạy ---------- */
  const refreshCurrent = useCallback(async () => {
    const res = await getCurrentGroupFocus();
    if (!res.ok) return;
    const data = res.data ?? null;
    setCurrent(data);
    if (data) {
      anchorRef.current = {
        elapsed: data.elapsedSeconds,
        at: performance.now(),
      };
      setElapsed(data.elapsedSeconds);
    } else {
      anchorRef.current = null;
      setElapsed(0);
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- data-fetch pattern
    void refreshCurrent();
    const t = window.setInterval(() => {
      void refreshCurrent();
    }, RESYNC_MS);
    return () => window.clearInterval(t);
  }, [refreshCurrent]);

  /* ---------- Tick 1s → đồng hồ chạy mượt ---------- */
  useEffect(() => {
    const t = window.setInterval(() => {
      const a = anchorRef.current;
      if (!a) return;
      const drift = (performance.now() - a.at) / 1000;
      setElapsed(Math.max(0, Math.floor(a.elapsed + drift)));
    }, 1_000);
    return () => window.clearInterval(t);
  }, []);

  /* ---------- Bắt đầu phiên làm việc ---------- */
  async function handleStart(
    task: GroupTaskDto,
    subTaskId?: string | null,
    scheduleSlotId?: string | null,
  ) {
    setStarting(true);
    const res = await startGroupFocus(task.id, {
      subTaskId: subTaskId ?? null,
      scheduleSlotId: scheduleSlotId ?? null,
    });
    setStarting(false);
    if (!res.ok) {
      showApiError(res, "start this focus session");
      return;
    }

    /*
     * Cập nhật status ngay — không chờ reload trang.
     * BE đổi việc con `ToDo` → `InProgress` (việc cha tự suy lại) → patch
     * ngay vào state của trang cha.
     */
    const startedStatus = res.data?.taskStatus;
    if (startedStatus) {
      onTaskStatusChange?.(task.id, String(startedStatus));
    }

    await refreshCurrent();
  }

  /* ---------- Dừng phiên làm việc ---------- */
  /**
   * Mở hộp thoại chọn lý do dừng.
   *
   * Phiên KHÔNG bị dừng ngay khi bấm nút "Stop" — người dùng phải chọn
   * `stopReason` (`Completed` / `Interrupted` / `Blocked` / `Other`) trước.
   */
  function openStopDialog() {
    setStopDialogOpen(true);
  }

  /** Gửi lý do dừng + ghi chú lên BE. */
  async function handleStop(
    reason: GroupFocusStopReason,
    note: string | null,
  ) {
    if (!current) return;
    setStopping(true);
    const res = await stopGroupFocus(current.sessionId, {
      stopReason: reason,
      note,
    });
    setStopping(false);
    if (!res.ok) {
      if (res.status === 409) {
        setStopDialogOpen(false);
        await refreshCurrent();
        return;
      }
      setStopError("Could not stop the session. Please try again.");
      return;
    }
    setStopDialogOpen(false);
    setStopError(null);

    /*
     * Cập nhật status ngay — không chờ reload trang.
     *
     * BE trả về `taskStatus` / `subTaskStatus` sau khi Stop → đẩy lên cho
     * trang cha để patch vào state `tasks` (áp dụng cho cả tab "Tasks").
     */
    const stoppedTaskId = current.groupTaskId;
    const newStatus = res.data?.taskStatus;
    if (newStatus) {
      onTaskStatusChange?.(stoppedTaskId, String(newStatus));
    }

    // Nạp lại slot + việc con của việc vừa dừng (slot có thể chuyển Done).
    await loadDetails([stoppedTaskId]);

    await refreshCurrent();
  }

  /* ---------- Mở hộp thoại chọn slot / việc con ---------- */
  function openPicker(task: GroupTaskDto) {
    setPickerFor(task.id);
    const upcoming = (slotsByTask[task.id] ?? [])
      .filter((s) => !isClosedSlotStatus(s.status))
      .sort(
        (a, b) =>
          new Date(a.startTime).getTime() - new Date(b.startTime).getTime(),
      );
    setSlotPickerValue(upcoming[0]?.id ?? "");
    // Mặc định chọn việc con đầu tiên (BE bắt buộc `subTaskId` nếu có con).
    setSubPickerValue((subsByTask[task.id] ?? [])[0]?.id ?? "");
  }

  const pickerTask = useMemo(
    () => tasks.find((t) => t.id === pickerFor) ?? null,
    [tasks, pickerFor],
  );
  const pickerSubs = useMemo(
    () => (pickerFor ? (subsByTask[pickerFor] ?? []) : []),
    [subsByTask, pickerFor],
  );

  /** Việc đang xem trong modal chi tiết. */
  const detailTask = useMemo(
    () => tasks.find((t) => t.id === detailFor) ?? null,
    [tasks, detailFor],
  );

  /** Việc con của việc đang xem trong modal chi tiết. */
  const detailSubs = useMemo(
    () => (detailFor ? (subsByTask[detailFor] ?? []) : []),
    [subsByTask, detailFor],
  );

  /** Slot lịch của việc đang xem trong modal chi tiết. */
  const detailSlots = useMemo(
    () =>
      (detailFor ? (slotsByTask[detailFor] ?? []) : [])
        .slice()
        .sort(
          (a, b) =>
            new Date(a.startTime).getTime() - new Date(b.startTime).getTime(),
        ),
    [slotsByTask, detailFor],
  );

  /**
   * Mở modal chi tiết việc — nạp bình luận + thống kê thời gian.
   */
  const openDetail = useCallback(async (task: GroupTaskDto) => {
    setDetailFor(task.id);
    setDetailComments([]);
    setDetailTime(null);
    setDetailDraft("");
    setDetailLoading(true);
    const [cRes, tRes] = await Promise.all([
      listGroupComments(task.id),
      getGroupTaskTime(task.id),
    ]);
    if (cRes.ok) setDetailComments(cRes.data ?? []);
    if (tRes.ok) setDetailTime(tRes.data ?? null);
    setDetailLoading(false);
  }, []);

  /** Đóng modal chi tiết. */
  const closeDetail = useCallback(() => {
    setDetailFor(null);
    setDetailComments([]);
    setDetailTime(null);
    setDetailDraft("");
  }, []);

  /** Gửi bình luận mới cho việc đang mở. */
  async function handleSendComment() {
    const content = detailDraft.trim();
    if (!detailFor || !content) return;
    const res = await createGroupComment(detailFor, { content });
    if (!res.ok) {
      showApiError(res, "post this comment");
      return;
    }
    setDetailComments((prev) => [...prev, res.data]);
    setDetailDraft("");
  }

  return (
    <>
      {/* ---------- Danh sách việc của tôi ---------- */}
      {tasks.length === 0 ? (
        <div className="mgt-state">
          <span className="material-symbols-outlined mgt-state-icon">
            task_alt
          </span>
          <p>No tasks are assigned to you in this group yet.</p>
        </div>
      ) : (
        <>
          {/* Bộ lọc: mặc định chỉ hiện việc đang mở. */}
          <label className="mgt-check">
            <input
              type="checkbox"
              checked={showClosed}
              onChange={(e) => setShowClosed(e.target.checked)}
            />
            <span>
              Show closed tasks ({tasks.length - visibleTasks.length})
            </span>
          </label>

          {visibleTasks.length === 0 ? (
            <div className="mgt-state">
              <span className="material-symbols-outlined mgt-state-icon">
                task_alt
              </span>
              <p>
                All your tasks in this group are done. Turn on "Show closed
                tasks" to see them again.
              </p>
            </div>
          ) : (
            <ul className="mgt-task-list">
              {visibleTasks.map((task) => {
            const st = taskStatusLabel(task.status);
            const runningHere =
              current && current.groupId === groupId &&
              current.groupTaskId === task.id
                ? current
                : null;
            const slots = (slotsByTask[task.id] ?? []).filter(
              (s) => !isClosedSlotStatus(s.status),
            );
            const subs = subsByTask[task.id] ?? [];
            /**
             * Việc đã xong / bị bỏ qua → việc CŨ → không cho bấm giờ.
             * (Dùng chung luật với `canSuggestTimes` trong `group-logic.ts`.)
             */
            const isOpen = isOpenGroupTask(task.status);

            return (
              <li key={task.id} className="mgt-task">
                {/*
                  ⚠️ Cấu trúc PHẢI khớp `.mgt-task-head > (.mgt-task-main | .mgt-task-actions)`
                  như trang `/my-group-tasks` — nếu đặt `.mgt-task-meta` / `.mgt-task-actions`
                  ra ngoài `.mgt-task-head` thì layout vỡ (card bị dẹp, nút lệch).
                */}
                <div className="mgt-task-head">
                  <div
                    className="mgt-task-main mgt-task-main--clickable"
                    onClick={() => void openDetail(task)}
                  >
                    <button
                      type="button"
                      className="mgt-task-title-btn"
                      onClick={(e) => {
                        e.stopPropagation();
                        void openDetail(task);
                      }}
                      title="Open task details"
                    >
                      <span className="mgt-task-title">{task.title}</span>
                    </button>
                    <div className="mgt-task-tags">
                      <span className={`mgt-status mgt-status--${st.tone}`}>
                        {st.label}
                      </span>
                      <span
                        className={`mgt-priority mgt-priority--${priorityTone(task.priority)}`}
                      >
                        {priorityLabel(task.priority)}
                      </span>
                    </div>
                    <div className="mgt-task-meta">
                      {task.deadline && (
                        <span className="mgt-task-meta-item">
                          <span
                            className="material-symbols-outlined"
                            aria-hidden="true"
                          >
                            event
                          </span>
                          Deadline {fmtGroupDateTime(task.deadline)}
                        </span>
                      )}
                      {task.fixedStart && task.fixedEnd && (
                        <span className="mgt-task-meta-item mgt-task-meta-item--fixed">
                          <span
                            className="material-symbols-outlined"
                            aria-hidden="true"
                          >
                            lock_clock
                          </span>
                          {fmtGroupDateTime(task.fixedStart)} →{" "}
                          {fmtGroupDateTime(task.fixedEnd)}
                        </span>
                      )}
                      {subs.length > 0 && (
                        <span className="mgt-task-meta-item">
                          <span
                            className="material-symbols-outlined"
                            aria-hidden="true"
                          >
                            subdirectory_arrow_right
                          </span>
                          {subs.length} subtask{subs.length > 1 ? "s" : ""}
                        </span>
                      )}
                    </div>
                  </div>

                  <div className="mgt-task-actions">
                    {runningHere ? (
                      <>
                        <span className="mgt-running">
                          <span className="material-symbols-outlined mgt-running-icon" aria-hidden="true">
                            timer
                          </span>
                          {fmtElapsedSeconds(elapsed)}
                        </span>
                        <button
                          type="button"
                          className="mgt-btn mgt-btn--primary mgt-btn--sm"
                          onClick={openStopDialog}
                          disabled={stopping}
                          title="Stop this focus session"
                        >
                          <span className="material-symbols-outlined mgt-btn-icon">
                            stop_circle
                          </span>
                          <span>Stop</span>
                        </button>
                      </>
                    ) : isOpen ? (
                      <button
                        type="button"
                        className="mgt-btn mgt-btn--primary mgt-btn--sm"
                        onClick={() =>
                          slots.length > 0 || subs.length > 0
                            ? openPicker(task)
                            : void handleStart(task)
                        }
                        disabled={starting || !!current}
                        title={
                          slots.length > 0
                            ? "Start a focus session and pick a time slot"
                            : "Start a focus session"
                        }
                      >
                        <span className="material-symbols-outlined mgt-btn-icon">
                          play_arrow
                        </span>
                        <span>Start</span>
                      </button>
                    ) : (
                      <span className="mgt-task-meta-item">Closed</span>
                    )}
                  </div>
                </div>
              </li>
            );
              })}
            </ul>
          )}
        </>
      )}

      {/* ---------- Hộp thoại chọn việc con + slot ---------- */}
      {pickerFor && pickerTask && (
        <div
          className="mgt-modal-backdrop"
          onClick={() => setPickerFor(null)}
          role="presentation"
        >
          <div
            className="mgt-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="gdt-my-slot-title"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mgt-modal-head">
              <h2 id="gdt-my-slot-title" className="mgt-modal-title">
                <span
                  className="material-symbols-outlined mgt-modal-title-icon"
                  aria-hidden="true"
                >
                  event_available
                </span>
                Start this task
              </h2>
              <button
                type="button"
                className="mgt-modal-close"
                onClick={() => setPickerFor(null)}
                aria-label="Close"
              >
                <span className="material-symbols-outlined">close</span>
              </button>
            </div>

            <div className="mgt-modal-sub">{pickerTask.title}</div>

            <div className="mgt-modal-body">
              {/* ---------- Việc con (bắt buộc nếu việc có việc con) ---------- */}
              {pickerSubs.length > 0 && (
                <>
                  <p className="mgt-modal-text">
                    This task has subtasks. Pick the one you're working on.
                  </p>
                  <ul className="mgt-slot-list">
                    {pickerSubs.map((s) => {
                      const sst = taskStatusLabel(s.status);
                      return (
                        <li key={s.id}>
                          <label className="mgt-slot-option">
                            <input
                              type="radio"
                              name="gdt-my-sub"
                              value={s.id}
                              checked={subPickerValue === s.id}
                              onChange={() => setSubPickerValue(s.id)}
                            />
                            <span className="mgt-slot-option-body">
                              <span className="mgt-slot-option-time">
                                {s.title}
                              </span>
                              <span className="mgt-slot-option-meta">
                                {sst.label}
                              </span>
                            </span>
                          </label>
                        </li>
                      );
                    })}
                  </ul>
                </>
              )}

              {/* ---------- Slot ---------- */}
              {(slotsByTask[pickerFor] ?? []).some(
                (s) => !isClosedSlotStatus(s.status),
              ) && (
                <>
                  <p className="mgt-modal-text">
                    Choose which scheduled block this session belongs to. Your
                    working time is then tracked against that slot.
                  </p>

                  <ul className="mgt-slot-list">
                    {(slotsByTask[pickerFor] ?? [])
                      .filter((s) => !isClosedSlotStatus(s.status))
                      .sort(
                        (a, b) =>
                          new Date(a.startTime).getTime() -
                          new Date(b.startTime).getTime(),
                      )
                      .map((s) => (
                        <li key={s.id}>
                          <label className="mgt-slot-option">
                            <input
                              type="radio"
                              name="gdt-my-slot"
                              value={s.id}
                              checked={slotPickerValue === s.id}
                              onChange={() => setSlotPickerValue(s.id)}
                            />
                            <span className="mgt-slot-option-body">
                              <span className="mgt-slot-option-time">
                                {fmtGroupDateTime(s.startTime)} →{" "}
                                {fmtGroupDateTime(s.endTime)}
                              </span>
                              <span className="mgt-slot-option-meta">
                                {s.status}
                                {s.proposedMinutes > 0
                                  ? ` · ${fmtMinutes(s.proposedMinutes)}`
                                  : ""}
                              </span>
                            </span>
                          </label>
                        </li>
                      ))}
                  </ul>

                  {/* Không chọn slot nào → vẫn bấm giờ được. */}
                  <label className="mgt-slot-option">
                    <input
                      type="radio"
                      name="gdt-my-slot"
                      value=""
                      checked={slotPickerValue === ""}
                      onChange={() => setSlotPickerValue("")}
                    />
                    <span className="mgt-slot-option-body">
                      <span className="mgt-slot-option-time">
                        No specific slot
                      </span>
                      <span className="mgt-slot-option-meta">
                        Just track the time I spend on this task
                      </span>
                    </span>
                  </label>
                </>
              )}
            </div>

            <div className="mgt-form-actions">
              <button
                type="button"
                className="mgt-btn mgt-btn--ghost"
                onClick={() => setPickerFor(null)}
              >
                Cancel
              </button>
              <button
                type="button"
                className="mgt-btn mgt-btn--primary"
                disabled={
                  starting ||
                  // Việc có việc con → bắt buộc chọn việc con (BE trả 400 nếu thiếu).
                  (pickerSubs.length > 0 && !subPickerValue)
                }
                onClick={() => {
                  const taskId = pickerFor;
                  const slotId = slotPickerValue || null;
                  const subId = pickerSubs.length > 0 ? subPickerValue : null;
                  setPickerFor(null);
                  const task = tasks.find((t) => t.id === taskId);
                  if (task) void handleStart(task, subId, slotId);
                }}
              >
                {starting ? "Starting…" : "Start session"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ---------- Hộp thoại chi tiết việc ---------- */}
      {detailTask && (
        <div
          className="mgt-modal-backdrop"
          onClick={closeDetail}
          role="presentation"
        >
          <div
            className="mgt-modal mgt-modal--wide"
            role="dialog"
            aria-modal="true"
            aria-labelledby="gdt-my-detail-title"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mgt-modal-head">
              <h2 id="gdt-my-detail-title" className="mgt-modal-title">
                <span
                  className="material-symbols-outlined mgt-modal-title-icon"
                  aria-hidden="true"
                >
                  assignment
                </span>
                Task details
              </h2>
              <button
                type="button"
                className="mgt-modal-close"
                onClick={closeDetail}
                aria-label="Close"
              >
                <span className="material-symbols-outlined">close</span>
              </button>
            </div>

            <div className="mgt-modal-sub">{detailTask.title}</div>

            <div className="mgt-modal-body">
              {/* ---------- Thông tin việc ---------- */}
              <div className="mgt-detail-tags">
                <span
                  className={`mgt-status mgt-status--${taskStatusLabel(detailTask.status).tone}`}
                >
                  {taskStatusLabel(detailTask.status).label}
                </span>
                <span
                  className={`mgt-priority mgt-priority--${priorityTone(detailTask.priority)}`}
                >
                  {priorityLabel(detailTask.priority)}
                </span>
                {detailTask.assigneeName && (
                  <span className="mgt-detail-chip">
                    <span
                      className="material-symbols-outlined"
                      aria-hidden="true"
                    >
                      person
                    </span>
                    {detailTask.assigneeName}
                  </span>
                )}
                {detailTask.estimatedMinutes != null && (
                  <span className="mgt-detail-chip">
                    <span
                      className="material-symbols-outlined"
                      aria-hidden="true"
                    >
                      timer
                    </span>
                    {fmtMinutes(detailTask.estimatedMinutes)}
                  </span>
                )}
              </div>

              {detailTask.description && (
                <p className="mgt-modal-text">{detailTask.description}</p>
              )}

              {/* ---------- Lịch ---------- */}
              <div className="mgt-detail-section">
                <h4 className="mgt-detail-title">Schedule</h4>
                {detailSlots.length === 0 ? (
                  <p className="mgt-modal-text">
                    No scheduled blocks for this task yet.
                  </p>
                ) : (
                  <ul className="mgt-slot-list">
                    {detailSlots.map((s) => (
                      <li key={s.id}>
                        <div className="mgt-slot-option mgt-slot-option--static">
                          <span className="mgt-slot-option-body">
                            <span className="mgt-slot-option-time">
                              {fmtGroupDateTime(s.startTime)} →{" "}
                              {fmtGroupDateTime(s.endTime)}
                            </span>
                            <span className="mgt-slot-option-meta">
                              {s.status}
                              {s.proposedMinutes > 0
                                ? ` · ${fmtMinutes(s.proposedMinutes)}`
                                : ""}
                            </span>
                          </span>
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              {/* ---------- Việc con ---------- */}
              <div className="mgt-detail-section">
                <h4 className="mgt-detail-title">
                  Subtasks
                  <span className="mgt-detail-count">{detailSubs.length}</span>
                </h4>
                {detailSubs.length === 0 ? (
                  <p className="mgt-text">
                    No subtasks yet.
                  </p>
                ) : (
                  <ul className="mgt-slot-list">
                    {detailSubs.map((s) => {
                      const sst = taskStatusLabel(s.status);
                      return (
                        <li key={s.id}>
                          <div className="mgt-slot-option mgt-slot-option--static">
                            <span className="mgt-slot-option-body">
                              <span className="mgt-slot-option-time">
                                {s.title}
                              </span>
                              <span className="mgt-slot-option-meta">
                                {sst.label}
                              </span>
                            </span>
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>

              {/* ---------- Thống kê thời gian ---------- */}
              {detailTime && (
                <div className="mgt-detail-section">
                  <h4 className="mgt-detail-title">Time tracked</h4>
                  <div className="mgt-detail-tags">
                    <span className="mgt-detail-chip">
                      <span
                        className="material-symbols-outlined"
                        aria-hidden="true"
                      >
                        timer
                      </span>
                      {fmtMinutes(detailTime.totalMinutes)}
                    </span>
                    <span className="mgt-detail-chip">
                      <span
                        className="material-symbols-outlined"
                        aria-hidden="true"
                      >
                        play_circle
                      </span>
                      {detailTime.sessionCount} session
                      {detailTime.sessionCount === 1 ? "" : "s"}
                    </span>
                  </div>
                </div>
              )}

              {/* ---------- Bình luận ---------- */}
              <div className="mgt-detail-section">
                <h4 className="mgt-detail-title">
                  Comments
                  <span className="mgt-detail-count">
                    {detailComments.length}
                  </span>
                </h4>
                {detailLoading ? (
                  <p className="mgt-modal-text">Loading…</p>
                ) : detailComments.length === 0 ? (
                  <p className="mgt-modal-text">No comments yet.</p>
                ) : (
                  <ul className="mgt-detail-comments">
                    {detailComments.map((c) => (
                      <li key={c.id} className="mgt-detail-comment">
                        <div className="mgt-detail-comment-head">
                          <span className="mgt-detail-comment-author">
                            {c.authorName}
                          </span>
                          <span className="mgt-detail-comment-time">
                            {fmtGroupDateTime(c.createdAt)}
                          </span>
                        </div>
                        <p className="mgt-detail-comment-body">{c.content}</p>
                      </li>
                    ))}
                  </ul>
                )}

                {/* Gửi bình luận */}
                <div className="mgt-detail-comment-form">
                  <textarea
                    className="mgt-textarea"
                    value={detailDraft}
                    onChange={(e) => setDetailDraft(e.target.value)}
                    placeholder="Write a comment…"
                    rows={4}
                  />
                </div>
              </div>
            </div>

            <div className="mgt-form-actions">
              <button
                type="button"
                className="mgt-btn mgt-btn--ghost"
                onClick={closeDetail}
              >
                Close
              </button>
              <button
                type="button"
                className="mgt-btn mgt-btn--primary"
                disabled={!detailDraft.trim()}
                onClick={() => void handleSendComment()}
              >
                <span className="material-symbols-outlined mgt-btn-icon">
                  send
                </span>
                <span>Send comment</span>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ---------- Hộp thoại chọn lý do dừng ---------- */}
      {stopDialogOpen && current && (
        <GroupStopReasonDialog
          taskTitle={current.taskTitle}
          subTaskTitle={current.subTaskTitle}
          groupName={current.groupName}
          elapsedLabel={fmtElapsedSeconds(current.elapsedSeconds)}
          busy={stopping}
          serverError={stopError}
          onConfirm={(reason, note) => void handleStop(reason, note)}
          onClose={() => {
            setStopDialogOpen(false);
            setStopError(null);
          }}
        />
      )}

      <GroupErrorDialog
        error={errorDialog?.view ?? null}
        details={errorDialog?.details ?? null}
        rawMessage={errorDialog?.raw || undefined}
        onClose={() => setErrorDialog(null)}
      />
    </>
  );
}
