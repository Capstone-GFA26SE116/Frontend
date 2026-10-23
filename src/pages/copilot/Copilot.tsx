import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import "./copilot.css";
import {
  ProposalBody,
  ProposalActions,
} from "../../components/ScheduleProposal";
import {
  useScheduleProposal,
  collectSchedulableTasks,
} from "../../components/schedule-proposal-logic";
import { CenterToasts, useCenterToast } from "../../components/Toast";
import { useAuth } from "../../auth/AuthContext";
import {
  applyTaskChat as apiApplyTaskChat,
  getSimilarMemory,
  getTaskChat,
  listProjects,
  listScheduleSlotsByTask,
  listTasks,
  sendTaskMessage,
  type AiMessage,
  type AppliedResponse,
  type ChatTurnResponse,
  type ProjectDto,
  type ScheduleSlotDto,
  type SimilarItem,
  type SummaryResponse,
  type TaskChatResponse,
  type TaskDto,
} from "../../lib/api-client";

/* ============================================================
 * AI Schedule Coordinator (Copilot Chat & Scheduling)
 * Route: /copilot
 *
 * Tích hợp trực tiếp với AI service (METANOIA Neural Engine) qua
 * Bearer accessToken của METANOIA backend. 4 endpoint đang dùng:
 *   GET  /memory/similar?task_id=...&limit=...
 *   GET  /chat/tasks/{task_id}
 *   POST /chat/tasks/{task_id}/messages
 *   POST /chat/tasks/{task_id}/apply
 *
 * Layout (60/40 split):
 *   - LEFT  (7 cols)  : Conversational stream + AI response cards +
 *                       quick-pill composer + Task ID picker
 *   - RIGHT (5 cols)  : Live timeline simulation + metric shift +
 *                       dual-memory RAG context (loaded from /memory/similar)
 *
 * Theme: đồng bộ với các page khác (#0f131c surface, #c0c1ff primary,
 *        #4edea3 secondary, #d0bcff tertiary). Scope class prefix `.cp-*`.
 * ============================================================ */

interface ChatMessage {
  id: string;
  role: "user" | "ai";
  text: string;
  time: string; // HH:MM (derived from created_at hoặc now())
  kind: "text" | "draft";
  /** AI message: nếu kind === "draft" thì đây là draft được server trả về */
  draft?: {
    messageId: string;
    subtasks: { title: string; minutes: number; order: number; reason?: string | null }[];
    yourEstimateMinutes: number;
    adjustedMinutes: number;
    subtaskTotalMinutes: number;
    adjustedIsHint: boolean;
    warning: string | null;
  };
}

/**
 * Host AI service để hiển thị trong panel "Schedule Context".
 * Lấy từ env để luôn khớp với request thật (host đã đổi nhiều lần trong
 * quá trình dev — hardcode sẽ khiến UI hiển thị sai).
 */
const aiHostLabel = (() => {
  const raw = (import.meta.env.VITE_AI_API_URL as string | undefined) ?? "";
  if (!raw) return "(chưa cấu hình VITE_AI_API_URL)";
  try {
    return new URL(raw).host;
  } catch {
    return raw;
  }
})();

/**
 * Avatar mặc định khi user không có ảnh (Google avatar URL hết hạn rất nhanh).
 * Dùng SVG inline — không phụ thuộc mạng, không bao giờ 403.
 */
const DEFAULT_AVATAR =
  "data:image/svg+xml;charset=UTF-8," +
  encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40" width="40" height="40">
      <circle cx="20" cy="20" r="20" fill="#7c3aed"/>
      <circle cx="20" cy="16" r="7" fill="#ddd6fe"/>
      <path d="M6 38a14 14 0 0 1 28 0z" fill="#ddd6fe"/>
    </svg>`,
  );

/**
 * Quick prompts.
 *
 * Cần nói rõ "this task" vì AI đọc task từ DB theo task_id — nếu prompt chỉ
 * nói "break this" mà không nhắc tới task, AI có thể hiểu là cần hỏi lại
 * thêm thông tin (đặc biệt khi task thiếu description).
 */
/**
 * Dựng phần ngữ cảnh task để gắn vào message gửi AI.
 *
 * AI service đọc task từ DB theo `task_id`, nhưng khi task **thiếu
 * `description`** thì AI chỉ thấy một title mơ hồ (vd: "Build admin panel")
 * và sẽ hỏi lại "what specific features do you need?" thay vì tách subtask.
 *
 * Gửi kèm title + description giúp AI tách được ngay cả với task mơ hồ.
 * Trả về chuỗi rỗng nếu không có task (trường hợp paste UUID lạ).
 */
function buildTaskContext(task: TaskDto | undefined): string {
  if (!task) return "";
  const parts: string[] = [`[Task] ${task.title}`];
  const desc = task.description?.trim();
  if (desc) parts.push(`[Description] ${desc}`);
  else parts.push("[Description] (not provided — infer the subtasks from the title above.)");
  return parts.join("\n");
}

const QUICK_PROMPTS = [
  {
    icon: "⚡",
    text: "Break this task into 3-5 subtasks, each ≤ 60 minutes. Use the task title and description as the scope.",
  },
  {
    icon: "🧠",
    text: "Estimate realistic minutes for each subtask of this task, based on similar past tasks.",
  },
  {
    icon: "☕",
    text: "Break this task into subtasks and add a 10-minute rest buffer after each subtask.",
  },
  {
    icon: "🔄",
    text: "Break this task into subtasks, ordered by dependencies (DB → API → UI).",
  },
];

/* ---------- helpers ---------- */
function fmtHHmm(iso: string | undefined | null): string {
  if (!iso) return nowHHmm();
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return nowHHmm();
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}
function nowHHmm() {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}
function uid() {
  return Math.random().toString(36).slice(2, 10);
}
function truncate(s: string, n: number) {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

/** Map 1 AiMessage (server) -> ChatMessage (UI). */
function aiMessageToUi(m: AiMessage): ChatMessage {
  return {
    id: m.id,
    role: m.role === "user" ? "user" : "ai",
    text: m.content ?? "",
    time: fmtHHmm(m.created_at),
    kind: m.kind === "draft" ? "draft" : "text",
    draft: m.draft
      ? {
          messageId: m.draft.message_id,
          subtasks: m.draft.subtasks.map((s) => ({
            title: s.title,
            minutes: s.estimated_minutes,
            order: s.order_index,
            reason: s.reason ?? null,
          })),
          yourEstimateMinutes: m.draft.your_estimate_minutes,
          adjustedMinutes: m.draft.adjusted_minutes,
          subtaskTotalMinutes: m.draft.subtask_total_minutes,
          adjustedIsHint: m.draft.adjusted_is_hint,
          warning: m.draft.warning,
        }
      : undefined,
  };
}

/* ============================================================
 * Main page
 * ============================================================ */
export function CopilotPage() {
  const { user } = useAuth();
  /** Avatar hiển thị cạnh bubble — ưu tiên ảnh thật, không có thì dùng SVG. */
  const avatarSrc = user?.avatarUrl || DEFAULT_AVATAR;
  const [taskId, setTaskId] = useState<string>("");
  const [taskIdDraft, setTaskIdDraft] = useState<string>("");
  const [taskIdError, setTaskIdError] = useState<string | null>(null);

  /* Picker state: dropdown Project → Task, hoặc paste UUID */
  const [projects, setProjects] = useState<ProjectDto[]>([]);
  const [projectsLoading, setProjectsLoading] = useState(false);
  const [projectId, setProjectId] = useState<string>("");
  const [tasks, setTasks] = useState<TaskDto[]>([]);
  const [tasksLoading, setTasksLoading] = useState(false);
  const [pickerTaskId, setPickerTaskId] = useState<string>("");
  const [pickerError, setPickerError] = useState<string | null>(null);
  const [showPasteUuid, setShowPasteUuid] = useState(false);

  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [isTyping, setIsTyping] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);

  const [appliedIds, setAppliedIds] = useState<Set<string>>(new Set());
  const [applyError, setApplyError] = useState<string | null>(null);

  /* Toast thông báo giữa màn hình */
  const [toasts, toast] = useCenterToast();

  /* ============ AI schedule proposal ============
   * Cùng bộ logic với trang /schedule: Copilot là nơi AI chủ động gợi ý,
   * còn /schedule là nơi người dùng chủ động bấm. */
  const [scheduleSlots, setScheduleSlots] = useState<ScheduleSlotDto[]>([]);
  /** Task vừa được phân rã xong — ứng viên xếp lịch nổi bật. */
  const [scheduleHintTaskId, setScheduleHintTaskId] = useState<string | null>(null);

  const scheduledTaskIds = useMemo(
    () => new Set(scheduleSlots.map((s) => s.taskId).filter(Boolean)),
    [scheduleSlots],
  );

  /** Ưu tiên task vừa chat, sau đó mới tới task khác trong cùng project. */
  const schedulableTasks = useMemo(() => {
    const base = tasks.length > 0 ? tasks : [];
    const pool = collectSchedulableTasks(base, scheduledTaskIds);
    if (!scheduleHintTaskId) return pool;
    const hit = pool.find((t) => t.id === scheduleHintTaskId);
    if (!hit) return pool;
    return [hit, ...pool.filter((t) => t.id !== scheduleHintTaskId)];
  }, [tasks, scheduledTaskIds, scheduleHintTaskId]);

  /**
   * Task sẽ gửi lên AI khi bấm "Đề xuất lịch".
   *
   * Ưu tiên task đang chọn ở dropdown (đây mới là task user đang muốn xếp
   * lịch). Trước đây nút này gửi **mọi** task flexible chưa có lịch, nên bấm
   * "Đề xuất lịch" cho task mới vẫn ra kết quả của task cũ đã quá hạn.
   *
   * Task đang chọn không hợp lệ (Fixed / đã có lịch / done) → bỏ qua, dùng
   * danh sách đầy đủ để user vẫn xếp được hàng loạt.
   */
  const preferredScheduleTaskIds = useMemo(() => {
    const picked = tasks.find((t) => t.id === taskId);
    if (picked && schedulableTasks.some((t) => t.id === picked.id)) {
      return [picked.id];
    }
    return schedulableTasks.map((t) => t.id);
  }, [tasks, taskId, schedulableTasks]);

  const tasksByIdMap = useMemo(() => {
    const m = new Map<string, TaskDto>();
    for (const t of tasks) m.set(t.id, t);
    return m;
  }, [tasks]);

  const proposal = useScheduleProposal({
    scheduledTaskIds,
    tasksById: tasksByIdMap,
    toast,
  });

  const proposalOpen = proposal.proposal !== null || proposal.loading;

  /* RAG panel (right) */
  const [ragItems, setRagItems] = useState<SimilarItem[]>([]);
  const [ragSummary, setRagSummary] = useState<SummaryResponse | null>(null);
  const [ragSearchMode, setRagSearchMode] = useState<string | null>(null);
  const [ragLoading, setRagLoading] = useState(false);
  const [ragError, setRagError] = useState<string | null>(null);

  const streamRef = useRef<HTMLDivElement | null>(null);
  /** Chốt 1 request đang bay để chặn gửi trùng (xem handleSend). */
  const sendingRef = useRef(false);
  /** Chốt 1 lần apply đang chạy để chặn tạo trùng subtask (xem handleApply). */
  const applyingRef = useRef(false);

  /* auto-scroll */
  useEffect(() => {
    if (streamRef.current) {
      streamRef.current.scrollTop = streamRef.current.scrollHeight;
    }
  }, [messages, isTyping]);

  /* Load project list khi mount */
  useEffect(() => {
    let cancelled = false;
    setProjectsLoading(true);
    void listProjects().then((res) => {
      if (cancelled) return;
      if (res.ok) setProjects(res.data ?? []);
      setProjectsLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  /* Load task list khi project đổi */
  useEffect(() => {
    if (!projectId) {
      setTasks([]);
      setPickerTaskId("");
      return;
    }
    let cancelled = false;
    setTasksLoading(true);
    setPickerError(null);
    setPickerTaskId("");
    void listTasks(projectId).then((res) => {
      if (cancelled) return;
      if (res.ok) {
        setTasks(res.data ?? []);
      } else {
        setPickerError(res.error);
        setTasks([]);
      }
      setTasksLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  /** Load chat + RAG song song cho 1 task. */
  const loadTask = useCallback(async (id: string) => {
    const clean = id.trim();
    if (!clean) return;
    // Nhả chốt gửi: nếu không, đổi task lúc đang chờ AI sẽ kẹt vĩnh viễn
    // (ref không tự reset theo taskId).
    sendingRef.current = false;
    setIsTyping(false);
    setTaskIdError(null);
    setSendError(null);
    setApplyError(null);
    setMessages([]);
    setAppliedIds(new Set());
    setRagItems([]);
    setRagSummary(null);
    setRagSearchMode(null);
    setRagError(null);

    // 1) chat history
    const chatRes = await getTaskChat(clean);
    if (chatRes.ok) {
      const data: TaskChatResponse = chatRes.data;
      setTaskId(data.task_id);
      setTaskIdDraft(data.task_id);
      setMessages(data.messages.map(aiMessageToUi));
    } else {
      setTaskIdError(chatRes.error);
      return;
    }

    // 2) RAG
    setRagLoading(true);
    const simRes = await getSimilarMemory(clean, 5);
    if (simRes.ok) {
      setRagItems(simRes.data.items ?? []);
      setRagSummary(simRes.data.summary ?? null);
      setRagSearchMode(simRes.data.search_mode ?? null);
    } else {
      setRagError(simRes.error);
    }
    setRagLoading(false);
  }, []);

  function handleLoadTask() {
    // Ưu tiên picker task nếu đã chọn; nếu không thì dùng UUID paste.
    const fromPicker = pickerTaskId.trim();
    const fromInput = taskIdDraft.trim();
    const id = fromPicker || fromInput;
    if (id) void loadTask(id);
  }

  function handleSend(text?: string) {
    const raw = (text ?? draft).trim();
    if (!raw || !taskId) return;
    // Chặn gửi trùng: nếu không có guard này, bấm Enter liên tục hoặc bấm nút
    // 2 lần trước khi request đầu về sẽ bắn ra 2 request song song → BE trả
    // 409 Conflict và 1 trong 2 message bị mất.
    // Dùng ref chứ không phải `isTyping` vì state đóng lại theo render, 2 lần
    // bấm trong cùng 1 tick vẫn thấy `isTyping === false`.
    if (sendingRef.current) return;
    sendingRef.current = true;
    setSendError(null);

    // Gắn ngữ cảnh task vào message.
    //
    // Vì sao: AI đọc task từ DB theo task_id, nhưng nếu task thiếu `description`
    // thì AI chỉ thấy một title mơ hồ ("Build admin panel") và sẽ hỏi lại
    // "what specific features do you need?" thay vì tách subtask. Gửi kèm
    // title + description giúp AI tách được ngay cả với task mơ hồ.
    const currentTask = tasks.find((t) => t.id === taskId);
    const context = buildTaskContext(currentTask);
    const content = context ? `${context}\n\n${raw}` : raw;

    // optimistic user bubble — hiển thị đúng những gì user gõ, không lộ context
    // đã thêm vào request.
    setMessages((prev) => [
      ...prev,
      { id: uid(), role: "user", text: raw, time: nowHHmm(), kind: "text" },
    ]);
    setDraft("");
    setIsTyping(true);
    void (async () => {
      const res = await sendTaskMessage(taskId, content);
      sendingRef.current = false;
      setIsTyping(false);
      if (!res.ok) {
        setSendError(res.error);
        // Trả lại nội dung đã gõ vào ô nhập để user không mất ý định.
        setDraft(raw);
        return;
      }
      const turn: ChatTurnResponse = res.data;
      setMessages((prev) => [
        ...prev,
        aiMessageToUi(turn.user_message),
        aiMessageToUi(turn.ai_message),
      ]);
    })();
  }

  async function handleApply(messageId: string) {
    if (!taskId) return;
    // Chặn double-apply: bấm 2 lần nhanh sẽ tạo trùng subtask ở BE
    // (endpoint apply không tốn AI quota nên BE không chặn trùng).
    if (applyingRef.current) return;
    if (appliedIds.has(messageId)) return;
    applyingRef.current = true;
    setApplyError(null);
    try {
      const res = await apiApplyTaskChat(taskId, messageId, null);
      if (!res.ok) {
        setApplyError(res.error);
        return;
      }
      setAppliedIds((prev) => new Set(prev).add(messageId));
      const applied: AppliedResponse = res.data;
      // inject a confirmation message in the stream
      const list = applied.subtasks
        .slice()
        .sort((a, b) => a.order_index - b.order_index)
        .map((s, i) => `${i + 1}. ${s.title} (${s.estimated_minutes}m)`)
        .join("\n");
      setMessages((prev) => [
        ...prev,
        {
          id: uid(),
          role: "ai",
          text: `Synced ${applied.subtasks.length} subtask(s) to your task:\n${list}`,
          time: nowHHmm(),
          kind: "text",
        },
      ]);

      // Task vừa phân rã xong là ứng viên tốt nhất để xếp lịch → đánh dấu lại.
      setScheduleHintTaskId(taskId);
      // Nạp slot hiện có của task để loại trừ đúng khi tính đề xuất.
      const slotRes = await listScheduleSlotsByTask(taskId);
      if (slotRes.ok) {
        setScheduleSlots((prev) => [
          ...prev.filter((s) => s.taskId !== taskId),
          ...slotRes.data,
        ]);
      }
    } finally {
      applyingRef.current = false;
    }
  }

  /** Nạp lại toàn bộ slot của các task đang xem — gọi sau khi duyệt proposal. */
  const refreshSlots = useCallback(async () => {
    if (tasks.length === 0) return;
    const results = await Promise.all(tasks.map((t) => listScheduleSlotsByTask(t.id)));
    const merged: ScheduleSlotDto[] = [];
    for (const r of results) if (r.ok) merged.push(...r.data);
    setScheduleSlots(merged);
  }, [tasks]);

  return (
    <section className="cp">
      <div className="cp-ambient cp-ambient--left" aria-hidden="true" />
      <div className="cp-ambient cp-ambient--right" aria-hidden="true" />

      {/* ============ Context sub-header ============ */}
      <div className="cp-subbar">
        <div className="cp-subbar-inner">
          <div className="cp-subbar-left">
            <div className="cp-breadcrumb">
              <span className="cp-breadcrumb-link">Workspace</span>
              <span className="material-symbols-outlined cp-breadcrumb-sep">chevron_right</span>
              <span className="cp-breadcrumb-current">AI Schedule Coordinator (Neural Copilot)</span>
            </div>
            <div className="cp-subbar-divider" aria-hidden="true" />
            <div className="cp-engine-pill">
              <span className="cp-engine-dot" />
              <span>METANOIA Neural Engine v2.4</span>
            </div>
          </div>

          <div className="cp-subbar-right">
            <button type="button" className="cp-toolbar-btn">
              <span className="material-symbols-outlined cp-toolbar-icon cp-toolbar-icon--primary">sync</span>
              <span>Sync G-Calendar</span>
            </button>
            <button type="button" className="cp-toolbar-btn cp-toolbar-btn--muted">
              <span className="material-symbols-outlined cp-toolbar-icon">history</span>
              <span className="cp-toolbar-label-long">Reload context</span>
            </button>
            <button
              type="button"
              className="cp-toolbar-btn cp-toolbar-btn--kpi"
              title="Configure K_bias"
            >
              <span className="material-symbols-outlined cp-toolbar-icon">tune</span>
              <span className="cp-toolbar-kpi">K=1.25x</span>
            </button>
          </div>
        </div>
      </div>

      {/* ============ Main split layout ============ */}
      <div className="cp-container">
        <div className="cp-grid">
          {/* ====== LEFT: Copilot Stream ====== */}
          <div className="cp-stream">
            {/* Stream header */}
            <div className="cp-stream-head">
              <div className="cp-stream-title">
                <div className="cp-stream-avatar">
                  <span className="material-symbols-outlined">smart_toy</span>
                </div>
                <div className="cp-stream-title-text">
                  <h1 className="cp-stream-h1">Metanoia Copilot</h1>
                  <p className="cp-stream-sub">AI Schedule Coordinator · live API connected</p>
                </div>
              </div>
              <div className="cp-stream-tags">
                {taskId ? (
                  <span className="cp-tag cp-tag--primary" title="Active task">
                    <span className="material-symbols-outlined cp-tag-icon">task_alt</span>
                    Task {taskId.slice(0, 8)}…
                  </span>
                ) : (
                  <span className="cp-tag cp-tag--primary">
                    <span className="cp-tag-dot" /> No task
                  </span>
                )}
                <span className="cp-tag cp-tag--secondary">
                  <span className="material-symbols-outlined cp-tag-icon">bolt</span> {messages.length} msgs
                </span>
              </div>
            </div>

            {/* Task picker bar */}
            <div className="cp-task-bar">
              <div className="cp-picker">
                <span className="material-symbols-outlined cp-picker-icon">workspaces</span>
                <select
                  className="cp-picker-select"
                  value={projectId}
                  onChange={(e) => setProjectId(e.target.value)}
                  disabled={projectsLoading}
                  aria-label="Project"
                >
                  <option value="">
                    {projectsLoading ? "Loading projects…" : "— Select project —"}
                  </option>
                  {projects.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </div>

              <div className="cp-picker">
                <span className="material-symbols-outlined cp-picker-icon">task_alt</span>
                <select
                  className="cp-picker-select"
                  value={pickerTaskId}
                  onChange={(e) => setPickerTaskId(e.target.value)}
                  disabled={!projectId || tasksLoading}
                  aria-label="Task"
                >
                  <option value="">
                    {!projectId
                      ? "Pick a project first"
                      : tasksLoading
                        ? "Loading tasks…"
                        : tasks.length === 0
                          ? "No tasks in this project"
                          : "— Select task —"}
                  </option>
                  {tasks.map((t) => (
                    <option key={t.id} value={t.id}>
                      {truncate(t.title, 60)}
                      {t.status ? ` · ${t.status}` : ""}
                    </option>
                  ))}
                </select>
              </div>

              <button
                type="button"
                className="cp-task-bar-load"
                onClick={handleLoadTask}
                disabled={!pickerTaskId.trim() && !taskIdDraft.trim()}
                title="Load chat + RAG for the selected task"
              >
                <span className="material-symbols-outlined">login</span>
                <span>Load</span>
              </button>

              <button
                type="button"
                className="cp-task-bar-toggle"
                onClick={() => setShowPasteUuid((v) => !v)}
                title={showPasteUuid ? "Hide UUID input" : "Paste a UUID instead"}
              >
                <span className="material-symbols-outlined">
                  {showPasteUuid ? "close" : "content_paste"}
                </span>
              </button>
            </div>

            {showPasteUuid && (
              <div className="cp-task-bar cp-task-bar--paste">
                <span className="material-symbols-outlined cp-task-bar-icon">tag</span>
                <input
                  type="text"
                  className="cp-task-bar-input"
                  placeholder="Paste task UUID…"
                  value={taskIdDraft}
                  onChange={(e) => setTaskIdDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      handleLoadTask();
                    }
                  }}
                  spellCheck={false}
                />
              </div>
            )}

            {pickerError && (
              <div className="cp-banner cp-banner--error" role="alert">
                <span className="material-symbols-outlined">error</span>
                <span>Failed to load tasks: {pickerError}</span>
              </div>
            )}

            {taskIdError && (
              <div className="cp-banner cp-banner--error" role="alert">
                <span className="material-symbols-outlined">error</span>
                <span>{taskIdError}</span>
              </div>
            )}

            {/* Chat transcript */}
            <div className="cp-transcript" ref={streamRef}>
              {messages.length === 0 && taskId && !isTyping && (
                <div className="cp-empty">
                  <span className="material-symbols-outlined">forum</span>
                  <p>No messages yet for this task. Ask the Copilot to break it down.</p>
                </div>
              )}
              {messages.length === 0 && !taskId && (
                <div className="cp-empty">
                  <span className="material-symbols-outlined">arrow_upward</span>
                  <p>Paste a task UUID above to start chatting with the Copilot.</p>
                </div>
              )}

              {messages.map((m) => (
                <Message
                  key={m.id}
                  msg={m}
                  applied={appliedIds.has(m.id)}
                  onApply={handleApply}
                  avatarSrc={avatarSrc}
                />
              ))}

              {isTyping && (
                <div className="cp-msg cp-msg--ai">
                  <div className="cp-ai-avatar">
                    <span className="material-symbols-outlined">neurology</span>
                  </div>
                  <div className="cp-msg-body">
                    <div className="cp-msg-meta">
                      <span className="cp-msg-meta-name">METANOIA Engine v2.4</span>
                      <span className="cp-msg-meta-time">· Analyzing</span>
                    </div>
                    <div className="cp-typing">
                      <span className="cp-typing-dot" />
                      <span className="cp-typing-dot" />
                      <span className="cp-typing-dot" />
                    </div>
                  </div>
                </div>
              )}
            </div>

            {sendError && (
              <div className="cp-banner cp-banner--error" role="alert">
                <span className="material-symbols-outlined">error</span>
                <span>Send failed: {sendError}</span>
              </div>
            )}
            {applyError && (
              <div className="cp-banner cp-banner--error" role="alert">
                <span className="material-symbols-outlined">error</span>
                <span>Apply failed: {applyError}</span>
              </div>
            )}

            {/* ============ AI schedule proposal ============
                Sau khi phân rã xong, AI đề nghị xếp lịch luôn cho các task
                flexible chưa có giờ. Cùng component với trang /schedule. */}
            <div className="cp-propose">
              <div className="cp-propose-head">
                <div className="cp-propose-title">
                  <span className="material-symbols-outlined cp-propose-icon">auto_awesome</span>
                  <div>
                    <strong>Xếp lịch bằng AI</strong>
                    <span>
                      {(() => {
                        const picked = tasks.find((t) => t.id === taskId);
                        const onlyPicked =
                          preferredScheduleTaskIds.length === 1 &&
                          picked?.id === preferredScheduleTaskIds[0];
                        const n = preferredScheduleTaskIds.length;
                        if (n === 0) return "Mọi task flexible đều đã có lịch.";
                        const scope = onlyPicked
                          ? `task "${truncate(picked?.title ?? "", 40)}"`
                          : `${n} task flexible chưa có lịch`;
                        const hint = onlyPicked
                          ? ""
                          : picked
                            ? " — chọn 1 task ở dropdown để xếp riêng"
                            : "";
                        return `Sẽ xếp ${scope}${hint}.`;
                      })()}
                    </span>
                  </div>
                </div>
                {!proposalOpen && (
                  <button
                    type="button"
                    className="cp-btn cp-btn--primary"
                    onClick={() => void proposal.run(preferredScheduleTaskIds)}
                    disabled={preferredScheduleTaskIds.length === 0 || proposal.loading}
                  >
                    <span className="material-symbols-outlined cp-btn-icon">auto_awesome</span>
                    Đề xuất lịch
                  </button>
                )}
              </div>

              {proposalOpen && (
                <div className="sp-root">
                  <ProposalBody hook={proposal} tasksById={tasksByIdMap} />
                  <ProposalActions hook={proposal} onDone={() => void refreshSlots()} />
                </div>
              )}
            </div>

            {/* Composer */}
            <div className="cp-composer">
              <div className="cp-pills">
                {QUICK_PROMPTS.map((p) => (
                  <button
                    key={p.text}
                    type="button"
                    className="cp-pill"
                    onClick={() => handleSend(p.text)}
                    disabled={!taskId || isTyping}
                  >
                    <span className="cp-pill-emoji">{p.icon}</span>
                    <span>{p.text}</span>
                  </button>
                ))}
              </div>

              <div className="cp-input-row">
                <button type="button" className="cp-input-icon" title="Attach context">
                  <span className="material-symbols-outlined">attach_file</span>
                </button>
                <input
                  type="text"
                  className="cp-input"
                  placeholder={
                    taskId
                      ? "Ask the Copilot to break down, re-estimate, or adjust this task…"
                      : "Load a task UUID above to start chatting…"
                  }
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      handleSend();
                    }
                  }}
                  disabled={!taskId || isTyping}
                />
                <div className="cp-input-actions">
                  <button type="button" className="cp-input-icon" title="Voice command" disabled={!taskId || isTyping}>
                    <span className="material-symbols-outlined">mic</span>
                  </button>
                  <button
                    type="button"
                    className="cp-send"
                    onClick={() => handleSend()}
                    disabled={!draft.trim() || !taskId || isTyping}
                    aria-label="Send message"
                  >
                    <span className="material-symbols-outlined">
                      {isTyping ? "hourglass_top" : "arrow_upward"}
                    </span>
                  </button>
                </div>
              </div>

              <div className="cp-composer-foot">
                <span>Enter to dispatch · Shift + Enter for new line</span>
                <span className="cp-composer-foot-sync">Bearer token: Active</span>
              </div>
            </div>
          </div>

          {/* ====== RIGHT: RAG + Live timeline + metrics ====== */}
          <aside className="cp-side">
            {/* RAG (from /memory/similar) */}
            <div className="cp-card">
              <div className="cp-card-head">
                <div className="cp-card-head-left">
                  <span className="material-symbols-outlined cp-card-icon cp-card-icon--primary">memory</span>
                  <h2 className="cp-card-title cp-card-title--sm">RAG · Similar Past Tasks</h2>
                </div>
                {ragSearchMode && (
                  <span className="cp-card-meta" title="Search mode">{ragSearchMode}</span>
                )}
              </div>

              {ragLoading && (
                <div className="cp-state-row">
                  <span className="material-symbols-outlined cp-state-icon">progress_activity</span>
                  <span>Querying /memory/similar…</span>
                </div>
              )}
              {ragError && (
                <div className="cp-state-row cp-state-row--error">
                  <span className="material-symbols-outlined">error</span>
                  <span>{ragError}</span>
                </div>
              )}
              {!ragLoading && !ragError && ragItems.length === 0 && taskId && (
                <p className="cp-card-sub">No similar past tasks found for this task.</p>
              )}
              {!ragLoading && !ragError && ragItems.length === 0 && !taskId && (
                <p className="cp-card-sub">Load a task UUID to retrieve dual-memory context.</p>
              )}

              {ragSummary && ragSummary.count > 0 && (
                <div className="cp-rag-summary">
                  <div className="cp-rag-summary-cell">
                    <span className="cp-rag-summary-label">Total</span>
                    <span className="cp-rag-summary-value">{ragSummary.count}</span>
                  </div>
                  <div className="cp-rag-summary-cell">
                    <span className="cp-rag-summary-label">Done</span>
                    <span className="cp-rag-summary-value cp-rag-summary-value--primary">{ragSummary.done_count}</span>
                  </div>
                  <div className="cp-rag-summary-cell">
                    <span className="cp-rag-summary-label">Avg K_bias</span>
                    <span className="cp-rag-summary-value cp-rag-summary-value--secondary">
                      {ragSummary.average_ratio !== null && ragSummary.average_ratio !== undefined
                        ? `×${ragSummary.average_ratio.toFixed(2)}`
                        : "—"}
                    </span>
                  </div>
                </div>
              )}

              {ragItems.length > 0 && (
                <div className="cp-rag">
                  {ragItems.map((it) => (
                    <div key={it.task_id} className="cp-rag-item">
                      <span
                        className={
                          "material-symbols-outlined cp-rag-icon " +
                          (it.outcome === "done"
                            ? "cp-rag-icon--secondary"
                            : "cp-rag-icon--primary")
                        }
                      >
                        {it.outcome === "done" ? "check_circle" : "remove_circle"}
                      </span>
                      <div className="cp-rag-body">
                        <div className="cp-rag-title">{it.title}</div>
                        <p className="cp-rag-meta">
                          {it.domain || "no domain"} · est {it.estimated_minutes}m · actual{" "}
                          {it.actual_minutes}m
                          {it.ratio !== null && it.ratio !== undefined
                            ? ` · ratio ×${it.ratio.toFixed(2)}`
                            : ""}
                          {" "}· sim {(it.similarity * 100).toFixed(0)}%
                        </p>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Live timeline (kept as a static preview while the chat is loading) */}
            <div className="cp-card">
              <div className="cp-card-head">
                <div className="cp-card-head-left">
                  <span className="material-symbols-outlined cp-card-icon cp-card-icon--secondary">schedule</span>
                  <h2 className="cp-card-title">Schedule Context</h2>
                </div>
                <span className="cp-live-pill">
                  <span className="cp-live-dot" /> Connected
                </span>
              </div>
              <p className="cp-card-sub">
                Subtask drafts from the Copilot can be applied to your task in one click.
                {taskId
                  ? ` Currently scoped to task ${taskId.slice(0, 8)}…`
                  : " Load a task to begin."}
              </p>

              <div className="cp-timeline">
                <TimelineRow time="status" tone="primary" highlight>
                  <strong>AI service</strong>
                  {/* Đọc từ env thay vì hardcode — host đã đổi nhiều lần và
                      hardcode khiến UI hiển thị sai host so với request thật. */}
                  <em>{aiHostLabel}</em>
                </TimelineRow>
                <TimelineRow time="auth" tone="secondary">
                  <strong>Bearer</strong>
                  <em>METANOIA accessToken (auto-attached)</em>
                </TimelineRow>
                <TimelineRow time="endp">
                  <strong>Endpoints</strong>
                  <em>{"/memory/similar · /chat/tasks/{task_id}…"}</em>
                </TimelineRow>
              </div>
            </div>

            {/* Apply hint */}
            <div className="cp-card">
              <div className="cp-card-head">
                <h2 className="cp-card-title cp-card-title--plain">How it works</h2>
              </div>
              <ol className="cp-howto">
                <li>
                  <span className="cp-howto-num">1</span>
                  <span>Paste a <strong>task UUID</strong> and press <em>Load</em>.</span>
                </li>
                <li>
                  <span className="cp-howto-num">2</span>
                  <span>The right panel queries <code>/memory/similar</code> for past similar tasks.</span>
                </li>
                <li>
                  <span className="cp-howto-num">3</span>
                  <span>Ask the Copilot to break the task down — each AI <em>draft</em> shows the proposed subtasks.</span>
                </li>
                <li>
                  <span className="cp-howto-num">4</span>
                  <span>Click <em>Accept &amp; sync</em> to call <code>/chat/tasks/…/apply</code> and write the subtasks.</span>
                </li>
              </ol>
            </div>
          </aside>
        </div>
      </div>

      <CenterToasts toasts={toasts} onDismiss={toast.dismiss} />
    </section>
  );
}

/* ============================================================
 * Sub-components
 * ============================================================ */

function Message({
  msg,
  applied,
  onApply,
  avatarSrc,
}: {
  msg: ChatMessage;
  applied: boolean;
  onApply: (messageId: string) => void;
  avatarSrc: string;
}) {
  if (msg.role === "user") {
    return (
      <div className="cp-msg cp-msg--user">
        <div className="cp-msg-col">
          <div className="cp-msg-meta cp-msg-meta--right">
            <span className="cp-msg-meta-time">{msg.time} · You</span>
          </div>
          <div className="cp-bubble cp-bubble--user">{msg.text}</div>
        </div>
        <img className="cp-msg-avatar" src={avatarSrc} alt="You" />
      </div>
    );
  }

  // AI message
  return (
    <div className="cp-msg cp-msg--ai">
      <div className="cp-ai-avatar">
        <span className="material-symbols-outlined">neurology</span>
      </div>
      <div className="cp-msg-body">
        <div className="cp-msg-meta">
          <span className="cp-msg-meta-name">METANOIA Engine v2.4</span>
          <span className="cp-msg-meta-time">· {msg.time}</span>
        </div>

        {msg.text && msg.kind !== "draft" && (
          <div className="cp-bubble cp-bubble--ai">{msg.text}</div>
        )}

        {msg.kind === "draft" && msg.draft && (
          <DraftCard
            summary={msg.text}
            draft={msg.draft}
            applied={applied}
            onApply={() => onApply(msg.draft!.messageId)}
          />
        )}
      </div>
    </div>
  );
}

function DraftCard({
  summary,
  draft,
  applied,
  onApply,
}: {
  summary: string;
  draft: NonNullable<ChatMessage["draft"]>;
  applied: boolean;
  onApply: () => void;
}) {
  const ratio =
    draft.yourEstimateMinutes > 0
      ? draft.adjustedMinutes / draft.yourEstimateMinutes
      : null;

  return (
    <div className="cp-proposal">
      {summary && <div className="cp-bubble cp-bubble--ai">{summary}</div>}

      {/* Estimates summary */}
      <div className="cp-triage">
        <div className="cp-triage-head">
          <div className="cp-triage-title">
            <span className="material-symbols-outlined cp-triage-icon">psychology</span>
            <span>AI Estimate</span>
          </div>
          <span className="cp-triage-badge">
            K_bias{" "}
            {ratio !== null ? `×${ratio.toFixed(2)}` : "—"}
          </span>
        </div>
        <ul className="cp-triage-list">
          <li>
            <span className="material-symbols-outlined cp-triage-bullet cp-triage-bullet--primary">schedule</span>
            <span>
              <strong>Your estimate:</strong> {draft.yourEstimateMinutes}m ·{" "}
              <strong>Adjusted:</strong> {draft.adjustedMinutes}m
              {draft.adjustedIsHint && (
                <em className="cp-hint"> (hint only)</em>
              )}
            </span>
          </li>
          <li>
            <span className="material-symbols-outlined cp-triage-bullet cp-triage-bullet--secondary">checklist</span>
            <span>
              <strong>Subtask total:</strong> {draft.subtaskTotalMinutes}m across{" "}
              {draft.subtasks.length} subtask{draft.subtasks.length === 1 ? "" : "s"}.
            </span>
          </li>
          {draft.warning && (
            <li>
              <span className="material-symbols-outlined cp-triage-bullet cp-triage-bullet--primary">warning</span>
              <span>{draft.warning}</span>
            </li>
          )}
        </ul>
      </div>

      {/* Subtask list */}
      <div className="cp-proposal-card">
        <div className="cp-proposal-head">
          <div className="cp-proposal-head-left">
            <span className="material-symbols-outlined cp-proposal-icon">checklist</span>
            <span className="cp-proposal-title">Draft subtasks</span>
          </div>
          <span className="cp-proposal-feas">{draft.subtasks.length} items</span>
        </div>

        <div className="cp-blocks">
          {draft.subtasks.map((s) => (
            <div className="cp-block cp-block--deep" key={`${s.order}-${s.title}`}>
              <div className="cp-block-bar" />
              <div className="cp-block-info">
                <div className="cp-block-head">
                  <span className="cp-block-time">#{s.order}</span>
                  <span className="cp-block-pill cp-block-pill--deep">{s.minutes}m</span>
                </div>
                <div className="cp-block-title">{s.title}</div>
                {s.reason && <p className="cp-block-reason">{s.reason}</p>}
              </div>
              <span className="material-symbols-outlined cp-block-icon cp-block-icon--deep">task_alt</span>
            </div>
          ))}
        </div>

        <div className="cp-proposal-actions">
          <button
            type="button"
            className={"cp-btn cp-btn--primary" + (applied ? " cp-btn--applied" : "")}
            onClick={onApply}
            disabled={applied}
          >
            <span className="material-symbols-outlined">
              {applied ? "check_circle" : "auto_awesome"}
            </span>
            <span>{applied ? "Synced!" : "Accept & apply subtasks"}</span>
          </button>
        </div>
      </div>
    </div>
  );
}

function TimelineRow({
  time,
  highlight,
  tone,
  children,
}: {
  time: string;
  highlight?: boolean;
  tone?: "primary" | "secondary" | "outline";
  children: React.ReactNode;
}) {
  return (
    <div
      className={
        "cp-tl-row" +
        (highlight ? " cp-tl-row--highlight" : "") +
        (tone ? ` cp-tl-row--${tone}` : "")
      }
    >
      <div className="cp-tl-time">{time}</div>
      <div className="cp-tl-card">
        <div className="cp-tl-card-text">{children}</div>
        <span className="material-symbols-outlined cp-tl-icon">check_circle</span>
      </div>
    </div>
  );
}
