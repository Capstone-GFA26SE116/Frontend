import { useCallback, useEffect, useRef, useState } from "react";
import "./toast.css";

export type ToastKind = "success" | "error" | "info";

interface ToastItem {
  id: number;
  kind: ToastKind;
  title: string;
  detail?: string;
}

interface ToastApi {
  show: (kind: ToastKind, title: string, detail?: string) => void;
  success: (title: string, detail?: string) => void;
  error: (title: string, detail?: string) => void;
  info: (title: string, detail?: string) => void;
  /** Tự đóng 1 toast theo id (dùng cho nút onDismiss của <CenterToasts>). */
  dismiss: (id: number) => void;
}

/* ===========================================================
 * Hook: useCenterToast
 * Trả về [toasts, api] — api.success()/error()/info() để bắn toast,
 * api.dismiss(id) để đóng thủ công, toasts để render.
 * Toast tự ẩn sau 3.2s, tự dismiss được bằng click.
 * =========================================================== */
export function useCenterToast(): [ToastItem[], ToastApi] {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const seq = useRef(0);
  const timers = useRef<number[]>([]);

  useEffect(() => {
    const list = timers.current;
    return () => list.forEach((t) => window.clearTimeout(t));
  }, []);

  const dismiss = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const show = useCallback(
    (kind: ToastKind, title: string, detail?: string) => {
      const id = ++seq.current;
      setToasts((prev) => [...prev, { id, kind, title, detail }]);
      const timer = window.setTimeout(() => {
        setToasts((prev) => prev.filter((t) => t.id !== id));
      }, 3200);
      timers.current.push(timer);
    },
    []
  );

  const api = useRef<ToastApi>({
    show,
    success: (t, d) => show("success", t, d),
    error: (t, d) => show("error", t, d),
    info: (t, d) => show("info", t, d),
    dismiss,
  });
  api.current.show = show;
  api.current.dismiss = dismiss;

  return [toasts, api.current];
}

const ICONS: Record<ToastKind, string> = {
  success: "check_circle",
  error: "error",
  info: "info",
};

/* ===========================================================
 * <CenterToasts toasts={toasts} onDismiss={...} />
 * Đặt 1 lần ở gốc layout để toast hiện giữa màn hình.
 * =========================================================== */
export function CenterToasts({
  toasts,
  onDismiss,
}: {
  toasts: ToastItem[];
  onDismiss: (id: number) => void;
}) {
  if (toasts.length === 0) return null;
  return (
    <div className="mtoast-layer" role="status" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`mtoast mtoast--${t.kind}`} onClick={() => onDismiss(t.id)}>
          <span className="material-symbols-outlined mtoast__icon">{ICONS[t.kind]}</span>
          <div className="mtoast__body">
            <span className="mtoast__title">{t.title}</span>
            {t.detail && <span className="mtoast__detail">{t.detail}</span>}
          </div>
          <button
            type="button"
            className="mtoast__close"
            aria-label="Đóng"
            onClick={(e) => {
              e.stopPropagation();
              onDismiss(t.id);
            }}
          >
            <span className="material-symbols-outlined">close</span>
          </button>
        </div>
      ))}
    </div>
  );
}