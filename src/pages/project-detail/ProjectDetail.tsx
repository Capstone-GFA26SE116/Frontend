import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { CenterToasts, useCenterToast } from "../../components/Toast";
import { ProjectErrorDialog } from "./ProjectErrorDialog";
import {
  rawServerMessage,
  toProjectErrorView,
  type ProjectErrorView,
} from "./project-errors";
import {
  deleteMilestone,
  deleteSubtask,
  deleteTask,
  getProject,
  listClients,
  listDomains,
  listMilestones,
  listSubtasks,
  listTasks,
  updateMilestone,
  updateProject,
  updateSubtask,
  updateTask,
  type ApiErr,
  type ClientDto,
  type DomainDto,
  type MilestoneDto,
  type ProjectDto,
  type SubtaskDto,
  type TaskDto,
} from "../../lib/api-client";
import "./project-detail.css";

/**
 * Đối tượng đang được sửa ở Project Detail.
 *
 * `kind` quyết định modal nào hiện và endpoint PUT nào được gọi:
 *   - `milestone` → PUT /api/milestones/{id}
 *   - `task`      → PUT /api/tasks/{id}
 *   - `subtask`   → PUT /api/subtasks/{id}
 */
type EditTarget =
  | { kind: "milestone"; item: MilestoneDto }
  | { kind: "task"; item: TaskDto }
  | { kind: "subtask"; item: SubtaskDto };

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

  /* ---------- Xóa milestone / task (có hộp thoại xác nhận tiếng Anh) ---------- */
  /**
   * Đối tượng đang chờ xác nhận xóa.
   *
   * ⚠️ KHÔNG xóa ngay khi bấm nút thùng — chỉ mở hộp thoại xác nhận.
   * Chỉ khi bấm "Delete" trong hộp thoại mới gọi API.
   */
  const [pendingDelete, setPendingDelete] = useState<
    | { kind: "milestone"; id: string; title: string }
    | { kind: "task"; id: string; title: string }
    | { kind: "subtask"; id: string; title: string; taskId: string }
    | null
  >(null);
  /** Đang gọi API xóa → khoá nút xác nhận. */
  const [deleting, setDeleting] = useState(false);
  const [toasts, toast] = useCenterToast();

  /* ---------- Hộp thoại báo lỗi (tiếng Anh) ---------- */
  /**
   * Lỗi đang hiển thị.
   *
   * ⚠️ KHÔNG dùng toast cho lỗi — toast tự tắt sau 3.2s, người dùng không
   * kịp đọc. Lỗi dùng modal có nút "Close" + gợi ý hành động.
   */
  const [errorDialog, setErrorDialog] = useState<{
    view: ProjectErrorView;
    raw: string;
  } | null>(null);

  /**
   * 409 `MILESTONE_HAS_OPEN_TASKS` — milestone còn task dở, BE từ chối
   * chuyển sang `Delivered`.
   *
   * Ta lưu lại body đã sửa + milestone id để khi user bấm
   * "Deliver anyway" thì gửi lại kèm `confirmOpenTasks: true`.
   */
  const [openTasksWarning, setOpenTasksWarning] = useState<{
    milestoneId: string;
    body: {
      name: string;
      orderIndex: number;
      dueDate: string | null;
      status: string;
      revisionCount: number;
    };
    openTaskCount: number;
    openSubTaskCount: number;
    tasks: string[];
  } | null>(null);

  /* ---------- Sửa project (PUT /api/projects/{projectId}) ---------- */
  /** Mở/đóng modal sửa project. */
  const [editOpen, setEditOpen] = useState(false);
  /** Danh sách client để chọn trong modal sửa. */
  const [clients, setClients] = useState<ClientDto[]>([]);
  /** Danh sách domain (loại công việc) để chọn khi sửa task. */
  const [domains, setDomains] = useState<DomainDto[]>([]);

  /* ---------- Sửa milestone / task / subtask ---------- */
  /**
   * Đối tượng đang được sửa.
   *
   * `kind` quyết định modal nào hiện và endpoint PUT nào được gọi:
   *   - `milestone` → PUT /api/milestones/{id}
   *   - `task`      → PUT /api/tasks/{id}
   *   - `subtask`   → PUT /api/subtasks/{id}
   */
  const [editing, setEditing] = useState<EditTarget | null>(null);

  // Lazy-load subtasks for a task (only first time)
  function loadSubtasks(taskId: string) {
    if (subtasksMap[taskId] !== undefined || subtasksLoading[taskId]) return;
    setSubtasksLoading((p) => ({ ...p, [taskId]: true }));
    void listSubtasks(taskId).then((res) => {
      setSubtasksMap((p) => ({ ...p, [taskId]: res.ok ? res.data : [] }));
      setSubtasksLoading((p) => ({ ...p, [taskId]: false }));
      if (!res.ok) {
        showApiError(res, "load the subtasks of this task");
      }
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
        showApiError(res, "load the milestones of this project");
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
        showApiError(res, "load the tasks of this project");
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

  /**
   * Đổi lỗi API thành hộp thoại dễ hiểu (tiếng Anh).
   *
   * @param action Động từ ngắn mô tả thao tác, VD: "delete this task".
   */
  function showApiError(
    res: { ok: false } & Record<string, unknown>,
    action?: string,
  ) {
    const err = res as ApiErr;
    setErrorDialog({
      view: toProjectErrorView(err, undefined, { action }),
      raw: rawServerMessage(err, undefined),
    });
  }

  /**
   * Mở modal sửa project.
   *
   * Load danh sách client (để chọn `clientId`) — lỗi load client không
   * block, user vẫn sửa được các trường khác.
   */
  function openEditProject() {
    setEditOpen(true);
    void listClients().then((res) => {
      if (res.ok) setClients(res.data);
    });
  }

  /**
   * Mở modal sửa milestone / task / subtask.
   *
   * Load danh sách domain (loại công việc) để chọn khi sửa task — lỗi load
   * không block, user vẫn sửa được các trường khác.
   */
  function openEditItem(target: EditTarget) {
    setEditing(target);
    if (target.kind === "task" && domains.length === 0) {
      void listDomains().then((res) => {
        if (res.ok) setDomains(res.data);
      });
    }
  }

  /**
   * Bấm nút thùng → CHỈ mở hộp thoại xác nhận (tiếng Anh), chưa xóa.
   */
  function requestDeleteMilestone(milestone: MilestoneDto) {
    setPendingDelete({ kind: "milestone", id: milestone.id, title: milestone.name });
  }

  function requestDeleteTask(task: TaskDto) {
    setPendingDelete({ kind: "task", id: task.id, title: task.title });
  }

  /**
   * Bấm nút thùng ở 1 subtask → CHỈ mở hộp thoại xác nhận.
   *
   * `taskId` cần để biết subtask nằm trong task nào (để cập nhật list
   * subtask đã load của task đó sau khi xóa).
   */
  function requestDeleteSubtask(subtask: SubtaskDto, taskId: string) {
    setPendingDelete({
      kind: "subtask",
      id: subtask.id,
      title: subtask.title,
      taskId,
    });
  }

  /**
   * Xác nhận xóa → gọi API.
   *
   * Milestone: BE trả 409 `MILESTONE_HAS_OPEN_TASKS` nếu còn task dở →
   * lúc đó ta báo lỗi bằng toast (người dùng có thể xóa task trước).
   */
  async function confirmDelete() {
    if (!pendingDelete || deleting) return;
    setDeleting(true);
    const target = pendingDelete;

    if (target.kind === "milestone") {
      const res = await deleteMilestone(target.id);
      setDeleting(false);
      if (!res.ok) {
        showApiError(res, "delete this milestone");
        return;
      }
      setMilestones((prev) => prev.filter((m) => m.id !== target.id));
      // Task thuộc milestone đã xóa → bỏ liên kết (milestoneId = null).
      setTasks((prev) =>
        prev.map((t) =>
          t.milestoneId === target.id ? { ...t, milestoneId: null } : t,
        ),
      );
      toast.success("Milestone deleted", target.title);
      setPendingDelete(null);
      return;
    }

    if (target.kind === "subtask") {
      const res = await deleteSubtask(target.id);
      setDeleting(false);
      if (!res.ok) {
        showApiError(res, "delete this subtask");
        return;
      }
      // Xoá khỏi list subtask đã load của task cha.
      setSubtasksMap((prev) => {
        const list = prev[target.taskId];
        if (!list) return prev;
        return {
          ...prev,
          [target.taskId]: list.filter((s) => s.id !== target.id),
        };
      });
      toast.success("Subtask deleted", target.title);
      setPendingDelete(null);
      return;
    }

    const res = await deleteTask(target.id);
    setDeleting(false);
    if (!res.ok) {
      showApiError(res, "delete this task");
      return;
    }
    setTasks((prev) => prev.filter((t) => t.id !== target.id));
    // Dọn subtask đã load của task vừa xóa.
    setSubtasksMap((prev) => {
      const next = { ...prev };
      delete next[target.id];
      return next;
    });
    setExpandedTasks((prev) => {
      const next = new Set(prev);
      next.delete(target.id);
      return next;
    });
    toast.success("Task deleted", target.title);
    setPendingDelete(null);
  }

  /**
   * Lưu thông tin project đã sửa → `PUT /api/projects/{projectId}`.
   *
   * ⚠️ BE dùng **partial update**: chỉ gửi trường thực sự thay đổi.
   * `clientId` rỗng → gửi `null` (dự án nội bộ, không thuộc client nào).
   */
  async function handleSaveProject(body: {
    name: string;
    description: string;
    startDate: string;
    deadline: string;
    clientId: string | null;
  }) {
    if (!project) return;
    const res = await updateProject(project.id, body);
    if (!res.ok) {
      showApiError(res, "update this project");
      return;
    }
    setProject(res.data);
    setEditOpen(false);
    toast.success("Project updated", res.data.name);
  }

  /**
   * Lưu milestone đã sửa → `PUT /api/milestones/{milestoneId}`.
   *
   * ⚠️ Khi đổi status sang `Delivered` mà còn task dở, BE trả 409
   * `MILESTONE_HAS_OPEN_TASKS` → ta báo lỗi, user có thể xử lý task trước
   * hoặc đổi status khác.
   */
  async function handleSaveMilestone(body: {
    name: string;
    orderIndex: number;
    dueDate: string | null;
    status: string;
    revisionCount: number;
  }) {
    if (!editing || editing.kind !== "milestone") return;
    const milestoneId = editing.item.id;
    const res = await updateMilestone(milestoneId, body);

    // 409 MILESTONE_HAS_OPEN_TASKS → hỏi user có giao giai đoạn dù còn task dở.
    if (!res.ok && res.status === 409 && isOpenTasksError(res)) {
      const details = (res.details ?? {}) as {
        openTaskCount?: number;
        openSubTaskCount?: number;
        tasks?: { title?: string }[];
      };
      setOpenTasksWarning({
        milestoneId,
        body,
        openTaskCount: details.openTaskCount ?? 0,
        openSubTaskCount: details.openSubTaskCount ?? 0,
        tasks: (details.tasks ?? [])
          .map((t) => t?.title ?? "")
          .filter((t) => t.length > 0),
      });
      return;
    }

    if (!res.ok) {
      showApiError(res, "update this milestone");
      return;
    }
    setMilestones((prev) =>
      prev.map((m) => (m.id === res.data.id ? res.data : m)),
    );
    setEditing(null);
    toast.success("Milestone updated", res.data.name);
  }

  /**
   * Giao giai đoạn dù còn task dở — gửi lại cùng body kèm
   * `confirmOpenTasks: true` (BE chấp nhận, task dở giữ nguyên).
   */
  async function handleDeliverAnyway() {
    if (!openTasksWarning) return;
    const { milestoneId, body } = openTasksWarning;
    setOpenTasksWarning(null);
    const res = await updateMilestone(milestoneId, {
      ...body,
      confirmOpenTasks: true,
    });
    if (!res.ok) {
      showApiError(res, "deliver this milestone anyway");
      return;
    }
    setMilestones((prev) =>
      prev.map((m) => (m.id === res.data.id ? res.data : m)),
    );
    setEditing(null);
    toast.success("Milestone delivered", res.data.name);
  }

  /**
   * Lưu task đã sửa → `PUT /api/tasks/{taskId}`.
   *
   * ⚠️ BE dùng **partial update** → chỉ gửi trường thực sự đổi.
   */
  async function handleSaveTask(body: {
    title: string;
    description: string;
    taskType: string;
    status: string;
    domainId: string | null;
    milestoneId: string | null;
    deadline: string | null;
    estimatedMinutes: number;
    aiEstimatedMinutes: number;
    fixedStart: string | null;
    fixedEnd: string | null;
  }) {
    if (!editing || editing.kind !== "task") return;
    const res = await updateTask(editing.item.id, body);
    if (!res.ok) {
      showApiError(res, "update this task");
      return;
    }
    setTasks((prev) => prev.map((t) => (t.id === res.data.id ? res.data : t)));
    setEditing(null);
    toast.success("Task updated", res.data.title);
  }

  /**
   * Lưu subtask đã sửa → `PUT /api/subtasks/{subtaskId}`.
   */
  async function handleSaveSubtask(body: {
    title: string;
    description: string | null;
    estimatedMinutes: number;
    orderIndex: number;
    status: string;
  }) {
    if (!editing || editing.kind !== "subtask") return;
    /*
     * ⚠️ `CreateSubtaskRequest.description` là `string | undefined` (KHÔNG
     * nhận `null`) → chuẩn hoá null thành undefined trước khi gửi.
     */
    const res = await updateSubtask(editing.item.id, {
      ...body,
      description: body.description ?? undefined,
    });
    if (!res.ok) {
      showApiError(res, "update this subtask");
      return;
    }
    // Cập nhật list subtask đã load của task cha.
    setSubtasksMap((prev) => {
      const list = prev[res.data.taskId];
      if (!list) return prev;
      return {
        ...prev,
        [res.data.taskId]: list.map((s) =>
          s.id === res.data.id ? res.data : s,
        ),
      };
    });
    setEditing(null);
    toast.success("Subtask updated", res.data.title);
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
                onClick={openEditProject}
                title="Edit project"
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
            onDeleteMilestone={requestDeleteMilestone}
            onDeleteTask={requestDeleteTask}
            onDeleteSubtask={requestDeleteSubtask}
            onEdit={openEditItem}
          />
        )}

        {/* Modal sửa project — PUT /api/projects/{projectId} */}
        {editOpen && project && (
          <EditProjectModal
            project={project}
            clients={clients}
            onClose={() => setEditOpen(false)}
            onSave={handleSaveProject}
          />
        )}

        {/* Modal sửa milestone / task / subtask */}
        {editing?.kind === "milestone" && (
          <EditMilestoneModal
            milestone={editing.item}
            onClose={() => setEditing(null)}
            onSave={handleSaveMilestone}
          />
        )}
        {editing?.kind === "task" && (
          <EditTaskModal
            task={editing.item}
            milestones={milestones}
            domains={domains}
            onClose={() => setEditing(null)}
            onSave={handleSaveTask}
          />
        )}
        {editing?.kind === "subtask" && (
          <EditSubtaskModal
            subtask={editing.item}
            onClose={() => setEditing(null)}
            onSave={handleSaveSubtask}
          />
        )}

        {/* Hộp thoại xác nhận xóa (tiếng Anh) */}
        <ConfirmDialog
          open={pendingDelete !== null}
          busy={deleting}
          title={
            pendingDelete?.kind === "milestone"
              ? `Delete milestone "${pendingDelete.title}"?`
              : pendingDelete?.kind === "task"
                ? `Delete task "${pendingDelete.title}"?`
                : pendingDelete?.kind === "subtask"
                  ? `Delete subtask "${pendingDelete.title}"?`
                  : ""
          }
          message={
            pendingDelete?.kind === "milestone"
              ? "Tasks in this milestone will become unassigned. This action cannot be undone."
              : pendingDelete?.kind === "task"
                ? "This will also delete all subtasks and scheduled slots inside. This action cannot be undone."
                : pendingDelete?.kind === "subtask"
                  ? "This will also remove its scheduled slot from the calendar. This action cannot be undone."
                  : ""
          }
          confirmLabel="Delete"
          onConfirm={() => void confirmDelete()}
          onCancel={() => {
            if (!deleting) setPendingDelete(null);
          }}
        />
      </div>

      {/* Hộp thoại báo lỗi (tiếng Anh) — thay cho toast 3.2s */}
      <ProjectErrorDialog
        error={errorDialog?.view ?? null}
        rawMessage={errorDialog?.raw || undefined}
        onClose={() => setErrorDialog(null)}
      />

      {openTasksWarning && (
        <ProjectErrorDialog
          error={{
            title: "This milestone still has unfinished work",
            message:
              "A milestone can only be marked as Delivered once every task inside it is done or skipped." +
              (openTasksWarning.openTaskCount > 0
                ? ` Right now ${openTasksWarning.openTaskCount} task${openTasksWarning.openTaskCount > 1 ? "s are" : " is"} still open`
                : "") +
              (openTasksWarning.openSubTaskCount > 0
                ? `, plus ${openTasksWarning.openSubTaskCount} unfinished subtask${openTasksWarning.openSubTaskCount > 1 ? "s" : ""}.`
                : "."),
            hint: "Finish the remaining tasks first, or deliver the milestone anyway — the open tasks will stay as they are.",
            tone: "warning",
            code: "MILESTONE_HAS_OPEN_TASKS",
            status: 409,
          }}
          itemsTitle="Tasks that are still open"
          items={openTasksWarning.tasks.map((t) => ({ title: t }))}
          confirmLabel="Deliver anyway"
          confirmDanger
          onClose={() => setOpenTasksWarning(null)}
          onConfirm={() => void handleDeliverAnyway()}
          onSecondary={() => setOpenTasksWarning(null)}
          secondaryLabel="Finish tasks first"
        />
      )}

      <CenterToasts toasts={toasts} onDismiss={toast.dismiss} />
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
  onDeleteMilestone,
  onDeleteTask,
  onDeleteSubtask,
  onEdit,
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
  /** Mở hộp thoại xác nhận xóa milestone (tiếng Anh). */
  onDeleteMilestone: (milestone: MilestoneDto) => void;
  /** Mở hộp thoại xác nhận xóa task (tiếng Anh). */
  onDeleteTask: (task: TaskDto) => void;
  /** Mở hộp thoại xác nhận xóa subtask (tiếng Anh). */
  onDeleteSubtask: (subtask: SubtaskDto, taskId: string) => void;
  /** Mở modal sửa milestone / task / subtask. */
  onEdit: (target: EditTarget) => void;
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
        onDeleteMilestone={onDeleteMilestone}
        onDeleteTask={onDeleteTask}
        onEditMilestone={(m) => onEdit({ kind: "milestone", item: m })}
        onEditTask={(t) => onEdit({ kind: "task", item: t })}
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
        onDeleteTask={onDeleteTask}
        onDeleteSubtask={onDeleteSubtask}
        onEditTask={(t) => onEdit({ kind: "task", item: t })}
        onEditSubtask={(s) => onEdit({ kind: "subtask", item: s })}
      />

      {/* Direction cards */}
      <section className="pd-directions" aria-label="Next steps">
        <div className="pd-section-head">
          <div>
            <span className="pd-section-eyebrow">Choose your flow</span>
            <h2 className="pd-section-title">How do you want to work on this project?</h2>
            <p className="pd-section-sub">
              METANOIA supports two flows: create tasks manually and place them on
              a schedule, or talk to AI and let it plan the work with you.
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

          {/*
            TODO: tạm thời ẩn luồng "AI auto-decompose" (/projects/:id/execution)
            cho tới khi luồng này ổn định. Route vẫn còn trong App.tsx nên
            deep-link vẫn vào được — chỉ ẩn entry point trên trang này.
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
          */}

          <Link
            to={`/projects/${project.id}/chat`}
            className="pd-direction pd-direction--chat"
            aria-label="Open AI chat for this project"
          >
            <div className="pd-direction-badge">AI</div>
            <div className="pd-direction-icon">
              <span className="material-symbols-outlined">forum</span>
            </div>
            <div className="pd-direction-body">
              <h3 className="pd-direction-title">AI chat</h3>
              <p className="pd-direction-desc">
                Talk to AI about this project — full chat history, project tree
                and one-click scheduling.
              </p>
            </div>
            <div className="pd-direction-cta">
              <span>Chat</span>
              <span className="material-symbols-outlined">arrow_forward</span>
            </div>
          </Link>
        </div>
      </section>

      {/* Kho tài liệu của dự án */}
      <section className="pd-docs" aria-label="Documents">
        <div className="pd-section-head">
          <div>
            <span className="pd-section-eyebrow">Documents</span>
            <h2 className="pd-section-title">Project documents</h2>
            <p className="pd-section-sub">
              Files and links attached to this project — briefs, contracts and
              design assets.
            </p>
          </div>
          <Link
            to={`/projects/${project.id}/documents`}
            className="pd-ms-view-all"
          >
            Open library
            <span className="material-symbols-outlined">arrow_forward</span>
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
  onDeleteMilestone,
  onDeleteTask,
  onEditMilestone,
  onEditTask,
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
  /** Mở hộp thoại xác nhận xóa milestone (tiếng Anh). */
  onDeleteMilestone: (milestone: MilestoneDto) => void;
  /** Mở hộp thoại xác nhận xóa task (tiếng Anh). */
  onDeleteTask: (task: TaskDto) => void;
  /** Mở modal sửa milestone. */
  onEditMilestone: (milestone: MilestoneDto) => void;
  /** Mở modal sửa task. */
  onEditTask: (task: TaskDto) => void;
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

                {/*
                  Nút xóa milestone.
                  ⚠️ Chỉ MỞ hộp thoại xác nhận — không xóa ngay.
                  Component cha (`ProjectDetailPage`) gọi API sau khi user
                  bấm "Delete" trong hộp thoại.
                */}
                <button
                  type="button"
                  className="pd-del-btn"
                  onClick={() => onDeleteMilestone(m)}
                  title={`Delete milestone "${m.name}"`}
                  aria-label={`Delete milestone ${m.name}`}
                >
                  <span className="material-symbols-outlined">delete</span>
                </button>

                {/*
                  Nút sửa milestone → mở modal `EditMilestoneModal`.
                */}
                <button
                  type="button"
                  className="pd-edit-btn"
                  onClick={() => onEditMilestone(m)}
                  title={`Edit milestone "${m.name}"`}
                  aria-label={`Edit milestone ${m.name}`}
                >
                  <span className="material-symbols-outlined">edit</span>
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
                          <MilestoneTaskLine
                            key={t.id}
                            task={t}
                            onDelete={onDeleteTask}
                            onEdit={onEditTask}
                          />
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
function MilestoneTaskLine({
  task,
  onDelete,
  onEdit,
}: {
  task: TaskDto;
  /** Mở hộp thoại xác nhận xóa task (tiếng Anh). */
  onDelete: (task: TaskDto) => void;
  /** Mở modal sửa task. */
  onEdit: (task: TaskDto) => void;
}) {
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
      {/*
        Nút xóa task.
        ⚠️ Chỉ MỞ hộp thoại xác nhận — không xóa ngay.
      */}
      <button
        type="button"
        className="pd-del-btn pd-del-btn--sm"
        onClick={() => onDelete(task)}
        title={`Delete task "${task.title}"`}
        aria-label={`Delete task ${task.title}`}
      >
        <span className="material-symbols-outlined">delete</span>
      </button>
      {/* Nút sửa task → mở modal `EditTaskModal`. */}
      <button
        type="button"
        className="pd-edit-btn pd-edit-btn--sm"
        onClick={() => onEdit(task)}
        title={`Edit task "${task.title}"`}
        aria-label={`Edit task ${task.title}`}
      >
        <span className="material-symbols-outlined">edit</span>
      </button>
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
  onDeleteTask,
  onDeleteSubtask,
  onEditTask,
  onEditSubtask,
}: {
  projectId: string;
  tasks: TaskDto[];
  loading: boolean;
  error: string | null;
  subtasksMap: Record<string, SubtaskDto[]>;
  subtasksLoading: Record<string, boolean>;
  expandedTasks: Set<string>;
  onToggleTask: (taskId: string) => void;
  /** Mở hộp thoại xác nhận xóa task (tiếng Anh). */
  onDeleteTask: (task: TaskDto) => void;
  /** Mở hộp thoại xác nhận xóa subtask (tiếng Anh). */
  onDeleteSubtask: (subtask: SubtaskDto, taskId: string) => void;
  /** Mở modal sửa task. */
  onEditTask: (task: TaskDto) => void;
  /** Mở modal sửa subtask. */
  onEditSubtask: (subtask: SubtaskDto) => void;
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
              onDelete={onDeleteTask}
              onDeleteSubtask={onDeleteSubtask}
              onEdit={onEditTask}
              onEditSubtask={onEditSubtask}
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
  onDelete,
  onDeleteSubtask,
  onEdit,
  onEditSubtask,
}: {
  task: TaskDto;
  isExpanded: boolean;
  onToggle: () => void;
  subtasks?: SubtaskDto[];
  subtasksLoading: boolean;
  /** Mở hộp thoại xác nhận xóa task (tiếng Anh). */
  onDelete: (task: TaskDto) => void;
  /** Mở hộp thoại xác nhận xóa subtask (tiếng Anh). */
  onDeleteSubtask: (subtask: SubtaskDto, taskId: string) => void;
  /** Mở modal sửa task. */
  onEdit: (task: TaskDto) => void;
  /** Mở modal sửa subtask. */
  onEditSubtask: (subtask: SubtaskDto) => void;
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
      {/*
        ⚠️ Nút xóa phải là ANH em của nút expand (không lồng trong `<button>`)
        — HTML không cho `<button>` chứa `<button>`.
      */}
      <div className="pd-task-row">
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

        {/*
          Nút xóa task.
          ⚠️ Chỉ MỞ hộp thoại xác nhận — không xóa ngay.
        */}
        <button
          type="button"
          className="pd-del-btn pd-del-btn--sm"
          onClick={() => onDelete(task)}
          title={`Delete task "${task.title}"`}
          aria-label={`Delete task ${task.title}`}
        >
          <span className="material-symbols-outlined">delete</span>
        </button>

        {/* Nút sửa task → mở modal `EditTaskModal`. */}
        <button
          type="button"
          className="pd-edit-btn pd-edit-btn--sm"
          onClick={() => onEdit(task)}
          title={`Edit task "${task.title}"`}
          aria-label={`Edit task ${task.title}`}
        >
          <span className="material-symbols-outlined">edit</span>
        </button>
      </div>

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
                <SubtaskPreviewRow
                  key={s.id}
                  subtask={s}
                  taskId={task.id}
                  onDelete={onDeleteSubtask}
                  onEdit={onEditSubtask}
                />
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

function SubtaskPreviewRow({
  subtask,
  taskId,
  onDelete,
  onEdit,
}: {
  subtask: SubtaskDto;
  /** Id của task cha (để cập nhật list sau khi xóa). */
  taskId: string;
  /** Mở hộp thoại xác nhận xóa subtask (tiếng Anh). */
  onDelete: (subtask: SubtaskDto, taskId: string) => void;
  /** Mở modal sửa subtask. */
  onEdit: (subtask: SubtaskDto) => void;
}) {
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
      {/*
        Nút xóa subtask.
        ⚠️ Chỉ MỞ hộp thoại xác nhận — không xóa ngay.
      */}
      <button
        type="button"
        className="pd-del-btn pd-del-btn--sm"
        onClick={() => onDelete(subtask, taskId)}
        title={`Delete subtask "${subtask.title}"`}
        aria-label={`Delete subtask ${subtask.title}`}
      >
        <span className="material-symbols-outlined">delete</span>
      </button>
      {/* Nút sửa subtask → mở modal `EditSubtaskModal`. */}
      <button
        type="button"
        className="pd-edit-btn pd-edit-btn--sm"
        onClick={() => onEdit(subtask)}
        title={`Edit subtask "${subtask.title}"`}
        aria-label={`Edit subtask ${subtask.title}`}
      >
        <span className="material-symbols-outlined">edit</span>
      </button>
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

/* ============================================================
 * EditProjectModal — sửa thông tin project
 * ------------------------------------------------------------
 * API: PUT /api/projects/{projectId}
 * Body: { name, description, startDate, deadline, clientId }
 * ============================================================ */
function EditProjectModal({
  project,
  clients,
  onClose,
  onSave,
}: {
  project: ProjectDto;
  clients: ClientDto[];
  onClose: () => void;
  onSave: (body: {
    name: string;
    description: string;
    startDate: string;
    deadline: string;
    clientId: string | null;
  }) => Promise<void>;
}) {
  const [name, setName] = useState(project.name ?? "");
  const [description, setDescription] = useState(project.description ?? "");
  const [startDate, setStartDate] = useState(toDateInput(project.startDate));
  const [deadline, setDeadline] = useState(toDateInput(project.deadline));
  const [clientId, setClientId] = useState(project.clientId ?? "");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Đóng bằng Escape (trừ khi đang submit).
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape" && !submitting) onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [submitting, onClose]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (submitting) return;
    setError(null);

    const trimmedName = name.trim();
    if (!trimmedName) {
      setError("Project name is required.");
      return;
    }
    if (!startDate) {
      setError("Start date is required.");
      return;
    }
    if (!deadline) {
      setError("Deadline is required.");
      return;
    }
    if (new Date(deadline) < new Date(startDate)) {
      setError("The deadline must be on or after the start date.");
      return;
    }

    setSubmitting(true);
    await onSave({
      name: trimmedName,
      description: description.trim(),
      startDate,
      deadline,
      // Client rỗng → dự án nội bộ → gửi `null`.
      clientId: clientId ? clientId : null,
    });
    setSubmitting(false);
  }

  return (
    <div
      className="pd-modal-backdrop"
      role="presentation"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !submitting) onClose();
      }}
    >
      <div
        className="pd-modal"
        role="dialog"
        aria-modal="true"
        aria-label="Edit project"
      >
        <div className="pd-modal-head">
          <div>
            <span className="pd-section-eyebrow">Edit project</span>
            <h2 className="pd-modal-title">Update project details</h2>
          </div>
          <button
            type="button"
            className="pd-icon-btn pd-icon-btn--sm"
            onClick={onClose}
            disabled={submitting}
            aria-label="Close"
          >
            <span className="material-symbols-outlined">close</span>
          </button>
        </div>

        <form onSubmit={handleSubmit}>
          <div className="pd-modal-body">
            <label className="pd-field">
              <span className="pd-label">Name</span>
              <input
                className="pd-input"
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Project name"
                disabled={submitting}
                autoFocus
              />
            </label>

            <label className="pd-field">
              <span className="pd-label">Description</span>
              <textarea
                className="pd-input pd-input--textarea"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Short description of the project"
                rows={4}
                disabled={submitting}
              />
            </label>

            <div className="pd-field-row">
              <label className="pd-field">
                <span className="pd-label">Start date</span>
                <input
                  className="pd-input"
                  type="date"
                  value={startDate}
                  onChange={(e) => setStartDate(e.target.value)}
                  disabled={submitting}
                />
              </label>

              <label className="pd-field">
                <span className="pd-label">Deadline</span>
                <input
                  className="pd-input"
                  type="date"
                  value={deadline}
                  onChange={(e) => setDeadline(e.target.value)}
                  disabled={submitting}
                />
              </label>
            </div>

            <label className="pd-field">
              <span className="pd-label">Client</span>
              <select
                className="pd-input"
                value={clientId}
                onChange={(e) => setClientId(e.target.value)}
                disabled={submitting}
              >
                <option value="">— None / Internal —</option>
                {clients.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </label>

            {error && (
              <p className="pd-field-error" role="alert">
                <span className="material-symbols-outlined">error</span>
                {error}
              </p>
            )}
          </div>

          <div className="pd-modal-actions">
            <button
              type="button"
              className="pd-btn pd-btn--ghost"
              onClick={onClose}
              disabled={submitting}
            >
              Cancel
            </button>
            <button
              type="submit"
              className="pd-btn pd-btn--primary"
              disabled={submitting}
            >
              {submitting ? (
                <>
                  <span className="material-symbols-outlined pd-btn-icon pd-spin">
                    progress_activity
                  </span>
                  <span>Saving…</span>
                </>
              ) : (
                <>
                  <span className="material-symbols-outlined pd-btn-icon">check</span>
                  <span>Save changes</span>
                </>
              )}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

/**
 * Chuyển ISO date (`2026-11-27` hoặc full ISO) → format `<input type="date">`
 * cần (`YYYY-MM-DD`).
 */
function toDateInput(value: string | null | undefined): string {
  if (!value) return "";
  const s = value.slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : "";
}

/**
 * Lỗi 409 `MILESTONE_HAS_OPEN_TASKS`?
 *
 * BE có thể trả mã ở nhiều chỗ:
 *   - `errorCode` (đã được `api-client` rút ra)
 *   - `details.code` (bản BE cũ chỉ nhét mã vào `details`)
 */
function isOpenTasksError(err: {
  errorCode?: string;
  details?: unknown;
}): boolean {
  if (err.errorCode === "MILESTONE_HAS_OPEN_TASKS") return true;
  const details = err.details as { code?: string } | undefined;
  return details?.code === "MILESTONE_HAS_OPEN_TASKS";
}

/* ============================================================
 * EditMilestoneModal — sửa milestone
 * ------------------------------------------------------------
 * API: PUT /api/milestones/{milestoneId}
 * Body: { name, orderIndex, dueDate, status, revisionCount }
 * ============================================================ */
const MILESTONE_STATUS_OPTIONS = [
  "Planned",
  "InProgress",
  "Delivered",
  "InRevision",
  "Approved",
] as const;

function EditMilestoneModal({
  milestone,
  onClose,
  onSave,
}: {
  milestone: MilestoneDto;
  onClose: () => void;
  onSave: (body: {
    name: string;
    orderIndex: number;
    dueDate: string | null;
    status: string;
    revisionCount: number;
  }) => Promise<void>;
}) {
  const [name, setName] = useState(milestone.name ?? "");
  const [orderIndex, setOrderIndex] = useState(String(milestone.orderIndex ?? 1));
  const [dueDate, setDueDate] = useState(toDateInput(milestone.dueDate));
  const [status, setStatus] = useState(milestone.status ?? "Planned");
  const [revisionCount, setRevisionCount] = useState(
    String(milestone.revisionCount ?? 0),
  );
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape" && !submitting) onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [submitting, onClose]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (submitting) return;
    setError(null);

    const trimmed = name.trim();
    if (!trimmed) {
      setError("Milestone name is required.");
      return;
    }
    const order = parseInt(orderIndex, 10);
    if (!Number.isFinite(order) || order < 1) {
      setError("Order index must be a number greater than or equal to 1.");
      return;
    }
    const revision = parseInt(revisionCount, 10);
    if (!Number.isFinite(revision) || revision < 0) {
      setError("Revision count must be a number greater than or equal to 0.");
      return;
    }

    setSubmitting(true);
    await onSave({
      name: trimmed,
      orderIndex: order,
      dueDate: dueDate || null,
      status,
      revisionCount: revision,
    });
    setSubmitting(false);
  }

  return (
    <div
      className="pd-modal-backdrop"
      role="presentation"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !submitting) onClose();
      }}
    >
      <div
        className="pd-modal"
        role="dialog"
        aria-modal="true"
        aria-label="Edit milestone"
      >
        <div className="pd-modal-head">
          <div>
            <span className="pd-section-eyebrow">Edit milestone</span>
            <h2 className="pd-modal-title">Update milestone details</h2>
          </div>
          <button
            type="button"
            className="pd-icon-btn pd-icon-btn--sm"
            onClick={onClose}
            disabled={submitting}
            aria-label="Close"
          >
            <span className="material-symbols-outlined">close</span>
          </button>
        </div>

        <form onSubmit={handleSubmit}>
          <div className="pd-modal-body">
            <label className="pd-field">
              <span className="pd-label">Name</span>
              <input
                className="pd-input"
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Milestone name"
                disabled={submitting}
                autoFocus
              />
            </label>

            <div className="pd-field-row">
              <label className="pd-field">
                <span className="pd-label">Order index</span>
                <input
                  className="pd-input"
                  type="number"
                  min="1"
                  step="1"
                  value={orderIndex}
                  onChange={(e) => setOrderIndex(e.target.value)}
                  disabled={submitting}
                />
              </label>

              <label className="pd-field">
                <span className="pd-label">Due date</span>
                <input
                  className="pd-input"
                  type="date"
                  value={dueDate}
                  onChange={(e) => setDueDate(e.target.value)}
                  disabled={submitting}
                />
              </label>
            </div>

            <div className="pd-field-row">
              <label className="pd-field">
                <span className="pd-label">Status</span>
                <select
                  className="pd-input"
                  value={status}
                  onChange={(e) => setStatus(e.target.value)}
                  disabled={submitting}
                >
                  {MILESTONE_STATUS_OPTIONS.map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
                </select>
              </label>

              <label className="pd-field">
                <span className="pd-label">Revision count</span>
                <input
                  className="pd-input"
                  type="number"
                  min="0"
                  step="1"
                  value={revisionCount}
                  onChange={(e) => setRevisionCount(e.target.value)}
                  disabled={submitting}
                />
              </label>
            </div>

            {error && (
              <p className="pd-field-error" role="alert">
                <span className="material-symbols-outlined">error</span>
                {error}
              </p>
            )}
          </div>

          <div className="pd-modal-actions">
            <button
              type="button"
              className="pd-btn pd-btn--ghost"
              onClick={onClose}
              disabled={submitting}
            >
              Cancel
            </button>
            <button
              type="submit"
              className="pd-btn pd-btn--primary"
              disabled={submitting}
            >
              {submitting ? (
                <>
                  <span className="material-symbols-outlined pd-btn-icon pd-spin">
                    progress_activity
                  </span>
                  <span>Saving…</span>
                </>
              ) : (
                <>
                  <span className="material-symbols-outlined pd-btn-icon">check</span>
                  <span>Save changes</span>
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
 * EditTaskModal — sửa task
 * ------------------------------------------------------------
 * API: PUT /api/tasks/{taskId}
 * Body: { title, description, taskType, status, domainId, milestoneId,
 *         deadline, estimatedMinutes, aiEstimatedMinutes,
 *         fixedStart, fixedEnd }
 * ============================================================ */
const TASK_STATUS_OPTIONS = [
  "ToDo",
  "Scheduled",
  "InProgress",
  "Done",
  "Skipped",
] as const;

const TASK_TYPE_OPTIONS = ["Flexible", "Fixed"] as const;

function EditTaskModal({
  task,
  milestones,
  domains,
  onClose,
  onSave,
}: {
  task: TaskDto;
  milestones: MilestoneDto[];
  domains: DomainDto[];
  onClose: () => void;
  onSave: (body: {
    title: string;
    description: string;
    taskType: string;
    status: string;
    domainId: string | null;
    milestoneId: string | null;
    deadline: string | null;
    estimatedMinutes: number;
    aiEstimatedMinutes: number;
    fixedStart: string | null;
    fixedEnd: string | null;
  }) => Promise<void>;
}) {
  const [title, setTitle] = useState(task.title ?? "");
  const [description, setDescription] = useState(task.description ?? "");
  const [taskType, setTaskType] = useState(task.taskType ?? "Flexible");
  const [status, setStatus] = useState(task.status ?? "ToDo");
  const [domainId, setDomainId] = useState(task.domainId ?? "");
  const [milestoneId, setMilestoneId] = useState(task.milestoneId ?? "");
  const [deadline, setDeadline] = useState(toDateInput(task.deadline));
  const [estimatedMinutes, setEstimatedMinutes] = useState(
    String(task.estimatedMinutes ?? 0),
  );
  const [aiEstimatedMinutes, setAiEstimatedMinutes] = useState(
    String(task.aiEstimatedMinutes ?? 0),
  );
  const [fixedStart, setFixedStart] = useState(toDateInput(task.fixedStart));
  const [fixedEnd, setFixedEnd] = useState(toDateInput(task.fixedEnd));
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape" && !submitting) onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [submitting, onClose]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (submitting) return;
    setError(null);

    const trimmed = title.trim();
    if (!trimmed) {
      setError("Task title is required.");
      return;
    }
    const est = parseInt(estimatedMinutes, 10);
    if (!Number.isFinite(est) || est < 0) {
      setError("Estimated minutes must be a number greater than or equal to 0.");
      return;
    }
    const aiEst = parseInt(aiEstimatedMinutes, 10);
    if (!Number.isFinite(aiEst) || aiEst < 0) {
      setError("AI estimated minutes must be a number greater than or equal to 0.");
      return;
    }
    if (fixedStart && fixedEnd && new Date(fixedEnd) < new Date(fixedStart)) {
      setError("The fixed end time must be after the fixed start time.");
      return;
    }

    setSubmitting(true);
    await onSave({
      title: trimmed,
      description: description.trim(),
      taskType,
      status,
      domainId: domainId || null,
      milestoneId: milestoneId || null,
      deadline: deadline ? new Date(deadline).toISOString() : null,
      estimatedMinutes: est,
      aiEstimatedMinutes: aiEst,
      fixedStart: fixedStart ? new Date(fixedStart).toISOString() : null,
      fixedEnd: fixedEnd ? new Date(fixedEnd).toISOString() : null,
    });
    setSubmitting(false);
  }

  return (
    <div
      className="pd-modal-backdrop"
      role="presentation"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !submitting) onClose();
      }}
    >
      <div
        className="pd-modal"
        role="dialog"
        aria-modal="true"
        aria-label="Edit task"
      >
        <div className="pd-modal-head">
          <div>
            <span className="pd-section-eyebrow">Edit task</span>
            <h2 className="pd-modal-title">Update task details</h2>
          </div>
          <button
            type="button"
            className="pd-icon-btn pd-icon-btn--sm"
            onClick={onClose}
            disabled={submitting}
            aria-label="Close"
          >
            <span className="material-symbols-outlined">close</span>
          </button>
        </div>

        <form onSubmit={handleSubmit}>
          <div className="pd-modal-body">
            <label className="pd-field">
              <span className="pd-label">Title</span>
              <input
                className="pd-input"
                type="text"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="Task title"
                disabled={submitting}
                autoFocus
              />
            </label>

            <label className="pd-field">
              <span className="pd-label">Description</span>
              <textarea
                className="pd-input pd-input--textarea"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="What needs to be done"
                rows={3}
                disabled={submitting}
              />
            </label>

            <div className="pd-field-row">
              <label className="pd-field">
                <span className="pd-label">Task type</span>
                <select
                  className="pd-input"
                  value={taskType}
                  onChange={(e) => setTaskType(e.target.value)}
                  disabled={submitting}
                >
                  {TASK_TYPE_OPTIONS.map((t) => (
                    <option key={t} value={t}>
                      {t}
                    </option>
                  ))}
                </select>
              </label>

              <label className="pd-field">
                <span className="pd-label">Status</span>
                <select
                  className="pd-input"
                  value={status}
                  onChange={(e) => setStatus(e.target.value)}
                  disabled={submitting}
                >
                  {TASK_STATUS_OPTIONS.map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
                </select>
              </label>
            </div>

            <div className="pd-field-row">
              <label className="pd-field">
                <span className="pd-label">Milestone</span>
                <select
                  className="pd-input"
                  value={milestoneId}
                  onChange={(e) => setMilestoneId(e.target.value)}
                  disabled={submitting}
                >
                  <option value="">— None —</option>
                  {milestones.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name}
                    </option>
                  ))}
                </select>
              </label>

              <label className="pd-field">
                <span className="pd-label">Domain</span>
                <select
                  className="pd-input"
                  value={domainId}
                  onChange={(e) => setDomainId(e.target.value)}
                  disabled={submitting}
                >
                  <option value="">— None —</option>
                  {domains.map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.name}
                    </option>
                  ))}
                </select>
              </label>
            </div>

            <label className="pd-field">
              <span className="pd-label">Deadline</span>
              <input
                className="pd-input"
                type="date"
                value={deadline}
                onChange={(e) => setDeadline(e.target.value)}
                disabled={submitting}
              />
            </label>

            <div className="pd-field-row">
              <label className="pd-field">
                <span className="pd-label">Estimated minutes</span>
                <input
                  className="pd-input"
                  type="number"
                  min="0"
                  step="1"
                  value={estimatedMinutes}
                  onChange={(e) => setEstimatedMinutes(e.target.value)}
                  disabled={submitting}
                />
              </label>

              <label className="pd-field">
                <span className="pd-label">AI estimated minutes</span>
                <input
                  className="pd-input"
                  type="number"
                  min="0"
                  step="1"
                  value={aiEstimatedMinutes}
                  onChange={(e) => setAiEstimatedMinutes(e.target.value)}
                  disabled={submitting}
                />
              </label>
            </div>

            <div className="pd-field-row">
              <label className="pd-field">
                <span className="pd-label">Fixed start</span>
                <input
                  className="pd-input"
                  type="date"
                  value={fixedStart}
                  onChange={(e) => setFixedStart(e.target.value)}
                  disabled={submitting}
                />
              </label>

              <label className="pd-field">
                <span className="pd-label">Fixed end</span>
                <input
                  className="pd-input"
                  type="date"
                  value={fixedEnd}
                  onChange={(e) => setFixedEnd(e.target.value)}
                  disabled={submitting}
                />
              </label>
            </div>

            {error && (
              <p className="pd-field-error" role="alert">
                <span className="material-symbols-outlined">error</span>
                {error}
              </p>
            )}
          </div>

          <div className="pd-modal-actions">
            <button
              type="button"
              className="pd-btn pd-btn--ghost"
              onClick={onClose}
              disabled={submitting}
            >
              Cancel
            </button>
            <button
              type="submit"
              className="pd-btn pd-btn--primary"
              disabled={submitting}
            >
              {submitting ? (
                <>
                  <span className="material-symbols-outlined pd-btn-icon pd-spin">
                    progress_activity
                  </span>
                  <span>Saving…</span>
                </>
              ) : (
                <>
                  <span className="material-symbols-outlined pd-btn-icon">check</span>
                  <span>Save changes</span>
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
 * EditSubtaskModal — sửa subtask
 * ------------------------------------------------------------
 * API: PUT /api/subtasks/{subtaskId}
 * Body: { title, description, estimatedMinutes, orderIndex, status }
 * ============================================================ */
const SUBTASK_STATUS_OPTIONS = [
  "ToDo",
  "Scheduled",
  "InProgress",
  "Done",
  "Skipped",
] as const;

function EditSubtaskModal({
  subtask,
  onClose,
  onSave,
}: {
  subtask: SubtaskDto;
  onClose: () => void;
  onSave: (body: {
    title: string;
    description: string | null;
    estimatedMinutes: number;
    orderIndex: number;
    status: string;
  }) => Promise<void>;
}) {
  const [title, setTitle] = useState(subtask.title ?? "");
  const [description, setDescription] = useState(subtask.description ?? "");
  const [estimatedMinutes, setEstimatedMinutes] = useState(
    String(subtask.estimatedMinutes ?? 0),
  );
  const [orderIndex, setOrderIndex] = useState(String(subtask.orderIndex ?? 0));
  const [status, setStatus] = useState(subtask.status ?? "ToDo");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape" && !submitting) onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [submitting, onClose]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (submitting) return;
    setError(null);

    const trimmed = title.trim();
    if (!trimmed) {
      setError("Subtask title is required.");
      return;
    }
    const est = parseInt(estimatedMinutes, 10);
    if (!Number.isFinite(est) || est < 0) {
      setError("Estimated minutes must be a number greater than or equal to 0.");
      return;
    }
    const order = parseInt(orderIndex, 10);
    if (!Number.isFinite(order) || order < 0) {
      setError("Order index must be a number greater than or equal to 0.");
      return;
    }

    setSubmitting(true);
    await onSave({
      title: trimmed,
      description: description.trim() || null,
      estimatedMinutes: est,
      orderIndex: order,
      status,
    });
    setSubmitting(false);
  }

  return (
    <div
      className="pd-modal-backdrop"
      role="presentation"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !submitting) onClose();
      }}
    >
      <div
        className="pd-modal"
        role="dialog"
        aria-modal="true"
        aria-label="Edit subtask"
      >
        <div className="pd-modal-head">
          <div>
            <span className="pd-section-eyebrow">Edit subtask</span>
            <h2 className="pd-modal-title">Update subtask details</h2>
          </div>
          <button
            type="button"
            className="pd-icon-btn pd-icon-btn--sm"
            onClick={onClose}
            disabled={submitting}
            aria-label="Close"
          >
            <span className="material-symbols-outlined">close</span>
          </button>
        </div>

        <form onSubmit={handleSubmit}>
          <div className="pd-modal-body">
            <label className="pd-field">
              <span className="pd-label">Title</span>
              <input
                className="pd-input"
                type="text"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="Subtask title"
                disabled={submitting}
                autoFocus
              />
            </label>

            <label className="pd-field">
              <span className="pd-label">Description</span>
              <textarea
                className="pd-input pd-input--textarea"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Optional details"
                rows={3}
                disabled={submitting}
              />
            </label>

            <div className="pd-field-row">
              <label className="pd-field">
                <span className="pd-label">Estimated minutes</span>
                <input
                  className="pd-input"
                  type="number"
                  min="0"
                  step="1"
                  value={estimatedMinutes}
                  onChange={(e) => setEstimatedMinutes(e.target.value)}
                  disabled={submitting}
                />
              </label>

              <label className="pd-field">
                <span className="pd-label">Order index</span>
                <input
                  className="pd-input"
                  type="number"
                  min="0"
                  step="1"
                  value={orderIndex}
                  onChange={(e) => setOrderIndex(e.target.value)}
                  disabled={submitting}
                />
              </label>
            </div>

            <label className="pd-field">
              <span className="pd-label">Status</span>
              <select
                className="pd-input"
                value={status}
                onChange={(e) => setStatus(e.target.value)}
                disabled={submitting}
              >
                {SUBTASK_STATUS_OPTIONS.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
            </label>

            {error && (
              <p className="pd-field-error" role="alert">
                <span className="material-symbols-outlined">error</span>
                {error}
              </p>
            )}
          </div>

          <div className="pd-modal-actions">
            <button
              type="button"
              className="pd-btn pd-btn--ghost"
              onClick={onClose}
              disabled={submitting}
            >
              Cancel
            </button>
            <button
              type="submit"
              className="pd-btn pd-btn--primary"
              disabled={submitting}
            >
              {submitting ? (
                <>
                  <span className="material-symbols-outlined pd-btn-icon pd-spin">
                    progress_activity
                  </span>
                  <span>Saving…</span>
                </>
              ) : (
                <>
                  <span className="material-symbols-outlined pd-btn-icon">check</span>
                  <span>Save changes</span>
                </>
              )}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
