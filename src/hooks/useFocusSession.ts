import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  confirmFocusSession,
  getCurrentFocusSession,
  listPendingFocusConfirmations,
  selfReportFocusSession,
  startFocusSession,
  stopFocusSession,
  type FocusConfirmRequest,
  type FocusCurrentResponse,
  type FocusPendingConfirmationItem,
  type FocusSelfReportRequest,
  type FocusStartRequest,
  type FocusStartResponse,
  type FocusStopReason,
  type FocusStopResponse,
} from "../lib/api-client";

/**
 * ============================================================
 * useFocusSession — nguồn sự thật cho "phiên làm việc đang chạy".
 * ============================================================
 *
 * Vì sao cần hook riêng (và không nhét vào 1 trang):
 *  - Phiên làm việc là trạng thái TOÀN CỤC: bắt đầu ở /schedule, đóng tab,
 *    mở lại /dashboard → đồng hồ phải vẫn chạy đúng. Nên nó phải sống ở
 *    layout (SiteLayout) chứ không ở từng page.
 *  - Nhiều nơi cần đọc: thanh đồng hồ global, nút Start/Stop trên lịch,
 *    dialog hỏi stop-reason, SignalR handler.
 *
 * ------------------------------------------------------------
 * ĐỒNG HỒ ĐƠN ĐIỆU — phần quan trọng nhất của file này
 * ------------------------------------------------------------
 * KHÔNG được tính `Date.now() - startedAt`:
 *   • User có thể đổi giờ máy → đồng hồ nhảy về 0 hoặc vượt quá.
 *   • `startedAt` là giờ UTC của server, còn `Date.now()` là giờ máy local.
 *
 * Cách đúng (theo spec BE):
 *   baseElapsed = server.elapsedSeconds   (server đã tính sẵn)
 *   receivedAt  = performance.now()        (đồng hồ đơn điệu của trình duyệt)
 *   elapsed     = baseElapsed + (performance.now() - receivedAt) / 1000
 *
 * `performance.now()` không bị ảnh hưởng bởi thay đổi đồng hồ hệ thống, và
 * vẫn chạy đúng khi tab bị đóng (đồng hồ dừng, ta resync khi focus lại).
 *
 * Để không lệch dần, ta resync `GET /api/focus/current` mỗi RESYNC_MS và
 * ngay khi tab được focus lại (`visibilitychange`).
 */

/** Chu kỳ resync đồng hồ về server (ms). Spec khuyến nghị 15–30s. */
const RESYNC_MS = 20_000;
/** Chu kỳ tick hiển thị (ms) — 1s là đủ mịn, rẻ hơn frame-by-frame. */
const TICK_MS = 1_000;

/**
 * Key lưu `plannedMinutes` theo `sessionId` trong `sessionStorage`.
 *
 * Vì sao cần: `GET /api/focus/current` KHÔNG trả `plannedMinutes` (chỉ
 * response của `POST /api/focus/start` có). Nếu user reload trang (hoặc mở
 * app ở tab khác), ta mất mốc thời gian → thanh đồng hồ không vẽ được
 * "còn bao lâu" và thanh tiến trình.
 *
 * `sessionStorage` (không phải `localStorage`) vì dữ liệu này chỉ có ý
 * nghĩa trong phiên làm việc hiện tại; và ta tự dọn khi session đổi/kết thúc.
 */
const PLANNED_MINUTES_KEY = "metanoia:focus:plannedMinutes";

/** Trạng thái phiên mà hook đang quản lý. */
export type FocusSessionPhase =
  /** Chưa có phiên nào đang chạy. */
  | "idle"
  /** Đang chạy. */
  | "running"
  /** Đang gọi API (start/stop/...). */
  | "busy";

/** Kết quả chuẩn hoá của `startFocusSession` cho UI dùng. */
export type StartFocusOutcome =
  /** Bắt đầu thành công. */
  | { kind: "started"; data: FocusStartResponse }
  /**
   * Đã có phiên khác đang chạy (409). `session` là phiên đó — FE chuyển
   * sang màn hình phiên đang chạy, KHÔNG báo lỗi đỏ.
   */
  | { kind: "conflict"; session: FocusCurrentResponse }
  /**
   * Bắt đầu sớm hơn lịch > 2h. Phiên ĐÃ được tạo — cần hỏi user xem có
   * giữ không. `session` là phiên vừa tạo.
   */
  | { kind: "tooEarly"; session: FocusStartResponse }
  /** Lỗi khác — hiển thị `error`. */
  | { kind: "error"; error: string };

/** Kết quả chuẩn hoá của `stopFocusSession`. */
export type StopFocusOutcome =
  | { kind: "stopped"; data: FocusStopResponse }
  /** 409 = đã dừng trước đó (bấm 2 lần / 2 tab) → coi như thành công. */
  | { kind: "alreadyStopped" }
  | { kind: "error"; error: string };

/** Thông tin đồng hồ đang chạy — nguồn cho mọi UI hiển thị. */
export interface FocusTimerState {
  /** Tổng giây đã làm (đã tính cả phần trôi qua từ lúc nhận response). */
  elapsedSeconds: number;
  /** Phút dự kiến (0 = làm việc ngoài lịch, không có mốc). */
  plannedMinutes: number;
  /** Số giây còn lại — âm nghĩa là đã quá giờ. */
  remainingSeconds: number;
  /** true khi đã vượt giờ dự kiến (đồng hồ chuyển màu cảnh báo). */
  isOverrun: boolean;
  /** % đã dùng so với kế hoạch (0–100+, không plan = 0). */
  progressPercent: number;
}

export interface UseFocusSessionResult {
  /** Phiên đang chạy (null nếu không có). */
  session: FocusCurrentResponse | null;
  /** Trạng thái phiên. */
  phase: FocusSessionPhase;
  /** true khi đang gọi API — dùng để disable nút. */
  busy: boolean;
  /** Đồng hồ (null khi không có phiên). */
  timer: FocusTimerState | null;
  /** Lỗi cuối cùng (đã reset khi bắt đầu hành động mới). */
  error: string | null;
  /** Phiên bị hệ thống tự ngắt, chờ user xác nhận. */
  pendingConfirmation: FocusPendingConfirmationItem | null;

  /** Nạp lại phiên đang chạy từ server. */
  refresh: () => Promise<void>;
  /** Bắt đầu phiên mới. */
  start: (req: FocusStartRequest) => Promise<StartFocusOutcome>;
  /** Dừng phiên hiện tại (hoặc 1 sessionId cụ thể). */
  stop: (
    reason: FocusStopReason,
    note?: string | null,
    sessionId?: string,
  ) => Promise<StopFocusOutcome>;
  /** Xác nhận / sửa / loại bỏ phiên bị tự ngắt. */
  confirm: (req: FocusConfirmRequest, sessionId?: string) => Promise<boolean>;
  /** Khai báo giờ làm việc (quên bấm Start). */
  selfReport: (req: FocusSelfReportRequest) => Promise<boolean>;
  /** Nạp lại danh sách phiên chờ xác nhận. */
  refreshPending: () => Promise<void>;
  /** Đóng dialog xác nhận (sau khi đã xử lý). */
  dismissPending: () => void;
  /**
   * Cung cấp phút dự kiến cho phiên đang chạy khi ta chưa biết (sau khi
   * reload trang — `/current` không trả `plannedMinutes`).
   */
  seedPlannedMinutes: (minutes: number) => void;
  /**
   * Đăng ký callback được gọi khi trạng thái slot có thể đã đổi (sau start/stop/
   * confirm) — trang lịch dùng để refetch. Trả về hàm huỷ đăng ký.
   */
  onSlotChanged: (fn: () => void) => () => void;
}

/**
 * Đọc `details` của lỗi 409 — BE trả chính phiên đang chạy ở đó.
 *
 * Shape giống hệt `FocusCurrentResponse` (sessionId, taskId, taskTitle,
 * scheduleSlotId, startedAt, elapsedSeconds, serverTime, isOverrun).
 *
 * Vì server có thể bọc thêm 1 lớp (`details.session`, `details.currentSession`)
 * nên ta thử tuần tự các vị trí khả dụng.
 */
function parseConflictSession(details: unknown): FocusCurrentResponse | null {
  if (!details || typeof details !== "object") return null;

  // Thử các vị trí lồng nhau trước.
  const candidates: unknown[] = [];
  const rec = details as Record<string, unknown>;
  for (const key of ["session", "currentSession", "activeSession", "data"]) {
    const v = rec[key];
    if (v && typeof v === "object") candidates.push(v);
  }
  candidates.push(details);

  for (const c of candidates) {
    const parsed = toCurrentResponse(c);
    if (parsed) return parsed;
  }
  return null;
}

/** Chuẩn hoá 1 object bất kỳ thành `FocusCurrentResponse` (null nếu thiếu id). */
function toCurrentResponse(value: unknown): FocusCurrentResponse | null {
  if (!value || typeof value !== "object") return null;
  const d = value as Record<string, unknown>;
  if (typeof d.sessionId !== "string" || !d.sessionId) return null;
  return {
    sessionId: d.sessionId,
    taskId: typeof d.taskId === "string" ? d.taskId : "",
    taskTitle: typeof d.taskTitle === "string" ? d.taskTitle : null,
    scheduleSlotId:
      typeof d.scheduleSlotId === "string" ? d.scheduleSlotId : null,
    startedAt:
      typeof d.startedAt === "string" ? d.startedAt : new Date().toISOString(),
    elapsedSeconds:
      typeof d.elapsedSeconds === "number" ? d.elapsedSeconds : 0,
    serverTime:
      typeof d.serverTime === "string" ? d.serverTime : new Date().toISOString(),
    isOverrun: d.isOverrun === true,
  };
}

/**
 * Đọc `plannedMinutes` đã lưu cho 1 phiên.
 *
 * @returns số phút, hoặc 0 nếu chưa có / sessionStorage không khả dụng.
 */
function readStoredPlannedMinutes(sessionId: string): number {
  try {
    const raw = window.sessionStorage.getItem(PLANNED_MINUTES_KEY);
    if (!raw) return 0;
    const parsed = JSON.parse(raw) as Record<string, number>;
    const v = parsed?.[sessionId];
    return typeof v === "number" && v > 0 ? v : 0;
  } catch {
    return 0;
  }
}

/** Lưu `plannedMinutes` cho 1 phiên (giữ tối đa 5 phiên gần nhất). */
function storePlannedMinutes(sessionId: string, minutes: number): void {
  if (!sessionId || minutes <= 0) return;
  try {
    const raw = window.sessionStorage.getItem(PLANNED_MINUTES_KEY);
    const parsed = raw
      ? (JSON.parse(raw) as Record<string, number>)
      : ({} as Record<string, number>);
    parsed[sessionId] = minutes;
    // Giữ 5 phiên gần nhất → tránh phình storage.
    const keys = Object.keys(parsed);
    if (keys.length > 5) {
      for (const k of keys.slice(0, keys.length - 5)) delete parsed[k];
    }
    window.sessionStorage.setItem(PLANNED_MINUTES_KEY, JSON.stringify(parsed));
  } catch {
    // sessionStorage bị chặn (private mode / quota) → bỏ qua, không sao.
  }
}

/** Xoá `plannedMinutes` đã lưu của 1 phiên. */
function clearStoredPlannedMinutes(sessionId: string): void {
  if (!sessionId) return;
  try {
    const raw = window.sessionStorage.getItem(PLANNED_MINUTES_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw) as Record<string, number>;
    delete parsed[sessionId];
    window.sessionStorage.setItem(PLANNED_MINUTES_KEY, JSON.stringify(parsed));
  } catch {
    // ignore
  }
}

/**
 * Hook quản lý phiên làm việc.
 *
 * @param enabled Chỉ bật khi user đã đăng nhập. Rất quan trọng — nếu gọi API
 *   lúc chưa có token, `apiFetch` nhận 401 → xoá token và redirect `/login`,
 *   làm hỏng cả trang public (landing/pricing).
 */
export function useFocusSession(enabled: boolean = true): UseFocusSessionResult {
  const [session, setSession] = useState<FocusCurrentResponse | null>(null);
  const [phase, setPhase] = useState<FocusSessionPhase>("idle");
  const [error, setError] = useState<string | null>(null);
  const [pendingConfirmation, setPendingConfirmation] =
    useState<FocusPendingConfirmationItem | null>(null);

  /**
   * Mốc đồng hồ: `elapsed` = số giây server đã tính, `at` = performance.now()
   * tại lúc nhận response. Chỉ đọc trong effect (không đọc lúc render).
   */
  const anchorRef = useRef<{ elapsed: number; at: number } | null>(null);
  /** Số giây đã làm — cập nhật mỗi giây trong effect tick. */
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  /**
   * Phút dự kiến của phiên hiện tại.
   *
   * ⚠️ `GET /api/focus/current` KHÔNG trả `plannedMinutes` — chỉ response của
   *   `POST /api/focus/start` có. Nên ta giữ riêng ở đây, và lấy từ
   *   `proposedMinutes` của slot khi cần dựng lại.
   */
  const [plannedMinutes, setPlannedMinutes] = useState(0);
  /** Chống set state sau unmount. */
  const alive = useRef(true);
  /** Callback báo các page biết slot đã đổi trạng thái (để refetch lịch). */
  const slotChangedRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  /**
   * Đặt mốc đồng hồ từ 1 response của server.
   *
   * `elapsedSeconds` là số giây server đã tính tới thời điểm gửi response.
   * Ta ghi nhớ `performance.now()` ngay lúc nhận → từ đó chạy đồng hồ đơn
   * điệu để cộng thêm thời gian trôi qua.
   */
  const anchorFromServer = useCallback((data: FocusCurrentResponse) => {
    anchorRef.current = {
      elapsed: data.elapsedSeconds,
      at: performance.now(),
    };
    setElapsedSeconds(data.elapsedSeconds);
  }, []);

  /** Nạp lại phiên đang chạy từ server. */
  const refresh = useCallback(async () => {
    if (!enabled) return;
    const res = await getCurrentFocusSession();
    if (!alive.current) return;
    if (!res.ok) {
      setError(res.error);
      return;
    }
    setError(null);
    setSession(res.data);
    if (res.data) {
      anchorFromServer(res.data);
      setPhase("running");
      // `/current` không trả `plannedMinutes` → lấy lại từ sessionStorage
      // (đã lưu lúc start) nếu có. Nếu không có (vd: phiên start ở tab
      // khác), trang lịch sẽ `seedPlannedMinutes` bổ sung.
      const stored = readStoredPlannedMinutes(res.data.sessionId);
      if (stored) setPlannedMinutes(stored);
    } else {
      anchorRef.current = null;
      setElapsedSeconds(0);
      setPhase("idle");
      setPlannedMinutes(0);
    }
  }, [enabled, anchorFromServer]);

  /** Nạp lại danh sách phiên chờ xác nhận (hệ thống tự ngắt). */
  const refreshPending = useCallback(async () => {
    if (!enabled) return;
    const res = await listPendingFocusConfirmations();
    if (!alive.current) return;
    if (!res.ok) return;
    // Lấy phiên mới nhất trước (BE đã sort sẵn).
    setPendingConfirmation(res.data[0] ?? null);
  }, [enabled]);

  /* ---------- Vòng đời: mount / unmount / resync / visibility ---------- */

  useEffect(() => {
    if (!enabled) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- data-fetch pattern
    void refresh();
    void refreshPending();

    // Resync định kỳ để đồng hồ không lệch dần.
    const resyncTimer = window.setInterval(() => {
      void refresh();
    }, RESYNC_MS);

    // Tab được focus lại → resync ngay (đồng hồ trình duyệt đã dừng khi
    // tab ẩn, nên cần lấy lại elapsedSeconds từ server).
    const onVisibility = () => {
      if (document.visibilityState === "visible") {
        void refresh();
        void refreshPending();
      }
    };
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      window.clearInterval(resyncTimer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [enabled, refresh, refreshPending]);

  /* ---------- Tick 1s: cập nhật đồng hồ đơn điệu ---------- */

  useEffect(() => {
    if (!enabled) return;
    const tickTimer = window.setInterval(() => {
      const anchor = anchorRef.current;
      if (!anchor) return;
      const drift = (performance.now() - anchor.at) / 1000;
      setElapsedSeconds(Math.max(0, Math.floor(anchor.elapsed + drift)));
    }, TICK_MS);
    return () => window.clearInterval(tickTimer);
  }, [enabled]);

  /* ---------- Đồng hồ (thuần từ state — không đụng ref lúc render) ---------- */

  const timer = useMemo<FocusTimerState | null>(() => {
    if (!session) return null;
    // plannedMinutes = 0 nghĩa là làm việc ngoài lịch → không có mốc.
    const plannedSeconds = plannedMinutes ? plannedMinutes * 60 : 0;
    const remainingSeconds = plannedSeconds ? plannedSeconds - elapsedSeconds : 0;

    return {
      elapsedSeconds,
      plannedMinutes,
      remainingSeconds,
      isOverrun: session.isOverrun === true || remainingSeconds < 0,
      progressPercent: plannedSeconds
        ? Math.min(100, (elapsedSeconds / plannedSeconds) * 100)
        : 0,
    };
  }, [session, plannedMinutes, elapsedSeconds]);

  /* ---------- Hành động ---------- */

  const start = useCallback(
    async (req: FocusStartRequest): Promise<StartFocusOutcome> => {
      if (!enabled) return { kind: "error", error: "Chưa đăng nhập." };
      setPhase("busy");
      setError(null);
      const res = await startFocusSession(req);
      if (!alive.current) return { kind: "error", error: "Đã hủy." };

      if (res.ok) {
        // `plannedMinutes` chỉ có ở response của start → lưu lại để vẽ mốc.
        // Đồng thời lưu vào sessionStorage để sau khi reload vẫn có mốc
        // (vì `/current` không trả field này).
        setPlannedMinutes(res.data.plannedMinutes ?? 0);
        storePlannedMinutes(res.data.sessionId, res.data.plannedMinutes ?? 0);
        // Cảnh báo bắt đầu sớm: phiên ĐÃ được tạo. Ta vẫn nạp nó vào state
        // để thanh đồng hồ hiện, nhưng báo UI để hỏi user có giữ không.
        if (res.data.warning === "STARTED_VERY_EARLY") {
          // Phải nạp phiên vào state: UI cần `sessionId` để gọi Stop nếu
          // user chọn "Không" (bỏ phiên).
          void refresh();
          setPhase("running");
          return { kind: "tooEarly", session: res.data };
        }
        // Đồng hồ dùng `elapsedSeconds` từ server — start trả `startedAt`
        // chứ không có elapsed, nên ta gọi /current cho chuẩn.
        void refresh();
        setPhase("running");
        return { kind: "started", data: res.data };
      }

      // 409 = đã có phiên đang chạy → chuyển sang phiên đó.
      if (res.status === 409) {
        const conflict = parseConflictSession(res.details);
        if (conflict) {
          setSession(conflict);
          anchorFromServer(conflict);
          setPhase("running");
          return { kind: "conflict", session: conflict };
        }
        // Không đọc được details → vẫn nạp lại từ server cho chắc.
        void refresh();
        return {
          kind: "conflict",
          session: {
            sessionId: "",
            taskId: "",
            taskTitle: null,
            scheduleSlotId: null,
            startedAt: new Date().toISOString(),
            elapsedSeconds: 0,
            serverTime: new Date().toISOString(),
            isOverrun: false,
          },
        };
      }

      setPhase(session ? "running" : "idle");
      setError(res.error);
      return { kind: "error", error: res.error };
    },
    [enabled, refresh, session, anchorFromServer],
  );

  const stop = useCallback(
    async (
      reason: FocusStopReason,
      note?: string | null,
      sessionId?: string,
    ): Promise<StopFocusOutcome> => {
      if (!enabled) return { kind: "error", error: "Chưa đăng nhập." };
      const targetId = sessionId ?? session?.sessionId;
      if (!targetId) return { kind: "error", error: "Không có phiên đang chạy." };

      setPhase("busy");
      setError(null);
      const res = await stopFocusSession(targetId, {
        stopReason: reason,
        note: note ?? null,
      });
      if (!alive.current) return { kind: "error", error: "Đã hủy." };

      if (res.ok) {
        // Slot đã đổi trạng thái (Done nếu Completed, về Due nếu lý do khác)
        // → các trang lịch cần refetch.
        slotChangedRef.current?.();
        setSession(null);
        anchorRef.current = null;
        setElapsedSeconds(0);
        setPlannedMinutes(0);
        clearStoredPlannedMinutes(targetId);
        setPhase("idle");
        return { kind: "stopped", data: res.data };
      }

      // 409 = phiên đã dừng trước đó (bấm 2 lần, hoặc 2 tab) → coi như OK.
      if (res.status === 409) {
        slotChangedRef.current?.();
        setSession(null);
        anchorRef.current = null;
        setElapsedSeconds(0);
        setPlannedMinutes(0);
        clearStoredPlannedMinutes(targetId);
        setPhase("idle");
        return { kind: "alreadyStopped" };
      }

      setPhase(session ? "running" : "idle");
      setError(res.error);
      return { kind: "error", error: res.error };
    },
    [enabled, session],
  );

  const confirm = useCallback(
    async (req: FocusConfirmRequest, sessionId?: string): Promise<boolean> => {
      if (!enabled) return false;
      const targetId = sessionId ?? pendingConfirmation?.sessionId;
      if (!targetId) return false;
      setPhase("busy");
      const res = await confirmFocusSession(targetId, req);
      if (!alive.current) return false;
      setPhase("idle");
      if (!res.ok) {
        setError(res.error);
        return false;
      }
      // Phiên đã xác nhận → không còn chờ nữa.
      setPendingConfirmation(null);
      // Slot có thể đổi trạng thái → refetch lịch.
      slotChangedRef.current?.();
      void refreshPending();
      return true;
    },
    [enabled, pendingConfirmation, refreshPending],
  );

  const selfReport = useCallback(
    async (req: FocusSelfReportRequest): Promise<boolean> => {
      if (!enabled) return false;
      setPhase("busy");
      setError(null);
      const res = await selfReportFocusSession(req);
      if (!alive.current) return false;
      setPhase("idle");
      if (!res.ok) {
        setError(res.error);
        return false;
      }
      slotChangedRef.current?.();
      void refreshPending();
      return true;
    },
    [enabled, refreshPending],
  );

  const dismissPending = useCallback(() => {
    setPendingConfirmation(null);
  }, []);

  /**
   * Cung cấp phút dự kiến cho phiên hiện tại khi ta chưa biết.
   *
   * Dùng khi phiên được nạp từ `/current` sau khi reload trang (BE không trả
   * `plannedMinutes` ở đó). Trang lịch gọi hàm này với `proposedMinutes` của
   * slot tương ứng.
   */
  const seedPlannedMinutes = useCallback((minutes: number) => {
    if (!minutes || minutes <= 0) return;
    setPlannedMinutes((prev) => (prev > 0 ? prev : minutes));
    // Lưu luôn để reload vẫn giữ được mốc.
    const id = session?.sessionId;
    if (id) storePlannedMinutes(id, minutes);
  }, [session?.sessionId]);

  /**
   * Đăng ký callback được gọi khi slot đổi trạng thái — trang lịch dùng để
   * refetch. Trả về hàm để huỷ đăng ký.
   */
  const onSlotChanged = useCallback((fn: () => void) => {
    slotChangedRef.current = fn;
    return () => {
      if (slotChangedRef.current === fn) slotChangedRef.current = null;
    };
  }, []);

  return {
    session,
    phase,
    busy: phase === "busy",
    timer,
    error,
    pendingConfirmation,
    refresh,
    start,
    stop,
    confirm,
    selfReport,
    refreshPending,
    dismissPending,
    seedPlannedMinutes,
    onSlotChanged,
  };
}
