import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  markDateTimePickerClosed,
  markDateTimePickerOpen,
} from "./date-time-picker-registry";
import "./date-time-picker.css";

/**
 * ===========================================================
 * <DateTimePicker> — ô chọn NGÀY + GIỜ (không bắt nhập tay)
 * ===========================================================
 *
 * Thay thế `<input type="datetime-local">` bằng popover có:
 *   1. Lịch tháng (chọn ngày bằng click).
 *   2. 2 cột cuộn độc lập: **giờ** (0-23) và **phút** (0-59).
 *
 * ⚠️ Phút là BẤT KỲ số nào (0-59), không chia bước 15 phút → slot có thể
 * bắt đầu lúc 09:07, 14:23… như thực tế người dùng cần.
 *
 * Popover render qua `createPortal` vào `document.body` vì panel modal
 * (`overflow-y: auto`) sẽ **cắt mất** popover nếu render bên trong.
 *
 * Giá trị trả về là `Date` (giờ địa phương) — component cha tự quyết định
 * chuyển sang ISO 8601 (UTC) khi gửi API.
 */

const WEEKDAY_SHORT = ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"];
const MONTH_LONG = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

/** `Date` → "Sat, Nov 28 · 09:30" (nhãn trên nút). */
function formatTriggerLabel(d: Date | null): string {
  if (!d) return "Pick a date and time";
  const time = d.toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const date = d.toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
  return `${date} · ${time}`;
}

/** Thứ trong tuần (0 = Thứ 2) — tuần bắt đầu từ Thứ 2. */
function mondayIndex(d: Date): number {
  const day = d.getDay(); // 0 = CN
  return day === 0 ? 6 : day - 1;
}

/** Ngày 1 của tháng chứa `d`. */
function startOfMonth(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), 1);
}

/** Cùng ngày/tháng/năm? */
function isSameDay(a: Date | null, b: Date | null): boolean {
  if (!a || !b) return false;
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

export function DateTimePicker({
  value,
  onChange,
  label,
  disabled = false,
  id,
}: {
  /** Giá trị hiện tại (giờ địa phương). `null` = chưa chọn. */
  value: Date | null;
  /** Gọi khi user chọn ngày + giờ mới. */
  onChange: (next: Date) => void;
  /** Nhãn hiển thị phía trên ô. */
  label: string;
  disabled?: boolean;
  id?: string;
}) {
  const [open, setOpen] = useState(false);
  /** Tháng đang xem trong lịch. */
  const [viewMonth, setViewMonth] = useState<Date>(() =>
    value ? startOfMonth(value) : startOfMonth(new Date()),
  );
  /** Ngày đang chọn (trong popover, chưa chốt giờ). */
  const [draftDate, setDraftDate] = useState<Date | null>(value);

  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);
  /** Danh sách cuộn của cột GIỜ / PHÚT (để tự cuộn tới giá trị đang chọn). */
  const hourListRef = useRef<HTMLDivElement | null>(null);
  const minuteListRef = useRef<HTMLDivElement | null>(null);
  /** Vị trí popover (fixed) — tính từ bounding rect của nút. */
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  /* ---- Mở/đóng ---- */
  const openPicker = useCallback(() => {
    if (disabled) return;
    setDraftDate(value);
    setViewMonth(value ? startOfMonth(value) : startOfMonth(new Date()));
    setOpen(true);
  }, [disabled, value]);

  const closePicker = useCallback(() => {
    setOpen(false);
    setPos(null);
  }, []);

  /* ---- Báo registry: picker đang mở hay không ---- */
  useEffect(() => {
    if (!open) return;
    markDateTimePickerOpen();
    return () => markDateTimePickerClosed();
  }, [open]);

  /**
   * Tự cuộn cột GIỜ / PHÚT tới giá trị đang chọn khi mở popover.
   * Nếu không, danh sách dài (60 phút) sẽ luôn bắt đầu ở "00".
   */
  useEffect(() => {
    if (!open) return;
    const id = window.setTimeout(() => {
      const h = hourListRef.current?.querySelector<HTMLElement>(
        '[aria-selected="true"]',
      );
      const m = minuteListRef.current?.querySelector<HTMLElement>(
        '[aria-selected="true"]',
      );
      h?.scrollIntoView({ block: "center" });
      m?.scrollIntoView({ block: "center" });
    }, 0);
    return () => window.clearTimeout(id);
  }, [open]);

  // Đóng khi click ra ngoài.
  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      const t = e.target as HTMLElement | null;
      if (t?.closest(".dtp-popover")) return;
      if (t?.closest(".dtp-trigger")) return;
      closePicker();
    }
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open, closePicker]);

  // Đóng bằng Escape.
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.stopPropagation();
        closePicker();
      }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, closePicker]);

  /* ---- Vị trí popover ---- */
  useLayoutEffect(() => {
    if (!open) return;
    function place() {
      const el = triggerRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      const width = 336;
      const estimatedHeight = 380;
      let left = r.left;
      let top = r.bottom + 8;
      // Không tràn ra ngoài màn hình.
      if (left + width > window.innerWidth - 12) {
        left = Math.max(12, window.innerWidth - width - 12);
      }
      if (top + estimatedHeight > window.innerHeight - 12) {
        top = Math.max(12, r.top - estimatedHeight - 8);
      }
      setPos({ top, left });
    }
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open]);

  /* ---- Lịch tháng ---- */
  const monthCells = useMemo(() => {
    const first = startOfMonth(viewMonth);
    const lead = mondayIndex(first);
    const daysInMonth = new Date(
      viewMonth.getFullYear(),
      viewMonth.getMonth() + 1,
      0,
    ).getDate();
    const cells: Array<Date | null> = [];
    for (let i = 0; i < lead; i += 1) cells.push(null);
    for (let d = 1; d <= daysInMonth; d += 1) {
      cells.push(new Date(viewMonth.getFullYear(), viewMonth.getMonth(), d));
    }
    // Luôn 6 hàng → 42 ô (để chiều cao không nhảy).
    while (cells.length < 42) cells.push(null);
    return cells;
  }, [viewMonth]);

  /* ---- Danh sách giờ (0-23) và phút (0-59) ---- */
  const HOURS = useMemo(
    () => Array.from({ length: 24 }, (_, h) => h),
    [],
  );
  const MINUTES = useMemo(
    () => Array.from({ length: 60 }, (_, m) => m),
    [],
  );

  /**
   * Chọn giờ (giữ nguyên ngày + phút hiện tại).
   *
   * ⚠️ Phút KHÔNG bị làm tròn — user có thể chọn bất kỳ phút nào (00-59).
   */
  const handlePickHour = useCallback(
    (hour: number) => {
      const base = draftDate ?? value ?? new Date();
      const next = new Date(
        base.getFullYear(),
        base.getMonth(),
        base.getDate(),
        hour,
        base.getMinutes(),
        0,
        0,
      );
      setDraftDate(next);
      onChange(next);
    },
    [draftDate, value, onChange],
  );

  /** Chọn phút (giữ nguyên ngày + giờ hiện tại). */
  const handlePickMinute = useCallback(
    (minute: number) => {
      const base = draftDate ?? value ?? new Date();
      const next = new Date(
        base.getFullYear(),
        base.getMonth(),
        base.getDate(),
        base.getHours(),
        minute,
        0,
        0,
      );
      setDraftDate(next);
      onChange(next);
    },
    [draftDate, value, onChange],
  );

  /** Chọn ngày (giữ nguyên giờ + phút hiện tại). */
  const handlePickDay = useCallback(
    (day: Date) => {
      const base = value ?? draftDate ?? new Date();
      const next = new Date(
        day.getFullYear(),
        day.getMonth(),
        day.getDate(),
        base.getHours(),
        base.getMinutes(),
        0,
        0,
      );
      setDraftDate(next);
      onChange(next);
    },
    [value, draftDate, onChange],
  );

  const shiftMonth = useCallback((delta: number) => {
    setViewMonth(
      (m) => new Date(m.getFullYear(), m.getMonth() + delta, 1),
    );
  }, []);

  const today = useMemo(() => new Date(), []);

  return (
    <>
      <label className="sch-edit__field">
        <span className="sch-edit__label">{label}</span>
        <button
          ref={triggerRef}
          id={id}
          type="button"
          className={`dtp-trigger${disabled ? " dtp-trigger--disabled" : ""}`}
          onClick={() => (open ? closePicker() : openPicker())}
          disabled={disabled}
          aria-haspopup="dialog"
          aria-expanded={open}
        >
          <span className="material-symbols-outlined sch-icon-16">
            calendar_month
          </span>
          <span className="dtp-trigger__label">{formatTriggerLabel(value)}</span>
          <span className="material-symbols-outlined sch-icon-16 dtp-trigger__caret">
            expand_more
          </span>
        </button>
      </label>

      {open &&
        createPortal(
          <div
            ref={popoverRef}
            className="dtp-popover"
            role="dialog"
            aria-label={`${label} picker`}
            style={{
              top: pos?.top ?? -9999,
              left: pos?.left ?? -9999,
              visibility: pos ? "visible" : "hidden",
            }}
          >
            {/* Header: điều hướng tháng */}
            <div className="dtp-head">
              <button
                type="button"
                className="dtp-nav"
                aria-label="Previous month"
                onClick={() => shiftMonth(-1)}
              >
                <span className="material-symbols-outlined">chevron_left</span>
              </button>
              <span className="dtp-head__title">
                {MONTH_LONG[viewMonth.getMonth()]} {viewMonth.getFullYear()}
              </span>
              <button
                type="button"
                className="dtp-nav"
                aria-label="Next month"
                onClick={() => shiftMonth(1)}
              >
                <span className="material-symbols-outlined">chevron_right</span>
              </button>
            </div>

            {/* Lịch tháng */}
            <div className="dtp-weekdays" aria-hidden="true">
              {WEEKDAY_SHORT.map((w) => (
                <span key={w} className="dtp-weekday">
                  {w}
                </span>
              ))}
            </div>
            <div className="dtp-grid" role="grid">
              {monthCells.map((day, i) => {
                if (!day) {
                  return <span key={`e${i}`} className="dtp-day dtp-day--empty" />;
                }
                const selected = isSameDay(day, value);
                const isDraft = isSameDay(day, draftDate);
                const isToday = isSameDay(day, today);
                return (
                  <button
                    key={day.toISOString()}
                    type="button"
                    className={`dtp-day${selected ? " dtp-day--selected" : ""}${
                      isDraft && !selected ? " dtp-day--draft" : ""
                    }${isToday ? " dtp-day--today" : ""}`}
                    onClick={() => handlePickDay(day)}
                    aria-label={day.toLocaleDateString()}
                    aria-pressed={selected}
                  >
                    {day.getDate()}
                  </button>
                );
              })}
            </div>

            {/*
              Chọn giờ + phút.
              ⚠️ Phút là bất kỳ số nào 0-59 (không chia bước 15 phút) →
              dùng 2 cột cuộn độc lập.
            */}
            <div className="dtp-time">
              <div className="dtp-time__head">
                <span className="dtp-time__title">Pick a time</span>
                <button
                  type="button"
                  className="dtp-time__now"
                  onClick={() => {
                    const now = new Date();
                    setDraftDate(now);
                    setViewMonth(startOfMonth(now));
                    onChange(now);
                    closePicker();
                  }}
                >
                  Now
                </button>
              </div>
              <div className="dtp-time__cols">
                {/* Cột GIỜ */}
                <div className="dtp-time__col">
                  <div className="dtp-time__col-title">Hour</div>
                  <div
                    className="dtp-time__list"
                    role="listbox"
                    aria-label="Hour"
                    ref={hourListRef}
                  >
                    {HOURS.map((h) => {
                      const hh = String(h).padStart(2, "0");
                      const isActive = (draftDate ?? value)?.getHours() === h;
                      return (
                        <button
                          key={hh}
                          type="button"
                          className={`dtp-time__item${isActive ? " dtp-time__item--active" : ""}`}
                          onClick={() => handlePickHour(h)}
                          role="option"
                          aria-selected={isActive}
                        >
                          {hh}
                        </button>
                      );
                    })}
                  </div>
                </div>

                {/* Cột PHÚT */}
                <div className="dtp-time__col">
                  <div className="dtp-time__col-title">Minute</div>
                  <div
                    className="dtp-time__list"
                    role="listbox"
                    aria-label="Minute"
                    ref={minuteListRef}
                  >
                    {MINUTES.map((m) => {
                      const mm = String(m).padStart(2, "0");
                      const isActive = (draftDate ?? value)?.getMinutes() === m;
                      return (
                        <button
                          key={mm}
                          type="button"
                          className={`dtp-time__item${isActive ? " dtp-time__item--active" : ""}`}
                          onClick={() => handlePickMinute(m)}
                          role="option"
                          aria-selected={isActive}
                        >
                          {mm}
                        </button>
                      );
                    })}
                  </div>
                </div>
              </div>
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}
