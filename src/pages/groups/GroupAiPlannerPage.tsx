/**
 * ===========================================================
 * Group AI Planner — trang riêng cho Chat AI của nhóm
 * ===========================================================
 * Route: /groups/:groupId/ai
 *
 * Layout 3 cột (giống Project AI Chat — `/projects/:id/execution`):
 *
 *   ┌──────────────┬──────────────────────┬───────────────────┐
 *   │ LỊCH SỬ CHAT │      KHUNG CHAT       │   BẢN NHÁP PLAN  │
 *   │  (trái)      │       (giữa)         │      (phải)      │
 *   └──────────────┴──────────────────────┴───────────────────┘
 *
 * ⚠️ Vì sao tách ra trang riêng:
 * - Trong tab "Chat AI" cũ (GroupDetail), thẻ bản nháp nằm **trong** khung
 *   chat → dài → Leader phải cuộn mới thấy, dễ tưởng "AI không ra plan".
 * - Ở đây bản nháp nằm cột phải, **luôn hiện** ngay cạnh khung chat.
 *
 * API (AI service — `VITE_AI_API_URL`), xem `GROUP_AI_FE.md` mục 2:
 *   GET  /groups/{groupId}/chats
 *   POST /groups/{groupId}/chats
 *   GET  /groups/chats/{chatId}
 *   POST /groups/chats/{chatId}/messages
 *   POST /groups/chats/{chatId}/messages/{messageId}/applied
 *
 * Áp dụng bản nháp → gọi **Backend** (`group-api.ts`) tạo giai đoạn / việc /
 * việc con. AI không ghi vào bảng nhóm.
 *
 * Scope class prefix: `.gai-*` (dùng chung với `group-ai.css`).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { CenterToasts, useCenterToast } from "../../components/Toast";
import {
  createGroupChat,
  getGroupChat,
  listGroupChats,
  markGroupDraftApplied,
  sendGroupChatMessage,
  type GroupChatMessageDto,
  type GroupChatMode,
  type GroupConversationDto,
} from "../../lib/group-ai-api";
import {
  createGroupMilestone,
  createGroupSubTask,
  createGroupTask,
  getGroup,
  listGroupMembers,
  listGroupMilestones,
  parseAssigneeBusyDetails,
  type GroupDto,
  type GroupMemberDto,
  type GroupMilestoneDto,
} from "../../lib/group-api";
import { toGroupAiErrorView, type GroupAiErrorView } from "./group-ai-errors";
import {
  buildApplyPlans,
  findLatestDraft,
  findPlanWithoutDraft,
  isReadyToPlan,
  toEditableDraft,
  toVietnamDeadline,
  validateDraft,
  type EditableDraft,
  type EditableMilestone,
  type EditableTask,
} from "./group-ai-logic";
import {
  GroupDraftPanel,
  GroupChatThread,
  type GroupDraftPanelHandle,
} from "./group-ai-parts";
import "./group-ai.css";
import "./group-ai-planner.css";
import "./group-ai-planner-extra.css";

/** Độ dài tối đa 1 tin nhắn (AI service trả 422 nếu vượt). */
const MAX_MESSAGE_LENGTH = 4000;

export function GroupAiPlannerPage() {
  const { groupId = "" } = useParams();
  const [toasts, toast] = useCenterToast();

  /* ---------- Dữ liệu nhóm ---------- */
  const [group, setGroup] = useState<GroupDto | null>(null);
  const [members, setMembers] = useState<GroupMemberDto[]>([]);
  const [groupError, setGroupError] = useState<string | null>(null);
  const [loadingGroup, setLoadingGroup] = useState(true);

  /* ---------- Chat ---------- */
  const [chats, setChats] = useState<GroupConversationDto[]>([]);
  const [activeChatId, setActiveChatId] = useState<string | null>(null);
  const [messages, setMessages] = useState<GroupChatMessageDto[]>([]);
  const [loadingChats, setLoadingChats] = useState(true);
  const [loadingChat, setLoadingChat] = useState(false);

  /* ---------- Gửi tin ---------- */
  const [draftText, setDraftText] = useState("");
  const [sending, setSending] = useState(false);
  const [thinking, setThinking] = useState(false);

  /* ---------- Bản nháp ---------- */
  const [draftOverride, setDraftOverride] = useState<EditableDraft | null>(null);
  const [applying, setApplying] = useState(false);
  const [applyError, setApplyError] = useState<string | null>(null);
  const [busyConflict, setBusyConflict] = useState<{
    taskKey: string;
    milestoneKey: string;
    title: string;
    assigneeId: string | null;
  } | null>(null);
  /** Id giai đoạn / việc đã tạo → "Thử lại phần còn lại" không tạo trùng. */
  const [createdMilestoneIds, setCreatedMilestoneIds] = useState<
    Record<string, string>
  >({});
  const [createdTaskIds, setCreatedTaskIds] = useState<Record<string, string>>(
    {},
  );

  /* ---------- Lỗi ---------- */
  const [errorView, setErrorView] = useState<GroupAiErrorView | null>(null);
  const [errorRaw, setErrorRaw] = useState("");
  /** Thao tác thử lại cho lỗi tạm thời (502/503/429). */
  const [retryAction, setRetryAction] = useState<(() => void) | null>(null);

  const bodyRef = useRef<HTMLDivElement | null>(null);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const sendRef = useRef<((mode: GroupChatMode) => Promise<void>) | null>(null);
  const applyRef = useRef<
    ((confirmConflicts?: boolean) => Promise<void>) | null
  >(null);
  const loadChatRef = useRef<((chatId: string) => Promise<void>) | null>(null);
  /** Handle của cột phải — để cuộn tới bản nháp khi nó vừa xuất hiện. */
  const panelRef = useRef<GroupDraftPanelHandle | null>(null);

  /* ===========================================================
   * Báo lỗi
   * =========================================================== */

  const reportError = useCallback(
    (
      res: { ok: false; error: string; status?: number; errorCode?: string },
      retry?: () => void,
    ) => {
      const view = toGroupAiErrorView(res);
      setErrorView(view);
      setErrorRaw(res.error);
      if (view.showRetry && retry) setRetryAction(() => retry);
    },
    [],
  );

  /* ===========================================================
   * Nhóm
   * =========================================================== */

  const loadGroup = useCallback(async () => {
    if (!groupId) return;
    const [gRes, mRes] = await Promise.all([
      getGroup(groupId),
      listGroupMembers(groupId),
    ]);
    setLoadingGroup(false);
    if (!gRes.ok) {
      setGroupError(gRes.error);
      return;
    }
    setGroupError(null);
    setGroup(gRes.data);
    setMembers(mRes.ok ? (mRes.data ?? []) : []);
  }, [groupId]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadGroup();
  }, [loadGroup]);

  /* ===========================================================
   * Chat
   * =========================================================== */

  const loadChats = useCallback(async () => {
    if (!groupId) return;
    setLoadingChats(true);
    const res = await listGroupChats(groupId);
    setLoadingChats(false);
    if (!res.ok) {
      reportError(res);
      return;
    }
    setChats(res.data);
    setActiveChatId((prev) => prev ?? res.data[0]?.conversation_id ?? null);
  }, [groupId, reportError]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadChats();
  }, [loadChats]);

  const loadChat = useCallback(
    async (chatId: string) => {
      setLoadingChat(true);
      const res = await getGroupChat(chatId);
      setLoadingChat(false);
      if (!res.ok) {
        reportError(res, () => void loadChatRef.current?.(chatId));
        return;
      }
      /*
       * Sắp xếp theo `created_at` tăng dần (cũ → mới).
       *
       * ⚠️ `findLatestDraft` quét **từ cuối mảng** → thứ tự mảng PHẢI là
       * thứ tự thời gian, nếu không bản nháp mới nhất bị đẩy lên đầu.
       */
      const loaded = [...(res.data.messages ?? [])].sort((a, b) => {
        const ta = Date.parse(a.created_at ?? "");
        const tb = Date.parse(b.created_at ?? "");
        if (Number.isNaN(ta) || Number.isNaN(tb)) return 0;
        return ta - tb;
      });
      setMessages(loaded);
      setCreatedMilestoneIds({});
      setCreatedTaskIds({});
      setApplyError(null);
      setDraftOverride(null);
    },
    [reportError],
  );

  useEffect(() => {
    loadChatRef.current = loadChat;
  }, [loadChat]);

  useEffect(() => {
    if (!activeChatId) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadChat(activeChatId);
  }, [activeChatId, loadChat]);

  /* ===========================================================
   * Bản nháp (derived + override)
   * =========================================================== */

  const latest = useMemo(() => findLatestDraft(messages), [messages]);

  const derivedDraft = useMemo<EditableDraft | null>(() => {
    if (!latest) return null;
    return toEditableDraft(
      latest.draft,
      latest.message.is_applied === true,
      latest.message.message_id,
    );
  }, [latest]);

  const editableDraft = useMemo<EditableDraft | null>(() => {
    if (!derivedDraft) return null;
    if (draftOverride && draftOverride.messageId === derivedDraft.messageId) {
      return draftOverride;
    }
    return derivedDraft;
  }, [derivedDraft, draftOverride]);

  const readyToPlan = useMemo(() => isReadyToPlan(messages), [messages]);

  /**
   * Brief gốc Leader đã gửi (tin `user` đầu tiên có nội dung).
   *
   * Dùng làm ngữ cảnh khi yêu cầu AI sinh kế hoạch: `mode: "plan"` với
   * `text: ""` đôi khi không đủ để AI service dựng lại cấu trúc → gửi kèm
   * brief giúp AI có đủ ngữ cảnh để dựng milestone / task / subtask.
   */
  const originalBrief = useMemo(() => {
    const userMsg = messages.find((m) => m.role === "user" && m.content?.trim());
    return userMsg?.content?.trim() ?? "";
  }, [messages]);

  /** AI trả về nhưng KHÔNG sinh được bản nháp → cảnh báo + nút thử lại. */
  const planWithoutDraft = useMemo(() => {
    if (editableDraft && editableDraft.milestones.length > 0) return null;
    return findPlanWithoutDraft(messages);
  }, [messages, editableDraft]);

  /* ===========================================================
   * Cuộn
   * =========================================================== */

  useEffect(() => {
    const el = bodyRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, thinking, editableDraft]);

  /* ===========================================================
   * Tạo chat mới
   * =========================================================== */

  const handleNewChat = useCallback(async () => {
    if (!groupId) return;
    const res = await createGroupChat(groupId);
    if (!res.ok) {
      reportError(res);
      return;
    }
    setChats((prev) => [res.data, ...prev]);
    setActiveChatId(res.data.conversation_id);
    setMessages([]);
    setDraftText("");
    setCreatedMilestoneIds({});
    setCreatedTaskIds({});
    setApplyError(null);
    setDraftOverride(null);
    window.setTimeout(() => composerRef.current?.focus(), 40);
  }, [groupId, reportError]);

  /* ===========================================================
   * Gửi tin
   * =========================================================== */

  const handleSend = useCallback(
    async (mode: GroupChatMode) => {
      if (!activeChatId || sending) return;
      let text = draftText.trim();

      if (mode === "discuss" && !text) return;
      if (text.length > MAX_MESSAGE_LENGTH) {
        setApplyError(
          "Your message is too long. Please keep it under 4000 characters.",
        );
        return;
      }

      /*
       * `mode: "plan"` mà Leader KHÔNG gõ thêm gì → gửi kèm **brief gốc**.
       *
       * ⚠️ Vì sao: `text: ""` đúng theo spec, nhưng AI service đôi khi chỉ
       * trả về prose ("I have created a structured work plan...") mà KHÔNG
       * kèm `draft` → không có gì để sửa / áp dụng. Gửi kèm brief giúp AI
       * service có đủ ngữ cảnh để dựng milestone / task / subtask.
       */
      if (mode === "plan" && !text) {
        const brief = originalBrief.slice(0, MAX_MESSAGE_LENGTH);
        if (brief) text = brief;
      }

      setSending(true);
      setThinking(true);
      setApplyError(null);

      const res = await sendGroupChatMessage(activeChatId, { text, mode });
      setSending(false);
      setThinking(false);

      if (!res.ok) {
        reportError(res, () => void sendRef.current?.(mode));
        return;
      }

      /*
       * Nối tin mới vào danh sách — nhưng BỎ QUA tin đã có (trùng id) để
       * không render trùng thẻ bản nháp.
       */
      setMessages((prev) => {
        const incoming = [res.data.user_message, res.data.ai_message];
        const incomingIds = new Set(incoming.map((m) => m.message_id));
        const kept = prev.filter((m) => !incomingIds.has(m.message_id));
        return [...kept, ...incoming];
      });
      if (mode === "plan") setDraftText("");
    },
    [activeChatId, draftText, originalBrief, sending, reportError],
  );

  useEffect(() => {
    sendRef.current = handleSend;
  }, [handleSend]);

  /**
   * Bấm "Generate plan again" — yêu cầu AI sinh lại kế hoạch.
   *
   * ⚠️ Gửi kèm **brief gốc** (nếu có) thay vì `text: ""`:
   * - `text: ""` → AI service đôi khi chỉ trả prose mà KHÔNG kèm `draft`.
   * - Kèm brief → AI có đủ ngữ cảnh để dựng milestone/task/subtask.
   */
  const handleRegeneratePlan = useCallback(async () => {
    if (!activeChatId || sending) return;
    const brief = originalBrief.slice(0, MAX_MESSAGE_LENGTH);

    setSending(true);
    setThinking(true);
    setApplyError(null);

    const res = await sendGroupChatMessage(activeChatId, {
      text: brief,
      mode: "plan",
    });

    setSending(false);
    setThinking(false);

    if (!res.ok) {
      reportError(res, () => void sendRef.current?.("plan"));
      return;
    }

    setMessages((prev) => {
      const incoming = [res.data.user_message, res.data.ai_message];
      const incomingIds = new Set(incoming.map((m) => m.message_id));
      const kept = prev.filter((m) => !incomingIds.has(m.message_id));
      return [...kept, ...incoming];
    });
    setDraftText("");
  }, [activeChatId, originalBrief, sending, reportError]);

  /* ===========================================================
   * Sửa bản nháp
   * =========================================================== */

  const patchMilestone = useCallback(
    (msKey: string, patch: Partial<EditableMilestone>) => {
      setDraftOverride((prev) => {
        const base = prev ?? derivedDraft;
        if (!base) return prev;
        return {
          ...base,
          milestones: base.milestones.map((m) =>
            m.key === msKey ? { ...m, ...patch } : m,
          ),
        };
      });
    },
    [derivedDraft],
  );

  const patchTask = useCallback(
    (msKey: string, taskKey: string, patch: Partial<EditableTask>) => {
      setDraftOverride((prev) => {
        const base = prev ?? derivedDraft;
        if (!base) return prev;
        return {
          ...base,
          milestones: base.milestones.map((m) =>
            m.key !== msKey
              ? m
              : {
                  ...m,
                  tasks: m.tasks.map((t) =>
                    t.key === taskKey ? { ...t, ...patch } : t,
                  ),
                },
          ),
        };
      });
    },
    [derivedDraft],
  );

  /** Khôi phục bản gốc của AI (bỏ các sửa tay). */
  const restoreDraft = useCallback(() => {
    setDraftOverride(null);
  }, []);

  /* ===========================================================
   * Áp dụng bản nháp → Backend
   * =========================================================== */

  const handleApply = useCallback(
    async (confirmConflicts = false) => {
      if (!editableDraft || !activeChatId || applying) return;

      const problems = validateDraft(editableDraft);
      if (problems.length > 0) {
        setApplyError(problems[0]);
        return;
      }

      setApplying(true);
      setApplyError(null);

      /* 1. orderIndex tiếp theo cho milestone. */
      const msRes = await listGroupMilestones(groupId);
      let nextOrder = 1;
      if (msRes.ok) {
        const max = msRes.data.reduce(
          (acc, m: GroupMilestoneDto) => Math.max(acc, m.orderIndex ?? 0),
          0,
        );
        nextOrder = max + 1;
      }

      const { milestones, tasks } = buildApplyPlans(editableDraft);

      /* Bản ghi các mục đã tạo — để "Thử lại phần còn lại" không tạo trùng. */
      const createdMilestones: Record<string, string> = {
        ...createdMilestoneIds,
      };
      const createdTasks: Record<string, string> = { ...createdTaskIds };

      /* 2. Tạo giai đoạn + việc + việc con — TUẦN TỰ (không song song). */
      for (const ms of milestones) {
        if (ms.tasks.length === 0) continue;

        /* --- Giai đoạn --- */
        let milestoneId = createdMilestones[ms.key];
        if (!milestoneId) {
          const msCreate = await createGroupMilestone(groupId, {
            name: ms.title.trim(),
            orderIndex: nextOrder++,
            /* `dueDate` là DateTime? — không có hạn thì gửi `null`, KHÔNG gửi
               chuỗi rỗng (Backend parse `YYYY-MM-DD` sẽ lỗi 400). */
            dueDate: ms.deadline ? ms.deadline : null,
          });
          if (!msCreate.ok) {
            setApplying(false);
            setCreatedMilestoneIds(createdMilestones);
            setCreatedTaskIds(createdTasks);
            reportError(msCreate, () => void applyRef.current?.(confirmConflicts));
            return;
          }
          milestoneId = msCreate.data.id;
          createdMilestones[ms.key] = milestoneId;
        }

        /* --- Việc của giai đoạn --- */
        for (const task of tasks.filter((t) => t.milestoneKey === ms.key)) {
          const already = createdTasks[task.key];
          if (already) continue; // đã tạo ở lần trước → bỏ qua

          const taskCreate = await createGroupTask(groupId, {
            title: task.title,
            milestoneId,
            estimatedMinutes: task.estimatedMinutes,
            /* Deadline của việc = 23:59 giờ Việt Nam của ngày hết hạn
               giai đoạn (spec mục 2.6 bước 3). Không có hạn → `null`. */
            deadline: ms.deadline ? toVietnamDeadline(ms.deadline) : null,
            assigneeId: task.assigneeId,
            confirmConflicts: confirmConflicts || undefined,
          });

          if (!taskCreate.ok) {
            setApplying(false);
            setCreatedMilestoneIds(createdMilestones);
            setCreatedTaskIds(createdTasks);
            /*
             * 409 GROUP_ASSIGNEE_BUSY → Leader xác nhận rồi gửi lại kèm
             * `confirmConflicts: true` (spec mục 2.6).
             */
            if (taskCreate.status === 409) {
              const details = parseAssigneeBusyDetails(taskCreate.details);
              if (details) {
                setBusyConflict({
                  taskKey: task.key,
                  milestoneKey: ms.key,
                  title: task.title,
                  assigneeId: task.assigneeId,
                });
                setApplyError(
                  `"${task.title}" was not created because the assignee is busy at that time. Confirm to assign it anyway.`,
                );
                return;
              }
            }
            reportError(taskCreate, () =>
              void applyRef.current?.(confirmConflicts),
            );
            return;
          }

          const taskId = taskCreate.data.id;

          /* --- Việc con --- */
          for (const st of task.subtasks) {
            const stRes = await createGroupSubTask(taskId, {
              title: st.title,
              estimatedMinutes: st.estimatedMinutes,
            });
            /* Việc con lỗi không chặn — báo nhưng vẫn tiếp tục tạo việc còn lại. */
            if (!stRes.ok) {
              setApplyError(
                `Could not add the subtask "${st.title}". You can add it manually from the task.`,
              );
            }
          }

          createdTasks[task.key] = taskId;
        }
      }

      /* 3. Đánh dấu đã áp dụng → khóa nút. */
      const appliedRes = await markGroupDraftApplied(
        activeChatId,
        editableDraft.messageId,
      );
      setApplying(false);
      setCreatedMilestoneIds(createdMilestones);
      setCreatedTaskIds(createdTasks);
      setBusyConflict(null);
      setApplyError(null);

      if (!appliedRes.ok && appliedRes.status === 409) {
        /* 409 already_applied → đã áp dụng ở tab khác → khóa nút. */
        setDraftOverride((prev) => {
          const base = prev ?? editableDraft;
          return base ? { ...base, applied: true } : prev;
        });
        return;
      }

      if (!appliedRes.ok) {
        reportError(appliedRes, () =>
          void applyRef.current?.(confirmConflicts),
        );
        return;
      }

      setDraftOverride((prev) => {
        const base = prev ?? editableDraft;
        return base ? { ...base, applied: true } : prev;
      });
      toast.success(
        "Plan applied to the group",
        `${milestones.length} milestones and ${tasks.length} tasks created.`,
      );
    },
    [
      editableDraft,
      activeChatId,
      groupId,
      applying,
      createdMilestoneIds,
      createdTaskIds,
      reportError,
      toast,
    ],
  );

  useEffect(() => {
    applyRef.current = handleApply;
  }, [handleApply]);

  /* ===========================================================
   * Render
   * =========================================================== */

  const activeChat = useMemo(
    () => chats.find((c) => c.conversation_id === activeChatId) ?? null,
    [chats, activeChatId],
  );

  /** Thành viên có thể được giao việc (Leader / Member, không Viewer). */
  const assignable = useMemo(
    () =>
      members.filter((m) => {
        const role = (m.role ?? "").toLowerCase();
        return role === "leader" || role === "member";
      }),
    [members],
  );

  const isLeader = (group?.myRole ?? "").toLowerCase() === "leader";
  const archived = group?.status === "Archived";

  if (loadingGroup) {
    return (
      <div className="gai-page-state">
        <span className="material-symbols-outlined gai-spin">progress_activity</span>
        <span>Loading group…</span>
      </div>
    );
  }

  if (groupError || !group) {
    return (
      <div className="gai-page-state gai-page-state--error">
        <span className="material-symbols-outlined">error</span>
        <span>{groupError ?? "Group not found."}</span>
        <Link to="/groups" className="gai-btn gai-btn--ghost">
          Back to groups
        </Link>
      </div>
    );
  }

  if (!isLeader) {
    return (
      <div className="gai-page-state">
        <span className="material-symbols-outlined">lock</span>
        <span>
          Only group leaders can plan work with AI. Ask a leader to start a
          planning chat for this group.
        </span>
      </div>
    );
  }

  return (
    <div className="gai-planner">
      {/* ============ Sub-header ============ */}
      <div className="gai-planner-subbar">
        <div className="gai-planner-subbar-inner">
          <div className="gai-planner-breadcrumb">
            <Link to="/groups" className="gai-planner-crumb">
              Groups
            </Link>
            <span className="material-symbols-outlined gai-planner-crumb-sep">
              chevron_right
            </span>
            <Link
              to={`/groups/${groupId}`}
              className="gai-planner-crumb"
            >
              {group.name}
            </Link>
            <span className="material-symbols-outlined gai-planner-crumb-sep">
              chevron_right
            </span>
            <span className="gai-planner-crumb-current">AI Plan</span>
          </div>
          <div className="gai-planner-subbar-right">
            <Link
              to={`/groups/${groupId}`}
              className="gai-btn gai-btn--ghost gai-btn--sm"
            >
              <span className="material-symbols-outlined" aria-hidden="true">
                arrow_back
              </span>
              Group
            </Link>
          </div>
        </div>
      </div>

      <div className="gai-planner-container">
        <div className="gai-planner-grid">
          {/* ============ TRÁI: lịch sử chat ============ */}
          <aside className="gai-planner-history">
            <div className="gai-planner-history-head">
              <h3 className="gai-planner-history-title">Planning chats</h3>
              <button
                type="button"
                className="gai-btn gai-btn--primary gai-btn--sm"
                onClick={() => void handleNewChat()}
                disabled={archived}
              >
                <span className="material-symbols-outlined" aria-hidden="true">
                  add
                </span>
                New
              </button>
            </div>
            <div className="gai-planner-history-items">
              {loadingChats && (
                <p className="gai-planner-history-empty">
                  <span className="material-symbols-outlined gai-spin">
                    progress_activity
                  </span>{" "}
                  Loading chats…
                </p>
              )}
              {!loadingChats && chats.length === 0 && (
                <p className="gai-planner-history-empty">
                  No planning chats yet. Create one to turn a client brief into
                  a milestone plan.
                </p>
              )}
              {!loadingChats &&
                chats.map((c) => (
                  <button
                    key={c.conversation_id}
                    type="button"
                    className={
                      "gai-planner-history-item" +
                      (c.conversation_id === activeChatId
                        ? " gai-planner-history-item--on"
                        : "")
                    }
                    onClick={() => setActiveChatId(c.conversation_id)}
                  >
                    <span className="gai-planner-history-item-name">
                      {c.title || "Group planning"}
                    </span>
                    <span className="gai-planner-history-item-meta">
                      {new Date(c.created_at).toLocaleDateString(undefined, {
                        day: "numeric",
                        month: "short",
                      })}
                      {c.status === "applied" && (
                        <span className="gai-planner-history-item-status">
                          applied
                        </span>
                      )}
                    </span>
                  </button>
                ))}
            </div>
          </aside>

          {/* ============ GIỮA: khung chat ============ */}
          <section className="gai-planner-stream">
            <div className="gai-planner-stream-head">
              <div className="gai-planner-stream-title">
                <span
                  className="material-symbols-outlined gai-planner-stream-avatar"
                  aria-hidden="true"
                >
                  auto_awesome
                </span>
                <div>
                  <h1 className="gai-planner-stream-h1">
                    Group AI Planner
                    {activeChat?.title && (
                      <span className="gai-planner-stream-chat-title">
                        {activeChat.title}
                      </span>
                    )}
                  </h1>
                  <p className="gai-planner-stream-sub">
                    Paste the client brief → AI drafts milestones and tasks →
                    review on the right, then apply
                  </p>
                </div>
              </div>
              <div className="gai-planner-stream-tags">
                <span className="gai-planner-tag">
                  <span className="material-symbols-outlined" aria-hidden="true">
                    groups
                  </span>
                  {members.length} members
                </span>
                <span className="gai-planner-tag">
                  <span className="material-symbols-outlined" aria-hidden="true">
                    bolt
                  </span>
                  {messages.length} msgs
                </span>
              </div>
            </div>

            {errorView && (
              <div className="gai-planner-banner gai-planner-banner--error" role="alert">
                <span className="material-symbols-outlined" aria-hidden="true">
                  error
                </span>
                <div className="gai-planner-banner-body">
                  <strong>{errorView.title}</strong>
                  <span>{errorView.message}</span>
                  {errorRaw && (
                    <span className="gai-planner-banner-raw">{errorRaw}</span>
                  )}
                </div>
                {retryAction && (
                  <button
                    type="button"
                    className="gai-btn gai-btn--ghost gai-btn--sm"
                    onClick={() => {
                      const fn = retryAction;
                      setRetryAction(null);
                      fn();
                    }}
                  >
                    <span className="material-symbols-outlined" aria-hidden="true">
                      refresh
                    </span>
                    Try again
                  </button>
                )}
              </div>
            )}

            <GroupChatThread
              messages={messages}
              members={members}
              loading={loadingChat}
              thinking={thinking}
              planWithoutDraft={planWithoutDraft}
              hasDraft={!!editableDraft}
              onRegenerate={() => void handleRegeneratePlan()}
              bodyRef={bodyRef}
            />

            {/* ---------- Ô nhập ---------- */}
            <div className="gai-planner-composer">
              <textarea
                ref={composerRef}
                className="gai-planner-input"
                value={draftText}
                onChange={(e) => setDraftText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                    e.preventDefault();
                    void handleSend("discuss");
                  }
                }}
                placeholder="Paste the client brief, or ask the AI a question…"
                maxLength={MAX_MESSAGE_LENGTH + 200}
                disabled={sending || archived}
                aria-label="Message the AI"
              />
              <div className="gai-planner-composer-foot">
                <span>
                  {draftText.length}/{MAX_MESSAGE_LENGTH}
                </span>
              </div>
              <div className="gai-planner-composer-actions">
                <button
                  type="button"
                  className="gai-btn gai-btn--primary"
                  onClick={() => void handleSend("discuss")}
                  disabled={sending || archived || !draftText.trim()}
                >
                  <span className="material-symbols-outlined" aria-hidden="true">
                    send
                  </span>
                  Send
                </button>
                <button
                  type="button"
                  className={
                    "gai-btn gai-btn--ghost" +
                    (readyToPlan ? " gai-plan-btn" : "")
                  }
                  onClick={() => void handleSend("plan")}
                  disabled={sending || archived}
                  title={
                    readyToPlan
                      ? "AI has enough detail to draft a plan"
                      : "Ask the AI to draft a milestone plan"
                  }
                >
                  <span className="material-symbols-outlined" aria-hidden="true">
                    account_tree
                  </span>
                  {editableDraft ? "Update plan" : "Draft plan"}
                </button>
              </div>
            </div>
          </section>

          {/* ============ PHẢI: bản nháp plan ============ */}
          <aside className="gai-planner-side">
            <GroupDraftPanel
              ref={panelRef}
              draft={editableDraft}
              assignable={assignable}
              applying={applying}
              error={applyError}
              busyConflict={busyConflict}
              onPatchMilestone={patchMilestone}
              onPatchTask={patchTask}
              onRestore={restoreDraft}
              onApply={() => void handleApply()}
              onConfirmConflicts={() => void handleApply(true)}
              onDismissConflict={() => {
                setBusyConflict(null);
                setApplyError(null);
              }}
            />

            {/* Ngữ cảnh nhóm */}
            <div className="gai-planner-card">
              <div className="gai-planner-card-head">
                <span
                  className="material-symbols-outlined gai-planner-card-icon"
                  aria-hidden="true"
                >
                  info
                </span>
                <h2 className="gai-planner-card-title">Group context</h2>
              </div>
              <ul className="gai-planner-context-list">
                <li>
                  <strong>Group:</strong> {group.name} ·{" "}
                  {members.length} members
                </li>
                <li>
                  <strong>Apply</strong> creates milestones, tasks and subtasks
                  in the group — AI never writes to the group tables.
                </li>
                <li>
                  <strong>Each chat</strong> can be applied once. Start a new
                  chat to plan more work.
                </li>
              </ul>
            </div>
          </aside>
        </div>
      </div>

      <CenterToasts toasts={toasts} onDismiss={toast.dismiss} />
    </div>
  );
}
