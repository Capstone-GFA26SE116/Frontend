import { useMemo, useState } from "react";
import {
  createProjectDocumentLink,
  deleteProjectDocument,
  MAX_DOCUMENT_FILE_BYTES,
  updateProjectDocument,
  uploadProjectDocument,
  type DocumentSourceType,
  type DocumentTag,
  type ProjectDocumentDto,
} from "../../lib/api-client";
import {
  DOCUMENT_TAGS,
  formatBytes,
  formatDocDate,
  sourceIcon,
  TAG_META,
  withKeptExtension,
  type AnyDocument,
} from "./document-utils";

/* ===============================================================
 * Shared components cho kho tài liệu (dùng bởi cả trang dự án
 * và trang "Tất cả tài liệu của tôi").
 *
 * Nguồn đặc tả: `PROJECT_DOCUMENTS_FE (1).md`.
 * =============================================================== */

/* ===============================================================
 * DocumentRow — 1 dòng tài liệu trong danh sách.
 * =============================================================== */
export function DocumentRow({
  doc,
  onDownload,
  onEdit,
  onDelete,
  busyId,
}: {
  doc: AnyDocument;
  onDownload: (doc: AnyDocument) => void;
  onEdit: (doc: AnyDocument) => void;
  onDelete: (doc: AnyDocument) => void;
  busyId?: string | null;
}) {
  const isLink = doc.sourceType === "Link";
  const tag = (doc.tag ?? "Other") as DocumentTag;
  const meta = TAG_META[tag] ?? TAG_META.Other;
  const busy = busyId === doc.id;

  return (
    <li className="doc-row" data-source={doc.sourceType ?? "File"}>
      <span className="doc-row-icon" aria-hidden="true">
        <span className="material-symbols-outlined">
          {sourceIcon(doc.sourceType)}
        </span>
      </span>

      <div className="doc-row-main">
        <span className="doc-row-name" title={doc.name ?? ""}>
          {doc.name || "(no name)"}
        </span>
        <span className="doc-row-meta">
          <span className={`doc-tag doc-tag--${meta.tone}`}>{meta.label}</span>
          {!isLink && (
            <span className="doc-row-meta-item">
              <span className="material-symbols-outlined">database</span>
              {formatBytes(doc.sizeBytes)}
            </span>
          )}
          {isLink && doc.linkUrl && (
            <span className="doc-row-meta-item doc-row-url" title={doc.linkUrl}>
              <span className="material-symbols-outlined">open_in_new</span>
              {doc.linkUrl}
            </span>
          )}
          <span className="doc-row-meta-item">
            <span className="material-symbols-outlined">event</span>
            {formatDocDate(doc.uploadedAt)}
          </span>
        </span>
      </div>

      <div className="doc-row-actions">
        {isLink ? (
          <a
            className="doc-icon-btn"
            href={doc.linkUrl ?? "#"}
            target="_blank"
            rel="noopener noreferrer"
            title="Mở liên kết"
            aria-label={`Mở liên kết ${doc.name ?? ""}`}
          >
            <span className="material-symbols-outlined">open_in_new</span>
          </a>
        ) : (
          <button
            type="button"
            className="doc-icon-btn"
            title="Tải về"
            aria-label={`Tải về ${doc.name ?? ""}`}
            disabled={busy}
            onClick={() => onDownload(doc)}
          >
            <span className="material-symbols-outlined">
              {busy ? "progress_activity" : "download"}
            </span>
          </button>
        )}

        <button
          type="button"
          className="doc-icon-btn"
          title="Đổi tên / tag"
          aria-label={`Đổi tên hoặc tag ${doc.name ?? ""}`}
          onClick={() => onEdit(doc)}
        >
          <span className="material-symbols-outlined">edit</span>
        </button>

        <button
          type="button"
          className="doc-icon-btn doc-icon-btn--danger"
          title="Xoá"
          aria-label={`Xoá ${doc.name ?? ""}`}
          onClick={() => onDelete(doc)}
        >
          <span className="material-symbols-outlined">delete</span>
        </button>
      </div>
    </li>
  );
}

/* ===============================================================
 * AddDocumentModal — thêm tài liệu mới (2 chế độ: File / Link).
 * =============================================================== */
export function AddDocumentModal({
  projectId,
  onClose,
  onCreated,
}: {
  projectId: string;
  onClose: () => void;
  onCreated: (doc: ProjectDocumentDto) => void;
}) {
  const [mode, setMode] = useState<DocumentSourceType>("File");
  const [file, setFile] = useState<File | null>(null);
  const [name, setName] = useState("");
  const [tag, setTag] = useState<DocumentTag>("Other");
  const [linkUrl, setLinkUrl] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const fileTooBig = file ? file.size > MAX_DOCUMENT_FILE_BYTES : false;

  /** URL hợp lệ? BE chỉ nhận http/https và tối đa 2000 ký tự. */
  const linkError = useMemo(() => {
    const raw = linkUrl.trim();
    if (!raw) return "Vui lòng nhập đường dẫn.";
    if (raw.length > 2000) return "Đường dẫn quá dài (tối đa 2000 ký tự).";
    let parsed: URL;
    try {
      parsed = new URL(raw);
    } catch {
      return "Đường dẫn không hợp lệ.";
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return "Đường dẫn phải bắt đầu bằng http:// hoặc https://.";
    }
    return null;
  }, [linkUrl]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (submitting) return;
    setError(null);

    if (mode === "File") {
      if (!file) {
        setError("Vui lòng chọn một file để tải lên.");
        return;
      }
      if (fileTooBig) {
        setError("File vượt quá giới hạn 20 MB. Vui lòng chọn file nhỏ hơn.");
        return;
      }
      setSubmitting(true);
      const res = await uploadProjectDocument(projectId, file, { name, tag });
      setSubmitting(false);
      if (!res.ok) {
        setError(res.error ?? "Không tải được file lên.");
        return;
      }
      onCreated(res.data);
      return;
    }

    // Chế độ Link.
    if (linkError) {
      setError(linkError);
      return;
    }
    setSubmitting(true);
    const res = await createProjectDocumentLink(projectId, {
      name: name.trim() || null,
      tag,
      linkUrl: linkUrl.trim(),
    });
    setSubmitting(false);
    if (!res.ok) {
      setError(res.error ?? "Không thêm được liên kết.");
      return;
    }
    onCreated(res.data);
  }

  return (
    <div
      className="doc-modal-backdrop"
      onClick={(e) => e.target === e.currentTarget && !submitting && onClose()}
    >
      <div
        className="doc-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="doc-add-title"
      >
        <div className="doc-modal-head">
          <div>
            <span className="doc-modal-eyebrow">New document</span>
            <h2 className="doc-modal-title" id="doc-add-title">
              Add a document
            </h2>
          </div>
          <button
            type="button"
            className="doc-modal-close"
            onClick={onClose}
            aria-label="Close"
            disabled={submitting}
          >
            <span className="material-symbols-outlined">close</span>
          </button>
        </div>

        <form className="doc-form" onSubmit={handleSubmit}>
          <div className="doc-mode" role="tablist" aria-label="Loại tài liệu">
            <button
              type="button"
              role="tab"
              aria-selected={mode === "File"}
              className={
                "doc-mode-btn" + (mode === "File" ? " doc-mode-btn--on" : "")
              }
              onClick={() => setMode("File")}
            >
              <span className="material-symbols-outlined">upload_file</span>
              Tải file lên
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={mode === "Link"}
              className={
                "doc-mode-btn" + (mode === "Link" ? " doc-mode-btn--on" : "")
              }
              onClick={() => setMode("Link")}
            >
              <span className="material-symbols-outlined">link</span>
              Thêm liên kết
            </button>
          </div>

          {mode === "File" ? (
            <div className="doc-field">
              <label className="doc-label" htmlFor="doc-file">
                File <span className="doc-req">*</span>
              </label>
              <input
                id="doc-file"
                type="file"
                className="doc-file-input"
                onChange={(e) => {
                  const picked = e.target.files?.[0] ?? null;
                  setFile(picked);
                  // Bỏ trống `Name` thì BE lấy tên file gốc → tự điền cho tiện.
                  if (picked && !name.trim()) setName(picked.name);
                  setError(null);
                }}
                disabled={submitting}
              />
              {file && (
                <p
                  className={
                    "doc-file-hint" + (fileTooBig ? " doc-file-hint--error" : "")
                  }
                >
                  {file.name} · {formatBytes(file.size)}
                  {fileTooBig && " — vượt quá giới hạn 20 MB"}
                </p>
              )}
              <p className="doc-hint">
                Tối đa 20 MB mỗi file. Bỏ trống tên thì dùng tên file gốc.
              </p>
            </div>
          ) : (
            <div className="doc-field">
              <label className="doc-label" htmlFor="doc-url">
                URL <span className="doc-req">*</span>
              </label>
              <input
                id="doc-url"
                type="url"
                className="doc-input"
                placeholder="https://figma.com/file/abc"
                value={linkUrl}
                onChange={(e) => {
                  setLinkUrl(e.target.value);
                  setError(null);
                }}
                disabled={submitting}
                autoFocus
              />
              <p className="doc-hint">
                Chỉ nhận đường dẫn http:// hoặc https:// (Google Drive, Figma,
                Notion…).
              </p>
            </div>
          )}

          <div className="doc-field">
            <label className="doc-label" htmlFor="doc-name">
              Tên hiển thị
            </label>
            <input
              id="doc-name"
              type="text"
              className="doc-input"
              placeholder={mode === "File" ? "VD: Hop dong.pdf" : "VD: Brief Figma"}
              value={name}
              maxLength={255}
              onChange={(e) => {
                setName(e.target.value);
                setError(null);
              }}
              disabled={submitting}
            />
            {mode === "Link" && (
              <p className="doc-hint">
                Nên luôn đặt tên — nếu bỏ trống, BE lấy phần cuối của URL và
                URL kết thúc bằng &quot;/&quot; sẽ bị lỗi.
              </p>
            )}
          </div>

          <div className="doc-field">
            <label className="doc-label" htmlFor="doc-tag">
              Tag
            </label>
            <select
              id="doc-tag"
              className="doc-input"
              value={tag}
              onChange={(e) => setTag(e.target.value as DocumentTag)}
              disabled={submitting}
            >
              {DOCUMENT_TAGS.map((t) => (
                <option key={t} value={t}>
                  {TAG_META[t].label}
                </option>
              ))}
            </select>
          </div>

          {error && (
            <div className="doc-form-error" role="alert">
              <span className="material-symbols-outlined">error</span>
              <span>{error}</span>
            </div>
          )}

          <div className="doc-form-actions">
            <button
              type="button"
              className="doc-btn doc-btn--ghost"
              onClick={onClose}
              disabled={submitting}
            >
              Cancel
            </button>
            <button
              type="submit"
              className="doc-btn doc-btn--primary"
              disabled={
                submitting || (mode === "File" ? !file || fileTooBig : !!linkError)
              }
            >
              {submitting ? (
                <>
                  <span className="material-symbols-outlined doc-spin">
                    progress_activity
                  </span>
                  Adding…
                </>
              ) : (
                <>
                  <span className="material-symbols-outlined">add</span>
                  Add document
                </>
              )}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

/* ===============================================================
 * EditDocumentModal — đổi tên / tag (và URL nếu là Link).
 * =============================================================== */
export function EditDocumentModal({
  doc,
  onClose,
  onSaved,
}: {
  doc: AnyDocument;
  onClose: () => void;
  onSaved: (doc: ProjectDocumentDto) => void;
}) {
  const isLink = doc.sourceType === "Link";  const [name, setName] = useState(doc.name ?? "");
  const [tag, setTag] = useState<DocumentTag>(
    (doc.tag ?? "Other") as DocumentTag,
  );
  const [linkUrl, setLinkUrl] = useState(doc.linkUrl ?? "");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const linkError = useMemo(() => {
    if (!isLink) return null;
    const raw = linkUrl.trim();
    if (!raw) return "Đường dẫn không được để trống.";
    if (raw.length > 2000) return "Đường dẫn quá dài (tối đa 2000 ký tự).";
    try {
      const parsed = new URL(raw);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        return "Đường dẫn phải bắt đầu bằng http:// hoặc https://.";
      }
    } catch {
      return "Đường dẫn không hợp lệ.";
    }
    return null;
  }, [isLink, linkUrl]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (submitting) return;
    setError(null);

    if (isLink && linkError) {
      setError(linkError);
      return;
    }

    setSubmitting(true);
    // API là partial update → chỉ gửi trường thực sự đổi.
    const body: Parameters<typeof updateProjectDocument>[1] = {};
    const nextName = withKeptExtension(name, doc.name);
    if (nextName !== (doc.name ?? "")) body.name = nextName;
    if (tag !== (doc.tag ?? "Other")) body.tag = tag;
    if (isLink && linkUrl.trim() !== (doc.linkUrl ?? "")) {
      body.linkUrl = linkUrl.trim();
    }

    const res = await updateProjectDocument(doc.id, body);
    setSubmitting(false);
    if (!res.ok) {
      setError(res.error ?? "Không lưu được tài liệu.");
      return;
    }
    onSaved(res.data);
  }

  return (
    <div
      className="doc-modal-backdrop"
      onClick={(e) => e.target === e.currentTarget && !submitting && onClose()}
    >
      <div
        className="doc-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="doc-edit-title"
      >
        <div className="doc-modal-head">
          <div>
            <span className="doc-modal-eyebrow">Edit document</span>
            <h2 className="doc-modal-title" id="doc-edit-title">
              Rename or re-tag
            </h2>
          </div>
          <button
            type="button"
            className="doc-modal-close"
            onClick={onClose}
            aria-label="Close"
            disabled={submitting}
          >
            <span className="material-symbols-outlined">close</span>
          </button>
        </div>

        <form className="doc-form" onSubmit={handleSubmit}>
          <div className="doc-field">
            <label className="doc-label" htmlFor="doc-edit-name">
              Tên hiển thị
            </label>
            <input
              id="doc-edit-name"
              type="text"
              className="doc-input"
              value={name}
              maxLength={255}
              onChange={(e) => {
                setName(e.target.value);
                setError(null);
              }}
              disabled={submitting}
              autoFocus
            />
            {!isLink && (
              <p className="doc-hint">
                Đuôi file được giữ lại kể cả khi bạn không gõ — để file tải
                về vẫn mở được.
              </p>
            )}
          </div>

          {isLink && (
            <div className="doc-field">
              <label className="doc-label" htmlFor="doc-edit-url">
                URL
              </label>
              <input
                id="doc-edit-url"
                type="url"
                className="doc-input"
                value={linkUrl}
                onChange={(e) => {
                  setLinkUrl(e.target.value);
                  setError(null);
                }}
                disabled={submitting}
              />
            </div>
          )}

          <div className="doc-field">
            <label className="doc-label" htmlFor="doc-edit-tag">
              Tag
            </label>
            <select
              id="doc-edit-tag"
              className="doc-input"
              value={tag}
              onChange={(e) => setTag(e.target.value as DocumentTag)}
              disabled={submitting}
            >
              {DOCUMENT_TAGS.map((t) => (
                <option key={t} value={t}>
                  {TAG_META[t].label}
                </option>
              ))}
            </select>
          </div>

          {!isLink && (
            <p className="doc-hint doc-hint--info">
              <span className="material-symbols-outlined">info</span>
              Không thể thay nội dung file — muốn đổi file thì xoá rồi tải lại.
            </p>
          )}

          {error && (
            <div className="doc-form-error" role="alert">
              <span className="material-symbols-outlined">error</span>
              <span>{error}</span>
            </div>
          )}

          <div className="doc-form-actions">
            <button
              type="button"
              className="doc-btn doc-btn--ghost"
              onClick={onClose}
              disabled={submitting}
            >
              Cancel
            </button>
            <button
              type="submit"
              className="doc-btn doc-btn--primary"
              disabled={submitting || (isLink && !!linkError)}
            >
              {submitting ? (
                <>
                  <span className="material-symbols-outlined doc-spin">
                    progress_activity
                  </span>
                  Saving…
                </>
              ) : (
                <>
                  <span className="material-symbols-outlined">check</span>
                  Save
                </>
              )}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

/* ===============================================================
 * DeleteDocumentModal — xác nhận xoá.
 * =============================================================== */
export function DeleteDocumentModal({
  doc,
  onClose,
  onDeleted,
}: {
  doc: AnyDocument;
  onClose: () => void;
  onDeleted: (id: string) => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  async function handleConfirm() {
    if (deleting) return;
    setDeleting(true);
    setError(null);
    const res = await deleteProjectDocument(doc.id);
    setDeleting(false);
    if (!res.ok) {
      setError(res.error ?? "Không xoá được tài liệu.");
      return;
    }
    onDeleted(doc.id);
  }

  return (
    <div
      className="doc-modal-backdrop"
      onClick={(e) => e.target === e.currentTarget && !deleting && onClose()}
    >
      <div
        className="doc-modal doc-modal--sm"
        role="dialog"
        aria-modal="true"
        aria-labelledby="doc-del-title"
      >
        <div className="doc-modal-head">
          <div>
            <span className="doc-modal-eyebrow">Delete</span>
            <h2 className="doc-modal-title" id="doc-del-title">
              Delete document?
            </h2>
          </div>
          <button
            type="button"
            className="doc-modal-close"
            onClick={onClose}
            aria-label="Close"
            disabled={deleting}
          >
            <span className="material-symbols-outlined">close</span>
          </button>
        </div>

        <div className="doc-modal-body">
          <p className="doc-del-desc">
            <strong>{doc.name || "(no name)"}</strong> will be removed
            {doc.sourceType === "File" &&
              " together with its file on the server"}. This action cannot be
            undone.
          </p>

          {error && (
            <div className="doc-form-error" role="alert">
              <span className="material-symbols-outlined">error</span>
              <span>{error}</span>
            </div>
          )}
        </div>

        <div className="doc-form-actions">
          <button
            type="button"
            className="doc-btn doc-btn--ghost"
            onClick={onClose}
            disabled={deleting}
          >
            Cancel
          </button>
          <button
            type="button"
            className="doc-btn doc-btn--danger"
            onClick={() => void handleConfirm()}
            disabled={deleting}
          >
            {deleting ? (
              <>
                <span className="material-symbols-outlined doc-spin">
                  progress_activity
                </span>
                Deleting…
              </>
            ) : (
              <>
                <span className="material-symbols-outlined">delete</span>
                Delete
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
