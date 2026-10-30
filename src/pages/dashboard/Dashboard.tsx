import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useAuth } from "../../auth/AuthContext";
import { useStaggeredMount } from "../../hooks/useStaggeredMount";
import {
  getGoogleCalendarStatus,
  getProjectProgress,
  listCalendar,
  listProjects,
  syncGoogleCalendar,
  type CalendarItemDto,
} from "../../lib/api-client";
import "./dashboard.css";

/* ---------- Hằng số cho nhịp độ của lịch ---------- */
/** Còn dưới ngưỡng này (phút) thì khung đang chạy được tô thêm viền cảnh báo. */
const SOON_THRESHOLD_MS = 5 * 60 * 1000;
/** Chu kỳ tick: đủ mịn cho đồng hồ đếm ngược, rẻ hơn cập nhật mỗi giây. */
const TICK_MS = 30 * 1000;
/** Số project tối đa hiện trong Deadline radar (cột phải). */
const RADAR_LIMIT = 5;

/** "42m" / "1h 05" — định dạng ngắn cho phần thời gian còn lại. */
function formatRemain(ms: number): string {
  if (ms <= 0) return "0m";
  const totalMin = Math.ceil(ms / 60_000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return h > 0 ? `${h}h ${String(m).padStart(2, "0")}` : `${m}m`;
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

const TZ = "vi-VN";

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
    "Khối thời gian tập trung từ lịch của bạn.";

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
 *      - Right (4/12): Quick Task Drawer (input + upcoming + AI tip).
 *
 * Class prefix `.dash-*`. Render bên trong <SiteLayout /> để có header/footer
 * chuẩn + nav active "Trang chủ".
 * ============================================================ */
export function DashboardPage() {
  const { user } = useAuth();
  const navigate = useNavigate();
  // Scratch pad: task user gõ nhanh ở ô quick capture (chỉ tồn tại trong
  // phiên hiện tại — BE chưa có endpoint "inbox" nên chưa lưu được).
  const [quickTask, setQuickTask] = useState("");
  const [captured, setCaptured] = useState<{ id: string; title: string }[]>([]);
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
  // true khi user đã liên kết Google Calendar (đổi hành vi nút Sync).
  const [googleConnected, setGoogleConnected] = useState(false);
  const [syncing, setSyncing] = useState(false);
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
  // Stagger cho các task đã capture (mỗi task +80ms).
  const capturedAnim = useStaggeredMount(80, 260, captured.length);

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
   * chạy sau `await`), còn nút "Thử lại" dùng `loadTodaySchedule`.
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
   * Chỉ để đổi nhãn nút Sync cho đúng thực tế; lỗi thì coi như chưa kết nối.
   */
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const res = await getGoogleCalendarStatus();
      if (cancelled) return;
      setGoogleConnected(res.ok ? !!res.data.isConnected : false);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

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

  function handleQuickAdd(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const v = quickTask.trim();
    if (!v) return;
    setQuickTask("");
    setCaptured((prev) => [{ id: `c${Date.now()}`, title: v }, ...prev]);
    showToast(`Captured "${v.length > 28 ? v.slice(0, 28) + "…" : v}"`);
  }

  function handleSync() {
    if (syncing) return;
    setSyncing(true);
    showToast("Scanning and syncing with Google Calendar…", "sync");
    void (async () => {
      const res = await syncGoogleCalendar();
      setSyncing(false);
      if (!res.ok) {
        // 401 / chưa liên kết → nhắc user kết nối thay vì báo lỗi kỹ thuật.
        const notConnected =
          res.status === 401 || res.status === 400 || res.status === 404;
        showToast(
          notConnected
            ? "Google Calendar chưa được liên kết. Kết nối ở trang Schedule."
            : "Đồng bộ thất bại. Vui lòng thử lại.",
          "error",
        );
        return;
      }
      const { added, updated, cancelled } = res.data;
      showToast(
        `Đã đồng bộ: +${added} mới · ${updated} cập nhật · ${cancelled} huỷ`,
        "sync_done",
      );
      // Slot có thể đổi giờ sau khi sync → nạp lại timeline hôm nay.
      void loadTodaySchedule();
    })();
  }

  function handleQuickAddFocus() {
    const el = document.getElementById("dash-quick-input");
    if (el) {
      el.focus({ preventScroll: true });
      el.classList.add("dash-input--ring");
      window.setTimeout(() => el.classList.remove("dash-input--ring"), 1000);
    }
  }

  // Take the first whitespace-separated name part for the greeting
  // (e.g. "Chào <First> 👋") with a safe fallback when name is null.
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
              title="AI tổng hợp task ưu tiên, task thiếu thời gian và khung giờ tập trung hôm nay"
            >
              <span className="material-symbols-outlined dash-btn-icon">
                auto_awesome
              </span>
              <span>Briefing hôm nay</span>
            </Link>
            <button
              type="button"
              onClick={handleSync}
              className="dash-btn dash-btn--ghost"
              disabled={syncing}
              title={
                googleConnected
                  ? "Đồng bộ 2 chiều với Google Calendar"
                  : "Chưa liên kết — kết nối ở trang Schedule & Tasks"
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
            <button
              type="button"
              onClick={handleQuickAddFocus}
              className="dash-btn dash-btn--primary"
            >
              <span className="material-symbols-outlined dash-btn-icon">
                add
              </span>
              <span>Quick add task</span>
            </button>
          </div>
        </section>

        {/* ================= 3 Key Metrics ================= */}
        <section
          className={"dash-metrics" + (pageMounted ? " dash-metrics--in" : "")}
        >
          {/* Metric 1: Energy Peak */}
          <article
            className={
              "dash-metric" +
              (metricsAnim.mounted ? " dash-metric--in" : "")
            }
            style={metricsAnim.getDelay(0)}
          >
            <div className="dash-metric-head">
              <span className="dash-metric-label">Focus energy</span>
              <span className="dash-chip dash-chip--success">Optimal</span>
            </div>
            <div className="dash-metric-value">
              <span className="dash-metric-number">88%</span>
              <span className="dash-metric-trend">
                <span className="material-symbols-outlined">north_east</span>
                Bio peak
              </span>
            </div>
            <div className="dash-metric-foot">
              <span>Deep work window</span>
              <span className="dash-metric-foot-emph">14:00 - 16:30</span>
            </div>
            <div className="dash-sparkline" aria-hidden="true">
              <svg
                className="dash-sparkline-svg"
                fill="none"
                preserveAspectRatio="none"
                viewBox="0 0 100 32"
              >
                <path
                  d="M0,26 Q20,23 35,13 T65,5 T85,20 T100,16 L100,32 L0,32 Z"
                  fill="currentColor"
                  fillOpacity="0.15"
                />
                <path
                  d="M0,26 Q20,23 35,13 T65,5 T85,20 T100,16"
                  stroke="currentColor"
                  strokeLinecap="round"
                  strokeWidth="2"
                />
              </svg>
            </div>
          </article>

          {/* Metric 2: K_bias */}
          <article
            className={
              "dash-metric" +
              (metricsAnim.mounted ? " dash-metric--in" : "")
            }
            style={metricsAnim.getDelay(1)}
          >
            <div className="dash-metric-head">
              <span className="dash-metric-label">
                Time multiplier
              </span>
              <span className="dash-chip dash-chip--primary">AI</span>
            </div>

            <div className="dash-metric-value">
              <span className="dash-metric-number">1.34x</span>
            </div>

            <div className="dash-metric-foot dash-metric-foot--pinned">
              <span>Bias compensation</span>
              <span className="dash-metric-foot-emph">+34%</span>
            </div>

            <div
              className="dash-bar"
              role="img"
              aria-label="60 min base, 20 min bias compensation, 20 min recovery buffer"
            >
              <div
                className="dash-bar-seg dash-bar-seg--60"
                style={{ width: "60%" }}
              />
              <div
                className="dash-bar-seg dash-bar-seg--20a"
                style={{ width: "20%" }}
              />
              <div
                className="dash-bar-seg dash-bar-seg--20b"
                style={{ width: "20%" }}
              />
            </div>
          </article>

          {/* Metric 3: Today tasks */}
          <article
            className={
              "dash-metric" +
              (metricsAnim.mounted ? " dash-metric--in" : "")
            }
            style={metricsAnim.getDelay(2)}
          >
            <div className="dash-metric-head">
              <span className="dash-metric-label">Today's tasks</span>
              <span className="dash-chip dash-chip--success">
                {weekdayLabel}
              </span>
            </div>
            <div className="dash-metric-value">
              <span className="dash-metric-number">
                {doneSlots}/{totalSlots}
              </span>
            </div>
            <div className="dash-metric-foot dash-metric-foot--pinned">
              <span>Remaining today</span>
              <span className="dash-metric-foot-emph">
                {totalSlots - doneSlots === 0
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
            >
              <div
                className="dash-progress-fill"
                style={{ width: `${donePercent}%` }}
              />
            </div>
          </article>

          {/* Metric 4: Focus minutes đã hoàn thành hôm nay */}
          <article
            className={
              "dash-metric" +
              (metricsAnim.mounted ? " dash-metric--in" : "")
            }
            style={metricsAnim.getDelay(3)}
          >
            <div className="dash-metric-head">
              <span className="dash-metric-label">Focus time</span>
              <span className="dash-chip dash-chip--primary">Log</span>
            </div>
            <div className="dash-metric-value">
              <span className="dash-metric-number">
                {fmtMinutes(doneMinutes)}
              </span>
            </div>
            <div className="dash-metric-foot dash-metric-foot--pinned">
              <span>Completed today</span>
              <span className="dash-metric-foot-emph">
                {doneSlots} {doneSlots === 1 ? "block" : "blocks"}
              </span>
            </div>
            <div
              className="dash-progress"
              role="progressbar"
              aria-valuenow={donePercent}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-label="Phần thời gian đã hoàn thành trong ngày"
            >
              <div
                className="dash-progress-fill"
                style={{ width: `${donePercent}%` }}
              />
            </div>
          </article>
        </section>

        {/* ================= Rail trái: mini calendar + summary ================= */}
        <aside className="dash-rail" aria-label="Lịch tháng">
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
                aria-label="Tháng trước"
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
                aria-label="Tháng sau"
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
                        ? `${d.count} khối thời gian`
                        : "Không có lịch"
                    }
                    aria-label={`${d.date.getDate()}${
                      d.count > 0 ? `, ${d.count} khối` : ""
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
                {daysWithSlots} ngày có lịch tháng này
              </span>
              <span className="material-symbols-outlined">arrow_forward</span>
            </Link>
          </div>

          <div className="dash-rail-block">
            <h3 className="dash-rail-title">Hôm nay</h3>
            <div className="dash-rail-stat">
              <span className="dash-rail-stat-label">Hoàn thành</span>
              <span className="dash-rail-stat-value">
                {doneSlots}/{totalSlots}
              </span>
            </div>
            <div className="dash-rail-stat">
              <span className="dash-rail-stat-label">Thời gian focus</span>
              <span className="dash-rail-stat-value">
                {fmtMinutes(doneMinutes)}
              </span>
            </div>
            <div className="dash-rail-stat">
              <span className="dash-rail-stat-label">Kế tiếp</span>
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
                  <span>Đang tải lịch hôm nay…</span>
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
                    Thử lại
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
                    Chưa có khối thời gian nào hôm nay
                  </h3>
                  <p className="dash-empty-text">
                    AI có thể xếp lịch cho bạn trong vài giây — chọn project
                    trong Copilot, đề xuất khung giờ rồi duyệt là chạy.
                  </p>
                  <div className="dash-empty-actions">
                    <Link
                      to="/copilot"
                      className="dash-btn dash-btn--primary dash-empty-btn"
                    >
                      <span className="material-symbols-outlined dash-btn-icon">
                        auto_awesome
                      </span>
                      <span>Đề xuất lịch bằng AI</span>
                    </Link>
                    <Link
                      to="/schedule"
                      className="dash-btn dash-btn--ghost dash-empty-btn"
                    >
                      <span className="material-symbols-outlined dash-btn-icon">
                        calendar_month
                      </span>
                      <span>Mở Schedule</span>
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

          {/* Right column: Quick capture + Deadline radar + AI tip */}
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

            {/* Quick capture — ghi nhanh việc cần làm */}
            <form className="dash-input-form" onSubmit={handleQuickAdd}>
              <input
                id="dash-quick-input"
                type="text"
                value={quickTask}
                onChange={(e) => setQuickTask(e.target.value)}
                placeholder="Capture a task and press Enter…"
                className="dash-input"
              />
              <button
                type="submit"
                aria-label="Save quickly"
                className="dash-input-submit"
              >
                <span className="material-symbols-outlined">
                  keyboard_return
                </span>
              </button>
            </form>

            {captured.length > 0 && (
              <div className="dash-captured">
                {captured.map((c, i) => (
                  <div
                    key={`${capturedAnim.bumpKey}-${c.id}`}
                    className={
                      "dash-captured-item" +
                      (capturedAnim.mounted ? " dash-captured-item--in" : "")
                    }
                    style={capturedAnim.getDelay(i)}
                  >
                    <span className="dash-captured-dot" aria-hidden="true" />
                    <span className="dash-captured-title">{c.title}</span>
                  </div>
                ))}
              </div>
            )}

            <div className="dash-radar">
              {radarLoading && (
                <div className="dash-radar-state">
                  <span className="material-symbols-outlined dash-radar-state-icon">
                    progress_activity
                  </span>
                  <span>Đang tải dự án…</span>
                </div>
              )}

              {!radarLoading && radar.length === 0 && (
                <div className="dash-radar-state">
                  <span className="material-symbols-outlined dash-radar-state-icon">
                    event_busy
                  </span>
                  <span>Chưa có dự án nào sắp tới hạn.</span>
                  <Link to="/projects" className="dash-link-primary">
                    <span>Mở Projects</span>
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
                    ? "Khung giờ tốt nhất hôm nay nằm trong các block đang chạy — ưu tiên deep work trước 16:30."
                    : "Chưa có lịch hôm nay. Mở Copilot để AI xếp hộ bạn theo deadline gần nhất."}
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
        aria-label="Mở AI Copilot"
        title="Mở AI Copilot"
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
        aria-label={`Tiến độ ${item.name}`}
      >
        <div
          className="dash-radar-bar-fill"
          style={{ width: `${item.progress}%` }}
        />
      </div>
    </Link>
  );
}
