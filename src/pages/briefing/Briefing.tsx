import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import {
  getTodayBriefing,
  type BriefingAtRisk,
  type BriefingReasonCode,
  type BriefingResponse,
  type BriefingScheduleItem,
  type BriefingTopTask,
} from "../../lib/api-client";
import "./briefing.css";

/* ===========================================================
 * Briefing hôm nay  (/briefing)
 *
 * Trang "1 màn hình, 1 việc": AI service gộp sẵn task + slot + lịch
 * Google + hồ sơ năng suất của user rồi trả về trong **1** call
 * `GET /briefing/today?language=vi|en`.
 *
 * Vì sao không đưa vào Dashboard?
 *   Dashboard đã có 7 khối (welcome, 4 metric, mini-calendar, stats
 *   "Hôm nay", schedule, radar, tip) → thêm nữa sẽ loãng. Brief có
 *   4 nhóm nội dung riêng (gợi ý, task ưu tiên, task thiếu thời gian,
 *   lịch hôm nay) → tách trang riêng, Dashboard chỉ link sang.
 *
 * Quy tắc:
 *   - Read-only: endpoint này **không** tốn quota AI, không gọi LLM.
 *   - `schedule[]` của AI chỉ để HIỂN THIỊ. Nguồn sự thật cho các
 *     hành động tương tác (bấm slot để bắt đầu focus) vẫn là
 *     `GET /api/calendar` của BE — vì calendar BE giàu thông tin hơn
 *     (subTaskId, googleEventId, syncFailed, isManualOverride).
 *   - `top_tasks[]` KHÔNG có `project_id` (chỉ có `project_name` dạng
 *     text) → không deep-link được tới project. Chỉ hiển thị.
 *
 * Scope class prefix `.brf-*`.
 * =========================================================== */

/* ---------- helpers ---------- */

/** "2h 05" / "45m" — định dạng phút cho giao diện. */
function fmtMinutes(m: number | null | undefined): string {
  if (m === null || m === undefined || !Number.isFinite(m)) return "—";
  if (m <= 0) return "0m";
  const h = Math.floor(m / 60);
  const r = m % 60;
  if (h === 0) return `${r}m`;
  if (r === 0) return `${h}h`;
  return `${h}h ${String(r).padStart(2, "0")}`;
}

/** "09:00" — giờ theo múi giờ máy. */
function fmtHHmm(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return `${String(d.getHours()).padStart(2, "0")}:${String(
    d.getMinutes(),
  ).padStart(2, "0")}`;
}

/** "30/10/2026" — ngày kiểu Việt Nam, không phụ thuộc locale máy. */
function fmtDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("vi-VN", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  });
}

/** "Thứ Sáu" — tên ngày trong tuần. */
function fmtWeekday(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const raw = d.toLocaleDateString("vi-VN", { weekday: "long" });
  return raw.charAt(0).toUpperCase() + raw.slice(1);
}

/**
 * Icon + tone cho 1 mã lý do của AI.
 * `ReasonCode` trong openapi: overdue | at_risk | in_progress |
 * deadline_soon | bias
 */
const REASON_META: Record<
  BriefingReasonCode,
  { icon: string; label: string; tone: string }
> = {
  overdue: { icon: "event_busy", label: "Quá hạn", tone: "danger" },
  at_risk: { icon: "warning", label: "Thiếu thời gian", tone: "warning" },
  in_progress: { icon: "play_circle", label: "Đang làm", tone: "info" },
  deadline_soon: { icon: "schedule", label: "Sắp đến hạn", tone: "neutral" },
  bias: { icon: "psychology", label: "Lệch ước lượng", tone: "primary" },
};

/** Nhãn + màu cho nguồn của 1 dòng lịch. */
const KIND_META: Record<
  BriefingScheduleItem["kind"],
  { icon: string; label: string }
> = {
  slot: { icon: "bolt", label: "METANOIA" },
  fixed: { icon: "lock", label: "Fixed" },
  google: { icon: "event", label: "Google" },
};

/* ===========================================================
 * Main page
 * =========================================================== */
export function BriefingPage() {
  const [data, setData] = useState<BriefingResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  /**
   * Nạp lại briefing (dùng cho nút "Làm mới" / "Thử lại").
   *
   * Lưu ý: hàm này setState **đồng bộ** ở đầu → không gọi trực tiếp trong
   * `useEffect` (react-hooks/set-state-in-effect). Effect đầu tiên dùng
   * đường riêng bên dưới.
   */
  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const res = await getTodayBriefing("vi");
    if (res.ok) {
      setData(res.data);
    } else {
      setData(null);
      setError(res.error);
    }
    setLoading(false);
  }, []);

  /* Lần tải đầu tiên: setState chỉ chạy SAU await → không vi phạm
     react-hooks/set-state-in-effect, và không render 2 lần liên tiếp. */
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const res = await getTodayBriefing("vi");
      if (cancelled) return;
      if (res.ok) {
        setData(res.data);
      } else {
        setError(res.error);
      }
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  /* ---------- derived ---------- */

  /** Lịch hôm nay: gộp `schedule[]` (có giờ) + `all_day[]` (cả ngày). */
  const timeline = useMemo(() => {
    const items = (data?.schedule ?? []).map((s) => ({
      key: `${s.kind}-${s.start}-${s.title}`,
      kind: s.kind,
      title: s.title,
      start: s.start,
      end: s.end,
      task_id: s.task_id,
      status: s.status,
      allDay: false,
    }));
    const allDay = (data?.all_day ?? []).map((a, i) => ({
      key: `allday-${i}-${a.title}`,
      kind: "google" as const,
      title: a.title,
      start: "",
      end: "",
      task_id: null,
      status: null,
      allDay: true,
    }));
    return [...allDay, ...items].sort((a, b) => {
      // All-day luôn lên trước; còn lại sort theo giờ bắt đầu.
      if (a.allDay !== b.allDay) return a.allDay ? -1 : 1;
      return new Date(a.start).getTime() - new Date(b.start).getTime();
    });
  }, [data]);

  const topTasks: BriefingTopTask[] = data?.top_tasks ?? [];
  const atRisk: BriefingAtRisk[] = data?.at_risk ?? [];
  const hint = data?.productive_hint ?? null;

  return (
    <div className="brf">
      <div className="brf-container">
        {/* ============ Header ============ */}
        <header className="brf-head">
          <div className="brf-head-text">
            <span className="brf-eyebrow">
              <span
                className="material-symbols-outlined"
                style={{ fontVariationSettings: "'FILL' 1" }}
                aria-hidden="true"
              >
                auto_awesome
              </span>
              Daily Briefing
            </span>
            <h1 className="brf-title">Hôm nay bạn cần biết</h1>
            <p className="brf-sub">
              {data ? (
                <>
                  {fmtWeekday(data.date)} · {fmtDate(data.date)} ·{" "}
                  <span className="brf-mono">{data.time_zone}</span>
                </>
              ) : (
                "AI tổng hợp task, lịch và khung giờ tập trung của bạn."
              )}
            </p>
          </div>
          <div className="brf-head-actions">
            <button
              type="button"
              className="brf-btn brf-btn--ghost"
              onClick={() => void load()}
              disabled={loading}
            >
              <span
                className={
                  "material-symbols-outlined brf-btn-icon" +
                  (loading ? " brf-btn-icon--spin" : "")
                }
                aria-hidden="true"
              >
                refresh
              </span>
              <span>Làm mới</span>
            </button>
            <Link to="/copilot" className="brf-btn brf-btn--primary">
              <span className="material-symbols-outlined brf-btn-icon" aria-hidden="true">
                neurology
              </span>
              <span>AI Copilot</span>
            </Link>
          </div>
        </header>

        {/* ============ Error ============ */}
        {error && !loading && (
          <div className="brf-banner brf-banner--error" role="alert">
            <span className="material-symbols-outlined" aria-hidden="true">
              error
            </span>
            <span className="brf-banner-text">{error}</span>
            <button
              type="button"
              className="brf-btn brf-btn--ghost brf-btn--sm"
              onClick={() => void load()}
            >
              Thử lại
            </button>
          </div>
        )}

        {/* ============ Loading ============ */}
        {loading && !data && (
          <div className="brf-state" role="status">
            <span className="material-symbols-outlined brf-state-icon" aria-hidden="true">
              progress_activity
            </span>
            <span>Đang tổng hợp briefing hôm nay…</span>
          </div>
        )}

        {data && (
          <>
            {/* ============ Hero: gợi ý của AI ============ */}
            <section className="brf-hero">
              <div className="brf-hero-icon" aria-hidden="true">
                <span className="material-symbols-outlined">neurology</span>
              </div>
              <div className="brf-hero-body">
                {hint ? (
                  <>
                    <p className="brf-hero-text">{hint.text}</p>
                    {hint.ranges.length > 0 && (
                      <div className="brf-hero-ranges">
                        {hint.ranges.map((r, i) => (
                          <span className="brf-range" key={`${r.start}-${i}`}>
                            <span className="material-symbols-outlined brf-range-icon" aria-hidden="true">
                              schedule
                            </span>
                            {r.start} – {r.end}
                          </span>
                        ))}
                      </div>
                    )}
                  </>
                ) : (
                  <p className="brf-hero-text brf-hero-text--muted">
                    Chưa có dữ liệu giờ tập trung — hoàn tất vài phiên focus để AI
                    học được khung giờ của bạn.
                  </p>
                )}
              </div>
              <div className="brf-hero-flags">
                <span
                  className={
                    "brf-flag " +
                    (data.calendar_connected
                      ? "brf-flag--on"
                      : "brf-flag--off")
                  }
                  title={
                    data.calendar_connected
                      ? "Google Calendar đã liên kết"
                      : "Chưa liên kết Google Calendar"
                  }
                >
                  <span className="material-symbols-outlined brf-flag-icon" aria-hidden="true">
                    event
                  </span>
                  {data.calendar_connected
                    ? "Google Calendar đã liên kết"
                    : "Chưa liên kết Google Calendar"}
                </span>
                {data.has_pending_proposal && (
                  <Link to="/copilot" className="brf-flag brf-flag--pending">
                    <span className="material-symbols-outlined brf-flag-icon" aria-hidden="true">
                      pending_actions
                    </span>
                    AI đang chờ duyệt lịch
                  </Link>
                )}
              </div>
            </section>

            <div className="brf-grid">
              {/* ============ Task nên làm hôm nay ============ */}
              <section className="brf-card">
                <div className="brf-card-head">
                  <div className="brf-card-head-left">
                    <span className="material-symbols-outlined brf-card-icon brf-card-icon--primary" aria-hidden="true">
                      target
                    </span>
                    <h2 className="brf-card-title">Task nên làm hôm nay</h2>
                  </div>
                  {topTasks.length > 0 && (
                    <span className="brf-card-meta">{topTasks.length} task</span>
                  )}
                </div>

                {topTasks.length === 0 ? (
                  <p className="brf-card-sub">
                    Hôm nay không có task nào ưu tiên — hoặc bạn đã xong hết.
                  </p>
                ) : (
                  <ul className="brf-list">
                    {topTasks.map((t) => (
                      <li className="brf-task" key={t.task_id}>
                        <div className="brf-task-main">
                          <span className="brf-task-title">{t.title}</span>
                          <span className="brf-task-meta">
                            {t.project_name}
                            <span className="brf-dot" aria-hidden="true">
                              ·
                            </span>
                            Hạn {fmtDate(t.deadline)}
                            <span className="brf-dot" aria-hidden="true">
                              ·
                            </span>
                            {t.remaining_minutes > 0
                              ? `còn ${fmtMinutes(t.remaining_minutes)}`
                              : "đã quá hạn"}
                          </span>
                        </div>
                        <div className="brf-task-reasons">
                          {t.reasons.map((r, i) => {
                            const meta = REASON_META[r.code] ?? REASON_META.bias;
                            return (
                              <span
                                className={`brf-reason brf-reason--${meta.tone}`}
                                key={`${r.code}-${i}`}
                                title={r.text}
                              >
                                <span
                                  className="material-symbols-outlined brf-reason-icon"
                                  aria-hidden="true"
                                >
                                  {meta.icon}
                                </span>
                                {meta.label}
                              </span>
                            );
                          })}
                        </div>
                        {t.similar_warning && (
                          <p className="brf-task-warning">
                            <span
                              className="material-symbols-outlined brf-task-warning-icon"
                              aria-hidden="true"
                            >
                              history
                            </span>
                            {t.similar_warning.text}
                          </p>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </section>

              {/* ============ Thiếu thời gian ============ */}
              {atRisk.length > 0 && (
                <section className="brf-card brf-card--warn">
                  <div className="brf-card-head">
                    <div className="brf-card-head-left">
                      <span className="material-symbols-outlined brf-card-icon brf-card-icon--warn" aria-hidden="true">
                        warning
                      </span>
                      <h2 className="brf-card-title">Task thiếu thời gian</h2>
                    </div>
                    <span className="brf-card-meta">{atRisk.length} task</span>
                  </div>
                  <ul className="brf-list">
                    {atRisk.map((t) => (
                      <li className="brf-task" key={t.task_id}>
                        <div className="brf-task-main">
                          <span className="brf-task-title">{t.title}</span>
                          <span className="brf-task-meta">
                            Hạn {fmtDate(t.deadline)}
                          </span>
                        </div>
                        <span className="brf-missing">
                          Thiếu {fmtMinutes(t.missing_minutes)}
                        </span>
                      </li>
                    ))}
                  </ul>
                </section>
              )}

              {/* ============ Lịch hôm nay ============ */}
              <section className="brf-card">
                <div className="brf-card-head">
                  <div className="brf-card-head-left">
                    <span className="material-symbols-outlined brf-card-icon" aria-hidden="true">
                      calendar_month
                    </span>
                    <h2 className="brf-card-title">Lịch hôm nay</h2>
                  </div>
                  {timeline.length > 0 && (
                    <span className="brf-card-meta">{timeline.length} mục</span>
                  )}
                </div>

                {timeline.length === 0 ? (
                  <p className="brf-card-sub">
                    Chưa có khối thời gian nào hôm nay. Mở AI Copilot để AI xếp hộ
                    bạn theo deadline gần nhất.
                  </p>
                ) : (
                  <ul className="brf-timeline">
                    {timeline.map((it) => {
                      const meta = KIND_META[it.kind] ?? KIND_META.slot;
                      return (
                        <li className="brf-tl" key={it.key}>
                          <span className="brf-tl-time brf-mono">
                            {it.allDay ? "Cả ngày" : `${fmtHHmm(it.start)}`}
                          </span>
                          <span className="brf-tl-bar" aria-hidden="true">
                            <span
                              className={`brf-tl-dot brf-tl-dot--${it.kind}`}
                            />
                          </span>
                          <span className="brf-tl-body">
                            <span className="brf-tl-title">{it.title}</span>
                            <span className="brf-tl-meta">
                              <span className="brf-kind">
                                <span
                                  className="material-symbols-outlined brf-kind-icon"
                                  aria-hidden="true"
                                >
                                  {meta.icon}
                                </span>
                                {meta.label}
                              </span>
                              {!it.allDay && it.end && (
                                <>
                                  <span className="brf-dot" aria-hidden="true">
                                    ·
                                  </span>
                                  <span className="brf-mono">{fmtHHmm(it.end)}</span>
                                </>
                              )}
                              {it.status && (
                                <>
                                  <span className="brf-dot" aria-hidden="true">
                                    ·
                                  </span>
                                  <span
                                    className={
                                      "brf-status" +
                                      (it.status === "Done" ? " brf-status--done" : "")
                                    }
                                  >
                                    {it.status === "Done" ? "Đã xong" : "Đã duyệt"}
                                  </span>
                                </>
                              )}
                            </span>
                          </span>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </section>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
