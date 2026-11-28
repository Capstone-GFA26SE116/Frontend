import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import {
  listDomains,
  type CreateTaskRequest,
  type DomainDto,
  type MilestoneDto,
  type SubtaskDto,
  type TaskDto,
} from "../../lib/api-client";
import {
  computeProgress,
  fmtDuration,
  fmtShortDate,
  isTaskDone,
} from "./ai-chat-logic";

/* ===========================================================
 * Cột phải — Thông tin dự án (thêm / sửa / xoá) — spec mục 4
 * ------------------------------------------------------------
 * 4.1 Đầu cột: tên · khách · hạn (font mono) · nút ✎ sửa dự án.
 *           Thanh tiến độ: `{x}/{y} việc xong · {n} cột mốc`.
 * 4.2 Cây cột mốc › việc › việc con:
 *   - Cột mốc : ▸/▾ · tên (đậm) · "hạn dd/mm · n việc" · + ✎ 🗑
 *   - Việc    : thụt 22px · ☐ ô xong · tên · "4h · 3 con" · + ✎ 🗑
 *   - Việc con: thụt 44px · tên (chữ nhỏ, xám) · phút · ✎ 🗑
 *   - Thêm  : dòng mới hiện ngay ở chế độ sửa tên, cha tự mở ra.
 *   - Sửa  : bấm ✎ → dòng thành ô nhập + Lưu / Huỷ (Enter = Lưu, Esc = Huỷ).
 *   - Xoá  : bấm 🗑 → dòng đổi thành "Xoá việc "…"? + Xoá (đỏ) / Huỷ.
 *             Confirm deletion in a dialog before sending the request.
 *   - Xong : tích ☐ → PUT task status = Done.
 * 4.3 Trạng thái rỗng + khung "Bản nháp của AI — chưa áp dụng".
 *
 * Class prefix `.aic-*`.
 * =========================================================== */

export interface ProjectTreeProps {
  planningSummary?: ReactNode;
  taskActions?: (task: TaskDto, subtasks: SubtaskDto[]) => ReactNode;
  project: {
    id: string;
    name: string;
    clientName: string | null;
    deadline: string | null;
  } | null;
  milestones: MilestoneDto[];
  tasks: TaskDto[];
  recentTaskIds?: ReadonlySet<string>;
  /** taskId -> subtasks. */
  subtasksByTaskId: Map<string, SubtaskDto[]>;
  /** Tên các cột mốc trong bản nháp chưa áp dụng (chỉ xem). */
  draftMilestoneTitles: string[];
  /** Đang tải cây. */
  loading: boolean;
  /** Lỗi tải cây. */
  error: string | null;
  /** Sửa thông tin dự án. */
  onEditProject: () => void;
  /** Thêm cột mốc. */
  onAddMilestone: (name: string) => Promise<boolean>;
  /** Thêm việc vào cột mốc. */
  onAddTask: (milestoneId: string, task: CreateTaskRequest) => Promise<boolean>;
  /** Thêm việc con vào việc. */
  onAddSubtask: (taskId: string, title: string, minutes: number) => Promise<boolean>;
  /** Lưu tên milestone. */
  onRenameMilestone: (milestoneId: string, name: string) => Promise<boolean>;
  /** Lưu tên task. */
  onRenameTask: (taskId: string, title: string) => Promise<boolean>;
  /** Lưu tên việc con. */
  onRenameSubtask: (subtaskId: string, title: string) => Promise<boolean>;
  /** Xoá milestone. */
  onDeleteMilestone: (milestoneId: string) => Promise<boolean>;
  /** Xoá task. */
  onDeleteTask: (taskId: string) => Promise<boolean>;
  /** Xoá việc con. */
  onDeleteSubtask: (subtaskId: string) => Promise<boolean>;
  /** Đánh dấu task xong / chưa xong. */
  onToggleTaskDone: (task: TaskDto) => void;
}

/** Khoá duy nhất cho 1 hành động đang chờ (rename/delete/add). */
type PendingEdit =
  | { kind: "rename"; id: string }
  | { kind: "delete"; id: string; label: string }
  | { kind: "add"; parentId: string }
  | null;

export function ProjectTree(props: ProjectTreeProps) {
  const {
    project,
    milestones,
    tasks,
    recentTaskIds,
    subtasksByTaskId,
    draftMilestoneTitles,
    loading,
    error,
    onEditProject,
    onAddMilestone,
    onAddTask,
    onAddSubtask,
    onRenameMilestone,
    onRenameTask,
    onRenameSubtask,
    onDeleteMilestone,
    onDeleteTask,
    onDeleteSubtask,
    onToggleTaskDone,
    planningSummary,
    taskActions,
  } = props;

  /** Milestone đang mở rộng (có thể mở nhiều cùng lúc). */
  const [openMs, setOpenMs] = useState<Map<string, boolean>>(() => new Map());
  /** Task đang mở rộng (hiện việc con). */
  const [openTasks, setOpenTasks] = useState<Set<string>>(new Set());
  const [pending, setPending] = useState<PendingEdit>(null);

  /* ---------- Gom task theo milestone ---------- */
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

  /** Task chưa gắn cột mốc nào → hiện cuối cây. */
  const orphanTasks = useMemo(
    () => tasks.filter((t) => !t.milestoneId),
    [tasks],
  );

  const progress = useMemo(
    () => computeProgress(tasks, milestones.length),
    [tasks, milestones.length],
  );

  function toggle(set: Set<string>, id: string): Set<string> {
    const next = new Set(set);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  }

  /**
   * Lưu tên sau khi sửa nội tuyến.
   *
   * Khoá có tiền tố: `ms:` = milestone · `ts:` = việc con · còn lại = task.
   */
  async function finishEdit(save: Promise<boolean>) {
    const saved = await save;
    if (saved) setPending((current) => current === pending ? null : current);
    return saved;
  }

  function handleRename(id: string, value: string) {
    if (id.startsWith("ms:")) return finishEdit(onRenameMilestone(id.slice(3), value));
    if (id.startsWith("ts:")) return finishEdit(onRenameSubtask(id.slice(3), value));
    return finishEdit(onRenameTask(id, value));
  }

  function requestAddTask(id: string) {
    setOpenMs((previous) => new Map(previous).set(id, true));
    setPending({ kind: "add", parentId: `ms:${id}` });
  }

  function requestAddSubtask(id: string) {
    setOpenTasks((previous) => new Set(previous).add(id));
    setPending({ kind: "add", parentId: id });
  }

  async function handleDelete(id: string) {
    const deleted = id.startsWith("ms:")
      ? await onDeleteMilestone(id.slice(3))
      : id.startsWith("ts:")
        ? await onDeleteSubtask(id.slice(3))
        : await onDeleteTask(id);
    if (deleted) setPending(null);
  }

  /** The trash button only opens confirmation. */
  function handleRequestDelete(id: string) {
    setPending({ kind: "delete", id, label: "" });
  }

  return (
    <aside className="aic-right" aria-label="Thông tin dự án">
      {/* ============ Đầu cột ============ */}
      <header className="aic-right__head">
        <div className="aic-right__title-row">
          <h2 className="aic-right__title">{project?.name ?? "Dự án"}</h2>
          <button
            type="button"
            className="aic-icon-btn"
            onClick={onEditProject}
            aria-label="Sửa dự án"
            title="Sửa dự án"
          >
            <span className="material-symbols-outlined">edit</span>
          </button>
        </div>

        <div className="aic-right__meta">
          {project?.clientName && (
            <span className="aic-right__client">Khách: {project.clientName}</span>
          )}
          {project?.deadline && (
            <span className="aic-right__deadline">
              Hạn: {fmtShortDate(project.deadline)}
            </span>
          )}
        </div>

        {/* Thanh tiến độ */}
        <div className="aic-progress">
          <div className="aic-progress__bar">
            <span
              className="aic-progress__fill"
              style={{ width: `${progress.pct}%` }}
            />
          </div>
          <span className="aic-progress__label">
            {progress.done}/{progress.total} việc xong · {progress.milestones}{" "}
            cột mốc
          </span>
        </div>
      </header>

      {/* ============ Cây ============ */}
      <div className="aic-right__body">
        {error && (
          <div className="aic-right__state aic-right__state--error" role="alert">
            <span className="material-symbols-outlined">error</span>
            <p>{error}</p>
          </div>
        )}

        {/* Bản nháp chưa áp dụng — chỉ xem */}
        {draftMilestoneTitles.length > 0 && (
          <div className="aic-draftbox">
            <span className="aic-draftbox__title">
              Bản nháp của AI — chưa áp dụng
            </span>
            <ul>
              {draftMilestoneTitles.map((t, i) => (
                <li key={`${t}-${i}`}>{t}</li>
              ))}
            </ul>
          </div>
        )}

        {planningSummary}

        {/* Nút thêm cột mốc */}
        <button
          type="button"
          className="aic-right__addms"
          onClick={() => setPending({ kind: "add", parentId: "project" })}
          disabled={loading || !project}
        >
          <span className="material-symbols-outlined">add</span>
          Cột mốc
        </button>
        {pending?.kind === "add" && pending.parentId === "project" && (
          <InlineEditor
            label="Tên cột mốc"
            maxLength={150}
            onSave={(name) => finishEdit(onAddMilestone(name))}
            onCancel={() => setPending(null)}
          />
        )}

        {loading ? (
          <div
            className="aic-right__skeleton"
            role="status"
            aria-label="Đang tải cấu trúc dự án"
          >
            {Array.from({ length: 6 }).map((_, i) => (
              <span key={i} className="aic-right__skel-line" />
            ))}
          </div>
        ) : milestones.length === 0 && orphanTasks.length === 0 ? (
          <div className="aic-right__state">
            <span className="material-symbols-outlined">account_tree</span>
            <p>
              Chưa có cột mốc nào. Bạn có thể thêm cột mốc hoặc tạo bản nháp với AI.
            </p>
          </div>
        ) : (
          <div className="aic-tree">
            {milestones.map((m) => {
              const milestoneTasks = tasksByMilestone.get(m.id) ?? [];
              const open = openMs.get(m.id) ?? milestoneTasks.some((task) => recentTaskIds?.has(task.id));
              return (
                <MilestoneNode
                  key={m.id}
                  milestone={m}
                  tasks={milestoneTasks}
                  recentTaskIds={recentTaskIds}
                  subtasksByTaskId={subtasksByTaskId}
                  open={open}
                  openTasks={openTasks}
                  pending={pending}
                  onToggleMs={() => setOpenMs((previous) => new Map(previous).set(m.id, !open))}
                  onToggleTask={(id) => setOpenTasks((s) => toggle(s, id))}
                  defaultDeadline={m.dueDate ?? project?.deadline}
                  onAddTask={requestAddTask}
                  onAddSubtask={requestAddSubtask}
                  onSaveTask={(id, task) => finishEdit(onAddTask(id, task))}
                  onSaveSubtask={(id, title, minutes) => finishEdit(onAddSubtask(id, title, minutes))}
                  onRename={(id) => setPending({ kind: "rename", id })}
                  onSaveName={handleRename}
                  onRequestDelete={handleRequestDelete}
                  onCancelEdit={() => setPending(null)}
                  onDelete={handleDelete}
                  onToggleDone={onToggleTaskDone}
                  taskActions={taskActions}
                />
              );
            })}

            {/* Task chưa có cột mốc */}
            {orphanTasks.length > 0 && (
              <section className="aic-tree__orphan">
                <h3 className="aic-tree__orphan-title">Chưa gán cột mốc · {orphanTasks.length} việc</h3>
                {orphanTasks.map((t) => (
                  <TaskNode
                    key={t.id}
                    task={t}
                    recentlyAdded={recentTaskIds?.has(t.id)}
                    subtasks={subtasksByTaskId.get(t.id) ?? []}
                    open={openTasks.has(t.id)}
                    pending={pending}
                    onToggle={() => setOpenTasks((s) => toggle(s, t.id))}
                    onAddSubtask={requestAddSubtask}
                    onSaveSubtask={(id, title, minutes) => finishEdit(onAddSubtask(id, title, minutes))}
                    onRename={(id) => setPending({ kind: "rename", id })}
                    onSaveName={handleRename}
                    onRequestDelete={handleRequestDelete}
                    onCancelEdit={() => setPending(null)}
                    onDelete={handleDelete}
                    onToggleDone={onToggleTaskDone}
                    taskActions={taskActions}
                  />
                ))}
              </section>
            )}
          </div>
        )}
      </div>
    </aside>
  );
}

/* ===========================================================
 * Node cột mốc
 * =========================================================== */
function MilestoneNode({
  milestone,
  tasks,
  recentTaskIds,
  subtasksByTaskId,
  open,
  openTasks,
  pending,
  onToggleMs,
  onToggleTask,
  onAddTask,
  onAddSubtask,
  defaultDeadline,
  onSaveTask,
  onSaveSubtask,
  onRename,
  onSaveName,
  onRequestDelete,
  onCancelEdit,
  onDelete,
  onToggleDone,
  taskActions,
}: {
  milestone: MilestoneDto;
  tasks: TaskDto[];
  recentTaskIds?: ReadonlySet<string>;
  subtasksByTaskId: Map<string, SubtaskDto[]>;
  open: boolean;
  openTasks: Set<string>;
  pending: PendingEdit;
  onToggleMs: () => void;
  onToggleTask: (id: string) => void;
  onAddTask: (msId: string) => void;
  onAddSubtask: (taskId: string) => void;
  defaultDeadline?: string | null;
  onSaveTask: ProjectTreeProps["onAddTask"];
  onSaveSubtask: ProjectTreeProps["onAddSubtask"];
  onRename: (id: string) => void;
  onSaveName: (id: string, value: string) => Promise<boolean>;
  /** Open the confirmation dialog. */
  onRequestDelete: (id: string) => void;
  /** Huỷ thao tác nội tuyến. */
  onCancelEdit: () => void;
  /** Xác nhận xoá → xoá thật. */
  onDelete: (id: string) => Promise<void>;
  onToggleDone: (task: TaskDto) => void;
  taskActions?: ProjectTreeProps["taskActions"];
}) {
  const msId = `ms:${milestone.id}`;
  const renaming = pending?.kind === "rename" && pending.id === msId;
  const deleting = pending?.kind === "delete" && pending.id === msId;
  const adding = pending?.kind === "add" && pending.parentId === msId;

  return (
    <section className="aic-node aic-node--ms">
      {/* --- Dòng cột mốc --- */}
      {deleting ? (
        <ConfirmDelete
          label={`cột mốc "${milestone.name}"`}
          message={tasks.length
            ? `${tasks.length} việc trong cột mốc sẽ chuyển sang “Chưa gán cột mốc”.`
            : "Cột mốc sẽ bị xóa khỏi dự án."}
          onConfirm={() => onDelete(msId)}
          onCancel={onCancelEdit}
        />
      ) : renaming ? (
        <InlineEditor
          label="Tên cột mốc"
          maxLength={150}
          initial={milestone.name}
          onSave={(name) => onSaveName(msId, name)}
          onCancel={onCancelEdit}
        />
      ) : (
        <div className="aic-node__row">
          <button
            type="button"
            className="aic-node__caret"
            onClick={onToggleMs}
            aria-label={open ? "Thu gọn" : "Mở rộng"}
            aria-expanded={open}
          >
            <span className="material-symbols-outlined">
              {open ? "expand_more" : "chevron_right"}
            </span>
          </button>

          <span className="aic-node__title">{milestone.name}</span>

          <span className="aic-node__meta">
            hạn {fmtShortDate(milestone.dueDate)} · {tasks.length} việc
          </span>

          <span className="aic-node__acts">
            <button
              type="button"
              className="aic-icon-btn aic-icon-btn--xs"
              onClick={() => onAddTask(milestone.id)}
              aria-label="Thêm việc"
              title="Thêm việc"
            >
              <span className="material-symbols-outlined">add</span>
            </button>
            <button
              type="button"
              className="aic-icon-btn aic-icon-btn--xs"
              onClick={() => onRename(msId)}
              aria-label="Sửa cột mốc"
              title="Sửa"
            >
              <span className="material-symbols-outlined">edit</span>
            </button>
            <button
              type="button"
              className="aic-icon-btn aic-icon-btn--xs aic-icon-btn--danger"
              onClick={() => onRequestDelete(msId)}
              aria-label="Xoá cột mốc"
              title="Xoá"
            >
              <span className="material-symbols-outlined">delete</span>
            </button>
          </span>
        </div>
      )}

      {/* --- Việc --- */}
      {open && (
        <div className="aic-node__children">
          {tasks.map((t) => (
            <TaskNode
              key={t.id}
              task={t}
              recentlyAdded={recentTaskIds?.has(t.id)}
              subtasks={subtasksByTaskId.get(t.id) ?? []}
              open={openTasks.has(t.id)}
              pending={pending}
              onToggle={() => onToggleTask(t.id)}
              onAddSubtask={onAddSubtask}
              onSaveSubtask={onSaveSubtask}
              onRename={onRename}
              onSaveName={onSaveName}
              onRequestDelete={onRequestDelete}
              onCancelEdit={onCancelEdit}
              onDelete={onDelete}
              onToggleDone={onToggleDone}
              taskActions={taskActions}
            />
          ))}

          {adding && (
            <InlineEditor
              label="Tên việc"
              taskDeadline={defaultDeadline ?? ""}
              onSave={(title, minutes, deadline, domainId) => onSaveTask(milestone.id, {
                title,
                taskType: "Flexible",
                estimatedMinutes: minutes,
                deadline,
                domainId,
              })}
              onCancel={onCancelEdit}
            />
          )}
        </div>
      )}
    </section>
  );
}

/* ===========================================================
 * Node việc
 * =========================================================== */
function TaskNode({
  task,
  recentlyAdded,
  subtasks,
  open,
  pending,
  onToggle,
  onAddSubtask,
  onSaveSubtask,
  onRename,
  onSaveName,
  onRequestDelete,
  onCancelEdit,
  onDelete,
  onToggleDone,
  taskActions,
}: {
  task: TaskDto;
  recentlyAdded?: boolean;
  subtasks: SubtaskDto[];
  open: boolean;
  pending: PendingEdit;
  onToggle: () => void;
  onAddSubtask: (taskId: string) => void;
  onSaveSubtask: ProjectTreeProps["onAddSubtask"];
  onRename: (id: string) => void;
  onSaveName: (id: string, value: string) => Promise<boolean>;
  onDelete: (id: string) => Promise<void>;
  /** Open the confirmation dialog. */
  onRequestDelete: (id: string) => void;
  /** Huỷ thao tác nội tuyến. */
  onCancelEdit: () => void;
  onToggleDone: (task: TaskDto) => void;
  taskActions?: ProjectTreeProps["taskActions"];
}) {
  const done = isTaskDone(task.status);
  const renaming = pending?.kind === "rename" && pending.id === task.id;
  const deleting = pending?.kind === "delete" && pending.id === task.id;
  const adding = pending?.kind === "add" && pending.parentId === task.id;

  return (
    <div className="aic-node aic-node--task">
      {deleting ? (
        <ConfirmDelete
          label={`việc "${task.title}"`}
          message="Việc, các việc con và khung giờ liên quan có thể bị xóa khỏi dự án. Bạn không thể hoàn tác thao tác này."
          onConfirm={() => onDelete(task.id)}
          onCancel={onCancelEdit}
        />
      ) : renaming ? (
        <InlineEditor
          label="Tên việc"
          initial={task.title}
          onSave={(title) => onSaveName(task.id, title)}
          onCancel={onCancelEdit}
        />
      ) : (
        <div className={`aic-node__row${done ? " aic-node__row--done" : ""}`}>
          {subtasks.length > 0 ? (
            <button
              type="button"
              className="aic-node__caret"
              onClick={onToggle}
              aria-label={open ? "Thu gọn" : "Mở rộng"}
              aria-expanded={open}
            >
              <span className="material-symbols-outlined">
                {open ? "expand_more" : "chevron_right"}
              </span>
            </button>
          ) : (
            <span className="aic-node__caret aic-node__caret--empty" />
          )}

          <label className="aic-node__check">
            <input
              type="checkbox"
              checked={done}
              onChange={() => onToggleDone(task)}
              aria-label={`Đánh dấu "${task.title}" hoàn thành`}
            />
            <span className="material-symbols-outlined">
              {done ? "check_box" : "check_box_outline_blank"}
            </span>
          </label>

          <span className="aic-node__title">{task.title}</span>
          {recentlyAdded && <span className="pc-recent-task">Mới</span>}

          <span className="aic-node__meta">
            {fmtDuration(task.estimatedMinutes)}
            {subtasks.length > 0 && ` · ${subtasks.length} con`}
          </span>

          <span className="aic-node__acts">
            <button
              type="button"
              className="aic-icon-btn aic-icon-btn--xs"
              onClick={() => onAddSubtask(task.id)}
              aria-label="Thêm việc con"
              title="Thêm việc con"
            >
              <span className="material-symbols-outlined">add</span>
            </button>
            <button
              type="button"
              className="aic-icon-btn aic-icon-btn--xs"
              onClick={() => onRename(task.id)}
              aria-label="Sửa việc"
              title="Sửa"
            >
              <span className="material-symbols-outlined">edit</span>
            </button>
            <button
              type="button"
              className="aic-icon-btn aic-icon-btn--xs aic-icon-btn--danger"
              onClick={() => onRequestDelete(task.id)}
              aria-label="Xoá việc"
              title="Xoá"
            >
              <span className="material-symbols-outlined">delete</span>
            </button>
          </span>
        </div>
      )}

      {!deleting && !renaming && !done && taskActions?.(task, subtasks)}

      {/* --- Việc con --- */}
      {open && (
        <div className="aic-node__children aic-node__children--sub">
          {subtasks.map((s) => (
            <SubtaskNode
              key={s.id}
              subtask={s}
              pending={pending}
              onRename={onRename}
              onSaveName={onSaveName}
              onRequestDelete={onRequestDelete}
              onCancelEdit={onCancelEdit}
              onDelete={onDelete}
            />
          ))}

          {adding && (
            <InlineEditor
              label="Tên việc con"
              needsMinutes
              onSave={(title, minutes) => onSaveSubtask(task.id, title, minutes)}
              onCancel={onCancelEdit}
            />
          )}
        </div>
      )}
    </div>
  );
}

/* ===========================================================
 * Node việc con
 * =========================================================== */
function SubtaskNode({
  subtask,
  pending,
  onRename,
  onSaveName,
  onRequestDelete,
  onCancelEdit,
  onDelete,
}: {
  subtask: SubtaskDto;
  pending: PendingEdit;
  onRename: (id: string) => void;
  onSaveName: (id: string, value: string) => Promise<boolean>;
  onDelete: (id: string) => Promise<void>;
  /** Bam 🗑 → bat che do xac nhan noi tuyen. */
  onRequestDelete: (id: string) => void;
  /** Huy thao tac noi tuyen. */
  onCancelEdit: () => void;
}) {
  const id = `ts:${subtask.id}`;
  const renaming = pending?.kind === "rename" && pending.id === id;
  const deleting = pending?.kind === "delete" && pending.id === id;

  return (
    <div className="aic-node aic-node--sub">
      {deleting ? (
        <ConfirmDelete
          label={`việc con "${subtask.title}"`}
          message="Việc con và khung giờ liên quan có thể bị xóa. Bạn không thể hoàn tác thao tác này."
          onConfirm={() => onDelete(id)}
          onCancel={onCancelEdit}
        />
      ) : renaming ? (
        <InlineEditor
          label="Tên việc con"
          initial={subtask.title}
          onSave={(title) => onSaveName(id, title)}
          onCancel={onCancelEdit}
        />
      ) : (
        <div className="aic-node__row">
          <span className="aic-node__title aic-node__title--sub">
            {subtask.title}
          </span>
          <span className="aic-node__meta">
            {fmtDuration(subtask.estimatedMinutes)}
          </span>

          <span className="aic-node__acts">
            <button
              type="button"
              className="aic-icon-btn aic-icon-btn--xs"
              onClick={() => onRename(id)}
              aria-label="Sửa việc con"
              title="Sửa"
            >
              <span className="material-symbols-outlined">edit</span>
            </button>
            <button
              type="button"
              className="aic-icon-btn aic-icon-btn--xs aic-icon-btn--danger"
              onClick={() => onRequestDelete(id)}
              aria-label="Xoá việc con"
              title="Xoá"
            >
              <span className="material-symbols-outlined">delete</span>
            </button>
          </span>
        </div>
      )}
    </div>
  );
}

/** Save only on submit and keep the form open when the request fails. */
function InlineEditor({
  label,
  initial = "",
  maxLength = 200,
  needsMinutes = false,
  taskDeadline,
  onSave,
  onCancel,
}: {
  label: string;
  initial?: string;
  maxLength?: number;
  needsMinutes?: boolean;
  taskDeadline?: string;
  onSave: (title: string, minutes: number, deadline?: string, domainId?: string) => Promise<boolean>;
  onCancel: () => void;
}) {
  const [title, setTitle] = useState(initial);
  const [minutes, setMinutes] = useState("");
  const [deadline, setDeadline] = useState(taskDeadline?.slice(0, 10) ?? "");
  const [domainId, setDomainId] = useState("");
  const [domains, setDomains] = useState<DomainDto[] | null>(null);
  const [domainError, setDomainError] = useState(false);
  const [domainRequest, setDomainRequest] = useState(0);
  const [busy, setBusy] = useState(false);
  const submitted = useRef(false);
  const creatingTask = taskDeadline !== undefined;
  const showMinutes = needsMinutes || creatingTask;

  useEffect(() => {
    if (!creatingTask) return;
    let active = true;
    void listDomains().then((result) => {
      if (!active) return;
      if (result.ok) setDomains(result.data);
      else setDomainError(true);
    });
    return () => { active = false; };
  }, [creatingTask, domainRequest]);

  async function save() {
    if (submitted.current || !title.trim() || (creatingTask && (!deadline || !domainId))) return;
    submitted.current = true;
    setBusy(true);
    try {
      const due = creatingTask ? new Date(`${deadline}T23:59:59`).toISOString() : undefined;
      await onSave(title.trim(), Number(minutes), due, domainId || undefined);
    } finally {
      submitted.current = false;
      setBusy(false);
    }
  }

  return (
    <form
      className="aic-node__editor"
      onSubmit={(event) => { event.preventDefault(); void save(); }}
      onKeyDown={(event) => {
        if (event.key === "Escape" && !submitted.current) {
          event.preventDefault();
          onCancel();
        }
      }}
    >
      <fieldset disabled={busy}>
        <label>
          {label}
          <input className="aic-node__input" value={title} maxLength={maxLength} required autoFocus
            onChange={(event) => setTitle(event.target.value)} />
        </label>
        {showMinutes && (
          <label>
            Thời lượng (phút)
            <input className="aic-node__input" type="number" min={1} max={2147483647} step={1}
              value={minutes} required onChange={(event) => setMinutes(event.target.value)} />
          </label>
        )}
        {creatingTask && (
          <>
            <label>
              Hạn hoàn thành
              <input className="aic-node__input" type="date" value={deadline} required
                onChange={(event) => setDeadline(event.target.value)} />
            </label>
            <label>
              Lĩnh vực
              <select className="aic-node__input" value={domainId} required
                disabled={!domains?.length} onChange={(event) => setDomainId(event.target.value)}>
                <option value="">{domains || domainError ? "Chọn lĩnh vực" : "Đang tải lĩnh vực…"}</option>
                {domains?.map((domain) => <option key={domain.id} value={domain.id}>{domain.name}</option>)}
              </select>
            </label>
            {domainError && (
              <button type="button" className="aic-btn aic-btn--tiny" onClick={() => {
                setDomainError(false);
                setDomainRequest((count) => count + 1);
              }}>
                Tải lại lĩnh vực
              </button>
            )}
            {domains?.length === 0 && <span>Chưa có lĩnh vực để chọn.</span>}
          </>
        )}
        <div className="aic-node__editor-actions">
          <button type="submit" className="aic-btn aic-btn--tiny aic-btn--primary"
            disabled={!title.trim() || (creatingTask && !domainId)}>
            {busy ? "Đang lưu…" : "Lưu"}
          </button>
          <button type="button" className="aic-btn aic-btn--tiny" onClick={onCancel}>Hủy</button>
        </div>
      </fieldset>
    </form>
  );
}

/* ===========================================================
 * Deletion confirmation
 * =========================================================== */
function ConfirmDelete({
  label,
  message,
  onConfirm,
  onCancel,
}: {
  label: string;
  message: string;
  onConfirm: () => Promise<void>;
  onCancel: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const submitted = useRef(false);
  async function confirm() {
    if (submitted.current) return;
    submitted.current = true;
    setBusy(true);
    try {
      await onConfirm();
    } finally {
      submitted.current = false;
      setBusy(false);
    }
  }
  return <ConfirmDialog open title={`Xóa ${label}?`} message={message}
    confirmLabel="Xóa" cancelLabel="Hủy" busy={busy}
    onConfirm={() => void confirm()} onCancel={onCancel} />;
}
