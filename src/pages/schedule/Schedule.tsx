import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useStaggeredMount } from "../../hooks/useStaggeredMount";
import {
  getProject,
  listProjects,
  listSubtasks,
  listTasks,
  type ProjectDto,
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
type Tone = "primary" | "secondary" | "tertiary" | "error" | "muted";
type FilterId = "all" | "priority" | "capstone" | "deep";
type CalSource = "task" | "subtask" | "milestone" | "google";

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
  /** Item gốc: TaskDto | SubtaskDto | null (khi là Google event). */
  task?: TaskDto;
  subtask?: SubtaskDto;
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
  };
  return m[source?.toLowerCase()] ?? source;
}

/* ===========================================================
 * Cell accent picker — tính "project chính" cho 1 ngày + số liệu tổng.
 * Pure function, dùng cho week/month cell để render 1 màu + badge.
 * =========================================================== */
type CellAccent = {
  accent: ProjectSpan;
  allSpans: Array<{ sp: ProjectSpan; taskCount: number; subtaskCount: number; total: number; urgency: number }>;
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
    let taskCount = 0;
    let subtaskCount = 0;
    let bestDeadlineDelta = Number.POSITIVE_INFINITY;
    const projTasks = tasks.filter((t) => t.projectId === sp.project.id);
    for (const t of projTasks) {
      const isActive =
        (t.deadline && isSameDay(new Date(t.deadline), day)) ||
        (t.fixedStart && new Date(t.fixedStart) <= dayEnd && new Date(t.fixedEnd) >= dayStart);
      if (isActive) taskCount++;
      if (t.deadline) {
        const dl = new Date(t.deadline).getTime();
        const delta = Math.abs(dl - dc);
        if (delta < bestDeadlineDelta) bestDeadlineDelta = delta;
      }
    }
    const taskIds = new Set(projTasks.map((t) => t.id));
    for (const st of subtasks) {
      if (!taskIds.has(st.taskId)) continue;
      const isActive =
        st.scheduledStart && new Date(st.scheduledStart) <= dayEnd && new Date(st.scheduledEnd) >= dayStart;
      if (isActive) subtaskCount++;
    }
    const total = taskCount + subtaskCount;
    return { sp, taskCount, subtaskCount, total, urgency: bestDeadlineDelta };
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
   */
  const [allProjects, setAllProjects] = useState<ProjectDto[]>([]);
  const loadData = useCallback(async () => {
    setLoading(true);
    setError(null);
    if (!projectId) {
      // Global /schedule: load tất cả projects, rồi load tasks của từng cái.
      const projRes = await listProjects();
      if (!projRes.ok) {
        setError(projRes.error ?? "Failed to load projects");
        setAllProjects([]);
        setTasks([]);
        setSubtasks([]);
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
      setLoading(false);
      return;
    }
    const tasksRes = await listTasks(projectId);
    if (!tasksRes.ok) {
      setError(tasksRes.error ?? "Failed to load tasks");
      setTasks([]);
      setSubtasks([]);
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
    setLoading(false);
  }, [projectId]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- data-fetch pattern
    void loadData();
  }, [loadData]);

  /* Build CalEvent từ tasks + subtasks */
  const events = useMemo<CalEvent[]>(() => {
    const list: CalEvent[] = [];
    for (const t of tasks) {
      // 1) Task có fixedStart/fixedEnd -> event timed
      if (t.fixedStart && t.fixedEnd) {
        const s = new Date(t.fixedStart);
        const e = new Date(t.fixedEnd);
        if (!Number.isNaN(s.getTime()) && !Number.isNaN(e.getTime())) {
          list.push({
            id: `task-fixed-${t.id}`,
            source: "task",
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
            source: "task",
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
    for (const st of subtasks) {
      if (st.scheduledStart && st.scheduledEnd) {
        const s = new Date(st.scheduledStart);
        const e = new Date(st.scheduledEnd);
        if (!Number.isNaN(s.getTime()) && !Number.isNaN(e.getTime())) {
          const parent = tasks.find((t) => t.id === st.taskId);
          list.push({
            id: `subtask-${st.id}`,
            source: "subtask",
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
    return list;
  }, [tasks, subtasks]);

  /** Map taskId -> TaskDto để enrich chip. */
  const tasksById = useMemo<Record<string, TaskDto>>(() => {
    const m: Record<string, TaskDto> = {};
    for (const t of tasks) m[t.id] = t;
    return m;
  }, [tasks]);

  /**
   * Project spans: mỗi project 1 span, lấy từ ProjectDto (startDate, deadline)
   * làm anchor, mở rộng về phía trước/sau bằng deadline/fixed* của tasks và
   * scheduled* của subtasks. Mỗi span có 1 màu riêng (hash từ project id).
   */
  type ProjectSpan = {
    project: ProjectDto;
    start: Date;
    end: Date;
    color: string;
  };

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

  /** Lưu anchor của project span để "Jump to span". */
  useEffect(() => {
    if (projectSpan) {
      // Đặt anchor vào khoảng giữa span để bao quát dễ nhìn
      const mid = new Date(
        (projectSpan.start.getTime() + projectSpan.end.getTime()) / 2,
      );
      setSpanAnchor((prev) => prev ?? mid);
      // Chỉ auto-jump anchor nếu anchor hiện tại nằm ngoài span (lần đầu vào)
      // Và chưa có spanAnchor (lần đầu load)
      // Anchor set về mid 1 lần
    }
  }, [projectSpan]);

  /** Anchor mặc định lúc mount: nếu có project, nhảy vào giữa span. */
  useEffect(() => {
    if (spanAnchor) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional default anchor
      setAnchor(spanAnchor);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only on mount/span resolution
  }, [spanAnchor]);

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
    useStaggeredMount<HTMLDivElement>([kpis.totalHours, kpis.tasksCount]);

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

  /** Cell popover: hiện khi click 1 cell có nhiều projects/tasks. */
  const [popover, setPopover] = useState<{ day: Date; info: ReturnType<typeof pickAccentForCell> } | null>(null);

  const openCellPopover = useCallback((day: Date) => {
    const info = pickAccentForCell(day);
    if (!info) return;
    setPopover({ day, info });
  }, [pickAccentForCell]);

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
            <button type="button" className="sch-btn sch-btn--primary">
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
              <button type="button" className="sch-btn sch-btn--soft">View</button>
              <button type="button" className="sch-btn sch-btn--primary">Apply</button>
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
                <MonthGrid days={monthGrid} onSelectEvent={setSelected} spans={projectSpans} onCellClick={openCellPopover} accentByKey={cellAccentByKey} />
              )}
              {viewMode === "gantt" && (
                <GanttView days={visibleWeek} onSelectEvent={setSelected} spans={projectSpans} />
              )}
            </div>

            <aside className="sch-board__side">
              <Sidebar upcoming={upcomingEvents} totalEvents={events.length} onSelect={setSelected} />
            </aside>
          </div>
        )}
      </div>

      {/* Event detail modal */}
      {selected && (
        <EventDetailModal event={selected} onClose={() => setSelected(null)} />
      )}

      {/* Cell popover: hiện khi click 1 cell có nhiều projects/tasks */}
      {popover && (
        <CellPopover
          day={popover.day}
          info={popover.info}
          onClose={() => setPopover(null)}
          onSelectEvent={setSelected}
        />
      )}
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
  days, onSelectEvent, spans, onCellClick, accentByKey,
}: {
  days: DayPlan[];
  onSelectEvent: (e: CalEvent) => void;
  spans: ProjectSpan[];
  onCellClick?: (day: Date) => void;
  accentByKey: Map<string, CellAccent | null>;
}) {
  return (
    <div className="sch-month">
      <div className="sch-month__head">
        {WEEKDAY_LABELS.map((d) => (
          <div key={d} className="sch-month__dow">{d}</div>
        ))}
      </div>
      <div className="sch-month__grid">
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
  return (
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
 * Cell popover — liệt kê tất cả projects + tasks đang active trong 1 ngày
 * (khi cell có >1 project, hoặc user muốn xem chi tiết).
 * =========================================================== */
function CellPopover({
  day, info, onClose, onSelectEvent,
}: {
  day: Date;
  info: CellAccent;
  onClose: () => void;
  onSelectEvent: (e: CalEvent) => void;
}) {
  return (
    <div className="sch-cell-popover" role="dialog" aria-modal="false" aria-label={`Details for ${day.toDateString()}`}>
      <div className="sch-cell-popover__head">
        <div>
          <div className="sch-cell-popover__date">
            {day.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" })}
          </div>
          <div className="sch-cell-popover__meta">
            {info.projectCount} project{info.projectCount !== 1 ? "s" : ""}
            {" • "}
            {info.totalTasks + info.totalSubtasks} item{(info.totalTasks + info.totalSubtasks) !== 1 ? "s" : ""}
          </div>
        </div>
        <button type="button" className="sch-icon-btn" onClick={onClose} aria-label="Close">
          <span className="material-symbols-outlined">close</span>
        </button>
      </div>
      <div className="sch-cell-popover__body">
        {info.allSpans.map((s) => (
          <div key={s.sp.project.id} className="sch-cell-popover__project">
            <div className="sch-cell-popover__project-head">
              <span className="sch-cell-popover__dot" style={{ background: s.sp.color }} />
              <span className="sch-cell-popover__project-name">{s.sp.project.name}</span>
              <span className="sch-cell-popover__project-count">
                {s.taskCount} task{s.taskCount !== 1 ? "s" : ""}
                {s.subtaskCount > 0 ? `, ${s.subtaskCount} subtask${s.subtaskCount !== 1 ? "s" : ""}` : ""}
              </span>
            </div>
            {s.taskCount === 0 && s.subtaskCount === 0 && (
              <div className="sch-cell-popover__empty">No active items today</div>
            )}
            {/* Note: trong scope này ta không truyền tasks chi tiết vào,
                chỉ summary. Click "Open project" để drilldown. */}
          </div>
        ))}
      </div>
      <div className="sch-cell-popover__foot">
        <span className="sch-cell-popover__hint">Primary project: {info.accent.project.name}</span>
      </div>
    </div>
  );
}

/* ===========================================================
 * Event detail modal
 * =========================================================== */
function EventDetailModal({
  event, onClose,
}: {
  event: CalEvent;
  onClose: () => void;
}) {
  const task = event.task;
  const subtask = event.subtask;
  return (
    <div className="sch-modal" role="presentation" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="sch-modal__panel" role="dialog" aria-modal="true">
        <div className="sch-modal__head">
          <div>
            <span className="sch-card__eyebrow">{sourceLabel(event.source)}</span>
            <h2 className="sch-card__title">{event.title}</h2>
          </div>
          <button type="button" className="sch-icon-btn" aria-label="Close" onClick={onClose}>
            <span className="material-symbols-outlined">close</span>
          </button>
        </div>

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
              <code>{event.taskId}</code>
            </div>
          )}
        </div>

        <div className="sch-modal__actions">
          <button type="button" className="sch-btn sch-btn--soft" onClick={onClose}>Close</button>
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
        </div>
      </div>
    </div>
  );
}
