import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  type ProjectChatMessageDto,
  type ProjectDraftDto,
  type ProjectDraftMilestoneDto,
  type ProjectDraftTaskDto,
} from "../../lib/api-client";
import {
  fmtDuration,
  fmtDurationWords,
  fmtShortDate,
  stepOfState,
  type ChatScreenState,
} from "./ai-chat-logic";

/* ===========================================================
 * Cột giữa — Khung chat (spec mục 3)
 * ------------------------------------------------------------
 * 3.1 Header: tên dự án · thanh 3 bước · công tắc chế độ AI.
 * 3.2 Tin nhắn:
 *   - user  : bong bóng phải, nền xanh đậm; file đính kèm → chip tên.
 *   - AI discuss : bong bóng trái, `white-space: pre-line`, nút Sao chép,
 *                   checklist notes (Đã rõ / Nên hỏi / Rủi ro / Còn thiếu),
 *                   chip "Sẵn sàng lên kế hoạch" khi `ready_to_plan`.
 *   - AI question : bong bóng trái, chỉ `content`.
 *   - AI draft    : thẻ kế hoạch (mục 3.3).
 *   - AI đang trả lời : bong bóng 3 chấm nhấp nháy + chữ.
 *   - Kết quả xếp lịch : `schedule.explanation` + cảnh báo + nút
 *                   "Xem & duyệt lịch".
 * 3.4 Ô nhập: 📎 · ô nhắn (Enter gửi / Shift+Enter xuống dòng) ·
 *              Gửi · nút xanh (Lên kế hoạch / Cập nhật kế hoạch).
 *
 * Class prefix `.aic-*`.
 * =========================================================== */

/** Loại file được đính kèm (spec mục 3.4). */
export const ACCEPTED_FILE_EXT = ".pdf,.docx,.txt,.md,.xlsx,.csv";
/** Tối đa 3 file / tin. */
export const MAX_FILES_PER_MESSAGE = 3;
/** Tối đa 20 MB / file. */
export const MAX_FILE_BYTES = 20 * 1024 * 1024;

export interface PendingFile {
  file: File;
  id: string;
}

export interface ChatFrameProps {
  /** Tên dự án (header). */
  projectName: string;
  /** Trạng thái màn hình → quyết định bước sáng + nhãn nút xanh. */
  screenState: ChatScreenState;
  /** Có bản nháp chưa áp dụng không (→ nút xanh = "Cập nhật kế hoạch"). */
  hasDraft: boolean;
  /** Lịch sử tin nhắn. */
  messages: ProjectChatMessageDto[];
  /** Đang chờ AI trả lời. */
  waiting: boolean;
  /** Nội dung ô nhập. */
  draftText: string;
  onDraftTextChange: (v: string) => void;
  /** File đính kèm đang chọn. */
  files: PendingFile[];
  onFilesChange: (files: PendingFile[]) => void;
  /** Gửi tin (chế độ discuss). */
  onSend: () => void;
  /** Bấm nút xanh — lập kế hoạch. */
  onPlan: () => void;
  /** Bấm "Áp dụng & xếp lịch". */
  onApplyAndSchedule: (messageId: string) => void;
  /** Bấm "Chỉ áp dụng". */
  onApplyOnly: (messageId: string) => void;
  /** Bấm "Tạo task cố định" ở phần reminders của thẻ kế hoạch. */
  onCreateFixedTask: (reminder: string) => void;
  /** Mở màn đề xuất lịch. */
  onOpenSchedule: () => void;
  /** Kết quả xếp lịch gần nhất (để hiện bong bóng). */
  scheduleResult: {
    explanation: string | null;
    warnings: { message?: string }[];
  } | null;
  /** Đang apply (khoá nút). */
  applying: boolean;
  /** Chat AI bị khoá theo gói → ẩn nút lập kế hoạch. */
  planLocked: boolean;
  /** Lỗi AI (502) → bong bóng lỗi + nút Thử lại. */
  aiError: string | null;
  onRetry: () => void;
}

export function ChatFrame(props: ChatFrameProps) {
  const {
    projectName,
    screenState,
    hasDraft,
    messages,
    waiting,
    draftText,
    onDraftTextChange,
    files,
    onFilesChange,
    onSend,
    onPlan,
    onApplyAndSchedule,
    onApplyOnly,
    onCreateFixedTask,
    onOpenSchedule,
    scheduleResult,
    applying,
    planLocked,
    aiError,
    onRetry,
  } = props;

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [mode, setMode] = useState<"discuss" | "plan">("discuss");
  const navigate = useNavigate();

  /* Cuộn xuống cuối khi có tin mới. */
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages.length, waiting]);

  const step = stepOfState(screenState);
  const busy = waiting || applying;

  /* ---------------- Ô nhập ---------------- */

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    // Enter = gửi · Shift+Enter = xuống dòng
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      onSend();
    }
  }

  function handlePickFiles(e: React.ChangeEvent<HTMLInputElement>) {
    const picked = Array.from(e.target.files ?? []);
    e.target.value = "";
    const room = MAX_FILES_PER_MESSAGE - files.length;
    const accepted = picked
      .filter((f) => f.size <= MAX_FILE_BYTES)
      .slice(0, Math.max(0, room))
      .map((f) => ({ file: f, id: `${f.name}-${f.size}-${Math.random()}` }));
    onFilesChange([...files, ...accepted]);
  }

  function removeFile(id: string) {
    onFilesChange(files.filter((f) => f.id !== id));
  }

  const canSend = draftText.trim().length > 0 || files.length > 0;

  return (
    <section className="aic-mid" aria-label="Khung chat">
      {/* ============ Header ============ */}
      <header className="aic-mid__head">
        <div className="aic-mid__head-top">
          <h1 className="aic-mid__title">{projectName}</h1>

          {/* Công tắc chế độ AI */}
          <div
            className="aic-mode"
            role="group"
            aria-label="Chế độ AI"
          >
            <button
              type="button"
              className={`aic-mode__btn${mode === "discuss" ? " aic-mode__btn--on" : ""}`}
              aria-pressed={mode === "discuss"}
              onClick={() => setMode("discuss")}
            >
              Bàn bạc
            </button>
            <button
              type="button"
              className={`aic-mode__btn${mode === "plan" ? " aic-mode__btn--on" : ""}`}
              aria-pressed={mode === "plan"}
              disabled={planLocked || busy}
              onClick={() => {
                setMode("plan");
                onPlan();
              }}
            >
              Lên kế hoạch
            </button>
          </div>
        </div>

        {/* Thanh 3 bước */}
        <ol className="aic-steps" aria-label="Tiến trình">
          <Step n={1} label="Bàn bạc" active={step === 1} done={step > 1} />
          <Step n={2} label="Kế hoạch" active={step === 2} done={step > 2} />
          <Step n={3} label="Xếp lịch" active={step === 3} done={false} />
        </ol>
      </header>

      {/* ============ Tin nhắn ============ */}
      <div className="aic-mid__scroll" ref={scrollRef} aria-live="polite">
        {messages.length === 0 && !waiting && (
          <div className="aic-mid__empty">
            <span className="material-symbols-outlined">forum</span>
            <p>
              Dán brief của khách vào đây, hoặc bấm{" "}
              <strong>Lên kế hoạch</strong> để AI tự chia dự án thành cột
              mốc, việc và việc con.
            </p>
          </div>
        )}

        {messages.map((m) => (
          <MessageRow
            key={m.id}
            msg={m}
            applying={applying}
            onApplyAndSchedule={onApplyAndSchedule}
            onApplyOnly={onApplyOnly}
            onCreateFixedTask={onCreateFixedTask}
          />
        ))}

        {/* AI đang trả lời */}
        {waiting && (
          <div className="aic-msg aic-msg--ai">
            <div className="aic-bubble aic-bubble--ai">
              <span className="aic-typing" aria-label="AI đang trả lời">
                <i />
                <i />
                <i />
              </span>
              <span className="aic-typing__text">
                {mode === "plan"
                  ? "AI đang chia dự án thành cột mốc, việc và việc con…"
                  : "AI đang trả lời…"}
              </span>
            </div>
          </div>
        )}

        {/* Lỗi AI (502) */}
        {aiError && (
          <div className="aic-msg aic-msg--ai">
            <div className="aic-bubble aic-bubble--ai aic-bubble--error">
              <p className="aic-bubble__text">{aiError}</p>
              <button
                type="button"
                className="aic-btn aic-btn--ghost"
                onClick={onRetry}
              >
                <span className="material-symbols-outlined">refresh</span>
                Thử lại
              </button>
            </div>
          </div>
        )}

        {/* Kết quả xếp lịch */}
        {scheduleResult && (
          <div className="aic-msg aic-msg--ai">
            <div className="aic-bubble aic-bubble--ai aic-bubble--schedule">
              {scheduleResult.explanation && (
                <p className="aic-bubble__text">{scheduleResult.explanation}</p>
              )}
              {scheduleResult.warnings.length > 0 && (
                <div className="aic-warn">
                  <span className="material-symbols-outlined">warning</span>
                  <div>
                    {scheduleResult.warnings.map((w, i) => (
                      <p key={i} className="aic-warn__line">
                        {w.message ?? ""}
                      </p>
                    ))}
                  </div>
                </div>
              )}
              <button
                type="button"
                className="aic-btn aic-btn--ghost"
                onClick={onOpenSchedule}
              >
                <span className="material-symbols-outlined">event</span>
                Xem & duyệt lịch
              </button>
            </div>
          </div>
        )}
      </div>

      {/* ============ Ô nhập ============ */}
      <div className="aic-mid__composer">
        {planLocked ? (
          <div className="aic-locked">
            <span className="material-symbols-outlined">lock</span>
            <div>
              <strong>Chat AI có ở gói Pro/Premium</strong>
              <p>Nâng cấp gói để bàn bạc và lập kế hoạch với AI.</p>
            </div>
            <button
              type="button"
              className="aic-btn aic-btn--primary"
              onClick={() => navigate("/pricing")}
            >
              Nâng cấp
            </button>
          </div>
        ) : (
          <>
            {files.length > 0 && (
              <div className="aic-files">
                {files.map((f) => (
                  <span key={f.id} className="aic-file">
                    <span className="material-symbols-outlined">attach_file</span>
                    <span className="aic-file__name">{f.file.name}</span>
                    <button
                      type="button"
                      className="aic-file__x"
                      onClick={() => removeFile(f.id)}
                      aria-label={`Bỏ file ${f.file.name}`}
                    >
                      <span className="material-symbols-outlined">close</span>
                    </button>
                  </span>
                ))}
              </div>
            )}

            <div className="aic-compose">
              <input
                ref={fileRef}
                type="file"
                multiple
                accept={ACCEPTED_FILE_EXT}
                className="aic-visually-hidden"
                onChange={handlePickFiles}
                aria-hidden="true"
                tabIndex={-1}
              />
              <button
                type="button"
                className="aic-compose__attach"
                onClick={() => fileRef.current?.click()}
                disabled={busy || files.length >= MAX_FILES_PER_MESSAGE}
                aria-label="Đính kèm file"
                title="Đính kèm file (pdf, docx, txt, md, xlsx, csv)"
              >
                <span className="material-symbols-outlined">attach_file</span>
              </button>

              <label className="aic-visually-hidden" htmlFor="aic-msg-input">
                Nhập tin nhắn
              </label>
              <textarea
                id="aic-msg-input"
                className="aic-compose__input"
                placeholder="Hỏi, bàn bạc, nhờ viết email… (Enter để gửi)"
                value={draftText}
                onChange={(e) => onDraftTextChange(e.target.value)}
                onKeyDown={handleKeyDown}
                rows={1}
                disabled={busy}
              />

              <button
                type="button"
                className="aic-btn aic-btn--secondary aic-compose__send"
                onClick={onSend}
                disabled={!canSend || busy}
              >
                Gửi
              </button>

              <button
                type="button"
                className="aic-btn aic-btn--primary aic-compose__plan"
                onClick={onPlan}
                disabled={busy}
              >
                {waiting && screenState === "thinking"
                  ? "Đang lên kế hoạch…"
                  : hasDraft
                    ? "Cập nhật kế hoạch"
                    : "Lên kế hoạch"}
              </button>
            </div>

            <p className="aic-compose__hint">
              Ô chat = trò chuyện · Nút xanh = lập kế hoạch từ cả cuộc trò
              chuyện · 1 lượt AI mỗi lần gửi
            </p>
          </>
        )}
      </div>
    </section>
  );
}

/* ===========================================================
 * 1 bước trên thanh 3 bước
 * =========================================================== */
function Step({
  n,
  label,
  active,
  done,
}: {
  n: 1 | 2 | 3;
  label: string;
  active: boolean;
  done: boolean;
}) {
  return (
    <li
      className={`aic-step${active ? " aic-step--active" : ""}${done ? " aic-step--done" : ""}`}
      aria-current={active ? "step" : undefined}
    >
      <span className="aic-step__num">{n}</span>
      <span className="aic-step__label">{label}</span>
    </li>
  );
}

/* ===========================================================
 * 1 tin nhắn
 * =========================================================== */
function MessageRow({
  msg,
  applying,
  onApplyAndSchedule,
  onApplyOnly,
  onCreateFixedTask,
}: {
  msg: ProjectChatMessageDto;
  applying: boolean;
  onApplyAndSchedule: (messageId: string) => void;
  onApplyOnly: (messageId: string) => void;
  onCreateFixedTask: (reminder: string) => void;
}) {
  if (msg.role === "user") {
    return (
      <div className="aic-msg aic-msg--user">
        <div className="aic-bubble aic-bubble--user">
          {msg.content && <p className="aic-bubble__text">{msg.content}</p>}
        </div>
      </div>
    );
  }

  // --- Tin AI loại draft → thẻ kế hoạch ---
  if (msg.kind === "draft" && msg.draft) {
    return (
      <div className="aic-msg aic-msg--ai">
        <DraftCard
          draft={msg.draft}
          messageId={msg.id}
          applying={applying}
          onApplyAndSchedule={onApplyAndSchedule}
          onApplyOnly={onApplyOnly}
          onCreateFixedTask={onCreateFixedTask}
        />
      </div>
    );
  }

  // --- Tin AI bàn bạc / hỏi ---
  const notes = msg.notes ?? null;

  return (
    <div className="aic-msg aic-msg--ai">
      <div className="aic-bubble aic-bubble--ai">
        {msg.content && <p className="aic-bubble__text">{msg.content}</p>}

        {notes && <NotesCard notes={notes} />}

        {msg.ready_to_plan && (
          <span className="aic-chip aic-chip--ready">
            <span className="material-symbols-outlined">check_circle</span>
            Sẵn sàng lên kế hoạch
          </span>
        )}

        {msg.content && (
          <button
            type="button"
            className="aic-copy"
            onClick={() => void navigator.clipboard?.writeText(msg.content)}
            aria-label="Sao chép nội dung"
            title="Sao chép"
          >
            <span className="material-symbols-outlined">content_copy</span>
          </button>
        )}
      </div>
    </div>
  );
}

/* ===========================================================
 * Checklist notes của tin "bàn bạc"
 * =========================================================== */
function NotesCard({
  notes,
}: {
  notes: {
    clear?: string[] | null;
    questions?: string[] | null;
    risks?: string[] | null;
    missing?: string[] | null;
  };
}) {
  const groups: {
    key: "clear" | "questions" | "risks" | "missing";
    label: string;
    items: string[];
    tone: "ok" | "warn" | "muted";
  }[] = [
    { key: "clear", label: "Đã rõ", items: notes.clear ?? [], tone: "ok" },
    {
      key: "questions",
      label: "Nên hỏi",
      items: notes.questions ?? [],
      tone: "muted",
    },
    { key: "risks", label: "Rủi ro", items: notes.risks ?? [], tone: "warn" },
    {
      key: "missing",
      label: "Còn thiếu",
      items: notes.missing ?? [],
      tone: "muted",
    },
  ].filter((g) => g.items.length > 0) as {
    key: "clear" | "questions" | "risks" | "missing";
    label: string;
    items: string[];
    tone: "ok" | "warn" | "muted";
  }[];

  if (groups.length === 0) return null;

  return (
    <div className="aic-notes">
      {groups.map((g) => (
        <div key={g.key} className={`aic-notes__group aic-notes__group--${g.tone}`}>
          <span className="aic-notes__label">{g.label}</span>
          <ul>
            {g.items.map((it, i) => (
              <li key={i}>{it}</li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

/* ===========================================================
 * Thẻ kế hoạch (bản nháp) — spec mục 3.3
 * =========================================================== */
function DraftCard({
  draft,
  messageId,
  applying,
  onApplyAndSchedule,
  onApplyOnly,
  onCreateFixedTask,
}: {
  draft: ProjectDraftDto;
  messageId: string;
  applying: boolean;
  onApplyAndSchedule: (messageId: string) => void;
  onApplyOnly: (messageId: string) => void;
  onCreateFixedTask: (reminder: string) => void;
}) {
  const [openTaskKey, setOpenTaskKey] = useState<string | null>(null);

  const milestones = draft.milestones ?? [];
  const taskCount = milestones.reduce((sum, m) => sum + (m.tasks?.length ?? 0), 0);
  const subtaskCount = milestones.reduce(
    (sum, m) =>
      sum +
      (m.tasks ?? []).reduce((s, t) => s + (t.subtasks?.length ?? 0), 0),
    0,
  );
  const applied = draft.applied === true;

  return (
    <div className={`aic-draft${applied ? " aic-draft--applied" : ""}`}>
      {/* Dòng đầu */}
      <div className="aic-draft__head">
        <span className="material-symbols-outlined aic-draft__icon">
          account_tree
        </span>
        <span className="aic-draft__summary">
          Bản nháp: {milestones.length} cột mốc · {taskCount} việc ·{" "}
          {subtaskCount} việc con
        </span>
        {applied && (
          <span className="aic-chip aic-chip--applied">
            <span className="material-symbols-outlined">check</span>
            Đã áp dụng
          </span>
        )}
      </div>

      {/* Cột mốc */}
      <div className="aic-draft__body">
        {milestones.map((m) => (
          <DraftMilestone
            key={m.key ?? m.title}
            milestone={m}
            openTaskKey={openTaskKey}
            onToggleTask={(k) =>
              setOpenTaskKey((prev) => (prev === k ? null : k))
            }
          />
        ))}
      </div>

      {/* Số liệu */}
      {draft.numbers && (
        <div className="aic-draft__numbers">
          {draft.numbers.by_domain?.map((d) => (
            <span key={d.domain} className="aic-num">
              <span className="aic-num__k">{d.domain}</span>
              <span className="aic-num__v">
                {fmtDuration(d.estimated_minutes)}
              </span>
              {d.adjusted_minutes !== d.estimated_minutes && (
                <span className="aic-num__hint">
                  ≈ {fmtDuration(d.adjusted_minutes)}
                </span>
              )}
            </span>
          ))}
          {draft.numbers.total_estimated_minutes > 0 && (
            <span className="aic-num aic-num--total">
              <span className="aic-num__k">Tổng</span>
              <span className="aic-num__v">
                {fmtDurationWords(draft.numbers.total_estimated_minutes)}
              </span>
            </span>
          )}
        </div>
      )}

      {/* Cảnh báo */}
      {draft.warnings && draft.warnings.length > 0 && (
        <div className="aic-warn aic-warn--block">
          <span className="material-symbols-outlined">warning</span>
          <div>
            {draft.warnings.map((w, i) => (
              <p key={i} className="aic-warn__line">
                {w}
              </p>
            ))}
          </div>
        </div>
      )}

      {/* Nhắc việc (cuộc họp…) */}
      {draft.reminders && draft.reminders.length > 0 && (
        <div className="aic-reminders">
          {draft.reminders.map((r, i) => (
            <div key={i} className="aic-reminder">
              <span className="material-symbols-outlined">event</span>
              <span className="aic-reminder__text">{r}</span>
              <button
                type="button"
                className="aic-btn aic-btn--tiny"
                onClick={() => onCreateFixedTask(r)}
                title="Tạo task cố định"
              >
                Tạo task cố định
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Nút áp dụng */}
      {!applied && (
        <div className="aic-draft__actions">
          <button
            type="button"
            className="aic-btn aic-btn--primary"
            disabled={applying}
            onClick={() => onApplyAndSchedule(messageId)}
          >
            {applying ? (
              <>
                <span className="material-symbols-outlined aic-spin">
                  progress_activity
                </span>
                Đang tạo việc và xếp lịch…
              </>
            ) : (
              "Áp dụng & xếp lịch"
            )}
          </button>
          <button
            type="button"
            className="aic-btn aic-btn--secondary"
            disabled={applying}
            onClick={() => onApplyOnly(messageId)}
          >
            Chỉ áp dụng
          </button>
        </div>
      )}
    </div>
  );
}

/* ===========================================================
 * 1 cột mốc trong thẻ kế hoạch
 * =========================================================== */
function DraftMilestone({
  milestone,
  openTaskKey,
  onToggleTask,
}: {
  milestone: ProjectDraftMilestoneDto;
  openTaskKey: string | null;
  onToggleTask: (key: string) => void;
}) {
  return (
    <section className="aic-dms">
      <header className="aic-dms__head">
        <span className="aic-dms__title">{milestone.title}</span>
        <span className="aic-dms__deadline">
          hạn {fmtShortDate(milestone.deadline)}
        </span>
        <span className="aic-dms__count">
          {milestone.tasks?.length ?? 0} việc
        </span>
      </header>

      {milestone.reason && (
        <p className="aic-dms__reason">Vì sao: {milestone.reason}</p>
      )}

      <ul className="aic-dms__tasks">
        {(milestone.tasks ?? []).map((t, i) => (
          <DraftTask
            key={t.key ?? `${t.title}-${i}`}
            task={t}
            open={openTaskKey === (t.key ?? `${t.title}-${i}`)}
            onToggle={() => onToggleTask(t.key ?? `${t.title}-${i}`)}
          />
        ))}
      </ul>
    </section>
  );
}

/* ===========================================================
 * 1 việc trong thẻ kế hoạch (bấm → mở danh sách việc con)
 * =========================================================== */
function DraftTask({
  task,
  open,
  onToggle,
}: {
  task: ProjectDraftTaskDto;
  open: boolean;
  onToggle: () => void;
}) {
  const subtasks = task.subtasks ?? [];

  return (
    <li className="aic-dtask">
      <button
        type="button"
        className="aic-dtask__row"
        onClick={onToggle}
        aria-expanded={open}
      >
        <span className="material-symbols-outlined aic-dtask__caret">
          {open ? "expand_more" : "chevron_right"}
        </span>
        <span className="aic-dtask__title">{task.title}</span>
        <span className="aic-dtask__meta">
          {fmtDuration(task.estimated_minutes)}
          {subtasks.length > 0 && ` · ${subtasks.length} việc con`}
        </span>
      </button>

      {open && subtasks.length > 0 && (
        <ul className="aic-dsubs">
          {subtasks.map((s, i) => (
            <li key={i} className="aic-dsub">
              <span className="aic-dsub__title">{s.title}</span>
              <span className="aic-dsub__min">{fmtDuration(s.estimated_minutes)}</span>
              {s.reason && (
                <span className="aic-dsub__reason">{s.reason}</span>
              )}
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}
