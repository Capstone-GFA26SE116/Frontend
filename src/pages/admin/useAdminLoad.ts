import { useCallback, useEffect, useState } from "react";

/**
 * Hook tải dữ liệu bất đồng bộ cho các trang Admin.
 *
 * Vì sao không gọi `load()` trực tiếp trong `useEffect`?
 * Rule `react-hooks/set-state-in-effect` cấm setState đồng bộ ngay trong thân
 * effect (gây cascading render). Cách đúng theo convention của repo (xem
 * `Dashboard.tsx`): setState chỉ chạy SAU `await`, và dùng cờ `cancelled`
 * để bỏ qua kết quả của request đã bị huỷ khi unmount / đổi dependency.
 *
 * `reload()` dùng sau mỗi thao tác ghi để nạp lại dữ liệu.
 */
export function useAdminLoad<T>(
  loader: () => Promise<{ ok: boolean; data?: T; error?: string }>,
  deps: React.DependencyList,
): {
  data: T | null;
  loading: boolean;
  error: string | null;
  reload: () => void;
} {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  const reload = useCallback(() => {
    setLoading(true);
    setNonce((n) => n + 1);
  }, []);

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      const res = await loader();
      if (cancelled) return;

      if (res.ok) {
        setData(res.data ?? null);
        setError(null);
      } else {
        setError(res.error ?? "Không tải được dữ liệu.");
      }
      setLoading(false);
    })();

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, nonce]);

  return { data, loading, error, reload };
}
