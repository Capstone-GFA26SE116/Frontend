import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import {
  listGroupSubTasks,
  type GroupDto,
  type GroupMemberDto,
  type GroupMilestoneDto,
  type GroupSubTaskDto,
  type GroupTaskDto,
} from "../../lib/group-api";
import { fmtMinutes } from "./group-ai-logic";

const statusLabels: Record<string, string> = {
  ToDo: "Cần làm",
  Planned: "Đã lên kế hoạch",
  InProgress: "Đang làm",
  Done: "Hoàn thành",
  Skipped: "Bỏ qua",
  Delivered: "Đã bàn giao",
  Approved: "Đã duyệt",
  InRevision: "Đang chỉnh sửa",
};

function formatDate(value?: string | null, withTime = false) {
  if (!value) return "Chưa đặt";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("vi-VN", {
    dateStyle: "short",
    ...(withTime ? { timeStyle: "short" } : {}),
    timeZone: "Asia/Ho_Chi_Minh",
  }).format(date);
}

interface GroupWorkPanelProps {
  group: GroupDto;
  members: GroupMemberDto[];
  milestones: GroupMilestoneDto[];
  tasks: GroupTaskDto[];
  loading: boolean;
  error: boolean;
  version: number;
  onRetry: () => void;
}

export function GroupWorkPanel({
  group, members, milestones, tasks, loading, error, version, onRetry,
}: GroupWorkPanelProps) {
  const membersById = new Map(members.map((member) => [member.userId, member.fullName]));
  const tasksByMilestone = new Map<string, GroupTaskDto[]>();
  const milestoneIds = new Set(milestones.map((milestone) => milestone.id));
  const ungrouped: GroupTaskDto[] = [];
  for (const task of tasks) {
    if (!task.milestoneId || !milestoneIds.has(task.milestoneId)) {
      ungrouped.push(task);
      continue;
    }
    const milestoneTasks = tasksByMilestone.get(task.milestoneId) ?? [];
    milestoneTasks.push(task);
    tasksByMilestone.set(task.milestoneId, milestoneTasks);
  }
  const done = tasks.filter((task) => task.status === "Done").length;

  return (
    <section className="gai-planner-card gai-group-work" aria-label="Thông tin và công việc của nhóm">
      <div className="gai-planner-card-head">
        <span className="material-symbols-outlined gai-planner-card-icon" aria-hidden="true">groups</span>
        <h2 className="gai-planner-card-title">{group.name}</h2>
        <Link className="gai-btn gai-btn--ghost gai-btn--sm" to={`/groups/${group.id}`}>Mở nhóm</Link>
      </div>
      {group.description && <p className="gai-group-work-description">{group.description}</p>}
      <dl className="gai-group-work-info">
        <div><dt>Trạng thái</dt><dd>{group.status === "Archived" ? "Đã lưu trữ" : "Đang hoạt động"}</dd></div>
        <div><dt>Bắt đầu</dt><dd>{formatDate(group.startDate)}</dd></div>
        <div><dt>Hạn bàn giao</dt><dd>{formatDate(group.deadline)}</dd></div>
        <div><dt>Thành viên</dt><dd>{group.memberCount}</dd></div>
      </dl>

      <div className="gai-group-work-heading">
        <h3>Cột mốc và công việc</h3>
        {(!loading && !error) && <span>{done}/{tasks.length} việc hoàn thành</span>}
      </div>
      {loading && <p className="gai-planner-card-sub" role="status">Đang tải công việc…</p>}
      {error && (
        <div className="gai-group-work-error">
          <p className="gai-planner-card-sub" role="alert">Chưa tải được đầy đủ cột mốc và công việc.</p>
          <button type="button" className="gai-btn gai-btn--ghost gai-btn--sm" disabled={loading} onClick={onRetry}>
            Tải lại công việc
          </button>
        </div>
      )}
      {!loading && !error && !milestones.length && !tasks.length && (
        <p className="gai-planner-card-sub">Nhóm chưa có cột mốc hoặc công việc nào.</p>
      )}
      {[...milestones].sort((a, b) => a.orderIndex - b.orderIndex).map((milestone) => {
        const list = tasksByMilestone.get(milestone.id) ?? [];
        return (
          <details key={milestone.id} className="gai-group-work-milestone" open>
            <summary>
              <strong>{milestone.name}</strong>
              <span className="gai-group-work-meta">
                {list.length} việc
                {milestone.dueDate && ` · Hạn ${formatDate(milestone.dueDate)}`}
                {milestone.status && ` · ${statusLabels[milestone.status] ?? milestone.status}`}
              </span>
            </summary>
            {list.length ? (
              <ul className="gai-group-work-list">
                {list.map((task) => <WorkItem key={task.id} task={task} members={membersById} version={version} />)}
              </ul>
            ) : <p className="gai-planner-card-sub">Chưa có việc trong cột mốc này.</p>}
          </details>
        );
      })}
      {ungrouped.length > 0 && (
        <details className="gai-group-work-milestone" open>
          <summary><strong>Chưa gán cột mốc</strong><span className="gai-group-work-meta">{ungrouped.length} việc</span></summary>
          <ul className="gai-group-work-list">
            {ungrouped.map((task) => <WorkItem key={task.id} task={task} members={membersById} version={version} />)}
          </ul>
        </details>
      )}
    </section>
  );
}

function WorkItem({ task, members, version }: {
  task: GroupTaskDto;
  members: Map<string, string>;
  version: number;
}) {
  const [opened, setOpened] = useState(false);
  const [retry, setRetry] = useState(0);
  const [loaded, setLoaded] = useState<{
    version: number;
    retry: number;
    subtasks: GroupSubTaskDto[] | null;
  } | null>(null);
  const hasSubtasks = task.subTaskCount > 0;
  const current = loaded?.version === version && loaded.retry === retry ? loaded : null;

  useEffect(() => {
    if (!opened || !hasSubtasks || current) return;
    let active = true;
    void listGroupSubTasks(task.id).then((result) => {
      if (active) setLoaded({ version, retry, subtasks: result.ok ? result.data : null });
    });
    return () => { active = false; };
  }, [opened, hasSubtasks, current, retry, task.id, version]);

  const assignee = task.assigneeName || (task.assigneeId && members.get(task.assigneeId));
  return (
    <li className="gai-group-work-item">
      <details onToggle={(event) => setOpened(event.currentTarget.open)}>
        <summary>
          <strong>{task.title}</strong>
          <span className="gai-group-work-meta">
            {statusLabels[task.status] ?? task.status}
            {" · "}{assignee || (task.assigneeId ? "Đã giao" : "Chưa giao")}
            {task.estimatedMinutes != null && ` · ${fmtMinutes(task.estimatedMinutes)}`}
            {hasSubtasks && ` · ${task.subTaskDoneCount}/${task.subTaskCount} việc con`}
          </span>
        </summary>
        <div className="gai-group-work-detail">
          {task.description && <p className="gai-planner-card-sub">{task.description}</p>}
          <span className="gai-group-work-meta">
            {task.fixedStart && task.fixedEnd
              ? `Giờ cố định: ${formatDate(task.fixedStart, true)} – ${formatDate(task.fixedEnd, true)}`
              : `Hạn: ${formatDate(task.deadline, true)}`}
            {task.priority && ` · Ưu tiên ${({ High: "cao", Medium: "vừa", Low: "thấp" } as Record<string, string>)[task.priority] ?? task.priority}`}
          </span>
          {hasSubtasks && !current && <p className="gai-planner-card-sub" role="status">Đang tải việc con…</p>}
          {hasSubtasks && current && (current.subtasks === null ? (
            <button className="gai-btn gai-btn--ghost gai-btn--sm" type="button" onClick={() => setRetry((count) => count + 1)}>
              Tải lại việc con
            </button>
          ) : current.subtasks.length ? (
            <ul className="gai-group-work-list">
              {[...current.subtasks].sort((a, b) => a.orderIndex - b.orderIndex).map((subtask) => {
                const name = subtask.assigneeName || (subtask.assigneeId && members.get(subtask.assigneeId));
                return (
                  <li key={subtask.id} className="gai-group-work-subtask">
                    <strong>{subtask.title}</strong>
                    <span className="gai-group-work-meta">
                      {statusLabels[subtask.status] ?? subtask.status}
                      {name && ` · ${name}`}
                      {subtask.estimatedMinutes != null && ` · ${fmtMinutes(subtask.estimatedMinutes)}`}
                    </span>
                  </li>
                );
              })}
            </ul>
          ) : <p className="gai-planner-card-sub">Chưa có việc con.</p>)}
        </div>
      </details>
    </li>
  );
}
