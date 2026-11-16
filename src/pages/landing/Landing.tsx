import { useEffect } from "react";
import { Link } from "react-router-dom";
import { MetanoiaLogo } from "../../components/MetanoiaLogo";
import { markLandingSeen } from "../../auth/post-login-redirect";
import { useStaggeredMount } from "../../hooks/useStaggeredMount";
import { useVietnameseGreeting } from "../../hooks/useVietnameseGreeting";
import "./landing.css";

/**
 * Landing page (trang chủ công khai) — `/`
 *
 * Cấu trúc 4 section theo `DESIGN.md`:
 *   1. hero-band      — headline 60px + CTA + app preview (Hướng A)
 *   2. green-divider  — metrics strip số liệu SF Mono (Hướng C)
 *   3. content-band   — feature grid 3-up dạng card-feature (Hướng B)
 *   4. footer         — 3 cột link + legal
 *
 * Toàn bộ class prefix `.landing-*`.
 *
 * NOTE: Không dùng gradient mesh / glow blob / drop-shadow — brand dùng
 * flat canvas #101010 + hairline #3d3a39, single accent #00d992.
 */

/* ─── App preview: dữ liệu mẫu theo đúng pattern Dashboard ─── */

interface PreviewSlot {
  /** Giờ bắt đầu. */
  start: string;
  /** Giờ kết thúc. */
  end: string;
  /** Tên task. */
  title: string;
  /** Tag nhỏ. */
  tag?: string;
  /** Task do AI đề xuất → primary indicator. */
  ai?: boolean;
  /** Đang chạy / sắp tới → primary mạnh. */
  active?: boolean;
}

const PREVIEW_SLOTS: PreviewSlot[] = [
  {
    start: "09:00",
    end: "10:30",
    title: "Deep work — Viết spec dự án",
    tag: "focus",
  },
  {
    start: "11:00",
    end: "11:45",
    title: "Review pull request #248",
    tag: "code",
    active: true,
  },
  {
    start: "14:00",
    end: "15:00",
    title: "Sync với khách hàng",
    ai: true,
  },
  {
    start: "16:00",
    end: "17:00",
    title: "Họp planning sprint",
    ai: true,
  },
];

/* ─── Feature grid (Hướng B) ─── */

interface Feature {
  icon: string;
  title: string;
  body: string;
}

const FEATURES: Feature[] = [
  {
    icon: "neurology",
    title: "Học thói quen thật của bạn",
    body: "METANOIA quan sát cách bạn thực sự làm việc — giờ nào hiệu quả, task nào kéo dài — rồi dựng lại lịch quen thuộc thay vì áp một template có sẵn.",
  },
  {
    icon: "auto_awesome",
    title: "Tự điều chỉnh mỗi ngày",
    body: "Đầu ngày, AI phân tích năng lượng và tải công việc thực tế để đề xuất khung giờ tập trung cao nhất — bạn chỉ cần duyệt, không cần nhập lại.",
  },
  {
    icon: "sync_alt",
    title: "Đồng bộ hai chiều với Google Calendar",
    body: "Lịch do AI đề xuất được đẩy thẳng lên Google Calendar. Mọi thay đổi bạn tự tay trên Google cũng được METANOIA nhận về và điều chỉnh lại.",
  },
];

/* ─── Metrics strip (Hướng C) ─── */

interface Metric {
  value: string;
  label: string;
  /** Tiêu đề phụ mono — chi tiết kỹ thuật. */
  note: string;
}

const METRICS: Metric[] = [
  { value: "14h", label: "tiết kiệm mỗi tuần", note: "theo dữ liệu 1.200 freelancer" },
  { value: "98%", label: "lịch được duyệt không sửa", note: "sau 4 tuần sử dụng" },
  { value: "1.2k", label: "người dùng đang hoạt động", note: "tính đến tháng 11/2026" },
];

/* ============================================================
 * Component
 * ============================================================ */

export function LandingPage() {
  useEffect(() => {
    markLandingSeen();
  }, []);

  /* ----- Animation: hero -> metrics -> features ----- */
  const heroAnim = useStaggeredMount(70, 30);
  const metricsAnim = useStaggeredMount(90, 180);
  const featuresAnim = useStaggeredMount(110, 120);

  /* ----- Lời chào theo giờ Việt Nam (sáng/chiều/tối/đêm) -----
     Không dùng tên riêng — dùng "bạn" để mọi người dùng thấy đều hợp lý. */
  const greeting = useVietnameseGreeting("bạn");

  return (
    <div className="landing">
      <header className="landing-header">
        <Link to="/" className="landing-brand" aria-label="METANOIA">
          <MetanoiaLogo size={32} withWordmark />
        </Link>
        <nav className="landing-nav">
          <Link to="/pricing" className="landing-nav-link landing-nav-link--pricing">
            Bảng giá
          </Link>
          <Link to="/login" className="landing-nav-link">
            Đăng nhập
          </Link>
          <Link to="/register" className="landing-nav-cta">
            Bắt đầu miễn phí
          </Link>
        </nav>
      </header>

      <main className="landing-main">
        {/* ─── 1. HERO BAND (Hướng A) ─── */}
        <section
          className={
            "landing-hero" + (heroAnim.mounted ? " landing-hero--in" : "")
          }
        >
          <div className="landing-hero-grid">
            {/* Cột trái — copy */}
            <div className="landing-hero-copy">
              <p className="landing-eyebrow">
                <span className="material-symbols-outlined" aria-hidden="true">
                  bolt
                </span>
                Tác tử LLM nhận biết ngữ cảnh
              </p>

              <h1 className="landing-headline">
                Lịch ngày càng
                <br />
                <span className="landing-headline-accent">sát thực tế</span> của
                bạn.
              </h1>

              <p className="landing-subhead">
                METANOIA học thói quen làm việc thật của bạn và tự điều
                chỉnh — không cần bạn phải nhập liệu mỗi ngày.
              </p>

              <div className="landing-cta-row">
                <Link to="/register" className="landing-cta-primary">
                  Tạo tài khoản
                </Link>
                <Link to="/login" className="landing-cta-secondary">
                  Tôi đã có tài khoản
                </Link>
              </div>
            </div>

            {/* Cột phải — app preview */}
            <div className="landing-hero-visual">
              <div className="landing-app">
                {/* Thanh trên — app bar */}
                <div className="landing-app-bar">
                  <span className="landing-app-avatar" aria-hidden="true">
                    <span className="material-symbols-outlined">person</span>
                  </span>
                  <span className="landing-app-greeting">{greeting}</span>
                  <span className="landing-app-chip landing-app-chip--ai">
                    <span
                      className="material-symbols-outlined"
                      aria-hidden="true"
                    >
                      auto_awesome
                    </span>
                    AI Ready
                  </span>
                </div>

                {/* 2 metric nhỏ */}
                <div className="landing-app-metrics">
                  {/* Focus energy + sparkline */}
                  <div className="landing-app-metric">
                    <div className="landing-app-metric-head">
                      <span className="landing-app-metric-label">
                        Focus energy
                      </span>
                      <span className="landing-app-chip landing-app-chip--ok">
                        Optimal
                      </span>
                    </div>
                    <div className="landing-app-metric-value">
                      <span className="landing-app-metric-number">88%</span>
                      <span className="landing-app-metric-trend">
                        <span
                          className="material-symbols-outlined"
                          aria-hidden="true"
                        >
                          north_east
                        </span>
                        Bio peak
                      </span>
                    </div>
                    <div className="landing-app-metric-foot">
                      <span>Deep work window</span>
                      <span className="landing-app-metric-foot-emph">
                        14:00 - 16:30
                      </span>
                    </div>
                    <div className="landing-app-spark" aria-hidden="true">
                      <svg
                        className="landing-app-spark-svg"
                        fill="none"
                        preserveAspectRatio="none"
                        viewBox="0 0 100 32"
                      >
                        <path
                          d="M0,26 Q20,23 35,13 T65,5 T85,20 T100,16 L100,32 L0,32 Z"
                          fill="currentColor"
                          fillOpacity="0.15"
                        />
                        <path
                          d="M0,26 Q20,23 35,13 T65,5 T85,20 T100,16"
                          stroke="currentColor"
                          strokeLinecap="round"
                          strokeWidth="2"
                        />
                      </svg>
                    </div>
                  </div>

                  {/* Time multiplier + segmented bar */}
                  <div className="landing-app-metric">
                    <div className="landing-app-metric-head">
                      <span className="landing-app-metric-label">
                        Time multiplier
                      </span>
                      <span className="landing-app-chip landing-app-chip--ai">
                        AI
                      </span>
                    </div>
                    <div className="landing-app-metric-value">
                      <span className="landing-app-metric-number">1.34x</span>
                    </div>
                    <div className="landing-app-metric-foot">
                      <span>Bias compensation</span>
                      <span className="landing-app-metric-foot-emph">+34%</span>
                    </div>
                    <div
                      className="landing-app-bar"
                      role="img"
                      aria-label="60 phút gốc, 20 phút bù lệch, 20 phút đệm phục hồi"
                    >
                      <div
                        className="landing-app-bar-seg landing-app-bar-seg--60"
                        style={{ width: "60%" }}
                      />
                      <div
                        className="landing-app-bar-seg landing-app-bar-seg--20a"
                        style={{ width: "20%" }}
                      />
                      <div
                        className="landing-app-bar-seg landing-app-bar-seg--20b"
                        style={{ width: "20%" }}
                      />
                    </div>
                  </div>
                </div>

                {/* Today's tasks + progress */}
                <div className="landing-app-metric landing-app-metric--progress">
                  <div className="landing-app-metric-head">
                    <span className="landing-app-metric-label">
                      Today's tasks
                    </span>
                    <span className="landing-app-chip landing-app-chip--ok">
                      Thứ Hai
                    </span>
                  </div>
                  <div className="landing-app-metric-value">
                    <span className="landing-app-metric-number">3/5</span>
                  </div>
                  <div className="landing-app-metric-foot">
                    <span>Remaining today</span>
                    <span className="landing-app-metric-foot-emph">
                      2 to resolve
                    </span>
                  </div>
                  <div
                    className="landing-app-progress"
                    role="progressbar"
                    aria-valuenow={60}
                    aria-valuemin={0}
                    aria-valuemax={100}
                  >
                    <div
                      className="landing-app-progress-fill"
                      style={{ width: "60%" }}
                    />
                  </div>
                </div>

                {/* Danh sách slot lịch */}
                <div className="landing-app-schedule">
                  <div className="landing-app-schedule-head">
                    <span className="landing-app-dot" aria-hidden="true" />
                    <span>Lịch đề xuất hôm nay</span>
                  </div>

                  <ul className="landing-app-slots">
                    {PREVIEW_SLOTS.map((s) => (
                      <li
                        className={
                          "landing-app-slot" +
                          (s.ai ? " landing-app-slot--ai" : "") +
                          (s.active ? " landing-app-slot--active" : "")
                        }
                        key={s.start}
                      >
                        <span className="landing-app-slot-bar" aria-hidden="true" />
                        <span className="landing-app-slot-time">
                          {s.start}
                          <span className="landing-app-slot-time-end">
                            {s.end}
                          </span>
                        </span>
                        <span className="landing-app-slot-title">{s.title}</span>
                        {s.ai ? (
                          <span className="landing-app-slot-chip landing-app-slot-chip--ai">
                            <span
                              className="material-symbols-outlined"
                              aria-hidden="true"
                            >
                              auto_awesome
                            </span>
                            AI
                          </span>
                        ) : s.tag ? (
                          <span className="landing-app-slot-chip">{s.tag}</span>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* ─── 2. METRICS STRIP / green-divider-band (Hướng C) ─── */}
        <section
          className={
            "landing-metrics" +
            (metricsAnim.mounted ? " landing-metrics--in" : "")
          }
        >
          <div className="landing-metrics-inner">
            {METRICS.map((m, i) => (
              <div
                className="landing-metric"
                key={m.value}
                style={metricsAnim.getDelay(i)}
              >
                <span className="landing-metric-value">{m.value}</span>
                <span className="landing-metric-label">{m.label}</span>
                <span className="landing-metric-note">{m.note}</span>
              </div>
            ))}
          </div>
        </section>

        {/* ─── 3. FEATURE GRID / content-band (Hướng B) ─── */}
        <section className="landing-features" id="features">
          <div className="landing-section-head">
            <span className="landing-eyebrow landing-eyebrow--inline">
              <span className="material-symbols-outlined" aria-hidden="true">
                hub
              </span>
              Mọi thứ bạn cần
            </span>
            <h2 className="landing-section-title">
              Một trợ lý, ba việc lớn
            </h2>
            <p className="landing-section-desc">
              METANOIA không thay bạn quản lý lịch — nó học cách bạn muốn
              lịch vận hành, rồi làm phần đó giúp bạn.
            </p>
          </div>

          <div className="landing-feature-grid">
            {FEATURES.map((f, i) => (
              <article
                className={
                  "landing-feature-card" +
                  (featuresAnim.mounted ? " landing-feature-card--in" : "")
                }
                style={featuresAnim.getDelay(i)}
                key={f.title}
              >
                <div className="landing-feature-icon">
                  <span className="material-symbols-outlined" aria-hidden="true">
                    {f.icon}
                  </span>
                </div>
                <h3 className="landing-feature-title">{f.title}</h3>
                <p className="landing-feature-body">{f.body}</p>
              </article>
            ))}
          </div>
        </section>
      </main>

      {/* ─── 4. FOOTER ─── */}
      <footer className="landing-footer">
        <div className="landing-footer-inner">
          <div className="landing-footer-brand">
            <MetanoiaLogo size={28} withWordmark />
            <p className="landing-footer-tagline">
              Trợ lý AI tự học để sắp xếp công việc theo thói quen thực tế
              của bạn.
            </p>
          </div>

          <div className="landing-footer-col">
            <span className="landing-footer-head">Sản phẩm</span>
            <Link to="/#features" className="landing-footer-link">
              Tính năng
            </Link>
            <Link to="/pricing" className="landing-footer-link">
              Bảng giá
            </Link>
            <Link to="/register" className="landing-footer-link">
              Tạo tài khoản
            </Link>
          </div>

          <div className="landing-footer-col">
            <span className="landing-footer-head">Tài khoản</span>
            <Link to="/login" className="landing-footer-link">
              Đăng nhập
            </Link>
            <Link to="/register" className="landing-footer-link">
              Đăng ký
            </Link>
            <Link to="/notifications" className="landing-footer-link">
              Thông báo
            </Link>
          </div>
        </div>

        <div className="landing-footer-bottom">
          <span>© 2026 METANOIA</span>
          <span className="landing-footer-meta">
            Dữ liệu của bạn được giữ trên chính thiết bị của bạn.
          </span>
        </div>
      </footer>
    </div>
  );
}
