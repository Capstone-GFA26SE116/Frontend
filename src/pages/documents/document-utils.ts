import {
  type DocumentTag,
  type DocumentSourceType,
  type ProjectDocumentDto,
  type ProjectDocumentListItemDto,
} from "../../lib/api-client";

/* ===============================================================
 * Helpers dùng chung cho kho tài liệu (không chứa component để
 * giữ luật `react-refresh/only-export-components`).
 *
 * Nguồn đặc tả: `PROJECT_DOCUMENTS_FE (1).md`.
 * =============================================================== */

export const DOCUMENT_TAGS: DocumentTag[] = [
  "Brief",
  "Contract",
  "Design",
  "Other",
];

/** Nhãn hiển thị + tone màu cho từng tag. */
export const TAG_META: Record<
  DocumentTag,
  { label: string; tone: "brief" | "contract" | "design" | "other" }
> = {
  Brief: { label: "Brief", tone: "brief" },
  Contract: { label: "Contract", tone: "contract" },
  Design: { label: "Design", tone: "design" },
  Other: { label: "Other", tone: "other" },
};

/** Icon theo loại tài liệu. */
export function sourceIcon(sourceType: DocumentSourceType | null): string {
  return sourceType === "Link" ? "link" : "description";
}

/** "1.4 MB" / "820 KB" / "—" (link không có dung lượng). */
export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes)) return "—";
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${Math.round(kb)} KB`;
  const mb = kb / 1024;
  return `${mb.toFixed(mb >= 10 ? 0 : 1)} MB`;
}

/** "08/11/2026" — ngày kiểu Việt Nam, không phụ thuộc locale máy. */
export function formatDocDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("vi-VN", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  });
}

/**
 * Giữ đuôi file khi người dùng đổi tên.
 *
 * Spec mục 7: tên file khi tải về chính là `name`. Nếu user đổi thành
 * "Hop dong" (không đuôi) thì file tải về cũng không có đuôi → ta tự
 * thêm lại đuôi cũ cho an toàn.
 */
export function withKeptExtension(
  nextName: string,
  previousName: string | null | undefined,
): string {
  const trimmed = nextName.trim();
  if (!trimmed) return trimmed;
  // Đã có đuôi rồi → giữ nguyên.
  if (/\.[A-Za-z0-9]{1,10}$/.test(trimmed)) return trimmed;
  const prevExt = previousName?.match(/\.([A-Za-z0-9]{1,10})$/)?.[1];
  return prevExt ? `${trimmed}.${prevExt}` : trimmed;
}

/** Kiểu tài liệu mà 1 hành động có thể nhận. */
export type AnyDocument = ProjectDocumentDto | ProjectDocumentListItemDto;
