import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from "react";
import { Link, useParams } from "react-router-dom";
import { CenterToasts, useCenterToast } from "../../components/Toast";
import { useAuth } from "../../auth/AuthContext";
import { useNotificationsContext } from "../../components/focus/notifications-context-state";
import { signalAffectsSchedule } from "../../hooks/useNotifications";
import type { ApiErr } from "../../lib/api-client";
import { isSlotOverlapError, listDomains } from "../../lib/api-client";
import { GroupErrorDialog } from "./GroupErrorDialog";
import { GroupInviteModal } from "./GroupInviteModal";
import { GroupScheduleSlots } from "./GroupScheduleSlots";
import { GroupScheduleBoard } from "./GroupScheduleBoard";
import {
  GroupAssigneeSuggestionsModal,
  type GroupAiMember,
} from "./GroupAssigneeSuggestionsModal";
import { GroupSlotSuggestionsModal } from "./GroupSlotSuggestionsModal";
import {
  getGroupAssigneeSuggestions,
  getGroupSlotSuggestions,
  type GroupAssigneeSuggestionsDto,
  type GroupSlotSuggestionDto,
  type GroupSlotSuggestionsDto,
} from "../../lib/group-ai-api";
import {
  toGroupAiErrorView,
  type GroupAiErrorView,
} from "./group-ai-errors";
import {
  type GroupErrorDetails,
  type GroupErrorView,
  rawServerMessage,
  toGroupErrorDetails,
  toGroupErrorView,
} from "./group-errors";
import {
  archiveGroup,
  createGroupComment,
  createGroupMilestone,
  createGroupScheduleSlot,
  createGroupSubTask,
  createGroupTask,
  deleteGroupComment,
  deleteGroupMilestone,
  deleteGroupSubTask,
  deleteGroupTask,
  getGroup,
  getGroupAssigneeCheck,
  getGroupProgress,
  getGroupTask,
  leaveGroup,
  listGroupActivity,
  listGroupComments,
  listGroupMembers,
  listGroupMilestones,
  listGroupSubTasks,
  listGroupTasks,
  parseAssigneeBusyDetails,
  removeGroupMember,
  restoreGroup,
  updateGroup,
  updateGroupMilestone,
  updateGroupSubTask,
  updateGroupSubTaskStatus,
  updateGroupTask,
  updateGroupTaskStatus,
  updateGroupTaskAssignee,
  parseMilestoneOpenTasksDetails,
  type GroupActivityDto,
  type GroupAssigneeAvailabilityDto,
  type GroupCommentDto,
  type GroupDto,
  type GroupMemberDto,
  type GroupMilestoneDto,
  type GroupProgressDto,
  type GroupSubTaskDto,
  type GroupTaskDto,
  type GroupMilestoneStatus,
  type GroupPriority,
} from "../../lib/group-api";
import {
  activityActionLabel,
  busySourceLabel,
  canChangeTaskStatus,
  canManageTasks,
  canSuggestTimes,
  fmtGroupDate,
  fmtGroupDateTime,
  fmtMinutes,
  fmtRelativeTime,
  isLeader,
  milestoneStatusLabel,
  memberSignalCounters,
  memberSignalTotal,
  normalizeRole,
  priorityLabel,
  priorityTone,
  roleLabel,
  signalLabel,
  taskStatusLabel,
  GROUP_MILESTONE_STATUSES,
  GROUP_PRIORITIES,
  GROUP_TASK_STATUSES,
} from "./group-logic";
import "./group-detail.css";

/* ===========================================================
 * Trang /groups/:groupId — Chi tiết nhóm
 * ===========================================================
 *
 * API (spec BE GROUP_FE.md):
 *  - GET    /api/groups/{id}
 *  - GET    /api/groups/{id}/members
 *  - GET    /api/groups/{id}/milestones
 *  - GET    /api/groups/{id}/tasks
 *  - GET    /api/groups/{id}/activity?skip&take
 *  - GET    /api/groups/{id}/progress
 *  - GET    /api/group-tasks/{id}/subtasks
 *  - GET    /api/group-tasks/{id}/comments
 *  - PUT    /api/group-tasks/{id}/status
 *  - PUT    /api/group-tasks/{id}/assignee
 *  - PUT    /api/group-subtasks/{id}/status
 *  - POST   /api/group-tasks/{id}/comments
 *  - DELETE ...
 *
 * Class prefix `.gdt-*`. Tuân thủ DESIGN.md.
 * =========================================================== */

/**
 * Tab của trang.
 *
 * ⚠️ Không có `"ai"` — Chat AI của nhóm đã tách sang trang riêng
 * `/groups/:groupId/ai` (layout 3 cột). Leader vào bằng nút "Chat AI"
 * ở header của trang này.
 */
type TabKey =
  | "tasks"
  | "schedule"
  | "milestones"
  | "members"
  | "activity";

export function GroupDetailPage() {
  const { groupId = "" } = useParams();
  const { user } = useAuth();
  const [toasts, toast] = useCenterToast();

  /* ---------- Dữ liệu nhóm ---------- */
  const [group, setGroup] = useState<GroupDto | null>(null);
  const [members, setMembers] = useState<GroupMemberDto[]>([]);
  const [milestones, setMilestones] = useState<GroupMilestoneDto[]>([]);
  const [tasks, setTasks] = useState<GroupTaskDto[]>([]);
  const [activity, setActivity] = useState<GroupActivityDto[]>([]);
  const [progress, setProgress] = useState<GroupProgressDto | null>(null);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<TabKey>("tasks");

  /* ---------- Lọc việc ---------- */
  const [statusFilter, setStatusFilter] = useState<string>("");
  const [assigneeFilter, setAssigneeFilter] = useState<string>("");

  /* ---------- Việc con + bình luận (mở theo việc) ---------- */
  const [openTaskId, setOpenTaskId] = useState<string | null>(null);
  const [subTasks, setSubTasks] = useState<Record<string, GroupSubTaskDto[]>>(
    {},
  );
  const [comments, setComments] = useState<Record<string, GroupCommentDto[]>>(
    {},
  );
  const [commentDraft, setCommentDraft] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  /* ---------- Modal sửa thông tin nhóm ---------- */
  const [groupModalOpen, setGroupModalOpen] = useState(false);
  const [groupForm, setGroupForm] = useState({
    name: "",
    description: "",
    startDate: "",
    deadline: "",
  });
  const [groupFormError, setGroupFormError] = useState<string | null>(null);

  /* ---------- Modal tạo việc ---------- */
  const [taskModalOpen, setTaskModalOpen] = useState(false);
  const [taskForm, setTaskForm] = useState({
    title: "",
    description: "",
    priority: "Medium" as GroupPriority,
    milestoneId: "",
    assigneeId: "",
    deadline: "",
    estimatedMinutes: "",
  });
  const [taskFormError, setTaskFormError] = useState<string | null>(null);

  /* ---------- Modal tạo giai đoạn ---------- */
  const [msModalOpen, setMsModalOpen] = useState(false);
  const [msForm, setMsForm] = useState({
    name: "",
    orderIndex: "1",
    dueDate: "",
    status: "Planned" as GroupMilestoneStatus,
  });
  const [msFormError, setMsFormError] = useState<string | null>(null);

  /* ---------- Modal sửa giai đoạn ---------- */
  /**
   * Giai đoạn đang sửa (null = modal đóng).
   *
   * Dùng chung form với modal TẠO giai đoạn? Không — tách riêng để không
   * lẫn trạng thái giữa 2 modal (mở lại modal tạo sẽ phải reset form).
   */
  const [msEditTarget, setMsEditTarget] = useState<GroupMilestoneDto | null>(
    null,
  );
  const [msEditForm, setMsEditForm] = useState({
    name: "",
    orderIndex: "1",
    dueDate: "",
    status: "Planned" as GroupMilestoneStatus,
  });
  const [msEditFormError, setMsEditFormError] = useState<string | null>(null);

  /* ---------- Modal sửa việc ---------- */
  /**
   * Việc đang sửa (null = modal đóng).
   *
   * Tách riêng khỏi modal TẠO việc (giống milestone) để không lẫn trạng thái.
   */
  const [taskEditTarget, setTaskEditTarget] = useState<GroupTaskDto | null>(
    null,
  );
  const [taskEditForm, setTaskEditForm] = useState({
    title: "",
    description: "",
    priority: "Medium" as GroupPriority,
    milestoneId: "",
    assigneeId: "",
    deadline: "",
    estimatedMinutes: "",
    fixedStart: "",
    fixedEnd: "",
  });
  const [taskEditFormError, setTaskEditFormError] = useState<string | null>(null);

  /* ---------- Modal sửa việc con ---------- */
  /** Việc con đang sửa (null = modal đóng). */
  const [subEditTarget, setSubEditTarget] = useState<GroupSubTaskDto | null>(
    null,
  );
  /** Id việc cha (để biết cập nhật list con nào). */
  const [subEditTaskId, setSubEditTaskId] = useState<string | null>(null);
  const [subEditForm, setSubEditForm] = useState({
    title: "",
    estimatedMinutes: "",
    assigneeId: "",
    orderIndex: "1",
  });
  const [subEditFormError, setSubEditFormError] = useState<string | null>(null);

  /* ---------- Modal thêm việc con ---------- */
  const [subModalFor, setSubModalFor] = useState<string | null>(null);
  const [subForm, setSubForm] = useState({
    title: "",
    estimatedMinutes: "",
    assigneeId: "",
  });
  const [subFormError, setSubFormError] = useState<string | null>(null);

  /* ---------- Đề xuất đổi giờ (đợt 2) ---------- */
  /** Chi tiết 409 GROUP_ASSIGNEE_BUSY đang chờ Leader xác nhận. */
  const [busyWarning, setBusyWarning] = useState<{
    taskId: string;
    assigneeId: string;
    details: import("../../lib/group-api").GroupAssigneeBusyDetails;
  } | null>(null);

  /**
   * 409 MILESTONE_HAS_OPEN_TASKS đang chờ Leader xác nhận.
   * Dùng modal (tiếng Anh) thay cho `window.confirm`.
   */
  const [msOpenTasksWarning, setMsOpenTasksWarning] = useState<{
    milestone: GroupMilestoneDto;
    status: GroupMilestoneStatus;
    details: import("../../lib/group-api").GroupMilestoneOpenTasksDetails;
    /**
     * Nguồn phát sinh 409:
     *  - `"status"` → đổi status bằng dropdown (dùng milestone cũ).
     *  - `"edit"`   → lưu từ modal sửa (dùng form đang nhập + `confirmOpenTasks`).
     */
    source: "status" | "edit";
  } | null>(null);

  /**
   * Kiểm tra lịch TRƯỚC khi giao (spec mục 8) — Leader xem bên cạnh tên
   * người được giao: bận / rảnh, chỉ có khoảng thời gian + nguồn (không
   * có tên dự án hay tiêu đề lịch cá nhân).
   */
  const [availability, setAvailability] = useState<
    Record<string, GroupAssigneeAvailabilityDto>
  >({});

  /* ---------- Hộp thoại báo lỗi (tiếng Anh) ---------- */
  const [errorDialog, setErrorDialog] = useState<{
    view: GroupErrorView;
    details: GroupErrorDetails;
    raw: string;
  } | null>(null);

  /* ---------- Modal mời thành viên (tab Members) ---------- */
  const [inviteOpen, setInviteOpen] = useState(false);

  /* ---------- AI: gợi ý người làm (spec GROUP_AI_FE.md mục 1) ---------- */
  /** Việc đang xét gợi ý. */
  const [suggestForTask, setSuggestForTask] = useState<GroupTaskDto | null>(
    null,
  );
  /** Kết quả AI trả về. */
  const [suggestions, setSuggestions] =
    useState<GroupAssigneeSuggestionsDto | null>(null);
  /** Đang gọi AI. */
  const [suggestLoading, setSuggestLoading] = useState(false);
  /** Loại công việc để AI dùng đúng thói quen ước lượng (tuỳ chọn). */
  const [suggestDomainId, setSuggestDomainId] = useState<string>("");
  /** Danh sách loại công việc lấy từ `GET /api/domains`. */
  const [domains, setDomains] = useState<{ id: string; name: string }[]>([]);

  /* ---------- AI: gợi ý giờ làm việc (FR-25, spec mục 3) ---------- */
  /** Việc nhóm đang xét gợi ý giờ. */
  const [timesForTask, setTimesForTask] = useState<GroupTaskDto | null>(null);
  /** Kết quả AI trả về (khung giờ + cảnh báo). */
  const [timeSuggestions, setTimeSuggestions] =
    useState<GroupSlotSuggestionsDto | null>(null);
  /** Đang gọi AI. */
  const [timeSuggestLoading, setTimeSuggestLoading] = useState(false);
  /** Đang tạo slot ở Backend. */
  const [timeSuggestSaving, setTimeSuggestSaving] = useState(false);
  /** Số slot đã tạo thành công (để báo tóm tắt). */
  const [timeAddedCount, setTimeAddedCount] = useState(0);
  /** Số khung bị bỏ qua vì chồng lịch (409 SLOT_OVERLAP). */
  const [timeSkippedCount, setTimeSkippedCount] = useState(0);

  /** Hộp thoại lỗi riêng cho AI (tiếng Anh). */
  const [aiErrorDialog, setAiErrorDialog] = useState<{
    view: GroupAiErrorView;
    raw: string;
  } | null>(null);

  /**
   * Thao tác thử lại cho lỗi AI tạm thời (502/503/429).
   *
   * Hộp thoại lỗi AI hiện nút "Try again" thay vì bắt user tự làm lại từ
   * đầu. Được set kèm khi báo lỗi cho 1 request AI cụ thể.
   */
  const [aiRetry, setAiRetry] = useState<(() => void) | null>(null);

  /**
   * Ref tới các hàm "thử lại" để hộp thoại lỗi AI gọi lại được mà không
   * tạo phụ thuộc vòng tròn trong `useCallback` (linter chặn self-reference).
   */
  const retryHandlers = useRef<{
    openSuggestions?: (task: GroupTaskDto) => void;
    retrySuggestions?: () => void;
    suggestDomainChange?: (domainId: string) => void;
    assignSuggestion?: (userId: string) => void;
    openTimeSuggestions?: (task: GroupTaskDto) => void;
    retryTimeSuggestions?: () => void;
  }>({});

  /**
   * Hiện lỗi AI trong hộp thoại dùng chung (tiêu đề + message đã dịch).
   *
   * @param retry Thao tác thử lại (nếu lỗi tạm thời) → hiện nút "Try again".
   */
  const showAiError = useCallback(
    (view: GroupAiErrorView, raw?: string, retry?: () => void) => {
      setAiErrorDialog({ view, raw: raw ?? "" });
      setAiRetry(retry ?? null);
    },
    [],
  );

  /**
   * Đổi lỗi API thành hộp thoại dễ hiểu.
   *
   * @param action Động từ ngắn mô tả thao tác, VD: "assign this task".
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
    document.title = "Group · METANOIA";
  }, []);

  /* ---------- Nạp loại công việc (cho gợi ý AI) ---------- */
  useEffect(() => {
    void listDomains().then((res) => {
      if (res.ok) {
        setDomains(res.data.map((d) => ({ id: d.id, name: d.name })));
      }
    });
  }, []);

  /* ---------- Nạp toàn bộ dữ liệu ---------- */
  const loadAll = useCallback(async () => {
    if (!groupId) return;
    setLoading(true);
    const [gRes, mRes, msRes, tRes, aRes, pRes] = await Promise.all([
      getGroup(groupId),
      listGroupMembers(groupId),
      listGroupMilestones(groupId),
      listGroupTasks(groupId),
      listGroupActivity(groupId, { skip: 0, take: 50 }),
      getGroupProgress(groupId),
    ]);
    setLoading(false);
    if (!gRes.ok) {
      setError(gRes.error);
      return;
    }
    setError(null);
    setGroup(gRes.data);
    setMembers(mRes.ok ? (mRes.data ?? []) : []);
    setMilestones(msRes.ok ? (msRes.data ?? []) : []);
    setTasks(tRes.ok ? (tRes.data ?? []) : []);
    setActivity(aRes.ok ? (aRes.data ?? []) : []);
    setProgress(pRes.ok ? pRes.data : null);
  }, [groupId]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- data-fetch pattern
    void loadAll();
  }, [loadAll]);

  /**
   * Mục 10 (BE cập nhật): việc được giao lại / người làm rời nhóm → slot chưa
   * bắt đầu bị huỷ + server phát `GroupStatusChanged`.
   *
   * → Nạp lại dữ liệu nhóm (tiến độ, việc con, slot) để UI khớp server.
   */
  const notif = useNotificationsContext();

  useEffect(() => {
    return notif.onSignal((signal) => {
      if (!signalAffectsSchedule(signal)) return;
      void loadAll();
    });
  }, [notif, loadAll]);

  const leader = isLeader(group);
  const canManage = canManageTasks(group);
  const archived = group?.status === "Archived";

  /* ---------- Việc lọc ---------- */
  const visibleTasks = useMemo(() => {
    return tasks.filter((t) => {
      if (statusFilter && t.status !== statusFilter) return false;
      if (assigneeFilter) {
        if (assigneeFilter === "__unassigned__") {
          if (t.assigneeId) return false;
        } else if (t.assigneeId !== assigneeFilter) {
          return false;
        }
      }
      return true;
    });
  }, [tasks, statusFilter, assigneeFilter]);

  /* ---------- Tên thành viên: id → fullName ---------- */
  /** Dùng cho lịch nhóm (hiện "ai đang làm việc nào"). */
  const memberNames = useMemo(() => {
    const map: Record<string, string> = {};
    for (const m of members) map[m.userId] = m.fullName;
    return map;
  }, [members]);

  /* ---------- Tín hiệu tiến độ (mục 10 của cập nhật BE) ---------- */
  /**
   * `signals` từ BE — chuẩn hoá để luôn có đủ 4 loại, sắp xếp theo mức độ
   * nghiêm trọng (quá hạn → nguy cơ trễ → chưa có lịch → đứng yên).
   *
   * BE có thể chưa trả `signals` (bản cũ) → mảng rỗng → ẩn hẳn khối.
   */
  const groupSignals = useMemo(() => {
    const raw = progress?.signals ?? [];
    if (!Array.isArray(raw) || raw.length === 0) return [];
    const order = ["overdue", "atrisk", "unscheduled", "stale"];
    return [...raw]
      .filter((s) => s && typeof s.type === "string")
      .map((s) => ({
        ...s,
        count: typeof s.count === "number" ? s.count : 0,
      }))
      .sort((a, b) => {
        // BE có thể gửi "Overdue" hoặc "overdue" → so sánh không phân biệt hoa thường.
        const ai = order.indexOf(a.type.trim().toLowerCase());
        const bi = order.indexOf(b.type.trim().toLowerCase());
        return (ai < 0 ? 99 : ai) - (bi < 0 ? 99 : bi);
      });
  }, [progress]);
  /* ---------- Mở 1 việc → nạp việc con + bình luận ---------- */
  const openTask = useCallback(async (taskId: string) => {
    setOpenTaskId((prev) => (prev === taskId ? null : taskId));
    const [sRes, cRes] = await Promise.all([
      listGroupSubTasks(taskId),
      listGroupComments(taskId),
    ]);
    setSubTasks((prev) => ({
      ...prev,
      [taskId]: sRes.ok ? (sRes.data ?? []) : [],
    }));
    setComments((prev) => ({
      ...prev,
      [taskId]: cRes.ok ? (cRes.data ?? []) : [],
    }));
  }, []);

  /* ---------- Đổi status việc ---------- */
  async function handleTaskStatus(task: GroupTaskDto, status: string) {
    setBusy(true);
    const res = await updateGroupTaskStatus(task.id, { status });
    setBusy(false);
    if (!res.ok) {
      showApiError(res, "update this task's status");
      return;
    }
    setTasks((prev) =>
      prev.map((t) => (t.id === task.id ? { ...t, status: res.data.status } : t)),
    );
    // Việc con có thể đã bị đóng theo → nạp lại chi tiết nếu đang mở.
    if (openTaskId === task.id) {
      const sRes = await listGroupSubTasks(task.id);
      if (sRes.ok) {
        setSubTasks((prev) => ({ ...prev, [task.id]: sRes.data ?? [] }));
      }
    }
    toast.success("Status updated");
  }

  /* ---------- Đổi status việc con ---------- */
  async function handleSubTaskStatus(
    task: GroupTaskDto,
    sub: GroupSubTaskDto,
    status: string,
  ) {
    setBusy(true);
    const res = await updateGroupSubTaskStatus(sub.id, { status });
    setBusy(false);
    if (!res.ok) {
      showApiError(res, "update this subtask's status");
      return;
    }
    setSubTasks((prev) => ({
      ...prev,
      [task.id]: (prev[task.id] ?? []).map((s) =>
        s.id === sub.id ? { ...s, status: res.data.status } : s,
      ),
    }));
    /*
     * ⚠️ Sau khi đổi status việc con, PHẢI gọi lại việc cha vì status việc
     * cha có thể tự suy theo (spec mục 4).
     */
    const parent = await getGroupTaskSafe(task.id);
    if (parent) {
      setTasks((prev) =>
        prev.map((t) => (t.id === task.id ? parent : t)),
      );
    }
    toast.success("Status updated");
  }

  /** Gọi lại 1 việc (bọc try/catch để không crash nếu lỗi). */
  async function getGroupTaskSafe(taskId: string): Promise<GroupTaskDto | null> {
    const res = await getGroupTask(taskId);
    return res.ok ? res.data : null;
  }

  /* ---------- Giao việc (Leader) ---------- */
  /**
   * Xem trước tình trạng người nhận TRƯỚC khi giao (spec mục 8).
   *
   * `GET /api/group-tasks/{taskId}/assignee-check?assigneeId=...` chỉ Leader
   * gọi được (Member nhận 403). Trả về khoảng bận + khối lượng tuần.
   */
  async function handlePreviewAssignee(
    task: GroupTaskDto,
    assigneeId: string,
  ) {
    if (!assigneeId) {
      setAvailability((prev) => {
        const next = { ...prev };
        delete next[task.id];
        return next;
      });
      return;
    }
    const res = await getGroupAssigneeCheck(task.id, assigneeId);
    if (!res.ok) {
      // Member gọi API này nhận 403 → im lặng, không báo lỗi đỏ.
      return;
    }
    setAvailability((prev) => ({ ...prev, [task.id]: res.data }));
  }

  async function handleAssign(
    task: GroupTaskDto,
    assigneeId: string,
    confirmConflicts = false,
  ) {
    setBusy(true);
    const res = await updateGroupTaskAssignee(task.id, {
      assigneeId: assigneeId || null,
      confirmConflicts,
    });
    setBusy(false);
    if (!res.ok) {
      // 409 GROUP_ASSIGNEE_BUSY → hiện hộp thoại xác nhận.
      if (res.status === 409 && res.errorCode === "GROUP_ASSIGNEE_BUSY") {
        const details = parseAssigneeBusyDetails(res.details);
        if (details) {
          setBusyWarning({
            taskId: task.id,
            assigneeId,
            details,
          });
          return;
        }
      }
      showApiError(res, "assign this task");
      return;
    }
    setTasks((prev) =>
      prev.map((t) => (t.id === task.id ? res.data : t)),
    );
    setBusyWarning(null);
    toast.success("Task assigned");
  }

  /* ---------- AI: gợi ý người làm (spec GROUP_AI_FE.md mục 1) ---------- */

  /**
   * Mở modal gợi ý người làm cho 1 việc.
   *
   * Chỉ Leader, và chỉ với việc **chưa xong** (ToDo / InProgress) —
   * AI service trả 409 nếu việc đã Done/Skipped.
   */
  const handleOpenSuggestions = useCallback(
    async (task: GroupTaskDto) => {
      setSuggestForTask(task);
      setSuggestions(null);
      setSuggestLoading(true);

      const res = await getGroupAssigneeSuggestions(task.id, {
        domain_id: suggestDomainId || null,
        language: "vi",
      });
      setSuggestLoading(false);

      if (!res.ok) {
        showAiError(toGroupAiErrorView(res), res.error, () =>
          retryHandlers.current.openSuggestions?.(task),
        );
        return;
      }
      setSuggestions(res.data);
    },
    [suggestDomainId, showAiError],
  );

  /** Gọi lại AI (tốn thêm 1 lượt AI của Leader). */
  const handleRetrySuggestions = useCallback(async () => {
    if (!suggestForTask) return;
    setSuggestLoading(true);
    const res = await getGroupAssigneeSuggestions(suggestForTask.id, {
      domain_id: suggestDomainId || null,
      language: "vi",
    });
    setSuggestLoading(false);
    if (!res.ok) {
      showAiError(toGroupAiErrorView(res), res.error, () =>
        retryHandlers.current.retrySuggestions?.(),
      );
      return;
    }
    setSuggestions(res.data);
  }, [suggestForTask, suggestDomainId, showAiError]);

  /**
   * Đổi loại công việc → gọi lại AI với `domain_id` mới.
   *
   * Mỗi lần gọi lại tốn 1 lượt AI, nên chỉ gọi khi Leader **thực sự** đổi
   * (không gọi lại với cùng giá trị đã chọn).
   */
  const handleSuggestDomainChange = useCallback(
    async (domainId: string) => {
      setSuggestDomainId(domainId);
      if (!suggestForTask) return;
      if (domainId === suggestDomainId) return;

      setSuggestLoading(true);
      const res = await getGroupAssigneeSuggestions(suggestForTask.id, {
        domain_id: domainId || null,
        language: "vi",
      });
      setSuggestLoading(false);
      if (!res.ok) {
        showAiError(toGroupAiErrorView(res), res.error, () =>
          retryHandlers.current.suggestDomainChange?.(domainId),
        );
        return;
      }
      setSuggestions(res.data);
    },
    [suggestForTask, suggestDomainId, showAiError],
  );

  /**
   * Leader chọn 1 người → giao việc qua Backend.
   *
   * `PUT /api/group-tasks/{id}/assignee` → nếu 409 GROUP_ASSIGNEE_BUSY thì
   * hiện hộp thoại xác nhận (dùng lại `busyWarning` sẵn có).
   */
  const handleAssignSuggestion = useCallback(
    async (userId: string) => {
      if (!suggestForTask) return;
      setBusy(true);
      const res = await updateGroupTaskAssignee(suggestForTask.id, {
        assigneeId: userId,
      });
      setBusy(false);

      if (!res.ok) {
        if (res.status === 409 && res.errorCode === "GROUP_ASSIGNEE_BUSY") {
          const details = parseAssigneeBusyDetails(res.details);
          if (details) {
            setBusyWarning({
              taskId: suggestForTask.id,
              assigneeId: userId,
              details,
            });
            setSuggestForTask(null);
            return;
          }
        }
        showAiError(toGroupAiErrorView(res), res.error, () =>
          retryHandlers.current.assignSuggestion?.(userId),
        );
        return;
      }

      setTasks((prev) =>
        prev.map((t) => (t.id === suggestForTask.id ? res.data : t)),
      );
      setSuggestForTask(null);
      setSuggestions(null);
      toast.success("Task assigned");
    },
    [suggestForTask, showAiError, toast],
  );

  /*
   * Đăng ký các hàm "thử lại" vào ref → hộp thoại lỗi AI gọi lại được mà
   * không tạo phụ thuộc vòng tròn trong `useCallback` (linter chặn
   * self-reference).
   */
  useEffect(() => {
    retryHandlers.current.openSuggestions = (task) => {
      void handleOpenSuggestions(task);
    };
    retryHandlers.current.retrySuggestions = () => {
      void handleRetrySuggestions();
    };
    retryHandlers.current.suggestDomainChange = (domainId) => {
      void handleSuggestDomainChange(domainId);
    };
    retryHandlers.current.assignSuggestion = (userId) => {
      void handleAssignSuggestion(userId);
    };
  }, [
    handleOpenSuggestions,
    handleRetrySuggestions,
    handleSuggestDomainChange,
    handleAssignSuggestion,
  ]);

  /* ---------- AI: gợi ý giờ làm việc (FR-25, spec mục 3) ---------- */

  /**
   * Mở hộp thoại gợi ý giờ cho 1 việc nhóm.
   *
   * Ai dùng: **người được giao** việc (Leader hoặc Member) — người khác bị
   * `403` nên ta ẩn nút (xem `canSuggestTimes`).
   *
   * AI **không** tốn lượt → gọi lại thoải mái.
   */
  const handleOpenTimeSuggestions = useCallback(
    async (task: GroupTaskDto) => {
      setTimesForTask(task);
      setTimeSuggestions(null);
      setTimeAddedCount(0);
      setTimeSkippedCount(0);
      setTimeSuggestLoading(true);

      const res = await getGroupSlotSuggestions(task.id, { language: "vi" });
      setTimeSuggestLoading(false);

      if (!res.ok) {
        showAiError(toGroupAiErrorView(res), res.error, () =>
          retryHandlers.current.openTimeSuggestions?.(task),
        );
        return;
      }
      setTimeSuggestions(res.data);
    },
    [showAiError],
  );

  /** Gọi lại AI (không tốn lượt AI). */
  const handleRetryTimeSuggestions = useCallback(async () => {
    if (!timesForTask) return;
    setTimeSuggestLoading(true);
    const res = await getGroupSlotSuggestions(timesForTask.id, {
      language: "vi",
    });
    setTimeSuggestLoading(false);
    if (!res.ok) {
      showAiError(toGroupAiErrorView(res), res.error, () =>
        retryHandlers.current.retryTimeSuggestions?.(),
      );
      return;
    }
    setTimeSuggestions(res.data);
  }, [timesForTask, showAiError]);

  /* Đăng ký hàm thử lại cho gợi ý khung giờ vào ref (xem `retryHandlers`). */
  useEffect(() => {
    retryHandlers.current.openTimeSuggestions = (task) => {
      void handleOpenTimeSuggestions(task);
    };
    retryHandlers.current.retryTimeSuggestions = () => {
      void handleRetryTimeSuggestions();
    };
  }, [handleOpenTimeSuggestions, handleRetryTimeSuggestions]);

  /**
   * Lưu các khung giờ đã chọn vào lịch (Backend).
   *
   * Gọi **TUẦN TỰ** cho từng khung (spec mục 3) — tránh chồng giờ với
   * chính các slot vừa tạo.
   *
   * `409 SLOT_OVERLAP` = lịch đã thay đổi kể từ lúc gợi ý → **bỏ qua**
   * khung đó (không dừng cả lô) và báo người dùng gọi lại gợi ý cho phần
   * còn thiếu.
   */
  const handleAddTimeSuggestions = useCallback(
    async (slots: GroupSlotSuggestionDto[]) => {
      if (!timesForTask || slots.length === 0) return;
      setTimeSuggestSaving(true);
      setTimeAddedCount(0);
      setTimeSkippedCount(0);

      let added = 0;
      let skipped = 0;

      for (const s of slots) {
        const res = await createGroupScheduleSlot(timesForTask.id, {
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
        /* 409 SLOT_OVERLAP → bỏ qua khung này, xử lý khung còn lại. */
        if (isSlotOverlapError(res)) {
          skipped += 1;
          continue;
        }
        /* Lỗi khác → dừng, báo rõ. */
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
      void openTask(timesForTask.id);
      if (added > 0) {
        toast.success(
          added === 1 ? "1 slot added to your calendar" : `${added} slots added to your calendar`,
          skipped > 0
            ? `${skipped} skipped because your calendar changed.`
            : undefined,
        );
      }
      if (skipped > 0 && added === 0) {
        toast.info(
          "Nothing was added",
          "Your calendar changed since the suggestion — run \"Suggest times\" again.",
        );
      }
    },
    [timesForTask, showApiError, openTask, toast],
  );

  /** Danh sách thành viên dạng rút gọn cho modal AI. */
  const aiMembers: GroupAiMember[] = useMemo(
    () =>
      members.map((m) => ({
        userId: m.userId,
        fullName: m.fullName,
        role: String(m.role ?? "member"),
      })),
    [members],
  );

  /* ---------- Tạo việc ---------- */
  async function handleCreateTask(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!group) return;
    const title = taskForm.title.trim();
    if (!title) {
      setTaskFormError("Please enter a task title.");
      return;
    }
    setTaskFormError(null);
    setBusy(true);
    const res = await createGroupTask(group.id, {
      title,
      description: taskForm.description.trim() || null,
      priority: taskForm.priority,
      milestoneId: taskForm.milestoneId || null,
      assigneeId: taskForm.assigneeId || null,
      deadline: taskForm.deadline
        ? new Date(taskForm.deadline).toISOString()
        : null,
      estimatedMinutes: taskForm.estimatedMinutes
        ? Number(taskForm.estimatedMinutes)
        : null,
    });
    setBusy(false);
    if (!res.ok) {
      setTaskFormError(
        toGroupErrorView(res, undefined, { action: "create this task" }).message,
      );
      showApiError(res, "create this task");
      return;
    }
    setTasks((prev) => [res.data, ...prev]);
    setTaskModalOpen(false);
    setTaskForm({
      title: "",
      description: "",
      priority: "Medium",
      milestoneId: "",
      assigneeId: "",
      deadline: "",
      estimatedMinutes: "",
    });
    toast.success("Task created");
  }

  /* ---------- Tạo giai đoạn ---------- */
  async function handleCreateMilestone(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!group) return;
    const name = msForm.name.trim();
    if (!name) {
      setMsFormError("Please enter a milestone name.");
      return;
    }
    setMsFormError(null);
    setBusy(true);
    const res = await createGroupMilestone(group.id, {
      name,
      orderIndex: Number(msForm.orderIndex) || 1,
      dueDate: msForm.dueDate || null,
      status: msForm.status,
    });
    setBusy(false);
    if (!res.ok) {
      setMsFormError(
        toGroupErrorView(res, undefined, { action: "create this milestone" })
          .message,
      );
      showApiError(res, "create this milestone");
      return;
    }
    setMilestones((prev) => [...prev, res.data].sort((a, b) => a.orderIndex - b.orderIndex));
    setMsModalOpen(false);
    setMsForm({ name: "", orderIndex: "1", dueDate: "", status: "Planned" });
    toast.success("Milestone created");
  }

  /* ---------- Đổi status giai đoạn (409 → xác nhận) ---------- */
  async function handleMilestoneStatus(
    ms: GroupMilestoneDto,
    status: GroupMilestoneStatus,
    confirmOpenTasks = false,
  ) {
    setBusy(true);
    const res = await updateGroupMilestone(ms.id, {
      name: ms.name,
      orderIndex: ms.orderIndex,
      dueDate: ms.dueDate,
      status,
      confirmOpenTasks,
    });
    setBusy(false);
    if (!res.ok) {
      // 409 MILESTONE_HAS_OPEN_TASKS → mở modal xác nhận (tiếng Anh).
      if (res.status === 409) {
        const details = parseMilestoneOpenTasksDetails(res.details);
        if (details) {
          setMsOpenTasksWarning({ milestone: ms, status, details, source: "status" });
          return;
        }
      }
      showApiError(res, "update this milestone");
      return;
    }
    setMilestones((prev) =>
      prev.map((m) => (m.id === ms.id ? res.data : m)),
    );
    toast.success("Milestone updated");
  }

  /* ---------- Mở modal sửa giai đoạn ---------- */
  function openMilestoneEditModal(ms: GroupMilestoneDto) {
    setMsEditForm({
      name: ms.name ?? "",
      orderIndex: String(ms.orderIndex ?? 1),
      dueDate: toDateInput(ms.dueDate),
      status: (ms.status ?? "Planned") as GroupMilestoneStatus,
    });
    setMsEditFormError(null);
    setMsEditTarget(ms);
  }

  /**
   * Lưu giai đoạn đã sửa → `PUT /api/group-milestones/{milestoneId}`.
   *
   * Body: `{ name, orderIndex, dueDate, status, confirmOpenTasks }`.
   *
   * ⚠️ Khi đổi status sang `Delivered` mà còn việc dở, BE trả 409
   * `MILESTONE_HAS_OPEN_TASKS` → ta mở modal xác nhận (tiếng Anh) để user
   * chọn "giao dù còn việc dở" (gửi lại kèm `confirmOpenTasks: true`).
   */
  async function handleSaveMilestone(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!msEditTarget) return;
    const name = msEditForm.name.trim();
    if (!name) {
      setMsEditFormError("Please enter a milestone name.");
      return;
    }
    const orderIndex = Number(msEditForm.orderIndex);
    if (!Number.isFinite(orderIndex) || orderIndex < 1) {
      setMsEditFormError("Order index must be 1 or greater.");
      return;
    }
    setMsEditFormError(null);
    setBusy(true);
    const res = await updateGroupMilestone(msEditTarget.id, {
      name,
      orderIndex,
      dueDate: msEditForm.dueDate || null,
      status: msEditForm.status,
    });
    setBusy(false);
    if (!res.ok) {
      // 409 MILESTONE_HAS_OPEN_TASKS → mở modal xác nhận (tiếng Anh).
      if (res.status === 409) {
        const details = parseMilestoneOpenTasksDetails(res.details);
        if (details) {
          setMsOpenTasksWarning({
            /*
             * ⚠️ `msEditForm.orderIndex` là STRING (state của <input>) →
             * phải ép về number khi dựng DTO, nếu không TS báo lỗi.
             */
            milestone: {
              ...msEditTarget,
              name,
              orderIndex,
              dueDate: msEditForm.dueDate || null,
              status: msEditForm.status,
            },
            status: msEditForm.status,
            details,
            source: "edit",
          });
          return;
        }
      }
      setMsEditFormError(
        toGroupErrorView(res, undefined, {
          action: "update this milestone",
        }).message,
      );
      showApiError(res, "update this milestone");
      return;
    }
    setMilestones((prev) =>
      prev.map((m) => (m.id === res.data.id ? res.data : m)),
    );
    setMsEditTarget(null);
    toast.success("Milestone updated", res.data.name);
  }

  /**
   * Giao giai đoạn dù còn việc dở — gửi lại cùng body kèm
   * `confirmOpenTasks: true` (BE chấp nhận, việc dở giữ nguyên).
   */
  async function handleSaveMilestoneAnyway() {
    if (!msEditTarget) return;
    const name = msEditForm.name.trim();
    const orderIndex = Number(msEditForm.orderIndex);
    setMsOpenTasksWarning(null);
    setBusy(true);
    const res = await updateGroupMilestone(msEditTarget.id, {
      name,
      orderIndex: Number.isFinite(orderIndex) ? orderIndex : 1,
      dueDate: msEditForm.dueDate || null,
      status: msEditForm.status,
      confirmOpenTasks: true,
    });
    setBusy(false);
    if (!res.ok) {
      setMsEditFormError(
        toGroupErrorView(res, undefined, {
          action: "deliver this milestone anyway",
        }).message,
      );
      showApiError(res, "deliver this milestone anyway");
      return;
    }
    setMilestones((prev) =>
      prev.map((m) => (m.id === res.data.id ? res.data : m)),
    );
    setMsEditTarget(null);
    toast.success("Milestone updated", res.data.name);
  }

  /* ===========================================================
   * SỬA VIỆC — PUT /api/group-tasks/{taskId}
   * =========================================================== */

  /** Mở modal sửa việc — nạp sẵn giá trị hiện tại vào form. */
  function openTaskEditModal(t: GroupTaskDto) {
    setTaskEditForm({
      title: t.title ?? "",
      description: t.description ?? "",
      priority: (t.priority ?? "Medium") as GroupPriority,
      milestoneId: t.milestoneId ?? "",
      assigneeId: t.assigneeId ?? "",
      deadline: toDatetimeLocal(t.deadline),
      estimatedMinutes:
        t.estimatedMinutes != null ? String(t.estimatedMinutes) : "",
      fixedStart: toDatetimeLocal(t.fixedStart),
      fixedEnd: toDatetimeLocal(t.fixedEnd),
    });
    setTaskEditFormError(null);
    setTaskEditTarget(t);
  }

  /**
   * Lưu việc đã sửa → `PUT /api/group-tasks/{taskId}`.
   *
   * Body theo Swagger: `{ title, description, priority, milestoneId,
   * assigneeId, deadline, estimatedMinutes, fixedStart, fixedEnd }`.
   *
   * ⚠️ PUT KHÔNG đổi `status` (BE có endpoint riêng cho việc đó) → ta gửi
   * kèm nhưng không kỳ vọng BE đổi.
   */
  async function handleSaveTask(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!taskEditTarget) return;
    const title = taskEditForm.title.trim();
    if (!title) {
      setTaskEditFormError("Please enter a task title.");
      return;
    }
    if (
      taskEditForm.fixedStart &&
      taskEditForm.fixedEnd &&
      new Date(taskEditForm.fixedEnd) <= new Date(taskEditForm.fixedStart)
    ) {
      setTaskEditFormError("Fixed end time must be after the fixed start time.");
      return;
    }
    setTaskEditFormError(null);
    setBusy(true);
    const res = await updateGroupTask(taskEditTarget.id, {
      title,
      description: taskEditForm.description.trim() || null,
      priority: taskEditForm.priority,
      milestoneId: taskEditForm.milestoneId || null,
      assigneeId: taskEditForm.assigneeId || null,
      deadline: taskEditForm.deadline
        ? new Date(taskEditForm.deadline).toISOString()
        : null,
      estimatedMinutes: taskEditForm.estimatedMinutes
        ? Number(taskEditForm.estimatedMinutes)
        : null,
      fixedStart: taskEditForm.fixedStart
        ? new Date(taskEditForm.fixedStart).toISOString()
        : null,
      fixedEnd: taskEditForm.fixedEnd
        ? new Date(taskEditForm.fixedEnd).toISOString()
        : null,
    });
    setBusy(false);
    if (!res.ok) {
      setTaskEditFormError(
        toGroupErrorView(res, undefined, { action: "update this task" }).message,
      );
      showApiError(res, "update this task");
      return;
    }
    setTasks((prev) => prev.map((t) => (t.id === res.data.id ? res.data : t)));
    setTaskEditTarget(null);
    toast.success("Task updated", res.data.title);

    /*
     * ⚠️ Theo spec, `PUT /api/group-tasks/{id}` có nhận `assigneeId` nhưng BE
     * có thể BỎ QUA nó (endpoint riêng: `PUT /api/group-tasks/{id}/assignee`).
     * → So sánh kết quả thực tế: nếu người nhận chưa đúng ý user thì gọi
     * thêm endpoint chuyên dụng (có xử lý 409 GROUP_ASSIGNEE_BUSY sẵn).
     */
    const wantedAssignee = taskEditForm.assigneeId || null;
    if (wantedAssignee !== (res.data.assigneeId ?? null)) {
      void handleAssign(
        { ...res.data, assigneeId: res.data.assigneeId ?? null },
        wantedAssignee ?? "",
      );
    }
  }

  /* ===========================================================
   * SỬA VIỆC CON — PUT /api/group-subtasks/{subTaskId}
   * =========================================================== */

  /** Mở modal sửa việc con. */
  function openSubTaskEditModal(taskId: string, s: GroupSubTaskDto) {
    setSubEditForm({
      title: s.title ?? "",
      estimatedMinutes:
        s.estimatedMinutes != null ? String(s.estimatedMinutes) : "",
      assigneeId: s.assigneeId ?? "",
      orderIndex: String(s.orderIndex ?? 1),
    });
    setSubEditFormError(null);
    setSubEditTaskId(taskId);
    setSubEditTarget(s);
  }

  /**
   * Lưu việc con đã sửa → `PUT /api/group-subtasks/{subTaskId}`.
   *
   * ⚠️ Sau khi đổi, PHẢI gọi lại việc cha (`getGroupTask`) vì status việc cha
   * có thể tự suy theo việc con.
   */
  async function handleSaveSubTask(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!subEditTarget || !subEditTaskId) return;
    const title = subEditForm.title.trim();
    if (!title) {
      setSubEditFormError("Please enter a subtask title.");
      return;
    }
    const orderIndex = Number(subEditForm.orderIndex);
    if (!Number.isFinite(orderIndex) || orderIndex < 1) {
      setSubEditFormError("Order index must be 1 or greater.");
      return;
    }
    setSubEditFormError(null);
    setBusy(true);
    const res = await updateGroupSubTask(subEditTarget.id, {
      title,
      estimatedMinutes: subEditForm.estimatedMinutes
        ? Number(subEditForm.estimatedMinutes)
        : null,
      assigneeId: subEditForm.assigneeId || null,
      orderIndex,
    });
    setBusy(false);
    if (!res.ok) {
      setSubEditFormError(
        toGroupErrorView(res, undefined, { action: "update this subtask" })
          .message,
      );
      showApiError(res, "update this subtask");
      return;
    }
    // Cập nhật list việc con của việc cha.
    setSubTasks((prev) => ({
      ...prev,
      [subEditTaskId]: (prev[subEditTaskId] ?? []).map((s) =>
        s.id === res.data.id ? res.data : s,
      ),
    }));
    setSubEditTarget(null);
    setSubEditTaskId(null);
    toast.success("Subtask updated", res.data.title);
    // Nạp lại việc cha vì status việc cha có thể suy theo việc con.
    void refreshParentTask(subEditTaskId);
  }

  /** Nạp lại 1 việc cha (dùng sau khi sửa việc con). */
  async function refreshParentTask(taskId: string) {
    const res = await getGroupTask(taskId);
    if (!res.ok) return;
    setTasks((prev) => prev.map((t) => (t.id === res.data.id ? res.data : t)));
  }

  /* ---------- Thêm việc con ---------- */
  async function handleCreateSubTask(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!subModalFor) return;
    const title = subForm.title.trim();
    if (!title) {
      setSubFormError("Please enter a subtask title.");
      return;
    }
    setSubFormError(null);
    setBusy(true);
    const res = await createGroupSubTask(subModalFor, {
      title,
      estimatedMinutes: subForm.estimatedMinutes
        ? Number(subForm.estimatedMinutes)
        : null,
      assigneeId: subForm.assigneeId || null,
    });
    setBusy(false);
    if (!res.ok) {
      setSubFormError(
        toGroupErrorView(res, undefined, { action: "add this subtask" }).message,
      );
      showApiError(res, "add this subtask");
      return;
    }
    setSubTasks((prev) => ({
      ...prev,
      [subModalFor]: [...(prev[subModalFor] ?? []), res.data],
    }));
    setSubModalFor(null);
    setSubForm({ title: "", estimatedMinutes: "", assigneeId: "" });
    toast.success("Subtask added");
  }

  /* ---------- Bình luận ---------- */
  async function handleComment(taskId: string) {
    const content = (commentDraft[taskId] ?? "").trim();
    if (!content) return;
    setBusy(true);
    const res = await createGroupComment(taskId, { content });
    setBusy(false);
    if (!res.ok) {
      showApiError(res, "post this comment");
      return;
    }
    setComments((prev) => ({
      ...prev,
      [taskId]: [...(prev[taskId] ?? []), res.data],
    }));
    setCommentDraft((prev) => ({ ...prev, [taskId]: "" }));
  }

  async function handleDeleteComment(taskId: string, commentId: string) {
    const res = await deleteGroupComment(commentId);
    if (!res.ok) {
      showApiError(res, "delete this comment");
      return;
    }
    setComments((prev) => ({
      ...prev,
      [taskId]: (prev[taskId] ?? []).filter((c) => c.id !== commentId),
    }));
  }

  /* ---------- Xoá việc / việc con ---------- */
  async function handleDeleteTask(taskId: string) {
    const res = await deleteGroupTask(taskId);
    if (!res.ok) {
      showApiError(res, "delete this task");
      return;
    }
    setTasks((prev) => prev.filter((t) => t.id !== taskId));
    toast.info("Task deleted");
  }

  async function handleDeleteSubTask(taskId: string, subId: string) {
    const res = await deleteGroupSubTask(subId);
    if (!res.ok) {
      showApiError(res, "delete this subtask");
      return;
    }
    setSubTasks((prev) => ({
      ...prev,
      [taskId]: (prev[taskId] ?? []).filter((s) => s.id !== subId),
    }));
    toast.info("Subtask deleted");
  }

  /* ---------- Thành viên ---------- */
  async function handleRemoveMember(userId: string) {
    if (!group) return;
    const res = await removeGroupMember(group.id, userId);
    if (!res.ok) {
      showApiError(res, "remove this member");
      return;
    }
    setMembers((prev) => prev.filter((m) => m.userId !== userId));
    toast.info("Member removed");
  }

  async function handleLeaveGroup() {
    if (!group) return;
    const res = await leaveGroup(group.id);
    if (!res.ok) {
      showApiError(res, "leave this group");
      return;
    }
    toast.info("Left the group");
    window.location.href = "/groups";
  }

  /* ---------- Mở modal sửa thông tin nhóm ---------- */
  function openGroupEditModal() {
    if (!group) return;
    setGroupForm({
      name: group.name ?? "",
      description: group.description ?? "",
      startDate: toDateInput(group.startDate),
      deadline: toDateInput(group.deadline),
    });
    setGroupFormError(null);
    setGroupModalOpen(true);
  }

  /**
   * Lưu thông tin nhóm đã sửa → `PUT /api/groups/{groupId}`.
   *
   * Body: `{ name, description, startDate, deadline }`.
   */
  async function handleSaveGroup(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!group) return;
    const name = groupForm.name.trim();
    if (!name) {
      setGroupFormError("Please enter a group name.");
      return;
    }
    if (groupForm.startDate && groupForm.deadline) {
      if (new Date(groupForm.deadline) < new Date(groupForm.startDate)) {
        setGroupFormError("Deadline must be on or after the start date.");
        return;
      }
    }
    setGroupFormError(null);
    setBusy(true);
    const res = await updateGroup(group.id, {
      name,
      description: groupForm.description.trim() || null,
      startDate: groupForm.startDate || null,
      deadline: groupForm.deadline || null,
    });
    setBusy(false);
    if (!res.ok) {
      setGroupFormError(
        toGroupErrorView(res, undefined, { action: "update this group" }).message,
      );
      showApiError(res, "update this group");
      return;
    }
    setGroup(res.data);
    setGroupModalOpen(false);
    toast.success("Group updated", res.data.name);
  }

  /* ---------- Lưu trữ / khôi phục ---------- */
  async function handleArchive() {
    if (!group) return;
    const res = await archiveGroup(group.id);
    if (!res.ok) {
      showApiError(res, "archive this group");
      return;
    }
    setGroup((prev) => (prev ? { ...prev, status: "Archived" } : prev));
    toast.info("Group archived");
  }

  async function handleRestore() {
    if (!group) return;
    const res = await restoreGroup(group.id);
    if (!res.ok) {
      showApiError(res, "restore this group");
      return;
    }
    setGroup((prev) => (prev ? { ...prev, status: "Active" } : prev));
    toast.success("Group restored");
  }

  /* =========================================================
   * Render
   * ========================================================= */
  if (loading) {
    return (
      <div className="gdt">
        <div className="gdt-container">
          <div className="gdt-state">
            <span className="material-symbols-outlined gdt-state-icon gdt-state-icon--spin">
              progress_activity
            </span>
            <p>Loading group…</p>
          </div>
        </div>
      </div>
    );
  }

  if (error || !group) {
    return (
      <div className="gdt">
        <div className="gdt-container">
          <div className="gdt-state gdt-state--error">
            <span className="material-symbols-outlined gdt-state-icon">
              error
            </span>
            <p>{error ?? "Group not found."}</p>
            <Link to="/groups" className="gdt-btn gdt-btn--ghost">
              Back to groups
            </Link>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="gdt">
      <div className="gdt-container">
        {/* ================= Header ================= */}
        <header className="gdt-header">
          <div className="gdt-header-text">
            <div className="gdt-breadcrumb">
              <Link to="/groups" className="gdt-breadcrumb-link">
                Groups
              </Link>
              <span className="material-symbols-outlined gdt-breadcrumb-sep">
                chevron_right
              </span>
              <span className="gdt-breadcrumb-current">{group.name}</span>
            </div>
            <span className="gdt-eyebrow">Group workspace</span>
            <h1 className="gdt-title">{group.name}</h1>
            <div className="gdt-tags">
              <span className={`gdt-role gdt-role--${normalizeRole(group.myRole).toLowerCase()}`}>
                {roleLabel(group.myRole)}
              </span>
              <span className="gdt-tag">{group.memberCount} members</span>
              {archived && (
                <span className="gdt-tag gdt-tag--archived">Archived</span>
              )}
              {group.startDate && (
                <span className="gdt-tag">
                  <span className="material-symbols-outlined" aria-hidden="true">
                    event
                  </span>
                  {fmtGroupDate(group.startDate)}
                </span>
              )}
              {group.deadline && (
                <span className="gdt-tag">
                  <span className="material-symbols-outlined" aria-hidden="true">
                    flag
                  </span>
                  {fmtGroupDate(group.deadline)}
                </span>
              )}
            </div>
            {group.description && (
              <p className="gdt-desc">{group.description}</p>
            )}
          </div>

          <div className="gdt-header-actions">
            {/*
             * Chat AI của nhóm → TRANG RIÊNG (layout 3 cột: lịch sử chat ·
             * khung chat · bản nháp plan). Bản nháp nằm cột phải nên luôn
             * hiện ngay, không phải cuộn trong khung chat.
             */}
            {leader && !archived && (
              <Link
                to={`/groups/${groupId}/ai`}
                className="gdt-btn gdt-btn--primary"
                title="Bàn brief và lập kế hoạch cho nhóm"
              >
                <span className="material-symbols-outlined gdt-btn-icon">
                  auto_awesome
                </span>
                <span>Lập kế hoạch với AI</span>
              </Link>
            )}
            {leader && !archived && (
              <button
                type="button"
                className="gdt-btn gdt-btn--ghost"
                onClick={() => void handleArchive()}
              >
                <span className="material-symbols-outlined gdt-btn-icon">
                  archive
                </span>
                <span>Archive</span>
              </button>
            )}
            {leader && archived && (
              <button
                type="button"
                className="gdt-btn gdt-btn--ghost"
                onClick={() => void handleRestore()}
              >
                <span className="material-symbols-outlined gdt-btn-icon">
                  unarchive
                </span>
                <span>Restore</span>
              </button>
            )}
            {leader && !archived && (
              <button
                type="button"
                className="gdt-btn gdt-btn--ghost"
                onClick={openGroupEditModal}
                title="Edit group name, description and dates"
              >
                <span className="material-symbols-outlined gdt-btn-icon">
                  edit
                </span>
                <span>Edit group</span>
              </button>
            )}
          </div>
        </header>

        {/* ================= Tiến độ ================= */}
        {progress && (
          <section className="gdt-progress">
            <div className="gdt-progress-bar">
              <div
                className="gdt-progress-fill"
                style={{ width: `${Math.min(100, progress.completedPercent)}%` }}
                role="progressbar"
                aria-valuenow={progress.completedPercent}
                aria-valuemin={0}
                aria-valuemax={100}
              />
            </div>
            <div className="gdt-progress-stats">
              <span className="gdt-stat gdt-stat--accent">
                <span className="gdt-stat-value">
                  {progress.completedPercent.toFixed(1)}%
                </span>
                <span className="gdt-stat-label">completed</span>
              </span>
              <span className="gdt-stat">
                <span className="gdt-stat-value">{progress.totalTasks}</span>
                <span className="gdt-stat-label">tasks</span>
              </span>
              <span className="gdt-stat">
                <span className="gdt-stat-value">{progress.remainingTasks}</span>
                <span className="gdt-stat-label">remaining</span>
              </span>
              <span className="gdt-stat">
                <span className="gdt-stat-value">
                  {progress.unassignedTasks}
                </span>
                <span className="gdt-stat-label">unassigned</span>
              </span>
              <span className="gdt-stat gdt-stat--accent">
                <span className="gdt-stat-value">
                  {fmtMinutes(progress.totalTrackedMinutes)}
                </span>
                <span className="gdt-stat-label">tracked</span>
              </span>
              <span className="gdt-stat">
                <span className="gdt-stat-value">
                  {fmtMinutes(progress.totalEstimatedMinutes)}
                </span>
                <span className="gdt-stat-label">estimated</span>
              </span>
            </div>

            {/*
              Tín hiệu tiến độ (mục 10 của cập nhật BE): 4 loại rủi ro —
              quá hạn, chưa có lịch, nguy cơ trễ, đứng yên.
              BE có thể chưa trả `signals` → ẩn hẳn nếu rỗng.
            */}
            {groupSignals.length > 0 && (
              <div className="gdt-signals">
                <div className="gdt-signals-head">
                  <span className="gdt-signals-eyebrow">Progress signals</span>
                  <span className="gdt-signals-hint">
                    Where this group needs attention right now
                  </span>
                </div>
                <ul className="gdt-signals-grid">
                  {groupSignals.map((sig) => {
                    const meta = signalLabel(sig.type);
                    return (
                      <li
                        key={sig.type}
                        className="gdt-signal"
                        data-tone={meta.tone}
                        title={meta.hint}
                      >
                        <span className="gdt-signal-icon">
                          <span
                            className="material-symbols-outlined"
                            aria-hidden="true"
                          >
                            {meta.icon}
                          </span>
                        </span>
                        <span className="gdt-signal-body">
                          <span className="gdt-signal-value">
                            {sig.count}
                          </span>
                          <span className="gdt-signal-label">{meta.label}</span>
                        </span>
                        {sig.taskTitles && sig.taskTitles.length > 0 && (
                          <span className="gdt-signal-tasks">
                            {sig.taskTitles.slice(0, 2).join(" · ")}
                            {sig.taskTitles.length > 2
                              ? ` +${sig.taskTitles.length - 2} more`
                              : ""}
                          </span>
                        )}
                        {sig.message && (
                          <span className="gdt-signal-note">{sig.message}</span>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </div>
            )}
          </section>
        )}

        {/* ================= Tabs ================= */}
        <nav className="gdt-tabs" role="tablist">
          {(
            [
              { key: "tasks", label: "Tasks", icon: "checklist", count: tasks.length },
              {
                key: "schedule",
                label: "Schedule",
                icon: "calendar_month",
                count: 0,
              },
              {
                key: "milestones",
                label: "Milestones",
                icon: "flag",
                count: milestones.length,
              },
              {
                key: "members",
                label: "Members",
                icon: "group",
                count: members.length,
              },
              {
                key: "activity",
                label: "Activity",
                icon: "history",
                count: activity.length,
              },
              /*
               * ⚠️ KHÔNG có tab "Chat AI" ở đây nữa.
               *
               * Chat AI của nhóm đã tách ra TRANG RIÊNG `/groups/:groupId/ai`
               * (layout 3 cột: lịch sử chat · khung chat · bản nháp plan).
               * Leader vào bằng nút "Chat AI" ở header.
               */
            ] as const
          ).map((t) => (
            <button
              key={t.key}
              type="button"
              role="tab"
              aria-selected={tab === t.key}
              className={
                "gdt-tab" + (tab === t.key ? " gdt-tab--on" : "")
              }
              onClick={() => setTab(t.key)}
            >
              <span className="material-symbols-outlined gdt-tab-icon">
                {t.icon}
              </span>
              <span>{t.label}</span>
              <span className="gdt-tab-count">{t.count}</span>
            </button>
          ))}
        </nav>

        {/* ================= TAB: TASKS ================= */}
        {tab === "tasks" && (
          <section className="gdt-panel">
            <div className="gdt-section-head">
              <div className="gdt-section-head-text">
                <span className="gdt-section-eyebrow">Work items</span>
                <h2 className="gdt-section-title">Tasks</h2>
              </div>
              <div className="gdt-toolbar">
                <select
                  className="gdt-select"
                  value={statusFilter}
                  onChange={(e) => setStatusFilter(e.target.value)}
                  aria-label="Filter by status"
                >
                  <option value="">All statuses</option>
                  {GROUP_TASK_STATUSES.map((s) => (
                    <option key={s} value={s}>
                      {taskStatusLabel(s).label}
                    </option>
                  ))}
                </select>
                <select
                  className="gdt-select"
                  value={assigneeFilter}
                  onChange={(e) => setAssigneeFilter(e.target.value)}
                  aria-label="Filter by assignee"
                >
                  <option value="">All assignees</option>
                  <option value="__unassigned__">Unassigned</option>
                  {members.map((m) => (
                    <option key={m.userId} value={m.userId}>
                      {m.fullName}
                    </option>
                  ))}
                </select>
                <span className="gdt-toolbar-count">
                  {visibleTasks.length}/{tasks.length} tasks
                </span>
                {leader && !archived && (
                  <button
                    type="button"
                    className="gdt-btn gdt-btn--primary"
                    onClick={() => {
                      setTaskFormError(null);
                      setTaskModalOpen(true);
                    }}
                  >
                    <span className="material-symbols-outlined gdt-btn-icon">
                      add_task
                    </span>
                    <span>New task</span>
                  </button>
                )}
              </div>
            </div>

            {visibleTasks.length === 0 ? (
              <div className="gdt-state">
                <span className="material-symbols-outlined gdt-state-icon">
                  checklist
                </span>
                <p>No tasks yet.</p>
              </div>
            ) : (
              <ul className="gdt-task-list">
                {visibleTasks.map((t) => {
                  const subs = subTasks[t.id] ?? [];
                  const list = comments[t.id] ?? [];
                  const expanded = openTaskId === t.id;
                  const st = taskStatusLabel(t.status);
                  const canStatus = canChangeTaskStatus(
                    group,
                    t,
                    user?.id ?? null,
                  );
                  return (
                    <li
                      key={t.id}
                      id={`gdt-task-${t.id}`}
                      className={`gdt-task gdt-task--${st.tone}`}
                    >
                      <div className="gdt-task-main">
                        <button
                          type="button"
                          className="gdt-task-expand"
                          onClick={() => void openTask(t.id)}
                          aria-expanded={expanded}
                          aria-label={
                            expanded ? "Collapse task" : "Open task details"
                          }
                        >
                          <span
                            className={
                              "material-symbols-outlined gdt-task-caret" +
                              (expanded ? " gdt-task-caret--on" : "")
                            }
                          >
                            chevron_right
                          </span>
                        </button>

                        <div className="gdt-task-body">
                          <div className="gdt-task-title-row">
                            <span className="gdt-task-title">{t.title}</span>
                            <span className={`gdt-status gdt-status--${st.tone}`}>
                              {st.label}
                            </span>
                            <span
                              className={`gdt-priority gdt-priority--${priorityTone(t.priority)}`}
                            >
                              {priorityLabel(t.priority)}
                            </span>
                          </div>

                          <div className="gdt-task-meta">
                            {t.assigneeName ? (
                              <span className="gdt-task-meta-item">
                                <span
                                  className="material-symbols-outlined"
                                  aria-hidden="true"
                                >
                                  person
                                </span>
                                {t.assigneeName}
                              </span>
                            ) : (
                              <span className="gdt-task-meta-item gdt-task-meta-item--warn">
                                <span
                                  className="material-symbols-outlined"
                                  aria-hidden="true"
                                >
                                  person_alert
                                </span>
                                Unassigned
                              </span>
                            )}
                            {t.subTaskCount > 0 && (
                              <span className="gdt-task-meta-item">
                                <span
                                  className="material-symbols-outlined"
                                  aria-hidden="true"
                                >
                                  subdirectory_arrow_right
                                </span>
                                {t.subTaskDoneCount}/{t.subTaskCount} subtasks
                              </span>
                            )}
                            {t.estimatedMinutes != null && (
                              <span className="gdt-task-meta-item">
                                <span
                                  className="material-symbols-outlined"
                                  aria-hidden="true"
                                >
                                  timer
                                </span>
                                {fmtMinutes(t.estimatedMinutes)}
                              </span>
                            )}
                            {t.deadline && (
                              <span className="gdt-task-meta-item">
                                <span
                                  className="material-symbols-outlined"
                                  aria-hidden="true"
                                >
                                  event
                                </span>
                                {fmtGroupDateTime(t.deadline)}
                              </span>
                            )}
                            {t.fixedStart && t.fixedEnd && (
                              <span className="gdt-task-meta-item gdt-task-meta-item--fixed">
                                <span
                                  className="material-symbols-outlined"
                                  aria-hidden="true"
                                >
                                  lock_clock
                                </span>
                                {fmtGroupDateTime(t.fixedStart)} →{" "}
                                {fmtGroupDateTime(t.fixedEnd)}
                              </span>
                            )}
                          </div>
                        </div>

                        {/* ----- Điều khiển ----- */}
                        <div className="gdt-task-actions">
                          {canStatus && (
                            <select
                              className="gdt-select gdt-select--inline"
                              value={t.status}
                              disabled={busy || archived}
                              onChange={(e) =>
                                void handleTaskStatus(t, e.target.value)
                              }
                              aria-label={`Change status: ${t.title}`}
                            >
                              {GROUP_TASK_STATUSES.map((s) => (
                                <option key={s} value={s}>
                                  {taskStatusLabel(s).label}
                                </option>
                              ))}
                            </select>
                          )}

                          {canManage && !archived && (
                            <select
                              className="gdt-select gdt-select--inline"
                              value={t.assigneeId ?? ""}
                              disabled={busy}
                              onChange={(e) => {
                                // Xem trước tình trạng người nhận (spec mục 8).
                                void handlePreviewAssignee(t, e.target.value);
                                void handleAssign(t, e.target.value);
                              }}
                              aria-label={`Assign task: ${t.title}`}
                            >
                              <option value="">Chưa giao</option>
                              {members.map((m) => (
                                <option key={m.userId} value={m.userId}>
                                  {m.fullName}
                                </option>
                              ))}
                            </select>
                          )}

                          {/*
                           * Nút "Gợi ý người làm" bằng AI (spec GROUP_AI_FE.md mục 1).
                           * Chỉ Leader, chỉ việc chưa xong (ToDo / InProgress) —
                           * AI service trả 409 nếu việc đã Done/Skipped.
                           */}
                          {leader &&
                            !archived &&
                            (t.status === "ToDo" || t.status === "InProgress") && (
                              <button
                                type="button"
                                className="gai-suggest-btn"
                                onClick={() => void handleOpenSuggestions(t)}
                                disabled={busy}
                                title="Xem ai phù hợp với công việc này"
                              >
                                <span
                                  className="material-symbols-outlined"
                                  aria-hidden="true"
                                >
                                  auto_awesome
                                </span>
                                Gợi ý người làm
                              </button>
                            )}

                          {/*
                            Nút "Gợi ý giờ" bằng AI (FR-25 — spec mục 3).
                            AI tìm giờ trống trong lịch của MÌNH cho phần
                            việc được giao. Không tốn lượt AI.
                            Chỉ hiện với người được giao (Leader hoặc Member) —
                            người khác gọi API sẽ bị 403.
                          */}
                          {!archived &&
                            canSuggestTimes(t, subs, user?.id ?? null) && (
                              <button
                                type="button"
                                className="gai-timeslot-btn"
                                onClick={() => void handleOpenTimeSuggestions(t)}
                                disabled={busy}
                                title="Tìm giờ trống cho phần việc của bạn"
                              >
                                <span
                                  className="material-symbols-outlined"
                                  aria-hidden="true"
                                >
                                  event_available
                                </span>
                                Tìm giờ cho việc của tôi
                              </button>
                            )}

                          {/* Dấu cảnh báo bận / quá tải bên cạnh người nhận. */}
                          {availability[t.id] && (
                            <span
                              className={
                                "gdt-avail" +
                                (availability[t.id].isBusy ||
                                availability[t.id].workload?.isOverloaded
                                  ? " gdt-avail--warn"
                                  : " gdt-avail--ok")
                              }
                              title={
                                availability[t.id].conflicts.length > 0
                                  ? availability[t.id].conflicts
                                      .map(
                                        (c) =>
                                          `${fmtGroupDateTime(c.start)} → ${fmtGroupDateTime(c.end)} (${busySourceLabel(c.source)})`,
                                      )
                                      .join("\n")
                                  : "Assignee is free"
                              }
                            >
                              <span className="material-symbols-outlined">
                                {availability[t.id].isBusy ||
                                availability[t.id].workload?.isOverloaded
                                  ? "warning"
                                  : "check_circle"}
                              </span>
                              {availability[t.id].isBusy
                                ? "Busy"
                                : availability[t.id].workload?.isOverloaded
                                  ? "Overloaded"
                                  : "Free"}
                            </span>
                          )}

                          {canManage && !archived && (
                            <button
                              type="button"
                              className="gdt-icon-btn gdt-icon-btn--edit"
                              title="Edit task"
                              aria-label={`Edit task ${t.title}`}
                              onClick={() => openTaskEditModal(t)}
                            >
                              <span className="material-symbols-outlined">
                                edit
                              </span>
                            </button>
                          )}
                          {canManage && !archived && (
                            <button
                              type="button"
                              className="gdt-icon-btn"
                              title="Delete task"
                              aria-label={`Delete task ${t.title}`}
                              onClick={() => void handleDeleteTask(t.id)}
                            >
                              <span className="material-symbols-outlined">
                                delete
                              </span>
                            </button>
                          )}
                        </div>
                      </div>

                      {/* ----- Chi tiết: việc con + lịch + bình luận ----- */}
                      {expanded && (
                        <div className="gdt-task-detail">
                          {/*
                            Khung giờ của việc nhóm (mục 10 của cập nhật BE).
                            Tạo / xem / hủy slot + bắt 409 SLOT_OVERLAP.
                          */}
                          <div className="gdt-sub">
                            <GroupScheduleSlots
                              groupTaskId={t.id}
                              taskTitle={t.title}
                              groupName={group?.name ?? null}
                              subTasks={subs.map((s) => ({
                                id: s.id,
                                title: s.title,
                              }))}
                              assigneeId={t.assigneeId ?? null}
                              currentUserId={user?.id ?? null}
                              archived={archived}
                              canManage={canManage}
                              onError={(payload) => setErrorDialog(payload)}
                            />
                          </div>

                          {/* Việc con */}
                          <div className="gdt-sub">
                            <div className="gdt-sub-head">
                              <h4 className="gdt-sub-title">
                                Subtasks
                                <span className="gdt-sub-count">
                                  {subs.length}
                                </span>
                              </h4>
                              {canManage && !archived && (
                                <button
                                  type="button"
                                  className="gdt-btn gdt-btn--ghost gdt-btn--sm"
                                  onClick={() => {
                                    setSubModalFor(t.id);
                                    setSubFormError(null);
                                    setSubForm({
                                      title: "",
                                      estimatedMinutes: "",
                                      assigneeId: "",
                                    });
                                  }}
                                >
                                  <span className="material-symbols-outlined gdt-btn-icon">
                                    add
                                  </span>
                                  <span>Add subtask</span>
                                </button>
                              )}
                            </div>

                            {subs.length === 0 ? (
                              <p className="gdt-empty">
                                No subtasks yet.
                              </p>
                            ) : (
                              <ul className="gdt-sub-list">
                                {subs.map((s) => {
                                  const sst = taskStatusLabel(s.status);
                                  const sCanStatus = canChangeTaskStatus(
                                    group,
                                    t,
                                    user?.id ?? null,
                                    s.assigneeId === user?.id,
                                  );
                                  return (
                                    <li key={s.id} className="gdt-sub-item">
                                      <span
                                        className={`gdt-status gdt-status--${sst.tone} gdt-status--sm`}
                                      >
                                        {sst.label}
                                      </span>
                                      <span className="gdt-sub-name">
                                        {s.title}
                                      </span>
                                      {s.assigneeName && (
                                        <span className="gdt-sub-assignee">
                                          {s.assigneeName}
                                        </span>
                                      )}
                                      {s.estimatedMinutes != null && (
                                        <span className="gdt-sub-est">
                                          {fmtMinutes(s.estimatedMinutes)}
                                        </span>
                                      )}
                                      {sCanStatus && !archived && (
                                        <select
                                          className="gdt-select gdt-select--inline gdt-select--sm"
                                          value={s.status}
                                          disabled={busy}
                                          onChange={(e) =>
                                            void handleSubTaskStatus(
                                              t,
                                              s,
                                              e.target.value,
                                            )
                                          }
                                          aria-label={`Change status: ${s.title}`}
                                        >
                                          {GROUP_TASK_STATUSES.map((x) => (
                                            <option key={x} value={x}>
                                              {taskStatusLabel(x).label}
                                            </option>
                                          ))}
                                        </select>
                                      )}
                                      {canManage && !archived && (
                                        <button
                                          type="button"
                                          className="gdt-icon-btn gdt-icon-btn--sm gdt-icon-btn--edit"
                                          title="Edit subtask"
                                          aria-label={`Edit subtask ${s.title}`}
                                          onClick={() =>
                                            openSubTaskEditModal(t.id, s)
                                          }
                                        >
                                          <span className="material-symbols-outlined">
                                            edit
                                          </span>
                                        </button>
                                      )}
                                      {canManage && !archived && (
                                        <button
                                          type="button"
                                          className="gdt-icon-btn gdt-icon-btn--sm"
                                          title="Delete subtask"
                                          aria-label={`Delete subtask ${s.title}`}
                                          onClick={() =>
                                            void handleDeleteSubTask(t.id, s.id)
                                          }
                                        >
                                          <span className="material-symbols-outlined">
                                            close
                                          </span>
                                        </button>
                                      )}
                                    </li>
                                  );
                                })}
                              </ul>
                            )}
                          </div>

                          {/* Bình luận */}
                          <div className="gdt-comments">
                            <h4 className="gdt-sub-title">
                              Comments
                              <span className="gdt-sub-count">{list.length}</span>
                            </h4>
                            {list.length === 0 ? (
                              <p className="gdt-empty">
                                No comments yet. Mention someone with @email.
                              </p>
                            ) : (
                              <ul className="gdt-comment-list">
                                {list.map((c) => (
                                  <li key={c.id} className="gdt-comment">
                                    <span className="gdt-comment-avatar">
                                      {c.authorName.trim().charAt(0).toUpperCase()}
                                    </span>
                                    <div className="gdt-comment-body">
                                      <span className="gdt-comment-head">
                                        <strong>{c.authorName}</strong>
                                        <span className="gdt-comment-time">
                                          {fmtRelativeTime(c.createdAt)}
                                        </span>
                                      </span>
                                      <span className="gdt-comment-text">
                                        {c.content}
                                      </span>
                                    </div>
                                    {(c.authorId === user?.id || leader) && (
                                      <button
                                        type="button"
                                        className="gdt-icon-btn gdt-icon-btn--sm"
                                        title="Delete comment"
                                        aria-label="Delete comment"
                                        onClick={() =>
                                          void handleDeleteComment(t.id, c.id)
                                        }
                                      >
                                        <span className="material-symbols-outlined">
                                          delete
                                        </span>
                                      </button>
                                    )}
                                  </li>
                                ))}
                              </ul>
                            )}
                            <div className="gdt-comment-input">
                              <input
                                type="text"
                                className="gdt-input"
                                placeholder="Write a comment… use @email to mention"
                                value={commentDraft[t.id] ?? ""}
                                onChange={(e) =>
                                  setCommentDraft((prev) => ({
                                    ...prev,
                                    [t.id]: e.target.value,
                                  }))
                                }
                                onKeyDown={(e) => {
                                  if (e.key === "Enter") {
                                    e.preventDefault();
                                    void handleComment(t.id);
                                  }
                                }}
                              />
                              <button
                                type="button"
                                className="gdt-btn gdt-btn--primary gdt-btn--sm"
                                onClick={() => void handleComment(t.id)}
                                disabled={busy || !(commentDraft[t.id] ?? "").trim()}
                              >
                                <span className="material-symbols-outlined gdt-btn-icon">
                                  send
                                </span>
                                <span>Send</span>
                              </button>
                            </div>
                          </div>
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        )}

        {/* ================= TAB: SCHEDULE ================= */}
        {/*
          Lịch tuần của nhóm — ai làm việc gì, khung giờ nào, tiến độ tới
          đâu. Dùng chung slot với lịch cá nhân (`/schedule`) nên mọi người
          thấy cùng một bức tranh.
        */}
        {tab === "schedule" && (
          <section className="gdt-panel">
            <div className="gdt-section-head">
              <div className="gdt-section-head-text">
                <span className="gdt-section-eyebrow">Time plan</span>
                <h2 className="gdt-section-title">Schedule</h2>
              </div>
              <div className="gdt-toolbar">
                <span className="gdt-toolbar-count">
                  {tasks.length} tasks · {members.length} members
                </span>
              </div>
            </div>

            <GroupScheduleBoard
              groupId={groupId}
              tasks={tasks}
              groupName={group?.name ?? null}
              memberNames={memberNames}
              archived={archived}
              onOpenTask={(taskId) => {
                // Bấm khối lịch → nhảy sang tab Tasks và mở đúng việc đó.
                setTab("tasks");
                void openTask(taskId);
                setTimeout(() => {
                  document
                    .getElementById(`gdt-task-${taskId}`)
                    ?.scrollIntoView({
                      behavior: "smooth",
                      block: "center",
                    });
                }, 60);
              }}
            />
          </section>
        )}

        {/* ================= TAB: MILESTONES ================= */}
        {tab === "milestones" && (
          <section className="gdt-panel">
            <div className="gdt-section-head">
              <div className="gdt-section-head-text">
                <span className="gdt-section-eyebrow">Delivery phases</span>
                <h2 className="gdt-section-title">Milestones</h2>
              </div>
              <div className="gdt-toolbar">
                <span className="gdt-toolbar-count">
                  {milestones.length} milestones
                </span>
                {leader && !archived && (
                  <button
                    type="button"
                    className="gdt-btn gdt-btn--primary gdt-btn--sm"
                    onClick={() => {
                      setMsFormError(null);
                      setMsForm({
                        name: "",
                        orderIndex: String(milestones.length + 1),
                        dueDate: "",
                        status: "Planned",
                      });
                      setMsModalOpen(true);
                    }}
                  >
                    <span className="material-symbols-outlined gdt-btn-icon">
                      add
                    </span>
                    <span>New milestone</span>
                  </button>
                )}
              </div>
            </div>

            {milestones.length === 0 ? (
              <div className="gdt-state">
                <span className="material-symbols-outlined gdt-state-icon">
                  flag
                </span>
                <p>No milestones yet.</p>
              </div>
            ) : (
              <ul className="gdt-ms-list">
                {milestones
                  .slice()
                  .sort((a, b) => a.orderIndex - b.orderIndex)
                  .map((m) => {
                    const st = milestoneStatusLabel(m.status);
                    const related = tasks.filter(
                      (t) => t.milestoneId === m.id,
                    );
                    const done = related.filter(
                      (t) => t.status === "Done" || t.status === "Skipped",
                    ).length;
                    return (
                      <li key={m.id} className="gdt-ms">
                        <div className="gdt-ms-head">
                          <span className="gdt-ms-order">
                            {m.orderIndex}
                          </span>
                          <span className="gdt-ms-name">{m.name}</span>
                          <span className={`gdt-status gdt-status--${st.tone}`}>
                            {st.label}
                          </span>
                          {m.dueDate && (
                            <span className="gdt-ms-due">
                              <span
                                className="material-symbols-outlined"
                                aria-hidden="true"
                              >
                                event
                              </span>
                              {fmtGroupDate(m.dueDate)}
                            </span>
                          )}
                          <span className="gdt-ms-progress">
                            {done}/{related.length}
                          </span>
                        </div>
                        <div className="gdt-ms-actions">
                          {leader && !archived && (
                            <select
                              className="gdt-select gdt-select--inline gdt-select--sm"
                              value={m.status}
                              disabled={busy}
                              onChange={(e) =>
                                void handleMilestoneStatus(
                                  m,
                                  e.target.value as GroupMilestoneStatus,
                                )
                              }
                              aria-label={`Change status: ${m.name}`}
                            >
                              {GROUP_MILESTONE_STATUSES.map((s) => (
                                <option key={s} value={s}>
                                  {milestoneStatusLabel(s).label}
                                </option>
                              ))}
                            </select>
                          )}
                          {leader && !archived && (
                            <button
                              type="button"
                              className="gdt-icon-btn gdt-icon-btn--sm gdt-icon-btn--edit"
                              title="Edit milestone"
                              aria-label={`Edit milestone ${m.name}`}
                              onClick={() => openMilestoneEditModal(m)}
                            >
                              <span className="material-symbols-outlined">
                                edit
                              </span>
                            </button>
                          )}
                          {leader && !archived && (
                            <button
                              type="button"
                              className="gdt-icon-btn gdt-icon-btn--sm"
                              title="Delete milestone"
                              aria-label={`Delete milestone ${m.name}`}
                              onClick={async () => {
                                const res = await deleteGroupMilestone(m.id);
                                if (!res.ok) {
                                  showApiError(res, "delete this milestone");
                                  return;
                                }
                                setMilestones((prev) =>
                                  prev.filter((x) => x.id !== m.id),
                                );
                                toast.info("Milestone deleted");
                              }}
                            >
                              <span className="material-symbols-outlined">
                                delete
                              </span>
                            </button>
                          )}
                        </div>
                      </li>
                    );
                  })}
              </ul>
            )}
          </section>
        )}

        {/* ================= TAB: MEMBERS ================= */}
        {tab === "members" && (
          <section className="gdt-panel">
            <div className="gdt-section-head">
              <div className="gdt-section-head-text">
                <span className="gdt-section-eyebrow">Team</span>
                <h2 className="gdt-section-title">Members</h2>
              </div>
              <div className="gdt-toolbar">
                <span className="gdt-toolbar-count">
                  {members.length} members
                </span>
                {/*
                  * Mời thành viên — mở modal ngay tại trang chi tiết nhóm,
                  * không cần quay lại `/groups`. Chỉ Leader mời được (BE
                  * chặn 403 với vai trò khác) → ẩn nút nếu không phải Leader.
                  */}
                {leader && !archived && (
                  <button
                    type="button"
                    className="gdt-btn gdt-btn--ghost gdt-btn--sm"
                    onClick={() => setInviteOpen(true)}
                  >
                    <span className="material-symbols-outlined gdt-btn-icon">
                      person_add
                    </span>
                    <span>Invite</span>
                  </button>
                )}
              </div>
            </div>

            <ul className="gdt-member-list">
              {members.map((m) => (
                <li key={m.userId} className="gdt-member">
                  <span className="gdt-member-avatar">
                    {m.fullName.trim().charAt(0).toUpperCase()}
                  </span>
                  <div className="gdt-member-body">
                    <span className="gdt-member-name">
                      {m.fullName}
                      {m.userId === user?.id && (
                        <span className="gdt-member-you">you</span>
                      )}
                    </span>
                    <span className="gdt-member-email">{m.email}</span>
                  </div>
                  <span
                    className={`gdt-role gdt-role--${normalizeRole(m.role).toLowerCase()}`}
                  >
                    {roleLabel(m.role)}
                  </span>
                  <span className="gdt-member-joined">
                    {fmtGroupDate(m.joinedAt)}
                  </span>
                  {leader && !archived && m.userId !== user?.id && (
                    <button
                      type="button"
                      className="gdt-icon-btn gdt-icon-btn--sm"
                      title="Remove from group"
                      aria-label={`Remove ${m.fullName} from group`}
                      onClick={() => void handleRemoveMember(m.userId)}
                    >
                      <span className="material-symbols-outlined">
                        person_remove
                      </span>
                    </button>
                  )}
                </li>
              ))}
            </ul>

            {/* Tiến độ từng thành viên */}
            {progress && progress.members.length > 0 && (
              <div className="gdt-mem-progress">
                <h3 className="gdt-sub-title">Member progress</h3>
                <div className="gdt-mem-progress-grid">
                  {progress.members.map((mp) => {
                    const pct =
                      mp.assignedTasks > 0
                        ? Math.round((mp.doneTasks / mp.assignedTasks) * 100)
                        : 0;
                    return (
                      <div
                        key={mp.userId}
                        className="gdt-mem-progress-card"
                      >
                        <span className="gdt-mem-progress-name">
                          {mp.fullName}
                        </span>
                        <span className="gdt-role gdt-role--sm gdt-role--muted">
                          {roleLabel(mp.role)}
                        </span>
                        <div className="gdt-mem-progress-bar">
                          <div
                            className="gdt-mem-progress-fill"
                            style={{ width: `${pct}%` }}
                            role="progressbar"
                            aria-valuenow={pct}
                            aria-valuemin={0}
                            aria-valuemax={100}
                            aria-label={`Progress for ${mp.fullName}`}
                          />
                        </div>
                        <div className="gdt-mem-progress-stats">
                          <span>
                            {mp.doneTasks}/{mp.assignedTasks} tasks
                          </span>
                          <span>
                            {mp.doneSubTasks}/{mp.assignedSubTasks} subtasks
                          </span>
                          <span>{fmtMinutes(mp.trackedMinutes)}</span>
                        </div>
                        {/*
                          Bộ đếm tín hiệu tiến độ mỗi thành viên
                          (mục 10 của cập nhật BE): quá hạn, chưa có lịch,
                          nguy cơ trễ, đứng yên.
                          BE có thể chưa trả → ẩn hẳn nếu tất cả đều 0.
                        */}
                        {memberSignalTotal(mp) > 0 && (
                          <div className="gdt-mem-signals">
                            {memberSignalCounters(mp).map((c) => (
                              <span
                                key={c.key}
                                className="gdt-mem-signal"
                                data-tone={c.tone}
                                title={c.hint}
                              >
                                <span className="material-symbols-outlined">
                                  {c.icon}
                                </span>
                                <span className="gdt-mem-signal-value">
                                  {c.value}
                                </span>
                                <span className="gdt-mem-signal-label">
                                  {c.label}
                                </span>
                              </span>
                            ))}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Rời nhóm */}
            {normalizeRole(group.myRole) !== "Viewer" && (
              <div className="gdt-leave">
                <button
                  type="button"
                  className="gdt-btn gdt-btn--ghost"
                  onClick={() => void handleLeaveGroup()}
                >
                  <span className="material-symbols-outlined gdt-btn-icon">
                    logout
                  </span>
                  <span>Leave group</span>
                </button>
              </div>
            )}
          </section>
        )}

        {/* ================= TAB: ACTIVITY ================= */}
        {tab === "activity" && (
          <section className="gdt-panel">
            <div className="gdt-section-head">
              <div className="gdt-section-head-text">
                <span className="gdt-section-eyebrow">Audit trail</span>
                <h2 className="gdt-section-title">Activity log</h2>
              </div>
              <div className="gdt-toolbar">
                <span className="gdt-toolbar-count">
                  {activity.length} events
                </span>
              </div>
            </div>
            {activity.length === 0 ? (
              <div className="gdt-state">
                <span className="material-symbols-outlined gdt-state-icon">
                  history
                </span>
                <p>No activity yet.</p>
              </div>
            ) : (
              <ul className="gdt-activity-list">
                {activity.map((a) => (
                  <li key={a.id} className="gdt-activity">
                    <span className="gdt-activity-dot" aria-hidden="true" />
                    <div className="gdt-activity-body">
                      <span className="gdt-activity-text">
                        <strong>{a.actorName}</strong>{" "}
                        {activityActionLabel(a.action)}
                        {a.entityType && (
                          <span className="gdt-activity-entity">
                            {" "}
                            · {a.entityType}
                          </span>
                        )}
                      </span>
                      {(a.oldValue || a.newValue) && (
                        <span className="gdt-activity-change">
                          {a.oldValue ?? "—"} → {a.newValue ?? "—"}
                        </span>
                      )}
                    </div>
                    <span className="gdt-activity-time">
                      {fmtRelativeTime(a.createdAt)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        )}
        {/*
         * ⚠️ KHÔNG render tab "Chat AI" cũ ở đây nữa.
         *
         * Chat AI của nhóm nằm ở trang riêng `/groups/:groupId/ai`
         * (layout 3 cột) → Leader vào bằng nút "Chat AI" ở header.
         */}
      </div>

      {/* ================= Modal tạo việc ================= */}
      {taskModalOpen && (
        <div
          className="gdt-modal-backdrop"
          onClick={() => setTaskModalOpen(false)}
          role="presentation"
        >
          <div
            className="gdt-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="gdt-task-title"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="gdt-modal-head">
              <h2 id="gdt-task-title" className="gdt-modal-title">
                <span
                  className="material-symbols-outlined gdt-modal-title-icon"
                  aria-hidden="true"
                >
                  add_task
                </span>
                New task
              </h2>
              <button
                type="button"
                className="gdt-modal-close"
                onClick={() => setTaskModalOpen(false)}
                aria-label="Close"
              >
                <span className="material-symbols-outlined">close</span>
              </button>
            </div>

            <form className="gdt-form" onSubmit={handleCreateTask}>
              <div className="gdt-field">
                <label className="gdt-label" htmlFor="gdt-f-title">
                  Title *
                </label>
                <input
                  id="gdt-f-title"
                  type="text"
                  className="gdt-input"
                  placeholder="e.g. Design the home page"
                  value={taskForm.title}
                  onChange={(e) =>
                    setTaskForm((f) => ({ ...f, title: e.target.value }))
                  }
                  required
                />
              </div>

              <div className="gdt-field">
                <label className="gdt-label" htmlFor="gdt-f-desc">
                  Description
                </label>
                <textarea
                  id="gdt-f-desc"
                  rows={3}
                  className="gdt-input gdt-input--textarea"
                  value={taskForm.description}
                  onChange={(e) =>
                    setTaskForm((f) => ({ ...f, description: e.target.value }))
                  }
                />
              </div>

              <div className="gdt-field-row">
                <div className="gdt-field">
                  <label className="gdt-label" htmlFor="gdt-f-priority">
                    Priority
                  </label>
                  <select
                    id="gdt-f-priority"
                    className="gdt-input"
                    value={taskForm.priority}
                    onChange={(e) =>
                      setTaskForm((f) => ({
                        ...f,
                        priority: e.target.value as GroupPriority,
                      }))
                    }
                  >
                    {GROUP_PRIORITIES.map((p) => (
                      <option key={p} value={p}>
                        {priorityLabel(p)}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="gdt-field">
                  <label className="gdt-label" htmlFor="gdt-f-est">
                    Estimate (min)
                  </label>
                  <input
                    id="gdt-f-est"
                    type="number"
                    min={0}
                    step={5}
                    className="gdt-input"
                    placeholder="90"
                    value={taskForm.estimatedMinutes}
                    onChange={(e) =>
                      setTaskForm((f) => ({
                        ...f,
                        estimatedMinutes: e.target.value,
                      }))
                    }
                  />
                </div>
              </div>

              <div className="gdt-field-row">
                <div className="gdt-field">
                  <label className="gdt-label" htmlFor="gdt-f-ms">
                    Milestone
                  </label>
                  <select
                    id="gdt-f-ms"
                    className="gdt-input"
                    value={taskForm.milestoneId}
                    onChange={(e) =>
                      setTaskForm((f) => ({
                        ...f,
                        milestoneId: e.target.value,
                      }))
                    }
                  >
                    <option value="">—</option>
                    {milestones.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.orderIndex}. {m.name}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="gdt-field">
                  <label className="gdt-label" htmlFor="gdt-f-assignee">
                    Assignee
                  </label>
                  <select
                    id="gdt-f-assignee"
                    className="gdt-input"
                    value={taskForm.assigneeId}
                    onChange={(e) =>
                      setTaskForm((f) => ({
                        ...f,
                        assigneeId: e.target.value,
                      }))
                    }
                  >
                    <option value="">—</option>
                    {members.map((m) => (
                      <option key={m.userId} value={m.userId}>
                        {m.fullName}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <div className="gdt-field">
                <label className="gdt-label" htmlFor="gdt-f-deadline">
                  Deadline
                </label>
                <input
                  id="gdt-f-deadline"
                  type="datetime-local"
                  className="gdt-input"
                  value={taskForm.deadline}
                  onChange={(e) =>
                    setTaskForm((f) => ({ ...f, deadline: e.target.value }))
                  }
                />
              </div>

              {taskFormError && (
                <p className="gdt-form-error">
                  <span className="material-symbols-outlined" aria-hidden="true">
                    error
                  </span>
                  {taskFormError}
                </p>
              )}

              <div className="gdt-form-actions">
                <button
                  type="button"
                  className="gdt-btn gdt-btn--ghost"
                  onClick={() => setTaskModalOpen(false)}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="gdt-btn gdt-btn--primary"
                  disabled={busy}
                >
                  Create task
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ================= Modal sửa việc ================= */}
      {taskEditTarget && (
        <div
          className="gdt-modal-backdrop"
          onClick={() => setTaskEditTarget(null)}
          role="presentation"
        >
          <div
            className="gdt-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="gdt-task-edit-title"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="gdt-modal-head">
              <h2 id="gdt-task-edit-title" className="gdt-modal-title">
                <span
                  className="material-symbols-outlined gdt-modal-title-icon"
                  aria-hidden="true"
                >
                  edit
                </span>
                Edit task
              </h2>
              <button
                type="button"
                className="gdt-modal-close"
                onClick={() => setTaskEditTarget(null)}
                aria-label="Close"
              >
                <span className="material-symbols-outlined">close</span>
              </button>
            </div>

            <form className="gdt-form" onSubmit={handleSaveTask}>
              <div className="gdt-field">
                <label className="gdt-label" htmlFor="gdt-tf-edit-title">
                  Title *
                </label>
                <input
                  id="gdt-tf-edit-title"
                  type="text"
                  className="gdt-input"
                  placeholder="e.g. Design the home page"
                  value={taskEditForm.title}
                  onChange={(e) =>
                    setTaskEditForm((f) => ({ ...f, title: e.target.value }))
                  }
                  required
                />
              </div>

              <div className="gdt-field">
                <label className="gdt-label" htmlFor="gdt-tf-edit-desc">
                  Description
                </label>
                <textarea
                  id="gdt-tf-edit-desc"
                  rows={3}
                  className="gdt-input gdt-input--textarea"
                  value={taskEditForm.description}
                  onChange={(e) =>
                    setTaskEditForm((f) => ({
                      ...f,
                      description: e.target.value,
                    }))
                  }
                />
              </div>

              <div className="gdt-field-row">
                <div className="gdt-field">
                  <label className="gdt-label" htmlFor="gdt-tf-edit-priority">
                    Priority
                  </label>
                  <select
                    id="gdt-tf-edit-priority"
                    className="gdt-input"
                    value={taskEditForm.priority}
                    onChange={(e) =>
                      setTaskEditForm((f) => ({
                        ...f,
                        priority: e.target.value as GroupPriority,
                      }))
                    }
                  >
                    {GROUP_PRIORITIES.map((p) => (
                      <option key={p} value={p}>
                        {priorityLabel(p)}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="gdt-field">
                  <label className="gdt-label" htmlFor="gdt-tf-edit-est">
                    Estimate (min)
                  </label>
                  <input
                    id="gdt-tf-edit-est"
                    type="number"
                    min={0}
                    step={5}
                    className="gdt-input"
                    placeholder="90"
                    value={taskEditForm.estimatedMinutes}
                    onChange={(e) =>
                      setTaskEditForm((f) => ({
                        ...f,
                        estimatedMinutes: e.target.value,
                      }))
                    }
                  />
                </div>
              </div>

              <div className="gdt-field-row">
                <div className="gdt-field">
                  <label className="gdt-label" htmlFor="gdt-tf-edit-ms">
                    Milestone
                  </label>
                  <select
                    id="gdt-tf-edit-ms"
                    className="gdt-input"
                    value={taskEditForm.milestoneId}
                    onChange={(e) =>
                      setTaskEditForm((f) => ({
                        ...f,
                        milestoneId: e.target.value,
                      }))
                    }
                  >
                    <option value="">—</option>
                    {milestones.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.orderIndex}. {m.name}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="gdt-field">
                  <label className="gdt-label" htmlFor="gdt-tf-edit-assignee">
                    Assignee
                  </label>
                  <select
                    id="gdt-tf-edit-assignee"
                    className="gdt-input"
                    value={taskEditForm.assigneeId}
                    onChange={(e) =>
                      setTaskEditForm((f) => ({
                        ...f,
                        assigneeId: e.target.value,
                      }))
                    }
                  >
                    <option value="">—</option>
                    {members.map((m) => (
                      <option key={m.userId} value={m.userId}>
                        {m.fullName}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <div className="gdt-field">
                <label className="gdt-label" htmlFor="gdt-tf-edit-deadline">
                  Deadline
                </label>
                <input
                  id="gdt-tf-edit-deadline"
                  type="datetime-local"
                  className="gdt-input"
                  value={taskEditForm.deadline}
                  onChange={(e) =>
                    setTaskEditForm((f) => ({
                      ...f,
                      deadline: e.target.value,
                    }))
                  }
                />
              </div>

              {/*
                Giờ cố định (họp / hẹn) — khung giờ không thể dời được.
                Gửi `fixedStart` + `fixedEnd` cùng nhau.
              */}
              <div className="gdt-field-row">
                <div className="gdt-field">
                  <label className="gdt-label" htmlFor="gdt-tf-edit-fixed-start">
                    Fixed start
                  </label>
                  <input
                    id="gdt-tf-edit-fixed-start"
                    type="datetime-local"
                    className="gdt-input"
                    value={taskEditForm.fixedStart}
                    onChange={(e) =>
                      setTaskEditForm((f) => ({
                        ...f,
                        fixedStart: e.target.value,
                      }))
                    }
                  />
                </div>
                <div className="gdt-field">
                  <label className="gdt-label" htmlFor="gdt-tf-edit-fixed-end">
                    Fixed end
                  </label>
                  <input
                    id="gdt-tf-edit-fixed-end"
                    type="datetime-local"
                    className="gdt-input"
                    value={taskEditForm.fixedEnd}
                    onChange={(e) =>
                      setTaskEditForm((f) => ({
                        ...f,
                        fixedEnd: e.target.value,
                      }))
                    }
                  />
                </div>
              </div>

              {taskEditFormError && (
                <p className="gdt-form-error">
                  <span className="material-symbols-outlined" aria-hidden="true">
                    error
                  </span>
                  {taskEditFormError}
                </p>
              )}

              <div className="gdt-form-actions">
                <button
                  type="button"
                  className="gdt-btn gdt-btn--ghost"
                  onClick={() => setTaskEditTarget(null)}
                  disabled={busy}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="gdt-btn gdt-btn--primary"
                  disabled={busy}
                >
                  {busy ? "Saving…" : "Save changes"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ================= Modal sửa việc con ================= */}
      {subEditTarget && (
        <div
          className="gdt-modal-backdrop"
          onClick={() => setSubEditTarget(null)}
          role="presentation"
        >
          <div
            className="gdt-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="gdt-sub-edit-title"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="gdt-modal-head">
              <h2 id="gdt-sub-edit-title" className="gdt-modal-title">
                <span
                  className="material-symbols-outlined gdt-modal-title-icon"
                  aria-hidden="true"
                >
                  edit
                </span>
                Edit subtask
              </h2>
              <button
                type="button"
                className="gdt-modal-close"
                onClick={() => setSubEditTarget(null)}
                aria-label="Close"
              >
                <span className="material-symbols-outlined">close</span>
              </button>
            </div>

            <form className="gdt-form" onSubmit={handleSaveSubTask}>
              <div className="gdt-field">
                <label className="gdt-label" htmlFor="gdt-sf-edit-title">
                  Title *
                </label>
                <input
                  id="gdt-sf-edit-title"
                  type="text"
                  className="gdt-input"
                  placeholder="e.g. Write the copy for the landing page"
                  value={subEditForm.title}
                  onChange={(e) =>
                    setSubEditForm((f) => ({ ...f, title: e.target.value }))
                  }
                  required
                />
              </div>

              <div className="gdt-field-row">
                <div className="gdt-field">
                  <label className="gdt-label" htmlFor="gdt-sf-edit-est">
                    Estimate (min)
                  </label>
                  <input
                    id="gdt-sf-edit-est"
                    type="number"
                    min={0}
                    step={5}
                    className="gdt-input"
                    placeholder="45"
                    value={subEditForm.estimatedMinutes}
                    onChange={(e) =>
                      setSubEditForm((f) => ({
                        ...f,
                        estimatedMinutes: e.target.value,
                      }))
                    }
                  />
                </div>
                <div className="gdt-field">
                  <label className="gdt-label" htmlFor="gdt-sf-edit-order">
                    Order index
                  </label>
                  <input
                    id="gdt-sf-edit-order"
                    type="number"
                    min={1}
                    className="gdt-input"
                    value={subEditForm.orderIndex}
                    onChange={(e) =>
                      setSubEditForm((f) => ({
                        ...f,
                        orderIndex: e.target.value,
                      }))
                    }
                  />
                </div>
              </div>

              <div className="gdt-field">
                <label className="gdt-label" htmlFor="gdt-sf-edit-assignee">
                  Assignee
                </label>
                <select
                  id="gdt-sf-edit-assignee"
                  className="gdt-input"
                  value={subEditForm.assigneeId}
                  onChange={(e) =>
                    setSubEditForm((f) => ({
                      ...f,
                      assigneeId: e.target.value,
                    }))
                  }
                >
                  <option value="">—</option>
                  {members.map((m) => (
                    <option key={m.userId} value={m.userId}>
                      {m.fullName}
                    </option>
                  ))}
                </select>
              </div>

              {subEditFormError && (
                <p className="gdt-form-error">
                  <span className="material-symbols-outlined" aria-hidden="true">
                    error
                  </span>
                  {subEditFormError}
                </p>
              )}

              <div className="gdt-form-actions">
                <button
                  type="button"
                  className="gdt-btn gdt-btn--ghost"
                  onClick={() => setSubEditTarget(null)}
                  disabled={busy}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="gdt-btn gdt-btn--primary"
                  disabled={busy}
                >
                  {busy ? "Saving…" : "Save changes"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ================= Modal tạo giai đoạn ================= */}
      {msModalOpen && (
        <div
          className="gdt-modal-backdrop"
          onClick={() => setMsModalOpen(false)}
          role="presentation"
        >
          <div
            className="gdt-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="gdt-ms-title"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="gdt-modal-head">
              <h2 id="gdt-ms-title" className="gdt-modal-title">
                <span
                  className="material-symbols-outlined gdt-modal-title-icon"
                  aria-hidden="true"
                >
                  flag
                </span>
                New milestone
              </h2>
              <button
                type="button"
                className="gdt-modal-close"
                onClick={() => setMsModalOpen(false)}
                aria-label="Close"
              >
                <span className="material-symbols-outlined">close</span>
              </button>
            </div>

            <form className="gdt-form" onSubmit={handleCreateMilestone}>
              <div className="gdt-field">
                <label className="gdt-label" htmlFor="gdt-f-ms-name">
                  Name *
                </label>
                <input
                  id="gdt-f-ms-name"
                  type="text"
                  className="gdt-input"
                  placeholder="e.g. Design phase"
                  value={msForm.name}
                  onChange={(e) =>
                    setMsForm((f) => ({ ...f, name: e.target.value }))
                  }
                  required
                />
              </div>

              <div className="gdt-field-row">
                <div className="gdt-field">
                  <label className="gdt-label" htmlFor="gdt-f-ms-order">
                    Order index
                  </label>
                  <input
                    id="gdt-f-ms-order"
                    type="number"
                    min={1}
                    className="gdt-input"
                    value={msForm.orderIndex}
                    onChange={(e) =>
                      setMsForm((f) => ({ ...f, orderIndex: e.target.value }))
                    }
                  />
                </div>
                <div className="gdt-field">
                  <label className="gdt-label" htmlFor="gdt-f-ms-due">
                    Due date
                  </label>
                  <input
                    id="gdt-f-ms-due"
                    type="date"
                    className="gdt-input"
                    value={msForm.dueDate}
                    onChange={(e) =>
                      setMsForm((f) => ({ ...f, dueDate: e.target.value }))
                    }
                  />
                </div>
              </div>

              <div className="gdt-field">
                <label className="gdt-label" htmlFor="gdt-f-ms-status">
                  Status
                </label>
                <select
                  id="gdt-f-ms-status"
                  className="gdt-input"
                  value={msForm.status}
                  onChange={(e) =>
                    setMsForm((f) => ({
                      ...f,
                      status: e.target.value as GroupMilestoneStatus,
                    }))
                  }
                >
                  {GROUP_MILESTONE_STATUSES.map((s) => (
                    <option key={s} value={s}>
                      {milestoneStatusLabel(s).label}
                    </option>
                  ))}
                </select>
              </div>

              {msFormError && (
                <p className="gdt-form-error">
                  <span className="material-symbols-outlined" aria-hidden="true">
                    error
                  </span>
                  {msFormError}
                </p>
              )}

              <div className="gdt-form-actions">
                <button
                  type="button"
                  className="gdt-btn gdt-btn--ghost"
                  onClick={() => setMsModalOpen(false)}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="gdt-btn gdt-btn--primary"
                  disabled={busy}
                >
                  Create milestone
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ================= Modal sửa giai đoạn ================= */}
      {msEditTarget && (
        <div
          className="gdt-modal-backdrop"
          onClick={() => setMsEditTarget(null)}
          role="presentation"
        >
          <div
            className="gdt-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="gdt-ms-edit-title"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="gdt-modal-head">
              <h2 id="gdt-ms-edit-title" className="gdt-modal-title">
                <span
                  className="material-symbols-outlined gdt-modal-title-icon"
                  aria-hidden="true"
                >
                  edit
                </span>
                Edit milestone
              </h2>
              <button
                type="button"
                className="gdt-modal-close"
                onClick={() => setMsEditTarget(null)}
                aria-label="Close"
              >
                <span className="material-symbols-outlined">close</span>
              </button>
            </div>

            <form className="gdt-form" onSubmit={handleSaveMilestone}>
              <div className="gdt-field">
                <label className="gdt-label" htmlFor="gdt-f-ms-edit-name">
                  Name *
                </label>
                <input
                  id="gdt-f-ms-edit-name"
                  type="text"
                  className="gdt-input"
                  placeholder="e.g. Design phase"
                  value={msEditForm.name}
                  onChange={(e) =>
                    setMsEditForm((f) => ({ ...f, name: e.target.value }))
                  }
                  required
                />
              </div>

              <div className="gdt-field-row">
                <div className="gdt-field">
                  <label className="gdt-label" htmlFor="gdt-f-ms-edit-order">
                    Order index
                  </label>
                  <input
                    id="gdt-f-ms-edit-order"
                    type="number"
                    min={1}
                    className="gdt-input"
                    value={msEditForm.orderIndex}
                    onChange={(e) =>
                      setMsEditForm((f) => ({
                        ...f,
                        orderIndex: e.target.value,
                      }))
                    }
                  />
                </div>
                <div className="gdt-field">
                  <label className="gdt-label" htmlFor="gdt-f-ms-edit-due">
                    Due date
                  </label>
                  <input
                    id="gdt-f-ms-edit-due"
                    type="date"
                    className="gdt-input"
                    value={msEditForm.dueDate}
                    onChange={(e) =>
                      setMsEditForm((f) => ({ ...f, dueDate: e.target.value }))
                    }
                  />
                </div>
              </div>

              <div className="gdt-field">
                <label className="gdt-label" htmlFor="gdt-f-ms-edit-status">
                  Status
                </label>
                <select
                  id="gdt-f-ms-edit-status"
                  className="gdt-input"
                  value={msEditForm.status}
                  onChange={(e) =>
                    setMsEditForm((f) => ({
                      ...f,
                      status: e.target.value as GroupMilestoneStatus,
                    }))
                  }
                >
                  {GROUP_MILESTONE_STATUSES.map((s) => (
                    <option key={s} value={s}>
                      {milestoneStatusLabel(s).label}
                    </option>
                  ))}
                </select>
              </div>

              {msEditFormError && (
                <p className="gdt-form-error">
                  <span className="material-symbols-outlined" aria-hidden="true">
                    error
                  </span>
                  {msEditFormError}
                </p>
              )}

              <div className="gdt-form-actions">
                <button
                  type="button"
                  className="gdt-btn gdt-btn--ghost"
                  onClick={() => setMsEditTarget(null)}
                  disabled={busy}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="gdt-btn gdt-btn--primary"
                  disabled={busy}
                >
                  {busy ? "Saving…" : "Save changes"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ================= Modal thêm việc con ================= */}
      {subModalFor && (
        <div
          className="gdt-modal-backdrop"
          onClick={() => setSubModalFor(null)}
          role="presentation"
        >
          <div
            className="gdt-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="gdt-sub-title"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="gdt-modal-head">
              <h2 id="gdt-sub-title" className="gdt-modal-title">
                <span
                  className="material-symbols-outlined gdt-modal-title-icon"
                  aria-hidden="true"
                >
                  subdirectory_arrow_right
                </span>
                Add subtask
              </h2>
              <button
                type="button"
                className="gdt-modal-close"
                onClick={() => setSubModalFor(null)}
                aria-label="Close"
              >
                <span className="material-symbols-outlined">close</span>
              </button>
            </div>

            <form className="gdt-form" onSubmit={handleCreateSubTask}>
              <div className="gdt-field">
                <label className="gdt-label" htmlFor="gdt-f-sub-title">
                  Title *
                </label>
                <input
                  id="gdt-f-sub-title"
                  type="text"
                  className="gdt-input"
                  placeholder="e.g. Build wireframes"
                  value={subForm.title}
                  onChange={(e) =>
                    setSubForm((f) => ({ ...f, title: e.target.value }))
                  }
                  required
                />
              </div>

              <div className="gdt-field-row">
                <div className="gdt-field">
                  <label className="gdt-label" htmlFor="gdt-f-sub-est">
                    Estimate (min)
                  </label>
                  <input
                    id="gdt-f-sub-est"
                    type="number"
                    min={0}
                    step={5}
                    className="gdt-input"
                    value={subForm.estimatedMinutes}
                    onChange={(e) =>
                      setSubForm((f) => ({
                        ...f,
                        estimatedMinutes: e.target.value,
                      }))
                    }
                  />
                </div>
                <div className="gdt-field">
                  <label className="gdt-label" htmlFor="gdt-f-sub-assignee">
                    Assignee
                  </label>
                  <select
                    id="gdt-f-sub-assignee"
                    className="gdt-input"
                    value={subForm.assigneeId}
                    onChange={(e) =>
                      setSubForm((f) => ({
                        ...f,
                        assigneeId: e.target.value,
                      }))
                    }
                  >
                    <option value="">—</option>
                    {members.map((m) => (
                      <option key={m.userId} value={m.userId}>
                        {m.fullName}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              {subFormError && (
                <p className="gdt-form-error">
                  <span className="material-symbols-outlined" aria-hidden="true">
                    error
                  </span>
                  {subFormError}
                </p>
              )}

              <div className="gdt-form-actions">
                <button
                  type="button"
                  className="gdt-btn gdt-btn--ghost"
                  onClick={() => setSubModalFor(null)}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="gdt-btn gdt-btn--primary"
                  disabled={busy}
                >
                  Add subtask
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ================= Hộp thoại cảnh báo giao việc (409) ================= */}
      {busyWarning && (
        <div
          className="gdt-modal-backdrop"
          onClick={() => setBusyWarning(null)}
          role="presentation"
        >
          <div
            className="gdt-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="gdt-busy-title"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="gdt-modal-head">
              <h2 id="gdt-busy-title" className="gdt-modal-title">
                <span
                  className="material-symbols-outlined gdt-modal-title-icon gdt-modal-title-icon--warn"
                  aria-hidden="true"
                >
                  warning
                </span>
                This person is already busy at that time
              </h2>
              <button
                type="button"
                className="gdt-modal-close"
                onClick={() => setBusyWarning(null)}
                aria-label="Close"
              >
                <span className="material-symbols-outlined">close</span>
              </button>
            </div>

            <div className="gdt-modal-body">
              <p className="gdt-conflict-text">
                The assignee has a conflicting schedule or their workload for
                that week is higher than they can take on. You can still assign
                this task — the other person will see it on their schedule.
              </p>

              {busyWarning.details.conflicts.length > 0 && (
                <div className="gdt-conflict">
                  <h4 className="gdt-sub-title">Conflicting time slots</h4>
                  <ul className="gdt-conflict-list">
                    {busyWarning.details.conflicts.map((c, i) => (
                      <li key={i} className="gdt-conflict-item">
                        <span className="gdt-conflict-time">
                          {fmtGroupDateTime(c.start)} → {fmtGroupDateTime(c.end)}
                        </span>
                        <span className="gdt-conflict-source">
                          {busySourceLabel(c.source)}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {busyWarning.details.workload?.isOverloaded && (
                <div className="gdt-conflict">
                  <h4 className="gdt-sub-title">Overloaded this week</h4>
                  <p className="gdt-conflict-text">
                    Total estimated time for their unfinished tasks:{" "}
                    <strong>
                      {fmtMinutes(busyWarning.details.workload.assignedMinutes)}
                    </strong>{" "}
                    / available capacity{" "}
                    <strong>
                      {fmtMinutes(busyWarning.details.workload.capacityMinutes)}
                    </strong>
                    .
                  </p>
                </div>
              )}
            </div>

            <div className="gdt-form-actions">
              <button
                type="button"
                className="gdt-btn gdt-btn--ghost"
                onClick={() => setBusyWarning(null)}
              >
                Cancel
              </button>
              <button
                type="button"
                className="gdt-btn gdt-btn--primary"
                disabled={busy}
                onClick={() => {
                  const target = tasks.find(
                    (t) => t.id === busyWarning.taskId,
                  );
                  setBusyWarning(null);
                  if (target) {
                    void handleAssign(
                      target,
                      busyWarning.assigneeId,
                      true,
                    );
                  }
                }}
              >
                Assign anyway
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ============ Hộp thoại giai đoạn còn việc dở (409) ============ */}
      {msOpenTasksWarning && (
        <div
          className="gdt-modal-backdrop"
          onClick={() => setMsOpenTasksWarning(null)}
          role="presentation"
        >
          <div
            className="gdt-modal"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="gdt-ms-open-title"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="gdt-modal-head">
              <h2 id="gdt-ms-open-title" className="gdt-modal-title">
                <span
                  className="material-symbols-outlined gdt-modal-title-icon gdt-modal-title-icon--warn"
                  aria-hidden="true"
                >
                  warning
                </span>
                This milestone still has unfinished work
              </h2>
              <button
                type="button"
                className="gdt-modal-close"
                onClick={() => setMsOpenTasksWarning(null)}
                aria-label="Close"
              >
                <span className="material-symbols-outlined">close</span>
              </button>
            </div>

            <div className="gdt-modal-body">
              <p className="gdt-conflict-text">
                <strong>{msOpenTasksWarning.milestone.name}</strong> can only be
                marked as{" "}
                {milestoneStatusLabel(msOpenTasksWarning.status).label} once
                every task in it is done or skipped. There are still{" "}
                <strong>{msOpenTasksWarning.details.openTaskCount}</strong>{" "}
                unfinished task(s) and{" "}
                <strong>{msOpenTasksWarning.details.openSubTaskCount}</strong>{" "}
                unfinished subtask(s).
              </p>

              {msOpenTasksWarning.details.tasks.length > 0 && (
                <div className="gdt-conflict">
                  <h4 className="gdt-sub-title">Tasks that are still open</h4>
                  <ul className="gdt-conflict-list">
                    {msOpenTasksWarning.details.tasks.map((t) => (
                      <li key={t.id} className="gdt-conflict-item">
                        <span className="gdt-conflict-time">{t.title}</span>
                        <span className="gdt-conflict-source">
                          {t.openSubTaskCount > 0
                            ? `${t.openSubTaskCount} unfinished subtask(s)`
                            : taskStatusLabel(t.status).label}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>

            <div className="gdt-form-actions">
              <button
                type="button"
                className="gdt-btn gdt-btn--ghost"
                onClick={() => setMsOpenTasksWarning(null)}
              >
                Cancel
              </button>
              <button
                type="button"
                className="gdt-btn gdt-btn--primary"
                disabled={busy}
                onClick={() => {
                  const { milestone, status, source } = msOpenTasksWarning;
                  setMsOpenTasksWarning(null);
                  if (source === "edit") {
                    void handleSaveMilestoneAnyway();
                  } else {
                    void handleMilestoneStatus(milestone, status, true);
                  }
                }}
              >
                Mark as {milestoneStatusLabel(msOpenTasksWarning.status).label}{" "}
                anyway
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ============ Modal mời thành viên (tab Members) ============ */}
      {inviteOpen && group && (
        <GroupInviteModal
          groupId={group.id}
          groupName={group.name}
          onClose={() => setInviteOpen(false)}
          onInvited={() => {
            toast.success(
              "Invitation sent",
              "The invitee will see this invitation in their inbox.",
            );
            // Nạp lại danh sách thành viên (có thể đã có người mới).
            void loadAll();
          }}
          onError={(err) => showApiError(err, "send this invitation")}
        />
      )}

      {/* ============ Hộp thoại báo lỗi (tiếng Anh) ============ */}
      <GroupErrorDialog
        error={errorDialog?.view ?? null}
        details={errorDialog?.details ?? null}
        rawMessage={errorDialog?.raw || undefined}
        onClose={() => setErrorDialog(null)}
      />

      {/* ============ Modal gợi ý người làm (AI) ============ */}
      {suggestForTask && (
        <GroupAssigneeSuggestionsModal
          taskTitle={suggestForTask.title}
          data={suggestions}
          members={aiMembers}
          loading={suggestLoading}
          onClose={() => {
            setSuggestForTask(null);
            setSuggestions(null);
          }}
          onAssign={(userId) => void handleAssignSuggestion(userId)}
          onRetry={() => void handleRetrySuggestions()}
          domains={domains}
          domainId={suggestDomainId}
          onDomainChange={(id) => void handleSuggestDomainChange(id)}
        />
      )}

      {/* ============ Hộp thoại gợi ý giờ (AI, FR-25) ============ */}
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

      {/* ============ Hộp thoại lỗi AI (tiếng Anh) ============ */}
      <GroupErrorDialog
        error={aiErrorDialog?.view ?? null}
        rawMessage={aiErrorDialog?.raw || undefined}
        onClose={() => {
          setAiErrorDialog(null);
          setAiRetry(null);
        }}
        onSecondary={
          aiErrorDialog?.view.showRetry && aiRetry
            ? () => {
                const retry = aiRetry;
                setAiErrorDialog(null);
                setAiRetry(null);
                retry();
              }
            : undefined
        }
        secondaryLabel="Try again"
      />

      {/* ============ Modal sửa thông tin nhóm ============ */}
      {groupModalOpen && group && (
        <div
          className="gdt-modal-backdrop"
          onClick={() => setGroupModalOpen(false)}
          role="presentation"
        >
          <div
            className="gdt-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="gdt-group-title"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="gdt-modal-head">
              <h2 id="gdt-group-title" className="gdt-modal-title">
                <span
                  className="material-symbols-outlined gdt-modal-title-icon"
                  aria-hidden="true"
                >
                  edit
                </span>
                Edit group
              </h2>
              <button
                type="button"
                className="gdt-modal-close"
                onClick={() => setGroupModalOpen(false)}
                aria-label="Close"
              >
                <span className="material-symbols-outlined">close</span>
              </button>
            </div>

            <form className="gdt-form" onSubmit={handleSaveGroup}>
              <div className="gdt-field">
                <label className="gdt-label" htmlFor="gdt-gf-name">
                  Name *
                </label>
                <input
                  id="gdt-gf-name"
                  type="text"
                  className="gdt-input"
                  placeholder="e.g. Website redesign"
                  value={groupForm.name}
                  onChange={(e) =>
                    setGroupForm((f) => ({ ...f, name: e.target.value }))
                  }
                  required
                />
              </div>

              <div className="gdt-field">
                <label className="gdt-label" htmlFor="gdt-gf-desc">
                  Description
                </label>
                <textarea
                  id="gdt-gf-desc"
                  rows={3}
                  className="gdt-input gdt-input--textarea"
                  placeholder="What is this group working on?"
                  value={groupForm.description}
                  onChange={(e) =>
                    setGroupForm((f) => ({
                      ...f,
                      description: e.target.value,
                    }))
                  }
                />
              </div>

              <div className="gdt-field-row">
                <div className="gdt-field">
                  <label className="gdt-label" htmlFor="gdt-gf-start">
                    Start date
                  </label>
                  <input
                    id="gdt-gf-start"
                    type="date"
                    className="gdt-input"
                    value={groupForm.startDate}
                    onChange={(e) =>
                      setGroupForm((f) => ({ ...f, startDate: e.target.value }))
                    }
                  />
                </div>
                <div className="gdt-field">
                  <label className="gdt-label" htmlFor="gdt-gf-deadline">
                    Deadline
                  </label>
                  <input
                    id="gdt-gf-deadline"
                    type="date"
                    className="gdt-input"
                    value={groupForm.deadline}
                    onChange={(e) =>
                      setGroupForm((f) => ({
                        ...f,
                        deadline: e.target.value,
                      }))
                    }
                  />
                </div>
              </div>

              {groupFormError && (
                <p className="gdt-form-error">
                  <span className="material-symbols-outlined" aria-hidden="true">
                    error
                  </span>
                  {groupFormError}
                </p>
              )}

              <div className="gdt-form-actions">
                <button
                  type="button"
                  className="gdt-btn gdt-btn--ghost"
                  onClick={() => setGroupModalOpen(false)}
                  disabled={busy}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="gdt-btn gdt-btn--primary"
                  disabled={busy}
                >
                  {busy ? "Saving…" : "Save changes"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      <CenterToasts toasts={toasts} onDismiss={toast.dismiss} />
    </div>
  );
}

/**
 * "2026-11-27" — chuẩn hoá ngày về `yyyy-MM-dd` cho `<input type="date">`.
 *
 * BE trả ngày ở nhiều dạng (`2026-11-27`, ISO đầy đủ) → chỉ lấy phần ngày.
 */
function toDateInput(value: string | null | undefined): string {
  if (!value) return "";
  const s = value.slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : "";
}

/**
 * "2026-11-27T14:30" — chuẩn hoá thời gian về `yyyy-MM-ddTHH:mm` cho
 * `<input type="datetime-local">`.
 *
 * ⚠️ `datetime-local` KHÔNG có timezone → ta dùng giờ LOCAL của máy user.
 * Khi gửi lên BE ta quyết định `.toISOString()` (UTC) → nhất quán với
 * luồng tạo việc (`handleCreateTask`).
 */
function toDatetimeLocal(value: string | null | undefined): string {
  if (!value) return "";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}`
  );
}
