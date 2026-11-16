import { useCallback, useState } from "react";
import {
  createAdminUser,
  deleteAdminUser,
  getAdminUser,
  listAdminUsers,
  restoreAdminUser,
  updateAdminUser,
} from "../../lib/admin-api";
import type {
  AdminUserListItemDto,
  AdminUserRequestDto,
} from "../../lib/admin-api";
import {
  AdminConfirmDialog,
  AdminEmptyState,
  AdminErrorState,
  AdminLoading,
  AdminModal,
  AdminPagination,
  AdminPill,
  AdminReasonField,
  AdminToast,
} from "./admin-shared";
import { EMPTY_TOAST } from "./admin-constants";
import type { AdminToastState } from "./admin-constants";
import { useAdminLoad } from "./useAdminLoad";
import "./admin.css";

/**
 * Trang quản lý người dùng.
 *
 * API: GET/POST /api/admin/users, GET/PUT/DELETE /api/admin/users/{id},
 *      POST /api/admin/users/{id}/restore
 *
 * Luật quan trọng (ADMIN_FE.md mục 3):
 *  - Đổi `role` → BẮT BUỘC lý do (header X-Admin-Reason).
 *  - Khoá tài khoản (DELETE) → BẮT BUỘC lý do.
 *  - Không xoá/hạ quyền Admin cuối cùng; Admin không tự xoá mình.
 *  - Đổi role chỉ có hiệu lực với token mới.
 */

const VND = new Intl.NumberFormat("vi-VN");

/** Các role BE chấp nhận (fallback khi BE đổi danh sách). */
const ROLE_OPTIONS = ["Admin", "User", "Student"];

const PAGE_SIZE = 20;

function formatVnd(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return "—";
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

function roleTone(role: string): "accent" | "neutral" | "warn" {
  if (role.toLowerCase() === "admin") return "accent";
  if (role.toLowerCase() === "student") return "warn";
  return "neutral";
}

export function AdminUsers() {
  const [search, setSearch] = useState("");
  const [searchInput, setSearchInput] = useState("");
  const [roleFilter, setRoleFilter] = useState("");
  const [includeDeleted, setIncludeDeleted] = useState(false);
  const [page, setPage] = useState(1);

  const [toast, setToast] = useState<AdminToastState>(EMPTY_TOAST);

  // --- Modal / hành động ---
  const [detailId, setDetailId] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [lockTarget, setLockTarget] = useState<AdminUserListItemDto | null>(null);
  const [lockReason, setLockReason] = useState("");
  const [lockBusy, setLockBusy] = useState(false);
  const [restoreTarget, setRestoreTarget] = useState<AdminUserListItemDto | null>(null);
  const [restoreBusy, setRestoreBusy] = useState(false);

  const closeToast = useCallback(() => setToast(EMPTY_TOAST), []);

  /**
   * setState diễn ra sau `await` (trong hook) → không vi phạm
   * `react-hooks/set-state-in-effect`.
   */
  const { data, loading, error, reload } = useAdminLoad(
    async () => {
      const res = await listAdminUsers({
        search: search || undefined,
        role: roleFilter || undefined,
        includeDeleted,
        page,
        pageSize: PAGE_SIZE,
      });
      return {
        ok: res.ok,
        error: res.error,
        data: res.ok ? res.data : null,
      };
    },
    [search, roleFilter, includeDeleted, page],
  );

  const items = data?.items ?? [];
  const totalCount = data?.totalCount ?? 0;

  function applySearch() {
    setSearch(searchInput.trim());
    setPage(1);
  }

  function resetFilters() {
    setSearchInput("");
    setSearch("");
    setRoleFilter("");
    setIncludeDeleted(false);
    setPage(1);
  }

  /** Khoá tài khoản — bắt buộc lý do (header X-Admin-Reason). */
  async function handleLock() {
    if (!lockTarget) return;
    if (!lockReason.trim()) return;

    setLockBusy(true);
    const res = await deleteAdminUser(lockTarget.id, lockReason.trim());
    setLockBusy(false);

    if (!res.ok) {
      setToast({
        visible: true,
        tone: "error",
        message: res.error ?? "Không khoá được tài khoản.",
      });
      return;
    }

    setLockTarget(null);
    setLockReason("");
    setToast({
      visible: true,
      tone: "success",
      message: `Đã khoá tài khoản ${lockTarget.email}.`,
    });
    reload();
  }

  /** Khôi phục tài khoản đã khoá. */
  async function handleRestore() {
    if (!restoreTarget) return;

    setRestoreBusy(true);
    const res = await restoreAdminUser(restoreTarget.id);
    setRestoreBusy(false);

    if (!res.ok) {
      setToast({
        visible: true,
        tone: "error",
        message: res.error ?? "Không khôi phục được tài khoản.",
      });
      return;
    }

    setRestoreTarget(null);
    setToast({
      visible: true,
      tone: "success",
      message: `Đã khôi phục tài khoản ${restoreTarget.email}.`,
    });
    reload();
  }

  return (
    <div className="adm-page">
      <div className="adm-page-head">
        <div>
          <span className="adm-eyebrow">QUẢN LÝ NGƯỜI DÙNG</span>
          <h1 className="adm-page-title">Người dùng</h1>
          <p className="adm-page-sub">
            Tìm kiếm, đổi vai trò, khoá và khôi phục tài khoản. Mọi thao tác ghi đều
            được ghi vào nhật ký Admin.
          </p>
        </div>
        <div className="adm-page-head__actions">
          <button
            type="button"
            className="adm-btn adm-btn--primary"
            onClick={() => setCreateOpen(true)}
          >
            <span className="material-symbols-outlined" aria-hidden="true">
              person_add
            </span>
            Tạo tài khoản
          </button>
        </div>
      </div>

      {/* ============ Bộ lọc ============ */}
      <section className="adm-card adm-card--filter">
        <div className="adm-filter adm-filter--wrap">
          <div className="adm-field adm-field--grow">
            <label className="adm-label" htmlFor="adm-user-search">
              Tìm kiếm
            </label>
            <div className="adm-search">
              <span className="material-symbols-outlined adm-search__icon" aria-hidden="true">
                search
              </span>
              <input
                id="adm-user-search"
                type="search"
                className="adm-input adm-search__input"
                placeholder="Tên hoặc email…"
                value={searchInput}
                onChange={(e) => setSearchInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") applySearch();
                }}
              />
            </div>
          </div>

          <div className="adm-field">
            <label className="adm-label" htmlFor="adm-user-role">
              Vai trò
            </label>
            <select
              id="adm-user-role"
              className="adm-input adm-select"
              value={roleFilter}
              onChange={(e) => {
                setRoleFilter(e.target.value);
                setPage(1);
              }}
            >
              <option value="">Tất cả</option>
              {ROLE_OPTIONS.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </select>
          </div>

          <label className="adm-check">
            <input
              type="checkbox"
              checked={includeDeleted}
              onChange={(e) => {
                setIncludeDeleted(e.target.checked);
                setPage(1);
              }}
            />
            <span>Hiện tài khoản đã khoá</span>
          </label>

          <div className="adm-filter__actions">
            <button type="button" className="adm-btn adm-btn--primary" onClick={applySearch}>
              <span className="material-symbols-outlined" aria-hidden="true">
                search
              </span>
              Lọc
            </button>
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
            <span className="adm-eyebrow">DANH SÁCH</span>
            <h2 className="adm-card__title">
              {loading ? "Đang tải…" : `${totalCount} tài khoản`}
            </h2>
          </div>
        </header>

        {loading ? (
          <AdminLoading label="Đang tải người dùng…" />
        ) : error ? (
          <AdminErrorState message={error} onRetry={reload} />
        ) : items.length === 0 ? (
          <AdminEmptyState
            icon="group"
            title="Không có người dùng nào khớp bộ lọc"
            hint="Thử đổi từ khoá, bỏ lọc vai trò hoặc bật hiện tài khoản đã khoá."
            action={
              <button type="button" className="adm-btn adm-btn--outline" onClick={resetFilters}>
                Đặt lại bộ lọc
              </button>
            }
          />
        ) : (
          <>
            <div className="adm-table-wrap">
              <table className="adm-table">
                <thead>
                  <tr>
                    <th scope="col">Người dùng</th>
                    <th scope="col">Vai trò</th>
                    <th scope="col">Gói hiện tại</th>
                    <th scope="col" className="adm-table__num">Ngày tạo</th>
                    <th scope="col">Trạng thái</th>
                    <th scope="col" className="adm-table__actions">Thao tác</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((u) => (
                    <tr key={u.id} className={u.deletedAt ? "adm-table__row--muted" : ""}>
                      <td>
                        <div className="adm-user-cell">
                          <span className="adm-user-cell__avatar" aria-hidden="true">
                            {(u.fullName || u.email || "?").charAt(0).toUpperCase()}
                          </span>
                          <div className="adm-user-cell__info">
                            <span className="adm-table__strong">{u.fullName || "Chưa đặt tên"}</span>
                            <span className="adm-user-cell__email">{u.email}</span>
                          </div>
                        </div>
                      </td>
                      <td>
                        <AdminPill tone={roleTone(u.role)}>{u.role}</AdminPill>
                      </td>
                      <td>
                        {u.currentPlanName ? (
                          <div className="adm-plan-cell">
                            <span>{u.currentPlanName}</span>
                            {u.currentPlanEndAt && (
                              <span className="adm-plan-cell__end adm-mono">
                                đến {formatDateTime(u.currentPlanEndAt)}
                              </span>
                            )}
                          </div>
                        ) : (
                          <span className="adm-muted">—</span>
                        )}
                      </td>
                      <td className="adm-table__num adm-mono">{formatDateTime(u.createdAt)}</td>
                      <td>
                        {u.deletedAt ? (
                          <AdminPill tone="danger">Đã khoá</AdminPill>
                        ) : u.onboardingCompleted ? (
                          <AdminPill tone="success">Hoàn tất</AdminPill>
                        ) : (
                          <AdminPill tone="warn">Chưa onboarding</AdminPill>
                        )}
                      </td>
                      <td className="adm-table__actions">
                        <div className="adm-row-actions">
                          <button
                            type="button"
                            className="adm-btn adm-btn--ghost adm-btn--sm"
                            onClick={() => setDetailId(u.id)}
                          >
                            <span className="material-symbols-outlined" aria-hidden="true">
                              visibility
                            </span>
                            Chi tiết
                          </button>
                          {u.deletedAt ? (
                            <button
                              type="button"
                              className="adm-btn adm-btn--outline adm-btn--sm"
                              onClick={() => setRestoreTarget(u)}
                              disabled={restoreBusy}
                            >
                              <span className="material-symbols-outlined" aria-hidden="true">
                                restore
                              </span>
                              Khôi phục
                            </button>
                          ) : (
                            <button
                              type="button"
                              className="adm-btn adm-btn--danger-ghost adm-btn--sm"
                              onClick={() => setLockTarget(u)}
                            >
                              <span className="material-symbols-outlined" aria-hidden="true">
                                lock
                              </span>
                              Khoá
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
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

      {detailId && (
        <AdminUserDetailDialog
          userId={detailId}
          onClose={() => setDetailId(null)}
          onChanged={reload}
          onToast={setToast}
        />
      )}

      {createOpen && (
        <AdminCreateUserDialog
          onClose={() => setCreateOpen(false)}
          onCreated={() => {
            setCreateOpen(false);
            reload();
            setToast({
              visible: true,
              tone: "success",
              message: "Đã tạo tài khoản. Người dùng có thể đăng nhập bằng email này.",
            });
          }}
          onToast={setToast}
        />
      )}

      {/* ============ Khoá tài khoản (bắt buộc lý do) ============ */}
      <AdminConfirmDialog
        open={lockTarget !== null}
        eyebrow="HÀNH ĐỘNG KHÔNG THỂ HOÀN TÁC"
        title="Khoá tài khoản"
        danger
        busy={lockBusy}
        confirmLabel="Khoá tài khoản"
        reasonRequired
        reason={lockReason}
        onReasonChange={setLockReason}
        message={
          <>
            <p>
              Khoá tài khoản <strong>{lockTarget?.email}</strong> sẽ thu hồi mọi phiên
              đăng nhập và huỷ liên kết Google.
            </p>
            <p className="adm-confirm__note">
              Dữ liệu vẫn được giữ. Có thể khôi phục tài khoản sau.
            </p>
          </>
        }
        onClose={() => {
          setLockTarget(null);
          setLockReason("");
        }}
        onConfirm={handleLock}
      />

      {/* ============ Khôi phục ============ */}
      <AdminConfirmDialog
        open={restoreTarget !== null}
        title="Khôi phục tài khoản"
        busy={restoreBusy}
        confirmLabel="Khôi phục"
        message={
          <>
            <p>
              Khôi phục tài khoản <strong>{restoreTarget?.email}</strong>?
            </p>
            <p className="adm-confirm__note">
              Người dùng sẽ đăng nhập lại được và liên kết Google có thể cần kết nối
              lại.
            </p>
          </>
        }
        onClose={() => setRestoreTarget(null)}
        onConfirm={handleRestore}
      />

      <AdminToast toast={toast} onClose={closeToast} />
    </div>
  );
}

/* ================================================================
 * Chi tiết người dùng + sửa role
 * ================================================================ */

function AdminUserDetailDialog({
  userId,
  onClose,
  onChanged,
  onToast,
}: {
  userId: string;
  onClose: () => void;
  onChanged: () => void;
  onToast: (t: AdminToastState) => void;
}) {
  const [role, setRole] = useState("");
  const [roleReason, setRoleReason] = useState("");
  const [saving, setSaving] = useState(false);
  const [roleError, setRoleError] = useState<string | null>(null);

  const { data: detail, loading, error, reload } = useAdminLoad(
    async () => {
      const res = await getAdminUser(userId);
      return {
        ok: res.ok,
        error: res.error,
        data: res.ok ? res.data : null,
      };
    },
    [userId],
  );

  // Đồng bộ select với role hiện tại khi dữ liệu vừa tải xong.
  const [syncedRole, setSyncedRole] = useState<string | null>(null);
  if (detail && syncedRole !== detail.id) {
    setSyncedRole(detail.id);
    setRole(detail.role);
  }

  const roleChanged = detail !== null && role !== detail.role;

  async function handleSaveRole() {
    if (!detail) return;
    setRoleError(null);

    if (!roleChanged) {
      setRoleError("Vai trò không thay đổi.");
      return;
    }
    if (!roleReason.trim()) {
      setRoleError("Đổi vai trò bắt buộc phải có lý do.");
      return;
    }

    setSaving(true);
    const res = await updateAdminUser(
      detail.id,
      { role } as AdminUserRequestDto,
      roleReason.trim(),
    );
    setSaving(false);

    if (!res.ok) {
      setRoleError(res.error ?? "Không đổi được vai trò.");
      return;
    }

    onToast({
      visible: true,
      tone: "success",
      message: `Đã đổi vai trò sang ${role}. Thay đổi có hiệu lực với token mới.`,
    });
    setRoleReason("");
    onChanged();
    reload();
  }

  return (
    <AdminModal
      open
      wide
      title="Chi tiết người dùng"
      eyebrow={detail?.email ?? "ĐANG TẢI"}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="adm-btn adm-btn--outline" onClick={onClose}>
            Đóng
          </button>
          <button
            type="button"
            className="adm-btn adm-btn--primary"
            onClick={() => void handleSaveRole()}
            disabled={saving || !roleChanged}
          >
            {saving && (
              <span className="material-symbols-outlined adm-spin" aria-hidden="true">
                progress_activity
              </span>
            )}
            Lưu vai trò
          </button>
        </>
      }
    >
      {loading ? (
        <AdminLoading label="Đang tải chi tiết…" />
      ) : error || !detail ? (
        <AdminErrorState message={error ?? "Không có dữ liệu."} onRetry={reload} />
      ) : (
        <div className="adm-detail">
          {/* ---------- Thông tin cơ bản ---------- */}
          <div className="adm-detail__grid">
            <div className="adm-detail__item">
              <span className="adm-meta-row__label">Họ tên</span>
              <strong>{detail.fullName || "—"}</strong>
            </div>
            <div className="adm-detail__item">
              <span className="adm-meta-row__label">Email</span>
              <strong className="adm-mono">{detail.email}</strong>
            </div>
            <div className="adm-detail__item">
              <span className="adm-meta-row__label">Ngày tạo</span>
              <strong className="adm-mono">{formatDateTime(detail.createdAt)}</strong>
            </div>
            <div className="adm-detail__item">
              <span className="adm-meta-row__label">Múi giờ</span>
              <strong className="adm-mono">{detail.timeZone ?? "—"}</strong>
            </div>
            <div className="adm-detail__item">
              <span className="adm-meta-row__label">Google Calendar</span>
              <strong>{detail.googleCalendarStatus ?? "—"}</strong>
            </div>
            <div className="adm-detail__item">
              <span className="adm-meta-row__label">Gói hiện tại</span>
              <strong>{detail.currentPlanName ?? "—"}</strong>
            </div>
          </div>

          {/* ---------- Số liệu ---------- */}
          <div className="adm-stat-row">
            <div className="adm-stat">
              <span className="adm-stat__value adm-mono">{detail.projectCount}</span>
              <span className="adm-stat__label">Dự án</span>
            </div>
            <div className="adm-stat">
              <span className="adm-stat__value adm-mono">{detail.taskCount}</span>
              <span className="adm-stat__label">Task</span>
            </div>
            <div className="adm-stat">
              <span className="adm-stat__value adm-mono">{detail.paymentCount}</span>
              <span className="adm-stat__label">Giao dịch</span>
            </div>
            <div className="adm-stat">
              <span className="adm-stat__value adm-mono">{detail.aiCallCount}</span>
              <span className="adm-stat__label">Lượt AI</span>
            </div>
            <div className="adm-stat">
              <span className="adm-stat__value adm-mono adm-stat__value--vnd">
                {formatVnd(detail.totalPaid)}
              </span>
              <span className="adm-stat__label">Đã thanh toán</span>
            </div>
          </div>

          {/* ---------- Đổi vai trò ---------- */}
          <div className="adm-section">
            <h3 className="adm-section__title">Vai trò</h3>
            <div className="adm-field">
              <label className="adm-label" htmlFor="adm-detail-role">
                Vai trò mới
              </label>
              <select
                id="adm-detail-role"
                className="adm-input adm-select"
                value={role}
                onChange={(e) => setRole(e.target.value)}
              >
                {!ROLE_OPTIONS.includes(detail.role) && (
                  <option value={detail.role}>{detail.role}</option>
                )}
                {ROLE_OPTIONS.map((r) => (
                  <option key={r} value={r}>
                    {r}
                  </option>
                ))}
              </select>
            </div>

            {roleChanged && (
              <>
                <AdminReasonField
                  value={roleReason}
                  onChange={setRoleReason}
                  id="adm-role-reason"
                  placeholder="Ví dụ: Cấp quyền quản trị cho đồng nghiệp mới nhận việc"
                />
                {roleError && (
                  <p className="adm-inline-error" role="alert">
                    <span className="material-symbols-outlined" aria-hidden="true">
                      error
                    </span>
                    {roleError}
                  </p>
                )}
                <p className="adm-hint">
                  Đổi vai trò chỉ có hiệu lực với token đăng nhập mới — token cũ vẫn giữ
                  vai trò cũ đến khi hết hạn.
                </p>
              </>
            )}
          </div>

          {/* ---------- Gói đăng ký ---------- */}
          <div className="adm-section">
            <h3 className="adm-section__title">Gói đăng ký</h3>
            {detail.subscriptions.length === 0 ? (
              <p className="adm-muted">Chưa có gói đăng ký nào.</p>
            ) : (
              <div className="adm-table-wrap">
                <table className="adm-table adm-table--compact">
                  <thead>
                    <tr>
                      <th scope="col">Gói</th>
                      <th scope="col">Trạng thái</th>
                      <th scope="col" className="adm-table__num">AI calls</th>
                      <th scope="col" className="adm-table__num">Hết hạn</th>
                    </tr>
                  </thead>
                  <tbody>
                    {detail.subscriptions.map((s) => (
                      <tr key={s.id}>
                        <td>{s.planName}</td>
                        <td>
                          <AdminPill
                            tone={s.status === "Active" ? "success" : "neutral"}
                          >
                            {s.status}
                          </AdminPill>
                        </td>
                        <td className="adm-table__num adm-mono">
                          {s.aiCallsUsed}/{s.aiCallLimit ?? "∞"}
                        </td>
                        <td className="adm-table__num adm-mono">{formatDateTime(s.endAt)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* ---------- Giao dịch gần đây ---------- */}
          <div className="adm-section">
            <h3 className="adm-section__title">Giao dịch gần đây</h3>
            {detail.recentPayments.length === 0 ? (
              <p className="adm-muted">Chưa có giao dịch nào.</p>
            ) : (
              <div className="adm-table-wrap">
                <table className="adm-table adm-table--compact">
                  <thead>
                    <tr>
                      <th scope="col">Mã đơn</th>
                      <th scope="col">Gói</th>
                      <th scope="col">Trạng thái</th>
                      <th scope="col" className="adm-table__num">Số tiền</th>
                    </tr>
                  </thead>
                  <tbody>
                    {detail.recentPayments.map((p) => (
                      <tr key={p.id}>
                        <td className="adm-mono">{p.orderCode}</td>
                        <td>{p.planName}</td>
                        <td>
                          <AdminPill
                            tone={p.status === "Succeeded" ? "success" : "neutral"}
                          >
                            {p.status}
                          </AdminPill>
                        </td>
                        <td className="adm-table__num adm-mono">{formatVnd(p.amount)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      )}
    </AdminModal>
  );
}

/* ================================================================
 * Tạo tài khoản trước khi đăng nhập Google
 * ================================================================ */

function AdminCreateUserDialog({
  onClose,
  onCreated,
  onToast,
}: {
  onClose: () => void;
  onCreated: () => void;
  onToast: (t: AdminToastState) => void;
}) {
  const [email, setEmail] = useState("");
  const [fullName, setFullName] = useState("");
  const [role, setRole] = useState("User");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    if (!email.trim()) {
      setError("Email là bắt buộc.");
      return;
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
      setError("Email không hợp lệ.");
      return;
    }

    setBusy(true);
    const res = await createAdminUser({
      email: email.trim(),
      fullName: fullName.trim() || undefined,
      role,
    });
    setBusy(false);

    if (!res.ok) {
      setError(res.error ?? "Không tạo được tài khoản.");
      return;
    }

    onToast({
      visible: true,
      tone: "success",
      message: "Đã tạo tài khoản.",
    });
    onCreated();
  }

  return (
    <AdminModal
      open
      title="Tạo tài khoản"
      eyebrow="TÀI KHOẢN CHỜ ĐĂNG NHẬP GOOGLE"
      onClose={busy ? () => undefined : onClose}
      footer={
        <>
          <button
            type="button"
            className="adm-btn adm-btn--outline"
            onClick={onClose}
            disabled={busy}
          >
            Huỷ
          </button>
          <button
            type="submit"
            form="adm-create-user-form"
            className="adm-btn adm-btn--primary"
            disabled={busy}
          >
            {busy && (
              <span className="material-symbols-outlined adm-spin" aria-hidden="true">
                progress_activity
              </span>
            )}
            Tạo tài khoản
          </button>
        </>
      }
    >
      <form id="adm-create-user-form" className="adm-form" onSubmit={handleSubmit}>
        <p className="adm-hint adm-hint--block">
          Tạo sẵn tài khoản để chủ nhân đăng nhập bằng Google. Khi họ đăng nhập đúng
          email này, tài khoản sẽ được liên kết tự động.
        </p>

        <div className="adm-field">
          <label className="adm-label" htmlFor="adm-create-email">
            Email <span className="adm-req">*bắt buộc*</span>
          </label>
          <input
            id="adm-create-email"
            type="email"
            className="adm-input"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="ten@congty.vn"
            autoComplete="off"
          />
        </div>

        <div className="adm-field">
          <label className="adm-label" htmlFor="adm-create-name">
            Họ và tên
          </label>
          <input
            id="adm-create-name"
            type="text"
            className="adm-input"
            value={fullName}
            onChange={(e) => setFullName(e.target.value)}
            placeholder="Nguyễn Văn A"
            autoComplete="off"
          />
        </div>

        <div className="adm-field">
          <label className="adm-label" htmlFor="adm-create-role">
            Vai trò
          </label>
          <select
            id="adm-create-role"
            className="adm-input adm-select"
            value={role}
            onChange={(e) => setRole(e.target.value)}
          >
            {ROLE_OPTIONS.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
        </div>

        {error && (
          <p className="adm-inline-error" role="alert">
            <span className="material-symbols-outlined" aria-hidden="true">error</span>
            {error}
          </p>
        )}
      </form>
    </AdminModal>
  );
}
