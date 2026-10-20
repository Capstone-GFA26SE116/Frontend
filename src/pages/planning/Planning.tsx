import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { CenterToasts, useCenterToast } from "../../components/Toast";
import {
  createMilestone,
  createScheduleSlot,
  createSubtask,
  createTask,
  deleteMilestone,
  deleteSubtask,
  deleteTask,
  getProject,
  listDomains,
  listMilestones,
  listSubtasks,
  listTasks,
  type CreateMilestoneRequest,
  type CreateScheduleSlotRequest,
  type CreateSubtaskRequest,
  type CreateTaskRequest,
  type DomainDto,
  type MilestoneDto,
  type ProjectDto,
  type SubtaskDto,
  type TaskDto,
} from "../../lib/api-client";
import "./planning.css";

/* ============================================================
 * Planning page
 * Route: /projects/:projectId/planning
 *
 * UI:
 *   - Header: back + breadcrumb + project name
 *   - KPI strip: # tasks, # subtasks, overdue, total hours
 *   - Task list (collapsible, each has subtasks)
 *   - Create Task modal
 *   - Inline Create Subtask form
 * ============================================================ */

/* ---------- Helpers for DTO → display ---------- */
function prettyTaskStatus(s: string): string {
  const m: Record<string, string> = {
    todo: "ToDo",
    scheduled: "Scheduled",
    inprogress: "InProgress",
    done: "Done",
    completed: "Done",
    skipped: "Skipped",
    cancelled: "Cancelled",
    // legacy
    pending: "ToDo",
  };
  const lower = (s ?? "").toLowerCase();
  if (m[lower]) return m[lower];
  // BE có thể trả về đúng chữ "ToDo"/"InProgress" -> return as-is
  if (s === "ToDo" || s === "Scheduled" || s === "InProgress" || s === "Done" || s === "Skipped") return s;
  return s || "Unknown";
}
function taskStatusTone(s: string): string {
  const m: Record<string, string> = {
    todo: "muted",
    scheduled: "sky",
    inprogress: "secondary",
    done: "primary",
    completed: "primary",
    skipped: "muted",
    cancelled: "error",
    // legacy
    pending: "muted",
  };
  return m[(s ?? "").toLowerCase()] ?? "muted";
}
function taskTypeLabel(t: string): string {
  const m: Record<string, string> = {
    flexible: "Flexible",
    fixed: "Fixed",
    feature: "Feature",
    bugfix: "Bug Fix",
    research: "Research",
    design: "Design",
    meeting: "Meeting",
    documentation: "Docs",
    testing: "Testing",
    deployment: "Deploy",
  };
  // Hỗ trợ cả lowercase lẫn chữ hoa đầu (Flexible / FIXED / ...)
  const lower = (t ?? "").toLowerCase();
  if (m[lower]) return m[lower];
  // Nếu BE trả về đúng "Flexible"/"Fixed" thì return as-is
  if (t === "Flexible" || t === "Fixed") return t;
  return t || "General";
}
function formatDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "2-digit",
  });
}
function formatMinutes(mins: number | null | undefined): string {
  if (!mins) return "—";
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  if (h === 0) return `${m}m`;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}m`;
}
function subtaskStatusTone(s: string): string {
  const m: Record<string, string> = {
    todo: "muted",
    scheduled: "sky",
    inprogress: "secondary",
    done: "secondary",
    completed: "secondary",
    skipped: "muted",
    // legacy
    pending: "muted",
  };
  return m[(s ?? "").toLowerCase()] ?? "muted";
}

/* Enum trạng thái milestone mà BE chấp nhận */
type MilestoneStatus =
  | "Planned"
  | "InProgress"
  | "Delivered"
  | "InRevision"
  | "Approved";

/* ============================================================
 * Main page
 * ============================================================ */
export function PlanningPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const navigate = useNavigate();

  /* project */
  const [project, setProject] = useState<ProjectDto | null>(null);
  const [projectLoading, setProjectLoading] = useState(true);
  const [projectError, setProjectError] = useState<string | null>(null);

  /* tasks */
  const [tasks, setTasks] = useState<TaskDto[]>([]);
  const [tasksLoading, setTasksLoading] = useState(true);
  const [tasksError, setTasksError] = useState<string | null>(null);

  /* subtasks map: taskId -> SubtaskDto[] */
  const [subtasksMap, setSubtasksMap] = useState<Record<string, SubtaskDto[]>>({});
  const [subtasksLoading, setSubtasksLoading] = useState<Record<string, boolean>>({});
  const [expandedTasks, setExpandedTasks] = useState<Set<string>>(new Set());

  /* milestones */
  const [milestones, setMilestones] = useState<MilestoneDto[]>([]);
  const [milestonesLoading, setMilestonesLoading] = useState(true);
  const [milestonesError, setMilestonesError] = useState<string | null>(null);

  /* domains (dùng cho dropdown chọn domain của task) */
  const [domains, setDomains] = useState<DomainDto[]>([]);

  /* UI state */
  const [showCreateTask, setShowCreateTask] = useState(false);
  const [showCreateMilestone, setShowCreateMilestone] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submittingMilestone, setSubmittingMilestone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /* Inline subtask form: taskId đang mở form */
  const [subtaskFormTaskId, setSubtaskFormTaskId] = useState<string | null>(null);
  const [subtaskFormLoading, setSubtaskFormLoading] = useState(false);

  /* Delete confirm */
  const [deleteTarget, setDeleteTarget] = useState<{
    kind: "task" | "subtask" | "milestone";
    id: string;
    title: string;
  } | null>(null);
  const [deleteLoading, setDeleteLoading] = useState(false);

  /* Schedule Modal state */
  const [scheduleModal, setScheduleModal] = useState<{
    taskId: string;
    taskTitle: string;
  } | null>(null);
  const [scheduleStart, setScheduleStart] = useState("");
  const [scheduleEnd, setScheduleEnd] = useState("");
  const [scheduleExplanation, setScheduleExplanation] = useState("");
  const [scheduleSubtaskId, setScheduleSubtaskId] = useState<string | null>(null);
  const [scheduleSubmitting, setScheduleSubmitting] = useState(false);

  /* Toast thông báo giữa màn hình */
  const [toasts, toast] = useCenterToast();
  const toastDismiss = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  function openScheduleModal(taskId: string, taskTitle: string) {
    // Default: next hour to next hour + 1
    const now = new Date();
    const start = new Date(now);
    start.setHours(start.getHours() + 1, 0, 0, 0);
    const end = new Date(start);
    end.setHours(end.getHours() + 1);
    setScheduleStart(start.toISOString().slice(0, 16));
    setScheduleEnd(end.toISOString().slice(0, 16));
    setScheduleExplanation("");
    setScheduleSubtaskId(null);

    // Auto-load subtasks nếu chưa có để dropdown có dữ liệu
    if (subtasksMap[taskId] === undefined && !subtasksLoading[taskId]) {
      setSubtasksLoading((p) => ({ ...p, [taskId]: true }));
      void listSubtasks(taskId).then((res) => {
        setSubtasksMap((p) => ({ ...p, [taskId]: res.ok ? res.data : [] }));
        setSubtasksLoading((p) => ({ ...p, [taskId]: false }));
      });
    }

    setScheduleModal({ taskId, taskTitle });
  }

  async function handleScheduleSubmit() {
    console.log("handleScheduleSubmit called", { scheduleModal, scheduleStart, scheduleEnd, scheduleSubtaskId });
    if (!scheduleModal || !scheduleStart || !scheduleEnd) {
      console.log("Early return: missing data");
      return;
    }
    setScheduleSubmitting(true);
    console.log("Calling API...");
    try {
      // Nếu chọn 1 subtask cụ thể → chỉ tạo 1 slot
      if (scheduleSubtaskId) {
        const res = await createScheduleSlot(scheduleModal.taskId, {
          subTaskId: scheduleSubtaskId,
          startTime: new Date(scheduleStart).toISOString(),
          endTime: new Date(scheduleEnd).toISOString(),
          originalStartTime: new Date(scheduleStart).toISOString(),
          isManualOverride: true,
          kbiasUsed: 0,
          explanation: scheduleExplanation || "Manual schedule from Planning page",
          status: "scheduled",
        });
        console.log("API result:", JSON.stringify(res));
        setScheduleSubmitting(false);
        if (res.ok) {
          setScheduleModal(null);
          toast.success(
            "Đã tạo lịch thành công!",
            `"${subtasksMap[scheduleModal.taskId]?.find((s) => s.id === scheduleSubtaskId)?.title ?? "Task"}" được lên lịch.`
          );
        } else {
          toast.error("Không tạo được lịch", res.error);
        }
        return;
      }

      // Chọn "Whole task" → chia thời gian từ form theo estimatedMinutes của từng subtask (theo orderIndex)
      const subs = (subtasksMap[scheduleModal.taskId] ?? [])
        .slice()
        .sort((a, b) => a.orderIndex - b.orderIndex);

      if (subs.length === 0) {
        // Không có subtask → tạo 1 slot cho cả task
        const res = await createScheduleSlot(scheduleModal.taskId, {
          subTaskId: null,
          startTime: new Date(scheduleStart).toISOString(),
          endTime: new Date(scheduleEnd).toISOString(),
          originalStartTime: new Date(scheduleStart).toISOString(),
          isManualOverride: true,
          kbiasUsed: 0,
          explanation: scheduleExplanation || "Manual schedule from Planning page",
          status: "scheduled",
        });
        setScheduleSubmitting(false);
        if (res.ok) {
          setScheduleModal(null);
          toast.success(
            "Đã tạo lịch thành công!",
            `"${scheduleModal.taskTitle}" · ${new Date(scheduleStart).toLocaleTimeString("vi-VN", { hour: "2-digit", minute: "2-digit" })} — ${new Date(scheduleEnd).toLocaleTimeString("vi-VN", { hour: "2-digit", minute: "2-digit" })}`
          );
        } else {
          toast.error("Không tạo được lịch", res.error);
        }
        return;
      }

      // Chia thời gian từ scheduleStart → scheduleEnd theo tỉ lệ estimatedMinutes
      const totalStart = new Date(scheduleStart).getTime();
      const totalEnd = new Date(scheduleEnd).getTime();
      const totalRange = totalEnd - totalStart;
      const totalMinutes = subs.reduce((sum, s) => sum + (s.estimatedMinutes || 0), 0);

      if (totalMinutes === 0) {
        // Subtasks chưa có estimatedMinutes → fallback 1 slot cho cả task
        const res = await createScheduleSlot(scheduleModal.taskId, {
          subTaskId: null,
          startTime: new Date(scheduleStart).toISOString(),
          endTime: new Date(scheduleEnd).toISOString(),
          originalStartTime: new Date(scheduleStart).toISOString(),
          isManualOverride: true,
          kbiasUsed: 0,
          explanation: scheduleExplanation || "Manual schedule from Planning page",
          status: "scheduled",
        });
        setScheduleSubmitting(false);
        if (res.ok) {
          setScheduleModal(null);
          toast.success(
            "Đã tạo lịch thành công!",
            `"${scheduleModal.taskTitle}" · ${new Date(scheduleStart).toLocaleTimeString("vi-VN", { hour: "2-digit", minute: "2-digit" })} — ${new Date(scheduleEnd).toLocaleTimeString("vi-VN", { hour: "2-digit", minute: "2-digit" })}`
          );
        } else {
          toast.error("Không tạo được lịch", res.error);
        }
        return;
      }

      // Tạo slot cho từng subtask, mỗi slot chiếm tỉ lệ estimatedMinutes / totalMinutes
      let successCount = 0;
      let failedCount = 0;
      let cursor = totalStart;
      for (const sub of subs) {
        const minutes = sub.estimatedMinutes || 0;
        const sliceMs = (minutes / totalMinutes) * totalRange;
        const slotStart = cursor;
        const slotEnd = cursor + sliceMs;
        cursor = slotEnd;

        const res = await createScheduleSlot(scheduleModal.taskId, {
          subTaskId: sub.id,
          startTime: new Date(slotStart).toISOString(),
          endTime: new Date(slotEnd).toISOString(),
          originalStartTime: new Date(slotStart).toISOString(),
          isManualOverride: true,
          kbiasUsed: 0,
          explanation: scheduleExplanation || `Auto-scheduled for subtask "${sub.title}"`,
          status: "scheduled",
        });
        if (res.ok) successCount++;
        else failedCount++;
      }

      setScheduleSubmitting(false);
      if (failedCount === 0) {
        setScheduleModal(null);
        toast.success(
          "Đã tạo lịch thành công!",
          `${successCount} subtask đã được chia lịch từ ${new Date(scheduleStart).toLocaleTimeString("vi-VN", { hour: "2-digit", minute: "2-digit" })} đến ${new Date(scheduleEnd).toLocaleTimeString("vi-VN", { hour: "2-digit", minute: "2-digit" })}.`
        );
      } else {
        toast.error(
          "Tạo lịch chưa hoàn tất",
          `${successCount} thành công, ${failedCount} thất bại.`
        );
      }
    } catch (err) {
      console.error("Exception in handleScheduleSubmit:", err);
      setScheduleSubmitting(false);
    }
  }

  /* Load project */
  useEffect(() => {
    if (!projectId) return;
    let cancelled = false;
    setProjectLoading(true);
    setProjectError(null);
    void getProject(projectId).then((res) => {
      if (cancelled) return;
      if (res.ok) setProject(res.data);
      else setProjectError(res.error ?? "Failed to load project");
      setProjectLoading(false);
    });
    return () => { cancelled = true; };
  }, [projectId]);

  /* Load tasks */
  useEffect(() => {
    if (!projectId) return;
    let cancelled = false;
    setTasksLoading(true);
    setTasksError(null);
    void listTasks(projectId).then((res) => {
      if (cancelled) return;
      if (res.ok) setTasks(res.data);
      else setTasksError(res.error ?? "Failed to load tasks");
      setTasksLoading(false);
    });
    return () => { cancelled = true; };
  }, [projectId]);

  /* Load domains (1 lần khi mount, không phụ thuộc project) */
  useEffect(() => {
    let cancelled = false;
    void listDomains().then((res) => {
      if (cancelled) return;
      if (res.ok) setDomains(res.data);
      // Lỗi thì im lặng — domain là optional, vẫn cho tạo task bình thường
    });
    return () => { cancelled = true; };
  }, []);

  /* Load milestones */
  const loadMilestones = useCallback(() => {
    if (!projectId) return;
    setMilestonesLoading(true);
    setMilestonesError(null);
    void listMilestones(projectId).then((res) => {
      if (res.ok) setMilestones(res.data);
      else setMilestonesError(res.error ?? "Failed to load milestones");
      setMilestonesLoading(false);
    });
  }, [projectId]);

  useEffect(() => {
    loadMilestones();
  }, [loadMilestones]);

  /* Load subtasks when a task is expanded */
  const loadSubtasks = useCallback(
    (taskId: string) => {
      if (subtasksMap[taskId] !== undefined || subtasksLoading[taskId]) return;
      setSubtasksLoading((p) => ({ ...p, [taskId]: true }));
      void listSubtasks(taskId).then((res) => {
        setSubtasksMap((p) => ({ ...p, [taskId]: res.ok ? res.data : [] }));
        setSubtasksLoading((p) => ({ ...p, [taskId]: false }));
      });
    },
    [subtasksMap, subtasksLoading],
  );

  /* Toggle task expand */
  function toggleExpand(taskId: string) {
    setExpandedTasks((prev) => {
      const next = new Set(prev);
      if (next.has(taskId)) next.delete(taskId);
      else {
        next.add(taskId);
        loadSubtasks(taskId);
      }
      return next;
    });
  }

  /* KPI stats */
  const stats = useMemo(() => {
    const now = new Date();
    const overdue = tasks.filter(
      (t) => {
        if (!t.deadline || new Date(t.deadline) >= now) return false;
        const s = (t.status ?? "").toLowerCase();
        return s !== "done" && s !== "completed" && s !== "skipped";
      },
    ).length;
    const done = tasks.filter(
      (t) => {
        const s = (t.status ?? "").toLowerCase();
        return s === "done" || s === "completed";
      },
    ).length;
    const totalMins = tasks.reduce(
      (acc, t) => acc + (t.estimatedMinutes || 0),
      0,
    );
    const subtaskCount = Object.values(subtasksMap).flat().length;
    return {
      totalTasks: tasks.length,
      doneTasks: done,
      overdueTasks: overdue,
      totalSubtasks: subtaskCount,
      totalHours: Math.round(totalMins / 60),
      completionPct: tasks.length > 0 ? Math.round((done / tasks.length) * 100) : 0,
    };
  }, [tasks, subtasksMap]);

  /* ---- Create Task ---- */
  async function handleCreateTask(data: CreateTaskRequest) {
    if (!projectId) return;
    setSubmitting(true);
    setError(null);
    const res = await createTask(projectId, data);
    setSubmitting(false);
    if (res.ok) {
      setTasks((prev) => [res.data, ...prev]);
      setShowCreateTask(false);

      // Auto-tạo schedule slot nếu task có deadline hoặc fixedStart/fixedEnd
      const task = res.data;
      const hasDeadline = !!task.deadline;
      const hasFixedTime = !!task.fixedStart && !!task.fixedEnd;

      if (hasDeadline || hasFixedTime) {
        const slotData: CreateScheduleSlotRequest = {
          subTaskId: null,
          startTime: task.fixedStart ?? task.deadline ?? new Date().toISOString(),
          endTime: task.fixedEnd ?? task.deadline ?? new Date().toISOString(),
          originalStartTime: task.deadline ?? null,
          isManualOverride: false,
          kbiasUsed: 0,
          explanation: `Auto-scheduled from task creation`,
          status: "scheduled",
        };
        void createScheduleSlot(task.id, slotData);
      }
    } else {
      setError(res.error ?? "Failed to create task");
    }
  }

  /* ---- Create Milestone ---- */
  async function handleCreateMilestone(data: CreateMilestoneRequest) {
    if (!projectId) return;
    setSubmittingMilestone(true);
    setError(null);
    const res = await createMilestone(projectId, data);
    setSubmittingMilestone(false);
    if (res.ok) {
      setMilestones((prev) => {
        const next = [...prev, res.data];
        next.sort((a, b) => a.orderIndex - b.orderIndex);
        return next;
      });
      setShowCreateMilestone(false);
    } else {
      setError(res.error ?? "Failed to create milestone");
    }
  }

  /* ---- Create Subtask ---- */
  async function handleCreateSubtask(taskId: string, data: CreateSubtaskRequest) {
    setSubtaskFormLoading(true);
    const res = await createSubtask(taskId, data);
    setSubtaskFormLoading(false);
    if (res.ok) {
      setSubtasksMap((prev) => ({
        ...prev,
        [taskId]: [...(prev[taskId] ?? []), res.data],
      }));
      setSubtaskFormTaskId(null);

      // Auto-tạo schedule slot nếu subtask có scheduledStart/scheduledEnd
      const subtask = res.data;
      if (subtask.scheduledStart && subtask.scheduledEnd) {
        const slotData: CreateScheduleSlotRequest = {
          subTaskId: subtask.id,
          startTime: subtask.scheduledStart,
          endTime: subtask.scheduledEnd,
          originalStartTime: subtask.scheduledStart,
          isManualOverride: false,
          kbiasUsed: 0,
          explanation: `Auto-scheduled from subtask creation`,
          status: "scheduled",
        };
        void createScheduleSlot(taskId, slotData);
      }
    }
  }

  /* ---- Delete Task ---- */
  async function confirmDeleteTask() {
    if (!deleteTarget || deleteTarget.kind !== "task") return;
    setDeleteLoading(true);
    const res = await deleteTask(deleteTarget.id);
    setDeleteLoading(false);
    if (res.ok) {
      setTasks((prev) => prev.filter((t) => t.id !== deleteTarget.id));
      setDeleteTarget(null);
    }
  }

  /* ---- Delete Subtask ---- */
  async function confirmDeleteSubtask() {
    if (!deleteTarget || deleteTarget.kind !== "subtask") return;
    setDeleteLoading(true);
    const res = await deleteSubtask(deleteTarget.id);
    setDeleteLoading(false);
    if (res.ok) {
      setSubtasksMap((prev) => {
        const next = { ...prev };
        for (const k of Object.keys(next)) {
          next[k] = next[k].filter((s) => s.id !== deleteTarget.id);
        }
        return next;
      });
      setDeleteTarget(null);
    }
  }

  /* ---- Delete Milestone ---- */
  async function confirmDeleteMilestone() {
    if (!deleteTarget || deleteTarget.kind !== "milestone") return;
    setDeleteLoading(true);
    const res = await deleteMilestone(deleteTarget.id);
    setDeleteLoading(false);
    if (res.ok) {
      setMilestones((prev) => prev.filter((m) => m.id !== deleteTarget.id));
      // Bỏ liên kết task thuộc milestone này
      setTasks((prev) =>
        prev.map((t) => (t.milestoneId === deleteTarget.id ? { ...t, milestoneId: null } : t)),
      );
      setDeleteTarget(null);
    }
  }

  function goBack() {
    navigate(`/projects/${projectId}`);
  }

  return (
    <section className="plan">
      <div className="plan-ambient plan-ambient--left" aria-hidden="true" />
      <div className="plan-ambient plan-ambient--right" aria-hidden="true" />

      <div className="plan-container">
        {/* Top bar */}
        <div className="plan-topbar">
          <div className="plan-topbar-left">
            <button type="button" className="plan-icon-btn" onClick={goBack} aria-label="Back to project">
              <span className="material-symbols-outlined">arrow_back</span>
            </button>
            <div className="plan-breadcrumb">
              <Link to="/projects" className="plan-breadcrumb-link">Projects</Link>
              <span className="plan-breadcrumb-sep">/</span>
              <span className="plan-breadcrumb-current">
                {projectLoading ? "…" : project?.name ?? "Project"}
              </span>
              <span className="plan-breadcrumb-sep">/</span>
              <span className="plan-breadcrumb-current plan-breadcrumb-current--active">Planning</span>
            </div>
          </div>

          <div className="plan-topbar-right">
            {projectId && (
              <Link
                to={`/projects/${projectId}/schedule`}
                className="plan-btn plan-btn--ghost"
              >
                <span className="material-symbols-outlined plan-btn-icon">calendar_month</span>
                <span>View schedule</span>
              </Link>
            )}
            <button
              type="button"
              className="plan-btn plan-btn--ghost"
              onClick={() => setShowCreateMilestone(true)}
            >
              <span className="material-symbols-outlined plan-btn-icon">flag</span>
              <span>New milestone</span>
            </button>
            <button
              type="button"
              className="plan-btn plan-btn--primary"
              onClick={() => setShowCreateTask(true)}
            >
              <span className="material-symbols-outlined plan-btn-icon">add</span>
              <span>New task</span>
            </button>
          </div>
        </div>

        {/* Loading project */}
        {projectLoading && (
          <div className="plan-state" role="status">
            <span className="material-symbols-outlined plan-state-icon plan-state-icon--spin">progress_activity</span>
            <p>Loading project…</p>
          </div>
        )}

        {/* Error project */}
        {!projectLoading && projectError && (
          <div className="plan-state plan-state--error" role="alert">
            <span className="material-symbols-outlined plan-state-icon">error</span>
            <h2>Something went wrong</h2>
            <p>{projectError}</p>
            <button type="button" className="plan-btn plan-btn--primary" onClick={goBack}>
              <span className="material-symbols-outlined plan-btn-icon">arrow_back</span>
              <span>Go back</span>
            </button>
          </div>
        )}

        {/* Main content */}
        {!projectLoading && !projectError && project && (
          <>
            {/* KPI strip */}
            <div className="plan-kpi">
              <KpiCard label="Tasks" value={stats.totalTasks} icon="task_alt" tone="primary" />
              <KpiCard label="Subtasks" value={stats.totalSubtasks} icon="check_box" tone="default" />
              <KpiCard
                label="Completion"
                value={`${stats.completionPct}%`}
                icon="trending_up"
                tone={stats.completionPct >= 50 ? "secondary" : "muted"}
              />
              <KpiCard
                label="Overdue"
                value={stats.overdueTasks}
                icon="warning"
                tone={stats.overdueTasks > 0 ? "error" : "muted"}
              />
              <KpiCard label="Total hours" value={stats.totalHours} icon="schedule" tone="tertiary" />
            </div>

            {/* Task list */}
            <div className="plan-content">
              {/* Milestone strip */}
              <MilestoneStrip
                milestones={milestones}
                loading={milestonesLoading}
                error={milestonesError}
                onCreate={() => setShowCreateMilestone(true)}
                onDelete={(m) => setDeleteTarget({ kind: "milestone", id: m.id, title: m.name })}
              />

              <div className="plan-section-head">
                <div>
                  <span className="plan-section-eyebrow">Task list</span>
                  <h2 className="plan-section-title">
                    {stats.totalTasks > 0
                      ? `${stats.totalTasks} task${stats.totalTasks !== 1 ? "s" : ""}`
                      : "No tasks yet"}
                  </h2>
                  {stats.totalTasks === 0 && (
                    <p className="plan-section-sub">
                      {milestones.length === 0
                        ? <>Create a <strong>milestone</strong> first to group tasks by phase, then click <strong>"New task"</strong> to start decomposing this project.</>
                        : <>Click <strong>"New task"</strong> to create your first task and start decomposing this project.</>}
                    </p>
                  )}
                </div>
              </div>

              {tasksLoading ? (
                <div className="plan-state">
                  <span className="material-symbols-outlined plan-state-icon plan-state-icon--spin">progress_activity</span>
                  <p>Loading tasks…</p>
                </div>
              ) : tasksError ? (
                <div className="plan-state plan-state--error">
                  <span className="material-symbols-outlined plan-state-icon">error</span>
                  <p>{tasksError}</p>
                  <button
                    type="button"
                    className="plan-btn plan-btn--ghost"
                    onClick={() => {
                      if (!projectId) return;
                      setTasksError(null);
                      setTasksLoading(true);
                      void listTasks(projectId).then((res) => {
                        setTasksLoading(false);
                        if (res.ok) setTasks(res.data);
                        else setTasksError(res.error ?? "Failed to load tasks");
                      });
                    }}
                  >
                    Retry
                  </button>
                </div>
              ) : tasks.length === 0 ? (
                <div className="plan-empty">
                  <span className="material-symbols-outlined">task</span>
                  <p>No tasks in this project yet.</p>
                </div>
              ) : (
                <div className="plan-task-list">
                  {tasks.map((task) => (
                    <TaskItem
                      key={task.id}
                      task={task}
                      isExpanded={expandedTasks.has(task.id)}
                      onToggleExpand={() => toggleExpand(task.id)}
                      subtasks={subtasksMap[task.id] ?? (subtasksLoading[task.id] ? undefined : [])}
                      subtasksLoading={subtasksLoading[task.id] ?? false}
                      onAddSubtask={() => setSubtaskFormTaskId(task.id)}
                      isSubtaskFormOpen={subtaskFormTaskId === task.id}
                      onCloseSubtaskForm={() => setSubtaskFormTaskId(null)}
                      onCreateSubtask={(data) => handleCreateSubtask(task.id, data)}
                      subtaskFormLoading={subtaskFormLoading}
                      onDelete={(kind, id, title) => setDeleteTarget({ kind, id, title })}
                      onSchedule={(taskId, taskTitle) => openScheduleModal(taskId, taskTitle)}
                    />
                  ))}
                </div>
              )}
            </div>
          </>
        )}
      </div>

      {/* Create Task Modal */}
      {showCreateTask && (
        <CreateTaskModal
          onClose={() => setShowCreateTask(false)}
          onSubmit={handleCreateTask}
          submitting={submitting}
          error={error}
          milestones={milestones}
          domains={domains}
          onCreateMilestone={() => {
            setShowCreateTask(false);
            setShowCreateMilestone(true);
          }}
        />
      )}

      {/* Create Milestone Modal */}
      {showCreateMilestone && (
        <CreateMilestoneModal
          onClose={() => setShowCreateMilestone(false)}
          onSubmit={handleCreateMilestone}
          submitting={submittingMilestone}
          error={error}
          existingCount={milestones.length}
        />
      )}

      {/* Delete Confirm */}
      {deleteTarget && (
        <DeleteConfirmModal
          kind={deleteTarget.kind}
          title={deleteTarget.title}
          loading={deleteLoading}
          onConfirm={
            deleteTarget.kind === "task"
              ? confirmDeleteTask
              : deleteTarget.kind === "subtask"
                ? confirmDeleteSubtask
                : confirmDeleteMilestone
          }
          onClose={() => setDeleteTarget(null)}
        />
      )}

      {/* Schedule Modal */}
      {scheduleModal && (
        <div className="plan-modal-overlay" role="presentation" onMouseDown={(e) => e.target === e.currentTarget && setScheduleModal(null)}>
          <div className="plan-modal" role="dialog" aria-modal="true" aria-labelledby="schedule-modal-title">
            <div className="plan-modal__head">
              <div>
                <span className="plan-card__eyebrow">Schedule Task</span>
                <h2 className="plan-card__title" id="schedule-modal-title">{scheduleModal.taskTitle}</h2>
              </div>
              <button type="button" className="plan-icon-btn" aria-label="Close" onClick={() => setScheduleModal(null)}>
                <span className="material-symbols-outlined">close</span>
              </button>
            </div>

            <div className="plan-modal__body">
              {/* Subtask dropdown - chỉ hiện nếu task có subtasks */}
              {(() => {
                const subs = subtasksMap[scheduleModal.taskId] ?? [];
                if (subs.length > 0) {
                  return (
                    <div className="plan-form-group">
                      <label htmlFor="schedule-subtask">Subtask (optional)</label>
                      <select
                        id="schedule-subtask"
                        className="plan-input"
                        value={scheduleSubtaskId ?? ""}
                        onChange={(e) => setScheduleSubtaskId(e.target.value || null)}
                      >
                        <option value="">— Whole task —</option>
                        {subs.map((s) => (
                          <option key={s.id} value={s.id}>
                            {s.title}
                          </option>
                        ))}
                      </select>
                    </div>
                  );
                }
                return null;
              })()}

              <div className="plan-form-row">
                <div className="plan-form-group">
                  <label htmlFor="schedule-start">Start Time</label>
                  <input
                    id="schedule-start"
                    type="datetime-local"
                    className="plan-input"
                    value={scheduleStart}
                    onChange={(e) => setScheduleStart(e.target.value)}
                  />
                </div>
                <div className="plan-form-group">
                  <label htmlFor="schedule-end">End Time</label>
                  <input
                    id="schedule-end"
                    type="datetime-local"
                    className="plan-input"
                    value={scheduleEnd}
                    onChange={(e) => setScheduleEnd(e.target.value)}
                  />
                </div>
              </div>
              <div className="plan-form-group">
                <label htmlFor="schedule-explanation">Notes (optional)</label>
                <input
                  id="schedule-explanation"
                  type="text"
                  className="plan-input"
                  placeholder="Why this time slot?"
                  value={scheduleExplanation}
                  onChange={(e) => setScheduleExplanation(e.target.value)}
                />
              </div>
            </div>

            <div className="plan-modal__actions">
              <button type="button" className="plan-btn plan-btn--soft" onClick={() => setScheduleModal(null)}>
                Cancel
              </button>
              <button
                type="button"
                className="plan-btn plan-btn--primary"
                onClick={handleScheduleSubmit}
                disabled={scheduleSubmitting || !scheduleStart || !scheduleEnd}
              >
                {scheduleSubmitting ? "Scheduling..." : "Schedule"}
              </button>
            </div>
          </div>
        </div>
      )}

      <CenterToasts toasts={toasts} onDismiss={toastDismiss} />
    </section>
  );
}

/* ============================================================
 * KpiCard
 * ============================================================ */
function KpiCard({
  label,
  value,
  icon,
  tone = "default",
}: {
  label: string;
  value: string | number;
  icon: string;
  tone?: "default" | "primary" | "secondary" | "tertiary" | "error" | "muted";
}) {
  return (
    <div className="plan-kpi-card">
      <div className={`plan-kpi-icon plan-kpi-icon--${tone}`}>
        <span className="material-symbols-outlined">{icon}</span>
      </div>
      <div className="plan-kpi-text">
        <span className="plan-kpi-label">{label}</span>
        <span className="plan-kpi-value">{value}</span>
      </div>
    </div>
  );
}

/* ============================================================
 * TaskItem — collapsible, contains subtasks
 * ============================================================ */
interface TaskItemProps {
  task: TaskDto;
  isExpanded: boolean;
  onToggleExpand: () => void;
  subtasks?: SubtaskDto[];
  subtasksLoading: boolean;
  onAddSubtask: () => void;
  isSubtaskFormOpen: boolean;
  onCloseSubtaskForm: () => void;
  onCreateSubtask: (data: CreateSubtaskRequest) => void;
  subtaskFormLoading: boolean;
  onDelete: (kind: "task" | "subtask", id: string, title: string) => void;
  onSchedule: (taskId: string, taskTitle: string) => void;
}

function TaskItem({
  task,
  isExpanded,
  onToggleExpand,
  subtasks,
  subtasksLoading,
  onAddSubtask,
  isSubtaskFormOpen,
  onCloseSubtaskForm,
  onCreateSubtask,
  subtaskFormLoading,
  onDelete,
  onSchedule,
}: TaskItemProps) {
  const tone = taskStatusTone(task.status);
  const taskStatusLower = (task.status ?? "").toLowerCase();
  const isDone = taskStatusLower === "done" || taskStatusLower === "completed";
  const doneSubtasks = subtasks?.filter(
    (s) => {
      const ss = (s.status ?? "").toLowerCase();
      return ss === "done" || ss === "completed";
    },
  ).length ?? 0;
  const totalSubtasks = subtasks?.length ?? 0;
  const subtaskProgress =
    totalSubtasks > 0 ? Math.round((doneSubtasks / totalSubtasks) * 100) : 0;

  return (
    <div
      className={`plan-task ${isDone ? "plan-task--done" : ""}`}
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData("application/x-metanoia-task", JSON.stringify({
          taskId: task.id,
          taskTitle: task.title,
          projectId: task.projectId,
        }));
        e.dataTransfer.effectAllowed = "move";
      }}
    >
      {/* Task header row */}
      <div className="plan-task-head">
        <button
          type="button"
          className="plan-task-expand"
          onClick={onToggleExpand}
          aria-expanded={isExpanded}
          aria-label={isExpanded ? "Collapse task" : "Expand task"}
        >
          <span
            className={`material-symbols-outlined plan-task-expand-icon ${isExpanded ? "plan-task-expand-icon--open" : ""}`}
          >
            chevron_right
          </span>
        </button>

        <div className="plan-task-info" onClick={onToggleExpand} role="button" tabIndex={0} onKeyDown={(e) => e.key === "Enter" && onToggleExpand()}>
          <div className="plan-task-title-row">
            <span className={`plan-task-title ${isDone ? "plan-task-title--done" : ""}`}>
              {task.title}
            </span>
            {task.taskType && (
              <span className="plan-task-type">{taskTypeLabel(task.taskType)}</span>
            )}
            <span className={`plan-task-status plan-task-status--${tone}`}>
              {prettyTaskStatus(task.status)}
            </span>
          </div>

          {task.description && (
            <p className="plan-task-desc">{task.description}</p>
          )}

          <div className="plan-task-meta">
            {task.deadline && (
              <span className="plan-task-meta-item">
                <span className="material-symbols-outlined">event</span>
                {formatDate(task.deadline)}
              </span>
            )}
            {task.estimatedMinutes > 0 && (
              <span className="plan-task-meta-item">
                <span className="material-symbols-outlined">schedule</span>
                {formatMinutes(task.estimatedMinutes)}
              </span>
            )}
            {totalSubtasks > 0 && (
              <span className="plan-task-meta-item">
                <span className="material-symbols-outlined">check_box</span>
                {doneSubtasks}/{totalSubtasks}
              </span>
            )}
          </div>

          {/* Subtask mini progress bar */}
          {totalSubtasks > 0 && (
            <div className="plan-task-progress">
              <div
                className="plan-task-progress-fill"
                style={{ width: `${subtaskProgress}%` }}
              />
            </div>
          )}
        </div>

        {/* Actions */}
        <div className="plan-task-actions">
          <button
            type="button"
            className="plan-task-action"
            title="Schedule task"
            onClick={() => onSchedule(task.id, task.title)}
          >
            <span className="material-symbols-outlined">event</span>
          </button>
          <button
            type="button"
            className="plan-task-action"
            title="Delete task"
            onClick={() => onDelete("task", task.id, task.title)}
          >
            <span className="material-symbols-outlined">delete</span>
          </button>
        </div>
      </div>

      {/* Subtasks section */}
      {isExpanded && (
        <div className="plan-subtasks">
          {/* Subtask list */}
          {subtasksLoading ? (
            <div className="plan-subtask-loading">
              <span className="material-symbols-outlined plan-state-icon--spin">progress_activity</span>
              <span>Loading subtasks…</span>
            </div>
          ) : subtasks && subtasks.length > 0 ? (
            <ul className="plan-subtask-list">
              {subtasks.map((s) => (
                <SubtaskRow
                  key={s.id}
                  subtask={s}
                  onDelete={() => onDelete("subtask", s.id, s.title)}
                />
              ))}
            </ul>
          ) : (
            <div className="plan-subtask-empty">
              <span>No subtasks yet.</span>
            </div>
          )}

          {/* Inline create subtask form */}
          {isSubtaskFormOpen ? (
            <InlineSubtaskForm
              onSubmit={onCreateSubtask}
              onCancel={onCloseSubtaskForm}
              loading={subtaskFormLoading}
            />
          ) : (
            <button
              type="button"
              className="plan-add-subtask"
              onClick={onAddSubtask}
            >
              <span className="material-symbols-outlined">add</span>
              <span>Add subtask</span>
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/* ============================================================
 * SubtaskRow
 * ============================================================ */
function SubtaskRow({
  subtask,
  onDelete,
}: {
  subtask: SubtaskDto;
  onDelete: () => void;
}) {
  const tone = subtaskStatusTone(subtask.status);
  const isDone = (() => {
    const s = (subtask.status ?? "").toLowerCase();
    return s === "done" || s === "completed";
  })();

  return (
    <li className={`plan-subtask ${isDone ? "plan-subtask--done" : ""}`}>
      <span className={`plan-subtask-check ${isDone ? "plan-subtask-check--done" : ""}`}>
        <span className="material-symbols-outlined">
          {isDone ? "check_circle" : "radio_button_unchecked"}
        </span>
      </span>
      <div className="plan-subtask-info">
        <span className={`plan-subtask-title ${isDone ? "plan-subtask-title--done" : ""}`}>
          {subtask.title}
        </span>
        {subtask.estimatedMinutes > 0 && (
          <span className="plan-subtask-meta">
            <span className="material-symbols-outlined">schedule</span>
            {formatMinutes(subtask.estimatedMinutes)}
          </span>
        )}
        {subtask.scheduledStart && (
          <span className="plan-subtask-meta">
            <span className="material-symbols-outlined">event</span>
            {formatDate(subtask.scheduledStart)}
          </span>
        )}
      </div>
      <div className="plan-subtask-actions">
        <span className={`plan-subtask-status plan-subtask-status--${tone}`}>
          {subtask.status}
        </span>
        <button
          type="button"
          className="plan-task-action plan-task-action--sm"
          title="Delete subtask"
          onClick={onDelete}
        >
          <span className="material-symbols-outlined">delete</span>
        </button>
      </div>
    </li>
  );
}

/* ============================================================
 * InlineSubtaskForm
 * ============================================================ */
function InlineSubtaskForm({
  onSubmit,
  onCancel,
  loading,
}: {
  onSubmit: (data: CreateSubtaskRequest) => void;
  onCancel: () => void;
  loading: boolean;
}) {
  const [title, setTitle] = useState("");
  const [estimatedMinutes, setEstimatedMinutes] = useState("");
  const [status, setStatus] = useState("todo");

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!title.trim()) return;
    onSubmit({
      title: title.trim(),
      estimatedMinutes: estimatedMinutes ? parseInt(estimatedMinutes, 10) : 0,
      orderIndex: 0,
      status,
    });
  }

  return (
    <form className="plan-subtask-form" onSubmit={handleSubmit}>
      <div className="plan-subtask-form-row">
        <input
          type="text"
          className="plan-input"
          placeholder="Subtask title…"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          required
          autoFocus
        />
        <input
          type="number"
          className="plan-input plan-input--sm"
          placeholder="Minutes"
          min="0"
          value={estimatedMinutes}
          onChange={(e) => setEstimatedMinutes(e.target.value)}
        />
        <select
          className="plan-input plan-input--sm"
          value={status}
          onChange={(e) => setStatus(e.target.value)}
        >
          <option value="todo">todo</option>
          <option value="scheduled">scheduled</option>
          <option value="inprogress">inprogress</option>
          <option value="done">done</option>
          <option value="skipped">skipped</option>
        </select>
        <button type="submit" className="plan-btn plan-btn--primary" disabled={loading || !title.trim()}>
          {loading ? "…" : "Add"}
        </button>
        <button type="button" className="plan-btn plan-btn--ghost" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}

/* ============================================================
 * CreateTaskModal
 * ============================================================ */
function CreateTaskModal({
  onClose,
  onSubmit,
  submitting,
  error,
  milestones,
  domains,
  onCreateMilestone,
}: {
  onClose: () => void;
  onSubmit: (data: CreateTaskRequest) => void;
  submitting: boolean;
  error: string | null;
  milestones: MilestoneDto[];
  domains: DomainDto[];
  onCreateMilestone: () => void;
}) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [taskType, setTaskType] = useState("Flexible");
  const [status, setStatus] = useState("ToDo");
  const [milestoneId, setMilestoneId] = useState<string>(milestones[0]?.id ?? "");
  const [domainId, setDomainId] = useState<string>(""); // "" = null khi submit
  // Custom dropdown Domain state
  const [domainOpen, setDomainOpen] = useState(false);
  const [domainQuery, setDomainQuery] = useState("");
  const domainComboRef = useRef<HTMLDivElement | null>(null);
  // Tên domain đang được chọn (dùng để hiển thị nút toggle + clear)
  const selectedDomainName = domains.find((d) => d.id === domainId)?.name ?? "";
  // Danh sách domain đã lọc theo query
  const filteredDomains = useMemo(() => {
    const q = domainQuery.trim().toLowerCase();
    if (!q) return domains;
    return domains.filter((d) => d.name.toLowerCase().includes(q));
  }, [domains, domainQuery]);
  const [deadline, setDeadline] = useState("");
  const [estimatedMinutes, setEstimatedMinutes] = useState("");
  const [fixedStart, setFixedStart] = useState("");
  const [fixedEnd, setFixedEnd] = useState("");

  const hasMilestone = milestones.length > 0;

  /**
   * datetime-local trả về "YYYY-MM-DDTHH:mm" (không có timezone, không có millis).
   * BE Swagger yêu cầu ISO 8601 đầy đủ kiểu "2026-10-16T05:58:27.043Z" — UTC.
   * → convert sang UTC ISO 8601 trước khi gửi.
   */
  // Click-outside để đóng dropdown Domain
  useEffect(() => {
    if (!domainOpen) return;
    function onDown(e: MouseEvent) {
      const el = domainComboRef.current;
      if (el && !el.contains(e.target as Node)) {
        setDomainOpen(false);
      }
    }
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [domainOpen]);

  // Reset query khi mở/đóng
  useEffect(() => {
    if (!domainOpen) setDomainQuery("");
  }, [domainOpen]);
  function toUtcIso(local: string): string | null {
    if (!local) return null;
    const d = new Date(local);
    if (isNaN(d.getTime())) return null;
    return d.toISOString();
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!title.trim()) return;
    if (!hasMilestone) return; // guard: chặn submit khi chưa có milestone
    const payload: CreateTaskRequest = {
      title: title.trim(),
      description: description.trim() || undefined,
      taskType,
      status,
      milestoneId: milestoneId || null,
      domainId: domainId || null, // Manual decompose: optional, null nếu không chọn
      deadline: toUtcIso(deadline),
      estimatedMinutes: estimatedMinutes ? parseInt(estimatedMinutes, 10) : 0,
      // Manual decompose: không phải AI estimate — bỏ field
      fixedStart: taskType === "Fixed" ? toUtcIso(fixedStart) : null,
      fixedEnd: taskType === "Fixed" ? toUtcIso(fixedEnd) : null,
    };
    // DEBUG: in payload thực tế gửi lên BE
    // eslint-disable-next-line no-console
    console.log("[CreateTask] payload =", JSON.stringify(payload, null, 2));
    onSubmit(payload);
  }

  return (
    <div className="plan-modal-backdrop" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="plan-modal" role="dialog" aria-modal="true" aria-labelledby="modal-title">
        <div className="plan-modal-head">
          <div>
            <span className="plan-modal-eyebrow">New task</span>
            <h2 className="plan-modal-title" id="modal-title">Create task</h2>
          </div>
          <button type="button" className="plan-modal-close" onClick={onClose} aria-label="Close">
            <span className="material-symbols-outlined">close</span>
          </button>
        </div>

        <form className="plan-form" onSubmit={handleSubmit}>
          <div className="plan-field">
            <label className="plan-label" htmlFor="task-title">Title *</label>
            <input
              id="task-title"
              type="text"
              className="plan-input"
              placeholder="e.g. Design login screen"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              required
              autoFocus
            />
          </div>

          <div className="plan-field">
            <label className="plan-label" htmlFor="task-desc">Description</label>
            <textarea
              id="task-desc"
              className="plan-input plan-input--textarea"
              placeholder="Optional details…"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={3}
            />
          </div>

          {!hasMilestone && (
            <div className="plan-milestone-required">
              <span className="material-symbols-outlined">flag</span>
              <div>
                <strong>Create a milestone first.</strong>
                <p>Tasks need to belong to a milestone (phase) of the project.</p>
              </div>
              <button
                type="button"
                className="plan-btn plan-btn--primary plan-btn--sm"
                onClick={onCreateMilestone}
              >
                <span className="material-symbols-outlined plan-btn-icon">add</span>
                New milestone
              </button>
            </div>
          )}

          <div className="plan-field-row">
            <div className="plan-field">
              <label className="plan-label" htmlFor="task-milestone">Milestone *</label>
              <select
                id="task-milestone"
                className="plan-input"
                value={milestoneId}
                onChange={(e) => setMilestoneId(e.target.value)}
                disabled={!hasMilestone}
                required
              >
                {hasMilestone ? (
                  milestones.map((m) => (
                    <option key={m.id} value={m.id}>
                      #{m.orderIndex} — {m.name}
                    </option>
                  ))
                ) : (
                  <option value="">— No milestones yet —</option>
                )}
              </select>
            </div>
          </div>

          <div className="plan-field">
            <label className="plan-label" htmlFor="task-domain">
              Domain <span className="plan-label-optional">(optional)</span>
            </label>

            {/* Custom searchable dropdown */}
            <div
              className={`plan-domain-combo ${domainOpen ? "is-open" : ""}`}
              ref={domainComboRef}
            >
              <button
                type="button"
                id="task-domain"
                className="plan-input plan-domain-trigger"
                onClick={() =>
                  domains.length > 0 && setDomainOpen((v) => !v)
                }
                disabled={domains.length === 0}
              >
                <span
                  className={
                    selectedDomainName
                      ? "plan-domain-trigger__value"
                      : "plan-domain-trigger__placeholder"
                  }
                >
                  {selectedDomainName || "— No domain —"}
                </span>
                <span className="plan-domain-trigger__icons">
                  {selectedDomainName && (
                    <span
                      className="plan-domain-trigger__icon"
                      role="button"
                      aria-label="Clear domain"
                      onClick={(e) => {
                        e.stopPropagation();
                        setDomainId("");
                        setDomainQuery("");
                      }}
                    >
                      <span className="material-symbols-outlined">close</span>
                    </span>
                  )}
                  <span className="plan-domain-trigger__icon">
                    <span className="material-symbols-outlined">
                      {domainOpen ? "expand_less" : "expand_more"}
                    </span>
                  </span>
                </span>
              </button>

              {domainOpen && (
                <div className="plan-domain-popover" role="listbox">
                  <div className="plan-domain-search">
                    <span className="material-symbols-outlined">search</span>
                    <input
                      type="text"
                      autoFocus
                      placeholder="Search domains…"
                      value={domainQuery}
                      onChange={(e) => setDomainQuery(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Escape") setDomainOpen(false);
                      }}
                    />
                  </div>
                  <div className="plan-domain-list">
                    {filteredDomains.length === 0 ? (
                      <div className="plan-domain-empty">
                        {domains.length === 0
                          ? "No domains available"
                          : `No match for “${domainQuery}”`}
                      </div>
                    ) : (
                      filteredDomains.map((d) => (
                        <button
                          type="button"
                          key={d.id}
                          className={`plan-domain-option ${
                            d.id === domainId ? "is-selected" : ""
                          }`}
                          onClick={() => {
                            setDomainId(d.id);
                            setDomainQuery("");
                            setDomainOpen(false);
                          }}
                          role="option"
                          aria-selected={d.id === domainId}
                        >
                          <span className="plan-domain-option__check">
                            {d.id === domainId ? (
                              <span className="material-symbols-outlined">
                                check
                              </span>
                            ) : null}
                          </span>
                          <span className="plan-domain-option__name">
                            {d.name}
                          </span>
                        </button>
                      ))
                    )}
                  </div>
                  <div className="plan-domain-foot">
                    {filteredDomains.length}/{domains.length} domains
                  </div>
                </div>
              )}
            </div>

            {domains.length === 0 && (
              <span className="plan-field-hint">No domains available — leave empty.</span>
            )}
          </div>

          <div className="plan-field-row">
            <div className="plan-field">
              <label className="plan-label" htmlFor="task-type">Task type</label>
              <select
                id="task-type"
                className="plan-input"
                value={taskType}
                onChange={(e) => {
                  const v = e.target.value;
                  setTaskType(v);
                  // Đổi sang flexible: xoá luôn start/end trong state
                  // (payload khi submit vốn đã trả null, nhưng reset để UX sạch)
                  if (v === "flexible") {
                    setFixedStart("");
                    setFixedEnd("");
                  }
                }}
              >
                <option value="Flexible">Flexible</option>
                <option value="Fixed">Fixed</option>
              </select>
            </div>

            <div className="plan-field">
              <label className="plan-label" htmlFor="task-status">Status</label>
              <select
                id="task-status"
                className="plan-input"
                value={status}
                onChange={(e) => setStatus(e.target.value)}
              >
                <option value="ToDo">ToDo</option>
                <option value="Scheduled">Scheduled</option>
                <option value="InProgress">InProgress</option>
                <option value="Done">Done</option>
                <option value="Skipped">Skipped</option>
              </select>
            </div>
          </div>

          <div className="plan-field-row">
            <div className="plan-field">
              <label className="plan-label" htmlFor="task-deadline">Deadline</label>
              <input
                id="task-deadline"
                type="datetime-local"
                className="plan-input"
                value={deadline}
                onChange={(e) => setDeadline(e.target.value)}
              />
            </div>

            <div className="plan-field">
              <label className="plan-label" htmlFor="task-mins">Est. minutes</label>
              <input
                id="task-mins"
                type="number"
                className="plan-input"
                placeholder="e.g. 120"
                min="0"
                value={estimatedMinutes}
                onChange={(e) => setEstimatedMinutes(e.target.value)}
              />
            </div>
          </div>

          {taskType === "Fixed" && (
            <div className="plan-field-row">
              <div className="plan-field">
                <label className="plan-label" htmlFor="task-fixed-start">
                  Fixed start *
                </label>
                <input
                  id="task-fixed-start"
                  type="datetime-local"
                  className="plan-input"
                  value={fixedStart}
                  onChange={(e) => setFixedStart(e.target.value)}
                  required
                />
              </div>
              <div className="plan-field">
                <label className="plan-label" htmlFor="task-fixed-end">
                  Fixed end *
                </label>
                <input
                  id="task-fixed-end"
                  type="datetime-local"
                  className="plan-input"
                  value={fixedEnd}
                  onChange={(e) => setFixedEnd(e.target.value)}
                  required
                />
              </div>
            </div>
          )}

          {error && (
            <div className="plan-form-error">
              <span className="material-symbols-outlined">error</span>
              {error}
            </div>
          )}

          <div className="plan-form-actions">
            <button type="button" className="plan-btn plan-btn--ghost" onClick={onClose}>
              Cancel
            </button>
            <button
              type="submit"
              className="plan-btn plan-btn--primary"
              disabled={submitting || !title.trim() || !hasMilestone || (taskType === "Fixed" && (!fixedStart || !fixedEnd))}
            >
              {submitting ? (
                <>
                  <span className="material-symbols-outlined plan-state-icon--spin">progress_activity</span>
                  Creating…
                </>
              ) : (
                <>
                  <span className="material-symbols-outlined">add</span>
                  Create task
                </>
              )}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

/* ============================================================
 * DeleteConfirmModal
 * ============================================================ */
function DeleteConfirmModal({
  kind,
  title,
  loading,
  onConfirm,
  onClose,
}: {
  kind: "task" | "subtask" | "milestone";
  title: string;
  loading: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const desc =
    kind === "task"
      ? "This will also delete all subtasks inside. This action cannot be undone."
      : kind === "subtask"
        ? "This action cannot be undone."
        : "Tasks in this milestone will become unassigned. This action cannot be undone.";
  return (
    <div className="plan-modal-backdrop" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="plan-modal plan-modal--sm" role="alertdialog" aria-modal="true">
        <div className="plan-modal-head">
          <div>
            <span className="plan-modal-eyebrow plan-modal-eyebrow--danger">Delete {kind}</span>
            <h2 className="plan-modal-title">Delete "{title}"?</h2>
          </div>
          <button type="button" className="plan-modal-close" onClick={onClose} aria-label="Close">
            <span className="material-symbols-outlined">close</span>
          </button>
        </div>
        <p className="plan-delete-desc">{desc}</p>
        <div className="plan-form-actions">
          <button type="button" className="plan-btn plan-btn--ghost" onClick={onClose} disabled={loading}>
            Cancel
          </button>
          <button
            type="button"
            className="plan-btn plan-btn--danger"
            onClick={onConfirm}
            disabled={loading}
          >
            {loading ? "Deleting…" : "Delete"}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ============================================================
 * MilestoneStrip — thanh hiển thị các milestone của project
 * ============================================================ */
function MilestoneStrip({
  milestones,
  loading,
  error,
  onCreate,
  onDelete,
}: {
  milestones: MilestoneDto[];
  loading: boolean;
  error: string | null;
  onCreate: () => void;
  onDelete: (m: MilestoneDto) => void;
}) {
  if (loading) {
    return (
      <div className="plan-milestone-strip plan-milestone-strip--loading">
        <span className="material-symbols-outlined plan-state-icon plan-state-icon--spin">progress_activity</span>
        <span>Loading milestones…</span>
      </div>
    );
  }
  if (error) {
    return (
      <div className="plan-milestone-strip plan-milestone-strip--error" role="alert">
        <span className="material-symbols-outlined">error</span>
        <span>{error}</span>
      </div>
    );
  }
  if (milestones.length === 0) {
    return (
      <div className="plan-milestone-strip plan-milestone-strip--empty">
        <div className="plan-milestone-strip-icon">
          <span className="material-symbols-outlined">flag</span>
        </div>
        <div className="plan-milestone-strip-body">
          <strong>No milestones yet</strong>
          <p>Milestones are the phases of this project. Tasks must belong to a milestone.</p>
        </div>
        <button type="button" className="plan-btn plan-btn--primary plan-btn--sm" onClick={onCreate}>
          <span className="material-symbols-outlined plan-btn-icon">add</span>
          Create first milestone
        </button>
      </div>
    );
  }
  return (
    <div className="plan-milestone-strip">
      <div className="plan-milestone-strip-label">
        <span className="material-symbols-outlined">flag</span>
        <span>Milestones</span>
        <span className="plan-milestone-strip-count">{milestones.length}</span>
      </div>
      <div className="plan-milestone-list">
        {milestones.map((m) => {
          const due = m.dueDate ?? m.endDate ?? m.startDate ?? null;
          return (
            <div key={m.id} className="plan-milestone-chip">
              <span className="plan-milestone-chip-index">#{m.orderIndex}</span>
              <span className="plan-milestone-chip-name">{m.name}</span>
              {due && <span className="plan-milestone-chip-due">· {due.slice(0, 10)}</span>}
              {m.status && <span className="plan-milestone-chip-status">{m.status}</span>}
              <button
                type="button"
                className="plan-milestone-chip-del"
                onClick={() => onDelete(m)}
                aria-label={`Delete milestone ${m.name}`}
                title="Delete milestone"
              >
                <span className="material-symbols-outlined">close</span>
              </button>
            </div>
          );
        })}
      </div>
      <button type="button" className="plan-btn plan-btn--ghost plan-btn--sm" onClick={onCreate}>
        <span className="material-symbols-outlined plan-btn-icon">add</span>
        Add
      </button>
    </div>
  );
}

/* ============================================================
 * CreateMilestoneModal
 * ============================================================ */
function CreateMilestoneModal({
  onClose,
  onSubmit,
  submitting,
  error,
  existingCount,
}: {
  onClose: () => void;
  onSubmit: (data: CreateMilestoneRequest) => void;
  submitting: boolean;
  error: string | null;
  existingCount: number;
}) {
  // Gợi ý orderIndex = max(existing.orderIndex, 0) + 1, default ≥ 1 theo Swagger
  const [name, setName] = useState("");
  const [orderIndex, setOrderIndex] = useState<string>(String(Math.max(1, existingCount + 1)));
  const [dueDate, setDueDate] = useState("");
  const [status, setStatus] = useState<MilestoneStatus>("Planned");

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;
    const order = parseInt(orderIndex, 10);
    if (!Number.isFinite(order) || order < 1) return;
    onSubmit({
      name: trimmed,
      orderIndex: order,
      dueDate: dueDate || null,
      status,
      revisionCount: 0,
    });
  }

  return (
    <div className="plan-modal-backdrop" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="plan-modal" role="dialog" aria-modal="true" aria-labelledby="ms-title">
        <div className="plan-modal-head">
          <div>
            <span className="plan-modal-eyebrow">New milestone</span>
            <h2 className="plan-modal-title" id="ms-title">Create milestone</h2>
          </div>
          <button type="button" className="plan-modal-close" onClick={onClose} aria-label="Close">
            <span className="material-symbols-outlined">close</span>
          </button>
        </div>

        <form className="plan-form" onSubmit={handleSubmit}>
          <div className="plan-field">
            <label className="plan-label" htmlFor="ms-name">Name *</label>
            <input
              id="ms-name"
              type="text"
              className="plan-input"
              placeholder="e.g. Phase 1 — Design"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              autoFocus
            />
          </div>

          <div className="plan-field-row">
            <div className="plan-field">
              <label className="plan-label" htmlFor="ms-order">Order *</label>
              <input
                id="ms-order"
                type="number"
                className="plan-input"
                min="1"
                step="1"
                value={orderIndex}
                onChange={(e) => setOrderIndex(e.target.value)}
                required
              />
            </div>
            <div className="plan-field">
              <label className="plan-label" htmlFor="ms-due">Due date</label>
              <input
                id="ms-due"
                type="date"
                className="plan-input"
                value={dueDate}
                onChange={(e) => setDueDate(e.target.value)}
              />
            </div>
          </div>

          <div className="plan-field">
            <label className="plan-label" htmlFor="ms-status">Status</label>
            <select
              id="ms-status"
              className="plan-input"
              value={status}
              onChange={(e) => setStatus(e.target.value as MilestoneStatus)}
            >
              <option value="Planned">Planned</option>
              <option value="InProgress">InProgress</option>
              <option value="Delivered">Delivered</option>
              <option value="InRevision">InRevision</option>
              <option value="Approved">Approved</option>
            </select>
          </div>

          {error && (
            <div className="plan-form-error">
              <span className="material-symbols-outlined">error</span>
              {error}
            </div>
          )}

          <div className="plan-form-actions">
            <button type="button" className="plan-btn plan-btn--ghost" onClick={onClose} disabled={submitting}>
              Cancel
            </button>
            <button
              type="submit"
              className="plan-btn plan-btn--primary"
              disabled={submitting || !name.trim() || !orderIndex || parseInt(orderIndex, 10) < 1}
            >
              {submitting ? (
                <>
                  <span className="material-symbols-outlined plan-state-icon--spin">progress_activity</span>
                  Creating…
                </>
              ) : (
                <>
                  <span className="material-symbols-outlined">flag</span>
                  Create milestone
                </>
              )}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
