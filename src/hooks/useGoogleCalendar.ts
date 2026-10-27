import { useCallback, useEffect, useRef, useState } from "react";
import {
  disconnectGoogleCalendar,
  fetchGoogleCalendarAuthorizationUrl,
  getGoogleCalendarConnectUrl,
  getGoogleCalendarStatus,
  syncGoogleCalendar,
  type GoogleCalendarStatusDto,
  type GoogleCalendarSyncResultDto,
} from "../lib/api-client";

/**
 * Hook quản lý trạng thái kết nối Google Calendar của user hiện tại.
 *
 * Dùng chung cho card trong `/schedule` và item trong user menu để cả hai
 * luôn hiển thị cùng một trạng thái (mỗi nơi mount hook sẽ tự gọi
 * `GET /api/google-calendar/status` một lần).
 *
 * `enabled` (mặc định true): đặt false khi chưa đăng nhập. Rất quan trọng —
 * nếu gọi API lúc chưa có token, `apiFetch` sẽ nhận 401 → xoá token và
 * redirect `/login`, làm hỏng cả trang public (landing/pricing).
 *
 * Luồng connect (theo BE mới):
 *   1. `GET /api/google-calendar/connect`  (có Bearer) → `{ authorizationUrl }`
 *   2. `window.location.assign(authorizationUrl)` → trang consent Google
 *   3. User đồng ý → Google gọi callback của BE → BE lưu token, redirect về
 *      `CalendarConnectedRedirectUri?calendar=connected` (hoặc `error`/`denied`)
 *   4. FE (trang callback) gọi lại `refresh()` để đọc trạng thái thật.
 *
 * Vì bước 2 là redirect cả trang, hook KHÔNG giữ state "connecting" sau khi
 * rời trang — trang callback sẽ mount lại hook và tự refresh.
 */
export type GoogleCalendarBusy = "connect" | "sync" | "disconnect" | null;

export function useGoogleCalendar(enabled: boolean = true) {
  const [status, setStatus] = useState<GoogleCalendarStatusDto | null>(null);
  const [loading, setLoading] = useState(enabled);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<GoogleCalendarBusy>(null);
  /** Kết quả lần sync gần nhất (để UI báo added/updated/cancelled). */
  const [lastSync, setLastSync] = useState<GoogleCalendarSyncResultDto | null>(
    null,
  );
  /** Chống set state sau khi unmount (connect là redirect nên hay gặp). */
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const refresh = useCallback(async () => {
    if (!enabled) return;
    setError(null);
    const res = await getGoogleCalendarStatus();
    if (!alive.current) return;
    if (res.ok) {
      setStatus(res.data);
    } else {
      // 404 = BE chưa có endpoint này (deploy cũ) → coi như chưa kết nối
      // thay vì hiện lỗi đỏ làm user hoảng.
      if (res.status === 404) {
        setStatus({ isConnected: false, status: null, tokenExpiresAt: null });
      } else if (res.status !== 401) {
        setError(res.error);
      }
    }
    setLoading(false);
  }, [enabled]);

  useEffect(() => {
    if (!enabled) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- data-fetch pattern
    void refresh();
  }, [enabled, refresh]);

  /**
   * Bắt đầu OAuth.
   *
   * Gọi API (có Bearer) để lấy `authorizationUrl`, rồi redirect cả trang.
   * Nếu API lỗi (BE cũ trả 302 / mạng lỗi) → fallback redirect thẳng
   * endpoint connect, vì một số deploy cũ vẫn chấp nhận không cần header.
   */
  const connect = useCallback(async () => {
    setBusy("connect");
    setError(null);
    const res = await fetchGoogleCalendarAuthorizationUrl();
    if (!alive.current) return; // đã redirect hoặc unmount

    if (res.ok && res.data?.authorizationUrl) {
      window.location.assign(res.data.authorizationUrl);
      return;
    }

    // 401 nghĩa là token hết hạn — apiFetch đã xử lý logout, không redirect mù.
    if (!res.ok && res.status === 401) {
      setError(res.error);
      setBusy(null);
      return;
    }

    // Deploy cũ: endpoint connect trả 302 trực tiếp (không có JSON) → 404/405.
    // Chỉ trong trường hợp này mới redirect thẳng; lỗi mạng thì báo lỗi cho user
    // thay vì đẩy họ sang một trang trắng 401.
    if (!res.ok && (res.status === 404 || res.status === 405)) {
      window.location.assign(getGoogleCalendarConnectUrl());
      return;
    }

    setError(!res.ok ? res.error : "Không lấy được liên kết uỷ quyền Google.");
    setBusy(null);
  }, []);

  const disconnect = useCallback(async () => {
    setBusy("disconnect");
    setError(null);
    const res = await disconnectGoogleCalendar();
    if (!alive.current) return res;
    if (res.ok) {
      setStatus({ isConnected: false, status: null, tokenExpiresAt: null });
      setLastSync(null);
    } else {
      setError(res.error);
    }
    setBusy(null);
    return res;
  }, []);

  const sync = useCallback(async () => {
    setBusy("sync");
    setError(null);
    const res = await syncGoogleCalendar();
    if (!alive.current) return res;
    if (res.ok) {
      setLastSync(res.data);
      // Sync xong token có thể đã được refresh → cập nhật lại status.
      void refresh();
    } else {
      setError(res.error);
    }
    setBusy(null);
    return res;
  }, [refresh]);

  return {
    status,
    isConnected: status?.isConnected ?? false,
    loading,
    busy,
    error,
    lastSync,
    refresh,
    connect,
    disconnect,
    sync,
  };
}
