import { useCallback, useMemo, useState } from "react";
import {
  getRevenueReport,
  listInvoices,
  listPaymentTransactions,
} from "../../lib/admin-api";
import type { RevenueGroupBy } from "../../lib/admin-api";
import {
  AdminEmptyState,
  AdminErrorState,
  AdminLoading,
  AdminPill,
  AdminToast,
} from "./admin-shared";
import { EMPTY_TOAST } from "./admin-constants";
import type { AdminToastState } from "./admin-constants";
import { useAdminLoad } from "./useAdminLoad";
import "./admin.css";

/**
 * Trang báo cáo doanh thu.
 *
 * API: GET /api/admin/revenue?groupBy=day|month|plan&from=&to=
 *  - `from`/`to` là ISO 8601, gồm `from` không gồm `to`.
 *  - Mặc định 30 ngày gần nhất, tối đa 366 ngày.
 *  - Theo ngày/tháng: `rows` đủ mọi mốc (kể cả mốc 0) → biểu đồ không bị hụt.
 *  - Theo gói: gói doanh thu cao nhất lên đầu, `key` là tên gói.
 */

const VND = new Intl.NumberFormat("vi-VN");

const GROUP_OPTIONS: Array<{ value: RevenueGroupBy; label: string }> = [
  { value: "day", label: "Theo ngày" },
  { value: "month", label: "Theo tháng" },
  { value: "plan", label: "Theo gói" },
];

function formatVnd(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return "—";
  return `${VND.format(value)} đ`;
}

function formatShortVnd(value: number): string {
  if (Math.abs(value) >= 1000000000) {
    return `${(value / 1000000000).toFixed(1).replace(/\.0$/, "")} tỷ`;
  }
  if (Math.abs(value) >= 1000000) {
    return `${(value / 1000000).toFixed(1).replace(/\.0$/, "")} tr`;
  }
  if (Math.abs(value) >= 1000) {
    return `${(value / 1000).toFixed(1).replace(/\.0$/, "")} ng`;
  }
  return VND.format(value);
}

/** `yyyy-MM-dd` trong giờ local (BE mặc định 30 ngày gần nhất theo UTC). */
function toDateInput(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/**
 * Nhãn trục X — rút gọn để không chồng lên nhau.
 *
 * - Theo ngày  : `2026-10-17` → `17/10`
 * - Theo tháng : `2026-10`    → `T10/26`
 * - Theo gói   : giữ nguyên tên gói (BE đã trả key là tên).
 */
function formatAxisLabel(key: string, groupBy: RevenueGroupBy): string {
  if (groupBy === "day") {
    // yyyy-MM-dd → dd/MM
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key);
    if (m) return `${m[3]}/${m[2]}`;
    return key;
  }
  if (groupBy === "month") {
    // yyyy-MM → MM/yy
    const m = /^(\d{4})-(\d{2})$/.exec(key);
    if (m) return `${m[2]}/${m[1].slice(2)}`;
    return key;
  }
  return key;
}

/**
 * Bước nhảy hiển thị nhãn: cứ mỗi `step` cột mới hiện 1 nhãn.
 *
 * Mỗi nhãn ngày rộng ~34px, nên bước nhảy phải đủ lớn để nhãn không chồng
 * lên nhau. Vì số cột thay đổi theo khoảng thời gian, ta ưu tiên các bước
 * "đẹp" (1, 2, 3, 5, 7, 10, 14, 20, 30...) sao cho tổng số nhãn <= 12.
 */
function axisLabelStep(total: number): number {
  if (total <= 1) return 1;
  const niceSteps = [1, 2, 3, 5, 7, 10, 14, 20, 30, 45, 60];
  for (const s of niceSteps) {
    if (Math.ceil(total / s) <= 12) return s;
  }
  return Math.ceil(total / 12);
}

function defaultRange(): { from: string; to: string } {
  const to = new Date();
  const from = new Date();
  from.setDate(from.getDate() - 30);
  return { from: toDateInput(from), to: toDateInput(to) };
}

export function AdminRevenue() {
  const initial = useMemo(() => defaultRange(), []);
  const [groupBy, setGroupBy] = useState<RevenueGroupBy>("day");
  const [fromDate, setFromDate] = useState(initial.from);
  const [toDate, setToDate] = useState(initial.to);

  const [toast, setToast] = useState<AdminToastState>(EMPTY_TOAST);

  const closeToast = useCallback(() => setToast(EMPTY_TOAST), []);

  /**
   * Validate khoảng ngày phía client trước khi gọi API.
   * Trả về payload đã chuẩn hoá (from/to ISO, `to` không gồm).
   */
  const range = useMemo(() => {
    if (!fromDate || !toDate) {
      return { error: "Vui lòng chọn đầy đủ ngày bắt đầu và ngày kết thúc." };
    }
    if (toDate <= fromDate) {
      return { error: "Ngày kết thúc phải sau ngày bắt đầu." };
    }
    const spanDays =
      (new Date(toDate).getTime() - new Date(fromDate).getTime()) / 86400000;
    if (spanDays > 366) {
      return { error: "Khoảng thời gian tối đa là 366 ngày." };
    }
    // `from` gồm, `to` không gồm → cộng 1 ngày để `to` bao gồm cả ngày chọn.
    const toInclusive = new Date(toDate);
    toInclusive.setDate(toInclusive.getDate() + 1);
    return {
      from: new Date(fromDate).toISOString(),
      to: toInclusive.toISOString(),
    };
  }, [fromDate, toDate]);

  const { data, loading, error, reload } = useAdminLoad(
    async () => {
      if ("error" in range) {
        return { ok: false, error: range.error };
      }
      const [revRes, txRes, invRes] = await Promise.all([
        getRevenueReport({ groupBy, from: range.from, to: range.to }),
        listPaymentTransactions({ from: range.from, to: range.to, pageSize: 20 }),
        listInvoices({ from: range.from, to: range.to, pageSize: 20 }),
      ]);

      if (!revRes.ok) {
        return { ok: false, error: revRes.error ?? "Không tải được báo cáo doanh thu." };
      }

      return {
        ok: true,
        data: {
          report: revRes.data,
          transactions: txRes.ok ? (txRes.data ?? []) : [],
          invoices: invRes.ok ? (invRes.data ?? []) : [],
        },
      };
    },
    [groupBy, range.from, range.to],
  );

  const transactions = data?.transactions ?? [];
  const invoices = data?.invoices ?? [];
  const report = data?.report ?? null;

  const dateError = "error" in range ? range.error : null;

  const maxRowNet = useMemo(() => {
    if (!report) return 1;
    return Math.max(1, ...report.rows.map((r) => Math.abs(r.net)));
  }, [report]);

  const totals = report?.total;

  function applyPreset(days: number) {
    const to = new Date();
    const from = new Date();
    from.setDate(from.getDate() - days);
    setFromDate(toDateInput(from));
    setToDate(toDateInput(to));
  }

  return (
    <div className="adm-page">
      <div className="adm-page-head">
        <div>
          <span className="adm-eyebrow">BÁO CÁO TÀI CHÍNH</span>
          <h1 className="adm-page-title">Doanh thu</h1>
          <p className="adm-page-sub">
            Doanh thu tính theo ngày thanh toán của giao dịch thành công; hoàn tiền
            tính vào kỳ xử lý xong.
          </p>
        </div>
      </div>

      {/* ============ Bộ lọc ============ */}
      <section className="adm-card adm-card--filter">
        <div className="adm-filter">
          <div className="adm-field">
            <span className="adm-label">Tổng hợp theo</span>
            <div className="adm-segment" role="radiogroup" aria-label="Tổng hợp theo">
              {GROUP_OPTIONS.map((opt) => (
                <button
                  key={opt.value}
                  type="button"
                  role="radio"
                  aria-checked={groupBy === opt.value}
                  className={`adm-segment__btn${groupBy === opt.value ? " adm-segment__btn--on" : ""}`}
                  onClick={() => setGroupBy(opt.value)}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>

          <div className="adm-field">
            <label className="adm-label" htmlFor="adm-rev-from">
              Từ ngày
            </label>
            <input
              id="adm-rev-from"
              type="date"
              className="adm-input adm-mono"
              value={fromDate}
              max={toDate}
              onChange={(e) => setFromDate(e.target.value)}
            />
          </div>

          <div className="adm-field">
            <label className="adm-label" htmlFor="adm-rev-to">
              Đến ngày
            </label>
            <input
              id="adm-rev-to"
              type="date"
              className="adm-input adm-mono"
              value={toDate}
              min={fromDate}
              onChange={(e) => setToDate(e.target.value)}
            />
          </div>

          <div className="adm-field">
            <span className="adm-label">Khoảng nhanh</span>
            <div className="adm-preset-row">
              <button type="button" className="adm-chip" onClick={() => applyPreset(7)}>
                7 ngày
              </button>
              <button type="button" className="adm-chip" onClick={() => applyPreset(30)}>
                30 ngày
              </button>
              <button type="button" className="adm-chip" onClick={() => applyPreset(90)}>
                90 ngày
              </button>
              <button type="button" className="adm-chip" onClick={() => applyPreset(365)}>
                1 năm
              </button>
            </div>
          </div>

          <button type="button" className="adm-btn adm-btn--primary" onClick={reload}>
            <span className="material-symbols-outlined" aria-hidden="true">
              search
            </span>
            Áp dụng
          </button>
        </div>

        {dateError && (
          <p className="adm-inline-error" role="alert">
            <span className="material-symbols-outlined" aria-hidden="true">error</span>
            {dateError}
          </p>
        )}
      </section>

      {loading ? (
        <AdminLoading label="Đang tải báo cáo…" />
      ) : error ? (
        <AdminErrorState message={error} onRetry={reload} />
      ) : (
        <>
          {/* ============ KPI ============ */}
          <section className="adm-kpi-grid" aria-label="Tổng quan doanh thu">
            <article className="adm-kpi adm-kpi--accent">
              <span className="adm-kpi__label">Doanh thu thuần</span>
              <strong className="adm-kpi__value adm-mono">
                {formatShortVnd(totals?.netRevenue ?? 0)}
              </strong>
              <span className="adm-kpi__foot">
                Tổng {formatVnd(totals?.grossRevenue ?? 0)}
              </span>
            </article>
            <article className="adm-kpi">
              <span className="adm-kpi__label">Giao dịch thành công</span>
              <strong className="adm-kpi__value adm-mono">
                {totals?.succeededTransactions ?? 0}
              </strong>
              <span className="adm-kpi__foot">Trong kỳ đang xem</span>
            </article>
            <article className="adm-kpi">
              <span className="adm-kpi__label">Giá trị đơn trung bình</span>
              <strong className="adm-kpi__value adm-mono">
                {formatShortVnd(totals?.averageOrderValue ?? 0)}
              </strong>
              <span className="adm-kpi__foot">Mỗi giao dịch thành công</span>
            </article>
            <article className="adm-kpi">
              <span className="adm-kpi__label">Đã hoàn tiền</span>
              <strong className="adm-kpi__value adm-mono">
                {formatShortVnd(totals?.refundedAmount ?? 0)}
              </strong>
              <span className="adm-kpi__foot">Hoàn tận xong trong kỳ</span>
            </article>
            <article className="adm-kpi">
              <span className="adm-kpi__label">Hoá đơn phát hành</span>
              <strong className="adm-kpi__value adm-mono">{totals?.invoicesIssued ?? 0}</strong>
              <span className="adm-kpi__foot">
                {totals?.newPayingUsers ?? 0} người dùng trả phí mới
              </span>
            </article>
          </section>

          {/* ============ Biểu đồ ============ */}
          <section className="adm-card">
            <header className="adm-card__head">
              <div>
                <span className="adm-eyebrow">
                  {groupBy === "plan" ? "THEO GÓI" : "THEO THỜI GIAN"}
                </span>
                <h2 className="adm-card__title">Diễn biến doanh thu</h2>
              </div>
              <AdminPill tone="accent">
                {report?.rows.length ?? 0} mốc
              </AdminPill>
            </header>

            {!report || report.rows.length === 0 ? (
              <AdminEmptyState
                icon="monitoring"
                title="Không có dữ liệu trong kỳ này"
                hint="Thử mở rộng khoảng thời gian hoặc chọn khoảng nhanh khác."
              />
            ) : (
              <div className="adm-chart" role="img" aria-label="Biểu đồ doanh thu theo kỳ">
                <div className="adm-chart__bars">
                  {report.rows.map((row, index) => {
                    const height = Math.max(
                      2,
                      (Math.abs(row.net) / maxRowNet) * 100,
                    );
                    /* Chỉ hiện nhãn mỗi `step` cột — tránh chồng chữ. */
                    const showLabel =
                      index % axisLabelStep(report.rows.length) === 0;
                    return (
                      <div
                        key={row.key}
                        className="adm-chart__col"
                        title={`${row.key} · ${formatVnd(row.net)}`}
                      >
                        <div className="adm-chart__stack">
                          <div
                            className="adm-chart__bar adm-chart__bar--net"
                            style={{ height: `${height}%` }}
                          />
                          {row.refunded > 0 && (
                            <div
                              className="adm-chart__bar adm-chart__bar--refund"
                              style={{
                                height: `${Math.max(
                                  1,
                                  (row.refunded / maxRowNet) * 100,
                                )}%`,
                              }}
                            />
                          )}
                        </div>
                        {showLabel && (
                          <span className="adm-chart__x adm-mono">
                            {formatAxisLabel(row.key, groupBy)}
                          </span>
                        )}
                      </div>
                    );
                  })}
                </div>
                <div className="adm-legend">
                  <span className="adm-legend__item">
                    <span className="adm-legend__swatch adm-legend__swatch--net" />
                    Doanh thu thuần
                  </span>
                  <span className="adm-legend__item">
                    <span className="adm-legend__swatch adm-legend__swatch--refund" />
                    Hoàn tiền
                  </span>
                </div>
              </div>
            )}
          </section>

          {/* ============ Bảng chi tiết ============ */}
          <section className="adm-card">
            <header className="adm-card__head">
              <div>
                <span className="adm-eyebrow">CHI TIẾT</span>
                <h2 className="adm-card__title">
                  {groupBy === "plan" ? "Doanh thu theo gói" : "Doanh thu theo mốc"}
                </h2>
              </div>
            </header>

            <div className="adm-table-wrap">
              <table className="adm-table">
                <thead>
                  <tr>
                    <th scope="col">{groupBy === "plan" ? "Gói" : "Mốc"}</th>
                    <th scope="col" className="adm-table__num">Doanh thu</th>
                    <th scope="col" className="adm-table__num">Giao dịch</th>
                    <th scope="col" className="adm-table__num">Hoàn</th>
                    <th scope="col" className="adm-table__num">Thực nhận</th>
                    <th scope="col" className="adm-table__num">Tỉ trọng</th>
                  </tr>
                </thead>
                <tbody>
                  {(report?.rows ?? []).map((row) => (
                    <tr key={row.key}>
                      <td>
                        <span className="adm-table__strong">{row.key}</span>
                      </td>
                      <td className="adm-table__num adm-mono">{formatVnd(row.revenue)}</td>
                      <td className="adm-table__num adm-mono">{row.transactions}</td>
                      <td className="adm-table__num adm-mono">{formatVnd(row.refunded)}</td>
                      <td className="adm-table__num adm-mono adm-table__strong">
                        {formatVnd(row.net)}
                      </td>
                      <td className="adm-table__num adm-mono">{row.sharePercent.toFixed(1)}%</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          {/* ============ Giao dịch & hoá đơn ============ */}
          <section className="adm-grid adm-grid--2">
            <article className="adm-card">
              <header className="adm-card__head">
                <div>
                  <span className="adm-eyebrow">GIAO DỊCH</span>
                  <h2 className="adm-card__title">Giao dịch gần nhất</h2>
                </div>
              </header>

              {transactions.length === 0 ? (
                <AdminEmptyState icon="receipt_long" title="Chưa có giao dịch trong kỳ" />
              ) : (
                <div className="adm-table-wrap">
                  <table className="adm-table adm-table--compact">
                    <thead>
                      <tr>
                        <th scope="col">Mã đơn</th>
                        <th scope="col">Trạng thái</th>
                        <th scope="col" className="adm-table__num">Số tiền</th>
                      </tr>
                    </thead>
                    <tbody>
                      {transactions.map((tx) => (
                        <tr key={tx.id}>
                          <td className="adm-mono">{tx.orderCode}</td>
                          <td>
                            <AdminPill
                              tone={
                                tx.status === "Succeeded"
                                  ? "success"
                                  : tx.status === "Failed"
                                    ? "danger"
                                    : tx.status === "Pending"
                                      ? "warn"
                                      : "neutral"
                              }
                            >
                              {tx.status}
                            </AdminPill>
                          </td>
                          <td className="adm-table__num adm-mono">{formatVnd(tx.amount)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </article>

            <article className="adm-card">
              <header className="adm-card__head">
                <div>
                  <span className="adm-eyebrow">HOÁ ĐƠN</span>
                  <h2 className="adm-card__title">Hoá đơn gần nhất</h2>
                </div>
              </header>

              {invoices.length === 0 ? (
                <AdminEmptyState icon="receipt_long" title="Chưa có hoá đơn trong kỳ" />
              ) : (
                <div className="adm-table-wrap">
                  <table className="adm-table adm-table--compact">
                    <thead>
                      <tr>
                        <th scope="col">Số hoá đơn</th>
                        <th scope="col">Gói</th>
                        <th scope="col" className="adm-table__num">Số tiền</th>
                      </tr>
                    </thead>
                    <tbody>
                      {invoices.map((inv) => (
                        <tr key={inv.id}>
                          <td className="adm-mono">{inv.invoiceNumber}</td>
                          <td>{inv.planName}</td>
                          <td className="adm-table__num adm-mono">{formatVnd(inv.amount)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </article>
          </section>
        </>
      )}

      <AdminToast toast={toast} onClose={closeToast} />
    </div>
  );
}
