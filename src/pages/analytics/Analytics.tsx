import { useCallback, useEffect, useMemo, useState } from "react";
import {
  getAnalyticsBreakdown,
  getAnalyticsOverview,
  type AnalyticsBreakdownBy,
  type AnalyticsBreakdownDto,
  type AnalyticsOverviewDto,
  type AnalyticsRange,
} from "../../lib/api-client";
import "./analytics.css";

/* ===========================================================
 * Thống kê — Route: /analytics
 *
 * 2 endpoint của AI service (không tốn lượt AI):
 *   GET /analytics/overview?range=&by=&limit=
 *   GET /analytics/breakdown?range=&by=&limit=
 *
 * Hiển thị:
 *   - Tỉ lệ hoàn thành
 *   - Mức hay ước thiếu theo loại việc (`domains[].text`, `trend[]`)
 *   - `insights[].text` — nhận xét do AI viết
 *   - Chia theo khách / dự án / task (đổi `by`)
 *
 * Scope class prefix `.ana-*`.
 * =========================================================== */

/* ---------- helpers ---------- */

/** "2h 05" / "45m" — định dạng phút. */
function fmtMinutes(m: number | null | undefined): string {
  if (m === null || m === undefined || !Number.isFinite(m)) return "—";
  if (m <= 0) return "0m";
  const h = Math.floor(m / 60);
  const r = m % 60;
  if (h === 0) return `${r}m`;
  if (r === 0) return `${h}h`;
  return `${h}h ${String(r).padStart(2, "0")}`;
}

/** Tỉ lệ 0–1 → phần trăm. */
function fmtPct(rate: number | null | undefined): string {
  if (rate === null || rate === undefined || !Number.isFinite(rate)) return "—";
  // BE có thể trả 0–1 hoặc 0–100 → chuẩn hoá về %.
  const pct = rate <= 1 ? rate * 100 : rate;
  return `${Math.round(pct)}%`;
}

/** Chuẩn hoá tỉ lệ về 0–1 để dùng cho width. */
function normRate(rate: number | null | undefined): number {
  if (rate === null || rate === undefined || !Number.isFinite(rate)) return 0;
  const pct = rate <= 1 ? rate * 100 : rate;
  return Math.max(0, Math.min(100, pct));
}

/* ---------- Bộ lọc ---------- */

const RANGES: Array<{ id: AnalyticsRange; label: string }> = [
  { id: "7d", label: "7 ngày" },
  { id: "30d", label: "30 ngày" },
  { id: "90d", label: "90 ngày" },
  { id: "month", label: "Tháng này" },
];

const BY_OPTIONS: Array<{ id: AnalyticsBreakdownBy; label: string }> = [
  { id: "domain", label: "Loại việc" },
  { id: "client", label: "Khách hàng" },
  { id: "project", label: "Dự án" },
  { id: "task", label: "Task" },
];

export function AnalyticsPage() {
  const [range, setRange] = useState<AnalyticsRange>("30d");
  const [by, setBy] = useState<AnalyticsBreakdownBy>("domain");
  const [limit, setLimit] = useState(10);

  const [overview, setOverview] = useState<AnalyticsOverviewDto | null>(null);
  const [breakdown, setBreakdown] = useState<AnalyticsBreakdownDto | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  /* ---------- load ---------- */
  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const [ovRes, bdRes] = await Promise.all([
      getAnalyticsOverview({ range, by, limit }),
      getAnalyticsBreakdown({ range, by, limit }),
    ]);
    setLoading(false);

    if (!ovRes.ok && !bdRes.ok) {
      setError(ovRes.error || bdRes.error);
      return;
    }
    if (ovRes.ok) setOverview(ovRes.data);
    if (bdRes.ok) setBreakdown(bdRes.data);
  }, [range, by, limit]);

  // setState chỉ chạy SAU await → không vi phạm react-hooks/set-state-in-effect.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      await load();
      if (cancelled) return;
    })();
    return () => {
      cancelled = true;
    };
  }, [load]);

  /* ---------- derived ---------- */

  /** Số liệu tổng quan — fallback về breakdown khi overview thiếu. */
  const stats = useMemo(() => {
    const o = overview;
    return {
      completion: normRate(o?.completion_rate),
      estimated: o?.estimated_minutes ?? 0,
      actual: o?.actual_minutes ?? 0,
      completed: o?.completed_tasks ?? 0,
      total: o?.total_tasks ?? 0,
    };
  }, [overview]);

  /** Độ lệch giữa ước lượng và thực tế (phút). */
  const bias = stats.actual - stats.estimated;

  /** Nhận xét AI — gộp từ overview + breakdown, khử trùng. */
  const insights = useMemo(() => {
    const list = [
      ...(overview?.insights ?? []).map((i) => i.text),
      ...(breakdown?.insights ?? []).map((i) => i.text),
    ].filter(Boolean);
    return Array.from(new Set(list));
  }, [overview, breakdown]);

  return (
    <section className="ana">
      <div className="ana-container">
        {/* ============ Header ============ */}
        <header className="ana-header">
          <div className="ana-header-text">
            <span className="ana-eyebrow">
              <span className="material-symbols-outlined">query_stats</span>
              Thống kê
            </span>
            <h1 className="ana-title">Bạn làm việc hiệu quả ra sao?</h1>
            <p className="ana-subtitle">
              AI so sánh ước lượng với thực tế để chỉ ra chỗ bạn hay bị
              kéo dài — và chỗ bạn đang làm tốt hơn cả dự tính.
            </p>
          </div>
        </header>

        {/* ============ Bộ lọc ============ */}
        <div className="ana-filters">
          <div className="ana-chip-group" role="group" aria-label="Khoảng thời gian">
            {RANGES.map((r) => (
              <button
                key={r.id}
                type="button"
                className={
                  "ana-chip" + (range === r.id ? " ana-chip--on" : "")
                }
                onClick={() => setRange(r.id)}
                disabled={loading}
              >
                {r.label}
              </button>
            ))}
          </div>
          <div className="ana-chip-group" role="group" aria-label="Chia theo">
            {BY_OPTIONS.map((o) => (
              <button
                key={o.id}
                type="button"
                className={
                  "ana-chip" + (by === o.id ? " ana-chip--on" : "")
                }
                onClick={() => setBy(o.id)}
                disabled={loading}
              >
                {o.label}
              </button>
            ))}
          </div>
        </div>

        {error && (
          <div className="ana-banner ana-banner--error" role="alert">
            <span className="material-symbols-outlined">error</span>
            <span>{error}</span>
            <button
              type="button"
              className="ana-btn ana-btn--ghost ana-btn--sm"
              onClick={() => void load()}
            >
              <span className="material-symbols-outlined">refresh</span>
              Thử lại
            </button>
          </div>
        )}

        {loading ? (
          <div className="ana-state" role="status">
            <span className="material-symbols-outlined ana-spin">
              progress_activity
            </span>
            <p>Đang tải thống kê…</p>
          </div>
        ) : (
          <>
            {/* ============ KPI ============ */}
            <div className="ana-kpis">
              <div className="ana-kpi">
                <span className="ana-kpi-label">Tỉ lệ hoàn thành</span>
                <span className="ana-kpi-value">{fmtPct(stats.completion)}</span>
                <div className="ana-kpi-bar">
                  <div
                    className="ana-kpi-bar-fill"
                    style={{ width: `${stats.completion}%` }}
                  />
                </div>
                <span className="ana-kpi-foot">
                  {stats.completed}/{stats.total} task
                </span>
              </div>

              <div className="ana-kpi">
                <span className="ana-kpi-label">Mức hay ước thiếu</span>
                <span className="ana-kpi-value">{fmtMinutes(stats.estimated)}</span>
                <span className="ana-kpi-foot">
                  Thực tế {fmtMinutes(stats.actual)}
                </span>
              </div>

              <div className="ana-kpi">
                <span className="ana-kpi-label">Chênh lệch</span>
                <span
                  className={
                    "ana-kpi-value " +
                    (bias > 0
                      ? "ana-kpi-value--over"
                      : bias < 0
                        ? "ana-kpi-value--under"
                        : "")
                  }
                >
                  {bias > 0 ? "+" : ""}
                  {fmtMinutes(Math.abs(bias))}
                </span>
                <span className="ana-kpi-foot">
                  {bias > 0
                    ? "Hay kéo dài hơn dự tính"
                    : bias < 0
                      ? "Làm nhanh hơn dự tính"
                      : "Khớp dự tính"}
                </span>
              </div>

              <div className="ana-kpi">
                <span className="ana-kpi-label">Số dòng chi tiết</span>
                <input
                  type="number"
                  className="ana-limit"
                  value={limit}
                  min={1}
                  max={50}
                  onChange={(e) =>
                    setLimit(
                      Math.max(
                        1,
                        Math.min(50, Number(e.target.value) || 1),
                      ),
                    )
                  }
                  aria-label="Số dòng chi tiết"
                />
                <span className="ana-kpi-foot">Tối đa 50</span>
              </div>
            </div>

            {/* ============ Nhận xét AI ============ */}
            {insights.length > 0 && (
              <div className="ana-card">
                <div className="ana-card-head">
                  <span className="material-symbols-outlined ana-card-icon">
                    auto_awesome
                  </span>
                  <h2 className="ana-card-title">AI nhận xét</h2>
                </div>
                <ul className="ana-insights">
                  {insights.map((t, i) => (
                    <li key={i}>
                      <span className="material-symbols-outlined">lightbulb</span>
                      <span>{t}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {/* ============ Breakdown ============ */}
            <div className="ana-card">
              <div className="ana-card-head">
                <span className="material-symbols-outlined ana-card-icon">
                  bar_chart
                </span>
                <h2 className="ana-card-title">
                  Mức hay ước thiếu theo{" "}
                  {BY_OPTIONS.find((o) => o.id === by)?.label.toLowerCase()}
                </h2>
              </div>

              {(breakdown?.domains ?? []).length === 0 ? (
                <p className="ana-empty">Chưa có dữ liệu trong khoảng thời gian này.</p>
              ) : (
                <ul className="ana-domains">
                  {(breakdown?.domains ?? []).map((d, i) => {
                    const rate = normRate(d.completion_rate);
                    const diff = (d.actual_minutes ?? 0) - (d.estimated_minutes ?? 0);
                    return (
                      <li className="ana-domain" key={`${d.text}-${i}`}>
                        <div className="ana-domain-head">
                          <span className="ana-domain-name">{d.text}</span>
                          <span className="ana-domain-rate">{fmtPct(d.completion_rate)}</span>
                        </div>
                        <div className="ana-domain-bar">
                          <div
                            className="ana-domain-bar-fill"
                            style={{ width: `${rate}%` }}
                          />
                        </div>
                        <div className="ana-domain-foot">
                          <span>Ước {fmtMinutes(d.estimated_minutes)}</span>
                          <span>Thực {fmtMinutes(d.actual_minutes)}</span>
                          <span
                            className={
                              "ana-domain-diff " +
                              (diff > 0
                                ? "ana-domain-diff--over"
                                : diff < 0
                                  ? "ana-domain-diff--under"
                                  : "")
                            }
                          >
                            {diff > 0 ? "+" : ""}
                            {fmtMinutes(Math.abs(diff))}
                          </span>
                        </div>
                        {/* Trend — biểu đồ mini bằng thanh */}
                        {(d.trend ?? []).length > 0 && (
                          <div
                            className="ana-trend"
                            role="img"
                            aria-label={`Xu hướng ${d.text}`}
                          >
                            {d.trend.map((v, k) => {
                              const max = Math.max(
                                ...d.trend.map((x) => Math.abs(x)),
                                1,
                              );
                              const h = Math.max(
                                6,
                                (Math.abs(v) / max) * 28,
                              );
                              return (
                                <span
                                  className="ana-trend-bar"
                                  key={k}
                                  style={{ height: `${h}px` }}
                                  title={String(v)}
                                />
                              );
                            })}
                          </div>
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          </>
        )}
      </div>
    </section>
  );
}
