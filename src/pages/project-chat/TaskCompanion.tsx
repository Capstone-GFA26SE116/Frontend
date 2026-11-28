import { useEffect, useRef, useState } from "react";
import {
  applyTaskChat,
  getTaskChat,
  sendTaskMessage,
  type AiMessage,
  type DraftResponse,
  type TaskDto,
} from "../../lib/api-client";
import { fmtDurationWords } from "../copilot/ai-chat-logic";

export function TaskCompanion({
  task, initialQuestion, onClose, onSaved,
}: {
  task: TaskDto;
  initialQuestion: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [messages, setMessages] = useState<AiMessage[]>([]);
  const [draft, setDraft] = useState<DraftResponse | null>(null);
  const [question, setQuestion] = useState(initialQuestion);
  const [excluded, setExcluded] = useState<number[]>([]);
  const [busy, setBusy] = useState(true);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");
  const active = useRef(true);

  useEffect(() => {
    let current = true;
    active.current = true;
    void getTaskChat(task.id).then((result) => {
      if (!current) return;
      setBusy(false);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setMessages(result.data.messages);
      setDraft(result.data.latest_draft);
      setSaved(result.data.applied);
    });
    return () => { current = false; active.current = false; };
  }, [task.id]);

  const selected = draft?.subtasks.filter((_, index) => !excluded.includes(index)) ?? [];

  async function send() {
    if (busy || saved || !question.trim()) return;
    setBusy(true);
    setError("");
    const result = await sendTaskMessage(task.id, question.trim());
    if (!active.current) return;
    setBusy(false);
    if (!result.ok) {
      setError(result.status === 502
        ? "AI chưa tạo được đề xuất. Nội dung bạn vừa nhập vẫn còn. Bạn có thể thử lại hoặc thêm việc con từ cây dự án."
        : result.error);
      return;
    }
    setQuestion("");
    setMessages((previous) => [...previous, result.data.user_message, result.data.ai_message]);
    if (result.data.ai_message.draft) {
      setDraft(result.data.ai_message.draft);
      setExcluded([]);
    }
  }

  async function save() {
    if (!draft || busy || saved || !selected.length) return;
    setBusy(true);
    setError("");
    const result = await applyTaskChat(task.id, draft.message_id,
      selected.map(({ title, estimated_minutes }) => ({ title, estimated_minutes })));
    if (!active.current) return;
    setBusy(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setSaved(true);
    onSaved();
  }

  return (
    <section className="pc-panel" aria-label={`Việc con của ${task.title}`}>
      <div className="pc-actions pc-panel-title">
        <strong>Việc con của {task.title}</strong>
        <button type="button" className="aic-btn aic-btn--ghost" disabled={busy} onClick={onClose}>Đóng</button>
      </div>
      {messages.map((message) => message.content && <p className="pc-message" key={message.id}>
        <strong>{message.role === "user" ? "Bạn" : "AI"}</strong> · {message.content}
      </p>)}
      {draft && !saved && <div className="pc-draft-group">
        {draft.subtasks.map((subtask, index) => <div className="pc-draft-item" key={index}>
          <input type="checkbox" checked={!excluded.includes(index)} disabled={busy}
            aria-label={`Lưu ${subtask.title}`}
            onChange={() => setExcluded((items) => items.includes(index)
              ? items.filter((item) => item !== index)
              : [...items, index])} />
          <details>
            <summary>{subtask.title}</summary>
            <p>{fmtDurationWords(subtask.estimated_minutes)}{subtask.reason && ` · ${subtask.reason}`}</p>
          </details>
        </div>)}
        <button type="button" className="aic-btn aic-btn--primary" disabled={busy || !selected.length} onClick={() => void save()}>
          Lưu {selected.length} việc con
        </button>
      </div>}
      {saved ? <p role="status">Đã lưu việc con vào “{task.title}”.</p> :
        <form className="pc-actions" onSubmit={(event) => { event.preventDefault(); void send(); }}>
          <textarea className="aic-compose__input" aria-label={`Hỏi về ${task.title}`}
            value={question} disabled={busy} maxLength={2000}
            placeholder="Nhắn để chia nhỏ hoặc sửa bản nháp…"
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault();
                void send();
              }
            }}
            onChange={(event) => setQuestion(event.target.value)} />
          <button type="submit" className="aic-btn aic-btn--secondary" disabled={busy || !question.trim()}>Gửi</button>
        </form>}
      {busy && <p role="status">Đang xử lý…</p>}
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
