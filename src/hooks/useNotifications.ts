import { useCallback, useEffect, useRef, useState } from "react";
import {
  getAccessToken,
  getVapidPublicKey,
  listNotifications,
  markAllNotificationsRead,
  markNotificationRead,
  subscribePushNotifications,
  unsubscribePushNotifications,
  type NotificationDto,
  type PushSubscriptionDto,
} from "../lib/api-client";
import {
  ACTION_TYPE_MESSAGES,
  toActionType,
  type FocusActionType,
} from "../components/focus/focus-logic";

/**
 * ============================================================
 * useNotifications — 3 đường thông báo theo spec BE.
 * ============================================================
 *
 *   1. SignalR  `/hubs/notifications`  → realtime khi app đang mở
 *   2. Web Push (service worker)        → kể cả khi đóng tab
 *   3. Hộp thư `GET /api/notifications` → xem lại thông báo đã lỡ
 *
 * SignalR là phần khó nhất:
 *  - JWT phải truyền qua `accessTokenFactory` (server đọc `access_token` trên
 *    query string).
 *  - Token hết hạn → phải `stop()` rồi tạo connection mới với token mới.
 *  - Dùng `withAutomaticReconnect()` để tự kết nối lại khi mạng chập chờn.
 * ============================================================ */

const API_BASE = import.meta.env.VITE_API_URL as string;
/** Đường dẫn hub (BE đã bật AllowCredentials + AllowedOrigins cho FE). */
const HUB_URL = `${API_BASE}/hubs/notifications`;

/**
 * Các `type` thông báo của NHÓM (spec GROUP_FE.md mục 6 + mục 10).
 *
 * Mục 10 của cập nhật BE: khi việc được giao lại hoặc người làm rời nhóm →
 * slot chưa bắt đầu của người cũ bị huỷ + phát `GroupStatusChanged` →
 * FE làm mới lịch.
 */
export const GROUP_NOTIFICATION_TYPES = new Set([
  "GroupInvited",
  "GroupAssigned",
  "GroupStatusChanged",
  "GroupMention",
  "GroupChangeRequested",
  "GroupChangeDecided",
]);

/**
 * Tín hiệu này có làm thay đổi **lịch** không?
 *
 * → Trả `true` cho `GroupStatusChanged` (slot nhóm bị huỷ) và các biến thể
 * giao lại / rời nhóm.
 */
export function signalAffectsSchedule(signal: {
  rawType?: string;
}): boolean {
  const t = (signal.rawType ?? "").trim();
  if (!t) return false;
  if (GROUP_NOTIFICATION_TYPES.has(t)) return true;
  // BE có thể gửi biến thể riêng cho việc giao lại / rời nhóm.
  return (
    t.includes("GroupStatusChanged") ||
    t.includes("GroupReassigned") ||
    t.includes("GroupMemberLeft")
  );
}

/** Kiểu trạng thái kết nối SignalR. */
export type SignalRStatus =
  | "disconnected"
  | "connecting"
  | "connected"
  | "reconnecting";

export interface NotificationSignal {
  /** Nội dung thông báo (message từ server). */
  message: string;
  /** Loại hành động chi tiết — chỉ có ở SignalR / Web Push. */
  actionType: FocusActionType;
  /** Id thông báo (có thể dùng để đánh dấu đã đọc). */
  notificationId: string;
  /**
   * `type` **gốc** do server gửi (chưa chuẩn hoá).
   *
   * Cần cho thông báo của NHÓM: `GroupStatusChanged`, `GroupAssigned`,
   * `GroupMention`… — không phải action type của nhánh cá nhân nên
   * `actionType` sẽ là `"Unknown"`.
   *
   * Mục 10 của cập nhật BE: khi nhận `GroupStatusChanged` (việc được giao lại
   * / người rời nhóm → slot chưa bắt đầu bị huỷ) → FE làm mới lịch.
   */
  rawType: string;
}

export interface UseNotificationsResult {
  /** Danh sách thông báo trong hộp thư (mới nhất trước). */
  notifications: NotificationDto[];
  /** Số thông báo chưa đọc — dùng cho badge. */
  unreadCount: number;
  /** Đang tải hộp thư. */
  loading: boolean;
  /** Lỗi gần nhất (hộp thư). */
  error: string | null;
  /** Trạng thái kết nối SignalR. */
  signalStatus: SignalRStatus;
  /** true nếu Web Push đã bật thành công. */
  pushEnabled: boolean;
  /** true nếu trình duyệt không hỗ trợ Web Push. */
  pushUnsupported: boolean;
  /**
   * Tín hiệu realtime MỚI NHẤT (null nếu chưa có).
   *
   * Component khác dùng nó để phản ứng (VD: bật toast, refetch phiên đang
   * chạy). Mỗi tín hiệu có `notificationId` riêng nên có thể so sánh để
   * tránh xử lý trùng.
   */
  lastSignal: NotificationSignal | null;

  /** Nạp lại hộp thư. */
  refresh: () => Promise<void>;
  /** Đánh dấu 1 thông báo đã đọc. */
  markRead: (notificationId: string) => Promise<void>;
  /** Đánh dấu toàn bộ đã đọc. */
  markAllRead: () => Promise<void>;
  /** Bật Web Push (xin quyền + đăng ký với BE). */
  enablePush: () => Promise<boolean>;
  /** Tắt Web Push. */
  disablePush: () => Promise<boolean>;
  /**
   * Đăng ký callback khi nhận thông báo realtime — dùng để bắn toast và
   * refetch dữ liệu liên quan (ví dụ trạng thái slot, phiên đang chạy).
   */
  onSignal: (fn: (signal: NotificationSignal) => void) => () => void;
}

/**
 * Chuyển base64 (VAPID key) → Uint8Array mà `pushManager.subscribe` cần.
 *
 * Ghi chú kiểu: `new Uint8Array(len)` tạo buffer `ArrayBufferLike` — TS 5.7+
 * yêu cầu `BufferSource` phải là `ArrayBufferView<ArrayBuffer>`, nên ta tạo
 * `ArrayBuffer` tường minh rồi bọc lại.
 */
function urlBase64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const normalized = (base64 + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = window.atob(normalized);
  const buffer = new ArrayBuffer(raw.length);
  const output = new Uint8Array(buffer);
  for (let i = 0; i < raw.length; i += 1) {
    output[i] = raw.charCodeAt(i);
  }
  return output;
}

/** Đọc subscription hiện tại của trình duyệt (nếu đã đăng ký). */
async function getExistingSubscription(): Promise<PushSubscription | null> {
  if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
    return null;
  }
  const reg = await navigator.serviceWorker.getRegistration();
  if (!reg) return null;
  try {
    return await reg.pushManager.getSubscription();
  } catch {
    return null;
  }
}

/** Chuyển `PushSubscription` → DTO mà BE mong đợi. */
function toSubscriptionDto(sub: PushSubscription): PushSubscriptionDto | null {
  const json = sub.toJSON();
  if (!json.endpoint || !json.keys?.p256dh || !json.keys?.auth) return null;
  return {
    endpoint: json.endpoint,
    keys: { p256dh: json.keys.p256dh, auth: json.keys.auth },
  };
}

/**
 * Hook quản lý thông báo.
 *
 * @param enabled Chỉ bật khi user đã đăng nhập — tránh gọi API lúc chưa có
 *   token (401 → xoá token → redirect /login, làm hỏng trang public).
 */
export function useNotifications(enabled: boolean = true): UseNotificationsResult {
  const [notifications, setNotifications] = useState<NotificationDto[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [signalStatus, setSignalStatus] = useState<SignalRStatus>("disconnected");
  const [pushEnabled, setPushEnabled] = useState(false);
  /** Tín hiệu realtime mới nhất. */
  const [lastSignal, setLastSignal] = useState<NotificationSignal | null>(null);
  /**
   * Trình duyệt có hỗ trợ Web Push không.
   *
   * Khởi tạo bằng lazy initializer (đọc 1 lần lúc mount) để không phải
   * setState trong effect — React Compiler cấm setState đồng bộ trong effect.
   */
  const [pushUnsupported, setPushUnsupported] = useState(() => {
    if (typeof window === "undefined") return true;
    return !(
      "serviceWorker" in navigator &&
      "PushManager" in window &&
      "Notification" in window
    );
  });

  const alive = useRef(true);
  /**
   * Các callback xử lý tín hiệu realtime.
   *
   * Dùng `Set` thay vì một biến đơn để NHIỀU màn hình cùng nghe được
   * (ví dụ `FocusManager` + trang `/schedule` cùng cần phản ứng khi nhận
   * `GroupStatusChanged` → làm mới lịch).
   */
  const signalHandlersRef = useRef<Set<(s: NotificationSignal) => void>>(
    new Set(),
  );

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  /* ---------- Hộp thư ---------- */

  const refresh = useCallback(async () => {
    if (!enabled) return;
    setLoading(true);
    const res = await listNotifications({ unreadOnly: false, take: 50 });
    if (!alive.current) return;
    setLoading(false);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    setError(null);
    setNotifications(res.data);
    setUnreadCount(res.data.filter((n) => !n.isRead).length);
  }, [enabled]);

  const markRead = useCallback(async (notificationId: string) => {
    // Cập nhật optimistic để UI phản hồi tức thì.
    setNotifications((prev) =>
      prev.map((n) =>
        n.id === notificationId
          ? { ...n, isRead: true, readAt: new Date().toISOString() }
          : n,
      ),
    );
    setUnreadCount((c) => Math.max(0, c - 1));
    const res = await markNotificationRead(notificationId);
    if (!res.ok && alive.current) {
      // Hoàn tác nếu server từ chối.
      await refresh();
    }
  }, [refresh]);

  const markAllRead = useCallback(async () => {
    const res = await markAllNotificationsRead();
    if (!alive.current) return;
    if (!res.ok) {
      setError(res.error);
      return;
    }
    await refresh();
  }, [refresh]);

  /* ---------- SignalR ---------- */

  useEffect(() => {
    if (!enabled) return;
    // Import động để không bundle SignalR vào các trang không dùng.
    let disposed = false;
    let connection: import("@microsoft/signalr").HubConnection | null = null;

    async function connect() {
      try {
        const signalR = await import("@microsoft/signalr");
        if (disposed) return;

        connection = new signalR.HubConnectionBuilder()
          .withUrl(HUB_URL, {
            accessTokenFactory: () => getAccessToken() ?? "",
            /**
             * ⚠️ `withCredentials: false` — BẮT BUỘC.
             *
             * SignalR mặc định gửi `credentials: "include"` (kèm cookie) cho
             * request `negotiate`. Browser chỉ cho đọc response khi server
             * trả `Access-Control-Allow-Credentials: true`; BE hiện KHÔNG trả
             * header đó (chỉ có `Access-Control-Allow-Origin`) → browser chặn
             * → `net::ERR_FAILED` / "Failed to complete negotiation".
             *
             * BE xác thực bằng `Authorization: Bearer` (đã xác nhận: response
             * 401 trả `WWW-Authenticate: Bearer`, KHÔNG set cookie) → không
             * cần cookie → tắt credentials là cách đúng và cũng tránh lộ
             * cookie sang domain khác.
             */
            withCredentials: false,
          })
          .withAutomaticReconnect()
          .configureLogging(signalR.LogLevel.Error)
          .build();

        connection.on(
          "ReceiveNotification",
          (message: string, actionType: string, notificationId: string) => {
            if (!alive.current) return;
            const signal: NotificationSignal = {
              message: message || ACTION_TYPE_MESSAGES.Unknown,
              actionType: toActionType(actionType),
              notificationId: notificationId ?? "",
              rawType: actionType ?? "",
            };
            setLastSignal(signal);
            signalHandlersRef.current.forEach((fn) => {
              try {
                fn(signal);
              } catch (err) {
                console.error("[useNotifications] signal handler failed:", err);
              }
            });
            // Nạp lại hộp thư để badge + danh sách luôn khớp server.
            void refresh();
          },
        );

        connection.onreconnecting(() => setSignalStatus("reconnecting"));
        connection.onreconnected(() => setSignalStatus("connected"));
        connection.onclose(() => {
          setSignalStatus("disconnected");
          // Token có thể đã hết hạn → thử kết nối lại sau vài giây.
          window.setTimeout(() => {
            if (!disposed && alive.current) void connect();
          }, 5000);
        });

        setSignalStatus("connecting");
        await connection.start();
        if (!disposed && alive.current) setSignalStatus("connected");
      } catch (err) {
        if (!disposed && alive.current) setSignalStatus("disconnected");
        // Ghi log để dev thấy nguyên nhân thật (CORS / 401 / mạng).
        console.error("[useNotifications] SignalR connect failed:", err);
      }
    }

    void connect();

    return () => {
      disposed = true;
      if (connection) {
        void connection.stop().catch(() => {
          // ignore
        });
      }
    };
  }, [enabled, refresh]);

  /* ---------- Web Push ---------- */

  /** Đăng ký service worker (idempotent). */
  const ensureServiceWorker = useCallback(async (): Promise<ServiceWorkerRegistration | null> => {
    if (!("serviceWorker" in navigator)) return null;
    try {
      const reg = await navigator.serviceWorker.register("/sw.js", {
        scope: "/",
      });
      // Đợi SW kích hoạt để pushManager.subscribe dùng được.
      await navigator.serviceWorker.ready;
      return reg;
    } catch {
      return null;
    }
  }, []);

  const enablePush = useCallback(async (): Promise<boolean> => {
    if (!enabled) return false;
    if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
      setPushUnsupported(true);
      return false;
    }
    if (!("Notification" in window)) {
      setPushUnsupported(true);
      return false;
    }

    const permission = await Notification.requestPermission();
    if (permission !== "granted") return false;

    const reg = await ensureServiceWorker();
    if (!reg) return false;

    const vapid = await getVapidPublicKey();
    if (!vapid.ok || !vapid.data.publicKey) return false;

    try {
      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(vapid.data.publicKey),
      });
      const dto = toSubscriptionDto(sub);
      if (!dto) return false;
      const res = await subscribePushNotifications(dto);
      if (!res.ok) {
        setError(res.error);
        return false;
      }
      setPushEnabled(true);
      return true;
    } catch {
      return false;
    }
  }, [enabled, ensureServiceWorker]);

  const disablePush = useCallback(async (): Promise<boolean> => {
    const sub = await getExistingSubscription();
    if (!sub) {
      setPushEnabled(false);
      return true;
    }
    const dto = toSubscriptionDto(sub);
    if (dto) {
      await unsubscribePushNotifications(dto).catch(() => {
        // ignore
      });
    }
    await sub.unsubscribe().catch(() => {
      // ignore
    });
    setPushEnabled(false);
    return true;
  }, []);

  /* ---------- Kiểm tra trạng thái push khi mount ---------- */

  /**
   * Trình duyệt có hỗ trợ Web Push không?
   *
   * Tính sẵn 1 lần thay vì setState trong effect (React Compiler cấm setState
   * đồng bộ trong effect).
   */
  const pushSupported =
    typeof window !== "undefined" &&
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    "Notification" in window;

  useEffect(() => {
    if (!enabled) return;
    if (!pushSupported) return;
    void getExistingSubscription().then((sub) => {
      if (alive.current) setPushEnabled(!!sub);
    });
  }, [enabled, pushSupported]);

  /* ---------- Nạp hộp thư lúc mount ---------- */

  useEffect(() => {
    if (!enabled) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- data-fetch pattern
    void refresh();
  }, [enabled, refresh]);

  /* ---------- Đăng ký handler realtime ---------- */

  /**
   * Đăng ký callback xử lý tín hiệu realtime (SignalR).
   *
   * Nhiều subscriber được phép cùng lúc — mỗi subscriber nhận về một hàm
   * huỷ đăng ký riêng.
   */
  const onSignal = useCallback((fn: (signal: NotificationSignal) => void) => {
    signalHandlersRef.current.add(fn);
    return () => {
      signalHandlersRef.current.delete(fn);
    };
  }, []);

  return {
    notifications,
    unreadCount,
    loading,
    error,
    signalStatus,
    pushEnabled,
    pushUnsupported,
    lastSignal,
    refresh,
    markRead,
    markAllRead,
    enablePush,
    disablePush,
    onSignal,
  };
}
