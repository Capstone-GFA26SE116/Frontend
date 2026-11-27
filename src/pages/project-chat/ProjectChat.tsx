import { useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { CenterToasts } from "../../components/Toast";
import {
  approveScheduleProposal,
  getPendingScheduleProposal,
  listProjectDocuments,
  listScheduleSlotsByTask,
  proposeSchedule,
  type ProjectDocumentDto,
  type ProposeScheduleResponse,
  type ScheduleSlotDto,
  type TaskDto,
} from "../../lib/api-client";
import { ChatFrame, MAX_FILES_PER_MESSAGE, NotesCard } from "../copilot/ChatFrame";
import { ChatHistoryPanel } from "../copilot/ChatHistoryPanel";
import { isTaskDone } from "../copilot/ai-chat-logic";
import { ProjectTree } from "../copilot/ProjectTree";
import { useProjectChat } from "../copilot/useProjectChat";
import { TaskCompanion } from "./TaskCompanion";
import "../copilot/copilot.css";
import "./project-chat.css";

interface ScheduleScope {
  ids: string[];
  title: string;
}

function formatTime(value: string) {
  return new Intl.DateTimeFormat("vi-VN", {
    day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit",
  }).format(new Date(value));
}

function canSchedule(task: TaskDto) {
  return task.taskType?.toLowerCase() === "flexible" && !isTaskDone(task.status) &&
    task.status.toLowerCase() !== "skipped";
}

function Companion({ projectId }: { projectId: string }) {
  const navigate = useNavigate();
  const chat = useProjectChat({ initialProjectId: projectId });
  const { handlers } = chat;
  const [pane, setPane] = useState<"history" | "work" | null>(null);
  const [documents, setDocuments] = useState<ProjectDocumentDto[]>([]);
  const [documentError, setDocumentError] = useState("");
  const [taskChat, setTaskChat] = useState<{ task: TaskDto; question: string } | null>(null);
  const [suggestAfterSplit, setSuggestAfterSplit] = useState(false);
  const [scope, setScope] = useState<ScheduleScope | null>(null);
  const [proposal, setProposal] = useState<ProposeScheduleResponse | null>(null);
  const [existingSlots, setExistingSlots] = useState<ScheduleSlotDto[]>([]);
  const [usingExisting, setUsingExisting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [deferred, setDeferred] = useState(false);
  const [scheduleError, setScheduleError] = useState("");
  const scheduleInFlight = useRef(false);
  const didLoadPending = useRef(false);
  const scopeChosen = useRef(false);
  const notes = chat.messages.findLast((message) => message.notes)?.notes;
  const splittable = chat.tasks.filter((task) => canSchedule(task) &&
    !chat.subtasksByTaskId.get(task.id)?.length);
  const sample = splittable.find((task) => task.estimatedMinutes > 120) ?? splittable[0];

  useEffect(() => {
    let active = true;
    void listProjectDocuments(projectId, { sourceType: "File" }).then((result) => {
      if (!active) return;
      if (result.ok) {
        setDocuments(result.data.filter((doc) => /\.(pdf|docx|txt|md|xlsx|csv)$/i.test(doc.name ?? "")));
      } else {
        setDocumentError("Không tải được tài liệu của dự án.");
      }
    });
    return () => { active = false; };
  }, [projectId]);

  useEffect(() => {
    if (!chat.tasks.length || didLoadPending.current) return;
    didLoadPending.current = true;
    const titles = new Map(chat.tasks.map((task) => [task.id, task.title]));
    void getPendingScheduleProposal().then((result) => {
      if (!result.ok || !result.data || scopeChosen.current) return;
      const pending = result.data;
      const slots = pending.slots.flatMap((slot) => slot.taskId ? [{
        slot_id: slot.id,
        task_id: slot.taskId,
        subtask_id: slot.subTaskId,
        start: slot.startTime,
        end: slot.endTime,
        proposed_minutes: slot.proposedMinutes,
        explanation: slot.explanation,
      }] : []);
      const ids = [...new Set(slots.map((slot) => slot.task_id))];
      if (!ids.length || !ids.every((id) => titles.has(id))) return;
      setScope({ ids, title: ids.length === 1 ? (titles.get(ids[0]) ?? "việc đã chọn") : `${ids.length} việc trong dự án` });
      setProposal({
        proposal_id: pending.id,
        is_feasible: pending.isFeasible,
        missing_minutes: pending.missingMinutes ?? 0,
        explanation: pending.explanation,
        slots,
        warnings: [],
      });
      setDeferred(true);
    });
  }, [chat.tasks]);

  function openTask(task: TaskDto, question = `Giúp tui chia nhỏ việc ${task.title}.`) {
    setPane(null);
    setSuggestAfterSplit(false);
    setTaskChat({ task, question });
  }

  function sendMessage() {
    const text = chat.draftText.trim().normalize("NFC").toLowerCase();
    if (!chat.files.length && !chat.documentIds.length && /chia nhỏ|phân rã/.test(text)) {
      const matches = splittable.filter((task) => text.includes(task.title.normalize("NFC").toLowerCase()));
      if (matches.length === 1) {
        openTask(matches[0], chat.draftText.trim());
        chat.setDraftText("");
        return;
      }
    }
    handlers.onSend();
  }

  async function suggest(nextScope: ScheduleScope) {
    if (scheduleInFlight.current || !nextScope.ids.length) return;
    if (proposal?.proposal_id && !confirmed && !scheduleError &&
      scope?.ids.length === nextScope.ids.length && nextScope.ids.every((id) => scope.ids.includes(id))) {
      setDeferred(false);
      return;
    }
    scopeChosen.current = true;
    scheduleInFlight.current = true;
    setPane(null);
    setBusy(true);
    setScope(nextScope);
    setProposal(null);
    setExistingSlots([]);
    setUsingExisting(false);
    setConfirmed(false);
    setDeferred(false);
    setScheduleError("");

    try {
      if (nextScope.ids.length === 1) {
        const existing = await listScheduleSlotsByTask(nextScope.ids[0]);
        if (!existing.ok) {
          setScheduleError("Chưa kiểm tra được giờ hiện tại của việc. Bạn thử lại nhé.");
          return;
        }
        const reserved = existing.data.filter((slot) => !slot.subTaskId &&
          ["approved", "due", "inprogress", "overrun"].includes(slot.status.toLowerCase()));
        if (reserved.length) {
          setExistingSlots(reserved);
          return;
        }
      }

      const result = await proposeSchedule({ task_ids: nextScope.ids, language: "vi" });
      if (result.ok) setProposal(result.data);
      else setScheduleError(result.error);
    } finally {
      scheduleInFlight.current = false;
      setBusy(false);
    }
  }

  async function approve() {
    if (scheduleInFlight.current || !proposal?.proposal_id || !proposal.slots.length || confirmed) return;
    scheduleInFlight.current = true;
    setBusy(true);
    setScheduleError("");
    try {
      const result = await approveScheduleProposal(proposal.proposal_id);
      if (result.ok) setConfirmed(true);
      else setScheduleError(result.error);
    } finally {
      scheduleInFlight.current = false;
      setBusy(false);
    }
  }

  function nameOf(taskId: string, subtaskId: string | null) {
    return (subtaskId && chat.subtasksByTaskId.get(taskId)?.find((item) => item.id === subtaskId)?.title) ||
      chat.tasks.find((task) => task.id === taskId)?.title || scope?.title;
  }

  const schedulePanel = scope && (
    <section className="pc-panel" aria-label="Đề xuất lịch">
      <div className="pc-panel-title">
        <strong>{confirmed ? "Đã thêm vào lịch" : "Tìm giờ cho " + scope.title}</strong>
        {proposal && !confirmed && proposal.slots.length > 0 && <span>Chờ duyệt</span>}
      </div>
      {!!existingSlots.length && <>
        <p>{usingExisting ? "Bạn có thể làm việc này trong khung giờ đang có." : "Việc này đã có khung giờ riêng."}</p>
        <ul>{existingSlots.map((slot) => <li key={slot.id}>{formatTime(slot.startTime)} – {formatTime(slot.endTime)}</li>)}</ul>
        <div className="pc-actions">
          {!usingExisting && <button type="button" className="aic-btn aic-btn--secondary" onClick={() => setUsingExisting(true)}>Dùng giờ hiện tại</button>}
          <button type="button" className="aic-btn aic-btn--ghost" onClick={() => navigate("/schedule")}>Đổi giờ trên lịch</button>
        </div>
      </>}
      {proposal && (deferred ? (
        <button type="button" className="aic-btn aic-btn--secondary" onClick={() => setDeferred(false)}>Xem lại giờ gợi ý</button>
      ) : <>
        {!proposal.slots.length && <p>Chưa có khung giờ phù hợp để thêm cho phạm vi này.</p>}
        {!!proposal.slots.length && <ul className="pc-slot-list">{proposal.slots.map((slot) => (
          <li key={slot.slot_id}>
            <strong>{nameOf(slot.task_id, slot.subtask_id)}</strong>
            <div>{formatTime(slot.start)} – {formatTime(slot.end)}</div>
            {slot.explanation && <p>{slot.explanation}</p>}
          </li>
        ))}</ul>}
        {proposal.warnings.map((warning, index) => (
          <p key={index}>{warning.message ?? `${nameOf(warning.task_id, null)} chưa đủ giờ phù hợp.`}</p>
        ))}
        {!proposal.is_feasible && !proposal.warnings.length && <p>
          Còn công việc chưa tìm được giờ{proposal.missing_minutes > 0 ? ` · còn thiếu ${proposal.missing_minutes} phút` : ""}.
        </p>}
        {confirmed ? (
          <button type="button" className="aic-btn aic-btn--secondary" onClick={() => navigate("/schedule")}>Xem lịch</button>
        ) : !!proposal.slots.length && (
          <div className="pc-actions">
            <button type="button" className="aic-btn aic-btn--primary" disabled={busy} onClick={() => void approve()}>
              Thêm {proposal.slots.length} khung giờ vào lịch
            </button>
            <button type="button" className="aic-btn aic-btn--secondary" disabled={busy} onClick={() => setDeferred(true)}>Để sau</button>
          </div>
        )}
      </>)}
      {busy && <p role="status">Đang xử lý lịch…</p>}
      {scheduleError && <p role="alert">{scheduleError}</p>}
      {!busy && (scheduleError || existingSlots.length > 0) &&
        <button type="button" className="aic-btn aic-btn--ghost" onClick={() => void suggest(scope)}>Kiểm tra và tìm giờ lại</button>}
    </section>
  );

  const tools = <>
    {taskChat && <TaskCompanion key={taskChat.task.id} task={taskChat.task} initialQuestion={taskChat.question}
      onClose={() => setTaskChat(null)} onSaved={() => {
        setSuggestAfterSplit(true);
        void chat.reloadProjectTree();
      }} />}
    {taskChat && suggestAfterSplit && <div className="pc-actions">
      <button type="button" className="aic-btn aic-btn--secondary" disabled={busy}
        onClick={() => void suggest({ ids: [taskChat.task.id], title: `việc con của “${taskChat.task.title}”` })}>
        Tìm giờ cho việc con vừa lưu
      </button>
    </div>}
    {!!chat.newTaskIds.length && <div className="pc-actions">
      <button type="button" className="aic-btn aic-btn--secondary" disabled={busy}
        onClick={() => void suggest({ ids: chat.newTaskIds, title: `${chat.newTaskIds.length} việc vừa lưu` })}>
        Tìm giờ cho {chat.newTaskIds.length} việc vừa lưu
      </button>
    </div>}
    {schedulePanel}
  </>;

  return (
    <div className="aic aic--embedded" data-pane={pane ?? "chat"}>
      <ChatHistoryPanel
        activeId={chat.conversationId}
        onOpen={(item) => {
          if (chat.waiting || chat.applying) return;
          setPane(null);
          setTaskChat(null);
          chat.setDraftText("");
          chat.setDocumentIds([]);
          chat.setFiles([]);
          void chat.openConversationById(item.conversation_id);
        }}
        onImportFile={() => navigate("/projects/import")}
        onCreateProject={() => navigate("/projects/new")}
        refreshKey={chat.refreshKey}
        projectIdFilter={projectId}
        hideCreateButton
        emptyMessage="Dự án này chưa có lịch sử chat."
      />
      <ChatFrame
        projectName={chat.project?.name ?? "Chat AI dự án"}
        screenState={chat.screenState}
        hasDraft={chat.hasDraft}
        messages={chat.messages}
        waiting={chat.waiting}
        draftText={chat.draftText}
        onDraftTextChange={chat.setDraftText}
        files={chat.files}
        onFilesChange={chat.setFiles}
        onSend={sendMessage}
        onPlan={handlers.onPlan}
        onApplyAndSchedule={handlers.onApplyAndSchedule}
        onApplyOnly={handlers.onApplyOnly}
        onCreateFixedTask={handlers.onCreateFixedTask}
        onOpenSchedule={() => navigate("/schedule")}
        scheduleResult={null}
        applying={chat.applying}
        planLocked={chat.aiErrorKind === "plan_locked"}
        aiError={chat.aiError}
        onRetry={handlers.onRetry}
        companion={{
          sampleTask: sample?.title,
          onSampleTask: () => { if (sample) openTask(sample); },
          latestDraftId: chat.latestDraft?.message_id,
          documentCount: chat.documentIds.length,
          panel: tools,
          navigation: <div className="pc-mobile-nav pc-actions">
            <button type="button" className="aic-btn aic-btn--ghost" aria-expanded={pane === "history"}
              onClick={() => setPane(pane === "history" ? null : "history")}>Lịch sử</button>
            <button type="button" className="aic-btn aic-btn--ghost" aria-expanded={pane === "work"}
              onClick={() => setPane(pane === "work" ? null : "work")}>Dự án</button>
          </div>,
          documentPicker: (documents.length > 0 || documentError) && <details className="pc-documents">
            <summary>Tài liệu dự án{chat.documentIds.length ? ` · ${chat.documentIds.length} đã chọn` : ""}</summary>
            {documentError && <p role="status">{documentError}</p>}
            {documents.map((document) => {
              const chosen = chat.documentIds.includes(document.id);
              const full = chat.documentIds.length + chat.files.length >= MAX_FILES_PER_MESSAGE;
              return <label key={document.id}>
                <input type="checkbox" checked={chosen} disabled={chat.waiting || chat.applying || (!chosen && full)}
                  onChange={() => chat.setDocumentIds((ids) => chosen ? ids.filter((id) => id !== document.id) : [...ids, document.id])} />
                {document.name}
              </label>;
            })}
          </details>,
        }}
      />
      <ProjectTree
        project={chat.project ? { id: chat.project.id, name: chat.project.name, clientName: chat.project.client?.name ?? null, deadline: chat.project.deadline ?? null } : null}
        milestones={chat.milestones}
        tasks={chat.tasks}
        subtasksByTaskId={chat.subtasksByTaskId}
        draftMilestoneTitles={chat.draftMilestoneTitles}
        loading={chat.treeLoading}
        error={chat.treeError}
        planningSummary={notes && <details className="pc-planning-summary">
          <summary>Tóm tắt để lập kế hoạch</summary>
          <NotesCard notes={notes} />
        </details>}
        taskActions={(task, subtasks) => canSchedule(task) && <details className="pc-task-actions">
          <summary aria-label={`Thao tác với ${task.title}`}>Thao tác</summary>
          <div className="pc-actions">
            {subtasks.length === 0 &&
              <button type="button" className="aic-btn aic-btn--ghost" onClick={() => openTask(task)}>Chia nhỏ với AI</button>}
            <button type="button" className="aic-btn aic-btn--ghost" disabled={busy}
              onClick={() => void suggest({ ids: [task.id], title: task.title })}>
              {subtasks.length ? "Xếp lịch việc con" : "Xếp lịch việc này"}
            </button>
          </div>
        </details>}
        onEditProject={() => navigate(`/projects/${projectId}`)}
        onAddMilestone={handlers.onAddMilestone}
        onAddTask={handlers.onAddTask}
        onAddSubtask={handlers.onAddSubtask}
        onRenameMilestone={handlers.onRenameMilestone}
        onRenameTask={handlers.onRenameTask}
        onRenameSubtask={handlers.onRenameSubtask}
        onDeleteMilestone={handlers.onDeleteMilestone}
        onDeleteTask={handlers.onDeleteTask}
        onDeleteSubtask={handlers.onDeleteSubtask}
        onToggleTaskDone={handlers.onToggleTaskDone}
      />
      <CenterToasts toasts={chat.toasts} onDismiss={chat.toast.dismiss} />
    </div>
  );
}

export function ProjectChatPage() {
  const { projectId } = useParams<{ projectId: string }>();
  return projectId ? <Companion key={projectId} projectId={projectId} /> : null;
}
