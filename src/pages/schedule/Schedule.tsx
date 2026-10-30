import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Ref } from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router-dom";
import {
  ProposalDialog,
} from "../../components/ScheduleProposal";
import { useScheduleProposal } from "../../components/schedule-proposal-logic";
import { CenterToasts, useCenterToast } from "../../components/Toast";
import { SlotFocusPanel } from "../../components/focus/SlotFocusPanel";
import { SlotFocusActions } from "../../components/focus/SlotFocusActions";
import { useFocusActions } from "../../components/focus/focus-context";
import { useStaggeredMount } from "../../hooks/useStaggeredMount";
import { useGoogleCalendar } from "../../hooks/useGoogleCalendar";
import {
  createScheduleSlot,
  deleteScheduleSlot,
  getProject,
  listCalendar,
  listProjects,
  listScheduleSlotsByTask,
  listSubtasks,
  listTasks,
  type CalendarItemDto,
  type ProjectDto,
  type ScheduleSlotDto,
  type SubtaskDto,
  type TaskDto,
} from "../../lib/api-client";
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
    const key = ev.taskId ?? ev.id;
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
  const [projectLoading, setProjectLoading] = useState(true);

  /* view state */
  const [viewMode, setViewMode] = useState<ViewMode>("week");
  const [anchor, setAnchor] = useState<Date>(() => new Date());
  const [filter, setFilter] = useState<FilterId>("all");
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
  /** Work hours + timezone từ calendar response (AI xếp lịch dựa trên vùng này) */
  const [workHours, setWorkHours] = useState<{
    timeZone?: string;
    workDayStart?: string | null;
    workDayEnd?: string | null;
    worksOnWeekend?: boolean;
    googleCalendarStatus?: string;
  }>({});

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
          "Đã tạo lịch thành công!",
          `"${taskData.taskTitle}" được gán vào ${start.toLocaleTimeString("vi-VN", { hour: "2-digit", minute: "2-digit" })} — ${end.toLocaleTimeString("vi-VN", { hour: "2-digit", minute: "2-digit" })}.`
        );
      } else {
        toast.error("Không tạo được lịch", res.error);
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
    // eslint-disable-next-line react-hooks/set-state-in-effect -- data-fetch pattern
    setProjectLoading(true);
    void getProject(projectId).then((res) => {
      if (cancelled) return;
      if (res.ok) setProject(res.data);
      setProjectLoading(false);
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
    // week & gantt: 7 days from startOfWeek(anchor)
    const start = startOfWeek(anchor);
    const end = addDays(start, 6);
    end.setHours(23, 59, 59, 999);
    return { start, end };
  }, [viewMode, anchor]);

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

    // Ưu tiên: dùng Calendar API (BE merged + enriched data)
    // Skip nếu đã biết API này không tồn tại (404)
    if (!calendarApiUnavailable.current) {
      const calRes = await listCalendar({ from, to, includeCancelled: false });

      // Nếu 404 → mark as unavailable và fall through
      if (!calRes.ok && calRes.status === 404) {
        calendarApiUnavailable.current = true;
      } else if (calRes.ok && calRes.data.items.length > 0) {
        // Dùng calendar items từ BE
        setCalendarItems(calRes.data.items);
        // Work-hours config: AI propose dựa trên giờ làm việc nên cần giữ lại.
        setWorkHours({
          timeZone: calRes.data.timeZone,
          workDayStart: calRes.data.workDayStart,
          workDayEnd: calRes.data.workDayEnd,
          worksOnWeekend: calRes.data.worksOnWeekend,
          googleCalendarStatus: calRes.data.googleCalendarStatus,
        });

        // Vẫn load tasks + subtasks để modal hiển thị được danh sách subtask
        if (!projectId) {
          const projRes = await listProjects();
          if (projRes.ok) setAllProjects(projRes.data);
          const taskResults = await Promise.all(
            (projRes.ok ? projRes.data : []).map((p) => listTasks(p.id)),
          );
          const allTasks: TaskDto[] = [];
          for (const r of taskResults) if (r.ok) allTasks.push(...r.data);
          setTasks(allTasks);
          // Subtask: cần cho modal (cột phải) — load theo từng task
          const subResults = await Promise.all(
            allTasks.map((t) => listSubtasks(t.id)),
          );
          const allSub: SubtaskDto[] = [];
          for (const r of subResults) if (r.ok) allSub.push(...r.data);
          setSubtasks(allSub);
        } else {
          const tasksRes = await listTasks(projectId);
          if (tasksRes.ok) setTasks(tasksRes.data);
          const subResults = await Promise.all(
            (tasksRes.ok ? tasksRes.data : []).map((t) => listSubtasks(t.id)),
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
      setTasks(allTasks);
      const subResults = await Promise.all(
        allTasks.map((t) => listSubtasks(t.id)),
      );
      const allSub: SubtaskDto[] = [];
      for (const r of subResults) if (r.ok) allSub.push(...r.data);
      setSubtasks(allSub);

      // Load schedule slots for all tasks
      const slotResults = await Promise.all(
        allTasks.map((t) => listScheduleSlotsByTask(t.id)),
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
    setTasks(tasksRes.data);
    // Tải song song subtasks của từng task
    const subResults = await Promise.all(
      tasksRes.data.map((t) => listSubtasks(t.id)),
    );
    const allSub: SubtaskDto[] = [];
    for (const r of subResults) if (r.ok) allSub.push(...r.data);
    setSubtasks(allSub);

    // Load schedule slots for project tasks
    const slotResults = await Promise.all(
      tasksRes.data.map((t) => listScheduleSlotsByTask(t.id)),
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
        "Đã kết nối Google Calendar",
        "Sự kiện giờ được đồng bộ hai chiều với lịch của bạn.",
      );
    } else if (result.outcome === "denied") {
      toast.error(
        "Bạn đã từ chối cấp quyền",
        "METANOIA cần quyền calendar.events để đồng bộ lịch.",
      );
    } else {
      toast.error(
        "Kết nối thất bại",
        result.message ?? "Không liên kết được Google Calendar. Vui lòng thử lại.",
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

  /** Bản Map cho AI proposal — lookup O(1) khi render danh sách slot. */
  const tasksByIdMap = useMemo(() => {
    const m = new Map<string, TaskDto>();
    for (const t of tasks) m.set(t.id, t);
    return m;
  }, [tasks]);

  /** Task đã có ít nhất 1 schedule slot → loại khỏi danh sách xin AI xếp lịch. */
  const scheduledTaskIds = useMemo(
    () => new Set(scheduleSlots.map((s) => s.taskId).filter(Boolean)),
    [scheduleSlots],
  );

  /** Đếm task Flexible còn xếp được — dùng để bật/tắt nút Auto-schedule. */
  const schedulableCount = useMemo(() => {
    let n = 0;
    for (const t of tasks) {
      if (scheduledTaskIds.has(t.id)) continue;
      if (t.fixedStart || t.fixedEnd) continue;
      if ((t.taskType ?? "").toLowerCase() !== "flexible") continue;
      const st = (t.status ?? "").toLowerCase();
      if (st === "done" || st === "completed" || st === "cancelled" || st === "skipped") continue;
      n += 1;
    }
    return n;
  }, [tasks, scheduledTaskIds]);

  /* ---------- AI schedule proposal ---------- */
  const [proposalOpen, setProposalOpen] = useState(false);
  const proposal = useScheduleProposal({
    scheduledTaskIds,
    tasksById: tasksByIdMap,
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
    const aggregatedTaskIds = new Set(aggregateEvents.map((e) => e.taskId!));
    const filtered = list.filter(
      (ev) => !(ev.taskId && !ev.isAllDay && aggregatedTaskIds.has(ev.taskId)),
    );
    list.length = 0;
    list.push(...filtered, ...aggregateEvents);

    return list;
  }, [rawEvents, tasksById]);

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

  /* Week board */
  const week = useMemo<DayPlan[]>(() => {
    return Array.from({ length: 7 }).map((_, i) => {
      const date = addDays(range.start, i);
      const dayEvents = events.filter((ev) => {
        if (ev.isAllDay) return isSameDay(ev.start, date);
        // for timed events, include if the start day matches OR if it spans this day
        return isSameDay(ev.start, date) || (ev.start < date && ev.end >= addDays(date, 1));
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
    if (viewMode === "month") setAnchor(new Date(anchor.getFullYear(), anchor.getMonth() - 1, 1));
    else setAnchor(addDays(anchor, -7));
  }
  function goNext() {
    if (viewMode === "month") setAnchor(new Date(anchor.getFullYear(), anchor.getMonth() + 1, 1));
    else setAnchor(addDays(anchor, 7));
  }
  function goToday() { setAnchor(new Date()); }

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
      if (target?.closest(".sch-week__day") || target?.closest(".sch-month__cell")) return;
      setPopover(null);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [popover]);

  /* ----- Schedule Slot handlers ----- */

  /** Xóa 1 schedule slot từ modal detail */
  const handleDeleteScheduleSlot = useCallback(
    async (slotId: string) => {
      const res = await deleteScheduleSlot(slotId);
      if (res.ok) {
        setScheduleSlots((prev) => prev.filter((s) => s.id !== slotId));
        toast.success("Đã xoá lịch", "Block thời gian đã được gỡ khỏi calendar.");
      } else {
        toast.error("Không xoá được lịch", res.error);
      }
    },
    [toast]
  );

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

  /* ----- Sidebar: events by day, ordered list ----- */
  const upcomingEvents = useMemo(() => {
    const now = new Date();
    return [...events]
      .filter((e) => e.end >= now)
      .sort((a, b) => a.start.getTime() - b.start.getTime())
      .slice(0, 8);
  }, [events]);

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
              <span className="sch-eyebrow">{projectId ? "Project schedule" : "Personal schedule"}</span>
              <h1 className="sch-title">
                {projectLoading ? "Loading…" : project?.name ?? "All your scheduled tasks"}
              </h1>
              <p className="sch-sub">
                {projectId
                  ? "Tasks, subtasks and milestones for this project, synced from your API."
                  : "Everything across all your projects — calendar items pulled from the backend."}
              </p>
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
            <button
              type="button"
              className="sch-btn sch-btn--primary"
              onClick={openProposal}
              disabled={proposal.loading || schedulableCount === 0}
              title={
                schedulableCount === 0
                  ? "Không còn task flexible nào chưa có lịch"
                  : `AI sẽ xếp lịch cho ${schedulableCount} task flexible${
                      workHours.workDayStart && workHours.workDayEnd
                        ? ` trong khung giờ làm việc ${workHours.workDayStart}–${workHours.workDayEnd}`
                        : ""
                    }`
              }
            >
              <span className="material-symbols-outlined sch-icon-18">auto_awesome</span>
              Auto-schedule
            </button>
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

        {/* ============ 1b-multi. All-projects legend (khi /schedule) ============ */}
        {projectSpans.length > 1 && (
          <div className="sch-legend" role="status" aria-live="polite">
            <span className="sch-legend__title">
              <span className="material-symbols-outlined sch-icon-18">folder_open</span>
              All projects
            </span>
            <div className="sch-legend__list">
              {projectSpans.map((sp) => (
                <div key={sp.project.id} className="sch-legend__item" title={sp.project.name}>
                  <span className="sch-legend__dot" style={{ background: sp.color }} />
                  <span className="sch-legend__name">{sp.project.name}</span>
                  <span className="sch-legend__range">
                    {sp.start.toLocaleDateString(undefined, { month: "short", day: "numeric" })}
                    <span>→</span>
                    {sp.end.toLocaleDateString(undefined, { month: "short", day: "numeric" })}
                  </span>
                </div>
              ))}
            </div>
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

          <div className="sch-timeline__filters" role="tablist" aria-label="Filter">
            {(["all", "priority", "capstone", "deep"] as FilterId[]).map((f) => (
              <button
                key={f}
                type="button"
                role="tab"
                aria-selected={filter === f}
                className={`sch-chip${filter === f ? " sch-chip--active" : ""}`}
                onClick={() => setFilter(f)}
              >
                {f === "all" ? "All items" : f === "priority" ? "Priority" : f === "capstone" ? "Capstone" : "Deep work"}
              </button>
            ))}
          </div>
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
                className="sch-btn sch-btn--soft"
                onClick={openProposal}
                disabled={schedulableCount === 0 || proposal.loading}
              >
                Auto-schedule
              </button>
              <button
                type="button"
                className="sch-btn sch-btn--primary"
                onClick={openProposal}
                disabled={schedulableCount === 0 || proposal.loading}
              >
                Let AI re-plan
              </button>
            </div>
          </div>
        )}

        {/* ============ 5. Main board + sidebar ============ */}
        {!loading && !error && (
          <div className="sch-board">
            <div className="sch-board__main">
              {viewMode === "week" && (
                <WeekBoard days={visibleWeek} onSelectEvent={setSelected} tasksById={tasksById} spans={projectSpans} onCellClick={openCellPopover} accentByKey={cellAccentByKey} />
              )}
              {viewMode === "month" && (
                <MonthGrid days={monthGrid} onSelectEvent={setSelected} spans={projectSpans} onCellClick={openCellPopover} accentByKey={cellAccentByKey} gridRef={monthGridRef} />
              )}
              {viewMode === "gantt" && (
                <GanttView days={visibleWeek} onSelectEvent={setSelected} spans={projectSpans} />
              )}
            </div>

            <aside className="sch-board__side">
              <Sidebar upcoming={upcomingEvents} totalEvents={events.length} onSelect={(e) => setSelected(e)} />
              <GoogleCalendarCard toast={toast} onSynced={handleCalendarSynced} />
            </aside>
          </div>
        )}
      </div>

      {/* Event detail modal */}
      {selected && (
        <EventDetailModal
          event={selected}
          subtasks={subtasks}
          onClose={() => setSelected(null)}
          onDelete={handleDeleteScheduleSlot}
          onSlotChanged={() => void loadData()}
        />
      )}

      {/* Cell popover: hiện khi click 1 cell — liệt kê tất cả task trong ngày */}
      {popover && (
        <CellPopover
          day={popover.day}
          items={popover.items}
          onClose={() => setPopover(null)}
          onSelectEvent={(e) => setSelected(e)}
        />
      )}

      {proposalOpen && (
        <ProposalDialog
          hook={proposal}
          tasksById={tasksByIdMap}
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
 * Week board — 7 day columns
 * =========================================================== */
function WeekBoard({
  days, onSelectEvent, tasksById, spans, onCellClick, accentByKey,
}: {
  days: DayPlan[];
  onSelectEvent: (e: CalEvent) => void;
  tasksById: Record<string, TaskDto>;
  spans: ProjectSpan[];
  onCellClick?: (day: Date) => void;
  accentByKey: Map<string, CellAccent | null>;
}) {
  return (
    <div className="sch-week">
      {days.map((d, i) => {
        const isToday = isSameDay(d.date, new Date());
        // Tìm spans chạm cell này
        const touching = spans
          .map((sp) => {
            const ts = startOfDay(sp.start).getTime();
            const te = startOfDay(sp.end).getTime();
            const dc = startOfDay(d.date).getTime();
            return { sp, isStart: dc === ts, isEnd: dc === te, isBoth: dc === ts && dc === te, inSpan: dc > ts && dc < te };
          })
          .filter((m) => m.isStart || m.isEnd || m.inSpan);
        const inSpan = touching.some((m) => m.inSpan);
        // Single-accent: lấy từ accentByKey (đã tính sẵn)
        const accent = accentByKey.get(d.key);
        const primary = accent ? { sp: accent.accent } : null;
        const multi = accent && accent.projectCount > 1;
        return (
          <div
            key={d.key}
            className={`sch-week__day${d.rest ? " sch-week__day--rest" : ""}${isToday ? " sch-week__day--today" : ""}${inSpan ? " sch-week__day--in-span" : ""}${multi ? " sch-week__day--multi" : ""}`}
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
            <div className="sch-week__head">
              <div>
                <div className="sch-week__dow">{WEEKDAY_LABELS[i]}</div>
                <div className="sch-week__num">{d.date.getDate()}</div>
              </div>
              <div className="sch-week__head-right">
                {/* Multi-project badge: hiện khi >1 project chạm cell */}
                {multi && (
                  <button
                    type="button"
                    className="sch-multi-badge"
                    title={`${accent!.projectCount} projects, ${accent!.totalTasks + accent!.totalSubtasks} items`}
                    onClick={(e) => { e.stopPropagation(); onCellClick?.(d.date); }}
                  >
                    <span className="material-symbols-outlined sch-icon-12">layers</span>
                    {accent!.projectCount}
                  </button>
                )}
                <div className={`sch-week__badge sch-tone--${d.badgeTone}`}>{d.badge}</div>
              </div>
            </div>

            {/* Project boundary chips (start / end) — chỉ show 1 cái của primary span,
                tránh chồng chất khi nhiều projects bắt đầu cùng ngày */}
            {accent && (() => {
              const m = touching.find((t) => t.sp.project.id === accent.accent.project.id);
              if (!m || (!m.isStart && !m.isEnd)) return null;
              return (
                <div
                  className={`sch-boundary${m.isStart ? " sch-boundary--start" : ""}${m.isEnd ? " sch-boundary--end" : ""}${m.isBoth ? " sch-boundary--both" : ""}`}
                  style={{
                    ["--boundary-color" as any]: accent.accent.color,
                    ["--boundary-bg" as any]: `${accent.accent.color}26`,
                  }}
                  title={`${accent.accent.project.name}: ${m.isBoth ? "start & end" : m.isStart ? "start" : "end"}`}
                >
                  <span className="material-symbols-outlined sch-icon-14">
                    {m.isBoth ? "flag" : m.isStart ? "play_arrow" : "stop"}
                  </span>
                  <span className="sch-boundary__label">
                    {accent.accent.project.name}
                    {m.isBoth ? " • start & end" : m.isStart ? " • start" : " • end"}
                  </span>
                </div>
              );
            })()}

            {/* load bar */}
            <div className="sch-week__load" data-tone={d.load.tone}>
              <div className="sch-week__load-fill" style={{ width: `${d.load.pct}%` }} />
              <span className="sch-week__load-text">{d.load.hours.toFixed(1)}h • {d.load.label}</span>
            </div>

            {/* events */}
            <div className="sch-week__events">
              {d.events.length === 0 && (
                <div className="sch-week__empty">No events</div>
              )}
              {d.events.map((ev) => (
                <EventChip key={ev.id} ev={ev} onClick={() => onSelectEvent(ev)} taskType={ev.taskId ? tasksById[ev.taskId]?.taskType : undefined} />
              ))}
            </div>
          </div>
        );
      })}
    </div>
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
      {/* Mỗi project 1 ribbon overlay (track between start & end col) */}
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
              gridColumn: `${a + 2} / span ${b - a + 1}`,
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
              {m.sp.project.name}
              <span className="sch-gantt__ribbon-dates">
                {m.sp.start.toLocaleDateString(undefined, { month: "short", day: "numeric" })}
                <span>→</span>
                {m.sp.end.toLocaleDateString(undefined, { month: "short", day: "numeric" })}
              </span>
            </div>
          </div>
        );
      })}
      <div className="sch-gantt__head">
        <div className="sch-gantt__col sch-gantt__col--name">Item</div>
        {days.map((d, i) => (
          <div key={d.key} className="sch-gantt__col">
            <div className="sch-gantt__dow">{WEEKDAY_LABELS[i]}</div>
            <div className="sch-gantt__num">{d.date.getDate()}</div>
          </div>
        ))}
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
                <span className="sch-gantt__meta">{sourceLabel(ev.source)}</span>
              </div>
              <div className="sch-gantt__bar-wrap">
                <button
                  type="button"
                  className={`sch-gantt__bar sch-tone--${dotFor(ev)}`}
                  style={{
                    gridColumn: `${colStart + 2} / span ${Math.min(span, days.length - colStart)}`,
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
                    style={{ gridColumn: `${startCol + 2} / span 1` }}
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
                    style={{ gridColumn: `${endCol + 2} / span 1` }}
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
   * Chỉ slot (`source === "slot"`) mới có nút Start/Stop.
   * Item từ Google Calendar chỉ để xem — không gắn phiên làm việc.
   */
  const isSlot = ev.source === "slot" && !!ev.scheduleSlotId && !!ev.taskId;

  const chip = (
    <button
      type="button"
      className={`sch-chip-event${compact ? " sch-chip-event--compact" : ""}${isDone ? " sch-chip-event--done" : ""}`}
      onClick={onClick}
      data-tone={dotFor(ev)}
    >
      <span className="sch-chip-event__dot" data-tone={dotFor(ev)} />
      <div className="sch-chip-event__body">
        <span className="sch-chip-event__title">{ev.title}</span>
        {!compact && (
          <span className="sch-chip-event__meta">
            {eventTimeRange(ev)} {taskType ? `· ${taskType}` : ""} · {sourceLabel(ev.source)}
          </span>
        )}
      </div>
      {compact && (
        <span className="sch-chip-event__time">{fmtTime(ev.start)}</span>
      )}
    </button>
  );

  if (!isSlot) return chip;

  /*
   * Không lồng `<button>` trong `<button>` (HTML không hợp lệ, và click vào
   * nút con sẽ kích hoạt cả nút cha → mở modal thay vì Start).
   * Ta bọc chip trong 1 `<div>` rồi đặt nút Start/Stop cạnh bên.
   */
  return (
    <div className="sch-chip-wrap">
      {chip}
      <SlotFocusActions
        slotId={ev.scheduleSlotId ?? null}
        taskId={ev.taskId ?? null}
        /*
         * ⚠️ `subTaskId` phải lấy từ SLOT, không từ event.
         *
         * Spec mục 6.1: "Slot gắn subtask nhưng **không gửi** `subTaskId` khi
         * Start → Phiên **không** có subtask. Backend **không tự lấy**
         * `subTaskId` từ slot."
         *
         * Với event gộp nhiều slot của 1 task, `event.subTaskId` là `null`
         * (aggregate) → dùng nó sẽ làm mất nhãn subtask của phiên. Ta tra
         * slot gốc để lấy đúng `subTaskId` của slot đang bấm.
         */
        subTaskId={ev.scheduleSlot?.subTaskId ?? ev.subTaskId ?? null}
        status={ev.slotStatus ?? ev.status}
        plannedMinutes={ev.slotPlannedMinutes ?? undefined}
        compact
      />
    </div>
  );
}

/* ===========================================================
 * Sidebar
 * =========================================================== */
function Sidebar({
  upcoming, totalEvents, onSelect,
}: {
  upcoming: CalEvent[];
  totalEvents: number;
  onSelect: (e: CalEvent) => void;
}) {
  return (
    <div className="sch-side">
      <div className="sch-card">
        <div className="sch-card__head">
          <span className="sch-card__eyebrow">Upcoming</span>
          <span className="sch-card__count">{upcoming.length}</span>
        </div>
        <h3 className="sch-card__title">Next on your calendar</h3>
        {upcoming.length === 0 ? (
          <p className="sch-card__hint">Nothing upcoming in this range.</p>
        ) : (
          <ul className="sch-side-list">
            {upcoming.map((ev) => (
              <li key={ev.id}>
                <button type="button" className="sch-side-item" onClick={() => onSelect(ev)}>
                  <div className="sch-side-item__date">
                    <span className="sch-side-item__day">{ev.start.getDate()}</span>
                    <span className="sch-side-item__mon">
                      {MONTH_LABELS[ev.start.getMonth()].slice(0, 3).toUpperCase()}
                    </span>
                  </div>
                  <div className="sch-side-item__body">
                    <span className="sch-side-item__title">{ev.title}</span>
                    <span className="sch-side-item__meta">
                      {eventTimeRange(ev)} · {sourceLabel(ev.source)}
                    </span>
                  </div>
                  <span className={`sch-side-item__dot sch-tone--${dotFor(ev)}`} />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="sch-card">
        <div className="sch-card__head">
          <span className="sch-card__eyebrow">Capacity</span>
        </div>
        <h3 className="sch-card__title">Workload signals</h3>
        <div className="sch-side-meta">
          <div className="sch-side-meta__row">
            <span>Total items</span>
            <strong>{totalEvents}</strong>
          </div>
          <div className="sch-side-meta__row">
            <span>All-day</span>
            <strong>{upcoming.filter((e) => e.isAllDay).length}</strong>
          </div>
          <div className="sch-side-meta__row">
            <span>Timed</span>
            <strong>{upcoming.filter((e) => !e.isAllDay).length}</strong>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ===========================================================
 * Google Calendar connection card
 *
 * Hiển thị trạng thái liên kết Google Calendar của user và cho phép
 * Connect (redirect OAuth) / Sync / Disconnect.
 *
 * Đặt trong sidebar của /schedule. Logic ở hook `useGoogleCalendar` để
 * user menu (SiteLayout) dùng chung cùng một nguồn sự thật.
 * =========================================================== */
function GoogleCalendarCard({
  toast,
  onSynced,
}: {
  toast: ReturnType<typeof useCenterToast>[1];
  onSynced?: () => void;
}) {
  const { isConnected, status, loading, busy, error, connect, disconnect, sync } =
    useGoogleCalendar();

  /** Định dạng `tokenExpiresAt` -> chuỗi ngắn gọn cho user đọc. */
  const tokenExpiresAt = status?.tokenExpiresAt ?? null;
  const [expiresLabel, setExpiresLabel] = useState<string | null>(null);
  useEffect(() => {
    function compute(): string | null {
      if (!tokenExpiresAt) return null;
      const d = new Date(tokenExpiresAt!);
      if (Number.isNaN(d.getTime())) return null;
      const mins = Math.round((d.getTime() - Date.now()) / 60000);
      if (mins <= 0) return "Token expired";
      if (mins < 60) return `Token valid ~${mins}m`;
      const hours = Math.round(mins / 60);
      if (hours < 48) return `Token valid ~${hours}h`;
      return `Token valid until ${d.toLocaleDateString()}`;
    }
    // eslint-disable-next-line react-hooks/set-state-in-effect -- derive từ tokenExpiresAt
    setExpiresLabel(compute());
  }, [tokenExpiresAt]);

  async function handleSync() {
    const res = await sync();
    if (res.ok) {
      toast.success(
        "Google Calendar synced",
        `${res.data.added} added · ${res.data.updated} updated · ${res.data.cancelled} cancelled`,
      );
      // Nạp lại lịch để thấy sự kiện vừa kéo về.
      onSynced?.();
    } else {
      toast.error("Sync failed", res.error);
    }
  }

  async function handleDisconnect() {
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
    <div className="sch-card sch-gcal">
      <div className="sch-card__head">
        <span className="sch-card__eyebrow">Integrations</span>
        <span
          className={
            "sch-gcal__badge" + (isConnected ? " sch-gcal__badge--on" : "")
          }
        >
          {loading ? "…" : isConnected ? "Connected" : "Not connected"}
        </span>
      </div>
      <h3 className="sch-card__title">Google Calendar</h3>

      {loading ? (
        <p className="sch-card__hint">Checking connection…</p>
      ) : isConnected ? (
        <>
          <p className="sch-card__hint">
            Events sync two-way with your Google account.
          </p>
          {expiresLabel && (
            <div className="sch-side-meta">
              <div className="sch-side-meta__row">
                <span>Token</span>
                <strong>{expiresLabel}</strong>
              </div>
            </div>
          )}
          <div className="sch-gcal__actions">
            <button
              type="button"
              className="sch-btn sch-btn--primary sch-gcal__btn"
              onClick={handleSync}
              disabled={busy !== null}
            >
              <span className="material-symbols-outlined sch-icon-18">sync</span>
              {busy === "sync" ? "Syncing…" : "Sync now"}
            </button>
            <button
              type="button"
              className="sch-btn sch-btn--soft sch-gcal__btn"
              onClick={handleDisconnect}
              disabled={busy !== null}
            >
              <span className="material-symbols-outlined sch-icon-18">link_off</span>
              {busy === "disconnect" ? "Disconnecting…" : "Disconnect"}
            </button>
          </div>
        </>
      ) : (
        <>
          <p className="sch-card__hint">
            Connect to mirror your scheduled blocks into Google Calendar.
          </p>
          <button
            type="button"
            className="sch-btn sch-btn--primary sch-gcal__btn sch-gcal__btn--full"
            onClick={() => void connect()}
            disabled={connecting}
          >
            <span className="material-symbols-outlined sch-icon-18">
              {connecting ? "progress_activity" : "link"}
            </span>
            {connecting ? "Redirecting…" : "Connect Google Calendar"}
          </button>
          <p className="sch-gcal__note">
            Bạn sẽ được chuyển sang Google để cấp quyền{" "}
            <code>calendar.events</code>, sau đó quay lại đây.
          </p>
        </>
      )}

      {error && <p className="sch-gcal__error">{error}</p>}
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
              const title = it.task?.title ?? it.subtask?.title ?? "Untitled";
              const desc = it.task?.description ?? it.subtask?.description ?? null;
              const est = it.task?.estimatedMinutes ?? it.subtask?.estimatedMinutes ?? 0;
              const isSubtask = !it.task && !!it.subtask;
              const done = /done|completed/i.test(it.status);
              return (
                <li
                  key={`${it.task?.id ?? it.subtask?.id ?? it.start.getTime()}`}
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
                      {done ? "check_circle" : isSubtask ? "subdirectory_arrow_right" : "task_alt"}
                    </span>
                    <span
                      className="sch-cell-popover__task-title"
                      style={done ? { color: "var(--sch-text-3)", textDecoration: "line-through" } : undefined}
                    >
                      {title}
                    </span>
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
                              compact
                            />
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
  event, subtasks, onClose, onDelete, onSlotChanged,
}: {
  event: CalEvent;
  subtasks: SubtaskDto[];
  onClose: () => void;
  onDelete?: (slotId: string) => void;
  /** Refetch lịch sau khi slot đổi trạng thái (Start/Stop). */
  onSlotChanged?: () => void;
}) {
  const task = event.task;
  const subtask = event.subtask;
  const slot = event.scheduleSlot;
  const isSlotEvent = event.source === "slot";
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
  const showSubtaskColumn = event.taskId != null && (isAggregate || taskSubtasks.length > 0);

  /** Danh sách "khối" hiển thị: chuẩn hoá cả slot lẫn subtask về shape giống nhau. */
  const detailBlocks = useMemo<
    Array<{
      key: string;
      title: string;
      status: string;
      start: Date;
      end: Date;
      slot?: ScheduleSlotDto;
      subtaskId?: string;
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
            subtaskId: e.subTaskId ?? undefined,
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
            </div>

            {/* Khối Focus Session: nút Start/Stop + tổng kết thời gian */}
            <SlotFocusPanel
              slotId={slot?.id ?? event.scheduleSlotId ?? null}
              taskId={event.taskId}
              /*
               * ⚠️ `subTaskId` của SLOT, không của event — spec mục 6.1:
               * backend không tự lấy `subTaskId` từ slot khi Start.
               * Với event aggregate (gộp nhiều slot của 1 task) thì
               * `event.subTaskId` là null → phải tra slot gốc.
               */
              subTaskId={slot?.subTaskId ?? event.subTaskId ?? null}
              status={slot?.status ?? event.status}
              plannedMinutes={
                slot?.proposedMinutes ?? event.slotPlannedMinutes ?? undefined
              }
              onChanged={onSlotChanged}
            />
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
                          {b.slot && onDelete && (
                            <button
                              type="button"
                              className="sch-aggregate__del"
                              onClick={() => {
                                onDelete(b.slot!.id);
                                onClose();
                              }}
                            >
                              <span className="material-symbols-outlined sch-icon-16">close</span>
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
          {isSlotEvent && !isAggregate && slot && onDelete && (
            <button
              type="button"
              className="sch-btn sch-btn--error"
              onClick={() => {
                onDelete(slot.id);
                onClose();
              }}
            >
              <span className="material-symbols-outlined sch-icon-18">delete</span>
              Remove Slot
            </button>
          )}
          {event.taskId && (
            <Link
              to={`/projects/${event.projectId ?? ""}/planning`}
              className="sch-btn sch-btn--primary"
              onClick={onClose}
            >
              <span className="material-symbols-outlined sch-icon-18">open_in_new</span>
              Open in Planning
            </Link>
          )}
        </div>      </div>
    </div>
  );
}
