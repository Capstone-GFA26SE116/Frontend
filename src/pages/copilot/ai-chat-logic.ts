/* ============================================================
 * AI Chat Screen — shared logic (pure functions)
 * ------------------------------------------------------------
 * Spec: `ui-man-chat-ai.md` (BE gửi FE).
 *
 * Màn hình gộp 3 việc:
 *   - Trái  : lịch sử chat
 *   - Giữa  : khung chat với AI (bàn bạc → kế hoạch → áp dụng)
 *   - Phải  : cây cột mốc › việc › việc con (thêm/sửa/xoá tay)
 *
 * File này chứa các hàm THUẦN (không phụ thuộc React) để:
 *   - suy ra trạng thái màn hình từ dữ liệu chat (discuss/thinking/draft/applying/applied)
 *   - nhóm lịch sử chat theo thời gian
 *   - tính tiến độ cây cột mốc
 *   - định dạng số phút / ngày
 * ============================================================ */

/* ===========================================================
 * Trạng thái màn hình (AI chuyển bước) — spec mục 5
 * =========================================================== */

export type ChatScreenState =
  | "discuss"
  | "thinking"
  | "draft"
  | "applying"
  | "applied";

/** Bước hiển thị trên thanh 3 bước (1 = Bàn bạc, 2 = Kế hoạch, 3 = Xếp lịch). */
export function stepOfState(state: ChatScreenState): 1 | 2 | 3 {
  switch (state) {
    case "discuss":
      return 1;
    case "thinking":
    case "draft":
    case "applying":
      return 2;
    case "applied":
      return 3;
  }
}

/**
 * Suy ra trạng thái màn hình từ dữ liệu chat.
 *
 * Spec mục 5:
 *   - `latest_draft` có và `applied = false` → `draft`
 *   - tin nháp cuối `applied = true` → `applied`
 *   - không có nháp → `discuss`
 *
 * @param hasDraft    Cuộc chat có bản nháp chưa áp dụng không.
 * @param applied     Bản nháp cuối đã được áp dụng chưa.
 * @param busy        Đang gọi API (gửi tin / lập kế hoạch).
 * @param applying    Đang apply (nút "Áp dụng & xếp lịch").
 */
export function deriveScreenState(params: {
  hasDraft: boolean;
  applied: boolean;
  busy: boolean;
  applying: boolean;
}): ChatScreenState {
  if (params.applying) return "applying";
  if (params.busy) return "thinking";
  if (params.hasDraft && !params.applied) return "draft";
  if (params.applied) return "applied";
  return "discuss";
}

/* ===========================================================
 * Nhóm lịch sử chat
 * =========================================================== */

export type HistoryGroup = "today" | "week" | "older";

/**
 * Xếp 1 cuộc chat vào nhóm theo thời điểm tin nhắn cuối.
 *
 * - "Hôm nay"  : trong vòng từ đầu hôm nay trở đi
 * - "Tuần này" : trong vòng 7 ngày
 * - "Cũ hơn"   : còn lại
 */
export function groupOf(lastMessageAt: string | null | undefined): HistoryGroup {
  if (!lastMessageAt) return "older";
  const d = new Date(lastMessageAt);
  if (Number.isNaN(d.getTime())) return "older";

  const now = new Date();
  const startOfToday = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
    0,
    0,
    0,
    0,
  ).getTime();

  if (d.getTime() >= startOfToday) return "today";
  if (d.getTime() >= startOfToday - 7 * 24 * 3600_000) return "week";
  return "older";
}

/** Thứ tự nhóm hiển thị. */
export const HISTORY_GROUP_ORDER: HistoryGroup[] = ["today", "week", "older"];

/* ===========================================================
 * Định dạng
 * =========================================================== */

/** "4h" · "4h30" · "45m" — dùng cho thời lượng. */
export function fmtDuration(minutes: number | null | undefined): string {
  if (minutes == null || !Number.isFinite(minutes)) return "—";
  const m = Math.max(0, Math.round(minutes));
  if (m === 0) return "0m";
  const h = Math.floor(m / 60);
  const r = m % 60;
  if (h === 0) return `${r}m`;
  if (r === 0) return `${h}h`;
  return `${h}h${r}`;
}

/** "4 giờ" — dạng chữ có dấu cho phần giải thích của AI. */
export function fmtDurationWords(minutes: number | null | undefined): string {
  if (minutes == null || !Number.isFinite(minutes)) return "—";
  const m = Math.max(0, Math.round(minutes));
  const h = Math.floor(m / 60);
  const r = m % 60;
  if (h === 0) return `${r} phút`;
  if (r === 0) return `${h} giờ`;
  return `${h} giờ ${r} phút`;
}

/** "dd/MM" — hạn cột mốc. */
export function fmtShortDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}`;
}

/** "dd/MM/yyyy" — hạn đầy đủ. */
export function fmtFullDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}/${d.getFullYear()}`;
}

/** "HH:MM" — giờ tin nhắn. */
export function fmtClock(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/**
 * Bỏ dấu tiếng Việt + lowercase.
 * Dùng để so khớp tìm kiếm "không phân biệt hoa thường, chưa tìm không dấu".
 */
export function normalize(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "");
}

/**
 * Tìm vị trí các từ khoá đã chuẩn hoá trong `text` để tô đậm.
 * Trả về mảng đoạn: `{ text, hit }`.
 */
export function highlightParts(
  text: string,
  query: string,
): { text: string; hit: boolean }[] {
  const q = normalize(query).trim();
  if (!q) return [{ text, hit: false }];

  const haystack = normalize(text);
  const parts: { text: string; hit: boolean }[] = [];
  let cursor = 0;
  let hit = haystack.indexOf(q);

  while (hit !== -1) {
    if (hit > cursor) parts.push({ text: text.slice(cursor, hit), hit: false });
    parts.push({ text: text.slice(hit, hit + q.length), hit: true });
    cursor = hit + q.length;
    hit = haystack.indexOf(q, cursor);
  }
  if (cursor < text.length) parts.push({ text: text.slice(cursor), hit: false });
  return parts;
}

/* ===========================================================
 * Tiến độ dự án
 * =========================================================== */

/** Task xong theo status. */
export function isTaskDone(status: string | null | undefined): boolean {
  const s = (status ?? "").toLowerCase();
  return s === "done" || s === "completed";
}

export interface ProjectProgress {
  done: number;
  total: number;
  milestones: number;
  /** 0–100. */
  pct: number;
}

/**
 * Tính tiến độ: `{x}/{y} việc xong · {n} cột mốc`.
 */
export function computeProgress(
  tasks: { status?: string | null }[],
  milestoneCount: number,
): ProjectProgress {
  const total = tasks.length;
  const done = tasks.filter((t) => isTaskDone(t.status)).length;
  return {
    done,
    total,
    milestones: milestoneCount,
    pct: total === 0 ? 0 : Math.round((done / total) * 100),
  };
}

/* ===========================================================
 * Thông báo lỗi xếp lịch (spec mục 5)
 * =========================================================== */

export interface ScheduleErrorHint {
  title: string;
  hint: string;
}

/**
 * Gợi ý hiển thị cho từng mã lỗi xếp lịch.
 *
 * Lưu ý: việc **đã được tạo**, chỉ phần xếp lịch là chưa thành công.
 */
export function scheduleErrorHint(code: string): ScheduleErrorHint {
  switch (code) {
    case "quota_exceeded":
      return {
        title: "Đã tạo việc, chưa xếp được lịch",
        hint: "Bạn đã dùng hết lượt AI của gói. Bấm “Xếp lịch” để thử lại.",
      };
    case "no_active_plan":
      return {
        title: "Đã tạo việc, chưa xếp được lịch",
        hint: "Bạn chưa có gói đang hoạt động — hãy chọn gói rồi xếp lịch lại.",
      };
    case "plan_feature_locked":
      return {
        title: "Đã tạo việc, chưa xếp được lịch",
        hint: "Tính năng xếp lịch chỉ có ở gói Pro/Premium.",
      };
    case "schedule_failed":
    default:
      return {
        title: "Đã tạo việc, chưa xếp được lịch",
        hint: "AI đang bận — bấm “Xếp lịch” để thử lại.",
      };
  }
}

/* ===========================================================
 * Phân loại lỗi API của màn chat AI (spec mục 7)
 * =========================================================== */

export type ChatErrorKind =
  /** 403 `plan_feature_locked` — khoá tính năng theo gói. */
  | "plan_locked"
  /** 429 — hết lượt AI. */
  | "quota"
  /** 502 — AI bận, có thể thử lại (không bị trừ lượt). */
  | "ai_busy"
  /** 409 `already_applied` / `not_latest_draft` — cần tải lại chat. */
  | "stale_draft";

export interface ChatErrorInfo {
  kind: ChatErrorKind;
  /** Nội dung hiển thị cho user. */
  message: string;
  /** Có nên hiện nút "Thử lại" không (không bị trừ lượt). */
  retryable: boolean;
}

/**
 * Rút ra thông tin lỗi để rẽ nhánh UI theo spec mục 7.
 *
 * @param status    HTTP status của lỗi.
 * @param errorCode Mã lỗi kỹ thuật do BE trả (nếu có).
 */
export function classifyChatError(
  status: number | undefined,
  errorCode: string | undefined,
): ChatErrorInfo {
  const code = (errorCode ?? "").toLowerCase();

  if (status === 403 || code.includes("plan_feature_locked")) {
    return {
      kind: "plan_locked",
      message: "Chat AI có ở gói Pro/Premium.",
      retryable: false,
    };
  }
  if (status === 429 || code.includes("quota")) {
    return {
      kind: "quota",
      message: "Bạn đã dùng hết lượt AI của gói.",
      retryable: false,
    };
  }
  if (
    status === 409 ||
    code.includes("already_applied") ||
    code.includes("not_latest_draft")
  ) {
    return {
      kind: "stale_draft",
      message: "Bản nháp đã thay đổi — mình tải lại cuộc chat.",
      retryable: false,
    };
  }
  return {
    kind: "ai_busy",
    message: "AI đang bận, thử lại.",
    retryable: true,
  };
}
