import { useCallback, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import {
  getRevenueReport,
  listAdminUsers,
  listSubscriptionPlans,
} from "../../lib/admin-api";
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
 * Trang tổng quan quản trị.
 *
 * Gom số liệu từ:
 *   - GET /api/admin/revenue      → doanh thu 30 ngày gần nhất
 *   - GET /api/admin/users        → tổng user (pageSize=1, đọc totalCount)
 *   - GET /api/subscription-plans → số gói đang bán / đã tắt
 */

const VND = new Intl.NumberFormat("vi-VN");

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

function formatDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("vi-VN", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  });
}

export function AdminOverview() {
  const [toast, setToast] = useState<AdminToastState>(EMPTY_TOAST);

  const closeToast = useCallback(() => setToast(EMPTY_TOAST), []);

  /**
   * Gom 3 nguồn dữ liệu vào 1 payload để hook chỉ gọi 1 lần.
   * setState diễn ra sau `await` → không vi phạm `react-hooks/set-state-in-effect`.
   */
  const { data, loading, error, reload } = useAdminLoad(
    async () => {
      const [revRes, planRes, userRes] = await Promise.all([
        getRevenueReport({ groupBy: "day" }),
        listSubscriptionPlans(),
        listAdminUsers({ page: 1, pageSize: 1 }),
      ]);

      const allFailed = !revRes.ok && !planRes.ok && !userRes.ok;

      return {
        ok: !allFailed,
        error: allFailed
          ? (revRes.error ??
            planRes.error ??
            userRes.error ??
            "Không tải được dữ liệu.")
          : undefined,
        data: {
          revenue: revRes.ok ? revRes.data : null,
          plans: planRes.ok ? planRes.data : [],
          userCount: userRes.ok ? (userRes.data?.totalCount ?? null) : null,
        },
      };
    },
    [],
  );

  const revenue = data?.revenue ?? null;
  const plans = useMemo(() => data?.plans ?? [], [data]);
  const userCount = data?.userCount ?? null;
  const activeUserCount = userCount;

  const planStats = useMemo(() => {
    const active = plans.filter((p) => p.isActive);
    const inactive = plans.filter((p) => !p.isActive);
    const avgPrice = active.length
      ? Math.round(active.reduce((s, p) => s + p.price, 0) / active.length)
      : 0;
    return { active, inactive, avgPrice };
  }, [plans]);

  const topPlans = useMemo(() => {
    if (!revenue) return [];
    return [...revenue.rows]
      .sort((a, b) => b.net - a.net)
      .slice(0, 5)
      .map((row) => ({
        key: row.key,
        net: row.net,
        share: row.sharePercent,
        transactions: row.transactions,
      }));
  }, [revenue]);

  const maxNet = useMemo(
    () => Math.max(1, ...topPlans.map((p) => Math.abs(p.net))),
    [topPlans],
  );

  if (loading) {
    return (
      <div className="adm-page">
        <AdminLoading label="Đang tải số liệu quản trị…" />
      </div>
    );
  }

  if (error && !revenue) {
    return (
      <div className="adm-page">
        <AdminErrorState message={error} onRetry={reload} />
      </div>
    );
  }

  const totals = revenue?.total;

  return (
    <div className="adm-page">
      <div className="adm-page-head">
        <div>
          <span className="adm-eyebrow">TỔNG QUAN HỆ THỐNG</span>
          <h1 className="adm-page-title">Bảng điều khiển quản trị</h1>
          <p className="adm-page-sub">
            Số liệu doanh thu 30 ngày gần nhất, quy mô người dùng và trạng thái các
            gói đăng ký.
          </p>
        </div>
        <div className="adm-page-head__actions">
          <Link to="/admin/revenue" className="adm-btn adm-btn--outline">
            <span className="material-symbols-outlined" aria-hidden="true">
              monitoring
            </span>
            Báo cáo doanh thu
          </Link>
          <button
            type="button"
            className="adm-btn adm-btn--primary"
            onClick={() => {
              reload();
              setToast({
                visible: true,
                tone: "info",
                message: "Đang làm mới số liệu…",
              });
            }}
          >
            <span className="material-symbols-outlined" aria-hidden="true">
              refresh
            </span>
            Làm mới
          </button>
        </div>
      </div>

      <section className="adm-kpi-grid" aria-label="Chỉ số chính">
        <article className="adm-kpi adm-kpi--accent">
          <span className="adm-kpi__label">Doanh thu thuần</span>
          <strong className="adm-kpi__value adm-mono">
            {formatShortVnd(totals?.netRevenue ?? 0)}
          </strong>
          <span className="adm-kpi__foot">
            Tổng {formatVnd(totals?.grossRevenue ?? 0)}
            {totals && totals.refundedAmount > 0 && (
              <> · Hoàn {formatVnd(totals.refundedAmount)}</>
            )}
          </span>
        </article>

        <article className="adm-kpi">
          <span className="adm-kpi__label">Giao dịch thành công</span>
          <strong className="adm-kpi__value adm-mono">
            {totals?.succeededTransactions ?? 0}
          </strong>
          <span className="adm-kpi__foot">
            Giá trị đơn TB {formatVnd(totals?.averageOrderValue ?? 0)}
          </span>
        </article>

        <article className="adm-kpi">
          <span className="adm-kpi__label">Người dùng</span>
          <strong className="adm-kpi__value adm-mono">
            {activeUserCount ?? userCount ?? 0}
          </strong>
          <span className="adm-kpi__foot">
            {userCount !== null &&
            activeUserCount !== null &&
            userCount !== activeUserCount
              ? `${userCount - activeUserCount} tài khoản bị khoá`
              : "Tài khoản đang hoạt động"}
          </span>
        </article>

        <article className="adm-kpi">
          <span className="adm-kpi__label">Người dùng trả phí mới</span>
          <strong className="adm-kpi__value adm-mono">
            {totals?.newPayingUsers ?? 0}
          </strong>
          <span className="adm-kpi__foot">
            {totals?.invoicesIssued ?? 0} hoá đơn đã phát hành
          </span>
        </article>

        <article className="adm-kpi">
          <span className="adm-kpi__label">Gói đang bán</span>
          <strong className="adm-kpi__value adm-mono">{planStats.active.length}</strong>
          <span className="adm-kpi__foot">
            {planStats.inactive.length} gói đã tắt · TB {formatVnd(planStats.avgPrice)}
          </span>
        </article>
      </section>

      <section className="adm-grid adm-grid--2">
        <article className="adm-card">
          <header className="adm-card__head">
            <div>
              <span className="adm-eyebrow">DOANH THU THEO GÓI</span>
              <h2 className="adm-card__title">Phân bổ doanh thu</h2>
            </div>
            <Link to="/admin/revenue" className="adm-btn adm-btn--ghost adm-btn--sm">
              Chi tiết
              <span className="material-symbols-outlined" aria-hidden="true">
                arrow_forward
              </span>
            </Link>
          </header>

          {topPlans.length === 0 ? (
            <AdminEmptyState
              icon="monitoring"
              title="Chưa có doanh thu trong kỳ"
              hint="Chuyển sang trang Doanh thu để xem chi tiết theo ngày hoặc tháng."
            />
          ) : (
            <ul className="adm-barlist">
              {topPlans.map((row) => (
                <li key={row.key} className="adm-barlist__row">
                  <div className="adm-barlist__head">
                    <span className="adm-barlist__label">{row.key}</span>
                    <span className="adm-barlist__value adm-mono">
                      {formatVnd(row.net)}
                    </span>
                  </div>
                  <div className="adm-barlist__track" aria-hidden="true">
                    <div
                      className="adm-barlist__fill"
                      style={{
                        width: `${Math.max(2, (Math.abs(row.net) / maxNet) * 100)}%`,
                      }}
                    />
                  </div>
                  <div className="adm-barlist__foot">
                    <span className="adm-mono">{row.transactions} giao dịch</span>
                    <span className="adm-mono">{row.share.toFixed(1)}%</span>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </article>

        <article className="adm-card">
          <header className="adm-card__head">
            <div>
              <span className="adm-eyebrow">GIAO DỊCH THEO TRẠNG THÁI</span>
              <h2 className="adm-card__title">Phân bổ trạng thái</h2>
            </div>
          </header>

          {revenue && Object.keys(revenue.transactionsByStatus).length > 0 ? (
            <ul className="adm-statuslist">
              {Object.entries(revenue.transactionsByStatus).map(([status, count]) => (
                <li key={status} className="adm-statuslist__row">
                  <AdminPill
                    tone={
                      status === "Succeeded"
                        ? "success"
                        : status === "Failed"
                          ? "danger"
                          : status === "Pending"
                            ? "warn"
                            : "neutral"
                    }
                  >
                    {status}
                  </AdminPill>
                  <span className="adm-statuslist__count adm-mono">{count}</span>
                </li>
              ))}
            </ul>
          ) : (
            <AdminEmptyState icon="receipt_long" title="Chưa có giao dịch nào" />
          )}

          <div className="adm-card__divider" />

          <div className="adm-meta-list">
            <div className="adm-meta-row">
              <span className="adm-meta-row__label">Kỳ báo cáo</span>
              <span className="adm-meta-row__value adm-mono">
                {formatDate(revenue?.from)} → {formatDate(revenue?.to)}
              </span>
            </div>
            <div className="adm-meta-row">
              <span className="adm-meta-row__label">Hoàn tiền đã xử lý</span>
              <span className="adm-meta-row__value adm-mono">
                {formatVnd(totals?.refundedAmount ?? 0)}
              </span>
            </div>
            <div className="adm-meta-row">
              <span className="adm-meta-row__label">Hoá đơn phát hành</span>
              <span className="adm-meta-row__value adm-mono">
                {totals?.invoicesIssued ?? 0}
              </span>
            </div>
          </div>
        </article>
      </section>

      <section className="adm-card">
        <header className="adm-card__head">
          <div>
            <span className="adm-eyebrow">GÓI ĐĂNG KÝ</span>
            <h2 className="adm-card__title">Gói trong hệ thống</h2>
          </div>
          <Link to="/admin/plans" className="adm-btn adm-btn--outline adm-btn--sm">
            Quản lý gói
            <span className="material-symbols-outlined" aria-hidden="true">
              arrow_forward
            </span>
          </Link>
        </header>

        {plans.length === 0 ? (
          <AdminEmptyState
            icon="workspace_premium"
            title="Chưa có gói đăng ký"
            hint="Tạo gói đầu tiên để người dùng có thể nâng cấp."
          />
        ) : (
          <div className="adm-table-wrap">
            <table className="adm-table">
              <thead>
                <tr>
                  <th scope="col">Tên gói</th>
                  <th scope="col" className="adm-table__num">Giá</th>
                  <th scope="col" className="adm-table__num">Thời hạn</th>
                  <th scope="col" className="adm-table__num">Dự án</th>
                  <th scope="col" className="adm-table__num">AI calls</th>
                  <th scope="col">Trạng thái</th>
                </tr>
              </thead>
              <tbody>
                {plans.map((plan) => (
                  <tr key={plan.id}>
                    <td>
                      <span className="adm-table__strong">{plan.name}</span>
                    </td>
                    <td className="adm-table__num adm-mono">
                      {plan.price === 0 ? "Miễn phí" : formatVnd(plan.price)}
                    </td>
                    <td className="adm-table__num adm-mono">{plan.durationDays} ngày</td>
                    <td className="adm-table__num adm-mono">{plan.projectLimit ?? "∞"}</td>
                    <td className="adm-table__num adm-mono">{plan.aiCallLimit ?? "∞"}</td>
                    <td>
                      <AdminPill tone={plan.isActive ? "success" : "neutral"}>
                        {plan.isActive ? "Đang bán" : "Đã tắt"}
                      </AdminPill>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <AdminToast toast={toast} onClose={closeToast} />
    </div>
  );
}
