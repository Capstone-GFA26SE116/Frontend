import { useMemo, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { CenterToasts, useCenterToast } from "../../components/Toast";
import {
  importProjects,
  previewProjectImport,
  type ImportErrorCode,
  type ImportLanguage,
  type ImportPreviewProjectDto,
  type ImportPreviewResponseDto,
} from "../../lib/api-client";
import "./project-import.css";

/* ===========================================================
 * Nhập từ file → nhiều dự án — FR theo spec BE "API AI cho màn hình"
 * Route: /projects/import
 *
 * Luồng 2 bước:
 *   1) Upload file (xlsx, csv, pdf, docx, txt, md — tối đa 20 MB)
 *      → POST /projects/import/preview (AI đọc ra danh sách dự án)
 *   2) Sửa tên / hạn / mô tả, bỏ bớt dự án
 *      → POST /projects/import (tạo dự án thật)
 *
 * Mỗi dự án được tạo kèm 1 cuộc chat sẵn có → mở thẳng `/projects/:id/chat`.
 *
 * Lưu ý: Gói Free không dùng được bước xem trước (403 `plan_feature_locked`).
 *
 * Class prefix `.pim-*`.
 * =========================================================== */

/** Kích thước file tối đa theo spec: 20 MB. */
const MAX_FILE_BYTES = 20 * 1024 * 1024;

/** Định dạng file AI đọc được. */
const ACCEPTED_EXT = ["xlsx", "csv", "pdf", "docx", "txt", "md"];

/** Lỗi 422 `{code, file}` từ bước xem trước → thông báo tiếng Việt. */
const IMPORT_FILE_ERRORS: Record<ImportErrorCode, string> = {
  unsupported_type:
    "Định dạng file chưa được hỗ trợ. Hãy dùng xlsx, csv, pdf, docx, txt hoặc md.",
  no_text: "Không đọc được nội dung trong file. Hãy kiểm tra lại file.",
  unreadable: "File bị lỗi hoặc không đọc được. Hãy thử lại với file khác.",
  too_large: "File vượt quá 20 MB. Hãy chia nhỏ file rồi thử lại.",
};

/** Cảnh báo cho mã lỗi 409 `project_limit`. */
function projectLimitMessage(limit: number, used: number, wanted: number): string {
  const left = Math.max(0, limit - used);
  if (wanted > left) {
    return `Gói của bạn còn tạo được ${left} dự án — bạn đang chọn ${wanted}. Bỏ bớt hoặc nâng cấp gói.`;
  }
  return `Gói của bạn còn tạo được ${left} dự án.`;
}

/** Kiểm tra extension của file. */
function hasAcceptedExtension(file: File): boolean {
  const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
  return ACCEPTED_EXT.includes(ext);
}

/** Định dạng kích thước file cho UI. */
function fmtBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function ProjectImportPage() {
  const navigate = useNavigate();
  const [toasts, toast] = useCenterToast();

  const [file, setFile] = useState<File | null>(null);
  const [language, setLanguage] = useState<ImportLanguage>("vi");
  const [preview, setPreview] = useState<ImportPreviewResponseDto | null>(null);
  /** Danh sách dự án sau khi user sửa. */
  const [edits, setEdits] = useState<
    Array<ImportPreviewProjectDto & { keep: boolean }>
  >([]);

  const [previewing, setPreviewing] = useState(false);
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);

  const fileInputRef = useRef<HTMLInputElement | null>(null);

  /* ---------- derived ---------- */

  /** Số dự án còn giữ lại (không bị bỏ). */
  const keptCount = useMemo(() => edits.filter((e) => e.keep).length, [edits]);

  /** Có vượt giới hạn gói không. */
  const overLimit = useMemo(() => {
    if (!preview) return false;
    if (preview.projects_left === null) return false;
    return keptCount > preview.projects_left;
  }, [preview, keptCount]);

  /* ---------- handlers ---------- */

  /** Chọn file → gọi ngay bước xem trước. */
  async function handleFilePicked(picked: File | null) {
    setError(null);
    setPreview(null);
    setEdits([]);
    if (!picked) {
      setFile(null);
      return;
    }

    if (!hasAcceptedExtension(picked)) {
      setError(
        `Định dạng ".${picked.name.split(".").pop()}" chưa được hỗ trợ. Hãy dùng: ${ACCEPTED_EXT.join(", ")}.`,
      );
      setFile(null);
      return;
    }
    if (picked.size > MAX_FILE_BYTES) {
      setError("File vượt quá 20 MB. Hãy chia nhỏ file rồi thử lại.");
      setFile(null);
      return;
    }

    setFile(picked);
    setPreviewing(true);
    const res = await previewProjectImport(picked, language);
    setPreviewing(false);

    if (!res.ok) {
      // BE trả 422 `{code, file}` — dịch theo bảng lỗi file của spec.
      const code = res.errorCode as ImportErrorCode | undefined;
      setError(
        code && code in IMPORT_FILE_ERRORS
          ? IMPORT_FILE_ERRORS[code]
          : res.error,
      );
      setFile(null);
      return;
    }

    const data = res.data;
    setPreview(data);
    setEdits(
      (data.projects ?? []).map((p) => ({
        ...p,
        deadline: p.deadline ?? "",
        description: p.description ?? "",
        keep: true,
      })),
    );

    if (data.warnings?.length) {
      data.warnings.forEach((w) => toast.info("Cảnh báo", w));
    }
  }

  /** Sửa 1 trường của 1 dự án. */
  function patchEdit(
    index: number,
    patch: Partial<ImportPreviewProjectDto & { keep: boolean }>,
  ) {
    setEdits((prev) =>
      prev.map((e, i) => (i === index ? { ...e, ...patch } : e)),
    );
  }

  /** Bỏ / giữ 1 dự án. */
  function toggleKeep(index: number) {
    setEdits((prev) =>
      prev.map((e, i) => (i === index ? { ...e, keep: !e.keep } : e)),
    );
  }

  /** Bước 2 — tạo dự án. */
  async function handleImport() {
    if (!preview || !file) return;
    const kept = edits.filter((e) => e.keep);
    if (kept.length === 0) {
      setError("Chọn ít nhất 1 dự án để tạo.");
      return;
    }
    if (overLimit) {
      setError(
        preview.projects_left !== null
          ? projectLimitMessage(
              preview.project_limit ?? preview.projects_left,
              (preview.project_limit ?? 0) - preview.projects_left,
              kept.length,
            )
          : "Bạn đã vượt giới hạn số dự án của gói.",
      );
      return;
    }

    setImporting(true);
    setError(null);
    const res = await importProjects({
      file_name: preview.file_name || file.name,
      language,
      projects: kept.map((e) => ({
        name: e.name.trim(),
        description: e.description?.trim() || null,
        deadline: e.deadline || null,
      })),
    });
    setImporting(false);

    if (!res.ok) {
      setError(res.error);
      return;
    }

    const created = res.data ?? [];
    toast.success(
      `Đã tạo ${created.length} dự án`,
      created[0]
        ? "Đang mở dự án đầu tiên…"
        : undefined,
    );

    // Mở dự án đầu tiên (đã có sẵn 1 cuộc chat) — theo spec BE.
    const first = created[0];
    if (first) {
      navigate(`/projects/${first.project_id}/chat`);
      return;
    }
    navigate("/projects");
  }

  return (
    <section className="pim">
      {/* ============ Sub-header ============ */}
      <div className="pim-subbar">
        <div className="pim-subbar-inner">
          <div className="pim-breadcrumb">
            <Link to="/projects" className="pim-breadcrumb-link">
              Projects
            </Link>
            <span className="material-symbols-outlined pim-breadcrumb-sep">
              chevron_right
            </span>
            <span className="pim-breadcrumb-current">Nhập từ file</span>
          </div>
          <Link to="/projects" className="pim-back-btn">
            <span className="material-symbols-outlined">arrow_back</span>
            <span>Về danh sách</span>
          </Link>
        </div>
      </div>

      <div className="pim-container">
        {/* ============ Header ============ */}
        <header className="pim-header">
          <span className="pim-eyebrow">
            <span className="material-symbols-outlined">upload_file</span>
            Nhập từ file
          </span>
          <h1 className="pim-title">Tạo nhiều dự án từ 1 file</h1>
          <p className="pim-subtitle">
            File xlsx, csv, pdf, docx, txt hoặc md (tối đa 20 MB). AI đọc ra
            danh sách dự án để bạn xem trước, sửa hoặc bỏ bớt trước khi tạo.
          </p>
        </header>

        {error && (
          <div className="pim-banner pim-banner--error" role="alert">
            <span className="material-symbols-outlined">error</span>
            <span>{error}</span>
          </div>
        )}

        {/* ============ Bước 1: upload ============ */}
        {!preview && (
          <div className="pim-card">
            <div className="pim-card-head">
              <div className="pim-card-head-left">
                <span className="material-symbols-outlined pim-card-icon">
                  upload_file
                </span>
                <h2 className="pim-card-title">Bước 1 — Chọn file</h2>
              </div>
              <div className="pim-lang-toggle" role="group" aria-label="Ngôn ngữ">
                <button
                  type="button"
                  className={
                    "pim-lang-btn" + (language === "vi" ? " pim-lang-btn--on" : "")
                  }
                  onClick={() => setLanguage("vi")}
                >
                  Tiếng Việt
                </button>
                <button
                  type="button"
                  className={
                    "pim-lang-btn" + (language === "en" ? " pim-lang-btn--on" : "")
                  }
                  onClick={() => setLanguage("en")}
                >
                  English
                </button>
              </div>
            </div>

            <div
              className={
                "pim-drop" + (dragOver ? " pim-drop--over" : "")
              }
              onDragOver={(e) => {
                e.preventDefault();
                setDragOver(true);
              }}
              onDragLeave={() => setDragOver(false)}
              onDrop={(e) => {
                e.preventDefault();
                setDragOver(false);
                void handleFilePicked(e.dataTransfer.files?.[0] ?? null);
              }}
              onClick={() => fileInputRef.current?.click()}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  fileInputRef.current?.click();
                }
              }}
            >
              <span className="material-symbols-outlined pim-drop-icon">
                cloud_upload
              </span>
              <p className="pim-drop-title">
                {previewing
                  ? "AI đang đọc file…"
                  : "Kéo-thả file vào đây, hoặc bấm để chọn"}
              </p>
              <p className="pim-drop-hint">
                {ACCEPTED_EXT.map((e) => `.${e}`).join(" · ")} — tối đa 20 MB
              </p>
              <input
                ref={fileInputRef}
                type="file"
                className="pim-file-input"
                accept={ACCEPTED_EXT.map((e) => `.${e}`).join(",")}
                onChange={(e) => void handleFilePicked(e.target.files?.[0] ?? null)}
                disabled={previewing}
              />
            </div>

            {file && (
              <div className="pim-file-chip">
                <span className="material-symbols-outlined">description</span>
                <span className="pim-file-name">{file.name}</span>
                <span className="pim-file-size">{fmtBytes(file.size)}</span>
              </div>
            )}
          </div>
        )}

        {/* ============ Bước 2: xem trước & sửa ============ */}
        {preview && (
          <div className="pim-card">
            <div className="pim-card-head">
              <div className="pim-card-head-left">
                <span className="material-symbols-outlined pim-card-icon">
                  fact_check
                </span>
                <h2 className="pim-card-title">
                  Bước 2 — Xem trước &amp; sửa ({keptCount}/{edits.length})
                </h2>
              </div>
              <button
                type="button"
                className="pim-btn pim-btn--ghost"
                onClick={() => {
                  setPreview(null);
                  setEdits([]);
                  setFile(null);
                }}
                disabled={importing}
              >
                <span className="material-symbols-outlined">upload_file</span>
                <span>Chọn file khác</span>
              </button>
            </div>

            {/* Thông tin file + giới hạn gói */}
            <div className="pim-meta-row">
              <span className="pim-meta-chip">
                <span className="material-symbols-outlined">description</span>
                {preview.file_name}
              </span>
              {preview.projects_left !== null && (
                <span
                  className={
                    "pim-meta-chip" +
                    (overLimit ? " pim-meta-chip--danger" : "")
                  }
                >
                  <span className="material-symbols-outlined">inventory_2</span>
                  Còn tạo được {preview.projects_left} dự án
                </span>
              )}
            </div>

            {overLimit && (
              <div className="pim-banner pim-banner--error" role="alert">
                <span className="material-symbols-outlined">warning</span>
                <span>
                  {preview.projects_left !== null
                    ? projectLimitMessage(
                        preview.project_limit ?? preview.projects_left,
                        (preview.project_limit ?? 0) - preview.projects_left,
                        keptCount,
                      )
                    : "Bạn đã vượt giới hạn số dự án của gói."}
                </span>
              </div>
            )}

            {/* Danh sách dự án */}
            {edits.length === 0 ? (
              <p className="pim-empty">
                AI không tìm thấy dự án nào trong file. Hãy kiểm tra lại nội dung
                file.
              </p>
            ) : (
              <ul className="pim-list">
                {edits.map((e, i) => (
                  <li
                    className={
                      "pim-item" + (e.keep ? "" : " pim-item--dropped")
                    }
                    key={`${e.name}-${i}`}
                  >
                    <label className="pim-item-check">
                      <input
                        type="checkbox"
                        checked={e.keep}
                        onChange={() => toggleKeep(i)}
                        disabled={importing}
                        aria-label={`Giữ dự án ${e.name}`}
                      />
                    </label>

                    <div className="pim-item-body">
                      <div className="pim-item-row">
                        <input
                          className="pim-input pim-input--name"
                          value={e.name}
                          onChange={(ev) => patchEdit(i, { name: ev.target.value })}
                          placeholder="Tên dự án"
                          disabled={importing || !e.keep}
                          aria-label="Tên dự án"
                        />
                        <input
                          type="date"
                          className="pim-input pim-input--date"
                          value={e.deadline ?? ""}
                          onChange={(ev) => patchEdit(i, { deadline: ev.target.value })}
                          disabled={importing || !e.keep}
                          aria-label="Hạn dự án"
                        />
                      </div>

                      <textarea
                        className="pim-input pim-input--textarea"
                        value={e.description ?? ""}
                        onChange={(ev) =>
                          patchEdit(i, { description: ev.target.value })
                        }
                        placeholder="Mô tả (tuỳ chọn)"
                        rows={2}
                        disabled={importing || !e.keep}
                        aria-label="Mô tả dự án"
                      />

                      {/* Nguồn — vị trí dự án nằm trong file */}
                      {e.source && (
                        <span className="pim-item-source">
                          <span className="material-symbols-outlined">my_location</span>
                          {e.source}
                        </span>
                      )}

                      {/* Nút xem brief */}
                      {e.brief && (
                        <details className="pim-brief">
                          <summary>
                            <span className="material-symbols-outlined">
                              visibility
                            </span>
                            Xem brief
                          </summary>
                          <p>{e.brief}</p>
                        </details>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            )}

            {/* Actions */}
            <div className="pim-actions">
              <button
                type="button"
                className="pim-btn pim-btn--ghost"
                onClick={() => {
                  setPreview(null);
                  setEdits([]);
                  setFile(null);
                }}
                disabled={importing}
              >
                <span className="material-symbols-outlined">arrow_back</span>
                <span>Quay lại</span>
              </button>
              <button
                type="button"
                className="pim-btn pim-btn--primary"
                onClick={() => void handleImport()}
                disabled={importing || keptCount === 0 || overLimit}
              >
                <span className="material-symbols-outlined">
                  {importing ? "progress_activity" : "check_circle"}
                </span>
                <span>
                  {importing
                    ? "Đang tạo…"
                    : `Tạo ${keptCount} dự án`}
                </span>
              </button>
            </div>
          </div>
        )}

        {/* ============ Gợi ý ============ */}
        {!preview && (
          <div className="pim-hint">
            <span className="material-symbols-outlined">info</span>
            <span>
              Mỗi dự án được tạo sẽ có sẵn một cuộc chat với AI để bạn bàn bạc
              và lên kế hoạch ngay.
            </span>
          </div>
        )}
      </div>

      <CenterToasts toasts={toasts} onDismiss={toast.dismiss} />
    </section>
  );
}
