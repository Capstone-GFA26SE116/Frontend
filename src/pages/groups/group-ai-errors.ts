/* ===========================================================
 * Dịch lỗi của AI service (nhóm) thành thông điệp tiếng Anh
 * ===========================================================
 *
 * Vì sao cần module riêng:
 *  - AI service trả lỗi theo kiểu FastAPI: `{ "detail": "..." }` hoặc
 *    `{ "detail": { "code": "plan_feature_locked", ... } }` — **khác** hẳn
 *    Backend (`{ "code": ..., "details": ... }`).
 *  - `api-client` đã có `translateAiError` nhưng dùng chung cho chat dự án,
 *    nhiều thông điệp tiếng Việt và chưa có mã riêng của nhóm.
 *  - Người dùng cần thông báo **rõ ràng, bằng tiếng Anh**, kèm gợi ý hành
 *    động tiếp theo (nâng cấp / thử lại / hỏi Leader).
 *
 * Bảng mã lỗi: `GROUP_AI_FE.md` mục 0.
 * =========================================================== */

import type { ApiErr } from "../../lib/api-client";

/** Mức độ nghiêm trọng → màu + icon của hộp thoại. */
export type GroupAiErrorTone = "error" | "warning" | "info";

export interface GroupAiErrorView {
  /** Tiêu đề ngắn, dạng câu, tiếng Anh. */
  title: string;
  /** Giải thích cụ thể vì sao lỗi xảy ra. */
  message: string;
  /** Gợi ý hành động tiếp theo (có thể rỗng). */
  hint: string;
  tone: GroupAiErrorTone;
  /** Mã lỗi kỹ thuật để tra cứu (có thể rỗng). */
  code: string;
  /** HTTP status, 0 nếu lỗi mạng. */
  status: number;
  /**
   * `true` → nên hiện nút "Nâng cấp" (gói Free dùng chat nhóm).
   * `true` → nên hiện nút "Thử lại" (AI lỗi 502 / 429).
   */
  showUpgrade: boolean;
  showRetry: boolean;
}

/* ===========================================================
 * Bảng ánh xạ theo mã lỗi
 * =========================================================== */

interface GroupAiErrorPreset {
  title: string;
  message: string;
  hint: string;
  tone: GroupAiErrorTone;
  showUpgrade?: boolean;
  showRetry?: boolean;
}

const PRESETS: Record<string, GroupAiErrorPreset> = {
  /* Gói Free dùng chat nhóm → cần nâng cấp. */
  plan_feature_locked: {
    title: "Group AI chat is part of a higher plan",
    message:
      "Your current plan doesn't include the AI planning chat for groups. Upgrade to Pro or Premium to plan work with AI together.",
    hint: "Upgrade your plan to unlock group AI planning.",
    tone: "warning",
    showUpgrade: true,
  },
  /* Không có gói đang hoạt động. */
  no_active_plan: {
    title: "You don't have an active plan",
    message:
      "Group AI features need an active subscription. Your plan may have expired or been cancelled.",
    hint: "Choose a plan to continue using AI features.",
    tone: "warning",
    showUpgrade: true,
  },
  /* Bản nháp đã áp dụng ở nơi khác. */
  already_applied: {
    title: "This plan was already applied",
    message:
      "Someone already applied this draft, so it can't be applied a second time. Reload the chat to see the result.",
    hint: "Reload the chat to see what was created.",
    tone: "info",
  },
  /* Bản nháp không còn là bản mới nhất. */
  not_latest_draft: {
    title: "There's a newer plan draft",
    message:
      "You've made changes since this draft was created, so it can no longer be applied. Reload the chat to get the latest draft.",
    hint: "Reload the chat and apply the most recent draft.",
    tone: "info",
  },
  /* Nhóm đã lưu trữ. */
  group_archived: {
    title: "This group is archived",
    message:
      "Archived groups are read-only, so AI planning and suggestions are turned off.",
    hint: "Restore the group if you want to keep working on it.",
    tone: "warning",
  },
  /* Việc đã xong / bị bỏ qua. */
  task_closed: {
    title: "This task is already finished",
    message:
      "AI suggestions are only available for tasks that are still To Do or In Progress.",
    hint: "Pick a task that's still open.",
    tone: "warning",
  },
  /* AI lỗi tạm thời — KHÔNG bị trừ lượt. */
  llm_failed: {
    title: "AI is having trouble right now",
    message:
      "The AI service couldn't produce a response this time. Your request wasn't counted against your AI allowance.",
    hint: "Try again in a moment.",
    tone: "error",
    showRetry: true,
  },
};

/* ===========================================================
 * Ánh xạ theo HTTP status
 * =========================================================== */

const STATUS_PRESETS: Record<number, GroupAiErrorPreset> = {
  401: {
    title: "Your session has expired",
    message:
      "You need to sign in again before using AI features for this group.",
    hint: "Sign in again and reload the page.",
    tone: "error",
  },
  403: {
    title: "Only group leaders can use this",
    message:
      "You're a member of this group, but AI planning and assignee suggestions are limited to group leaders.",
    hint: "Ask a group leader to run this for you.",
    tone: "warning",
  },
  404: {
    title: "We couldn't find that",
    message:
      "The task, group or chat doesn't exist, or you're no longer a member of the group that owns it.",
    hint: "Reload the page — you may have been removed from the group.",
    tone: "error",
  },
  409: {
    title: "This conflicts with the group's current state",
    message:
      "The group or task changed since this page loaded, so the AI couldn't continue.",
    hint: "Reload the page and try again.",
    tone: "warning",
  },
  422: {
    title: "Some of the details aren't valid",
    message: "One or more fields were rejected by the server.",
    hint: "Check your message and try again.",
    tone: "error",
  },
  429: {
    title: "You've used all your AI credits",
    message:
      "Your plan's AI allowance is used up for this period, so the AI can't run right now.",
    hint: "Upgrade your plan for more AI credits, or wait for the next period.",
    tone: "warning",
    showUpgrade: true,
  },
  500: {
    title: "Something went wrong on our side",
    message:
      "The server ran into an unexpected problem while handling your request.",
    hint: "Wait a moment and try again.",
    tone: "error",
    showRetry: true,
  },
  502: {
    title: "AI is busy right now",
    message:
      "The AI service couldn't answer this time. Your request wasn't counted against your AI allowance.",
    hint: "Try again in a moment.",
    tone: "error",
    showRetry: true,
  },
  503: {
    title: "The AI service is temporarily unavailable",
    message:
      "The service is restarting or too busy to handle requests right now.",
    hint: "Wait a few seconds and try again.",
    tone: "error",
    showRetry: true,
  },
};

/** Lỗi mạng (fetch throw) — không có HTTP status. */
const NETWORK_PRESET: GroupAiErrorPreset = {
  title: "Can't reach the AI service",
  message:
    "We couldn't connect to the AI service. Your changes may not have been saved.",
  hint: "Check your internet connection and try again.",
  tone: "error",
  showRetry: true,
};

/* ===========================================================
 * Hàm chính
 * =========================================================== */

/**
 * Đổi lỗi từ AI service thành thông điệp tiếng Anh dễ hiểu.
 *
 * @param err Kết quả lỗi từ `aiFetch` (có `status`, `errorCode`).
 */
export function toGroupAiErrorView(err: ApiErr | undefined): GroupAiErrorView {
  const status = err?.status ?? 0;
  const code = err?.errorCode ?? "";

  const preset =
    (code && PRESETS[code]) || (status ? STATUS_PRESETS[status] : undefined);

  if (!preset) {
    return {
      title: NETWORK_PRESET.title,
      message: NETWORK_PRESET.message,
      hint: NETWORK_PRESET.hint,
      tone: NETWORK_PRESET.tone,
      code,
      status,
      showUpgrade: false,
      showRetry: true,
    };
  }

  return {
    title: preset.title,
    message: preset.message,
    hint: preset.hint,
    tone: preset.tone,
    code,
    status,
    showUpgrade: preset.showUpgrade === true,
    showRetry: preset.showRetry === true,
  };
}

/**
 * Nhãn cho `reasons_skipped` — AI không viết được lý do.
 *
 * - `quota`     → hết lượt AI / không có gói.
 * - `llm_failed`→ AI lỗi tạm thời.
 */
export function reasonsSkippedNote(code: string | null | undefined): string {
  if (code === "quota") {
    return "No AI credits left, so the ranking came without written reasons.";
  }
  if (code === "llm_failed") {
    return "The AI service failed temporarily, so the ranking came without written reasons.";
  }
  return "";
}

/**
 * Thông điệp riêng cho `409` khi nhóm đã lưu trữ / việc đã xong.
 *
 * AI service trả `409` với `detail` dạng chuỗi, FE đọc `err.error`.
 */
export function archivedOrClosedMessage(err: ApiErr | undefined): string {
  const raw = (err?.error ?? "").toLowerCase();
  if (raw.includes("archiv")) {
    return "This group is archived, so AI features are turned off. Restore the group to use them.";
  }
  if (raw.includes("done") || raw.includes("skipped") || raw.includes("closed")) {
    return "This task is already finished, so AI suggestions aren't available. Pick a task that's still open.";
  }
  return "";
}
