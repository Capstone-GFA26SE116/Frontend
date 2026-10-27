import {
  useEffect,
  useMemo,
  useState,
  type CSSProperties,
  type FormEvent,
} from "react";
import { createPortal } from "react-dom";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useStaggeredMount } from "../../hooks/useStaggeredMount";
import { CenterToasts, useCenterToast } from "../../components/Toast";
import {
  createMilestone,
  deleteMilestone,
  getProject,
  listMilestones,
  listTasks,
  updateMilestone,
  type CreateMilestoneRequest,
  type MilestoneDto,
  type ProjectDto,
  type TaskDto,
} from "../../lib/api-client";
import "./milestones.css";

/* ===========================================================
 * Milestones — Trang quản lý milestone của một project
 * Route: /projects/:projectId/milestones
 *
 * Endpoints:
 *  - GET    /api/projects/{projectId}/milestones
 *  - POST   /api/projects/{projectId}/milestones
 *  - GET    /api/milestones/{milestoneId}
 *  - PUT    /api/milestones/{milestoneId}
 *  - DELETE /api/milestones/{milestoneId}
 *
 * Class prefix `.ms-*`. Tuân thủ DESIGN.md.
 * =========================================================== */

/** Enum trạng thái milestone mà BE chấp nhận. */
const MILESTONE_STATUSES = [
  "Planned",
  "InProgress",
  "Delivered",
  "InRevision",
  "Approved",
] as const;

type MilestoneStatus = (typeof MILESTONE_STATUSES)[number];

interface MilestoneForm {
  name: string;
  orderIndex: string;
  dueDate: string;
  status: MilestoneStatus;
  revisionCount: string;
}

const EMPTY_FORM: MilestoneForm = {
  name: "",
  orderIndex: "1",
  dueDate: "",
  status: "Planned",
  revisionCount: "0",
};

/** Map status → nhóm tone hiển thị. */
function statusTone(status: string): "planned" | "active" | "revision" | "done" {
  const s = (status ?? "").toLowerCase();
  if (s === "inprogress" || s === "in_progress") return "active";
  if (s === "inrevision" || s === "revision") return "revision";
  if (s === "delivered" || s === "approved" || s === "completed") return "done";
  return "planned";
}

/** Label đẹp cho status. */
function prettyStatus(status: string): string {
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

/** "27 Oct 2026" */
function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

/** Ngày tương đối so với hôm nay: "in 5 days" / "3 days ago" / "today". */
function dueLabel(iso: string | null): { label: string; kind: string } {
  if (!iso) return { label: "No due date", kind: "none" };
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return { label: "No due date", kind: "none" };
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const target = new Date(d);
  target.setHours(0, 0, 0, 0);
  const days = Math.round((target.getTime() - today.getTime()) / 86_400_000);
  if (days === 0) return { label: "Due today", kind: "soon" };
  if (days === 1) return { label: "Due tomorrow", kind: "soon" };
  if (days > 1) return { label: `Due in ${days} days`, kind: "future" };
  if (days === -1) return { label: "1 day overdue", kind: "overdue" };
  return { label: `${Math.abs(days)} days overdue`, kind: "overdue" };
}

function shortId(id: string): string {
  if (!id) return "—";
  if (id.length <= 8) return id;
  return `${id.slice(0, 4)}…${id.slice(-4)}`;
}

export function MilestonesPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const navigate = useNavigate();

  const [project, setProject] = useState<ProjectDto | null>(null);
  const [milestones, setMilestones] = useState<MilestoneDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  /* --- Modal create / edit --- */
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<MilestoneDto | null>(null);
  const [form, setForm] = useState<MilestoneForm>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  /* --- Modal delete --- */
  const [deleting, setDeleting] = useState<MilestoneDto | null>(null);
  const [removing, setRemoving] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const [toasts, toast] = useCenterToast();
  const { mounted } = useStaggeredMount(60, 40, milestones.length);

  /* --- Tasks thuộc milestone (mở rộng khi bấm Phase) --- */
  const [tasks, setTasks] = useState<TaskDto[]>([]);
  const [tasksLoading, setTasksLoading] = useState(true);
  const [tasksError, setTasksError] = useState<string | null>(null);

  /** Milestone đang mở rộng (chỉ 1 phase tại 1 thời điểm). */
  const [expanded, setExpanded] = useState<string | null>(null);

  /* -------------------- Load -------------------- */
  /** Fetch project + milestones + tasks. Mọi setState nằm sau `await` để tránh
   *  lint `react-hooks/set-state-in-effect` (setState đồng bộ trong effect). */
  async function fetchAll(pid: string) {
    const [projRes, msRes, taskRes] = await Promise.all([
      getProject(pid),
      listMilestones(pid),
      listTasks(pid),
    ]);
    return { projRes, msRes, taskRes };
  }

  function applyAll(
    projRes: Awaited<ReturnType<typeof getProject>>,
    msRes: Awaited<ReturnType<typeof listMilestones>>,
    taskRes: Awaited<ReturnType<typeof listTasks>>,
  ) {
    if (projRes.ok) setProject(projRes.data);
    if (msRes.ok) {
      setMilestones(sortMilestones(msRes.data ?? []));
      setError(null);
    } else {
      setError(
        msRes.status === 401
          ? "Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại."
          : (msRes.error ?? "Không tải được danh sách milestone."),
      );
    }
    if (taskRes.ok) {
      setTasks(taskRes.data ?? []);
      setTasksError(null);
    } else {
      setTasksError(taskRes.error ?? "Không tải được danh sách task.");
    }
    setTasksLoading(false);
  }

  /** Reload thủ công (nút "Thử lại"). */
  async function reload() {
    if (!projectId) return;
    setLoading(true);
    setError(null);
    setTasksLoading(true);
    const { projRes, msRes, taskRes } = await fetchAll(projectId);
    setLoading(false);
    applyAll(projRes, msRes, taskRes);
  }

  useEffect(() => {
    if (!projectId) return;
    let cancelled = false;
    void (async () => {
      const { projRes, msRes, taskRes } = await fetchAll(projectId);
      if (cancelled) return;
      setLoading(false);
      applyAll(projRes, msRes, taskRes);
    })();
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  /* -------------------- Derived -------------------- */
  const stats = useMemo(() => {
    const total = milestones.length;
    const active = milestones.filter(
      (m) => statusTone(m.status) === "active",
    ).length;
    const done = milestones.filter((m) => statusTone(m.status) === "done").length;
    const overdue = milestones.filter((m) => {
      if (statusTone(m.status) === "done") return false;
      return dueLabel(m.dueDate).kind === "overdue";
    }).length;
    return { total, active, done, overdue };
  }, [milestones]);

  /** Phần trăm milestone đã hoàn thành (Delivered + Approved). */
  const completionPct =
    stats.total > 0 ? Math.round((stats.done / stats.total) * 100) : 0;

  /** Task của từng milestone, đã sort theo trạng thái → deadline. */
  const tasksByMilestone = useMemo(() => {
    const map = new Map<string, TaskDto[]>();
    for (const t of tasks) {
      if (!t.milestoneId) continue;
      const bucket = map.get(t.milestoneId);
      if (bucket) bucket.push(t);
      else map.set(t.milestoneId, [t]);
    }
    for (const bucket of map.values()) {
      bucket.sort((a, b) => {
        const wa = taskWeight(a.status);
        const wb = taskWeight(b.status);
        if (wa !== wb) return wa - wb;
        const da = a.deadline ? new Date(a.deadline).getTime() : Infinity;
        const db = b.deadline ? new Date(b.deadline).getTime() : Infinity;
        return da - db;
      });
    }
    return map;
  }, [tasks]);

  /* -------------------- Handlers -------------------- */
  function openCreate() {
    setEditing(null);
    setForm({
      ...EMPTY_FORM,
      orderIndex: String(
        Math.max(1, milestones.reduce((m, x) => Math.max(m, x.orderIndex ?? 0), 0) + 1),
      ),
    });
    setFormError(null);
    setFormOpen(true);
  }

  function openEdit(m: MilestoneDto) {
    setEditing(m);
    setForm({
      name: m.name ?? "",
      orderIndex: String(m.orderIndex ?? 1),
      dueDate: m.dueDate ? m.dueDate.slice(0, 10) : "",
      status: (MILESTONE_STATUSES as readonly string[]).includes(m.status)
        ? (m.status as MilestoneStatus)
        : "Planned",
      revisionCount: String(m.revisionCount ?? 0),
    });
    setFormError(null);
    setFormOpen(true);
  }

  function closeForm() {
    if (saving) return;
    setFormOpen(false);
    setEditing(null);
    setFormError(null);
  }

  /** Mở / đóng danh sách task của một phase. */
  function toggleMilestone(milestoneId: string) {
    setExpanded((prev) => (prev === milestoneId ? null : milestoneId));
  }

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (saving || !projectId) return;

    const name = form.name.trim();
    if (!name) {
      setFormError("Tên milestone không được để trống.");
      return;
    }
    const order = parseInt(form.orderIndex, 10);
    if (!Number.isFinite(order) || order < 1) {
      setFormError("Order phải là số nguyên ≥ 1.");
      return;
    }
    const revision = parseInt(form.revisionCount, 10);
    if (!Number.isFinite(revision) || revision < 0) {
      setFormError("Revision count phải là số nguyên ≥ 0.");
      return;
    }

    const body: CreateMilestoneRequest = {
      name,
      orderIndex: order,
      dueDate: form.dueDate || null,
      status: form.status,
      revisionCount: revision,
    };

    setSaving(true);
    setFormError(null);
    const res = editing
      ? await updateMilestone(editing.id, body)
      : await createMilestone(projectId, body);
    setSaving(false);

    if (!res.ok) {
      setFormError(res.error ?? "Không lưu được milestone.");
      return;
    }

    setMilestones((prev) => {
      const next = editing
        ? prev.map((m) => (m.id === editing.id ? res.data : m))
        : [...prev, res.data];
      return sortMilestones(next);
    });
    setFormOpen(false);
    setEditing(null);
    toast.success(
      editing ? "Đã cập nhật milestone" : "Đã tạo milestone",
      res.data.name,
    );
  }

  async function handleDelete() {
    if (!deleting || removing) return;
    setRemoving(true);
    setDeleteError(null);
    const res = await deleteMilestone(deleting.id);
    setRemoving(false);
    if (!res.ok) {
      setDeleteError(res.error ?? "Không xoá được milestone.");
      return;
    }
    setMilestones((prev) => prev.filter((m) => m.id !== deleting.id));
    toast.success("Đã xoá milestone", deleting.name);
    setDeleting(null);
  }

  /* -------------------- Esc đóng modal -------------------- */
  useEffect(() => {
    if (!formOpen && !deleting) return;
    function onKey(e: globalThis.KeyboardEvent) {
      if (e.key !== "Escape") return;
      if (deleting) setDeleting(null);
      else closeForm();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [formOpen, deleting, saving]);

  const isEmpty = !loading && !error && milestones.length === 0;

  return (
    <div className="ms">
      <div className="ms-container">
        {/* ================= Top bar ================= */}
        <div className="ms-topbar">
          <div className="ms-topbar-left">
            <button
              type="button"
              className="ms-icon-btn"
              onClick={() => navigate(`/projects/${projectId}`)}
              aria-label="Back to project"
              title="Back to project"
            >
              <span className="material-symbols-outlined">arrow_back</span>
            </button>
            <div className="ms-breadcrumb">
              <Link to="/projects" className="ms-breadcrumb-link">
                Projects
              </Link>
              <span className="ms-breadcrumb-sep">/</span>
              {project && (
                <>
                  <Link
                    to={`/projects/${project.id}`}
                    className="ms-breadcrumb-link"
                  >
                    {project.name}
                  </Link>
                  <span className="ms-breadcrumb-sep">/</span>
                </>
              )}
              <span className="ms-breadcrumb-current">Milestones</span>
            </div>
          </div>

          {!loading && !error && (
            <div className="ms-topbar-actions">
              <button
                type="button"
                className="ms-btn ms-btn--ghost"
                onClick={() => navigate(`/projects/${projectId}/planning`)}
              >
                <span className="material-symbols-outlined ms-btn-icon">
                  checklist
                </span>
                <span>Planning</span>
              </button>
              <button
                type="button"
                className="ms-btn ms-btn--primary"
                onClick={openCreate}
              >
                <span className="material-symbols-outlined ms-btn-icon ms-btn-icon--rotate">
                  add
                </span>
                <span>New milestone</span>
              </button>
            </div>
          )}
        </div>

        {/* ================= Header ================= */}
        <header className={"ms-header" + (mounted ? " ms-header--in" : "")}>
          <div className="ms-header-text">
            <h1 className="ms-eyebrow">
              <span className="ms-eyebrow-dot" aria-hidden="true" />
              <span>Milestones</span>
            </h1>
            <p className="ms-header-sub">
              {project
                ? `Các giai đoạn (phase) của ${project.name}. Mỗi task thuộc một milestone để AI có thể lên kế hoạch theo tiến độ.`
                : "Các giai đoạn (phase) của project. Mỗi task thuộc một milestone để AI có thể lên kế hoạch theo tiến độ."}
            </p>
          </div>
          <div className="ms-header-meta">
            <span className="ms-header-meta-value">{stats.total}</span>
            <span className="ms-header-meta-label">milestones</span>
          </div>
        </header>

        {/* ================= KPI ================= */}
        <section className="ms-kpi" aria-label="Milestone overview">
          <KpiCard
            label="Total milestones"
            value={String(stats.total)}
            unit="phases"
            icon="flag"
            pct={100}
            foot={
              stats.total === 0
                ? "Chưa có giai đoạn nào"
                : `${stats.total} giai đoạn trong project`
            }
          />
          <KpiCard
            label="In progress"
            value={String(stats.active)}
            unit={`/ ${stats.total}`}
            icon="play_circle"
            tone="primary"
            pct={stats.total ? (stats.active / stats.total) * 100 : 0}
            foot="Đang được thực hiện"
          />
          <KpiCard
            label="Completed"
            value={String(stats.done)}
            unit={`/ ${stats.total}`}
            icon="task_alt"
            tone="primary"
            pct={completionPct}
            foot={`${completionPct}% đã hoàn tất`}
          />
          <KpiCard
            label="Overdue"
            value={String(stats.overdue)}
            unit="late"
            icon="priority_high"
            pct={stats.total ? (stats.overdue / stats.total) * 100 : 0}
            foot={
              stats.overdue > 0
                ? "Cần rà soát tiến độ"
                : "Không có milestone trễ hạn"
            }
          />
        </section>

        {/* ================= States ================= */}
        {loading && (
          <div className="ms-skeleton" aria-hidden="true">
            <div className="ms-skeleton-state">
              <span className="material-symbols-outlined ms-spin">
                progress_activity
              </span>
              <span>Đang tải milestones…</span>
            </div>
            {[0, 1, 2].map((i) => (
              <div
                key={i}
                className="ms-skeleton-row"
                style={{ animationDelay: `${i * 90}ms` }}
              >
                <span className="ms-skeleton-index" />
                <span className="ms-skeleton-lines">
                  <span className="ms-skeleton-line ms-skeleton-line--lg" />
                  <span className="ms-skeleton-line ms-skeleton-line--sm" />
                </span>
              </div>
            ))}
          </div>
        )}

        {!loading && error && (
          <div className="ms-state ms-state--error" role="alert">
            <span className="material-symbols-outlined">error</span>
            <span>{error}</span>
            <button
              type="button"
              className="ms-btn ms-btn--ghost"
              onClick={() => void reload()}
            >
              Thử lại
            </button>
          </div>
        )}

        {isEmpty && (
          <div className="ms-empty">
            <span className="material-symbols-outlined ms-empty-icon">
              flag
            </span>
            <h2 className="ms-empty-title">Chưa có milestone nào</h2>
            <p className="ms-empty-sub">
              Milestone là các giai đoạn của project. Tạo phase đầu tiên để bắt
              đầu phân rã task.
            </p>
            <button
              type="button"
              className="ms-btn ms-btn--primary"
              onClick={openCreate}
            >
              <span className="material-symbols-outlined ms-btn-icon">add</span>
              <span>Tạo milestone</span>
            </button>
          </div>
        )}

        {/* ================= List ================= */}
        {!loading && !error && milestones.length > 0 && (
          <section className="ms-list-wrap" aria-label="Milestone list">
            <div className="ms-list-head">
              <span className="ms-list-count">
                {milestones.length} milestone
                {milestones.length === 1 ? "" : "s"}
              </span>
              <span className="ms-list-hint">
                <span className="material-symbols-outlined">drag_indicator</span>
                Sắp xếp theo order
              </span>
            </div>

            <ol className="ms-list">
              {milestones.map((m, i) => (
                <MilestoneRow
                  key={m.id}
                  milestone={m}
                  index={i}
                  mounted={mounted}
                  tasks={tasksByMilestone.get(m.id) ?? []}
                  tasksLoading={tasksLoading}
                  tasksError={tasksError}
                  expanded={expanded === m.id}
                  onToggle={() => toggleMilestone(m.id)}
                  onEdit={() => openEdit(m)}
                  onDelete={() => {
                    setDeleting(m);
                    setDeleteError(null);
                  }}
                />
              ))}
            </ol>
          </section>
        )}
      </div>

      {/* ================= Modal: create / edit ================= */}
      {formOpen &&
        createPortal(
          <div
            className="ms-modal-backdrop"
            onClick={(e) => {
              if (e.target === e.currentTarget) closeForm();
            }}
          >
            <div
              className="ms-modal"
              role="dialog"
              aria-modal="true"
              aria-labelledby="ms-modal-title"
            >
              <div className="ms-modal-head">
                <div>
                  <span className="ms-modal-eyebrow">
                    <span className="material-symbols-outlined">
                      {editing ? "edit" : "add_task"}
                    </span>
                    {editing ? "Edit milestone" : "New milestone"}
                  </span>
                  <h2 className="ms-modal-title" id="ms-modal-title">
                    {editing ? "Cập nhật milestone" : "Thêm milestone"}
                  </h2>
                  <p className="ms-modal-sub">
                    {editing
                      ? "Chỉnh sửa tên, hạn chót và trạng thái của giai đoạn."
                      : "Định nghĩa một giai đoạn (phase) của project."}
                  </p>
                </div>
                <button
                  type="button"
                  className="ms-modal-close"
                  onClick={closeForm}
                  aria-label="Close"
                >
                  <span className="material-symbols-outlined">close</span>
                </button>
              </div>

              <form className="ms-form" onSubmit={handleSubmit}>
                <div className="ms-field">
                  <label className="ms-label" htmlFor="ms-name">
                    Tên milestone <span className="ms-req">*</span>
                  </label>
                  <input
                    id="ms-name"
                    className="ms-input"
                    value={form.name}
                    onChange={(e) =>
                      setForm((f) => ({ ...f, name: e.target.value }))
                    }
                    placeholder="VD: Phase 1 — Thiết kế UX"
                    autoFocus
                    maxLength={200}
                  />
                </div>

                <div className="ms-field-row">
                  <div className="ms-field">
                    <label className="ms-label" htmlFor="ms-order">
                      Order <span className="ms-req">*</span>
                    </label>
                    <input
                      id="ms-order"
                      className="ms-input"
                      type="number"
                      min={1}
                      step={1}
                      value={form.orderIndex}
                      onChange={(e) =>
                        setForm((f) => ({ ...f, orderIndex: e.target.value }))
                      }
                    />
                  </div>
                  <div className="ms-field">
                    <label className="ms-label" htmlFor="ms-due">
                      Hạn chót
                    </label>
                    <input
                      id="ms-due"
                      className="ms-input"
                      type="date"
                      value={form.dueDate}
                      onChange={(e) =>
                        setForm((f) => ({ ...f, dueDate: e.target.value }))
                      }
                    />
                  </div>
                </div>

                <div className="ms-field-row">
                  <div className="ms-field">
                    <label className="ms-label" htmlFor="ms-status">
                      Trạng thái
                    </label>
                    <select
                      id="ms-status"
                      className="ms-input"
                      value={form.status}
                      onChange={(e) =>
                        setForm((f) => ({
                          ...f,
                          status: e.target.value as MilestoneStatus,
                        }))
                      }
                    >
                      {MILESTONE_STATUSES.map((s) => (
                        <option key={s} value={s}>
                          {prettyStatus(s)}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="ms-field">
                    <label className="ms-label" htmlFor="ms-revision">
                      Revision count
                    </label>
                    <input
                      id="ms-revision"
                      className="ms-input"
                      type="number"
                      min={0}
                      step={1}
                      value={form.revisionCount}
                      onChange={(e) =>
                        setForm((f) => ({
                          ...f,
                          revisionCount: e.target.value,
                        }))
                      }
                    />
                  </div>
                </div>

                {formError && (
                  <div className="ms-form-error" role="alert">
                    <span className="material-symbols-outlined">error</span>
                    <span>{formError}</span>
                  </div>
                )}

                <div className="ms-form-actions">
                  <button
                    type="button"
                    className="ms-btn ms-btn--text"
                    onClick={closeForm}
                    disabled={saving}
                  >
                    Huỷ
                  </button>
                  <button
                    type="submit"
                    className="ms-btn ms-btn--primary"
                    disabled={saving}
                  >
                    {saving ? (
                      <span className="material-symbols-outlined ms-spin">
                        progress_activity
                      </span>
                    ) : (
                      <span className="material-symbols-outlined ms-btn-icon">
                        check
                      </span>
                    )}
                    <span>
                      {editing ? "Lưu thay đổi" : "Tạo milestone"}
                    </span>
                  </button>
                </div>
              </form>
            </div>
          </div>,
          document.body,
        )}

      {/* ================= Modal: delete ================= */}
      {deleting &&
        createPortal(
          <div
            className="ms-modal-backdrop"
            onClick={(e) => {
              if (e.target === e.currentTarget && !removing) setDeleting(null);
            }}
          >
            <div
              className="ms-modal ms-modal--confirm"
              role="alertdialog"
              aria-modal="true"
              aria-labelledby="ms-del-title"
            >
              <div className="ms-modal-head">
                <div>
                  <span className="ms-modal-eyebrow ms-modal-eyebrow--danger">
                    <span className="material-symbols-outlined">warning</span>
                    Delete milestone
                  </span>
                  <h2 className="ms-modal-title" id="ms-del-title">
                    Xoá milestone?
                  </h2>
                  <p className="ms-modal-sub">
                    <strong>{deleting.name}</strong> sẽ bị xoá. Các task đang
                    thuộc milestone này sẽ mất liên kết.
                  </p>
                </div>
              </div>

              {deleteError && (
                <div className="ms-form-error" role="alert">
                  <span className="material-symbols-outlined">error</span>
                  <span>{deleteError}</span>
                </div>
              )}

              <div className="ms-form-actions">
                <button
                  type="button"
                  className="ms-btn ms-btn--text"
                  onClick={() => setDeleting(null)}
                  disabled={removing}
                >
                  Giữ lại
                </button>
                <button
                  type="button"
                  className="ms-btn ms-btn--danger"
                  onClick={() => void handleDelete()}
                  disabled={removing}
                >
                  {removing ? (
                    <span className="material-symbols-outlined ms-spin">
                      progress_activity
                    </span>
                  ) : (
                    <span className="material-symbols-outlined ms-btn-icon">
                      delete
                    </span>
                  )}
                  <span>Xoá</span>
                </button>
              </div>
            </div>
          </div>,
          document.body,
        )}

      <CenterToasts toasts={toasts} onDismiss={toast.dismiss} />
    </div>
  );
}

/* ===========================================================
 * Milestone row — timeline entry
 * =========================================================== */
function MilestoneRow({
  milestone,
  index,
  mounted,
  tasks,
  tasksLoading,
  tasksError,
  expanded,
  onToggle,
  onEdit,
  onDelete,
}: {
  milestone: MilestoneDto;
  index: number;
  mounted: boolean;
  tasks: TaskDto[];
  tasksLoading: boolean;
  tasksError: string | null;
  expanded: boolean;
  onToggle: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const tone = statusTone(milestone.status);
  const due = dueLabel(milestone.dueDate);
  const taskCount = tasks.length;
  const doneCount = tasks.filter(
    (t) => taskIsDone(t.status),
  ).length;

  return (
    <li
      className={
        "ms-item" + (mounted ? " ms-item--in" : "") + (expanded ? " ms-item--open" : "")
      }
      style={{ animationDelay: `${index * 60}ms` } as CSSProperties}
    >
      {/* Rail: index + connector */}
      <div className="ms-item-rail" aria-hidden="true">
        <span className={`ms-item-index ms-item-index--${tone}`}>
          {milestone.orderIndex ?? index + 1}
        </span>
        <span className="ms-item-connector" />
      </div>

      {/* Body */}
      <div className={`ms-item-card ms-item-card--${tone}`}>
        <div className="ms-item-head">
          <div className="ms-item-head-text">
            <h3 className="ms-item-name">{milestone.name}</h3>
            <div className="ms-item-meta">
              <span className={`ms-item-status ms-item-status--${tone}`}>
                <span className="ms-item-status-dot" aria-hidden="true" />
                {prettyStatus(milestone.status)}
              </span>
              <span className="ms-item-meta-item">
                <span className="material-symbols-outlined">event</span>
                {fmtDate(milestone.dueDate)}
              </span>
              <span
                className={`ms-item-meta-item ms-item-meta-item--${due.kind}`}
              >
                <span className="material-symbols-outlined">schedule</span>
                {due.label}
              </span>
              {milestone.revisionCount > 0 && (
                <span className="ms-item-meta-item">
                  <span className="material-symbols-outlined">history</span>
                  {milestone.revisionCount} revision
                  {milestone.revisionCount === 1 ? "" : "s"}
                </span>
              )}
            </div>
          </div>

          <div className="ms-item-actions">
            {/* Nút mở task của phase */}
            <button
              type="button"
              className={"ms-icon-btn ms-icon-btn--expand" + (expanded ? " ms-icon-btn--expanded" : "")}
              onClick={onToggle}
              title={expanded ? "Ẩn task" : "Xem task của phase"}
              aria-label={
                expanded
                  ? `Ẩn task của ${milestone.name}`
                  : `Xem task của ${milestone.name}`
              }
              aria-expanded={expanded}
            >
              <span className="material-symbols-outlined">account_tree</span>
            </button>
            <button
              type="button"
              className="ms-icon-btn"
              onClick={onEdit}
              title="Sửa milestone"
              aria-label={`Edit ${milestone.name}`}
            >
              <span className="material-symbols-outlined">edit</span>
            </button>
            <button
              type="button"
              className="ms-icon-btn ms-icon-btn--danger"
              onClick={onDelete}
              title="Xoá milestone"
              aria-label={`Delete ${milestone.name}`}
            >
              <span className="material-symbols-outlined">delete</span>
            </button>
          </div>
        </div>

        {/* Timestamps */}
        {(milestone.deliveredAt || milestone.approvedAt) && (
          <div className="ms-item-timestamps">
            {milestone.deliveredAt && (
              <span className="ms-item-timestamp">
                <span className="material-symbols-outlined">outbound</span>
                Delivered {fmtDate(milestone.deliveredAt)}
              </span>
            )}
            {milestone.approvedAt && (
              <span className="ms-item-timestamp">
                <span className="material-symbols-outlined">verified</span>
                Approved {fmtDate(milestone.approvedAt)}
              </span>
            )}
          </div>
        )}

        <span className="ms-item-id" title={milestone.id}>
          {shortId(milestone.id)}
        </span>

        {/* ===== Task của phase (mở rộng) ===== */}
        {expanded && (
          <div className="ms-tasks">
            {tasksLoading ? (
              <div className="ms-tasks-state" role="status">
                <span className="material-symbols-outlined ms-spin">
                  progress_activity
                </span>
                <span>Đang tải task…</span>
              </div>
            ) : tasksError ? (
              <div className="ms-tasks-state ms-tasks-state--error" role="alert">
                <span className="material-symbols-outlined">error</span>
                <span>{tasksError}</span>
              </div>
            ) : taskCount === 0 ? (
              <div className="ms-tasks-state">
                <span className="material-symbols-outlined">task_alt</span>
                <span>
                  Phase này chưa có task. Thêm task trong{" "}
                  <strong>Planning</strong> để gán vào phase.
                </span>
              </div>
            ) : (
              <>
                <div className="ms-tasks-head">
                  <span className="ms-tasks-title">
                    <span className="material-symbols-outlined">account_tree</span>
                    Tasks trong phase
                  </span>
                  <span className="ms-tasks-count">
                    {doneCount}/{taskCount}
                  </span>
                </div>

                {/* Progress bar của phase */}
                <div className="ms-tasks-bar">
                  <span
                    className="ms-tasks-bar-fill"
                    style={{
                      width: `${taskCount > 0 ? (doneCount / taskCount) * 100 : 0}%`,
                    }}
                  />
                </div>

                <ul className="ms-task-list">
                  {tasks.map((t, ti) => (
                    <TaskRow key={t.id} task={t} index={ti} />
                  ))}
                </ul>
              </>
            )}
          </div>
        )}
      </div>
    </li>
  );
}

/* ===========================================================
 * Task row — task thuộc phase (read-only, không mở subtask)
 * =========================================================== */
function TaskRow({ task, index }: { task: TaskDto; index: number }) {
  const isDone = taskIsDone(task.status);
  const tone = taskTone(task.status);
  const overdue = isTaskOverdue(task.deadline, isDone);
  const est = task.estimatedMinutes ?? 0;

  return (
    <li
      className={
        "ms-task ms-task--in ms-task--" + tone + (isDone ? " ms-task--done" : "")
      }
      style={{ animationDelay: `${index * 40}ms` } as CSSProperties}
    >
      {/* Marker: số thứ tự trong phase */}
      <span className="ms-task-marker" aria-hidden="true">
        <span className={`ms-task-dot ms-task-dot--${tone}`} />
      </span>

      {/* Nội dung */}
      <div className="ms-task-body">
        <span className="ms-task-title">{task.title}</span>

        <div className="ms-task-meta">
          <span className={`ms-task-pill ms-task-pill--${tone}`}>
            {prettyTaskStatus(task.status)}
          </span>

          {est > 0 && (
            <span className="ms-task-meta-item">
              <span className="material-symbols-outlined">timer</span>
              {formatMinutes(est)}
            </span>
          )}

          {task.deadline && (
            <span
              className={
                "ms-task-meta-item" + (overdue ? " ms-task-meta-item--overdue" : "")
              }
            >
              <span className="material-symbols-outlined">event</span>
              {fmtDate(task.deadline)}
            </span>
          )}

          {task.taskType && (
            <span className="ms-task-meta-item ms-task-meta-item--type">
              {task.taskType}
            </span>
          )}
        </div>
      </div>

      {/* Trạng thái hoàn thành */}
      {isDone && (
        <span className="ms-task-check" aria-label="Hoàn thành">
          <span className="material-symbols-outlined">check</span>
        </span>
      )}
    </li>
  );
}

/* ===========================================================
 * KPI card
 * =========================================================== */
function KpiCard({
  label,
  value,
  unit,
  icon,
  foot,
  tone,
  pct,
}: {
  label: string;
  value: string;
  unit: string;
  icon: string;
  foot: string;
  tone?: "primary";
  pct: number;
}) {
  return (
    <div className="ms-kpi-card">
      <div className="ms-kpi-head">
        <span className="ms-kpi-label">{label}</span>
        <span
          className={
            "ms-kpi-icon" + (tone === "primary" ? " ms-kpi-icon--primary" : "")
          }
        >
          <span className="material-symbols-outlined">{icon}</span>
        </span>
      </div>
      <div className="ms-kpi-body">
        <div className="ms-kpi-value-row">
          <span
            className={
              "ms-kpi-value" +
              (tone === "primary" ? " ms-kpi-value--primary" : "")
            }
          >
            {value}
          </span>
          <span className="ms-kpi-unit">{unit}</span>
        </div>
        <div className="ms-kpi-bar">
          <span
            className="ms-kpi-bar-fill"
            style={{ width: `${Math.max(0, Math.min(100, pct))}%` }}
          />
        </div>
        <p className="ms-kpi-foot">{foot}</p>
      </div>
    </div>
  );
}

/* ===========================================================
 * Helpers
 * =========================================================== */
function sortMilestones(list: MilestoneDto[]): MilestoneDto[] {
  return [...list].sort((a, b) => {
    const ao = a.orderIndex ?? 0;
    const bo = b.orderIndex ?? 0;
    if (ao !== bo) return ao - bo;
    const ad = a.dueDate ? new Date(a.dueDate).getTime() : Infinity;
    const bd = b.dueDate ? new Date(b.dueDate).getTime() : Infinity;
    return ad - bd;
  });
}

/** Task đã hoàn thành? */
function taskIsDone(status: string | null | undefined): boolean {
  const s = (status ?? "").toLowerCase();
  return s === "done" || s === "completed";
}

/** Task quá hạn? (deadline đã qua và chưa xong) */
function isTaskOverdue(
  deadline: string | null | undefined,
  isDone: boolean,
): boolean {
  if (!deadline || isDone) return false;
  const d = new Date(deadline);
  if (Number.isNaN(d.getTime())) return false;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const target = new Date(d);
  target.setHours(0, 0, 0, 0);
  return target.getTime() < today.getTime();
}

/** Thứ tự ưu tiên khi sort task: đang làm → todo → scheduled → done. */
function taskWeight(status: string | null | undefined): number {
  const s = (status ?? "").toLowerCase();
  if (s === "inprogress" || s === "in_progress") return 0;
  if (s === "todo" || s === "pending") return 1;
  if (s === "scheduled") return 2;
  if (s === "skipped" || s === "cancelled") return 4;
  if (taskIsDone(s)) return 5;
  return 3;
}

/** Map status task → nhóm tone màu. */
function taskTone(status: string | null | undefined): string {
  const s = (status ?? "").toLowerCase();
  if (s === "inprogress" || s === "in_progress") return "active";
  if (s === "scheduled") return "scheduled";
  if (taskIsDone(s)) return "done";
  if (s === "skipped") return "skipped";
  if (s === "cancelled") return "cancelled";
  return "todo";
}

/** Label đẹp cho status task. */
function prettyTaskStatus(status: string | null | undefined): string {
  const s = (status ?? "").toLowerCase();
  const map: Record<string, string> = {
    todo: "To do",
    pending: "To do",
    scheduled: "Scheduled",
    inprogress: "In progress",
    in_progress: "In progress",
    done: "Done",
    completed: "Done",
    skipped: "Skipped",
    cancelled: "Cancelled",
  };
  return map[s] ?? status ?? "To do";
}

/** "1h 30m" / "45m" */
function formatMinutes(minutes: number): string {
  if (!Number.isFinite(minutes) || minutes <= 0) return "";
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  if (h === 0) return `${m}m`;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}m`;
}
