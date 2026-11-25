import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { markLandingSeen } from "../../auth/post-login-redirect";
import {
  demoAddDays,
  demoCalendarItems,
  demoGroupMembers,
  demoGroups,
  demoMilestones,
  demoProjects,
  demoToday,
} from "../../lib/demo-data";
import "./demo.css";

/**
 * ============================================================
 * TRANG CHỦ — trang marketing 1 trang (dữ liệu mẫu cho khách)
 * ============================================================
 *
 * `/` là MỘT trang dài: cuộn xuống lần lượt thấy
 *   1. Hero        — giá trị + CTA + mock app
 *   2. Today       — lịch ngày AI xếp
 *   3. Schedule    — lịch tuần 5 ngày
 *   4. Projects    — dự án + milestone + tiến độ
 *   5. Groups      — nhóm làm việc + thành viên
 *   6. Pricing     — bảng giá rút gọn
 *   7. CTA cuối    — đăng ký
 *
 * Tất cả dùng DỮ LIỆU MẪU (không gọi API) → khách xem an toàn.
 * Toàn bộ class prefix `.demo-*`.
 */

/* ============================================================
 * REVEAL — scroll-trigger animation wrapper
 * ============================================================ */

/**
 * Bọc nội dung để fade-up khi scroll tới.
 *
 * Vì sao tự làm thay vì lib: cần 3 thứ — (1) chạy 1 lần khi vào vùng
 * nhìn, (2) stagger delay theo index, (3) tôn trọng
 * `prefers-reduced-motion`. Tất cả gói trong ~30 dòng.
 */
function Reveal({
  children,
  delay = 0,
  className = "",
  as: Tag = "div",
}: {
  children: ReactNode;
  /** Delay (ms) trước khi animation chạy. */
  delay?: number;
  className?: string;
  as?: "div" | "section" | "article" | "li" | "span";
}) {
  const ref = useRef<HTMLElement | null>(null);
  /*
   * `prefers-reduced-motion` đọc 1 lần lúc khởi tạo state (lazy init)
   * để không phải setState trong effect — eslint chặn
   * `react-hooks/set-state-in-effect`.
   */
  const [reduced] = useState(
    () =>
      typeof window !== "undefined" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches,
  );
  const [shown, setShown] = useState(reduced);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    /* Nếu user tắt motion → hiện luôn, không cần observer. */
    if (reduced) return;

    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setShown(true);
          io.disconnect();
        }
      },
      { rootMargin: "0px 0px -12% 0px", threshold: 0.08 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [reduced]);

  return (
    <Tag
      ref={ref as never}
      className={
        "demo-reveal" + (shown ? " demo-reveal--in" : "") +
        (className ? ` ${className}` : "")
      }
      style={delay ? { transitionDelay: `${delay}ms` } : undefined}
    >
      {children}
    </Tag>
  );
}

/* ============================================================
 * COUNT UP — số liệu đếm dần khi scroll tới
 * ============================================================ */

/**
 * Đếm số từ 0 lên `value` khi vào vùng nhìn.
 *
 * `value` phải là số nguyên. Text phía sau (`suffix`) giữ nguyên.
 */
function CountUp({
  value,
  suffix = "",
  duration = 1400,
}: {
  value: number;
  suffix?: string;
  duration?: number;
}) {
  const ref = useRef<HTMLSpanElement | null>(null);
  const [reduced] = useState(
    () =>
      typeof window !== "undefined" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches,
  );
  const [display, setDisplay] = useState(() => (reduced ? value : 0));
  const started = useRef(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    /* Nếu user tắt motion → hiện luôn, không cần observer. */
    if (reduced) return;

    const io = new IntersectionObserver(
      (entries) => {
        if (!entries.some((e) => e.isIntersecting) || started.current) return;
        started.current = true;
        io.disconnect();

        const t0 = performance.now();
        const tick = (now: number) => {
          const p = Math.min(1, (now - t0) / duration);
          /* easeOutExpo — nhanh đầu, chậm đuôi, mượt. */
          const eased = p === 1 ? 1 : 1 - Math.pow(2, -10 * p);
          setDisplay(Math.round(eased * value));
          if (p < 1) requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      },
      { threshold: 0.4 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [value, duration, reduced]);

  return (
    <span ref={ref}>
      {display}
      {suffix}
    </span>
  );
}

/* ============================================================
 * Hero
 * ============================================================ */

function DemoHero() {
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    const t = window.setTimeout(() => setMounted(true), 60);
    return () => window.clearTimeout(t);
  }, []);

  const greeting = useMemo(() => {
    const h = new Date().getHours();
    if (h < 11) return "Good morning";
    if (h < 18) return "Good afternoon";
    return "Good evening";
  }, []);

  const heroSlots: Array<[string, string, string, boolean]> = [
    ["09:00", "10:30", "Deep work — Write project spec", true],
    ["11:00", "11:45", "Review pull request #248", false],
    ["14:00", "15:00", "Sync with client", true],
    ["16:00", "17:00", "Sprint planning meeting", true],
  ];

  return (
    <section className="demo-hero">
      <div className="demo-hero-grid">
        <div className="demo-hero-copy">
          <span
            className={
              "demo-eyebrow demo-eyebrow--pill" +
              (mounted ? " demo-hero-anim demo-hero-anim--in" : "")
            }
            style={{ transitionDelay: "60ms" }}
          >
            <span className="material-symbols-outlined" aria-hidden="true">
              visibility
            </span>
            Interactive sample workspace
          </span>

          <h1
            className={
              "demo-hero-title" + (mounted ? " demo-hero-anim demo-hero-anim--in" : "")
            }
            style={{ transitionDelay: "140ms" }}
          >
            See how METANOIA
            <br />
            arranges <span className="demo-hero-title-accent">a real day</span>
          </h1>

          <p
            className={
              "demo-hero-sub" + (mounted ? " demo-hero-anim demo-hero-anim--in" : "")
            }
            style={{ transitionDelay: "220ms" }}
          >
            Everything below is live sample data — no account, no signup, no
            waiting. Scroll through to see the day, the week, your projects and
            your team.
          </p>

          <div
            className={
              "demo-hero-actions" + (mounted ? " demo-hero-anim demo-hero-anim--in" : "")
            }
            style={{ transitionDelay: "300ms" }}
          >
            <Link to="/register" className="demo-btn demo-btn--primary">
              <span className="material-symbols-outlined" aria-hidden="true">
                auto_awesome
              </span>
              Get your own workspace
            </Link>
            <a href="#today" className="demo-btn demo-btn--ghost">
              <span className="material-symbols-outlined" aria-hidden="true">
                arrow_downward
              </span>
              Start scrolling
            </a>
          </div>

          {/* Trust row */}
          <div
            className={
              "demo-hero-trust" + (mounted ? " demo-hero-anim demo-hero-anim--in" : "")
            }
            style={{ transitionDelay: "380ms" }}
          >
            {[
              ["visibility", "No signup"],
              ["block", "Nothing saved"],
              ["bolt", "Real AI layout"],
            ].map(([icon, label]) => (
              <span key={label} className="demo-hero-trust-item">
                <span
                  className="material-symbols-outlined"
                  aria-hidden="true"
                >
                  {icon}
                </span>
                {label}
              </span>
            ))}
          </div>
        </div>

        {/* ---------- Mock app window ---------- */}
        <div
          className={
            "demo-hero-visual" + (mounted ? " demo-hero-anim demo-hero-anim--in" : "")
          }
          style={{ transitionDelay: "260ms" }}
        >
          <div className="demo-app">
            <div className="demo-app-bar">
              <span className="demo-app-avatar" aria-hidden="true">
                <span className="material-symbols-outlined">person</span>
              </span>
              <span className="demo-app-greeting">{greeting}</span>
              <span className="demo-app-chip demo-app-chip--ai">
                <span
                  className="material-symbols-outlined"
                  aria-hidden="true"
                >
                  auto_awesome
                </span>
                AI Ready
              </span>
            </div>

            <div className="demo-app-metrics">
              <div className="demo-app-metric">
                <div className="demo-app-metric-head">
                  <span className="demo-app-metric-label">Focus energy</span>
                  <span className="demo-app-chip demo-app-chip--ok">Optimal</span>
                </div>
                <div className="demo-app-metric-value">
                  <span className="demo-app-metric-number">88%</span>
                  <span className="demo-app-metric-trend">
                    <span
                      className="material-symbols-outlined"
                      aria-hidden="true"
                    >
                      north_east
                    </span>
                    Bio peak
                  </span>
                </div>
                <div className="demo-app-metric-foot">
                  <span>Deep work window</span>
                  <span className="demo-app-metric-foot-emph">14:00 - 16:30</span>
                </div>
                <div className="demo-app-spark" aria-hidden="true">
                  <svg
                    className="demo-app-spark-svg"
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

              <div className="demo-app-metric">
                <div className="demo-app-metric-head">
                  <span className="demo-app-metric-label">Time multiplier</span>
                  <span className="demo-app-chip demo-app-chip--ai">AI</span>
                </div>
                <div className="demo-app-metric-value">
                  <span className="demo-app-metric-number">1.34x</span>
                </div>
                <div className="demo-app-metric-foot">
                  <span>Bias compensation</span>
                  <span className="demo-app-metric-foot-emph">+34%</span>
                </div>
                <div className="demo-app-bar" aria-hidden="true">
                  <div
                    className="demo-app-bar-seg demo-app-bar-seg--60"
                    style={{ width: "60%" }}
                  />
                  <div
                    className="demo-app-bar-seg demo-app-bar-seg--20a"
                    style={{ width: "20%" }}
                  />
                  <div
                    className="demo-app-bar-seg demo-app-bar-seg--20b"
                    style={{ width: "20%" }}
                  />
                </div>
              </div>
            </div>

            <div className="demo-app-schedule">
              <div className="demo-app-schedule-head">
                <span className="demo-app-dot" aria-hidden="true" />
                <span>AI schedule for today</span>
              </div>
              <ul className="demo-app-slots">
                {heroSlots.map(([s, e, title, ai], i) => (
                  <li
                    className={
                      "demo-app-slot" +
                      (ai ? " demo-app-slot--ai" : "")
                    }
                    style={{ animationDelay: `${420 + i * 80}ms` }}
                    key={s}
                  >
                    <span className="demo-app-slot-bar" aria-hidden="true" />
                    <span className="demo-app-slot-time">
                      {s}
                      <span className="demo-app-slot-time-end">{e}</span>
                    </span>
                    <span className="demo-app-slot-title">{title}</span>
                    {ai && (
                      <span className="demo-app-slot-chip demo-app-slot-chip--ai">
                        <span
                          className="material-symbols-outlined"
                          aria-hidden="true"
                        >
                          auto_awesome
                        </span>
                        AI
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

/**
 * Cắt "HH:mm" từ chuỗi ISO — ổn định bất kể locale máy là gì
 * (`toLocaleTimeString` có thể ra "9:00 AM" ở en-US).
 */
function isoTime(iso: string): string {
  const m = /T(\d{2}:\d{2})/.exec(iso);
  return m ? m[1] : iso;
}

/** "18 thg 12" từ chuỗi ngày `YYYY-MM-DD`. */
function shortDate(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return iso;
  return `${Number(m[3])} thg ${Number(m[2])}`;
}

/* ============================================================
 * Section wrapper (có eyebrow pill + reveal)
 * ============================================================ */

function DemoSection({
  id,
  eyebrow,
  icon,
  title,
  desc,
  children,
}: {
  id: string;
  eyebrow: string;
  icon: string;
  title: string;
  desc: string;
  children: ReactNode;
}) {
  return (
    <section id={id} className="demo-section">
      <div className="demo-section-head">
        <Reveal>
          <span className="demo-eyebrow demo-eyebrow--pill demo-eyebrow--inline">
            <span className="material-symbols-outlined" aria-hidden="true">
              {icon}
            </span>
            {eyebrow}
          </span>
        </Reveal>
        <Reveal delay={60}>
          <h2 className="demo-section-title">{title}</h2>
        </Reveal>
        <Reveal delay={120}>
          <p className="demo-section-desc">{desc}</p>
        </Reveal>
      </div>
      {children}
    </section>
  );
}

/* ============================================================
 * 1. TODAY
 * ============================================================ */

function TodaySection() {
  const slots = useMemo(() => {
    return demoCalendarItems(0).map((c) => {
      return {
        id: c.id,
        start: isoTime(c.start),
        end: isoTime(c.end),
        title: c.title,
        project: c.projectName,
        ai: c.taskId !== null,
        fixed: c.isFixed,
        desc: c.description,
      };
    });
  }, []);

  const radar = useMemo(
    () =>
      demoMilestones()
        .flatMap((b) => b.tasks)
        .filter((t) => t.status !== "Done" && t.status !== "Cancelled")
        .slice(0, 6),
    [],
  );

  const all = demoMilestones().flatMap((b) => b.tasks);
  const doneCount = all.filter((t) => t.status === "Done").length;
  const activeProjects = demoProjects().filter((p) => p.status === "Active");

  return (
    <DemoSection
      id="today"
      eyebrow="Today"
      icon="today"
      title="Your day, already arranged"
      desc="AI reads your focus energy and real workload, then rebuilds the day around it — fixed meetings stay put, everything else flexes."
    >
      <div className="demo-grid">
        <Reveal className="demo-card demo-card--timeline">
          <div className="demo-card-head">
            <h3 className="demo-card-title">Today&apos;s schedule</h3>
            <span className="demo-card-meta">
              <span
                className="material-symbols-outlined demo-card-meta-icon"
                aria-hidden="true"
              >
                auto_awesome
              </span>
              {slots.filter((s) => s.ai).length} AI slots
            </span>
          </div>
          <ol className="demo-timeline">
            {slots.map((s, i) => (
              <Reveal
                as="li"
                key={s.id}
                delay={i * 70}
                className={
                  "demo-slot" +
                  (s.ai ? " demo-slot--ai" : "") +
                  (s.fixed ? " demo-slot--fixed" : "")
                }
              >
                <div className="demo-slot-time">
                  <span className="demo-slot-start">{s.start}</span>
                  <span className="demo-slot-end">{s.end}</span>
                </div>
                <div className="demo-slot-body">
                  <div className="demo-slot-head">
                    <span className="demo-slot-title">{s.title}</span>
                    {s.ai && (
                      <span className="demo-chip demo-chip--ai">
                        <span
                          className="material-symbols-outlined"
                          aria-hidden="true"
                        >
                          auto_awesome
                        </span>
                        AI
                      </span>
                    )}
                    {s.fixed && <span className="demo-chip">Fixed</span>}
                  </div>
                  {s.project && (
                    <span className="demo-slot-project">{s.project}</span>
                  )}
                  {s.desc && <p className="demo-slot-desc">{s.desc}</p>}
                </div>
              </Reveal>
            ))}
          </ol>
        </Reveal>

        <aside className="demo-side">
          <Reveal className="demo-card" delay={80}>
            <div className="demo-card-head">
              <h3 className="demo-card-title">Up next</h3>
              <span className="demo-card-meta">{radar.length} tasks</span>
            </div>
            <ul className="demo-task-list">
              {radar.map((t, i) => (
                <Reveal as="li" key={t.id} delay={i * 60} className="demo-task">
                  <span className="demo-task-dot" aria-hidden="true" />
                  <span className="demo-task-title">{t.title}</span>
                  <span className="demo-task-est">
                    {Math.round(t.estimatedMinutes / 60)}h
                  </span>
                </Reveal>
              ))}
            </ul>
          </Reveal>

          <Reveal className="demo-card demo-card--cta" delay={140}>
            <span className="demo-cta-icon" aria-hidden="true">
              <span className="material-symbols-outlined">auto_awesome</span>
            </span>
            <h3 className="demo-cta-title">
              This is what AI does for you every day
            </h3>
            <p className="demo-cta-body">
              It learns your real working habits, then rebuilds your schedule
              around them — instead of forcing a template.
            </p>
            <ul className="demo-cta-list">
              <li>
                <span
                  className="material-symbols-outlined"
                  aria-hidden="true"
                >
                  check_circle
                </span>
                Focus slots matched to your peak hours
              </li>
              <li>
                <span
                  className="material-symbols-outlined"
                  aria-hidden="true"
                >
                  check_circle
                </span>
                Tasks auto-planned from your project list
              </li>
              <li>
                <span
                  className="material-symbols-outlined"
                  aria-hidden="true"
                >
                  check_circle
                </span>
                Two-way Google Calendar sync
              </li>
            </ul>
            <Link
              to="/register"
              className="demo-btn demo-btn--primary demo-btn--block"
            >
              Create your free account
            </Link>
          </Reveal>
        </aside>
      </div>

      {/* ---------- Metrics band ---------- */}
      <Reveal className="demo-metrics" delay={60}>
        <div className="demo-metrics-inner">
          <div className="demo-metric">
            <span className="demo-metric-value">
              <CountUp value={doneCount} />
              <span className="demo-metric-sep">/</span>
              <CountUp value={all.length} />
            </span>
            <span className="demo-metric-label">Tasks completed</span>
            <span className="demo-metric-note">across the sample board</span>
          </div>
          <div className="demo-metric">
            <span className="demo-metric-value">
              <CountUp value={activeProjects.length} />
            </span>
            <span className="demo-metric-label">Active projects</span>
            <span className="demo-metric-note">each with milestones</span>
          </div>
          <div className="demo-metric">
            <span className="demo-metric-value">
              <CountUp value={26} suffix="h" />
            </span>
            <span className="demo-metric-label">Planned this week</span>
            <span className="demo-metric-note">AI-arranged time</span>
          </div>
          <div className="demo-metric">
            <span className="demo-metric-value">
              <CountUp value={134} suffix="%" />
            </span>
            <span className="demo-metric-label">Time multiplier</span>
            <span className="demo-metric-note">bias compensation</span>
          </div>
        </div>
      </Reveal>
    </DemoSection>
  );
}

/* ============================================================
 * 2. SCHEDULE
 * ============================================================ */

interface DemoWeekTask {
  id: string;
  title: string;
  dayIndex: number;
  start: string;
  end: string;
  subtasks: string[];
  ai: boolean;
}

function ScheduleSection() {
  const today = demoToday();
  const [weekOffset, setWeekOffset] = useState(0);

  const days = useMemo(
    () =>
      Array.from(
        { length: 5 },
        (_, i) => demoAddDays(today, weekOffset * 5 + i),
      ),
    [today, weekOffset],
  );

  const tasks = useMemo<DemoWeekTask[]>(() => {
    const out: DemoWeekTask[] = [];
    const cal = demoCalendarItems(0);
    const timeMap: Array<[string, string, string]> = [
      ["09:00", "10:30", "Deep work — Write project spec"],
      ["11:00", "11:45", "Review pull request #248"],
      ["14:00", "15:00", "Sync with client"],
      ["16:00", "17:00", "Sprint planning meeting"],
    ];
    cal.forEach((c, i) => {
      const [start, end, title] = timeMap[i] ?? ["09:00", "10:00", c.title];
      out.push({
        id: c.id,
        title,
        dayIndex: i === 3 ? 3 : i % 5,
        start,
        end,
        subtasks:
          i === 0
            ? ["Design shipment schema", "Set up repository + API architecture"]
            : i === 1
              ? ["Fix null-check bug", "Write tests for the booking form"]
              : [],
        ai: c.taskId !== null,
      });
    });

    const real = demoMilestones()
      .flatMap((b) => b.tasks)
      .filter((t) => t.status !== "Done")
      .slice(0, 6);

    real.forEach((t, i) => {
      const start = ["08:30", "10:00", "13:30", "15:00", "16:30"][i % 5];
      const dur = Math.max(30, Math.round(t.estimatedMinutes / 15) * 15);
      const sh = Number(start.slice(0, 2));
      const sm = Number(start.slice(3));
      const total = sh * 60 + sm + dur;
      const end = `${String(Math.floor(total / 60) % 24).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
      out.push({
        id: t.id,
        title: t.title,
        dayIndex: (i + 1) % 5,
        start,
        end,
        subtasks: [],
        ai: true,
      });
    });

    return out;
  }, []);

  const byDay = useMemo(() => {
    const map: DemoWeekTask[][] = [[], [], [], [], []];
    tasks.forEach((t) => map[t.dayIndex]?.push(t));
    return map;
  }, [tasks]);

  return (
    <DemoSection
      id="schedule"
      eyebrow="Schedule"
      icon="event"
      title="Your week, planned around constraints"
      desc="Tasks slot into the gaps between your fixed commitments. When something shifts, AI pushes the rest — never the meeting."
    >
      <Reveal className="demo-week-toolbar">
        <button
          type="button"
          className="demo-btn demo-btn--ghost"
          onClick={() => setWeekOffset((v) => v - 1)}
        >
          <span className="material-symbols-outlined" aria-hidden="true">
            chevron_left
          </span>
          Prev
        </button>
        <button
          type="button"
          className="demo-btn demo-btn--ghost"
          onClick={() => setWeekOffset(0)}
          disabled={weekOffset === 0}
        >
          This week
        </button>
        <button
          type="button"
          className="demo-btn demo-btn--ghost"
          onClick={() => setWeekOffset((v) => v + 1)}
        >
          Next
          <span className="material-symbols-outlined" aria-hidden="true">
            chevron_right
          </span>
        </button>
      </Reveal>

      <div className="demo-week">
        {days.map((d, di) => (
          <Reveal key={d} delay={di * 80} className="demo-day">
            <header className="demo-day-head">
              <span className="demo-day-label">
                {new Date(`${d}T00:00:00`).toLocaleDateString("en-US", {
                  weekday: "short",
                })}
              </span>
              <span className="demo-day-date">
                {new Date(`${d}T00:00:00`).getDate()}
              </span>
            </header>
            <div className="demo-day-body">
              {byDay[di]?.length ? (
                byDay[di].map((t, i) => (
                  <article
                    key={t.id}
                    className={
                      "demo-wtask" +
                      (t.ai ? " demo-wtask--ai" : "")
                    }
                    style={{ animationDelay: `${di * 80 + i * 50}ms` }}
                  >
                    <div className="demo-wtask-head">
                      <span className="demo-wtask-time">
                        {t.start}–{t.end}
                      </span>
                      {t.ai && (
                        <span
                          className="material-symbols-outlined demo-wtask-icon"
                          aria-hidden="true"
                        >
                          auto_awesome
                        </span>
                      )}
                    </div>
                    <h4 className="demo-wtask-title">{t.title}</h4>
                    {t.subtasks.length > 0 && (
                      <ul className="demo-wtask-subs">
                        {t.subtasks.map((s, si) => (
                          <li key={si} className="demo-wtask-sub">
                            <span
                              className="material-symbols-outlined"
                              aria-hidden="true"
                            >
                              subdirectory_arrow_right
                            </span>
                            {s}
                          </li>
                        ))}
                      </ul>
                    )}
                  </article>
                ))
              ) : (
                <div className="demo-day-empty">
                  <span
                    className="material-symbols-outlined"
                    aria-hidden="true"
                  >
                    event_available
                  </span>
                  <span>Nothing scheduled</span>
                </div>
              )}
            </div>
          </Reveal>
        ))}
      </div>
    </DemoSection>
  );
}

/* ============================================================
 * 3. PROJECTS
 * ============================================================ */

function ProjectsSection() {
  const projects = useMemo(() => demoProjects(), []);
  const bundles = useMemo(() => demoMilestones(), []);

  const statsOf = (projectId: string) => {
    const bs = bundles.filter((b) => b.milestone.projectId === projectId);
    const tasks = bs.flatMap((b) => b.tasks);
    const done = tasks.filter((t) => t.status === "Done").length;
    return {
      milestones: bs.length,
      tasks: tasks.length,
      done,
      percent: tasks.length ? Math.round((done / tasks.length) * 100) : 0,
    };
  };

  return (
    <DemoSection
      id="projects"
      eyebrow="Projects"
      icon="space_dashboard"
      title="Every project, broken down"
      desc="A brief becomes milestones, tasks and subtasks — each with an estimate, a deadline and an owner. AI does the decomposition."
    >
      <div className="demo-project-grid">
        {projects.map((p, i) => {
          const st = statsOf(p.id);
          return (
            <Reveal
              as="article"
              key={p.id}
              delay={i * 80}
              className="demo-project"
            >
              <div className="demo-project-head">
                <span className="demo-project-icon" aria-hidden="true">
                  <span className="material-symbols-outlined">
                    {p.status === "Completed" ? "task_alt" : "folder_open"}
                  </span>
                </span>
                <span
                  className={
                    "demo-chip" +
                    (p.status === "Active" ? " demo-chip--ai" : "")
                  }
                >
                  {p.status}
                </span>
              </div>
              <h3 className="demo-project-name">{p.name}</h3>
              <p className="demo-project-desc">{p.description}</p>
              {p.client && (
                <div className="demo-project-client">
                  <span
                    className="material-symbols-outlined"
                    aria-hidden="true"
                  >
                    person
                  </span>
                  <span>{p.client.name}</span>
                </div>
              )}
              <div className="demo-project-progress">
                <div
                  className="demo-project-progress-track"
                  role="progressbar"
                  aria-valuenow={st.percent}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-label={`${p.name} progress`}
                >
                  <div
                    className="demo-project-progress-fill"
                    style={{ width: `${st.percent}%` }}
                  />
                </div>
                <span className="demo-project-progress-text">
                  {st.done}/{st.tasks} tasks · {st.milestones} milestones
                </span>
              </div>
              <div className="demo-project-foot">
                <span className="demo-project-deadline">
                  <span
                    className="material-symbols-outlined"
                    aria-hidden="true"
                  >
                    event
                  </span>
                  Due {shortDate(p.deadline)}
                </span>
              </div>
            </Reveal>
          );
        })}
      </div>
    </DemoSection>
  );
}

/* ============================================================
 * 4. GROUPS
 * ============================================================ */

function GroupsSection() {
  const groups = useMemo(() => demoGroups(), []);
  const [openId, setOpenId] = useState<string | null>(null);

  return (
    <DemoSection
      id="groups"
      eyebrow="Groups"
      icon="groups"
      title="Work in groups, not alone"
      desc="Split the work, assign owners, and track real time per member. AI suggests who should take each task based on load and availability."
    >
      <div className="demo-group-list">
        {groups.map((g, i) => {
          const members = demoGroupMembers(g.id);
          const open = openId === g.id;
          return (
            <Reveal
              as="article"
              key={g.id}
              delay={i * 80}
              className={"demo-group" + (open ? " demo-group--open" : "")}
            >
              <button
                type="button"
                className="demo-group-head"
                onClick={() => setOpenId(open ? null : g.id)}
                aria-expanded={open}
              >
                <span className="demo-group-icon" aria-hidden="true">
                  <span className="material-symbols-outlined">
                    {g.status === "Archived" ? "inventory_2" : "groups"}
                  </span>
                </span>
                <span className="demo-group-head-text">
                  <span className="demo-group-name">{g.name}</span>
                  <span className="demo-group-desc">{g.description}</span>
                </span>
                <span className="demo-group-meta">
                  <span className="demo-chip">{g.memberCount} members</span>
                  <span
                    className="material-symbols-outlined demo-group-caret"
                    aria-hidden="true"
                  >
                    {open ? "expand_less" : "expand_more"}
                  </span>
                </span>
              </button>

              {open && (
                <div className="demo-group-body">
                  <div className="demo-group-section">
                    <span className="demo-group-section-head">Members</span>
                    <ul className="demo-member-list">
                      {members.map((m, mi) => (
                        <li
                          key={m.userId}
                          className="demo-member"
                          style={{ animationDelay: `${mi * 50}ms` }}
                        >
                          <span
                            className="demo-member-avatar"
                            aria-hidden="true"
                          >
                            {m.fullName.charAt(0).toUpperCase()}
                          </span>
                          <span className="demo-member-text">
                            <span className="demo-member-name">
                              {m.fullName}
                            </span>
                            <span className="demo-member-email">{m.email}</span>
                          </span>
                          <span
                            className={
                              "demo-chip" +
                              (m.role === "Leader" ? " demo-chip--ai" : "")
                            }
                          >
                            {m.role}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </div>
                  <div className="demo-group-section">
                    <span className="demo-group-section-head">
                      How AI helps inside a group
                    </span>
                    <ul className="demo-cta-list">
                      <li>
                        <span
                          className="material-symbols-outlined"
                          aria-hidden="true"
                        >
                          check_circle
                        </span>
                        Decompose a brief into milestones, tasks and subtasks
                      </li>
                      <li>
                        <span
                          className="material-symbols-outlined"
                          aria-hidden="true"
                        >
                          check_circle
                        </span>
                        Suggest the best assignee for every task
                      </li>
                      <li>
                        <span
                          className="material-symbols-outlined"
                          aria-hidden="true"
                        >
                          check_circle
                        </span>
                        Review and apply the plan before it touches the group
                      </li>
                    </ul>
                  </div>
                </div>
              )}
            </Reveal>
          );
        })}
      </div>
    </DemoSection>
  );
}

/* ============================================================
 * 5. PRICING (rút gọn)
 * ============================================================ */

const DEMO_PLANS = [
  {
    name: "Free",
    price: "0₫",
    period: "forever",
    note: "For trying it on your own work",
    features: [
      "1 project",
      "Basic AI planning",
      "Local schedule only",
      "Community support",
    ],
    featured: false,
  },
  {
    name: "Pro",
    price: "199k₫",
    period: "/month",
    note: "For freelancers billing real hours",
    features: [
      "Unlimited projects",
      "Full AI scheduling + auto-replan",
      "Google Calendar sync (two-way)",
      "Group workspaces",
      "AI decompose & assign",
      "Priority support",
    ],
    featured: true,
  },
  {
    name: "Team",
    price: "499k₫",
    period: "/month",
    note: "For small teams shipping together",
    features: [
      "Everything in Pro",
      "Up to 10 seats",
      "Shared group analytics",
      "Role-based access",
      "Audit log",
    ],
    featured: false,
  },
];

function PricingSection() {
  return (
    <DemoSection
      id="pricing"
      eyebrow="Pricing"
      icon="workspace_premium"
      title="Start free, upgrade when it pays for itself"
      desc="Every plan includes the AI planner. Upgrade when you need more projects, calendar sync and team workspaces."
    >
      <div className="demo-plan-grid">
        {DEMO_PLANS.map((p, i) => (
          <Reveal
            as="article"
            key={p.name}
            delay={i * 90}
            className={"demo-plan" + (p.featured ? " demo-plan--featured" : "")}
          >
            {p.featured && (
              <span className="demo-plan-badge">Most popular</span>
            )}
            <h3 className="demo-plan-name">{p.name}</h3>
            <p className="demo-plan-note">{p.note}</p>
            <div className="demo-plan-price">
              <span className="demo-plan-price-value">{p.price}</span>
              <span className="demo-plan-price-period">{p.period}</span>
            </div>
            <ul className="demo-plan-features">
              {p.features.map((f) => (
                <li key={f}>
                  <span
                    className="material-symbols-outlined"
                    aria-hidden="true"
                  >
                    check_circle
                  </span>
                  {f}
                </li>
              ))}
            </ul>
            <Link
              to="/register"
              className={
                "demo-btn demo-btn--block " +
                (p.featured ? "demo-btn--primary" : "demo-btn--ghost")
              }
            >
              {p.price === "0₫" ? "Start free" : "Get started"}
            </Link>
          </Reveal>
        ))}
      </div>

      <Reveal delay={120} className="demo-note">
        <span className="material-symbols-outlined" aria-hidden="true">
          info
        </span>
        <span>
          Prices shown are illustrative.{" "}
          <Link to="/pricing" className="demo-note-link">
            See the full pricing page
          </Link>{" "}
          for every plan and payment method.
        </span>
      </Reveal>
    </DemoSection>
  );
}

/* ============================================================
 * 6. CTA CUỐI
 * ============================================================ */

function FinalCta() {
  return (
    <section className="demo-final">
      <div className="demo-final-inner">
        <Reveal>
          <span className="demo-eyebrow demo-eyebrow--pill demo-eyebrow--inline">
            <span className="material-symbols-outlined" aria-hidden="true">
              rocket_launch
            </span>
            Your turn
          </span>
        </Reveal>
        <Reveal delay={60}>
          <h2 className="demo-final-title">
            This sample became your real schedule in one click
          </h2>
        </Reveal>
        <Reveal delay={120}>
          <p className="demo-final-sub">
            Create a free account and METANOIA starts learning your working
            habits today. No credit card, no setup.
          </p>
        </Reveal>
        <Reveal delay={180} className="demo-final-actions">
          <Link to="/register" className="demo-btn demo-btn--primary">
            <span className="material-symbols-outlined" aria-hidden="true">
              auto_awesome
            </span>
            Get started free
          </Link>
          <Link to="/pricing" className="demo-btn demo-btn--ghost">
            Compare plans
          </Link>
        </Reveal>
      </div>
    </section>
  );
}

/* ============================================================
 * Page
 * ============================================================ */

export function DemoPage() {
  /*
   * Đánh dấu "đã xem trang chủ" → sau lần đăng nhập đầu tiên, user được
   * đưa thẳng vào app thay vì quay lại trang giới thiệu.
   */
  useEffect(() => {
    markLandingSeen();
  }, []);

  return (
    <div className="demo-page">
      <DemoHero />
      <TodaySection />
      <ScheduleSection />
      <ProjectsSection />
      <GroupsSection />
      <PricingSection />
      <FinalCta />
    </div>
  );
}
