import { useMemo, useState, type ReactNode } from "react";
import {
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
 *             ⚠️ KHÔNG hỏi bằng popup che màn.
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
  onAddMilestone: () => void;
  /** Thêm việc vào cột mốc. */
  onAddTask: (milestoneId: string, title: string) => void;
  /** Thêm việc con vào việc. */
  onAddSubtask: (taskId: string, title: string) => void;
  /** Lưu tên milestone. */
  onRenameMilestone: (milestoneId: string, name: string) => void;
  /** Lưu tên task. */
  onRenameTask: (taskId: string, title: string) => void;
  /** Lưu tên việc con. */
  onRenameSubtask: (subtaskId: string, title: string) => void;
  /** Xoá milestone. */
  onDeleteMilestone: (milestoneId: string) => void;
  /** Xoá task. */
  onDeleteTask: (taskId: string) => void;
  /** Xoá việc con. */
  onDeleteSubtask: (subtaskId: string) => void;
  /** Đánh dấu task xong / chưa xong. */
  onToggleTaskDone: (task: TaskDto) => void;
}

/** Khoá duy nhất cho 1 hành động đang chờ (rename/delete/add). */
type PendingEdit =
  | { kind: "rename"; id: string; value: string }
  | { kind: "delete"; id: string; label: string }
  | { kind: "add"; parentId: string; value: string }
  | null;

export function ProjectTree(props: ProjectTreeProps) {
  const {
    project,
    milestones,
    tasks,
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
  const [openMs, setOpenMs] = useState<Set<string>>(new Set());
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
  function handleRename(id: string, value: string) {
    const trimmed = value.trim();
    if (!trimmed) return;
    if (id.startsWith("ms:")) onRenameMilestone(id.slice(3), trimmed);
    else if (id.startsWith("ts:")) onRenameSubtask(id.slice(3), trimmed);
    else onRenameTask(id, trimmed);
    setPending(null);
  }

  /** Xoá sau khi xác nhận nội tuyến. */
  function handleDelete(id: string) {
    if (id.startsWith("ms:")) onDeleteMilestone(id.slice(3));
    else if (id.startsWith("ts:")) onDeleteSubtask(id.slice(3));
    else onDeleteTask(id);
    setPending(null);
  }

  /** Bấm 🗑 → bật chế độ xác nhận nội tuyến (không dùng popup che màn). */
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
          onClick={onAddMilestone}
        >
          <span className="material-symbols-outlined">add</span>
          Cột mốc
        </button>

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
            {milestones.map((m) => (
              <MilestoneNode
                key={m.id}
                milestone={m}
                tasks={tasksByMilestone.get(m.id) ?? []}
                subtasksByTaskId={subtasksByTaskId}
                open={openMs.has(m.id)}
                openTasks={openTasks}
                pending={pending}
                onToggleMs={() => setOpenMs((s) => toggle(s, m.id))}
                onToggleTask={(id) => setOpenTasks((s) => toggle(s, id))}
                onAddTask={(msId, title) => onAddTask(msId, title)}
                onAddSubtask={(taskId, title) => onAddSubtask(taskId, title)}
                onRename={handleRename}
                onRequestDelete={handleRequestDelete}
                onCancelEdit={() => setPending(null)}
                onDelete={handleDelete}
                onToggleDone={onToggleTaskDone}
                taskActions={taskActions}
              />
            ))}

            {/* Task chưa có cột mốc */}
            {orphanTasks.length > 0 && (
              <section className="aic-tree__orphan">
                <h3 className="aic-tree__orphan-title">Chưa gán cột mốc</h3>
                {orphanTasks.map((t) => (
                  <TaskNode
                    key={t.id}
                    task={t}
                    subtasks={subtasksByTaskId.get(t.id) ?? []}
                    open={openTasks.has(t.id)}
                    pending={pending}
                    onToggle={() => setOpenTasks((s) => toggle(s, t.id))}
                    onAddSubtask={(taskId, title) => onAddSubtask(taskId, title)}
                    onRename={handleRename}
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
  subtasksByTaskId,
  open,
  openTasks,
  pending,
  onToggleMs,
  onToggleTask,
  onAddTask,
  onAddSubtask,
  onRename,
  onRequestDelete,
  onCancelEdit,
  onDelete,
  onToggleDone,
  taskActions,
}: {
  milestone: MilestoneDto;
  tasks: TaskDto[];
  subtasksByTaskId: Map<string, SubtaskDto[]>;
  open: boolean;
  openTasks: Set<string>;
  pending: PendingEdit;
  onToggleMs: () => void;
  onToggleTask: (id: string) => void;
  onAddTask: (msId: string, title: string) => void;
  onAddSubtask: (taskId: string, title: string) => void;
  onRename: (id: string, value: string) => void;
  /** Bấm 🗑 → bật chế độ xác nhận nội tuyến. */
  onRequestDelete: (id: string) => void;
  /** Huỷ thao tác nội tuyến. */
  onCancelEdit: () => void;
  /** Xác nhận xoá → xoá thật. */
  onDelete: (id: string) => void;
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
          onConfirm={() => onDelete(msId)}
          onCancel={onCancelEdit}
        />
      ) : renaming ? (
        <InlineEditor
          initial={milestone.name}
          onSave={onRename}
          onCancel={onCancelEdit}
          id={msId}
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
              onClick={() => onAddTask(milestone.id, "")}
              aria-label="Thêm việc"
              title="Thêm việc"
            >
              <span className="material-symbols-outlined">add</span>
            </button>
            <button
              type="button"
              className="aic-icon-btn aic-icon-btn--xs"
              onClick={() => onRename(msId, milestone.name)}
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
              subtasks={subtasksByTaskId.get(t.id) ?? []}
              open={openTasks.has(t.id)}
              pending={pending}
              onToggle={() => onToggleTask(t.id)}
              onAddSubtask={(taskId, title) => onAddSubtask(taskId, title)}
              onRename={onRename}
              onRequestDelete={onRequestDelete}
              onCancelEdit={onCancelEdit}
              onDelete={onDelete}
              onToggleDone={onToggleDone}
              taskActions={taskActions}
            />
          ))}

          {adding && (
            <AddRow
              placeholder="Việc mới"
              onSubmit={(title) => onAddTask(milestone.id, title)}
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
  subtasks,
  open,
  pending,
  onToggle,
  onAddSubtask,
  onRename,
  onRequestDelete,
  onCancelEdit,
  onDelete,
  onToggleDone,
  taskActions,
}: {
  task: TaskDto;
  subtasks: SubtaskDto[];
  open: boolean;
  pending: PendingEdit;
  onToggle: () => void;
  onAddSubtask: (taskId: string, title: string) => void;
  onRename: (id: string, value: string) => void;
  onDelete: (id: string) => void;
  /** Bấm 🗑 → bật chế độ xác nhận nội tuyến. */
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
          onConfirm={() => onDelete(task.id)}
          onCancel={onCancelEdit}
        />
      ) : renaming ? (
        <InlineEditor
          initial={task.title}
          onSave={onRename}
          onCancel={onCancelEdit}
          id={task.id}
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

          <span className="aic-node__meta">
            {fmtDuration(task.estimatedMinutes)}
            {subtasks.length > 0 && ` · ${subtasks.length} con`}
          </span>

          <span className="aic-node__acts">
            <button
              type="button"
              className="aic-icon-btn aic-icon-btn--xs"
              onClick={() => onAddSubtask(task.id, "")}
              aria-label="Thêm việc con"
              title="Thêm việc con"
            >
              <span className="material-symbols-outlined">add</span>
            </button>
            <button
              type="button"
              className="aic-icon-btn aic-icon-btn--xs"
              onClick={() => onRename(task.id, task.title)}
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
              onRequestDelete={onRequestDelete}
              onCancelEdit={onCancelEdit}
              onDelete={onDelete}
            />
          ))}

          {adding && (
            <AddRow
              placeholder="Việc con mới"
              onSubmit={(title) => onAddSubtask(task.id, title)}
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
  onRequestDelete,
  onCancelEdit,
  onDelete,
}: {
  subtask: SubtaskDto;
  pending: PendingEdit;
  onRename: (id: string, value: string) => void;
  onDelete: (id: string) => void;
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
          onConfirm={() => onDelete(id)}
          onCancel={onCancelEdit}
        />
      ) : renaming ? (
        <InlineEditor
          initial={subtask.title}
          onSave={onRename}
          onCancel={onCancelEdit}
          id={id}
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
              onClick={() => onRename(id, subtask.title)}
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

/* ===========================================================
 * Dòng thêm mới (hiện ngay ở chế độ sửa tên)
 * =========================================================== */
function AddRow({
  placeholder,
  onSubmit,
}: {
  placeholder: string;
  onSubmit: (title: string) => void;
}) {
  const [value, setValue] = useState("");

  function commit() {
    const t = value.trim();
    if (!t) return;
    onSubmit(t);
    setValue("");
  }

  return (
    <div className="aic-node__row aic-node__row--add">
      <input
        className="aic-node__input"
        placeholder={placeholder}
        value={value}
        autoFocus
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            commit();
          }
          if (e.key === "Escape") setValue("");
        }}
      />
      <button
        type="button"
        className="aic-btn aic-btn--tiny aic-btn--primary"
        onClick={commit}
      >
        Thêm
      </button>
    </div>
  );
}

/* ===========================================================
 * Ô sửa tên nội tuyến (Enter = Lưu, Esc = Huỷ)
 * =========================================================== */
function InlineEditor({
  initial,
  onSave,
  onCancel,
  id,
}: {
  initial: string;
  onSave: (id: string, value: string) => void;
  onCancel: () => void;
  id: string;
}) {
  const [value, setValue] = useState(initial);

  return (
    <div className="aic-node__row aic-node__row--editing">
      <input
        className="aic-node__input"
        value={value}
        autoFocus
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            onSave(id, value);
          }
          if (e.key === "Escape") {
            e.preventDefault();
            onCancel();
          }
        }}
      />
      <button
        type="button"
        className="aic-btn aic-btn--tiny aic-btn--primary"
        onClick={() => onSave(id, value)}
      >
        Lưu
      </button>
      <button type="button" className="aic-btn aic-btn--tiny" onClick={onCancel}>
        Huỷ
      </button>
    </div>
  );
}

/* ===========================================================
 * Xác nhận xoá nội tuyến (KHÔNG dùng popup che màn)
 * =========================================================== */
function ConfirmDelete({
  label,
  onConfirm,
  onCancel,
}: {
  label: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="aic-node__row aic-node__row--confirm">
      <span className="aic-node__confirm-text">Xoá {label}?</span>
      <button
        type="button"
        className="aic-btn aic-btn--tiny aic-btn--danger"
        onClick={onConfirm}
      >
        Xoá
      </button>
      <button type="button" className="aic-btn aic-btn--tiny" onClick={onCancel}>
        Huỷ
      </button>
    </div>
  );
}
