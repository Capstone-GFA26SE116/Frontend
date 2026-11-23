import { useNavigate, useParams } from "react-router-dom";
import { CenterToasts } from "../../components/Toast";
import { ChatFrame } from "../copilot/ChatFrame";
import { ChatHistoryPanel } from "../copilot/ChatHistoryPanel";
import { ProjectTree } from "../copilot/ProjectTree";
import { scheduleErrorHint } from "../copilot/ai-chat-logic";
import { useProjectChat } from "../copilot/useProjectChat";
import "../copilot/copilot.css";
import "./project-chat.css";

/* ===========================================================
 * Chat AI trong dự án
 * Route: /projects/:projectId/chat
 * ------------------------------------------------------------
 * Tích hợp nguyên màn chat AI 3 cột của trang `/copilot` vào trong
 * dự án:
 *
 *   ┌──────────────┬────────────────────────┬──────────────┐
 *   │ LỊCH SỬ CHAT │ KHUNG CHAT              │ THÔNG TIN DỰ │
 *   │ của dự án   │ chat với AI về dự án    │ ÁN           │
 *   └──────────────┴────────────────────────┴──────────────┘
 *
 * Khác biệt so với `/copilot`:
 *   - Lịch sử chat **chỉ hiện của dự án này** (lọc client-side từ
 *     `GET /chat/conversations` theo `project.id`).
 *   - Chân cột trái có nút "Import file" (thay cho nút ở `/copilot`) và
 *     không có nút "Dự án mới" (đã ở trong dự án rồi).
 *
 * Toàn bộ logic dùng chung với `/copilot` qua hook `useProjectChat`.
 *
 * Class prefix: `.aic-*` (dùng chung) + `.pc-*` (riêng trang này).
 * =========================================================== */

export function ProjectChatPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const navigate = useNavigate();

  const chat = useProjectChat({ initialProjectId: projectId ?? null });
  const {
    conversationId,
    project,
    messages,
    draftText,
    setDraftText,
    files,
    setFiles,
    waiting,
    applying,
    aiError,
    aiErrorKind,
    screenState,
    scheduleResult,
    scheduleError,
    scheduleBusy,
    newTaskIds,
    latestDraft,
    milestones,
    tasks,
    subtasksByTaskId,
    treeLoading,
    treeError,
    draftMilestoneTitles,
    refreshKey,
    toasts,
    toast,
    handlers,
    openConversationById,
  } = chat;

  return (
    <div className="aic aic--embedded">
      {/* ============ Cột trái — lịch sử chat của dự án ============ */}
      <ChatHistoryPanel
        activeId={conversationId}
        onOpen={(item) => void openConversationById(item.conversation_id)}
        onImportFile={() => navigate("/projects/import")}
        onCreateProject={() => navigate("/projects/new")}
        refreshKey={refreshKey}
        projectIdFilter={projectId ?? null}
        hideCreateButton
        emptyMessage="Dự án này chưa có lịch sử chat nào. Hãy bắt đầu cuộc trò chuyện với AI."
      />

      {/* ============ Cột giữa — chat với AI ============ */}
      <ChatFrame
        projectName={project?.name ?? "Chat AI dự án"}
        screenState={screenState}
        hasDraft={!!latestDraft && latestDraft.applied !== true}
        messages={messages}
        waiting={waiting}
        draftText={draftText}
        onDraftTextChange={setDraftText}
        files={files}
        onFilesChange={setFiles}
        onSend={handlers.onSend}
        onPlan={handlers.onPlan}
        onApplyAndSchedule={handlers.onApplyAndSchedule}
        onApplyOnly={handlers.onApplyOnly}
        onCreateFixedTask={handlers.onCreateFixedTask}
        onOpenSchedule={() => navigate("/schedule")}
        scheduleResult={
          scheduleResult
            ? {
                explanation: scheduleResult.explanation,
                warnings: (scheduleResult.warnings ?? []).map((w) => ({
                  message: "message" in w ? String(w.message) : String(w),
                })),
              }
            : null
        }
        applying={applying}
        planLocked={aiErrorKind === "plan_locked"}
        aiError={aiError}
        onRetry={handlers.onRetry}
      />

      {/* ============ Cột phải — cây dự án ============ */}
      <ProjectTree
        project={
          project
            ? {
                id: project.id,
                name: project.name,
                clientName: project.client?.name ?? null,
                deadline: project.deadline ?? null,
              }
            : null
        }
        milestones={milestones}
        tasks={tasks}
        subtasksByTaskId={subtasksByTaskId}
        draftMilestoneTitles={draftMilestoneTitles}
        loading={treeLoading}
        error={treeError}
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

      {/* ============ Cảnh báo lỗi xếp lịch ============ */}
      {scheduleError && (
        <div className="aic-toastbar" role="alert">
          <span className="material-symbols-outlined">warning</span>
          <div>
            <strong>{scheduleErrorHint(scheduleError).title}</strong>
            <p>{scheduleErrorHint(scheduleError).hint}</p>
          </div>
          <button
            type="button"
            className="aic-btn aic-btn--tiny aic-btn--primary"
            disabled={scheduleBusy || newTaskIds.length === 0}
            onClick={handlers.onRetrySchedule}
          >
            {scheduleBusy ? (
              <>
                <span className="material-symbols-outlined aic-spin">
                  progress_activity
                </span>
                Đang xếp lịch…
              </>
            ) : (
              "Xếp lịch"
            )}
          </button>
        </div>
      )}

      <CenterToasts toasts={toasts} onDismiss={toast.dismiss} />
    </div>
  );
}
