import { useCallback, useEffect, useMemo, useState } from "react";
import {
  getScheduleSlot,
  updateScheduleSlot,
  type ScheduleSlotDto,
} from "../../lib/api-client";
import { describeSlotOverlapError } from "./slot-overlap";
import { DateTimePicker } from "./DateTimePicker";
import { isAnyDateTimePickerOpen } from "./date-time-picker-registry";
import {
  planSlotStatusOnEdit,
  slotStatusDisplayLabel,
} from "./slot-status-rules";
import { AlertDialog } from "./AlertDialog";
import "./edit-slot-dialog.css";

/**
 * ===========================================================
 * <EditSlotDialog> — sửa thông tin 1 schedule slot
 * ===========================================================
 *
 * Luồng 3 bước (KHÔNG ghi thẳng ra API):
 *   1. Mở dialog → gọi `GET /api/schedule-slots/{slotId}` để lấy DTO slot đầy
 *      đủ (ở `/schedule` dữ liệu lịch đến từ `GET /api/calendar` nên không có
 *      sẵn `scheduleSlot`).
 *   2. User chỉnh form → bấm "Review changes" → hiện **pop-up xác nhận**
 *      tóm tắt thay đổi (tiếng Anh) → bấm "Apply changes".
 *   3. Mới gọi `PUT /api/schedule-slots/{slotId}`.
 *
 * Lỗi (409 `SLOT_OVERLAP` hoặc lỗi chung) → hiện **pop-up báo lỗi** tiếng
 * Anh dễ hiểu, KHÔNG đóng dialog để user sửa tiếp.
 */
export function EditSlotDialog({
  slotId,
  open,
  onClose,
  onSaved,
}: {
  /** Id của slot cần sửa (`null` = đóng). */
  slotId: string | null;
  open: boolean;
  onClose: () => void;
  /** Gọi sau khi PUT thành công → cha refetch lịch. */
  onSaved?: () => void;
}) {
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [slot, setSlot] = useState<ScheduleSlotDto | null>(null);

  /* ---- Form state ---- */
  const [startAt, setStartAt] = useState<Date | null>(null);
  const [endAt, setEndAt] = useState<Date | null>(null);
  const [explanation, setExplanation] = useState("");
  const [isManualOverride, setIsManualOverride] = useState(true);

  /**
   * Bước 2 — pop-up xác nhận.
   *
   * `null` = chưa bấm "Review changes" (đang ở màn nhập liệu).
   * Khác null = đang hiện pop-up xác nhận, kèm tóm tắt thay đổi.
   *
   * `newStatus` = trạng thái sẽ gửi lên BE; `null` = KHÔNG gửi `status`
   * (BE giữ trạng thái hiện tại — máy tự quản lý).
   */
  const [confirming, setConfirming] = useState<null | {
    startTime: string;
    endTime: string;
    newStatus: "Approved" | null;
    explanation: string | null;
    isManualOverride: boolean;
  }>(null);

  /** Lỗi hiển thị bằng pop-up (tiếng Anh). */
  const [alert, setAlert] = useState<{
    title: string;
    message: string;
    tone: "error" | "warn" | "success";
  } | null>(null);

  /**
   * Kế hoạch trạng thái khi sửa — tính từ trạng thái HIỆN TẠI của slot.
   *
   * - `set`  → sau khi sửa giờ, slot tự thành `Approved`.
   * - `keep` → không gửi `status`, máy tự quản lý.
   * - `block` → đang có phiên làm việc chạy → không cho sửa.
   */
  const statusPlan = useMemo(
    () => planSlotStatusOnEdit(slot?.status),
    [slot?.status],
  );

  /** Định dạng giờ đọc dễ hiểu: "Sat, Nov 28 · 09:30". */
  const formatMoment = useCallback((iso: string) => {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "—";
    return d.toLocaleString(undefined, {
      weekday: "short",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  }, []);

  /* ---- Load slot khi mở ---- */
  useEffect(() => {
    if (!open || !slotId) return;
    let cancelled = false;
    setLoading(true);
    setAlert(null);
    setConfirming(null);
    void (async () => {
      const res = await getScheduleSlot(slotId);
      if (cancelled) return;
      setLoading(false);
      if (!res.ok) {
        setAlert({
          title: "Couldn't open this slot",
          message:
            res.error ??
            "We couldn't load the details of this time block. Please try again in a moment.",
          tone: "error",
        });
        setSlot(null);
        return;
      }
      const s = res.data;
      setSlot(s);
      setStartAt(new Date(s.startTime));
      setEndAt(new Date(s.endTime));
      setExplanation(s.explanation ?? "");
      setIsManualOverride(s.isManualOverride ?? true);
    })();
    return () => {
      cancelled = true;
    };
  }, [open, slotId]);

  /** Lỗi validate cục bộ (trước khi gọi API). */
  const validationError = useMemo(() => {
    if (!startAt || !endAt) {
      return "Please choose both a start time and an end time for this time block.";
    }
    const start = startAt.getTime();
    const end = endAt.getTime();
    if (!Number.isFinite(start) || !Number.isFinite(end)) {
      return "Please choose both a start time and an end time for this time block.";
    }
    if (end <= start) {
      return "The end time needs to be later than the start time.";
    }
    return null;
  }, [startAt, endAt]);

  /**
   * Bước 2 — bấm "Review changes" → validate rồi mở pop-up xác nhận.
   * CHƯA gọi API.
   */
  const handleReview = useCallback(() => {
    if (statusPlan.mode === "block") {
      setAlert({
        title: "Can't move this time block yet",
        message: statusPlan.reason,
        tone: "warn",
      });
      return;
    }
    if (validationError) {
      setAlert({
        title: "Check the time block",
        message: validationError,
        tone: "warn",
      });
      return;
    }
    if (!startAt || !endAt) {
      setAlert({
        title: "Check the time block",
        message:
          "Please choose both a start time and an end time for this time block.",
        tone: "warn",
      });
      return;
    }
    setConfirming({
      startTime: startAt.toISOString(),
      endTime: endAt.toISOString(),
      // `null` = không gửi `status` → BE giữ trạng thái hiện tại.
      newStatus:
        statusPlan.mode === "set" ? statusPlan.status : null,
      explanation: explanation.trim() ? explanation.trim() : null,
      isManualOverride,
    });
  }, [
    validationError,
    statusPlan,
    startAt,
    endAt,
    explanation,
    isManualOverride,
  ]);

  /**
   * Bước 3 — xác nhận → gọi `PUT /api/schedule-slots/{slotId}`.
   */
  const handleApply = useCallback(async () => {
    if (!slotId || !confirming) return;
    setSaving(true);
    const res = await updateScheduleSlot(slotId, {
      startTime: confirming.startTime,
      endTime: confirming.endTime,
      /*
       * ⚠️ KHÔNG gửi `status` khi `newStatus = null` → BE giữ trạng thái
       * hiện tại (trạng thái do máy tự quản lý).
       */
      ...(confirming.newStatus ? { status: confirming.newStatus } : {}),
      explanation: confirming.explanation,
      isManualOverride: confirming.isManualOverride,
    });
    setSaving(false);
    if (!res.ok) {
      const overlapMsg = describeSlotOverlapError(res);
      setConfirming(null);
      setAlert({
        title: overlapMsg ? "That time is already taken" : "Couldn't save your changes",
        message: overlapMsg
          ? `${overlapMsg} The time block was not changed.`
          : `${res.error ?? "Something went wrong on our side."} The time block was not changed, so you can try again.`,
        tone: "error",
      });
      return;
    }
    setConfirming(null);
    onSaved?.();
    onClose();
  }, [slotId, confirming, onSaved, onClose]);
  /*
   * Đóng bằng Escape (trừ khi đang lưu).
   *
   * ⚠️ Nếu popover chọn ngày/giờ đang mở → Escape chỉ đóng popover đó,
   * KHÔNG đóng modal cha (registry đếm số picker đang mở).
   */
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key !== "Escape" || saving) return;
      if (isAnyDateTimePickerOpen()) return;
      setConfirming(null);
      onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, saving, onClose]);

  if (!open || !slotId) return null;

  return (
    <>
      <div
        className="sch-modal sch-modal--edit"
        role="presentation"
        onMouseDown={(e) => {
          if (e.target === e.currentTarget && !saving) onClose();
        }}
      >
        <div
          className="sch-modal__panel sch-modal__panel--edit"
          role="dialog"
          aria-modal="true"
          aria-label="Edit slot"
        >
          <div className="sch-modal__head">
            <div>
              <span className="sch-card__eyebrow">Edit slot</span>
              <h2 className="sch-card__title">Reschedule this time block</h2>
            </div>
            <button
              type="button"
              className="sch-icon-btn"
              aria-label="Close"
              onClick={onClose}
              disabled={saving}
            >
              <span className="material-symbols-outlined">close</span>
            </button>
          </div>

          {loading && (
            <div className="sch-edit__state" role="status">
              <span className="material-symbols-outlined sch-state-icon sch-state-icon--spin">
                progress_activity
              </span>
              <p>Loading slot…</p>
            </div>
          )}

          {!loading && (
            <form
              className="sch-edit__form"
              onSubmit={(e) => {
                e.preventDefault();
                handleReview();
              }}
            >
              {slot && (
                <div className="sch-edit__meta">
                  <span>
                    <strong>Status</strong>{" "}
                    {slotStatusDisplayLabel(slot.status)}
                  </span>
                  <span>
                    <strong>Planned</strong>{" "}
                    {slot.proposedMinutes > 0 ? `${slot.proposedMinutes}m` : "—"}
                  </span>
                  {slot.kbiasUsed > 0 && (
                    <span>
                      <strong>KBias</strong> {slot.kbiasUsed}%
                    </span>
                  )}
                  {slot.googleEventId && (
                    <span>
                      <strong>Google</strong>{" "}
                      {slot.syncFailed ? "sync failed" : "synced"}
                    </span>
                  )}
                </div>
              )}

              {/*
                ⚠️ Slot đang có phiên làm việc chạy → KHÔNG cho sửa giờ
                (sửa giữa chừng sẽ làm đồng hồ focus lệch).
              */}
              {statusPlan.mode === "block" && (
                <div className="sch-edit__blocked" role="status">
                  <span className="material-symbols-outlined sch-icon-16">
                    play_circle
                  </span>
                  <span>{statusPlan.reason}</span>
                </div>
              )}
              <DateTimePicker
                label="Starts"
                value={startAt}
                disabled={statusPlan.mode === "block"}
                onChange={setStartAt}
              />

              <DateTimePicker
                label="Ends"
                value={endAt}
                disabled={statusPlan.mode === "block"}
                onChange={setEndAt}
              />

              <label className="sch-edit__field sch-edit__field--full">
                <span className="sch-edit__label">Explanation</span>
                <textarea
                  className="sch-edit__input sch-edit__textarea"
                  rows={3}
                  value={explanation}
                  placeholder="Why is this block moving?"
                  onChange={(e) => setExplanation(e.target.value)}
                />
              </label>

              <label className="sch-edit__check">
                <input
                  type="checkbox"
                  checked={isManualOverride}
                  onChange={(e) => setIsManualOverride(e.target.checked)}
                />
                <span>Manual override (this change was made by me)</span>
              </label>

              <div className="sch-modal__actions">
                <button
                  type="button"
                  className="sch-btn sch-btn--soft"
                  onClick={onClose}
                  disabled={saving}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="sch-btn sch-btn--primary"
                  disabled={saving || loading || statusPlan.mode === "block"}
                >
                  <span className="material-symbols-outlined sch-icon-18">save</span>
                  Review changes
                </button>
              </div>
            </form>
          )}
        </div>
      </div>

      {/*
        Pop-up XÁC NHẬN — bước 2.
        Chỉ khi bấm "Apply changes" ở đây mới thực sự gọi API.
      */}
      {confirming && (
        <div
          className="sch-modal sch-modal--confirm sch-modal--confirm-edit"
          role="presentation"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget && !saving) setConfirming(null);
          }}
        >
          <div
            className="sch-modal__panel sch-modal__panel--confirm"
            role="alertdialog"
            aria-modal="true"
            aria-label="Confirm slot changes"
          >
            <div className="sch-confirm__head">
              <span
                className="sch-confirm__icon sch-confirm__icon--warn"
                aria-hidden="true"
              >
                <span className="material-symbols-outlined">edit_calendar</span>
              </span>
              <h2 className="sch-confirm__title">Apply these changes?</h2>
            </div>

            <p className="sch-confirm__message">
              This time block will be updated on your calendar. Your Google
              Calendar will be updated as well.
            </p>

            <div className="sch-edit__summary">
              <div className="sch-edit__summary-row">
                <span>Starts</span>
                <strong>{formatMoment(confirming.startTime)}</strong>
              </div>
              <div className="sch-edit__summary-row">
                <span>Ends</span>
                <strong>{formatMoment(confirming.endTime)}</strong>
              </div>
              {/*
                ⚠️ Trạng thái KHÔNG do người dùng chọn.
                - Nếu sửa được → slot tự trở về "Approved".
                - Nếu không → giữ nguyên, máy tự quản lý.
              */}
              <div className="sch-edit__summary-row">
                <span>Status</span>
                <strong>
                  {confirming.newStatus
                    ? slotStatusDisplayLabel(confirming.newStatus)
                    : "Kept as is"}
                </strong>
              </div>
              {confirming.explanation && (
                <div className="sch-edit__summary-row">
                  <span>Note</span>
                  <strong>{confirming.explanation}</strong>
                </div>
              )}
              <div className="sch-edit__summary-row">
                <span>Manual override</span>
                <strong>{confirming.isManualOverride ? "Yes" : "No"}</strong>
              </div>
            </div>

            <div className="sch-confirm__actions">
              <button
                type="button"
                className="sch-btn sch-btn--soft"
                onClick={() => setConfirming(null)}
                disabled={saving}
              >
                Go back
              </button>
              <button
                type="button"
                className="sch-btn sch-btn--primary"
                onClick={() => void handleApply()}
                disabled={saving}
              >
                {saving ? "Saving…" : "Apply changes"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Pop-up báo LỖI — tiếng Anh, dễ hiểu. */}
      <AlertDialog
        open={alert !== null}
        title={alert?.title ?? ""}
        message={alert?.message ?? ""}
        tone={alert?.tone ?? "error"}
        onClose={() => setAlert(null)}
      />
    </>
  );
}
