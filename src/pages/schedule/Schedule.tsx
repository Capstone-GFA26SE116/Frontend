import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, Ref } from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router-dom";
import {
  ProposalDialog,
} from "../../components/ScheduleProposal";
import { useScheduleProposal } from "../../components/schedule-proposal-logic";
import { CenterToasts, useCenterToast } from "../../components/Toast";
import { GoogleCalendarSyncDialog } from "../../components/GoogleCalendarSyncDialog";
import { SlotFocusPanel } from "../../components/focus/SlotFocusPanel";
import { SlotFocusActions } from "../../components/focus/SlotFocusActions";
import { useFocusActions } from "../../components/focus/focus-context";
import {
  blockedTooltip,
  computeSequenceGate,
  isItemAllowed,
  type SequencedItem,
  type SequenceGate,
} from "../../components/focus/sequence-logic";
import { isClosedStatus, toSlotPhase } from "../../components/focus/focus-logic";
import { useNotificationsContext } from "../../components/focus/notifications-context-state";
import { signalAffectsSchedule } from "../../hooks/useNotifications";
import { useStaggeredMount } from "../../hooks/useStaggeredMount";
import { useGoogleCalendar } from "../../hooks/useGoogleCalendar";
import {
  createScheduleSlot,
  deleteScheduleSlot,
  getProject,
  listArchivedProjectIds,
  listCalendar,
  listProjects,
  listScheduleSlotsByTask,
  listSubtasks,
  listTasks,
  type CalendarItemDto,
  type GoogleCalendarSyncDirection,
  type GoogleCalendarSyncResultDto,
  type ProjectDto,
  type ScheduleSlotDto,
  type SubtaskDto,
  type TaskDto,
} from "../../lib/api-client";
import { describeSlotOverlapError } from "../../components/schedule/slot-overlap";
import { ScheduleConfirmDialog } from "../../components/schedule/ScheduleConfirmDialog";
import "./schedule.css";

/* ===========================================================
 * Lịch biểu Tuần & Tháng (/schedule, /projects/:projectId/schedule)
 *
 * Nguồn dữ liệu chính (local):
 *   • Task có `deadline`  -> all-day event ở ngày deadline
 *   • Task có `fixedStart` / `fixedEnd` -> event timed
 *   • Subtask có `scheduledStart` / `scheduledEnd` -> event timed
 *
 * Nguồn phụ (Google Calendar) sẽ được merge sau qua GET /api/calendar
 * khi người dùng connect Google account.
 *
 *  1) Header + tabs (Tuần / Tháng / Sprint & Milestone) + CTA
 *  2) Timeline navigator (prev / next / hôm nay) + quick filter
 *  3) 4 KPI tải nhận thức
 *  4) AI ribbon
 *  5) Main: board 7 ngày | lưới tháng | gantt sprint  +  sidebar
 * =========================================================== */

type ViewMode = "week" | "month" | "gantt";
type Tone = "primary" | "secondary" | "tertiary" | "error" | "muted" | "sky";
type FilterId = "all" | "priority" | "capstone" | "deep";
type CalSource = "task" | "subtask" | "milestone" | "google" | "slot";

/**
 * Một "project span" đại diện cho 1 dự án trên timeline (gantt / month accent).
 * Được build từ `ProjectDto` + anchor (start/deadline) + tất cả tasks/subtasks
 * làm anchor, mở rộng về phía trước/sau bằng deadline/fixed* của tasks và
 * scheduled* của subtasks. Mỗi span có 1 màu riêng (hash từ project id).
 */
type ProjectSpan = {
  project: ProjectDto;
  start: Date;
  end: Date;
  color: string;
};

interface CalEvent {
  id: string;
  source: CalSource;
  title: string;
  start: Date;
  end: Date;
  isAllDay: boolean;
  status: string;
  taskId: string | null;
  subTaskId: string | null;
  projectId: string | null;
  /**
   * Việc nhóm của slot nhóm — `null` với lịch cá nhân.
   *
   * ⚠️ Slot nhóm có `taskId = null` (mục 10 của cập nhật BE) → dùng cờ này
   * để biết đây là slot việc nhóm, KHÔNG điều hướng sang trang task cá nhân.
   */
  groupTaskId?: string | null;
  /** Việc con của việc nhóm (slot nhóm). */
  groupSubTaskId?: string | null;
  /** Người được giao slot nhóm. */
  userId?: string | null;
  /** Nhóm sở hữu slot (slot nhóm). */
  groupId?: string | null;
  /** Tên nhóm (slot nhóm) — hiển thị trên card thay vì tên dự án. */
  groupName?: string | null;
  /**
   * Id của schedule slot gắn với event (null = không gắn).
   *
   * Cần cho Focus Session: `POST /api/focus/start` nhận `scheduleSlotId`.
   * Với Calendar API, `CalendarItemDto.id` chính là slot id khi `source = "slot"`
   * — nên ta gán luôn ở đây, không phụ thuộc fallback path.
   */
  scheduleSlotId?: string | null;
  /** Phút dự kiến của slot (dùng làm mốc cho đồng hồ). */
  slotPlannedMinutes?: number | null;
  /**
   * Status của SLOT gốc (khác với `status` của task).
   *
   * Cần vì khi lịch gộp nhiều slot của 1 task thành 1 event, `status` là của
   * task — nhưng quy tắc Start/Stop theo spec lại dựa trên status của SLOT
   * (`Proposed` không Start được, `InProgress` hiện nút Stop...).
   */
  slotStatus?: string | null;
  /** Item gốc: TaskDto | SubtaskDto | ScheduleSlotDto | null (khi là Google event). */
  task?: TaskDto;
  subtask?: SubtaskDto;
  scheduleSlot?: ScheduleSlotDto;
  /** Danh sách ScheduleSlotDto gốc khi event là task aggregate (gộp nhiều slot subtask). */
  aggregatedSlots?: ScheduleSlotDto[];
  /** Danh sách event gốc bị gộp — nguồn chuẩn để modal dựng danh sách subtask. */
  aggregatedEvents?: CalEvent[];
}

interface DayLoad {
  hours: number;
  pct: number;
  label: string;
  tone: Tone;
}

interface DayPlan {
  key: string;
  date: Date;
  badge: string;
  badgeTone: Tone;
  load: DayLoad;
  events: CalEvent[];
  rest?: boolean;
}

const WEEKDAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const MONTH_LABELS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/* ---------- Date helpers ---------- */
function startOfWeek(d: Date): Date {
  const r = new Date(d);
  const day = r.getDay();
  // week starts Monday
  const diff = day === 0 ? -6 : 1 - day;
  r.setDate(r.getDate() + diff);
  r.setHours(0, 0, 0, 0);
  return r;
}
function addDays(d: Date, n: number): Date {
  const r = new Date(d);
  r.setDate(r.getDate() + n);
  return r;
}
function startOfMonth(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), 1);
}
function endOfMonth(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth() + 1, 0, 23, 59, 59, 999);
}
function isSameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}
function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}
function fmtTime(d: Date): string {
  return d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", hour12: false });
}
function durationHours(ev: CalEvent): number {
  if (ev.isAllDay) return Math.max(1, Math.round((ev.end.getTime() - ev.start.getTime()) / 3_600_000));
  return Math.max(0.5, (ev.end.getTime() - ev.start.getTime()) / 3_600_000);
}
function eventTimeRange(ev: CalEvent): string {
  if (ev.isAllDay) return "All day";
  return `${fmtTime(ev.start)} - ${fmtTime(ev.end)}`;
}
/**
 * Khoá sắp xếp theo giờ bắt đầu của 1 event TRONG NGÀY ĐANG XEM.
 *
 * - All-day → đội sớm nhất (đầu ngày).
 * - Aggregate event (task gộp nhiều slot/subtask) → lấy giờ bắt đầu sớm
 *   nhất trong các block con **thuộc ngày này**, vì `ev.start` chỉ là min/max
 *   của cả nhóm (task kéo dài 3 ngày thì `ev.start` là ngày 1).
 * - Event kéo dài qua ngày này (bắt đầu hôm trước) → dùng đầu ngày này.
 */
function eventStartTime(ev: CalEvent, day?: Date): number {
  if (ev.isAllDay) return -Infinity;
  const dayStart = day ? startOfDay(day).getTime() : null;
  const dayEnd = day ? addDays(startOfDay(day), 1).getTime() : null;

  if (ev.aggregatedEvents && ev.aggregatedEvents.length > 0) {
    const inDay = ev.aggregatedEvents
      .map((c) => c.start.getTime())
      .filter((t) => (dayStart === null || t >= dayStart) && (dayEnd === null || t < dayEnd));
    if (inDay.length > 0) return Math.min(...inDay);
  }
  const t = ev.start.getTime();
  if (dayStart !== null && t < dayStart) return dayStart;
  return t;
}

/* ===========================================================
 * Layout lane — xep cac block khong chong nhau trong 1 cot ngay.
 * =========================================================== */

/** 1 block da duoc dat trong luoi (kem so lane de tranh chong). */
interface PlacedSegment {
  seg: EventSegment;
  /** Lane (cot con) — 0, 1, 2... */
  lane: number;
  /** Tong so lane trong cum chong nhau → tinh do rong. */
  lanes: number;
}

/**
 * Gan moi block vao 1 "lane" de 2 block chong nhau khong de len nhau.
 *
 * Cac block giao nhau (overlap theo giờ) cung 1 cum → chung so lane.
 */
function layoutSegments(list: EventSegment[]): PlacedSegment[] {
  const sorted = list.slice().sort((a, b) => a.start.getTime() - b.start.getTime());
  const out: PlacedSegment[] = [];
  let cluster: PlacedSegment[] = [];
  let clusterEnd = -Infinity;

  const flush = () => {
    if (cluster.length === 0) return;
    const maxLane = cluster.reduce((m, c) => Math.max(m, c.lane), 0) + 1;
    for (const c of cluster) c.lanes = maxLane;
    out.push(...cluster);
    cluster = [];
    clusterEnd = -Infinity;
  };

  for (const seg of sorted) {
    const s = seg.start.getTime();
    const e = seg.end.getTime();
    // Block mới bắt đầu sau khi cụm hiện tại kết thúc → tách cụm mới.
    if (cluster.length > 0 && s >= clusterEnd) flush();
    const used = new Set(cluster.map((c) => c.lane));
    let lane = 0;
    while (used.has(lane)) lane++;
    cluster.push({ seg, lane, lanes: 1 });
    clusterEnd = Math.max(clusterEnd, e);
  }
  flush();
  return out;
}

/* ===========================================================
 * Tách 1 event thành nhiều "khối giờ" liên tục.
 *
 * ⚠️ Vấn đề: task có 2 subtask ở 2 khung giờ rời nhau (8h–10h và 16h–18h)
 * bị gộp thành 1 card duy nhất với `start` = 8h, `end` = 18h → trên lưới
 * giờ nó chiếm hết khoảng 8h–18h, che mất các việc khác ở giữa.
 *
 * Hàm này cắt 1 event thành nhiều đoạn LIÊN TỤC (không bị cắt ngang giữa
 * chừng):
 *   - Dùng `aggregatedEvents` (các slot/subtask con) làm mốc ranh giới.
 *   - Mỗi đoạn = 1 nhóm các mốc liên tiếp không bị ngắt quãng > `MAX_GAP`.
 *   - Đoạn nào chỉ có 1 mốc → thành 1 card riêng với đúng giờ của nó.
 *
 * Event không có `aggregatedEvents` (đơn giản: 1 slot, 1 Google event) →
 * trả về nguyên event.
 * =========================================================== */

/**
 * Khoảng cách tối đa (phút) giữa 2 mốc liên tiếp để coi là "1 khối liên
 * tục". Mốc cách nhau quá → tách thành 2 khối riêng.
 */
const MAX_CONTIGUOUS_GAP_MIN = 30;

/**
 * 1 đoạn giờ liên tục của 1 event.
 *
 * - `ev`   : event gốc (giữ nguyên để mở modal, Focus Session, v.v.)
 * - `start`/`end`: mốc bắt đầu / kết thúc của đoạn này
 * - `blocks`: các mốc con (subtask/slot) nằm trong đoạn
 */
interface EventSegment {
  ev: CalEvent;
  start: Date;
  end: Date;
  blocks: CalEvent[];
}

/**
 * Cắt 1 event thành các đoạn giờ liên tục.
 *
 * @param ev       Event gốc
 * @param day      Ngày đang hiển thị (để clip đoạn về trong ngày)
 */
function segmentEvent(ev: CalEvent, day: Date): EventSegment[] {
  const children = ev.aggregatedEvents ?? [];
  // Không gộp → 1 đoạn duy nhất (dùng đúng start/end của event).
  if (children.length === 0) {
    const start = ev.start;
    const end = ev.end;
    if (end.getTime() <= start.getTime()) {
      return [{ ev, start, end: new Date(start.getTime() + 30 * 60_000), blocks: [] }];
    }
    return [{ ev, start, end, blocks: [] }];
  }

  /*
   * Gom các mốc con theo khung giờ, gộp trùng nhau (overlap) lại 1 mốc.
   * 1 mốc = 1 "việc con" (slot / subtask) có start + end.
   */
  const marks = children
    .map((c) => ({ start: c.start.getTime(), end: c.end.getTime() }))
    .filter((m) => m.end > m.start)
    .sort((a, b) => a.start - b.start);

  if (marks.length === 0) {
    return [{ ev, start: ev.start, end: ev.end, blocks: [] }];
  }

  /*
   * Gộp các mốc chồng lấn / liền kề (gap <= MAX_CONTIGUOUS_GAP_MIN) thành 1
   * cụm liên tục → 1 đoạn.
   */
  type Cluster = { start: number; end: number; marks: typeof marks };
  const clusters: Cluster[] = [];
  for (const m of marks) {
    const last = clusters[clusters.length - 1];
    if (last && m.start - last.end <= MAX_CONTIGUOUS_GAP_MIN * 60_000) {
      last.end = Math.max(last.end, m.end);
      last.marks.push(m);
    } else {
      clusters.push({ start: m.start, end: m.end, marks: [m] });
    }
  }

  // Clip các cụm về trong ngày đang hiển thị.
  const dayStart = startOfDay(day).getTime();
  const dayEnd = addDays(startOfDay(day), 1).getTime();

  return clusters
    .map((cl) => {
      /*
       * Chi giu cac cum THUC SU giao voi ngay dang xem.
       *
       * Khong duoc clip cu "cang" (Math.max/Math.min) o day: cum nam HOAN TOAN
       * truoc ngay dang xem se bi clip thanh [dayStart, dayStart] -> moi cum
       * deu co start = 00:00 -> trung key + sinh card ma o moi ngay.
       *
       * Dieu kien giao: cum.end > dayStart && cum.start < dayEnd.
       */
      if (cl.end <= dayStart) return null;
      if (cl.start >= dayEnd) return null;

      const s = Math.max(cl.start, dayStart);
      const e = Math.min(cl.end, dayEnd);
      const blocks = children.filter((c) => {
        const cs = c.start.getTime();
        const ce = c.end.getTime();
        return ce > s && cs < e;
      });
      return {
        ev,
        start: new Date(s),
        end: new Date(Math.max(e, s + 30 * 60_000)),
        blocks,
      };
    })
    .filter((seg): seg is EventSegment => seg !== null)
    .filter((seg) => seg.start.getTime() < dayEnd);
}

function dotFor(ev: CalEvent): Tone {
  const s = ev.status?.toLowerCase();
  if (s === "done" || s === "completed") return "secondary";
  if (s === "inprogress") return "primary";
  if (s === "scheduled") return "sky";
  if (s === "todo") return "muted";
  if (s === "skipped" || s === "cancelled") return "muted";
  if (ev.source === "milestone") return "tertiary";
  return "primary";
}
function sourceLabel(source: CalSource): string {
  const m: Record<string, string> = {
    task: "Task",
    subtask: "Subtask",
    milestone: "Milestone",
    google: "Google Cal",
    slot: "Scheduled",
  };
  return m[source?.toLowerCase()] ?? source;
}

/* ===========================================================
 * Gom task của 1 ngày từ danh sách event đã gộp.
 *
 * Vì sao cần: `pickAccentForDay` chỉ xét deadline + fixed time, nên BỎ SÓT
 * các task chỉ có schedule slot (nguồn lịch thực tế chính) và task có
 * calendar event. `events` đã gộp đủ 4 nguồn (calendar / task deadline /
 * subtask / schedule slot) nên dùng nó làm nguồn sự thật.
 * =========================================================== */
type DayItem = {
  /** Task (có thể null nếu event không gắn với task nào). */
  task: TaskDto | null;
  /** Subtask (nếu event là subtask). */
  subtask: SubtaskDto | null;
  /** Các slot thuộc task này trong ngày. */
  slots: ScheduleSlotDto[];
  /** Tổng phút ước tính của các item trong ngày. */
  minutes: number;
  /** Event đầu tiên (để biết giờ bắt đầu + mở modal chi tiết). */
  start: Date;
  /** Event gốc đầu tiên — dùng để mở modal khi click. */
  event: CalEvent;
  /** Trạng thái ưu tiên: done < in-progress < todo. */
  status: string;
  isAllDay: boolean;
};

function collectDayItems(events: CalEvent[], day: Date): DayItem[] {
  const dayEnd = addDays(startOfDay(day), 1);
  const dayEvents = events.filter((ev) => {
    if (ev.isAllDay) return isSameDay(ev.start, day);
    // Event có thể kéo dài qua nhiều ngày → tính cả phần chồng lên ngày này.
    return ev.start < dayEnd && ev.end > startOfDay(day);
  });

  const byTask = new Map<string, DayItem>();

  for (const ev of dayEvents) {
    /*
     * Khoá gom nhóm.
     *
     * ⚠️ Slot việc nhóm có `taskId = null` (mục 10 của cập nhật BE) → nếu dùng
     * `ev.taskId ?? ev.id` thì mỗi slot nhóm là 1 mục riêng. Ta gom theo
     * `groupTaskId` để các slot của cùng 1 việc nhóm vẫn gộp lại (như task
     * cá nhân), còn slot nhóm của task khác nhau tách riêng.
     */
    const key = ev.taskId ?? ev.groupTaskId ?? ev.id;
    let item = byTask.get(key);
    if (!item) {
      item = {
        task: ev.task ?? null,
        subtask: ev.subtask ?? null,
        slots: [],
        minutes: 0,
        start: ev.start,
        event: ev,
        status: ev.status,
        isAllDay: ev.isAllDay,
      };
      byTask.set(key, item);
    }
    // DEDUPE slot: aggregate event mang cả `scheduleSlot` (slot đầu) LẪN
    // `aggregatedSlots` (toàn bộ) → slot đầu bị đếm 2 lần. Dedupe theo id.
    const slotSeen = new Set(item.slots.map((s) => s.id));
    const pushSlot = (s: ScheduleSlotDto) => {
      if (slotSeen.has(s.id)) return;
      slotSeen.add(s.id);
      item!.slots.push(s);
    };
    if (ev.scheduleSlot) pushSlot(ev.scheduleSlot);
    if (ev.aggregatedSlots) ev.aggregatedSlots.forEach(pushSlot);
    const s = ev.start > startOfDay(day) ? ev.start : startOfDay(day);
    const e = ev.end < dayEnd ? ev.end : dayEnd;
    const mins = Math.max(0, Math.round((e.getTime() - s.getTime()) / 60000));
    item.minutes += mins;
    if (ev.start < item.start) item.start = ev.start;
  }

  return [...byTask.values()].sort((a, b) => a.start.getTime() - b.start.getTime());
}

/** Ưu tiên hiển thị item quan trọng hơn: đang chạy > chưa xong > xong rồi. */
const STATUS_RANK: Record<string, number> = {
  inprogress: 0,
  "in progress": 0,
  "in_progress": 0,
  active: 0,
  todo: 1,
  "to do": 1,
  notstarted: 1,
  "not started": 1,
  blocked: 2,
  done: 3,
  completed: 3,
  cancelled: 4,
  skipped: 4,
};

function statusRank(s: string | undefined): number {
  if (!s) return 1;
  return STATUS_RANK[s.toLowerCase()] ?? 1;
}

/* ===========================================================
 * Cell accent picker — tính "project chính" cho 1 ngày + số liệu tổng.
 * Pure function, dùng cho week/month cell để render 1 màu + badge.
 * =========================================================== */
type CellAccent = {
  accent: ProjectSpan;
  allSpans: Array<{
    sp: ProjectSpan;
    taskCount: number;
    subtaskCount: number;
    total: number;
    urgency: number;
  }>;
  totalTasks: number;
  totalSubtasks: number;
  projectCount: number;
};

function pickAccentForDay(
  day: Date,
  projectSpans: ProjectSpan[],
  tasks: TaskDto[],
  subtasks: SubtaskDto[],
): CellAccent | null {
  const dc = startOfDay(day).getTime();
  const touching = projectSpans.filter((sp) => {
    const ts = startOfDay(sp.start).getTime();
    const te = startOfDay(sp.end).getTime();
    return dc >= ts && dc <= te;
  });
  if (touching.length === 0) return null;
  const dayStart = new Date(day); dayStart.setHours(0, 0, 0, 0);
  const dayEnd = new Date(day); dayEnd.setHours(23, 59, 59, 999);
  const stats = touching.map((sp) => {
    let bestDeadlineDelta = Number.POSITIVE_INFINITY;
    const projTasks = tasks.filter((t) => t.projectId === sp.project.id);
    // Task "active" trong ngày: có deadline đúng ngày, hoặc fixed time bao phủ ngày.
    const activeTasks = projTasks.filter((t) => {
      const deadline = t.deadline ?? null;
      const fixedStart = t.fixedStart ? new Date(t.fixedStart) : null;
      const fixedEnd = t.fixedEnd ? new Date(t.fixedEnd) : null;
      return (
        (!!deadline && isSameDay(new Date(deadline), day)) ||
        (!!fixedStart && !!fixedEnd && fixedStart <= dayEnd && fixedEnd >= dayStart)
      );
    });
    const taskCount = activeTasks.length;
    for (const t of projTasks) {
      if (!t.deadline) continue;
      const dl = new Date(t.deadline).getTime();
      const delta = Math.abs(dl - dc);
      if (delta < bestDeadlineDelta) bestDeadlineDelta = delta;
    }
    const taskIds = new Set(projTasks.map((t) => t.id));
    // Subtask có lịch (scheduledStart/End) bao phủ ngày này.
    const activeSubtasks = subtasks.filter((st) => {
      if (!taskIds.has(st.taskId)) return false;
      const sStart = st.scheduledStart ? new Date(st.scheduledStart) : null;
      const sEnd = st.scheduledEnd ? new Date(st.scheduledEnd) : null;
      return !!sStart && !!sEnd && sStart <= dayEnd && sEnd >= dayStart;
    });
    const subtaskCount = activeSubtasks.length;
    const total = taskCount + subtaskCount;
    return {
      sp,
      taskCount,
      subtaskCount,
      total,
      urgency: bestDeadlineDelta,
    };
  });
  stats.sort((a, b) => {
    if (a.urgency !== b.urgency) return a.urgency - b.urgency;
    return b.total - a.total;
  });
  const winner = stats[0];
  return {
    accent: winner.sp,
    allSpans: stats,
    totalTasks: stats.reduce((s, x) => s + x.taskCount, 0),
    totalSubtasks: stats.reduce((s, x) => s + x.subtaskCount, 0),
    projectCount: stats.length,
  };
}


export function SchedulePage() {
  const { projectId } = useParams<{ projectId: string }>();
  const navigate = useNavigate();

  /* project */
  const [project, setProject] = useState<ProjectDto | null>(null);

  /* view state */
  const [viewMode, setViewMode] = useState<ViewMode>("week");
  const [anchor, setAnchor] = useState<Date>(() => new Date());
  /**
   * Bộ lọc nhanh (All items / Priority / Capstone / Deep work).
   *
   * ⚠️ UI đang ẩn — các filter này chưa được implement thật (xem
   * `visibleWeek` luôn trả về toàn bộ tuần). State vẫn giữ để sẵn sàng
   * bật lại khi có logic thật.
   */
  const [filter] = useState<FilterId>("all");
  /**
   * View Tuần hiện **trọn 1 tuần lịch: Thứ Hai → Chủ Nhật (7 ngày)**.
   *
   *  - Mặc định: tuần chứa hôm nay (T2 → CN của tuần hiện tại).
   *  - Bấm "Next" → tuần kế tiếp, "Prev" → tuần trước (mỗi bước 7 ngày).
   *  - Bấm "Today" → quay lại tuần chứa hôm nay.
   *
   * `weekStart` luôn là Thứ Hai của tuần đang xem → giữ cho việc nhảy tuần
   * và hiển thị đúng 7 cột (T2, T3, T4, T5, T6, T7, CN).
   */
  const [weekStart, setWeekStart] = useState<Date>(() => startOfWeek(new Date()));
  /** Lưu anchor ban đầu của project span, để "Jump to span" quay lại. */
  const [spanAnchor, setSpanAnchor] = useState<Date | null>(null);

  /* data */
  const [tasks, setTasks] = useState<TaskDto[]>([]);
  const [subtasks, setSubtasks] = useState<SubtaskDto[]>([]);
  /** Schedule slots — tạo từ task/subtask để hiển thị trên calendar + notification */
  const [scheduleSlots, setScheduleSlots] = useState<ScheduleSlotDto[]>([]);
  /* Toast thông báo giữa màn hình */
  const [toasts, toast] = useCenterToast();
  const toastDismiss = toast.dismiss;
  /** Calendar items từ API (BE merged + enriched) */
  const [calendarItems, setCalendarItems] = useState<CalendarItemDto[]>([]);
  /** Handle drop từ Planning page (localStorage-based) */
  const handleScheduleDrop = useCallback(async (date: Date) => {
    // Đọc task từ localStorage (được set bởi Planning page)
    const stored = localStorage.getItem("metanoia:drag-task");
    if (!stored) return;

    try {
      const taskData = JSON.parse(stored);
      // Default: từ 9:00 đến 10:00 ngày được drop
      const start = new Date(date);
      start.setHours(9, 0, 0, 0);
      const end = new Date(start);
      end.setHours(10, 0, 0, 0);

      const res = await createScheduleSlot(taskData.taskId, {
        subTaskId: null,
        startTime: start.toISOString(),
        endTime: end.toISOString(),
        originalStartTime: start.toISOString(),
        isManualOverride: true,
        kbiasUsed: 0,
        explanation: `Scheduled from Planning: "${taskData.taskTitle}"`,
        status: "Approved",
      });

      if (res.ok) {
        // Reload data
        setScheduleSlots((prev) => [...prev, res.data]);
        toast.success(
          "Schedule created!",
          `"${taskData.taskTitle}" was scheduled for ${start.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })} — ${end.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}.`
        );
      } else {
        /*
         * ⚠️ `409 SLOT_OVERLAP` — khung giờ mới chồng lên slot đang chiếm giờ.
         * Spec: `FE_CHANGES.md` mục 3.2.
         */
        const overlapMsg = describeSlotOverlapError(res, {
          taskTitle: taskData.taskTitle,
        });
        toast.error(
          overlapMsg ? "Time slot overlaps" : "Couldn't create the schedule",
          overlapMsg ?? res.error,
        );
      }

      // Clear localStorage
      localStorage.removeItem("metanoia:drag-task");
    } catch {
      // ignore parse errors
    }
  }, [toast]);

  /** Listen for drag events từ Planning page */
  useEffect(() => {
    const handleDragOver = (e: DragEvent) => {
      e.preventDefault();
      e.dataTransfer!.dropEffect = "move";
    };

    const handleDragDrop = (e: DragEvent) => {
      e.preventDefault();
      const data = e.dataTransfer?.getData("application/x-metanoia-task");
      if (data) {
        try {
          // Validate JSON trước khi lưu cross-tab, rồi drop vào ngày hiện tại.
          JSON.parse(data);
          localStorage.setItem("metanoia:drag-task", data);
          handleScheduleDrop(new Date());
        } catch {
          // ignore
        }
      }
    };

    document.addEventListener("dragover", handleDragOver);
    document.addEventListener("drop", handleDragDrop);

    return () => {
      document.removeEventListener("dragover", handleDragOver);
      document.removeEventListener("drop", handleDragDrop);
    };
  }, [handleScheduleDrop]);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  /* load project if projectId present */
  useEffect(() => {
    if (!projectId) return;
    let cancelled = false;
    void getProject(projectId).then((res) => {
      if (cancelled) return;
      if (res.ok) setProject(res.data);
    });
    return () => { cancelled = true; };
  }, [projectId]);

  /* Range based on view mode */
  const range = useMemo(() => {
    if (viewMode === "month") {
      const start = startOfWeek(startOfMonth(anchor));
      const end = addDays(startOfWeek(endOfMonth(anchor)), 6);
      end.setHours(23, 59, 59, 999);
      return { start, end };
    }
    /*
     * View Tuần: trọn 1 tuần lịch 7 ngày (T2 → CN). Xem `weekStart`.
     *
     * View Gantt: cũng dùng tuần lịch 7 ngày (Thứ Hai → Chủ Nhật).
     */
    if (viewMode === "gantt") {
      const start = startOfWeek(anchor);
      const end = addDays(start, 6);
      end.setHours(23, 59, 59, 999);
      return { start, end };
    }
    // week: 7 ngày từ `weekStart` (Thứ Hai → Chủ Nhật)
    const start = weekStart;
    const end = addDays(start, 6);
    end.setHours(23, 59, 59, 999);
    return { start, end };
  }, [viewMode, anchor, weekStart]);

  /**
   * Tải toàn bộ tasks (của 1 project hoặc tất cả) + subtasks của chúng,
   * rồi derive thành CalEvent.
   *   • /projects/:id/schedule  -> 1 project
   *   • /schedule                -> tất cả projects của user (loop listProjects + listTasks)
   *
   * Ưu tiên: dùng GET /api/calendar (BE merged data) khi available,
   * fallback về local build nếu cần.
   */
  const [allProjects, setAllProjects] = useState<ProjectDto[]>([]);

  /** Track if calendar API is unavailable (404) to skip future calls */
  const calendarApiUnavailable = useRef(false);

  /** Ref tới month grid — dùng để cuộn tới ô "hôm nay" khi mở tháng view. */
  const monthGridRef = useRef<HTMLDivElement | null>(null);

  const loadData = useCallback(async () => {
    setLoading(true);
    setError(null);

    // Tính from/to từ range hiện tại (7 ngày hoặc 1 tháng)
    const from = range.start.toISOString();
    const to = range.end.toISOString();

    /*
     * Lấy danh sách project đã archive TRƯỚC, để lọc data lịch.
     *
     * BE merge task/subtask/milestone/slot cho mọi project (kể cả project đã
     * archive) → nếu không lọc, lịch vẫn hiện dự án đã archive.
     */
    const archivedIds = await listArchivedProjectIds();
    /** Project đã archive → ẩn khỏi lịch. */
    const isArchived = (pid: string | null | undefined): boolean =>
      !!pid && archivedIds.has(pid);

    // Ưu tiên: dùng Calendar API (BE merged + enriched data)
    // Skip nếu đã biết API này không tồn tại (404)
    if (!calendarApiUnavailable.current) {
      const calRes = await listCalendar({ from, to, includeCancelled: false });

      // Nếu 404 → mark as unavailable và fall through
      if (!calRes.ok && calRes.status === 404) {
        calendarApiUnavailable.current = true;
      } else if (calRes.ok && calRes.data.items.length > 0) {
        // Dùng calendar items từ BE — ẩn item thuộc project đã archive
        setCalendarItems(
          calRes.data.items.filter((it) => !isArchived(it.projectId)),
        );

        // Vẫn load tasks + subtasks để modal hiển thị được danh sách subtask
        if (!projectId) {
          const projRes = await listProjects();
          if (projRes.ok) setAllProjects(projRes.data);
          const taskResults = await Promise.all(
            (projRes.ok ? projRes.data : []).map((p) => listTasks(p.id)),
          );
          const allTasks: TaskDto[] = [];
          for (const r of taskResults) if (r.ok) allTasks.push(...r.data);
          // Ẩn task của project đã archive
          const visibleTasks = allTasks.filter(
            (t) => !isArchived(t.projectId),
          );
          setTasks(visibleTasks);
          // Subtask: cần cho modal (cột phải) — load theo từng task
          const subResults = await Promise.all(
            visibleTasks.map((t) => listSubtasks(t.id)),
          );
          const allSub: SubtaskDto[] = [];
          for (const r of subResults) if (r.ok) allSub.push(...r.data);
          setSubtasks(allSub);
        } else {
          const tasksRes = await listTasks(projectId);
          if (tasksRes.ok) {
            setTasks(tasksRes.data.filter((t) => !isArchived(t.projectId)));
          }
          const subResults = await Promise.all(
            (tasksRes.ok ? tasksRes.data : [])
              .filter((t) => !isArchived(t.projectId))
              .map((t) => listSubtasks(t.id)),
          );
          const allSub: SubtaskDto[] = [];
          for (const r of subResults) if (r.ok) allSub.push(...r.data);
          setSubtasks(allSub);
        }
        setLoading(false);
        return;
      }
    }

    // Fallback: build CalEvents từ local tasks/subtasks/slots
    if (!projectId) {
      // Global /schedule: load tất cả projects, rồi load tasks của từng cái.
      const projRes = await listProjects();
      if (!projRes.ok) {
        setError(projRes.error ?? "Failed to load projects");
        setAllProjects([]);
        setTasks([]);
        setSubtasks([]);
        setCalendarItems([]);
        setLoading(false);
        return;
      }
      setAllProjects(projRes.data);
      const taskResults = await Promise.all(
        projRes.data.map((p) => listTasks(p.id)),
      );
      const allTasks: TaskDto[] = [];
      for (const r of taskResults) if (r.ok) allTasks.push(...r.data);
      // Ẩn task của project đã archive
      const visibleTasks = allTasks.filter((t) => !isArchived(t.projectId));
      setTasks(visibleTasks);
      const subResults = await Promise.all(
        visibleTasks.map((t) => listSubtasks(t.id)),
      );
      const allSub: SubtaskDto[] = [];
      for (const r of subResults) if (r.ok) allSub.push(...r.data);
      setSubtasks(allSub);

      // Load schedule slots for all tasks
      const slotResults = await Promise.all(
        visibleTasks.map((t) => listScheduleSlotsByTask(t.id)),
      );
      const allSlots: ScheduleSlotDto[] = [];
      for (const r of slotResults) if (r.ok) allSlots.push(...r.data);
      setScheduleSlots(allSlots);
      setCalendarItems([]); // Clear calendar items when using fallback

      setLoading(false);
      return;
    }
    const tasksRes = await listTasks(projectId);
    if (!tasksRes.ok) {
      setError(tasksRes.error ?? "Failed to load tasks");
      setTasks([]);
      setSubtasks([]);
      setCalendarItems([]);
      setLoading(false);
      return;
    }
    // Ẩn task của project đã archive
    const visibleTasks = tasksRes.data.filter((t) => !isArchived(t.projectId));
    setTasks(visibleTasks);
    // Tải song song subtasks của từng task
    const subResults = await Promise.all(
      visibleTasks.map((t) => listSubtasks(t.id)),
    );
    const allSub: SubtaskDto[] = [];
    for (const r of subResults) if (r.ok) allSub.push(...r.data);
    setSubtasks(allSub);

    // Load schedule slots for project tasks
    const slotResults = await Promise.all(
      visibleTasks.map((t) => listScheduleSlotsByTask(t.id)),
    );
    const allSlots: ScheduleSlotDto[] = [];
    for (const r of slotResults) if (r.ok) allSlots.push(...r.data);
    setScheduleSlots(allSlots);
    setCalendarItems([]); // Clear calendar items when using fallback

    setLoading(false);
  }, [projectId, range]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- data-fetch pattern
    void loadData();
  }, [loadData]);

  /* ===========================================================
   * Focus Session — nối trang lịch với phiên làm việc toàn cục
   * =========================================================== */

  const { currentSlotId, seedPlannedMinutes, onSlotChanged } = useFocusActions();

  /**
   * Mục 10 (BE cập nhật): việc được giao lại hoặc người làm rời nhóm →
   * slot chưa bắt đầu của người cũ bị huỷ + server phát `GroupStatusChanged`.
   * FE phải làm mới lịch ngay khi nhận thông báo này (slot nhóm có
   * `taskId = null` nên không nằm trong danh sách slot cá nhân).
   */
  const notif = useNotificationsContext();

  useEffect(() => {
    return notif.onSignal((signal) => {
      if (!signalAffectsSchedule(signal)) return;
      void loadData();
    });
  }, [notif, loadData]);

  /**
   * Khi slot đổi trạng thái (start/stop/confirm) → nạp lại lịch.
   *
   * Cần cho cả trường hợp user bấm Stop ở thanh đồng hồ global (đang ở
   * trang khác) rồi quay lại /schedule, hoặc đang ở /schedule thì trạng
   * thái slot phải đổi ngay (InProgress → Due/Done).
   */
  useEffect(() => {
    return onSlotChanged(() => {
      void loadData();
    });
  }, [onSlotChanged, loadData]);

  /**
   * `GET /api/focus/current` KHÔNG trả `plannedMinutes` — chỉ response của
   * `POST /api/focus/start` có. Sau khi reload trang, ta lấy lại mốc thời
   * gian từ `proposedMinutes` của slot đang chạy (nếu slot nằm trong data
   * đã tải — với data từ Calendar API thì `calendarItems` giữ thông tin này).
   */
  useEffect(() => {
    if (!currentSlotId) return;
    const fromSlots = scheduleSlots.find((s) => s.id === currentSlotId);
    if (fromSlots?.proposedMinutes) {
      seedPlannedMinutes(fromSlots.proposedMinutes);
      return;
    }
    const fromCalendar = calendarItems.find(
      (i) => i.id === currentSlotId,
    );
    const mins = fromCalendar?.proposedMinutes;
    if (mins) seedPlannedMinutes(mins);
  }, [
    currentSlotId,
    scheduleSlots,
    calendarItems,
    seedPlannedMinutes,
  ]);

  /* ===========================================================
   * Kết quả OAuth Google Calendar (BE redirect về FE)
   *
   * BE có thể redirect về:
   *   • `/auth/google/callback?calendar=connected` → trang xác nhận rồi
   *     navigate sang /schedule kèm `location.state.calendarResult`
   *   • hoặc thẳng `/schedule?calendar=connected|error|denied` (nếu
   *     CalendarConnectedRedirectUri trỏ vào đây)
   * Nên phải xử lý CẢ HAI nguồn.
   * =========================================================== */
  const location = useLocation();
  const calendarResultHandled = useRef(false);

  useEffect(() => {
    const fromState = (
      location.state as
        | {
            calendarResult?: {
              outcome: "connected" | "denied" | "error";
              connected?: boolean;
              message?: string;
            };
          }
        | null
    )?.calendarResult;

    const qs = new URLSearchParams(location.search);
    const rawQuery = (qs.get("calendar") ?? "").toLowerCase();
    const fromQuery =
      rawQuery === "connected" || rawQuery === "denied" || rawQuery === "error"
        ? {
            outcome: rawQuery as "connected" | "denied" | "error",
            connected: rawQuery === "connected",
            message: qs.get("message") ?? undefined,
          }
        : null;

    const result = fromState ?? fromQuery;
    if (!result || calendarResultHandled.current) return;
    calendarResultHandled.current = true;

    if (result.outcome === "connected") {
      toast.success(
        "Google Calendar connected",
        "Calendar events are now synced both ways with your schedule.",
      );
    } else if (result.outcome === "denied") {
      toast.error(
        "You denied the permission",
        "METANOIA needs the calendar.events permission to sync your schedule.",
      );
    } else {
      toast.error(
        "Connection failed",
        result.message ??
          "Couldn't link Google Calendar. Please try again.",
      );
    }

    // Xoá query + state để reload trang không hiện lại toast.
    if (rawQuery) {
      const next = new URLSearchParams(location.search);
      next.delete("calendar");
      next.delete("message");
      navigate(
        { pathname: location.pathname, search: next.toString() },
        { replace: true, state: null },
      );
    } else {
      navigate(
        { pathname: location.pathname, search: location.search },
        { replace: true, state: null },
      );
    }
    // Sau khi connect, nạp lại lịch để thấy sự kiện Google (nếu đã sync).
    void loadData();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- chạy 1 lần theo kết quả OAuth
  }, [location.state, location.search]);

  /** Sau khi Sync Google Calendar → nạp lại lịch để thấy event mới. */
  const handleCalendarSynced = useCallback(() => {
    void loadData();
  }, [loadData]);

  /** Map taskId -> TaskDto để enrich chip. */
  const tasksById = useMemo<Record<string, TaskDto>>(() => {
    const m: Record<string, TaskDto> = {};
    for (const t of tasks) m[t.id] = t;
    return m;
  }, [tasks]);

  /**
   * Map taskId -> SubtaskDto[] (đã sort theo orderIndex).
   *
   * TaskCard dùng map này để hiện danh sách subtask + khung giờ bên dưới
   * tên task, khi event không phải aggregate (tức task chỉ có 1 block).
   */
  const subtasksByTaskId = useMemo<Map<string, SubtaskDto[]>>(() => {
    const m = new Map<string, SubtaskDto[]>();
    for (const s of subtasks) {
      const arr = m.get(s.taskId);
      if (arr) arr.push(s);
      else m.set(s.taskId, [s]);
    }
    for (const arr of m.values()) arr.sort((a, b) => a.orderIndex - b.orderIndex);
    return m;
  }, [subtasks]);

  /** Bản Map cho AI proposal — lookup O(1) khi render danh sách slot. */
  const tasksByIdMap = useMemo(() => {
    const m = new Map<string, TaskDto>();
    for (const t of tasks) m.set(t.id, t);
    return m;
  }, [tasks]);

  /**
   * Task đã có ít nhất 1 schedule slot → loại khỏi danh sách xin AI xếp lịch.
   *
   * ⚠️ `taskId` có thể `null` (slot của việc nhóm — mục 10 của cập nhật BE)
   * → phải lọc `null` ra, nếu không sẽ lọn id `null` vào danh sách task.
   */
  const scheduledTaskIds = useMemo(
    () =>
      new Set(
        scheduleSlots
          .map((s) => s.taskId)
          .filter((x): x is string => typeof x === "string" && x.length > 0),
      ),
    [scheduleSlots],
  );

  /** Subtask đã có schedule slot. */
  const scheduledSubtaskIds = useMemo(
    () =>
      new Set(
        scheduleSlots.map((s) => s.subTaskId).filter((x): x is string => !!x),
      ),
    [scheduleSlots],
  );

  /**
   * Task còn subtask CHƯA có lịch.
   *
   * Task cha đã có 1 slot vẫn xếp được cho các subtask còn lại — vì AI service
   * tính slot theo từng subtask (trả `subtask_id` cho mỗi slot).
   */
  const pendingSubtaskTaskIds = useMemo(() => {
    const ids = new Set<string>();
    for (const st of subtasks) {
      if (scheduledSubtaskIds.has(st.id)) continue;
      ids.add(st.taskId);
    }
    return ids;
  }, [subtasks, scheduledSubtaskIds]);

  /** Đếm task Flexible còn xếp được — dùng để bật/tắt nút Auto-schedule. */
  const schedulableCount = useMemo(() => {
    let n = 0;
    for (const t of tasks) {
      // Task đã có slot vẫn xếp được nếu còn subtask chưa có lịch.
      if (scheduledTaskIds.has(t.id) && !pendingSubtaskTaskIds.has(t.id)) continue;
      if (t.fixedStart || t.fixedEnd) continue;
      if ((t.taskType ?? "").toLowerCase() !== "flexible") continue;
      const st = (t.status ?? "").toLowerCase();
      if (st === "done" || st === "completed" || st === "cancelled" || st === "skipped") continue;
      n += 1;
    }
    return n;
  }, [tasks, scheduledTaskIds, pendingSubtaskTaskIds]);

  /* ---------- AI schedule proposal ---------- */
  const [proposalOpen, setProposalOpen] = useState(false);

  /** Bản đồ subtaskId -> subtask, dùng tách slot thành nhóm cấp subtask. */
  const subtasksById = useMemo(() => {
    const m = new Map<string, SubtaskDto>();
    for (const st of subtasks) m.set(st.id, st);
    return m;
  }, [subtasks]);

  const proposal = useScheduleProposal({
    scheduledTaskIds,
    tasksById: tasksByIdMap,
    subtasks,
    scheduledSubtaskIds,
    toast,
  });

  /** Mở panel và nhờ AI xếp lịch ngay (nút "Auto-schedule" / ribbon AI). */
  const openProposal = useCallback(() => {
    setProposalOpen(true);
    void proposal.run();
  }, [proposal]);

  /**
   * Sau khi duyệt → nạp lại schedule slot của toàn bộ task.
   * Cách này giống hệt `loadData` nên không lệ logic với phần còn lại của trang.
   */
  const handleProposalDone = useCallback(async () => {
    setProposalOpen(false);
    const results = await Promise.all(tasks.map((t) => listScheduleSlotsByTask(t.id)));
    const merged: ScheduleSlotDto[] = [];
    for (const r of results) if (r.ok) merged.push(...r.data);
    setScheduleSlots(merged);
  }, [tasks]);

  /* ---------- Bước 1: event thô từ BE (nếu có) hoặc fallback từ local ---------- */
  const rawEvents = useMemo<CalEvent[]>(() => {
    // Ưu tiên dùng calendarItems từ BE (đã merged + enriched)
    if (calendarItems.length > 0) {
      return calendarItems.map((item) => ({
        id: `cal-${item.id}`,
        source: (item.source?.toLowerCase() ?? "task") as CalSource,
        title: item.title,
        start: new Date(item.start),
        end: new Date(item.end),
        isAllDay: item.isAllDay ?? false,
        status: item.status ?? "",
        taskId: item.taskId ?? null,
        subTaskId: item.subTaskId ?? null,
        projectId: item.projectId ?? null,
        /*
         * ⚠️ Slot của việc nhóm: `taskId = null`, các trường dự án / khách hàng
         * / loại công việc cũng `null`. Ta gán riêng các trường nhóm để màn
         * lịch hiển thị đúng (tên nhóm + tiêu đề việc) và KHÔNG điều hướng
         * sang trang task cá nhân.
         */
        groupTaskId: item.groupTaskId ?? null,
        groupSubTaskId: item.groupSubTaskId ?? null,
        userId: item.userId ?? null,
        groupId: item.groupId ?? null,
        groupName: item.groupName ?? null,
        // Khi source = "slot", id của calendar item CHÍNH LÀ schedule slot id
        // → Focus Session dùng được để gọi start/time-summary.
        scheduleSlotId:
          (item.source?.toLowerCase() ?? "") === "slot" ? item.id : null,
        slotPlannedMinutes: item.proposedMinutes ?? null,
        // Với item `source = "slot"`, `status` là status của SLOT → dùng
        // cho quy tắc Start/Stop.
        slotStatus:
          (item.source?.toLowerCase() ?? "") === "slot"
            ? (item.status ?? "")
            : null,
        task: item.taskId ? tasksById[item.taskId] : undefined,
        subtask: item.subTaskId
          ? subtasks.find((x) => x.id === item.subTaskId)
          : undefined,
      }));
    }

    // Fallback: build từ local tasks/subtasks/slots
    const list: CalEvent[] = [];
    for (const t of tasks) {
      // 1) Task có fixedStart/fixedEnd -> event timed
      if (t.fixedStart && t.fixedEnd) {
        const s = new Date(t.fixedStart);
        const e = new Date(t.fixedEnd);
        if (!Number.isNaN(s.getTime()) && !Number.isNaN(e.getTime())) {
          list.push({
            id: `task-fixed-${t.id}`,
            source: "task" as CalSource,
            title: t.title,
            start: s,
            end: e,
            isAllDay: false,
            status: t.status,
            taskId: t.id,
            subTaskId: null,
            projectId: t.projectId,
            task: t,
          });
        }
      }
      // 2) Task có deadline -> all-day event
      if (t.deadline) {
        const d = new Date(t.deadline);
        if (!Number.isNaN(d.getTime())) {
          const dayStart = new Date(d);
          dayStart.setHours(0, 0, 0, 0);
          const dayEnd = new Date(d);
          dayEnd.setHours(23, 59, 59, 999);
          list.push({
            id: `task-deadline-${t.id}`,
            source: "task" as CalSource,
            title: t.title,
            start: dayStart,
            end: dayEnd,
            isAllDay: true,
            status: t.status,
            taskId: t.id,
            subTaskId: null,
            projectId: t.projectId,
            task: t,
          });
        }
      }
    }
    // 3) Subtask có scheduledStart/End -> event timed
    //
    // DEDUPE: BE trả cả `subtask.scheduledStart/End` LẪN `scheduleSlot` cho cùng
    // 1 subtask với cùng khung giờ. Nếu dựng event từ cả 2 nguồn thì mỗi subtask
    // xuất hiện 2 lần trên lịch (và 2 lần trong modal task detail).
    // Slot là nguồn chính xác hơn (có kbiasUsed, isManualOverride, status riêng)
    // nên subtask nào đã có slot thì bỏ qua event từ subtask.
    const subTaskIdsWithSlot = new Set(
      scheduleSlots.map((s) => s.subTaskId).filter((x): x is string => !!x),
    );
    for (const st of subtasks) {
      if (st.scheduledStart && st.scheduledEnd && !subTaskIdsWithSlot.has(st.id)) {
        const s = new Date(st.scheduledStart);
        const e = new Date(st.scheduledEnd);
        if (!Number.isNaN(s.getTime()) && !Number.isNaN(e.getTime())) {
          const parent = tasks.find((t) => t.id === st.taskId);
          list.push({
            id: `subtask-${st.id}`,
            source: "subtask" as CalSource,
            title: st.title,
            start: s,
            end: e,
            isAllDay: false,
            status: st.status,
            taskId: st.taskId,
            subTaskId: st.id,
            projectId: parent?.projectId ?? null,
            subtask: st,
            task: parent,
          });
        }
      }
    }

    // 4) Schedule Slots -> event timed (ưu tiên hơn task/subtask event)
    for (const slot of scheduleSlots) {
      const s = new Date(slot.startTime);
      const e = new Date(slot.endTime);
      if (!Number.isNaN(s.getTime()) && !Number.isNaN(e.getTime())) {
        // Tìm task/subtask title để hiển thị
        const parentTask = tasks.find((t) => t.id === slot.taskId);
        const parentSubtask = subtasks.find((st) => st.id === slot.subTaskId);
        const title = parentSubtask?.title ?? parentTask?.title ?? "Scheduled Event";
        list.push({
          id: `slot-${slot.id}`,
          source: "slot" as CalSource,
          title,
          start: s,
          end: e,
          isAllDay: false,
          status: slot.status,
          taskId: slot.taskId,
          subTaskId: slot.subTaskId,
          projectId: parentTask?.projectId ?? null,
          /*
           * Slot của việc nhóm (mục 10 của cập nhật BE): `taskId = null`.
           * Ta mang theo thông tin nhóm để lịch hiển thị đúng và không điều
           * hướng nhầm sang trang task cá nhân.
           */
          groupTaskId: slot.groupTaskId ?? null,
          groupSubTaskId: slot.groupSubTaskId ?? null,
          userId: slot.userId ?? null,
          groupName: slot.groupName ?? null,
          scheduleSlotId: slot.id,
          slotPlannedMinutes: slot.proposedMinutes ?? null,
          slotStatus: slot.status,
          scheduleSlot: slot,
          task: parentTask,
          subtask: parentSubtask,
        });
      }
    }

    return list;
  }, [tasks, subtasks, scheduleSlots, calendarItems, tasksById]);

  /* ---------- Bước 2: gộp event theo task → lịch chỉ hiện task, click mở modal subtask ---------- */
  const events = useMemo<CalEvent[]>(() => {
    // Gộp các event cùng taskId thành 1 "task aggregate event" để hiển thị
    // Giữ lại event gốc để click vào modal xem chi tiết các subtask.
    const list = rawEvents.slice();
    const taskAggSource: CalSource = "slot";
    const aggregateEvents: CalEvent[] = [];
    const slotsByTask = new Map<string, CalEvent[]>();
    for (const ev of list) {
      // Bỏ qua event all-day (task deadline) — đã là view task, không cần gộp
      if (ev.taskId && !ev.isAllDay) {
        const arr = slotsByTask.get(ev.taskId) ?? [];
        arr.push(ev);
        slotsByTask.set(ev.taskId, arr);
      }
    }
    /*
     * Slot của việc nhóm: `taskId = null` → không đi qua vòng gộp trên.
     * Ta gộp riêng theo `groupTaskId` để nhiều slot của cùng 1 việc nhóm
     * hiện như 1 khối trên lịch (giống task cá nhân).
     */
    const slotsByGroupTask = new Map<string, CalEvent[]>();
    for (const ev of list) {
      if (ev.groupTaskId && !ev.taskId && !ev.isAllDay) {
        const arr = slotsByGroupTask.get(ev.groupTaskId) ?? [];
        arr.push(ev);
        slotsByGroupTask.set(ev.groupTaskId, arr);
      }
    }
    for (const [groupTaskId, allEvs] of slotsByGroupTask) {
      const evs = allEvs
        .slice()
        .sort((a, b) => a.start.getTime() - b.start.getTime())
        .filter((e, i, arr) => {
          const key = `${e.groupSubTaskId ?? "task"}|${e.start.getTime()}|${e.end.getTime()}`;
          return arr.findIndex((x) => `${x.groupSubTaskId ?? "task"}|${x.start.getTime()}|${x.end.getTime()}` === key) === i;
        });
      if (evs.length <= 1) continue;
      const minStart = evs.reduce(
        (min, e) => (e.start.getTime() < min.getTime() ? e.start : min),
        evs[0].start,
      );
      const maxEnd = evs.reduce(
        (max, e) => (e.end.getTime() > max.getTime() ? e.end : max),
        evs[0].end,
      );
      aggregateEvents.push({
        id: `group-agg-${groupTaskId}`,
        source: taskAggSource,
        title: evs[0].title,
        start: minStart,
        end: maxEnd,
        isAllDay: false,
        status: evs[0].status,
        taskId: null,
        subTaskId: null,
        projectId: null,
        groupTaskId,
        groupSubTaskId: null,
        userId: evs[0].userId ?? null,
        groupId: evs[0].groupId ?? null,
        groupName: evs[0].groupName ?? null,
        scheduleSlotId: evs[0].scheduleSlotId ?? null,
        slotPlannedMinutes: evs[0].slotPlannedMinutes ?? null,
        slotStatus: evs[0].status,
        scheduleSlot: evs[0].scheduleSlot,
        subtask: evs[0].subtask,
        aggregatedSlots: Array.from(
          new Map(
            evs
              .map((e) => e.scheduleSlot)
              .filter((x): x is ScheduleSlotDto => !!x)
              .map((s) => [s.id, s]),
          ).values(),
        ),
        aggregatedEvents: evs,
      });
    }
    for (const [taskId, allEvs] of slotsByTask) {
      // DEDUPE LẦN 2 (phòng thủ): cùng subtask + cùng khung giờ thì chỉ giữ 1.
      // Bảo vệ trường hợp BE trả slot không có subTaskId nhưng vẫn trùng
      // scheduledStart/End của subtask.
      const seen = new Set<string>();
      const evs = allEvs
        .slice()
        .sort((a, b) => a.start.getTime() - b.start.getTime())
        .filter((e) => {
          const key = `${e.subTaskId ?? "task"}|${e.start.getTime()}|${e.end.getTime()}`;
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        });
      // Chỉ 1 event thì hiển thị bình thường, không cần aggregate
      if (evs.length <= 1) continue;
      const parentTask = evs[0].task ?? tasksById[taskId];
      const minStart = evs.reduce(
        (min, e) => (e.start.getTime() < min.getTime() ? e.start : min),
        evs[0].start,
      );
      const maxEnd = evs.reduce(
        (max, e) => (e.end.getTime() > max.getTime() ? e.end : max),
        evs[0].end,
      );
      aggregateEvents.push({
        id: `task-agg-${taskId}`,
        source: taskAggSource,
        title: parentTask?.title ?? evs[0].title,
        start: minStart,
        end: maxEnd,
        isAllDay: false,
        status: parentTask?.status ?? evs[0].status,
        taskId,
        subTaskId: null,
        projectId: parentTask?.projectId ?? evs[0].projectId,
        task: parentTask,
        /*
         * Focus Session: aggregate gộp nhiều slot của 1 task. Ta gắn slot
         * ĐẦU TIÊN (theo thứ tự thời gian) để:
         *  - Nút Start/Stop trên chip lịch dùng được `scheduleSlotId`.
         *  - Modal chi tiết mở đúng slot đang chạy.
         *
         * ⚠️ `status` của aggregate lấy từ TASK (không phải slot) → không
         * dùng để quyết định Start/Stop. Ta để `status` của task như hiện tại
         * (để hiển thị badge), còn `SlotFocusActions` sẽ tự dùng status của
         * slot gốc khi được truyền `slotStatus`.
         */
        scheduleSlotId: evs[0].scheduleSlotId ?? null,
        slotPlannedMinutes: evs[0].slotPlannedMinutes ?? null,
        slotStatus: evs[0].status,
        // Gắn event gốc đầu tiên (slot hoặc subtask) + toàn bộ danh sách con
        scheduleSlot: evs[0].scheduleSlot,
        subtask: evs[0].subtask,
        // Danh sách block con để modal hiển thị: ưu tiên slot thật, nếu không có
        // thì dùng chính các event gốc (subtask event từ BE).
        // Dedupe theo slot id — tránh modal đếm trùng khi 1 slot xuất hiện nhiều lần.
        aggregatedSlots: Array.from(
          new Map(
            evs
              .map((e) => e.scheduleSlot)
              .filter((x): x is ScheduleSlotDto => !!x)
              .map((s) => [s.id, s]),
          ).values(),
        ),
        aggregatedEvents: evs,
      });
    }
    // Lọc: bỏ các event thuộc task ĐÃ THỰC SỰ được gộp.
    // Lưu ý: phải dựa trên danh sách aggregate đã tạo (sau dedupe), KHÔNG dùng
    // slotsByTask thô — nếu không, task có 2 event trùng (dedupe còn 1, không tạo
    // aggregate) sẽ bị xoá sạch khỏi lịch.
    const aggregatedTaskIds = new Set(
      aggregateEvents.map((e) => e.taskId).filter((x): x is string => !!x),
    );
    const aggregatedGroupTaskIds = new Set(
      aggregateEvents
        .map((e) => e.groupTaskId)
        .filter((x): x is string => !!x),
    );
    const filtered = list.filter(
      (ev) =>
        !(
          ev.taskId &&
          !ev.isAllDay &&
          aggregatedTaskIds.has(ev.taskId)
        ) &&
        !(
          ev.groupTaskId &&
          !ev.taskId &&
          !ev.isAllDay &&
          aggregatedGroupTaskIds.has(ev.groupTaskId)
        ),
    );
    list.length = 0;
    list.push(...filtered, ...aggregateEvents);

    return list;
  }, [rawEvents, tasksById]);

  /* ===========================================================
   * Luật "làm trước - làm sau"
   * ===========================================================
   *
   * Trên lịch có nhiều việc cùng có thể bấm Start, nhưng người dùng nên
   * làm theo đúng thứ tự thời gian: cái nào có lịch sớm hơn thì làm
   * trước, cái nào có lịch sau thì chưa được làm.
   *
   * ⚠️ Luật này CHỈ Ở FE. BE chưa có luật thứ tự — BE chỉ chặn "1 người
   * 1 phiên" (409 FOCUS_SESSION_CONFLICT). Xem `sequence-logic.ts`.
   *
   * Ta gom các "việc" (task không có subtask + từng subtask) thành 1 danh
   * sách có giờ bắt đầu, rồi tính ra:
   *  - việc nào được phép Start,
   *  - việc nào bị chặn và bị chặn bởi ai.
   *
   * Chỉ việc CÓ giờ bắt đầu mới tham gia: event all-day (deadline) và
   * event Google Calendar không có "giờ bắt đầu" để so sánh.
   */

  /** Danh sách việc xếp thứ tự — nguồn cho luật bên dưới. */
  const sequenceItems = useMemo<SequencedItem[]>(() => {
    const items: SequencedItem[] = [];
    const seen = new Set<string>();

    /*
     * Thêm 1 việc vào danh sách, bỏ qua nếu trùng khoá.
     *
     * @param key        Khoá ổn định (slot / subtask / task).
     * @param title      Tên hiển thị (dùng cho tooltip).
     * @param startAt    Giờ bắt đầu (epoch ms).
     * @param owner      Task hoặc subtask sở hữu việc này (để xem status).
     * @param phase      Phase của slot (để biết đang chạy không).
     */
    const push = (
      key: string,
      title: string,
      startAt: number,
      owner: { status?: string | null } | undefined,
      phase: ReturnType<typeof toSlotPhase>,
    ) => {
      if (!Number.isFinite(startAt)) return;
      if (seen.has(key)) return;
      seen.add(key);

      const ownerStatus = owner?.status ?? "";
      const isRunning = phase === "InProgress" || phase === "Overrun";

      items.push({
        key,
        title,
        startAt,
        dayAt: startOfDay(new Date(startAt)).getTime(),
        isPending: !isClosedStatus(ownerStatus),
        isRunning,
      });
    };

    for (const ev of events) {
      // Chỉ việc có giờ bắt đầu thật. All-day = deadline (không xếp được).
      if (ev.isAllDay) continue;
      // Không phải việc của ta (Google event) → không xếp.
      if (!ev.taskId) continue;
      /*
       * Slot của việc nhóm cũng không tham gia luật "làm trước - làm sau":
       * luật này chặn nút Start của nhánh cá nhân, còn slot nhóm bấm giờ ở
       * trang nhóm (endpoint riêng).
       */
      if (ev.groupTaskId) continue;
      /*
       * ⚠️ Task GỘP nhiều subtask (aggregate): các event con đã bị lọc khỏi
       * `events`, chỉ còn 1 event tổng. Nhưng event tổng hiển thị ở NHIỀU cột
       * ngày (mỗi ngày có 1 subtask) → ta phải tách ra từng khối con để mỗi
       * khối là 1 mắt xích trong chuỗi thứ tự.
       */
      if (ev.aggregatedEvents && ev.aggregatedEvents.length > 0) {
        for (const child of ev.aggregatedEvents) {
          const childKey = child.scheduleSlotId
            ? `slot:${child.scheduleSlotId}`
            : child.subTaskId
              ? `sub:${child.subTaskId}`
              : child.taskId
                ? `task:${child.taskId}`
                : null;
          if (!childKey) continue;
          const childOwner = child.subTaskId
            ? subtasks.find((s) => s.id === child.subTaskId)
            : child.taskId
              ? tasksById[child.taskId]
              : undefined;
          push(
            childKey,
            child.subtask?.title ?? child.title,
            child.start.getTime(),
            childOwner,
            toSlotPhase(child.slotStatus ?? child.status),
          );
        }
        continue;
      }

      /*
       * Khoá: ưu tiên slot (vì 1 task có thể có nhiều slot ở nhiều ngày),
       * nếu không có slot thì dùng subtask, cuối cùng là task.
       */
      const key = ev.scheduleSlotId
        ? `slot:${ev.scheduleSlotId}`
        : ev.subTaskId
          ? `sub:${ev.subTaskId}`
          : `task:${ev.taskId}`;

      // Trạng thái: task gốc, hoặc subtask nếu event là subtask.
      const owner = ev.subTaskId
        ? subtasks.find((s) => s.id === ev.subTaskId)
        : tasksById[ev.taskId];

      push(
        key,
        ev.title,
        ev.start.getTime(),
        owner,
        toSlotPhase(ev.slotStatus ?? ev.status),
      );
    }

    return items;
  }, [events, subtasks, tasksById]);

  /** Kết quả luật: việc nào được Start, việc nào bị chặn (và bị ai). */
  const sequenceGate = useMemo<SequenceGate>(
    () => computeSequenceGate(sequenceItems),
    [sequenceItems],
  );

  /**
   * Lý do (tiếng Anh) để việc này bị chặn — hoặc `null` nếu được phép.
   *
   * @param ev  Event đang render.
   * @param day Ngày của ô lịch — quan trọng với task GỘP nhiều subtask (một
   *             event hiện ở nhiều cột ngày, mỗi ngày 1 khối con khác nhau).
   */
  const blockedReasonFor = useCallback(
    (ev: CalEvent, day?: Date): string | null => {
      if (!ev.taskId) return null;

      /** Tra lý do chặn theo khoá việc (null = được phép Start). */
      const reasonForKey = (key: string): string | null => {
        const item = sequenceItems.find((i) => i.key === key);
        if (!item) return null;
        if (isItemAllowed(sequenceGate, key, item.dayAt)) return null;
        const blockerKey = sequenceGate.blockedBy.get(key);
        const blocker = blockerKey
          ? sequenceItems.find((i) => i.key === blockerKey)
          : null;
        return blockedTooltip(blocker?.title ?? null);
      };

      /*
       * Task GỘP: event tổng hiển thị ở nhiều cột ngày. Mỗi cột ứng với 1
       * khối con (subtask) → ta tra khối con rơi vào đúng ngày đó.
       */
      if (ev.aggregatedEvents && ev.aggregatedEvents.length > 0) {
        const dayMs = day ? startOfDay(day).getTime() : null;
        const child =
          ev.aggregatedEvents.find((c) => {
            if (dayMs == null) return false;
            const cs = startOfDay(c.start).getTime();
            const ce = startOfDay(c.end).getTime();
            return cs <= dayMs && ce >= dayMs;
          }) ?? ev.aggregatedEvents[0];
        const childKey = child.scheduleSlotId
          ? `slot:${child.scheduleSlotId}`
          : child.subTaskId
            ? `sub:${child.subTaskId}`
            : child.taskId
              ? `task:${child.taskId}`
              : null;
        if (!childKey) return null;
        return reasonForKey(childKey);
      }

      const key = ev.scheduleSlotId
        ? `slot:${ev.scheduleSlotId}`
        : ev.subTaskId
          ? `sub:${ev.subTaskId}`
          : `task:${ev.taskId}`;
      return reasonForKey(key);
    },
    [sequenceGate, sequenceItems],
  );

  /**
   * Project spans: mỗi project 1 span, lấy từ ProjectDto (startDate, deadline)
   * làm anchor, mở rộng về phía trước/sau bằng deadline/fixed* của tasks và
   * scheduled* của subtasks. Mỗi span có 1 màu riêng (hash từ project id).
   * (Kiểu ProjectSpan đã được khai báo ở top-level file.)
   */

  /** Bảng màu xoay vòng cho project spans (khi ở /schedule all-projects). */
  const PROJECT_COLORS = [
    "#4EDEA3", // secondary (green)
    "#C0C1FF", // primary (lavender)
    "#FFB4AB", // error (coral)
    "#FFD479", // amber
    "#9DC8FF", // sky
    "#FF9CD8", // pink
  ];
  const colorForProject = (id: string) => {
    let h = 0;
    for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0;
    return PROJECT_COLORS[Math.abs(h) % PROJECT_COLORS.length];
  };

  const projectSpans = useMemo<ProjectSpan[]>(() => {
    if (project) {
      // Single-project mode: 1 span duy nhất
      const starts: number[] = [];
      const ends: number[] = [];
      if (project.startDate) {
        const s = new Date(project.startDate);
        if (!Number.isNaN(s.getTime())) starts.push(s.getTime());
      }
      if (project.deadline) {
        const e = new Date(project.deadline);
        if (!Number.isNaN(e.getTime())) ends.push(e.getTime());
      }
      for (const t of tasks) {
        if (t.deadline) {
          const d = new Date(t.deadline);
          if (!Number.isNaN(d.getTime())) ends.push(d.getTime());
        }
        if (t.fixedStart) {
          const s = new Date(t.fixedStart);
          if (!Number.isNaN(s.getTime())) starts.push(s.getTime());
        }
        if (t.fixedEnd) {
          const e = new Date(t.fixedEnd);
          if (!Number.isNaN(e.getTime())) ends.push(e.getTime());
        }
      }
      for (const st of subtasks) {
        if (st.scheduledStart) {
          const s = new Date(st.scheduledStart);
          if (!Number.isNaN(s.getTime())) starts.push(s.getTime());
        }
        if (st.scheduledEnd) {
          const e = new Date(st.scheduledEnd);
          if (!Number.isNaN(e.getTime())) ends.push(e.getTime());
        }
      }
      if (starts.length === 0 && ends.length === 0) return [];
      const minStart = starts.length ? Math.min(...starts) : Math.min(...ends);
      const maxEnd = ends.length ? Math.max(...ends) : Math.max(...starts);
      return [{
        project,
        start: new Date(minStart),
        end: new Date(maxEnd),
        color: colorForProject(project.id),
      }];
    }
    // All-projects mode: 1 span mỗi project
    if (allProjects.length === 0) return [];
    const spans: ProjectSpan[] = [];
    for (const p of allProjects) {
      const starts: number[] = [];
      const ends: number[] = [];
      if (p.startDate) {
        const s = new Date(p.startDate);
        if (!Number.isNaN(s.getTime())) starts.push(s.getTime());
      }
      if (p.deadline) {
        const e = new Date(p.deadline);
        if (!Number.isNaN(e.getTime())) ends.push(e.getTime());
      }
      // tasks của project này
      const projTasks = tasks.filter((t) => t.projectId === p.id);
      for (const t of projTasks) {
        if (t.deadline) {
          const d = new Date(t.deadline);
          if (!Number.isNaN(d.getTime())) ends.push(d.getTime());
        }
        if (t.fixedStart) {
          const s = new Date(t.fixedStart);
          if (!Number.isNaN(s.getTime())) starts.push(s.getTime());
        }
        if (t.fixedEnd) {
          const e = new Date(t.fixedEnd);
          if (!Number.isNaN(e.getTime())) ends.push(e.getTime());
        }
      }
      const taskIds = new Set(projTasks.map((t) => t.id));
      for (const st of subtasks) {
        if (!taskIds.has(st.taskId)) continue;
        if (st.scheduledStart) {
          const s = new Date(st.scheduledStart);
          if (!Number.isNaN(s.getTime())) starts.push(s.getTime());
        }
        if (st.scheduledEnd) {
          const e = new Date(st.scheduledEnd);
          if (!Number.isNaN(e.getTime())) ends.push(e.getTime());
        }
      }
      if (starts.length === 0 && ends.length === 0) continue;
      const minStart = starts.length ? Math.min(...starts) : Math.min(...ends);
      const maxEnd = ends.length ? Math.max(...ends) : Math.max(...starts);
      spans.push({
        project: p,
        start: new Date(minStart),
        end: new Date(maxEnd),
        color: colorForProject(p.id),
      });
    }
    return spans;
  }, [project, allProjects, tasks, subtasks]);

  /** Backward compat: projectSpan = projectSpans[0] hoặc null. */
  const projectSpan = projectSpans[0] ?? null;

  /**
   * Pick project accent cho 1 ngày cụ thể (wrapper cho pickAccentForDay).
   * Ưu tiên project có deadline gần nhất, sau đó đến total tasks cao nhất.
   * Trả về {accent, allSpans, totalTasks, totalSubtasks, projectCount}.
   */
  const pickAccentForCell = useCallback((day: Date) => {
    return pickAccentForDay(day, projectSpans, tasks, subtasks);
  }, [projectSpans, tasks, subtasks]);

  /**
   * Lưu anchor của project span để nút "Jump to span" quay lại được.
   * Chỉ ghi nhớ — KHÔNG tự setAnchor, để vào trang luôn dừng ở hôm nay.
   */
  useEffect(() => {
    if (projectSpan) {
      // Đặt anchor vào khoảng giữa span để bao quát dễ nhìn
      const mid = new Date(
        (projectSpan.start.getTime() + projectSpan.end.getTime()) / 2,
      );
      setSpanAnchor((prev) => prev ?? mid);
    }
  }, [projectSpan]);

  /**
   * Anchor mặc định = HÔM NAY.
   *
   * Trước đây có effect setAnchor(spanAnchor) để nhảy vào giữa project span.
   * Điều đó khiến vào trang Schedule lịch bị dời sang tuần/tháng khác — user
   * phải tự bấm "Today" mới về đúng ngày hiện tại.
   *
   * Nay `anchor` khởi tạo sẵn là `new Date()` nên vào trang là đúng tuần/tháng
   * của hôm nay. Nút "Jump to span" vẫn dùng `spanAnchor` để nhảy khi user
   * muốn xem đúng khoảng thời gian của project.
   */

  /** Helper: anchor hiện tại có nằm ngoài project span không? */
  const outsideSpan = useMemo<boolean>(() => {
    if (!projectSpan) return false;
    const rStart = range.start.getTime();
    const rEnd = range.end.getTime();
    return (
      rEnd < projectSpan.start.getTime() || rStart > projectSpan.end.getTime()
    );
  }, [projectSpan, range]);

  function jumpToSpan() {
    if (!spanAnchor) return;
    setAnchor(spanAnchor);
  }

  /* Week board — 7 ngày (tuần lịch T2 → CN) ở cả view Tuần lẫn view Gantt */
  const week = useMemo<DayPlan[]>(() => {
    // 7 ngày: tuần lịch Thứ Hai → Chủ Nhật.
    const dayCount = 7;
    return Array.from({ length: dayCount }).map((_, i) => {
      const date = addDays(range.start, i);
      const dayEvents = events.filter((ev) => {
        if (ev.isAllDay) return isSameDay(ev.start, date);
        // Timed event: có trong ngày này nếu bắt đầu ngày này, HOẶC đang kéo
        // dài qua ngày này (start < day < end).
        if (isSameDay(ev.start, date)) return true;
        if (ev.start < date && ev.end > date) return true;
        /*
         * Aggregate event (task gộp nhiều subtask): `start`/`end` là min/max
         * của các block con → không đủ để biết task thực sự có việc ở ngày
         * này hay không. Ví dụ task có subtask ở ngày 1 và ngày 3 thì aggregate
         * start = ngày 1, end = ngày 3 → điều kiện trên chỉ khớp ngày 1.
         *
         * Ta kiểm tra thêm: có block con nào rơi vào ngày này không → nếu có
         * thì hiện task ở ngày này (TaskCard sẽ chỉ list các block của
         * đúng ngày đó).
         */
        if (ev.aggregatedEvents && ev.aggregatedEvents.length > 0) {
          return ev.aggregatedEvents.some((c) => {
            if (isSameDay(c.start, date)) return true;
            return c.start < date && c.end > date;
          });
        }
        return false;
      });
      /*
       * ⚠️ Sắp xếp theo GIỜ BẮT ĐẦU tăng dần.
       *
       * `events` giữ thứ tự API trả về → không sort thì card trong 1 ngày
       * hiện lộn xộn (việc 14:00 nằm trên việc 09:00).
       *
       * Tie-break theo tiêu đề để thứ tự ổn định giữa các lần render.
       */
      dayEvents.sort((a, b) => {
        const ta = eventStartTime(a, date);
        const tb = eventStartTime(b, date);
        if (ta !== tb) return ta - tb;
        return a.title.localeCompare(b.title);
      });
      const totalHours = dayEvents.reduce((acc, ev) => acc + durationHours(ev), 0);
      const pct = Math.min(100, Math.round((totalHours / 8) * 100));
      let label: string;
      let tone: Tone;
      if (pct >= 80) { label = "Overload"; tone = "error"; }
      else if (pct >= 60) { label = "High"; tone = "primary"; }
      else if (pct >= 40) { label = "Optimal"; tone = "secondary"; }
      else { label = "Light"; tone = "muted"; }
      const isToday = isSameDay(date, new Date());
      const isRest = date.getDay() === 0 || date.getDay() === 6;
      return {
        key: date.toISOString(),
        date,
        badge: isToday ? "Today" : `${totalHours.toFixed(1)}h`,
        badgeTone: isToday ? "primary" : tone,
        load: { hours: totalHours, pct, label, tone },
        events: dayEvents,
        rest: isRest && dayEvents.length === 0,
      };
    });
  }, [events, range]);

  /* Month grid: 6 weeks */
  const monthGrid = useMemo<DayPlan[]>(() => {
    const gridStart = startOfWeek(startOfMonth(anchor));
    return Array.from({ length: 42 }).map((_, i) => {
      const date = addDays(gridStart, i);
      const dayEvents = events.filter((ev) => {
        if (ev.isAllDay) return isSameDay(ev.start, date);
        return isSameDay(ev.start, date);
      });
      /* Sắp xếp theo giờ bắt đầu tăng dần (như week board). */
      dayEvents.sort((a, b) => {
        const ta = eventStartTime(a, date);
        const tb = eventStartTime(b, date);
        if (ta !== tb) return ta - tb;
        return a.title.localeCompare(b.title);
      });
      const totalHours = dayEvents.reduce((acc, ev) => acc + durationHours(ev), 0);
      return {
        key: date.toISOString(),
        date,
        badge: `${totalHours.toFixed(1)}h`,
        badgeTone: totalHours > 6 ? "error" : totalHours > 3 ? "primary" : "muted",
        load: {
          hours: totalHours,
          pct: Math.min(100, (totalHours / 8) * 100),
          label: "",
          tone: "muted",
        },
        events: dayEvents,
        rest: date.getMonth() !== anchor.getMonth(),
      };
    });
  }, [events, anchor]);

  /**
   * Cuộn month grid tới ô "hôm nay" để user luôn nhìn thấy ngày hiện tại
   * khi mở tháng view (grid 6 hàng × 110px thường vượt quá viewport).
   *
   * Dùng `scrollTo` trên chính grid (không `scrollIntoView`) để KHÔNG cuộn
   * cả trang — `scrollIntoView` sẽ kéo theo mọi scroll container cha.
   */
  useEffect(() => {
    if (viewMode !== "month") return;
    const grid = monthGridRef.current;
    if (!grid) return;
    const todayCell = grid.querySelector<HTMLElement>(
      ".sch-month__cell--today",
    );
    if (!todayCell) {
      // Tháng đang xem không chứa hôm nay (đã lướt sang tháng khác) →
      // reset grid về đầu thay vì giữ vị trí scroll của tháng trước.
      grid.scrollTo({ top: 0, behavior: "smooth" });
      return;
    }
    // requestAnimationFrame để chờ layout xong sau khi đổi tháng.
    const raf = requestAnimationFrame(() => {
      // Dùng getBoundingClientRect để không phụ thuộc offsetParent:
      // delta = vị trí cell so với mép trên của vùng nhìn grid.
      const gridRect = grid.getBoundingClientRect();
      const cellRect = todayCell.getBoundingClientRect();
      const delta = cellRect.top - gridRect.top;
      const target =
        grid.scrollTop + delta - (grid.clientHeight - cellRect.height) / 2;
      grid.scrollTo({ top: Math.max(0, target), behavior: "smooth" });
    });
    return () => cancelAnimationFrame(raf);
  }, [viewMode, anchor, loading, error]);

  /* KPIs */
  const kpis = useMemo(() => {
    const totalHours = events.reduce((acc, ev) => acc + durationHours(ev), 0);
    const done = events.filter((ev) => {
      const s = (ev.status ?? "").toLowerCase();
      return s === "done" || s === "completed";
    }).length;
    const total = events.length;
    const days = new Set(events.map((ev) => ev.start.toDateString())).size;
    const now = new Date();
    const overdue = events.filter((ev) => {
      const s = (ev.status ?? "").toLowerCase();
      return ev.end < now && s !== "done" && s !== "completed" && s !== "skipped";
    }).length;
    return {
      totalHours: Math.round(totalHours * 10) / 10,
      tasksCount: total,
      doneCount: done,
      activeDays: days,
      overdueCount: overdue,
    };
  }, [events]);

  /* AI ribbon suggestion */
  const aiSuggestion = useMemo(() => {
    const overloaded = week.filter((d) => d.load.pct >= 85);
    const light = week.filter((d) => d.load.pct < 30 && !d.rest);
    if (overloaded.length === 0 || light.length === 0) return null;
    return {
      from: overloaded[0],
      to: light[light.length - 1],
    };
  }, [week]);

  /* staggered mount for KPIs */
  const { mounted: kpiMounted, bumpKey: kpiBumpKey, getDelay: getKpiDelay } =
    useStaggeredMount(60, 40, kpis.tasksCount);

  /* Navigation */
  function goPrev() {
    if (viewMode === "month") {
      setAnchor(new Date(anchor.getFullYear(), anchor.getMonth() - 1, 1));
      return;
    }
    if (viewMode === "week") {
      // Tuần lịch 7 ngày → lùi 1 tuần.
      setWeekStart(addDays(weekStart, -7));
      return;
    }
    setAnchor(addDays(anchor, -7));
  }
  function goNext() {
    if (viewMode === "month") {
      setAnchor(new Date(anchor.getFullYear(), anchor.getMonth() + 1, 1));
      return;
    }
    if (viewMode === "week") {
      // Tuần lịch 7 ngày → tiến 1 tuần.
      setWeekStart(addDays(weekStart, 7));
      return;
    }
    setAnchor(addDays(anchor, 7));
  }
  function goToday() {
    setAnchor(new Date());
    // Quay lại tuần lịch chứa hôm nay.
    setWeekStart(startOfWeek(new Date()));
  }

  /* Period label */
  const periodLabel = useMemo(() => {
    if (viewMode === "month") {
      return `${MONTH_LABELS[anchor.getMonth()]} ${anchor.getFullYear()}`;
    }
    const s = range.start;
    const e = range.end;
    const sameMonth = s.getMonth() === e.getMonth();
    if (sameMonth) {
      return `${s.getDate()} – ${e.getDate()} ${MONTH_LABELS[s.getMonth()]} ${s.getFullYear()}`;
    }
    return `${s.getDate()} ${MONTH_LABELS[s.getMonth()]} – ${e.getDate()} ${MONTH_LABELS[e.getMonth()]} ${e.getFullYear()}`;
  }, [viewMode, anchor, range]);

  /* Selected event for detail */
  const [selected, setSelected] = useState<CalEvent | null>(null);
  /**
   * Slot đang được bấm trên lịch (id của schedule slot).
   *
   * ⚠️ 1 task có thể có N slot rời rạc (8h–10h, 16h–18h). Nút Start/Make up
   * phải áp dụng cho ĐÚNG slot người dùng bấm → nhớ lại slot id khi mở
   * modal, thay vì luôn lấy slot đầu tiên.
   */
  const [focusSlotId, setFocusSlotId] = useState<string | null>(null);

  /**
   * Mở modal chi tiết cho 1 event.
   *
   * `focusSlotId` = slot cụ thể người dùng vừa bấm trên lịch (nếu có) → modal
   * hiện nút Start/Make up/Stop đúng cho slot đó.
   */
  const openDetail = useCallback((e: CalEvent, focus?: string | null) => {
    setSelected(e);
    setFocusSlotId(focus ?? null);
  }, []);

  /** Cell popover: hiện khi click 1 cell — liệt kê TẤT CẢ task trong ngày. */
  const [popover, setPopover] = useState<{ day: Date; items: DayItem[] } | null>(null);

  const openCellPopover = useCallback(
    (day: Date) => {
      // Gom từ `events` (đã gộp calendar + task deadline + subtask + slot)
      // để không bỏ sót task nào trong ngày.
      setPopover({ day, items: collectDayItems(events, day) });
    },
    [events],
  );

  /** Đóng popover khi click ra ngoài. */
  useEffect(() => {
    if (!popover) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      if (target?.closest(".sch-cell-popover")) return;
      // Không đóng khi click vào cell (sẽ re-open)
      if (target?.closest(".sch-tg__col") || target?.closest(".sch-month__cell")) return;
      setPopover(null);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [popover]);

  /* ----- Schedule Slot handlers ----- */

  /**
   * Slot đang chờ xác nhận xóa.
   *
   * Yêu cầu: bấm xóa → hiện pop-up xác nhận (tiếng Anh) → CHỈ khi bấm
   * "Delete slot" mới gọi API xóa.
   */
  const [slotPendingDelete, setSlotPendingDelete] = useState<{
    slotId: string;
    title: string;
    isGroup: boolean;
  } | null>(null);
  /** Đang gọi API xóa → khoá nút xác nhận. */
  const [deletingSlot, setDeletingSlot] = useState(false);

  /** Mở pop-up xác nhận xóa (chưa xóa). */
  const requestDeleteSlot = useCallback(
    (slotId: string, title: string, isGroup = false) => {
      setSlotPendingDelete({ slotId, title, isGroup });
    },
    []
  );

  /** Bỏ qua xóa → đóng pop-up. */
  const cancelDeleteSlot = useCallback(() => {
    if (deletingSlot) return;
    setSlotPendingDelete(null);
  }, [deletingSlot]);

  /** Xác nhận xóa → mới gọi API. */
  const confirmDeleteSlot = useCallback(async () => {
    if (!slotPendingDelete) return;
    setDeletingSlot(true);
    const res = await deleteScheduleSlot(slotPendingDelete.slotId);
    setDeletingSlot(false);
    setSlotPendingDelete(null);
    if (res.ok) {
      setScheduleSlots((prev) => prev.filter((s) => s.id !== slotPendingDelete.slotId));
      toast.success(
        "Slot deleted",
        slotPendingDelete.isGroup
          ? "The group work block was removed from your calendar."
          : "The time block was removed from your calendar.",
      );
      /*
       * ⚠️ Ở `/schedule`, lịch được dựng từ `GET /api/calendar`
       * (`calendarItems`) chứ không phải từ `scheduleSlots` → phải refetch để
       * slot vừa xóa biến mất khỏi lịch.
       */
      void loadData();
    } else {
      toast.error("Couldn't delete the slot", res.error);
    }
  }, [slotPendingDelete, toast, loadData]);

  /* Filtered events: simple status filter for now */
  const visibleWeek = useMemo(() => {
    if (filter === "all") return week;
    // light stub: just return all for non-"all" filters
    return week;
  }, [filter, week]);

  /**
   * Pre-compute accent info cho mỗi visible day (week + month grid),
   * dùng để render badge "N projects / N tasks" trên mỗi cell.
   * Phải khai báo SAU `visibleWeek` & `monthGrid` (Temporal Dead Zone guard).
   */
  const cellAccentByKey = useMemo(() => {
    const map = new Map<string, ReturnType<typeof pickAccentForCell>>();
    for (const d of [...visibleWeek, ...monthGrid]) {
      map.set(d.key, pickAccentForCell(d.date));
    }
    return map;
  }, [visibleWeek, monthGrid, pickAccentForCell]);

  return (
    <section className="sch">
      <div className="sch-ambient sch-ambient--left" aria-hidden="true" />
      <div className="sch-ambient sch-ambient--right" aria-hidden="true" />

      <div className="sch-container">
        {/* ============ 1. Header ============ */}
        <div className="sch-header">
          <div className="sch-header__left">
            <button type="button" className="sch-icon-btn" onClick={() => navigate(projectId ? `/projects/${projectId}` : "/projects")} aria-label="Back">
              <span className="material-symbols-outlined">arrow_back</span>
            </button>
            <div>
              {/*
                * Tiêu đề lớn, nổi bật.
                * - Không còn chữ "Loading…" (trước đây `project?.name` chưa kịp
                *   tải → nhảy "Loading…" rồi mới đổi, gây nhấp nháy).
                * - Ở trang lịch tổng hiện "Personal schedule".
                */}
              <h1 className="sch-title sch-title--display">
                {projectId
                  ? (project?.name ?? "Project schedule")
                  : "Personal schedule"}
              </h1>
            </div>
          </div>

          <div className="sch-header__right">
            <Link
              to={projectId ? `/projects/${projectId}/planning` : "/projects"}
              className="sch-btn sch-btn--soft"
            >
              <span className="material-symbols-outlined sch-icon-18">edit_calendar</span>
              Planning
            </Link>
            <GoogleCalendarSyncButton
              toast={toast}
              onSynced={handleCalendarSynced}
            />
          </div>
        </div>

        {/* ============ 1b. Project span banner ============ */}
        {projectSpans.length === 1 && (
          <div
            className={`sch-span${outsideSpan ? " sch-span--off" : ""}`}
            role="status"
            aria-live="polite"
            style={{
              borderColor: `${projectSpans[0].color}55`,
              background: `${projectSpans[0].color}10`,
            }}
          >
            <span className="material-symbols-outlined sch-icon-18" style={{ color: projectSpans[0].color }}>date_range</span>
            <div className="sch-span__body">
              <span className="sch-span__label">
                <span className="sch-span__dot" style={{ background: projectSpans[0].color }} />
                {projectSpans[0].project.name} • span
              </span>
              <span className="sch-span__value">
                {projectSpans[0].start.toLocaleDateString(undefined, {
                  year: "numeric", month: "short", day: "numeric",
                })}
                <span className="sch-span__sep">→</span>
                {projectSpans[0].end.toLocaleDateString(undefined, {
                  year: "numeric", month: "short", day: "numeric",
                })}
              </span>
            </div>
            {outsideSpan && (
              <button
                type="button"
                className="sch-btn sch-btn--soft sch-span__jump"
                onClick={jumpToSpan}
              >
                <span className="material-symbols-outlined sch-icon-18">center_focus_strong</span>
                Jump to span
              </button>
            )}
          </div>
        )}

        {/* ============ 2. Timeline navigator ============ */}
        <div className="sch-timeline">
          <div className="sch-timeline__nav">
            <button type="button" className="sch-icon-btn" onClick={goPrev} aria-label="Previous">
              <span className="material-symbols-outlined">chevron_left</span>
            </button>
            <button type="button" className="sch-timeline__today" onClick={goToday}>Today</button>
            <button type="button" className="sch-icon-btn" onClick={goNext} aria-label="Next">
              <span className="material-symbols-outlined">chevron_right</span>
            </button>
            <div className="sch-timeline__period">{periodLabel}</div>
          </div>

          <div className="sch-timeline__tabs" role="tablist" aria-label="View mode">
            {(["week", "month", "gantt"] as ViewMode[]).map((v) => (
              <button
                key={v}
                type="button"
                role="tab"
                aria-selected={viewMode === v}
                className={`sch-tab${viewMode === v ? " sch-tab--active" : ""}`}
                onClick={() => setViewMode(v)}
              >
                {v === "week" ? "Week" : v === "month" ? "Month" : "Sprint & Gantt"}
              </button>
            ))}
          </div>

          {/*
            ⚠️ Bộ lọc nhanh (All items / Priority / Capstone / Deep work) đã
            bị ẩn — chúng chưa được implement thật (xem `visibleWeek`) nên
            chỉ gây nhiễu. `filter` vẫn giữ trong state để sẵn sàng bật lại.
          */}
        </div>

        {/* Loading / Error */}
        {loading && (
          <div className="sch-state" role="status">
            <span className="material-symbols-outlined sch-state-icon sch-state-icon--spin">progress_activity</span>
            <p>Loading calendar…</p>
          </div>
        )}
        {!loading && error && (
          <div className="sch-state sch-state--error" role="alert">
            <span className="material-symbols-outlined sch-state-icon">error</span>
            <p>{error}</p>
            <button type="button" className="sch-btn sch-btn--soft" onClick={() => void loadData()}>
              Retry
            </button>
          </div>
        )}

        {/* ============ 3. KPI strip ============ */}
        {!loading && !error && (
          <div
            key={kpiBumpKey}
            className={`sch-kpis${kpiMounted ? " sch-kpis--in" : ""}`}
          >
            <KpiCard
              tone="primary"
              label="Scheduled hours"
              value={`${kpis.totalHours}h`}
              icon="schedule"
              hint={viewMode === "month" ? "this month" : "this week"}
              delay={getKpiDelay(0)}
            />
            <KpiCard
              tone="secondary"
              label="Items"
              value={kpis.tasksCount}
              icon="task_alt"
              hint={`${kpis.doneCount} done`}
              delay={getKpiDelay(1)}
            />
            <KpiCard
              tone="tertiary"
              label="Active days"
              value={kpis.activeDays}
              icon="calendar_view_week"
              hint="with events"
              delay={getKpiDelay(2)}
            />
            <KpiCard
              tone={kpis.overdueCount > 0 ? "error" : "muted"}
              label="Overdue"
              value={kpis.overdueCount}
              icon="warning"
              hint={kpis.overdueCount > 0 ? "needs reschedule" : "on track"}
              delay={getKpiDelay(3)}
            />
          </div>
        )}

        {/* ============ 4. AI ribbon ============ */}
        {!loading && !error && aiSuggestion && (
          <div className="sch-ai">
            <div className="sch-ai__icon">
              <span className="material-symbols-outlined">auto_awesome</span>
            </div>
            <div className="sch-ai__body">
              <span className="sch-ai__title">AI suggestion</span>
              <p className="sch-ai__text">
                <strong>{aiSuggestion.from.date.toLocaleDateString(undefined, { weekday: "long" })}</strong> is at {aiSuggestion.from.load.pct}% load.
                Move a non-priority item to <strong>{aiSuggestion.to.date.toLocaleDateString(undefined, { weekday: "long" })}</strong> ({aiSuggestion.to.load.pct}%) to balance the week.
              </p>
            </div>
            <div className="sch-ai__actions">
              <button
                type="button"
                className="sch-btn sch-btn--primary"
                onClick={openProposal}
                disabled={schedulableCount === 0 || proposal.loading}
                title={
                  schedulableCount === 0
                    ? "No flexible tasks left without a schedule"
                    : `AI will suggest time slots for ${schedulableCount} flexible tasks — tick them then press Apply to write them to your schedule`
                }
              >
                <span className="material-symbols-outlined sch-icon-18">auto_awesome</span>
                Auto-schedule
              </button>
            </div>
          </div>
        )}

        {/* ============ 5. Main board (full width — không còn sidebar) ============ */}
        {!loading && !error && (
          <div className="sch-board">
            {/*
              Dải công cụ Google Calendar — trước đây nằm ở sidebar cạnh
              lịch. Nay đưa lên trên dạng dải ngang để lịch được rộng hết
              chiều ngang (mỗi task 1 ô vuông lớn, dễ đọc).
            */}
            <div className="sch-board__main">
              {viewMode === "week" && (
                <div className="sch-tg-scroll">
                  <WeekBoard days={visibleWeek} onSelectEvent={openDetail} tasksById={tasksById} spans={projectSpans} onCellClick={openCellPopover} accentByKey={cellAccentByKey} subtasksByTaskId={subtasksByTaskId} />
                </div>
              )}
              {viewMode === "month" && (
                <MonthGrid days={monthGrid} onSelectEvent={setSelected} spans={projectSpans} onCellClick={openCellPopover} accentByKey={cellAccentByKey} gridRef={monthGridRef} />
              )}
              {viewMode === "gantt" && (
                <GanttView days={visibleWeek} onSelectEvent={setSelected} spans={projectSpans} />
              )}
            </div>
          </div>
        )}
      </div>

      {/* Event detail modal */}
      {selected && (
        <EventDetailModal
          event={selected}
          subtasks={subtasks}
          focusSlotId={focusSlotId}
          blockedReasonFor={blockedReasonFor}
          onClose={() => setSelected(null)}
          onDelete={requestDeleteSlot}
          onSlotChanged={() => void loadData()}
        />
      )}

      {/* Cell popover: hiện khi click 1 cell — liệt kê tất cả task trong ngày */}
      {popover && (
        <CellPopover
          day={popover.day}
          items={popover.items}
          onClose={() => setPopover(null)}
          onSelectEvent={(e) => openDetail(e)}
        />
      )}

      {/*
        Pop-up xác nhận XÓA slot — chỉ khi bấm "Delete slot" mới gọi API.
        Song song với modal detail (modal cha vẫn mở) nên z-index cao hơn.
      */}
      <ScheduleConfirmDialog
        open={slotPendingDelete !== null}
        title="Delete this slot?"
        message={
          slotPendingDelete
            ? `The time block for "${slotPendingDelete.title}" will be removed from your calendar. This action cannot be undone.`
            : ""
        }
        confirmLabel="Delete slot"
        busy={deletingSlot}
        onConfirm={() => void confirmDeleteSlot()}
        onCancel={cancelDeleteSlot}
      />

      {proposalOpen && (
        <ProposalDialog
          hook={proposal}
          tasksById={tasksByIdMap}
          subtasksById={subtasksById}
          onClose={() => setProposalOpen(false)}
          onDone={handleProposalDone}
        />
      )}

      <CenterToasts toasts={toasts} onDismiss={toastDismiss} />
    </section>
  );
}

/* ===========================================================
 * KpiCard
 * =========================================================== */
function KpiCard({
  tone, label, value, icon, hint, delay,
}: {
  tone: Tone;
  label: string;
  value: string | number;
  icon: string;
  hint?: string;
  delay?: { animationDelay: string };
}) {
  // Tách số và đơn vị (e.g. "5.5h" -> ["5.5", "h"]; "12" -> ["12", ""])
  const text = String(value);
  const match = text.match(/^(-?\d+(?:\.\d+)?)(.*)$/);
  const num = match ? match[1] : text;
  const suffix = match ? match[2] : "";
  const isOk = hint && /on track|done|with events/.test(hint);
  return (
    <div className="sch-kpi" data-tone={tone} style={delay}>
      <div className="sch-kpi__head">
        <span className="sch-kpi__label">{label}</span>
        <span className="material-symbols-outlined sch-kpi__icon">{icon}</span>
      </div>
      <div className="sch-kpi__value">
        <span className="sch-kpi__num">{num}</span>
        {suffix && <span className="sch-kpi__suffix">{suffix}</span>}
      </div>
      {hint && (
        <div className="sch-kpi__foot">
          <span className={`sch-kpi__note${isOk ? " sch-kpi__note--ok" : ""}`}>
            <span className="material-symbols-outlined sch-icon-14">
              {isOk ? "check_circle" : "info"}
            </span>
            {hint}
          </span>
        </div>
      )}
    </div>
  );
}

/* ===========================================================
 * Week board — LƯỚI GIỜ (cột giờ bên trái)
 *
 * Mỗi cột là 1 ngày, trục thời gian chạy dọc 06:00 → 23:00. Các block
 * task được đặt theo đúng khung giờ (top/height tính theo giờ).
 *
 * ⚠️ Task có các khung giờ RỜI RẠC (subtask 8h–10h, rồi subtask khác
 * 16h–18h cùng task) → tách thành 2 block riêng, KHÔNG gộp thành 1 block
 * 8h–18h (xem `segmentEvent`).
 * =========================================================== */
function WeekBoard({
  days, onSelectEvent, tasksById, spans, onCellClick, accentByKey, subtasksByTaskId,
  gridStartHour = 6, gridEndHour = 23,
}: {
  days: DayPlan[];
  onSelectEvent: (e: CalEvent, focusSlotId?: string | null) => void;
  tasksById: Record<string, TaskDto>;
  spans: ProjectSpan[];
  onCellClick?: (day: Date) => void;
  accentByKey: Map<string, CellAccent | null>;
  /** Subtask theo taskId — TimeBlock dùng để hiện danh sách con. */
  subtasksByTaskId?: Map<string, SubtaskDto[]>;
  /** Giờ bắt đầu / kết thúc của trục thời gian (0–24). */
  gridStartHour?: number;
  gridEndHour?: number;
}) {
  /*
   * Tách mỗi event thành các đoạn giờ LIÊN TỤC rồi xếp lane để không
   * chồng nhau.
   */
  const daySegments = useMemo(() => {
    return days.map((d) => {
      const timed: EventSegment[] = [];
      const allDay: CalEvent[] = [];
      for (const ev of d.events) {
        if (ev.isAllDay) {
          allDay.push(ev);
          continue;
        }
        timed.push(...segmentEvent(ev, d.date));
      }
      return { day: d, timed: layoutSegments(timed), allDay };
    });
  }, [days]);

  /** Có all-day event nào không (để hiện hàng all-day riêng). */
  const hasAllDay = daySegments.some((s) => s.allDay.length > 0);

  /** Trục giờ: mở rộng để chứa hết block, làm tròn theo giờ. */
  const { axisStart, axisEnd } = useMemo(() => {
    let min = gridStartHour;
    let max = gridEndHour;
    for (const s of daySegments) {
      for (const t of s.timed) {
        const sh = t.seg.start.getHours();
        const eh =
          t.seg.end.getHours() + (t.seg.end.getMinutes() > 0 ? 1 : 0);
        if (sh < min) min = sh;
        if (eh > max) max = eh;
      }
    }
    const axisStart = Math.max(0, Math.floor(min));
    // Luôn giữ ít nhất 1 giờ để trục không bị rỗng / chia 0.
    const axisEnd = Math.max(axisStart + 1, Math.min(24, Math.ceil(max)));
    return { axisStart, axisEnd };
  }, [daySegments, gridStartHour, gridEndHour]);

  const hours = useMemo(() => {
    const out: number[] = [];
    for (let h = axisStart; h <= axisEnd; h++) out.push(h);
    return out;
  }, [axisStart, axisEnd]);

  return (
    <div
      className="sch-tg"
      style={
        {
          "--sch-tg-cols": days.length,
          "--sch-tg-hours": axisEnd - axisStart,
        } as CSSProperties
      }
    >
      {/* ---------- Góc trên trái: nhãn trục giờ ---------- */}
      <div className="sch-tg__corner">
        <span className="material-symbols-outlined sch-icon-14">schedule</span>
        <span className="sch-tg__corner-text">
          {String(axisStart).padStart(2, "0")}:00 – {String(axisEnd).padStart(2, "0")}:00
        </span>
      </div>

      {/* ---------- Header: tên ngày ---------- */}
      {daySegments.map(({ day: d }) => {
        const isToday = isSameDay(d.date, new Date());
        const accent = accentByKey.get(d.key);
        /*
         * Project boundary (start / end) — tìm span chạm ngày này để gắn nhãn
         * "project X · start" ở header cột.
         */
        const boundary = spans.find((sp) => {
          const ts = startOfDay(sp.start).getTime();
          const te = startOfDay(sp.end).getTime();
          const dc = startOfDay(d.date).getTime();
          return dc === ts || dc === te || (dc > ts && dc < te);
        });
        const isStart =
          boundary &&
          startOfDay(boundary.start).getTime() === startOfDay(d.date).getTime();
        const isEnd =
          boundary &&
          startOfDay(boundary.end).getTime() === startOfDay(d.date).getTime();
        return (
          <div
            key={d.key}
            className={`sch-tg__head${isToday ? " sch-tg__head--today" : ""}${d.rest ? " sch-tg__head--rest" : ""}`}
            style={accent ? { ["--accent-color" as any]: accent.accent.color } : undefined}
          >
            <span className="sch-tg__dow">
              {WEEKDAY_LABELS[d.date.getDay() === 0 ? 6 : d.date.getDay() - 1]}
            </span>
            <span className="sch-tg__num">{d.date.getDate()}</span>
            <span className={`sch-tg__badge sch-tone--${d.badgeTone}`}>{d.badge}</span>
            {boundary && (isStart || isEnd) && (
              <span
                className={`sch-tg__boundary${isStart && isEnd ? " sch-tg__boundary--both" : isStart ? " sch-tg__boundary--start" : " sch-tg__boundary--end"}`}
                title={`${boundary.project.name}${isStart && isEnd ? " · start & end" : isStart ? " · start" : " · end"}`}
              >
                <span className="material-symbols-outlined sch-icon-12">
                  {isStart && isEnd ? "flag" : isStart ? "play_arrow" : "stop"}
                </span>
                {boundary.project.name}
              </span>
            )}
          </div>
        );
      })}

      {/* ---------- Hàng all-day (deadline / milestone) ---------- */}
      {hasAllDay && (
        <>
          <div className="sch-tg__allday-label">
            <span>All day</span>
          </div>
          {daySegments.map(({ day: d, allDay }) => (
            <div key={`allday-${d.key}`} className="sch-tg__allday-cell">
              {allDay.map((ev) => (
                <button
                  key={ev.id}
                  type="button"
                  className="sch-tg__allday-chip"
                  onClick={(e) => {
                    e.stopPropagation();
                    onSelectEvent(ev);
                  }}
                  title={ev.title}
                >
                  <span className="material-symbols-outlined sch-icon-12">event</span>
                  <span className="sch-tg__allday-title">{ev.title}</span>
                </button>
              ))}
            </div>
          ))}
        </>
      )}

      {/* ---------- Trục giờ (bên trái) ----------
          *
          * Nhãn giờ được đặt TUYỆT ĐỐI theo % (canh đúng với đường kẻ ngang
          * của cột ngày). Nếu dùng flow + `height` cố định thì gutter lệch
          * 1 giờ so với cột ngày (lệch nhất là ở giờ cuối).
          */}
      <div className="sch-tg__gutter">
        {hours.map((h, i) => (
          <div
            key={h}
            className="sch-tg__hour"
            style={{
              top: `${((h - axisStart) / Math.max(1, axisEnd - axisStart)) * 100}%`,
              /*
               * Canh nhãn theo đường kẻ:
               * - Giờ đầu: nhãn nằm DƯỚI đường kẻ (0%) → translateY(0).
               * - Giờ giữa: nằm GIỮA đường kẻ → translateY(-50%).
               * - Giờ cuối: nằm TRÊN đường kẻ (100%) → translateY(-100%).
               */
              transform:
                i === 0
                  ? "translateY(0)"
                  : i === hours.length - 1
                    ? "translateY(-100%)"
                    : "translateY(-50%)",
            }}
          >
            <span>{String(h).padStart(2, "0")}:00</span>
          </div>
        ))}
      </div>

      {/* ---------- Các cột ngày ---------- */}
      {daySegments.map(({ day: d, timed }) => {
        const isToday = isSameDay(d.date, new Date());
        const accent = accentByKey.get(d.key);
        return (
          <div
            key={d.key}
            className={`sch-tg__col${isToday ? " sch-tg__col--today" : ""}${d.rest ? " sch-tg__col--rest" : ""}`}
            style={accent ? { ["--accent-color" as any]: accent.accent.color } : undefined}
            onClick={onCellClick ? () => onCellClick(d.date) : undefined}
          >
            {timed.length === 0 && <div className="sch-tg__empty">No events</div>}
            {timed.map(({ seg, lane, lanes }, i) => (
              <TimeBlock
                /*
                 * Key phai DUY NHAT trong 1 cot ngay.
                 *
                 * `seg.ev.id` co the lap (cung 1 task gop xuat hien o nhieu doan)
                 * -> them chi so de bao dam khoa duy nhat, tranh warning
                 * "Encountered two children with the same key".
                 */
                key={`${seg.ev.id}-${seg.start.getTime()}-${i}`}
                seg={seg}
                lane={lane}
                lanes={lanes}
                axisStart={axisStart}
                axisEnd={axisEnd}
                day={d.date}
                onClick={(focusSlotId) => onSelectEvent(seg.ev, focusSlotId)}
                taskType={seg.ev.taskId ? tasksById[seg.ev.taskId]?.taskType : undefined}
                subtasksByTaskId={subtasksByTaskId}
              />
            ))}
          </div>
        );
      })}
    </div>
  );
}

/* ===========================================================
 * TimeBlock — 1 khối giờ trên lưới (task hoặc subtask).
 * =========================================================== */
function TimeBlock({
  seg, lane, lanes, axisStart, axisEnd, day, onClick, taskType, subtasksByTaskId,
}: {
  seg: EventSegment;
  lane: number;
  lanes: number;
  axisStart: number;
  axisEnd: number;
  day: Date;
  onClick: (focusSlotId: string | null) => void;
  taskType?: string;
  subtasksByTaskId?: Map<string, SubtaskDto[]>;
}) {
  const ev = seg.ev;
  const isDone = (() => {
    const s = (ev.status ?? "").toLowerCase();
    return s === "done" || s === "completed";
  })();

  const isGroupSlot = ev.source === "slot" && !!ev.scheduleSlotId && !!ev.groupTaskId;

  /**
   * Id của slot thuộc ĐÚNG khối giờ này.
   *
   * ⚠️ 1 task có nhiều khối giờ rời rạc (8h–10h, 16h–18h). Event gộp
   * ("task-agg") chỉ giữ slot của khối ĐẦU TIÊN → nếu dùng nó cho mọi
   * khối thì nút Start trong modal sẽ trỏ nhầm slot.
   *
   * → Lấy từ `seg.blocks` (các mốc con thuộc đúng đoạn này).
   */
  const focusSlotId = useMemo(() => {
    if (seg.blocks.length > 0) {
      const withSlot = seg.blocks.find((b) => !!b.scheduleSlotId);
      if (withSlot) return withSlot.scheduleSlotId ?? null;
    }
    return ev.scheduleSlotId ?? null;
  }, [seg.blocks, ev.scheduleSlotId]);

  /*
   * Vị trí trên trục giờ (theo % chiều cao lưới).
   */
  const dayStart = startOfDay(day);
  const totalMinutes = (axisEnd - axisStart) * 60;
  const startMin = (seg.start.getTime() - dayStart.getTime()) / 60_000 - axisStart * 60;
  const endMin = (seg.end.getTime() - dayStart.getTime()) / 60_000 - axisStart * 60;
  const topPct = Math.max(0, Math.min(100, (startMin / totalMinutes) * 100));
  const heightPct = Math.max(2, Math.min(100 - topPct, ((endMin - startMin) / totalMinutes) * 100));

  /*
   * ===========================================================
   * TEN HIEN THI: TEN TASK la dong CHINH, TEN SUBTASK la dong PHU.
   * ===========================================================
   *
   * Ly do:
   * 1. TEN TASK luon hien (dong chinh) - day la thu quan trong nhat theo
   *    yeu cau. Khi card qua ngan, cac thong tin khac bi cat truoc.
   * 2. TEN SUBTASK la dong phu - bi an khi card qua ngan.
   *
   * Voi khoi RAI RAC (1 task, nhieu khung gio): moi khoi deu mang cung
   * ten task (tu event gop) -> phai lay ten subtask dung voi khung gio do
   * lam dong phu.
   */
  const taskName = ev.task?.title ?? ev.title;

  /** Ten viec con (subtask) cua khoi nay. */
  const subName = useMemo(() => {
    if (seg.blocks.length === 1) {
      const b = seg.blocks[0];
      const bt = b.subtask?.title ?? b.title;
      if (bt && bt !== taskName) return bt;
      return null;
    }
    // Khoi co nhieu viec con -> ten khong la "con" cua ten task.
    return null;
  }, [seg.blocks, taskName]);

  /*
   * Danh sách việc con hiển thị trong khối.
   *
   * Ưu tiên các mốc con đã gộp (`seg.blocks`) — đúng thứ đang trên lịch.
   * Fallback: subtask của task theo `orderIndex` (task chưa có slot nào).
   */
  const subRows = useMemo(() => {
    if (seg.blocks.length > 0) {
      /*
       * Khối chỉ có 1 việc con → tên của nó đã hiện ở `displayTitle`, không
       * cần lặp lại thành 1 dòng phụ (trông như lỗi hiển thị trùng).
       */
      if (seg.blocks.length === 1) return [];
      return seg.blocks
        .slice()
        .sort((a, b) => a.start.getTime() - b.start.getTime())
        .map((c) => ({
          id: c.id,
          title: c.subtask?.title ?? c.title,
          time: fmtTime(c.start),
        }));
    }
    if (!ev.taskId) return [];
    const subs = subtasksByTaskId?.get(ev.taskId) ?? [];
    return subs
      .map((s) => ({
        id: s.id,
        title: s.title,
        time: s.scheduledStart ? fmtTime(new Date(s.scheduledStart)) : "--:--",
      }))
      .sort((a, b) => a.time.localeCompare(b.time));
  }, [seg.blocks, ev, subtasksByTaskId]);

  /*
   * Cột giờ bên TRÁI card — "08:00 → 10:00".
   *
   * Đây là thông tin quan trọng nhất: người dùng nhìn là biết việc này
   * chạy từ mấy giờ tới mấy giờ mà không cần tra cột giờ bên trái.
   */
  const timeStart = fmtTime(seg.start);
  const timeEnd = fmtTime(seg.end);

  /*
   * ===========================================================
   * Tự ẩn thông tin khi card quá ngắn.
   * ===========================================================
   *
   * Card 30 phút chiều cao ~24px — không đủ chỗ cho tên task + tên task cha
   * + danh sách việc con + chip meta.
   *
   * THỨ TỰ ƯU TIÊN (bỏ từ dưới lên):
   *   1. Tên task (luôn giữ — thứ quan trọng nhất, theo yêu cầu).
   *   2. Giờ bắt đầu (để biết khung giờ).
   *   3. Giờ kết thúc.
   *   4. Tên task cha (eyebrow).
   *   5. Danh sách việc con.
   *   6. Chip meta.
   *
   * Đo bằng `ResizeObserver` vì chiều cao card là % của trục giờ → thay đổi
   * theo số giờ trong ngày, không tính được từ props.
   */
  const blockRef = useRef<HTMLButtonElement | null>(null);
  const [cardH, setCardH] = useState(0);

  useLayoutEffect(() => {
    const el = blockRef.current;
    if (!el) return;
    const measure = () => setCardH(el.getBoundingClientRect().height);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  /** Còn đủ chỗ hiện tên subtask (dòng phụ) không? */
  const showSub = cardH >= 46;
  /** Còn đủ chỗ hiện giờ kết thúc không? */
  const showTimeEnd = cardH >= 30;
  /** Còn đủ chỗ hiện danh sách việc con không? */
  const showSubs = cardH >= 56;
  /** Còn đủ chỗ hiện chip meta không? */
  const showMeta = cardH >= 76;

  /**
   * Mức độ "chật" của card — quyết định cách hiển thị tên task.
   *
   * - `tight` (< 34px): chỉ 1 dòng → tên task bị ellipsis nếu dài.
   * - `mid`   (34–56px): tên task được xuống tối đa 2 dòng.
   * - undefined (>= 56px): đủ chỗ, hiển thị đầy đủ.
   */
  const compactLevel =
    cardH > 0 && cardH < 34 ? "tight" : cardH > 0 && cardH < 56 ? "mid" : undefined;

  const body = (
    <>
      <span className="sch-tg__block-accent" data-tone={dotFor(ev)} aria-hidden="true" />
      <span className="sch-tg__block-time">
        <span className="sch-tg__block-time-start">{timeStart}</span>
        {showTimeEnd && (
          <span className="sch-tg__block-time-end">{timeEnd}</span>
        )}
      </span>
      <span className="sch-tg__block-body">
        {/* TEN TASK - dong chinh, luon hien */}
        <span className="sch-tg__block-title" title={taskName}>
          {taskName}
        </span>

        {/* TEN SUBTASK - dong phu, an khi card ngan */}
        {subName && showSub && (
          <span className="sch-tg__block-parent" title={subName}>
            {subName}
          </span>
        )}

        {/* Danh sách việc con (giờ · tên) */}
        {subRows.length > 0 && showSubs && (
          <span className="sch-tg__block-subs">
            {subRows.map((r) => (
              <span key={r.id} className="sch-tg__block-sub">
                <span className="sch-tg__block-sub-time">{r.time}</span>
                <span className="sch-tg__block-sub-title">{r.title}</span>
              </span>
            ))}
          </span>
        )}

        {/* Chip meta: loại công việc / nhóm / nguồn */}
        {showMeta && (
        <span className="sch-tg__block-meta">
          {isGroupSlot && ev.groupName ? (
            <span className="sch-tg__block-tag">
              <span className="material-symbols-outlined sch-icon-12">groups</span>
              {ev.groupName}
            </span>
          ) : (
            taskType && <span className="sch-tg__block-tag">{taskType}</span>
          )}
          <span className="sch-tg__block-tag sch-tg__block-tag--muted">
            {isGroupSlot ? "Group work" : sourceLabel(ev.source)}
          </span>
        </span>
        )}
      </span>
    </>
  );

  /*
   * Vị trí khối trên lưới (theo % chiều cao cột ngày).
   *
   * Card luôn đứng độc lập trong cột ngày — KHÔNG bọc trong wrapper, không
   * kèm nút Start/Make up bên cạnh. Mọi hành động focus (Start / Stop /
   * Make up / Add minutes) nằm bên trong modal chi tiết khi bấm vào card.
   */
  const boxStyle = {
    top: `${topPct}%`,
    height: `${heightPct}%`,
    left: `calc(${(lane / lanes) * 100}% + 2px)`,
    width: `calc(${(1 / lanes) * 100}% - 4px)`,
  };

  return (
    <button
      ref={blockRef}
      type="button"
      className={`sch-tg__block${isDone ? " sch-tg__block--done" : ""}`}
      /*
       * `data-compact="tight"` khi card quá ngắn → CSS thu padding lại để
       * dành chỗ cho tên task.
       */
      data-compact={compactLevel}
      style={boxStyle}
      onClick={() => onClick(focusSlotId)}
      data-tone={dotFor(ev)}
      title={`${taskName}${subName ? ` · ${subName}` : ""} · ${fmtTime(seg.start)} – ${fmtTime(seg.end)}`}
    >
      {body}
    </button>
  );
}

/* ===========================================================
 * Month grid — 6 rows x 7 cols
 * =========================================================== */
function MonthGrid({
  days, onSelectEvent, spans, onCellClick, accentByKey, gridRef,
}: {
  days: DayPlan[];
  onSelectEvent: (e: CalEvent) => void;
  spans: ProjectSpan[];
  onCellClick?: (day: Date) => void;
  accentByKey: Map<string, CellAccent | null>;
  /** Ref tới grid — để parent cuộn tới ô "hôm nay". */
  gridRef?: Ref<HTMLDivElement>;
}) {
  return (
    <div className="sch-month">
      <div className="sch-month__head">
        {WEEKDAY_LABELS.map((d) => (
          <div key={d} className="sch-month__dow">{d}</div>
        ))}
      </div>
      <div className="sch-month__grid" ref={gridRef}>
        {days.map((d) => {
          const isToday = isSameDay(d.date, new Date());
          const showCount = 3;
          const visible = d.events.slice(0, showCount);
          const more = d.events.length - showCount;
          // Tìm spans chạm cell
          const touching = spans
            .map((sp) => {
              const ts = startOfDay(sp.start).getTime();
              const te = startOfDay(sp.end).getTime();
              const dc = startOfDay(d.date).getTime();
              return { sp, isStart: dc === ts, isEnd: dc === te, isBoth: dc === ts && dc === te, inSpan: dc > ts && dc < te };
            })
            .filter((m) => m.isStart || m.isEnd || m.inSpan);
          const inSpan = touching.some((m) => m.inSpan);
          // Single-accent: lấy từ accentByKey
          const accent = accentByKey.get(d.key);
          const primary = accent ? { sp: accent.accent } : null;
          const multi = accent && accent.projectCount > 1;
          return (
            <div
              key={d.key}
              className={`sch-month__cell${d.rest ? " sch-month__cell--off" : ""}${isToday ? " sch-month__cell--today" : ""}${inSpan ? " sch-month__cell--in-span" : ""}${multi ? " sch-month__cell--multi" : ""}`}
              style={primary ? {
                ["--accent-color" as any]: primary.sp.color,
                ["--accent-bg" as any]: `${primary.sp.color}1A`,
              } : undefined}
              onClick={onCellClick ? () => onCellClick(d.date) : undefined}
            >
              {/* Single-accent strip bar ở đáy (màu project chính) */}
              {inSpan && primary && (
                <div className="sch-accent-bar" style={{ background: primary.sp.color }} aria-hidden="true" />
              )}
              <div className="sch-month__cell-head">
                <span className="sch-month__num">{d.date.getDate()}</span>
                <div className="sch-month__cell-flags">
                  {/* Chỉ show flag của primary span (tránh tràn khi nhiều projects) */}
                  {accent && (() => {
                    const m = touching.find((t) => t.sp.project.id === accent.accent.project.id);
                    if (!m) return null;
                    if (m.isBoth) {
                      return (
                        <span key={m.sp.project.id} className="sch-month__flag sch-month__flag--both" title={`${m.sp.project.name}: start & end`} style={{ color: m.sp.color, borderColor: m.sp.color }}>
                          <span className="material-symbols-outlined sch-icon-14">flag</span>
                        </span>
                      );
                    }
                    if (m.isStart) {
                      return (
                        <span key={m.sp.project.id} className="sch-month__flag sch-month__flag--start" title={`${m.sp.project.name} • start`} style={{ color: m.sp.color, borderColor: m.sp.color }}>
                          <span className="material-symbols-outlined sch-icon-14">play_arrow</span>
                        </span>
                      );
                    }
                    if (m.isEnd) {
                      return (
                        <span key={m.sp.project.id} className="sch-month__flag sch-month__flag--end" title={`${m.sp.project.name} • end`} style={{ color: m.sp.color, borderColor: m.sp.color }}>
                          <span className="material-symbols-outlined sch-icon-14">stop</span>
                        </span>
                      );
                    }
                    return null;
                  })()}
                  {/* Multi-project badge */}
                  {multi && (
                    <button
                      type="button"
                      className="sch-multi-badge sch-multi-badge--mini"
                      title={`${accent!.projectCount} projects — click to view`}
                      onClick={(e) => { e.stopPropagation(); onCellClick?.(d.date); }}
                    >
                      <span className="material-symbols-outlined sch-icon-12">layers</span>
                      {accent!.projectCount}
                    </button>
                  )}
                </div>
                {d.events.length > 0 && (
                  <span className="sch-month__pill">{d.events.length}</span>
                )}
              </div>
              <div className="sch-month__events">
                {visible.map((ev) => (
                  <EventChip key={ev.id} ev={ev} compact onClick={() => onSelectEvent(ev)} />
                ))}
                {more > 0 && (
                  <button type="button" className="sch-month__more">+{more} more</button>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* ===========================================================
 * Gantt view
 * =========================================================== */
function GanttView({
  days, onSelectEvent, spans,
}: {
  days: DayPlan[];
  onSelectEvent: (e: CalEvent) => void;
  spans: ProjectSpan[];
}) {
  const allEvents = useMemo(() => days.flatMap((d) => d.events), [days]);
  // Mỗi span -> {startCol, endCol} (0-based trong `days`). Nếu ngoài range thì clip.
  const spanCols = useMemo(() => {
    return spans
      .map((sp) => {
        const ts = startOfDay(sp.start).getTime();
        const te = startOfDay(sp.end).getTime();
        const startIdx = days.findIndex((d) => startOfDay(d.date).getTime() === ts);
        const endIdx = days.findIndex((d) => startOfDay(d.date).getTime() === te);
        return { sp, startIdx, endIdx };
      })
      .filter((m) => m.startIdx >= 0 || m.endIdx >= 0);
  }, [days, spans]);
  if (allEvents.length === 0) {
    return (
      <div className="sch-state">
        <span className="material-symbols-outlined sch-state-icon">view_timeline</span>
        <p>No items scheduled in this range.</p>
      </div>
    );
  }
  return (
    <div className="sch-gantt">
     <div
      className="sch-gantt__canvas"
      style={{ ["--sch-gantt-cols" as string]: days.length }}
    >
      {/*
        * Ribbon overlay: 1 grid RIÊNG có cùng cấu trúc cột với
        * `.sch-gantt__head` (cột "Item" + vùng 7 cột ngày).
        *
        * Trước đây ribbon dùng `gridColumn` bên trong `.sch-gantt` — mà
        * `.sch-gantt` KHÔNG phải grid → `gridColumn` bị bỏ qua hoàn toàn →
        * mọi ribbon dồn về góc trái và CHỒNG LÊN NHAU.
        */}
      <div className="sch-gantt__ribbons">
        <div className="sch-gantt__ribbons-name" />
        <div className="sch-gantt__ribbons-track">
          {spanCols.map((m) => {
            // Clip start/end vào range hiển thị
            const a = Math.max(0, m.startIdx < 0 ? 0 : m.startIdx);
            const b = Math.min(days.length - 1, m.endIdx < 0 ? days.length - 1 : m.endIdx);
            if (b < a) return null;
            return (
          <div
            key={m.sp.project.id}
            className="sch-gantt__ribbon"
            style={{
              /*
               * 7 cột ngày → chỉ số bắt đầu từ 1.
               *
               * `gridRow: 1` ghim tất cả ribbon vào CÙNG 1 hàng để chúng
               * overlap nhau (dải project). Nếu không, auto-placement sẽ đẩy
               * ribbon thứ 2 xuống hàng 2 khi 2 project cùng cột.
               */
              gridColumn: `${a + 1} / span ${b - a + 1}`,
              gridRow: 1,
            }}
          >
            <div
              className="sch-gantt__ribbon-fill"
              style={{
                background: `linear-gradient(90deg, ${m.sp.color}66 0%, ${m.sp.color}22 50%, ${m.sp.color}66 100%)`,
                borderColor: m.sp.color,
              }}
            />
            <div
              className="sch-gantt__ribbon-label"
              style={{
                background: `${m.sp.color}1F`,
                borderColor: m.sp.color,
                color: m.sp.color,
              }}
            >
              <span className="material-symbols-outlined sch-icon-14">date_range</span>
              <span className="sch-gantt__ribbon-name">{m.sp.project.name}</span>
              <span className="sch-gantt__ribbon-dates">
                {m.sp.start.toLocaleDateString(undefined, { month: "short", day: "numeric" })}
                <span>→</span>
                {m.sp.end.toLocaleDateString(undefined, { month: "short", day: "numeric" })}
              </span>
            </div>
          </div>
            );
          })}
        </div>
      </div>
      <div className="sch-gantt__head">
        <div className="sch-gantt__col sch-gantt__col--name">Item</div>
        {/*
          7 cột ngày nằm trong 1 grid RIÊNG (7 cột, gap 4px) → khớp đúng
          `.sch-gantt__bar-wrap`. Trước đây head là grid 8 cột (7 gaps) còn
          bar-wrap là grid 7 cột (6 gaps) → cột ngày lệch nhau, bar rơi
          lệch sang cột bên cạnh và chồng lên nhau.
        */}
        <div className="sch-gantt__days">
          {days.map((d, i) => (
            <div key={d.key} className="sch-gantt__col">
              <div className="sch-gantt__dow">{WEEKDAY_LABELS[i]}</div>
              <div className="sch-gantt__num">{d.date.getDate()}</div>
            </div>
          ))}
        </div>
      </div>
      <div className="sch-gantt__rows">
        {allEvents.map((ev) => {
          const dayIdx = days.findIndex((d) => isSameDay(d.date, ev.start));
          const colStart = Math.max(0, dayIdx);
          const span = ev.isAllDay
            ? Math.max(1, Math.ceil((ev.end.getTime() - ev.start.getTime()) / 86_400_000))
            : 1;
          // Tìm span của project chứa event này (nếu có) để render start/end markers
          const evSpan = spans.find((sp) => sp.project.id === ev.projectId);
          const startCol = evSpan
            ? days.findIndex((d) => isSameDay(d.date, evSpan.start))
            : -1;
          const endCol = evSpan
            ? days.findIndex((d) => isSameDay(d.date, evSpan.end))
            : -1;
          return (
            <div key={ev.id} className="sch-gantt__row">
              <div className="sch-gantt__col sch-gantt__col--name">
                <span className={`sch-gantt__dot sch-tone--${dotFor(ev)}`} />
                <span className="sch-gantt__title">{ev.title}</span>
                <span className="sch-gantt__meta">
                  {ev.groupTaskId ? (ev.groupName ?? "Group work") : sourceLabel(ev.source)}
                </span>
              </div>
              <div className="sch-gantt__bar-wrap">
                <button
                  type="button"
                  className={`sch-gantt__bar sch-tone--${dotFor(ev)}`}
                  style={{
                    gridColumn: `${colStart + 1} / span ${Math.min(span, days.length - colStart)}`,
                  }}
                  onClick={() => onSelectEvent(ev)}
                  title={ev.title}
                >
                  <span className="material-symbols-outlined sch-icon-14">
                    {ev.source === "milestone" ? "flag" : ev.isAllDay ? "event" : "schedule"}
                  </span>
                  <span className="sch-gantt__bar-text">{ev.title}</span>
                </button>
                {/* Project start marker */}
                {startCol >= 0 && startCol < days.length && (
                  <div
                    className="sch-gantt__marker sch-gantt__marker--start"
                    style={{ gridColumn: `${startCol + 1} / span 1` }}
                    aria-label="Project start"
                    title="Project start"
                  >
                    <div className="sch-gantt__marker-line" />
                    <div className="sch-gantt__marker-tag">
                      <span className="material-symbols-outlined sch-icon-14">play_arrow</span>
                      Start
                    </div>
                  </div>
                )}
                {/* Project end marker */}
                {endCol >= 0 && endCol < days.length && (
                  <div
                    className="sch-gantt__marker sch-gantt__marker--end"
                    style={{ gridColumn: `${endCol + 1} / span 1` }}
                    aria-label="Project end"
                    title="Project end"
                  >
                    <div className="sch-gantt__marker-line" />
                    <div className="sch-gantt__marker-tag">
                      <span className="material-symbols-outlined sch-icon-14">stop</span>
                      End
                    </div>
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>
     </div>
    </div>
  );
}

/* ===========================================================
 * EventChip — used in Week & Month
 * =========================================================== */
function EventChip({
  ev, onClick, compact, taskType,
}: {
  ev: CalEvent;
  onClick: () => void;
  compact?: boolean;
  taskType?: string;
}) {
  const isDone = (() => {
    const s = (ev.status ?? "").toLowerCase();
    return s === "done" || s === "completed";
  })();

  /**
   * Slot của việc nhóm (mục 10 của cập nhật BE): `taskId = null`.
   * → Chỉ hiển thị, không có nút Start của nhánh cá nhân.
   */
  const isGroupSlot =
    ev.source === "slot" && !!ev.scheduleSlotId && !!ev.groupTaskId;

  const chip = (
    <button
      type="button"
      className={`sch-chip-event${compact ? " sch-chip-event--compact" : ""}${isDone ? " sch-chip-event--done" : ""}`}
      onClick={onClick}
      data-tone={dotFor(ev)}
      title={[ev.task?.title, ev.title].filter(Boolean).join(" · ")}
    >
      <span className="sch-chip-event__dot" data-tone={dotFor(ev)} />
      <div className="sch-chip-event__body">
        {/*
          Ô là 1 subtask cụ thể → hiện tên TASK ở dòng nhỏ phía trên, tên
          SUBTASK là dòng chính (đọc được cả 2 tầng như yêu cầu).
        */}
        {compact && ev.task?.title && ev.task.title !== ev.title && (
          <span className="sch-chip-event__parent">{ev.task.title}</span>
        )}
        <span className="sch-chip-event__title">{ev.title}</span>
        {!compact && (
          <span className="sch-chip-event__meta">
            {eventTimeRange(ev)}{" "}
            {isGroupSlot
              ? `· ${ev.groupName ?? "Group work"}`
              : taskType
                ? `· ${taskType}`
                : ""}{" "}
            · {isGroupSlot ? "Group work" : sourceLabel(ev.source)}
          </span>
        )}
      </div>
      {compact && (
        <span className="sch-chip-event__time">{fmtTime(ev.start)}</span>
      )}
    </button>
  );

  /*
   * ⚠️ KHÔNG hiện nút Start/Make up/Remove ở trên lịch — mọi hành động
   * focus nằm bên trong modal chi tiết (bấm vào chip để mở). Lịch phải
   * gọn, không rối mắt.
   */
  return chip;
}

/* ===========================================================
 * GoogleCalendarSyncButton — nût "Đồng bộ Google Calendar" ộ header.
 *
 * Thay thẻf card "Integrations" cũ (dài đểt). Giữ nguyên logic
 * connect / sync / disconnect + hộp thoại chọn hướng + khoảng ngày.
 * =========================================================== */
function GoogleCalendarSyncButton({
  toast,
  onSynced,
}: {
  toast: ReturnType<typeof useCenterToast>[1];
  onSynced?: () => void;
}) {
  const {
    isConnected,
    busy,
    error,
    connect,
    disconnect,
    sync,
    reconnectRequired,
  } = useGoogleCalendar();

  /** Mở hộp thoại chọn hướng + khoảng ngày. */
  const [syncOpen, setSyncOpen] = useState(false);
  /** Lỗi 400 từ server khi sync (VD: `to` trước `from`). */
  const [syncError, setSyncError] = useState<string | null>(null);
  /** Kết quả sync vừa rồi → hiển chi tiết. */
  const [syncResult, setSyncResult] = useState<GoogleCalendarSyncResultDto | null>(
    null,
  );
  /** Menu nhỏ: Disconnect + trạng thái kết nối. */
  const [menuOpen, setMenuOpen] = useState(false);

  function openSyncDialog() {
    setSyncError(null);
    setSyncResult(null);
    setSyncOpen(true);
    setMenuOpen(false);
  }

  /**
   * Bấm nút chính:
   * - Chưa kết nối → bảt đầu OAuth (redirect sang Google).
   * - Đã kết nối → mở hộp thoại chọn hướng + khoảng ngày.
   */
  function handleMainClick() {
    if (!isConnected) {
      void connect();
      return;
    }
    openSyncDialog();
  }

  async function handleSync(options: {
    from: string | null;
    to: string | null;
    direction: GoogleCalendarSyncDirection;
  }) {
    const res = await sync({
      from: options.from,
      to: options.to,
      direction: options.direction,
    });
    if (!res.ok) {
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
      setSyncError(res.error);
      return;
    }
    setSyncError(null);
    setSyncResult(res.data);

    const { added, updated, cancelled } = res.data;
    const pushFailed = res.data.pushFailed ?? 0;
    const pushed = res.data.pushedCreated ?? 0;

    const parts = [
      `${added} added`,
      `${updated} updated`,
      `${cancelled} cancelled`,
    ];
    if (pushed > 0 || pushFailed > 0) {
      parts.push(`${pushed} pushed`);
    }
    if (res.data.mode === "Range") {
      parts.push("by date range");
    }

    if (pushFailed > 0) {
      toast.error(
        "Some slots couldn't be synced",
        `Try again later. · ${parts.join(" · ")}`,
      );
    } else {
      toast.success("Google Calendar synced", parts.join(" · "));
    }

    onSynced?.();
  }

  async function handleDisconnect() {
    setMenuOpen(false);
    const res = await disconnect();
    if (res.ok) {
      toast.success("Disconnected", "Google Calendar has been unlinked.");
      onSynced?.();
    } else {
      toast.error("Could not disconnect", res.error);
    }
  }

  const connecting = busy === "connect";

  return (
    <div className="sch-gcal-btn">
      <button
        type="button"
        className="sch-btn sch-btn--primary"
        onClick={handleMainClick}
        disabled={busy !== null}
        title={
          isConnected
            ? "Sync your schedule with Google Calendar (choose direction and date range)"
            : "Connect Google Calendar to sync your schedule with it"
        }
      >
        <span className="material-symbols-outlined sch-icon-18">
          {connecting ? "progress_activity" : "sync"}
        </span>
        {connecting
          ? "Redirecting…"
          : busy === "sync"
            ? "Syncing…"
            : "Sync Google Calendar"}
      </button>

      {/* Menu phụ: trạng thái kết nối + ngát kết nối */}
      {isConnected && (
        <>
          <button
            type="button"
            className="sch-btn sch-btn--soft sch-gcal-btn__more"
            onClick={() => setMenuOpen((v) => !v)}
            disabled={busy !== null}
            aria-label="Google Calendar options"
            aria-expanded={menuOpen}
            title="Google Calendar options"
          >
            <span className="material-symbols-outlined sch-icon-18">
              more_vert
            </span>
          </button>

          {menuOpen && (
            <>
              {/* Lầp nền để bấm menu đóng khi bấm ra ngoài */}
              <div
                className="sch-gcal-btn__scrim"
                onClick={() => setMenuOpen(false)}
                aria-hidden="true"
              />
              <div className="sch-gcal-btn__menu" role="menu">
                <div className="sch-gcal-btn__status">
                  <span className="material-symbols-outlined sch-icon-14">
                    check_circle
                  </span>
                  <span>Google Calendar connected</span>
                </div>
                <button
                  type="button"
                  className="sch-gcal-btn__item"
                  role="menuitem"
                  onClick={() => void handleDisconnect()}
                  disabled={busy !== null}
                >
                  <span className="material-symbols-outlined sch-icon-14">
                    link_off
                  </span>
                  <span>
                    {busy === "disconnect" ? "Disconnecting…" : "Disconnect"}
                  </span>
                </button>
              </div>
            </>
          )}
        </>
      )}

      {error && !isConnected && (
        <span className="sch-gcal-btn__error" title={error}>
          <span className="material-symbols-outlined sch-icon-14">error</span>
        </span>
      )}

      {syncOpen && (
        <GoogleCalendarSyncDialog
          busy={busy === "sync"}
          serverError={syncError}
          needsReconnect={reconnectRequired}
          result={syncResult}
          onReconnect={() => {
            setSyncOpen(false);
            void connect();
          }}
          onSubmit={(opts) => void handleSync(opts)}
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

/* ===========================================================
 * Cell popover — liệt kê TẤT CẢ task/subtask/slot đang có trong 1 ngày.
 *
 * Dùng `items` (đã gom từ `events` — nguồn sự thật gồm cả calendar, task
 * deadline, subtask và schedule slot) nên không bỏ sót task nào.
 * =========================================================== */
function CellPopover({
  day, items, onClose, onSelectEvent,
}: {
  day: Date;
  items: DayItem[];
  onClose: () => void;
  onSelectEvent: (e: CalEvent) => void;
}) {
  const totalMinutes = items.reduce((s, i) => s + i.minutes, 0);
  const taskCount = items.filter((i) => i.task).length;
  const subtaskCount = items.filter((i) => !i.task && i.subtask).length;

  // Sắp xếp: đang chạy trước, chưa xong sau, xong rồi cuối cùng.
  // Cùng nhóm thì theo giờ bắt đầu.
  const sorted = [...items].sort((a, b) => {
    const ra = statusRank(a.status);
    const rb = statusRank(b.status);
    if (ra !== rb) return ra - rb;
    return a.start.getTime() - b.start.getTime();
  });

  return (
    <div className="sch-cell-popover" role="dialog" aria-modal="false" aria-label={`Details for ${day.toDateString()}`}>
      <div className="sch-cell-popover__head">
        <div>
          <div className="sch-cell-popover__date">
            {day.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" })}
          </div>
          <div className="sch-cell-popover__meta">
            {items.length} item{items.length !== 1 ? "s" : ""}
            {taskCount > 0 && <>{" • "}{taskCount} task{taskCount !== 1 ? "s" : ""}</>}
            {subtaskCount > 0 && <>{" • "}{subtaskCount} subtask{subtaskCount !== 1 ? "s" : ""}</>}
            {totalMinutes > 0 && <>{" • "}{formatMinutesShort(totalMinutes * 60000)}</>}
          </div>
        </div>
        <button type="button" className="sch-icon-btn" onClick={onClose} aria-label="Close">
          <span className="material-symbols-outlined">close</span>
        </button>
      </div>

      <div className="sch-cell-popover__body">
        {items.length === 0 ? (
          <div className="sch-cell-popover__empty">
            Không có task nào trong ngày này.
          </div>
        ) : (
          <ul className="sch-cell-popover__list">
            {sorted.map((it) => {
              /*
               * Slot việc nhóm (mục 10 của cập nhật BE): không có task cá
               * nhân → dùng tiêu đề việc nhóm + tên nhóm.
               */
              const isGroupItem = !it.task && !it.subtask && !!it.event.groupTaskId;
              const title =
                it.task?.title ??
                it.subtask?.title ??
                (isGroupItem ? it.event.title : "Untitled");
              const desc = it.task?.description ?? it.subtask?.description ?? null;
              const est = it.task?.estimatedMinutes ?? it.subtask?.estimatedMinutes ?? 0;
              const isSubtask = !it.task && !!it.subtask;
              const done = /done|completed/i.test(it.status);
              return (
                <li
                  key={`${it.task?.id ?? it.subtask?.id ?? it.event.groupTaskId ?? it.start.getTime()}`}
                  className="sch-cell-popover__task"
                  role="button"
                  tabIndex={0}
                  onClick={() => onSelectEvent(it.event)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      onSelectEvent(it.event);
                    }
                  }}
                >
                  <div className="sch-cell-popover__task-row">
                    <span className="material-symbols-outlined sch-icon-14">
                      {done ? "check_circle" : isGroupItem ? "groups" : isSubtask ? "subdirectory_arrow_right" : "task_alt"}
                    </span>
                    <span
                      className="sch-cell-popover__task-title"
                      style={done ? { color: "var(--sch-text-3)", textDecoration: "line-through" } : undefined}
                    >
                      {title}
                    </span>
                    {isGroupItem && it.event.groupName && (
                      <span className="sch-cell-popover__tag sch-cell-popover__tag--status">
                        {it.event.groupName}
                      </span>
                    )}
                    {est > 0 && (
                      <span className="sch-cell-popover__task-est">{est}m</span>
                    )}
                  </div>

                  {/* Giờ bắt đầu + trạng thái */}
                  <div className="sch-cell-popover__task-tags">
                    {!it.isAllDay && (
                      <span className="sch-cell-popover__tag">
                        <span className="material-symbols-outlined sch-icon-12">schedule</span>
                        {it.start.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}
                      </span>
                    )}
                    {it.minutes > 0 && (
                      <span className="sch-cell-popover__tag">
                        {formatMinutesShort(it.minutes * 60000)}
                      </span>
                    )}
                    {it.status && (
                      <span className="sch-cell-popover__tag sch-cell-popover__tag--status">
                        {it.status}
                      </span>
                    )}
                  </div>

                  {desc && <p className="sch-cell-popover__task-desc">{desc}</p>}

                  {/* Các khung giờ (schedule slot) của item này trong ngày */}
                  {it.slots.length > 0 && (
                    <ul className="sch-cell-popover__list sch-cell-popover__list--nested">
                      {it.slots.map((sl) => (
                        <li key={sl.id} className="sch-cell-popover__subtask">
                          <span className="material-symbols-outlined sch-icon-12">event</span>
                          <span className="sch-cell-popover__task-title">
                            {new Date(sl.startTime).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}
                            {" – "}
                            {new Date(sl.endTime).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}
                          </span>
                          {sl.explanation && (
                            <em className="sch-cell-popover__task-parent">{sl.explanation}</em>
                          )}
                          {/* Nút Start / Stop cho slot này */}
                          <div className="sch-cell-popover__focus">
                            <SlotFocusActions
                              slotId={sl.id}
                              taskId={sl.taskId}
                              subTaskId={sl.subTaskId}
                              status={sl.status}
                              plannedMinutes={sl.proposedMinutes}
                              taskTitle={
                                it.task?.title ?? it.subtask?.title ?? null
                              }
                              compact
                            />
                            {/*
                              ⚠️ KHÔNG hiện nút xóa ở popover — chỉ xóa được
                              từ modal detail (nút "Remove Slot").
                            */}
                          </div>
                        </li>
                      ))}
                    </ul>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <div className="sch-cell-popover__foot">
        <span className="sch-cell-popover__hint">
          {items.length > 0
            ? "Click a task to see details"
            : "Nothing scheduled"}
        </span>
      </div>
    </div>
  );
}

/* ===========================================================
 * Event detail modal
 * =========================================================== */

/** Rút gọn ms → "1h 30m" / "45m" */
function formatMinutesShort(ms: number): string {
  const total = Math.max(0, Math.round(ms / 60000));
  if (total < 60) return `${total}m`;
  const h = Math.floor(total / 60);
  const m = total % 60;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

/** Sub-component: badge trạng thái thời gian thực của 1 subtask */
function NowBadge({ start, end }: { start: Date; end: Date }) {
  const [now, setNow] = useState<Date>(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(id);
  }, []);
  if (now < start) {
    const diff = Math.round((start.getTime() - now.getTime()) / 60000);
    if (diff > 60 * 24) return null;
    return (
      <span className="sch-aggregate__now sch-aggregate__now--soon">
        <span className="sch-aggregate__now-dot" />
        in {diff < 60 ? `${diff}m` : `${Math.round(diff / 60)}h`}
      </span>
    );
  }
  if (now >= start && now <= end) {
    const remain = Math.round((end.getTime() - now.getTime()) / 60000);
    return (
      <span className="sch-aggregate__now sch-aggregate__now--live">
        <span className="sch-aggregate__now-dot sch-aggregate__now-dot--pulse" />
        Live · {remain}m left
      </span>
    );
  }
  return (
    <span className="sch-aggregate__now sch-aggregate__now--done">
      <span className="material-symbols-outlined sch-icon-12">check_circle</span>
      Done
    </span>
  );
}

function EventDetailModal({
  event, subtasks, focusSlotId, blockedReasonFor, onClose, onDelete, onSlotChanged,
}: {
  event: CalEvent;
  subtasks: SubtaskDto[];
  /**
   * Slot cụ thể người dùng vừa bấm trên lịch (null = không xác định).
   *
   * ⚠️ 1 task có nhiều khối giờ rời rạc → nút Start/Make up phải áp dụng
   * cho ĐÚNG khối đã bấm, không phải slot đầu tiên.
   */
  focusSlotId?: string | null;
  onClose: () => void;
  /**
   * Mở pop-up xác nhận xóa slot.
   *
   * ⚠️ KHÔNG xóa trực tiếp ở đây — component cha sẽ mở dialog xác nhận
   * (tiếng Anh) rồi mới gọi API.
   */
  onDelete?: (slotId: string, title: string, isGroup?: boolean) => void;
  /** Refetch lịch sau khi slot đổi trạng thái (Start/Stop). */
  onSlotChanged?: () => void;
  /**
   * Lý do bị chặn theo luật "làm trước - làm sau" (tiếng Anh) — hoặc `null`
   * nếu được phép Start.
   *
   * Luật này trước đây áp dụng ngay trên card lịch; nay các nút nằm trong
   * modal → vẫn truyền xuống để nút Start bị disable + tooltip giải thích.
   */
  blockedReasonFor?: (ev: CalEvent, day?: Date) => string | null;
}) {
  const task = event.task;
  const subtask = event.subtask;
  const slot = event.scheduleSlot;
  const isSlotEvent = event.source === "slot";
  /**
   * Slot của **việc nhóm** (mục 10 của cập nhật BE).
   *
   * `taskId = null` → không có task cá nhân, không có dự án / khách hàng /
   * loại công việc. Modal phải hiển thị theo nhóm + tiêu đề việc nhóm và
   * KHÔNG điều hướng sang trang task cá nhân.
   */
  const isGroupSlot = !!event.groupTaskId;
  /** Task đã gộp nhiều event con (slot/subtask) → hiển thị dạng task view. */
  const isAggregate = !!event.aggregatedEvents && event.aggregatedEvents.length > 1;
  /**
   * Task view: click vào 1 task → modal liệt kê các subtask.
   * Nguồn 1: các event con đã gộp (đúng thứ trên lịch đang hiện).
   * Nguồn 2 (fallback): subtask của task theo orderIndex, dùng scheduledStart/End.
   */
  const taskSubtasks = useMemo<SubtaskDto[]>(
    () =>
      event.taskId
        ? subtasks
            .filter((x) => x.taskId === event.taskId)
            .sort((a, b) => a.orderIndex - b.orderIndex)
        : [],
    [event.taskId, subtasks],
  );
  const showSubtaskColumn =
    event.taskId != null
      ? isAggregate || taskSubtasks.length > 0
      : /* Slot việc nhóm: không có task cá nhân → dùng danh sách slot của nhóm. */
        isAggregate && (event.aggregatedEvents?.length ?? 0) > 0;

  /**
   * Id của slot cần xóa.
   *
   * ⚠️ Ở `/schedule` dữ liệu đến từ `GET /api/calendar` (`calendarItems`) —
   * path này KHÔNG set `event.scheduleSlot` (chỉ có `scheduleSlotId`).
   * Nếu chỉ dựa vào `event.scheduleSlot` thì nút xóa không bao giờ hiện.
   */
  const slotId = slot?.id ?? event.scheduleSlotId ?? null;

  /** Danh sách "khối" hiển thị: chuẩn hoá cả slot lẫn subtask về shape giống nhau. */
  const detailBlocks = useMemo<
    Array<{
      key: string;
      title: string;
      status: string;
      start: Date;
      end: Date;
      slot?: ScheduleSlotDto;
      /**
       * Id của slot (dùng để xóa).
       *
       * ⚠️ Ở `/schedule`, dữ liệu đến từ `GET /api/calendar` → event không
       * có `scheduleSlot` (chỉ có `scheduleSlotId`). Nếu chỉ dựa vào
       * `slot` thì nút xóa không bao giờ hiện ở trang lịch tổng.
       */
      slotId?: string | null;
      subtaskId?: string;
      /** Task sở hữu slot (dùng cho Focus Session: `POST /api/focus/start`). */
      taskId?: string | null;
      /** Status của SLOT gốc — quy tắc Start/Stop dựa trên status này. */
      slotStatus?: string | null;
      /** Phút dự kiến của slot. */
      slotPlannedMinutes?: number | null;
      /** Event gốc của khối (dùng để tra luật "làm trước - làm sau"). */
      ev?: CalEvent;
    }>
  >(() => {
    // Ưu tiên event gốc đã gộp — khớp chính xác với những gì lịch đang hiển thị
    if (isAggregate && event.aggregatedEvents) {
      return event.aggregatedEvents
        .slice()
        .sort((a, b) => a.start.getTime() - b.start.getTime())
        .map((e) => {
          const st = e.subTaskId ? subtasks.find((x) => x.id === e.subTaskId) : undefined;
          return {
            key: e.id,
            title: st?.title ?? (e.subTaskId ? "Subtask" : e.title || "Whole task"),
            status: st?.status ?? e.status ?? "",
            start: e.start,
            end: e.end,
            slot: e.scheduleSlot,
            slotId: e.scheduleSlot?.id ?? e.scheduleSlotId ?? null,
            subtaskId: e.subTaskId ?? undefined,
            taskId: e.taskId ?? null,
            slotStatus: e.slotStatus ?? e.status ?? null,
            slotPlannedMinutes: e.slotPlannedMinutes ?? null,
            ev: e,
          };
        });
    }
    // Data từ BE: suy ra block từ scheduledStart/scheduledEnd của từng subtask
    return taskSubtasks.map((st) => ({
      key: st.id,
      title: st.title,
      status: st.status ?? "",
      start: new Date(st.scheduledStart ?? event.start),
      end: new Date(st.scheduledEnd ?? event.end),
      subtaskId: st.id,
    }));
  }, [isAggregate, event.aggregatedEvents, event.start, event.end, subtasks, taskSubtasks]);

  /**
   * Khối (block) trong danh sách subtask tương ứng với slot đang focus.
   *
   * Dùng để đặt nút Start/Make up NGAY TRONG khối đó (đúng khối giờ người
   * dùng bấm trên lịch), thay vì 1 khối dùng chung ở cột trái.
   */
  const focusBlock = useMemo(() => {
    if (focusSlotId) {
      return detailBlocks.find((b) => b.slotId === focusSlotId) ?? null;
    }
    return detailBlocks.find((b) => b.slotId && b.slotId === slotId) ?? null;
  }, [detailBlocks, focusSlotId, slotId]);

  /**
   * Thông tin slot đang focus — gom từ event gốc (không phụ thuộc DTO slot
   * đầy đủ).
   *
   * ⚠️ Ở `/schedule`, dữ liệu đến từ `GET /api/calendar` → event KHÔNG có
   * `scheduleSlot` (chỉ có `scheduleSlotId`). Nếu chỉ dựa vào DTO slot thì
   * status / subTaskId / phút dự kiến đều mất → nút Start sai trạng thái.
   *
   * → Gom từ `aggregatedEvents` (đã có `slotStatus`, `slotPlannedMinutes`,
   *   `subTaskId`) — đúng dữ liệu đang hiển thị trên lịch.
   */
  const focusInfo = useMemo(() => {
    /** Event gốc tương ứng với slot đang focus. */
    const child =
      focusSlotId
        ? event.aggregatedEvents?.find((e) => e.scheduleSlotId === focusSlotId)
        : undefined;

    /** DTO slot gốc (có thể null trên path calendar). */
    const dto = child?.scheduleSlot ?? (slot?.id === focusSlotId ? slot : undefined);

    return {
      slotId: focusSlotId ?? slotId,
      taskId: child?.taskId ?? event.taskId ?? null,
      subTaskId:
        dto?.subTaskId ?? child?.subTaskId ?? event.subTaskId ?? null,
      status: dto?.status ?? child?.slotStatus ?? event.status,
      plannedMinutes:
        dto?.proposedMinutes ??
        child?.slotPlannedMinutes ??
        event.slotPlannedMinutes ??
        undefined,
    };
  }, [focusSlotId, slotId, slot, event, focusBlock]);

  /** Task sở hữu slot đang focus (fallback về task của event). */
  const focusTaskId = focusInfo.taskId;
  /** `subTaskId` của SLOT đang focus (không phải của event — spec mục 6.1). */
  const focusSubTaskId = focusInfo.subTaskId;

  return (
    <div className="sch-modal" role="presentation" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`sch-modal__panel ${showSubtaskColumn ? "sch-modal__panel--two-col" : ""}`} role="dialog" aria-modal="true">
        <div className="sch-modal__head">
          <div>
            <span className="sch-card__eyebrow">{showSubtaskColumn ? "Task" : sourceLabel(event.source)}</span>
            <h2 className="sch-card__title">{event.title}</h2>
          </div>
          <button type="button" className="sch-icon-btn" aria-label="Close" onClick={onClose}>
            <span className="material-symbols-outlined">close</span>
          </button>
        </div>

        <div className="sch-modal__body">
          {/* Cột trái: Task detail */}
          <div className="sch-modal__col sch-modal__col--info">
            <div className="sch-side-meta">
              <div className="sch-side-meta__row">
                <span>Start</span>
                <strong>{event.start.toLocaleString()}</strong>
              </div>
              <div className="sch-side-meta__row">
                <span>End</span>
                <strong>{event.end.toLocaleString()}</strong>
              </div>
              <div className="sch-side-meta__row">
                <span>Duration</span>
                <strong>{durationHours(event).toFixed(1)}h {event.isAllDay ? "· all day" : ""}</strong>
              </div>
              <div className="sch-side-meta__row">
                <span>Status</span>
                <strong>{event.status || "—"}</strong>
              </div>

              {/*
                Slot việc nhóm (mục 10 của cập nhật BE): các trường dự án /
                khách hàng / loại công việc đều `null` → hiện thông tin nhóm
                thay thế.
              */}
              {isGroupSlot && (
                <>
                  <div className="sch-side-meta__row">
                    <span>Group</span>
                    <strong>{event.groupName ?? "—"}</strong>
                  </div>
                  <div className="sch-side-meta__row">
                    <span>Work type</span>
                    <strong>Group task</strong>
                  </div>
                  {event.userId && (
                    <div className="sch-side-meta__row">
                      <span>Assignee</span>
                      <strong>
                        <code>{event.userId.slice(0, 8)}...</code>
                      </strong>
                    </div>
                  )}
                </>
              )}

              {slot && (
                <>
                  {slot.isManualOverride && (
                    <div className="sch-side-meta__row">
                      <span>Override</span>
                      <strong>Manual</strong>
                    </div>
                  )}
                  {slot.kbiasUsed > 0 && (
                    <div className="sch-side-meta__row">
                      <span>KBias Used</span>
                      <strong>{slot.kbiasUsed}%</strong>
                    </div>
                  )}
                  {slot.explanation && (
                    <div className="sch-side-meta__row">
                      <span>Explanation</span>
                      <strong>{slot.explanation}</strong>
                    </div>
                  )}
                  {slot.googleEventId && (
                    <div className="sch-side-meta__row">
                      <span>Google Event</span>
                      <strong>{slot.syncFailed ? "⚠️ Sync failed" : "✓ Synced"}</strong>
                    </div>
                  )}
                </>
              )}
              {task && (
                <>
                  <div className="sch-side-meta__row">
                    <span>Type</span>
                    <strong>{task.taskType || "—"}</strong>
                  </div>
                  {task.deadline && (
                    <div className="sch-side-meta__row">
                      <span>Deadline</span>
                      <strong>{new Date(task.deadline).toLocaleDateString()}</strong>
                    </div>
                  )}
                  {task.estimatedMinutes > 0 && (
                    <div className="sch-side-meta__row">
                      <span>Estimated</span>
                      <strong>
                        {task.estimatedMinutes >= 60
                          ? `${(task.estimatedMinutes / 60).toFixed(1)}h`
                          : `${task.estimatedMinutes}m`}
                      </strong>
                    </div>
                  )}
                </>
              )}
              {subtask && (
                <div className="sch-side-meta__row">
                  <span>Subtask</span>
                  <strong>{subtask.title}</strong>
                </div>
              )}
              {event.taskId && (
                <div className="sch-side-meta__row">
                  <span>Task ID</span>
                  <code>{event.taskId.slice(0, 8)}...</code>
                </div>
              )}
              {event.subTaskId && (
                <div className="sch-side-meta__row">
                  <span>SubTask ID</span>
                  <code>{event.subTaskId.slice(0, 8)}...</code>
                </div>
              )}
              {event.groupTaskId && (
                <div className="sch-side-meta__row">
                  <span>Group Task ID</span>
                  <code>{event.groupTaskId.slice(0, 8)}...</code>
                </div>
              )}
            </div>

            {/*
              Khối Focus Session của NHÁNH CÁ NHÂN.

              ⚠️ Slot việc nhóm có `taskId = null` → `SlotFocusPanel` tự ẩn
              (guard `if (!slotId || !taskId) return null`). Việc nhóm bấm giờ
              ở trang chi tiết nhóm / `/my-group-tasks` với endpoint riêng
              `POST /api/group-tasks/{id}/focus/start`.
            */}
            {!isGroupSlot && (
              <SlotFocusPanel
                /*
                 * Ưu tiên slot vừa bấm (`focusSlot`) → nút Start/Make up áp
                 * dụng đúng khối giờ người dùng chọn trên lịch.
                 */
                slotId={focusInfo.slotId}
                taskId={focusTaskId}
                /*
                 * ⚠️ `subTaskId` của SLOT, không của event — spec mục 6.1:
                 * backend không tự lấy `subTaskId` từ slot khi Start.
                 * Với event aggregate (gộp nhiều slot của 1 task) thì
                 * `event.subTaskId` là null → phải tra slot gốc.
                 */
                subTaskId={focusSubTaskId}
                status={focusInfo.status}
                plannedMinutes={focusInfo.plannedMinutes}
                taskTitle={event.task?.title ?? event.subtask?.title ?? null}
                /*
                 * Nếu khối giờ đã hiện nút Start/Make up riêng bên cột phải
                 * → ẩn bộ nút ở đây để không trùng.
                 */
                showActions={!focusBlock}
                blockedReason={
                  blockedReasonFor
                    ? blockedReasonFor(focusBlock?.ev ?? event)
                    : null
                }
                onChanged={onSlotChanged}
              />
            )}
          </div>

          {/* Cột phải: Subtasks list (task aggregate HOẶC task có subtask) */}
          {showSubtaskColumn && (
            <div className="sch-modal__col sch-modal__col--sub">
              <div className="sch-aggregate">
                <div className="sch-aggregate__head">
                  <span className="material-symbols-outlined sch-icon-18">account_tree</span>
                  <strong>Subtasks ({detailBlocks.length})</strong>
                  <span className="sch-aggregate__head-total">
                    {durationHours(event).toFixed(1)}h total
                  </span>
                </div>
                <ul className="sch-aggregate__list">
                  {detailBlocks.map((b, i) => {
                    const sStart = b.start;
                    const sEnd = b.end;
                    const durMs = Math.max(0, sEnd.getTime() - sStart.getTime());
                    const totalMs = Math.max(1, event.end.getTime() - event.start.getTime());
                    const pct = Math.min(100, Math.round((durMs / totalMs) * 100));
                    const offsetPct = Math.min(100, Math.max(0, Math.round(((sStart.getTime() - event.start.getTime()) / totalMs) * 100)));
                    return (
                      <li key={b.key} className="sch-aggregate__item">
                        <div className="sch-aggregate__rail">
                          <span className="sch-aggregate__dot">{i + 1}</span>
                        </div>
                        <div className="sch-aggregate__body">
                          <div className="sch-aggregate__item-row">
                            <strong>{b.title}</strong>
                            {b.status && (
                              <span className="sch-aggregate__badge">{b.status}</span>
                            )}
                            <span className="sch-aggregate__dur">
                              {(durMs / 3600000).toFixed(1)}h
                            </span>
                          </div>
                          {/* Time chip nổi bật: giờ bắt đầu lớn + duration + trạng thái */}
                          <div className="sch-aggregate__time">
                            <div className="sch-aggregate__time-start">
                              <span className="sch-aggregate__time-label">Starts</span>
                              <div className="sch-aggregate__time-value">
                                {sStart.toLocaleTimeString(undefined, {
                                  hour: "2-digit",
                                  minute: "2-digit",
                                })}
                              </div>
                              <span className="sch-aggregate__time-date">
                                {sStart.toLocaleDateString(undefined, {
                                  weekday: "short",
                                  month: "short",
                                  day: "numeric",
                                })}
                              </span>
                            </div>
                            <div className="sch-aggregate__time-arrow">
                              <span className="material-symbols-outlined sch-icon-16">arrow_forward</span>
                              <span className="sch-aggregate__time-dur">{formatMinutesShort(durMs)}</span>
                            </div>
                            <div className="sch-aggregate__time-end">
                              <span className="sch-aggregate__time-label">Ends</span>
                              <div className="sch-aggregate__time-value sch-aggregate__time-value--muted">
                                {sEnd.toLocaleTimeString(undefined, {
                                  hour: "2-digit",
                                  minute: "2-digit",
                                })}
                              </div>
                              <span className="sch-aggregate__time-date">
                                {sEnd.toLocaleDateString(undefined, {
                                  weekday: "short",
                                  month: "short",
                                  day: "numeric",
                                })}
                              </span>
                            </div>
                          </div>
                          {/* Trạng thái thời gian thực: đặt dưới chip, không overlap nhãn */}
                          <div className="sch-aggregate__now-row">
                            <NowBadge start={sStart} end={sEnd} />
                            <span className="sch-aggregate__now-span">
                              {formatMinutesShort(Math.max(0, sStart.getTime() - event.start.getTime()))} before start
                            </span>
                          </div>
                          {/* Bar thời lượng so với tổng thời gian task */}
                          <div className="sch-aggregate__bar-track">
                            <div
                              className="sch-aggregate__bar"
                              style={{ marginLeft: `${offsetPct}%`, width: `${pct}%` }}
                            />
                          </div>
                          {/*
                            Nút Start / Make up / Stop của riêng khối này.

                            ⚠️ Trước đây các nút này nằm NGAY BÊN CẠNH card
                            trên lịch → làm card bị kéo giãn / trượt dài xuống
                            và trông như bị duplicate. Nay chuyển vào trong
                            modal chi tiết: bấm card → mở modal → bấm Start
                            tại đúng khối giờ đó.
                          */}
                          {!isGroupSlot &&
                            focusBlock?.key === b.key &&
                            b.slotId &&
                            b.taskId && (
                              <div className="sch-aggregate__focus">
                                <SlotFocusActions
                                  slotId={b.slotId}
                                  taskId={b.taskId}
                                  subTaskId={b.slot?.subTaskId ?? b.subtaskId ?? null}
                                  status={b.slotStatus ?? b.status}
                                  plannedMinutes={b.slotPlannedMinutes ?? undefined}
                                  taskTitle={b.title}
                                  /* Luật "làm trước - làm sau" — xem TaskCard. */
                                  blockedReason={
                                    b.ev && blockedReasonFor
                                      ? blockedReasonFor(b.ev)
                                      : null
                                  }
                                  onChanged={onSlotChanged}
                                />
                              </div>
                            )}
                          {/*
                            Nút xóa slot của khối này.
                            ⚠️ Chỉ mở pop-up xác nhận — KHÔNG xóa ngay.
                            Modal cha vẫn mở để user đổi ý.
                          */}
                          {(b.slot || b.slotId) && onDelete && (
                            <button
                              type="button"
                              className="sch-aggregate__del"
                              title="Delete this slot"
                              aria-label={`Delete slot: ${b.title}`}
                              onClick={() =>
                                onDelete(b.slotId ?? b.slot!.id, b.title, isGroupSlot)
                              }
                            >
                              <span className="material-symbols-outlined sch-icon-16">delete</span>
                            </button>
                          )}
                        </div>
                      </li>
                    );
                  })}
                </ul>
              </div>
            </div>
          )}
        </div>

        <div className="sch-modal__actions">
          <button type="button" className="sch-btn sch-btn--soft" onClick={onClose}>Close</button>
          {/*
            Nút "Remove Slot".
            ⚠️ Chỉ hiện khi có `slotId` — ở `/schedule` dữ liệu đến từ
            `GET /api/calendar` nên `event.scheduleSlot` có thể null nhưng
            `event.scheduleSlotId` vẫn có.
            ⚠️ Chỉ mở pop-up xác nhận — KHÔNG xóa ngay.
          */}
          {isSlotEvent && !isAggregate && slotId && onDelete && (
            <button
              type="button"
              className="sch-btn sch-btn--soft sch-btn--danger-ghost"
              onClick={() => onDelete(slotId, event.title, isGroupSlot)}
            >
              <span className="material-symbols-outlined sch-icon-18">delete</span>
              Remove Slot
            </button>
          )}
          {/*
            Slot việc nhóm: KHÔNG điều hướng sang trang Planning của dự án
            cá nhân (slot nhóm không có dự án). Thay vào đó mở trang nhóm.
          */}
          {event.taskId ? (
            <Link
              to={`/projects/${event.projectId ?? ""}/planning`}
              className="sch-btn sch-btn--primary"
              onClick={onClose}
            >
              <span className="material-symbols-outlined sch-icon-18">open_in_new</span>
              Open in Planning
            </Link>
          ) : isGroupSlot && event.groupId ? (
            <Link
              to={`/groups/${event.groupId}`}
              className="sch-btn sch-btn--primary"
              onClick={onClose}
            >
              <span className="material-symbols-outlined sch-icon-18">groups</span>
              Open group
            </Link>
          ) : null}
        </div>      </div>
    </div>
  );
}
