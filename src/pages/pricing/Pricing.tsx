import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Link, useNavigate } from "react-router-dom";
import { useAuth } from "../../auth/AuthContext";
import {
  createPaymentCheckout,
  getMe,
  listSubscriptionPlans,
  type MeResponse,
  type SubscriptionPlanDto,
} from "../../lib/api-client";
import { useStaggeredMount } from "../../hooks/useStaggeredMount";
import { savePendingPayment } from "../payments/payment-storage";
import {
  durationLabel,
  formatLimit,
  formatVnd,
  inferTier,
  sortPlanViews,
  toPlanView,
  TIER_DISPLAY_NAME,
  type PlanTier,
  type PlanView,
} from "./plan-catalog";
import "./pricing.css";

/* ============================================================
 * Trang Bảng giá & Lựa chọn gói — /pricing
 * ----------------------------------------------------------
 * Nguồn dữ liệu:
 *   GET /api/subscription-plans → danh sách gói (giá, hạn mức, thời hạn…)
 *   GET /api/me                → gói hiện tại của user
 *
 * Luồng mua:
 *   bấm "Mua" → POST /api/payments/checkout → redirect checkoutUrl (PayOS)
 *   PayOS quay lại /payment/success → POST /api/payments/{id}/sync
 *
 * Quy tắc BE:
 *   - Chỉ gói isActive = true VÀ price > 0 mới mua được.
 *   - Gói Miễn phí (price = 0) không có nút mua.
 *
 * UI giữ nguyên thiết kế cũ (3 card + bảng so sánh đặc quyền + FAQ +
 * proof cards); chỉ thay dữ liệu hard-code bằng dữ liệu thật từ BE.
 * ============================================================ */

/** Chu kỳ thanh toán — BE quyết định bằng `durationDays` của từng gói. */
type BillingCycle = "monthly" | "annual";

/** Tôn trạng hiện tại của 1 gói. */
type PlanState = "current" | "available" | "inactive";

/** Số tháng của 1 gói để lọc theo chu kỳ. */
function isAnnualPlan(plan: PlanView): boolean {
  return plan.months >= 12;
}

export function PricingPage() {
  const navigate = useNavigate();
  const { isAuthenticated } = useAuth();

  /* ----- Dữ liệu gói từ BE ----- */
  const [plans, setPlans] = useState<PlanView[]>([]);
  const [plansLoading, setPlansLoading] = useState(true);
  const [plansError, setPlansError] = useState<string | null>(null);

  /* ----- Gói hiện tại của user (GET /api/me) ----- */
  const [me, setMe] = useState<MeResponse | null>(null);

  /* ----- Chu kỳ hiển thị ----- */
  const [billing, setBilling] = useState<BillingCycle>("annual");

  /* ----- Load danh sách gói ----- */
  const loadPlans = useCallback(async () => {
    const res = await listSubscriptionPlans();
    if (res.ok) {
      const views = sortPlanViews(
        (res.data ?? []).map((p: SubscriptionPlanDto) => toPlanView(p)),
      );
      setPlans(views);
      setPlansError(null);
    } else {
      setPlansError(res.error ?? "Could not load the plan list.");
    }
    setPlansLoading(false);
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const res = await listSubscriptionPlans();
      if (cancelled) return;
      if (res.ok) {
        setPlans(
          sortPlanViews(
            (res.data ?? []).map((p: SubscriptionPlanDto) => toPlanView(p)),
          ),
        );
        setPlansError(null);
      } else {
        setPlansError(res.error ?? "Could not load the plan list.");
      }
      setPlansLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  /* ----- Load gói hiện tại (chỉ khi đã đăng nhập) ----- */
  useEffect(() => {
    if (!isAuthenticated) return;
    let cancelled = false;
    void (async () => {
      const res = await getMe();
      if (!cancelled && res.ok) setMe(res.data);
    })();
    return () => {
      cancelled = true;
    };
  }, [isAuthenticated]);

  /** Id gói user đang dùng (từ currentSubscription.planId). */
  const currentPlanId = me?.currentSubscription?.planId ?? null;

  /**
   * Trạng thái của 1 gói so với gói user đang dùng.
   * - "current"   : đang dùng → CTA disabled, badge "Đang dùng"
   * - "inactive"  : isActive = false → không bán, CTA "Tạm dừng bán"
   * - "available" : còn mua được
   */
  const stateOf = useCallback(
    (plan: PlanView): PlanState => {
      if (currentPlanId && plan.id === currentPlanId) return "current";
      if (!plan.isActive) return "inactive";
      return "available";
    },
    [currentPlanId],
  );

  /**
   * Lọc gói theo chu kỳ.
   *
   * BE mô tả mỗi gói bằng `durationDays`, nên "gói theo tháng" và "gói theo
   * năm" là 2 record riêng (VD: Pro 30 ngày + Pro 365 ngày). Toggle chỉ
   * lọc, không nhân giá.
   *
   * Nếu BE chỉ có 1 chu kỳ cho mọi tier → lọc ra rỗng → fallback hiện tất cả
   * để trang không bị trống.
   */
  const visiblePlans = useMemo(() => {
    if (plans.length === 0) return [];
    const filtered = plans.filter((p) =>
      billing === "annual" ? isAnnualPlan(p) : !isAnnualPlan(p),
    );
    return filtered.length > 0 ? filtered : plans;
  }, [plans, billing]);

  /** Chu kỳ nào thực sự có gói (để disable toggle). */
  const hasCycle = useCallback(
    (cycle: BillingCycle) => {
      const any = plans.some((p) =>
        cycle === "annual" ? isAnnualPlan(p) : !isAnnualPlan(p),
      );
      return any;
    },
    [plans],
  );

  /* ----- Ripple effect (click feedback trên card) ----- */
  const [ripple, setRipple] = useState<
    { tier: PlanTier; x: number; y: number; key: number } | null
  >(null);
  /** Bộ đếm tăng dần để remount animation ripple (tránh Date.now). */
  const rippleSeq = useRef(0);

  function selectPlan(plan: PlanView, e?: React.MouseEvent) {
    if (stateOf(plan) === "current") return;
    if (e && e.currentTarget instanceof HTMLElement) {
      const rect = e.currentTarget.getBoundingClientRect();
      const key = ++rippleSeq.current;
      setRipple({
        tier: plan.tier,
        x: e.clientX - rect.left,
        y: e.clientY - rect.top,
        key,
      });
      window.setTimeout(() => setRipple((r) => (r?.key === key ? null : r)), 650);
    }
  }

  /* ----- Animation groups ----- */
  const pageAnim = useStaggeredMount(0, 30);
  const plansAnim = useStaggeredMount(110, 160, visiblePlans.length);
  const compareAnim = useStaggeredMount(50, 240, "compare");
  const priceAnim = useStaggeredMount(0, 0, billing);

  /* ----- Mua gói: POST /api/payments/checkout ----- */
  const [buyingPlanId, setBuyingPlanId] = useState<string | null>(null);
  const [buyError, setBuyError] = useState<string | null>(null);

  async function handleBuy(plan: PlanView) {
    /* Gói Miễn phí: không có nút mua — chỉ mời đăng ký / về dashboard. */
    if (plan.price === 0) {
      navigate(isAuthenticated ? "/dashboard" : "/register");
      return;
    }
    if (!isAuthenticated) {
      navigate("/login", { state: { from: "/pricing" } });
      return;
    }
    if (!plan.purchasable) {
      setBuyError("This plan is currently not available for purchase.");
      return;
    }

    setBuyingPlanId(plan.id);
    setBuyError(null);
    const res = await createPaymentCheckout(plan.id);
    if (!res.ok) {
      // 400 = plan not purchasable · 503 = PayOS temporarily down · 401 = session expired.
      setBuyError(
        res.status === 503
          ? "The payment gateway is busy. Please try again in a few minutes."
          : res.error ?? "Could not create a payment link.",
      );
      setBuyingPlanId(null);
      return;
    }

    const data = res.data;

    /* Lưu paymentId để bước sync/cancel sau khi PayOS redirect về. */
    savePendingPayment({
      paymentId: data.paymentId,
      planId: plan.id,
      orderCode: data.orderCode,
      amount: plan.price,
      checkoutUrl: data.checkoutUrl ?? "",
      qrCode: data.qrCode ?? "",
      expiresAt: data.expiresAt,
      createdAt: new Date().toISOString(),
    });

    /* Đã trả rồi → BE không trả link (status = Succeeded, reused = true).
     * Đi thẳng sang trang kết quả để sync và hiện gói mới. */
    if (!data.checkoutUrl) {
      const s = (data.status ?? "").toLowerCase();
      setBuyingPlanId(null);
      if (s === "succeeded" || s === "paid") {
        navigate(`/payment/success?orderCode=${data.orderCode}`);
      } else if (s === "cancelled" || s === "canceled") {
        navigate(`/payment/cancel?orderCode=${data.orderCode}`);
      } else {
        navigate(`/payment/success?orderCode=${data.orderCode}`);
      }
      return;
    }

    /* Chuyển sang trang thanh toán hosted của PayOS. */
    window.location.assign(data.checkoutUrl);
  }

  /* ----- Các plan theo tier để dựng bảng so sánh ----- */
  const byTier = useMemo(() => {
    const map: Record<PlanTier, PlanView | undefined> = {
      free: undefined,
      pro: undefined,
      team: undefined,
    };
    for (const p of plans) {
      if (!map[p.tier]) map[p.tier] = p;
    }
    return map;
  }, [plans]);

  /* ----- Thông tin gói hiện tại ----- */
  const currentSub = me?.currentSubscription ?? null;
  const currentEndAt = currentSub?.endAt ?? null;

  /**
   * Tên gói hiện tại hiển thị bằng tiếng Anh.
   *
   * BE trả `planName` bằng tiếng Việt (VD: "Tiêu chuẩn") → suy ra tier
   * rồi hiện tên tiếng Anh tương ứng cho nhất quán với phần còn lại
   * của trang.
   */
  const currentPlanLabel = useMemo(() => {
    const raw = currentSub?.planName ?? me?.currentPlanName ?? null;
    if (!raw) return "—";
    const tier = inferTier(raw, 0);
    return TIER_DISPLAY_NAME[tier];
  }, [currentSub?.planName, me?.currentPlanName]);

  return (
    <div className="pricing">
      {/* Ambient glow */}
      <div className="pricing-ambient" aria-hidden="true" />

      <section
        className={
          "pricing-section pricing-hero" +
          (pageAnim.mounted ? " pricing-hero--in" : "")
        }
      >
        <div className="pricing-container">
          <span className="pricing-eyebrow">
            <span className="material-symbols-outlined">bolt</span>
            Cognitive Orchestration System v2.4
          </span>
          <h1 className="pricing-title">
            Pick the plan that moves at your pace
          </h1>
          <p className="pricing-subtitle">
            Optimise your time and energy for freelancers and remote workers
            with a self-evolving AI system. Local payments via VietQR, MoMo,
            VNPay and international cards.
          </p>

          {/* Gói hiện tại — banner nhỏ (chỉ khi đã login) */}
          {isAuthenticated && currentSub && (
            <div className="pricing-current-bar">
              <span className="material-symbols-outlined pricing-current-bar-icon">
                workspace_premium
              </span>
              <span className="pricing-current-bar-text">
                Current plan:{" "}
                <strong>{currentPlanLabel}</strong>
              </span>
              {currentEndAt ? (
                <span className="pricing-current-bar-meta">
                  Renews{" "}
                  {new Date(currentEndAt).toLocaleDateString("en-US")}
                </span>
              ) : (
                <span className="pricing-current-bar-meta">Unlimited</span>
              )}
            </div>
          )}

          {/* Billing toggle */}
          <div
            className="pricing-toggle"
            role="tablist"
            aria-label="Billing cycle"
          >
            <button
              type="button"
              role="tab"
              aria-selected={billing === "monthly"}
              disabled={!hasCycle("monthly")}
              onClick={() => setBilling("monthly")}
              className={
                "pricing-toggle-btn" +
                (billing === "monthly" ? " pricing-toggle-btn--active" : "")
              }
            >
              Monthly billing
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={billing === "annual"}
              disabled={!hasCycle("annual")}
              onClick={() => setBilling("annual")}
              className={
                "pricing-toggle-btn" +
                (billing === "annual" ? " pricing-toggle-btn--active" : "")
              }
            >
              <span>Annual billing</span>
              <span className="pricing-save-pill">
                <span className="material-symbols-outlined">bolt</span>
                SAVE 20%
              </span>
            </button>
          </div>

          {buyError && (
            <div className="pricing-error" role="alert">
              <span className="material-symbols-outlined">error</span>
              <span>{buyError}</span>
            </div>
          )}
        </div>
      </section>

      {/* Plan cards */}
      <section
        className={
          "pricing-section pricing-plans" +
          (pageAnim.mounted ? " pricing-plans--in" : "")
        }
      >
        <div className="pricing-container">
          {plansLoading ? (
            <div className="pricing-skeleton-grid">
              {[0, 1, 2].map((i) => (
                <div key={i} className="pricing-skeleton-card" />
              ))}
            </div>
          ) : plansError ? (
            <div className="pricing-error pricing-error--block" role="alert">
              <span className="material-symbols-outlined">cloud_off</span>
              <span>{plansError}</span>
              <button
                type="button"
                className="pricing-retry-btn"
                onClick={() => void loadPlans()}
              >
                <span className="material-symbols-outlined">refresh</span>
                Retry
              </button>
            </div>
          ) : visiblePlans.length === 0 ? (
            <div className="pricing-empty" role="status">
              <span className="material-symbols-outlined">inventory_2</span>
              <p>No plans are available right now.</p>
            </div>
          ) : (
            <div className="pricing-plan-grid">
              {visiblePlans.map((plan, index) => {
                const state = stateOf(plan);
                return (
                  <PlanCard
                    key={plan.id}
                    plan={plan}
                    state={state}
                    billing={billing}
                    buying={buyingPlanId === plan.id}
                    onBuy={() => void handleBuy(plan)}
                    onSelect={(e) => selectPlan(plan, e)}
                    ripple={ripple && ripple.tier === plan.tier ? ripple : null}
                    animation={{
                      mounted: plansAnim.mounted,
                      delayStyle: plansAnim.getDelay(index),
                    }}
                    priceAnimation={{
                      mounted: priceAnim.mounted,
                      bumpKey: priceAnim.bumpKey,
                    }}
                  />
                );
              })}
            </div>
          )}
        </div>
      </section>

      {/* Feature comparison + FAQ */}
      <section
        className={
          "pricing-section pricing-compare" +
          (pageAnim.mounted ? " pricing-compare--in" : "")
        }
      >
        <div className="pricing-container">
          <div className="pricing-section-head">
            <span className="pricing-eyebrow pricing-eyebrow--inline">
              In-depth comparison
            </span>
            <h2 className="pricing-section-title">
              Full privilege breakdown by plan
            </h2>
            <p className="pricing-section-desc">
              Designed to the same standard for solo professionals, remote
              studios and expert teams alike.
            </p>
          </div>

          <div className="pricing-table-wrap">
            <table className="pricing-table">
              <thead>
                <tr>
                  <th className="pricing-th-feature">Features &amp; AI capabilities</th>
                  <th className="pricing-th-plan">
                    {byTier.free?.name ?? "Free"}
                  </th>
                  <th className="pricing-th-plan pricing-th-plan--hero">
                    {byTier.pro?.name ?? "Pro"}
                  </th>
                  <th className="pricing-th-plan">
                    {byTier.team?.name ?? "Team"}
                  </th>
                </tr>
              </thead>
              <tbody>
                <CompareRow
                  index={0}
                  animation={{
                    mounted: compareAnim.mounted,
                    delayStyle: compareAnim.getDelay(0),
                  }}
                  feature="Project breakdown (Macro → Sub-tasks)"
                  starter={byTier.free?.limits.tasks ?? "50 tasks / month"}
                  pro={{
                    text: byTier.pro?.limits.tasks ?? "Unlimited",
                    tone: "primary",
                    emphasis: true,
                  }}
                  team={{
                    text: byTier.team?.limits.tasks ?? "Unlimited",
                    tone: "secondary",
                    emphasis: true,
                  }}
                />
                <CompareRow
                  index={1}
                  animation={{
                    mounted: compareAnim.mounted,
                    delayStyle: compareAnim.getDelay(1),
                  }}
                  feature="Automatic AI Eisenhower matrix"
                  starter={byTier.free?.limits.ai === "Yes"}
                  pro={byTier.pro?.limits.ai === "Yes"}
                  team={byTier.team?.limits.ai === "Yes"}
                />
                <CompareRow
                  index={2}
                  animation={{
                    mounted: compareAnim.mounted,
                    delayStyle: compareAnim.getDelay(2),
                  }}
                  feature="K_bias biological rhythm algorithm"
                  starter={false}
                  pro
                  team
                />
                <CompareRow
                  index={3}
                  animation={{
                    mounted: compareAnim.mounted,
                    delayStyle: compareAnim.getDelay(3),
                  }}
                  feature="pgvector context memory"
                  starter={byTier.free?.limits.memory ?? "7-day retention"}
                  pro={{
                    text: byTier.pro?.limits.memory ?? "Lifetime (Personal)",
                    tone: "primary",
                    emphasis: true,
                  }}
                  team={{
                    text: byTier.team?.limits.memory ?? "Lifetime (Shared Team)",
                    tone: "secondary",
                    emphasis: true,
                  }}
                />
                <CompareRow
                  index={4}
                  animation={{
                    mounted: compareAnim.mounted,
                    delayStyle: compareAnim.getDelay(4),
                  }}
                  feature="Multi-device sync & schedules"
                  starter="Google Calendar"
                  pro={{ text: "Real-time SignalR", tone: "plain" }}
                  team={{ text: "SignalR + Webhook", tone: "plain" }}
                />
                <CompareRow
                  index={5}
                  animation={{
                    mounted: compareAnim.mounted,
                    delayStyle: compareAnim.getDelay(5),
                  }}
                  feature="AI call limit"
                  starter={formatLimit(byTier.free?.aiCallLimit ?? null, "call")}
                  pro={{
                    text: formatLimit(byTier.pro?.aiCallLimit ?? null, "call"),
                    tone: "primary",
                    emphasis: true,
                  }}
                  team={{
                    text: formatLimit(byTier.team?.aiCallLimit ?? null, "call"),
                    tone: "secondary",
                    emphasis: true,
                  }}
                />
                <CompareRow
                  index={6}
                  animation={{
                    mounted: compareAnim.mounted,
                    delayStyle: compareAnim.getDelay(6),
                  }}
                  feature="Storage capacity"
                  starter={formatLimit(byTier.free?.storageLimitMb ?? null, "MB")}
                  pro={{
                    text: formatLimit(byTier.pro?.storageLimitMb ?? null, "MB"),
                    tone: "plain",
                  }}
                  team={{
                    text: formatLimit(byTier.team?.storageLimitMb ?? null, "MB"),
                    tone: "secondary",
                    emphasis: true,
                  }}
                />
                <CompareRow
                  index={7}
                  animation={{
                    mounted: compareAnim.mounted,
                    delayStyle: compareAnim.getDelay(7),
                  }}
                  feature="Maximum projects"
                  starter={formatLimit(byTier.free?.projectLimit ?? null, "project")}
                  pro={{
                    text: formatLimit(byTier.pro?.projectLimit ?? null, "project"),
                    tone: "primary",
                    emphasis: true,
                  }}
                  team={{
                    text: formatLimit(byTier.team?.projectLimit ?? null, "project"),
                    tone: "secondary",
                    emphasis: true,
                  }}
                />
                <CompareRow
                  index={8}
                  animation={{
                    mounted: compareAnim.mounted,
                    delayStyle: compareAnim.getDelay(8),
                  }}
                  feature="Energy balancing & overload alerts"
                  starter={false}
                  pro={{ text: "Individual", tone: "plain" }}
                  team={{
                    text: "Whole team (Workload Balancing)",
                    tone: "secondary",
                    emphasis: true,
                  }}
                />
                <CompareRow
                  index={9}
                  animation={{
                    mounted: compareAnim.mounted,
                    delayStyle: compareAnim.getDelay(9),
                  }}
                  feature="Project progress reports & timesheets"
                  starter={false}
                  pro={{ text: "Markdown / PDF", tone: "plain" }}
                  team={{
                    text: "PDF + Notion + CSV",
                    tone: "secondary",
                    emphasis: true,
                  }}
                />
                <CompareRow
                  index={10}
                  animation={{
                    mounted: compareAnim.mounted,
                    delayStyle: compareAnim.getDelay(10),
                  }}
                  feature="Technical support"
                  starter={byTier.free?.limits.support ?? "Discord community"}
                  pro={{
                    text: byTier.pro?.limits.support ?? "Priority < 2h",
                    tone: "primary",
                    emphasis: true,
                  }}
                  team={{
                    text: byTier.team?.limits.support ?? "1:1 AI engineer support",
                    tone: "secondary",
                    emphasis: true,
                  }}
                />
              </tbody>
            </table>
          </div>
        </div>
      </section>

      {/* CTA cho guest — xem trang chủ (dữ liệu mẫu) trước khi quyết định mua gói. */}
      {!isAuthenticated && (
        <section className="pricing-section pricing-demo-cta">
          <div className="pricing-container">
            <div className="pricing-demo-cta-inner">
              <span className="pricing-eyebrow pricing-eyebrow--inline">
                <span className="material-symbols-outlined">visibility</span>
                Try it before you decide
              </span>
              <h2 className="pricing-demo-cta-title">
                Explore METANOIA with sample data — no account needed
              </h2>
              <p className="pricing-demo-cta-desc">
                Browse the daily schedule, the week, projects and work groups
                using sample data to see how the product behaves before you
                sign up.
              </p>
              <div className="pricing-demo-cta-actions">
                <Link to="/" className="pricing-demo-cta-btn">
                  <span className="material-symbols-outlined">visibility</span>
                  Open the sample workspace
                </Link>
                <Link to="/register" className="pricing-demo-cta-link">
                  Or create a free account →
                </Link>
              </div>
            </div>
          </div>
        </section>
      )}    </div>
  );
}

/* =========================================================
 * Sub-components
 * ========================================================= */

interface PlanCardProps {
  plan: PlanView;
  state: PlanState;
  billing: BillingCycle;
  buying: boolean;
  onBuy: () => void;
  onSelect: (e: React.MouseEvent) => void;
  animation: {
    mounted: boolean;
    delayStyle: { animationDelay: string };
  };
  priceAnimation?: {
    mounted: boolean;
    bumpKey: number;
  };
  ripple?: { x: number; y: number; key: number } | null;
}

function PlanCard(props: PlanCardProps) {
  const { plan, state } = props;
  const isPro = plan.tier === "pro";
  const isFree = plan.tier === "free";

  /** Chu kỳ hiển thị. Gói dài hạn hiện "/ tháng" + tổng tiền ở dòng dưới. */
  const displayPeriod =
    plan.price === 0 ? "— free" : `/ ${plan.months === 12 ? "month" : "cycle"}`;

  /** Giá quy đổi / tháng (chỉ hiện với gói > 1 tháng). */
  const perMonth = plan.months > 0 ? plan.price / plan.months : plan.price;

  /** Nhãn CTA theo trạng thái. */
  const ctaLabel = (() => {
    if (state === "current") return "Current plan";
    if (state === "inactive") return "Sales paused";
    if (props.buying) return "Creating checkout…";
    if (isFree) return "Start for free";
    return "Buy this plan";
  })();

  const ctaDisabled = state !== "available" || props.buying;

  return (
    <article
      className={
        "pricing-plan" +
        (isPro ? " pricing-plan--pro" : "") +
        (isFree ? " pricing-plan--starter" : "") +
        (props.animation.mounted ? " pricing-plan--in" : "") +
        (state === "current" ? " pricing-plan--current" : "")
      }
      style={props.animation.delayStyle}
      onClick={state === "current" ? undefined : props.onSelect}
      role="button"
      tabIndex={state === "current" ? -1 : 0}
      aria-pressed={state === "current" ? true : undefined}
      aria-current={state === "current" ? "true" : undefined}
      onKeyDown={(e) => {
        if (state === "current") return;
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          props.onSelect(e as unknown as React.MouseEvent);
        }
      }}
    >
      {/* Ripple effect */}
      {props.ripple && state !== "current" && (
        <span
          key={props.ripple.key}
          className="pricing-plan-ripple"
          style={{ left: props.ripple.x, top: props.ripple.y }}
          aria-hidden="true"
        />
      )}

      {/* Badge */}
      {state === "current" ? (
        <span className="pricing-plan-badge pricing-plan-badge--current">
          <span className="material-symbols-outlined">verified</span>
          Current plan
        </span>
      ) : isPro ? (
        <span className="pricing-plan-badge">
          <span className="material-symbols-outlined">auto_awesome</span>
          Most popular
        </span>
      ) : null}

      <div className="pricing-plan-body">
        <div className="pricing-plan-head">
          <span
            className={
              "pricing-plan-eyebrow" +
              (isPro ? " pricing-plan-eyebrow--pro" : "")
            }
          >
            {plan.eyebrow}
          </span>
          <span
            className={
              "pricing-plan-icon" +
              (isPro ? " pricing-plan-icon--pro" : "")
            }
            aria-hidden="true"
          >
            <span className="material-symbols-outlined">{plan.icon}</span>
          </span>
        </div>

        <h3 className="pricing-plan-title">{plan.name}</h3>
        <p className="pricing-plan-desc">{plan.desc}</p>

        {/* Giá */}
        {isFree ? (
          <div className="pricing-price pricing-price--static">
            <span className="pricing-price-amount">{formatVnd(0)}</span>
            <span className="pricing-price-period">{displayPeriod}</span>
          </div>
        ) : (
          <div
            key={props.priceAnimation?.bumpKey ?? 0}
            className={
              "pricing-price pricing-price--dynamic" +
              (props.priceAnimation?.mounted ? " pricing-price--in" : "")
            }
          >
            <div className="pricing-price-row">
              <div className="pricing-price-main">
                <span className="pricing-price-amount">
                  {formatVnd(plan.price)}
                </span>
                <span className="pricing-price-period">{displayPeriod}</span>
              </div>
              {plan.months === 12 && (
                <div className="pricing-price-side">
                  <span className="pricing-price-discount">
                    {durationLabel(plan.durationDays)}
                  </span>
                </div>
              )}
            </div>
            {plan.months > 1 && (
              <div className="pricing-price-savings">
                <span className="material-symbols-outlined">verified</span>
                <span>
                  ≈ {formatVnd(Math.round(perMonth))} / month · Billed{" "}
                  {durationLabel(plan.durationDays)}
                </span>
              </div>
            )}
          </div>
        )}

        {/* Hạn mức định lượng (từ BE) */}
        <ul className="pricing-plan-limits">
          <LimitRow
            icon="neurology"
            label="AI calls"
            value={formatLimit(plan.aiCallLimit, "call")}
          />
          <LimitRow
            icon="storage"
            label="Storage"
            value={formatLimit(plan.storageLimitMb, "MB")}
          />
          <LimitRow
            icon="space_dashboard"
            label="Projects"
            value={formatLimit(plan.projectLimit, "project")}
          />
        </ul>

        <div className="pricing-plan-divider" />

        <ul className="pricing-plan-features">
          {plan.features.map((f, i) => (
            <li
              key={i}
              className={
                "pricing-plan-feature" +
                (f.ok ? " pricing-plan-feature--ok" : " pricing-plan-feature--no") +
                (f.emphasize ? " pricing-plan-feature--em" : "")
              }
            >
              <span className="material-symbols-outlined pricing-plan-feature-icon">
                {f.ok ? "check_circle" : "remove"}
              </span>
              <span>{f.text}</span>
            </li>
          ))}
        </ul>
      </div>

      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          if (!ctaDisabled) props.onBuy();
        }}
        disabled={ctaDisabled}
        aria-disabled={ctaDisabled || undefined}
        className={
          "pricing-plan-cta" +
          (isPro ? " pricing-plan-cta--primary" : "") +
          (plan.tier === "team" ? " pricing-plan-cta--accent" : "") +
          (ctaDisabled ? " pricing-plan-cta--disabled" : "")
        }
      >
        <span>{ctaLabel}</span>
        <span className="material-symbols-outlined">
          {state === "current"
            ? "verified"
            : props.buying
              ? "progress_activity"
              : "arrow_forward"}
        </span>
      </button>
    </article>
  );
}

/** 1 dòng hạn mức (icon + label + value). */
function LimitRow({
  icon,
  label,
  value,
}: {
  icon: string;
  label: string;
  value: string;
}) {
  return (
    <li className="pricing-plan-limit">
      <span className="material-symbols-outlined pricing-plan-limit-icon">
        {icon}
      </span>
      <span className="pricing-plan-limit-label">{label}</span>
      <span className="pricing-plan-limit-value">{value}</span>
    </li>
  );
}

interface CompareCell {
  text: string;
  tone: "primary" | "secondary" | "plain";
  emphasis?: boolean;
}

type CompareValue = string | boolean | CompareCell;

interface CompareRowProps {
  feature: string;
  starter: CompareValue;
  pro: CompareValue;
  team: CompareValue;
  index: number;
  animation: {
    mounted: boolean;
    delayStyle: { animationDelay: string };
  };
}

function CompareRow({
  feature,
  starter,
  pro,
  team,
  animation,
}: CompareRowProps) {
  return (
    <tr
      className={"pricing-tr" + (animation.mounted ? " pricing-tr--in" : "")}
      style={animation.delayStyle}
    >
      <td className="pricing-td-feature">{feature}</td>
      <td className="pricing-td">
        <CellContent value={starter} />
      </td>
      <td className="pricing-td pricing-td--pro">
        <CellContent value={pro} />
      </td>
      <td className="pricing-td">
        <CellContent value={team} />
      </td>
    </tr>
  );
}

function CellContent({ value }: { value: CompareValue }) {
  if (value === false) {
    return (
      <span className="pricing-cell pricing-cell--no">
        <span className="material-symbols-outlined">remove</span>
      </span>
    );
  }
  if (value === true) {
    return (
      <span className="pricing-cell pricing-cell--ok">
        <span className="material-symbols-outlined">check_circle</span>
      </span>
    );
  }
  if (typeof value === "string") {
    return <span className="pricing-cell-text">{value}</span>;
  }
  return (
    <span
      className={
        "pricing-cell-text" +
        (value.emphasis ? " pricing-cell-text--em" : "") +
        (value.tone === "primary"
          ? " pricing-cell-text--primary"
          : value.tone === "secondary"
            ? " pricing-cell-text--secondary"
            : "")
      }
    >
      {value.text}
    </span>
  );
}
