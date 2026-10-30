import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { getProject, listMilestones, listSubtasks, listTasks, type MilestoneDto, type ProjectDto, type SubtaskDto, type TaskDto } from "../../lib/api-client";
import "./project-detail.css";

/**
 * Project detail page
 * ---------------------------------------------------------------
 * Route: /projects/:projectId
 * API:   GET /api/projects/{projectId}  -> ProjectDto
 *
 * UI is split into 8 sections:
 *   1. Top bar (back + breadcrumb)
 *   2. Hero (status pill, name, description)
 *   3. KPI strip (start / deadline / duration / remaining)
 *   4. Timeline (visual progress bar start → end, "today" marker)
 *   5. Milestones preview (key phases + "View all")
 *   6. Tasks preview (collapsible with subtasks)
 *   7. Two direction cards (Planning / Execution)
 *   8. Footer (client card + createdAt)
 *
 * Theme: aligned with the Projects page (Cognitive Minimalist Dark).
 */
export function ProjectDetailPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const navigate = useNavigate();

  const [project, setProject] = useState<ProjectDto | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);

  // Milestone preview (phases of this project)
  const [milestones, setMilestones] = useState<MilestoneDto[]>([]);
  const [milestonesLoading, setMilestonesLoading] = useState(true);
  const [milestonesError, setMilestonesError] = useState<string | null>(null);

  // Task list preview
  const [tasks, setTasks] = useState<TaskDto[]>([]);
  const [tasksLoading, setTasksLoading] = useState(true);
  const [tasksError, setTasksError] = useState<string | null>(null);

  // Subtasks per task (lazy load on expand)
  const [subtasksMap, setSubtasksMap] = useState<Record<string, SubtaskDto[]>>({});
  const [subtasksLoading, setSubtasksLoading] = useState<Record<string, boolean>>({});
  const [expandedTasks, setExpandedTasks] = useState<Set<string>>(new Set());
  /** Milestone đang mở rộng trong phần preview (chỉ 1 phase tại 1 thời điểm). */
  const [expandedMilestone, setExpandedMilestone] = useState<string | null>(null);

  // Lazy-load subtasks for a task (only first time)
  function loadSubtasks(taskId: string) {
    if (subtasksMap[taskId] !== undefined || subtasksLoading[taskId]) return;
    setSubtasksLoading((p) => ({ ...p, [taskId]: true }));
    void listSubtasks(taskId).then((res) => {
      setSubtasksMap((p) => ({ ...p, [taskId]: res.ok ? res.data : [] }));
      setSubtasksLoading((p) => ({ ...p, [taskId]: false }));
    });
  }

  function toggleTaskExpand(taskId: string) {
    setExpandedTasks((prev) => {
      const next = new Set(prev);
      if (next.has(taskId)) {
        next.delete(taskId);
      } else {
        next.add(taskId);
        loadSubtasks(taskId);
      }
      return next;
    });
  }

  /** Mở / đóng danh sách task của một phase trong phần preview. */
  function toggleMilestoneExpand(milestoneId: string) {
    setExpandedMilestone((prev) => (prev === milestoneId ? null : milestoneId));
  }

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      if (!projectId) {
        setNotFound(true);
        setLoading(false);
        return;
      }
      const res = await getProject(projectId);
      if (cancelled) return;
      if (res.ok) {
        setProject(res.data);
      } else if (res.status === 404) {
        setNotFound(true);
      } else if (res.status === 401) {
        setError("Your session has expired. Please log in again.");
      } else {
        setError(res.error ?? "Failed to load project.");
      }
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  // Load milestone preview for this project
  useEffect(() => {
    if (!projectId) return;
    let cancelled = false;
    void (async () => {
      const res = await listMilestones(projectId);
      if (cancelled) return;
      if (res.ok) {
        setMilestones(
          [...(res.data ?? [])].sort((a, b) => (a.orderIndex ?? 0) - (b.orderIndex ?? 0)),
        );
        setMilestonesError(null);
      } else {
        setMilestonesError(res.error ?? "Failed to load milestones");
      }
      setMilestonesLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  // Load task list preview for this project
  useEffect(() => {
    if (!projectId) return;
    let cancelled = false;
    void (async () => {
      const res = await listTasks(projectId);
      if (cancelled) return;
      if (res.ok) {
        setTasks(res.data);
        setTasksError(null);
      } else {
        setTasksError(res.error ?? "Failed to load tasks");
      }
      setTasksLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  function goBack() {
    navigate("/projects");
  }

  async function retry() {
    if (!projectId) return;
    setError(null);
    setNotFound(false);
    setLoading(true);
    const res = await getProject(projectId);
    setLoading(false);
    if (res.ok) setProject(res.data);
    else if (res.status === 404) setNotFound(true);
    else setError(res.error ?? "Failed to load project.");
  }

  return (
    <section className="pd">
      <div className="pd-ambient pd-ambient--left" aria-hidden="true" />
      <div className="pd-ambient pd-ambient--right" aria-hidden="true" />

      <div className="pd-container">
        {/* Top bar */}
        <div className="pd-topbar">
          <div className="pd-topbar-left">
            <button
              type="button"
              className="pd-icon-btn"
              onClick={goBack}
              aria-label="Back to projects"
              title="Back to projects"
            >
              <span className="material-symbols-outlined">arrow_back</span>
            </button>
            <div className="pd-breadcrumb">
              <Link to="/projects" className="pd-breadcrumb-link">
                Projects
              </Link>
              <span className="pd-breadcrumb-sep">/</span>
              <span className="pd-breadcrumb-current">
                {loading ? "Loading…" : project?.name ?? "—"}
              </span>
            </div>
          </div>

          {!loading && !error && !notFound && project && (
            <div className="pd-topbar-actions">
              <button
                type="button"
                className="pd-btn pd-btn--ghost"
                title="Edit project (coming soon)"
              >
                <span className="material-symbols-outlined pd-btn-icon">edit</span>
                <span>Edit</span>
              </button>
              <button
                type="button"
                className="pd-btn pd-btn--primary"
                onClick={() =>
                  navigate(`/projects/${project.id}/planning`)
                }
              >
                <span className="material-symbols-outlined pd-btn-icon">
                  rocket_launch
                </span>
                <span>Continue</span>
              </button>
            </div>
          )}
        </div>

        {/* Loading */}
        {loading && (
          <div className="pd-state" role="status">
            <span className="material-symbols-outlined pd-state-icon pd-state-icon--spin">
              progress_activity
            </span>
            <p>Loading project…</p>
          </div>
        )}

        {/* Not found */}
        {!loading && notFound && (
          <div className="pd-state pd-state--error" role="alert">
            <span className="material-symbols-outlined pd-state-icon">
              search_off
            </span>
            <h2>Project not found</h2>
            <p>
              We couldn't find a project with id <code>{projectId}</code>.
            </p>
            <button
              type="button"
              className="pd-btn pd-btn--primary"
              onClick={goBack}
            >
              <span className="material-symbols-outlined pd-btn-icon">
                arrow_back
              </span>
              <span>Go back</span>
            </button>
          </div>
        )}

        {/* Generic error */}
        {!loading && !notFound && error && (
          <div className="pd-state pd-state--error" role="alert">
            <span className="material-symbols-outlined pd-state-icon">
              error
            </span>
            <h2>Something went wrong</h2>
            <p>{error}</p>
            <button
              type="button"
              className="pd-btn pd-btn--primary"
              onClick={retry}
            >
              <span className="material-symbols-outlined pd-btn-icon">
                refresh
              </span>
              <span>Retry</span>
            </button>
          </div>
        )}

        {/* Loaded body */}
        {!loading && !error && !notFound && project && (
          <ProjectDetailBody
            project={project}
            tasks={tasks}
            tasksLoading={tasksLoading}
            tasksError={tasksError}
            milestones={milestones}
            milestonesLoading={milestonesLoading}
            milestonesError={milestonesError}
            subtasksMap={subtasksMap}
            subtasksLoading={subtasksLoading}
            expandedTasks={expandedTasks}
            onToggleTask={toggleTaskExpand}
            expandedMilestone={expandedMilestone}
            onToggleMilestone={toggleMilestoneExpand}
          />
        )}
      </div>
    </section>
  );
}

/* ============================================================
 * Body
 * ============================================================ */
function ProjectDetailBody({
  project,
  tasks,
  tasksLoading,
  tasksError,
  milestones,
  milestonesLoading,
  milestonesError,
  subtasksMap,
  subtasksLoading,
  expandedTasks,
  onToggleTask,
  expandedMilestone,
  onToggleMilestone,
}: {
  project: ProjectDto;
  tasks: TaskDto[];
  tasksLoading: boolean;
  tasksError: string | null;
  milestones: MilestoneDto[];
  milestonesLoading: boolean;
  milestonesError: string | null;
  subtasksMap: Record<string, SubtaskDto[]>;
  subtasksLoading: Record<string, boolean>;
  expandedTasks: Set<string>;
  onToggleTask: (taskId: string) => void;
  expandedMilestone: string | null;
  onToggleMilestone: (milestoneId: string) => void;
}) {
  const timeline = useMemo(
    () => computeTimeline(project.startDate, project.deadline),
    [project.startDate, project.deadline],
  );
  const statusKind = normalizeStatus(project.status);

  return (
    <article className="pd-detail">
      {/* Hero */}
      <header className="pd-hero">
        <div className="pd-hero-eyebrow">
          <span className={`pd-status pd-status--${statusKind}`}>
            <span className="pd-status-dot" />
            {prettyStatus(project.status)}
          </span>
          <span className="pd-hero-id" title={project.id}>
            {shortId(project.id)}
          </span>
        </div>

        <h1 className="pd-hero-title">{project.name}</h1>

        {project.description ? (
          <p className="pd-hero-desc">{project.description}</p>
        ) : (
          <p className="pd-hero-desc pd-hero-desc--empty">
            No description provided.
          </p>
        )}
      </header>

      {/* KPI strip */}
      <section className="pd-kpi" aria-label="Project overview">
        <KpiCard
          label="Start"
          value={formatDate(project.startDate)}
          icon="calendar_month"
        />
        <KpiCard
          label="Deadline"
          value={formatDate(project.deadline)}
          icon="event"
        />
        <KpiCard
          label="Duration"
          value={timeline.durationLabel}
          icon="schedule"
        />
        <KpiCard
          label={timeline.phaseLabel}
          value={timeline.phaseValue}
          icon={timeline.phaseIcon}
          tone={timeline.phaseTone}
        />
      </section>

      {/* Timeline */}
      <section className="pd-timeline" aria-label="Project timeline">
        <div className="pd-timeline-head">
          <div className="pd-timeline-head-left">
            <span className="pd-timeline-eyebrow">Timeline</span>
            <h2 className="pd-timeline-title">
              {timeline.progressLabel}
            </h2>
          </div>
          <div className="pd-timeline-head-right">
            <span className="pd-timeline-pct">{timeline.progressPct}%</span>
          </div>
        </div>
        <div className="pd-timeline-bar" role="progressbar" aria-valuenow={timeline.progressPct} aria-valuemin={0} aria-valuemax={100}>
          <div
            className="pd-timeline-fill"
            style={{ width: `${timeline.progressPct}%` }}
          />
          {timeline.todayPct != null && (
            <div
              className="pd-timeline-today"
              style={{ left: `${timeline.todayPct}%` }}
              aria-hidden="true"
            >
              <div className="pd-timeline-today-line" />
              <div className="pd-timeline-today-label">Today</div>
            </div>
          )}
        </div>
        <div className="pd-timeline-foot">
          <span>{formatDate(project.startDate)}</span>
          <span>{formatDate(project.deadline)}</span>
        </div>
      </section>

      {/* Milestones preview */}
      <MilestonesPreview
        projectId={project.id}
        milestones={milestones}
        loading={milestonesLoading}
        error={milestonesError}
        tasks={tasks}
        tasksLoading={tasksLoading}
        tasksError={tasksError}
        expandedMilestone={expandedMilestone}
        onToggleMilestone={onToggleMilestone}
      />

      {/* Tasks preview */}
      <TasksPreview
        projectId={project.id}
        tasks={tasks}
        loading={tasksLoading}
        error={tasksError}
        subtasksMap={subtasksMap}
        subtasksLoading={subtasksLoading}
        expandedTasks={expandedTasks}
        onToggleTask={onToggleTask}
      />

      {/* Direction cards */}
      <section className="pd-directions" aria-label="Next steps">
        <div className="pd-section-head">
          <div>
            <span className="pd-section-eyebrow">Choose your flow</span>
            <h2 className="pd-section-title">How do you want to decompose this project?</h2>
            <p className="pd-section-sub">
              METANOIA supports two flows: create tasks manually, or let AI decompose and schedule them automatically.
            </p>
          </div>
        </div>

        <div className="pd-direction-grid">
          <Link
            to={`/projects/${project.id}/planning`}
            className="pd-direction pd-direction--planning"
            aria-label="Open manual task decomposition"
          >
            <div className="pd-direction-icon">
              <span className="material-symbols-outlined">checklist</span>
            </div>
            <div className="pd-direction-body">
              <h3 className="pd-direction-title">Manual decompose</h3>
              <p className="pd-direction-desc">
                Create smaller tasks yourself and place them on a time grid / schedule — like Google Calendar.
              </p>
            </div>
            <div className="pd-direction-cta">
              <span>Start</span>
              <span className="material-symbols-outlined">arrow_forward</span>
            </div>
          </Link>

          <Link
            to={`/projects/${project.id}/execution`}
            className="pd-direction pd-direction--execution"
            aria-label="Open AI project planner"
          >
            <div className="pd-direction-badge">AI</div>
            <div className="pd-direction-icon">
              <span className="material-symbols-outlined">auto_awesome</span>
            </div>
            <div className="pd-direction-body">
              <h3 className="pd-direction-title">AI auto-decompose</h3>
              <p className="pd-direction-desc">
                Paste the client brief — AI proposes milestones + tasks, you review and apply.
              </p>
            </div>
            <div className="pd-direction-cta">
              <span>Explore</span>
              <span className="material-symbols-outlined">arrow_forward</span>
            </div>
          </Link>
        </div>
      </section>

      {/* Footer metadata */}
      <footer className="pd-foot">
        <div className="pd-foot-card">
          {project.client ? (
            <>
              <span className="pd-foot-avatar" aria-hidden="true">
                {project.client.name.trim().charAt(0).toUpperCase()}
              </span>
              <div className="pd-foot-info">
                <span className="pd-foot-label">Client</span>
                <span className="pd-foot-name">{project.client.name}</span>
                {(project.client.contactEmail || project.client.phone) && (
                  <span className="pd-foot-meta">
                    {[project.client.contactEmail, project.client.phone]
                      .filter(Boolean)
                      .join(" · ")}
                  </span>
                )}
              </div>
            </>
          ) : (
            <>
              <span
                className="pd-foot-avatar pd-foot-avatar--empty"
                aria-hidden="true"
              >
                <span className="material-symbols-outlined">person_off</span>
              </span>
              <div className="pd-foot-info">
                <span className="pd-foot-label">Client</span>
                <span className="pd-foot-name">Internal / None</span>
              </div>
            </>
          )}
        </div>

        <div className="pd-foot-card">
          <span className="pd-foot-avatar pd-foot-avatar--meta" aria-hidden="true">
            <span className="material-symbols-outlined">history</span>
          </span>
          <div className="pd-foot-info">
            <span className="pd-foot-label">Created</span>
            <span className="pd-foot-name">{formatDateTime(project.createdAt)}</span>
            <span className="pd-foot-meta">
              id <code>{project.id}</code>
            </span>
          </div>
        </div>
      </footer>
    </article>
  );
}

/* ============================================================
 * MilestonesPreview — vài milestone chính + link "View all"
 * ============================================================ */
const MILESTONE_PREVIEW_LIMIT = 4;

function MilestonesPreview({
  projectId,
  milestones,
  loading,
  error,
  tasks,
  tasksLoading,
  tasksError,
  expandedMilestone,
  onToggleMilestone,
}: {
  projectId: string;
  milestones: MilestoneDto[];
  loading: boolean;
  error: string | null;
  tasks: TaskDto[];
  tasksLoading: boolean;
  tasksError: string | null;
  expandedMilestone: string | null;
  onToggleMilestone: (milestoneId: string) => void;
}) {
  const stats = useMemo(() => {
    const total = milestones.length;
    const done = milestones.filter(
      (m) => milestoneTone(m.status) === "done",
    ).length;
    const active = milestones.filter(
      (m) => milestoneTone(m.status) === "active",
    ).length;
    return { total, done, active };
  }, [milestones]);

  const preview = useMemo(
    () => milestones.slice(0, MILESTONE_PREVIEW_LIMIT),
    [milestones],
  );

  /** Task của từng milestone. */
  const tasksByMilestone = useMemo(() => {
    const map = new Map<string, TaskDto[]>();
    for (const t of tasks) {
      if (!t.milestoneId) continue;
      const bucket = map.get(t.milestoneId);
      if (bucket) bucket.push(t);
      else map.set(t.milestoneId, [t]);
    }
    return map;
  }, [tasks]);

  return (
    <section className="pd-ms" aria-label="Milestones">
      <div className="pd-ms-head">
        <div className="pd-ms-head-left">
          <span className="pd-section-eyebrow">Milestones</span>
          <h2 className="pd-section-title">
            {stats.total > 0
              ? `${stats.total} milestone${stats.total !== 1 ? "s" : ""}`
              : "No milestones yet"}
          </h2>
        </div>
        <div className="pd-ms-stats">
          {stats.active > 0 && (
            <span className="pd-ms-stat pd-ms-stat--active">
              <span className="material-symbols-outlined">play_circle</span>
              {stats.active} in progress
            </span>
          )}
          {stats.done > 0 && (
            <span className="pd-ms-stat pd-ms-stat--done">
              <span className="material-symbols-outlined">task_alt</span>
              {stats.done} done
            </span>
          )}
          <Link
            to={`/projects/${projectId}/milestones`}
            className="pd-ms-view-all"
          >
            View all
            <span className="material-symbols-outlined">arrow_forward</span>
          </Link>
        </div>
      </div>

      {loading ? (
        <div className="pd-ms-loading" role="status">
          <span className="material-symbols-outlined">progress_activity</span>
          <span>Loading milestones…</span>
        </div>
      ) : error ? (
        <div className="pd-ms-error" role="alert">
          <span className="material-symbols-outlined">error</span>
          <span>{error}</span>
        </div>
      ) : milestones.length === 0 ? (
        <div className="pd-ms-empty">
          <span className="material-symbols-outlined">flag</span>
          <span>
            No milestones yet. Milestones are the phases of this project — tasks
            must belong to one.
          </span>
          <Link
            to={`/projects/${projectId}/milestones`}
            className="pd-ms-empty-cta"
          >
            Create milestone
            <span className="material-symbols-outlined">arrow_forward</span>
          </Link>
        </div>
      ) : (
        <ol className="pd-ms-list">
          {preview.map((m, i) => {
            const tone = milestoneTone(m.status);
            const due = milestoneDueLabel(m.dueDate);
            const msTasks = tasksByMilestone.get(m.id) ?? [];
            const isOpen = expandedMilestone === m.id;
            return (
              <li
                key={m.id}
                className="pd-ms-item"
                style={{ animationDelay: `${i * 60}ms` }}
              >
                <span
                  className={`pd-ms-index pd-ms-index--${tone}`}
                  aria-hidden="true"
                >
                  {m.orderIndex ?? i + 1}
                </span>
                <div className="pd-ms-body">
                  <span className={`pd-ms-name pd-ms-name--${tone}`}>
                    {m.name}
                  </span>
                  <div className="pd-ms-meta">
                    <span className={`pd-ms-status pd-ms-status--${tone}`}>
                      <span className="pd-ms-status-dot" aria-hidden="true" />
                      {prettyMilestoneStatus(m.status)}
                    </span>
                    <span className="pd-ms-meta-item">
                      <span className="material-symbols-outlined">event</span>
                      {formatDate(m.dueDate ?? "")}
                    </span>
                    {due.kind !== "none" && (
                      <span className={`pd-ms-meta-item pd-ms-meta-item--${due.kind}`}>
                        <span className="material-symbols-outlined">schedule</span>
                        {due.label}
                      </span>
                    )}
                    {m.revisionCount > 0 && (
                      <span className="pd-ms-meta-item">
                        <span className="material-symbols-outlined">history</span>
                        {m.revisionCount} rev
                      </span>
                    )}
                  </div>
                </div>
                {m.approvedAt && (
                  <span
                    className="pd-ms-approved"
                    title={`Approved ${formatDate(m.approvedAt)}`}
                  >
                    <span className="material-symbols-outlined">verified</span>
                  </span>
                )}
                <button
                  type="button"
                  className={
                    "pd-ms-expand" + (isOpen ? " pd-ms-expand--open" : "")
                  }
                  onClick={() => onToggleMilestone(m.id)}
                  title={isOpen ? "Hide tasks" : "View tasks in this phase"}
                  aria-label={`${isOpen ? "Hide" : "View"} tasks of ${m.name}`}
                  aria-expanded={isOpen}
                >
                  <span className="material-symbols-outlined">account_tree</span>
                </button>

                {/* Task của phase */}
                {isOpen && (
                  <div className="pd-ms-tasks">
                    {tasksLoading ? (
                      <div className="pd-ms-tasks-state" role="status">
                        <span className="material-symbols-outlined pd-spin">
                          progress_activity
                        </span>
                        <span>Loading tasks…</span>
                      </div>
                    ) : tasksError ? (
                      <div
                        className="pd-ms-tasks-state pd-ms-tasks-state--error"
                        role="alert"
                      >
                        <span className="material-symbols-outlined">error</span>
                        <span>{tasksError}</span>
                      </div>
                    ) : msTasks.length === 0 ? (
                      <div className="pd-ms-tasks-state">
                        <span className="material-symbols-outlined">task_alt</span>
                        <span>No tasks in this phase yet.</span>
                      </div>
                    ) : (
                      <ul className="pd-ms-task-list">
                        {msTasks.map((t) => (
                          <MilestoneTaskLine key={t.id} task={t} />
                        ))}
                      </ul>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}

/* ============================================================
 * MilestoneTaskLine — 1 dòng task gọn trong phase (không subtask)
 * ============================================================ */
function MilestoneTaskLine({ task }: { task: TaskDto }) {
  const status = (task.status ?? "").toLowerCase();
  const isDone = status === "done" || status === "completed";
  const isActive = status === "inprogress" || status === "in_progress";
  const isScheduled = status === "scheduled";

  const deadlineInfo = useMemo(() => {
    if (!task.deadline) return null;
    const d = new Date(task.deadline);
    if (Number.isNaN(d.getTime())) return null;
    const now = new Date();
    const days = Math.ceil((d.getTime() - now.getTime()) / 86_400_000);
    const label = d.toLocaleDateString(undefined, {
      month: "short",
      day: "2-digit",
    });
    if (isDone) return { label, kind: "normal" as const };
    if (days < 0) return { label, kind: "overdue" as const };
    if (days <= 3) return { label, kind: "soon" as const };
    return { label, kind: "normal" as const };
  }, [task.deadline, isDone]);

  const tone = isActive
    ? "active"
    : isScheduled
      ? "scheduled"
      : isDone
        ? "done"
        : "todo";

  return (
    <li className={`pd-ms-task pd-ms-task--${tone}${isDone ? " pd-ms-task--done" : ""}`}>
      <span className="pd-ms-task-marker" aria-hidden="true">
        <span className={`pd-ms-task-dot pd-ms-task-dot--${tone}`} />
      </span>
      <span className="pd-ms-task-body">
        <span className="pd-ms-task-title">{task.title}</span>
        <span className="pd-ms-task-meta">
          {task.taskType && (
            <span className="pd-ms-task-type">{task.taskType}</span>
          )}
          {task.estimatedMinutes > 0 && (
            <span className="pd-ms-task-meta-item">
              <span className="material-symbols-outlined">schedule</span>
              {formatMinutesCompact(task.estimatedMinutes)}
            </span>
          )}
          {deadlineInfo && (
            <span
              className={`pd-ms-task-meta-item pd-ms-task-meta-item--${deadlineInfo.kind}`}
            >
              <span className="material-symbols-outlined">event</span>
              {deadlineInfo.label}
            </span>
          )}
        </span>
      </span>
      <span className={`pd-ms-task-status pd-ms-task-status--${tone}`}>
        {prettyTaskStatusLocal(task.status)}
      </span>
    </li>
  );
}

/* ============================================================
 * TasksPreview — danh sách task gọn, click → /planning
 * ============================================================ */
const TASK_PREVIEW_LIMIT = 5;

function TasksPreview({
  projectId,
  tasks,
  loading,
  error,
  subtasksMap,
  subtasksLoading,
  expandedTasks,
  onToggleTask,
}: {
  projectId: string;
  tasks: TaskDto[];
  loading: boolean;
  error: string | null;
  subtasksMap: Record<string, SubtaskDto[]>;
  subtasksLoading: Record<string, boolean>;
  expandedTasks: Set<string>;
  onToggleTask: (taskId: string) => void;
}) {
  // Compute stats
  const stats = useMemo(() => {
    const now = new Date();
    let done = 0;
    let overdue = 0;
    for (const t of tasks) {
      const s = (t.status ?? "").toLowerCase();
      if (s === "done" || s === "completed") {
        done++;
        continue;
      }
      if (
        t.deadline &&
        new Date(t.deadline) < now &&
        s !== "skipped" &&
        s !== "cancelled"
      ) {
        overdue++;
      }
    }
    return { total: tasks.length, done, overdue };
  }, [tasks]);

  // Sort: inprogress first → todo → scheduled → done last; within each group, sort by deadline
  const sorted = useMemo(() => {
    const weight = (s: string) => {
      const v = (s ?? "").toLowerCase();
      if (v === "inprogress") return 0;
      if (v === "todo" || v === "pending") return 1;
      if (v === "scheduled") return 2;
      if (v === "skipped" || v === "cancelled") return 4;
      if (v === "done" || v === "completed") return 5;
      return 3;
    };
    return [...tasks]
      .sort((a, b) => {
        const wa = weight(a.status);
        const wb = weight(b.status);
        if (wa !== wb) return wa - wb;
        const da = a.deadline ? new Date(a.deadline).getTime() : Infinity;
        const db = b.deadline ? new Date(b.deadline).getTime() : Infinity;
        return da - db;
      })
      .slice(0, TASK_PREVIEW_LIMIT);
  }, [tasks]);

  return (
    <section className="pd-tasks" aria-label="Tasks">
      <div className="pd-tasks-head">
        <div className="pd-tasks-head-left">
          <span className="pd-section-eyebrow">Tasks</span>
          <h2 className="pd-section-title">
            {stats.total > 0
              ? `${stats.total} task${stats.total !== 1 ? "s" : ""}`
              : "No tasks yet"}
          </h2>
        </div>
        <div className="pd-tasks-stats">
          {stats.done > 0 && (
            <span className="pd-tasks-stat pd-tasks-stat--done" title="Completed tasks">
              <span className="material-symbols-outlined">check_circle</span>
              {stats.done} done
            </span>
          )}
          {stats.overdue > 0 && (
            <span className="pd-tasks-stat pd-tasks-stat--overdue" title="Overdue tasks">
              <span className="material-symbols-outlined">priority_high</span>
              {stats.overdue} overdue
            </span>
          )}
          {tasks.length > TASK_PREVIEW_LIMIT && (
            <Link
              to={`/projects/${projectId}/planning`}
              className="pd-tasks-view-all"
            >
              View all
              <span className="material-symbols-outlined">arrow_forward</span>
            </Link>
          )}
        </div>
      </div>

      {loading ? (
        <div className="pd-tasks-loading" role="status">
          <span className="material-symbols-outlined">progress_activity</span>
          <span>Loading tasks…</span>
        </div>
      ) : error ? (
        <div className="pd-tasks-error" role="alert">
          <span className="material-symbols-outlined">error</span>
          <span>{error}</span>
        </div>
      ) : tasks.length === 0 ? (
        <div className="pd-tasks-empty">
          <span className="material-symbols-outlined">task</span>
          <span>
            No tasks yet. Open <strong>Planning</strong> to decompose this project.
          </span>
        </div>
      ) : (
        <div className="pd-task-list">
          {sorted.map((t) => (
            <TaskPreviewRow
              key={t.id}
              task={t}
              isExpanded={expandedTasks.has(t.id)}
              onToggle={() => onToggleTask(t.id)}
              subtasks={subtasksMap[t.id] ?? (subtasksLoading[t.id] ? undefined : [])}
              subtasksLoading={subtasksLoading[t.id] ?? false}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function TaskPreviewRow({
  task,
  isExpanded,
  onToggle,
  subtasks,
  subtasksLoading,
}: {
  task: TaskDto;
  isExpanded: boolean;
  onToggle: () => void;
  subtasks?: SubtaskDto[];
  subtasksLoading: boolean;
}) {
  const status = (task.status ?? "").toLowerCase();
  const isDone = status === "done" || status === "completed";

  // Deadline state
  const deadlineInfo = useMemo(() => {
    if (!task.deadline) return null;
    const d = new Date(task.deadline);
    if (Number.isNaN(d.getTime())) return null;
    const now = new Date();
    const diffMs = d.getTime() - now.getTime();
    const days = Math.ceil(diffMs / 86_400_000);
    const label = d.toLocaleDateString(undefined, {
      month: "short",
      day: "2-digit",
    });
    if (isDone) return { label, kind: "normal" as const };
    if (days < 0) return { label, kind: "overdue" as const };
    if (days <= 3) return { label, kind: "soon" as const };
    return { label, kind: "normal" as const };
  }, [task.deadline, isDone]);

  // Map status → dot & pill tone
  const dotClass = `pd-task-status-dot pd-task-status-dot--${status || "todo"}`;
  const pillClass = `pd-task-status-pill pd-task-status-pill--${status || "todo"}`;

  return (
    <div className={`pd-task-wrap ${isExpanded ? "pd-task-wrap--open" : ""}`}>
      <button
        type="button"
        className={`pd-task ${isDone ? "pd-task--done" : ""}`}
        onClick={onToggle}
        aria-expanded={isExpanded}
        aria-label={isExpanded ? "Collapse subtasks" : "Expand subtasks"}
      >
        <span className={dotClass} aria-hidden="true" />
        <div className="pd-task-body">
          <span className={`pd-task-title ${isDone ? "pd-task-title--done" : ""}`}>
            {task.title}
          </span>
          <div className="pd-task-meta">
            {task.taskType && (
              <span className="pd-task-meta-item">{task.taskType}</span>
            )}
            {deadlineInfo && (
              <span
                className={`pd-task-meta-item pd-task-meta-item--${deadlineInfo.kind}`}
              >
                <span className="material-symbols-outlined">event</span>
                {deadlineInfo.label}
              </span>
            )}
            {task.estimatedMinutes > 0 && (
              <span className="pd-task-meta-item">
                <span className="material-symbols-outlined">schedule</span>
                {formatMinutesCompact(task.estimatedMinutes)}
              </span>
            )}
          </div>
        </div>
        <span className={pillClass}>{prettyTaskStatusLocal(task.status)}</span>
        <span
          className={`pd-task-chevron material-symbols-outlined ${isExpanded ? "pd-task-chevron--open" : ""}`}
          aria-hidden="true"
        >
          expand_more
        </span>
      </button>

      {isExpanded && (
        <div className="pd-subtasks" role="region" aria-label="Subtasks">
          {subtasksLoading ? (
            <div className="pd-subtasks-loading">
              <span className="material-symbols-outlined">progress_activity</span>
              <span>Loading subtasks…</span>
            </div>
          ) : subtasks && subtasks.length > 0 ? (
            <ul className="pd-subtask-list">
              {subtasks.map((s) => (
                <SubtaskPreviewRow key={s.id} subtask={s} />
              ))}
            </ul>
          ) : (
            <div className="pd-subtasks-empty">
              <span className="material-symbols-outlined">check_box</span>
              <span>No subtasks yet.</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function SubtaskPreviewRow({ subtask }: { subtask: SubtaskDto }) {
  const status = (subtask.status ?? "").toLowerCase();
  const isDone = status === "done" || status === "completed";
  return (
    <li className={`pd-subtask ${isDone ? "pd-subtask--done" : ""}`}>
      <span className="pd-subtask-check" aria-hidden="true">
        <span className="material-symbols-outlined">
          {isDone ? "check_circle" : "radio_button_unchecked"}
        </span>
      </span>
      <div className="pd-subtask-info">
        <span className={`pd-subtask-title ${isDone ? "pd-subtask-title--done" : ""}`}>
          {subtask.title}
        </span>
        <div className="pd-subtask-meta">
          {subtask.estimatedMinutes > 0 && (
            <span className="pd-subtask-meta-item">
              <span className="material-symbols-outlined">schedule</span>
              {formatMinutesCompact(subtask.estimatedMinutes)}
            </span>
          )}
          {subtask.scheduledStart && (
            <span className="pd-subtask-meta-item">
              <span className="material-symbols-outlined">event</span>
              {new Date(subtask.scheduledStart).toLocaleDateString(undefined, {
                month: "short",
                day: "2-digit",
              })}
            </span>
          )}
        </div>
      </div>
      <span className={`pd-subtask-status pd-subtask-status--${status || "todo"}`}>
        {prettyTaskStatusLocal(subtask.status)}
      </span>
    </li>
  );
}

/* ============================================================
 * Local helpers (milestone-specific)
 * ============================================================ */

/** Map status milestone → nhóm tone. */
function milestoneTone(
  status: string,
): "planned" | "active" | "revision" | "done" {
  const s = (status ?? "").toLowerCase();
  if (s === "inprogress" || s === "in_progress") return "active";
  if (s === "inrevision" || s === "revision") return "revision";
  if (s === "delivered" || s === "approved" || s === "completed") return "done";
  return "planned";
}

/** Label đẹp cho status milestone. */
function prettyMilestoneStatus(status: string): string {
  const s = (status ?? "").toLowerCase();
  const map: Record<string, string> = {
    planned: "Planned",
    inprogress: "In Progress",
    in_progress: "In Progress",
    delivered: "Delivered",
    inrevision: "In Revision",
    revision: "In Revision",
    approved: "Approved",
    completed: "Completed",
  };
  return map[s] ?? status ?? "—";
}

/** Ngày tương đối so với hôm nay. */
function milestoneDueLabel(dueDate: string | null): {
  label: string;
  kind: "none" | "soon" | "future" | "overdue";
} {
  if (!dueDate) return { label: "", kind: "none" };
  const d = new Date(dueDate);
  if (Number.isNaN(d.getTime())) return { label: "", kind: "none" };
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const target = new Date(d);
  target.setHours(0, 0, 0, 0);
  const days = Math.round((target.getTime() - today.getTime()) / 86_400_000);
  if (days === 0) return { label: "Due today", kind: "soon" };
  if (days === 1) return { label: "Due tomorrow", kind: "soon" };
  if (days > 1) return { label: `In ${days} days`, kind: "future" };
  if (days === -1) return { label: "1 day late", kind: "overdue" };
  return { label: `${Math.abs(days)} days late`, kind: "overdue" };
}

/* ============================================================
 * Local helpers (task-specific, not shared with planning)
 * ============================================================ */
function prettyTaskStatusLocal(s: string): string {
  const m: Record<string, string> = {
    todo: "ToDo",
    scheduled: "Scheduled",
    inprogress: "InProgress",
    done: "Done",
    completed: "Done",
    skipped: "Skipped",
    cancelled: "Cancelled",
    pending: "ToDo",
  };
  const lower = (s ?? "").toLowerCase();
  if (m[lower]) return m[lower];
  if (
    s === "ToDo" ||
    s === "Scheduled" ||
    s === "InProgress" ||
    s === "Done" ||
    s === "Skipped"
  ) {
    return s;
  }
  return s || "—";
}

function formatMinutesCompact(mins: number): string {
  if (!mins) return "";
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  if (h === 0) return `${m}m`;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}m`;
}

/* ============================================================
 * Sub-components
 * ============================================================ */
function KpiCard({
  label,
  value,
  icon,
  tone = "default",
}: {
  label: string;
  value: string;
  icon: string;
  tone?: "default" | "primary" | "secondary" | "tertiary" | "error";
}) {
  return (
    <div className="pd-kpi-card">
      <div className={`pd-kpi-icon pd-kpi-icon--${tone}`}>
        <span className="material-symbols-outlined">{icon}</span>
      </div>
      <div className="pd-kpi-text">
        <span className="pd-kpi-label">{label}</span>
        <span className="pd-kpi-value">{value}</span>
      </div>
    </div>
  );
}

/* ============================================================
 * Helpers
 * ============================================================ */
function shortId(id: string): string {
  if (!id) return "—";
  if (id.length <= 8) return id;
  return `${id.slice(0, 4)}…${id.slice(-4)}`;
}

function prettyStatus(s: string): string {
  if (!s) return "Unknown";
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * Map status của project → tone hiển thị.
 *
 * ⚠️ Enum THẬT của backend: `Active` | `OnHold` | `Completed` | `Archived`.
 * Code cũ chỉ biết `active` / `planning` / `done` → `OnHold` rơi vào
 * nhánh `other` và hiển thị sai.
 */
function normalizeStatus(
  s: string,
): "active" | "planning" | "done" | "other" {
  const v = (s ?? "").toLowerCase();
  if (v === "active" || v === "inprogress" || v === "in_progress") return "active";
  if (v === "onhold" || v === "on_hold" || v === "on-hold") return "planning";
  if (v === "planning" || v === "plan" || v === "draft") return "planning";
  if (v === "done" || v === "completed" || v === "complete") return "done";
  return "other";
}

function formatDate(iso: string): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "2-digit",
  });
}

function formatDateTime(iso: string): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function computeTimeline(startIso: string, deadlineIso: string) {
  const start = new Date(startIso);
  const end = new Date(deadlineIso);
  const now = new Date();

  const invalid =
    Number.isNaN(start.getTime()) || Number.isNaN(end.getTime());

  if (invalid) {
    return {
      durationLabel: "—",
      phaseLabel: "Status",
      phaseValue: "—",
      phaseIcon: "hourglass_empty" as string,
      phaseTone: "default" as const,
      progressLabel: "Timeline unavailable",
      progressPct: 0,
      todayPct: null as number | null,
    };
  }

  const totalMs = end.getTime() - start.getTime();
  const totalDays = Math.max(0, Math.round(totalMs / 86_400_000));

  let durationLabel: string;
  if (totalDays >= 60) {
    const months = Math.round(totalDays / 30);
    durationLabel = `${months} months`;
  } else if (totalDays >= 14) {
    const weeks = Math.round(totalDays / 7);
    durationLabel = `${weeks} weeks`;
  } else if (totalDays > 0) {
    durationLabel = `${totalDays} day${totalDays === 1 ? "" : "s"}`;
  } else {
    durationLabel = "Same day";
  }

  let phaseLabel: string;
  let phaseValue: string;
  let phaseIcon: string;
  let phaseTone: "default" | "primary" | "secondary" | "tertiary" | "error";
  let progressLabel: string;

  if (now < start) {
    const until = Math.max(
      0,
      Math.ceil((start.getTime() - now.getTime()) / 86_400_000),
    );
    phaseLabel = "Starts in";
    phaseValue = until > 0 ? `${until} day${until === 1 ? "" : "s"}` : "today";
    phaseIcon = "schedule";
    phaseTone = "primary";
    progressLabel = "Upcoming project";
  } else if (now > end) {
    const since = Math.max(
      0,
      Math.ceil((now.getTime() - end.getTime()) / 86_400_000),
    );
    phaseLabel = "Overdue by";
    phaseValue = `${since} day${since === 1 ? "" : "s"}`;
    phaseIcon = "priority_high";
    phaseTone = "error";
    progressLabel = "Past deadline";
  } else {
    const remaining = Math.max(
      0,
      Math.ceil((end.getTime() - now.getTime()) / 86_400_000),
    );
    phaseLabel = "Remaining";
    phaseValue = `${remaining} day${remaining === 1 ? "" : "s"}`;
    phaseIcon = "hourglass_top";
    phaseTone = "secondary";
    progressLabel = "In progress";
  }

  // Progress percentage: how much of the timeline has elapsed.
  let progressPct: number;
  if (now <= start) progressPct = 0;
  else if (now >= end) progressPct = 100;
  else if (totalMs <= 0) progressPct = 100;
  else
    progressPct = Math.round(((now.getTime() - start.getTime()) / totalMs) * 100);

  // Today marker: position of `now` between start and end.
  let todayPct: number | null = null;
  if (now >= start && now <= end && totalMs > 0) {
    todayPct = Math.round(((now.getTime() - start.getTime()) / totalMs) * 100);
  }

  return {
    durationLabel,
    phaseLabel,
    phaseValue,
    phaseIcon,
    phaseTone,
    progressLabel,
    progressPct,
    todayPct,
  };
}
