import { useCallback, useEffect, useRef, useState } from "react";
import { formatClock, formatMinutes } from "./focus-logic";
import "./focus.css";

/**
 * ===========================================================
 * <FocusTimerBar> — thanh phiên làm việc đang chạy (fixed đáy màn hình)
 * ===========================================================
 *
 * Hiển thị khi có phiên đang chạy:
 *   • Tên task
 *   • Đồng hồ đơn điệu (đếm lên) + thời gian còn lại
 *   • Thanh tiến trình so với kế hoạch
 *   • Nút Stop (mở hộp thoại chọn lý do)
 *
 * Thiết kế theo DESIGN.md:
 *   • Canvas #101010, hairline border #3d3a39.
 *   • Accent duy nhất #00d992 — chỉ dùng cho đồng hồ + progress.
 *   • Khi quá giờ (overrun) → chuyển sang cảnh báo (đỏ) — đây là ngoại lệ
 *     hợp lệ vì cần cảnh báo, nhưng vẫn giữ 1 accent chính.
 *   • Số đếm dùng font mono (SF Mono / JetBrains Mono).
 * =========================================================== */

export interface FocusTimerBarProps {
  /** Tên task đang làm. */
  taskTitle: string | null;
  /** Tổng giây đã làm. */
  elapsedSeconds: number;
  /** Phút dự kiến (0 = làm ngoài lịch). */
  plannedMinutes: number;
  /** Số giây còn lại (âm = đã quá giờ). */
  remainingSeconds: number;
  /** true khi đã vượt giờ dự kiến. */
  isOverrun: boolean;
  /** % đã dùng (0–100). */
  progressPercent: number;
  /** true khi đang gọi API → disable nút. */
  busy: boolean;
  /** Bấm nút Stop. */
  onStop: () => void;
  /** Điều hướng tới trang chi tiết của task (tuỳ chọn). */
  onOpenTask?: () => void;
}

export function FocusTimerBar({
  taskTitle,
  elapsedSeconds,
  plannedMinutes,
  remainingSeconds,
  isOverrun,
  progressPercent,
  busy,
  onStop,
  onOpenTask,
}: FocusTimerBarProps) {
  const [collapsed, setCollapsed] = useState(false);
  /** Ref tới thanh đồng hồ — đo chiều cao thật để chừa chỗ cho nội dung. */
  const barRef = useRef<HTMLDivElement | null>(null);

  // Gộp nhiều thay đổi liên tiếp thành 1 lần render (VD: đóng/mở nhanh).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setCollapsed(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  /**
   * Báo chiều cao thanh đồng hồ cho layout.
   *
   * Thanh là `position: fixed` ở đáy → che nội dung trang. Ta đặt 1 CSS
   * variable `--fc-bar-h` trên `<html>` để `site-layout.css` cộng vào
   * `padding-bottom` của `.site-main`.
   *
   * ⚠️ Phải đo bằng `ResizeObserver` chứ không hard-code: trên màn hình hẹp
   * (<=720px) thanh `flex-wrap` thành 2 dòng → cao hơn nhiều, hard-code
   * 92px sẽ để nội dung bị khuất.
   */
  useEffect(() => {
    const el = barRef.current;
    if (!el) return;
    const apply = () => {
      const h = Math.round(el.getBoundingClientRect().height);
      if (h > 0) {
        document.documentElement.style.setProperty("--fc-bar-h", `${h}px`);
      }
    };
    apply();
    const ro = new ResizeObserver(apply);
    ro.observe(el);
    return () => {
      ro.disconnect();
      document.documentElement.style.removeProperty("--fc-bar-h");
    };
  }, []);

  const handleStop = useCallback(() => {
    onStop();
  }, [onStop]);

  const overrunSeconds = Math.abs(Math.min(0, remainingSeconds));
  const hasPlan = plannedMinutes > 0;

  return (
    <div
      ref={barRef}
      className={`fc-bar${isOverrun ? " fc-bar--overrun" : ""}${collapsed ? " fc-bar--collapsed" : ""}`}
      role="region"
      aria-label="Phiên làm việc đang chạy"
    >
      {/* ----- Vùng trái: trạng thái + đồng hồ ----- */}
      <div className="fc-bar__lead">
        <span
          className="fc-bar__pulse"
          aria-hidden="true"
          data-overrun={isOverrun ? "true" : "false"}
        />
        <div className="fc-bar__leadtext">
          <span className="fc-bar__eyebrow">
            {isOverrun ? "Quá giờ dự kiến" : "Đang làm việc"}
          </span>
          {onOpenTask ? (
            <button
              type="button"
              className="fc-bar__task"
              onClick={onOpenTask}
              title="Mở task"
            >
              {taskTitle || "Không rõ task"}
            </button>
          ) : (
            <span className="fc-bar__task">{taskTitle || "Không rõ task"}</span>
          )}
        </div>
      </div>

      {/* ----- Vùng giữa: đồng hồ ----- */}
      <div className="fc-bar__clock">
        <span className="fc-bar__elapsed" aria-label="Thời gian đã làm">
          {formatClock(elapsedSeconds)}
        </span>
        <span className="fc-bar__sep" aria-hidden="true">
          /
        </span>
        {hasPlan ? (
          <span
            className={`fc-bar__remaining${isOverrun ? " fc-bar__remaining--over" : ""}`}
            aria-label={
              isOverrun
                ? `Đã quá giờ ${formatMinutes(overrunSeconds / 60)}`
                : `Còn ${formatMinutes(remainingSeconds / 60)}`
            }
          >
            {isOverrun
              ? `+${formatClock(overrunSeconds)}`
              : formatClock(remainingSeconds)}
          </span>
        ) : (
          <span className="fc-bar__remaining fc-bar__remaining--free">
            ngoài lịch
          </span>
        )}
      </div>

      {/* ----- Vùng phải: progress + nút ----- */}
      <div className="fc-bar__actions">
        {hasPlan && (
          <div
            className="fc-bar__track"
            role="progressbar"
            aria-valuenow={Math.round(progressPercent)}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label="Tiến độ so với kế hoạch"
          >
            <span
              className="fc-bar__fill"
              style={{ width: `${Math.min(100, progressPercent)}%` }}
            />
          </div>
        )}
        <button
          type="button"
          className="fc-bar__btn fc-bar__btn--stop"
          onClick={handleStop}
          disabled={busy}
        >
          <span className="material-symbols-outlined">stop_circle</span>
          <span>Dừng</span>
        </button>
        <button
          type="button"
          className="fc-bar__btn fc-bar__btn--ghost fc-bar__btn--icon"
          onClick={() => setCollapsed((v) => !v)}
          aria-label={collapsed ? "Mở rộng thanh đồng hồ" : "Thu gọn thanh đồng hồ"}
          title={collapsed ? "Mở rộng" : "Thu gọn"}
        >
          <span className="material-symbols-outlined">
            {collapsed ? "expand_more" : "expand_less"}
          </span>
        </button>
      </div>
    </div>
  );
}
