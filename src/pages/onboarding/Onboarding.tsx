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
    () => user?.name?.split(/\s+/)[0] ?? "bạn",
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

          <nav className="onboarding-stepnav" aria-label="Tiến trình onboarding">
            <span className="onboarding-stepnav-item onboarding-stepnav-item--active">
              01 · Khung giờ làm việc
            </span>
            <span className="onboarding-stepnav-sep" aria-hidden="true">
              /
            </span>
            <span className="onboarding-stepnav-item onboarding-stepnav-item--muted">
              02 · Loại công việc
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
                Chào mừng {greeting}
              </span>
              <h1 className="onboarding-title">
                Thiết lập khung giờ làm việc của bạn
              </h1>
              <p className="onboarding-subtitle">
                METANOIA cần 6 thông tin này để xếp lịch đúng nhịp làm việc
                thật của bạn. Bạn luôn có thể đổi lại trong phần Cài đặt.
              </p>
            </div>

            {/* Bước 1 — Khung giờ làm việc */}
            <div className="onboarding-steps">
              <section className="onboarding-step" aria-labelledby="ob-work">
                <div className="onboarding-step-head">
                  <div className="onboarding-step-title">
                    <span className="onboarding-step-number">1</span>
                    <h2 id="ob-work">Khung giờ làm việc</h2>
                  </div>
                  <span className="onboarding-step-hint">
                    Các trường có dấu * là bắt buộc
                  </span>
                </div>

                <div className="ob-field">
                  <label className="ob-label" htmlFor="ob-tz">
                    Múi giờ <span className="ob-required">*</span>
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
                      Đã tự nhận diện từ thiết bị — bạn có thể đổi.
                    </span>
                  )}
                </div>

                <div className="ob-grid-2">
                  <div className="ob-field">
                    <label className="ob-label" htmlFor="ob-start">
                      Bắt đầu làm việc <span className="ob-required">*</span>
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
                      Kết thúc làm việc <span className="ob-required">*</span>
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
                    Tôi cũng làm việc vào cuối tuần
                  </span>
                </label>

                <div className="ob-grid-2">
                  <div className="ob-field">
                    <label className="ob-label" htmlFor="ob-buffer">
                      Đệm giữa các khung giờ (phút){" "}
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
                      <span className="ob-hint">Khoảng nghỉ giữa 2 khung làm việc.</span>
                    )}
                  </div>
                  <div className="ob-field">
                    <label className="ob-label" htmlFor="ob-reminder">
                      Nhắc trước (phút) <span className="ob-required">*</span>
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
                      <span className="ob-hint">Báo trước khi khung giờ bắt đầu.</span>
                    )}
                  </div>
                </div>
              </section>

              {/* Bước 2 — Giờ hiệu quả (tuỳ chọn) */}
              <section className="onboarding-step" aria-labelledby="ob-hours">
                <div className="onboarding-step-head">
                  <div className="onboarding-step-title">
                    <span className="onboarding-step-number">2</span>
                    <h2 id="ob-hours">Giờ bạn làm hiệu quả nhất</h2>
                  </div>
                  <span className="onboarding-step-hint">Tuỳ chọn — bỏ qua được</span>
                </div>
                <p className="ob-note">
                  METANOIA tự chấm điểm 24 giờ làm việc từ khung giờ làm và
                  những giờ bạn chọn ở đây. Không chọn cũng được.
                </p>
                <div className="ob-hours-grid" role="group" aria-label="Chọn giờ hiệu quả">
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
                    <h2 id="ob-domain">Loại công việc bạn hay làm</h2>
                  </div>
                  <span className="onboarding-step-hint">
                    Tuỳ chọn — có thể chọn nhiều
                  </span>
                </div>

                {loadingDomains ? (
                  <p className="ob-note">Đang tải danh sách loại công việc…</p>
                ) : domains.length === 0 ? (
                  <p className="ob-note">
                    Chưa có loại công việc nào trong hệ thống — bạn có thể bỏ
                    qua bước này.
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
                        Bạn thường làm lố khung giờ ra sao?
                      </span>
                      <span className="ob-hint">
                        Áp dụng cho {form.domainIds.length} loại công việc đã
                        chọn
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
                      Không chọn → hệ thống dùng mặc định “Thỉnh thoảng”.
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
                  Bạn luôn có thể tuỳ chỉnh lại thông tin này trong phần Cài đặt.
                </span>
                <button
                  type="button"
                  onClick={() => void submit()}
                  className="onboarding-cta"
                  disabled={submitting || done}
                >
                  <span>
                    {done
                      ? "Đã lưu thiết lập!"
                      : submitting
                        ? "Đang lưu…"
                        : "Hoàn tất thiết lập"}
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
            © 2025 Metanoia Intelligence · Quyền riêng tư &amp; Tối giản nhận
            thức.
          </div>
        </div>
      </footer>
    </div>
  );
}
