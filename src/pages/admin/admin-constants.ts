/**
 * Hằng số + hook dùng chung cho khu vực quản trị.
 *
 * Tách riêng khỏi `admin-shared.tsx` để tuân thủ rule
 * `react-refresh/only-export-components` (file component chỉ export component).
 */
import { useCallback, useEffect, useRef, useState } from "react";

/** Trạng thái toast hiển thị trên trang Admin. */
export interface AdminToastState {
  visible: boolean;
  message: string;
  tone: "success" | "error" | "info";
}

/** Giá trị toast rỗng — dùng làm state khởi tạo. */
export const EMPTY_TOAST: AdminToastState = {
  visible: false,
  message: "",
  tone: "info",
};

/**
 * Hook nhỏ: copy vào clipboard + báo đã copy.
 */
export function useCopyToClipboard() {
  const [copied, setCopied] = useState<string | null>(null);

  const copy = useCallback(async (text: string, key: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(key);
      window.setTimeout(() => setCopied(null), 1800);
    } catch {
      setCopied(null);
    }
  }, []);

  return { copied, copy };
}

/**
 * Hook: đóng menu khi click ra ngoài.
 */
export function useOutsideClick<T extends HTMLElement>(
  onOutside: () => void,
): React.RefObject<T | null> {
  const ref = useRef<T | null>(null);

  useEffect(() => {
    function onClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        onOutside();
      }
    }
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [onOutside]);

  return ref;
}
