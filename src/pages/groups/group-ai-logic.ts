/* ===========================================================
 * Logic cho tab "Chat AI" của nhóm
 * ===========================================================
 *
 * Spec: `GROUP_AI_FE.md` mục 2.
 *
 * Vai trò:
 *  - Chuẩn hoá dữ liệu AI (snake_case) → state cho UI.
 *  - Tính deadline ISO của việc (23:59 giờ Việt Nam) khi áp dụng.
 *  - Chuẩn bị danh sách việc để tạo từ Backend.
 */

import type {
  GroupChatMessageDto,
  GroupDraftDto,
  GroupDraftMilestoneDto,
  GroupDraftSubTaskDto,
  GroupDraftTaskDto,
} from "../../lib/group-ai-api";

/* ===========================================================
 * Ngôn ngữ
 * =========================================================== */

/** Ngôn ngữ dùng cho câu lý do của AI. */
export type GroupAiLanguage = "vi" | "en";

/**
 * Ngôn ngữ lý do nên dùng.
 *
 * Mặc định `vi` (theo spec) — nhưng nếu giao diện đang hiển thị tiếng Anh
 * thì `en` hợp lý hơn. Ở đây giữ `vi` theo mặc định của BE, và cho phép
 * đổi qua tham số.
 */
export const DEFAULT_GROUP_AI_LANGUAGE: GroupAiLanguage = "vi";

/* ===========================================================
 * Deadline
 * =========================================================== */

/**
 * Đổi ngày `YYYY-MM-DD` + giờ → ISO 8601 kèm offset `+07:00` (giờ VN).
 *
 * Spec mục 2.6 bước 3: deadline của việc = `<milestone.deadline> 23:59`
 * giờ Việt Nam, dạng ISO, ví dụ `2026-11-25T23:59:00+07:00`.
 */
export function toVietnamDeadline(dateStr: string): string {
  const m = dateStr.trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return `${dateStr}T23:59:00+07:00`;
  return `${m[1]}-${m[2]}-${m[3]}T23:59:00+07:00`;
}

/** Ngày `YYYY-MM-DD` → "25 Nov 2026". */
export function fmtDeadline(dateStr: string): string {
  const m = dateStr.trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return dateStr;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  if (Number.isNaN(d.getTime())) return dateStr;
  return d.toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

/* ===========================================================
 * Phút → text
 * =========================================================== */

/** Số phút → "2h" / "45m" / "2h 30m". */
export function fmtMinutes(min: number | null | undefined): string {
  if (min == null || !Number.isFinite(min)) return "—";
  const total = Math.max(0, Math.round(min));
  if (total < 60) return `${total}m`;
  const h = Math.floor(total / 60);
  const m = total % 60;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

/* ===========================================================
 * Bản nháp chỉnh sửa được
 * =========================================================== */

/** Một việc con trong bản nháp — Leader có thể sửa tên / ước lượng. */
export interface EditableSubTask {
  title: string;
  estimatedMinutes: string;
  reason: string | null;
}

/** Một việc trong bản nháp. */
export interface EditableTask {
  included?: boolean;
  key: string;
  title: string;
  domainName: string | null;
  estimatedMinutes: string;
  reason: string | null;
  subtasks: EditableSubTask[];
  /** Người được gợi ý (mặc định khi mở form). */
  suggestedAssigneeId: string | null;
  /** Người Leader đang chọn (có thể khác gợi ý). */
  assigneeId: string | null;
  /** `true` đủ giờ · `false` có thể không đủ · `null` chưa có ước lượng. */
  fits: boolean | null;
  /** Lý do AI viết. */
  assigneeReason: string;
}

/** Một giai đoạn trong bản nháp. */
export interface EditableMilestone {
  key: string;
  title: string;
  deadline: string;
  reason: string | null;
  tasks: EditableTask[];
}

/** Bản nháp đã chuẩn hoá để Leader sửa trước khi áp dụng. */
export interface EditableDraft {
  messageId: string;
  milestones: EditableMilestone[];
  reminders: string[];
  warnings: string[];
  totalEstimatedMinutes: number;
  /** `true` = bản nháp đã áp dụng → khóa nút. */
  applied: boolean;
}

/**
 * Chuyển bản nháp của AI → dạng editable.
 *
 * ⚠️ `messageId` phải lấy từ **tin nhắn AI** (`MessageResponse.message_id`),
 * KHÔNG phải từ `draft.message_id`.
 *
 * Lý do: schema `groups.DraftResponse` của AI service **không có** trường
 * `message_id` (chỉ có `milestones`, `reminders`, `warnings`,
 * `total_estimated_minutes`) — khác với `ProjectDraftResponse` của chat dự án.
 * Nếu đọc `draft.message_id` thì ra `undefined`, và bước cuối
 * `POST /groups/chats/{chatId}/messages/{messageId}/applied` sẽ không chạy
 * → bản nháp không khoá được, và Leader bấm "Apply" lần nữa sẽ tạo trùng.
 *
 * @param draft Bản nháp do AI trả.
 * @param isApplied Tin nhắn AI đã đánh dấu áp dụng chưa.
 * @param messageId `message_id` của tin nhắn AI chứa bản nháp.
 */
export function toEditableDraft(
  draft: GroupDraftDto,
  isApplied: boolean,
  messageId?: string | null,
): EditableDraft {
  return {
    messageId: messageId || draft.message_id || "",
    milestones: draft.milestones.map((ms, i) => toEditableMilestone(ms, i)),
    reminders: [...(draft.reminders ?? [])],
    warnings: [...(draft.warnings ?? [])],
    totalEstimatedMinutes: draft.total_estimated_minutes ?? 0,
    applied: isApplied,
  };
}

function toEditableMilestone(
  ms: GroupDraftMilestoneDto,
  mi: number,
): EditableMilestone {
  return {
    /* AI có thể không trả `key` → tự sinh để các bản ghi "đã tạo" khớp. */
    key: ms.key || `ms-${mi}`,
    title: ms.title,
    deadline: ms.deadline ?? "",
    reason: ms.reason,
    tasks: (ms.tasks ?? []).map((t, i) => toEditableTask(t, i)),
  };
}

function toEditableTask(task: GroupDraftTaskDto, ti: number): EditableTask {
  const suggested = task.suggested_assignee?.user_id ?? null;
  return {
    key: task.key || `t-${ti}`,
    title: task.title,
    domainName: task.domain_name ?? null,
    estimatedMinutes:
      task.estimated_minutes == null ? "" : String(task.estimated_minutes),
    reason: task.reason,
    subtasks: (task.subtasks ?? []).map(toEditableSubTask),
    suggestedAssigneeId: suggested,
    assigneeId: suggested,
    fits: task.suggested_assignee?.fits ?? null,
    assigneeReason: task.suggested_assignee?.reason ?? "",
  };
}

function toEditableSubTask(st: GroupDraftSubTaskDto): EditableSubTask {
  return {
    title: st.title,
    estimatedMinutes:
      st.estimated_minutes == null ? "" : String(st.estimated_minutes),
    reason: st.reason,
  };
}

/* ===========================================================
 * Tìm bản nháp mới nhất trong lịch sử chat
 * =========================================================== */

/**
 * Lấy bản nháp AI **mới nhất** trong danh sách tin nhắn.
 *
 * `GET /groups/chats/{id}` trả tin nhắn cũ → mới. Bản nháp là tin của AI
 * có `draft != null`. Nếu bản nháp đó đã áp dụng (`is_applied`) thì vẫn trả
 * về — UI hiển thị chip "Applied" và khóa nút.
 *
 * ⚠️ KHÔNG lọc theo `role` — chỉ cần `draft != null` là đủ, vì chỉ tin của
 * AI mới mang bản nháp. So sánh `role === "assistant"` quá chặt: nếu AI
 * service đổi cách viết role (VD "AI", "ai", "bot") thì FE sẽ không nhận
 * ra bản nháp → chỉ hiện bản xem trước, mất nút Sửa / Áp dụng.
 *
 * ⚠️ BỎ QUA bản nháp RỖNG (`milestones: []`): đây là trường hợp AI được
 * yêu cầu "cập nhật kế hoạch" nhưng không sinh lại được cấu trúc. Nếu lấy
 * bản nháp rỗng thì thẻ Sửa/Áp dụng sẽ trống không, còn bản nháp đầy đủ
 * ở tin trước đó lại bị đẩy xuống dạng preview chỉ đọc.
 */
export function findLatestDraft(
  messages: GroupChatMessageDto[],
): { message: GroupChatMessageDto; draft: GroupDraftDto } | null {
  /*
   * Ưu tiên tin mang bản nháp ĐẦY ĐỦ (có milestone) — đó là bản nháp mà
   * Leader có thể sửa / áp dụng.
   *
   * ⚠️ Nếu không có tin nào có milestone (AI trả `draft` rỗng), ta vẫn trả
   * về tin mang bản nháp cuối cùng. Lý do: `DraftCard` tự hiện thông báo
   * "The plan came back empty." + nút "Generate plan again" — hữu ích hơn
   * việc im lặng. Nhưng KHÔNG được dùng bản nháp rỗng làm "bản nháp mới
   * nhất" khi vẫn còn bản nháp đầy đủ ở tin trước đó — nếu không thì bản
   * nháp đầy đủ bị đẩy xuống dạng preview chỉ đọc và mất nút Áp dụng.
   */
  let emptyFallback: {
    message: GroupChatMessageDto;
    draft: GroupDraftDto;
  } | null = null;

  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (!m.draft) continue;
    if ((m.draft.milestones?.length ?? 0) > 0) {
      return { message: m, draft: m.draft };
    }
    /* Bản nháp rỗng — nhớ lại để dùng làm fallback nếu không có bản đầy đủ. */
    if (!emptyFallback) emptyFallback = { message: m, draft: m.draft };
  }
  return emptyFallback;
}

/* ===========================================================
 * Áp dụng bản nháp
 * =========================================================== */

/** Kết quả chuẩn bị body áp dụng cho 1 việc. */
export interface ApplyTaskPlan {
  /** Key của việc trong bản nháp (để đối chiếu khi báo lỗi giữa chừng). */
  key: string;
  milestoneKey: string;
  title: string;
  estimatedMinutes: number | null;
  assigneeId: string | null;
  subtasks: { title: string; estimatedMinutes: number | null }[];
}

/** Một mục đã tạo thành công — dùng để "Thử lại phần còn lại". */
export interface ApplyCreatedItem {
  milestoneKey: string;
  taskKey: string;
  milestoneId: string;
  taskId: string;
  subtaskIds: string[];
}

/**
 * Chuẩn bị danh sách việc cần tạo từ bản nháp đã sửa.
 *
 * Gọi **tuần tự** (không song song) để tránh trùng `orderIndex` — theo
 * spec mục 2.6.
 */
export function buildApplyPlans(
  draft: EditableDraft,
): { milestones: EditableMilestone[]; tasks: ApplyTaskPlan[] } {
  const tasks: ApplyTaskPlan[] = [];
  for (const ms of draft.milestones) {
    for (const t of ms.tasks) {
      tasks.push({
        key: t.key,
        milestoneKey: ms.key,
        title: t.title.trim(),
        estimatedMinutes: parseMinutes(t.estimatedMinutes),
        assigneeId: t.assigneeId || null,
        subtasks: t.subtasks
          .filter((s) => s.title.trim())
          .map((s) => ({
            title: s.title.trim(),
            estimatedMinutes: parseMinutes(s.estimatedMinutes),
          })),
      });
    }
  }
  return { milestones: draft.milestones, tasks };
}

/** `""` → `null`; `"90"` → `90`. */
export function parseMinutes(v: string): number | null {
  const trimmed = v.trim();
  if (!trimmed) return null;
  const n = Number(trimmed);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n);
}

/**
 * Kiểm tra bản nháp có hợp lệ để áp dụng không.
 *
 * Trả về danh sách lỗi (tiếng Anh) theo từng việc — rỗng = hợp lệ.
 */
export function validateDraft(draft: EditableDraft): string[] {
  const problems: string[] = [];
  for (const ms of draft.milestones) {
    if (!ms.title.trim()) {
      problems.push("Nhập tên cho cột mốc.");
    }
    if (!ms.deadline) {
      problems.push(`Nhập hạn cho cột mốc “${ms.title || "chưa đặt tên"}”.`);
    }
    if (ms.tasks.length === 0) {
      problems.push(`Cột mốc “${ms.title}” cần ít nhất một việc.`);
    }
    for (const t of ms.tasks) {
      if (!t.title.trim()) {
        problems.push("Nhập tên cho từng công việc.");
      }
    }
  }
  if (draft.milestones.length === 0) {
    problems.push("Chọn ít nhất một việc để lưu.");
  }
  return problems;
}
