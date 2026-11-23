/* ============================================================
 * useProjectChat — hook dùng chung cho màn chat AI
 * ------------------------------------------------------------
 * Gộp toàn bộ state + logic của màn chat AI 3 cột vào 1 hook
 * để dùng lại ở 2 nơi:
 *
 *   1. `/copilot`                    → CopilotPage
 *   2. `/projects/:projectId/chat`   → ProjectChatPage
 *
 * Nội dung hook gồm:
 *   - State cột giữa: messages, draft, applied, lỗi AI, kết quả xếp lịch
 *   - State cột phải: cây milestone › task › subtask
 *   - Handler: gửi tin, lập kế hoạch, apply, apply-and-schedule, xếp lịch lại,
 *     thêm/sửa/xoá node, đánh dấu xong, tạo task cố định
 *
 * Spec: `ui-man-chat-ai.md` (BE gửi FE).
 * Class prefix của giao diện: `.aic-*` (dùng chung với trang /copilot).
 * ============================================================ */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  applyAndScheduleProjectBreakdown,
  applyProjectBreakdown,
  createMilestone,
  createProject,
  createSubtask,
  createTask,
  deleteMilestone,
  deleteSubtask,
  deleteTask,
  getProject,
  getProjectChat,
  listMilestones,
  listProjectConversations,
  listSubtasks,
  listTasks,
  proposeSchedule,
  sendProjectChatMessage,
  sendProjectChatMessageWithFiles,
  startProjectConversation,
  updateMilestone,
  updateSubtask,
  updateTask,
  type AppliedScheduleDto,
  type MilestoneDto,
  type ProjectChatDto,
  type ProjectChatMessageDto,
  type ProjectDraftDto,
  type ProjectDto,
  type SubtaskDto,
  type TaskDto,
} from "../../lib/api-client";
import { useCenterToast } from "../../components/Toast";
import {
  classifyChatError,
  deriveScreenState,
  scheduleErrorHint,
  type ChatErrorKind,
  type ChatScreenState,
} from "./ai-chat-logic";
import type { PendingFile } from "./ChatFrame";

export interface UseProjectChatOptions {
  /**
   * Dự án đang mở (dùng cho trang trong project).
   *
   * - `null` → trang `/copilot`: chưa chọn dự án nào, chờ user bấm ở cột trái.
   * - có id → trang `/projects/:id/chat`: tự mở (hoặc tạo) chat của dự án.
   */
  initialProjectId?: string | null;
}

export interface ProjectChatHandlers {
  onSend: () => void;
  onPlan: () => void;
  onApplyAndSchedule: (messageId: string) => void;
  onApplyOnly: (messageId: string) => void;
  onCreateFixedTask: (reminder: string) => void;
  onRetry: () => void;
  onRetrySchedule: () => void;
  onAddMilestone: () => void;
  onAddTask: (milestoneId: string, title: string) => void;
  onAddSubtask: (taskId: string, title: string) => void;
  onRenameMilestone: (milestoneId: string, name: string) => void;
  onRenameTask: (taskId: string, title: string) => void;
  onRenameSubtask: (subtaskId: string, title: string) => void;
  onDeleteMilestone: (milestoneId: string) => void;
  onDeleteTask: (taskId: string) => void;
  onDeleteSubtask: (subtaskId: string) => void;
  onToggleTaskDone: (task: TaskDto) => void;
}

export function useProjectChat(options: UseProjectChatOptions = {}) {
  const { initialProjectId = null } = options;
  const [toasts, toast] = useCenterToast();

  /* ===========================================================
   * State — cột giữa
   * =========================================================== */
  /** Conversation đang mở. */
  const [conversationId, setConversationId] = useState<string | null>(null);
  /** Dự án đang mở (rút từ conversation). */
  const [projectId, setProjectId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ProjectChatMessageDto[]>([]);
  const [draftText, setDraftText] = useState("");
  const [files, setFiles] = useState<PendingFile[]>([]);
  const [waiting, setWaiting] = useState(false);
  const [applying, setApplying] = useState(false);
  const [aiError, setAiError] = useState<string | null>(null);
  /**
   * Loại lỗi AI theo spec mục 7 — dùng để rẽ nhánh UI:
   *   - `plan_locked`  → ẩn nút "Lên kế hoạch", hiện thẻ nâng cấp gói
   *   - `quota`        → toast hết lượt AI (sửa tay ở cột phải vẫn dùng được)
   *   - `ai_busy`      → bong bóng lỗi + nút "Thử lại" (không bị trừ lượt)
   *   - `stale_draft`  → tải lại chat
   */
  const [aiErrorKind, setAiErrorKind] = useState<ChatErrorKind | null>(null);
  const [scheduleResult, setScheduleResult] = useState<AppliedScheduleDto | null>(
    null,
  );
  const [scheduleError, setScheduleError] = useState<string | null>(null);
  /**
   * ID các việc **mới tạo** trong lần apply gần nhất (spec mục 5).
   *
   * Khi `apply-and-schedule` trả `schedule_error` → việc đã tạo nhưng chưa xếp
   * được lịch. Nút "Xếp lịch" gọi `POST /schedule/propose` với đúng danh sách
   * này — **gửi tất cả trong 1 request** (tránh trùng giờ do gọi AI riêng cho
   * từng task).
   */
  const [newTaskIds, setNewTaskIds] = useState<string[]>([]);
  /** Đang gọi `POST /schedule/propose` (nút "Xếp lịch" sau khi lỗi xếp lịch). */
  const [scheduleBusy, setScheduleBusy] = useState(false);
  /** Bản nháp hiện tại (dùng cho cột phải + trạng thái màn hình). */
  const [latestDraft, setLatestDraft] = useState<ProjectDraftDto | null>(null);
  /** Chat đã apply hay chưa. */
  const [applied, setApplied] = useState(false);

  /* ===========================================================
   * State — cột phải
   * =========================================================== */
  const [project, setProject] = useState<ProjectDto | null>(null);
  const [milestones, setMilestones] = useState<MilestoneDto[]>([]);
  const [tasks, setTasks] = useState<TaskDto[]>([]);
  const [subtasksByTaskId, setSubtasksByTaskId] = useState<
    Map<string, SubtaskDto[]>
  >(new Map());
  const [treeLoading, setTreeLoading] = useState(false);
  const [treeError, setTreeError] = useState<string | null>(null);

  /* ===========================================================
   * State — modal tạo dự án (chỉ dùng ở trang /copilot)
   * =========================================================== */
  const [newProjectOpen, setNewProjectOpen] = useState(false);
  const [newProjectName, setNewProjectName] = useState("");
  const [newProjectDeadline, setNewProjectDeadline] = useState("");
  const [newProjectError, setNewProjectError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  /**
   * Bộ đếm để cột trái tải lại danh sách chat.
   *
   * Tăng sau mỗi lần apply / tạo dự án → lịch sử chat hiện mới nhất.
   */
  const [refreshKey, setRefreshKey] = useState(0);

  /* ===========================================================
   * Trạng thái màn hình
   * =========================================================== */
  const screenState: ChatScreenState = deriveScreenState({
    hasDraft: !!latestDraft && latestDraft.applied !== true,
    applied,
    busy: waiting,
    applying,
  });

  /* ===========================================================
   * Helpers
   * =========================================================== */

  /** Load lịch sử + draft của 1 conversation. */
  const openConversationById = useCallback(
    async (cid: string) => {
      setWaiting(true);
      setAiError(null);
      const res = await getProjectChat(cid);
      setWaiting(false);
      if (!res.ok) {
        toast.error(res.error ?? "Không tải được cuộc chat.");
        return;
      }
      const data: ProjectChatDto = res.data;
      setConversationId(data.conversation_id);
      setProjectId(data.project_id);
      setMessages(data.messages ?? []);
      setLatestDraft(data.latest_draft);
      setApplied(data.applied === true);
      setScheduleResult(null);
      setScheduleError(null);
    },
    [toast],
  );

  /**
   * Mở chat của 1 dự án.
   *
   * Mỗi dự án đúng 1 cuộc chat → dự án chưa có chat thì gọi
   * `POST /chat/projects/{project_id}/conversations` để tạo.
   */
  const openProject = useCallback(
    async (pid: string) => {
      setWaiting(true);
      setAiError(null);
      const listRes = await listProjectConversations(pid);
      if (!listRes.ok) {
        setWaiting(false);
        toast.error(listRes.error ?? "Không tải được danh sách chat.");
        return;
      }
      const first = listRes.data?.[0];
      if (first) {
        setWaiting(false);
        await openConversationById(first.conversation_id);
        return;
      }
      // Chưa có chat → tạo mới.
      const createRes = await startProjectConversation(pid);
      setWaiting(false);
      if (!createRes.ok) {
        toast.error(createRes.error ?? "Không mở được cuộc chat.");
        return;
      }
      await openConversationById(createRes.data.conversation_id);
    },
    [openConversationById, toast],
  );

  /** Load cây cột mốc › việc › việc con của dự án. */
  const loadTree = useCallback(async (pid: string) => {
    setTreeLoading(true);
    setTreeError(null);

    const [projRes, msRes, taskRes] = await Promise.all([
      getProject(pid),
      listMilestones(pid),
      listTasks(pid),
    ]);

    if (projRes.ok) setProject(projRes.data);
    if (msRes.ok) setMilestones(msRes.data ?? []);
    else setTreeError(msRes.error ?? "Không tải được cột mốc.");
    if (taskRes.ok) setTasks(taskRes.data ?? []);
    else setTreeError(taskRes.error ?? "Không tải được danh sách việc.");

    // Việc con: gọi song song theo từng task.
    const allTasks = taskRes.ok ? (taskRes.data ?? []) : [];
    const subLists = await Promise.all(
      allTasks.map((t) => listSubtasks(t.id).catch(() => null)),
    );
    const map = new Map<string, SubtaskDto[]>();
    allTasks.forEach((t, i) => {
      const r = subLists[i];
      map.set(t.id, r && r.ok ? (r.data ?? []) : []);
    });

    setSubtasksByTaskId(map);
    setTreeLoading(false);
  }, []);

  /* Load cây khi đổi dự án. */
  useEffect(() => {
    if (!projectId) return;
    let cancelled = false;
    // setState chỉ chạy SAU await → không vi phạm
    // react-hooks/set-state-in-effect.
    void (async () => {
      await loadTree(projectId);
      if (cancelled) return;
    })();
    return () => {
      cancelled = true;
    };
  }, [projectId, loadTree]);

  /**
   * Mở chat của dự án khi vào trang `/projects/:id/chat`.
   *
   * Chạy 1 lần cho mỗi projectId (dùng ref để không mở lại khi user đổi
   * conversation trong cùng dự án).
   */
  const openedProjectRef = useRef<string | null>(null);
  useEffect(() => {
    if (!initialProjectId) return;
    if (openedProjectRef.current === initialProjectId) return;
    openedProjectRef.current = initialProjectId;
    void (async () => {
      await openProject(initialProjectId);
    })();
  }, [initialProjectId, openProject]);

  /* ===========================================================
   * Gửi tin
   * =========================================================== */

  /**
   * Xử lý lỗi theo spec mục 7.
   *
   * - `plan_locked` → set cờ khoá gói (ẩn nút "Lên kế hoạch")
   * - `quota`       → toast "hết lượt AI"
   * - `stale_draft` → tải lại cuộc chat + toast ngắn
   * - `ai_busy`     → bong bóng lỗi + nút "Thử lại"
   */
  function handleChatError(res: {
    error?: string;
    status?: number;
    errorCode?: string;
  }) {
    const info = classifyChatError(res.status, res.errorCode);
    setAiErrorKind(info.kind);

    switch (info.kind) {
      case "plan_locked":
        setAiError(null);
        break;
      case "quota":
        setAiError(null);
        toast.error(info.message);
        break;
      case "stale_draft":
        setAiError(null);
        toast.info(info.message);
        if (conversationId) void openConversationById(conversationId);
        break;
      case "ai_busy":
      default:
        setAiError(res.error ?? info.message);
        break;
    }
  }

  /** Gửi tin nhắn (mode `discuss`). */
  async function handleSend() {
    if (!conversationId) return;
    const text = draftText.trim();
    if (!text && files.length === 0) return;

    setDraftText("");
    const sentFiles = files;
    setFiles([]);
    setWaiting(true);
    setAiError(null);

    const res =
      sentFiles.length > 0
        ? await sendProjectChatMessageWithFiles(
            conversationId,
            text,
            sentFiles.map((f) => f.file),
          )
        : await sendProjectChatMessage(conversationId, text, "discuss");

    setWaiting(false);

    if (!res.ok) {
      handleChatError(res);
      setDraftText(text);
      return;
    }

    setMessages((prev) => [
      ...prev,
      res.data.user_message,
      res.data.ai_message,
    ]);
    if (res.data.ai_message.draft) {
      setLatestDraft(res.data.ai_message.draft);
    }
  }

  /** Bấm nút xanh — lập kế hoạch từ cả cuộc trò chuyện. */
  async function handlePlan() {
    if (!conversationId) return;
    setWaiting(true);
    setAiError(null);

    const res = await sendProjectChatMessage(conversationId, "", "plan");
    setWaiting(false);

    if (!res.ok) {
      handleChatError(res);
      return;
    }
    setMessages((prev) => [
      ...prev,
      res.data.user_message,
      res.data.ai_message,
    ]);
    if (res.data.ai_message.draft) {
      setLatestDraft(res.data.ai_message.draft);
    }
  }

  /** Thử lại sau lỗi AI. */
  function handleRetry() {
    setAiError(null);
    setAiErrorKind(null);
    if (draftText.trim()) void handleSend();
    else void handlePlan();
  }

  /**
   * Nút "Tạo task cố định" ở phần `reminders` của thẻ kế hoạch (spec mục 3.3).
   *
   * Reminder là 1 chuỗi (VD: "Họp kickoff dự án — 10:00"). Ta tạo 1 task cố định
   * (fixedStart/fixedEnd) trong project hiện tại, ghim vào khung giờ đầu tiên của
   * ngày làm việc kế tiếp.
   */
  async function handleCreateFixedTask(reminder: string) {
    if (!projectId) return;
    const title = reminder.trim() || "Cuộc họp cố định";
    // Gom giờ nếu reminder có dạng "... 10:00" hoặc "... 10:00-11:00".
    const hhmm = reminder.match(/(\d{1,2}):(\d{2})/);
    const startHour = hhmm ? Number(hhmm[1]) : 9;
    const startMinute = hhmm ? Number(hhmm[2]) : 0;
    const durationMin = 60;

    const base = new Date();
    base.setHours(startHour, startMinute, 0, 0);
    if (base.getTime() <= Date.now()) base.setDate(base.getDate() + 1);
    const end = new Date(base.getTime() + durationMin * 60_000);

    const res = await createTask(projectId, {
      title,
      taskType: "Meeting",
      fixedStart: base.toISOString(),
      fixedEnd: end.toISOString(),
      estimatedMinutes: durationMin,
    });
    if (!res.ok) {
      toast.error(res.error ?? "Không tạo được task cố định.");
      return;
    }
    setTasks((prev) => [...prev, res.data]);
    toast.success("Đã tạo task cố định.");
  }

  /* ===========================================================
   * Áp dụng
   * =========================================================== */
  async function handleApplyAndSchedule(messageId: string) {
    if (!conversationId) return;
    setApplying(true);
    setScheduleError(null);

    const res = await applyAndScheduleProjectBreakdown(
      conversationId,
      messageId,
    );
    setApplying(false);

    if (!res.ok) {
      if (res.status === 409) {
        toast.error("Bản nháp này đã áp dụng hoặc không còn mới nhất.");
        await openConversationById(conversationId);
        return;
      }
      toast.error(res.error ?? "Không áp dụng được bản nháp.");
      return;
    }

    setApplied(true);
    setLatestDraft((d) => (d ? { ...d, applied: true } : d));

    // Gom ID các việc vừa tạo → dùng cho nút "Xếp lịch" khi xếp lịch lỗi.
    const createdIds = (res.data.applied?.milestones ?? []).flatMap((m) =>
      (m.tasks ?? []).map((t) => t.id),
    );
    setNewTaskIds(createdIds);

    if (res.data.schedule) {
      setScheduleResult(res.data.schedule);
      setScheduleError(null);
      toast.success("Đã tạo và xếp lịch thành công.");
    } else if (res.data.schedule_error) {
      setScheduleError(res.data.schedule_error);
      setScheduleResult(null);
      // ⚠️ Việc ĐÃ tạo thành công — chỉ phần xếp lịch chưa được (spec mục 5).
      toast.info(
        scheduleErrorHint(res.data.schedule_error).title,
        scheduleErrorHint(res.data.schedule_error).hint,
      );
    }

    // Việc đã tạo → tải lại cây bên phải.
    if (projectId) void loadTree(projectId);
    await openConversationById(conversationId);
    setRefreshKey((k) => k + 1);
  }

  /**
   * Nút "Xếp lịch" sau khi `apply-and-schedule` trả `schedule_error` (spec mục 5).
   *
   * Gọi `POST /schedule/propose` với **toàn bộ** việc mới trong **1 request**
   * → AI xếp cùng lúc nên không trùng giờ.
   */
  async function handleRetrySchedule() {
    if (newTaskIds.length === 0) return;
    setScheduleBusy(true);
    const res = await proposeSchedule({
      task_ids: newTaskIds,
      language: "vi",
    });
    setScheduleBusy(false);

    if (!res.ok) {
      toast.error(res.error ?? "Không xếp được lịch.");
      return;
    }
    setScheduleError(null);
    setScheduleResult({
      proposal_id: res.data.proposal_id ?? null,
      is_feasible: res.data.is_feasible ?? true,
      missing_minutes: res.data.missing_minutes ?? 0,
      explanation: res.data.explanation ?? null,
      slots: res.data.slots ?? [],
      warnings: res.data.warnings ?? [],
    });
    toast.success("Đã xếp lịch thành công.");
  }

  async function handleApplyOnly(messageId: string) {
    if (!conversationId) return;
    setApplying(true);
    setScheduleError(null);

    const res = await applyProjectBreakdown(conversationId, messageId);
    setApplying(false);

    if (!res.ok) {
      if (res.status === 409) {
        toast.error("Bản nháp này đã áp dụng hoặc không còn mới nhất.");
        await openConversationById(conversationId);
        return;
      }
      toast.error(res.error ?? "Không áp dụng được bản nháp.");
      return;
    }

    setApplied(true);
    setLatestDraft((d) => (d ? { ...d, applied: true } : d));

    // Gom ID việc mới (để nút "Xếp lịch" dùng được sau nếu cần).
    setNewTaskIds(
      (res.data.milestones ?? []).flatMap((m) =>
        (m.tasks ?? []).map((t) => t.id),
      ),
    );

    // Milestone được giao vào cột mốc cũ → toast.
    for (const ms of res.data.milestones ?? []) {
      if (ms.reused) {
        toast.success(`Đã thêm vào cột mốc ${ms.title}.`);
      }
    }

    if (projectId) void loadTree(projectId);
    await openConversationById(conversationId);
    setRefreshKey((k) => k + 1);
    toast.success("Đã áp dụng thành công.");
  }

  /* ===========================================================
   * Cột phải — thêm / sửa / xoá
   * =========================================================== */
  async function handleAddMilestone() {
    if (!projectId) return;
    const orderIndex =
      milestones.reduce((m, x) => Math.max(m, x.orderIndex ?? 0), 0) + 1;
    const res = await createMilestone(projectId, {
      name: "Cột mốc mới",
      orderIndex,
    });
    if (!res.ok) {
      toast.error(res.error ?? "Không tạo được cột mốc.");
      return;
    }
    setMilestones((prev) => [...prev, res.data]);
    toast.success("Đã thêm cột mốc.");
  }

  async function handleAddTask(milestoneId: string, title: string) {
    if (!projectId) return;
    const res = await createTask(projectId, {
      title: title.trim() || "Việc mới",
      milestoneId,
    });
    if (!res.ok) {
      toast.error(res.error ?? "Không tạo được việc.");
      return;
    }
    setTasks((prev) => [...prev, res.data]);
  }

  async function handleAddSubtask(taskId: string, title: string) {
    const res = await createSubtask(taskId, {
      title: title.trim() || "Việc con mới",
    });
    if (!res.ok) {
      toast.error(res.error ?? "Không tạo được việc con.");
      return;
    }
    setSubtasksByTaskId((prev) => {
      const next = new Map(prev);
      next.set(taskId, [...(next.get(taskId) ?? []), res.data]);
      return next;
    });
  }

  async function handleRenameMilestone(milestoneId: string, name: string) {
    const ms = milestones.find((m) => m.id === milestoneId);
    if (!ms) return;
    // ⚠️ PUT /api/milestones/{id} thay thế toàn bộ entity → gửi đủ mọi trường.
    const res = await updateMilestone(milestoneId, {
      name,
      orderIndex: ms.orderIndex,
      dueDate: ms.dueDate,
      startDate: ms.startDate,
      endDate: ms.endDate,
      status: ms.status,
      revisionCount: ms.revisionCount,
    });
    if (!res.ok) {
      toast.error(res.error ?? "Không sửa được cột mốc.");
      return;
    }
    setMilestones((prev) =>
      prev.map((m) => (m.id === milestoneId ? res.data : m)),
    );
  }

  async function handleRenameTask(taskId: string, title: string) {
    const task = tasks.find((t) => t.id === taskId);
    if (!task) return;
    // ⚠️ PUT /api/tasks/{id} thay thế toàn bộ entity → phải gửi đủ mọi trường,
    // nếu không sẽ mất `aiEstimatedMinutes` (ước lượng của AI) và làm hệ thống
    // học thói quen sai (spec ui-man-chat-ai.md mục 4.3).
    const res = await updateTask(taskId, {
      title,
      description: task.description,
      taskType: task.taskType,
      domainId: task.domainId,
      milestoneId: task.milestoneId,
      deadline: task.deadline,
      estimatedMinutes: task.estimatedMinutes,
      aiEstimatedMinutes: task.aiEstimatedMinutes,
      fixedStart: task.fixedStart,
      fixedEnd: task.fixedEnd,
      status: task.status,
    });
    if (!res.ok) {
      toast.error(res.error ?? "Không sửa được việc.");
      return;
    }
    setTasks((prev) => prev.map((t) => (t.id === taskId ? res.data : t)));
  }

  async function handleRenameSubtask(subtaskId: string, title: string) {
    const current = Array.from(subtasksByTaskId.values())
      .flat()
      .find((s) => s.id === subtaskId);
    if (!current) return;
    // ⚠️ PUT /api/subtasks/{id} cũng thay thế toàn bộ → gửi đủ trường.
    const res = await updateSubtask(subtaskId, {
      title,
      description: current.description ?? undefined,
      estimatedMinutes: current.estimatedMinutes,
      orderIndex: current.orderIndex,
      status: current.status,
    });
    if (!res.ok) {
      toast.error(res.error ?? "Không sửa được việc con.");
      return;
    }
    setSubtasksByTaskId((prev) => {
      const next = new Map(prev);
      for (const [k, list] of next) {
        next.set(
          k,
          list.map((s) => (s.id === subtaskId ? res.data : s)),
        );
      }
      return next;
    });
  }

  async function handleDeleteMilestone(milestoneId: string) {
    const res = await deleteMilestone(milestoneId);
    if (!res.ok) {
      toast.error(res.error ?? "Không xoá được cột mốc.");
      return;
    }
    setMilestones((prev) => prev.filter((m) => m.id !== milestoneId));
  }

  async function handleDeleteTask(taskId: string) {
    const res = await deleteTask(taskId);
    if (!res.ok) {
      toast.error(res.error ?? "Không xoá được việc.");
      return;
    }
    setTasks((prev) => prev.filter((t) => t.id !== taskId));
  }

  async function handleDeleteSubtask(subtaskId: string) {
    const res = await deleteSubtask(subtaskId);
    if (!res.ok) {
      toast.error(res.error ?? "Không xoá được việc con.");
      return;
    }
    setSubtasksByTaskId((prev) => {
      const next = new Map(prev);
      for (const [k, list] of next) {
        next.set(k, list.filter((s) => s.id !== subtaskId));
      }
      return next;
    });
  }

  async function handleToggleTaskDone(task: TaskDto) {
    const nextStatus = task.status === "Done" ? "ToDo" : "Done";
    // ⚠️ PUT thay thế toàn bộ entity → gửi đủ trường, chỉ đổi `status`.
    const res = await updateTask(task.id, {
      title: task.title,
      description: task.description,
      taskType: task.taskType,
      domainId: task.domainId,
      milestoneId: task.milestoneId,
      deadline: task.deadline,
      estimatedMinutes: task.estimatedMinutes,
      aiEstimatedMinutes: task.aiEstimatedMinutes,
      fixedStart: task.fixedStart,
      fixedEnd: task.fixedEnd,
      status: nextStatus,
    });
    if (!res.ok) {
      toast.error(res.error ?? "Không cập nhật được việc.");
      return;
    }
    setTasks((prev) => prev.map((t) => (t.id === task.id ? res.data : t)));
  }

  /* ===========================================================
   * Tạo dự án mới (chỉ dùng ở trang /copilot)
   * =========================================================== */
  async function handleCreateProject(e: React.FormEvent) {
    e.preventDefault();
    if (creating) return;
    const name = newProjectName.trim();
    if (!name) {
      setNewProjectError("Vui lòng điền tên dự án.");
      return;
    }
    setCreating(true);
    setNewProjectError(null);

    const res = await createProject({
      name,
      description: "",
      startDate: new Date().toISOString(),
      deadline: newProjectDeadline
        ? new Date(newProjectDeadline).toISOString()
        : new Date(Date.now() + 30 * 24 * 3600_000).toISOString(),
      clientId: null,
    });
    setCreating(false);

    if (!res.ok) {
      setNewProjectError(res.error ?? "Không tạo được dự án.");
      return;
    }

    setNewProjectOpen(false);
    setNewProjectName("");
    setNewProjectDeadline("");
    // Mở chat của dự án vừa tạo.
    await openProject(res.data.id);
  }

  /* ===========================================================
   * Tên các cột mốc trong bản nháp chưa áp dụng
   * =========================================================== */
  const draftMilestoneTitles = useMemo(() => {
    if (!latestDraft || latestDraft.applied === true) return [];
    return (latestDraft.milestones ?? []).map((m) => m.title);
  }, [latestDraft]);

  const handlers: ProjectChatHandlers = {
    onSend: () => void handleSend(),
    onPlan: () => void handlePlan(),
    onApplyAndSchedule: (id) => void handleApplyAndSchedule(id),
    onApplyOnly: (id) => void handleApplyOnly(id),
    onCreateFixedTask: (reminder) => void handleCreateFixedTask(reminder),
    onRetry: handleRetry,
    onRetrySchedule: () => void handleRetrySchedule(),
    onAddMilestone: () => void handleAddMilestone(),
    onAddTask: (msId, title) => void handleAddTask(msId, title),
    onAddSubtask: (taskId, title) => void handleAddSubtask(taskId, title),
    onRenameMilestone: (id, name) => void handleRenameMilestone(id, name),
    onRenameTask: (id, title) => void handleRenameTask(id, title),
    onRenameSubtask: (id, title) => void handleRenameSubtask(id, title),
    onDeleteMilestone: (id) => void handleDeleteMilestone(id),
    onDeleteTask: (id) => void handleDeleteTask(id),
    onDeleteSubtask: (id) => void handleDeleteSubtask(id),
    onToggleTaskDone: (t) => void handleToggleTaskDone(t),
  };

  return {
    /* --- cột giữa --- */
    conversationId,
    projectId,
    messages,
    draftText,
    setDraftText,
    files,
    setFiles,
    waiting,
    applying,
    aiError,
    aiErrorKind,
    screenState,
    scheduleResult,
    scheduleError,
    scheduleBusy,
    newTaskIds,
    latestDraft,
    applied,
    hasDraft: !!latestDraft && latestDraft.applied !== true,

    /* --- cột phải --- */
    project,
    milestones,
    tasks,
    subtasksByTaskId,
    treeLoading,
    treeError,
    draftMilestoneTitles,

    /* --- modal tạo dự án --- */
    newProjectOpen,
    setNewProjectOpen,
    newProjectName,
    setNewProjectName,
    newProjectDeadline,
    setNewProjectDeadline,
    newProjectError,
    creating,
    handleCreateProject,
    refreshKey,

    /* --- toast --- */
    toasts,
    toast,

    /* --- handlers --- */
    handlers,
    openProject,
    openConversationById,
  };
}
