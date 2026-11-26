import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../../auth/AuthContext";
import { MetanoiaLogo } from "../../components/MetanoiaLogo";
import {
  COMMON_TIME_ZONES,
  OVERRUN_LEVELS,
  OVERRUN_LEVEL_META,
  useOnboardingForm,
  type OnboardingFieldErrors,
} from "./onboarding-form-logic";
import "./onboarding.css";

/**
 * Onboarding — Thiết lập lịch làm việc lần đầu.
 *
 * ⚠️ Contract BE mới (`POST /api/me/onboarding`):
 *   • 6 trường **BẮT BUỘC**: `timeZone`, `workDayStart`, `workDayEnd`,
 *     `worksOnWeekend`, `defaultBufferMinutes`, `reminderLeadMinutes`.
 *     Thiếu bất kỳ → BE trả `400` và **không lưu gì**.
 *   • `productiveHours`, `domainIds` — tuỳ chọn, có thể để trống.
 *   • `overrunLevel` — tuỳ chọn, CHỈ hiện khi đã chọn ít nhất 1 loại
 *     công việc (vì nó được lưu riêng cho từng loại đã chọn).
 *
 * BE **không** chặn API khi chưa onboarding → `ProtectedRoute` tự gate,
 * nên màn này là bắt buộc để vào được home.
 *
 * Spec: `FE_CHANGES.md` mục 1.2 + 1.3.
 */
export function OnboardingPage() {
  const navigate = useNavigate();
  const { user, markOnboardingCompleted } = useAuth();
  const [done, setDone] = useState(false);

  const { form, setField, toggleProductiveHour, toggleDomain, domains, loadingDomains, errors, submitting, submitError, submit } =
    useOnboardingForm(() => {
      // Đánh dấu onboarding hoàn tất → cỡng cổng gate ngay, không chờ
      // refetch `/api/me`.
      markOnboardingCompleted();
      setDone(true);
    });

  // Scroll lên đầu mỗi lần vào.
  useEffect(() => {
    window.scrollTo({ top: 0, behavior: "instant" as ScrollBehavior });
  }, []);

  const greeting = useMemo(
    () => user?.name?.split(/\s+/)[0] ?? "there",
    [user?.name],
  );

  /** Chuyển tới home sau khi lưu thành công (delay nhẹ để user thấy confirm). */
  useEffect(() => {
    if (!done) return;
    const t = window.setTimeout(() => {
      navigate("/dashboard", { replace: true });
    }, 900);
    return () => window.clearTimeout(t);
  }, [done, navigate]);

  /** `overrunLevel` chỉ hiện khi đã chọn ít nhất 1 loại công việc. */
  const showOverrun = form.domainIds.length > 0;

  const fieldError = (key: keyof OnboardingFieldErrors): string | undefined =>
    errors[key];

  return (
    <div className="onboarding">
      {/* ================= HEADER ================= */}
      <header className="onboarding-header">
        <div className="onboarding-header-inner">
          <div className="onboarding-brand">
            <MetanoiaLogo size={30} tone="dark" />
            <span className="onboarding-brand-name">METANOIA</span>
          </div>

          <nav className="onboarding-stepnav" aria-label="Onboarding progress">
            <span className="onboarding-stepnav-item onboarding-stepnav-item--active">
              01 · Working hours
            </span>
            <span className="onboarding-stepnav-sep" aria-hidden="true">
              /
            </span>
            <span className="onboarding-stepnav-item onboarding-stepnav-item--muted">
              02 · Work type
            </span>
          </nav>

          <div className="onboarding-header-right">
            {user?.avatarUrl ? (
              <img
                alt={user.name ?? "Profile"}
                className="onboarding-avatar"
                src={user.avatarUrl}
                onError={(e) => {
                  (e.currentTarget as HTMLImageElement).style.display = "none";
                }}
              />
            ) : (
              <span
                className="onboarding-avatar onboarding-avatar--fallback"
                aria-hidden="true"
              >
                <span className="material-symbols-outlined">person</span>
              </span>
            )}
          </div>
        </div>
      </header>

      {/* ================= MAIN ================= */}
      <main className="onboarding-main">
        <div className="onboarding-shell">
          <div className="onboarding-card">
            {/* Intro */}
            <div className="onboarding-intro">
              <span className="onboarding-badge">
                <span className="onboarding-badge-dot" />
                Welcome {greeting}
              </span>
              <h1 className="onboarding-title">
                Set up your working hours
              </h1>
              <p className="onboarding-subtitle">
                METANOIA needs these 6 details to schedule around your real
                working rhythm. You can always change them later in Settings.
              </p>
            </div>

            {/* Bước 1 — Khung giờ làm việc */}
            <div className="onboarding-steps">
              <section className="onboarding-step" aria-labelledby="ob-work">
                <div className="onboarding-step-head">
                  <div className="onboarding-step-title">
                    <span className="onboarding-step-number">1</span>
                    <h2 id="ob-work">Working hours</h2>
                  </div>
                  <span className="onboarding-step-hint">
                    Fields marked with * are required
                  </span>
                </div>

                <div className="ob-field">
                  <label className="ob-label" htmlFor="ob-tz">
                    Time zone <span className="ob-required">*</span>
                  </label>
                  <select
                    id="ob-tz"
                    className={"ob-input" + (fieldError("timeZone") ? " ob-input--error" : "")}
                    value={form.timeZone}
                    onChange={(e) => setField("timeZone", e.target.value)}
                  >
                    {/* Nếu múi giờ detect ra không nằm trong danh sách phổ biến
                        → thêm vào đầu để không mất giá trị đang chọn. */}
                    {COMMON_TIME_ZONES.some((t) => t.id === form.timeZone) ? null : (
                      <option value={form.timeZone}>{form.timeZone}</option>
                    )}
                    {COMMON_TIME_ZONES.map((tz) => (
                      <option key={tz.id} value={tz.id}>
                        {tz.label}
                      </option>
                    ))}
                  </select>
                  {fieldError("timeZone") ? (
                    <span className="ob-error">{fieldError("timeZone")}</span>
                  ) : (
                    <span className="ob-hint">
                      Detected from your device — you can change it.
                    </span>
                  )}
                </div>

                <div className="ob-grid-2">
                  <div className="ob-field">
                    <label className="ob-label" htmlFor="ob-start">
                      Work day starts <span className="ob-required">*</span>
                    </label>
                    <input
                      id="ob-start"
                      type="time"
                      className="ob-input"
                      value={form.workDayStart}
                      onChange={(e) => setField("workDayStart", e.target.value)}
                    />
                  </div>
                  <div className="ob-field">
                    <label className="ob-label" htmlFor="ob-end">
                      Work day ends <span className="ob-required">*</span>
                    </label>
                    <input
                      id="ob-end"
                      type="time"
                      className={"ob-input" + (fieldError("workDayEnd") ? " ob-input--error" : "")}
                      value={form.workDayEnd}
                      onChange={(e) => setField("workDayEnd", e.target.value)}
                    />
                    {fieldError("workDayEnd") ? (
                      <span className="ob-error">{fieldError("workDayEnd")}</span>
                    ) : null}
                  </div>
                </div>

                <label className="ob-check">
                  <input
                    type="checkbox"
                    checked={form.worksOnWeekend}
                    onChange={(e) => setField("worksOnWeekend", e.target.checked)}
                  />
                  <span className="ob-check-box" aria-hidden="true">
                    <span className="material-symbols-outlined">check</span>
                  </span>
                  <span className="ob-check-text">
                    I also work on weekends
                  </span>
                </label>

                <div className="ob-grid-2">
                  <div className="ob-field">
                    <label className="ob-label" htmlFor="ob-buffer">
                      Buffer between slots (minutes){" "}
                      <span className="ob-required">*</span>
                    </label>
                    <input
                      id="ob-buffer"
                      type="number"
                      min={0}
                      max={120}
                      className={"ob-input" + (fieldError("defaultBufferMinutes") ? " ob-input--error" : "")}
                      value={form.defaultBufferMinutes}
                      onChange={(e) =>
                        setField("defaultBufferMinutes", Number(e.target.value))
                      }
                    />
                    {fieldError("defaultBufferMinutes") ? (
                      <span className="ob-error">
                        {fieldError("defaultBufferMinutes")}
                      </span>
                    ) : (
                      <span className="ob-hint">
                        A short break between two work blocks.
                      </span>
                    )}
                  </div>
                  <div className="ob-field">
                    <label className="ob-label" htmlFor="ob-reminder">
                      Reminder lead (minutes){" "}
                      <span className="ob-required">*</span>
                    </label>
                    <input
                      id="ob-reminder"
                      type="number"
                      min={0}
                      max={120}
                      className={"ob-input" + (fieldError("reminderLeadMinutes") ? " ob-input--error" : "")}
                      value={form.reminderLeadMinutes}
                      onChange={(e) =>
                        setField("reminderLeadMinutes", Number(e.target.value))
                      }
                    />
                    {fieldError("reminderLeadMinutes") ? (
                      <span className="ob-error">
                        {fieldError("reminderLeadMinutes")}
                      </span>
                    ) : (
                      <span className="ob-hint">
                        Notify me before a slot starts.
                      </span>
                    )}
                  </div>
                </div>
              </section>

              {/* Bước 2 — Giờ hiệu quả (tuỳ chọn) */}
              <section className="onboarding-step" aria-labelledby="ob-hours">
                <div className="onboarding-step-head">
                  <div className="onboarding-step-title">
                    <span className="onboarding-step-number">2</span>
                    <h2 id="ob-hours">Your most productive hours</h2>
                  </div>
                  <span className="onboarding-step-hint">
                    Optional — you can skip this
                  </span>
                </div>
                <p className="ob-note">
                  METANOIA scores your 24-hour day using your working hours plus
                  the hours you pick here. You can skip this too.
                </p>
                <div className="ob-hours-grid" role="group" aria-label="Choose your productive hours">
                  {Array.from({ length: 24 }, (_, h) => {
                    const active = form.productiveHours.includes(h);
                    return (
                      <button
                        key={h}
                        type="button"
                        aria-pressed={active}
                        className={
                          "ob-hour" + (active ? " ob-hour--active" : "")
                        }
                        onClick={() => toggleProductiveHour(h)}
                      >
                        {h.toString().padStart(2, "0")}
                      </button>
                    );
                  })}
                </div>
              </section>

              {/* Bước 3 — Loại công việc + mức làm lố */}
              <section className="onboarding-step" aria-labelledby="ob-domain">
                <div className="onboarding-step-head">
                  <div className="onboarding-step-title">
                    <span className="onboarding-step-number">3</span>
                    <h2 id="ob-domain">The kind of work you usually do</h2>
                  </div>
                  <span className="onboarding-step-hint">
                    Optional — pick as many as you like
                  </span>
                </div>

                {loadingDomains ? (
                  <p className="ob-note">Loading work types…</p>
                ) : domains.length === 0 ? (
                  <p className="ob-note">
                    There are no work types in the system yet — you can skip
                    this step.
                  </p>
                ) : (
                  <div className="ob-tagcloud">
                    {domains.map((d) => {
                      const active = form.domainIds.includes(d.id);
                      return (
                        <button
                          key={d.id}
                          type="button"
                          aria-pressed={active}
                          className={"ob-tag" + (active ? " ob-tag--active" : "")}
                          onClick={() => toggleDomain(d.id)}
                        >
                          {d.name}
                        </button>
                      );
                    })}
                  </div>
                )}

                {/*
                 * ⚠️ `overrunLevel` CHỈ hiện khi đã chọn ít nhất 1 loại công
                 * việc — vì BE lưu hệ số "làm lố" riêng cho TỪNG loại đã chọn.
                 */}
                {showOverrun && (
                  <div className="ob-overrun">
                    <div className="ob-overrun-head">
                      <span className="ob-label">
                        How often do you run over your time slots?
                      </span>
                      <span className="ob-hint">
                        Applies to the {form.domainIds.length} work type
                        {form.domainIds.length === 1 ? "" : "s"} you selected
                      </span>
                    </div>
                    <div className="ob-overrun-grid">
                      {OVERRUN_LEVELS.map((level) => {
                        const meta = OVERRUN_LEVEL_META[level];
                        const active = form.overrunLevel === level;
                        return (
                          <button
                            key={level}
                            type="button"
                            aria-pressed={active}
                            className={
                              "ob-overrun-card" +
                              (active ? " ob-overrun-card--active" : "")
                            }
                            onClick={() => setField("overrunLevel", level)}
                          >
                            <span className="ob-overrun-label">
                              {meta.label}
                            </span>
                            <span className="ob-overrun-factor adm-mono">
                              {meta.factor}
                            </span>
                            <span className="ob-overrun-desc">{meta.desc}</span>
                          </button>
                        );
                      })}
                    </div>
                    <p className="ob-note">
                      No selection → the system uses the default “Sometimes”.
                    </p>
                  </div>
                )}
              </section>
            </div>

            {/* Footer actions */}
            <div className="onboarding-actions">
              {submitError && (
                <div className="ob-alert" role="alert">
                  <span className="material-symbols-outlined">error</span>
                  <span>{submitError}</span>
                </div>
              )}
              <div className="onboarding-actions-row">
                <span className="onboarding-reassure">
                  You can always fine-tune these details later in Settings.
                </span>
                <button
                  type="button"
                  onClick={() => void submit()}
                  className="onboarding-cta"
                  disabled={submitting || done}
                >
                  <span>
                    {done
                      ? "Settings saved!"
                      : submitting
                        ? "Saving…"
                        : "Finish setup"}
                  </span>
                  <span
                    className="material-symbols-outlined onboarding-cta-icon"
                    aria-hidden="true"
                  >
                    {done ? "check" : "arrow_forward"}
                  </span>
                </button>
              </div>
            </div>
          </div>
        </div>
      </main>

      {/* ================= FOOTER ================= */}
      <footer className="onboarding-footer">
        <div className="onboarding-footer-inner">
          <div className="onboarding-footer-left">
            <span className="onboarding-footer-dot" aria-hidden="true" />
            <span>METANOIA Cognitive Protocol v2.4</span>
          </div>
          <div className="onboarding-footer-right">
            © 2025 Metanoia Intelligence · Privacy &amp; Minimal Cognition.
          </div>
        </div>
      </footer>
    </div>
  );
}
