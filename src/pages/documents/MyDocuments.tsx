import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import {
  listMyDocuments,
  type DocumentSourceType,
  type DocumentTag,
  type ProjectDocumentDto,
  type ProjectDocumentListItemDto,
} from "../../lib/api-client";
import { useCenterToast, CenterToasts } from "../../components/Toast";
import {
  DeleteDocumentModal,
  DocumentRow,
  EditDocumentModal,
} from "./document-shared";
import { TAG_META } from "./document-utils";
import { useDocumentActions } from "./useDocumentActions";
import "./documents.css";

/**
 * All my documents — tài liệu của tôi qua mọi dự án
 * ---------------------------------------------------------------
 * Route: /documents
 * API:   GET /api/documents?search=&tag=&sourceType=&projectId=
 *
 * Nguồn đặc tả: `PROJECT_DOCUMENTS_FE (1).md` (mục 9.B).
 *
 * Danh sách được **nhóm theo `projectName`**; bấm vào tên dự án để
 * chuyển tới dự án (có `projectId` trong dữ liệu).
 */
export function MyDocumentsPage() {
  const [toasts, toast] = useCenterToast();

  const [docs, setDocs] = useState<ProjectDocumentListItemDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [search, setSearch] = useState("");
  const [tag, setTag] = useState<DocumentTag | "">("");
  const [sourceType, setSourceType] = useState<DocumentSourceType | "">("");

  const load = useCallback(async () => {
    setLoading(true);
    const res = await listMyDocuments({
      search: search.trim() || undefined,
      tag: tag || undefined,
      sourceType: sourceType || undefined,
    });
    if (res.ok) {
      setDocs(res.data ?? []);
      setError(null);
    } else {
      setError(res.error ?? "Failed to load documents");
    }
    setLoading(false);
  }, [search, tag, sourceType]);

  /* Lần tải đầu tiên: setState chỉ chạy SAU await → không vi phạm
     react-hooks/set-state-in-effect. Lần nạp lại dùng `load()` ở event. */
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const res = await listMyDocuments({
        search: search.trim() || undefined,
        tag: tag || undefined,
        sourceType: sourceType || undefined,
      });
      if (cancelled) return;
      if (res.ok) {
        setDocs(res.data ?? []);
        setError(null);
      } else {
        setError(res.error ?? "Failed to load documents");
      }
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [search, tag, sourceType]);

  const actions = useDocumentActions(() => void load());

  /** Nhóm theo project, giữ thứ tự dự án xuất hiện trong danh sách. */
  const groups = useMemo(() => {
    const map = new Map<string, ProjectDocumentListItemDto[]>();
    const order: string[] = [];
    for (const d of docs) {
      const key = d.projectId || "unknown";
      const bucket = map.get(key);
      if (bucket) bucket.push(d);
      else {
        map.set(key, [d]);
        order.push(key);
      }
    }
    return order.map((key) => {
      const items = map.get(key) ?? [];
      return {
        projectId: key,
        projectName: items[0]?.projectName ?? "Unknown project",
        items,
      };
    });
  }, [docs]);

  function handleSaved(doc: ProjectDocumentDto) {
    setDocs((prev) => prev.map((d) => (d.id === doc.id ? { ...d, ...doc } : d)));
    actions.setEditing(null);
    toast.success("Document updated", doc.name || "Untitled document");
  }

  function handleDeleted(id: string) {
    setDocs((prev) => prev.filter((d) => d.id !== id));
    actions.setDeleting(null);
    toast.success("Document deleted");
  }

  const hasFilters = !!(search.trim() || tag || sourceType);

  return (
    <div className="doc-page">
      <header className="doc-head">
        <div className="doc-head-left">
          <div>
            <span className="doc-eyebrow">Document library</span>
            <h1 className="doc-title">All my documents</h1>
            <p className="doc-sub">
              Every file and link you have attached to your projects, grouped by
              project.
            </p>
          </div>
        </div>
      </header>

      <div className="doc-filters">
        <div className="doc-search">
          <span className="material-symbols-outlined" aria-hidden="true">
            search
          </span>
          <input
            type="search"
            className="doc-search-input"
            placeholder="Search by name…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            aria-label="Search documents by name"
          />
        </div>

        <select
          className="doc-filter-select"
          value={tag}
          onChange={(e) => setTag(e.target.value as DocumentTag | "")}
          aria-label="Filter by tag"
        >
          <option value="">All tags</option>
          {(Object.keys(TAG_META) as DocumentTag[]).map((t) => (
            <option key={t} value={t}>
              {TAG_META[t].label}
            </option>
          ))}
        </select>

        <select
          className="doc-filter-select"
          value={sourceType}
          onChange={(e) =>
            setSourceType(e.target.value as DocumentSourceType | "")
          }
          aria-label="Filter by type"
        >
          <option value="">Files &amp; links</option>
          <option value="File">Files only</option>
          <option value="Link">Links only</option>
        </select>

        {hasFilters && (
          <button
            type="button"
            className="doc-btn doc-btn--ghost doc-btn--sm"
            onClick={() => {
              setSearch("");
              setTag("");
              setSourceType("");
            }}
          >
            <span className="material-symbols-outlined">filter_alt_off</span>
            Clear
          </button>
        )}
      </div>

      {actions.downloadError && (
        <div className="doc-banner doc-banner--error" role="alert">
          <span className="material-symbols-outlined">error</span>
          <span>{actions.downloadError}</span>
          <button
            type="button"
            className="doc-banner-close"
            onClick={() => actions.setDownloadError(null)}
            aria-label="Dismiss"
          >
            <span className="material-symbols-outlined">close</span>
          </button>
        </div>
      )}

      {loading ? (
        <div className="doc-state" role="status">
          <span className="material-symbols-outlined doc-spin">progress_activity</span>
          <span>Loading documents…</span>
        </div>
      ) : error ? (
        <div className="doc-state doc-state--error" role="alert">
          <span className="material-symbols-outlined">error</span>
          <span>{error}</span>
          <button
            type="button"
            className="doc-btn doc-btn--ghost doc-btn--sm"
            onClick={() => void load()}
          >
            Retry
          </button>
        </div>
      ) : docs.length === 0 ? (
        <div className="doc-empty">
          <span className="material-symbols-outlined">folder_open</span>
          <p>
            {hasFilters
              ? "No documents match the current filters."
              : "You have not uploaded any document yet. Open a project and add files or links to get started."}
          </p>
          <Link to="/projects" className="doc-btn doc-btn--primary">
            <span className="material-symbols-outlined">space_dashboard</span>
            Go to projects
          </Link>
        </div>
      ) : (
        <div className="doc-groups">
          {groups.map((g) => (
            <section key={g.projectId} className="doc-group">
              <div className="doc-group-head">
                {g.projectId && g.projectId !== "unknown" ? (
                  <Link
                    to={`/projects/${g.projectId}`}
                    className="doc-group-name"
                  >
                    <span className="material-symbols-outlined">folder</span>
                    {g.projectName}
                    <span className="material-symbols-outlined doc-group-go">
                      arrow_forward
                    </span>
                  </Link>
                ) : (
                  <span className="doc-group-name doc-group-name--static">
                    <span className="material-symbols-outlined">folder</span>
                    {g.projectName}
                  </span>
                )}
                <span className="doc-group-count">
                  {g.items.length} document{g.items.length !== 1 ? "s" : ""}
                </span>
              </div>

              <ul className="doc-list">
                {g.items.map((d) => (
                  <DocumentRow
                    key={d.id}
                    doc={d}
                    busyId={actions.busyId}
                    onDownload={actions.handleDownload}
                    onEdit={actions.setEditing}
                    onDelete={actions.setDeleting}
                  />
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}

      {actions.editing && (
        <EditDocumentModal
          doc={actions.editing}
          onClose={() => actions.setEditing(null)}
          onSaved={handleSaved}
        />
      )}

      {actions.deleting && (
        <DeleteDocumentModal
          doc={actions.deleting}
          onClose={() => actions.setDeleting(null)}
          onDeleted={handleDeleted}
        />
      )}

      <CenterToasts toasts={toasts} onDismiss={toast.dismiss} />
    </div>
  );
}
