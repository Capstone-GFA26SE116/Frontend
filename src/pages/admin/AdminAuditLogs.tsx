import { useCallback, useState } from "react";
import { listAdminAuditLogs } from "../../lib/admin-api";
import type { AdminAuditLogDto } from "../../lib/admin-api";
import {
  AdminEmptyState,
  AdminErrorState,
  AdminLoading,
  AdminModal,
  AdminPagination,
  AdminPill,
  AdminToast,
} from "./admin-shared";
import { EMPTY_TOAST, useCopyToClipboard } from "./admin-constants";
import type { AdminToastState } from "./admin-constants";
import { useAdminLoad } from "./useAdminLoad";
import "./admin.css";

/**
 * Trang nhật ký thao tác Admin.
 *
 * API: GET /api/admin/audit-logs?adminId=&targetType=&targetId=&action=&from=&to=&page=&pageSize=
 *  - Mới nhất trước.
 *  - `action` có dạng `<Bảng>.<Create|Update|Delete>`, riêng status-resync là `StatusResync.Run`.
 *  - `oldValue`/`newValue` là JSON string.
 *  - Nhật ký chỉ đọc — không có API sửa/xoá.
 */

const PAGE_SIZE = 20;

/** Các loại target thường gặp — dùng cho dropdown lọc. */
const TARGET_TYPES = [
  "SubscriptionPlan",
  "User",
  "UserSubscription",
  "PaymentTransaction",
  "Invoice",
  "Refund",
  "StatusResync",
];

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
    second: "2-digit",
  });
}

/** Tách `SubscriptionPlan.Update` → table + action. */
function splitAction(action: string): { table: string; action: string } {
  const idx = action.lastIndexOf(".");
  if (idx <= 0) return { table: action, action: "" };
  return { table: action.slice(0, idx), action: action.slice(idx + 1) };
}

function actionTone(action: string): "success" | "danger" | "accent" | "neutral" {
  if (action.endsWith("Delete")) return "danger";
  if (action.endsWith("Create")) return "success";
  if (action.endsWith("Update")) return "accent";
  return "neutral";
}

const ACTION_LABEL: Record<string, string> = {
  Create: "Tạo",
  Update: "Sửa",
  Delete: "Xoá",
  Run: "Chạy",
};

/** Định dạng JSON cho đọc: thử parse, nếu là JSON thì pretty-print. */
function formatJson(raw: string | null): string {
  if (!raw) return "";
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
}

export function AdminAuditLogs() {
  const [targetType, setTargetType] = useState("");
  const [action, setAction] = useState("");
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");
  const [page, setPage] = useState(1);

  const [toast, setToast] = useState<AdminToastState>(EMPTY_TOAST);

  const [detail, setDetail] = useState<AdminAuditLogDto | null>(null);
  const { copied, copy } = useCopyToClipboard();

  const closeToast = useCallback(() => setToast(EMPTY_TOAST), []);

  const { data, loading, error, reload } = useAdminLoad(
    async () => {
      const res = await listAdminAuditLogs({
        targetType: targetType || undefined,
        action: action || undefined,
        from: fromDate ? new Date(fromDate).toISOString() : undefined,
        to: toDate
          ? new Date(new Date(toDate).getTime() + 86400000).toISOString()
          : undefined,
        page,
        pageSize: PAGE_SIZE,
      });
      return {
        ok: res.ok,
        error: res.error ?? "Không tải được nhật ký thao tác.",
        data: res.ok ? res.data : null,
      };
    },
    [targetType, action, fromDate, toDate, page],
  );

  const items = data?.items ?? [];
  const totalCount = data?.totalCount ?? 0;

  function resetFilters() {
    setTargetType("");
    setAction("");
    setFromDate("");
    setToDate("");
    setPage(1);
  }

  return (
    <div className="adm-page">
      <div className="adm-page-head">
        <div>
          <span className="adm-eyebrow">TRUY VẤT</span>
          <h1 className="adm-page-title">Nhật ký thao tác</h1>
          <p className="adm-page-sub">
            Mọi thay đổi do Admin thực hiện đều được ghi lại: giá trị cũ, giá trị
            mới, ai làm, lúc nào và lý do. Nhật ký chỉ đọc.
          </p>
        </div>
      </div>

      {/* ============ Bộ lọc ============ */}
      <section className="adm-card adm-card--filter">
        <div className="adm-filter adm-filter--wrap">
          <div className="adm-field">
            <label className="adm-label" htmlFor="adm-log-target">
              Loại đối tượng
            </label>
            <select
              id="adm-log-target"
              className="adm-input adm-select"
              value={targetType}
              onChange={(e) => {
                setTargetType(e.target.value);
                setPage(1);
              }}
            >
              <option value="">Tất cả</option>
              {TARGET_TYPES.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          </div>

          <div className="adm-field">
            <label className="adm-label" htmlFor="adm-log-action">
              Hành động
            </label>
            <select
              id="adm-log-action"
              className="adm-input adm-select"
              value={action}
              onChange={(e) => {
                setAction(e.target.value);
                setPage(1);
              }}
            >
              <option value="">Tất cả</option>
              <option value="Create">Create</option>
              <option value="Update">Update</option>
              <option value="Delete">Delete</option>
              <option value="StatusResync.Run">StatusResync.Run</option>
            </select>
          </div>

          <div className="adm-field">
            <label className="adm-label" htmlFor="adm-log-from">
              Từ ngày
            </label>
            <input
              id="adm-log-from"
              type="date"
              className="adm-input adm-mono"
              value={fromDate}
              onChange={(e) => {
                setFromDate(e.target.value);
                setPage(1);
              }}
            />
          </div>

          <div className="adm-field">
            <label className="adm-label" htmlFor="adm-log-to">
              Đến ngày
            </label>
            <input
              id="adm-log-to"
              type="date"
              className="adm-input adm-mono"
              value={toDate}
              onChange={(e) => {
                setToDate(e.target.value);
                setPage(1);
              }}
            />
          </div>

          <div className="adm-filter__actions">
            <button type="button" className="adm-btn adm-btn--outline" onClick={resetFilters}>
              Đặt lại
            </button>
          </div>
        </div>
      </section>

      {/* ============ Bảng ============ */}
      <section className="adm-card">
        <header className="adm-card__head">
          <div>
            <span className="adm-eyebrow">LỊCH SỬ</span>
            <h2 className="adm-card__title">
              {loading ? "Đang tải…" : `${totalCount} bản ghi`}
            </h2>
          </div>
        </header>

        {loading ? (
          <AdminLoading label="Đang tải nhật ký…" />
        ) : error ? (
          <AdminErrorState message={error} onRetry={reload} />
        ) : items.length === 0 ? (
          <AdminEmptyState
            icon="history"
            title="Không có bản ghi nào"
            hint="Nhật ký chỉ ghi thay đổi, không ghi lần đăng nhập hay lần đọc dữ liệu."
          />
        ) : (
          <>
            <div className="adm-table-wrap">
              <table className="adm-table">
                <thead>
                  <tr>
                    <th scope="col">Thời điểm</th>
                    <th scope="col">Admin</th>
                    <th scope="col">Hành động</th>
                    <th scope="col">Đối tượng</th>
                    <th scope="col">Lý do</th>
                    <th scope="col" className="adm-table__actions">Chi tiết</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((log) => {
                    const parsed = splitAction(log.action);
                    return (
                      <tr key={log.id}>
                        <td className="adm-mono adm-table__nowrap">
                          {formatDateTime(log.createdAt)}
                        </td>
                        <td>
                          <span className="adm-table__strong">{log.adminEmail}</span>
                        </td>
                        <td>
                          <AdminPill tone={actionTone(log.action)}>
                            {ACTION_LABEL[parsed.action] ?? parsed.action} · {parsed.table}
                          </AdminPill>
                        </td>
                        <td className="adm-mono adm-table__nowrap">{log.targetType}</td>
                        <td className="adm-table__reason">
                          {log.reason ? (
                            <span title={log.reason}>{log.reason}</span>
                          ) : (
                            <span className="adm-muted">—</span>
                          )}
                        </td>
                        <td className="adm-table__actions">
                          <button
                            type="button"
                            className="adm-btn adm-btn--ghost adm-btn--sm"
                            onClick={() => setDetail(log)}
                          >
                            <span className="material-symbols-outlined" aria-hidden="true">
                              visibility
                            </span>
                            Xem
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            <AdminPagination
              page={page}
              pageSize={PAGE_SIZE}
              totalCount={totalCount}
              onPageChange={setPage}
            />
          </>
        )}
      </section>

      {/* ============ Chi tiết bản ghi ============ */}
      <AdminModal
        open={detail !== null}
        wide
        eyebrow="CHI TIẾT NHẬT KÝ"
        title={detail?.action ?? "Nhật ký"}
        onClose={() => setDetail(null)}
      >
        {detail && (
          <div className="adm-detail">
            <div className="adm-detail__grid">
              <div className="adm-detail__item">
                <span className="adm-meta-row__label">Thời điểm</span>
                <strong className="adm-mono">{formatDateTime(detail.createdAt)}</strong>
              </div>
              <div className="adm-detail__item">
                <span className="adm-meta-row__label">Admin</span>
                <strong>{detail.adminEmail}</strong>
              </div>
              <div className="adm-detail__item">
                <span className="adm-meta-row__label">Loại đối tượng</span>
                <strong className="adm-mono">{detail.targetType}</strong>
              </div>
              <div className="adm-detail__item">
                <span className="adm-meta-row__label">ID đối tượng</span>
                <strong className="adm-mono adm-detail__id">{detail.targetId}</strong>
              </div>
            </div>

            {detail.reason && (
              <div className="adm-section">
                <h3 className="adm-section__title">Lý do</h3>
                <p className="adm-reason-box">{detail.reason}</p>
              </div>
            )}

            {detail.oldValue && (
              <div className="adm-section">
                <div className="adm-section__head">
                  <h3 className="adm-section__title">Giá trị cũ</h3>
                  <button
                    type="button"
                    className="adm-btn adm-btn--ghost adm-btn--sm"
                    onClick={() => {
                      void copy(formatJson(detail.oldValue), "old");
                      setToast({
                        visible: true,
                        tone: "info",
                        message: "Đã sao chép giá trị cũ.",
                      });
                    }}
                  >
                    <span className="material-symbols-outlined" aria-hidden="true">
                      content_copy
                    </span>
                    {copied === "old" ? "Đã chép" : "Sao chép"}
                  </button>
                </div>
                <pre className="adm-code">{formatJson(detail.oldValue)}</pre>
              </div>
            )}

            {detail.newValue && (
              <div className="adm-section">
                <div className="adm-section__head">
                  <h3 className="adm-section__title">Giá trị mới</h3>
                  <button
                    type="button"
                    className="adm-btn adm-btn--ghost adm-btn--sm"
                    onClick={() => {
                      void copy(formatJson(detail.newValue), "new");
                      setToast({
                        visible: true,
                        tone: "info",
                        message: "Đã sao chép giá trị mới.",
                      });
                    }}
                  >
                    <span className="material-symbols-outlined" aria-hidden="true">
                      content_copy
                    </span>
                    {copied === "new" ? "Đã chép" : "Sao chép"}
                  </button>
                </div>
                <pre className="adm-code">{formatJson(detail.newValue)}</pre>
              </div>
            )}

            {!detail.oldValue && !detail.newValue && (
              <p className="adm-muted">Bản ghi này không có giá trị cũ/mới.</p>
            )}
          </div>
        )}
      </AdminModal>

      <AdminToast toast={toast} onClose={closeToast} />
    </div>
  );
}
