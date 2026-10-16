import { useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { useAuth } from "../../auth/AuthContext";
import { useStaggeredMount } from "../../hooks/useStaggeredMount";
import "./dashboard.css";

/* ---------- Types ---------- */
type FocusStatus = "done" | "next" | "upcoming";
type FocusType = "meeting" | "focus" | "reading" | "task";

interface FocusSlot {
  id: string;
  start: string;
  end: string;
  title: string;
  desc: string;
  type: FocusType;
  status: FocusStatus;
  tags: { label: string; tone?: "primary" | "success" | "muted" | "warning" }[];
  meta?: string;
}

interface UpcomingTask {
  id: string;
  title: string;
  due: string;
  urgency: "urgent" | "normal";
}

const FOCUS_SLOTS: FocusSlot[] = [
  {
    id: "s1",
    start: "09:00",
    end: "10:30",
    title: "Weekly Capstone sync with Dr. Cam Huong",
    desc: "Finalize Vector Search architecture & K_bias evaluation criteria.",
    type: "meeting",
    status: "done",
    tags: [
      { label: "Google Calendar", tone: "muted" },
      { label: "Synced", tone: "success" },
    ],
  },
  {
    id: "s2",
    start: "14:00",
    end: "16:15",
    title: "Write Backend Clean Architecture & Hangfire Hubs",
    desc: "Implement recurring background jobs to sync the cognitive-energy matrix.",
    type: "focus",
    status: "next",
    tags: [
      { label: "Focus Peak", tone: "primary" },
      { label: "Atomic Task", tone: "muted" },
      { label: "+23m recovery buffer", tone: "warning" },
    ],
  },
  {
    id: "s3",
    start: "16:30",
    end: "17:30",
    title: "Review research docs and pgvector embeddings",
    desc: "Benchmark recall & query latency for semantic search.",
    type: "reading",
    status: "upcoming",
    tags: [
      { label: "Deep Reading", tone: "muted" },
      { label: "60 min", tone: "muted" },
    ],
  },
];

const UPCOMING: UpcomingTask[] = [
  {
    id: "t1",
    title: "Submit Sprint 1 report",
    due: "Due: 17:00",
    urgency: "urgent",
  },
  {
    id: "t2",
    title: "Sync with DevOps on Redis infrastructure",
    due: "Due: 18:30",
    urgency: "normal",
  },
];

/* ============================================================
 * DashboardPage — homepage sau khi đăng nhập.
 *
 * Bố cục (Progressive Disclosure + High-clarity UX):
 *  1) Header Welcome Bar: greeting + status overview + actions.
 *  2) Top 3 Minimalist Key Metrics (energy peak, K_bias, today).
 *  3) Main grid 8/4 (65% / 35%):
 *      - Left  (8/12): AI Recommended Focus Slots (timeline).
 *      - Right (4/12): Quick Task Drawer (input + upcoming + AI tip).
 *
 * Class prefix `.dash-*`. Render bên trong <SiteLayout /> để có header/footer
 * chuẩn + nav active "Trang chủ".
 * ============================================================ */
export function DashboardPage() {
  const { user } = useAuth();
  const [quickTask, setQuickTask] = useState("");
  // Danh sách task sắp đến hạn — khởi tạo từ UPCOMING, có thể thêm khi user
  // nhấn Enter ở quick input. Lưu state để có thể trigger re-animation.
  const [upcomingTasks, setUpcomingTasks] = useState<UpcomingTask[]>(UPCOMING);
  // Focus slots cũng dynamic (vd: sau sync Google Calendar có thể thêm slot)
  const [focusSlots] = useState<FocusSlot[]>(FOCUS_SLOTS);
  const [toast, setToast] = useState<{
    visible: boolean;
    text: string;
    icon: string;
  }>({ visible: false, text: "", icon: "check_circle" });

  // Stagger animation cho 3 khu vực chính (welcome / metrics / workspace).
  // Tất cả dùng cùng `mounted` để bắt đầu sau một nhịp ngắn cho cảm giác
  // mạch lạc.
  const { mounted: pageMounted } = useStaggeredMount(0, 30);
  // Stagger riêng cho 3 metric cards (mỗi card delay +70ms).
  const metricsAnim = useStaggeredMount(70, 120);
  // Stagger cho timeline slots (mỗi slot +90ms).
  const slotsAnim = useStaggeredMount(90, 220, focusSlots.length);
  // Stagger cho upcoming tasks (mỗi task +80ms), trigger lại khi list đổi.
  const tasksAnim = useStaggeredMount(80, 260, upcomingTasks.length);

  function showToast(text: string, icon: string = "check_circle") {
    setToast({ visible: true, text, icon });
    window.setTimeout(() => {
      setToast((t) => ({ ...t, visible: false }));
    }, 3200);
  }

  function handleQuickAdd(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const v = quickTask.trim();
    if (!v) return;
    const trimmed = v.length > 28 ? v.slice(0, 28) + "..." : v;
    setQuickTask("");
    // Prepend new task -> list.length changes -> tasksAnim re-runs.
    const newTask: UpcomingTask = {
      id: `t${Date.now()}`,
      title: v,
      due: "Just added",
      urgency: "normal",
    };
    setUpcomingTasks((prev) => [newTask, ...prev]);
    showToast(`Added "${trimmed}" to the task inbox`);
  }

  function handleSync() {
    showToast("Scanning and syncing with Google Calendar…", "sync");
    window.setTimeout(() => {
      showToast("Sync complete! Optimized schedule is preserved.");
    }, 1200);
  }

  function handleQuickAddFocus() {
    const el = document.getElementById("dash-quick-input");
    if (el) {
      el.focus({ preventScroll: true });
      el.classList.add("dash-input--ring");
      window.setTimeout(() => el.classList.remove("dash-input--ring"), 1000);
    }
  }

  // Take the first whitespace-separated name part for the greeting
  // (e.g. "Chào <First> 👋") with a safe fallback when name is null.
  const firstName = (user?.name ?? "there").trim().split(/\s+/)[0];

  return (
    <div className="dash">
      <div className="dash-ambient" aria-hidden="true" />

      <div className="dash-container">
        {/* ================= Welcome Bar ================= */}
        <section
          className={"dash-welcome" + (pageMounted ? " dash-welcome--in" : "")}
        >
          <div className="dash-welcome-text">
            <span className="dash-eyebrow">
              <span
                className="material-symbols-outlined"
                style={{ fontVariationSettings: "'FILL' 1" }}
              >
                auto_awesome
              </span>
              Cognitive Co-Pilot v2.4
            </span>
            <h1 className="dash-title">
              Hi {firstName}{" "}
              <span
                className="dash-wave"
                role="img"
                aria-label="hello"
              >
                👋
              </span>
            </h1>
            <p className="dash-subtitle">
              Today you have{" "}
              <span className="dash-strong">3 focus tasks</span>. Peak energy
              hits{" "}
              <span className="dash-success">88%</span> at 14:00.
            </p>
          </div>

          <div className="dash-actions">
            <button
              type="button"
              onClick={handleSync}
              className="dash-btn dash-btn--ghost"
            >
              <span className="material-symbols-outlined dash-btn-icon">sync</span>
              <span>Sync Google Calendar</span>
            </button>
            <button
              type="button"
              onClick={handleQuickAddFocus}
              className="dash-btn dash-btn--primary"
            >
              <span className="material-symbols-outlined dash-btn-icon">
                add
              </span>
              <span>+ Quick add task</span>
            </button>
          </div>
        </section>

        {/* ================= 3 Key Metrics ================= */}
        <section
          className={"dash-metrics" + (pageMounted ? " dash-metrics--in" : "")}
        >
          {/* Metric 1: Energy Peak */}
          <article
            className={
              "dash-metric" +
              (metricsAnim.mounted ? " dash-metric--in" : "")
            }
            style={metricsAnim.getDelay(0)}
          >
            <div className="dash-metric-head">
              <span className="dash-metric-label">
                Focus energy (Circadian Peak)
              </span>
              <span className="dash-chip dash-chip--success">Optimal</span>
            </div>
            <div className="dash-metric-value">
              <span className="dash-metric-number">88%</span>
              <span className="dash-metric-trend">
                <span className="material-symbols-outlined">north_east</span>
                Bio peak
              </span>
            </div>
            <div className="dash-metric-foot">
              <span>Deep work window</span>
              <span className="dash-metric-foot-emph">14:00 - 16:30</span>
            </div>
            <div className="dash-sparkline" aria-hidden="true">
              <svg
                className="dash-sparkline-svg"
                fill="none"
                preserveAspectRatio="none"
                viewBox="0 0 100 25"
              >
                <path
                  d="M0,20 Q20,18 35,10 T65,4 T85,15 T100,12 L100,25 L0,25 Z"
                  fill="currentColor"
                  fillOpacity="0.15"
                />
                <path
                  d="M0,20 Q20,18 35,10 T65,4 T85,15 T100,12"
                  stroke="currentColor"
                  strokeLinecap="round"
                  strokeWidth="2"
                />
              </svg>
            </div>
          </article>

          {/* Metric 2: K_bias */}
          <article
            className={
              "dash-metric" +
              (metricsAnim.mounted ? " dash-metric--in" : "")
            }
            style={metricsAnim.getDelay(1)}
          >
            <div className="dash-metric-head">
              <div className="dash-metric-head-left">
                <span className="dash-metric-label">
                  Time adjustment coefficient
                </span>
                <span
                  className="dash-chip dash-chip--mono"
                  title="T_proposed = 60m × 1.34 + 20m bio-recovery buffer = 100m total block (Self-adaptive K_bias algorithm)"
                >
                  K_bias
                </span>
              </div>
              <span className="dash-chip dash-chip--primary">
                AI Compensated
              </span>
            </div>

            <div className="dash-metric-value dash-metric-value--split">
              <div className="dash-metric-value-left">
                <span className="dash-metric-number">1.34x</span>
                <span className="dash-metric-mono">(Bias)</span>
              </div>
              <div className="dash-metric-value-right">
                <span className="dash-metric-number dash-metric-number--sm dash-metric-number--success">
                  100m
                </span>
                <span className="dash-metric-sub">Total allocated</span>
              </div>
            </div>

            <div className="dash-formula">
              <code className="dash-formula-code">
                T_proposed = (T_est × K_bias) + Δt
              </code>
              <span className="dash-formula-addon">+20m recovery buffer</span>
            </div>

            <div
              className="dash-bar"
              role="img"
              aria-label="60 min base, 20 min bias compensation, 20 min recovery buffer"
            >
              <div
                className="dash-bar-seg dash-bar-seg--60"
                style={{ width: "60%" }}
              />
              <div
                className="dash-bar-seg dash-bar-seg--20a"
                style={{ width: "20%" }}
              />
              <div
                className="dash-bar-seg dash-bar-seg--20b"
                style={{ width: "20%" }}
              />
            </div>

            <div className="dash-bar-legend">
              <span>Base: 60m → Compensated: 80m</span>
              <span className="dash-strong">+20m buffer = 100m</span>
            </div>
          </article>

          {/* Metric 3: Today tasks */}
          <article
            className={
              "dash-metric" +
              (metricsAnim.mounted ? " dash-metric--in" : "")
            }
            style={metricsAnim.getDelay(2)}
          >
            <div className="dash-metric-head">
              <span className="dash-metric-label">Today's tasks</span>
              <span className="dash-chip dash-chip--muted">Tuesday</span>
            </div>
            <div className="dash-metric-value">
              <span className="dash-metric-number">3/5</span>
              <span className="dash-metric-trend dash-metric-trend--mono">
                60% complete
              </span>
            </div>
            <div className="dash-metric-foot">
              <span>Remaining today</span>
              <span className="dash-metric-foot-emph">2 tasks to resolve</span>
            </div>
            <div
              className="dash-progress"
              role="progressbar"
              aria-valuenow={60}
              aria-valuemin={0}
              aria-valuemax={100}
            >
              <div className="dash-progress-fill" style={{ width: "60%" }} />
            </div>
            <div className="dash-bar-legend">
              <span>Done: 3</span>
              <span>Total: 5</span>
            </div>
          </article>
        </section>

        {/* ================= Workspace (8/4) ================= */}
        <section
          className={
            "dash-workspace" + (pageMounted ? " dash-workspace--in" : "")
          }
        >
          {/* Left column: Focus slots */}
          <div className="dash-col-left">
            <div className="dash-col-head">
              <div className="dash-col-head-left">
                <span className="dash-col-dot" />
                <h2 className="dash-col-title">Today's recommended schedule</h2>
                <span className="dash-col-sub">
                  (AI Recommended Focus Slots)
                </span>
              </div>
              <span className="dash-col-meta">Timezone: UTC+7</span>
            </div>

            <div className="dash-slots">
              {focusSlots.map((slot, i) => (
                <FocusSlotCard
                  key={`${slotsAnim.bumpKey}-${slot.id}`}
                  slot={slot}
                  index={i}
                  mounted={slotsAnim.mounted}
                  delayStyle={slotsAnim.getDelay(i)}
                />
              ))}
            </div>

            <div className="dash-col-footer">
              <Link
                to="/dashboard"
                className="dash-link-primary"
                onClick={(e) => e.preventDefault()}
              >
                <span>View full detailed schedule</span>
                <span className="material-symbols-outlined">arrow_forward</span>
              </Link>
            </div>
          </div>

          {/* Right column: Quick task drawer */}
          <aside className="dash-col-right">
            <div className="dash-col-head">
              <div className="dash-col-head-left">
                <span className="material-symbols-outlined dash-col-icon">
                  inbox
                </span>
                <h2 className="dash-col-title">Quick task inbox</h2>
              </div>
              <span className="dash-col-meta">Drawer</span>
            </div>

            <div className="dash-drawer">
              {/* Input */}
              <form className="dash-input-form" onSubmit={handleQuickAdd}>
                <input
                  id="dash-quick-input"
                  type="text"
                  value={quickTask}
                  onChange={(e) => setQuickTask(e.target.value)}
                  placeholder="Type a task and press Enter…"
                  className="dash-input"
                />
                <button
                  type="submit"
                  aria-label="Save quickly"
                  className="dash-input-submit"
                >
                  <span className="material-symbols-outlined">
                    keyboard_return
                  </span>
                </button>
              </form>

              {/* Upcoming */}
              <div className="dash-drawer-section">
                <div className="dash-drawer-section-head">
                  <span className="dash-drawer-section-title">
                    Upcoming
                  </span>
                  <span className="dash-drawer-section-count">
                    {upcomingTasks.length} tasks
                  </span>
                </div>
                <div className="dash-tasks">
                  {upcomingTasks.map((t, i) => (
                    <UpcomingTaskItem
                      key={`${tasksAnim.bumpKey}-${t.id}`}
                      task={t}
                      index={i}
                      mounted={tasksAnim.mounted}
                      delayStyle={tasksAnim.getDelay(i)}
                    />
                  ))}
                </div>
              </div>

              {/* AI tip */}
              <div className="dash-tip">
                <span
                  className="material-symbols-outlined dash-tip-icon"
                  style={{ fontVariationSettings: "'FILL' 1" }}
                >
                  tips_and_updates
                </span>
                <div className="dash-tip-body">
                  <div className="dash-tip-head">
                    <span className="dash-tip-title">AI suggestion</span>
                    <span className="dash-tip-dot" />
                  </div>
                  <p className="dash-tip-text">
                    Today you shouldn't take on more complex tasks after{" "}
                    <strong className="dash-strong">20:00</strong> since
                    biological energy is projected to drop sharply (&lt;35%).
                  </p>
                </div>
              </div>
            </div>
          </aside>
        </section>
      </div>

      {/* ================= Toast ================= */}
      <div
        className={"dash-toast" + (toast.visible ? " dash-toast--show" : "")}
        role="status"
        aria-live="polite"
      >
        <span
          className={
            "material-symbols-outlined dash-toast-icon" +
            (toast.icon === "sync" ? " dash-toast-icon--spin" : "")
          }
        >
          {toast.icon}
        </span>
        <span className="dash-toast-text">{toast.text}</span>
      </div>
    </div>
  );
}

/* ============================================================
 * Sub-components
 * ============================================================ */

function FocusSlotCard({
  slot,
  mounted,
  delayStyle,
}: {
  slot: FocusSlot;
  index: number;
  mounted: boolean;
  delayStyle: { animationDelay: string };
}) {
  const isFocus = slot.status === "next";
  const isDone = slot.status === "done";

  return (
    <article
      className={
        "dash-slot" +
        (isFocus ? " dash-slot--focus" : "") +
        (isDone ? " dash-slot--done" : "") +
        (mounted ? " dash-slot--in" : "")
      }
      style={delayStyle}
    >
      {isFocus && <span className="dash-slot-bar" aria-hidden="true" />}

      <div className="dash-slot-inner">
        <div className="dash-slot-left">
          <div
            className={
              "dash-slot-time" + (isFocus ? " dash-slot-time--focus" : "")
            }
          >
            <span
              className={
                "dash-slot-time-start" +
                (isFocus ? " dash-slot-time-start--focus" : "")
              }
            >
              {slot.start}
            </span>
            <span className="dash-slot-time-end">{slot.end}</span>
          </div>

          <div className="dash-slot-body">
            <div className="dash-slot-tags">
              {slot.tags.map((t, i) => (
                <span
                  key={i}
                  className={
                    "dash-tag" +
                    (t.tone === "primary"
                      ? " dash-tag--primary"
                      : t.tone === "success"
                        ? " dash-tag--success"
                        : t.tone === "warning"
                          ? " dash-tag--warning"
                          : " dash-tag--muted")
                  }
                >
                  {t.tone === "primary" && (
                    <span className="material-symbols-outlined dash-tag-icon">
                      bolt
                    </span>
                  )}
                  {t.tone === "success" && (
                    <span
                      className="material-symbols-outlined dash-tag-icon"
                      style={{ fontVariationSettings: "'FILL' 1" }}
                    >
                      check_circle
                    </span>
                  )}
                  {t.label}
                </span>
              ))}
            </div>
            <h3 className="dash-slot-title">{slot.title}</h3>
            <p className="dash-slot-desc">{slot.desc}</p>
          </div>
        </div>

        <div className="dash-slot-right">
          {slot.status === "done" && (
            <span className="dash-slot-status dash-slot-status--done">
              Done
            </span>
          )}
          {slot.status === "next" && (
            <span className="dash-slot-status dash-slot-status--next">
              <span className="dash-slot-ping" aria-hidden="true" />
              Up next
            </span>
          )}
          {slot.status === "upcoming" && (
            <button
              type="button"
              title="Snooze"
              aria-label="Options"
              className="dash-slot-more"
            >
              <span className="material-symbols-outlined">more_horiz</span>
            </button>
          )}
        </div>
      </div>
    </article>
  );
}

function UpcomingTaskItem({
  task,
  mounted,
  delayStyle,
}: {
  task: UpcomingTask;
  index: number;
  mounted: boolean;
  delayStyle: { animationDelay: string };
}) {
  return (
    <div
      className={"dash-task" + (mounted ? " dash-task--in" : "")}
      style={delayStyle}
    >
      <div className="dash-task-left">
        <input
          type="checkbox"
          aria-label={`Complete: ${task.title}`}
          className="dash-task-check"
        />
        <div>
          <p className="dash-task-title">{task.title}</p>
          <div className="dash-task-meta">
            <span className="dash-task-due">{task.due}</span>
            <span
              className={
                "dash-urgency" +
                (task.urgency === "urgent"
                  ? " dash-urgency--urgent"
                  : " dash-urgency--normal")
              }
            >
              {task.urgency === "urgent" ? "Khẩn cấp" : "Bình thường"}
            </span>
          </div>
        </div>
      </div>
      <span className="material-symbols-outlined dash-task-chev">
        chevron_right
      </span>
    </div>
  );
}
