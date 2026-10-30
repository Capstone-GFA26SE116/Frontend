/**
 * ============================================================
 * Logic dùng chung cho UI Focus Session.
 * ============================================================
 *
 * Tách riêng khỏi component để:
 *  - Giữ react-refresh hoạt động (file .ts chỉ chứa logic).
 *  - Test/đọc dễ hơn — không phải lần theo JSX.
 */

import type { FocusStopReason } from "../../lib/api-client";

/* ---------- Định dạng thời gian ---------- */

/**
 * Định dạng giây → "MM:SS" hoặc "H:MM:SS".
 *
 * Dùng font mono ở UI nên ta chỉ cần số + dấu phẩy, không đơn vị.
 */
export function formatClock(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const mm = String(m).padStart(2, "0");
  const ss = String(sec).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

/**
 * Định dạng phút → "45 phút" / "1h 30" cho phần mô tả.
 */
export function formatMinutes(minutes: number): string {
  const m = Math.max(0, Math.round(minutes));
  if (m < 60) return `${m} phút`;
  const h = Math.floor(m / 60);
  const rem = m % 60;
  return rem === 0 ? `${h} giờ` : `${h}h ${rem}`;
}

/* ---------- Nhãn trạng thái slot ---------- */

/**
 * Trạng thái slot mà BE trả về (qua `GET /api/calendar`).
 *
 * Bảng ánh xạ theo spec FOCUS_SESSION_FE.md mục 1.
 */
export type FocusSlotPhase =
  | "Proposed"
  | "Approved"
  | "Due"
  | "InProgress"
  | "Overrun"
  | "Done"
  | "Missed"
  | "Skipped"
  | "Cancelled"
  | "Postponed"
  | "Unknown";

/** Chuẩn hoá status bất kỳ về `FocusSlotPhase`. */
export function toSlotPhase(status: string | null | undefined): FocusSlotPhase {
  if (!status) return "Unknown";
  const s = status.trim().toLowerCase();
  switch (s) {
    case "proposed":
      return "Proposed";
    case "approved":
      return "Approved";
    case "due":
      return "Due";
    case "inprogress":
    case "in_progress":
    case "in progress":
      return "InProgress";
    case "overrun":
      return "Overrun";
    case "done":
    case "completed":
      return "Done";
    case "missed":
    case "notstarted":
    case "not_started":
      return "Missed";
    case "skipped":
      return "Skipped";
    case "cancelled":
    case "canceled":
      return "Cancelled";
    case "postponed":
      return "Postponed";
    default:
      return "Unknown";
  }
}

/**
 * Slot này có cho phép bấm Start không?
 *
 * Theo spec FOCUS_SESSION_FE (1).md mục 4:
 *   "Start được khi slot ở: `Approved`, `Due`, `InProgress`, `Overrun`,
 *    `Missed`, `Postponed`. Slot `Proposed`, `Done`, `Skipped`, `Cancelled`
 *    thì 400."
 *
 * Lưu ý `InProgress` / `Overrun` nằm trong danh sách Start-được của BE, nhưng
 * ở UI ta hiện nút **Stop** thay vì Start (xem `isSlotRunning`) — vì đang
 * có phiên chạy thì Start sẽ trả 409.
 */
export function canStartSlot(phase: FocusSlotPhase): boolean {
  return (
    phase === "Approved" ||
    phase === "Due" ||
    phase === "InProgress" ||
    phase === "Overrun" ||
    phase === "Missed" ||
    phase === "Postponed"
  );
}

/**
 * Slot này đang có phiên chạy (nên hiện nút Stop thay vì Start)?
 */
export function isSlotRunning(phase: FocusSlotPhase): boolean {
  return phase === "InProgress" || phase === "Overrun";
}

/**
 * Slot này bị "ẩn mờ" (không quan tâm)?
 *
 * ⚠️ Theo spec mục 4, `Postponed` cũng nằm trong nhóm "Bỏ qua, hủy, dời
 * → Ẩn hoặc làm mờ", **NHƯNG** BE vẫn cho Start được với `Postponed`
 * ("Start được khi slot ở: Approved, Due, InProgress, Overrun, Missed,
 * Postponed"). Vì vậy:
 *   • `Skipped` / `Cancelled` → dim + KHÔNG Start (BE trả 400).
 *   • `Postponed` → dim nhưng VẪN Start được → không nằm trong hàm này.
 */
export function isSlotDimmed(phase: FocusSlotPhase): boolean {
  return phase === "Skipped" || phase === "Cancelled";
}

/**
 * Slot này bị "làm mờ" nhưng vẫn hành động được (Postponed).
 *
 * Hiển thị dạng mờ để user biết nó đã bị dời, nhưng vẫn cho bấm Start
 * (BE cho phép).
 */
export function isSlotFaded(phase: FocusSlotPhase): boolean {
  return phase === "Postponed";
}

/** Nhãn tiếng Việt của trạng thái slot — dùng cho badge. */
export function slotPhaseLabel(phase: FocusSlotPhase): string {
  switch (phase) {
    case "Proposed":
      return "Chờ duyệt";
    case "Approved":
      return "Đã duyệt";
    case "Due":
      return "Đến giờ";
    case "InProgress":
      return "Đang làm";
    case "Overrun":
      return "Quá giờ";
    case "Done":
      return "Hoàn thành";
    case "Missed":
      return "Đã bỏ lỡ";
    case "Skipped":
      return "Bỏ qua";
    case "Cancelled":
      return "Đã huỷ";
    case "Postponed":
      return "Đã dời";
    default:
      return "Chưa rõ";
  }
}

/* ---------- Lý do dừng ---------- */

/** Nhãn tiếng Việt cho `stopReason`. */
export const STOP_REASON_LABELS: Record<FocusStopReason, string> = {
  Completed: "Đã xong",
  Interrupted: "Tạm dừng / bị gián đoạn",
  Blocked: "Bị chặn",
  Other: "Lý do khác",
};

/** Mô tả ngắn gợi ý cho từng lý do dừng. */
export const STOP_REASON_HINTS: Record<FocusStopReason, string> = {
  Completed: "Công việc đã hoàn thành — slot sẽ chuyển sang Done.",
  Interrupted: "Slot sẽ trở lại trạng thái Due để bạn làm tiếp.",
  Blocked: "Slot sẽ trở lại trạng thái Due để bạn làm tiếp.",
  Other: "Slot sẽ trở lại trạng thái Due để bạn làm tiếp.",
};

/**
 * `checkInRequired = true` (BE trả về khi stop) nghĩa là nên hỏi
 * "bạn thấy thế nào / xong chưa?".
 *
 * Lưu ý từ spec: BE **chưa** có API lưu câu trả lời check-in, nên FE chỉ
 * hiển thị hộp thoại rồi bỏ qua (không gửi đi đâu).
 */
export const CHECK_IN_QUESTIONS = [
  "Công việc đã xong chưa?",
  "Bạn thấy thế nào về buổi làm vừa rồi?",
];

/** Gợi ý câu trả lời nhanh cho hộp thoại check-in. */
export const CHECK_IN_OPTIONS = [
  "Hoàn thành tốt",
  "Tạm ổn",
  "Bị gián đoạn",
  "Chưa xong",
];

/* ---------- Body cho POST /api/focus/start ---------- */

/**
 * Body của `POST /api/focus/start`.
 *
 * Theo spec FOCUS_SESSION_FE (1).md mục 7 — mẫu TypeScript gốc:
 *
 * ```ts
 * type FocusStartBody = { taskId: string; scheduleSlotId?: string;
 *                         subTaskId?: string; focusTrackId?: string };
 *
 * function buildStartBody(task, opts) {
 *   const body = { taskId: task.id };
 *   if (opts?.slot) body.scheduleSlotId = opts.slot.id;
 *   // slot gắn subtask thì gửi đúng subtask đó; backend không tự lấy
 *   const sub = opts?.slot?.subTaskId ?? opts?.subTaskId;
 *   if (sub) body.subTaskId = sub;
 *   return body;
 * }
 * ```
 *
 * ⚠️ Điểm dễ sai nhất (spec mục 6.1 + bảng "kết quả đã kiểm tra" #9):
 *   *"Slot gắn subtask nhưng **không gửi** `subTaskId` khi Start → Phiên
 *   **không** có subtask. Backend **không tự lấy** `subTaskId` từ slot."*
 *
 * ⇒ `subTaskId` phải lấy TỪ SLOT, không phải từ task. Với event gộp
 *   nhiều slot của 1 task, `event.subTaskId` là `null` (task aggregate) →
 *   nếu ta gửi theo event thì phiên sẽ mất nhãn subtask. Ta luôn gửi
 *   theo slot.
 */
export interface FocusStartBody {
  taskId: string;
  scheduleSlotId?: string;
  subTaskId?: string;
}

/**
 * Dựng body Start đúng theo spec.
 *
 * @param taskId Task đang làm (bắt buộc).
 * @param slot   Slot gắn vào phiên (nếu có) — nguồn của `subTaskId`.
 * @param subTaskId Subtask được chọn khi làm việc **ngoài lịch**.
 */
export function buildFocusStartBody(
  taskId: string,
  slot?: { id: string; subTaskId?: string | null } | null,
  subTaskId?: string | null,
): FocusStartBody {
  const body: FocusStartBody = { taskId };
  if (slot?.id) body.scheduleSlotId = slot.id;
  // Ưu tiên subtask của slot; backend không tự suy ra.
  const sub = slot?.subTaskId ?? subTaskId;
  if (sub) body.subTaskId = sub;
  return body;
}

/* ---------- Action type của thông báo ---------- */

/**
 * `actionType` chi tiết — chỉ có ở SignalR và Web Push (không có trong hộp
 * thư). Dùng để quyết định toast + hành động kèm theo.
 */
export type FocusActionType =
  | "PRE_START_REMINDER"
  | "START_PROMPT"
  | "NOT_STARTED"
  | "NEAR_END"
  | "OVERRUN"
  | "AUTO_TIMEOUT"
  | "CHECK_IN"
  | "MISSED_SLOT"
  | "Unknown";

/** Chuẩn hoá actionType về dạng đã biết. */
export function toActionType(raw: string | null | undefined): FocusActionType {
  if (!raw) return "Unknown";
  const s = raw.trim();
  const known: FocusActionType[] = [
    "PRE_START_REMINDER",
    "START_PROMPT",
    "NOT_STARTED",
    "NEAR_END",
    "OVERRUN",
    "AUTO_TIMEOUT",
    "CHECK_IN",
    "MISSED_SLOT",
  ];
  return (known as string[]).includes(s) ? (s as FocusActionType) : "Unknown";
}

/** Thông điệp mặc định cho từng actionType — fallback khi BE không kèm text. */
export const ACTION_TYPE_MESSAGES: Record<FocusActionType, string> = {
  PRE_START_REMINDER: "Sắp đến giờ rồi.",
  START_PROMPT: "Đã đến giờ — sẵn sàng bắt đầu?",
  NOT_STARTED: "Bạn chưa bắt đầu slot này.",
  NEAR_END: "Sắp hết giờ rồi.",
  OVERRUN: "Bạn đã làm quá giờ — nhớ bấm Stop.",
  AUTO_TIMEOUT: "Hệ thống đã tự ngắt phiên làm việc.",
  CHECK_IN: "Công việc đã xong chưa?",
  MISSED_SLOT: "Bạn đã bỏ lỡ slot này.",
  Unknown: "Bạn có thông báo mới.",
};
