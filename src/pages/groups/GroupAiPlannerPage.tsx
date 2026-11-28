/**
 * ===========================================================
 * Group Lập kế hoạch với AIner — trang riêng cho Chat AI của nhóm
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
  listGroupTasks,
  parseAssigneeBusyDetails,
  type GroupDto,
  type GroupMemberDto,
  type GroupMilestoneDto,
} from "../../lib/group-api";
import { toGroupAiErrorView, type GroupAiErrorView } from "./group-ai-errors";
import {
  buildApplyPlans,
  findLatestDraft,
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

type ApplyProgress = {
  draft: EditableDraft;
  milestones: Record<string, string>;
  tasks: Record<string, string>;
  subtasks: Record<string, number>;
};

export function GroupAiPlannerPage() {
  const { groupId = "" } = useParams();
  const [toasts, toast] = useCenterToast();

  /* ---------- Dữ liệu nhóm ---------- */
  const [group, setGroup] = useState<GroupDto | null>(null);
  const [members, setMembers] = useState<GroupMemberDto[]>([]);
  const [groupError, setGroupError] = useState<string | null>(null);
  const [loadingGroup, setLoadingGroup] = useState(true);
  const [groupMilestones, setGroupMilestones] = useState<GroupMilestoneDto[]>([]);
  const [groupTaskCount, setGroupTaskCount] = useState<number | null>(null);

  /* ---------- Chat ---------- */
  const [chats, setChats] = useState<GroupConversationDto[]>([]);
  const [activeChatId, setActiveChatId] = useState<string | null>(null);
  const [messages, setMessages] = useState<GroupChatMessageDto[]>([]);
  const [loadingChats, setLoadingChats] = useState(true);
  const [loadingChat, setLoadingChat] = useState(false);

  /* ---------- Gửi tin ---------- */
  const [draftText, setDraftText] = useState("");
  const [sending, setSending] = useState(false);
  const [emptyPlan, setEmptyPlan] = useState(false);
  const [thinking, setThinking] = useState(false);
  const chatBusy = useRef(false);
  const creatingChat = useRef(false);
  const [creating, setCreating] = useState(false);

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
  const [progress, setProgress] = useState<ApplyProgress | null>(null);
  const applyingRef = useRef(false);

  /* ---------- Lỗi ---------- */
  const [errorView, setErrorView] = useState<GroupAiErrorView | null>(null);
  /** Thao tác thử lại cho lỗi tạm thời (502/503/429). */
  const [retryAction, setRetryAction] = useState<(() => void) | null>(null);

  const bodyRef = useRef<HTMLDivElement | null>(null);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const sendRef = useRef<((mode: GroupChatMode) => Promise<void>) | null>(null);
  const skipChatLoad = useRef<string | null>(null);
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
      setRetryAction(view.showRetry && retry ? () => retry : null);
    },
    [],
  );

  /* ===========================================================
   * Nhóm
   * =========================================================== */

  const loadGroup = useCallback(async () => {
    if (!groupId) return;
    const [gRes, mRes, milestoneRes, taskRes] = await Promise.all([
      getGroup(groupId),
      listGroupMembers(groupId),
      listGroupMilestones(groupId),
      listGroupTasks(groupId),
    ]);
    setLoadingGroup(false);
    if (!gRes.ok) {
      setGroupError(gRes.error);
      return;
    }
    setGroupError(null);
    setGroup(gRes.data);
    if (milestoneRes.ok) setGroupMilestones(milestoneRes.data);
    if (taskRes.ok) setGroupTaskCount(taskRes.data.length);
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
      const draft = findLatestDraft(loaded);
      if (draft?.message.is_applied) {
        setChats((prev) => prev.map((chat) =>
          chat.conversation_id === chatId ? { ...chat, status: "applied" } : chat
        ));
      }
      let saved: ApplyProgress | null = null;
      if (draft && !draft.message.is_applied) {
        try {
          const raw = sessionStorage.getItem(`metanoia:group-plan:${chatId}:${draft.message.message_id}`);
          saved = raw ? JSON.parse(raw) as ApplyProgress : null;
        } catch {
          // The chat can still be opened when storage is unavailable.
        }
      }
      setProgress(saved);
      setApplyError(null);
      setEmptyPlan(false);
      setBusyConflict(null);
      setDraftOverride(saved?.draft ?? null);
    },
    [reportError],
  );

  useEffect(() => {
    loadChatRef.current = loadChat;
  }, [loadChat]);

  useEffect(() => {
    if (!activeChatId) return;
    if (skipChatLoad.current === activeChatId) {
      skipChatLoad.current = null;
      return;
    }
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
    if (!groupId || creatingChat.current) return;
    creatingChat.current = true;
    setCreating(true);
    setErrorView(null);
    try {
      const res = await createGroupChat(groupId);
      if (!res.ok) {
        reportError(res);
        return;
      }
      setChats((prev) => [res.data, ...prev]);
      setMessages([]);
      skipChatLoad.current = res.data.conversation_id;
      setActiveChatId(res.data.conversation_id);
      setProgress(null);
      setDraftText("");
      setApplyError(null);
      setEmptyPlan(false);
      setBusyConflict(null);
      setDraftOverride(null);
      window.setTimeout(() => composerRef.current?.focus(), 40);
    } finally {
      creatingChat.current = false;
      setCreating(false);
    }
  }, [groupId, reportError]);

  const handleSend = useCallback(
    async (mode: GroupChatMode) => {
      const text = draftText.trim();
      if (chatBusy.current || creatingChat.current || applyingRef.current || loadingChat || loadingChats) return;
      if (mode === "discuss" && !text) return;
      if (mode === "plan" && (!activeChatId || !originalBrief || editableDraft?.applied || progress)) return;

      chatBusy.current = true;
      setSending(true);
      setThinking(true);
      setErrorView(null);
      setApplyError(null);
      setEmptyPlan(false);
      try {
        let chatId = activeChatId;
        if (!chatId) {
          const created = await createGroupChat(groupId);
          if (!created.ok) {
            reportError(created, () => void sendRef.current?.(mode));
            return;
          }
          chatId = created.data.conversation_id;
          skipChatLoad.current = chatId;
          setChats((prev) => [created.data, ...prev]);
          setActiveChatId(chatId);
        }

        const result = await sendGroupChatMessage(chatId, {
          text: mode === "plan" && !text
            ? "Tạo bản nháp dựa trên brief và các phản hồi đã trao đổi trong cuộc trò chuyện này."
            : text,
          mode,
        });
        if (!result.ok) {
          reportError(result, () => void sendRef.current?.(mode));
          return;
        }

        const { user_message, ai_message } = result.data;
        setMessages((prev) => [...prev, user_message, ai_message]);
        if (mode === "plan") setEmptyPlan(!(ai_message.draft?.milestones.length));
        setDraftText("");
      } finally {
        chatBusy.current = false;
        setSending(false);
        setThinking(false);
      }
    },
    [activeChatId, draftText, editableDraft?.applied, groupId, loadingChat, loadingChats, originalBrief, progress, reportError],
  );

  useEffect(() => {
    sendRef.current = handleSend;
  }, [handleSend]);

  /* ===========================================================
   * Sửa bản nháp
   * =========================================================== */

  const patchMilestone = useCallback(
    (msKey: string, patch: Partial<EditableMilestone>) => {
      setDraftOverride((prev) => {
        const base = prev?.messageId === derivedDraft?.messageId ? prev : derivedDraft;
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
      if (patch.assigneeId !== undefined && busyConflict?.milestoneKey === msKey && busyConflict.taskKey === taskKey) {
        setBusyConflict(null);
      }
      setDraftOverride((prev) => {
        const base = prev?.messageId === derivedDraft?.messageId ? prev : derivedDraft;
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
    [busyConflict, derivedDraft],
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
      if (!editableDraft || editableDraft.applied || !activeChatId || applyingRef.current || chatBusy.current || loadingChat || group?.status === "Archived") return;

      const selectedDraft = {
        ...editableDraft,
        milestones: editableDraft.milestones
          .map((ms) => ({ ...ms, tasks: ms.tasks.filter((task) => task.included !== false) }))
          .filter((ms) => ms.tasks.length),
      };
      const problems = validateDraft(selectedDraft);
      const invalidAssignee = selectedDraft.milestones.flatMap((ms) => ms.tasks).find((task) =>
        task.assigneeId && members.length > 0 && !members.some((member) =>
          member.userId === task.assigneeId && ["leader", "member"].includes(member.role.toLowerCase())
        )
      );
      if (invalidAssignee) {
        setApplyError(`Hãy chọn người khác hoặc để trống người làm cho “${invalidAssignee.title}”.`);
        return;
      }
      if (problems.length) {
        setApplyError(problems[0]);
        return;
      }

      applyingRef.current = true;
      setApplying(true);
      setApplyError(null);
      setErrorView(null);

      const journalKey = `metanoia:group-plan:${activeChatId}:${editableDraft.messageId}`;
      const saved: ApplyProgress = {
        draft: editableDraft,
        milestones: { ...progress?.milestones },
        tasks: { ...progress?.tasks },
        subtasks: { ...progress?.subtasks },
      };
      function remember() {
        setProgress({ ...saved });
        try {
          sessionStorage.setItem(journalKey, JSON.stringify(saved));
        } catch {
          // Keep retry progress in memory when storage is unavailable.
        }
      }

      function fail(res: { ok: false; error: string; status?: number; errorCode?: string }, label: string) {
        setApplyError(label);
        reportError(res);
      }

      try {
        const current = await getGroupChat(activeChatId);
        if (!current.ok) {
          fail(current, "Chưa kiểm tra được trạng thái bản nháp. Hãy thử lưu lại.");
          return;
        }
        const currentDraft = findLatestDraft(current.data.messages);
        if (currentDraft?.message.message_id !== editableDraft.messageId) {
          setApplyError("Bản nháp đã thay đổi. Hãy mở lại cuộc trò chuyện để xem bản mới nhất.");
          return;
        }
        if (currentDraft.message.is_applied || current.data.conversation.status === "applied") {
          setDraftOverride({ ...editableDraft, applied: true });
          setChats((prev) => prev.map((chat) =>
            chat.conversation_id === activeChatId ? { ...chat, status: "applied" } : chat
          ));
          return;
        }

        const msRes = await listGroupMilestones(groupId);
        if (!msRes.ok) {
          fail(msRes, "Chưa tải được cột mốc của nhóm. Hãy thử lưu lại.");
          return;
        }
        let nextOrder = msRes.data.reduce((max, ms) => Math.max(max, ms.orderIndex ?? 0), 0) + 1;
        const { milestones, tasks } = buildApplyPlans(selectedDraft);

        for (const ms of milestones) {
          let milestoneId = saved.milestones[ms.key];
          if (!milestoneId) {
            const result = await createGroupMilestone(groupId, {
              name: ms.title.trim(),
              orderIndex: nextOrder++,
              dueDate: ms.deadline,
            });
            if (!result.ok) {
              fail(result, `Chưa lưu được cột mốc “${ms.title}”.`);
              return;
            }
            milestoneId = result.data.id;
            saved.milestones[ms.key] = milestoneId;
            remember();
          }

          for (const task of tasks.filter((item) => item.milestoneKey === ms.key)) {
            const taskKey = JSON.stringify([ms.key, task.key]);
            let taskId = saved.tasks[taskKey];
            if (!taskId) {
              const result = await createGroupTask(groupId, {
                title: task.title,
                milestoneId,
                estimatedMinutes: task.estimatedMinutes,
                deadline: toVietnamDeadline(ms.deadline),
                assigneeId: task.assigneeId,
                confirmConflicts: confirmConflicts && busyConflict?.taskKey === task.key &&
                  busyConflict.milestoneKey === ms.key ? true : undefined,
              });
              if (!result.ok) {
                if (result.status === 409 && parseAssigneeBusyDetails(result.details)) {
                  setBusyConflict({ taskKey: task.key, milestoneKey: ms.key, title: task.title, assigneeId: task.assigneeId });
                  return;
                }
                fail(result, `Chưa lưu được việc “${task.title}”.`);
                return;
              }
              taskId = result.data.id;
              saved.tasks[taskKey] = taskId;
              setBusyConflict(null);
              remember();
            }

            const alreadySaved = saved.subtasks[taskKey] ?? 0;
            for (const [offset, subtask] of task.subtasks.slice(alreadySaved).entries()) {
              const result = await createGroupSubTask(taskId, {
                title: subtask.title,
                estimatedMinutes: subtask.estimatedMinutes,
              });
              if (!result.ok) {
                fail(result, `Chưa lưu được việc con “${subtask.title}”. Những mục đã lưu sẽ được bỏ qua khi thử lại.`);
                return;
              }
              saved.subtasks[taskKey] = alreadySaved + offset + 1;
              remember();
            }
          }
        }

        const result = await markGroupDraftApplied(activeChatId, editableDraft.messageId);
        if (!result.ok && !(result.status === 409 &&
          (result.errorCode ?? result.error).trim().toLowerCase() === "already_applied")) {
          fail(result, "Các mục đã được tạo. Bấm thử lại để hoàn tất trạng thái lưu.");
          return;
        }

        try {
          sessionStorage.removeItem(journalKey);
        } catch {
          // The server records the applied state.
        }
        setProgress(null);
        setBusyConflict(null);
        setDraftOverride({ ...selectedDraft, applied: true });
        void loadGroup();
        setChats((prev) => prev.map((chat) => chat.conversation_id === activeChatId ? { ...chat, status: "applied" } : chat));
        toast.success("Đã lưu kế hoạch vào nhóm", `${milestones.length} cột mốc và ${tasks.length} việc.`);
      } finally {
        applyingRef.current = false;
        setApplying(false);
      }
    },
    [activeChatId, busyConflict, editableDraft, group?.status, groupId, loadingChat, loadGroup, members, progress, reportError, toast],
  );

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
  const pending = creating || sending || applying || loadingChat || loadingChats;
  const canDraft = !!originalBrief && !editableDraft?.applied && !progress;
  const step = editableDraft?.applied ? 2 : editableDraft?.milestones.length ? 1 : 0;

  if (loadingGroup) {
    return (
      <div className="gai-page-state">
        <span className="material-symbols-outlined gai-spin">progress_activity</span>
        <span>Đang tải nhóm…</span>
      </div>
    );
  }

  if (groupError || !group) {
    return (
      <div className="gai-page-state gai-page-state--error">
        <span className="material-symbols-outlined">error</span>
        <span>{groupError ?? "Không tìm thấy nhóm."}</span>
        <Link to="/groups" className="gai-btn gai-btn--ghost">
          Về danh sách nhóm
        </Link>
      </div>
    );
  }

  if (!isLeader) {
    return (
      <div className="gai-page-state">
        <span className="material-symbols-outlined">lock</span>
        <span>
Trưởng nhóm có thể mở cuộc trò chuyện lập kế hoạch với AI.
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
            <span className="gai-planner-crumb-current">Lập kế hoạch với AI</span>
          </div>
          <div className="gai-planner-subbar-right">
            <Link
              to={`/groups/${groupId}`}
              className="gai-btn gai-btn--ghost gai-btn--sm"
            >
              <span className="material-symbols-outlined" aria-hidden="true">
                arrow_back
              </span>
              Về nhóm
            </Link>
          </div>
        </div>
      </div>

      <div className="gai-planner-container">
        <div className="gai-planner-grid">
          {/* ============ TRÁI: lịch sử chat ============ */}
          <aside className="gai-planner-history">
            <div className="gai-planner-history-head">
              <h3 className="gai-planner-history-title">Cuộc trò chuyện</h3>
              <button
                type="button"
                className="gai-btn gai-btn--primary gai-btn--sm"
                onClick={() => void handleNewChat()}
                disabled={archived || pending}
              >
                <span className="material-symbols-outlined" aria-hidden="true">
                  add
                </span>
                Mới
              </button>
            </div>
            <div className="gai-planner-history-items">
              {loadingChats && (
                <p className="gai-planner-history-empty">
                  <span className="material-symbols-outlined gai-spin">
                    progress_activity
                  </span>{" "}
                  Đang tải lịch sử…
                </p>
              )}
              {!loadingChats && chats.length === 0 && (
                <p className="gai-planner-history-empty">
                  Cuộc trò chuyện đầu tiên sẽ xuất hiện sau khi bạn gửi brief.
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
                    disabled={pending}
                    aria-current={c.conversation_id === activeChatId ? "true" : undefined}
                    onClick={() => {
                      if (c.conversation_id === activeChatId) {
                        void loadChat(c.conversation_id);
                        return;
                      }
                      setMessages([]);
                      setDraftText("");
                      setDraftOverride(null);
                      setProgress(null);
                      setEmptyPlan(false);
                      setBusyConflict(null);
                      setErrorView(null);
                      setActiveChatId(c.conversation_id);
                    }}
                  >
                    <span className="gai-planner-history-item-name">
                      {c.title || "Kế hoạch nhóm"}
                    </span>
                    <span className="gai-planner-history-item-meta">
                      {new Date(c.created_at).toLocaleDateString("vi-VN", {
                        day: "numeric",
                        month: "short",
                      })}
                      {c.status === "applied" && (
                        <span className="gai-planner-history-item-status">
                          Đã lưu
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
                    Group Lập kế hoạch với AIner
                    {activeChat?.title && (
                      <span className="gai-planner-stream-chat-title">
                        {activeChat.title}
                      </span>
                    )}
                  </h1>
                </div>
              </div>
              <ol className="gai-planner-steps" aria-label="Tiến trình lập kế hoạch">
                {["Bàn brief", "Duyệt và giao việc", "Đã lưu vào nhóm"].map((label, index) => (
                  <li key={label} aria-current={index === step ? "step" : undefined}>
                    <span aria-hidden="true">{index < step ? "✓" : index + 1}</span>
                    {label}
                  </li>
                ))}
              </ol>
            </div>

            {errorView && (
              <div className="gai-planner-banner gai-planner-banner--error" role="alert">
                <span className="material-symbols-outlined" aria-hidden="true">
                  error
                </span>
                <div className="gai-planner-banner-body">
                  <strong>{errorView.title}</strong>
                  <span>{errorView.message}</span>
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
                    Thử lại
                  </button>
                )}
              </div>
            )}

            <GroupChatThread
              messages={messages}
              members={members}
              loading={loadingChat}
              thinking={thinking}
              emptyPlan={emptyPlan}
              canRegenerate={!pending && !archived && canDraft}
              onRegenerate={() => void handleSend("plan")}
              showReview={step === 1}
              onReview={() => panelRef.current?.scrollToDraft()}
              onExample={() => {
                setDraftText("Giúp mình rà soát brief của nhóm. Mục tiêu là [kết quả cần bàn giao], hạn là [ngày]. Những việc đã có là [các việc]. Mình muốn bổ sung [phần còn thiếu].");
                composerRef.current?.focus();
              }}
              exampleDisabled={pending || archived}
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
                placeholder="Mô tả mục tiêu, yêu cầu khách hàng và hạn bàn giao…"
                maxLength={MAX_MESSAGE_LENGTH}
                disabled={pending || archived}
                aria-label="Nhắn cho AI"
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
                  disabled={pending || archived || !draftText.trim()}
                >
                  <span className="material-symbols-outlined" aria-hidden="true">
                    send
                  </span>
                  Gửi để bàn bạc
                </button>
                {canDraft && (
                  <button
                    type="button"
                    className={`gai-btn ${step === 0 ? "gai-btn--primary" : "gai-btn--ghost"}`}
                    onClick={() => void handleSend("plan")}
                    disabled={pending || archived}
                    title="Dùng nội dung đã trao đổi và yêu cầu bạn đang nhập"
                  >
                    <span className="material-symbols-outlined" aria-hidden="true">account_tree</span>
                    {step === 1 ? "Cập nhật bản nháp với AI" : "Tạo bản nháp"}
                  </button>
                )}
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
              readOnly={archived || sending || loadingChat || creating}
              savedMilestones={progress?.milestones}
              savedTasks={progress?.tasks}
              groupPath={`/groups/${groupId}`}
              error={applyError}
              busyConflict={busyConflict}
              onPatchMilestone={patchMilestone}
              onPatchTask={patchTask}
              onRestore={restoreDraft}
              onApply={() => void handleApply()}
              onConfirmConflicts={() => void handleApply(true)}
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
                <h2 className="gai-planner-card-title">Nhóm đang có gì?</h2>
              </div>
              <p className="gai-planner-card-sub">
                {group.name} · {group.memberCount} thành viên
                {groupTaskCount !== null && ` · ${groupTaskCount} công việc`}
                {group.deadline && ` · Hạn ${new Date(group.deadline).toLocaleDateString("vi-VN")}`}
              </p>
              {groupMilestones.length > 0 && (
                <details className="gai-group-existing">
                  <summary>{groupMilestones.length} cột mốc hiện có</summary>
                  <ul className="gai-planner-context-list">
                    {groupMilestones.map((milestone) => <li key={milestone.id}>{milestone.name}</li>)}
                  </ul>
                </details>
              )}
              <Link to={`/groups/${groupId}`} className="gai-btn gai-btn--ghost gai-btn--sm">
                Xem công việc và gợi ý người làm
              </Link>
            </div>
          </aside>
        </div>
      </div>

      <CenterToasts toasts={toasts} onDismiss={toast.dismiss} />
    </div>
  );
}
