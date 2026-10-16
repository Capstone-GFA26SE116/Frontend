import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { getProject, type ProjectDto } from "../../lib/api-client";
import "./project-detail.css";

/**
 * Project detail page
 * ---------------------------------------------------------------
 * Route: /projects/:projectId
 * API:   GET /api/projects/{projectId}  -> ProjectDto
 *
 * UI chia 4 phần:
 *   1. Top bar (back + breadcrumb)
 *   2. Hero (status pill, tên, description)
 *   3. KPI strip (start / deadline / duration / remaining)
 *   4. Timeline (visual progress bar start → end, marker "today")
 *   5. Two direction cards (Planning / Execution)
 *   6. Footer (client card + createdAt)
 *
 * Theme: đồng bộ với Projects page (Cognitive Minimalist Dark).
 */
export function ProjectDetailPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const navigate = useNavigate();

  const [project, setProject] = useState<ProjectDto | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      if (!projectId) {
        setNotFound(true);
        setLoading(false);
        return;
      }
      setLoading(true);
      setError(null);
      setNotFound(false);
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
    }
    void load();
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
          <ProjectDetailBody project={project} />
        )}
      </div>
    </section>
  );
}

/* ============================================================
 * Body
 * ============================================================ */
function ProjectDetailBody({ project }: { project: ProjectDto }) {
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

      {/* Direction cards */}
      <section className="pd-directions" aria-label="Next steps">
        <div className="pd-section-head">
          <div>
            <span className="pd-section-eyebrow">Choose your flow</span>
            <h2 className="pd-section-title">Phân rã dự án theo cách nào?</h2>
            <p className="pd-section-sub">
              METANOIA hỗ trợ 2 hướng: tự tạo task thủ công, hoặc để AI phân rã + xếp lịch tự động.
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
                Tự tạo tasks nhỏ và xếp chúng vào khung giờ / lịch — giống Google Calendar.
              </p>
            </div>
            <div className="pd-direction-cta">
              <span>Bắt đầu</span>
              <span className="material-symbols-outlined">arrow_forward</span>
            </div>
          </Link>

          <Link
            to={`/projects/${project.id}/execution`}
            className="pd-direction pd-direction--execution"
            aria-label="Open AI auto-decomposition (coming soon)"
            onClick={(e) => {
              e.preventDefault();
              // TODO: trigger AI decompose
            }}
          >
            <div className="pd-direction-badge">AI</div>
            <div className="pd-direction-icon">
              <span className="material-symbols-outlined">auto_awesome</span>
            </div>
            <div className="pd-direction-body">
              <h3 className="pd-direction-title">AI auto-decompose</h3>
              <p className="pd-direction-desc">
                AI đọc dự án, tự phân rã thành tasks nhỏ và sắp xếp thời gian tự động.
              </p>
            </div>
            <div className="pd-direction-cta">
              <span>Khám phá</span>
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

function normalizeStatus(s: string): "active" | "planning" | "done" | "other" {
  const v = (s ?? "").toLowerCase();
  if (v === "active" || v === "inprogress" || v === "in_progress") return "active";
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
