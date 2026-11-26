import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from "react";
import { Link } from "react-router-dom";
import { CenterToasts, useCenterToast } from "../../components/Toast";
import { useAuth } from "../../auth/AuthContext";
import { useNotificationsContext } from "../../components/focus/notifications-context-state";
import { signalAffectsSchedule } from "../../hooks/useNotifications";
import type { ApiErr } from "../../lib/api-client";
import {
  approveGroupChangeRequest,
  cancelGroupChangeRequest,
  createGroupChangeRequest,
  createGroupScheduleSlot,
  getCurrentGroupFocus,
  getGroupTaskTime,
  listGroupChangeRequests,
  listGroupScheduleSlots,
  listMyGroupWork,
  rejectGroupChangeRequest,
  startGroupFocus,
  stopGroupFocus,
  type GroupChangeRequestDto,
  type GroupFocusCurrentDto,
  type GroupScheduleSlotDto,
  type GroupTaskTimeDto,
  type MyGroupSubTaskDto,
  type MyGroupTaskDto,
} from "../../lib/group-api";
import {
  getGroupSlotSuggestions,
  type GroupSlotSuggestionDto,
  type GroupSlotSuggestionsDto,
} from "../../lib/group-ai-api";
import { GroupSlotSuggestionsModal } from "./GroupSlotSuggestionsModal";
import { toGroupAiErrorView, type GroupAiErrorView } from "./group-ai-errors";
import {
  canStartFocus,
  fmtGroupDateTime,
  fmtMinutes,
  fmtRelativeTime,
  isChangeRequestOpen,
  priorityLabel,
  priorityTone,
  taskStatusLabel,
} from "./group-logic";
import { GroupErrorDialog } from "./GroupErrorDialog";
import {
  type GroupErrorDetails,
  type GroupErrorView,
  rawServerMessage,
  toGroupErrorDetails,
  toGroupErrorView,
} from "./group-errors";
import "./my-group-tasks.css";

/* ===========================================================
 * Trang /my-group-tasks — Việc của tôi trong các nhóm
 * ===========================================================
 *
 * API (spec BE GROUP_FE.md — đợt 2):
 *  - GET  /api/my-group-tasks
 *  - POST /api/group-tasks/{id}/focus/start
 *  - POST /api/group-focus/{sessionId}/stop
 *  - GET  /api/group-focus/current
 *  - GET  /api/group-tasks/{id}/time
 *  - POST /api/group-tasks/{id}/change-requests
 *  - GET  /api/groups/{id}/change-requests?status=Pending
 *  - POST /api/group-change-requests/{id}/approve | reject | cancel
 *
 * Class prefix `.mgt-*`. Tuân thủ DESIGN.md.
 * =========================================================== */

/** Chu kỳ resync đồng hồ về server (ms). */
const RESYNC_MS = 20_000;
/** Chu kỳ tick hiển thị (ms). */
const TICK_MS = 1_000;

/**
 * Slot đã huỷ / bỏ lỡ / xong → không chọn được khi bấm Start.
 */
function isClosedSlotStatus(status: string): boolean {
  const s = (status ?? "").trim().toLowerCase();
  return s === "cancelled" || s === "skipped" || s === "done";
}

export function MyGroupTasksPage() {
  const { user } = useAuth();
  const [toasts, toast] = useCenterToast();

  /* ---------- Dữ liệu ---------- */
  const [tasks, setTasks] = useState<MyGroupTaskDto[]>([]);
  const [subTasks, setSubTasks] = useState<MyGroupSubTaskDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  /* ---------- Phiên làm việc của nhóm đang chạy ---------- */
  const [current, setCurrent] = useState<GroupFocusCurrentDto | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [starting, setStarting] = useState(false);
  const [stopping, setStopping] = useState(false);
  /** Mốc đồng hồ đơn điệu (như `useFocusSession` của nhánh cá nhân). */
  const anchorRef = useRef<{ elapsed: number; at: number } | null>(null);

  /* ---------- Đề xuất đổi giờ ---------- */
  const [changeRequests, setChangeRequests] = useState<
    GroupChangeRequestDto[]
  >([]);
  const [crOpen, setCrOpen] = useState(false);
  const [crTask, setCrTask] = useState<MyGroupTaskDto | null>(null);
  const [crForm, setCrForm] = useState({
    newFixedStart: "",
    newFixedEnd: "",
    newDeadline: "",
    reason: "",
  });
  const [crError, setCrError] = useState<string | null>(null);
  /**
   * 409 GROUP_ASSIGNEE_BUSY khi duyệt đề xuất đổi giờ → chờ người dùng
   * xác nhận để gửi lại kèm `confirmConflicts: true`.
   */
  const [confirmConflictsCr, setConfirmConflictsCr] =
    useState<GroupChangeRequestDto | null>(null);

  /* ---------- Báo cáo giờ của 1 việc ---------- */
  const [timeTaskId, setTimeTaskId] = useState<string | null>(null);
  const [timeData, setTimeData] = useState<GroupTaskTimeDto | null>(null);
  const [timeLoading, setTimeLoading] = useState(false);

  /* ---------- Chọn slot khi bấm Start (mục 10 của cập nhật BE) ---------- */
  /** Slot theo việc nhóm: `groupTaskId -> slot[]`. */
  const [slotsByTask, setSlotsByTask] = useState<
    Record<string, GroupScheduleSlotDto[]>
  >({});
  /** Việc nhóm đang mở hộp thoại chọn slot (null = đóng). */
  const [slotPickerFor, setSlotPickerFor] = useState<string | null>(null);
  /** Slot được chọn trong hộp thoại. */
  const [slotPickerValue, setSlotPickerValue] = useState("");

  /* ---------- Hộp thoại báo lỗi (tiếng Anh) ---------- */
  const [errorDialog, setErrorDialog] = useState<{
    view: GroupErrorView;
    details: GroupErrorDetails;
    raw: string;
  } | null>(null);

  /* ---------- AI: gợi ý giờ làm việc (FR-25 — spec mục 3) ---------- */
  /** Việc đang xét gợi ý giờ. */
  const [timesForTask, setTimesForTask] = useState<MyGroupTaskDto | null>(null);
  /** Kết quả AI trả về. */
  const [timeSuggestions, setTimeSuggestions] =
    useState<GroupSlotSuggestionsDto | null>(null);
  const [timeSuggestLoading, setTimeSuggestLoading] = useState(false);
  const [timeSuggestSaving, setTimeSuggestSaving] = useState(false);
  const [timeAddedCount, setTimeAddedCount] = useState(0);
  const [timeSkippedCount, setTimeSkippedCount] = useState(0);

  /** Hộp thoại lỗi riêng cho AI (tiếng Anh). */
  const [aiErrorDialog, setAiErrorDialog] = useState<{
    view: GroupAiErrorView;
    raw: string;
  } | null>(null);

  /**
   * Đổi lỗi API thành hộp thoại dễ hiểu (tiếng Anh).
   *
   * @param action Động từ ngắn mô tả thao tác, VD: "start this focus session".
   */
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

  useEffect(() => {
    document.title = "Việc của tôi · METANOIA";
  }, []);

  /* ---------- Nạp việc của tôi ---------- */
  const load = useCallback(async () => {
    setLoading(true);
    const res = await listMyGroupWork();
    setLoading(false);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    setError(null);
    setTasks(res.data.tasks ?? []);
    setSubTasks(res.data.subTasks ?? []);
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- data-fetch pattern
    void load();
  }, [load]);

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
    const onVis = () => {
      if (document.visibilityState === "visible") void refreshCurrent();
    };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      window.clearInterval(t);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [refreshCurrent]);

  /* ---------- Tick 1s ---------- */
  useEffect(() => {
    const t = window.setInterval(() => {
      const a = anchorRef.current;
      if (!a) return;
      const drift = (performance.now() - a.at) / 1000;
      setElapsed(Math.max(0, Math.floor(a.elapsed + drift)));
    }, TICK_MS);
    return () => window.clearInterval(t);
  }, []);

  /* ---------- Đề xuất đổi giờ ---------- */
  const loadChangeRequests = useCallback(async () => {
    const res = await listMyGroupWork();
    if (!res.ok) return;
    const groupIds = Array.from(
      new Set((res.data.tasks ?? []).map((t) => t.groupId)),
    );
    const all: GroupChangeRequestDto[] = [];
    for (const gid of groupIds) {
      const cr = await listGroupChangeRequests(gid, { status: "Pending" });
      if (cr.ok) all.push(...(cr.data ?? []));
    }
    setChangeRequests(all);
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- data-fetch pattern
    void loadChangeRequests();
  }, [loadChangeRequests]);

  /* ---------- Slot nhóm của các việc được giao (mục 10 của cập nhật BE) ---------- */
  /**
   * Nạp slot của 1 danh sách việc.
   *
   * ⚠️ **Gộp** vào map hiện có (không thay thế) — vì hàm này còn được gọi
   * lại cho 1 việc duy nhất sau khi tạo slot mới; nếu thay thế thì các
   * việc khác mất slot khỏi UI.
   */
  const loadSlots = useCallback(async (taskIds: string[]) => {
    const map: Record<string, GroupScheduleSlotDto[]> = {};
    for (const id of taskIds) {
      const res = await listGroupScheduleSlots(id);
      if (res.ok) map[id] = res.data ?? [];
    }
    setSlotsByTask((prev) => ({ ...prev, ...map }));
  }, []);

  useEffect(() => {
    if (tasks.length === 0) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- data-fetch pattern
    void loadSlots(tasks.map((t) => t.taskId));
  }, [tasks, loadSlots]);

  /**
   * Mục 10 (BE cập nhật): `GroupStatusChanged` → slot chưa bắt đầu của người
   * cũ bị huỷ (việc giao lại / người rời nhóm) → nạp lại việc + slot.
   */
  const notif = useNotificationsContext();

  useEffect(() => {
    return notif.onSignal((signal) => {
      if (!signalAffectsSchedule(signal)) return;
      void load();
      void loadSlots(tasks.map((t) => t.taskId));
    });
  }, [notif, load, loadSlots, tasks]);

  /* ---------- Bắt đầu phiên làm việc ---------- */
  async function handleStart(
    task: MyGroupTaskDto,
    subTaskId?: string | null,
    scheduleSlotId?: string | null,
  ) {
    setStarting(true);
    const res = await startGroupFocus(task.taskId, {
      subTaskId: subTaskId ?? null,
      /*
       * Slot được chọn (mục 10 của cập nhật BE) — BE ghi nhận phiên này gắn
       * với khung giờ nào và trả lại `scheduleSlotId`.
       */
      scheduleSlotId: scheduleSlotId ?? null,
    });
    setStarting(false);
    if (!res.ok) {
      /*
       * 409 FOCUS_SESSION_CONFLICT = đang có phiên khác chạy (nhóm hoặc cá
       * nhân) → hiện hộp thoại giải thích, kèm nút dừng phiên hiện tại.
       */
      if (res.status === 409) {
        await refreshCurrent();
        showApiError(res, "start this focus session");
        return;
      }
      showApiError(res, "start this focus session");
      return;
    }
    await refreshCurrent();
    toast.success("Đã bắt đầu phiên làm việc");
  }

  /* ---------- Dừng phiên làm việc ---------- */
  async function handleStop(
    stopReason: "Completed" | "Interrupted" | "Blocked" | "Other",
    note?: string,
  ) {
    if (!current) return;
    setStopping(true);
    const res = await stopGroupFocus(current.sessionId, {
      stopReason,
      note: note ?? null,
    });
    setStopping(false);
    if (!res.ok) {
      if (res.status === 409) {
        // Phiên đã dừng trước đó → chỉ cần đồng bộ lại, không phải lỗi.
        await refreshCurrent();
        toast.info("This session was already stopped");
        return;
      }
      showApiError(res, "stop this focus session");
      return;
    }
    const mins = res.data.sessionMinutes;
    toast.success(
      "Đã dừng phiên làm việc",
      `${fmtMinutes(mins)}${res.data.wasCapped ? " (đã bị cắt ở 12 giờ)" : ""}`,
    );
    await refreshCurrent();
    await load();
  }

  /* ---------- Báo cáo giờ ---------- */
  async function handleShowTime(taskId: string) {
    if (timeTaskId === taskId) {
      setTimeTaskId(null);
      setTimeData(null);
      return;
    }
    setTimeTaskId(taskId);
    setTimeLoading(true);
    const res = await getGroupTaskTime(taskId);
    setTimeLoading(false);
    if (!res.ok) {
      showApiError(res, "load the time report");
      setTimeData(null);
      return;
    }
    setTimeData(res.data);
  }

  /* ---------- AI: gợi ý giờ làm việc (FR-25 — spec mục 3) ---------- */

  /**
   * Mở hộp thoại gợi ý giờ cho 1 việc nhóm được giao.
   *
   * AI **không** tốn lượt → gọi lại thoải mái.
   */
  async function handleOpenTimeSuggestions(task: MyGroupTaskDto) {
    setTimesForTask(task);
    setTimeSuggestions(null);
    setTimeAddedCount(0);
    setTimeSkippedCount(0);
    setTimeSuggestLoading(true);

    const res = await getGroupSlotSuggestions(task.taskId, { language: "en" });
    setTimeSuggestLoading(false);

    if (!res.ok) {
      setAiErrorDialog({ view: toGroupAiErrorView(res), raw: res.error });
      return;
    }
    setTimeSuggestions(res.data);
  }

  /** Gọi lại AI (không tốn lượt AI). */
  async function handleRetryTimeSuggestions() {
    if (!timesForTask) return;
    setTimeSuggestLoading(true);
    const res = await getGroupSlotSuggestions(timesForTask.taskId, {
      language: "en",
    });
    setTimeSuggestLoading(false);
    if (!res.ok) {
      setAiErrorDialog({ view: toGroupAiErrorView(res), raw: res.error });
      return;
    }
    setTimeSuggestions(res.data);
  }

  /**
   * Lưu các khung giờ đã chọn vào lịch (Backend) — gọi TUẦN TỰ.
   *
   * `409 SLOT_OVERLAP` = lịch đã đổi kể từ lúc gợi ý → bỏ qua khung đó
   * và xử lý tiếp các khung còn lại.
   */
  async function handleAddTimeSuggestions(slots: GroupSlotSuggestionDto[]) {
    if (!timesForTask || slots.length === 0) return;
    setTimeSuggestSaving(true);
    setTimeAddedCount(0);
    setTimeSkippedCount(0);

    let added = 0;
    let skipped = 0;

    for (const s of slots) {
      const res = await createGroupScheduleSlot(timesForTask.taskId, {
        groupSubTaskId: s.subtask_id || null,
        startTime: s.start,
        endTime: s.end,
        explanation: s.reason?.slice(0, 500) || null,
        status: "Approved",
      });
      if (res.ok) {
        added += 1;
        continue;
      }
      if (res.status === 409) {
        skipped += 1;
        continue;
      }
      setTimeSuggestSaving(false);
      setTimeAddedCount(added);
      setTimeSkippedCount(skipped);
      showApiError(res, "add this time slot");
      return;
    }

    setTimeSuggestSaving(false);
    setTimeAddedCount(added);
    setTimeSkippedCount(skipped);

    /* Nạp lại slot của việc để UI khớp server. */
    await loadSlots([timesForTask.taskId]);
    if (added > 0) {
      toast.success(
        added === 1
          ? "1 slot added to your calendar"
          : `${added} slots added to your calendar`,
        skipped > 0
          ? `${skipped} skipped because your calendar changed.`
          : undefined,
      );
    } else if (skipped > 0) {
      toast.info(
        "Nothing was added",
        "Your calendar changed since the suggestion — run \"Suggest times\" again.",
      );
    }
  }

  /* ---------- Gửi đề xuất đổi giờ ---------- */
  function openChangeRequest(task: MyGroupTaskDto) {
    setCrTask(task);
    setCrOpen(true);
    setCrError(null);
    setCrForm({
      newFixedStart: "",
      newFixedEnd: "",
      newDeadline: "",
      reason: "",
    });
  }

  async function handleCreateChangeRequest(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!crTask) return;
    const reason = crForm.reason.trim();
    if (!reason) {
      setCrError("Vui lòng nêu lý do đổi giờ.");
      return;
    }
    const hasFixed = !!(crForm.newFixedStart || crForm.newFixedEnd);
    if (hasFixed && !(crForm.newFixedStart && crForm.newFixedEnd)) {
      setCrError("Giờ cố định mới cần có cả giờ bắt đầu và giờ kết thúc.");
      return;
    }
    if (!hasFixed && !crForm.newDeadline) {
      setCrError("Cần có ít nhất giờ cố định mới hoặc deadline mới.");
      return;
    }
    setCrError(null);
    const res = await createGroupChangeRequest(crTask.taskId, {
      newFixedStart: hasFixed
        ? new Date(crForm.newFixedStart).toISOString()
        : null,
      newFixedEnd: hasFixed ? new Date(crForm.newFixedEnd).toISOString() : null,
      newDeadline: crForm.newDeadline
        ? new Date(crForm.newDeadline).toISOString()
        : null,
      reason,
    });
    if (!res.ok) {
      setCrError(
        toGroupErrorView(res, undefined, {
          action: "send this change request",
        }).message,
      );
      showApiError(res, "send this change request");
      return;
    }
    setCrOpen(false);
    await loadChangeRequests();
    toast.success("Đã gửi đề xuất đổi giờ", "Leader sẽ xem xét.");
  }

  /* ---------- Duyệt / từ chối / rút đề xuất ---------- */
  async function handleApprove(cr: GroupChangeRequestDto) {
    const res = await approveGroupChangeRequest(cr.id);
    if (!res.ok) {
      /*
       * 409 GROUP_ASSIGNEE_BUSY = giờ mới trùng lịch người nhận.
       * → Hỏi xác nhận bằng modal tiếng Anh, rồi gửi lại kèm
       *   confirmConflicts: true.
       */
      if (res.status === 409) {
        setConfirmConflictsCr(cr);
        return;
      }
      showApiError(res, "approve this change request");
      return;
    }
    await loadChangeRequests();
    toast.success("Đã duyệt đề xuất");
  }

  async function handleReject(cr: GroupChangeRequestDto) {
    const note = window.prompt("Reason for rejecting (required):");
    if (!note || !note.trim()) return;
    const res = await rejectGroupChangeRequest(cr.id, { note: note.trim() });
    if (!res.ok) {
      showApiError(res, "reject this change request");
      return;
    }
    await loadChangeRequests();
    toast.info("Đã từ chối đề xuất");
  }

  /** Duyệt đề xuất khi đã xác nhận trùng lịch (409 GROUP_ASSIGNEE_BUSY). */
  async function handleApproveWithConflicts(cr: GroupChangeRequestDto) {
    const forced = await approveGroupChangeRequest(cr.id, {
      confirmConflicts: true,
    });
    if (!forced.ok) {
      showApiError(forced, "approve this change request");
      return;
    }
    await loadChangeRequests();
    toast.success("Đã duyệt đề xuất");
  }

  async function handleCancel(cr: GroupChangeRequestDto) {
    const res = await cancelGroupChangeRequest(cr.id);
    if (!res.ok) {
      showApiError(res, "cancel this change request");
      return;
    }
    await loadChangeRequests();
    toast.info("Đã rút đề xuất");
  }

  /* ---------- Gom việc con theo việc cha ---------- */
  const subsByTask = useMemo(() => {
    const map: Record<string, MyGroupSubTaskDto[]> = {};
    for (const s of subTasks) {
      (map[s.taskId] ??= []).push(s);
    }
    return map;
  }, [subTasks]);

  /* ---------- Mở hộp thoại chọn slot khi bấm Start ---------- */
  function openSlotPicker(task: MyGroupTaskDto) {
    setSlotPickerFor(task.taskId);
    // Mặc định chọn slot sắp tới nhất → thao tác ít thao tác nhất.
    const upcoming = (slotsByTask[task.taskId] ?? [])
      .filter((s) => !isClosedSlotStatus(s.status))
      .sort(
        (a, b) =>
          new Date(a.startTime).getTime() - new Date(b.startTime).getTime(),
      );
    setSlotPickerValue(upcoming[0]?.id ?? "");
  }

  const openRequests = changeRequests.filter(isChangeRequestOpen);

  /* ---------- Render helpers ---------- */

  /**
   * Trang này chỉ liệt kê việc **được giao cho tôi** (Backend đã lọc) →
   * chỉ cần chặn 2 trường hợp AI từ chối: việc đã xong, việc có giờ
   * cố định (spec mục 3 → `409`).
   */
  function canSuggestTimesForMe(task: MyGroupTaskDto): boolean {
    const tone = taskStatusLabel(task.status).tone;
    if (tone === "done" || tone === "skipped") return false;
    if (task.fixedStart && task.fixedEnd) return false;
    return true;
  }

  function renderTask(task: MyGroupTaskDto) {
    const subs = subsByTask[task.taskId] ?? [];
    const st = taskStatusLabel(task.status);
    const runningHere =
      current?.groupTaskId === task.taskId ? current : null;
    const canStart = canStartFocus(
      {
        assigneeId: user?.id ?? null,
        subTaskCount: subs.length,
      },
      null,
      user?.id ?? null,
    );
    /** Slot nhóm còn dùng được của việc này (chưa huỷ / chưa xong). */
    const slotsForTask = (slotsByTask[task.taskId] ?? []).filter(
      (s) => !isClosedSlotStatus(s.status),
    );

    return (
      <li key={task.taskId} className="mgt-task">
        <div className="mgt-task-head">
          <div className="mgt-task-main">
            <span className="mgt-task-title">{task.title}</span>
            <div className="mgt-task-tags">
              <span className={`mgt-status mgt-status--${st.tone}`}>
                {st.label}
              </span>
              <span
                className={`mgt-priority mgt-priority--${priorityTone(task.priority)}`}
              >
                {priorityLabel(task.priority)}
              </span>
              <Link to={`/groups/${task.groupId}`} className="mgt-task-group">
                <span
                  className="material-symbols-outlined"
                  aria-hidden="true"
                >
                  groups
                </span>
                {task.groupName}
              </Link>
            </div>
            <div className="mgt-task-meta">
              {task.deadline && (
                <span className="mgt-task-meta-item">
                  <span className="material-symbols-outlined" aria-hidden="true">
                    event
                  </span>
                  Deadline {fmtGroupDateTime(task.deadline)}
                </span>
              )}
              {task.fixedStart && task.fixedEnd && (
                <span className="mgt-task-meta-item mgt-task-meta-item--fixed">
                  <span className="material-symbols-outlined" aria-hidden="true">
                    lock_clock
                  </span>
                  {fmtGroupDateTime(task.fixedStart)} →{" "}
                  {fmtGroupDateTime(task.fixedEnd)}
                </span>
              )}
            </div>
          </div>

          <div className="mgt-task-actions">
            {runningHere ? (
              <span className="mgt-running">
                <span className="mgt-running-dot" aria-hidden="true" />
                {fmtElapsed(elapsed)}
              </span>
            ) : (
              <>
                {/*
                  Nút Start. Nếu việc có slot nhóm → mở hộp thoại chọn slot
                  (mục 10 của cập nhật BE) để gửi `scheduleSlotId` khi Start.
                */}
                {slotsForTask.length > 0 ? (
                  <button
                    type="button"
                    className="mgt-btn mgt-btn--primary mgt-btn--sm"
                    onClick={() => openSlotPicker(task)}
                    disabled={starting || !!current || !canStart}
                    title={
                      canStart
                        ? "Start a focus session and pick a time slot"
                        : "Only the assignee can start this task"
                    }
                  >
                    <span className="material-symbols-outlined mgt-btn-icon">
                      play_arrow
                    </span>
                    <span>Start</span>
                  </button>
                ) : (
                  <button
                    type="button"
                    className="mgt-btn mgt-btn--primary mgt-btn--sm"
                    onClick={() => void handleStart(task)}
                    disabled={starting || !!current || !canStart}
                    title={
                      canStart
                        ? "Start a focus session"
                        : "Only the assignee can start this task"
                    }
                  >
                    <span className="material-symbols-outlined mgt-btn-icon">
                      play_arrow
                    </span>
                    <span>Start</span>
                  </button>
                )}
              </>
            )}
            <button
              type="button"
              className="mgt-btn mgt-btn--ghost mgt-btn--sm"
              onClick={() => void handleShowTime(task.taskId)}
            >
              <span className="material-symbols-outlined mgt-btn-icon">
                timer
              </span>
              <span>Time</span>
            </button>
            <button
              type="button"
              className="mgt-btn mgt-btn--ghost mgt-btn--sm"
              onClick={() => openChangeRequest(task)}
            >
              <span className="material-symbols-outlined mgt-btn-icon">
                edit_calendar
              </span>
              <span>Đổi giờ</span>
            </button>
            {/*
              Nút "Gợi ý giờ" (AI, FR-25 — spec mục 3).

              Trang này chỉ liệt kê **việc được giao cho tôi** (hoặc việc có
              việc con giao cho tôi) → ta chỉ cần chặn 2 trường hợp mà AI
              từ chối: việc đã xong và việc đã có giờ cố định.
            */}
            {canSuggestTimesForMe(task) && (
              <button
                type="button"
                className="mgt-btn mgt-btn--ghost mgt-btn--sm"
                onClick={() => void handleOpenTimeSuggestions(task)}
                disabled={timeSuggestLoading}
                title="Let AI find free time in your calendar for this task"
              >
                <span className="material-symbols-outlined mgt-btn-icon">
                  event_available
                </span>
                <span>Suggest times</span>
              </button>
            )}
          </div>
        </div>

        {/* Việc con */}
        {subs.length > 0 && (
          <ul className="mgt-sub-list">
            {subs.map((s) => {
              const sst = taskStatusLabel(s.status);
              const runningSub =
                current?.groupTaskId === task.taskId &&
                current.subTaskId === s.subTaskId
                  ? current
                  : null;
              return (
                <li key={s.subTaskId} className="mgt-sub">
                  <span
                    className={`mgt-status mgt-status--${sst.tone} mgt-status--sm`}
                  >
                    {sst.label}
                  </span>
                  <span className="mgt-sub-name">{s.title}</span>
                  {runningSub ? (
                    <span className="mgt-running mgt-running--sm">
                      <span className="mgt-running-dot" aria-hidden="true" />
                      {fmtElapsed(elapsed)}
                    </span>
                  ) : (
                    <button
                      type="button"
                      className="mgt-btn mgt-btn--ghost mgt-btn--sm"
                      onClick={() =>
                        void handleStart(task, s.subTaskId)
                      }
                      disabled={starting || !!current}
                    >
                      <span className="material-symbols-outlined mgt-btn-icon">
                        play_arrow
                      </span>
                      <span>Start</span>
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        )}

        {/* Báo cáo giờ */}
        {timeTaskId === task.taskId && (
          <div className="mgt-time">
            {timeLoading ? (
              <p className="mgt-empty">Đang tải báo cáo giờ…</p>
            ) : !timeData ? (
              <p className="mgt-empty">Chưa có dữ liệu giờ.</p>
            ) : (
              <>
                <div className="mgt-time-summary">
                  <span className="mgt-stat">
                    <span className="mgt-stat-value">
                      {fmtMinutes(timeData.totalMinutes)}
                    </span>
                    <span className="mgt-stat-label">tổng</span>
                  </span>
                  <span className="mgt-stat">
                    <span className="mgt-stat-value">
                      {fmtMinutes(timeData.estimatedMinutes)}
                    </span>
                    <span className="mgt-stat-label">ước lượng</span>
                  </span>
                  <span className="mgt-stat">
                    <span className="mgt-stat-value">
                      {timeData.sessionCount}
                    </span>
                    <span className="mgt-stat-label">phiên</span>
                  </span>
                </div>

                {timeData.byUser.length > 0 && (
                  <div className="mgt-time-block">
                    <h4 className="mgt-sub-title">Theo thành viên</h4>
                    <ul className="mgt-time-list">
                      {timeData.byUser.map((u) => (
                        <li key={u.userId} className="mgt-time-item">
                          <span className="mgt-time-name">{u.fullName}</span>
                          <span className="mgt-time-value">
                            {fmtMinutes(u.minutes)}
                          </span>
                          <span className="mgt-time-count">
                            {u.sessionCount} phiên
                          </span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                {timeData.bySubTask.length > 0 && (
                  <div className="mgt-time-block">
                    <h4 className="mgt-sub-title">Theo việc con</h4>
                    <ul className="mgt-time-list">
                      {timeData.bySubTask.map((s, i) => (
                        <li key={s.subTaskId ?? i} className="mgt-time-item">
                          <span className="mgt-time-name">
                            {s.title ?? "Việc (không có việc con)"}
                          </span>
                          <span className="mgt-time-value">
                            {fmtMinutes(s.minutes)}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </>
            )}
          </div>
        )}
      </li>
    );
  }

  return (
    <div className="mgt">
      <div className="mgt-container">
        {/* ================= Header ================= */}
        <header className="mgt-header">
          <div className="mgt-header-text">
            <h1 className="mgt-eyebrow">
              <span className="mgt-eyebrow-dot" aria-hidden="true" />
              <span>My Group Work</span>
            </h1>
            <p className="mgt-sub">
              Việc và việc con được giao cho bạn trong các nhóm — kèm bấm giờ
              và báo cáo thời gian thực tế.
            </p>
          </div>
        </header>

        {/* ================= Phiên đang chạy ================= */}
        {current && (
          <section className="mgt-live">
            <span className="mgt-live-icon" aria-hidden="true">
              <span className="material-symbols-outlined">timer</span>
            </span>
            <div className="mgt-live-body">
              <span className="mgt-live-title">
                {current.taskTitle}
                {current.subTaskTitle ? ` · ${current.subTaskTitle}` : ""}
              </span>
              <span className="mgt-live-group">{current.groupName}</span>
            </div>
            <span className="mgt-live-clock">{fmtElapsed(elapsed)}</span>
            <div className="mgt-live-actions">
              <button
                type="button"
                className="mgt-btn mgt-btn--primary mgt-btn--sm"
                onClick={() => void handleStop("Completed")}
                disabled={stopping}
              >
                <span className="material-symbols-outlined mgt-btn-icon">
                  stop_circle
                </span>
                <span>Hoàn thành</span>
              </button>
              <button
                type="button"
                className="mgt-btn mgt-btn--ghost mgt-btn--sm"
                onClick={() => void handleStop("Interrupted")}
                disabled={stopping}
              >
                <span className="material-symbols-outlined mgt-btn-icon">
                  pause
                </span>
                <span>Tạm dừng</span>
              </button>
            </div>
          </section>
        )}

        {/* ================= Đề xuất đổi giờ ================= */}
        {openRequests.length > 0 && (
          <section className="mgt-cr">
            <h2 className="mgt-section-title">
              <span className="material-symbols-outlined mgt-section-icon">
                edit_calendar
              </span>
              Đề xuất đổi giờ ({openRequests.length})
            </h2>
            <ul className="mgt-cr-list">
              {openRequests.map((cr) => (
                <li key={cr.id} className="mgt-cr-item">
                  <div className="mgt-cr-body">
                    <span className="mgt-cr-title">{cr.taskTitle}</span>
                    <span className="mgt-cr-requester">
                      {cr.requestedByName} · {fmtRelativeTime(cr.createdAt)}
                    </span>
                    <span className="mgt-cr-reason">“{cr.reason}”</span>
                    <div className="mgt-cr-change">
                      {cr.currentFixedStart && (
                        <span className="mgt-cr-dim">
                          Hiện tại: {fmtGroupDateTime(cr.currentFixedStart)}
                        </span>
                      )}
                      {cr.newFixedStart && (
                        <span className="mgt-cr-new">
                          Mới: {fmtGroupDateTime(cr.newFixedStart)}
                          {cr.newFixedEnd
                            ? ` → ${fmtGroupDateTime(cr.newFixedEnd)}`
                            : ""}
                        </span>
                      )}
                      {cr.newDeadline && (
                        <span className="mgt-cr-new">
                          Deadline mới: {fmtGroupDateTime(cr.newDeadline)}
                        </span>
                      )}
                    </div>
                  </div>
                  <div className="mgt-cr-actions">
                    <button
                      type="button"
                      className="mgt-btn mgt-btn--primary mgt-btn--sm"
                      onClick={() => void handleApprove(cr)}
                    >
                      Duyệt
                    </button>
                    <button
                      type="button"
                      className="mgt-btn mgt-btn--ghost mgt-btn--sm"
                      onClick={() => void handleReject(cr)}
                    >
                      Từ chối
                    </button>
                    <button
                      type="button"
                      className="mgt-btn mgt-btn--ghost mgt-btn--sm"
                      onClick={() => void handleCancel(cr)}
                    >
                      Rút
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          </section>
        )}

        {/* ================= Danh sách việc ================= */}
        {loading ? (
          <div className="mgt-state">
            <span className="material-symbols-outlined mgt-state-icon mgt-state-icon--spin">
              progress_activity
            </span>
            <p>Đang tải việc…</p>
          </div>
        ) : error ? (
          <div className="mgt-state mgt-state--error">
            <span className="material-symbols-outlined mgt-state-icon">
              error
            </span>
            <p>{error}</p>
            <button
              type="button"
              className="mgt-btn mgt-btn--ghost"
              onClick={() => void load()}
            >
              Thử lại
            </button>
          </div>
        ) : tasks.length === 0 && subTasks.length === 0 ? (
          <div className="mgt-state">
            <span className="material-symbols-outlined mgt-state-icon">
              task_alt
            </span>
            <p>Chưa có việc nhóm nào được giao cho bạn.</p>
            <Link to="/groups" className="mgt-btn mgt-btn--ghost">
              Xem các nhóm
            </Link>
          </div>
        ) : (
          <>
            <h2 className="mgt-section-title">
              <span className="material-symbols-outlined mgt-section-icon">
                assignment
              </span>
              Việc được giao ({tasks.length})
            </h2>
            <ul className="mgt-task-list">
              {tasks.map((t) => renderTask(t))}
            </ul>
          </>
        )}
      </div>

      {/* ================= Hộp thoại chọn slot khi Start ================= */}
      {slotPickerFor && (
        <div
          className="mgt-modal-backdrop"
          onClick={() => setSlotPickerFor(null)}
          role="presentation"
        >
          <div
            className="mgt-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="mgt-slot-title"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mgt-modal-head">
              <h2 id="mgt-slot-title" className="mgt-modal-title">
                <span
                  className="material-symbols-outlined mgt-modal-title-icon"
                  aria-hidden="true"
                >
                  event_available
                </span>
                Pick a time slot
              </h2>
              <button
                type="button"
                className="mgt-modal-close"
                onClick={() => setSlotPickerFor(null)}
                aria-label="Close"
              >
                <span className="material-symbols-outlined">close</span>
              </button>
            </div>

            <div className="mgt-modal-sub">
              {tasks.find((t) => t.taskId === slotPickerFor)?.title ?? ""}
            </div>

            <div className="mgt-modal-body">
              <p className="mgt-modal-text">
                Choose which scheduled block this session belongs to. Your
                working time is then tracked against that slot.
              </p>

              <ul className="mgt-slot-list">
                {(slotsByTask[slotPickerFor] ?? [])
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
                          name="mgt-slot"
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

              {/*
                Không chọn slot nào → vẫn cho phép bấm giờ (BE cho phép phiên
                không gắn slot).
              */}
              <label className="mgt-slot-option">
                <input
                  type="radio"
                  name="mgt-slot"
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
            </div>

            <div className="mgt-form-actions">
              <button
                type="button"
                className="mgt-btn mgt-btn--ghost"
                onClick={() => setSlotPickerFor(null)}
              >
                Cancel
              </button>
              <button
                type="button"
                className="mgt-btn mgt-btn--primary"
                disabled={starting}
                onClick={() => {
                  const taskId = slotPickerFor;
                  const slotId = slotPickerValue || null;
                  setSlotPickerFor(null);
                  const task = tasks.find((t) => t.taskId === taskId);
                  if (task) void handleStart(task, null, slotId);
                }}
              >
                {starting ? "Starting…" : "Start session"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ================= Modal đề xuất đổi giờ ================= */}
      {crOpen && crTask && (
        <div
          className="mgt-modal-backdrop"
          onClick={() => setCrOpen(false)}
          role="presentation"
        >
          <div
            className="mgt-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="mgt-cr-title"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mgt-modal-head">
              <h2 id="mgt-cr-title" className="mgt-modal-title">
                <span
                  className="material-symbols-outlined mgt-modal-title-icon"
                  aria-hidden="true"
                >
                  edit_calendar
                </span>
                Đề xuất đổi giờ
              </h2>
              <button
                type="button"
                className="mgt-modal-close"
                onClick={() => setCrOpen(false)}
                aria-label="Đóng"
              >
                <span className="material-symbols-outlined">close</span>
              </button>
            </div>

            <div className="mgt-modal-sub">
              {crTask.title} · {crTask.groupName}
            </div>

            <form className="mgt-form" onSubmit={handleCreateChangeRequest}>
              <div className="mgt-field-row">
                <div className="mgt-field">
                  <label className="mgt-label" htmlFor="mgt-f-cr-start">
                    Giờ cố định mới (bắt đầu)
                  </label>
                  <input
                    id="mgt-f-cr-start"
                    type="datetime-local"
                    className="mgt-input"
                    value={crForm.newFixedStart}
                    onChange={(e) =>
                      setCrForm((f) => ({
                        ...f,
                        newFixedStart: e.target.value,
                      }))
                    }
                  />
                </div>
                <div className="mgt-field">
                  <label className="mgt-label" htmlFor="mgt-f-cr-end">
                    Giờ cố định mới (kết thúc)
                  </label>
                  <input
                    id="mgt-f-cr-end"
                    type="datetime-local"
                    className="mgt-input"
                    value={crForm.newFixedEnd}
                    onChange={(e) =>
                      setCrForm((f) => ({
                        ...f,
                        newFixedEnd: e.target.value,
                      }))
                    }
                  />
                </div>
              </div>

              <div className="mgt-field">
                <label className="mgt-label" htmlFor="mgt-f-cr-deadline">
                  Deadline mới
                </label>
                <input
                  id="mgt-f-cr-deadline"
                  type="datetime-local"
                  className="mgt-input"
                  value={crForm.newDeadline}
                  onChange={(e) =>
                    setCrForm((f) => ({
                      ...f,
                      newDeadline: e.target.value,
                    }))
                  }
                />
              </div>

              <div className="mgt-field">
                <label className="mgt-label" htmlFor="mgt-f-cr-reason">
                  Lý do *
                </label>
                <textarea
                  id="mgt-f-cr-reason"
                  rows={3}
                  maxLength={1000}
                  className="mgt-input mgt-input--textarea"
                  placeholder="Vì sao cần đổi giờ?"
                  value={crForm.reason}
                  onChange={(e) =>
                    setCrForm((f) => ({ ...f, reason: e.target.value }))
                  }
                  required
                />
              </div>

              {crError && (
                <p className="mgt-form-error">
                  <span className="material-symbols-outlined" aria-hidden="true">
                    error
                  </span>
                  {crError}
                </p>
              )}

              <div className="mgt-form-actions">
                <button
                  type="button"
                  className="mgt-btn mgt-btn--ghost"
                  onClick={() => setCrOpen(false)}
                >
                  Huỷ
                </button>
                <button type="submit" className="mgt-btn mgt-btn--primary">
                  Gửi đề xuất
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ===== Hộp thoại xác nhận trùng lịch khi duyệt đề xuất (409) ===== */}
      {confirmConflictsCr && (
        <div
          className="mgt-modal-backdrop"
          onClick={() => setConfirmConflictsCr(null)}
          role="presentation"
        >
          <div
            className="mgt-modal"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="mgt-conflict-title"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mgt-modal-head">
              <h2 id="mgt-conflict-title" className="mgt-modal-title">
                <span
                  className="material-symbols-outlined mgt-modal-title-icon mgt-modal-title-icon--warn"
                  aria-hidden="true"
                >
                  warning
                </span>
                The new time clashes with the assignee's schedule
              </h2>
              <button
                type="button"
                className="mgt-modal-close"
                onClick={() => setConfirmConflictsCr(null)}
                aria-label="Close"
              >
                <span className="material-symbols-outlined">close</span>
              </button>
            </div>

            <div className="mgt-modal-body">
              <p className="mgt-modal-text">
                <strong>{confirmConflictsCr.taskTitle}</strong> already has time
                booked for the assignee around the new slot. Approving this
                request will move it anyway and may create an overlap.
              </p>
              <p className="mgt-modal-text">
                Approve it if you are happy with the overlap — the assignee will
                see the change on their schedule.
              </p>
            </div>

            <div className="mgt-form-actions">
              <button
                type="button"
                className="mgt-btn mgt-btn--ghost"
                onClick={() => setConfirmConflictsCr(null)}
              >
                Cancel
              </button>
              <button
                type="button"
                className="mgt-btn mgt-btn--primary"
                onClick={() => {
                  const cr = confirmConflictsCr;
                  setConfirmConflictsCr(null);
                  void handleApproveWithConflicts(cr);
                }}
              >
                Approve anyway
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ===== Hộp thoại báo lỗi (tiếng Anh) ===== */}
      <GroupErrorDialog
        error={errorDialog?.view ?? null}
        details={errorDialog?.details ?? null}
        rawMessage={errorDialog?.raw || undefined}
        onClose={() => setErrorDialog(null)}
      />

      {/* ===== Hộp thoại gợi ý giờ (AI, FR-25) ===== */}
      {timesForTask && (
        <GroupSlotSuggestionsModal
          taskTitle={timesForTask.title}
          data={timeSuggestions}
          loading={timeSuggestLoading}
          saving={timeSuggestSaving}
          addedCount={timeAddedCount}
          skippedCount={timeSkippedCount}
          onClose={() => {
            setTimesForTask(null);
            setTimeSuggestions(null);
            setTimeAddedCount(0);
            setTimeSkippedCount(0);
          }}
          onAddToCalendar={(slots) => void handleAddTimeSuggestions(slots)}
          onRetry={() => void handleRetryTimeSuggestions()}
        />
      )}

      {/* ===== Hộp thoại lỗi AI (tiếng Anh) ===== */}
      <GroupErrorDialog
        error={aiErrorDialog?.view ?? null}
        rawMessage={aiErrorDialog?.raw || undefined}
        onClose={() => setAiErrorDialog(null)}
      />

      <CenterToasts toasts={toasts} onDismiss={toast.dismiss} />
    </div>
  );
}

/** "01:23:45" — giây → đồng hồ. */
function fmtElapsed(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(h)}:${pad(m)}:${pad(sec)}`;
}
