import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { CenterToasts, useCenterToast } from "../../components/Toast";
import {
  applyAndScheduleProjectBreakdown,
  applyProjectBreakdown,
  getProject,
  getProjectChat,
  listDomains,
  listMilestones,
  listProjectConversations,
  listTasks,
  sendProjectChatMessage,
  sendProjectChatMessageWithFiles,
  startProjectConversation,
  type AppliedProjectBreakdownDto,
  type AppliedScheduleDto,
  type DomainDto,
  type EditedProjectMilestone,
  type EditedProjectTask,
  type MilestoneDto,
  type ProjectChatMessageDto,
  type ProjectConversationDto,
  type ProjectDraftDto,
  type ProjectDraftMilestoneDto,
  type ProjectDto,
  type ScheduleErrorCode,
  type TaskDto,
} from "../../lib/api-client";
import "./project-ai-chat.css";

/* ===========================================================
 * Project AI Chat — FR-08b-1
 * Route: /projects/:projectId/execution
 *
 * AI chat ở mức **project** (không phải task): user dán brief của khách
 * vào chat, AI hỏi lại nếu thiếu thông tin (deadline, scope…), rồi đưa
 * bản nháp **milestone + task Flexible**. User sửa tay được rồi bấm
 * Apply → BE ghi Milestone + Task thật vào DB.
 *
 * 5 endpoint (thuộc AI service → dùng `aiFetch` trong api-client):
 *   POST /chat/projects/{project_id}/conversations
 *   GET  /chat/projects/{project_id}/conversations
 *   GET  /chat/conversations/{id}
 *   POST /chat/conversations/{id}/messages   ← chỉ endpoint này tốn lượt AI
 *   POST /chat/conversations/{id}/apply
 *
 * Quy tắc nghiệp vụ (từ FR-08b-1):
 *   - Mỗi cuộc chat Apply **đúng 1 lần** → BE trả 409 `already_applied`.
 *   - Apply phải trỏ tới **bản nháp mới nhất** → 409 `not_latest_draft`.
 *   - Apply chỉ **tạo mới**, không sửa/xoá milestone/task đã có.
 *   - AI không tạo task `Fixed` — những việc đó nằm ở `reminders`.
 *
 * Scope class prefix `.pac-*`.
 * =========================================================== */

/* ---------- helpers ---------- */

function fmtHHmm(iso: string | undefined | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function fmtDate(iso: string | undefined | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("vi-VN", { day: "2-digit", month: "2-digit", year: "numeric" });
}

function fmtMinutes(m: number): string {
  if (!Number.isFinite(m)) return "—";
  const h = Math.floor(m / 60);
  const r = m % 60;
  if (h === 0) return `${r}m`;
  if (r === 0) return `${h}h`;
  return `${h}h${r > 0 ? ` ${r}m` : ""}`;
}

/**
 * Gợi ý hiển thị cho từng mã lỗi xếp lịch (theo spec BE).
 * Việc luôn đã được tạo — chỉ phần xếp lịch là chưa thành công.
 */
const SCHEDULE_ERROR_HINT: Record<ScheduleErrorCode, string> = {
  quota_exceeded: "Bạn đã dùng hết lượt AI. Bấm Xếp lịch lại sau.",
  no_active_plan: "Bạn chưa có gói đang hoạt động — hãy chọn gói để xếp lịch.",
  plan_feature_locked: "Tính năng này có ở gói cao hơn.",
  schedule_failed: "AI đang bận, thử lại sau.",
};

/* ---------- editable draft model ---------- */

interface EditableSubtask {
  title: string;
  estimated_minutes: number;
}

interface EditableTask {
  /** Key của bản nháp gốc — cần giữ để BE lấy đúng `AiEstimatedMinutes`. */
  key: string | null;
  title: string;
  domain_id: string;
  estimated_minutes: number;
  /**
   * Việc con.
   * - `undefined` → giữ nguyên việc con AI sinh (bỏ field khi gửi).
   * - `[]` → không có việc con.
   */
  subtasks?: EditableSubtask[];
}

interface EditableMilestone {
  key: string | null;
  title: string;
  deadline: string;
  /** Vì sao AI có giai đoạn này — hiển thị, không sửa. */
  reason?: string | null;
  tasks: EditableTask[];
}

function draftToEditable(d: ProjectDraftDto): EditableMilestone[] {
  return d.milestones.map((m: ProjectDraftMilestoneDto) => ({
    key: m.key ?? null,
    title: m.title,
    deadline: m.deadline,
    reason: m.reason ?? null,
    tasks: m.tasks.map((t) => ({
      key: t.key ?? null,
      title: t.title,
      domain_id: t.domain.id,
      estimated_minutes: t.estimated_minutes,
      // `undefined` khi AI không sinh việc con → giữ nguyên khi Apply.
      subtasks:
        t.subtasks && t.subtasks.length > 0
          ? t.subtasks.map((s) => ({
              title: s.title,
              estimated_minutes: s.estimated_minutes,
            }))
          : undefined,
    })),
  }));
}

/**
 * Chuyển model editable → payload Apply.
 *
 * Quy tắc của BE: bỏ `subtasks` = giữ việc con của AI, `[]` = không việc con.
 * Vì vậy `subtasks: undefined` phải được **loại bỏ hẳn** khỏi JSON
 * (không gửi `subtasks: null`) để BE hiểu là "giữ".
 */
function editableToPayload(
  milestones: EditableMilestone[],
): EditedProjectMilestone[] {
  return milestones.map((m) => ({
    key: m.key,
    title: m.title,
    deadline: m.deadline,
    tasks: m.tasks.map((t) => {
      const task: EditedProjectTask = {
        key: t.key,
        title: t.title,
        domain_id: t.domain_id,
        estimated_minutes: t.estimated_minutes,
      };
      // Chỉ gửi khi user đã thay đổi (có giá trị khác undefined).
      if (t.subtasks !== undefined) {
        task.subtasks = t.subtasks.map((s) => ({
          title: s.title,
          estimated_minutes: s.estimated_minutes,
        }));
      }
      return task;
    }),
  }));
}

/* ===========================================================
 * Main page
 * =========================================================== */
export function ProjectAiChatPage() {
  const { projectId = "" } = useParams();
  const [toasts, toast] = useCenterToast();

  const [project, setProject] = useState<ProjectDto | null>(null);
  const [projectError, setProjectError] = useState<string | null>(null);

  const [conversation, setConversation] = useState<ProjectConversationDto | null>(null);
  const [conversations, setConversations] = useState<ProjectConversationDto[]>([]);
  const [messages, setMessages] = useState<ProjectChatMessageDto[]>([]);
  const [draft, setDraft] = useState<ProjectDraftDto | null>(null);
  const [applied, setApplied] = useState(false);
  const [appliedResult, setAppliedResult] = useState<AppliedProjectBreakdownDto | null>(null);
  /**
   * Đề xuất lịch trả về từ "Áp dụng & xếp lịch".
   * `null` = chưa xếp / xếp lỗi (xem `scheduleError`).
   */
  const [schedule, setSchedule] = useState<AppliedScheduleDto | null>(null);
  /** Mã lỗi xếp lịch — việc đã tạo nhưng chưa xếp được. */
  const [scheduleError, setScheduleError] = useState<ScheduleErrorCode | null>(null);

  const [domains, setDomains] = useState<DomainDto[]>([]);
  const [existingMilestones, setExistingMilestones] = useState<MilestoneDto[]>([]);

  const [composer, setComposer] = useState("");
  const [isTyping, setIsTyping] = useState(false);
  /**
   * AI đã đủ thông tin → bật nút "Lên kế hoạch" (mode = "plan").
   * Lấy từ `ready_to_plan` của tin AI gần nhất.
   */
  const [readyToPlan, setReadyToPlan] = useState(false);
  /** Đang gọi mode "plan" (nút Lên kế hoạch). */
  const [planning, setPlanning] = useState(false);
  /** File đính kèm chờ gửi (tối đa 3). */
  const [attachments, setAttachments] = useState<File[]>([]);
  /** Đang gửi yêu cầu "Lên kế hoạch". */
  const planningRef = useRef(false);
  /**
   * Chốt request đang bay để chặn double-submit.
   * Dùng `useRef` chứ không phải `useState` vì state đóng lại theo render —
   * 2 lần bấm trong cùng 1 tick vẫn thấy `false` → bắn 2 request.
   */
  const sendingRef = useRef(false);
  const applyingRef = useRef(false);
  /** Bản sao state để disable nút trong lúc request đang bay. */
  const [sending, setSending] = useState(false);
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /** Bản nháp đang được user sửa tay. */
  const [editable, setEditable] = useState<EditableMilestone[]>([]);

  const transcriptRef = useRef<HTMLDivElement | null>(null);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);

  /* ---------- load project + conversations ---------- */
  useEffect(() => {
    if (!projectId) return;
    let cancelled = false;
    void getProject(projectId).then((res) => {
      if (cancelled) return;
      if (res.ok) setProject(res.data);
      else setProjectError(res.error);
    });
    void listProjectConversations(projectId).then((res) => {
      if (cancelled) return;
      if (res.ok) setConversations(res.data ?? []);
    });
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  /* Domain list (để user đổi domain của task lúc sửa tay) */
  useEffect(() => {
    let cancelled = false;
    void listDomains().then((res) => {
      if (cancelled) return;
      if (res.ok) setDomains(res.data ?? []);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  /* Milestone đang có — để user biết AI có thể trùng title */
  useEffect(() => {
    if (!projectId) return;
    let cancelled = false;
    void listMilestones(projectId).then((res) => {
      if (cancelled) return;
      if (res.ok) setExistingMilestones(res.data ?? []);
    });
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  /* Mở (hoặc mở lại) 1 cuộc chat */
  const openConversation = useCallback(
    async (conversationId: string) => {
      const res = await getProjectChat(conversationId);
      if (!res.ok) {
        setError(res.error);
        return;
      }
      const chat = res.data;
      setConversation({
        conversation_id: chat.conversation_id,
        title: conversations.find((c) => c.conversation_id === chat.conversation_id)?.title ?? "Brief",
        status: chat.status,
        created_at: "",
      });
      setMessages(chat.messages ?? []);
      setDraft(chat.latest_draft ?? null);
      // Spec BE: `applied = true` nằm trong **draft** → ẩn nút Áp dụng.
      // Fallback về `chat.applied` cho các phiên bản cũ chỉ trả flag ở top.
      setApplied(
        chat.latest_draft?.applied === true || chat.applied === true,
      );
      setEditable(chat.latest_draft ? draftToEditable(chat.latest_draft) : []);
      setAppliedResult(null);
      setSchedule(null);
      setScheduleError(null);
      setAttachments([]);
      // `ready_to_plan` lấy từ tin AI gần nhất có cờ này.
      setReadyToPlan(
        (chat.messages ?? []).some((m) => m.ready_to_plan === true),
      );
    },
    [conversations],
  );

  /**
   * Mở cuộc chat mới — POST /chat/projects/{id}/conversations.
   * Không tốn lượt AI. 409 → project đã đóng (Completed / Archived).
   */
  const startNewConversation = useCallback(async () => {
    if (!projectId) return;
    setError(null);
    setMessages([]);
    setDraft(null);
    setApplied(false);
    setAppliedResult(null);
    setEditable([]);
    setSchedule(null);
    setScheduleError(null);
    setReadyToPlan(false);
    setAttachments([]);
    const res = await startProjectConversation(projectId);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    setConversation(res.data);
    setConversations((prev) => [res.data, ...prev]);
    composerRef.current?.focus();
  }, [projectId]);

  /* Mở cuộc chat mới ngay khi vào trang (project chưa bị đóng). */
  useEffect(() => {
    if (!projectId) return;
    if (conversation) return;
    let cancelled = false;
    void (async () => {
      const res = await startProjectConversation(projectId);
      if (cancelled) return;
      if (res.ok) {
        setConversation(res.data);
        setConversations((prev) => [res.data, ...prev]);
      } else {
        setError(res.error);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  /* auto-scroll */
  useEffect(() => {
    if (transcriptRef.current) {
      transcriptRef.current.scrollTop = transcriptRef.current.scrollHeight;
    }
  }, [messages, isTyping]);

  /* ---------- gửi tin (bàn bạc) ---------- */
  async function handleSend() {
    const raw = composer.trim();
    const files = attachments;
    if (!conversation) return;
    // Chỉ cần nội dung HOẶC file mới gửi được.
    if (!raw && files.length === 0) return;
    if (sendingRef.current) return;
    sendingRef.current = true;
    setSending(true);
    setError(null);
    setComposer("");
    setAttachments([]);
    setIsTyping(true);

    // optimistic bubble — hiện đúng thứ user gõ
    setMessages((prev) => [
      ...prev,
      {
        id: `local-${Date.now()}`,
        role: "user",
        kind: null,
        content: raw,
        created_at: new Date().toISOString(),
        draft: null,
      },
    ]);

    const res = files.length
      ? await sendProjectChatMessageWithFiles(
          conversation.conversation_id,
          raw,
          files,
          "discuss",
        )
      : await sendProjectChatMessage(
          conversation.conversation_id,
          raw,
          "discuss",
        );
    sendingRef.current = false;
    setSending(false);
    setIsTyping(false);

    if (!res.ok) {
      setError(res.error);
      // Trả lại nội dung + file để user không mất ý định.
      setComposer(raw);
      setAttachments(files);
      return;
    }
    const turn = res.data;
    setMessages((prev) => [
      ...prev.filter((m) => !m.id.startsWith("local-")),
      turn.user_message,
      turn.ai_message,
    ]);
    if (turn.ai_message.draft) {
      setDraft(turn.ai_message.draft);
      setEditable(draftToEditable(turn.ai_message.draft));
      // Bản nháp mới → cho phép Apply lại (trừ khi BE đã đánh dấu applied).
      setApplied(turn.ai_message.draft.applied === true);
    }
    // Cờ "sẵn sàng lên kế hoạch" do AI set → bật nút Lên kế hoạch.
    if (turn.ai_message.ready_to_plan === true) setReadyToPlan(true);
  }

  /**
   * Bấm "Lên kế hoạch" / "Cập nhật kế hoạch".
   * Gửi lại **cùng endpoint** với `mode: "plan"` và `message: ""`.
   * Tốn 1 lượt AI.
   */
  async function handlePlan() {
    if (!conversation) return;
    if (planningRef.current) return;
    planningRef.current = true;
    setPlanning(true);
    setError(null);
    setIsTyping(true);

    const res = await sendProjectChatMessage(
      conversation.conversation_id,
      "",
      "plan",
    );
    planningRef.current = false;
    setPlanning(false);
    setIsTyping(false);

    if (!res.ok) {
      setError(res.error);
      return;
    }
    const turn = res.data;
    setMessages((prev) => [
      ...prev.filter((m) => !m.id.startsWith("local-")),
      turn.user_message,
      turn.ai_message,
    ]);
    if (turn.ai_message.draft) {
      setDraft(turn.ai_message.draft);
      setEditable(draftToEditable(turn.ai_message.draft));
      // Bản nháp mới → cho phép Apply lại.
      setApplied(turn.ai_message.draft.applied === true);
    }
    if (turn.ai_message.ready_to_plan === true) setReadyToPlan(true);
  }

  /* ---------- Apply ---------- */

  /** Refresh milestone sau khi áp dụng — để user thấy kết quả ngay. */
  function refreshMilestones() {
    if (!projectId) return;
    void listMilestones(projectId).then((r) => {
      if (r.ok) setExistingMilestones(r.data ?? []);
    });
  }

  /**
   * Dựng lại khối "Đã tạo trong dự án" từ API **Backend**.
   *
   * Chỉ dùng làm **fallback**: response `apply-and-schedule` đã có sẵn
   * `applied.milestones[]`. Nhưng nếu BE không trả `applied` (VD bản cũ),
   * ta gọi `listMilestones` + `listTasks` rồi ghép task vào milestone qua
   * `task.milestoneId`.
   */
  async function loadAppliedResult(): Promise<{ ms: number; tasks: number }> {
    if (!projectId) return { ms: 0, tasks: 0 };

    const [msRes, taskRes] = await Promise.all([
      listMilestones(projectId),
      listTasks(projectId),
    ]);

    if (!msRes.ok) return { ms: 0, tasks: 0 };

    const milestones = msRes.data ?? [];
    const allTasks = taskRes.ok ? (taskRes.data ?? []) : [];

    // Gom task theo milestoneId.
    const byMilestone = new Map<string, TaskDto[]>();
    for (const t of allTasks) {
      const mid = t.milestoneId;
      if (!mid) continue;
      const list = byMilestone.get(mid);
      if (list) list.push(t);
      else byMilestone.set(mid, [t]);
    }

    const result: AppliedProjectBreakdownDto = {
      milestones: milestones.map((m) => ({
        id: m.id,
        title: m.name,
        deadline: m.dueDate ?? m.endDate ?? "",
        tasks: (byMilestone.get(m.id) ?? []).map((t) => ({
          id: t.id,
          title: t.title,
          estimated_minutes: t.estimatedMinutes,
          estimate_source: t.aiEstimatedMinutes ? "ai" : "user",
        })),
      })),
      skipped: [],
    };

    setAppliedResult(result);
    return {
      ms: result.milestones.length,
      tasks: result.milestones.reduce((n, m) => n + m.tasks.length, 0),
    };
  }

  /**
   * Nút phụ "Chỉ áp dụng" — POST /chat/conversations/{id}/apply.
   * Tạo Milestone + Task, **không** xếp lịch. Không tốn lượt AI.
   */
  async function handleApplyOnly() {
    if (!conversation || !draft) return;
    if (applyingRef.current) return;
    if (applied) return;
    applyingRef.current = true;
    setApplying(true);
    setError(null);
    try {
      const res = await applyProjectBreakdown(
        conversation.conversation_id,
        draft.message_id,
        editableToPayload(editable),
      );
      if (!res.ok) {
        setError(res.error);
        return;
      }
      setApplied(true);
      setAppliedResult(res.data);
      setSchedule(null);
      setScheduleError(null);
      setConversation((c) => (c ? { ...c, status: "applied" } : c));
      // Defensive: `apply` trả `{milestones[], skipped[]}` theo spec BE, nhưng
      // nếu BE đổi shape → không được phép crash (xem bug apply-and-schedule).
      const milestones = res.data.milestones ?? [];
      const skipped = res.data.skipped ?? [];
      const created =
        milestones.reduce((n, m) => n + (m.tasks?.length ?? 0), 0) || 0;
      toast.success(
        `Đã tạo ${milestones.length} milestone và ${created} task`,
        skipped.length
          ? `${skipped.length} task bị bỏ qua (trùng việc đã có)`
          : undefined,
      );
      refreshMilestones();
    } finally {
      applyingRef.current = false;
      setApplying(false);
    }
  }

  /**
   * Nút chính "Áp dụng & xếp lịch" — POST /chat/conversations/{id}/apply-and-schedule.
   * Tạo Milestone + Task **và** xếp lịch. Tốn 1 lượt AI (phần xếp lịch).
   *
   * ⚠️ Shape response (đối chiếu OpenAPI AI service):
   *   {`applied`: {milestones[], skipped[]}, `schedule`, `schedule_error`}
   *
   * `milestones[]` nằm trong `applied`, KHÔNG ở top-level → đọc sai sẽ
   * crash với "Cannot read properties of undefined (reading 'reduce')".
   *
   * Nếu `schedule_error` có giá trị → việc **đã được tạo**, chỉ chưa xếp
   * được lịch → hiện thông báo + nút "Xếp lịch" để user thử lại.
   */
  async function handleApplyAndSchedule() {
    if (!conversation || !draft) return;
    if (applyingRef.current) return;
    if (applied) return;
    applyingRef.current = true;
    setApplying(true);
    setError(null);
    try {
      const res = await applyAndScheduleProjectBreakdown(
        conversation.conversation_id,
        draft.message_id,
        editableToPayload(editable),
        "vi",
      );
      if (!res.ok) {
        setError(res.error);
        return;
      }
      setApplied(true);
      setConversation((c) => (c ? { ...c, status: "applied" } : c));

      const err = res.data.schedule_error ?? null;
      setScheduleError(err);
      setSchedule(res.data.schedule ?? null);

      // Kết quả apply nằm trong `applied` — fallback sang listMilestones
      // nếu BE không trả (để khối "Đã tạo trong dự án" vẫn hiện được).
      const appliedData = res.data.applied ?? null;
      if (appliedData) {
        setAppliedResult(appliedData);
      } else {
        await loadAppliedResult();
      }

      const milestones = appliedData?.milestones ?? [];
      const created =
        milestones.reduce((n, m) => n + (m.tasks?.length ?? 0), 0) || 0;

      if (err) {
        // Việc đã tạo nhưng chưa xếp được lịch.
        toast.error(
          "Đã tạo việc, chưa xếp được lịch",
          SCHEDULE_ERROR_HINT[err],
        );
      } else {
        const slotCount = res.data.schedule?.slots?.length ?? 0;
        toast.success(
          created > 0
            ? `Đã tạo ${milestones.length} cột mốc và ${created} việc`
            : "Đã tạo việc thành công",
          slotCount > 0
            ? `Đã xếp ${slotCount} khung giờ — xem đề xuất bên dưới.`
            : undefined,
        );
      }
      refreshMilestones();
    } finally {
      applyingRef.current = false;
      setApplying(false);
    }
  }

  /* ---------- sửa tay bản nháp ---------- */
  function patchMilestone(index: number, patch: Partial<EditableMilestone>) {
    setEditable((prev) =>
      prev.map((m, i) => (i === index ? { ...m, ...patch } : m)),
    );
  }
  function patchTask(
    mIdx: number,
    tIdx: number,
    patch: Partial<EditableTask>,
  ) {
    setEditable((prev) =>
      prev.map((m, i) =>
        i === mIdx
          ? {
              ...m,
              tasks: m.tasks.map((t, j) => (j === tIdx ? { ...t, ...patch } : t)),
            }
          : m,
      ),
    );
  }
  function removeTask(mIdx: number, tIdx: number) {
    setEditable((prev) =>
      prev.map((m, i) =>
        i === mIdx ? { ...m, tasks: m.tasks.filter((_, j) => j !== tIdx) } : m,
      ),
    );
  }
  function removeMilestone(index: number) {
    setEditable((prev) => prev.filter((_, i) => i !== index));
  }

  /* ---------- sửa việc con (subtasks) ---------- */

  /** Thêm 1 việc con vào task. */
  function addSubtask(mIdx: number, tIdx: number) {
    setEditable((prev) =>
      prev.map((m, i) =>
        i === mIdx
          ? {
              ...m,
              tasks: m.tasks.map((t, j) =>
                j === tIdx
                  ? {
                      ...t,
                      // `[]` = chủ động không có việc con.
                      subtasks: [
                        ...(t.subtasks ?? []),
                        { title: "", estimated_minutes: 30 },
                      ],
                    }
                  : t,
              ),
            }
          : m,
      ),
    );
  }

  /** Sửa 1 việc con. */
  function patchSubtask(
    mIdx: number,
    tIdx: number,
    sIdx: number,
    patch: Partial<EditableSubtask>,
  ) {
    setEditable((prev) =>
      prev.map((m, i) =>
        i === mIdx
          ? {
              ...m,
              tasks: m.tasks.map((t, j) =>
                j === tIdx
                  ? {
                      ...t,
                      subtasks: (t.subtasks ?? []).map((s, k) =>
                        k === sIdx ? { ...s, ...patch } : s,
                      ),
                    }
                  : t,
              ),
            }
          : m,
      ),
    );
  }

  /** Bỏ 1 việc con. */
  function removeSubtask(mIdx: number, tIdx: number, sIdx: number) {
    setEditable((prev) =>
      prev.map((m, i) =>
        i === mIdx
          ? {
              ...m,
              tasks: m.tasks.map((t, j) =>
                j === tIdx
                  ? {
                      ...t,
                      subtasks: (t.subtasks ?? []).filter((_, k) => k !== sIdx),
                    }
                  : t,
              ),
            }
          : m,
      ),
    );
  }

  /** Bỏ hết việc con (gửi `subtasks: []` → BE hiểu là không việc con). */
  function clearSubtasks(mIdx: number, tIdx: number) {
    setEditable((prev) =>
      prev.map((m, i) =>
        i === mIdx
          ? {
              ...m,
              tasks: m.tasks.map((t, j) =>
                j === tIdx ? { ...t, subtasks: [] } : t,
              ),
            }
          : m,
      ),
    );
  }

  function restoreDraft() {
    if (!draft) return;
    setEditable(draftToEditable(draft));
  }

  /* ---------- derived ---------- */
  const totalTasks = useMemo(
    () => editable.reduce((n, m) => n + m.tasks.length, 0),
    [editable],
  );
  const totalMinutes = useMemo(
    () =>
      editable.reduce(
        (n, m) => n + m.tasks.reduce((k, t) => k + (t.estimated_minutes || 0), 0),
        0,
      ),
    [editable],
  );
  const hasEdits = useMemo(() => {
    if (!draft) return false;
    const base = draftToEditable(draft);
    return JSON.stringify(base) !== JSON.stringify(editable);
  }, [draft, editable]);

  const projectClosed = project
    ? project.status === "Completed" || project.status === "Archived"
    : false;

  return (
    <section className="pac">
      {/* ============ Sub-header ============ */}
      <div className="pac-subbar">
        <div className="pac-subbar-inner">
          <div className="pac-breadcrumb">
            <span className="pac-breadcrumb-link">Workspace</span>
            <span className="material-symbols-outlined pac-breadcrumb-sep">chevron_right</span>
            <Link to="/projects" className="pac-breadcrumb-link">
              Projects
            </Link>
            <span className="material-symbols-outlined pac-breadcrumb-sep">chevron_right</span>
            <span className="pac-breadcrumb-current">
              AI Plan · {project?.name ?? "…"}
            </span>
          </div>
          <div className="pac-subbar-right">
            {conversations.length > 0 && (
              <select
                className="pac-convo-select"
                value={conversation?.conversation_id ?? ""}
                onChange={(e) => void openConversation(e.target.value)}
                aria-label="Chọn cuộc chat"
              >
                {conversations.map((c) => (
                  <option key={c.conversation_id} value={c.conversation_id}>
                    {c.title} · {c.status === "applied" ? "đã áp dụng" : "đang mở"}
                  </option>
                ))}
              </select>
            )}
            {conversation && (
              <span className="pac-convo-pill" title="Conversation status">
                <span className="pac-convo-dot" />
                {conversation.status === "open" ? "Brief đang mở" : "Đã áp dụng"}
              </span>
            )}
            <button
              type="button"
              className="pac-toolbar-btn"
              onClick={() => void startNewConversation()}
              disabled={!conversation || sending}
              title="Mở cuộc chat mới (mỗi cuộc chat chỉ áp dụng được 1 lần)"
            >
              <span className="material-symbols-outlined pac-toolbar-icon">add_comment</span>
              <span>Brief mới</span>
            </button>
            {projectId && (
              <Link
                to={`/projects/${projectId}/planning`}
                className="pac-toolbar-btn"
                title="Mở kế hoạch thủ công"
              >
                <span className="material-symbols-outlined pac-toolbar-icon">checklist</span>
                <span>Kế hoạch</span>
              </Link>
            )}
          </div>
        </div>
      </div>

      <div className="pac-container">
        <div className="pac-grid">
          {/* ============ LEFT: chat ============ */}
          <div className="pac-stream">
            <div className="pac-stream-head">
              <div className="pac-stream-title">
                <div className="pac-stream-avatar">
                  <span className="material-symbols-outlined">neurology</span>
                </div>
                <div className="pac-stream-title-text">
                  <h1 className="pac-stream-h1">AI Project Planner</h1>
                  <p className="pac-stream-sub">
                    Dán brief của khách → AI tách milestone + task → bạn duyệt rồi Apply
                  </p>
                </div>
              </div>
              <div className="pac-stream-tags">
                {project && (
                  <span className="pac-tag pac-tag--primary" title="Project deadline">
                    <span className="material-symbols-outlined pac-tag-icon">event</span>
                    Deadline {fmtDate(project.deadline)}
                  </span>
                )}
                <span className="pac-tag pac-tag--secondary">
                  <span className="material-symbols-outlined pac-tag-icon">bolt</span>
                  {messages.length} msgs
                </span>
              </div>
            </div>

            {projectClosed && (
              <div className="pac-banner pac-banner--error" role="alert">
                <span className="material-symbols-outlined">lock</span>
                <span>
                  Project đã đóng ({project?.status}) — không thể mở chat mới. Hãy mở lại
                  project hoặc dùng kế hoạch thủ công.
                </span>
              </div>
            )}

            {error && (
              <div className="pac-banner pac-banner--error" role="alert">
                <span className="material-symbols-outlined">error</span>
                <span>{error}</span>
              </div>
            )}
            {projectError && (
              <div className="pac-banner pac-banner--error" role="alert">
                <span className="material-symbols-outlined">error</span>
                <span>Không tải được project: {projectError}</span>
              </div>
            )}

            {/* Transcript */}
            <div className="pac-transcript" ref={transcriptRef}>
              {messages.length === 0 && !isTyping && (
                <div className="pac-empty">
                  <span className="material-symbols-outlined">content_paste</span>
                  <p>
                    Dán brief của khách vào ô bên dưới — mô tả sản phẩm cần làm, deadline,
                    và các ràng buộc. AI sẽ hỏi lại nếu thiếu thông tin.
                  </p>
                </div>
              )}

              {messages.map((m) => (
                <Message
                  key={m.id}
                  msg={m}
                  onPlan={() => void handlePlan()}
                  planning={planning}
                />
              ))}

              {isTyping && (
                <div className="pac-msg pac-msg--ai">
                  <div className="pac-ai-avatar">
                    <span className="material-symbols-outlined">neurology</span>
                  </div>
                  <div className="pac-msg-body">
                    <div className="pac-msg-meta">
                      <span className="pac-msg-meta-name">METANOIA Engine</span>
                      <span className="pac-msg-meta-time">· Đang phân tích brief…</span>
                    </div>
                    <div className="pac-typing">
                      <span className="pac-typing-dot" />
                      <span className="pac-typing-dot" />
                      <span className="pac-typing-dot" />
                    </div>
                  </div>
                </div>
              )}
            </div>

            {/* Composer */}
            <div className="pac-composer">
              {/* File đã đính kèm (tối đa 3) */}
              {attachments.length > 0 && (
                <div className="pac-attachments">
                  {attachments.map((f, i) => (
                    <span className="pac-attachment" key={`${f.name}-${i}`}>
                      <span className="material-symbols-outlined">attach_file</span>
                      <span className="pac-attachment-name">{f.name}</span>
                      <button
                        type="button"
                        className="pac-attachment-remove"
                        onClick={() =>
                          setAttachments((prev) => prev.filter((_, j) => j !== i))
                        }
                        aria-label={`Bỏ ${f.name}`}
                      >
                        <span className="material-symbols-outlined">close</span>
                      </button>
                    </span>
                  ))}
                </div>
              )}

              <textarea
                ref={composerRef}
                className="pac-input"
                rows={5}
                placeholder={
                  projectClosed
                    ? "Project đã đóng — không thể chat AI."
                    : "Dán brief của khách ở đây…\n\nVí dụ: Cần làm landing page 3 trang cho shop bán bánh, có trang giỏ hàng và checkout, deadline giữa tháng 12. Khách dùng tone xanh navy."
                }
                value={composer}
                onChange={(e) => setComposer(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                    e.preventDefault();
                    void handleSend();
                  }
                }}
                disabled={!conversation || sending || projectClosed}
              />
              <div className="pac-composer-foot">
                <span>Ctrl/⌘ + Enter để gửi · tối đa 8.000 ký tự</span>
                <span>
                  {composer.length}/8000
                </span>
              </div>
              <div className="pac-composer-actions">
                {/* Đính kèm file — pdf, docx, txt, md, xlsx, csv */}
                <label className="pac-attach-btn">
                  <input
                    type="file"
                    multiple
                    className="pac-attach-input"
                    accept=".pdf,.docx,.txt,.md,.xlsx,.csv,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/plain,text/markdown,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                    disabled={!conversation || sending || projectClosed || attachments.length >= 3}
                    onChange={(e) => {
                      const picked = Array.from(e.target.files ?? []);
                      // Tối đa 3 file/tin.
                      setAttachments((prev) =>
                        [...prev, ...picked].slice(0, 3),
                      );
                      e.target.value = "";
                    }}
                  />
                  <span className="material-symbols-outlined">attach_file</span>
                  <span>Đính kèm</span>
                </label>

                {/* Nút "Lên kế hoạch" — mode = "plan" */}
                <button
                  type="button"
                  className={
                    "pac-btn pac-btn--ghost" + (readyToPlan ? " pac-btn--ready" : "")
                  }
                  onClick={() => void handlePlan()}
                  disabled={
                    !conversation ||
                    planning ||
                    sending ||
                    applied ||
                    projectClosed
                  }
                  title={
                    readyToPlan
                      ? "AI đã đủ thông tin — lên kế hoạch"
                      : "AI chưa đủ thông tin — cần bàn bạc thêm"
                  }
                >
                  <span className="material-symbols-outlined">
                    {planning ? "hourglass_top" : "route"}
                  </span>
                  <span>
                    {planning
                      ? "Đang lên kế hoạch…"
                      : draft
                        ? "Cập nhật kế hoạch"
                        : "Lên kế hoạch"}
                  </span>
                </button>

                <button
                  type="button"
                  className="pac-btn pac-btn--primary"
                  onClick={() => void handleSend()}
                  disabled={
                    !conversation ||
                    (!composer.trim() && attachments.length === 0) ||
                    sending ||
                    applied ||
                    projectClosed
                  }
                >
                  <span className="material-symbols-outlined">
                    {isTyping ? "hourglass_top" : "arrow_upward"}
                  </span>
                  <span>{applied ? "Đã áp dụng brief này" : "Gửi brief cho AI"}</span>
                </button>
              </div>
            </div>
          </div>

          {/* ============ RIGHT: draft + context ============ */}
          <aside className="pac-side">
            {/* Draft card */}
            <div className="pac-card">
              <div className="pac-card-head">
                <div className="pac-card-head-left">
                  <span className="material-symbols-outlined pac-card-icon pac-card-icon--primary">
                    account_tree
                  </span>
                  <h2 className="pac-card-title pac-card-title--sm">
                    Bản nháp milestone + task
                  </h2>
                  {/* Spec BE: `applied = true` → nhãn "Đã áp dụng" */}
                  {draft?.applied === true && (
                    <span className="pac-card-badge-applied">
                      <span className="material-symbols-outlined">check_circle</span>
                      Đã áp dụng
                    </span>
                  )}
                </div>
                {draft && (
                  <span className="pac-card-meta">
                    {editable.length} milestone · {totalTasks} task
                  </span>
                )}
              </div>

              {!draft && (
                <p className="pac-card-sub">
                  Chưa có bản nháp. Gửi brief để AI đề xuất cấu trúc milestone + task.
                </p>
              )}

              {draft && (
                <>
                  {/* Numbers */}
                  <div className="pac-numbers">
                    <div className="pac-numbers-cell">
                      <span className="pac-numbers-label">Tổng AI đoán</span>
                      <span className="pac-numbers-value">
                        {fmtMinutes(totalMinutes)}
                      </span>
                    </div>
                    <div className="pac-numbers-cell">
                      <span className="pac-numbers-label">Đã chỉnh (×K)</span>
                      <span className="pac-numbers-value pac-numbers-value--primary">
                        {fmtMinutes(draft.numbers.total_adjusted_minutes)}
                      </span>
                    </div>
                    <div className="pac-numbers-cell">
                      <span className="pac-numbers-label">Còn</span>
                      <span className="pac-numbers-value pac-numbers-value--secondary">
                        {draft.numbers.days_left !== null
                          ? `${draft.numbers.days_left} ngày`
                          : "—"}
                      </span>
                    </div>
                  </div>

                  {draft.numbers.adjusted_is_hint && (
                    <p className="pac-hint-note">
                      Gói Free — số phút đã chỉnh chỉ là gợi ý, chưa dùng để học K_bias.
                    </p>
                  )}

                  {draft.warnings.length > 0 && (
                    <div className="pac-warnings">
                      {draft.warnings.map((w, i) => (
                        <div className="pac-warning" key={i}>
                          <span className="material-symbols-outlined">warning</span>
                          <span>{w}</span>
                        </div>
                      ))}
                    </div>
                  )}

                  {/* Editable milestones */}
                  <div className="pac-draft">
                    {editable.map((m, mIdx) => (
                      <div className="pac-ms" key={`${m.key ?? "m"}-${mIdx}`}>
                        <div className="pac-ms-head">
                          <span className="material-symbols-outlined pac-ms-icon">
                            flag
                          </span>
                          <input
                            className="pac-ms-title"
                            value={m.title}
                            onChange={(e) =>
                              patchMilestone(mIdx, { title: e.target.value })
                            }
                            aria-label="Tên milestone"
                          />
                          <input
                            type="date"
                            className="pac-ms-date"
                            value={m.deadline ?? ""}
                            onChange={(e) =>
                              patchMilestone(mIdx, { deadline: e.target.value })
                            }
                            aria-label="Deadline milestone"
                          />
                          <button
                            type="button"
                            className="pac-icon-btn pac-icon-btn--danger"
                            onClick={() => removeMilestone(mIdx)}
                            title="Bỏ milestone này khỏi bản nháp"
                          >
                            <span className="material-symbols-outlined">delete</span>
                          </button>
                        </div>

                        {/* Vì sao AI có giai đoạn này (chỉ đọc) */}
                        {m.reason && (
                          <p className="pac-ms-reason">
                            <span className="material-symbols-outlined">lightbulb</span>
                            {m.reason}
                          </p>
                        )}

                        <div className="pac-ms-tasks">
                          {m.tasks.map((t, tIdx) => (
                            <div className="pac-task" key={`${t.key ?? "t"}-${tIdx}`}>
                              <input
                                className="pac-task-title"
                                value={t.title}
                                onChange={(e) =>
                                  patchTask(mIdx, tIdx, { title: e.target.value })
                                }
                                aria-label="Tên task"
                              />
                              <select
                                className="pac-task-domain"
                                value={t.domain_id}
                                onChange={(e) =>
                                  patchTask(mIdx, tIdx, { domain_id: e.target.value })
                                }
                                aria-label="Domain"
                              >
                                {domains.length === 0 && (
                                  <option value={t.domain_id}>{t.domain_id.slice(0, 8)}…</option>
                                )}
                                {domains.map((d) => (
                                  <option key={d.id} value={d.id}>
                                    {d.name}
                                  </option>
                                ))}
                              </select>
                              <input
                                type="number"
                                className="pac-task-mins"
                                value={t.estimated_minutes}
                                min={5}
                                max={960}
                                step={5}
                                onChange={(e) =>
                                  patchTask(mIdx, tIdx, {
                                    estimated_minutes: Number(e.target.value) || 0,
                                  })
                                }
                                aria-label="Số phút"
                              />
                              <span className="pac-task-unit">phút</span>
                              <button
                                type="button"
                                className="pac-icon-btn pac-icon-btn--danger"
                                onClick={() => removeTask(mIdx, tIdx)}
                                title="Bỏ task này khỏi bản nháp"
                              >
                                <span className="material-symbols-outlined">close</span>
                              </button>

                              {/* ── Việc con (AI sinh khi task > 2 giờ) ── */}
                              <div className="pac-task-subs">
                                {t.subtasks && t.subtasks.length > 0 && (
                                  <div className="pac-task-subs-head">
                                    <span className="material-symbols-outlined">
                                      account_tree
                                    </span>
                                    <span>Việc con ({t.subtasks.length})</span>
                                    <button
                                      type="button"
                                      className="pac-task-subs-clear"
                                      onClick={() => clearSubtasks(mIdx, tIdx)}
                                      title="Bỏ toàn bộ việc con (gửi subtasks = [])"
                                    >
                                      Bỏ hết
                                    </button>
                                  </div>
                                )}

                                {(t.subtasks ?? []).map((s, sIdx) => (
                                  <div
                                    className="pac-subtask"
                                    key={`${t.key ?? "t"}-${tIdx}-s${sIdx}`}
                                  >
                                    <span
                                      className="material-symbols-outlined pac-subtask-icon"
                                      aria-hidden="true"
                                    >
                                      subdirectory_arrow_right
                                    </span>
                                    <input
                                      className="pac-subtask-title"
                                      value={s.title}
                                      onChange={(e) =>
                                        patchSubtask(mIdx, tIdx, sIdx, {
                                          title: e.target.value,
                                        })
                                      }
                                      aria-label="Tên việc con"
                                      placeholder="Tên việc con"
                                    />
                                    <input
                                      type="number"
                                      className="pac-subtask-mins"
                                      value={s.estimated_minutes}
                                      min={5}
                                      max={960}
                                      step={5}
                                      onChange={(e) =>
                                        patchSubtask(mIdx, tIdx, sIdx, {
                                          estimated_minutes:
                                            Number(e.target.value) || 0,
                                        })
                                      }
                                      aria-label="Số phút việc con"
                                    />
                                    <span className="pac-subtask-unit">phút</span>
                                    <button
                                      type="button"
                                      className="pac-icon-btn pac-icon-btn--danger"
                                      onClick={() =>
                                        removeSubtask(mIdx, tIdx, sIdx)
                                      }
                                      title="Bỏ việc con này"
                                    >
                                      <span className="material-symbols-outlined">
                                        close
                                      </span>
                                    </button>
                                  </div>
                                ))}

                                <button
                                  type="button"
                                  className="pac-task-subs-add"
                                  onClick={() => addSubtask(mIdx, tIdx)}
                                >
                                  <span className="material-symbols-outlined">add</span>
                                  Thêm việc con
                                </button>
                              </div>
                            </div>
                          ))}
                          {m.tasks.length === 0 && (
                            <p className="pac-task-empty">
                              Milestone này không còn task nào — sẽ bị bỏ qua khi Apply.
                            </p>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>

                  {/* Reminders (AI không tạo task Fixed) */}
                  {draft.reminders.length > 0 && (
                    <div className="pac-reminders">
                      <div className="pac-reminders-head">
                        <span className="material-symbols-outlined">notifications_active</span>
                        <span>Việc cố định — cần bạn tự tạo (AI không tạo task Fixed)</span>
                      </div>
                      <ul className="pac-reminders-list">
                        {draft.reminders.map((r, i) => (
                          <li key={i}>{r}</li>
                        ))}
                      </ul>
                    </div>
                  )}

                  {/* Actions — nút chính "Áp dụng & xếp lịch", nút phụ "Chỉ áp dụng" */}
                  <div className="pac-actions">
                    <button
                      type="button"
                      className="pac-btn pac-btn--primary"
                      onClick={() => void handleApplyAndSchedule()}
                      disabled={applying || applied || totalTasks === 0}
                    >
                      <span className="material-symbols-outlined">
                        {applied ? "check_circle" : "event_available"}
                      </span>
                      <span>
                        {applied
                          ? "Đã áp dụng"
                          : `Áp dụng & xếp lịch (${editable.length} milestone · ${totalTasks} task)`}
                      </span>
                    </button>
                    <button
                      type="button"
                      className="pac-btn pac-btn--ghost"
                      onClick={() => void handleApplyOnly()}
                      disabled={applying || applied || totalTasks === 0}
                    >
                      <span className="material-symbols-outlined">checklist</span>
                      <span>Chỉ áp dụng</span>
                    </button>
                    {hasEdits && !applied && (
                      <button
                        type="button"
                        className="pac-btn pac-btn--ghost"
                        onClick={restoreDraft}
                      >
                        <span className="material-symbols-outlined">undo</span>
                        <span>Khôi phục bản AI</span>
                      </button>
                    )}
                  </div>

                  {applied && (
                    <p className="pac-applied-note">
                      Mỗi cuộc chat chỉ áp dụng được <strong>1 lần</strong>. Muốn bổ sung
                      việc khác, hãy bấm <strong>Brief mới</strong> ở góc trên.
                    </p>
                  )}
                </>
              )}

                  {/* Applied result */}
                  {appliedResult && (
                    <div className="pac-result">
                      <div className="pac-result-head">
                        <span className="material-symbols-outlined">task_alt</span>
                        <span>Đã tạo trong dự án</span>
                      </div>
                      {(appliedResult.milestones ?? []).map((m) => (
                    <div className="pac-result-ms" key={m.id}>
                      <div className="pac-result-ms-title">{m.title}</div>
                      <div className="pac-result-ms-deadline">
                        {fmtDate(m.deadline)}
                        {/* `reused` = milestone đã có sẵn, task được thêm vào. */}
                        {m.reused && (
                          <span className="pac-result-reused">
                            Đã thêm vào cột mốc này
                          </span>
                        )}
                      </div>
                      <ul className="pac-result-tasks">
                        {(m.tasks ?? []).map((t) => (
                          <li key={t.id}>
                            <span>{t.title}</span>
                            <span className="pac-result-badge">
                              {fmtMinutes(t.estimated_minutes)}
                            </span>
                            <span
                              className={
                                "pac-result-badge " +
                                (t.estimate_source === "ai"
                                  ? "pac-result-badge--ai"
                                  : "pac-result-badge--user")
                              }
                              title="Nguồn ước lượng"
                            >
                              {t.estimate_source === "ai" ? "AI" : "Bạn"}
                            </span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  ))}
                  {(appliedResult.skipped ?? []).length > 0 && (
                    <div className="pac-result-skipped">
                      <div className="pac-result-skipped-head">
                        <span className="material-symbols-outlined">content_copy</span>
                        <span>Bị bỏ qua ({(appliedResult.skipped ?? []).length})</span>
                      </div>
                      <ul className="pac-reminders-list">
                        {(appliedResult.skipped ?? []).map((s, i) => (
                          <li key={i}>
                            {s.title} —{" "}
                            {s.reason === "existing_task"
                              ? "trùng task đã có"
                              : "trùng trong bản nháp"}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}

                  {/* ── Đề xuất lịch ── */}
                  {scheduleError && (
                    <div className="pac-schedule-error" role="alert">
                      <span className="material-symbols-outlined">error</span>
                      <div className="pac-schedule-error-body">
                        <strong>Đã tạo việc, chưa xếp được lịch</strong>
                        <span>{SCHEDULE_ERROR_HINT[scheduleError]}</span>
                      </div>
                      {projectId && (
                        <Link
                          to={`/projects/${projectId}/schedule`}
                          className="pac-btn pac-btn--ghost pac-btn--sm"
                        >
                          <span className="material-symbols-outlined">calendar_month</span>
                          <span>Xếp lịch</span>
                        </Link>
                      )}
                    </div>
                  )}

                  {/*
                    ✅ Thông báo thành công — chỉ hiện khi "Áp dụng & xếp lịch"
                    chạy OK (không có `schedule_error`). Hiển thị rõ số cột mốc /
                    việc đã tạo và số khung giờ đã xếp.
                  */}
                  {applied && !scheduleError && (
                    <div className="pac-success" role="status">
                      <span className="material-symbols-outlined pac-success-icon">
                        check_circle
                      </span>
                      <div className="pac-success-body">
                        <strong>Tạo và xếp lịch thành công</strong>
                        <span>
                          {appliedResult && appliedResult.milestones
                            ? `Đã tạo ${appliedResult.milestones.length} cột mốc và ${appliedResult.milestones.reduce((n, m) => n + (m.tasks?.length ?? 0), 0)} việc trong dự án.`
                            : "Đã tạo việc trong dự án."}
                          {schedule && (schedule.slots ?? []).length > 0
                            ? ` Đã xếp ${schedule.slots.length} khung giờ — xem đề xuất bên dưới.`
                            : ""}
                        </span>
                      </div>
                    </div>
                  )}

                  {schedule && (schedule.slots ?? []).length > 0 && (
                    <div className="pac-schedule">
                      <div className="pac-schedule-head">
                        <span className="material-symbols-outlined">calendar_month</span>
                        <span>Đề xuất lịch ({schedule.slots.length} khung giờ)</span>
                      </div>
                      {schedule.explanation && (
                        <p className="pac-schedule-explain">{schedule.explanation}</p>
                      )}
                      {!schedule.is_feasible && (
                        <p className="pac-schedule-infeasible">
                          Có {schedule.missing_minutes} phút chưa kịp hạn — các việc
                          còn lại vẫn đã được xếp.
                        </p>
                      )}
                      <ul className="pac-schedule-slots">
                        {(schedule.slots ?? []).map((s) => (
                          <li key={s.slot_id}>
                            <span className="pac-schedule-slot-time">
                              {fmtHHmm(s.start)} – {fmtHHmm(s.end)}
                            </span>
                            <span className="pac-schedule-slot-mins">
                              {fmtMinutes(s.proposed_minutes)}
                            </span>
                            {s.explanation && (
                              <span className="pac-schedule-slot-why">
                                {s.explanation}
                              </span>
                            )}
                          </li>
                        ))}
                      </ul>
                      {(schedule.warnings ?? []).length > 0 && (
                        <div className="pac-warnings">
                          {(schedule.warnings ?? []).map((w, i) => (
                            <div className="pac-warning" key={i}>
                              <span className="material-symbols-outlined">warning</span>
                              <span>{w.message ?? w.type}</span>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  )}

                  {projectId && (
                    <Link
                      to={`/projects/${projectId}/planning`}
                      className="pac-btn pac-btn--ghost"
                    >
                      <span className="material-symbols-outlined">checklist</span>
                      <span>Xem trong Kế hoạch</span>
                    </Link>
                  )}
                </div>
              )}
            </div>

            {/* Context */}
            <div className="pac-card">
              <div className="pac-card-head">
                <div className="pac-card-head-left">
                  <span className="material-symbols-outlined pac-card-icon pac-card-icon--secondary">
                    info
                  </span>
                  <h2 className="pac-card-title pac-card-title--sm">Ngữ cảnh</h2>
                </div>
              </div>
              <ul className="pac-context-list">
                <li>
                  <strong>Project:</strong> {project?.name ?? "—"} · deadline{" "}
                  {fmtDate(project?.deadline)}
                </li>
                <li>
                  <strong>Milestone đang có:</strong>{" "}
                    {existingMilestones.length === 0
                    ? "chưa có"
                    : existingMilestones.map((m) => m.name).join(", ")}
                </li>
                <li>
                  <strong>AI sẽ bỏ qua</strong> task trùng title với việc đang có.
                </li>
                <li>
                  <strong>Apply chỉ tạo mới</strong> — không sửa/xoá milestone hay task cũ.
                </li>
              </ul>
            </div>
          </aside>
        </div>
      </div>

      <CenterToasts toasts={toasts} onDismiss={toast.dismiss} />
    </section>
  );
}

/* ===========================================================
 * Sub-components
 * =========================================================== */

function Message({
  msg,
  onPlan,
  planning,
}: {
  msg: ProjectChatMessageDto;
  onPlan: () => void;
  planning: boolean;
}) {
  if (msg.role === "user") {
    return (
      <div className="pac-msg pac-msg--user">
        <div className="pac-msg-col">
          <div className="pac-msg-meta pac-msg-meta--right">
            <span className="pac-msg-meta-time">{fmtHHmm(msg.created_at)} · Bạn</span>
          </div>
          <div className="pac-bubble pac-bubble--user">{msg.content}</div>
        </div>
      </div>
    );
  }

  const notes = msg.notes ?? null;
  const hasNotes =
    notes &&
    (notes.clear?.length ||
      notes.missing?.length ||
      notes.questions?.length ||
      notes.risks?.length);

  return (
    <div className="pac-msg pac-msg--ai">
      <div className="pac-ai-avatar">
        <span className="material-symbols-outlined">neurology</span>
      </div>
      <div className="pac-msg-body">
        <div className="pac-msg-meta">
          <span className="pac-msg-meta-name">METANOIA Engine</span>
          <span className="pac-msg-meta-time">
            · {fmtHHmm(msg.created_at)}
            {msg.kind === "question" ? " · cần thêm thông tin" : ""}
          </span>
        </div>

        {msg.content && (
          <div className="pac-ai-content">
            <div className="pac-bubble pac-bubble--ai">{msg.content}</div>
            <CopyButton text={msg.content} />
          </div>
        )}

        {/* Bảng ghi chú bên phải: đã rõ / còn thiếu / nên hỏi / rủi ro */}
        {hasNotes && (
          <div className="pac-notes">
            <NotesGroup
              tone="clear"
              icon="check_circle"
              title="Đã rõ"
              items={notes?.clear ?? []}
            />
            <NotesGroup
              tone="missing"
              icon="help"
              title="Còn thiếu"
              items={notes?.missing ?? []}
            />
            <NotesGroup
              tone="questions"
              icon="forum"
              title="Nên hỏi thêm"
              items={notes?.questions ?? []}
            />
            <NotesGroup
              tone="risks"
              icon="warning"
              title="Rủi ro"
              items={notes?.risks ?? []}
            />
          </div>
        )}

        {msg.kind === "question" && (
          <span className="pac-verified">
            <span className="material-symbols-outlined pac-verified-icon">help</span>
            AI đang hỏi lại — trả lời để có bản nháp
          </span>
        )}

        {/* `ready_to_plan = true` → nút Lên kế hoạch sáng lên */}
        {msg.ready_to_plan === true && (
          <button
            type="button"
            className="pac-btn pac-btn--primary pac-plan-btn"
            onClick={onPlan}
            disabled={planning}
          >
            <span className="material-symbols-outlined">
              {planning ? "hourglass_top" : "route"}
            </span>
            <span>{planning ? "Đang lên kế hoạch…" : "Lên kế hoạch"}</span>
          </button>
        )}
      </div>
    </div>
  );
}

/* ---------- Nhóm ghi chú (Đã rõ / Còn thiếu / Nên hỏi / Rủi ro) ---------- */

function NotesGroup({
  tone,
  icon,
  title,
  items,
}: {
  tone: "clear" | "missing" | "questions" | "risks";
  icon: string;
  title: string;
  items: string[];
}) {
  if (!items || items.length === 0) return null;
  return (
    <div className={`pac-notes-group pac-notes-group--${tone}`}>
      <div className="pac-notes-group-head">
        <span className="material-symbols-outlined pac-notes-group-icon">
          {icon}
        </span>
        <span>{title}</span>
        <span className="pac-notes-group-count">{items.length}</span>
      </div>
      <ul className="pac-notes-group-list">
        {items.map((t, i) => (
          <li key={i}>{t}</li>
        ))}
      </ul>
    </div>
  );
}

/* ---------- Nút sao chép nội dung AI ---------- */

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      setCopied(false);
    }
  }

  return (
    <button
      type="button"
      className={"pac-copy-btn" + (copied ? " pac-copy-btn--done" : "")}
      onClick={() => void handleCopy()}
      aria-label="Sao chép nội dung"
      title={copied ? "Đã sao chép" : "Sao chép"}
    >
      <span className="material-symbols-outlined">
        {copied ? "check" : "content_copy"}
      </span>
    </button>
  );
}
