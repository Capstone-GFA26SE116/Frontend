import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type FormEvent,
} from "react";
import { Link, useParams } from "react-router-dom";
import { CenterToasts, useCenterToast } from "../../components/Toast";
import { useAuth } from "../../auth/AuthContext";
import type { ApiErr } from "../../lib/api-client";
import { listDomains } from "../../lib/api-client";
import { GroupErrorDialog } from "./GroupErrorDialog";
import { GroupInviteModal } from "./GroupInviteModal";
import { GroupAiChatTab } from "./GroupAiChatTab";
import {
  GroupAssigneeSuggestionsModal,
  type GroupAiMember,
} from "./GroupAssigneeSuggestionsModal";
import {
  getGroupAssigneeSuggestions,
  type GroupAssigneeSuggestionsDto,
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
  updateGroupMilestone,
  updateGroupSubTaskStatus,
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
  fmtGroupDate,
  fmtGroupDateTime,
  fmtMinutes,
  fmtRelativeTime,
  isLeader,
  milestoneStatusLabel,
  normalizeRole,
  priorityLabel,
  priorityTone,
  roleLabel,
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

/** Tab của trang. */
type TabKey = "tasks" | "milestones" | "members" | "activity" | "ai";

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

  /** Hộp thoại lỗi riêng cho AI (tiếng Anh). */
  const [aiErrorDialog, setAiErrorDialog] = useState<{
    view: GroupAiErrorView;
    raw: string;
  } | null>(null);

  /**
   * Thao tác thử lại cho lỗi AI tạm thời (502/503/429).
   *
   * Được `GroupAiChatTab` đăng ký khi một request AI thất bại → hộp thoại
   * lỗi hiện nút "Try again" thay vì bắt user tự làm lại từ đầu.
   */
  const [aiRetry, setAiRetry] = useState<(() => void) | null>(null);

  /** Hiện lỗi AI trong hộp thoại dùng chung (tiêu đề + message đã dịch). */
  const showAiError = useCallback(
    (view: GroupAiErrorView, raw?: string) => {
      setAiErrorDialog({ view, raw: raw ?? "" });
    },
    [],
  );

  /**
   * Nhận thao tác thử lại từ `GroupAiChatTab`.
   *
   * Chỉ giữ khi lỗi **tạm thời** (`showRetry`) — lỗi cấu hình/gói thì
   * không có gì để thử lại.
   */
  const registerAiRetry = useCallback((retry: () => void) => {
    setAiRetry(() => retry);
  }, []);

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
        language: "en",
      });
      setSuggestLoading(false);

      if (!res.ok) {
        showAiError(toGroupAiErrorView(res), res.error);
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
      language: "en",
    });
    setSuggestLoading(false);
    if (!res.ok) {
      showAiError(toGroupAiErrorView(res), res.error);
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
        language: "en",
      });
      setSuggestLoading(false);
      if (!res.ok) {
        showAiError(toGroupAiErrorView(res), res.error);
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
        showAiError(toGroupAiErrorView(res), res.error);
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
          setMsOpenTasksWarning({ milestone: ms, status, details });
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
          </section>
        )}

        {/* ================= Tabs ================= */}
        <nav className="gdt-tabs" role="tablist">
          {(
            [
              { key: "tasks", label: "Tasks", icon: "checklist", count: tasks.length },
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
               * Tab "Chat AI" — CHỈ Leader mới thấy (spec GROUP_AI_FE.md mục 0).
               * Member/Viewer: ẩn hẳn, gọi API vẫn bị 403.
               */
              ...(leader
                ? [
                    {
                      key: "ai" as const,
                      label: "Chat AI",
                      icon: "auto_awesome",
                      count: 0,
                    },
                  ]
                : []),
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
                                title="Ask AI who should take this on"
                              >
                                <span
                                  className="material-symbols-outlined"
                                  aria-hidden="true"
                                >
                                  auto_awesome
                                </span>
                                Suggest assignee
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

                      {/* ----- Chi tiết: việc con + bình luận ----- */}
                      {expanded && (
                        <div className="gdt-task-detail">
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

        {/* ================= TAB: CHAT AI (Leader) ================= */}
        {tab === "ai" && leader && (
          <section className="gdt-panel">
            <div className="gdt-section-head">
              <div className="gdt-section-head-text">
                <span className="gdt-section-eyebrow">AI planning</span>
                <h2 className="gdt-section-title">Chat AI</h2>
              </div>
            </div>
            <GroupAiChatTab
              groupId={groupId}
              members={members}
              enabled={leader}
              archived={archived}
              onError={showAiError}
              onRetryRequest={registerAiRetry}
              onGroupChanged={() => void loadAll()}
            />
          </section>
        )}
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
                  const { milestone, status } = msOpenTasksWarning;
                  setMsOpenTasksWarning(null);
                  void handleMilestoneStatus(milestone, status, true);
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

      <CenterToasts toasts={toasts} onDismiss={toast.dismiss} />
    </div>
  );
}
