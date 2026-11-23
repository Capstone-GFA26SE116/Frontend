import { useEffect, useMemo, useState } from "react";
import {
  listChatHistory,
  type ChatHistoryItemDto,
} from "../../lib/api-client";
import {
  fmtClock,
  groupOf,
  HISTORY_GROUP_ORDER,
  highlightParts,
  type HistoryGroup,
} from "./ai-chat-logic";

/* ===========================================================
 * Cột trái — Lịch sử chat (spec mục 2)
 * ------------------------------------------------------------
 * - Ô tìm: gõ xong ~300 ms mới gọi API.
 * - Nhóm: "Hôm nay" / "Tuần này" / "Cũ hơn" — FE tự chia theo
 *   `last_message.created_at`.
 * - 1 dòng: tên dự án (đậm nếu đang mở) · giờ tin cuối · preview.
 *   - preview của AI → tiền tố "AI: …", của user → "Bạn: …"
 *   - `scope = task` → chip xanh dương "Task · {tên}"
 *   - `applied = true` → chip xanh lá "Đã áp dụng"
 * - Khớp trong tin → hiện `match.snippet`, tô vàng; bấm → cuộn tới tin.
 * - `has_more` → nút "Tải thêm" (offset += 20).
 * - Không có nút "Chat mới" — mỗi dự án đúng 1 cuộc chat.
 * - Chân cột trái: nút "Import file" + "Dự án mới" (mỗi nút ẩn/hiện
 *   độc lập qua `hideImportButton` / `hideCreateButton`).
 *
 * Class prefix `.aic-*`.
 * =========================================================== */

const PAGE_SIZE = 20;
/** Debounce ô tìm kiếm (ms). */
const SEARCH_DEBOUNCE = 300;

const GROUP_LABEL: Record<HistoryGroup, string> = {
  today: "Hôm nay",
  week: "Tuần này",
  older: "Cũ hơn",
};

export interface ChatHistoryPanelProps {
  /** Conversation đang mở — dòng này hiện đậm. */
  activeId: string | null;
  /** Mở 1 cuộc chat. */
  onOpen: (item: ChatHistoryItemDto) => void;
  /** Nút "Import file" (mở trang nhập dự án từ file). */
  onImportFile: () => void;
  /** Nút "+ Dự án mới". */
  onCreateProject: () => void;
  /** Tải lại danh sách (sau khi tạo dự án / import). */
  refreshKey: string | number;
  /**
   * Chỉ hiện chat của 1 dự án (dùng ở trang `/projects/:id/chat`).
   *
   * Lọc ở client từ `GET /chat/conversations` — không cần đổi API BE.
   * `null` → hiện toàn bộ lịch sử (trang `/copilot`).
   */
  projectIdFilter?: string | null;
  /** Ẩn 2 nút dưới cùng (import Excel / tạo dự án). */
  hideFooter?: boolean;
  /** Ẩn riêng nút "Import file" (vẫn hiện nút "Dự án mới"). */
  hideImportButton?: boolean;
  /** Ẩn riêng nút "Dự án mới" (vẫn hiện nút "Import file"). */
  hideCreateButton?: boolean;
  /** Nhắn khi không có chat nào (mặc định: gợi ý tạo dự án). */
  emptyMessage?: string;
}

export function ChatHistoryPanel({
  activeId,
  onOpen,
  onImportFile,
  onCreateProject,
  refreshKey,
  projectIdFilter = null,
  hideFooter = false,
  hideImportButton = false,
  hideCreateButton = false,
  emptyMessage,
}: ChatHistoryPanelProps) {
  const [items, setItems] = useState<ChatHistoryItemDto[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /** Ô tìm kiếm đang gõ. */
  const [input, setInput] = useState("");
  /** Query đã áp dụng (sau debounce). */
  const [query, setQuery] = useState("");

  /* ---------- Debounce 300ms ---------- */
  useEffect(() => {
    const t = window.setTimeout(() => {
      setQuery(input.trim().slice(0, 100));
    }, SEARCH_DEBOUNCE);
    return () => window.clearTimeout(t);
  }, [input]);

  /* ---------- Lọc theo dự án (nếu có) ---------- */
  /** Chỉ giữ chat thuộc dự án đang xem. */
  const filterByProject = useMemo(
    () =>
      projectIdFilter
        ? (list: ChatHistoryItemDto[]) =>
            list.filter(
              (i) => i.scope === "project" && i.project?.id === projectIdFilter,
            )
        : (list: ChatHistoryItemDto[]) => list,
    [projectIdFilter],
  );

  /* ---------- Load trang đầu / theo query ---------- */
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      setLoading(true);
      setError(null);
      const res = await listChatHistory({
        q: query || undefined,
        limit: PAGE_SIZE,
        offset: 0,
      });
      if (cancelled) return;
      if (!res.ok) {
        setError(res.error);
        setLoading(false);
        return;
      }
      setItems(filterByProject(res.data.items));
      setHasMore(res.data.has_more);
      setOffset(PAGE_SIZE);
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [query, refreshKey, filterByProject]);

  /* ---------- Load thêm ---------- */
  async function loadMore() {
    if (loadingMore || !hasMore) return;
    setLoadingMore(true);
    const res = await listChatHistory({
      q: query || undefined,
      limit: PAGE_SIZE,
      offset,
    });
    setLoadingMore(false);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    setItems((prev) => [...prev, ...filterByProject(res.data.items)]);
    setHasMore(res.data.has_more);
    setOffset((o) => o + PAGE_SIZE);
  }

  /**
   * Khi đang lọc theo dự án mà trang vừa tải ra 0 mục, tự tải thêm cho tới khi
   * tìm thấy chat của dự án đó (tránh hiện "rỗng" giả).
   *
   * `setState` chỉ chạy sau `await` → không vi phạm
   * react-hooks/set-state-in-effect.
   */
  useEffect(() => {
    if (!projectIdFilter) return;
    if (loading || loadingMore) return;
    if (items.length > 0) return;
    if (!hasMore) return;

    let cancelled = false;
    void (async () => {
      setLoadingMore(true);
      const res = await listChatHistory({
        q: query || undefined,
        limit: PAGE_SIZE,
        offset,
      });
      if (cancelled) return;
      setLoadingMore(false);
      if (!res.ok) {
        setError(res.error);
        return;
      }
      setItems((prev) => [...prev, ...filterByProject(res.data.items)]);
      setHasMore(res.data.has_more);
      setOffset((o) => o + PAGE_SIZE);
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- chạy khi trạng thái đổi
  }, [projectIdFilter, loading, loadingMore, items.length, hasMore, query, offset]);

  /* ---------- Chia nhóm ---------- */
  const groups = useMemo(() => {
    const map = new Map<HistoryGroup, ChatHistoryItemDto[]>();
    for (const g of HISTORY_GROUP_ORDER) map.set(g, []);
    for (const it of items) {
      const g = groupOf(it.last_message?.created_at);
      map.get(g)?.push(it);
    }
    return map;
  }, [items]);

  const total = items.length;

  return (
    <aside className="aic-left" aria-label="Lịch sử chat">
      {/* ============ Ô tìm kiếm ============ */}
      <div className="aic-left__search">
        <span className="material-symbols-outlined aic-left__search-icon">
          search
        </span>
        <input
          type="search"
          className="aic-left__search-input"
          placeholder="Tìm trong tin nhắn, dự án…"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          maxLength={100}
          aria-label="Tìm trong lịch sử chat"
        />
        {input && (
          <button
            type="button"
            className="aic-left__search-clear"
            onClick={() => setInput("")}
            aria-label="Xoá tìm kiếm"
          >
            <span className="material-symbols-outlined">close</span>
          </button>
        )}
      </div>

      {/* ============ Danh sách ============ */}
      <div className="aic-left__list" role="list">
        {loading ? (
          <div className="aic-left__skeleton" role="status" aria-label="Đang tải lịch sử chat">
            {Array.from({ length: 5 }).map((_, i) => (
              <div key={i} className="aic-left__skel-row">
                <span className="aic-left__skel-line aic-left__skel-line--title" />
                <span className="aic-left__skel-line" />
              </div>
            ))}
          </div>
        ) : error ? (
          <div className="aic-left__state" role="alert">
            <span className="material-symbols-outlined">error</span>
            <p>{error}</p>
          </div>
        ) : total === 0 ? (
          <div className="aic-left__state">
            <span className="material-symbols-outlined">forum</span>
            <p>
              {emptyMessage ??
                (query
                  ? `Không tìm thấy chat nào khớp "${query}".`
                  : "Bạn chưa có cuộc chat nào. Tạo dự án để bắt đầu.")}
            </p>
          </div>
        ) : (
          <>
            {HISTORY_GROUP_ORDER.map((g) => {
              const list = groups.get(g) ?? [];
              if (list.length === 0) return null;
              return (
                <section key={g} className="aic-left__group">
                  <h3 className="aic-left__group-title">{GROUP_LABEL[g]}</h3>
                  <ul className="aic-left__items">
                    {list.map((it) => (
                      <HistoryRow
                        key={`${it.scope}-${it.conversation_id}`}
                        item={it}
                        active={it.conversation_id === activeId}
                        query={query}
                        onOpen={onOpen}
                      />
                    ))}
                  </ul>
                </section>
              );
            })}

            {hasMore && (
              <button
                type="button"
                className="aic-left__more"
                onClick={() => void loadMore()}
                disabled={loadingMore}
              >
                {loadingMore ? (
                  <>
                    <span className="material-symbols-outlined aic-spin">
                      progress_activity
                    </span>
                    Đang tải…
                  </>
                ) : (
                  "Tải thêm"
                )}
              </button>
            )}
          </>
        )}
      </div>

      {/* ============ Nút dưới cùng ============ */}
      {!hideFooter && (
        <div className="aic-left__foot">
          {!hideImportButton && (
            <button
              type="button"
              className="aic-left__foot-btn"
              onClick={onImportFile}
            >
              <span className="material-symbols-outlined">upload_file</span>
              Import file
            </button>
          )}
          {!hideCreateButton && (
            <button
              type="button"
              className="aic-left__foot-btn aic-left__foot-btn--primary"
              onClick={onCreateProject}
            >
              <span className="material-symbols-outlined">add</span>
              Dự án mới
            </button>
          )}
        </div>
      )}
    </aside>
  );
}

/* ===========================================================
 * 1 dòng chat trong lịch sử
 * =========================================================== */
function HistoryRow({
  item,
  active,
  query,
  onOpen,
}: {
  item: ChatHistoryItemDto;
  active: boolean;
  query: string;
  onOpen: (item: ChatHistoryItemDto) => void;
}) {
  /** Tên hiển thị chính: dự án (scope=project) hoặc task (scope=task). */
  const title =
    item.scope === "task"
      ? (item.task?.name ?? "Chat task")
      : (item.project?.name ?? "Dự án");

  /** Preview: có khớp tìm kiếm thì dùng `match.snippet`. */
  const previewText = item.match?.snippet ?? item.last_message?.preview ?? "";
  const previewPrefix =
    item.last_message?.role === "assistant"
      ? "AI: "
      : item.last_message?.role === "user"
        ? "Bạn: "
        : "";

  return (
    <li>
      <button
        type="button"
        className={`aic-hist${active ? " aic-hist--active" : ""}`}
        onClick={() => onOpen(item)}
        aria-current={active ? "true" : undefined}
      >
        <span className="aic-hist__top">
          <span className="aic-hist__title">{title}</span>
          <span className="aic-hist__time">
            {fmtClock(item.last_message?.created_at)}
          </span>
        </span>

        <span className="aic-hist__preview">
          {previewPrefix}
          {highlightParts(previewText, query).map((p, i) =>
            p.hit ? (
              <mark key={i} className="aic-mark">
                {p.text}
              </mark>
            ) : (
              <span key={i}>{p.text}</span>
            ),
          )}
        </span>

        {(item.scope === "task" || item.applied) && (
          <span className="aic-hist__chips">
            {item.scope === "task" && (
              <span className="aic-chip aic-chip--task">
                Task · {item.task?.name ?? ""}
              </span>
            )}
            {item.applied && (
              <span className="aic-chip aic-chip--applied">Đã áp dụng</span>
            )}
          </span>
        )}
      </button>
    </li>
  );
}
