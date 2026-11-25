/* ===========================================================
 * AI cho nhóm (Work Group) — API client
 * ----------------------------------------------------------
 * Spec: `GROUP_AI_FE.md`
 *
 * ⚠️ Toàn bộ endpoint dưới đây thuộc **AI service** (`VITE_AI_API_URL`),
 *    KHÔNG phải Backend METANOIA. Gọi thẳng AI service, dùng chung Bearer
 *    access token của Backend (AI xác thực bằng token đó).
 *
 * Khác biệt về format lỗi so với Backend:
 *   - Backend : `{ "code": "...", "details": {...} }`
 *   - AI svc  : `{ "detail": "..." }` hoặc `{ "detail": { "code": "...", ... } }`
 *    (FastAPI). Vì vậy mọi lỗi được dịch sang thông điệp tiếng Anh ở
 *    `src/pages/groups/group-ai-errors.ts`.
 *
 * Phân quyền: chỉ **Leader** của nhóm được dùng (BE/AI trả 403 cho Member).
 * Nhóm đã lưu trữ (Archived) → 409.
 * =========================================================== */

import { aiFetch, type ApiResult } from "./api-client";

/* ===========================================================
 * 1. Gợi ý người nhận việc
 * =========================================================== */

/** Khung giờ trống — ISO 8601 theo múi giờ của thành viên (VD `+07:00`). */
export interface GroupFreeTimeDto {
  start: string;
  end: string;
}

/** Một gợi ý người làm cho 1 việc nhóm. */
export interface GroupAssigneeSuggestionDto {
  /** AI **không** trả tên/email (riêng tư) — chỉ trả id, FE ghép tên từ BE. */
  user_id: string;
  /** `leader` | `member` — không có `viewer`. */
  role: string;
  /** 1 = tốt nhất. */
  rank: number;
  /** Đang là người được giao việc này. */
  is_current_assignee: boolean;
  /** Việc có giờ cố định và người này đã bận đúng giờ đó. */
  busy_at_fixed_time: boolean;
  /** Số phút rảnh trước hạn (đã trừ việc khác của họ). */
  free_minutes: number;
  /** Số phút việc nhóm họ đang ôm. */
  group_work_minutes: number;
  /** `true` đủ giờ · `false` có thể không đủ · `null` chưa có ước lượng. */
  fits: boolean | null;
  /** 1–2 câu do AI viết — có thể `null` (hết lượt / AI lỗi). */
  reason: string | null;
  /** ≤ 2 khung lịch trống dài nhất. */
  free_times: GroupFreeTimeDto[];
}

/** Lý do AI **không** viết được câu giải thích. */
export type GroupReasonsSkipped = "quota" | "llm_failed" | null;

export interface GroupAssigneeSuggestionsDto {
  task_id: string;
  /** Đã sắp xếp sẵn tốt nhất trước. */
  suggestions: GroupAssigneeSuggestionDto[];
  reasons_skipped: GroupReasonsSkipped;
}

/** Body của `POST /groups/tasks/{groupTaskId}/assignee-suggestions`. */
export interface GroupAssigneeSuggestionsRequest {
  /** Loại công việc (Coding, Design…) để AI dùng đúng thói quen ước lượng. */
  domain_id?: string | null;
  /** Ngôn ngữ của câu lý do: `vi` (mặc định) hoặc `en`. */
  language?: "vi" | "en";
}

/**
 * `POST /groups/tasks/{groupTaskId}/assignee-suggestions`
 *
 * Mỗi lần gọi = tối đa **1 lượt AI** của Leader (chỉ trừ khi AI viết được
 * lý do). Hết lượt vẫn trả `200` kèm xếp hạng — chỉ thiếu `reason`.
 */
export async function getGroupAssigneeSuggestions(
  groupTaskId: string,
  body: GroupAssigneeSuggestionsRequest = {},
): Promise<ApiResult<GroupAssigneeSuggestionsDto>> {
  if (!groupTaskId) {
    return { ok: false, status: 0, error: "Missing group task id." };
  }
  return aiFetch<GroupAssigneeSuggestionsDto>(
    `/groups/tasks/${encodeURIComponent(groupTaskId)}/assignee-suggestions`,
    {
      method: "POST",
      body: JSON.stringify({
        domain_id: body.domain_id ?? null,
        language: body.language ?? "vi",
      }),
    },
  );
}

/* ===========================================================
 * 2. Chat AI lập kế hoạch nhóm
 * =========================================================== */

/** Trạng thái cuộc chat. */
export type GroupChatStatus = "open" | "applied" | "closed";

/** Chế độ gửi tin. */
export type GroupChatMode = "discuss" | "plan";

export interface GroupConversationDto {
  conversation_id: string;
  group_id: string;
  title: string;
  status: GroupChatStatus;
  /** ISO 8601 UTC (`Z`). */
  created_at: string;
}

/** Gợi ý người làm kèm trong bản nháp (AI chỉ trả `user_id`). */
export interface GroupDraftAssigneeDto {
  user_id: string | null;
  fits: boolean | null;
  reason: string;
}

export interface GroupDraftSubTaskDto {
  title: string;
  estimated_minutes: number | null;
  reason: string | null;
}

export interface GroupDraftTaskDto {
  /**
   * `key` của AI — có thể `null` (schema `TaskResponse.key` là nullable).
   * FE tự sinh key thay thế nếu AI không trả về.
   */
  key: string | null;
  title: string;
  domain_id: string | null;
  domain_name: string | null;
  estimated_minutes: number | null;
  reason: string | null;
  subtasks: GroupDraftSubTaskDto[];
  suggested_assignee: GroupDraftAssigneeDto | null;
}

export interface GroupDraftMilestoneDto {
  /** `key` của AI — có thể `null` (schema `MilestoneResponse.key` là nullable). */
  key: string | null;
  title: string;
  /** Ngày `YYYY-MM-DD` — schema cho phép `null`. */
  deadline: string | null;
  reason: string | null;
  tasks: GroupDraftTaskDto[];
}

/**
 * Bản nháp kế hoạch do AI trả về.
 *
 * ⚠️ Schema `groups.DraftResponse` của AI service **KHÔNG có** `message_id`
 * (chỉ có `milestones`, `reminders`, `warnings`, `total_estimated_minutes`).
 * `message_id` cần cho bước `/applied` phải lấy từ **tin nhắn AI** chứa bản
 * nháp (`GroupChatMessageDto.message_id`).
 *
 * Trường `message_id` ở đây là **tuỳ chọn** để chịu được cả 2 biến thể.
 */
export interface GroupDraftDto {
  message_id?: string;
  milestones: GroupDraftMilestoneDto[];
  reminders: string[];
  warnings: string[];
  total_estimated_minutes: number;
}

/** Checklist 4 khối khi AI trả lời ở chế độ `discuss`. */
export interface GroupChatNotesDto {
  clear: string[];
  missing: string[];
  questions: string[];
  risks: string[];
  /** `true` → nổi nút "Lên kế hoạch" (Leader vẫn bấm được khi `false`). */
  ready_to_plan: boolean;
}

export interface GroupChatMessageDto {
  message_id: string;
  role: "user" | "assistant";
  content: string;
  /** ISO 8601 UTC. */
  created_at: string;
  /** Có khi AI trả lời `discuss`. */
  notes: GroupChatNotesDto | null;
  /** Có khi AI trả lời `plan`. */
  draft: GroupDraftDto | null;
  /** `true` = bản nháp đã áp dụng → ẩn/khóa nút Áp dụng. */
  is_applied: boolean;
}

export interface GroupChatDto {
  conversation: GroupConversationDto;
  /** Cũ → mới. */
  messages: GroupChatMessageDto[];
}

export interface GroupChatTurnDto {
  conversation_id: string;
  user_message: GroupChatMessageDto;
  ai_message: GroupChatMessageDto;
}

/** `POST /groups/{groupId}/chats` — tạo chat mới. */
export async function createGroupChat(
  groupId: string,
  body: { title?: string | null; language?: "vi" | "en" } = {},
): Promise<ApiResult<GroupConversationDto>> {
  if (!groupId) {
    return { ok: false, status: 0, error: "Missing group id." };
  }
  return aiFetch<GroupConversationDto>(
    `/groups/${encodeURIComponent(groupId)}/chats`,
    {
      method: "POST",
      body: JSON.stringify({
        title: body.title ?? null,
        language: body.language ?? "vi",
      }),
    },
  );
}

/** `GET /groups/{groupId}/chats` — danh sách chat của nhóm (mới nhất trước). */
export async function listGroupChats(
  groupId: string,
): Promise<ApiResult<GroupConversationDto[]>> {
  if (!groupId) {
    return { ok: false, status: 0, error: "Missing group id." };
  }
  return aiFetch<GroupConversationDto[]>(
    `/groups/${encodeURIComponent(groupId)}/chats`,
    { method: "GET" },
  );
}

/** `GET /groups/chats/{chatId}` — toàn bộ tin nhắn (kể cả bản nháp cũ). */
export async function getGroupChat(
  chatId: string,
): Promise<ApiResult<GroupChatDto>> {
  if (!chatId) {
    return { ok: false, status: 0, error: "Missing chat id." };
  }
  return aiFetch<GroupChatDto>(`/groups/chats/${encodeURIComponent(chatId)}`, {
    method: "GET",
  });
}

/**
 * `POST /groups/chats/{chatId}/messages`
 *
 * - `discuss`: bàn brief, hỏi AI. `text` **bắt buộc**, ≤ 4000 ký tự.
 * - `plan`   : nút "Lên kế hoạch" / yêu cầu sửa bản nháp. `text` có thể `""`.
 *
 * Mỗi tin gửi = **1 lượt AI** của Leader (chỉ trừ khi AI trả lời được).
 */
export async function sendGroupChatMessage(
  chatId: string,
  body: { text: string; mode: GroupChatMode },
): Promise<ApiResult<GroupChatTurnDto>> {
  if (!chatId) {
    return { ok: false, status: 0, error: "Missing chat id." };
  }
  const text = (body.text ?? "").trim();
  if (body.mode === "discuss" && !text) {
    return {
      ok: false,
      status: 0,
      error: "Write a brief or a question before sending.",
    };
  }
  if (text.length > 4000) {
    return {
      ok: false,
      status: 0,
      error: "Your message is too long. Please keep it under 4000 characters.",
    };
  }
  return aiFetch<GroupChatTurnDto>(
    `/groups/chats/${encodeURIComponent(chatId)}/messages`,
    {
      method: "POST",
      body: JSON.stringify({ text, mode: body.mode }),
    },
  );
}

/**
 * `POST /groups/chats/{chatId}/messages/{messageId}/applied`
 *
 * Đánh dấu bản nháp đã áp dụng → khóa nút Áp dụng. AI service trả `204`.
 * `409 already_applied` = đã áp dụng ở tab/máy khác.
 */
export async function markGroupDraftApplied(
  chatId: string,
  messageId: string,
): Promise<ApiResult<void>> {
  if (!chatId || !messageId) {
    return { ok: false, status: 0, error: "Missing chat id or message id." };
  }
  return aiFetch<void>(
    `/groups/chats/${encodeURIComponent(chatId)}/messages/${encodeURIComponent(
      messageId,
    )}/applied`,
    { method: "POST" },
  );
}
