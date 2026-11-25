import { useCallback, useState } from "react";
import {
  archiveAdminGroup,
  getAdminGroup,
  getAdminGroupStats,
  listAdminGroupActivity,
  listAdminGroups,
  restoreAdminGroup,
  type AdminGroupActivityDto,
  type AdminGroupDetailDto,
  type AdminGroupListItemDto,
  type AdminGroupStatus,
} from "../../lib/admin-api";
import {
  AdminConfirmDialog,
  AdminEmptyState,
  AdminErrorState,
  AdminLoading,
  AdminModal,
  AdminPagination,
  AdminPill,
  AdminToast,
} from "./admin-shared";
import { EMPTY_TOAST, type AdminToastState } from "./admin-constants";
import { useAdminLoad } from "./useAdminLoad";
import "./admin.css";

/**
 * Trang quản trị nhóm — /admin/groups
 *
 * API (spec BE `FE_CHANGES.md` mục 9):
 *  - GET    /api/admin/groups?search=&status=&ownerId=&page=&pageSize=
 *  - GET    /api/admin/groups/stats
 *  - GET    /api/admin/groups/{id}
 *  - GET    /api/admin/groups/{id}/activity?skip=&take=
 *  - POST   /api/admin/groups/{id}/archive   ← BẮT BUỘC header `X-Admin-Reason`
 *  - POST   /api/admin/groups/{id}/restore   ← BẮT BUỘC header `X-Admin-Reason`
 *
 * Lưu ý: Admin KHÔNG cần là thành viên nhóm, nhưng KHÔNG thấy nội dung
 * bình luận hay lịch cá nhân của nhóm.
 *
 * Chưa có API: đổi Leader bằng quyền Admin, xoá hẳn nhóm.
 */

const PAGE_SIZE = 20;

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

/** Tone của pill trạng thái nhóm. */
function statusTone(status: string): "success" | "neutral" | "warn" {
  if (status === "Active") return "success";
  if (status === "Archived") return "neutral";
  return "warn";
}

/** Tone của pill vai trò thành viên. */
function memberRoleTone(role: string): "accent" | "neutral" | "success" {
  const r = (role ?? "").toLowerCase();
  if (r === "leader" || r === "owner") return "accent";
  if (r === "member") return "success";
  return "neutral";
}

export function AdminGroups() {
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState<"" | AdminGroupStatus>("");
  const [page, setPage] = useState(1);

  const [toast, setToast] = useState<AdminToastState>(EMPTY_TOAST);
  const closeToast = useCallback(() => setToast(EMPTY_TOAST), []);

  /* ---------- Chi tiết nhóm ---------- */
  const [detailId, setDetailId] = useState<string | null>(null);
  const [activity, setActivity] = useState<AdminGroupActivityDto[]>([]);
  const [activityLoading, setActivityLoading] = useState(false);

  /* ---------- Archive / Restore ---------- */
  const [actionTarget, setActionTarget] = useState<{
    group: AdminGroupListItemDto;
    mode: "archive" | "restore";
  } | null>(null);
  const [actionReason, setActionReason] = useState("");
  const [actionBusy, setActionBusy] = useState(false);

  /* ---------- Danh sách ---------- */
  const { data, loading, error, reload } = useAdminLoad(
    async () => {
      const res = await listAdminGroups({
        search: search.trim() || undefined,
        status: status || undefined,
        page,
        pageSize: PAGE_SIZE,
      });
      return {
        ok: res.ok,
        error: res.error ?? "Không tải được danh sách nhóm.",
        data: res.ok ? res.data : null,
      };
    },
    [search, status, page],
  );

  /* ---------- Số liệu tổng quan ---------- */
  const { data: stats } = useAdminLoad(
    async () => {
      const res = await getAdminGroupStats();
      return {
        ok: res.ok,
        error: res.error ?? "Không tải được số liệu nhóm.",
        data: res.ok ? res.data : null,
      };
    },
    [],
  );

  const items = data?.items ?? [];
  const totalCount = data?.totalCount ?? 0;

  /* ---------- Mở chi tiết ---------- */
  const [detail, setDetail] = useState<AdminGroupDetailDto | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);

  const openDetail = useCallback(async (groupId: string) => {
    setDetailId(groupId);
    setDetail(null);
    setDetailLoading(true);
    setDetailError(null);
    setActivity([]);

    const [detailRes, actRes] = await Promise.all([
      getAdminGroup(groupId),
      listAdminGroupActivity(groupId, { skip: 0, take: 30 }),
    ]);

    if (detailRes.ok && detailRes.data) setDetail(detailRes.data);
    else setDetailError(detailRes.error ?? "Không tải được chi tiết nhóm.");

    if (actRes.ok && actRes.data) setActivity(actRes.data);
    setActivityLoading(false);
    setDetailLoading(false);
  }, []);

  const closeDetail = useCallback(() => {
    setDetailId(null);
    setDetail(null);
    setDetailError(null);
    setActivity([]);
  }, []);

  /* ---------- Archive / Restore ---------- */
  const runAction = useCallback(async () => {
    if (!actionTarget) return;
    const reason = actionReason.trim();
    // Thiếu lý do → BE trả 400 → chặn trước ở UI.
    if (!reason) return;

    setActionBusy(true);
    const isArchive = actionTarget.mode === "archive";
    const res = isArchive
      ? await archiveAdminGroup(actionTarget.group.id, reason)
      : await restoreAdminGroup(actionTarget.group.id, reason);

    setActionBusy(false);

    if (res.ok) {
      setActionTarget(null);
      setActionReason("");
      setToast({
        visible: true,
        tone: "success",
        message: isArchive
          ? `Đã lưu trữ nhóm “${actionTarget.group.name}”.`
          : `Đã khôi phục nhóm “${actionTarget.group.name}”.`,
      });
      reload();
    } else {
      setToast({
        visible: true,
        tone: "error",
        message: res.error ?? "Không thực hiện được thao tác.",
      });
    }
  }, [actionTarget, actionReason, reload]);

  function resetFilters() {
    setSearch("");
    setStatus("");
    setPage(1);
  }

  return (
    <div className="adm-page">
      <AdminToast toast={toast} onClose={closeToast} />

      <div className="adm-page-head">
        <div>
          <span className="adm-eyebrow">QUẢN LÝ NHÓM</span>
          <h1 className="adm-page-title">Nhóm làm việc</h1>
          <p className="adm-page-sub">
            Theo dõi nhóm, thành viên và tiến độ. Lưu trữ hoặc khôi phục nhóm đều
            cần lý do thao tác.
          </p>
        </div>
      </div>

      {/* ============ KPI ============ */}
      {stats && (
        <section className="adm-kpi-grid" aria-label="Số liệu nhóm">
          <article className="adm-kpi adm-kpi--accent">
            <span className="adm-kpi__label">Tổng nhóm</span>
            <strong className="adm-kpi__value adm-mono">
              {stats.totalGroups ?? 0}
            </strong>
            <span className="adm-kpi__foot">
              {stats.activeGroups ?? 0} đang hoạt động ·{" "}
              {stats.archivedGroups ?? 0} đã lưu trữ
            </span>
          </article>
          <article className="adm-kpi">
            <span className="adm-kpi__label">Thành viên</span>
            <strong className="adm-kpi__value adm-mono">
              {stats.totalMembers ?? 0}
            </strong>
            <span className="adm-kpi__foot">Trong tất cả nhóm</span>
          </article>
          <article className="adm-kpi">
            <span className="adm-kpi__label">Việc trong nhóm</span>
            <strong className="adm-kpi__value adm-mono">
              {stats.totalTasks ?? 0}
            </strong>
            <span className="adm-kpi__foot">
              {stats.activeFocusSessions ?? 0} phiên bấm giờ đang chạy
            </span>
          </article>
          <article className="adm-kpi">
            <span className="adm-kpi__label">Nhóm mới · 30 ngày</span>
            <strong className="adm-kpi__value adm-mono">
              {stats.newGroupsLast30Days ?? 0}
            </strong>
            <span className="adm-kpi__foot">
              {stats.pendingInvitations ?? 0} lời mời đang chờ
            </span>
          </article>
        </section>
      )}

      {/* ============ Bộ lọc ============ */}
      <section className="adm-card adm-card--filter">
        <div className="adm-filter">
          <div className="adm-field">
            <span className="adm-label">Tìm kiếm</span>
            <input
              className="adm-input"
              type="search"
              value={search}
              placeholder="Tên nhóm…"
              onChange={(e) => {
                setSearch(e.target.value);
                setPage(1);
              }}
            />
          </div>
          <div className="adm-field">
            <span className="adm-label">Trạng thái</span>
            <select
              className="adm-input adm-select"
              value={status}
              onChange={(e) => {
                setStatus(e.target.value as "" | AdminGroupStatus);
                setPage(1);
              }}
            >
              <option value="">Tất cả</option>
              <option value="Active">Đang hoạt động</option>
              <option value="Archived">Đã lưu trữ</option>
            </select>
          </div>
          <div className="adm-filter__actions">
            <button
              type="button"
              className="adm-btn adm-btn--outline adm-btn--sm"
              onClick={resetFilters}
              disabled={!search && !status}
            >
              <span className="material-symbols-outlined" aria-hidden="true">
                filter_alt_off
              </span>
              Xoá lọc
            </button>
          </div>
        </div>
      </section>

      {/* ============ Bảng nhóm ============ */}
      <section className="adm-card">
        <header className="adm-card__head">
          <div>
            <span className="adm-eyebrow">DANH SÁCH</span>
            <h2 className="adm-card__title">Tất cả nhóm</h2>
          </div>
          <AdminPill tone="accent">{totalCount} nhóm</AdminPill>
        </header>

        {loading ? (
          <AdminLoading label="Đang tải danh sách nhóm…" />
        ) : error ? (
          <AdminErrorState message={error} onRetry={reload} />
        ) : items.length === 0 ? (
          <AdminEmptyState
            icon="groups"
            title="Không có nhóm nào"
            hint={
              search || status
                ? "Thử bỏ bộ lọc hoặc đổi từ khoá tìm kiếm."
                : "Chưa có nhóm nào trong hệ thống."
            }
          />
        ) : (
          <div className="adm-table-wrap">
            <table className="adm-table">
              <thead>
                <tr>
                  <th scope="col">Nhóm</th>
                  <th scope="col">Chủ nhóm</th>
                  <th scope="col" className="adm-table__num">
                    Thành viên
                  </th>
                  <th scope="col" className="adm-table__num">
                    Việc
                  </th>
                  <th scope="col">Trạng thái</th>
                  <th scope="col">Ngày tạo</th>
                  <th scope="col" className="adm-table__actions">
                    Thao tác
                  </th>
                </tr>
              </thead>
              <tbody>
                {items.map((g) => (
                  <tr key={g.id}>
                    <td>
                      <button
                        type="button"
                        className="adm-link-btn"
                        onClick={() => void openDetail(g.id)}
                      >
                        {g.name}
                      </button>
                    </td>
                    <td>
                      <span className="adm-table__strong">
                        {g.ownerName ?? "—"}
                      </span>
                      {g.ownerEmail ? (
                        <span className="adm-table__sub">{g.ownerEmail}</span>
                      ) : null}
                    </td>
                    <td className="adm-table__num adm-mono">{g.memberCount ?? 0}</td>
                    <td className="adm-table__num adm-mono">{g.taskCount ?? 0}</td>
                    <td>
                      <AdminPill tone={statusTone(g.status)}>{g.status}</AdminPill>
                    </td>
                    <td className="adm-table__num adm-mono">
                      {formatDateTime(g.createdAt)}
                    </td>
                    <td className="adm-table__actions">
                      <div className="adm-row-actions">
                        <button
                          type="button"
                          className="adm-btn adm-btn--outline adm-btn--sm"
                          onClick={() => void openDetail(g.id)}
                        >
                          <span className="material-symbols-outlined" aria-hidden="true">
                            visibility
                          </span>
                          Chi tiết
                        </button>
                        {g.status === "Archived" ? (
                          <button
                            type="button"
                            className="adm-btn adm-btn--outline adm-btn--sm"
                            onClick={() => {
                              setActionTarget({ group: g, mode: "restore" });
                              setActionReason("");
                            }}
                          >
                            <span className="material-symbols-outlined" aria-hidden="true">
                              unarchive
                            </span>
                            Khôi phục
                          </button>
                        ) : (
                          <button
                            type="button"
                            className="adm-btn adm-btn--outline adm-btn--sm"
                            onClick={() => {
                              setActionTarget({ group: g, mode: "archive" });
                              setActionReason("");
                            }}
                          >
                            <span className="material-symbols-outlined" aria-hidden="true">
                              archive
                            </span>
                            Lưu trữ
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <AdminPagination
          page={page}
          pageSize={PAGE_SIZE}
          totalCount={totalCount}
          onPageChange={setPage}
        />
      </section>

      {/* ============ Chi tiết nhóm ============ */}
      <AdminModal
        open={detailId !== null}
        title={detail?.name ?? "Chi tiết nhóm"}
        eyebrow="CHI TIẾT NHÓM"
        onClose={closeDetail}
        footer={
          <button
            type="button"
            className="adm-btn adm-btn--outline"
            onClick={closeDetail}
          >
            Đóng
          </button>
        }
      >
        {detailLoading ? (
          <AdminLoading label="Đang tải chi tiết nhóm…" />
        ) : detailError ? (
          <AdminErrorState message={detailError} onRetry={() => detailId && void openDetail(detailId)} />
        ) : detail ? (
          <>
            <div className="adm-section">
              <h3 className="adm-section__title">Thông tin</h3>
              <div className="adm-meta-list">
                <div className="adm-meta-row">
                  <span className="adm-meta-row__label">Trạng thái</span>
                  <span className="adm-meta-row__value">
                    <AdminPill tone={statusTone(detail.status)}>
                      {detail.status}
                    </AdminPill>
                  </span>
                </div>
                <div className="adm-meta-row">
                  <span className="adm-meta-row__label">Chủ nhóm</span>
                  <span className="adm-meta-row__value adm-mono">
                    {detail.ownerName ?? "—"}
                    {detail.ownerEmail ? ` · ${detail.ownerEmail}` : ""}
                  </span>
                </div>
                <div className="adm-meta-row">
                  <span className="adm-meta-row__label">Ngày tạo</span>
                  <span className="adm-meta-row__value adm-mono">
                    {formatDateTime(detail.createdAt)}
                  </span>
                </div>
                {detail.description ? (
                  <div className="adm-meta-row">
                    <span className="adm-meta-row__label">Mô tả</span>
                    <span className="adm-meta-row__value">
                      {detail.description}
                    </span>
                  </div>
                ) : null}
                {detail.progress ? (
                  <div className="adm-meta-row">
                    <span className="adm-meta-row__label">Tiến độ</span>
                    <span className="adm-meta-row__value adm-mono">
                      {detail.progress.completedTasks ?? 0}/
                      {detail.progress.totalTasks ?? 0} việc ·{" "}
                      {detail.progress.progressPercent ?? 0}%
                    </span>
                  </div>
                ) : null}
              </div>
            </div>

            <div className="adm-section">
              <h3 className="adm-section__title">
                Thành viên · {detail.members?.length ?? 0}
              </h3>
              {!detail.members || detail.members.length === 0 ? (
                <p className="adm-muted">Nhóm chưa có thành viên.</p>
              ) : (
                <div className="adm-table-wrap">
                  <table className="adm-table adm-table--compact">
                    <thead>
                      <tr>
                        <th scope="col">Thành viên</th>
                        <th scope="col">Vai trò</th>
                        <th scope="col">Tham gia</th>
                      </tr>
                    </thead>
                    <tbody>
                      {detail.members.map((m) => (
                        <tr key={m.userId}>
                          <td>
                            <span className="adm-table__strong">
                              {m.fullName ?? "—"}
                            </span>
                            {m.email ? (
                              <span className="adm-table__sub">{m.email}</span>
                            ) : null}
                          </td>
                          <td>
                            <AdminPill tone={memberRoleTone(m.role)}>
                              {m.role}
                            </AdminPill>
                          </td>
                          <td className="adm-table__num adm-mono">
                            {formatDateTime(m.joinedAt)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

            <div className="adm-section">
              <h3 className="adm-section__title">Nhật ký hoạt động</h3>
              {activityLoading ? (
                <AdminLoading label="Đang tải nhật ký…" />
              ) : activity.length === 0 ? (
                <p className="adm-muted">Chưa có hoạt động nào được ghi nhận.</p>
              ) : (
                <ul className="adm-activity-list">
                  {activity.map((a) => (
                    <li key={a.id} className="adm-activity-item">
                      <span className="adm-activity-dot" aria-hidden="true" />
                      <div className="adm-activity-body">
                        <span className="adm-activity-action">{a.action}</span>
                        <span className="adm-activity-meta">
                          {a.actorName ?? a.actorEmail ?? "Hệ thống"} ·{" "}
                          {formatDateTime(a.createdAt)}
                        </span>
                        {a.detail ? (
                          <span className="adm-activity-detail">{a.detail}</span>
                        ) : null}
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </>
        ) : null}
      </AdminModal>

      {/* ============ Archive / Restore (bắt buộc lý do) ============ */}
      <AdminConfirmDialog
        open={actionTarget !== null}
        eyebrow={
          actionTarget?.mode === "archive"
            ? "THAO TÁC KHÔNG THỂ HOÀN TÁC"
            : "KHÔI PHỤC NHÓM"
        }
        title={
          actionTarget?.mode === "archive" ? "Lưu trữ nhóm" : "Khôi phục nhóm"
        }
        danger={actionTarget?.mode === "archive"}
        busy={actionBusy}
        confirmLabel={
          actionTarget?.mode === "archive" ? "Lưu trữ" : "Khôi phục"
        }
        reasonRequired
        reason={actionReason}
        onReasonChange={setActionReason}
        message={
          <>
            <p>
              {actionTarget?.mode === "archive" ? (
                <>
                  Lưu trữ nhóm{" "}
                  <strong>{actionTarget?.group.name}</strong> sẽ ẩn nhóm khỏi
                  danh sách của các thành viên và gửi thông báo{" "}
                  <code>GroupStatusChanged</code> cho mọi Leader.
                </>
              ) : (
                <>
                  Khôi phục nhóm <strong>{actionTarget?.group.name}</strong> sẽ
                  đưa nhóm trở lại trạng thái hoạt động và gửi thông báo cho mọi
                  Leader.
                </>
              )}
            </p>
            <p className="adm-confirm__note">
              Admin không cần là thành viên, nhưng không xem được nội dung bình
              luận hay lịch cá nhân của nhóm.
            </p>
          </>
        }
        onClose={() => {
          setActionTarget(null);
          setActionReason("");
        }}
        onConfirm={() => void runAction()}
      />
    </div>
  );
}
