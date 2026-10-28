import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useAuth } from "../../auth/AuthContext";
import { useStaggeredMount } from "../../hooks/useStaggeredMount";
import {
  getMe,
  listInvoices,
  listSubscriptionPlans,
  listUserSubscriptions,
  updateProfile,
  type InvoiceDto,
  type MeResponse,
  type UserSubscriptionDto,
} from "../../lib/api-client";
import "./profile.css";

/* ===========================================================
 * Hồ sơ người dùng  (/profile)
 * Nguồn dữ liệu: GET /api/me  (BE trả profile + cấu hình lịch + gói).
 *
 * Giao diện theo DESIGN.md (Voltagent):
 *   - canvas #101010, canvas-soft #1a1a1a, hairline #3d3a39
 *   - electric-green #00d992 làm accent duy nhất
 *   - Inter cho chữ, SF Mono (JetBrains Mono) cho số / mã / thời gian
 *   - KHÔNG dùng box-shadow để tạo chiều sâu cho card — elevation = hairline.
 *     (Chỉ hover mới dùng inset glow rất nhẹ theo Level 2 của DESIGN.md.)
 * =========================================================== */

/* ---------- Helpers định dạng ---------- */

/** Chuẩn hoá chuỗi "HH:mm" để hiển thị đồng nhất. */
function fmtClock(v: string | null | undefined): string {
  if (!v) return "—";
  const s = v.trim();
  // BE có thể trả "08:00", "08:00:00" hoặc ISO.
  const m = s.match(/^(\d{1,2}):(\d{2})/);
  if (m) return `${m[1].padStart(2, "0")}:${m[2]}`;
  const d = new Date(s);
  if (!Number.isNaN(d.getTime())) {
    return d.toLocaleTimeString(undefined, {
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
  }
  return s;
}

/** Định dạng ngày kiểu "27 Oct 2026". */
function fmtDate(v: string | null | undefined): string {
  if (!v) return "—";
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return v;
  return d.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

/** Số phút -> "45m" / "2h 30m". */
function fmtMinutes(v: number | null | undefined): string {
  if (v == null || Number.isNaN(v)) return "—";
  if (v < 60) return `${v}m`;
  const h = Math.floor(v / 60);
  const m = v % 60;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

/** "08:30" -> số phút kể từ nửa đêm (để vẽ thanh timeline). */
function clockToMinutes(v: string | null | undefined): number | null {
  if (!v) return null;
  const m = v.trim().match(/^(\d{1,2}):(\d{2})/);
  if (m) return Number(m[1]) * 60 + Number(m[2]);
  const d = new Date(v);
  if (!Number.isNaN(d.getTime())) return d.getHours() * 60 + d.getMinutes();
  return null;
}

/** Trạng thái Google Calendar -> nhãn + tone hiển thị. */
function calendarBadge(status: string | null | undefined): {
  label: string;
  tone: "on" | "off";
} {
  const s = (status ?? "").toLowerCase().replace(/[_-]+/g, " ").trim();
  if (!s) return { label: "Not connected", tone: "off" };
  if (s === "connected" || s === "active" || s === "linked") {
    return { label: "Connected", tone: "on" };
  }
  if (s === "expired" || s === "revoked" || s === "error") {
    return { label: "Needs attention", tone: "off" };
  }
  if (s === "not connected" || s === "disconnected") {
    return { label: "Not connected", tone: "off" };
  }
  return { label: s.charAt(0).toUpperCase() + s.slice(1), tone: "off" };
}

/** Các ngày trong tuần — dùng cho visualizer "days". */
const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

export function ProfilePage() {
  const { user } = useAuth();
  const [me, setMe] = useState<MeResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  /* ---- Chế độ sửa tên (PUT /api/me/profile) ---- */
  const [editing, setEditing] = useState(false);
  const [nameDraft, setNameDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const nameInputRef = useRef<HTMLInputElement | null>(null);

  /** Nạp lại hồ sơ — dùng cho nút "Retry" khi lần đầu load lỗi. */
  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    const res = await getMe();
    if (res.ok) {
      setMe(res.data);
    } else {
      setError(res.error ?? "Failed to load profile");
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      setLoading(true);
      setError(null);
      const res = await getMe();
      if (cancelled) return;
      if (res.ok) {
        setMe(res.data);
      } else {
        setError(res.error ?? "Failed to load profile");
      }
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  /* Tên hiển thị: ưu tiên dữ liệu từ API, fallback về user trong context. */
  const displayName = me?.fullName || user?.name || "Chưa cập nhật";
  const displayEmail = me?.email || user?.email || "—";
  const initial = (displayName || "?").trim().charAt(0).toUpperCase();

  /* Gói thuê bao: BE deploy mới trả `currentSubscription`, cũ trả `currentPlanName`. */
  const planName = useMemo(() => {
    const raw =
      me?.currentSubscription?.planName || me?.currentPlanName || null;
    if (!raw) return null;
    // BE có thể trả tên tiếng Việt ("Gói Pro") hoặc mã kỹ thuật ("pro") —
    // map mã kỹ thuật sang tên hiển thị, còn lại giữ nguyên tên BE trả về.
    const key = raw.trim().toLowerCase();
    const known: Record<string, string> = {
      starter: "Free plan",
      free: "Free plan",
      "gói miễn phí": "Free plan",
      pro: "Professional",
      professional: "Professional",
      "gói pro": "Professional",
      team: "Team",
      "gói nhóm": "Team",
    };
    return known[key] ?? raw;
  }, [me]);

  const planEndAt = me?.currentSubscription?.endAt ?? null;

  /** Gói Free -> CTA "Upgrade"; gói trả phí -> CTA "Manage plan". */
  const isFreePlan = useMemo(() => {
    const raw =
      me?.currentSubscription?.planName || me?.currentPlanName || "";
    const key = raw.trim().toLowerCase();
    return (
      key === "" ||
      key === "starter" ||
      key === "free" ||
      key === "gói miễn phí"
    );
  }, [me]);

  /* Gói đang chờ (Scheduled) + hoá đơn + lịch sử giao dịch. */
  const [scheduled, setScheduled] = useState<UserSubscriptionDto[]>([]);
  const [invoices, setInvoices] = useState<InvoiceDto[]>([]);
  /** Tên gói theo planId — để hiện tên thay vì GUID thô. */
  const [planNames, setPlanNames] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!me) return;
    let cancelled = false;
    void (async () => {
      const [subRes, invRes, plansRes] = await Promise.all([
        listUserSubscriptions(),
        listInvoices(),
        listSubscriptionPlans(),
      ]);
      if (cancelled) return;
      if (subRes.ok) {
        setScheduled(
          subRes.data.filter(
            (s) => (s.status ?? "").toLowerCase() === "scheduled",
          ),
        );
      }
      if (invRes.ok) setInvoices(invRes.data);
      if (plansRes.ok) {
        const map: Record<string, string> = {};
        for (const p of plansRes.data) {
          if (p.id && p.name) map[p.id] = p.name;
        }
        setPlanNames(map);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [me]);

  const gcal = useMemo(() => calendarBadge(me?.googleCalendarStatus), [me]);

  /* Work hours: nếu user làm cuối tuần thì hiện thêm block cuối tuần. */
  const workDays = useMemo(() => {
    if (!me) return null;
    const base = "Mon – Fri";
    return me.worksOnWeekend ? `${base} + Sat – Sun` : base;
  }, [me]);

  /* Timeline ngày làm việc — vẽ thanh 06:00 → 22:00. */
  const timeline = useMemo(() => {
    const T0 = 6 * 60;
    const T1 = 22 * 60;
    const span = T1 - T0;
    const start = clockToMinutes(me?.workDayStart);
    const end = clockToMinutes(me?.workDayEnd);
    if (start == null || end == null || end <= start) return null;
    return {
      left: ((start - T0) / span) * 100,
      width: ((end - start) / span) * 100,
      totalHours: (end - start) / 60,
    };
  }, [me]);

  /* Ngày trong tuần được bật — dùng để tô xanh các chip ngày. */
  const activeDays = useMemo(() => {
    const set = new Set<number>([0, 1, 2, 3, 4]);
    if (me?.worksOnWeekend) {
      set.add(5);
      set.add(6);
    }
    return set;
  }, [me]);

  const { mounted, bumpKey } = useStaggeredMount(70, 60, me?.id);

  /** Delay dồn cho từng card (animation chạy dần theo thứ tự). */
  const cardDelay = (i: number) => ({ animationDelay: `${i * 70}ms` });

  /* ---------- Sửa tên ---------- */

  /** Mở form sửa — điền sẵn tên hiện tại và focus input. */
  const startEdit = useCallback(() => {
    setNameDraft(displayName);
    setSaveError(null);
    setEditing(true);
    // Đợi input mount xong rồi focus + chọn hết chữ.
    window.setTimeout(() => {
      nameInputRef.current?.focus();
      nameInputRef.current?.select();
    }, 30);
  }, [displayName]);

  /** Đóng form, xoá nháp + lỗi. */
  const cancelEdit = useCallback(() => {
    setEditing(false);
    setNameDraft("");
    setSaveError(null);
  }, []);

  /** Lưu tên qua PUT /api/me/profile. */
  const saveName = useCallback(async () => {
    const next = nameDraft.trim();
    if (!next) {
      setSaveError("Tên hiển thị không được để trống.");
      return;
    }
    if (next === (me?.fullName ?? "").trim()) {
      cancelEdit();
      return;
    }

    setSaving(true);
    setSaveError(null);
    const res = await updateProfile({ fullName: next });
    setSaving(false);

    if (!res.ok) {
      setSaveError(res.error ?? "Không lưu được tên. Vui lòng thử lại.");
      return;
    }
    setMe(res.data);
    setEditing(false);
    setNameDraft("");
  }, [nameDraft, me, cancelEdit]);

  return (
    <section className="prof">
      <div className="prof-ambient" aria-hidden="true" />
      <div className="prof-grid-bg" aria-hidden="true" />

      <div className="prof-container">
        {/* ============ Header — "Account" phóng to, căn trái ============ */}
        <header className="prof-header">
          <span className="prof-eyebrow">
            <span className="prof-eyebrow-dot" aria-hidden="true" />
            Account
          </span>
        </header>

        {loading && (
          <div className="prof-state" role="status">
            <span className="material-symbols-outlined prof-state__icon prof-spin">
              progress_activity
            </span>
            <span>Loading your profile…</span>
          </div>
        )}

        {!loading && error && (
          <div className="prof-state prof-state--error" role="alert">
            <span className="material-symbols-outlined prof-state__icon">
              error
            </span>
            <span>{error}</span>
            <button
              type="button"
              className="prof-btn prof-btn--soft"
              onClick={() => void reload()}
            >
              <span className="material-symbols-outlined prof-icon-18">
                refresh
              </span>
              Retry
            </button>
          </div>
        )}

        {!loading && !error && (
          <div className="prof-grid" key={bumpKey}>
            {/* ============ Identity — hero panel ============ */}
            <article
              className={`prof-card prof-card--identity prof-anim${
                mounted ? " is-in" : ""
              }`}
              style={cardDelay(0)}
            >
              <div className="prof-identity">
                <div className="prof-avatar" aria-hidden="true">
                  <span className="prof-avatar__ring" />
                  <span className="prof-avatar__letter">{initial}</span>
                </div>
                <div className="prof-identity__body">
                  <div className="prof-identity__tags">
                    {me?.role && (
                      <span className="prof-tag prof-tag--primary">
                        {me.role}
                      </span>
                    )}
                    <span
                      className={
                        "prof-tag" +
                        (me?.onboardingCompleted ? " prof-tag--primary" : "")
                      }
                    >
                      {me?.onboardingCompleted ? "Onboarded" : "Onboarding"}
                    </span>
                  </div>

                  {/* Tên hiển thị — đổi inline qua PUT /api/me/profile */}
                  {editing ? (
                    <div className="prof-name-edit">
                      <input
                        ref={nameInputRef}
                        className="prof-name-input"
                        value={nameDraft}
                        onChange={(e) => setNameDraft(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") {
                            e.preventDefault();
                            void saveName();
                          }
                          if (e.key === "Escape") {
                            e.preventDefault();
                            cancelEdit();
                          }
                        }}
                        maxLength={100}
                        disabled={saving}
                        placeholder="Your display name"
                        aria-label="Display name"
                        aria-invalid={saveError ? true : undefined}
                      />
                      <div className="prof-name-actions">
                        <button
                          type="button"
                          className="prof-btn prof-btn--primary prof-btn--sm"
                          onClick={() => void saveName()}
                          disabled={saving}
                        >
                          {saving ? (
                            <>
                              <span className="material-symbols-outlined prof-icon-16 prof-spin">
                                progress_activity
                              </span>
                              Saving
                            </>
                          ) : (
                            <>
                              <span className="material-symbols-outlined prof-icon-16">
                                check
                              </span>
                              Save
                            </>
                          )}
                        </button>
                        <button
                          type="button"
                          className="prof-btn prof-btn--soft prof-btn--sm"
                          onClick={cancelEdit}
                          disabled={saving}
                        >
                          Cancel
                        </button>
                        <span className="prof-name-count">
                          {nameDraft.trim().length}/100
                        </span>
                      </div>
                      {saveError && (
                        <span className="prof-name-error" role="alert">
                          <span className="material-symbols-outlined prof-icon-14">
                            error
                          </span>
                          {saveError}
                        </span>
                      )}
                    </div>
                  ) : (
                    <div className="prof-name-row">
                      <h2 className="prof-identity__name">{displayName}</h2>
                      <button
                        type="button"
                        className="prof-edit-btn"
                        onClick={startEdit}
                        title="Edit display name"
                        aria-label="Edit display name"
                      >
                        <span className="material-symbols-outlined prof-icon-16">
                          edit
                        </span>
                      </button>
                    </div>
                  )}

                  <span className="prof-identity__email">{displayEmail}</span>
                </div>
              </div>

              <dl className="prof-fields">
                <div className="prof-field">
                  <dt>User ID</dt>
                  <dd className="prof-mono">{me?.id ?? "—"}</dd>
                </div>
                <div className="prof-field">
                  <dt>Time zone</dt>
                  <dd className="prof-mono">{me?.timeZone ?? "—"}</dd>
                </div>
                <div className="prof-field">
                  <dt>Account</dt>
                  <dd className="prof-mono">{me?.id?.slice(0, 8) ?? "—"}</dd>
                </div>
              </dl>
            </article>

            {/* ============ Work rhythm ============ */}
            <article
              className={`prof-card prof-anim${mounted ? " is-in" : ""}`}
              style={cardDelay(1)}
            >
              <div className="prof-card__head">
                <span className="prof-card__eyebrow">Schedule defaults</span>
                <span className="material-symbols-outlined prof-card__icon">
                  schedule
                </span>
              </div>
              <h3 className="prof-card__title">Working rhythm</h3>

              {/* Timeline ngày làm việc */}
              {timeline && (
                <div className="prof-timeline">
                  <div className="prof-timeline__track">
                    <div
                      className="prof-timeline__fill"
                      style={{
                        left: `${timeline.left}%`,
                        width: `${timeline.width}%`,
                      }}
                    />
                  </div>
                  <div className="prof-timeline__axis">
                    <span>06:00</span>
                    <span>12:00</span>
                    <span>18:00</span>
                    <span>22:00</span>
                  </div>
                </div>
              )}

              {/* Chips ngày trong tuần */}
              <div className="prof-days" role="list" aria-label="Working days">
                {WEEKDAYS.map((d, i) => (
                  <span
                    key={d}
                    role="listitem"
                    className={
                      "prof-day" + (activeDays.has(i) ? " prof-day--on" : "")
                    }
                    style={{ animationDelay: `${i * 45}ms` }}
                  >
                    {d.slice(0, 1)}
                  </span>
                ))}
              </div>

              <dl className="prof-hours">
                <div className="prof-hours__slot">
                  <dt className="prof-hours__label">Work day</dt>
                  <dd className="prof-hours__value prof-mono">
                    {fmtClock(me?.workDayStart)} → {fmtClock(me?.workDayEnd)}
                  </dd>
                </div>
                <div className="prof-hours__slot">
                  <dt className="prof-hours__label">Days</dt>
                  <dd className="prof-hours__value">{workDays ?? "—"}</dd>
                </div>
                <div className="prof-hours__slot">
                  <dt className="prof-hours__label">Default buffer</dt>
                  <dd className="prof-hours__value prof-mono">
                    {fmtMinutes(me?.defaultBufferMinutes)}
                  </dd>
                </div>
                <div className="prof-hours__slot">
                  <dt className="prof-hours__label">Reminder lead</dt>
                  <dd className="prof-hours__value prof-mono">
                    {fmtMinutes(me?.reminderLeadMinutes)}
                  </dd>
                </div>
              </dl>
            </article>

            {/* ============ Subscription ============ */}
            <article
              className={`prof-card prof-anim${mounted ? " is-in" : ""}`}
              style={cardDelay(2)}
            >
              <div className="prof-card__head">
                <span className="prof-card__eyebrow">Subscription</span>
                <span className="material-symbols-outlined prof-card__icon">
                  workspace_premium
                </span>
              </div>

              <div className="prof-plan">
                <div className="prof-plan__badge">
                  <span className="material-symbols-outlined prof-icon-20">
                    {isFreePlan ? "bolt" : "workspace_premium"}
                  </span>
                </div>
                <div className="prof-plan__body">
                  <h3 className="prof-card__title">
                    {planName ?? "Free plan"}
                  </h3>
                  <p className="prof-card__hint">
                    {isFreePlan
                      ? "Upgrade to unlock deeper planning and unlimited AI blocks."
                      : `Your workspace runs on the ${planName} plan.`}
                  </p>
                </div>
              </div>

              {me?.currentSubscription && (
                <dl className="prof-fields prof-fields--2">
                  <div className="prof-field">
                    <dt>Plan ID</dt>
                    <dd className="prof-mono">
                      {me.currentSubscription.planId}
                    </dd>
                  </div>
                  <div className="prof-field">
                    <dt>Renews on</dt>
                    <dd className="prof-mono">{fmtDate(planEndAt)}</dd>
                  </div>
                </dl>
              )}

              {/* Gói đang chờ (Scheduled) — khi mua gói mới trong khi gói cũ còn hạn */}
              {scheduled.length > 0 && (
                <div className="prof-scheduled">
                  <span className="prof-scheduled__label">
                    Gói đang chờ kích hoạt
                  </span>
                  {scheduled.map((s) => (
                    <div key={s.id} className="prof-scheduled__item">
                      <span className="material-symbols-outlined prof-icon-16">
                        event_repeat
                      </span>
                      <span className="prof-scheduled__name">
                        {planNames[s.planId] ?? "Gói sắp tới"}
                      </span>
                      <span className="prof-mono prof-scheduled__date">
                        {s.endAt ? fmtDate(s.endAt) : "—"}
                      </span>
                    </div>
                  ))}
                  <p className="prof-scheduled__hint">
                    Gói mới sẽ tự chạy sau khi gói hiện tại hết hạn — không mất
                    ngày đã trả.
                  </p>
                </div>
              )}

              <Link
                to="/pricing"
                className={`prof-btn prof-btn--primary${
                  isFreePlan ? " prof-btn--full" : ""
                }`}
              >
                <span className="material-symbols-outlined prof-icon-18">
                  {isFreePlan ? "bolt" : "workspace_premium"}
                </span>
                {isFreePlan ? "Upgrade plan" : "Manage plan"}
              </Link>

              {/* Hoá đơn gần nhất */}
              {invoices.length > 0 && (
                <div className="prof-invoices">
                  <span className="prof-scheduled__label">Hoá đơn gần đây</span>
                  {invoices.slice(0, 3).map((inv) => (
                    <div key={inv.id} className="prof-invoice">
                      <span className="prof-mono prof-invoice__no">
                        {inv.invoiceNumber ?? "—"}
                      </span>
                      <span className="prof-invoice__plan">
                        {inv.planName ?? "—"}
                      </span>
                      <span className="prof-mono prof-invoice__amount">
                        {inv.amount.toLocaleString("vi-VN")}đ
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </article>

            {/* ============ Integrations ============ */}
            <article
              className={`prof-card prof-anim${mounted ? " is-in" : ""}`}
              style={cardDelay(3)}
            >
              <div className="prof-card__head">
                <span className="prof-card__eyebrow">Integrations</span>
                <span className="material-symbols-outlined prof-card__icon">
                  hub
                </span>
              </div>
              <h3 className="prof-card__title">Google Calendar</h3>

              <div className="prof-integration">
                <span
                  className="prof-integration__dot"
                  data-tone={gcal.tone}
                  aria-hidden="true"
                />
                <span className="prof-integration__label">{gcal.label}</span>
                <Link to="/schedule" className="prof-link">
                  Manage
                  <span className="material-symbols-outlined prof-icon-14">
                    arrow_forward
                  </span>
                </Link>
              </div>

              <p className="prof-card__hint">
                Two-way sync mirrors your scheduled blocks into your Google
                account and pulls external events back.
              </p>
            </article>
          </div>
        )}
      </div>
    </section>
  );
}
