/**
 * ===========================================================
 * Dịch lỗi của nhóm (BE) thành thông điệp dễ hiểu — tiếng Anh.
 * ===========================================================
 *
 * Vì sao cần:
 *  - BE trả `message` tiếng Việt/kỹ thuật (VD: "Member không đổi tay được").
 *    Đưa thẳng ra UI thì người dùng không hiểu mình sai ở đâu.
 *  - Mỗi mã lỗi có một "hành động gợi ý" khác nhau: 403 thì cần nâng
 *    quyền, 400 thì cần sửa dữ liệu, 409 thì cần xác nhận.
 *
 * Nguồn: `GROUP_FE.md` mục 1 (bảng mã lỗi), mục 7 (focus), mục 8 (giao việc),
 * mục 9 (đề xuất đổi giờ).
 *
 * Cấu trúc 1 lỗi:
 *  - `title`   : tiêu đề ngắn, dạng câu (VD: "You don't have permission to do that")
 *  - `message` : giải thích cụ thể vì sao lỗi xảy ra
 *  - `hint`    : người dùng nên làm gì tiếp theo
 *  - `tone`    : `error` | `warning` | `info` để chọn màu/icon
 */

import type { ApiErr } from "../../lib/api-client";

/** Mức độ nghiêm trọng quyết định màu + icon của hộp thoại. */
export type GroupErrorTone = "error" | "warning" | "info";

export interface GroupErrorView {
  /** Tiêu đề, tiếng Anh, dạng câu. */
  title: string;
  /** Giải thích cụ thể. */
  message: string;
  /** Gợi ý hành động tiếp theo (có thể rỗng). */
  hint: string;
  tone: GroupErrorTone;
  /** Mã lỗi kỹ thuật của BE (để tra cứu), có thể rỗng. */
  code: string;
  /** HTTP status, 0 nếu không xác định (lỗi mạng). */
  status: number;
}

/* ===========================================================
 * Bảng ánh xạ theo mã lỗi của BE
 * =========================================================== */

interface GroupErrorPreset {
  title: string;
  message: string;
  hint: string;
  tone: GroupErrorTone;
}

/**
 * Mã lỗi kỹ thuật → thông điệp tiếng Anh.
 *
 * - `GROUP_FORBIDDEN`            : 403, trong nhóm nhưng thiếu quyền.
 * - `MILESTONE_HAS_OPEN_TASKS`   : 409, chuyển giai đoạn sang Delivered khi còn việc dở.
 * - `GROUP_ASSIGNEE_BUSY`        : 409, người nhận bận / quá tải.
 * - `FOCUS_SESSION_CONFLICT`     : 409, đã có phiên bấm giờ khác đang chạy.
 */
const PRESETS: Record<string, GroupErrorPreset> = {
  GROUP_FORBIDDEN: {
    title: "You don't have permission to do that",
    message:
      "Your role in this group doesn't allow this action. Only group leaders can manage members, milestones and tasks.",
    hint: "Ask a group leader to make this change for you.",
    tone: "warning",
  },
  MILESTONE_HAS_OPEN_TASKS: {
    title: "This milestone still has unfinished work",
    message:
      "A milestone can only be marked as Delivered once every task in it is done or skipped.",
    hint: "Finish the remaining tasks first, or confirm the move to Delivered anyway.",
    tone: "warning",
  },
  GROUP_ASSIGNEE_BUSY: {
    title: "This person is already busy at that time",
    message:
      "The assignee has a conflicting schedule, or their workload for that week is higher than they can take on.",
    hint:
      "Pick a different time or assignee, or assign it anyway if you're happy to overlap.",
    tone: "warning",
  },
  FOCUS_SESSION_CONFLICT: {
    title: "A focus session is already running",
    message:
      "You can only track one focus session at a time, and another session is still running.",
    hint: "Stop the running session before starting a new one.",
    tone: "warning",
  },
  /*
   * 409 SLOT_OVERLAP — khung giờ mới chồng giờ đã có.
   *
   * Áp dụng cho CẢ slot cá nhân lẫn slot việc nhóm (mục 10 của cập nhật BE):
   * `details.overlaps[]` có `groupTaskId` khi bên chồng là slot của nhóm.
   */
  SLOT_OVERLAP: {
    title: "That time is already booked",
    message:
      "This time slot overlaps with work that is already scheduled. Pick a different time so nothing gets double-booked.",
    hint:
      "Move the slot to a free time window, or cancel the conflicting slot first.",
    tone: "warning",
  },
};

/* ===========================================================
 * Ánh xạ theo HTTP status (khi BE không trả mã kỹ thuật)
 * =========================================================== */

const STATUS_PRESETS: Record<number, GroupErrorPreset> = {
  400: {
    title: "That action isn't allowed right now",
    message:
      "The request broke one of the group's rules, so it wasn't applied. Nothing was changed.",
    hint: "Check the details below and adjust the request before trying again.",
    tone: "error",
  },
  403: {
    title: "You don't have permission to do that",
    message:
      "You're in this group, but your role doesn't allow this action. Only group leaders can manage members, milestones and tasks.",
    hint: "Ask a group leader to make this change for you.",
    tone: "warning",
  },
  404: {
    title: "We couldn't find that",
    message:
      "The item doesn't exist, or you're no longer a member of the group that owns it.",
    hint: "Refresh the page — you may have been removed from the group.",
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
    message: "The server is restarting or too busy to handle requests right now.",
    hint: "Wait a few seconds and try again.",
    tone: "error",
  },
};

/** Lỗi mạng (fetch throw) — không có HTTP status. */
const NETWORK_PRESET: GroupErrorPreset = {
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
  const keys = ["code", "errorCode", "error_code"];
  for (const k of keys) {
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

/**
 * Rút thông tin "chi tiết" từ `details` của lỗi 409 để người dùng hiểu
 * chính xác mình đang vướng cái gì.
 *
 * - `MILESTONE_HAS_OPEN_TASKS` → danh sách việc còn dở.
 * - `GROUP_ASSIGNEE_BUSY`      → các khoảng thời gian bị trùng + mức quá tải.
 */
export interface GroupErrorDetailLine {
  label: string;
  value: string;
}

/** Chi tiết dạng danh sách (dùng cho MILESTONE_HAS_OPEN_TASKS). */
export interface GroupErrorDetailItem {
  title: string;
  meta: string;
}

export interface GroupErrorDetails {
  /** Các dòng "nhãn - giá trị" (dùng cho khoảng bận, mức quá tải). */
  lines: GroupErrorDetailLine[];
  /** Các mục có tiêu đề (dùng cho danh sách việc còn dở). */
  items: GroupErrorDetailItem[];
}

function readDetails(
  body: unknown,
  code: string,
  formatDate: (iso: string) => string,
  formatMinutes: (min: number) => string,
  fallbackDetails?: unknown,
): GroupErrorDetails {
  const rec = asRecord(body);
  /*
   * `details` có thể nằm ở 2 nơi:
   *  - trong body lỗi gốc của BE (`{ details: {...} }`), hoặc
   *  - đã được `api-client` tách ra thành `err.details`.
   *
   * Ta ưu tiên body, nhưng LUÔN fallback về `err.details` — nếu không, hộp
   * thoại sẽ mất danh sách khung giờ bị chồng (mục 10 của cập nhật BE).
   */
  const fromBody = rec ? asRecord(rec["details"]) : null;
  const details = fromBody ?? asRecord(fallbackDetails);
  const out: GroupErrorDetails = { lines: [], items: [] };
  if (!details) return out;

  if (code === "MILESTONE_HAS_OPEN_TASKS") {
    const openTasks = details["openTaskCount"];
    const openSubs = details["openSubTaskCount"];
    if (typeof openTasks === "number") {
      out.lines.push({
        label: "Unfinished tasks",
        value: String(openTasks),
      });
    }
    if (typeof openSubs === "number") {
      out.lines.push({
        label: "Unfinished subtasks",
        value: String(openSubs),
      });
    }
    const tasks = details["tasks"];
    if (Array.isArray(tasks)) {
      for (const t of tasks) {
        const r = asRecord(t);
        if (!r) continue;
        const title = typeof r["title"] === "string" ? r["title"] : "Untitled task";
        const status = typeof r["status"] === "string" ? r["status"] : "";
        const subCount =
          typeof r["openSubTaskCount"] === "number" ? r["openSubTaskCount"] : 0;
        const metaParts: string[] = [];
        if (status) metaParts.push(status);
        if (subCount > 0) metaParts.push(`${subCount} unfinished subtask${subCount > 1 ? "s" : ""}`);
        out.items.push({
          title,
          meta: metaParts.join(" · "),
        });
      }
    }
    return out;
  }

  if (code === "GROUP_ASSIGNEE_BUSY") {
    const conflicts = details["conflicts"];
    if (Array.isArray(conflicts)) {
      for (const c of conflicts) {
        const r = asRecord(c);
        if (!r) continue;
        const start = typeof r["start"] === "string" ? r["start"] : "";
        const end = typeof r["end"] === "string" ? r["end"] : "";
        const source = typeof r["source"] === "string" ? r["source"] : "";
        if (!start && !end) continue;
        out.items.push({
          title: `${formatDate(start)} → ${formatDate(end)}`,
          meta: sourceLabel(source),
        });
      }
    }
    const workload = asRecord(details["workload"]);
    if (workload) {
      const assigned = workload["assignedMinutes"];
      const capacity = workload["capacityMinutes"];
      if (typeof assigned === "number" && typeof capacity === "number") {
        out.lines.push({
          label: "Assigned vs available",
          value: `${formatMinutes(assigned)} of ${formatMinutes(capacity)} this week`,
        });
      }
    }
    return out;
  }

  if (code === "FOCUS_SESSION_CONFLICT") {
    const source = details["source"];
    if (typeof source === "string") {
      out.lines.push({
        label: "Running session",
        value: source === "Personal" ? "Your personal focus session" : "Another group focus session",
      });
    }
    return out;
  }

  /*
   * 409 SLOT_OVERLAP — liệt kê các khung giờ đang bị chồng.
   *
   * Mỗi phần tử có `slotId`, `taskTitle`, `start`, `end` và có thể có
   * `groupTaskId` (bên chồng là slot của việc nhóm — mục 10 của cập nhật BE).
   */
  if (code === "SLOT_OVERLAP") {
    const overlaps = details["overlaps"];
    if (Array.isArray(overlaps)) {
      for (const o of overlaps) {
        const r = asRecord(o);
        if (!r) continue;
        const start = typeof r["start"] === "string" ? r["start"] : "";
        const end = typeof r["end"] === "string" ? r["end"] : "";
        const title =
          typeof r["taskTitle"] === "string" && r["taskTitle"].trim()
            ? r["taskTitle"]
            : "Scheduled work";
        const isGroup = typeof r["groupTaskId"] === "string" && r["groupTaskId"];
        const meta = isGroup
          ? "Group task · already booked"
          : "Personal task · already booked";
        out.items.push({
          title: start && end ? `${title} — ${formatDate(start)} → ${formatDate(end)}` : title,
          meta,
        });
      }
    }
    return out;
  }

  return out;
}

/** Nhãn tiếng Anh cho nguồn khoảng bận. */
function sourceLabel(source: string): string {
  if (source === "PersonalSchedule") return "Your personal schedule";
  if (source === "GoogleCalendar") return "Google Calendar";
  if (source === "GroupTask") return "Another group task";
  return source || "Busy";
}

/* ===========================================================
 * Hàm chính
 * =========================================================== */

/**
 * Đổi một lỗi API của nhóm thành thông điệp tiếng Anh dễ hiểu.
 *
 * @param err   Kết quả lỗi từ `api-client` (còn `status`, `errorCode`, `details`).
 * @param body  Body lỗi gốc của BE (nếu có) — dùng để đọc message/mã chi tiết.
 * @param opts  `action` là nhãn hành động ngắn (VD: "assign this task") để ghép câu.
 *              `formatDate` / `formatMinutes` là formatter có sẵn trong `group-logic.ts`.
 */
export function toGroupErrorView(
  err: ApiErr | undefined,
  body?: unknown,
  opts?: {
    /** Động từ ngắn mô tả thao tác đang thực hiện, VD: "assign this task". */
    action?: string;
  },
): GroupErrorView {
  const status = err?.status ?? 0;
  const code = err?.errorCode ?? readCode(body);

  // Ưu tiên mã kỹ thuật, sau đó tới status.
  const preset = (code && PRESETS[code]) || (status ? STATUS_PRESETS[status] : undefined);

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

/** Đọc chi tiết (danh sách việc dở / khoảng bận) cho hộp thoại. */
export function toGroupErrorDetails(
  err: ApiErr | undefined,
  body?: unknown,
  opts?: {
    formatDate?: (iso: string) => string;
    formatMinutes?: (min: number) => string;
  },
): GroupErrorDetails {
  const formatDate = opts?.formatDate ?? defaultFormatDate;
  const formatMinutes = opts?.formatMinutes ?? defaultFormatMinutes;
  const code = err?.errorCode ?? readCode(body);
  return readDetails(body, code, formatDate, formatMinutes, err?.details);
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

function defaultFormatDate(iso: string): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function defaultFormatMinutes(min: number): string {
  if (!Number.isFinite(min)) return "—";
  const h = Math.floor(min / 60);
  const m = Math.round(min % 60);
  if (h <= 0) return `${m}m`;
  if (m <= 0) return `${h}h`;
  return `${h}h ${m}m`;
}
