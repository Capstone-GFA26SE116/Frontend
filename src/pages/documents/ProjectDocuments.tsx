import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import {
  listProjectDocuments,
  type DocumentSourceType,
  type DocumentTag,
  type ProjectDocumentDto,
} from "../../lib/api-client";
import { useCenterToast, CenterToasts } from "../../components/Toast";
import {
  AddDocumentModal,
  DeleteDocumentModal,
  DocumentRow,
  EditDocumentModal,
} from "./document-shared";
import { TAG_META } from "./document-utils";
import { useDocumentActions } from "./useDocumentActions";
import "./documents.css";

/**
 * Project documents — kho tài liệu của 1 dự án
 * ---------------------------------------------------------------
 * Route: /projects/:projectId/documents
 * API:   GET /api/projects/{projectId}/documents?search=&tag=
 *
 * Nguồn đặc tả: `PROJECT_DOCUMENTS_FE (1).md` (mục 9.A).
 *
 * Mỗi dòng: icon theo `sourceType`, tên, tag (nhãn màu), dung lượng
 * (với File), ngày `uploadedAt`, và các nút Tải về / Mở liên kết,
 * Đổi tên-tag, Xoá (có hộp thoại xác nhận).
 */
export function ProjectDocumentsPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const [toasts, toast] = useCenterToast();

  const [docs, setDocs] = useState<ProjectDocumentDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Bộ lọc (đều là query string tuỳ chọn của BE).
  const [search, setSearch] = useState("");
  const [tag, setTag] = useState<DocumentTag | "">("");
  const [sourceType, setSourceType] = useState<DocumentSourceType | "">("");

  const [showAdd, setShowAdd] = useState(false);

  const load = useCallback(async () => {
    if (!projectId) {
      setLoading(false);
      return;
    }
    setLoading(true);
    const res = await listProjectDocuments(projectId, {
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
  }, [projectId, search, tag, sourceType]);

  /* Lần tải đầu tiên: setState chỉ chạy SAU await → không vi phạm
     react-hooks/set-state-in-effect, và không render 2 lần liên tiếp.
     Lần nạp lại (bấm Retry / đổi bộ lọc) dùng `load()` ở event handler. */
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      if (!projectId) {
        if (!cancelled) setLoading(false);
        return;
      }
      const res = await listProjectDocuments(projectId, {
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
  }, [projectId, search, tag, sourceType]);

  const actions = useDocumentActions(() => void load());

  function handleCreated(doc: ProjectDocumentDto) {
    setShowAdd(false);
    // Thêm vào đầu danh sách cho phản hồi tức thì, không cần chờ reload.
    setDocs((prev) => [doc, ...prev]);
    toast.success("Document added", doc.name || "Untitled document");
  }

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
          <Link
            to={`/projects/${projectId}`}
            className="doc-back"
            aria-label="Back to project"
          >
            <span className="material-symbols-outlined">arrow_back</span>
          </Link>
          <div>
            <span className="doc-eyebrow">Project documents</span>
            <h1 className="doc-title">Documents</h1>
            <p className="doc-sub">
              Files and links attached to this project — briefs, contracts and
              design assets.
            </p>
          </div>
        </div>

        <div className="doc-head-actions">
          <Link to="/documents" className="doc-btn doc-btn--ghost">
            <span className="material-symbols-outlined">folder_open</span>
            All my documents
          </Link>
          <button
            type="button"
            className="doc-btn doc-btn--primary"
            onClick={() => setShowAdd(true)}
          >
            <span className="material-symbols-outlined">add</span>
            Add document
          </button>
        </div>
      </header>

      {/* Bộ lọc: tìm theo tên + tag + loại */}
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
              : "No documents yet. Upload a file or add a link to keep briefs, contracts and design assets next to the project."}
          </p>
          {!hasFilters && (
            <button
              type="button"
              className="doc-btn doc-btn--primary"
              onClick={() => setShowAdd(true)}
            >
              <span className="material-symbols-outlined">add</span>
              Add the first document
            </button>
          )}
        </div>
      ) : (
        <>
          <p className="doc-count">
            {docs.length} document{docs.length !== 1 ? "s" : ""}
          </p>
          <ul className="doc-list">
            {docs.map((d) => (
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
        </>
      )}

      {showAdd && projectId && (
        <AddDocumentModal
          projectId={projectId}
          onClose={() => setShowAdd(false)}
          onCreated={handleCreated}
        />
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
