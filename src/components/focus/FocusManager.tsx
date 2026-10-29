import { useCallback, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import type {
  FocusSelfReportRequest,
  FocusStartRequest,
  FocusStopReason,
} from "../../lib/api-client";
import { useFocusSession } from "../../hooks/useFocusSession";
import { CenterToasts, useCenterToast } from "../Toast";
import {
  CheckInDialog,
  ConfirmTimeoutDialog,
  EarlyWarningDialog,
  SelfReportDialog,
  StopReasonDialog,
} from "./FocusDialogs";
import { FocusTimerBar } from "./FocusTimerBar";
import { FocusActionsProvider, type FocusActions } from "./focus-context";
import { useNotificationsContext } from "./notifications-context-state";
import "./focus.css";

/**
 * ===========================================================
 * <FocusManager> — điều phối toàn bộ UI Focus Session.
 * ===========================================================
 *
 * Đặt 1 lần ở SiteLayout (cấp cao nhất của app đã đăng nhập) vì:
 *  - Phiên làm việc là trạng thái toàn cục (bắt đầu ở /schedule, đóng tab,
 *    mở lại /dashboard vẫn phải thấy đồng hồ).
 *  - Thanh đồng hồ fixed đáy màn hình phải hiện ở MỌI trang.
 *
 * Nó lo:
 *  1. Thanh đồng hồ global (khi có phiên chạy).
 *  2. Hộp thoại Stop (chọn lý do) — mở từ thanh đồng hồ.
 *  3. Hộp thoại "bắt đầu sớm" — sau khi start trả warning.
 *  4. Hộp thoại xác nhận phiên bị hệ thống tự ngắt.
 *  5. Hộp thoại check-in sau khi stop (nếu BE yêu cầu).
 *  6. Hộp thoại self-report (quên bấm Start).
 *
 * Các hành động cho trang lịch gọi qua `useFocusActions()` (focus-context).
 * =========================================================== */

/** Loại hộp thoại đang mở. */
type DialogKind =
  | "none"
  /** Hỏi lý do dừng. */
  | "stop"
  /** Cảnh báo bắt đầu sớm — cần giữ hay bỏ phiên. */
  | "earlyWarning"
  /** Xác nhận phiên bị hệ thống tự ngắt. */
  | "confirmTimeout"
  /** Hỏi "xong chưa?" sau khi stop. */
  | "checkIn"
  /** Khai báo giờ đã làm việc. */
  | "selfReport";

export interface FocusManagerProps {
  /** true khi user đã đăng nhập — tắt hoàn toàn khi false. */
  enabled: boolean;
  /**
   * Task được chọn sẵn cho hộp thoại self-report (danh sách task của user).
   * Mỗi item: { id, title }.
   */
  selfReportTasks?: Array<{ id: string; title: string }>;
  /**
   * Nội dung trang (thường là `<Outlet />`).
   *
   * ⚠️ Bắt buộc: `<FocusActionsProvider>` phải bao quanh TRANG CON, vì nút
   * Start/Stop của slot nằm ở trang `/schedule` và gọi `useFocusActions()`.
   * Nếu provider chỉ bọc thanh đồng hồ, trang lịch sẽ ném lỗi
   * "must be used within a <FocusActionsProvider>".
   */
  children?: ReactNode;
}

export function FocusManager({
  enabled,
  selfReportTasks = [],
  children,
}: FocusManagerProps) {
  const [toasts, toast] = useCenterToast();
  const focus = useFocusSession(enabled);
  /**
   * Thông báo realtime (SignalR) — dùng chung instance với header để chỉ có
   * 1 hub connection cho toàn app.
   */
  const notif = useNotificationsContext();

  const [dialog, setDialog] = useState<DialogKind>("none");
  /** Số phút bắt đầu sớm (cho hộp thoại early warning). */
  const [earlyMinutes, setEarlyMinutes] = useState(0);
  /**
   * `sessionId` của phiên bắt đầu sớm.
   *
   * Lưu riêng vì `focus.session` chỉ được nạp sau `GET /current` (bất đồng bộ),
   * nên khi user bấm "Không" ngay lập tức thì state chưa kịp có phiên.
   */
  const [earlySessionId, setEarlySessionId] = useState<string | null>(null);
  /** Task đang chọn trong hộp thoại self-report. */
  const [selfReportTaskId, setSelfReportTaskId] = useState<string>("");
  /** Task dùng cho check-in (sau khi stop). */
  const [checkInTaskTitle, setCheckInTaskTitle] = useState<string | null>(null);
  const [checkInMinutes, setCheckInMinutes] = useState(0);

  /* ---------- Gọi lại API khi có thông báo realtime ---------- */

  /**
   * Theo spec (mục 2.2): `GET /api/focus/current` phải được gọi **sau mỗi
   * thông báo SignalR** — vì server có thể vừa tự ngắt phiên (AUTO_TIMEOUT)
   * hoặc vừa đánh dấu slot. Nếu không gọi lại, đồng hồ và trạng thái slot
   * sẽ cũ.
   *
   * `onSignal` đăng ký callback và trả về hàm huỷ đăng ký → ta huỷ khi
   * unmount (hoặc khi `enabled` đổi).
   */
  useEffect(() => {
    if (!enabled) return;
    // Destructure ra biến cục bộ → dependency ổn định, không bị ESLint
    // báo thiếu `focus`.
    const { refresh, refreshPending } = focus;
    return notif.onSignal(() => {
      void refresh();
      void refreshPending();
    });
  }, [enabled, notif, focus]);

  /* ---------- Hành động cho UI bên ngoài (nút Start trên lịch) ---------- */

  /**
   * Bắt đầu phiên — tự xử lý 3 trường hợp đặc biệt theo spec:
   *  - 409 (đã có phiên chạy) → chuyển sang phiên đó, KHÔNG báo lỗi đỏ.
   *  - warning STARTED_VERY_EARLY → mở hộp thoại hỏi user có giữ không.
   *  - startedEarlyMinutes > 0 → toast nhẹ "bắt đầu sớm X phút".
   */
  const handleStart = useCallback(
    async (req: FocusStartRequest) => {
      const res = await focus.start(req);
      if (res.kind === "error") {
        toast.error("Không bắt đầu được", res.error);
        return;
      }
      if (res.kind === "conflict") {
        toast.info(
          "Đang có phiên khác chạy",
          res.session.taskTitle ?? "Chuyển sang phiên đang chạy",
        );
        return;
      }
      if (res.kind === "tooEarly") {
        setEarlyMinutes(res.session.startedEarlyMinutes ?? 0);
        // Lưu lại id phiên để "Không" → Stop được ngay, không phụ thuộc
        // `GET /current` đã trả về hay chưa.
        setEarlySessionId(res.session.sessionId);
        setDialog("earlyWarning");
        return;
      }
      if (res.data.startedEarlyMinutes > 0) {
        toast.info(
          "Bắt đầu sớm",
          `Bạn bắt đầu sớm ${res.data.startedEarlyMinutes} phút so với lịch`,
        );
      } else {
        toast.success("Đã bắt đầu phiên làm việc");
      }
    },
    [focus, toast],
  );
  const openStopDialog = useCallback(() => {
    setDialog("stop");
  }, []);

  const openSelfReportDialog = useCallback((taskId?: string) => {
    if (taskId) setSelfReportTaskId(taskId);
    setDialog("selfReport");
  }, []);

  const actions = useMemo<FocusActions>(
    () => ({
      start: handleStart,
      openStopDialog,
      openSelfReportDialog,
      busy: focus.busy,
      selfReportTaskId,
      setSelfReportTaskId,
      selfReportTasks,
      currentSlotId: focus.session?.scheduleSlotId ?? null,
      hasActiveSession: !!focus.session,
      plannedMinutes: focus.timer?.plannedMinutes ?? 0,
      seedPlannedMinutes: focus.seedPlannedMinutes,
      onSlotChanged: focus.onSlotChanged,
    }),
    [
      handleStart,
      openStopDialog,
      openSelfReportDialog,
      focus.busy,
      focus.session,
      focus.timer?.plannedMinutes,
      focus.seedPlannedMinutes,
      focus.onSlotChanged,
      selfReportTaskId,
      selfReportTasks,
    ],
  );

  /* ---------- Giữ phiên bắt đầu sớm ---------- */

  const keepEarlySession = useCallback(() => {
    setDialog("none");
    setEarlySessionId(null);
    toast.success("Đã bắt đầu phiên làm việc");
  }, [toast]);

  /**
   * Bỏ phiên bắt đầu sớm → gọi Stop ngay với lý do `Interrupted`.
   *
   * Theo spec: "Nếu người dùng bấm 'Không', gọi Stop ngay."
   */
  const discardEarlySession = useCallback(async () => {
    // Ưu tiên id đã lưu lúc start; fallback sang phiên hiện tại.
    const sessionId = earlySessionId ?? focus.session?.sessionId;
    setDialog("none");
    setEarlySessionId(null);
    if (!sessionId) return;
    const res = await focus.stop("Interrupted", null, sessionId);
    if (res.kind === "stopped" || res.kind === "alreadyStopped") {
      toast.info("Đã bỏ phiên làm việc");
    } else {
      toast.error(
        "Không bỏ được phiên",
        res.kind === "error" ? res.error : undefined,
      );
    }
  }, [focus, toast, earlySessionId]);

  /* ---------- Gửi lý do dừng ---------- */

  const confirmStop = useCallback(
    async (reason: FocusStopReason, note: string | null) => {
      const taskTitle = focus.session?.taskTitle ?? null;
      const res = await focus.stop(reason, note);
      setDialog("none");
      if (res.kind === "error") {
        toast.error("Không dừng được phiên", res.error);
        return;
      }
      if (res.kind === "alreadyStopped") {
        toast.info("Phiên này đã dừng trước đó");
        return;
      }
      const data = res.data;
      toast.success(
        "Đã dừng phiên",
        `Phiên này ${data.sessionMinutes.toFixed(1)} phút · tổng task ${data.taskTotalMinutes.toFixed(1)} phút`,
      );
      // BE yêu cầu hỏi thêm khi Completed/Other.
      if (data.checkInRequired) {
        setCheckInTaskTitle(taskTitle);
        setCheckInMinutes(data.sessionMinutes);
        setDialog("checkIn");
      }
    },
    [focus, toast],
  );

  /* ---------- Xác nhận phiên bị tự ngắt ---------- */

  const confirmTimeout = useCallback(
    async (correctedMinutes: number | null) => {
      const item = focus.pendingConfirmation;
      if (!item) return;
      const ok = await focus.confirm({
        confirmed: true,
        correctedMinutes: correctedMinutes ?? null,
      });
      setDialog("none");
      if (ok) {
        toast.success(
          "Đã xác nhận phiên",
          correctedMinutes
            ? `Ghi nhận ${correctedMinutes} phút`
            : `Ghi nhận ${item.systemMinutes} phút`,
        );
      } else {
        toast.error("Không xác nhận được phiên");
      }
    },
    [focus, toast],
  );

  const discardTimeout = useCallback(async () => {
    const ok = await focus.confirm({ confirmed: false });
    setDialog("none");
    if (ok) toast.info("Đã bỏ phiên bị tự ngắt");
    else toast.error("Không bỏ được phiên");
  }, [focus, toast]);

  /* ---------- Self report ---------- */

  const submitSelfReport = useCallback(
    async (minutes: number, note: string | null) => {
      const taskId = selfReportTaskId;
      if (!taskId) {
        toast.error("Chọn task trước khi ghi nhận");
        return;
      }
      const now = Date.now();
      const endedAt = new Date(now).toISOString();
      const startedAt = new Date(now - minutes * 60_000).toISOString();
      const body: FocusSelfReportRequest = {
        taskId,
        scheduleSlotId: null,
        startedAt,
        endedAt,
        stopReason: "Completed",
        note,
      };
      const ok = await focus.selfReport(body);
      setDialog("none");
      if (ok) toast.success("Đã ghi nhận thời gian làm việc");
      else toast.error("Không ghi nhận được", focus.error ?? undefined);
    },
    [selfReportTaskId, focus, toast],
  );

  const { session, timer, busy, pendingConfirmation } = focus;

  /**
   * Thanh đồng hồ là `position: fixed` ở đáy màn hình → nó che nội dung
   * trang (VD: các ô lịch ở hàng cuối, nút trong bảng).
   *
   * Ta gắn 1 class lên `<body>` khi thanh đồng hồ đang hiện, để CSS của
   * layout (`site-layout.css`) thêm `padding-bottom` cho vùng nội dung.
   */
  useEffect(() => {
    if (!session) return;
    document.body.classList.add("has-focus-bar");
    return () => {
      document.body.classList.remove("has-focus-bar");
    };
  }, [session]);

  /**
   * Mở hộp thoại xác nhận phiên bị tự ngắt.
   *
   * Thay vì dùng effect để setState (React Compiler cấm), ta tính trực
   * tiếp `dialog` cần hiển thị: nếu user chưa mở hộp thoại nào và có phiên
   * chờ xác nhận → hiện hộp thoại confirmTimeout.
   */
  const activeDialog: DialogKind =
    dialog !== "none"
      ? dialog
      : pendingConfirmation
        ? "confirmTimeout"
        : "none";

  /* ---------- Render ---------- */

  return (
    /*
     * Provider bao quanh CẢ children lẫn UI focus:
     *   • `children` (trang con, vd `/schedule`) dùng `useFocusActions()`.
     *   • Thanh đồng hồ + hộp thoại nằm cùng provider để không cần context
     *     riêng.
     */
    <FocusActionsProvider value={actions}>
      {children}

      <div className="fc-root">
        {/* ----- Thanh đồng hồ ----- */}
        {session && timer && (
          <FocusTimerBar
            taskTitle={session.taskTitle}
            elapsedSeconds={timer.elapsedSeconds}
            plannedMinutes={timer.plannedMinutes}
            remainingSeconds={timer.remainingSeconds}
            isOverrun={timer.isOverrun}
            progressPercent={timer.progressPercent}
            busy={busy}
            onStop={openStopDialog}
          />
        )}

        {/* ----- Hộp thoại: chọn lý do dừng ----- */}
        {activeDialog === "stop" && (
          <StopReasonDialog
            taskTitle={session?.taskTitle ?? null}
            elapsedSeconds={timer?.elapsedSeconds ?? 0}
            onConfirm={(reason, note) => void confirmStop(reason, note)}
            onClose={() => setDialog("none")}
            busy={busy}
          />
        )}

        {/* ----- Hộp thoại: bắt đầu sớm ----- */}
        {activeDialog === "earlyWarning" && (
          <EarlyWarningDialog
            startedEarlyMinutes={earlyMinutes}
            taskTitle={session?.taskTitle ?? null}
            onKeep={keepEarlySession}
            onDiscard={() => void discardEarlySession()}
            busy={busy}
          />
        )}

        {/* ----- Hộp thoại: xác nhận phiên bị tự ngắt ----- */}
        {activeDialog === "confirmTimeout" && pendingConfirmation && (
          <ConfirmTimeoutDialog
            item={pendingConfirmation}
            onConfirm={(m) => void confirmTimeout(m)}
            onDiscard={() => void discardTimeout()}
            onClose={() => {
              focus.dismissPending();
              setDialog("none");
            }}
            busy={busy}
          />
        )}

        {/* ----- Hộp thoại: check-in ----- */}
        {activeDialog === "checkIn" && (
          <CheckInDialog
            taskTitle={checkInTaskTitle}
            sessionMinutes={checkInMinutes}
            onClose={() => setDialog("none")}
          />
        )}

        {/* ----- Hộp thoại: self-report ----- */}
        {activeDialog === "selfReport" && (
          <SelfReportDialog
            taskTitle={
              selfReportTasks.find((t) => t.id === selfReportTaskId)?.title ??
              null
            }
            tasks={selfReportTasks}
            selectedTaskId={selfReportTaskId}
            onSelectTask={setSelfReportTaskId}
            onSubmit={(m, n) => void submitSelfReport(m, n)}
            onClose={() => setDialog("none")}
            busy={busy}
          />
        )}

        <CenterToasts toasts={toasts} onDismiss={toast.dismiss} />
      </div>
    </FocusActionsProvider>
  );
}
