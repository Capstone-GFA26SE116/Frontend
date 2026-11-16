import { useCallback, useMemo, useState } from "react";
import {
  createSubscriptionPlan,
  deleteSubscriptionPlan,
  listSubscriptionPlans,
  updateSubscriptionPlan,
} from "../../lib/admin-api";
import type {
  SubscriptionPlanDto,
  SubscriptionPlanRequestDto,
} from "../../lib/admin-api";
import {
  AdminConfirmDialog,
  AdminEmptyState,
  AdminErrorState,
  AdminLoading,
  AdminModal,
  AdminPill,
  AdminReasonField,
  AdminToast,
} from "./admin-shared";
import { EMPTY_TOAST } from "./admin-constants";
import type { AdminToastState } from "./admin-constants";
import { useAdminLoad } from "./useAdminLoad";
import "./admin.css";

/**
 * Trang quản lý gói đăng ký.
 *
 * API: GET/POST /api/subscription-plans, PUT/DELETE /api/subscription-plans/{id}
 *
 * Luật quan trọng (ADMIN_FE.md mục 2):
 *  - Sửa / tắt / xoá gói → BẮT BUỘC lý do (header X-Admin-Reason).
 *  - Gói Miễn phí: không tắt được, không đổi giá khác 0, không xoá được.
 *    Vẫn sửa được tên và hạn mức.
 *  - Gói đã có người dùng/giao dịch → không xoá được (400), hãy tắt.
 *  - Tạo gói: lý do tùy chọn.
 */

const VND = new Intl.NumberFormat("vi-VN");

/** Tên gói miễn phí — BE tự nhận diện, FE chỉ hiển thị cảnh báo. */
const FREE_PLAN_NAMES = ["miễn phí", "free", "mien phi"];

function isFreePlan(plan: Pick<SubscriptionPlanDto, "name">): boolean {
  const n = plan.name.trim().toLowerCase();
  return FREE_PLAN_NAMES.some((k) => n === k || n.startsWith(`${k} `));
}

function formatVnd(value: number): string {
  return `${VND.format(value)} đ`;
}

interface PlanFormState {
  name: string;
  price: string;
  durationDays: string;
  aiCallLimit: string;
  storageLimitMb: string;
  projectLimit: string;
  isActive: boolean;
}

const EMPTY_FORM: PlanFormState = {
  name: "",
  price: "",
  durationDays: "30",
  aiCallLimit: "",
  storageLimitMb: "",
  projectLimit: "",
  isActive: true,
};

function planToForm(plan: SubscriptionPlanDto): PlanFormState {
  return {
    name: plan.name,
    price: String(plan.price),
    durationDays: String(plan.durationDays),
    aiCallLimit: plan.aiCallLimit === null ? "" : String(plan.aiCallLimit),
    storageLimitMb:
      plan.storageLimitMb === null ? "" : String(plan.storageLimitMb),
    projectLimit: plan.projectLimit === null ? "" : String(plan.projectLimit),
    isActive: plan.isActive,
  };
}

function buildPayload(form: PlanFormState): SubscriptionPlanRequestDto | null {
  const price = Number(form.price);
  const durationDays = Number(form.durationDays);

  if (!form.name.trim()) return null;
  if (!Number.isFinite(price) || price < 0) return null;
  if (!Number.isFinite(durationDays) || durationDays <= 0) return null;

  const aiCallLimit = form.aiCallLimit.trim() === "" ? null : Number(form.aiCallLimit);
  const storageLimitMb =
    form.storageLimitMb.trim() === "" ? null : Number(form.storageLimitMb);
  const projectLimit =
    form.projectLimit.trim() === "" ? null : Number(form.projectLimit);

  if (aiCallLimit !== null && (!Number.isFinite(aiCallLimit) || aiCallLimit < 0)) {
    return null;
  }
  if (
    storageLimitMb !== null &&
    (!Number.isFinite(storageLimitMb) || storageLimitMb <= 0)
  ) {
    return null;
  }
  if (
    projectLimit !== null &&
    (!Number.isFinite(projectLimit) || projectLimit <= 0)
  ) {
    return null;
  }

  return {
    name: form.name.trim(),
    price,
    durationDays,
    aiCallLimit,
    storageLimitMb,
    projectLimit,
    isActive: form.isActive,
  };
}

export function AdminPlans() {
  const [toast, setToast] = useState<AdminToastState>(EMPTY_TOAST);

  // --- Form tạo/sửa ---
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<SubscriptionPlanDto | null>(null);
  const [form, setForm] = useState<PlanFormState>(EMPTY_FORM);
  const [formReason, setFormReason] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // --- Xoá ---
  const [deleteTarget, setDeleteTarget] = useState<SubscriptionPlanDto | null>(null);
  const [deleteReason, setDeleteReason] = useState("");
  const [deleteBusy, setDeleteBusy] = useState(false);

  const closeToast = useCallback(() => setToast(EMPTY_TOAST), []);

  const { data: plans, loading, error, reload } = useAdminLoad(
    async () => {
      const res = await listSubscriptionPlans();
      return {
        ok: res.ok,
        error: res.error ?? "Không tải được danh sách gói.",
        data: res.ok ? (res.data ?? []) : [],
      };
    },
    [],
  );

  const planList = useMemo(() => plans ?? [], [plans]);

  const stats = useMemo(() => {
    const active = planList.filter((p) => p.isActive);
    const free = planList.filter(isFreePlan);
    const avg = active.length
      ? Math.round(active.reduce((s, p) => s + p.price, 0) / active.length)
      : 0;
    return {
      active,
      inactive: planList.filter((p) => !p.isActive),
      free,
      avg,
    };
  }, [planList]);

  function openCreate() {
    setEditing(null);
    setForm(EMPTY_FORM);
    setFormReason("");
    setFormError(null);
    setFormOpen(true);
  }

  function openEdit(plan: SubscriptionPlanDto) {
    setEditing(plan);
    setForm(planToForm(plan));
    setFormReason("");
    setFormError(null);
    setFormOpen(true);
  }

  /** Gói miễn phí không được tắt / đổi giá khác 0. */
  function validateFreePlan(plan: Pick<SubscriptionPlanDto, "name">, next: SubscriptionPlanRequestDto) {
    if (!isFreePlan(plan)) return null;
    if (!next.isActive) {
      return "Gói Miễn phí không thể tắt. Hãy dùng gói khác cho người dùng mới.";
    }
    if (next.price !== 0) {
      return "Gói Miễn phí không thể đổi giá khác 0.";
    }
    return null;
  }

  async function handleSave() {
    if (!editing) return;

    const payload = buildPayload(form);
    if (!payload) {
      setFormError(
        "Kiểm tra lại: tên gói bắt buộc, giá không âm, thời hạn > 0, hạn mức > 0.",
      );
      return;
    }

    if (editing) {
      const freeError = validateFreePlan(editing, payload);
      if (freeError) {
        setFormError(freeError);
        return;
      }
      if (!formReason.trim()) {
        setFormError("Sửa gói bắt buộc phải có lý do (gửi kèm header X-Admin-Reason).");
        return;
      }
    }

    setSaving(true);
    setFormError(null);

    const res = editing
      ? await updateSubscriptionPlan(editing.id, payload, formReason.trim())
      : await createSubscriptionPlan(payload);
    setSaving(false);

    if (!res.ok) {
      setFormError(res.error ?? "Không lưu được gói.");
      return;
    }

    setFormOpen(false);
    setToast({
      visible: true,
      tone: "success",
      message: editing
        ? `Đã cập nhật gói ${payload.name}.`
        : `Đã tạo gói ${payload.name}.`,
    });
    reload();
  }

  async function handleDelete() {
    if (!deleteTarget) return;
    if (!deleteReason.trim()) return;

    setDeleteBusy(true);
    const res = await deleteSubscriptionPlan(deleteTarget.id, deleteReason.trim());
    setDeleteBusy(false);

    if (!res.ok) {
      setToast({
        visible: true,
        tone: "error",
        message:
          res.error ??
          "Không xoá được gói. Nếu gói đã có người dùng hoặc giao dịch, hãy tắt gói thay vì xoá.",
      });
      return;
    }

    setDeleteTarget(null);
    setDeleteReason("");
    setToast({
      visible: true,
      tone: "success",
      message: `Đã xoá gói ${deleteTarget.name}.`,
    });
    reload();
  }

  /** Tắt/mở gói nhanh — vẫn là thao tác ghi nên cần lý do. */
  async function handleToggleActive(plan: SubscriptionPlanDto, reason: string) {
    const payload: SubscriptionPlanRequestDto = {
      name: plan.name,
      price: plan.price,
      durationDays: plan.durationDays,
      aiCallLimit: plan.aiCallLimit,
      storageLimitMb: plan.storageLimitMb,
      projectLimit: plan.projectLimit,
      isActive: !plan.isActive,
    };

    const freeError = validateFreePlan(plan, payload);
    if (freeError) {
      setToast({ visible: true, tone: "error", message: freeError });
      return;
    }

    const res = await updateSubscriptionPlan(plan.id, payload, reason);
    if (!res.ok) {
      setToast({
        visible: true,
        tone: "error",
        message: res.error ?? "Không cập nhật được trạng thái gói.",
      });
      return;
    }

    setToast({
      visible: true,
      tone: "success",
      message: plan.isActive
        ? `Đã tắt gói ${plan.name}.`
        : `Đã mở bán gói ${plan.name}.`,
    });
    reload();
  }

  return (
    <div className="adm-page">
      <div className="adm-page-head">
        <div>
          <span className="adm-eyebrow">DANH MỤC SẢN PHẨM</span>
          <h1 className="adm-page-title">Gói đăng ký</h1>
          <p className="adm-page-sub">
            Admin thấy toàn bộ gói, kể cả gói đã tắt. Thay đổi hạn mức có hiệu lực
            ngay với mọi người đang dùng gói đó.
          </p>
        </div>
        <div className="adm-page-head__actions">
          <button type="button" className="adm-btn adm-btn--primary" onClick={openCreate}>
            <span className="material-symbols-outlined" aria-hidden="true">
              add
            </span>
            Tạo gói
          </button>
        </div>
      </div>

      <section className="adm-kpi-grid adm-kpi-grid--4" aria-label="Tổng quan gói">
        <article className="adm-kpi adm-kpi--accent">
          <span className="adm-kpi__label">Gói đang bán</span>
          <strong className="adm-kpi__value adm-mono">{stats.active.length}</strong>
          <span className="adm-kpi__foot">Hiển thị cho người dùng</span>
        </article>
        <article className="adm-kpi">
          <span className="adm-kpi__label">Gói đã tắt</span>
          <strong className="adm-kpi__value adm-mono">{stats.inactive.length}</strong>
          <span className="adm-kpi__foot">Chỉ Admin nhìn thấy</span>
        </article>
        <article className="adm-kpi">
          <span className="adm-kpi__label">Giá trung bình</span>
          <strong className="adm-kpi__value adm-mono adm-kpi__value--sm">
            {formatVnd(stats.avg)}
          </strong>
          <span className="adm-kpi__foot">Của các gói đang bán</span>
        </article>
        <article className="adm-kpi">
          <span className="adm-kpi__label">Gói Miễn phí</span>
          <strong className="adm-kpi__value adm-mono">{stats.free.length}</strong>
          <span className="adm-kpi__foot">Không tắt / không đổi giá</span>
        </article>
      </section>

      <section className="adm-card">
        <header className="adm-card__head">
          <div>
            <span className="adm-eyebrow">TẤT CẢ GÓI</span>
            <h2 className="adm-card__title">
              {loading ? "Đang tải…" : `${planList.length} gói`}
            </h2>
          </div>
        </header>

        {loading ? (
          <AdminLoading label="Đang tải gói đăng ký…" />
        ) : error ? (
          <AdminErrorState message={error} onRetry={reload} />
        ) : planList.length === 0 ? (
          <AdminEmptyState
            icon="workspace_premium"
            title="Chưa có gói đăng ký nào"
            hint="Tạo gói đầu tiên để người dùng có thể nâng cấp."
            action={
              <button type="button" className="adm-btn adm-btn--primary" onClick={openCreate}>
                Tạo gói
              </button>
            }
          />
        ) : (
          <div className="adm-plan-grid">
            {planList.map((plan) => {
              const free = isFreePlan(plan);
              return (
                <article
                  key={plan.id}
                  className={`adm-plan${plan.isActive ? "" : " adm-plan--off"}`}
                >
                  <header className="adm-plan__head">
                    <div>
                      <h3 className="adm-plan__name">{plan.name}</h3>
                      <span className="adm-plan__price adm-mono">
                        {formatVnd(plan.price)}
                        <span className="adm-plan__duration"> / {plan.durationDays} ngày</span>
                      </span>
                    </div>
                    <AdminPill tone={plan.isActive ? "success" : "neutral"}>
                      {plan.isActive ? "Đang bán" : "Đã tắt"}
                    </AdminPill>
                  </header>

                  <ul className="adm-plan__limits">
                    <li>
                      <span className="material-symbols-outlined" aria-hidden="true">
                        folder_open
                      </span>
                      Dự án:{" "}
                      <strong className="adm-mono">{plan.projectLimit ?? "∞"}</strong>
                    </li>
                    <li>
                      <span className="material-symbols-outlined" aria-hidden="true">
                        neurology
                      </span>
                      Lượt AI:{" "}
                      <strong className="adm-mono">{plan.aiCallLimit ?? "∞"}</strong>
                    </li>
                    <li>
                      <span className="material-symbols-outlined" aria-hidden="true">
                        database
                      </span>
                      Dung lượng:{" "}
                      <strong className="adm-mono">
                        {plan.storageLimitMb === null
                          ? "∞"
                          : `${VND.format(plan.storageLimitMb)} MB`}
                      </strong>
                    </li>
                  </ul>

                  {free && (
                    <p className="adm-plan__note">
                      Gói mặc định cho người đăng ký mới và người dùng gói trả phí hết
                      hạn. Không thể tắt, đổi giá hoặc xoá.
                    </p>
                  )}

                  <footer className="adm-plan__actions">
                    <button
                      type="button"
                      className="adm-btn adm-btn--outline adm-btn--sm"
                      onClick={() => openEdit(plan)}
                    >
                      <span className="material-symbols-outlined" aria-hidden="true">
                        edit
                      </span>
                      Sửa
                    </button>
                    <button
                      type="button"
                      className="adm-btn adm-btn--outline adm-btn--sm"
                      onClick={() => {
                        const reason = window.prompt(
                          `Lý do ${plan.isActive ? "tắt" : "mở bán"} gói "${plan.name}" (bắt buộc):`,
                        );
                        if (reason && reason.trim()) {
                          void handleToggleActive(plan, reason.trim());
                        }
                      }}
                      disabled={free}
                      title={free ? "Gói Miễn phí không thể tắt" : undefined}
                    >
                      <span className="material-symbols-outlined" aria-hidden="true">
                        {plan.isActive ? "toggle_off" : "toggle_on"}
                      </span>
                      {plan.isActive ? "Tắt" : "Mở bán"}
                    </button>
                    <button
                      type="button"
                      className="adm-btn adm-btn--danger-ghost adm-btn--sm"
                      onClick={() => {
                        setDeleteTarget(plan);
                        setDeleteReason("");
                      }}
                      disabled={free}
                      title={free ? "Gói Miễn phí không thể xoá" : undefined}
                    >
                      <span className="material-symbols-outlined" aria-hidden="true">
                        delete
                      </span>
                      Xoá
                    </button>
                  </footer>
                </article>
              );
            })}
          </div>
        )}
      </section>

      {/* ============ Form tạo/sửa ============ */}
      <AdminModal
        open={formOpen}
        wide
        eyebrow={editing ? "CẬP NHẬT GÓI" : "TẠO GÓI MỚI"}
        title={editing ? `Sửa gói ${editing.name}` : "Tạo gói đăng ký"}
        onClose={saving ? () => undefined : () => setFormOpen(false)}
        footer={
          <>
            <button
              type="button"
              className="adm-btn adm-btn--outline"
              onClick={() => setFormOpen(false)}
              disabled={saving}
            >
              Huỷ
            </button>
            <button
              type="button"
              className="adm-btn adm-btn--primary"
              onClick={() => void handleSave()}
              disabled={saving}
            >
              {saving && (
                <span className="material-symbols-outlined adm-spin" aria-hidden="true">
                  progress_activity
                </span>
              )}
              {editing ? "Lưu thay đổi" : "Tạo gói"}
            </button>
          </>
        }
      >
        <div className="adm-form adm-form--grid">
          <div className="adm-field">
            <label className="adm-label" htmlFor="adm-plan-name">
              Tên gói <span className="adm-req">*bắt buộc*</span>
            </label>
            <input
              id="adm-plan-name"
              type="text"
              className="adm-input"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              maxLength={50}
              placeholder="Gói Pro"
            />
            <span className="adm-field__hint">Tối đa 50 ký tự, không phân biệt hoa thường.</span>
          </div>

          <div className="adm-field">
            <label className="adm-label" htmlFor="adm-plan-price">
              Giá (đồng) <span className="adm-req">*bắt buộc*</span>
            </label>
            <input
              id="adm-plan-price"
              type="number"
              min={0}
              step={1000}
              className="adm-input adm-mono"
              value={form.price}
              onChange={(e) => setForm({ ...form, price: e.target.value })}
              placeholder="199000"
            />
          </div>

          <div className="adm-field">
            <label className="adm-label" htmlFor="adm-plan-duration">
              Thời hạn (ngày) <span className="adm-req">*bắt buộc*</span>
            </label>
            <input
              id="adm-plan-duration"
              type="number"
              min={1}
              className="adm-input adm-mono"
              value={form.durationDays}
              onChange={(e) => setForm({ ...form, durationDays: e.target.value })}
            />
          </div>

          <div className="adm-field">
            <label className="adm-label" htmlFor="adm-plan-ai">
              Hạn mức lượt AI
            </label>
            <input
              id="adm-plan-ai"
              type="number"
              min={0}
              className="adm-input adm-mono"
              value={form.aiCallLimit}
              onChange={(e) => setForm({ ...form, aiCallLimit: e.target.value })}
              placeholder="Để trống = không giới hạn"
            />
          </div>

          <div className="adm-field">
            <label className="adm-label" htmlFor="adm-plan-storage">
              Dung lượng (MB)
            </label>
            <input
              id="adm-plan-storage"
              type="number"
              min={1}
              className="adm-input adm-mono"
              value={form.storageLimitMb}
              onChange={(e) => setForm({ ...form, storageLimitMb: e.target.value })}
              placeholder="Để trống = không giới hạn"
            />
          </div>

          <div className="adm-field">
            <label className="adm-label" htmlFor="adm-plan-projects">
              Số dự án tối đa
            </label>
            <input
              id="adm-plan-projects"
              type="number"
              min={1}
              className="adm-input adm-mono"
              value={form.projectLimit}
              onChange={(e) => setForm({ ...form, projectLimit: e.target.value })}
              placeholder="Để trống = không giới hạn"
            />
          </div>

          <label className="adm-check adm-field--full">
            <input
              type="checkbox"
              checked={form.isActive}
              onChange={(e) => setForm({ ...form, isActive: e.target.checked })}
            />
            <span>Gói đang bán (hiển thị cho người dùng)</span>
          </label>

          {editing && (
            <div className="adm-field--full">
              <AdminReasonField
                value={formReason}
                onChange={setFormReason}
                id="adm-plan-reason"
                placeholder="Ví dụ: Cập nhật giá gói Pro theo bảng giá mới"
              />
            </div>
          )}

          {formError && (
            <p className="adm-inline-error adm-field--full" role="alert">
              <span className="material-symbols-outlined" aria-hidden="true">error</span>
              {formError}
            </p>
          )}
        </div>
      </AdminModal>

      {/* ============ Xoá gói ============ */}
      <AdminConfirmDialog
        open={deleteTarget !== null}
        eyebrow="HÀNH ĐỘNG KHÔNG THỂ HOÀN TÁC"
        title="Xoá gói đăng ký"
        danger
        busy={deleteBusy}
        confirmLabel="Xoá gói"
        reasonRequired
        reason={deleteReason}
        onReasonChange={setDeleteReason}
        message={
          <>
            <p>
              Xoá gói <strong>{deleteTarget?.name}</strong>?
            </p>
            <p className="adm-confirm__note">
              Nếu gói đã có người dùng hoặc giao dịch, BE sẽ từ chối (400). Hãy tắt
              gói (<code>isActive = false</code>) thay vì xoá.
            </p>
          </>
        }
        onClose={() => {
          setDeleteTarget(null);
          setDeleteReason("");
        }}
        onConfirm={() => void handleDelete()}
      />

      <AdminToast toast={toast} onClose={closeToast} />
    </div>
  );
}
