import { useCallback, useState } from "react";
import { listInvoices, listPaymentTransactions } from "../../lib/admin-api";
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
 * Trang giao dịch & hoá đơn.
 *
 * API:
 *   GET /api/payment-transactions?status=&userId=&planId=&from=&to=&page=&pageSize=
 *   GET /api/invoices?userId=&from=&to=&search=&page=&pageSize=
 *
 * Tổng số dòng nằm ở header `X-Total-Count` khi có phân trang.
 */

const VND = new Intl.NumberFormat("vi-VN");

const TX_STATUSES = [
  "Pending",
  "Succeeded",
  "Failed",
  "Cancelled",
  "Expired",
];

const PAGE_SIZE = 20;

function formatVnd(value: number): string {
  return `${VND.format(value)} đ`;
}

function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString("vi-VN", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function statusTone(status: string): "success" | "danger" | "warn" | "neutral" {
  if (status === "Succeeded") return "success";
  if (status === "Failed") return "danger";
  if (status === "Pending") return "warn";
  return "neutral";
}

export function AdminTransactions() {
  const [tab, setTab] = useState<"transactions" | "invoices">("transactions");

  // --- Bộ lọc giao dịch ---
  const [txStatus, setTxStatus] = useState("");
  const [txFrom, setTxFrom] = useState("");
  const [txTo, setTxTo] = useState("");
  const [txPage, setTxPage] = useState(1);

  // --- Bộ lọc hoá đơn ---
  const [invSearch, setInvSearch] = useState("");
  const [invFrom, setInvFrom] = useState("");
  const [invTo, setInvTo] = useState("");
  const [invPage, setInvPage] = useState(1);

  const [toast, setToast] = useState<AdminToastState>(EMPTY_TOAST);

  const closeToast = useCallback(() => setToast(EMPTY_TOAST), []);

  /**
   * Giao dịch và hoá đơn dùng chung 1 vòng tải (setState sau `await`).
   */
  const { data, loading, error, reload } = useAdminLoad(
    async () => {
      const txToIso = txTo
        ? new Date(new Date(txTo).getTime() + 86400000).toISOString()
        : undefined;

      const [txRes, invRes] = await Promise.all([
        listPaymentTransactions({
          status: txStatus || undefined,
          from: txFrom ? new Date(txFrom).toISOString() : undefined,
          to: txToIso,
          page: txPage,
          pageSize: PAGE_SIZE,
        }),
        listInvoices({
          search: invSearch || undefined,
          from: invFrom ? new Date(invFrom).toISOString() : undefined,
          to: invTo
            ? new Date(new Date(invTo).getTime() + 86400000).toISOString()
            : undefined,
          page: invPage,
          pageSize: PAGE_SIZE,
        }),
      ]);

      const allFailed = !txRes.ok && !invRes.ok;

      return {
        ok: !allFailed,
        error: allFailed
          ? (txRes.error ?? invRes.error ?? "Không tải được dữ liệu.")
          : undefined,
        data: {
          transactions: txRes.ok ? (txRes.data ?? []) : [],
          txTotal: txRes.ok ? (txRes.totalCount ?? txRes.data?.length ?? 0) : 0,
          invoices: invRes.ok ? (invRes.data ?? []) : [],
          invTotal: invRes.ok ? (invRes.totalCount ?? invRes.data?.length ?? 0) : 0,
        },
      };
    },
    [txStatus, txFrom, txTo, txPage, invSearch, invFrom, invTo, invPage],
  );

  const transactions = data?.transactions ?? [];
  const txTotal = data?.txTotal ?? 0;
  const invoices = data?.invoices ?? [];
  const invTotal = data?.invTotal ?? 0;

  return (
    <div className="adm-page">
      <div className="adm-page-head">
        <div>
          <span className="adm-eyebrow">TÀI CHÍNH</span>
          <h1 className="adm-page-title">Giao dịch & Hoá đơn</h1>
          <p className="adm-page-sub">
            Lọc theo trạng thái, người dùng, gói và khoảng thời gian. Tổng số dòng
            đến từ header <code>X-Total-Count</code>.
          </p>
        </div>
      </div>

      {/* ============ Tabs ============ */}
      <div className="adm-tabs" role="tablist" aria-label="Loại dữ liệu">
        <button
          type="button"
          role="tab"
          aria-selected={tab === "transactions"}
          className={`adm-tab${tab === "transactions" ? " adm-tab--on" : ""}`}
          onClick={() => setTab("transactions")}
        >
          <span className="material-symbols-outlined" aria-hidden="true">
            receipt_long
          </span>
          Giao dịch
          <span className="adm-tab__count adm-mono">{txTotal}</span>
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === "invoices"}
          className={`adm-tab${tab === "invoices" ? " adm-tab--on" : ""}`}
          onClick={() => setTab("invoices")}
        >
          <span className="material-symbols-outlined" aria-hidden="true">
            description
          </span>
          Hoá đơn
          <span className="adm-tab__count adm-mono">{invTotal}</span>
        </button>
      </div>

      {/* ============ Bộ lọc giao dịch ============ */}
      {tab === "transactions" && (
        <section className="adm-card adm-card--filter">
          <div className="adm-filter adm-filter--wrap">
            <div className="adm-field">
              <label className="adm-label" htmlFor="adm-tx-status">
                Trạng thái
              </label>
              <select
                id="adm-tx-status"
                className="adm-input adm-select"
                value={txStatus}
                onChange={(e) => {
                  setTxStatus(e.target.value);
                  setTxPage(1);
                }}
              >
                <option value="">Tất cả</option>
                {TX_STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
            </div>

            <div className="adm-field">
              <label className="adm-label" htmlFor="adm-tx-from">
                Từ ngày
              </label>
              <input
                id="adm-tx-from"
                type="date"
                className="adm-input adm-mono"
                value={txFrom}
                onChange={(e) => {
                  setTxFrom(e.target.value);
                  setTxPage(1);
                }}
              />
            </div>

            <div className="adm-field">
              <label className="adm-label" htmlFor="adm-tx-to">
                Đến ngày
              </label>
              <input
                id="adm-tx-to"
                type="date"
                className="adm-input adm-mono"
                value={txTo}
                onChange={(e) => {
                  setTxTo(e.target.value);
                  setTxPage(1);
                }}
              />
            </div>

            <div className="adm-filter__actions">
              <button
                type="button"
                className="adm-btn adm-btn--outline"
                onClick={() => {
                  setTxStatus("");
                  setTxFrom("");
                  setTxTo("");
                  setTxPage(1);
                }}
              >
                Đặt lại
              </button>
            </div>
          </div>
        </section>
      )}

      {/* ============ Bộ lọc hoá đơn ============ */}
      {tab === "invoices" && (
        <section className="adm-card adm-card--filter">
          <div className="adm-filter adm-filter--wrap">
            <div className="adm-field adm-field--grow">
              <label className="adm-label" htmlFor="adm-inv-search">
                Tìm kiếm
              </label>
              <div className="adm-search">
                <span className="material-symbols-outlined adm-search__icon" aria-hidden="true">
                  search
                </span>
                <input
                  id="adm-inv-search"
                  type="search"
                  className="adm-input adm-search__input"
                  placeholder="Số hoá đơn, tên gói, tên hoặc email thanh toán…"
                  value={invSearch}
                  onChange={(e) => setInvSearch(e.target.value)}
                />
              </div>
            </div>

            <div className="adm-field">
              <label className="adm-label" htmlFor="adm-inv-from">
                Từ ngày
              </label>
              <input
                id="adm-inv-from"
                type="date"
                className="adm-input adm-mono"
                value={invFrom}
                onChange={(e) => {
                  setInvFrom(e.target.value);
                  setInvPage(1);
                }}
              />
            </div>

            <div className="adm-field">
              <label className="adm-label" htmlFor="adm-inv-to">
                Đến ngày
              </label>
              <input
                id="adm-inv-to"
                type="date"
                className="adm-input adm-mono"
                value={invTo}
                onChange={(e) => {
                  setInvTo(e.target.value);
                  setInvPage(1);
                }}
              />
            </div>

            <div className="adm-filter__actions">
              <button
                type="button"
                className="adm-btn adm-btn--outline"
                onClick={() => {
                  setInvSearch("");
                  setInvFrom("");
                  setInvTo("");
                  setInvPage(1);
                }}
              >
                Đặt lại
              </button>
            </div>
          </div>
        </section>
      )}

      {/* ============ Bảng ============ */}
      <section className="adm-card">
        {loading ? (
          <AdminLoading label="Đang tải dữ liệu…" />
        ) : error ? (
          <AdminErrorState message={error} onRetry={reload} />
        ) : tab === "transactions" ? (
          transactions.length === 0 ? (
            <AdminEmptyState
              icon="receipt_long"
              title="Không có giao dịch nào"
              hint="Thử bỏ bộ lọc trạng thái hoặc mở rộng khoảng thời gian."
            />
          ) : (
            <>
              <div className="adm-table-wrap">
                <table className="adm-table">
                  <thead>
                    <tr>
                      <th scope="col">Mã đơn</th>
                      <th scope="col">Cổng thanh toán</th>
                      <th scope="col" className="adm-table__num">Số tiền</th>
                      <th scope="col">Trạng thái</th>
                      <th scope="col" className="adm-table__num">Ngày tạo</th>
                      <th scope="col" className="adm-table__num">Ngày thanh toán</th>
                      <th scope="col">Mã người dùng</th>
                    </tr>
                  </thead>
                  <tbody>
                    {transactions.map((tx) => (
                      <tr key={tx.id}>
                        <td className="adm-mono adm-table__strong">{tx.orderCode}</td>
                        <td className="adm-mono">{tx.gateway}</td>
                        <td className="adm-table__num adm-mono">{formatVnd(tx.amount)}</td>
                        <td>
                          <AdminPill tone={statusTone(tx.status)}>{tx.status}</AdminPill>
                        </td>
                        <td className="adm-table__num adm-mono adm-table__nowrap">
                          {formatDateTime(tx.createdAt)}
                        </td>
                        <td className="adm-table__num adm-mono adm-table__nowrap">
                          {formatDateTime(tx.paidAt)}
                        </td>
                        <td className="adm-mono adm-table__id">{tx.userId}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <Pagination
                page={txPage}
                totalCount={txTotal}
                onPageChange={setTxPage}
              />
            </>
          )
        ) : invoices.length === 0 ? (
          <AdminEmptyState
            icon="description"
            title="Không có hoá đơn nào"
            hint="Thử từ khoá khác hoặc mở rộng khoảng thời gian."
          />
        ) : (
          <>
            <div className="adm-table-wrap">
              <table className="adm-table">
                <thead>
                  <tr>
                    <th scope="col">Số hoá đơn</th>
                    <th scope="col">Gói</th>
                    <th scope="col" className="adm-table__num">Số tiền</th>
                    <th scope="col">Người thanh toán</th>
                    <th scope="col" className="adm-table__num">Kỳ hiệu lực</th>
                    <th scope="col" className="adm-table__num">Ngày phát hành</th>
                  </tr>
                </thead>
                <tbody>
                  {invoices.map((inv) => (
                    <tr key={inv.id}>
                      <td className="adm-mono adm-table__strong">{inv.invoiceNumber}</td>
                      <td>{inv.planName}</td>
                      <td className="adm-table__num adm-mono">{formatVnd(inv.amount)}</td>
                      <td>
                        <div className="adm-user-cell__info">
                          <span>{inv.billingName || "—"}</span>
                          <span className="adm-user-cell__email">{inv.billingEmail}</span>
                        </div>
                      </td>
                      <td className="adm-table__num adm-mono adm-table__nowrap">
                        {formatDateTime(inv.periodStart)} → {formatDateTime(inv.periodEnd)}
                      </td>
                      <td className="adm-table__num adm-mono adm-table__nowrap">
                        {formatDateTime(inv.issuedAt)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Pagination
              page={invPage}
              totalCount={invTotal}
              onPageChange={setInvPage}
            />
          </>
        )}
      </section>

      <AdminToast toast={toast} onClose={closeToast} />
    </div>
  );
}

/** Phân trang nhỏ (dùng chung cho 2 tab). */
function Pagination({
  page,
  totalCount,
  onPageChange,
}: {
  page: number;
  totalCount: number;
  onPageChange: (p: number) => void;
}) {
  const totalPages = Math.max(1, Math.ceil(totalCount / PAGE_SIZE));
  if (totalCount === 0) return null;

  const from = (page - 1) * PAGE_SIZE + 1;
  const to = Math.min(page * PAGE_SIZE, totalCount);

  return (
    <div className="adm-pagination">
      <span className="adm-pagination__info">
        <span className="adm-mono">{from}</span>–<span className="adm-mono">{to}</span> /{" "}
        <span className="adm-mono">{totalCount}</span>
      </span>
      <div className="adm-pagination__controls">
        <button
          type="button"
          className="adm-btn adm-btn--outline adm-btn--sm"
          onClick={() => onPageChange(page - 1)}
          disabled={page <= 1}
        >
          <span className="material-symbols-outlined" aria-hidden="true">
            chevron_left
          </span>
          Trước
        </button>
        <span className="adm-pagination__page adm-mono">
          {page} / {totalPages}
        </span>
        <button
          type="button"
          className="adm-btn adm-btn--outline adm-btn--sm"
          onClick={() => onPageChange(page + 1)}
          disabled={page >= totalPages}
        >
          Sau
          <span className="material-symbols-outlined" aria-hidden="true">
            chevron_right
          </span>
        </button>
      </div>
    </div>
  );
}
