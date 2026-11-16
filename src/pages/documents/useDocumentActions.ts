import { useCallback, useState } from "react";
import { downloadProjectDocument } from "../../lib/api-client";
import type { AnyDocument } from "./document-utils";

/**
 * useDocumentActions — gom các hành động dùng chung (tải về, sửa, xoá)
 * để 2 trang không lặp code.
 *
 * @param onChanged Callback được gọi sau khi sửa / xoá xong để reload danh sách.
 */
export function useDocumentActions(onChanged: () => void) {
  const [busyId, setBusyId] = useState<string | null>(null);
  const [editing, setEditing] = useState<AnyDocument | null>(null);
  const [deleting, setDeleting] = useState<AnyDocument | null>(null);
  const [downloadError, setDownloadError] = useState<string | null>(null);

  const handleDownload = useCallback(
    async (doc: AnyDocument) => {
      if (doc.sourceType === "Link") {
        if (doc.linkUrl) window.open(doc.linkUrl, "_blank", "noopener");
        return;
      }
      setBusyId(doc.id);
      setDownloadError(null);
      const res = await downloadProjectDocument(doc.id, doc.name ?? "document");
      setBusyId(null);
      if (!res.ok) setDownloadError(res.error ?? "Không tải được file.");
    },
    [],
  );

  return {
    busyId,
    editing,
    deleting,
    downloadError,
    setEditing,
    setDeleting,
    setDownloadError,
    handleDownload,
    /** Được gọi sau khi sửa / xoá xong để reload danh sách. */
    refresh: onChanged,
  };
}
