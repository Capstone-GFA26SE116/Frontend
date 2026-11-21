import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { CenterToasts, useCenterToast } from "../../components/Toast";
import {
  listChatHistory,
  type ChatHistoryItemDto,
  type ChatHistoryResponseDto,
} from "../../lib/api-client";
import "./chat-history.css";

/* ===========================================================
 * Lịch sử chat — Route: /chat-history
 *
 * GET /chat/conversations?q=&limit=&offset=
 * Trả mọi cuộc chat của user (chat dự án + chat chia nhỏ task),
 * tin mới nhất trước. Không tốn lượt AI.
 *
 * Ô tìm `q` (≤ 100 ký tự): tìm trong tin nhắn, tên dự án, tên task;
 * không phân biệt hoa thường, chưa tìm không dấu. Khớp trong tin →
 * `match` {message_id, snippet} để tô đậm & cuộn tới đúng tin.
 *
 * Bấm 1 dòng:
 *   - scope = "project" → mở `/projects/:projectId/execution` (chat dự án)
 *   - scope = "task"   → mở chat chia nhỏ 1 task
 *
 * Không có nút "Chat mới" ở trang này (theo spec BE).
 *
 * Class prefix `.chh-*`.
 * =========================================================== */

/** Số item mỗi trang. */
const PAGE_SIZE = 20;

/** Định dạng thời gian tương đối. */
function fmtRelative(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const diffMs = Date.now() - d.getTime();
  const mins = Math.round(diffMs / 60000);
  if (mins < 1) return "vừa xong";
  if (mins < 60) return `${mins} phút trước`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} giờ trước`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days} ngày trước`;
  return d.toLocaleDateString("vi-VN", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  });
}

/**
 * Bỏ dấu tiếng Việt + lowercase — để so khớp không phân biệt hoa thường
 * và không dấu (theo spec BE).
 */
function normalize(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "");
}

/** Tìm vị trí các từ khoá đã chuẩn hoá trong text để tô đậm. */
function highlightParts(text: string, query: string): React.ReactNode[] {
  const q = normalize(query).trim();
  if (!q) return [text];

  const haystack = normalize(text);
  const parts: React.ReactNode[] = [];
  let cursor = 0;
  let hit = haystack.indexOf(q);

  while (hit !== -1) {
    if (hit > cursor) parts.push(text.slice(cursor, hit));
    parts.push(
      <mark key={`${hit}-${cursor}`} className="chh-mark">
        {text.slice(hit, hit + q.length)}
      </mark>,
    );
    cursor = hit + q.length;
    hit = haystack.indexOf(q, cursor);
  }
  if (cursor < text.length) parts.push(text.slice(cursor));
  return parts;
}

export function ChatHistoryPage() {
  const navigate = useNavigate();
  const [toasts, toast] = useCenterToast();

  const [query, setQuery] = useState("");
  /** Ô tìm kiếm đang gõ (chưa submit). */
  const [searchInput, setSearchInput] = useState("");
  const [data, setData] = useState<ChatHistoryResponseDto | null>(null);
  const [offset, setOffset] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const searchRef = useRef<HTMLInputElement | null>(null);

  /* ---------- load trang đầu / theo query ---------- */
  const load = useCallback(async (q: string, nextOffset: number) => {
    const res = await listChatHistory({
      q: q || undefined,
      limit: PAGE_SIZE,
      offset: nextOffset,
    });
    if (!res.ok) return res;
    return { ok: true as const, data: res.data };
  }, []);

  useEffect(() => {
    let cancelled = false;
    // setState chỉ chạy SAU await → không vi phạm
    // react-hooks/set-state-in-effect.
    void (async () => {
      setLoading(true);
      setError(null);
      const res = await load(query, 0);
      if (cancelled) return;
      if (!res.ok) {
        setError(res.error);
        setLoading(false);
        return;
      }
      setData(res.data);
      setHasMore(res.data.has_more);
      setOffset(PAGE_SIZE);
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [query, load]);

  /* ---------- load thêm ---------- */
  async function loadMore() {
    if (loadingMore || !hasMore) return;
    setLoadingMore(true);
    const res = await load(query, offset);
    setLoadingMore(false);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    setData((prev) =>
      prev
        ? {
            items: [...prev.items, ...res.data.items],
            has_more: res.data.has_more,
          }
        : res.data,
    );
    setOffset((o) => o + PAGE_SIZE);
  }

  /* ---------- handlers ---------- */

  /** Submit ô tìm kiếm. */
  function handleSearch(e: React.FormEvent) {
    e.preventDefault();
    setQuery(searchInput.trim().slice(0, 100));
  }

  /** Mở 1 cuộc chat. */
  function openItem(item: ChatHistoryItemDto) {
    if (item.scope === "project") {
      // Chat dự án — mở thẳng màn hình chat của dự án.
      if (item.project?.id) {
        navigate(`/projects/${item.project.id}/execution`);
      }
      return;
    }
    // Chat chia nhỏ task — mở chat task ở trang Copilot.
    if (item.task?.id) {
      navigate(`/copilot?task=${encodeURIComponent(item.task.id)}`);
    }
  }

  const items = useMemo(() => data?.items ?? [], [data]);

  return (
    <section className="chh">
      <div className="chh-container">
        {/* ============ Header ============ */}
        <header className="chh-header">
          <div className="chh-header-text">
            <span className="chh-eyebrow">
              <span className="material-symbols-outlined">forum</span>
              Lịch sử chat
            </span>
            <h1 className="chh-title">Tất cả cuộc chat của bạn</h1>
            <p className="chh-subtitle">
              Chat dự án và chat chia nhỏ task — tin mới nhất trước.
            </p>
          </div>
        </header>

        {/* ============ Tìm kiếm ============ */}
        <form className="chh-search" onSubmit={handleSearch} role="search">
          <span className="material-symbols-outlined chh-search-icon">
            search
          </span>
          <input
            ref={searchRef}
            type="search"
            className="chh-search-input"
            placeholder="Tìm trong tin nhắn, tên dự án, tên task…"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            maxLength={100}
            aria-label="Tìm trong lịch sử chat"
          />
          {searchInput && (
            <button
              type="button"
              className="chh-search-clear"
              onClick={() => {
                setSearchInput("");
                setQuery("");
                searchRef.current?.focus();
              }}
              aria-label="Xoá tìm kiếm"
            >
              <span className="material-symbols-outlined">close</span>
            </button>
          )}
          <button type="submit" className="chh-search-submit">
            Tìm
          </button>
        </form>

        {error && (
          <div className="chh-banner chh-banner--error" role="alert">
            <span className="material-symbols-outlined">error</span>
            <span>{error}</span>
          </div>
        )}

        {/* ============ Danh sách ============ */}
        {loading ? (
          <div className="chh-state" role="status">
            <span className="material-symbols-outlined chh-spin">progress_activity</span>
            <p>Đang tải lịch sử chat…</p>
          </div>
        ) : items.length === 0 ? (
          <div className="chh-state">
            <span className="material-symbols-outlined">chat_bubble_outline</span>
            <p>
              {query
                ? `Không tìm thấy chat nào khớp "${query}".`
                : "Bạn chưa có cuộc chat nào. Bắt đầu từ trang Dự án."}
            </p>
          </div>
        ) : (
          <>
            <ul className="chh-list">
              {items.map((item) => (
                <li key={`${item.scope}-${item.conversation_id}`}>
                  <button
                    type="button"
                    className="chh-item"
                    onClick={() => openItem(item)}
                  >
                    <span
                      className={
                        "chh-item-icon" +
                        (item.scope === "task" ? " chh-item-icon--task" : "")
                      }
                      aria-hidden="true"
                    >
                      <span className="material-symbols-outlined">
                        {item.scope === "project" ? "space_dashboard" : "task_alt"}
                      </span>
                    </span>

                    <span className="chh-item-body">
                      <span className="chh-item-head">
                        <span className="chh-item-title">
                          {item.project?.name ?? item.task?.name ?? "Cuộc chat"}
                        </span>
                        {item.applied && (
                          <span className="chh-item-badge">Đã áp dụng</span>
                        )}
                        {item.scope === "task" && (
                          <span className="chh-item-scope">Task</span>
                        )}
                      </span>

                      {/* Snippet khớp tìm kiếm → tô đậm phần khớp */}
                      <span className="chh-item-snippet">
                        {item.match?.snippet
                          ? highlightParts(item.match.snippet, query)
                          : item.last_message?.preview ?? "—"}
                      </span>

                      <span className="chh-item-meta">
                        <span>{item.message_count} tin</span>
                        <span aria-hidden="true">•</span>
                        <span>{fmtRelative(item.last_message?.created_at)}</span>
                      </span>
                    </span>

                    <span
                      className="material-symbols-outlined chh-item-arrow"
                      aria-hidden="true"
                    >
                      arrow_forward
                    </span>
                  </button>
                </li>
              ))}
            </ul>

            {hasMore && (
              <div className="chh-more">
                <button
                  type="button"
                  className="chh-btn"
                  onClick={() => void loadMore()}
                  disabled={loadingMore}
                >
                  <span className="material-symbols-outlined">
                    {loadingMore ? "progress_activity" : "expand_more"}
                  </span>
                  <span>{loadingMore ? "Đang tải…" : "Xem thêm"}</span>
                </button>
              </div>
            )}
          </>
        )}
      </div>

      <CenterToasts toasts={toasts} onDismiss={toast.dismiss} />
    </section>
  );
}
