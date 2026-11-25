import { useCallback, useEffect, useState } from "react";
import {
  listDomains,
  submitOnboarding,
  type DomainDto,
  type OverrunLevel,
  type OnboardingRequest,
} from "../../lib/api-client";

/* Re-export để UI chỉ import 1 nơi. */
export { OVERRUN_LEVELS } from "../../lib/api-client";

/* ===========================================================
 * Logic cho màn onboarding mới (POST /api/me/onboarding)
 * ----------------------------------------------------------
 * BE đã đổi contract: onboarding giờ nhận **6 trường bắt buộc**
 * (múi giờ, giờ làm, đệm, nhắc trước) + 3 trường tuỳ chọn
 * (giờ hiệu quả, loại công việc, mức làm lố).
 *
 * Spec: `FE_CHANGES.md` mục 1.2.
 * =========================================================== */

/** Múi giờ IANA của máy user (fallback về UTC nếu không lấy được). */
export function detectTimeZone(): string {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return tz || "UTC";
  } catch {
    return "UTC";
  }
}

/**
 * Danh sách múi giờ IANA phổ biến — để user chọn khi auto-detect không
 * đúng (VD: user ở VN nhưng server chạy UTC).
 */
export const COMMON_TIME_ZONES: ReadonlyArray<{
  id: string;
  label: string;
}> = [
  { id: "Asia/Ho_Chi_Minh", label: "Việt Nam (GMT+7)" },
  { id: "Asia/Singapore", label: "Singapore (GMT+8)" },
  { id: "Asia/Bangkok", label: "Thái Lan (GMT+7)" },
  { id: "Asia/Tokyo", label: "Nhật Bản (GMT+9)" },
  { id: "Australia/Sydney", label: "Sydney (GMT+11)" },
  { id: "Europe/London", label: "London (GMT+0)" },
  { id: "Europe/Paris", label: "Paris (GMT+1)" },
  { id: "America/New_York", label: "New York (GMT-5)" },
  { id: "America/Los_Angeles", label: "Los Angeles (GMT-8)" },
  { id: "UTC", label: "UTC" },
];

/** Nhãn tiếng Việt cho mức làm lố + hệ số tương ứng. */
export const OVERRUN_LEVEL_META: Record<
  OverrunLevel,
  { label: string; factor: string; desc: string }
> = {
  Rarely: {
    label: "Hiếm khi",
    factor: "×1.10",
    desc: "Tôi gần như luôn kết thúc đúng giờ.",
  },
  Sometimes: {
    label: "Thỉnh thoảng",
    factor: "×1.25",
    desc: "Tôi hay làm lố một chút khi việc phức tạp.",
  },
  Often: {
    label: "Thường xuyên",
    factor: "×1.50",
    desc: "Việc của tôi thường kéo dài hơn dự kiến.",
  },
  Always: {
    label: "Luôn luôn",
    factor: "×1.80",
    desc: "Tôi gần như luôn vượt thời gian dự kiến.",
  },
};

/** Nhãn tiếng Việt cho giờ làm việc. */
export const WEEKDAY_OPTIONS: ReadonlyArray<{ value: string; label: string }> =
  [
    { value: "Mon", label: "T2" },
    { value: "Tue", label: "T3" },
    { value: "Wed", label: "T4" },
    { value: "Thu", label: "T5" },
    { value: "Fri", label: "T6" },
    { value: "Sat", label: "T7" },
    { value: "Sun", label: "CN" },
  ];

/** Chuẩn hoá "HH:mm" → "HH:mm:ss" (BE yêu cầu định dạng có giây). */
export function toTimeWithSeconds(hhmm: string): string {
  const trimmed = hhmm.trim();
  if (!trimmed) return "00:00:00";
  const [h, m] = trimmed.split(":");
  const hh = (h ?? "0").padStart(2, "0");
  const mm = (m ?? "0").padStart(2, "0");
  return `${hh}:${mm}:00`;
}

/** Chuyển "HH:mm:ss" → "HH:mm" cho input `type="time"`. */
export function toTimeInput(hhmmss: string): string {
  const parts = hhmmss.split(":");
  const hh = parts[0] ?? "00";
  const mm = parts[1] ?? "00";
  return `${hh}:${mm}`;
}

/**
 * Kiểm tra giờ kết thúc có sau giờ bắt đầu không.
 * BE trả `400` nếu không → validate trước ở FE cho UX tốt hơn.
 */
export function isEndAfterStart(start: string, end: string): boolean {
  const toMinutes = (v: string) => {
    const [h, m] = v.split(":").map((x) => Number(x) || 0);
    return h * 60 + m;
  };
  return toMinutes(end) > toMinutes(start);
}

/** Kiểm tra số phút trong khoảng hợp lệ (0–120). */
export function isValidMinutes(v: number): boolean {
  return Number.isFinite(v) && v >= 0 && v <= 120;
}

/** State của form onboarding. */
export interface OnboardingFormState {
  timeZone: string;
  workDayStart: string;
  workDayEnd: string;
  worksOnWeekend: boolean;
  defaultBufferMinutes: number;
  reminderLeadMinutes: number;
  productiveHours: number[];
  domainIds: string[];
  overrunLevel: OverrunLevel | null;
}

export function createInitialFormState(): OnboardingFormState {
  return {
    timeZone: detectTimeZone(),
    workDayStart: "08:00",
    workDayEnd: "18:00",
    worksOnWeekend: false,
    defaultBufferMinutes: 15,
    reminderLeadMinutes: 15,
    productiveHours: [],
    domainIds: [],
    overrunLevel: null,
  };
}

/** Lỗi validation theo từng field (null = hợp lệ). */
export interface OnboardingFieldErrors {
  timeZone?: string;
  workDayEnd?: string;
  defaultBufferMinutes?: string;
  reminderLeadMinutes?: string;
}

export function validateOnboardingForm(
  form: OnboardingFormState,
): OnboardingFieldErrors {
  const errors: OnboardingFieldErrors = {};

  if (!form.timeZone.trim()) {
    errors.timeZone = "Vui lòng chọn múi giờ.";
  }
  if (!isEndAfterStart(form.workDayStart, form.workDayEnd)) {
    errors.workDayEnd = "Giờ kết thúc phải sau giờ bắt đầu.";
  }
  if (!isValidMinutes(form.defaultBufferMinutes)) {
    errors.defaultBufferMinutes = "Đệm phải từ 0 đến 120 phút.";
  }
  if (!isValidMinutes(form.reminderLeadMinutes)) {
    errors.reminderLeadMinutes = "Nhắc trước phải từ 0 đến 120 phút.";
  }

  return errors;
}

export function hasValidationErrors(errors: OnboardingFieldErrors): boolean {
  return Object.keys(errors).length > 0;
}

/** Chuyển state form → body gửi BE. */
export function toOnboardingRequest(
  form: OnboardingFormState,
): OnboardingRequest {
  const body: OnboardingRequest = {
    timeZone: form.timeZone,
    workDayStart: toTimeWithSeconds(form.workDayStart),
    workDayEnd: toTimeWithSeconds(form.workDayEnd),
    worksOnWeekend: form.worksOnWeekend,
    defaultBufferMinutes: form.defaultBufferMinutes,
    reminderLeadMinutes: form.reminderLeadMinutes,
  };
  // Tuỳ chọn — chỉ gửi khi có dữ liệu để BE không validate nhầm.
  if (form.productiveHours.length > 0) {
    body.productiveHours = [...form.productiveHours].sort((a, b) => a - b);
  }
  if (form.domainIds.length > 0) {
    body.domainIds = [...form.domainIds];
  }
  /*
   * ⚠️ `overrunLevel` CHỈ có tác dụng khi chọn ít nhất 1 loại công việc.
   * Bỏ trống → BE dùng mặc định `Sometimes`.
   */
  if (form.domainIds.length > 0 && form.overrunLevel) {
    body.overrunLevel = form.overrunLevel;
  }
  return body;
}

/* ===========================================================
 * Hook: useOnboardingForm
 * =========================================================== */
export interface UseOnboardingForm {
  form: OnboardingFormState;
  setField: <K extends keyof OnboardingFormState>(
    key: K,
    value: OnboardingFormState[K],
  ) => void;
  toggleProductiveHour: (hour: number) => void;
  toggleDomain: (domainId: string) => void;
  /** Đồng bộ `overrunLevel` khi bỏ chọn hết domain → reset về null. */
  syncOverrunWithDomains: () => void;
  domains: DomainDto[];
  loadingDomains: boolean;
  errors: OnboardingFieldErrors;
  submitting: boolean;
  submitError: string | null;
  submit: () => Promise<boolean>;
  reset: () => void;
}

export function useOnboardingForm(onSuccess?: () => void): UseOnboardingForm {
  const [form, setForm] = useState<OnboardingFormState>(createInitialFormState);
  const [domains, setDomains] = useState<DomainDto[]>([]);
  const [loadingDomains, setLoadingDomains] = useState(true);
  const [errors, setErrors] = useState<OnboardingFieldErrors>({});
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  /*
   * Nạp danh sách loại công việc (GET /api/domains) 1 lần.
   *
   * ⚠️ `loadingDomains` khởi tạo = true nên không cần setState trong effect →
   * tránh rule `react-hooks/set-state-in-effect`.
   */
  useEffect(() => {
    let cancelled = false;
    void listDomains().then((res) => {
      if (cancelled) return;
      if (res.ok) setDomains(res.data ?? []);
      setLoadingDomains(false);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const setField = useCallback(
    <K extends keyof OnboardingFormState>(
      key: K,
      value: OnboardingFormState[K],
    ) => {
      setForm((prev) => ({ ...prev, [key]: value }));
      // Xoá lỗi của field vừa sửa.
      setErrors((prev) => {
        if (!(key in prev)) return prev;
        const next = { ...prev };
        delete next[key as keyof OnboardingFieldErrors];
        return next;
      });
    },
    [],
  );

  const toggleProductiveHour = useCallback((hour: number) => {
    setForm((prev) => {
      const has = prev.productiveHours.includes(hour);
      const next = has
        ? prev.productiveHours.filter((h) => h !== hour)
        : [...prev.productiveHours, hour];
      return { ...prev, productiveHours: next };
    });
  }, []);

  const toggleDomain = useCallback((domainId: string) => {
    setForm((prev) => {
      const has = prev.domainIds.includes(domainId);
      const next = has
        ? prev.domainIds.filter((id) => id !== domainId)
        : [...prev.domainIds, domainId];
      /*
       * Bỏ chọn hết domain → `overrunLevel` mất tác dụng → reset về null
       * (BE sẽ dùng mặc định `Sometimes`).
       */
      return {
        ...prev,
        domainIds: next,
        overrunLevel: next.length === 0 ? null : prev.overrunLevel,
      };
    });
  }, []);

  const syncOverrunWithDomains = useCallback(() => {
    setForm((prev) =>
      prev.domainIds.length === 0 ? { ...prev, overrunLevel: null } : prev,
    );
  }, []);

  const submit = useCallback(async (): Promise<boolean> => {
    const nextErrors = validateOnboardingForm(form);
    setErrors(nextErrors);
    if (hasValidationErrors(nextErrors)) {
      setSubmitError("Vui lòng kiểm tra lại các trường được đánh dấu.");
      return false;
    }

    setSubmitting(true);
    setSubmitError(null);
    const res = await submitOnboarding(toOnboardingRequest(form));
    setSubmitting(false);

    if (!res.ok) {
      setSubmitError(
        res.error ||
          "Không lưu được thiết lập. Vui lòng kiểm tra lại thông tin và thử lại.",
      );
      return false;
    }

    onSuccess?.();
    return true;
  }, [form, onSuccess]);

  const reset = useCallback(() => {
    setForm(createInitialFormState());
    setErrors({});
    setSubmitError(null);
  }, []);

  return {
    form,
    setField,
    toggleProductiveHour,
    toggleDomain,
    syncOverrunWithDomains,
    domains,
    loadingDomains,
    errors,
    submitting,
    submitError,
    submit,
    reset,
  };
}
