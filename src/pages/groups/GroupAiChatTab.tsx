/**
 * ===========================================================
 * Tab "Chat AI" của nhóm — lập kế hoạch cùng AI
 * ===========================================================
 *
 * Spec: `GROUP_AI_FE.md` mục 2.
 *
 * Luồng:
 *   GET  /groups/{groupId}/chats        → danh sách chat (mới nhất trước)
 *   POST /groups/{groupId}/chats        → tạo chat mới (nút "+ New chat")
 *   GET  /groups/chats/{chatId}         → toàn bộ tin nhắn (kể cả bản nháp cũ)
 *   POST /groups/chats/{chatId}/messages → gửi tin (tốn 1 lượt AI)
 *   POST /groups/chats/{chatId}/messages/{messageId}/applied → khóa bản nháp
 *
 * Áp dụng bản nháp: FE gọi **Backend** (`group-api.ts`) để tạo giai đoạn /
 * việc / việc con — AI **không** ghi vào bảng nhóm.
 *
 * Giao diện theo `DESIGN.md` (prefix `.gai-*`).
 */

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  createGroupChat,
  getGroupChat,
  listGroupChats,
  markGroupDraftApplied,
  sendGroupChatMessage,
  type GroupChatMessageDto,
  type GroupConversationDto,
  type GroupChatMode,
} from "../../lib/group-ai-api";
import {
  createGroupMilestone,
  createGroupSubTask,
  createGroupTask,
  listGroupMilestones,
  parseAssigneeBusyDetails,
  type GroupMemberDto,
  type GroupMilestoneDto,
} from "../../lib/group-api";
import { toGroupAiErrorView, type GroupAiErrorView } from "./group-ai-errors";
import {
  buildApplyPlans,
  findLatestDraft,
  findPlanWithoutDraft,
  fmtDeadline,
  fmtMinutes,
  isReadyToPlan,
  parseMinutes,
  toEditableDraft,
  toVietnamDeadline,
  validateDraft,
  type EditableDraft,
  type EditableMilestone,
  type EditableTask,
} from "./group-ai-logic";
import "./group-ai.css";

/** Độ dài tối đa của 1 tin nhắn (AI service trả 422 nếu vượt). */
const MAX_MESSAGE_LENGTH = 4000;

export interface GroupAiChatTabProps {
  groupId: string;
  /** Thành viên nhóm — dùng cho dropdown người làm. */
  members: GroupMemberDto[];
  /** Leader có dùng được AI không (Member/Viewer thì không). */
  enabled: boolean;
  /** Nhóm đã lưu trữ → ẩn chức năng. */
  archived: boolean;
  /** Hiện hộp thoại lỗi (tiếng Anh). */
  onError: (view: GroupAiErrorView, raw?: string) => void;
  /** Nhóm đã có thay đổi → gọi lại danh sách việc. */
  onGroupChanged: () => void;
  /**
   * Thao tác gần nhất bị lỗi tạm thời (502/503/429) → để hộp thoại lỗi
   * hiện nút "Try again". `null` = không có gì để thử lại.
   */
  onRetryRequest?: (retry: () => void) => void;
}

export function GroupAiChatTab({
  groupId,
  members,
  enabled,
  archived,
  onError,
  onGroupChanged,
  onRetryRequest,
}: GroupAiChatTabProps) {
  /* ---------- Danh sách chat ---------- */
  const [chats, setChats] = useState<GroupConversationDto[]>([]);
  const [activeChatId, setActiveChatId] = useState<string | null>(null);
  const [messages, setMessages] = useState<GroupChatMessageDto[]>([]);
  const [loadingChats, setLoadingChats] = useState(true);
  const [loadingChat, setLoadingChat] = useState(false);

  /* ---------- Gửi tin ---------- */
  const [draftText, setDraftText] = useState("");
  const [sending, setSending] = useState(false);
  /** `true` = đang chờ AI trả lời (discuss ~4s, plan ~9–15s). */
  const [thinking, setThinking] = useState(false);

  /* ---------- Bản nháp ---------- */
  /**
   * Bản nháp đang được Leader sửa.
   *
   * - `null` → lấy từ bản nháp mới nhất của AI (`derivedDraft`).
   * - Có giá trị → Leader đã sửa, giữ nguyên các thay đổi đó.
   *
   * Dùng mẫu "derived + override" để không phải setState trong effect
   * (chuẩn React 19 / eslint `set-state-in-effect`).
   */
  const [draftOverride, setDraftOverride] = useState<EditableDraft | null>(
    null,
  );
  const [applying, setApplying] = useState(false);
  /** Lỗi khi áp dụng (validate hoặc BE trả lỗi). */
  const [applyError, setApplyError] = useState<string | null>(null);
  /**
   * Việc bị chặn vì người nhận bận — Leader cần xác nhận để gửi lại kèm
   * `confirmConflicts: true` (spec mục 2.6 bước 3).
   */
  const [busyConflict, setBusyConflict] = useState<{
    taskKey: string;
    milestoneKey: string;
    title: string;
    assigneeId: string | null;
  } | null>(null);
  /**
   * Id giai đoạn / việc đã tạo thành công — dùng cho "Thử lại phần còn lại"
   * khi lỗi giữa chừng. Lưu ở FE (không gọi `/applied` khi lỗi).
   */
  const [createdMilestoneIds, setCreatedMilestoneIds] = useState<
    Record<string, string>
  >({});
  const [createdTaskIds, setCreatedTaskIds] = useState<Record<string, string>>(
    {},
  );

  const bodyRef = useRef<HTMLDivElement | null>(null);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  /**
   * Ref tới `handleSend` mới nhất — dùng cho nút "Try again" (tránh
   * `handleSend` tự tham chiếu trong `useCallback`).
   */
  const sendRef = useRef<((mode: GroupChatMode) => Promise<void>) | null>(
    null,
  );
  /** Ref tới `handleApply` mới nhất — dùng cho nút "Try again". */
  const applyRef = useRef<
    ((confirmConflicts?: boolean) => Promise<void>) | null
  >(null);
  /** Ref tới `loadChat` mới nhất — dùng cho nút "Try again". */
  const loadChatRef = useRef<((chatId: string) => Promise<void>) | null>(null);

  /* ===========================================================
   * Báo lỗi (kèm nút "Try again" cho lỗi tạm thời)
   * =========================================================== */

  /**
   * Báo lỗi cho user.
   *
   * Với lỗi **tạm thời** (502/503/429 — AI service bận), ta đăng ký thêm
   * thao tác để thử lại, nên hộp thoại lỗi có nút "Try again" thay vì
   * bắt user tự làm lại từ đầu.
   *
   * @param res Kết quả lỗi từ `aiFetch`.
   * @param retry Thao tác thử lại (nếu có).
   */
  const reportError = useCallback(
    (
      res: {
        ok: false;
        error: string;
        status?: number;
        errorCode?: string;
      },
      retry?: () => void,
    ) => {
      const view = toGroupAiErrorView(res);
      onError(view, res.error);
      if (view.showRetry && retry && onRetryRequest) {
        onRetryRequest(retry);
      }
    },
    [onError, onRetryRequest],
  );

  /* ===========================================================
   * Nạp danh sách chat
   * =========================================================== */

  const loadChats = useCallback(async () => {
    setLoadingChats(true);
    const res = await listGroupChats(groupId);
    setLoadingChats(false);
    if (!res.ok) {
      onError(toGroupAiErrorView(res), res.error);
      return;
    }
    setChats(res.data);
    // Mở chat mới nhất nếu chưa chọn chat nào.
    setActiveChatId((prev) => prev ?? res.data[0]?.conversation_id ?? null);
  }, [groupId, onError]);

  useEffect(() => {
    if (!enabled || !groupId) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- data-fetch pattern
    void loadChats();
  }, [enabled, groupId, loadChats]);

  /* ===========================================================
   * Nạp tin nhắn của 1 chat
   * =========================================================== */

  const loadChat = useCallback(
    async (chatId: string) => {
      setLoadingChat(true);
      const res = await getGroupChat(chatId);
      setLoadingChat(false);
      if (!res.ok) {
        reportError(res, () => void loadChatRef.current?.(chatId));
        return;
      }
      setMessages(res.data.messages ?? []);
      setCreatedMilestoneIds({});
      setCreatedTaskIds({});
      setApplyError(null);
      /* Bản nháp cũ (nếu Leader đã sửa) không áp dụng cho chat mới. */
      setDraftOverride(null);
    },
    [reportError],
  );

  /* Giữ ref tới `loadChat` mới nhất cho nút "Try again". */
  useEffect(() => {
    loadChatRef.current = loadChat;
  }, [loadChat]);

  useEffect(() => {
    if (!activeChatId) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- data-fetch pattern
    void loadChat(activeChatId);
  }, [activeChatId, loadChat]);

  /* Bản nháp mới nhất → dạng editable (để Leader sửa). */
  const latest = useMemo(() => findLatestDraft(messages), [messages]);

  /** Bản nháp gốc từ AI (chưa qua chỉnh sửa của Leader). */
  const derivedDraft = useMemo<EditableDraft | null>(() => {
    if (!latest) return null;
    /* `message_id` lấy từ TIN NHẮN AI — schema draft của nhóm không có
       trường này (xem `group-ai-logic.ts` → `toEditableDraft`). */
    return toEditableDraft(
      latest.draft,
      latest.message.is_applied === true,
      latest.message.message_id,
    );
  }, [latest]);

  /**
   * Bản nháp đang hiển thị: bản Leader đã sửa (nếu có) thì ưu tiên bản đó.
   *
   * `draftOverride` được xoá khi bản nháp gốc thay đổi (AI trả bản nháp mới)
   * — xử lý bằng cách so `messageId`.
   */
  const editableDraft = useMemo<EditableDraft | null>(() => {
    if (!derivedDraft) return null;
    if (draftOverride && draftOverride.messageId === derivedDraft.messageId) {
      return draftOverride;
    }
    return derivedDraft;
  }, [derivedDraft, draftOverride]);

  const readyToPlan = useMemo(() => isReadyToPlan(messages), [messages]);

  /**
   * Leader đã yêu cầu lập kế hoạch nhưng AI **không trả về bản nháp dùng
   * được** — hoặc `draft = null`, hoặc `draft.milestones` rỗng.
   *
   * Lúc đó không có gì để sửa / assign / apply → phải nói rõ với Leader và
   * cho nút thử lại, nếu không họ tưởng chức năng hỏng.
   */
  const planWithoutDraft = useMemo(() => {
    /* Đã có bản nháp thật sự → không cần cảnh báo. */
    if (editableDraft && editableDraft.milestones.length > 0) return null;
    return findPlanWithoutDraft(messages);
  }, [messages, editableDraft]);

  /** Chat đang mở (để hiện tiêu đề ở đầu hội thoại). */
  const activeChat = useMemo(
    () => chats.find((c) => c.conversation_id === activeChatId) ?? null,
    [chats, activeChatId],
  );

  /* Cuộn xuống cuối khi có tin mới. */
  useEffect(() => {
    const el = bodyRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, thinking, editableDraft]);

  /* ===========================================================
   * Tạo chat mới
   * =========================================================== */

  const handleNewChat = useCallback(async () => {
    const res = await createGroupChat(groupId);
    if (!res.ok) {
      onError(toGroupAiErrorView(res), res.error);
      return;
    }
    setChats((prev) => [res.data, ...prev]);
    setActiveChatId(res.data.conversation_id);
    setMessages([]);
    setDraftText("");
    setCreatedMilestoneIds({});
    setCreatedTaskIds({});
    setApplyError(null);
    window.setTimeout(() => composerRef.current?.focus(), 40);
  }, [groupId, onError]);

  /* ===========================================================
   * Gửi tin
   * =========================================================== */

  const handleSend = useCallback(
    async (mode: GroupChatMode) => {
      if (!activeChatId || sending) return;
      const text = draftText.trim();

      if (mode === "discuss" && !text) return;
      if (text.length > MAX_MESSAGE_LENGTH) {
        setApplyError(
          "Your message is too long. Please keep it under 4000 characters.",
        );
        return;
      }

      setSending(true);
      setThinking(true);
      setApplyError(null);

      const res = await sendGroupChatMessage(activeChatId, { text, mode });

      setSending(false);
      setThinking(false);

      if (!res.ok) {
        // 502 / 429 → giữ nguyên chữ đã gõ để user bấm "Try again".
        reportError(res, () => void sendRef.current?.(mode));
        return;
      }

      setMessages((prev) => [
        ...prev,
        res.data.user_message,
        res.data.ai_message,
      ]);
      // Tin `plan` đã dùng xong → xoá ô nhập.
      if (mode === "plan") setDraftText("");
    },
    [activeChatId, draftText, sending, reportError],
  );

  /* Giữ ref tới `handleSend` mới nhất cho nút "Try again". */
  useEffect(() => {
    sendRef.current = handleSend;
  }, [handleSend]);

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

      /* 1. orderIndex tiep theo cho milestone. */
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

    /* Bản ghi các mục đã tạo — để "Retry remaining" không tạo trùng. */
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
          /* Có thể đã tạo được vài mục trước đó → nạp lại nhóm để Leader
             thấy được phần nào đã có (spec mục 2.6 "lỗi giữa chừng"). */
          onGroupChanged();
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
          /* Deadline của việc = 23:59 giờ Việt Nam của ngày hết hạn giai đoạn
             (spec mục 2.6 bước 3). Không có hạn → `null`. */
          deadline: ms.deadline ? toVietnamDeadline(ms.deadline) : null,
          assigneeId: task.assigneeId,
          /* Leader đã đồng ý chồng lịch → gửi lại kèm cờ xác nhận. */
          confirmConflicts: confirmConflicts || undefined,
        });

        if (!taskCreate.ok) {
          setApplying(false);
          setCreatedMilestoneIds(createdMilestones);
          setCreatedTaskIds(createdTasks);
          /* Nạp lại nhóm: giai đoạn (và các việc trước đó) đã tạo xong. */
          onGroupChanged();
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

    /*
     * ⚠️ Luôn nạp lại nhóm TRƯỚC khi xử lý lỗi `/applied`.
     *
     * Việc/giai đoạn đã tạo xong rồi → tab Tasks/Milestones của nhóm phải
     * cập nhật ngay, kể cả khi bước đánh dấu "đã áp dụng" thất bại.
     * Trước đây lỗi ở bước này `return` sớm → không reload → người dùng
     * thấy bản nháp nhưng không thấy giai đoạn/việc trong nhóm.
     */
    onGroupChanged();

    if (!appliedRes.ok && appliedRes.status === 409) {
      /* 409 already_applied → đã áp dụng ở tab khác → khóa nút, không tạo lại. */
      setDraftOverride((prev) => {
        const base = prev ?? editableDraft;
        return base ? { ...base, applied: true } : prev;
      });
      return;
    }

    /* Đánh dấu "đã áp dụng" lỗi (502/503) → việc đã tạo xong, chỉ chưa khoá. */
    if (!appliedRes.ok) {
      reportError(appliedRes, () => void applyRef.current?.(confirmConflicts));
      return;
    }

    setDraftOverride((prev) => {
      const base = prev ?? editableDraft;
      return base ? { ...base, applied: true } : prev;
    });
  }, [
    editableDraft,
    activeChatId,
    groupId,
    applying,
    createdMilestoneIds,
    createdTaskIds,
    reportError,
    onGroupChanged,
  ]);

  /* Giữ ref tới `handleApply` mới nhất cho nút "Try again". */
  useEffect(() => {
    applyRef.current = handleApply;
  }, [handleApply]);
  /* ===========================================================
   * Render
   * =========================================================== */

  /** Thành viên có thể được giao việc (Leader / Member, không Viewer). */
  const assignable = useMemo(
    () =>
      members.filter((m) => {
        const role = (m.role ?? "").toLowerCase();
        return role === "leader" || role === "member";
      }),
    [members],
  );

  if (!enabled) {
    return (
      <div className="gai-state">
        <span className="material-symbols-outlined">lock</span>
        <span>
          Only group leaders can plan work with AI. Ask a leader to start a
          planning chat for this group.
        </span>
      </div>
    );
  }

  return (
    <div className="gai-chat">
      {/* ================= Cột trái: danh sách chat ================= */}
      <aside className="gai-chat-list">
        <div className="gai-chat-list-head">
          <h3 className="gai-chat-list-title">Planning chats</h3>
          <button
            type="button"
            className="gai-btn gai-btn--primary gai-chat-new"
            onClick={() => void handleNewChat()}
            disabled={archived}
          >
            <span className="material-symbols-outlined" aria-hidden="true">
              add
            </span>
            New chat
          </button>
        </div>

        <div className="gai-chat-items">
          {loadingChats && (
            <div className="gai-chat-empty" role="status">
              <span className="material-symbols-outlined gai-spin">
                progress_activity
              </span>{" "}
              Loading chats…
            </div>
          )}

          {!loadingChats && chats.length === 0 && (
            <p className="gai-chat-empty">
              No planning chats yet. Create one to turn a client brief into a
              milestone plan.
            </p>
          )}

          {!loadingChats &&
            chats.map((c) => (
              <button
                key={c.conversation_id}
                type="button"
                className={
                  "gai-chat-item" +
                  (c.conversation_id === activeChatId
                    ? " gai-chat-item--on"
                    : "")
                }
                onClick={() => setActiveChatId(c.conversation_id)}
              >
                <span className="gai-chat-item-name">
                  {c.title || "Group planning"}
                </span>
                <span className="gai-chat-item-meta">
                  {new Date(c.created_at).toLocaleDateString(undefined, {
                    day: "numeric",
                    month: "short",
                  })}
                  {c.status === "applied" && (
                    <span className="gai-chat-item-status">applied</span>
                  )}
                </span>
              </button>
            ))}
        </div>
      </aside>

      {/* ================= Cột phải: hội thoại ================= */}
      <section className="gai-thread">
        {/* ---------- Đầu hội thoại ---------- */}
        <div className="gai-thread-head">
          <span className="gai-thread-icon" aria-hidden="true">
            <span className="material-symbols-outlined">auto_awesome</span>
          </span>
          <span className="gai-thread-title">
            {activeChat
              ? activeChat.title || "Group planning"
              : "Group planning"}
          </span>
          {activeChat && (
            <span className="gai-thread-badge">
              {messages.length} {messages.length === 1 ? "message" : "messages"}
            </span>
          )}
        </div>

        {!activeChatId ? (
          <div className="gai-thread-body">
            <div className="gai-state">
              <span className="material-symbols-outlined">forum</span>
              <span>
                Pick a planning chat on the left, or create a new one to start.
              </span>
            </div>
          </div>
        ) : (
          <>
            {/* ---------- Tin nhắn ---------- */}
            <div className="gai-thread-body" ref={bodyRef}>
              {loadingChat && (
                <div className="gai-thinking" role="status">
                  <span className="material-symbols-outlined">
                    progress_activity
                  </span>
                  <span>Loading conversation…</span>
                </div>
              )}

              {!loadingChat && messages.length === 0 && (
                <div className="gai-state">
                  <span className="material-symbols-outlined">auto_awesome</span>
                  <span>
                    Describe the client brief below. AI will ask what's missing,
                    then draft a milestone plan for the group.
                  </span>
                </div>
              )}

              {messages.map((m) => {
                /* Tin này có mang bản nháp MỚI NHẤT không? */
                const isDraftHost =
                  latest?.message.message_id === m.message_id;
                return (
                  <Fragment key={m.message_id}>
                    <ChatMessage
                      message={m}
                      memberName={memberNameOf(m, members)}
                      isLatestDraft={isDraftHost}
                    />
                    {/*
                     * Thẻ "Review & apply" nằm NGAY DƯỚI tin nhắn AI vừa
                     * sinh bản nháp — không đẩy xuống cuối khung chat (dễ bị
                     * bỏ sót / nằm ngoài tầm nhìn khi hội thoại dài).
                     */}
                    {isDraftHost && editableDraft && (
                      <DraftCard
                        draft={editableDraft}
                        assignable={assignable}
                        applying={applying}
                        error={applyError}
                        onPatchMilestone={patchMilestone}
                        onPatchTask={patchTask}
                        onApply={() => void handleApply()}
                        busyConflict={busyConflict}
                        onConfirmConflicts={() => void handleApply(true)}
                        onDismissConflict={() => {
                          setBusyConflict(null);
                          setApplyError(null);
                        }}
                      />
                    )}
                  </Fragment>
                );
              })}

              {/*
               * AI trả lời nhưng KHÔNG sinh được bản nháp (chỉ có text).
               * → Báo rõ + cho nút thử lại, thay vì im lặng không hiện gì.
               */}
              {planWithoutDraft && (
                <div className="gai-no-draft" role="alert">
                  <span
                    className="material-symbols-outlined"
                    aria-hidden="true"
                  >
                    error_outline
                  </span>
                  <div className="gai-no-draft-body">
                    <strong>The plan came back empty.</strong>
                    <p>
                      The AI replied with text only, so there are no
                      milestones, tasks or assignees to review. Try generating
                      the plan again — or type what you want changed and
                      press Update plan.
                    </p>
                    <button
                      type="button"
                      className="gai-btn gai-btn--ghost gai-no-draft-btn"
                      onClick={() => void handleSend("plan")}
                      disabled={sending || archived}
                    >
                      <span
                        className="material-symbols-outlined"
                        aria-hidden="true"
                      >
                        refresh
                      </span>
                      Generate plan again
                    </button>
                  </div>
                </div>
              )}

              {thinking && (
                <div className="gai-msg gai-msg--ai" role="status">
                  <span className="gai-avatar gai-avatar--ai" aria-hidden="true">
                    <span className="material-symbols-outlined">auto_awesome</span>
                  </span>
                  <div className="gai-msg-col">
                    <div className="gai-msg-meta">
                      <span className="gai-msg-meta-name">METANOIA AI</span>
                      <span className="gai-msg-meta-time">· thinking</span>
                    </div>
                    <div className="gai-bubble gai-bubble--ai gai-typing">
                      <span className="gai-typing-dot" />
                      <span className="gai-typing-dot" />
                      <span className="gai-typing-dot" />
                    </div>
                  </div>
                </div>
              )}
            </div>

            {/* ---------- Ô nhập ---------- */}
            <div className="gai-composer">
              {applyError && !editableDraft && (
                <div className="gai-note" role="alert">
                  <span className="material-symbols-outlined" aria-hidden="true">
                    error
                  </span>
                  <span>{applyError}</span>
                </div>
              )}
              <textarea
                ref={composerRef}
                className="gai-composer-input"
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
              <div className="gai-composer-actions">
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
                    "gai-btn gai-btn--ghost" + (readyToPlan ? " gai-plan-btn" : "")
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
                <span className="gai-composer-hint">
                  {draftText.length}/{MAX_MESSAGE_LENGTH}
                </span>
              </div>
            </div>
          </>
        )}
      </section>
    </div>
  );
}

/* ===========================================================
 * Hiển thị 1 tin nhắn
 * =========================================================== */

function ChatMessage({
  message,
  memberName,
  isLatestDraft = false,
}: {
  message: GroupChatMessageDto;
  memberName: string | null;
  /**
   * `true` = đây là tin mang bản nháp MỚI NHẤT (đã có thẻ Sửa/Áp dụng).
   * Mặc định `false` → bản nháp hiện dạng preview read-only trong tin nhắn.
   */
  isLatestDraft?: boolean;
}) {
  const isUser = message.role === "user";
  const notes = message.notes;
  const draft = message.draft;

  /** Chữ cái đầu của tên — dùng làm avatar khi không có tên. */
  const initial = (memberName ?? "?").trim().charAt(0).toUpperCase() || "?";

  return (
    <div className={"gai-msg " + (isUser ? "gai-msg--user" : "gai-msg--ai")}>
      {/* ---------- Avatar ---------- */}
      {isUser ? (
        <span className="gai-avatar" title={memberName ?? "You"}>
          {initial}
        </span>
      ) : (
        <span className="gai-avatar gai-avatar--ai" title="METANOIA AI">
          <span className="material-symbols-outlined" aria-hidden="true">
            auto_awesome
          </span>
        </span>
      )}

      <div className="gai-msg-col">
        {/* ---------- Meta ---------- */}
        <div className="gai-msg-meta">
          <span className="gai-msg-meta-name">
            {isUser ? (memberName ?? "You") : "METANOIA AI"}
          </span>
          <span className="gai-msg-meta-time">
            · {fmtMsgTime(message.created_at)}
          </span>
        </div>

        {/* ---------- Nội dung ---------- */}
        {message.content && (
          <div
            className={"gai-bubble " + (isUser ? "gai-bubble--user" : "gai-bubble--ai")}
          >
            {message.content}
          </div>
        )}

        {/* ---------- Checklist 4 khối ---------- */}
        {notes && (
          <div className="gai-notes">
            <NoteBlock
              variant="clear"
              icon="check_circle"
              title="Clear"
              items={notes.clear}
            />
            <NoteBlock
              variant="missing"
              icon="help"
              title="Missing"
              items={notes.missing}
            />
            <NoteBlock
              variant="questions"
              icon="help_outline"
              title="Ask the client"
              items={notes.questions}
            />
            <NoteBlock
              variant="risks"
              icon="warning"
              title="Risks"
              items={notes.risks}
            />
          </div>
        )}

        {/* ---------- Bản nháp ----------
            Bản nháp MỚI NHẤT không hiện ở đây — nó hiện bằng thẻ "Review &
            apply" (có nút Sửa / Áp dụng) ngay bên dưới tin nhắn này. */}
        {draft && !isLatestDraft && (
          <DraftPreview draft={draft} memberName={memberName} />
        )}
      </div>
    </div>
  );
}

/** Giờ kiểu "14:32" — ngắn gọn cho dòng meta. */
function fmtMsgTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

/** 1 khối trong checklist 4 khối. */
function NoteBlock({
  variant,
  icon,
  title,
  items,
}: {
  variant: string;
  icon: string;
  title: string;
  items: string[];
}) {
  if (!items || items.length === 0) return null;
  return (
    <div className={`gai-note-block gai-note-block--${variant}`}>
      <p className="gai-note-block-title">
        <span className="material-symbols-outlined" aria-hidden="true">
          {icon}
        </span>
        {title}
      </p>
      <ul className="gai-note-list">
        {items.map((it, i) => (
          <li key={i}>{it}</li>
        ))}
      </ul>
    </div>
  );
}

/**
 * Xem trước bản nháp CŨ (không sửa được).
 *
 * Bản nháp MỚI NHẤT hiện bằng thẻ "Review & apply" (`DraftCard`) — có ô
 * sửa, dropdown người làm và nút Áp dụng.
 *
 * Bản nháp cũ thu gọn thành 1 dòng tóm tắt (bấm để mở xem chi tiết) để
 * không làm rối hội thoại — trước đây nó chiếm cả màn hình.
 */
function DraftPreview({
  draft,
  memberName,
}: {
  draft: NonNullable<GroupChatMessageDto["draft"]>;
  memberName: string | null;
}) {
  const [open, setOpen] = useState(false);

  const msCount = draft.milestones.length;
  const taskCount = draft.milestones.reduce(
    (acc, ms) => acc + (ms.tasks?.length ?? 0),
    0,
  );

  return (
    <div className="gai-draft gai-draft--preview">
      <button
        type="button"
        className="gai-draft-preview-toggle"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <span className="material-symbols-outlined" aria-hidden="true">
          account_tree
        </span>
        <span className="gai-draft-preview-label">Earlier draft plan</span>
        <span className="gai-draft-preview-meta">
          {msCount} {msCount === 1 ? "milestone" : "milestones"} · {taskCount}{" "}
          {taskCount === 1 ? "task" : "tasks"} ·{" "}
          {fmtMinutes(draft.total_estimated_minutes)}
        </span>
        <span
          className="material-symbols-outlined gai-draft-preview-caret"
          aria-hidden="true"
        >
          {open ? "expand_less" : "expand_more"}
        </span>
      </button>

      {open && (
        <div className="gai-draft-preview-body">
          {draft.milestones.map((ms, i) => (
            <div key={ms.key ?? `ms-${i}`} className="gai-milestone">
              <div className="gai-milestone-head">
                <span className="gai-milestone-index">{i + 1}</span>
                <span className="gai-milestone-title">{ms.title}</span>
                {ms.deadline && (
                  <span className="gai-milestone-deadline">
                    <span
                      className="material-symbols-outlined"
                      aria-hidden="true"
                    >
                      event
                    </span>
                    {fmtDeadline(ms.deadline)}
                  </span>
                )}
              </div>
              <div className="gai-tasks">
                {ms.tasks.map((t, ti) => (
                  <div key={t.key ?? `t-${ti}`} className="gai-task">
                    <div className="gai-task-head">
                      <span className="gai-task-title">{t.title}</span>
                      {t.domain_name && (
                        <span className="gai-domain">{t.domain_name}</span>
                      )}
                      <span className="gai-est">
                        <span
                          className="material-symbols-outlined"
                          aria-hidden="true"
                        >
                          schedule
                        </span>
                        {fmtMinutes(t.estimated_minutes)}
                      </span>
                    </div>
                    {t.suggested_assignee && (
                      <p className="gai-task-reason">
                        {t.suggested_assignee.user_id
                          ? `Suggested: ${memberName ?? "a team member"}`
                          : "No one is available to take this on yet."}
                        {t.suggested_assignee.reason
                          ? ` — ${t.suggested_assignee.reason}`
                          : ""}
                      </p>
                    )}
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* ===========================================================
 * Thẻ bản nháp có thể sửa + nút Áp dụng
 * =========================================================== */

function DraftCard({
  draft,
  assignable,
  applying,
  error,
  onPatchMilestone,
  onPatchTask,
  onApply,
  busyConflict,
  onConfirmConflicts,
  onDismissConflict,
}: {
  draft: EditableDraft;
  assignable: GroupMemberDto[];
  applying: boolean;
  error: string | null;
  onPatchMilestone: (msKey: string, patch: Partial<EditableMilestone>) => void;
  onPatchTask: (
    msKey: string,
    taskKey: string,
    patch: Partial<EditableTask>,
  ) => void;
  onApply: () => void;
  /** Việc bị chặn vì người nhận bận (Leader xác nhận để gửi lại). */
  busyConflict?: {
    taskKey: string;
    milestoneKey: string;
    title: string;
    assigneeId: string | null;
  } | null;
  /** Leader đồng ý giao dù bận → gửi lại kèm `confirmConflicts: true`. */
  onConfirmConflicts?: () => void;
  /** Leader chọn người khác → bỏ qua cảnh báo. */
  onDismissConflict?: () => void;
}) {
  /* Số việc / việc con sẽ tạo → hiện tóm tắt cho Leader trước khi duyệt. */
  const taskCount = draft.milestones.reduce(
    (acc, ms) => acc + ms.tasks.length,
    0,
  );
  const subtaskCount = draft.milestones.reduce(
    (acc, ms) =>
      acc + ms.tasks.reduce((a, t) => a + t.subtasks.length, 0),
    0,
  );

  /*
   * Bản nháp RỖNG (AI không sinh được milestone nào).
   * → Không render card trống; hiện lời nhắc cho Leader biết AI chưa tạo
   *   được cấu trúc, kèm nút thử lại.
   */
  if (draft.milestones.length === 0) {
    return (
      <div className="gai-no-draft" role="alert">
        <span className="material-symbols-outlined" aria-hidden="true">
          error_outline
        </span>
        <div className="gai-no-draft-body">
          <strong>The plan came back empty.</strong>
          <p>
            The AI replied, but it did not produce any milestones, tasks or
            assignees to review. Generate the plan again — or type what you
            want changed and press Update plan.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="gai-draft gai-draft--action">
      {/* ---------- Đầu: nhãn + trạng thái ---------- */}
      <div className="gai-draft-head">
        <div className="gai-draft-head-main">
          <span className="gai-draft-icon" aria-hidden="true">
            <span className="material-symbols-outlined">account_tree</span>
          </span>
          <div className="gai-draft-head-text">
            <h4 className="gai-draft-title">
              {draft.applied ? "Plan applied to the group" : "Review this plan"}
            </h4>
            <p className="gai-draft-sub">
              {draft.applied
                ? "These milestones and tasks are now in the group."
                : "Edit names, estimates and assignees, then apply it to the group."}
            </p>
          </div>
        </div>
        <span className="gai-draft-total">
          {fmtMinutes(draft.totalEstimatedMinutes)} estimated
        </span>
      </div>

      {draft.warnings.length > 0 && (
        <div className="gai-draft-warnings">
          {draft.warnings.map((w, i) => (
            <span key={i} className="gai-draft-warning">
              <span className="material-symbols-outlined" aria-hidden="true">
                warning
              </span>
              {w}
            </span>
          ))}
        </div>
      )}

      {draft.milestones.map((ms, mi) => (
        <div key={ms.key} className="gai-milestone">
          <div className="gai-milestone-head">
            <span className="gai-milestone-index">{mi + 1}</span>
            <input
              className="gai-input"
              value={ms.title}
              onChange={(e) =>
                onPatchMilestone(ms.key, { title: e.target.value })
              }
              disabled={applying || draft.applied}
              aria-label={`Milestone ${mi + 1} name`}
              style={{ maxWidth: 280 }}
            />
            <input
              type="date"
              className="gai-input"
              value={ms.deadline}
              onChange={(e) =>
                onPatchMilestone(ms.key, { deadline: e.target.value })
              }
              disabled={applying || draft.applied}
              aria-label={`Milestone ${mi + 1} deadline`}
              style={{ maxWidth: 170 }}
            />
          </div>

          {ms.reason && <p className="gai-milestone-reason">{ms.reason}</p>}

          <div className="gai-tasks">
            {ms.tasks.map((t) => (
              <div key={t.key} className="gai-task">
                <div className="gai-task-head">
                  <span className="gai-task-title">{t.title}</span>
                  {t.domainName && (
                    <span className="gai-domain">{t.domainName}</span>
                  )}
                </div>

                {/* ---------- Form chỉnh sửa ---------- */}
                <div className="gai-task-fields">
                  <div className="gai-field">
                    <label className="gai-field-label">Task name</label>
                    <input
                      className="gai-input"
                      value={t.title}
                      onChange={(e) =>
                        onPatchTask(ms.key, t.key, { title: e.target.value })
                      }
                      disabled={applying || draft.applied}
                    />
                  </div>

                  <div className="gai-field">
                    <label className="gai-field-label">Estimate (min)</label>
                    <input
                      type="number"
                      min={0}
                      step={15}
                      className="gai-input"
                      value={t.estimatedMinutes}
                      onChange={(e) =>
                        onPatchTask(ms.key, t.key, {
                          estimatedMinutes: e.target.value,
                        })
                      }
                      disabled={applying || draft.applied}
                    />
                  </div>

                  <div className="gai-field">
                    <label className="gai-field-label">Assignee</label>
                    <select
                      className="gai-select"
                      value={t.assigneeId ?? ""}
                      onChange={(e) =>
                        onPatchTask(ms.key, t.key, {
                          assigneeId: e.target.value || null,
                        })
                      }
                      disabled={applying || draft.applied}
                    >
                      <option value="">Unassigned</option>
                      {/*
                       * Nếu người AI gợi ý KHÔNG còn trong nhóm (đã rời nhóm)
                       * → thêm option riêng, nếu không `<select>` sẽ không
                       * khớp option nào và Leader không thấy ai đang được giao.
                       */}
                      {t.assigneeId &&
                        !assignable.some((m) => m.userId === t.assigneeId) && (
                          <option value={t.assigneeId}>
                            Former member (no longer in this group)
                          </option>
                        )}
                      {assignable.map((m) => {
                        const isSuggested =
                          t.suggestedAssigneeId === m.userId &&
                          t.assigneeId === m.userId;
                        const role = (m.role ?? "").toLowerCase();
                        const roleLabel =
                          role === "leader" ? "Leader" : "Member";
                        return (
                          <option key={m.userId} value={m.userId}>
                            {m.fullName} · {roleLabel}
                            {isSuggested ? " · AI pick" : ""}
                          </option>
                        );
                      })}
                    </select>
                    {/* Gợi ý của AI khác người đang chọn → nhắc Leader. */}
                    {t.suggestedAssigneeId &&
                      t.assigneeId !== t.suggestedAssigneeId && (
                        <button
                          type="button"
                          className="gai-ai-pick-btn"
                          onClick={() =>
                            onPatchTask(ms.key, t.key, {
                              assigneeId: t.suggestedAssigneeId,
                            })
                          }
                          disabled={applying || draft.applied}
                          title="Use the person AI suggested for this task"
                        >
                          <span
                            className="material-symbols-outlined"
                            aria-hidden="true"
                          >
                            auto_awesome
                          </span>
                          Use AI's pick
                        </button>
                      )}
                  </div>
                </div>

                {/* Lý do AI */}
                {t.assigneeReason && (
                  <p className="gai-task-reason">{t.assigneeReason}</p>
                )}

                {/* Việc con */}
                {t.subtasks.length > 0 && (
                  <div className="gai-subtasks">
                    {t.subtasks.map((st, si) => (
                      <div key={si} className="gai-subtask">
                        <span className="gai-subtask-name">{st.title}</span>
                        <span className="gai-subtask-est">
                          {fmtMinutes(parseMinutes(st.estimatedMinutes))}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      ))}

      {/* ---------- Nút Áp dụng ---------- */}
      <div className="gai-draft-actions">
        {draft.applied ? (
          <span className="gai-applied-chip">
            <span className="material-symbols-outlined" aria-hidden="true">
              check_circle
            </span>
            Applied to the group
          </span>
        ) : (
          <>
            {/* Tóm tắt sẽ tạo gì → Leader biết chính xác mình đang duyệt. */}
            <span className="gai-draft-summary">
              <span className="material-symbols-outlined" aria-hidden="true">
                flag
              </span>
              {draft.milestones.length}{" "}
              {draft.milestones.length === 1 ? "milestone" : "milestones"}
              <span className="gai-draft-summary-sep">·</span>
              <span className="material-symbols-outlined" aria-hidden="true">
                checklist
              </span>
              {taskCount} {taskCount === 1 ? "task" : "tasks"}
              {subtaskCount > 0 && (
                <>
                  <span className="gai-draft-summary-sep">·</span>
                  <span className="material-symbols-outlined" aria-hidden="true">
                    account_tree
                  </span>
                  {subtaskCount} {subtaskCount === 1 ? "subtask" : "subtasks"}
                </>
              )}
            </span>
            <button
              type="button"
              className="gai-btn gai-btn--primary gai-apply-btn"
              onClick={onApply}
              disabled={applying}
            >
              {applying ? (
                <>
                  <span
                    className="material-symbols-outlined gai-spin"
                    aria-hidden="true"
                  >
                    progress_activity
                  </span>
                  Applying…
                </>
              ) : (
                <>
                  <span className="material-symbols-outlined" aria-hidden="true">
                    check
                  </span>
                  Apply to group
                </>
              )}
            </button>
          </>
        )}
      </div>

      {error && (
        <div className="gai-note" role="alert" style={{ margin: "0 16px 16px" }}>
          <span className="material-symbols-outlined" aria-hidden="true">
            error
          </span>
          <span>{error}</span>
        </div>
      )}

      {/*
       * Xác nhận giao dù bận — Leader đồng ý thì gửi lại kèm
       * `confirmConflicts: true` (spec mục 2.6 bước 3).
       */}
      {busyConflict && (
        <div className="gai-conflict" role="alert">
          <span className="material-symbols-outlined" aria-hidden="true">
            warning
          </span>
          <div className="gai-conflict-body">
            <p className="gai-conflict-text">
              <strong>{busyConflict.title}</strong> — the assignee has a
              conflicting schedule, or their workload for that week is higher
              than they can take on.
            </p>
            <div className="gai-conflict-actions">
              <button
                type="button"
                className="gai-btn gai-btn--primary"
                onClick={onConfirmConflicts}
                disabled={applying}
              >
                <span className="material-symbols-outlined" aria-hidden="true">
                  check
                </span>
                Assign anyway
              </button>
              <button
                type="button"
                className="gai-btn gai-btn--ghost"
                onClick={onDismissConflict}
                disabled={applying}
              >
                Change assignee
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/* ===========================================================
 * Helper
 * =========================================================== */

/** Tìm tên thành viên theo id (AI chỉ trả id, không trả tên). */
function memberNameOf(
  message: GroupChatMessageDto,
  members: GroupMemberDto[],
): string | null {
  if (message.role !== "user") return null;
  const id = message.message_id;
  if (!id) return null;
  return members.find((m) => m.userId === id)?.fullName ?? null;
}
