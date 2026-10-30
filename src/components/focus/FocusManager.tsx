import { useCallback, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import {
  getTask,
  listSubtasks,
  markSubtaskDone,
  markTaskDone,
  type FocusSelfReportRequest,
  type FocusStartRequest,
  type FocusStopReason,
} from "../../lib/api-client";
import { useFocusSession } from "../../hooks/useFocusSession";
import { CenterToasts, useCenterToast } from "../Toast";
import {
  CheckInDialog,
  ConfirmTimeoutDialog,
  EarlyWarningDialog,
  MarkDoneDialog,
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
  | "selfReport"
  /**
   * Hỏi "Đánh dấu subtask này là xong?" sau khi Stop `Completed`.
   *
   * BẮT BUỘC theo spec mục E — Stop `Completed` chỉ làm slot thành `Done`,
   * KHÔNG đánh dấu task/subtask xong.
   */
  | "markSubtaskDone"
  /** Hỏi "Đánh dấu cả task là xong?" (khi mọi subtask đã xong). */
  | "markTaskDone";

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
  /**
   * Subtask của phiên vừa dừng với lý do `Completed` (null = phiên task-only).
   *
   * Cần cho hộp thoại "Đánh dấu subtask này là xong?" (spec mục E).
   */
  const [pendingSubTaskId, setPendingSubTaskId] = useState<string | null>(null);
  /** Task cha của subtask vừa dừng — để hỏi "đánh dấu cả task?" tiếp theo. */
  const [pendingTaskId, setPendingTaskId] = useState<string | null>(null);
  /**
   * Tên subtask của phiên đang chạy (để hiện trên thanh đồng hồ).
   *
   * `GET /api/focus/current` không trả `subTaskId`/`subTaskTitle` (spec mục 8.1)
   * → ta tự nhớ id rồi tra tên từ `GET /api/tasks/{taskId}/subtasks`.
   *
   * Lưu kèm `subTaskId` để tránh hiện tên của subtask cũ khi đổi phiên:
   * giá trị hiển thị được **derive** (không setState trong effect).
   */
  const [subTaskTitleState, setSubTaskTitleState] = useState<{
    subTaskId: string;
    title: string;
  } | null>(null);

  /* ---------- Tra tên subtask của phiên đang chạy ---------- */

  useEffect(() => {
    const subTaskId = focus.currentSubTaskId;
    const taskId = focus.session?.taskId;
    if (!subTaskId || !taskId) return;
    let cancelled = false;
    void (async () => {
      const res = await listSubtasks(taskId);
      if (cancelled) return;
      if (!res.ok) return;
      const title = res.data.find((s) => s.id === subTaskId)?.title;
      if (!title) return;
      setSubTaskTitleState({ subTaskId, title });
    })();
    return () => {
      cancelled = true;
    };
  }, [focus.currentSubTaskId, focus.session?.taskId]);

  /** Chỉ hiện khi `subTaskId` khớp đúng phiên đang chạy. */
  const currentSubTaskTitle =
    subTaskTitleState && subTaskTitleState.subTaskId === focus.currentSubTaskId
      ? subTaskTitleState.title
      : null;

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
      currentSubTaskId: focus.currentSubTaskId,
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
      focus.currentSubTaskId,
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
   * Theo spec mục 5.1: "nếu người dùng bấm 'Không' thì gọi Stop ngay."
   *
   * ⚠️ `stop` trả về `subTaskId` của phiên vừa dừng → không hỏi đánh dấu
   * xong (vì user chủ động bỏ phiên, không phải hoàn thành).
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

  /**
   * Gửi lý do dừng lên BE.
   *
   * Sau khi stop thành công, theo spec mục E ta hỏi tiếp:
   *  1. Nếu phiên là của 1 **subtask** → "Đánh dấu subtask này là xong?"
   *     → `PUT /api/subtasks/{id}` với **đủ** trường (spec mục 6.3).
   *  2. Nếu mọi subtask của task đã `Done` → "Đánh dấu cả task là xong?"
   *     → `PUT /api/tasks/{id}` với **đủ** trường.
   *
   * ⚠️ `checkInRequired` (BE gợi ý hỏi "xong chưa / thấy thế nào") và
   * hộp thoại đánh dấu xong là 2 việc KHÁC NHAU:
   *   • check-in = thu thập cảm nhận (BE **chưa** có API lưu → chỉ hiển thị).
   *   • đánh dấu xong = `PUT` thật, có tác động lên DB + AI học K_bias.
   */
  const confirmStop = useCallback(
    async (reason: FocusStopReason, note: string | null) => {
      const taskTitle = focus.session?.taskTitle ?? null;
      const taskId = focus.session?.taskId ?? null;
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

      /*
       * Hỏi đánh dấu xong — CHỈ khi lý do là `Completed` và có subtask.
       * (Spec mục 6.2: "Trạng thái subtask và task không đổi sau Stop".)
       */
      if (reason === "Completed" && res.subTaskId) {
        setPendingSubTaskId(res.subTaskId);
        setPendingTaskId(taskId);
        setDialog("markSubtaskDone");
        return;
      }

      // BE yêu cầu hỏi thêm khi Completed/Other.
      if (data.checkInRequired) {
        setCheckInTaskTitle(taskTitle);
        setCheckInMinutes(data.sessionMinutes);
        setDialog("checkIn");
      }
    },
    [focus, toast],
  );

  /**
   * Đánh dấu subtask vừa dừng là `Done` → `PUT /api/subtasks/{id}`.
   *
   * `PUT` thay thế toàn bộ → ta gửi **đủ** trường (spec mục 6.3), lấy từ
   * `GET /api/tasks/{taskId}/subtasks`.
   */
  const confirmMarkSubtaskDone = useCallback(async () => {
    const subTaskId = pendingSubTaskId;
    const taskId = pendingTaskId;
    setDialog("none");
    if (!subTaskId || !taskId) return;

    const res = await listSubtasks(taskId);
    if (!res.ok) {
      toast.error("Không đánh dấu được", res.error);
      return;
    }
    const sub = res.data.find((s) => s.id === subTaskId);
    if (!sub) {
      toast.error("Không tìm thấy subtask");
      return;
    }
    const put = await markSubtaskDone(sub);
    if (!put.ok) {
      toast.error("Không đánh dấu được subtask", put.error);
      return;
    }
    toast.success("Đã đánh dấu subtask là xong");

    // Nếu mọi subtask của task đã xong → hỏi tiếp "đánh dấu cả task?".
    const all = res.data.map((s) =>
      s.id === subTaskId ? { ...s, status: "Done" } : s,
    );
    const allDone = all.every((s) => {
      const st = (s.status ?? "").toLowerCase();
      return st === "done" || st === "completed";
    });
    if (allDone && all.length > 0) {
      setDialog("markTaskDone");
    }
  }, [pendingSubTaskId, pendingTaskId, toast]);

  /** Đánh dấu cả task là `Done` → `PUT /api/tasks/{id}` (đủ trường). */
  const confirmMarkTaskDone = useCallback(async () => {
    const taskId = pendingTaskId;
    setDialog("none");
    if (!taskId) return;

    const res = await getTask(taskId);
    if (!res.ok) {
      toast.error("Không đánh dấu được", res.error);
      return;
    }
    const put = await markTaskDone(res.data);
    if (!put.ok) {
      toast.error("Không đánh dấu được task", put.error);
      return;
    }
    toast.success("Đã đánh dấu task là xong");
  }, [pendingTaskId, toast]);

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
            subTaskTitle={currentSubTaskTitle}
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

        {/* ----- Hộp thoại: đánh dấu subtask xong -----
            BẮT BUỘC theo spec mục E: Stop `Completed` chỉ làm slot thành
            `Done`, KHÔNG tự đánh dấu task/subtask xong. */}
        {activeDialog === "markSubtaskDone" && (
          <MarkDoneDialog
            kind="subtask"
            title={focus.session?.taskTitle ?? null}
            onConfirm={() => void confirmMarkSubtaskDone()}
            onSkip={() => {
              setPendingSubTaskId(null);
              setPendingTaskId(null);
              setDialog("none");
            }}
            busy={busy}
          />
        )}

        {/* ----- Hộp thoại: đánh dấu cả task xong ----- */}
        {activeDialog === "markTaskDone" && (
          <MarkDoneDialog
            kind="task"
            title={focus.session?.taskTitle ?? null}
            onConfirm={() => void confirmMarkTaskDone()}
            onSkip={() => {
              setPendingSubTaskId(null);
              setPendingTaskId(null);
              setDialog("none");
            }}
            busy={busy}
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
