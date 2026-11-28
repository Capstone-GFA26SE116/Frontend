import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useAuth } from "../../auth/AuthContext";
import { useStaggeredMount } from "../../hooks/useStaggeredMount";
import { useGoogleCalendar } from "../../hooks/useGoogleCalendar";
import { GoogleCalendarSyncDialog } from "../../components/GoogleCalendarSyncDialog";
import {
  getProjectProgress,
  listCalendar,
  listProjects,
  getProductiveHours,
  getTodayBriefing,
  type BriefingResponse,
  type CalendarItemDto,
  type GoogleCalendarSyncDirection,
  type GoogleCalendarSyncResultDto,
  type ProductiveHoursDto,
} from "../../lib/api-client";
import "./dashboard.css";

/* ---------- Hằng số cho nhịp độ của lịch ---------- */
/** Còn dưới ngưỡng này (phút) thì khung đang chạy được tô thêm viền cảnh báo. */
const SOON_THRESHOLD_MS = 5 * 60 * 1000;
/** Chu kỳ tick: đủ mịn cho đồng hồ đếm ngược, rẻ hơn cập nhật mỗi giây. */
const TICK_MS = 30 * 1000;
/** Số project tối đa hiện trong Deadline radar (cột phải). */
const RADAR_LIMIT = 5;

/* ---------- Hằng số cho metric card (dữ liệu thật từ API) ---------- */
/**
 * Ngưỡng coi 1 giờ là "khung giờ hiệu quả" (0–1 → phần trăm).
 * Chỉ dùng để tô màu thanh nhiệt, KHÔNG phải ngưỡng AI dùng để xếp lịch.
 */
const HOUR_SCALE = 100;
/**
 * Ngưỡng TƯƠNG ĐỐI để gom khung giờ vàng: giờ chỉ được tính vào khung nếu
 * đạt ≥ 70% điểm đỉnh. Dùng mốc tương đối để không gom nhầm giờ "vừa có
 * dữ liệu" (mọi giờ > 0) thành 1 khum hết ngày.
 */
const PEAK_RATIO = 70;
/** Số giờ nhóm liền kề gộp lại thành 1 "khung giờ vàng" (vd 9–12, 14–18). */
const PEAK_BLOCK_MIN_HOURS = 1;

/** "42m" / "1h 05" — định dạng ngắn cho phần thời gian còn lại. */
function formatRemain(ms: number): string {
  if (ms <= 0) return "0m";
  const totalMin = Math.ceil(ms / 60_000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return h > 0 ? `${h}h ${String(m).padStart(2, "0")}` : `${m}m`;
}

/** "09:00" / "9:00" — giờ từ số (0–23) hoặc chuỗi ISO. */
function fmtHourLabel(h: number): string {
  return `${String(h).padStart(2, "0")}:00`;
}

/**
 * "09:00" / "09:00:00" / "9" → số giờ (0–23). Trả `null` nếu không parse được.
 * Dùng cho `top_hours[]` của API (BE trả chuỗi giờ dạng text).
 */
function parseHourFromClock(value: string | null | undefined): number | null {
  if (!value) return null;
  const first = value.trim().split(":")[0];
  const n = Number(first);
  if (!Number.isFinite(n) || n < 0 || n > 23) return null;
  return Math.floor(n);
}

/**
 * Chuẩn hoá 1 điểm giờ (0–1) về phần trăm (0–100).
 * BE có thể trả 0–1 hoặc 0–100 → đọc cả hai để không phụ thuộc shape.
 */
function toPercent(value: number | null | undefined): number | null {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return null;
  }
  const pct = value <= 1 ? value * HOUR_SCALE : value;
  return Math.max(0, Math.min(100, Math.round(pct)));
}

/**
 * Từ mảng `hours[24]` → khung giờ hiệu quả nhất (giờ có điểm cao nhất).
 * Trả `null` khi BE chưa có dữ liệu (user chưa onboard, hoặc chưa học được).
 */
function findPeakHour(hours: number[] | undefined): number | null {
  if (!hours || hours.length === 0) return null;
  let best: number | null = null;
  for (let i = 0; i < hours.length; i++) {
    const v = toPercent(hours[i]);
    if (v === null) continue;
    if (best === null || v > (toPercent(hours[best]) ?? -1)) best = i;
  }
  return best;
}

/**
 * Gom các giờ hiệu quả thành các khung liên tục → "09:00 – 12:00".
 *
 * Ngưỡng là **tương đối**: chỉ tính giờ đạt ≥ `PEAK_RATIO` (mặc định 70%)
 * của điểm đỉnh. Nếu dùng mốc tuyệt đối (> 0) thì mọi giờ có dữ liệu
 * đều bị gộp thành 1 khum hết ngày.
 *
 * Trả về tối đa `maxBlocks` khung, mỗi khung là `{ start, end }` (end = giờ kế tiếp).
 */
function findPeakBlocks(
  hours: number[] | undefined,
  maxBlocks = 2,
): { start: number; end: number }[] {
  if (!hours || hours.length === 0) return [];
  const peak = findPeakHour(hours);
  if (peak === null) return [];
  const peakPct = toPercent(hours[peak]) ?? 0;
  if (peakPct <= 0) return [];
  const threshold = (peakPct * PEAK_RATIO) / HOUR_SCALE;

  const good: boolean[] = hours.map((v) => {
    const pct = toPercent(v);
    return pct !== null && pct > 0 && pct / HOUR_SCALE >= threshold;
  });

  const blocks: { start: number; end: number }[] = [];
  let i = 0;
  while (i < good.length) {
    if (!good[i]) {
      i++;
      continue;
    }
    const start = i;
    while (i < good.length && good[i]) i++;
    const end = i; // exclusive
    if (end - start >= PEAK_BLOCK_MIN_HOURS) blocks.push({ start, end });
  }
  // Ưu tiên khung dài nhất (đây là khung "vàng" nhất).
  blocks.sort((a, b) => b.end - b.start - (a.end - a.start));
  return blocks.slice(0, maxBlocks);
}

/** "09:00 – 12:00" — nhãn 1 khung giờ hiệu quả. */
function fmtPeakBlock(b: { start: number; end: number }): string {
  return `${fmtHourLabel(b.start)} – ${fmtHourLabel(b.end)}`;
}

/* ---------- Types ---------- */
type FocusStatus = "done" | "running" | "next" | "upcoming";type FocusType = "meeting" | "focus" | "reading" | "task";

interface FocusSlot {
  id: string;
  start: string;
  end: string;
  title: string;
  desc: string;
  type: FocusType;
  status: FocusStatus;
  tags: { label: string; tone?: "primary" | "success" | "muted" | "warning" }[];
  meta?: string;
  /** Epoch ms của mốc bắt đầu — dùng để tính "sắp tới" theo phút. */
  startMs: number;
  /** Epoch ms của mốc kết thúc — dùng cho đếm ngược. */
  endMs: number;
  /** Epoch ms lúc render, để đếm ngược không phụ thuộc Date.now() mỗi lần vẽ. */
  nowMs: number;
}

/** Một dòng trong "Deadline radar" (cột phải) — project sắp tới hạn. */interface RadarItem {
  id: string;
  name: string;
  client: string;
  /** Số ngày còn lại tới deadline (âm = đã quá hạn). null = chưa đặt deadline. */
  daysLeft: number | null;
  /** % tiến độ thật từ GET /api/projects/{id}/progress. */
  progress: number;
  doneTasks: number;
  totalTasks: number;
}

/* ---------- Calendar helpers ---------- */

const TZ = "en-GB";

/** Số ngày còn lại từ hôm nay tới deadline (âm = quá hạn); null nếu không parse được. */
function daysUntil(iso: string): number | null {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const now = new Date();
  // Chuẩn hoá về đầu ngày để không lệch vì giờ trong ngày.
  const a = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  const b = Date.UTC(d.getFullYear(), d.getMonth(), d.getDate());
  return Math.round((b - a) / 86_400_000);
}

/** Nhãn ngày còn lại: "in 3d" / "Due today" / "2d overdue". */
function fmtDaysLeft(days: number): string {
  if (days < 0) return `${Math.abs(days)}d overdue`;
  if (days === 0) return "Due today";
  return `in ${days}d`;
}

/* ---------- Mini month calendar helpers ---------- */

/** Khoá ngày theo local time: `YYYY-MM-DD` (không dùng toISOString vì lệch múi giờ). */
function dayKey(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** Khoá tháng: `YYYY-MM` — dùng để biết tháng nào đã tải xong. */
function monthKeyOf(year: number, month: number): string {
  return `${year}-${String(month + 1).padStart(2, "0")}`;
}

interface MiniMonthDay {
  date: Date;
  /** false nếu thuộc tháng trước/sau — vẫn vẽ để lưới đủ 6 tuần. */
  inMonth: boolean;
  /** true nếu là hôm nay. */
  isToday: boolean;
  /** Số khối thời gian trong ngày (0 = không có). */
  count: number;
}

/**
 * Build lưới 6 tuần (42 ô) bắt đầu từ thứ Hai cho tháng của `anchor`.
 * Trả kèm số item mỗi ngày tra từ `countByDay`.
 */
function buildMiniMonth(
  anchor: Date,
  countByDay: Map<string, number>,
): MiniMonthDay[] {
  const year = anchor.getFullYear();
  const month = anchor.getMonth();
  const first = new Date(year, month, 1);
  // getDay(): 0=CN. Đổi về thứ Hai = 0 để lưới bắt đầu bằng T2.
  const offset = (first.getDay() + 6) % 7;
  const start = new Date(year, month, 1 - offset);
  const todayKey = dayKey(new Date());

  return Array.from({ length: 42 }, (_, i) => {
    const date = new Date(
      start.getFullYear(),
      start.getMonth(),
      start.getDate() + i,
    );
    const key = dayKey(date);
    return {
      date,
      inMonth: date.getMonth() === month,
      isToday: key === todayKey,
      count: countByDay.get(key) ?? 0,
    };
  });
}

/** Tổng phút của các khối đã hoàn thành trong ngày (dùng cho metric Focus minutes). */
function sumDoneMinutes(slots: FocusSlot[]): number {
  return slots.reduce((acc, s) => {
    if (s.status !== "done") return acc;
    const mins = Math.round((s.endMs - s.startMs) / 60_000);
    return acc + (Number.isFinite(mins) && mins > 0 ? mins : 0);
  }, 0);
}

/** "2h 15m" / "45m" — nhãn gọn cho tổng phút. */
function fmtMinutes(total: number): string {
  if (total <= 0) return "0m";
  const h = Math.floor(total / 60);
  const m = total % 60;
  if (h === 0) return `${m}m`;
  return m === 0 ? `${h}h` : `${h}h ${String(m).padStart(2, "0")}m`;
}

function fmtTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "--:--";
  return d.toLocaleTimeString(TZ, {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

function isAllDayOn(item: CalendarItemDto): boolean {
  if (item.isAllDay) return true;
  // Một sự kiện bị coi là all-day nếu span >= 20h (backend có thể bỏ cờ isAllDay).
  const s = new Date(item.start).getTime();
  const e = new Date(item.end).getTime();
  if (Number.isNaN(s) || Number.isNaN(e)) return false;
  return e - s >= 20 * 60 * 60 * 1000;
}

/**
 * Dedupe item từ `GET /api/calendar`.
 *
 * BE trả mỗi việc đã xếp lịch dưới nhiều nguồn cùng lúc (task / subtask / slot /
 * google). Cùng một khối thời gian có thể xuất hiện 2–3 lần với `id` khác nhau
 * và `source` khác nhau, làm timeline bị lặp (mỗi subtask hiện 2 lần).
 *
 * Khóa dedupe: subtask (nếu có, fallback taskId) + start + end. Nhờ vậy:
 *  - Hai bản ghi cùng công việc, cùng khung giờ → giữ 1.
 *  - Cùng subtask nhưng khác khung giờ (chia nhỏ phiên) → giữ cả.
 *
 * Thứ tự ưu tiên bản được giữ: slot (có giờ thật + status) > subtask > task >
 * google > còn lại. Bản ưu tiên cao hơn được giữ lại, nhưng nếu bản bị loại có
 * thông tin mà bản giữ thiếu (vd. `explanation`, `googleEventId`) thì bù vào.
 */
const SOURCE_PRIORITY: Record<string, number> = {
  slot: 4,
  subtask: 3,
  task: 2,
  google: 1,
  milestone: 0,
};

function dedupeCalendarItems(items: CalendarItemDto[]): CalendarItemDto[] {
  const byKey = new Map<string, CalendarItemDto>();

  for (const item of items) {
    const owner = item.subTaskId ?? item.taskId ?? item.id;
    const startMs = new Date(item.start).getTime();
    const endMs = new Date(item.end).getTime();
    // Nếu thời gian không parse được thì giữ nguyên, không gộp bừa.
    if (Number.isNaN(startMs) || Number.isNaN(endMs)) {
      byKey.set(`raw|${item.id}`, item);
      continue;
    }
    const key = `${owner}|${startMs}|${endMs}`;
    const current = byKey.get(key);
    if (!current) {
      byKey.set(key, item);
      continue;
    }

    const curRank = SOURCE_PRIORITY[(current.source ?? "").toLowerCase()] ?? -1;
    const newRank = SOURCE_PRIORITY[(item.source ?? "").toLowerCase()] ?? -1;
    const [keep, drop] = newRank > curRank ? [item, current] : [current, item];

    // Bù các field mà bản giữ đang thiếu nhưng bản bị loại có.
    byKey.set(key, {
      ...keep,
      explanation: keep.explanation ?? drop.explanation,
      googleEventId: keep.googleEventId ?? drop.googleEventId,
      taskId: keep.taskId ?? drop.taskId,
      subTaskId: keep.subTaskId ?? drop.subTaskId,
      projectName: keep.projectName ?? drop.projectName,
      clientName: keep.clientName ?? drop.clientName,
      domainName: keep.domainName ?? drop.domainName,
      subTaskTitle: keep.subTaskTitle ?? drop.subTaskTitle,
      taskType: keep.taskType ?? drop.taskType,
      taskStatus: keep.taskStatus ?? drop.taskStatus,
      proposedMinutes: keep.proposedMinutes ?? drop.proposedMinutes,
    });
  }

  return [...byKey.values()];
}

/** Map 1 item của API calendar → FocusSlot cho timeline. */
function itemToSlot(item: CalendarItemDto, now: Date): FocusSlot | null {  const start = new Date(item.start);
  const end = new Date(item.end);
  if (Number.isNaN(start.getTime())) return null;

  const durationMin = Number.isNaN(end.getTime())
    ? 0
    : Math.max(0, Math.round((end.getTime() - start.getTime()) / 60000));

  // Title: ưu tiên subtask > task > raw title
  const title =
    item.subTaskTitle?.trim() || item.title?.trim() || "Untitled block";

  // Desc: ghép các ngữ cảnh có sẵn từ API
  const descParts = [
    item.projectName?.trim(),
    item.clientName?.trim(),
    item.domainName?.trim(),
  ].filter(Boolean);
  const desc =
    item.explanation?.trim() ||
    descParts.join(" · ") ||
    "A focus block from your schedule.";

  // Status dựa trên mốc thời gian + trạng thái task
  const statusLower = (item.status ?? "").toLowerCase();
  const cancelled =
    statusLower === "cancelled" || statusLower === "canceled";
  let status: FocusStatus;
  if (cancelled) {
    status = "upcoming";
  } else if (end.getTime() <= now.getTime()) {
    status = "done";
  } else if (start.getTime() <= now.getTime()) {
    status = "running";
  } else {
    // Khung tương lai: đánh `next` cho khung gần nhất, còn lại là `upcoming`.
    // Logic chính xác hoá phân tầng nổi bật diễn ra ở useEffect tick (xem
    // `promoteNextSlot`), vì `now` ở đây chỉ là giá trị tại thời điểm load.
    status = "upcoming";
  }

  // Type: suy ra từ nguồn của sự kiện
  const src = (item.source ?? "").toLowerCase();
  let type: FocusType;
  if (src === "google") type = "meeting";
  else if (src === "slot") type = "focus";
  else if (src === "milestone") type = "reading";
  else type = "task";

  // Tags dựng từ metadata API
  const tags: FocusSlot["tags"] = [];
  if (src === "google") tags.push({ label: "Google Calendar", tone: "muted" });
  if (item.googleEventId) tags.push({ label: "Synced", tone: "success" });
  if (status === "running") tags.push({ label: "Focus Peak", tone: "primary" });
  if (item.subTaskId) tags.push({ label: "Atomic Task", tone: "muted" });
  if (item.taskType?.trim()) {
    tags.push({ label: item.taskType.trim(), tone: "muted" });
  }
  if (durationMin > 0) {
    tags.push({
      label:
        durationMin >= 60
          ? `${Math.floor(durationMin / 60)}h${durationMin % 60 ? ` ${durationMin % 60}m` : ""}`
          : `${durationMin} min`,
      tone: "muted",
    });
  }
  if (item.isManualOverride) {
    tags.push({ label: "Manual", tone: "warning" });
  }
  if (item.syncFailed) {
    tags.push({ label: "⚠ Sync failed", tone: "warning" });
  }

  return {
    id: item.id,
    start: fmtTime(item.start),
    end: isAllDayOn(item) ? "All day" : fmtTime(item.end),
    title,
    desc,
    type,
    status,
    tags,
    startMs: start.getTime(),
    endMs: end.getTime(),
    nowMs: now.getTime(),
  };
}

/* ============================================================
 * withUpNext — đánh lại tầng nổi bật cho danh sách slot.
 *
 * Quy tắc (chỉ đúng 1 khung mỗi tầng):
 *   done      : đã qua `end`
 *   running   : đã qua `start`, chưa qua `end`  (đang diễn ra)
 *   next      : khung tương lai GẦN NHẤT       (chỉ đúng 1 cái)
 *   upcoming  : các khung tương lai còn lại
 *
 * Dùng chung cho lúc load và mỗi lần tick, nên hai đường không thể lệch nhau.
 * ============================================================ */
function withUpNext(slots: FocusSlot[], nowMs: number): FocusSlot[] {
  let nextIdx = -1;
  for (let i = 0; i < slots.length; i++) {
    const s = slots[i];
    if (s.status === "done") continue;
    if (s.startMs <= nowMs) continue;
    if (nextIdx === -1 || s.startMs < slots[nextIdx].startMs) nextIdx = i;
  }
  return slots.map((s, i) => {
    let status: FocusStatus;
    if (s.endMs <= nowMs) status = "done";
    else if (s.startMs <= nowMs) status = "running";
    else status = i === nextIdx ? "next" : "upcoming";
    return { ...s, status, nowMs };
  });
}

/* ============================================================
 * DashboardPage — homepage sau khi đăng nhập.
 *
 * Bố cục (Progressive Disclosure + High-clarity UX):
 *  1) Header Welcome Bar: greeting + status overview + actions.
 *  2) Top 3 Minimalist Key Metrics (energy peak, K_bias, today).
 *  3) Main grid 8/4 (65% / 35%):
 *      - Left  (8/12): Today's recommended schedule (timeline).
 *      - Right (4/12): Deadline radar + AI tip.
 *
 * Class prefix `.dash-*`. Render bên trong <SiteLayout /> để có header/footer
 * chuẩn + nav active "Trang chủ".
 * ============================================================ */
export function DashboardPage() {
  const { user } = useAuth();
  const navigate = useNavigate();
  // Tháng đang xem ở mini calendar (rail trái).
  const [monthAnchor, setMonthAnchor] = useState<Date>(() => new Date());
  // Số khối thời gian theo ngày trong tháng đang xem: key `YYYY-MM-DD`.
  const [monthCounts, setMonthCounts] = useState<Map<string, number>>(
    () => new Map(),
  );
  // Tháng đã tải xong (key `YYYY-MM`). Dùng để suy ra loading mà không cần
  // setState đồng bộ trong thân effect.
  const [loadedMonthKey, setLoadedMonthKey] = useState<string | null>(null);
  // Focus slots lấy thật từ API calendar theo ngày hôm nay.
  const [focusSlots, setFocusSlots] = useState<FocusSlot[]>([]);
  const [slotsLoading, setSlotsLoading] = useState(true);
  const [slotsError, setSlotsError] = useState<string | null>(null);
  // Deadline radar: project sắp tới hạn + progress thật (cột phải).
  const [radar, setRadar] = useState<RadarItem[]>([]);
  const [radarLoading, setRadarLoading] = useState(true);
  /* ---------- Dữ liệu metric card (API thật) ---------- */
  // GET /profile/productive-hours → điểm giờ hiệu quả + khung giờ vàng.
  const [productive, setProductive] = useState<ProductiveHoursDto | null>(null);
  // GET /briefing/today → task ưu tiên + task thiếu thời gian (at risk).
  const [briefing, setBriefing] = useState<BriefingResponse | null>(null);
  const [metricsLoading, setMetricsLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  /** Mở hộp thoại đồng bộ (chọn hướng + khoảng ngày). */
  const [syncOpen, setSyncOpen] = useState(false);
  /** Lỗi 400 từ server khi sync (VD: `to` trước `from`). */
  const [syncError, setSyncError] = useState<string | null>(null);
  /** Kết quả sync vừa rồi → hiển thị chi tiết (kèm `pushErrors`). */
  const [syncResult, setSyncResult] = useState<GoogleCalendarSyncResultDto | null>(
    null,
  );
  const [toast, setToast] = useState<{
    visible: boolean;
    text: string;
    icon: string;
  }>({ visible: false, text: "", icon: "check_circle" });

  // Stagger animation cho 3 khu vực chính (welcome / metrics / workspace).
  // Tất cả dùng cùng `mounted` để bắt đầu sau một nhịp ngắn cho cảm giác
  // mạch lạc.
  const { mounted: pageMounted } = useStaggeredMount(0, 30);
  // Stagger riêng cho 4 metric cards (mỗi card delay +70ms).
  const metricsAnim = useStaggeredMount(70, 120);
  // Stagger cho timeline slots (mỗi slot +90ms).
  const slotsAnim = useStaggeredMount(90, 220, focusSlots.length);
  // Stagger cho các dòng deadline radar (mỗi dòng +80ms), chạy lại khi list đổi.
  const radarAnim = useStaggeredMount(80, 260, radar.length);

  function showToast(text: string, icon: string = "check_circle") {
    setToast({ visible: true, text, icon });
    window.setTimeout(() => {
      setToast((t) => ({ ...t, visible: false }));
    }, 3200);
  }

  /* ---------- Load hôm nay từ API calendar ---------- */

  /**
   * Gọi API calendar cho hôm nay và trả về danh sách slot đã chuẩn hoá.
   *
   * Tách riêng khỏi `loadTodaySchedule` vì `loadTodaySchedule` setState
   * **đồng bộ** ở đầu → không được gọi trực tiếp trong `useEffect`
   * (react-hooks/set-state-in-effect). Effect dùng hàm này (setState chỉ
   * chạy sau `await`), còn nút "Retry" dùng `loadTodaySchedule`.
   */
  const fetchTodaySlots = useCallback(async () => {
    // Khoảng [00:00 hôm nay, 00:00 ngày mai) theo local time.
    const dayStart = new Date();
    dayStart.setHours(0, 0, 0, 0);
    const dayEnd = new Date(dayStart);
    dayEnd.setDate(dayEnd.getDate() + 1);

    const res = await listCalendar({
      from: dayStart.toISOString(),
      to: dayEnd.toISOString(),
      includeCancelled: false,
    });

    if (!res.ok) return { ok: false as const, error: res.error, slots: [] };

    const now = new Date();
    const slots = withUpNext(
      dedupeCalendarItems(res.data.items ?? [])
        .map((item) => itemToSlot(item, now))
        .filter((s): s is FocusSlot => s !== null)
        .sort((a, b) => {
          // Sắp xếp theo giờ bắt đầu thật (không so sánh string HH:mm)
          const toMin = (t: string) => {
            if (t === "All day") return -1;
            const [h, m] = t.split(":").map(Number);
            return h * 60 + m;
          };
          return toMin(a.start) - toMin(b.start);
        }),
      now.getTime(),
    );

    return { ok: true as const, error: null, slots };
  }, []);

  const loadTodaySchedule = useCallback(async () => {
    setSlotsLoading(true);
    setSlotsError(null);
    const res = await fetchTodaySlots();
    if (!res.ok) {
      setFocusSlots([]);
      setSlotsError(res.error);
      setSlotsLoading(false);
      return;
    }
    setFocusSlots(res.slots);
    setSlotsLoading(false);
  }, [fetchTodaySlots]);

  /* Lần tải đầu tiên: setState chỉ chạy SAU await → không vi phạm
     react-hooks/set-state-in-effect, và không render 2 lần liên tiếp. */
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const res = await fetchTodaySlots();
      if (cancelled) return;
      if (res.ok) {
        setFocusSlots(res.slots);
      } else {
        setSlotsError(res.error);
      }
      setSlotsLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [fetchTodaySlots]);

  /* ---------- Load Deadline radar (project sắp tới hạn) ----------
   * GET /api/projects cho danh sách, rồi GET /api/projects/{id}/progress
   * song song để lấy % thật. Progress lỗi thì giữ 0, không chặn render.
   */
  useEffect(() => {
    let cancelled = false;

    void (async () => {
      setRadarLoading(true);

      const projRes = await listProjects();
      if (cancelled) return;
      if (!projRes.ok) {
        setRadar([]);
        setRadarLoading(false);
        return;
      }

      // Chỉ giữ project còn sống (chưa completed/archived) + có deadline hợp lệ.
      const candidates = (projRes.data ?? [])
        .map((p) => ({ p, days: daysUntil(p.deadline) }))
        .filter(({ p, days }) => {
          if (days === null) return false;
          const st = (p.status ?? "").toLowerCase();
          return st !== "completed" && st !== "archived";
        })
        .sort((a, b) => (a.days ?? 0) - (b.days ?? 0))
        .slice(0, RADAR_LIMIT);

      if (candidates.length === 0) {
        setRadar([]);
        setRadarLoading(false);
        return;
      }

      const progressResults = await Promise.all(
        candidates.map(async ({ p }) => {
          const r = await getProjectProgress(p.id);
          return { id: p.id, r };
        }),
      );
      if (cancelled) return;

      const progById = new Map<
        string,
        { percent: number; done: number; total: number }
      >();
      for (const { id, r } of progressResults) {
        if (!r.ok) continue;
        // BE thực tế trả `percent`; type khai báo `progressPercent`. Đọc cả
        // hai để không phụ thuộc vào tên field (kể cả khi BE đổi).
        const raw = r.data as unknown as {
          percent?: number;
          progressPercent?: number;
        };
        const value = Number(raw.percent ?? raw.progressPercent);
        progById.set(id, {
          percent: Number.isFinite(value)
            ? Math.max(0, Math.min(100, Math.round(value)))
            : 0,
          done: r.data.completedTasks ?? 0,
          total: r.data.totalTasks ?? 0,
        });
      }

      setRadar(
        candidates.map(({ p, days }) => {
          const prog = progById.get(p.id);
          return {
            id: p.id,
            name: p.name,
            client: p.client?.name ?? "Internal",
            daysLeft: days,
            progress: prog?.percent ?? 0,
            doneTasks: prog?.done ?? 0,
            totalTasks: prog?.total ?? 0,
          };
        }),
      );
      setRadarLoading(false);
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  /* ---------- Load dữ liệu metric card từ API ----------
   * 2 nguồn, gọi song song:
   *   GET /profile/productive-hours → điểm giờ hiệu quả (khung giờ vàng)
   *   GET /briefing/today           → task ưu tiên + task thiếu thời gian
   *
   * Cả 2 đều là endpoint READ-ONLY của AI service, **không** tốn lượt AI.
   * Lỗi 1 nguồn không chặn nguồn kia → mỗi metric tự hiển thị "—".
   */
  useEffect(() => {
    let cancelled = false;

    void (async () => {
      const [hoursRes, briefRes] = await Promise.all([
        getProductiveHours(),
        getTodayBriefing("en"),
      ]);
      if (cancelled) return;

      if (hoursRes.ok) setProductive(hoursRes.data);
      if (briefRes.ok) setBriefing(briefRes.data);
      setMetricsLoading(false);
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  /* ---------- Load số khối thời gian cho cả tháng (mini calendar) ----------
   * Chỉ đếm, không map sang FocusSlot, nên không đụng logic timeline.
   */
  useEffect(() => {
    let cancelled = false;

    void (async () => {
      const year = monthAnchor.getFullYear();
      const month = monthAnchor.getMonth();
      // Phủ rộng hơn tháng 1 tuần mỗi bên để lưới 6 tuần không bị thiếu dữ liệu.
      const from = new Date(year, month, 1 - 7);
      const to = new Date(year, month + 1, 7);

      const res = await listCalendar({
        from: from.toISOString(),
        to: to.toISOString(),
        includeCancelled: false,
      });
      if (cancelled) return;

      if (!res.ok) {
        setMonthCounts(new Map());
        setLoadedMonthKey(monthKeyOf(year, month));
        return;
      }

      // Dedupe theo (taskId/subTaskId + start) để không đếm trùng 2 nguồn.
      const seen = new Set<string>();
      const counts = new Map<string, number>();
      for (const item of res.data.items ?? []) {
        const start = new Date(item.start);
        if (Number.isNaN(start.getTime())) continue;
        const key = `${item.subTaskId ?? item.taskId ?? item.id}|${item.start}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const k = dayKey(start);
        counts.set(k, (counts.get(k) ?? 0) + 1);
      }

      setMonthCounts(counts);
      setLoadedMonthKey(monthKeyOf(year, month));
    })();

    return () => {
      cancelled = true;
    };
  }, [monthAnchor]);

  /* ---------- Trạng thái kết nối Google Calendar ----------
   * Dùng hook `useGoogleCalendar` để dùng chung nguồn sự thật với trang
   * Schedule (và user menu trong SiteLayout). Hook tự lo phần connect /
   * sync / disconnect + trạng thái reconnect.
   */
  const {
    isConnected: googleConnected,
    connect: connectGoogle,
    sync: syncGoogle,
    reconnectRequired,
  } = useGoogleCalendar(Boolean(user));

  /* ---------- Tính lại status + nowMs mỗi TICK_MS ----------
   * Lý do: status (`done`/`running`/`next`) chỉ đúng tại thời điểm load.
   * Khi khung hiện tại hết giờ, ta cần tự động đánh `done` cho nó và thăng
   * cấp khung kế tiếp lên `next`/`running`. Tick mỗi 30 giây đủ mịn cho
   * đồng hồ đếm ngược, không tốn render.
   */
  useEffect(() => {
    const tick = () => {
      const nowMs = Date.now();
      setFocusSlots((prev) => {
        if (prev.length === 0) return prev;
        // Dùng chung `withUpNext` với lúc load: luôn đảm bảo đúng 1 `running`
        // và đúng 1 `next`, nên không bao giờ tồn tại 2 badge "Up next".
        const nextList = withUpNext(prev, nowMs);
        // Bỏ qua setState nếu không có gì đổi (tránh render thừa mỗi 30s).
        const unchanged =
          nextList.length === prev.length &&
          nextList.every(
            (s, i) =>
              s.status === prev[i].status && s.nowMs === prev[i].nowMs,
          );
        return unchanged ? prev : nextList;
      });
    };
    // Tick ngay lập tức (phòng trường hợp load xong đã muộn hơn giờ kết thúc
    // của slot đầu), sau đó đặt interval.
    tick();
    const id = window.setInterval(tick, TICK_MS);
    return () => window.clearInterval(id);
  }, []);

  /**
   * Mở hộp thoại đồng bộ Google Calendar.
   *
   * ⚠️ Theo spec `GOOGLE_CALENDAR_SYNC_FE.md` mục 5: phải hỏi rõ **hướng**
   * và khoảng ngày, vì chiều đẩy lên sẽ ghi vào lịch Google thật của user.
   * → Nút nhanh ở Dashboard chỉ mở hộp thoại, không tự đồng bộ.
   */
  function handleSync() {
    if (syncing) return;
    setSyncError(null);
    setSyncResult(null);
    setSyncOpen(true);
  }

  /**
   * Gửi sync theo hướng + khoảng ngày đã chọn trong hộp thoại.
   */
  async function handleSyncSubmit(options: {
    from: string | null;
    to: string | null;
    direction: GoogleCalendarSyncDirection;
  }) {
    setSyncing(true);
    showToast("Scanning and syncing with Google Calendar…", "sync");
    const res = await syncGoogle({
      from: options.from,
      to: options.to,
      direction: options.direction,
    });
    setSyncing(false);
    if (!res.ok) {
      // 401 / chưa liên kết → nhắc user kết nối thay vì báo lỗi kỹ thuật.
      const notConnected =
        res.status === 401 || res.status === 400 || res.status === 404;
      if (notConnected && res.status !== 400) {
        showToast(
          "Google Calendar isn't linked yet. Connect it on the Schedule page.",
          "error",
        );
        setSyncOpen(false);
        return;
      }
      // 409 `GOOGLE_RECONNECT_REQUIRED` → gợi ý kết nối lại (hook set cờ).
      if (res.status === 409 && res.errorCode === "GOOGLE_RECONNECT_REQUIRED") {
        setSyncError(
          "Your Google Calendar connection expired or was revoked. Reconnect Google Calendar and try syncing again.",
        );
        return;
      }
      if (res.status === 502) {
        setSyncError(
          "Google Calendar is having trouble or the connection dropped. Please try again later.",
        );
        return;
      }
      // Lỗi khác (VD `to` trước `from`) → giữ hộp thoại mở để user sửa.
      setSyncError(res.error);
      return;
    }
    setSyncError(null);
    // Giữ hộp thoại mở để user xem kết quả chi tiết (đặc biệt `pushErrors`).
    setSyncResult(res.data);

    const { added, updated, cancelled } = res.data;
    const pushFailed = res.data.pushFailed ?? 0;
    const pushed = res.data.pushedCreated ?? 0;

    if (pushFailed > 0) {
      showToast(
        `Sync finished with errors: ${pushFailed} slots couldn't be pushed. Try again later.`,
        "error",
      );
    } else {
      const parts = [
        `${added} added`,
        `${updated} updated`,
        `${cancelled} cancelled`,
      ];
      if (pushed > 0) parts.push(`${pushed} pushed`);
      showToast(`Synced: ${parts.join(" · ")}`, "sync_done");
    }
    // Slot có thể đổi giờ sau khi sync → nạp lại timeline hôm nay.
    void loadTodaySchedule();
  }

  // Take the first whitespace-separated name part for the greeting
  // (e.g. "Hi <First> 👋") with a safe fallback when name is null.
  const firstName = (user?.name ?? "there").trim().split(/\s+/)[0];

  /* ---------- Số liệu phái sinh cho welcome bar + metrics ---------- */
  // Khung tương lai gần nhất (đã được withUpNext đánh status "next").
  const nextSlot = focusSlots.find((s) => s.status === "next") ?? null;
  // Tổng phút của các khối đã hoàn thành hôm nay.
  const doneMinutes = sumDoneMinutes(focusSlots);
  const doneSlots = focusSlots.filter((s) => s.status === "done").length;
  const totalSlots = focusSlots.length;
  const donePercent =
    totalSlots === 0 ? 0 : Math.round((doneSlots / totalSlots) * 100);
  // Nhãn thứ trong tuần theo ngôn ngữ đang dùng của máy (không hardcode).
  const weekdayLabel = new Date().toLocaleDateString("en-US", {
    weekday: "long",
  });

  /* ---------- Số liệu metric card (100% từ API, không bịa) ---------- */

  /* Metric 1: Giờ hiệu quả — GET /profile/productive-hours */
  // Giờ có điểm cao nhất (null = BE chưa có dữ liệu).
  const peakHour = useMemo(
    () => findPeakHour(productive?.hours),
    [productive?.hours],
  );
  // Điểm của giờ đỉnh (phần trăm 0–100), null = chưa có dữ liệu.
  const peakScore = useMemo(() => {
    if (peakHour === null) return null;
    return toPercent(productive?.hours?.[peakHour]);
  }, [productive?.hours, peakHour]);
  // Khung giờ vàng. Ưu tiên `top_hours` do BE trả (đã tính sẵn từ hồ sơ
  // năng suất); fallback tự gom từ `hours[]` nếu BE chưa có.
  const peakBlocks = useMemo(() => {
    const top = productive?.top_hours ?? [];
    const fromApi = top
      .map((r) => {
        const start = parseHourFromClock(r.start);
        const end = parseHourFromClock(r.end);
        if (start === null || end === null || end <= start) return null;
        return { start, end };
      })
      .filter((b): b is { start: number; end: number } => b !== null);
    if (fromApi.length > 0) return fromApi;
    return findPeakBlocks(productive?.hours);
  }, [productive]);
  // Nhãn khung giờ vàng đầu tiên, fallback sang giờ đỉnh đơn lẻ.
  const peakLabel = peakBlocks.length
    ? fmtPeakBlock(peakBlocks[0])
    : peakHour !== null
      ? fmtHourLabel(peakHour)
      : "—";

  /* Metric 2: Task ưu tiên — GET /briefing/today */
  const topTasks = useMemo(() => briefing?.top_tasks ?? [], [briefing]);
  // Tổng phút còn lại của các task ưu tiên (BE đã quy đổi sẵn).
  const topRemainingMinutes = useMemo(
    () => topTasks.reduce((sum, t) => sum + (t.remaining_minutes ?? 0), 0),
    [topTasks],
  );

  /* Metric 3: Task thiếu thời gian — GET /briefing/today (at_risk) */
  const atRisk = useMemo(() => briefing?.at_risk ?? [], [briefing]);
  // Task at-risk sắp hết hạn nhất → hiển thị deadline gần nhất.
  const nearestRisk = useMemo(() => {
    if (atRisk.length === 0) return null;
    return atRisk
      .filter((t) => t.deadline && !Number.isNaN(new Date(t.deadline).getTime()))
      .sort(
        (a, b) =>
          new Date(a.deadline).getTime() - new Date(b.deadline).getTime(),
      )[0] ?? null;
  }, [atRisk]);
  // Tổng phút còn thiếu của các task at-risk.
  const atRiskMissingMinutes = useMemo(
    () => atRisk.reduce((sum, t) => sum + (t.missing_minutes ?? 0), 0),
    [atRisk],
  );
  // Nhãn deadline gần nhất: "Due today" / "in 2d" / "3d overdue".
  const nearestRiskLabel = useMemo(() => {
    if (!nearestRisk) return "—";
    const days = daysUntil(nearestRisk.deadline);
    if (days === null) return "—";
    return fmtDaysLeft(days);
  }, [nearestRisk]);
  // Tỉ lệ task thiếu thời gian / tổng task AI đang theo dõi (0–100).
  const riskRatioPercent = useMemo(() => {
    const tracked = topTasks.length + atRisk.length;
    if (tracked === 0) return 0;
    return Math.round((atRisk.length / tracked) * 100);
  }, [topTasks.length, atRisk.length]);

  /* Metric 4: Lịch hôm nay — tổng phút đã xếp (kể cả khung chưa tới giờ). */
  const scheduledMinutes = useMemo(
    () =>
      focusSlots.reduce((acc, s) => {
        const mins = Math.round((s.endMs - s.startMs) / 60_000);
        return acc + (Number.isFinite(mins) && mins > 0 ? mins : 0);
      }, 0),
    [focusSlots],
  );

  /* ---------- Mini calendar: lưới 6 tuần của tháng đang xem ---------- */
  const miniDays = useMemo(
    () => buildMiniMonth(monthAnchor, monthCounts),
    [monthAnchor, monthCounts],
  );
  // Nhãn tháng: "October 2026"
  const monthLabel = monthAnchor.toLocaleDateString("en-US", {
    month: "long",
    year: "numeric",
  });
  // Đang tải khi tháng hiện tại chưa từng tải xong.
  const monthLoading =
    loadedMonthKey !== monthKeyOf(monthAnchor.getFullYear(), monthAnchor.getMonth());
  // Số ngày có lịch trong tháng đang xem (để hiện ở footer rail).
  const daysWithSlots = useMemo(
    () =>
      miniDays.filter((d) => d.inMonth && d.count > 0).length,
    [miniDays],
  );

  return (
    <div className="dash">
      <div className="dash-ambient" aria-hidden="true" />

      <div className="dash-container">
        {/* ================= Welcome Bar ================= */}
        <section
          className={"dash-welcome" + (pageMounted ? " dash-welcome--in" : "")}
        >
          <div className="dash-welcome-text">
            <span className="dash-eyebrow">
              <span
                className="material-symbols-outlined"
                style={{ fontVariationSettings: "'FILL' 1" }}
              >
                auto_awesome
              </span>
              Cognitive Co-Pilot
            </span>
            <h1 className="dash-title">
              Hi {firstName}{" "}
              <span
                className="dash-wave"
                role="img"
                aria-label="hello"
              >
                👋
              </span>
            </h1>
            <p className="dash-subtitle">
              {slotsLoading ? (
                <>Today you have{" "}
                  <span className="dash-strong">…</span> focus tasks set up.</>
              ) : (
                <>
                  Today you have{" "}
                  <span className="dash-strong">
                    {focusSlots.length} focus {focusSlots.length === 1 ? "task" : "tasks"}
                  </span>
                  {" · "}
                  <span className="dash-success">
                    {fmtMinutes(doneMinutes)} completed
                  </span>
                  {". "}
                  {nextSlot ? (
                    <>
                      Up next at{" "}
                      <span className="dash-strong">{nextSlot.start}</span>.
                    </>
                  ) : focusSlots.length > 0 ? (
                    <>Everything left for today is already done.</>
                  ) : (
                    <>No blocks scheduled yet — let AI draft one.</>
                  )}
                </>
              )}
            </p>
          </div>

          <div className="dash-actions">
            <Link
              to="/briefing"
              className="dash-btn dash-btn--ghost"
              title="AI summary of your priority tasks, tasks missing time and today's focus windows"
            >
              <span className="material-symbols-outlined dash-btn-icon">
                auto_awesome
              </span>
              <span>Today's briefing</span>
            </Link>
            <button
              type="button"
              onClick={handleSync}
              className="dash-btn dash-btn--primary"
              disabled={syncing}
              title={
                googleConnected
                  ? "Two-way sync with Google Calendar"
                  : "Not linked yet — connect it on the Schedule & Tasks page"
              }
            >
              <span
                className={
                  "material-symbols-outlined dash-btn-icon" +
                  (syncing ? " dash-btn-icon--spin" : "")
                }
              >
                sync
              </span>
              <span>{googleConnected ? "Sync Google Calendar" : "Google Calendar"}</span>
            </button>
          </div>
        </section>

        {/* ================= 4 Key Metrics (dữ liệu thật từ API) ================= */}
        <section
          className={"dash-metrics" + (pageMounted ? " dash-metrics--in" : "")}
        >
          {/* Metric 1: Giờ hiệu quả — GET /profile/productive-hours */}
          <article
            className={
              "dash-metric" +
              (metricsAnim.mounted ? " dash-metric--in" : "")
            }
            style={metricsAnim.getDelay(0)}
          >
            <div className="dash-metric-head">
              <span className="dash-metric-label">Peak focus hours</span>
              <span
                className={
                  "dash-chip " +
                  (productive?.onboarded
                    ? "dash-chip--success"
                    : "dash-chip--muted")
                }
              >
                {productive?.onboarded ? "Set" : "Not set"}
              </span>
            </div>
            <div className="dash-metric-value">
              <span className="dash-metric-number">
                {peakScore === null ? "—" : `${peakScore}%`}
              </span>
              <span className="dash-metric-trend">
                <span className="material-symbols-outlined">schedule</span>
                Best hour
              </span>
            </div>
            <div className="dash-metric-foot">
              <span>Deep work window</span>
              <span className="dash-metric-foot-emph">{peakLabel}</span>
            </div>
            {/* Thanh nhiệt 24 giờ — dựng từ `hours[]` thật của API. */}
            <div
              className="dash-hours"
              role="img"
              aria-label={
                peakScore === null
                  ? "No productive hours data yet"
                  : `Peak focus ${peakScore}% at ${peakLabel}`
              }
            >
              {(productive?.hours ?? Array.from({ length: 24 }, () => 0)).map(
                (v, i) => {
                  const pct = toPercent(v) ?? 0;
                  return (
                    <span
                      key={i}
                      className={
                        "dash-hour" +
                        (i === peakHour ? " dash-hour--peak" : "")
                      }
                      style={{ opacity: pct === 0 ? 0.12 : 0.25 + pct / 133 }}
                      title={`${fmtHourLabel(i)} — ${pct}%`}
                    />
                  );
                },
              )}
            </div>
          </article>

          {/* Metric 2: Task ưu tiên — GET /briefing/today (top_tasks) */}
          <article
            className={
              "dash-metric" +
              (metricsAnim.mounted ? " dash-metric--in" : "")
            }
            style={metricsAnim.getDelay(1)}
          >
            <div className="dash-metric-head">
              <span className="dash-metric-label">Priority tasks</span>
              <span className="dash-chip dash-chip--primary">AI</span>
            </div>

            <div className="dash-metric-value">
              <span className="dash-metric-number">
                {metricsLoading ? "…" : topTasks.length}
              </span>
              {topTasks.length > 0 && (
                <span className="dash-metric-trend">
                  <span className="material-symbols-outlined">timer</span>
                  {fmtMinutes(topRemainingMinutes)} left
                </span>
              )}
            </div>

            <div className="dash-metric-foot dash-metric-foot--pinned">
              <span>Time needed today</span>
              <span className="dash-metric-foot-emph">
                {topTasks.length === 0
                  ? "Nothing queued"
                  : fmtMinutes(topRemainingMinutes)}
              </span>
            </div>

            {/* Thanh: phần phút đã ước tính / tổng phút việc hôm nay. */}
            <div
              className="dash-bar"
              role="img"
              aria-label={
                topTasks.length === 0
                  ? "No priority tasks"
                  : `${topTasks.length} priority tasks, ${fmtMinutes(topRemainingMinutes)} remaining`
              }
            >
              <div
                className="dash-bar-seg dash-bar-seg--tasks"
                style={{ width: "100%" }}
              />
            </div>
          </article>

          {/* Metric 3: Task thiếu thời gian — GET /briefing/today (at_risk) */}
          <article
            className={
              "dash-metric" +
              (metricsAnim.mounted ? " dash-metric--in" : "")
            }
            style={metricsAnim.getDelay(2)}
          >
            <div className="dash-metric-head">
              <span className="dash-metric-label">At risk</span>
              <span
                className={
                  "dash-chip " +
                  (atRisk.length > 0
                    ? "dash-chip--warning"
                    : "dash-chip--success")
                }
              >
                {atRisk.length > 0 ? "Needs time" : "All clear"}
              </span>
            </div>
            <div className="dash-metric-value">
              <span className="dash-metric-number">
                {metricsLoading ? "…" : atRisk.length}
              </span>
              {atRisk.length > 0 && (
                <span className="dash-metric-trend">
                  <span className="material-symbols-outlined">warning</span>
                  {fmtMinutes(atRiskMissingMinutes)} short
                </span>
              )}
            </div>
            <div className="dash-metric-foot dash-metric-foot--pinned">
              <span>Nearest deadline</span>
              <span className="dash-metric-foot-emph">
                {nearestRiskLabel}
              </span>
            </div>
            {/* Thanh: tỉ lệ task thiếu thời gian trong tổng việc AI đang theo dõi. */}
            <div
              className="dash-bar"
              role="img"
              aria-label={
                atRisk.length === 0
                  ? "No tasks are missing time"
                  : `${atRisk.length} tasks are missing ${fmtMinutes(atRiskMissingMinutes)} of time`
              }
            >
              <div
                className="dash-bar-seg dash-bar-seg--risk"
                style={{
                  width: `${riskRatioPercent}%`,
                }}
              />
            </div>
          </article>

          {/* Metric 4: Lịch hôm nay — GET /api/calendar (đã load sẵn cho timeline) */}
          <article
            className={
              "dash-metric" +
              (metricsAnim.mounted ? " dash-metric--in" : "")
            }
            style={metricsAnim.getDelay(3)}
          >
            <div className="dash-metric-head">
              <span className="dash-metric-label">Today's schedule</span>
              <span className="dash-chip dash-chip--success">
                {weekdayLabel}
              </span>
            </div>
            <div className="dash-metric-value">
              <span className="dash-metric-number">
                {doneSlots}/{totalSlots}
              </span>
              {totalSlots > 0 && (
                <span className="dash-metric-trend">
                  <span className="material-symbols-outlined">schedule</span>
                  {fmtMinutes(scheduledMinutes)}
                </span>
              )}
            </div>
            <div className="dash-metric-foot dash-metric-foot--pinned">
              <span>Remaining today</span>
              <span className="dash-metric-foot-emph">
                {totalSlots === 0
                  ? "Nothing scheduled"
                  : totalSlots - doneSlots === 0
                    ? "All cleared"
                    : `${totalSlots - doneSlots} to resolve`}
              </span>
            </div>
            <div
              className="dash-progress"
              role="progressbar"
              aria-valuenow={donePercent}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-label="Completed time today"
            >
              <div
                className="dash-progress-fill"
                style={{ width: `${donePercent}%` }}
              />
            </div>
          </article>
        </section>

        {/* ================= Rail trái: mini calendar + summary ================= */}
        <aside className="dash-rail" aria-label="Month calendar">
          <div className="dash-rail-block dash-rail-cal">
            <div className="dash-rail-cal-head">
              <button
                type="button"
                className="dash-rail-nav"
                onClick={() =>
                  setMonthAnchor(
                    (d) => new Date(d.getFullYear(), d.getMonth() - 1, 1),
                  )
                }
                aria-label="Previous month"
              >
                <span className="material-symbols-outlined">chevron_left</span>
              </button>
              <span className="dash-rail-cal-month">{monthLabel}</span>
              <button
                type="button"
                className="dash-rail-nav"
                onClick={() =>
                  setMonthAnchor(
                    (d) => new Date(d.getFullYear(), d.getMonth() + 1, 1),
                  )
                }
                aria-label="Next month"
              >
                <span className="material-symbols-outlined">chevron_right</span>
              </button>
            </div>

            <div className="dash-rail-cal-weekdays" aria-hidden="true">
              {["M", "T", "W", "T", "F", "S", "S"].map((d, i) => (
                <span key={i} className="dash-rail-cal-weekday">
                  {d}
                </span>
              ))}
            </div>

            <div
              className={
                "dash-rail-cal-grid" +
                (monthLoading ? " dash-rail-cal-grid--loading" : "")
              }
            >
              {miniDays.map((d) => {
                const classes =
                  "dash-rail-cal-day" +
                  (d.inMonth ? "" : " dash-rail-cal-day--out") +
                  (d.isToday ? " dash-rail-cal-day--today" : "") +
                  (d.count > 0 ? " dash-rail-cal-day--has" : "");
                return (
                  <button
                    key={dayKey(d.date)}
                    type="button"
                    className={classes}
                    onClick={() => navigate("/schedule")}
                    title={
                      d.count > 0
                        ? `${d.count} time blocks`
                        : "Nothing scheduled"
                    }
                    aria-label={`${d.date.getDate()}${
                      d.count > 0 ? `, ${d.count} blocks` : ""
                    }`}
                  >
                    <span className="dash-rail-cal-day-num">
                      {d.date.getDate()}
                    </span>
                    {d.count > 0 && (
                      <span className="dash-rail-cal-day-dot" aria-hidden="true" />
                    )}
                  </button>
                );
              })}
            </div>

            <Link
              to="/schedule"
              className="dash-rail-cal-foot"
            >
              <span>
                {daysWithSlots} days with scheduled blocks this month
              </span>
              <span className="material-symbols-outlined">arrow_forward</span>
            </Link>
          </div>

          <div className="dash-rail-block">
            <h3 className="dash-rail-title">Today</h3>
            <div className="dash-rail-stat">
              <span className="dash-rail-stat-label">Completed</span>
              <span className="dash-rail-stat-value">
                {doneSlots}/{totalSlots}
              </span>
            </div>
            <div className="dash-rail-stat">
              <span className="dash-rail-stat-label">Focus time</span>
              <span className="dash-rail-stat-value">
                {fmtMinutes(doneMinutes)}
              </span>
            </div>
            <div className="dash-rail-stat">
              <span className="dash-rail-stat-label">Next up</span>
              <span className="dash-rail-stat-value">
                {nextSlot ? nextSlot.start : "—"}
              </span>
            </div>
          </div>
        </aside>

        {/* ================= Workspace (8/4) ================= */}
        <section
          className={
            "dash-workspace" + (pageMounted ? " dash-workspace--in" : "")
          }
        >
          {/* Left column: Focus slots */}
          <div className="dash-col-left">
            <div className="dash-col-head">
              <div className="dash-col-head-left">
                <span className="dash-col-dot" />
                <h2 className="dash-col-title">Today's recommended schedule</h2>
              </div>
            </div>

            <div className="dash-slots">
              {slotsLoading && (
                <div className="dash-slots-state">
                  <span className="material-symbols-outlined dash-slots-state-icon">
                    progress_activity
                  </span>
                  <span>Loading today's schedule…</span>
                </div>
              )}

              {!slotsLoading && slotsError && (
                <div className="dash-slots-state dash-slots-state--error">
                  <span className="material-symbols-outlined dash-slots-state-icon">
                    error
                  </span>
                  <span>{slotsError}</span>
                  <button
                    type="button"
                    className="dash-slots-state-retry"
                    onClick={() => void loadTodaySchedule()}
                  >
                    Retry
                  </button>
                </div>
              )}

              {!slotsLoading && !slotsError && focusSlots.length === 0 && (
                <div className="dash-empty">
                  <span
                    className="material-symbols-outlined dash-empty-icon"
                    aria-hidden="true"
                  >
                    event_available
                  </span>
                  <h3 className="dash-empty-title">
                    No time blocks scheduled today
                  </h3>
                  <p className="dash-empty-text">
                    AI can schedule for you in a few seconds — pick a project in
                    Copilot, suggest time slots, then approve and you're done.
                  </p>
                  <div className="dash-empty-actions">
                    <Link
                      to="/copilot"
                      className="dash-btn dash-btn--primary dash-empty-btn"
                    >
                      <span className="material-symbols-outlined dash-btn-icon">
                        auto_awesome
                      </span>
                      <span>Plan with AI</span>
                    </Link>
                    <Link
                      to="/schedule"
                      className="dash-btn dash-btn--ghost dash-empty-btn"
                    >
                      <span className="material-symbols-outlined dash-btn-icon">
                        calendar_month
                      </span>
                      <span>Open Schedule</span>
                    </Link>
                  </div>
                </div>
              )}

              {focusSlots.map((slot, i) => (
                <FocusSlotCard
                  key={`${slotsAnim.bumpKey}-${slot.id}-${i}`}
                  slot={slot}
                  index={i}
                  mounted={slotsAnim.mounted}
                  delayStyle={slotsAnim.getDelay(i)}
                />
              ))}
            </div>

            <div className="dash-col-footer">
              <Link
                to="/dashboard"
                className="dash-link-primary"
                onClick={(e) => e.preventDefault()}
              >
                <span>View full detailed schedule</span>
                <span className="material-symbols-outlined">arrow_forward</span>
              </Link>
            </div>
          </div>

          {/* Right column: Deadline radar + AI tip */}
          <aside className="dash-col-right">
            <div className="dash-col-head">
              <div className="dash-col-head-left">
                <span className="material-symbols-outlined dash-col-icon">
                  radar
                </span>
                <h2 className="dash-col-title">Deadline radar</h2>
              </div>
              {radar.length > 0 && (
                <span className="dash-col-meta">{radar.length} projects</span>
              )}
            </div>

            <div className="dash-radar">
              {radarLoading && (
                <div className="dash-radar-state">
                  <span className="material-symbols-outlined dash-radar-state-icon">
                    progress_activity
                  </span>
                  <span>Loading projects…</span>
                </div>
              )}

              {!radarLoading && radar.length === 0 && (
                <div className="dash-radar-state">
                  <span className="material-symbols-outlined dash-radar-state-icon">
                    event_busy
                  </span>
                  <span>No projects are due soon.</span>
                  <Link to="/projects" className="dash-link-primary">
                    <span>Open Projects</span>
                    <span className="material-symbols-outlined">arrow_forward</span>
                  </Link>
                </div>
              )}

              <div className="dash-radar-list">
                {radar.map((r, i) => (
                  <RadarRow
                    key={`${radarAnim.bumpKey}-${r.id}`}
                    item={r}
                    mounted={radarAnim.mounted}
                    delayStyle={radarAnim.getDelay(i)}
                  />
                ))}
              </div>
            </div>

            {/* AI tip */}
            <div className="dash-tip">
              <span
                className="material-symbols-outlined dash-tip-icon"
                style={{ fontVariationSettings: "'FILL' 1" }}
              >
                tips_and_updates
              </span>
              <div className="dash-tip-body">
                <div className="dash-tip-head">
                  <span className="dash-tip-title">AI suggestion</span>
                  <span className="dash-tip-dot" />
                </div>
                <p className="dash-tip-text">
                  {focusSlots.length > 0
                    ? "Your best time today falls inside the blocks that are running — prioritise deep work before 16:30."
                    : "Nothing scheduled today. Open Copilot and let AI plan around your nearest deadline."}
                </p>
              </div>
            </div>
          </aside>
        </section>
      </div>

      {/* ================= AI Copilot FAB (góc phải dưới) ================= */}
      <button
        type="button"
        className="dash-fab"
        onClick={() => navigate("/copilot")}
        aria-label="Open AI Copilot"
        title="Open AI Copilot"
      >
        <span className="dash-fab-glow" aria-hidden="true" />
        <span
          className="material-symbols-outlined dash-fab-icon"
          aria-hidden="true"
        >
          smart_toy
        </span>
      </button>

      {/* ================= Toast ================= */}
      <div
        className={"dash-toast" + (toast.visible ? " dash-toast--show" : "")}
        role="status"
        aria-live="polite"
      >
        <span
          className={
            "material-symbols-outlined dash-toast-icon" +
            (toast.icon === "sync" ? " dash-toast-icon--spin" : "")
          }
        >
          {toast.icon}
        </span>
        <span className="dash-toast-text">{toast.text}</span>
      </div>

      {/* ================= Hộp thoại đồng bộ Google Calendar =================
          Chọn hướng (kéo về / đẩy lên / cả hai) + khoảng ngày.
          Bắt buộc hỏi hướng vì chiều đẩy lên ghi vào lịch Google thật. */}
      {syncOpen && (
        <GoogleCalendarSyncDialog
          busy={syncing}
          serverError={syncError}
          needsReconnect={reconnectRequired}
          result={syncResult}
          onReconnect={() => {
            setSyncOpen(false);
            void connectGoogle();
          }}
          onSubmit={(opts) => void handleSyncSubmit(opts)}
          onBack={() => setSyncResult(null)}
          onClose={() => {
            setSyncOpen(false);
            setSyncError(null);
            setSyncResult(null);
          }}
        />
      )}
    </div>
  );
}

/* ============================================================
 * Sub-components
 * ============================================================ */

function FocusSlotCard({
  slot,
  mounted,
  delayStyle,
}: {
  slot: FocusSlot;
  index: number;
  mounted: boolean;
  delayStyle: { animationDelay: string };
}) {
  const isRunning = slot.status === "running";
  const isNext = slot.status === "next";
  const isDone = slot.status === "done";

  // Đếm ngược cho khung đang chạy: phần giờ còn lại tới `end`.
  const remainMs = (slot.endMs ?? 0) - slot.nowMs;
  const isEndingSoon = isRunning && remainMs > 0 && remainMs <= SOON_THRESHOLD_MS;
  const remainLabel = isRunning
    ? formatRemain(remainMs)
    : null;

  return (
    <article
      className={
        "dash-slot" +
        ` dash-slot--t-${slot.type}` +
        (isRunning ? " dash-slot--running" : "") +
        (isNext ? " dash-slot--next" : "") +
        (isEndingSoon ? " dash-slot--ending" : "") +
        (isDone ? " dash-slot--done" : "") +
        (mounted ? " dash-slot--in" : "")
      }
      style={delayStyle}
    >
      <span className="dash-slot-bar" aria-hidden="true" />

      <div className="dash-slot-time">
        <span
          className={
            "dash-slot-time-start" +
            (isRunning || isNext ? " dash-slot-time-start--focus" : "")
          }
        >
          {slot.start}
        </span>
        <span className="dash-slot-time-end">{slot.end}</span>
        <span className="dash-slot-time-rule" aria-hidden="true" />
      </div>

      <div className="dash-slot-body">
        <div className="dash-slot-tags">
          {slot.tags.map((t, i) => (
            <span
              key={i}
              className={
                "dash-tag" +
                (t.tone === "primary"
                  ? " dash-tag--primary"
                  : t.tone === "success"
                    ? " dash-tag--success"
                    : t.tone === "warning"
                      ? " dash-tag--warning"
                      : " dash-tag--muted")
              }
            >
              {t.tone === "primary" && (
                <span className="material-symbols-outlined dash-tag-icon">
                  bolt
                </span>
              )}
              {t.tone === "success" && (
                <span
                  className="material-symbols-outlined dash-tag-icon"
                  style={{ fontVariationSettings: "'FILL' 1" }}
                >
                  check_circle
                </span>
              )}
              {t.label}
            </span>
          ))}
        </div>
        <h3 className="dash-slot-title">{slot.title}</h3>
        <p className="dash-slot-desc">{slot.desc}</p>
      </div>

      <div className="dash-slot-right">
        {slot.status === "done" && (
          <span className="dash-slot-status dash-slot-status--done">
            <span
              className="material-symbols-outlined"
              style={{ fontVariationSettings: "'FILL' 1", fontSize: 14 }}
            >
              check_circle
            </span>
            Done
          </span>
        )}
        {slot.status === "running" && (
          <span className="dash-slot-status dash-slot-status--running">
            <span className="dash-slot-ping dash-slot-ping--running" aria-hidden="true" />
            <span className="dash-slot-status-meta">
              <span className="dash-slot-status-eyebrow">In progress</span>
              <span className="dash-slot-status-time" aria-live="polite">
                {remainLabel ? `${remainLabel} left` : "Ending"}
              </span>
            </span>
          </span>
        )}
        {slot.status === "next" && (
          <span className="dash-slot-status dash-slot-status--next">
            <span className="dash-slot-ping" aria-hidden="true" />
            Up next
          </span>
        )}
        {slot.status === "upcoming" && (
          <button
            type="button"
            title="Snooze"
            aria-label="Options"
            className="dash-slot-more"
          >
            <span className="material-symbols-outlined">more_horiz</span>
          </button>
        )}
      </div>
    </article>
  );
}

/**
 * Một dòng deadline trong radar: tên project · client · số ngày còn lại ·
 * thanh progress thật. Click để mở detail của project đó.
 */
function RadarRow({
  item,
  mounted,
  delayStyle,
}: {
  item: RadarItem;
  mounted: boolean;
  delayStyle: { animationDelay: string };
}) {
  const overdue = (item.daysLeft ?? 0) < 0;
  const soon = !overdue && (item.daysLeft ?? 99) <= 3;

  return (
    <Link
      to={`/projects/${item.id}`}
      className={
        "dash-radar-item" +
        (overdue ? " dash-radar-item--overdue" : "") +
        (soon ? " dash-radar-item--soon" : "") +
        (mounted ? " dash-radar-item--in" : "")
      }
      style={delayStyle}
    >
      <div className="dash-radar-item-top">
        <span className="dash-radar-item-name">{item.name}</span>
        <span
          className={
            "dash-radar-item-days" +
            (overdue ? " dash-radar-item-days--overdue" : "") +
            (soon ? " dash-radar-item-days--soon" : "")
          }
        >
          {item.daysLeft === null ? "—" : fmtDaysLeft(item.daysLeft)}
        </span>
      </div>

      <div className="dash-radar-item-meta">
        <span className="dash-radar-item-client">{item.client}</span>
        <span className="dash-radar-item-tasks">
          {item.totalTasks > 0
            ? `${item.doneTasks}/${item.totalTasks} tasks`
            : "No tasks yet"}
        </span>
      </div>

      <div
        className="dash-radar-bar"
        role="progressbar"
        aria-valuenow={item.progress}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={`Progress for ${item.name}`}
      >
        <div
          className="dash-radar-bar-fill"
          style={{ width: `${item.progress}%` }}
        />
      </div>
    </Link>
  );
}
