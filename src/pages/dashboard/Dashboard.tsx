import {
  useCallback,
  useEffect,
  useState,
  type FormEvent,
} from "react";
import { Link } from "react-router-dom";
import { useAuth } from "../../auth/AuthContext";
import { useStaggeredMount } from "../../hooks/useStaggeredMount";
import { listCalendar, type CalendarItemDto } from "../../lib/api-client";
import "./dashboard.css";

/* ---------- Hằng số cho nhịp độ của lịch ---------- */
/** Còn dưới ngưỡng này (phút) thì khung đang chạy được tô thêm viền cảnh báo. */
const SOON_THRESHOLD_MS = 5 * 60 * 1000;
/** Chu kỳ tick: đủ mịn cho đồng hồ đếm ngược, rẻ hơn cập nhật mỗi giây. */
const TICK_MS = 30 * 1000;

/** "42m" / "1h 05" — định dạng ngắn cho phần thời gian còn lại. */
function formatRemain(ms: number): string {
  if (ms <= 0) return "0m";
  const totalMin = Math.ceil(ms / 60_000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return h > 0 ? `${h}h ${String(m).padStart(2, "0")}` : `${m}m`;
}

/* ---------- Types ---------- */
type FocusStatus = "done" | "running" | "next" | "upcoming";
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
  /** Epoch ms của mốc bắt đầu — dùng để tính "sắp tới" theo phút. */
  startMs: number;
  /** Epoch ms của mốc kết thúc — dùng cho đếm ngược. */
  endMs: number;
  /** Epoch ms lúc render, để đếm ngược không phụ thuộc Date.now() mỗi lần vẽ. */
  nowMs: number;
}

interface UpcomingTask {
  id: string;
  title: string;
  due: string;
  urgency: "urgent" | "normal";
}

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

/* ---------- Calendar helpers ---------- */

const TZ = "vi-VN";

function fmtTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "--:--";
  return d.toLocaleTimeString(TZ, {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

function isAllDayOn(item: CalendarItemDto): boolean {
  if (item.isAllDay) return true;
  // Một sự kiện bị coi là all-day nếu span >= 20h (backend có thể bỏ cờ isAllDay).
  const s = new Date(item.start).getTime();
  const e = new Date(item.end).getTime();
  if (Number.isNaN(s) || Number.isNaN(e)) return false;
  return e - s >= 20 * 60 * 60 * 1000;
}

/** Map 1 item của API calendar → FocusSlot cho timeline. */
function itemToSlot(item: CalendarItemDto, now: Date): FocusSlot | null {
  const start = new Date(item.start);
  const end = new Date(item.end);
  if (Number.isNaN(start.getTime())) return null;

  const durationMin = Number.isNaN(end.getTime())
    ? 0
    : Math.max(0, Math.round((end.getTime() - start.getTime()) / 60000));

  // Title: ưu tiên subtask > task > raw title
  const title =
    item.subTaskTitle?.trim() || item.title?.trim() || "Untitled block";

  // Desc: ghép các ngữ cảnh có sẵn từ API
  const descParts = [
    item.projectName?.trim(),
    item.clientName?.trim(),
    item.domainName?.trim(),
  ].filter(Boolean);
  const desc =
    item.explanation?.trim() ||
    descParts.join(" · ") ||
    "Khối thời gian tập trung từ lịch của bạn.";

  // Status dựa trên mốc thời gian + trạng thái task
  const statusLower = (item.status ?? "").toLowerCase();
  const cancelled =
    statusLower === "cancelled" || statusLower === "canceled";
  let status: FocusStatus;
  if (cancelled) {
    status = "upcoming";
  } else if (end.getTime() <= now.getTime()) {
    status = "done";
  } else if (start.getTime() <= now.getTime()) {
    status = "running";
  } else {
    // Khung tương lai: đánh `next` cho khung gần nhất, còn lại là `upcoming`.
    // Logic chính xác hoá phân tầng nổi bật diễn ra ở useEffect tick (xem
    // `promoteNextSlot`), vì `now` ở đây chỉ là giá trị tại thời điểm load.
    status = "upcoming";
  }

  // Type: suy ra từ nguồn của sự kiện
  const src = (item.source ?? "").toLowerCase();
  let type: FocusType;
  if (src === "google") type = "meeting";
  else if (src === "slot") type = "focus";
  else if (src === "milestone") type = "reading";
  else type = "task";

  // Tags dựng từ metadata API
  const tags: FocusSlot["tags"] = [];
  if (src === "google") tags.push({ label: "Google Calendar", tone: "muted" });
  if (item.googleEventId) tags.push({ label: "Synced", tone: "success" });
  if (status === "running") tags.push({ label: "Focus Peak", tone: "primary" });
  if (item.subTaskId) tags.push({ label: "Atomic Task", tone: "muted" });
  if (item.taskType?.trim()) {
    tags.push({ label: item.taskType.trim(), tone: "muted" });
  }
  if (durationMin > 0) {
    tags.push({
      label:
        durationMin >= 60
          ? `${Math.floor(durationMin / 60)}h${durationMin % 60 ? ` ${durationMin % 60}m` : ""}`
          : `${durationMin} min`,
      tone: "muted",
    });
  }
  if (item.isManualOverride) {
    tags.push({ label: "Manual", tone: "warning" });
  }
  if (item.syncFailed) {
    tags.push({ label: "⚠ Sync failed", tone: "warning" });
  }

  return {
    id: item.id,
    start: fmtTime(item.start),
    end: isAllDayOn(item) ? "All day" : fmtTime(item.end),
    title,
    desc,
    type,
    status,
    tags,
    startMs: start.getTime(),
    endMs: end.getTime(),
    nowMs: now.getTime(),
  };
}

/* ============================================================
 * withUpNext — đánh lại tầng nổi bật cho danh sách slot.
 *
 * Quy tắc (chỉ đúng 1 khung mỗi tầng):
 *   done      : đã qua `end`
 *   running   : đã qua `start`, chưa qua `end`  (đang diễn ra)
 *   next      : khung tương lai GẦN NHẤT       (chỉ đúng 1 cái)
 *   upcoming  : các khung tương lai còn lại
 *
 * Dùng chung cho lúc load và mỗi lần tick, nên hai đường không thể lệch nhau.
 * ============================================================ */
function withUpNext(slots: FocusSlot[], nowMs: number): FocusSlot[] {
  let nextIdx = -1;
  for (let i = 0; i < slots.length; i++) {
    const s = slots[i];
    if (s.status === "done") continue;
    if (s.startMs <= nowMs) continue;
    if (nextIdx === -1 || s.startMs < slots[nextIdx].startMs) nextIdx = i;
  }
  return slots.map((s, i) => {
    let status: FocusStatus;
    if (s.endMs <= nowMs) status = "done";
    else if (s.startMs <= nowMs) status = "running";
    else status = i === nextIdx ? "next" : "upcoming";
    return { ...s, status, nowMs };
  });
}

/* ============================================================
 * DashboardPage — homepage sau khi đăng nhập.
 *
 * Bố cục (Progressive Disclosure + High-clarity UX):
 *  1) Header Welcome Bar: greeting + status overview + actions.
 *  2) Top 3 Minimalist Key Metrics (energy peak, K_bias, today).
 *  3) Main grid 8/4 (65% / 35%):
 *      - Left  (8/12): Today's recommended schedule (timeline).
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
  // Focus slots lấy thật từ API calendar theo ngày hôm nay.
  const [focusSlots, setFocusSlots] = useState<FocusSlot[]>([]);
  const [slotsLoading, setSlotsLoading] = useState(true);
  const [slotsError, setSlotsError] = useState<string | null>(null);
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

  /* ---------- Load hôm nay từ API calendar ---------- */
  const loadTodaySchedule = useCallback(async () => {
    setSlotsLoading(true);
    setSlotsError(null);
    // Khoảng [00:00 hôm nay, 00:00 ngày mai) theo local time.
    const dayStart = new Date();
    dayStart.setHours(0, 0, 0, 0);
    const dayEnd = new Date(dayStart);
    dayEnd.setDate(dayEnd.getDate() + 1);

    const res = await listCalendar({
      from: dayStart.toISOString(),
      to: dayEnd.toISOString(),
      includeCancelled: false,
    });

    if (!res.ok) {
      setFocusSlots([]);
      setSlotsError(res.error);
      setSlotsLoading(false);
      return;
    }

    const now = new Date();
    const slots = withUpNext(
      (res.data.items ?? [])
        .map((item) => itemToSlot(item, now))
        .filter((s): s is FocusSlot => s !== null)
        .sort((a, b) => {
          // Sắp xếp theo giờ bắt đầu thật (không so sánh string HH:mm)
          const toMin = (t: string) => {
            if (t === "All day") return -1;
            const [h, m] = t.split(":").map(Number);
            return h * 60 + m;
          };
          return toMin(a.start) - toMin(b.start);
        }),
      now.getTime(),
    );

    setFocusSlots(slots);
    setSlotsLoading(false);
  }, []);

  useEffect(() => {
    void loadTodaySchedule();
  }, [loadTodaySchedule]);

  /* ---------- Tính lại status + nowMs mỗi TICK_MS ----------
   * Lý do: status (`done`/`running`/`next`) chỉ đúng tại thời điểm load.
   * Khi khung hiện tại hết giờ, ta cần tự động đánh `done` cho nó và thăng
   * cấp khung kế tiếp lên `next`/`running`. Tick mỗi 30 giây đủ mịn cho
   * đồng hồ đếm ngược, không tốn render.
   */
  useEffect(() => {
    const tick = () => {
      const nowMs = Date.now();
      setFocusSlots((prev) => {
        if (prev.length === 0) return prev;
        // Dùng chung `withUpNext` với lúc load: luôn đảm bảo đúng 1 `running`
        // và đúng 1 `next`, nên không bao giờ tồn tại 2 badge "Up next".
        const nextList = withUpNext(prev, nowMs);
        // Bỏ qua setState nếu không có gì đổi (tránh render thừa mỗi 30s).
        const unchanged =
          nextList.length === prev.length &&
          nextList.every(
            (s, i) =>
              s.status === prev[i].status && s.nowMs === prev[i].nowMs,
          );
        return unchanged ? prev : nextList;
      });
    };
    // Tick ngay lập tức (phòng trường hợp load xong đã muộn hơn giờ kết thúc
    // của slot đầu), sau đó đặt interval.
    tick();
    const id = window.setInterval(tick, TICK_MS);
    return () => window.clearInterval(id);
  }, []);

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
              <span>Quick add task</span>
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
              <span className="dash-metric-label">
                Time multiplier
              </span>
              <span className="dash-chip dash-chip--primary">AI</span>
            </div>

            <div className="dash-metric-value">
              <span className="dash-metric-number">1.34x</span>
            </div>

            <div className="dash-metric-foot dash-metric-foot--pinned">
              <span>Bias compensation</span>
              <span className="dash-metric-foot-emph">+34%</span>
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
              <span className="dash-chip dash-chip--success">Tuesday</span>
            </div>
            <div className="dash-metric-value">
              <span className="dash-metric-number">3/5</span>
            </div>
            <div className="dash-metric-foot dash-metric-foot--pinned">
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
              </div>
              <span className="dash-col-meta">Timezone: UTC+7</span>
            </div>

            <div className="dash-slots">
              {slotsLoading && (
                <div className="dash-slots-state">
                  <span className="material-symbols-outlined dash-slots-state-icon">
                    progress_activity
                  </span>
                  <span>Đang tải lịch hôm nay…</span>
                </div>
              )}

              {!slotsLoading && slotsError && (
                <div className="dash-slots-state dash-slots-state--error">
                  <span className="material-symbols-outlined dash-slots-state-icon">
                    error
                  </span>
                  <span>{slotsError}</span>
                  <button
                    type="button"
                    className="dash-slots-state-retry"
                    onClick={() => void loadTodaySchedule()}
                  >
                    Thử lại
                  </button>
                </div>
              )}

              {!slotsLoading && !slotsError && focusSlots.length === 0 && (
                <div className="dash-slots-state">
                  <span className="material-symbols-outlined dash-slots-state-icon">
                    event_available
                  </span>
                  <span>Chưa có khối thời gian nào được xếp lịch cho hôm nay.</span>
                </div>
              )}

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
  const isRunning = slot.status === "running";
  const isNext = slot.status === "next";
  const isDone = slot.status === "done";

  // Đếm ngược cho khung đang chạy: phần giờ còn lại tới `end`.
  const remainMs = (slot.endMs ?? 0) - slot.nowMs;
  const isEndingSoon = isRunning && remainMs > 0 && remainMs <= SOON_THRESHOLD_MS;
  const remainLabel = isRunning
    ? formatRemain(remainMs)
    : null;

  return (
    <article
      className={
        "dash-slot" +
        ` dash-slot--t-${slot.type}` +
        (isRunning ? " dash-slot--running" : "") +
        (isNext ? " dash-slot--next" : "") +
        (isEndingSoon ? " dash-slot--ending" : "") +
        (isDone ? " dash-slot--done" : "") +
        (mounted ? " dash-slot--in" : "")
      }
      style={delayStyle}
    >
      <span className="dash-slot-bar" aria-hidden="true" />

      <div className="dash-slot-time">
        <span
          className={
            "dash-slot-time-start" +
            (isRunning || isNext ? " dash-slot-time-start--focus" : "")
          }
        >
          {slot.start}
        </span>
        <span className="dash-slot-time-end">{slot.end}</span>
        <span className="dash-slot-time-rule" aria-hidden="true" />
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

      <div className="dash-slot-right">
        {slot.status === "done" && (
          <span className="dash-slot-status dash-slot-status--done">
            <span
              className="material-symbols-outlined"
              style={{ fontVariationSettings: "'FILL' 1", fontSize: 14 }}
            >
              check_circle
            </span>
            Done
          </span>
        )}
        {slot.status === "running" && (
          <span className="dash-slot-status dash-slot-status--running">
            <span className="dash-slot-ping dash-slot-ping--running" aria-hidden="true" />
            <span className="dash-slot-status-meta">
              <span className="dash-slot-status-eyebrow">In progress</span>
              <span className="dash-slot-status-time" aria-live="polite">
                {remainLabel ? `${remainLabel} left` : "Ending"}
              </span>
            </span>
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
