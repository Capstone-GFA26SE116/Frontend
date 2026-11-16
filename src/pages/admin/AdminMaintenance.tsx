import { useCallback, useState } from "react";
import { runStatusResync } from "../../lib/admin-api";
import type { StatusResyncReportDto } from "../../lib/admin-api";
import {
  AdminConfirmDialog,
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
 * Trang bảo trì dữ liệu — đồng bộ lại trạng thái dữ liệu cũ.
 *
 * API: POST /api/admin/status-resync?dryRun=true|false
 *  - `dryRun = true` (mặc định): chạy thử, không lưu, KHÔNG cần lý do.
 *  - `dryRun = false`: chạy thật → BẮT BUỘC lý do (header X-Admin-Reason),
 *    và ghi lại một dòng nhật ký `StatusResync.Run`.
 */

export function AdminMaintenance() {
  const [toast, setToast] = useState<AdminToastState>(EMPTY_TOAST);

  const [confirmOpen, setConfirmOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [running, setRunning] = useState(false);
  /** Report sau khi chạy THẬT (ghi đè kết quả dryRun của hook). */
  const [appliedReport, setAppliedReport] = useState<StatusResyncReportDto | null>(null);

  const closeToast = useCallback(() => setToast(EMPTY_TOAST), []);

  /**
   * Chạy thử (dryRun) — không cần lý do, không ghi thay đổi.
   * setState diễn ra sau `await` → không vi phạm `react-hooks/set-state-in-effect`.
   */
  const {
    data: dryRunReport,
    loading,
    error,
    reload,
  } = useAdminLoad(
    async () => {
      const res = await runStatusResync(true);
      return {
        ok: res.ok,
        error: res.error ?? "Không chạy được kiểm tra đồng bộ.",
        data: res.ok ? res.data : null,
      };
    },
    [],
  );

  const report = appliedReport ?? dryRunReport;

  /** Chạy thật — bắt buộc lý do. */
  async function handleRealRun() {
    if (!reason.trim()) return;

    setRunning(true);
    const res = await runStatusResync(false, reason.trim());
    setRunning(false);

    if (!res.ok) {
      setToast({
        visible: true,
        tone: "error",
        message: res.error ?? "Không chạy được đồng bộ.",
      });
      return;
    }

    setConfirmOpen(false);
    setReason("");
    setAppliedReport(res.data ?? null);
    setToast({
      visible: true,
      tone: "success",
      message: "Đã chạy đồng bộ và ghi nhật ký thao tác.",
    });
  }

  const changed = report ? report.tasksChanged + report.milestonesChanged + report.slotsCancelled : 0;

  return (
    <div className="adm-page">
      <div className="adm-page-head">
        <div>
          <span className="adm-eyebrow">BẢO TRÌ HỆ THỐNG</span>
          <h1 className="adm-page-title">Đồng bộ trạng thái dữ liệu</h1>
          <p className="adm-page-sub">
            Tính lại trạng thái của task, milestone và slot lịch cho các dữ liệu cũ.
            Luôn chạy thử trước khi áp dụng thật.
          </p>
        </div>
        <div className="adm-page-head__actions">
          <button
            type="button"
            className="adm-btn adm-btn--outline"
            onClick={() => {
              setAppliedReport(null);
              reload();
            }}
            disabled={loading || running}
          >
            <span className="material-symbols-outlined" aria-hidden="true">
              science
            </span>
            Chạy thử lại
          </button>
          <button
            type="button"
            className="adm-btn adm-btn--primary"
            onClick={() => {
              setReason("");
              setConfirmOpen(true);
            }}
            disabled={loading || running}
          >
            <span className="material-symbols-outlined" aria-hidden="true">
              play_arrow
            </span>
            Chạy thật
          </button>
        </div>
      </div>

      {/* ============ Cảnh báo ============ */}
      <section className="adm-callout adm-callout--warn">
        <span className="material-symbols-outlined adm-callout__icon" aria-hidden="true">
          warning
        </span>
        <div className="adm-callout__body">
          <strong>Thao tác này thay đổi dữ liệu trên toàn hệ thống.</strong>
          <p>
            Chạy thật sẽ ghi lại một dòng nhật ký <code>StatusResync.Run</code> kèm lý do
            của bạn. Hãy chạy thử trước để xem danh sách thay đổi dự kiến.
          </p>
        </div>
      </section>

      {/* ============ Kết quả ============ */}
      {loading ? (
        <AdminLoading label="Đang kiểm tra dữ liệu…" />
      ) : error ? (
        <AdminErrorState message={error} onRetry={reload} />
      ) : !report ? (
        <AdminEmptyState
          icon="build"
          title="Chưa có kết quả kiểm tra"
          hint="Bấm “Chạy thử lại” để tính lại trạng thái dữ liệu."
        />
      ) : (
        <>
          <section className="adm-kpi-grid adm-kpi-grid--4" aria-label="Kết quả kiểm tra">
            <article className="adm-kpi">
              <span className="adm-kpi__label">Task đã kiểm tra</span>
              <strong className="adm-kpi__value adm-mono">{report.tasksChecked}</strong>
              <span className="adm-kpi__foot">Tổng số task trong hệ thống</span>
            </article>
            <article className="adm-kpi">
              <span className="adm-kpi__label">Task sẽ đổi</span>
              <strong className="adm-kpi__value adm-mono">{report.tasksChanged}</strong>
              <span className="adm-kpi__foot">Trạng thái được tính lại</span>
            </article>
            <article className="adm-kpi">
              <span className="adm-kpi__label">Milestone sẽ đổi</span>
              <strong className="adm-kpi__value adm-mono">{report.milestonesChanged}</strong>
              <span className="adm-kpi__foot">Tiến độ roll-up</span>
            </article>
            <article className="adm-kpi adm-kpi--accent">
              <span className="adm-kpi__label">Slot sẽ huỷ</span>
              <strong className="adm-kpi__value adm-mono">{report.slotsCancelled}</strong>
              <span className="adm-kpi__foot">Lịch không còn hợp lệ</span>
            </article>
          </section>

          <section className="adm-card">
            <header className="adm-card__head">
              <div>
                <span className="adm-eyebrow">DANH SÁCH THAY ĐỔI</span>
                <h2 className="adm-card__title">
                  {report.dryRun ? "Kết quả chạy thử" : "Kết quả đã áp dụng"}
                </h2>
              </div>
              <div className="adm-card__head-actions">
                <AdminPill tone={report.dryRun ? "warn" : "success"}>
                  {report.dryRun ? "Chạy thử" : "Đã áp dụng"}
                </AdminPill>
                {report.truncated && <AdminPill tone="danger">Bị cắt bớt</AdminPill>}
              </div>
            </header>

            {report.changes.length === 0 ? (
              <AdminEmptyState
                icon="check_circle"
                title="Không có thay đổi nào cần thiết"
                hint="Dữ liệu hiện tại đã nhất quán với quy tắc trạng thái."
              />
            ) : (
              <>
                <p className="adm-hint adm-hint--block">
                  {changed} thay đổi dự kiến
                  {report.truncated && " (danh sách bị cắt bớt)"} — bấm “Chạy thật” ở trên
                  để áp dụng.
                </p>
                <div className="adm-table-wrap">
                  <table className="adm-table">
                    <thead>
                      <tr>
                        <th scope="col">Loại</th>
                        <th scope="col">Tên</th>
                        <th scope="col">Từ</th>
                        <th scope="col">Sang</th>
                      </tr>
                    </thead>
                    <tbody>
                      {report.changes.map((c, idx) => (
                        <tr key={`${c.id}-${idx}`}>
                          <td>
                            <AdminPill tone="neutral">{c.kind}</AdminPill>
                          </td>
                          <td className="adm-table__strong">{c.name}</td>
                          <td className="adm-mono">{c.from || "—"}</td>
                          <td className="adm-mono adm-table__strong">{c.to || "—"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            )}
          </section>
        </>
      )}

      {/* ============ Xác nhận chạy thật ============ */}
      <AdminConfirmDialog
        open={confirmOpen}
        eyebrow="KHÔNG THỂ HOÀN TÁC"
        title="Chạy đồng bộ thật"
        danger
        busy={running}
        confirmLabel="Chạy thật"
        reasonRequired
        reason={reason}
        onReasonChange={setReason}
        message={
          <>
            <p>
              Sẽ áp dụng{" "}
              <strong>
                {report
                  ? `${report.tasksChanged + report.milestonesChanged + report.slotsCancelled} thay đổi`
                  : "các thay đổi"}
              </strong>{" "}
              vào dữ liệu thật.
            </p>
            <p className="adm-confirm__note">
              Thao tác này được ghi vào nhật ký Admin với lý do bạn nhập bên dưới.
            </p>
          </>
        }
        onClose={() => setConfirmOpen(false)}
        onConfirm={() => void handleRealRun()}
      />

      <AdminToast toast={toast} onClose={closeToast} />
    </div>
  );
}
