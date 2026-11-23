import { useEffect } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { CenterToasts } from "../../components/Toast";
import type { ChatHistoryItemDto } from "../../lib/api-client";
import { ChatFrame } from "./ChatFrame";
import { ChatHistoryPanel } from "./ChatHistoryPanel";
import { ProjectTree } from "./ProjectTree";
import { useProjectChat } from "./useProjectChat";
import { scheduleErrorHint } from "./ai-chat-logic";
import "./copilot.css";

/* ===========================================================
 * Màn chat AI — 3 cột
 * Route: /copilot
 *
 * Spec: `ui-man-chat-ai.md` (BE gửi FE).
 *
 *   ┌──────────────┬────────────────────────┬──────────────┐
 *   │ LỊCH SỬ CHAT │ KHUNG CHAT              │ THÔNG TIN DỰ │
 *   │ 264px        │ co giãn (min ~560px)    │ ÁN 400px     │
 *   └──────────────┴────────────────────────┴──────────────┘
 *
 * Luồng chính: Bàn bạc → Lên kế hoạch → Áp dụng & xếp lịch → chat tiếp.
 *
 * Toàn bộ state + logic nằm trong hook `useProjectChat` (dùng chung với
 * trang `/projects/:projectId/chat`).
 *
 * Class prefix `.aic-*`.
 * =========================================================== */

export function CopilotPage() {
  const navigate = useNavigate();
  const [params] = useSearchParams();

  const chat = useProjectChat();
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
    newProjectOpen,
    setNewProjectOpen,
    newProjectName,
    setNewProjectName,
    newProjectDeadline,
    setNewProjectDeadline,
    newProjectError,
    creating,
    handleCreateProject,
    refreshKey,
    toasts,
    toast,
    handlers,
    openProject,
    openConversationById,
  } = chat;

  /* Mở conversation từ URL (?conversation=...). */
  useEffect(() => {
    const cid = params.get("conversation");
    if (!cid) return;
    let cancelled = false;
    void (async () => {
      await openConversationById(cid);
      if (cancelled) return;
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- chạy khi URL đổi
  }, [params]);

  /**
   * Mở 1 dòng lịch sử chat.
   *
   * - `scope = "project"` → mở chat của dự án đó.
   * - `scope = "task"`    → chat theo task đã được gộp vào chat dự án.
   */
  async function handleOpenHistory(item: ChatHistoryItemDto) {
    if (item.scope === "project" && item.project?.id) {
      await openProject(item.project.id);
      return;
    }
    if (item.scope === "task" && item.task?.id) {
      toast.info("Chat theo task đã được gộp vào chat dự án.");
      return;
    }
    await openConversationById(item.conversation_id);
  }

  return (
    <div className="aic">
      {/* ============ Cột trái ============ */}
      <ChatHistoryPanel
        activeId={conversationId}
        onOpen={(item) => void handleOpenHistory(item)}
        onImportFile={() => navigate("/projects/import")}
        onCreateProject={() => setNewProjectOpen(true)}
        refreshKey={refreshKey}
        hideImportButton
      />

      {/* ============ Cột giữa ============ */}
      <ChatFrame
        projectName={project?.name ?? "Màn chat AI"}
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
                  message:
                    "message" in w ? String(w.message) : String(w),
                })),
              }
            : null
        }
        applying={applying}
        planLocked={aiErrorKind === "plan_locked"}
        aiError={aiError}
        onRetry={handlers.onRetry}
      />

      {/* ============ Cột phải ============ */}
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
        onEditProject={() => navigate("/projects")}
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

      {/* ============ Modal tạo dự án ============ */}
      {newProjectOpen && (
        <div
          className="aic-modal"
          role="dialog"
          aria-modal="true"
          aria-label="Tạo dự án mới"
        >
          <div
            className="aic-modal__backdrop"
            onClick={() => setNewProjectOpen(false)}
          />
          <form className="aic-modal__card" onSubmit={handleCreateProject}>
            <h2 className="aic-modal__title">Dự án mới</h2>

            <label className="aic-field">
              <span className="aic-field__label">Tên dự án</span>
              <input
                className="aic-field__input"
                value={newProjectName}
                onChange={(e) => setNewProjectName(e.target.value)}
                placeholder="VD: Website bán hàng cho Lan Anh"
                autoFocus
              />
            </label>

            <label className="aic-field">
              <span className="aic-field__label">Hạn</span>
              <input
                type="date"
                className="aic-field__input"
                value={newProjectDeadline}
                onChange={(e) => setNewProjectDeadline(e.target.value)}
              />
            </label>

            {newProjectError && (
              <p className="aic-field__error" role="alert">
                {newProjectError}
              </p>
            )}

            <div className="aic-modal__actions">
              <button
                type="button"
                className="aic-btn aic-btn--secondary"
                onClick={() => setNewProjectOpen(false)}
              >
                Huỷ
              </button>
              <button
                type="submit"
                className="aic-btn aic-btn--primary"
                disabled={creating}
              >
                {creating ? "Đang tạo…" : "Tạo dự án"}
              </button>
            </div>
          </form>
        </div>
      )}

      <CenterToasts toasts={toasts} onDismiss={toast.dismiss} />
    </div>
  );
}
