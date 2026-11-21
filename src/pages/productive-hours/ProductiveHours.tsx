import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { CenterToasts, useCenterToast } from "../../components/Toast";
import {
  getProductiveHours,
  saveProductiveHoursOnboarding,
  type ProductiveHoursBlock,
  type ProductiveHoursDto,
} from "../../lib/api-client";
import "./productive-hours.css";

/* ===========================================================
 * Giờ hiệu quả — Route: /productive-hours
 *
 * 2 endpoint của AI service (không tốn lượt AI):
 *   GET /profile/productive-hours              → onboarded, hours[], top_hours
 *   PUT /profile/productive-hours/onboarding   → {blocks}
 *
 * Màn hình này là "Cài đặt giờ hiệu quả": user chọn các khung giờ mình
 * tập trung tốt nhất → AI dùng để xếp lịch các task khó vào đúng giờ đó.
 *
 * Scope class prefix `.pho-*`.
 * =========================================================== */

/** Số giờ trong 1 ngày. */
const HOURS = Array.from({ length: 24 }, (_, i) => i);

/** Khung giờ mặc định gợi ý (9–12 & 14–18). */
const DEFAULT_BLOCKS: ProductiveHoursBlock[] = [
  { start: 9, end: 12 },
  { start: 14, end: 18 },
];

/** Chuyển 1 khung giờ → nhãn "09:00 – 12:00". */
function fmtBlock(b: ProductiveHoursBlock): string {
  const p = (h: number) => String(h).padStart(2, "0");
  return `${p(b.start)}:00 – ${p(b.end)}:00`;
}

/** Điểm 0–1 → phần trăm. */
function fmtScore(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "—";
  return `${Math.round(v <= 1 ? v * 100 : v)}%`;
}

export function ProductiveHoursPage() {
  const [toasts, toast] = useCenterToast();

  const [data, setData] = useState<ProductiveHoursDto | null>(null);
  const [blocks, setBlocks] = useState<ProductiveHoursBlock[]>(DEFAULT_BLOCKS);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /* ---------- load ---------- */
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const res = await getProductiveHours();
      if (cancelled) return;
      if (!res.ok) {
        setError(res.error);
        setLoading(false);
        return;
      }
      setData(res.data);
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  /* ---------- helpers ---------- */

  /** Giờ đang được hover để xem điểm. */
  const [hoverHour, setHoverHour] = useState<number | null>(null);

  /** Điểm hiệu quả theo giờ (0–1). */
  const hours = useMemo(() => data?.hours ?? [], [data]);

  /** Giờ nằm trong khối đã chọn. */
  function inSelected(h: number): boolean {
    return blocks.some((b) => h >= b.start && h < b.end);
  }

  /** Bật/tắt 1 giờ. */
  function toggleHour(h: number) {
    setBlocks((prev) => {
      const next = prev.map((b) => ({ ...b }));
      const hit = next.findIndex((b) => h >= b.start && h < b.end);
      if (hit === -1) {
        // Thêm giờ → gộp vào khối liền kề nếu có.
        next.push({ start: h, end: h + 1 });
      } else {
        // Bỏ giờ → tách khối.
        const b = next[hit];
        if (b.end - b.start === 1) {
          next.splice(hit, 1);
        } else if (h === b.start) {
          next[hit] = { ...b, start: h + 1 };
        } else if (h === b.end - 1) {
          next[hit] = { ...b, end: h };
        } else {
          next.splice(hit, 1, { ...b, end: h }, { start: h + 1, end: b.end });
        }
      }
      // Sắp xếp + gộp các khối liền kề.
      next.sort((a, b2) => a.start - b2.start);
      const merged: ProductiveHoursBlock[] = [];
      for (const b of next) {
        const last = merged[merged.length - 1];
        if (last && last.end === b.start) last.end = b.end;
        else merged.push({ ...b });
      }
      return merged;
    });
  }

  /* ---------- lưu ---------- */
  async function handleSave() {
    if (blocks.length === 0) {
      setError("Chọn ít nhất 1 giờ hiệu quả.");
      return;
    }
    setSaving(true);
    setError(null);
    const res = await saveProductiveHoursOnboarding(blocks);
    setSaving(false);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    setData(res.data);
    toast.success("Đã lưu giờ hiệu quả", "AI sẽ ưu tiên xếp việc khó vào các giờ này.");
  }

  /* ---------- derived ---------- */

  /** Tổng số giờ đã chọn. */
  const totalHours = useMemo(
    () => blocks.reduce((n, b) => n + (b.end - b.start), 0),
    [blocks],
  );

  /** Giờ có điểm cao nhất. */
  const bestHour = useMemo(() => {
    if (hours.length === 0) return null;
    let best = 0;
    for (let i = 1; i < hours.length; i++) {
      if ((hours[i] ?? 0) > (hours[best] ?? 0)) best = i;
    }
    return best;
  }, [hours]);

  return (
    <section className="pho">
      <div className="pho-container">
        {/* ============ Header ============ */}
        <header className="pho-header">
          <span className="pho-eyebrow">
            <span className="material-symbols-outlined">bolt</span>
            Giờ hiệu quả
          </span>
          <h1 className="pho-title">Khi nào bạn tập trung nhất?</h1>
          <p className="pho-subtitle">
            Chọn các khung giờ bạn làm việc hiệu quả nhất. AI sẽ ưu tiên xếp
            việc khó vào đúng những giờ đó — và học dần từ thói quen của bạn.
          </p>
        </header>

        {error && (
          <div className="pho-banner pho-banner--error" role="alert">
            <span className="material-symbols-outlined">error</span>
            <span>{error}</span>
          </div>
        )}

        {/* ============ Trạng thái ============ */}
        {data && (
          <div className="pho-status">
            <span
              className={
                "pho-status-chip" +
                (data.onboarded ? " pho-status-chip--ok" : "")
              }
            >
              <span className="material-symbols-outlined">
                {data.onboarded ? "check_circle" : "pending"}
              </span>
              {data.onboarded ? "Đã thiết lập" : "Chưa thiết lập"}
            </span>
            {data.top_hours?.length > 0 && (
              <span className="pho-status-chip">
                <span className="material-symbols-outlined">schedule</span>
                Khung tốt nhất:{" "}
                {data.top_hours
                  .map((t) => `${t.start} – ${t.end}`)
                  .join(" · ")}
              </span>
            )}
          </div>
        )}

        {/* ============ Chọn giờ ============ */}
        <div className="pho-card">
          <div className="pho-card-head">
            <div className="pho-card-head-left">
              <span className="material-symbols-outlined pho-card-icon">
                timer
              </span>
              <h2 className="pho-card-title">Chọn giờ hiệu quả</h2>
            </div>
            <span className="pho-card-meta">{totalHours} giờ đã chọn</span>
          </div>

          {loading ? (
            <div className="pho-state" role="status">
              <span className="material-symbols-outlined pho-spin">
                progress_activity
              </span>
              <p>Đang tải dữ liệu giờ hiệu quả…</p>
            </div>
          ) : (
            <>
              {/* Lưới 24 giờ — màu theo điểm hiệu quả đã học */}
              <div className="pho-hours" role="grid" aria-label="24 giờ trong ngày">
                {HOURS.map((h) => {
                  const score = hours[h];
                  const hasScore =
                    score !== undefined && score !== null && Number.isFinite(score);
                  const selected = inSelected(h);
                  return (
                    <button
                      key={h}
                      type="button"
                      className={
                        "pho-hour" +
                        (selected ? " pho-hour--on" : "") +
                        (bestHour === h ? " pho-hour--best" : "")
                      }
                      style={
                        hasScore
                          ? ({
                              "--pho-score": String(
                                Math.max(0.08, score <= 1 ? score : score / 100),
                              ),
                            } as React.CSSProperties)
                          : undefined
                      }
                      onClick={() => toggleHour(h)}
                      onMouseEnter={() => setHoverHour(h)}
                      onMouseLeave={() => setHoverHour(null)}
                      role="gridcell"
                      aria-selected={selected}
                      aria-label={`${String(h).padStart(2, "0")}:00${
                        hasScore ? ` — hiệu quả ${fmtScore(score)}` : ""
                      }`}
                      title={`${String(h).padStart(2, "0")}:00`}
                    >
                      {h % 3 === 0 ? (
                        <span className="pho-hour-label">
                          {String(h).padStart(2, "0")}
                        </span>
                      ) : null}
                    </button>
                  );
                })}
              </div>

              {/* Chú thích */}
              <div className="pho-legend">
                <span className="pho-legend-item">
                  <span className="pho-legend-swatch pho-legend-swatch--low" />
                  Ít hiệu quả
                </span>
                <span className="pho-legend-item">
                  <span className="pho-legend-swatch pho-legend-swatch--high" />
                  Hiệu quả cao
                </span>
                <span className="pho-legend-item">
                  <span className="pho-legend-swatch pho-legend-swatch--on" />
                  Bạn đã chọn
                </span>
                {hoverHour !== null && (
                  <span className="pho-legend-item pho-legend-item--live">
                    {String(hoverHour).padStart(2, "0")}:00 —{" "}
                    {fmtScore(hours[hoverHour])}
                  </span>
                )}
              </div>

              {/* Khối đã chọn */}
              {blocks.length > 0 && (
                <div className="pho-blocks">
                  {blocks.map((b) => (
                    <span className="pho-block" key={`${b.start}-${b.end}`}>
                      <span className="material-symbols-outlined">schedule</span>
                      {fmtBlock(b)}
                    </span>
                  ))}
                </div>
              )}

              {/* Actions */}
              <div className="pho-actions">
                <button
                  type="button"
                  className="pho-btn pho-btn--ghost"
                  onClick={() => setBlocks(DEFAULT_BLOCKS)}
                  disabled={saving}
                >
                  <span className="material-symbols-outlined">restart_alt</span>
                  <span>Đặt lại</span>
                </button>
                <button
                  type="button"
                  className="pho-btn pho-btn--primary"
                  onClick={() => void handleSave()}
                  disabled={saving || blocks.length === 0}
                >
                  <span className="material-symbols-outlined">
                    {saving ? "progress_activity" : "check"}
                  </span>
                  <span>{saving ? "Đang lưu…" : "Lưu giờ hiệu quả"}</span>
                </button>
              </div>
            </>
          )}
        </div>

        {/* ============ Gợi ý ============ */}
        <div className="pho-hint">
          <span className="material-symbols-outlined">info</span>
          <span>
            Bạn có thể bỏ qua bước này — AI vẫn học dần từ thói quen khi bạn
            đánh dấu task hoàn thành. Xem thêm tại{" "}
            <Link to="/profile">Cài đặt</Link>.
          </span>
        </div>
      </div>

      <CenterToasts toasts={toasts} onDismiss={toast.dismiss} />
    </section>
  );
}
