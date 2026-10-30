import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { CenterToasts, useCenterToast } from "../../components/Toast";
import {
  applyProjectBreakdown,
  getProject,
  getProjectChat,
  listDomains,
  listMilestones,
  listProjectConversations,
  sendProjectChatMessage,
  startProjectConversation,
  type AppliedProjectBreakdownDto,
  type DomainDto,
  type MilestoneDto,
  type ProjectChatMessageDto,
  type ProjectConversationDto,
  type ProjectDraftDto,
  type ProjectDraftMilestoneDto,
  type ProjectDto,
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

/* ---------- editable draft model ---------- */

interface EditableTask {
  /** Key của bản nháp gốc — cần giữ để BE lấy đúng `AiEstimatedMinutes`. */
  key: string | null;
  title: string;
  domain_id: string;
  estimated_minutes: number;
}

interface EditableMilestone {
  key: string | null;
  title: string;
  deadline: string;
  tasks: EditableTask[];
}

function draftToEditable(d: ProjectDraftDto): EditableMilestone[] {
  return d.milestones.map((m: ProjectDraftMilestoneDto) => ({
    key: m.key ?? null,
    title: m.title,
    deadline: m.deadline,
    tasks: m.tasks.map((t) => ({
      key: t.key ?? null,
      title: t.title,
      domain_id: t.domain.id,
      estimated_minutes: t.estimated_minutes,
    })),
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

  const [domains, setDomains] = useState<DomainDto[]>([]);
  const [existingMilestones, setExistingMilestones] = useState<MilestoneDto[]>([]);

  const [composer, setComposer] = useState("");
  const [isTyping, setIsTyping] = useState(false);
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
      setApplied(chat.applied);
      setEditable(chat.latest_draft ? draftToEditable(chat.latest_draft) : []);
      setAppliedResult(null);
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

  /* ---------- gửi tin (brief) ---------- */
  async function handleSend() {
    const raw = composer.trim();
    if (!raw || !conversation) return;
    if (sendingRef.current) return;
    sendingRef.current = true;
    setSending(true);
    setError(null);
    setComposer("");
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

    const res = await sendProjectChatMessage(conversation.conversation_id, raw);
    sendingRef.current = false;
    setSending(false);
    setIsTyping(false);

    if (!res.ok) {
      setError(res.error);
      // Trả lại nội dung để user không mất ý định.
      setComposer(raw);
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
    }
  }

  /* ---------- Apply ---------- */
  async function handleApply() {
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
        editable,
      );
      if (!res.ok) {
        setError(res.error);
        return;
      }
      setApplied(true);
      setAppliedResult(res.data);
      setConversation((c) => (c ? { ...c, status: "applied" } : c));
      const created =
        res.data.milestones.reduce((n, m) => n + m.tasks.length, 0) || 0;
      toast.success(
        `Đã tạo ${res.data.milestones.length} milestone và ${created} task`,
        res.data.skipped.length
          ? `${res.data.skipped.length} task bị bỏ qua (trùng việc đã có)`
          : undefined,
      );
      // Refresh milestone đang có để user thấy kết quả ngay.
      if (projectId) {
        void listMilestones(projectId).then((r) => {
          if (r.ok) setExistingMilestones(r.data ?? []);
        });
      }
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
                <Message key={m.id} msg={m} />
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
                <button
                  type="button"
                  className="pac-btn pac-btn--primary"
                  onClick={() => void handleSend()}
                  disabled={
                    !conversation ||
                    !composer.trim() ||
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

                  {/* Actions */}
                  <div className="pac-actions">
                    <button
                      type="button"
                      className="pac-btn pac-btn--primary"
                      onClick={() => void handleApply()}
                      disabled={applying || applied || totalTasks === 0}
                    >
                      <span className="material-symbols-outlined">
                        {applied ? "check_circle" : "auto_awesome"}
                      </span>
                      <span>
                        {applied
                          ? "Đã áp dụng"
                          : `Apply ${editable.length} milestone · ${totalTasks} task`}
                      </span>
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
                  {appliedResult.milestones.map((m) => (
                    <div className="pac-result-ms" key={m.id}>
                      <div className="pac-result-ms-title">{m.title}</div>
                      <div className="pac-result-ms-deadline">
                        {fmtDate(m.deadline)}
                      </div>
                      <ul className="pac-result-tasks">
                        {m.tasks.map((t) => (
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
                  {appliedResult.skipped.length > 0 && (
                    <div className="pac-result-skipped">
                      <div className="pac-result-skipped-head">
                        <span className="material-symbols-outlined">content_copy</span>
                        <span>Bị bỏ qua ({appliedResult.skipped.length})</span>
                      </div>
                      <ul className="pac-reminders-list">
                        {appliedResult.skipped.map((s, i) => (
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

function Message({ msg }: { msg: ProjectChatMessageDto }) {
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
        {msg.content && <div className="pac-bubble pac-bubble--ai">{msg.content}</div>}
        {msg.kind === "question" && (
          <span className="pac-verified">
            <span className="material-symbols-outlined pac-verified-icon">help</span>
            AI đang hỏi lại — trả lời để có bản nháp
          </span>
        )}
      </div>
    </div>
  );
}
