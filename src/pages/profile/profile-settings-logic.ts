/* ===========================================================
 * Logic cho form chỉnh sửa cài đặt giờ làm
 * ----------------------------------------------------------
 * Endpoint: PUT /api/me/settings
 *
 * Body (Swagger):
 *   {
 *     "workDayStart": "string",
 *     "workDayEnd": "string",
 *     "worksOnWeekend": true,
 *     "defaultBufferMinutes": 0,
 *     "reminderLeadMinutes": 0,
 *     "timeZone": "string"
 *   }
 *
 * ⚠️ Cả 6 trường đều BẮT BUỘC — thiếu bất kỳ trường nào BE trả 400.
 * ⚠️ `workDayStart` / `workDayEnd` là "HH:mm:ss" (BE tự tính lại 24 điểm
 *    giờ làm việc theo khung mới khi giờ làm thay đổi).
 *
 * Reuse helper từ onboarding để format giờ giống hệt màn onboarding.
 * =========================================================== */

import {
  COMMON_TIME_ZONES,
  detectTimeZone,
  toTimeInput,
  toTimeWithSeconds,
} from "../onboarding/onboarding-form-logic";

export { COMMON_TIME_ZONES, detectTimeZone };

/** Số phút hợp lệ cho buffer / reminder: 0 – 120. */
export function isValidMinutes(v: number): boolean {
  return Number.isFinite(v) && v >= 0 && v <= 120;
}

/** "HH:mm" -> số phút kể từ nửa đêm. */
export function minutesFromClock(hhmm: string): number {
  const m = hhmm.trim().match(/^(\d{1,2}):(\d{2})/);
  if (!m) return 0;
  return Number(m[1]) * 60 + Number(m[2]);
}

/** Giờ kết thúc phải SAU giờ bắt đầu (không cho phép ca đêm). */
export function isEndAfterStart(start: string, end: string): boolean {
  return minutesFromClock(end) > minutesFromClock(start);
}

/** State của form cài đặt giờ làm. */
export interface SettingsFormState {
  timeZone: string;
  /** "HH:mm" — dùng cho input type="time". */
  workDayStart: string;
  /** "HH:mm" — dùng cho input type="time". */
  workDayEnd: string;
  worksOnWeekend: boolean;
  defaultBufferMinutes: number;
  reminderLeadMinutes: number;
}

/** Lỗi theo từng field (key = tên field trong `SettingsFormState`). */
export type SettingsFieldErrors = Partial<
  Record<keyof SettingsFormState, string>
>;

/**
 * Tạo state ban đầu từ `GET /api/me` — điền sẵn giá trị hiện tại.
 */
export function createSettingsFormState(me: {
  timeZone?: string | null;
  workDayStart?: string | null;
  workDayEnd?: string | null;
  worksOnWeekend?: boolean | null;
  defaultBufferMinutes?: number | null;
  reminderLeadMinutes?: number | null;
}): SettingsFormState {
  return {
    timeZone: me.timeZone?.trim() || detectTimeZone(),
    workDayStart: toTimeInput(me.workDayStart ?? "08:00:00"),
    workDayEnd: toTimeInput(me.workDayEnd ?? "18:00:00"),
    worksOnWeekend: me.worksOnWeekend ?? false,
    defaultBufferMinutes: me.defaultBufferMinutes ?? 15,
    reminderLeadMinutes: me.reminderLeadMinutes ?? 15,
  };
}

/**
 * Validate state → trả về map lỗi (rỗng = hợp lệ).
 *
 * Thông điệp bằng tiếng Anh — lỗi hiển thị cho user cuối.
 */
export function validateSettingsForm(
  form: SettingsFormState,
): SettingsFieldErrors {
  const errors: SettingsFieldErrors = {};

  if (!form.timeZone.trim()) {
    errors.timeZone = "Please choose a time zone.";
  }
  if (!form.workDayStart) {
    errors.workDayStart = "Please pick a start time.";
  }
  if (!form.workDayEnd) {
    errors.workDayEnd = "Please pick an end time.";
  } else if (
    form.workDayStart &&
    !isEndAfterStart(form.workDayStart, form.workDayEnd)
  ) {
    errors.workDayEnd = "End time must be later than start time.";
  }
  if (!isValidMinutes(form.defaultBufferMinutes)) {
    errors.defaultBufferMinutes = "Buffer must be between 0 and 120 minutes.";
  }
  if (!isValidMinutes(form.reminderLeadMinutes)) {
    errors.reminderLeadMinutes =
      "Reminder lead must be between 0 and 120 minutes.";
  }

  return errors;
}

/** Chuyển state form → body gửi BE (`HH:mm` → `HH:mm:ss`). */
export function toSettingsRequest(form: SettingsFormState) {
  return {
    timeZone: form.timeZone,
    workDayStart: toTimeWithSeconds(form.workDayStart),
    workDayEnd: toTimeWithSeconds(form.workDayEnd),
    worksOnWeekend: form.worksOnWeekend,
    defaultBufferMinutes: form.defaultBufferMinutes,
    reminderLeadMinutes: form.reminderLeadMinutes,
  };
}

/**
 * State có thay đổi so với bản gốc không — dùng để disable nút Save
 * khi user chưa sửa gì.
 */
export function isSettingsFormDirty(
  form: SettingsFormState,
  initial: SettingsFormState,
): boolean {
  return (
    form.timeZone !== initial.timeZone ||
    form.workDayStart !== initial.workDayStart ||
    form.workDayEnd !== initial.workDayEnd ||
    form.worksOnWeekend !== initial.worksOnWeekend ||
    form.defaultBufferMinutes !== initial.defaultBufferMinutes ||
    form.reminderLeadMinutes !== initial.reminderLeadMinutes
  );
}
