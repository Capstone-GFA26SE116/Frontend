/**
 * ===========================================================
 * Dịch lỗi API của Project Detail thành thông điệp tiếng Anh dễ hiểu.
 * ===========================================================
 *
 * Vì sao cần:
 *  - BE trả `message` kỹ thuật (VD: "MILESTONE_HAS_OPEN_TASKS") hoặc lỗi
 *    tiếng Việt. Đưa thẳng ra UI thì người dùng không hiểu mình sai ở đâu.
 *  - Mỗi lỗi cần 1 "hành động gợi ý" riêng: 409 thì cần xử lý xung đột,
 *    400 thì cần sửa dữ liệu, 403 thì cần nâng quyền.
 *
 * Cấu trúc 1 lỗi:
 *  - `title`   : tiêu đề ngắn, dạng câu (VD: "We couldn't find that milestone")
 *  - `message` : giải thích cụ thể vì sao lỗi xảy ra
 *  - `hint`    : người dùng nên làm gì tiếp theo
 *  - `tone`    : `error` | `warning` | `info` để chọn màu/icon
 */

import type { ApiErr } from "../../lib/api-client";

/** Mức độ nghiêm trọng quyết định màu + icon của hộp thoại. */
export type ProjectErrorTone = "error" | "warning" | "info";

export interface ProjectErrorView {
  /** Tiêu đề, tiếng Anh, dạng câu. */
  title: string;
  /** Giải thích cụ thể. */
  message: string;
  /** Gợi ý hành động tiếp theo (có thể rỗng). */
  hint: string;
  tone: ProjectErrorTone;
  /** Mã lỗi kỹ thuật của BE (để tra cứu), có thể rỗng. */
  code: string;
  /** HTTP status, 0 nếu không xác định (lỗi mạng). */
  status: number;
}

/* ===========================================================
 * Bảng ánh xạ theo mã lỗi của BE
 * =========================================================== */

interface ProjectErrorPreset {
  title: string;
  message: string;
  hint: string;
  tone: ProjectErrorTone;
}

/**
 * Mã lỗi kỹ thuật → thông điệp tiếng Anh.
 *
 * - `MILESTONE_HAS_OPEN_TASKS` : 409, chuyển giai đoạn sang Delivered khi
 *   còn việc dở.
 * - `PROJECT_ARCHIVED`         : 409/400, project đã archive → không sửa được.
 * - `PROJECT_NOT_FOUND`        : 404.
 * - `VALIDATION_ERROR`         : 422, dữ liệu không hợp lệ.
 */
const PRESETS: Record<string, ProjectErrorPreset> = {
  MILESTONE_HAS_OPEN_TASKS: {
    title: "This milestone still has unfinished work",
    message:
      "A milestone can only be marked as Delivered once every task inside it is done or skipped.",
    hint: "Finish the remaining tasks first, or change the status to something else.",
    tone: "warning",
  },
  PROJECT_ARCHIVED: {
    title: "This project is archived",
    message:
      "Archived projects are read-only, so their milestones, tasks and subtasks can't be changed.",
    hint: "Restore the project from the Projects page, then try again.",
    tone: "warning",
  },
  PROJECT_NOT_FOUND: {
    title: "We couldn't find that project",
    message:
      "The project doesn't exist, or it was deleted after you opened this page.",
    hint: "Go back to the Projects list and open it again.",
    tone: "error",
  },
  TASK_NOT_FOUND: {
    title: "We couldn't find that task",
    message:
      "The task doesn't exist any more — it may have been deleted in another session.",
    hint: "Refresh the page to see the current list of tasks.",
    tone: "error",
  },
  MILESTONE_NOT_FOUND: {
    title: "We couldn't find that milestone",
    message:
      "The milestone doesn't exist any more — it may have been deleted in another session.",
    hint: "Refresh the page to see the current list of milestones.",
    tone: "error",
  },
  VALIDATION_ERROR: {
    title: "Some of the details aren't valid",
    message:
      "One or more fields were rejected by the server, so your change wasn't saved.",
    hint: "Check the values you entered and try again.",
    tone: "error",
  },
  DUPLICATE_ENTITY: {
    title: "That already exists",
    message:
      "Another milestone or task with the same details is already in this project.",
    hint: "Rename the item or adjust its details so it's unique.",
    tone: "warning",
  },
};

/* ===========================================================
 * Ánh xạ theo HTTP status (khi BE không trả mã kỹ thuật)
 * =========================================================== */

const STATUS_PRESETS: Record<number, ProjectErrorPreset> = {
  400: {
    title: "That action isn't allowed right now",
    message:
      "The request broke one of the project's rules, so it wasn't applied. Nothing was changed.",
    hint: "Check the details below and adjust the request before trying again.",
    tone: "error",
  },
  401: {
    title: "Your session has expired",
    message: "You've been signed out, so we couldn't save your change.",
    hint: "Log in again and retry.",
    tone: "warning",
  },
  403: {
    title: "You don't have permission to do that",
    message:
      "Your account doesn't have permission to change this project, its milestones or tasks.",
    hint: "Ask the project owner to make this change for you.",
    tone: "warning",
  },
  404: {
    title: "We couldn't find that",
    message:
      "The item doesn't exist, or it was deleted after you opened this page.",
    hint: "Refresh the page to see the current data.",
    tone: "error",
  },
  409: {
    title: "This conflicts with something else",
    message:
      "Someone else changed this at the same time, or the change conflicts with existing data.",
    hint: "Reload the page and try again.",
    tone: "warning",
  },
  422: {
    title: "Some of the details aren't valid",
    message: "One or more fields were rejected by the server.",
    hint: "Correct the highlighted details and try again.",
    tone: "error",
  },
  500: {
    title: "Something went wrong on our side",
    message:
      "The server ran into an unexpected problem while handling your request.",
    hint: "Wait a moment and try again. If it keeps happening, contact support.",
    tone: "error",
  },
  503: {
    title: "The service is temporarily unavailable",
    message:
      "The server is restarting or too busy to handle requests right now.",
    hint: "Wait a few seconds and try again.",
    tone: "error",
  },
};

/** Lỗi mạng (fetch throw) — không có HTTP status. */
const NETWORK_PRESET: ProjectErrorPreset = {
  title: "Can't reach the server",
  message:
    "We couldn't connect to METANOIA. Your changes may not have been saved.",
  hint: "Check your internet connection and try again.",
  tone: "error",
};

/* ===========================================================
 * Công cụ đọc an toàn
 * =========================================================== */

function asRecord(v: unknown): Record<string, unknown> | null {
  if (!v || typeof v !== "object") return null;
  return v as Record<string, unknown>;
}

/** Lấy mã lỗi kỹ thuật từ body lỗi (BE có thể trả ở nhiều chỗ). */
function readCode(body: unknown): string {
  const rec = asRecord(body);
  if (!rec) return "";
  for (const k of ["code", "errorCode", "error_code"]) {
    const v = rec[k];
    if (typeof v === "string" && /^[A-Z][A-Z0-9_]{2,}$/.test(v.trim())) {
      return v.trim();
    }
  }
  return "";
}

/**
 * Đọc `message` từ body lỗi, nhưng **không** dùng nó làm thông điệp chính —
 * chỉ để hiển thị ở dòng "Server details" cho người có quyền tra cứu.
 */
function readRawMessage(body: unknown): string {
  const rec = asRecord(body);
  if (!rec) return "";
  for (const k of ["message", "detail", "title", "reason", "error"]) {
    const v = rec[k];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return "";
}

/* ===========================================================
 * Hàm chính
 * =========================================================== */

/**
 * Đổi một lỗi API thành thông điệp tiếng Anh dễ hiểu.
 *
 * @param err   Kết quả lỗi từ `api-client` (còn `status`, `errorCode`).
 * @param body  Body lỗi gốc của BE (nếu có) — dùng để đọc message/mã chi tiết.
 * @param opts  `action` là nhãn hành động ngắn (VD: "delete this task") để
 *              ghép câu cho đúng ngữ cảnh.
 */
export function toProjectErrorView(
  err: ApiErr | undefined,
  body?: unknown,
  opts?: {
    /** Động từ ngắn mô tả thao tác đang thực hiện. */
    action?: string;
  },
): ProjectErrorView {
  const status = err?.status ?? 0;
  const code = err?.errorCode ?? readCode(body);

  // Ưu tiên mã kỹ thuật, sau đó tới status.
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
    };
  }

  const action = opts?.action;
  let message = preset.message;
  if (action) {
    message = `${capitalize(action)}: ${lowerFirst(preset.message)}`;
  }

  return {
    title: preset.title,
    message,
    hint: preset.hint,
    tone: preset.tone,
    code,
    status,
  };
}

/**
 * Thông điệp thô của BE — hiển thị ở dòng "Server details" nhỏ ở cuối hộp thoại.
 * Giữ nguyên để người có quyền tra cứu, không dùng làm thông điệp chính.
 */
export function rawServerMessage(
  err: ApiErr | undefined,
  body?: unknown,
): string {
  return readRawMessage(body) || err?.error || "";
}

/* ===========================================================
 * Helper
 * =========================================================== */

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function lowerFirst(s: string): string {
  return s.charAt(0).toLowerCase() + s.slice(1);
}
