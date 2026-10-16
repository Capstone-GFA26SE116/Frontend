import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../../auth/AuthContext";
import {
  GOAL_OPTIONS,
  ROLE_OPTIONS,
  SECTOR_OPTIONS,
  writeOnboarding,
  type GoalId,
  type OnboardingProfile,
  type RoleId,
  type SectorId,
} from "./storage";
import "./onboarding.css";

/**
 * Onboarding — Khảo sát & Cá nhân hoá sau Đăng nhập.
 *
 * Flow: user vừa login lần đầu -> ProtectedRoute redirect về đây.
 *  - Bước 1: chọn 1 role (single-select card).
 *  - Bước 2: chọn nhiều sector (pill toggle).
 *  - Bước 3: chọn nhiều goal (checkbox card).
 *  - Cuối: CTA "Tiếp tục vào Không gian làm việc" lưu profile -> /dashboard.
 *  - "Bỏ qua bước này" lưu profile rỗng (đánh dấu completed) -> /dashboard.
 *
 * Lưu ý UX:
 *  - Mặc định: role=student, sector đầu tiên đã chọn, goal đầu tiên đã chọn.
 *  - Không bắt buộc chọn — CTA luôn enabled.
 *  - Header cố định, footer cố định (giống design mẫu).
 */
export function OnboardingPage() {
  const navigate = useNavigate();
  const { user } = useAuth();

  const [role, setRole] = useState<RoleId>("student");
  const [sectors, setSectors] = useState<Set<SectorId>>(
    () => new Set<SectorId>(["it_programming"]),
  );
  const [goals, setGoals] = useState<Set<GoalId>>(
    () => new Set<GoalId>(["deep_work"]),
  );

  // Scroll lên đầu mỗi lần vào.
  useEffect(() => {
    window.scrollTo({ top: 0, behavior: "instant" as ScrollBehavior });
  }, []);

  function toggleSector(id: SectorId) {
    setSectors((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleGoal(id: GoalId) {
    setGoals((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function buildProfile(): OnboardingProfile {
    return {
      role,
      sectors: Array.from(sectors),
      goals: Array.from(goals),
      completedAt: new Date().toISOString(),
    };
  }

  function handleContinue() {
    writeOnboarding(buildProfile());
    navigate("/dashboard", { replace: true });
  }

  function handleSkip() {
    // Đánh dấu đã hoàn tất để không redirect lại, nhưng lưu role mặc định
    // (nếu user chưa chọn gì) để Dashboard có dữ liệu dùng được.
    writeOnboarding(buildProfile());
    navigate("/dashboard", { replace: true });
  }

  const greeting = useMemo(
    () => user?.name?.split(/\s+/)[0] ?? "bạn",
    [user?.name],
  );

  return (
    <div className="onboarding">
      {/* HEADER cố định */}
      <header className="onboarding-header">
        <div className="onboarding-header-inner">
          <div className="onboarding-brand">
            <img
              alt="METANOIA logo"
              className="onboarding-brand-logo"
              src="https://lh3.googleusercontent.com/aida/AEtjO1WgnNz4wnvDpVMPhalEUeKHDxcYm1v4t6rE9Wh4sLYs2jVFFpDVmZbmXmpwWUuULuwCTwEEu-la12sWMZbb5gwBBSipZMFaLqvsf2MqubCWhG4PQ1UrfaqQ8EgTAJpPoa9YxjVSM6M8HIlwd9Mhj_XjGS-FWhiauIWLS0LOFc90XsJnC6Uh5Py6BoElkJS2thk2C4AmBkyjDT6sCTU-InWWeUNXv3B1CtNyxP_FQjIN7yZga11XS-Gh4b9V"
            />
            <span className="onboarding-brand-name">METANOIA</span>
          </div>

          <nav
            className="onboarding-stepnav"
            aria-label="Tiến trình onboarding"
          >
            <span className="onboarding-stepnav-item onboarding-stepnav-item--active">
              01 Vai trò &amp; Mục tiêu
            </span>
            <span className="onboarding-stepnav-sep" aria-hidden="true">
              /
            </span>
            <span className="onboarding-stepnav-item onboarding-stepnav-item--muted">
              02 Nhịp độ Tư duy
            </span>
            <span className="onboarding-stepnav-sep" aria-hidden="true">
              /
            </span>
            <span className="onboarding-stepnav-item onboarding-stepnav-item--muted">
              03 Đồng bộ Không gian
            </span>
          </nav>

          <div className="onboarding-header-right">
            <button
              type="button"
              onClick={handleSkip}
              className="onboarding-skip"
            >
              Bỏ qua
            </button>
            <span className="onboarding-divider" aria-hidden="true" />
            <img
              alt="Profile"
              className="onboarding-avatar"
              src="https://lh3.googleusercontent.com/aida/AEtjO1WwZGgMBVZcdQX0fNL4k2n2SI70nfwjZCsJF75szec0Hw-MI9-maOmXDJMdzVYiw-oZmt1csY0DUKD2m5brfN5rFjM3Vwz-58yvOeuiYCzqJdOCR0zJa-3Sf5fL0uSfHZ8kOqN85PBOsDIwWZxBM1gqnyMgNg1NV_yotCU0OvyKne4RRr9cwvZGSsUpemZaKyykc9hsCBjQ3SZ0swbFatkFEp9UYU5o5Y7HHbaZjJCwiZhxjNHmJn8CuHA"
            />
          </div>
        </div>
      </header>

      {/* MAIN */}
      <main className="onboarding-main">
        <div className="onboarding-shell">
          {/* Ambient glow */}
          <div className="onboarding-glow onboarding-glow--top" aria-hidden="true" />
          <div
            className="onboarding-glow onboarding-glow--side"
            aria-hidden="true"
          />

          <div className="onboarding-card">
            {/* Header intro */}
            <div className="onboarding-intro">
              <span className="onboarding-badge">
                <span className="onboarding-badge-dot" />
                Chào mừng {greeting} đến với METANOIA
              </span>
              <h1 className="onboarding-title">
                Hãy cá nhân hoá không gian làm việc nhận thức của bạn
              </h1>
              <p className="onboarding-subtitle">
                Trả lời nhanh 3 câu hỏi để AI điều phối lịch trình học tập và
                làm việc chuẩn xác nhất theo thói quen sinh học của bạn.
              </p>
              <div className="onboarding-rhythm">
                <span className="onboarding-rhythm-label">
                  Đồng bộ nhịp tư duy
                </span>
                <div className="onboarding-rhythm-bars" aria-hidden="true">
                  <span
                    className="onboarding-rhythm-bar"
                    style={{
                      height: 6,
                      animationDelay: "0ms",
                    }}
                  />
                  <span
                    className="onboarding-rhythm-bar"
                    style={{
                      height: 12,
                      animationDelay: "150ms",
                    }}
                  />
                  <span
                    className="onboarding-rhythm-bar"
                    style={{
                      height: 8,
                      animationDelay: "300ms",
                    }}
                  />
                  <span
                    className="onboarding-rhythm-bar"
                    style={{
                      height: 10,
                      animationDelay: "450ms",
                    }}
                  />
                </div>
              </div>
            </div>

            {/* 3 bước */}
            <div className="onboarding-steps">
              {/* Bước 1: Role */}
              <section className="onboarding-step" aria-labelledby="step-1">
                <div className="onboarding-step-head">
                  <div className="onboarding-step-title">
                    <span className="onboarding-step-number">1</span>
                    <h2 id="step-1">Bạn hiện đang là ai?</h2>
                  </div>
                  <span className="onboarding-step-hint">
                    Chọn một vai trò chính
                  </span>
                </div>
                <div className="onboarding-role-grid">
                  {ROLE_OPTIONS.map((opt) => {
                    const isActive = role === opt.id;
                    return (
                      <button
                        key={opt.id}
                        type="button"
                        onClick={() => setRole(opt.id)}
                        aria-pressed={isActive}
                        className={
                          "onboarding-role-card" +
                          (isActive
                            ? " onboarding-role-card--active"
                            : "")
                        }
                      >
                        <div className="onboarding-role-top">
                          <div
                            className={
                              "onboarding-role-icon" +
                              (isActive
                                ? " onboarding-role-icon--active"
                                : "")
                            }
                          >
                            <span
                              className="material-symbols-outlined"
                              style={
                                isActive
                                  ? { fontVariationSettings: "'FILL' 1" }
                                  : undefined
                              }
                            >
                              {opt.icon}
                            </span>
                          </div>
                          <div
                            className={
                              "onboarding-role-check" +
                              (isActive
                                ? " onboarding-role-check--active"
                                : "")
                            }
                            aria-hidden="true"
                          >
                            <span className="material-symbols-outlined onboarding-role-check-icon">
                              check
                            </span>
                          </div>
                        </div>
                        <div>
                          <h3 className="onboarding-role-title">{opt.title}</h3>
                          <p className="onboarding-role-desc">{opt.desc}</p>
                        </div>
                      </button>
                    );
                  })}
                </div>
              </section>

              {/* Bước 2: Sector */}
              <section className="onboarding-step" aria-labelledby="step-2">
                <div className="onboarding-step-head">
                  <div className="onboarding-step-title">
                    <span className="onboarding-step-number">2</span>
                    <h2 id="step-2">
                      Lĩnh vực hoặc chuyên ngành chính của bạn?
                    </h2>
                  </div>
                  <span className="onboarding-step-hint">
                    Có thể chọn nhiều
                  </span>
                </div>
                <div className="onboarding-tagcloud">
                  {SECTOR_OPTIONS.map((opt) => {
                    const isActive = sectors.has(opt.id);
                    return (
                      <button
                        key={opt.id}
                        type="button"
                        onClick={() => toggleSector(opt.id)}
                        aria-pressed={isActive}
                        className={
                          "onboarding-tag" +
                          (isActive ? " onboarding-tag--active" : "")
                        }
                      >
                        {opt.label}
                      </button>
                    );
                  })}
                </div>
              </section>

              {/* Bước 3: Goal */}
              <section className="onboarding-step" aria-labelledby="step-3">
                <div className="onboarding-step-head">
                  <div className="onboarding-step-title">
                    <span className="onboarding-step-number">3</span>
                    <h2 id="step-3">
                      Mục tiêu lớn nhất của bạn khi dùng METANOIA?
                    </h2>
                  </div>
                  <span className="onboarding-step-hint">
                    Tùy chọn đa mục tiêu
                  </span>
                </div>
                <div className="onboarding-goal-grid">
                  {GOAL_OPTIONS.map((opt) => {
                    const isActive = goals.has(opt.id);
                    return (
                      <div
                        key={opt.id}
                        role="checkbox"
                        tabIndex={0}
                        aria-checked={isActive}
                        onClick={() => toggleGoal(opt.id)}
                        onKeyDown={(e) => {
                          if (e.key === " " || e.key === "Enter") {
                            e.preventDefault();
                            toggleGoal(opt.id);
                          }
                        }}
                        className={
                          "onboarding-goal" +
                          (isActive ? " onboarding-goal--active" : "")
                        }
                      >
                        <div
                          className={
                            "onboarding-goal-box" +
                            (isActive
                              ? " onboarding-goal-box--active"
                              : "")
                          }
                          aria-hidden="true"
                        >
                          <span className="material-symbols-outlined onboarding-goal-check">
                            done
                          </span>
                        </div>
                        <div className="onboarding-goal-text">
                          <span className="onboarding-goal-title">
                            {opt.title}
                          </span>
                          <span className="onboarding-goal-desc">
                            {opt.desc}
                          </span>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </section>
            </div>

            {/* Footer actions */}
            <div className="onboarding-actions">
              <div className="onboarding-actions-row">
                <button
                  type="button"
                  onClick={handleSkip}
                  className="onboarding-skip-action"
                >
                  Bỏ qua bước này
                </button>
                <button
                  type="button"
                  onClick={handleContinue}
                  className="onboarding-cta"
                >
                  <span>Tiếp tục vào Không gian làm việc</span>
                  <span
                    className="material-symbols-outlined onboarding-cta-icon"
                    aria-hidden="true"
                  >
                    arrow_forward
                  </span>
                </button>
              </div>
              <p className="onboarding-reassure">
                Bạn luôn có thể tuỳ chỉnh lại thông tin này bất kỳ lúc nào
                trong phần Cài đặt.
              </p>
            </div>
          </div>
        </div>
      </main>

      {/* FOOTER cố định */}
      <footer className="onboarding-footer">
        <div className="onboarding-footer-inner">
          <div className="onboarding-footer-left">
            <span className="onboarding-footer-dot" aria-hidden="true" />
            <span>METANOIA Cognitive Protocol v2.4</span>
          </div>
          <div className="onboarding-footer-right">
            © 2025 Metanoia Intelligence. Quyền riêng tư &amp; Tối giản nhận
            thức.
          </div>
        </div>
      </footer>
    </div>
  );
}
