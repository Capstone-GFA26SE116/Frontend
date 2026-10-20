import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import {
  cancelPayment,
  createCheckout,
  setCurrentPlan,
  simulatePayOSWebhook,
  syncPayment,
  type CreateCheckoutRequest,
  type PaymentGateway,
  type PaymentTransactionDto,
} from "../../lib/api-client";
import "./payments.css";

/* ============================================================
 * Checkout (Payments) page
 * Route: /checkout?plan=pro&cycle=annual
 *
 * UI layout:
 *   1. Top bar (back + AES-256 secure pill)
 *   2. Header (title + subtitle)
 *   3. Two-column grid:
 *      - Left:  Order summary + Activation form
 *      - Right: Payment method tabs + QR / wallet / card panel + CTA
 *   4. Trust strip (PCI-DSS, TLS, 24/7 support)
 *
 * Theme: Cognitive Minimalist Dark — đồng bộ ProjectDetail / Pricing.
 *
 * API (mocked via src/lib/api-client.ts):
 *   POST /api/payments/checkout                  → createCheckout()
 *   POST /api/payments/{id}/sync                  → syncPayment()
 *   POST /api/payments/{id}/cancel                → cancelPayment()
 * ============================================================ */

type Cycle = "monthly" | "annual";
type PlanKey = "pro" | "team";

interface PlanInfo {
  name: string;
  monthly: number; // VND
  annual: number; // VND (total/year)
  description: string;
  icon: string;
}

const PLAN_INFO: Record<PlanKey, PlanInfo> = {
  pro: {
    name: "Pro & Freelancer",
    monthly: 149_000,
    annual: 1_428_000,
    description:
      "For freelancers, remote workers and engineers managing personal progress & independent projects.",
    icon: "psychology",
  },
  team: {
    name: "Team & Organization",
    monthly: 399_000,
    annual: 3_828_000,
    description:
      "For small teams that collaborate on shared projects with AI-driven scheduling.",
    icon: "groups",
  },
};

function formatVnd(amount: number): string {
  // 1.428.000đ
  return amount.toLocaleString("vi-VN") + "đ";
}

/* ============================================================
 * Main page
 * ============================================================ */
export function PaymentsPage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const planParam = (searchParams.get("plan") ?? "pro") as PlanKey;
  const cycleParam = (searchParams.get("cycle") ?? "annual") as Cycle;
  const initialPlan: PlanKey = PLAN_INFO[planParam] ? planParam : "pro";
  const initialCycle: Cycle = cycleParam === "monthly" ? "monthly" : "annual";

  /* ----- Plan (locked from query string — switcher lives on /pricing) ----- */
  const [plan] = useState<PlanKey>(initialPlan);
  /* ----- Cycle ----- */
  const [cycle, setCycle] = useState<Cycle>(initialCycle);

  /* ----- Payment method ----- */
  const [gateway, setGateway] = useState<PaymentGateway>("VietQR");

  /* ----- Activation info ----- */
  const [email, setEmail] = useState<string>("alex.nguyen@metanoia.ai");
  const [fullName, setFullName] = useState<string>("Nguyễn Hoàng Nam");
  const [wantInvoice, setWantInvoice] = useState<boolean>(false);

  /* ----- API state ----- */
  const [payment, setPayment] = useState<PaymentTransactionDto | null>(null);
  const [creating, setCreating] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  /* ----- Countdown timer (15 min) ----- */
  const [remainingSec, setRemainingSec] = useState<number | null>(null);
  const syncIntervalRef = useRef<number | null>(null);

  /* Derived price */
  const planInfo = PLAN_INFO[plan];
  const { basePrice, cycleTotal, savings, perMonth } = useMemo(() => {
    if (cycle === "annual") {
      const monthly = planInfo.monthly * 12; // 1.788.000
      const total = planInfo.annual; // 1.428.000
      const saved = monthly - total;
      return {
        basePrice: monthly,
        cycleTotal: total,
        savings: saved,
        perMonth: total / 12, // 119.000
      };
    }
    return {
      basePrice: planInfo.monthly,
      cycleTotal: planInfo.monthly,
      savings: 0,
      perMonth: planInfo.monthly,
    };
  }, [plan, cycle, planInfo]);

  /* ----- Initial checkout ----- */
  useEffect(() => {
    void startCheckout({ planId: plan, cycle, gateway, email, fullName, plan });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* ----- Re-create checkout when plan / cycle / gateway changes ----- */
  useEffect(() => {
    if (!email) return;
    void startCheckout({ planId: plan, cycle, gateway, email, fullName, plan });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [plan, cycle, gateway]);

  /* ----- Tick countdown ----- */
  useEffect(() => {
    if (!payment?.expiresAt) {
      setRemainingSec(null);
      return;
    }
    const tick = () => {
      const ms = new Date(payment.expiresAt!).getTime() - Date.now();
      const sec = Math.max(0, Math.floor(ms / 1000));
      setRemainingSec(sec);
      if (sec === 0) {
        // Tự động hủy
        handleCancel();
      }
    };
    tick();
    const t = window.setInterval(tick, 1000);
    return () => window.clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [payment?.expiresAt]);

  /* ----- Auto-sync payment (polling) every 8s khi status waiting ----- */
  useEffect(() => {
    if (!payment || payment.status !== "waiting") {
      if (syncIntervalRef.current) {
        window.clearInterval(syncIntervalRef.current);
        syncIntervalRef.current = null;
      }
      return;
    }
    syncIntervalRef.current = window.setInterval(() => {
      void doSync(false);
    }, 8000);
    return () => {
      if (syncIntervalRef.current) window.clearInterval(syncIntervalRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [payment?.id, payment?.status]);

  async function startCheckout(req: CreateCheckoutRequest) {
    setCreating(true);
    setError(null);
    const res = await createCheckout(req);
    setCreating(false);
    if (res.ok) setPayment(res.data);
    else setError(res.error ?? "Failed to create checkout");
  }

  async function doSync(showError: boolean) {
    if (!payment) return;
    // Polling thuần: kéo status từ gateway, không tự đổi sang paid.
    const res = await syncPayment(payment.id);
    if (res.ok) {
      setPayment(res.data);
      // Vẫn xử lý case status đã paid (do tab khác / webhook BE kích).
      if (res.data.status === "paid") {
        if (syncIntervalRef.current) {
          window.clearInterval(syncIntervalRef.current);
          syncIntervalRef.current = null;
        }
        setCurrentPlan(plan as PlanKey);
      }
    } else if (showError) {
      setError(res.error ?? "Failed to sync payment");
    }
  }

  /** User click "Tôi đã chuyển khoản" → giả lập webhook Paid từ PayOS. */
  async function markAsPaid() {
    if (!payment) return;
    setError(null);
    const res = await simulatePayOSWebhook(payment.id);
    if (res.ok) {
      setPayment(res.data);
      if (res.data.status === "paid") {
        if (syncIntervalRef.current) {
          window.clearInterval(syncIntervalRef.current);
          syncIntervalRef.current = null;
        }
        setCurrentPlan(plan as PlanKey);
      }
    } else {
      setError(res.error ?? "Could not confirm payment");
    }
  }

  async function handleCancel() {
    if (!payment) return;
    const res = await cancelPayment(payment.id);
    if (res.ok) setPayment(res.data);
  }

  function formatMmSs(sec: number) {
    const m = Math.floor(sec / 60).toString().padStart(2, "0");
    const s = (sec % 60).toString().padStart(2, "0");
    return `${m}:${s}`;
  }

  /* ----- Loading state (until first payment) ----- */
  if (!payment && creating && !error) {
    return (
      <section className="pay">
        <div className="pay-ambient pay-ambient--top" aria-hidden="true" />
        <div className="pay-container">
          <div className="pay-state" role="status">
            <span className="material-symbols-outlined pay-state-icon spin">
              progress_activity
            </span>
            <p>Initializing secure checkout…</p>
          </div>
        </div>
      </section>
    );
  }

  /* ----- Error ----- */
  if (error && !payment) {
    return (
      <section className="pay">
        <div className="pay-ambient pay-ambient--top" aria-hidden="true" />
        <div className="pay-container">
          <div className="pay-state pay-state--error" role="alert">
            <span className="material-symbols-outlined pay-state-icon">error</span>
            <h2 className="bad">Something went wrong</h2>
            <p>{error}</p>
            <button
              type="button"
              className="pay-cta"
              style={{ maxWidth: 240 }}
              onClick={() => navigate("/pricing")}
            >
              Back to pricing
            </button>
          </div>
        </div>
      </section>
    );
  }

  if (!payment) return null;

  const isPaid = payment.status === "paid";
  const isCancelled = payment.status === "cancelled";

  /* ----- Success screen ----- */
  if (isPaid) {
    return (
      <section className="pay">
        <div className="pay-ambient pay-ambient--top" aria-hidden="true" />
        <div className="pay-container">
          <div className="pay-state pay-state--success" role="status">
            <span className="material-symbols-outlined pay-state-icon">
              check_circle
            </span>
            <h2 className="ok">Payment received — welcome aboard!</h2>
            <p>
              Your <strong>{planInfo.name}</strong> plan is now active. We've sent
              a confirmation to <code>{email}</code>.
            </p>
            <button
              type="button"
              className="pay-cta"
              style={{ maxWidth: 280 }}
              onClick={() => navigate("/dashboard")}
            >
              <span>Continue to dashboard</span>
              <span className="material-symbols-outlined">arrow_forward</span>
            </button>
          </div>
        </div>
      </section>
    );
  }

  /* ----- Main checkout UI ----- */
  return (
    <section className="pay">
      <div className="pay-ambient pay-ambient--top" aria-hidden="true" />
      <div className="pay-container">
        {/* Top bar */}
        <div className="pay-topbar">
          <Link to="/pricing" className="pay-back" aria-label="Back to plans">
            <span className="material-symbols-outlined">arrow_back</span>
            <span>Back to plans</span>
          </Link>
          <div className="pay-secure" title="AES-256 encrypted payment gateway">
            <span className="material-symbols-outlined">lock</span>
            <span>Secure checkout · AES-256</span>
          </div>
        </div>

        {/* Header */}
        <header className="pay-head">
          <h1 className="pay-title">Confirm order &amp; activate your account</h1>
          <p className="pay-subtitle">
            Complete the secure payment below to unlock METANOIA's AI-powered
            scheduling intelligence on your account.
          </p>
        </header>

        {/* Grid */}
        <div className="pay-grid">
          {/* ============== Left column ============== */}
          <div className="pay-col">
            {/* Order summary */}
            <section
              className={`pay-summary ${creating ? "is-loading" : ""}`}
              aria-label="Order summary"
            >
              <div className="pay-summary-head">
                <div className="pay-summary-head-left">
                  <div className="pay-summary-icon">
                    <span className="material-symbols-outlined">
                      {planInfo.icon}
                    </span>
                  </div>
                  <div>
                    <h3 className="pay-summary-title">{planInfo.name}</h3>
                    <span className="pay-summary-cycle">
                      {cycle === "annual"
                        ? "12-month billing · Save 20%"
                        : "Monthly billing"}
                    </span>
                  </div>
                </div>
                {cycle === "annual" && (
                  <span className="pay-summary-badge">Save 20%</span>
                )}
              </div>

              <p className="pay-summary-desc">{planInfo.description}</p>

              <div className="pay-summary-rows">
                {cycle === "annual" ? (
                  <>
                    <div className="pay-summary-row">
                      <span>
                        Base price ({formatVnd(planInfo.monthly)} × 12 months)
                      </span>
                      <span className="strike mono">{formatVnd(basePrice)}</span>
                    </div>
                    <div className="pay-summary-row">
                      <span>Annual discount (-20%)</span>
                      <span className="discount mono">
                        −{formatVnd(savings)}
                      </span>
                    </div>
                  </>
                ) : (
                  <div className="pay-summary-row">
                    <span>Monthly subscription</span>
                    <span className="mono">{formatVnd(basePrice)}</span>
                  </div>
                )}
                <div className="pay-summary-row">
                  <span>VAT (10%)</span>
                  <span className="mono">Included</span>
                </div>
              </div>

              <div className="pay-summary-total">
                <span className="pay-summary-total-label">Total due</span>
                <div className="pay-summary-total-value">
                  <span className="pay-summary-total-price">
                    {formatVnd(cycleTotal)}
                  </span>
                  <p className="pay-summary-total-equiv">
                    ≈ {formatVnd(Math.round(perMonth))} / month
                  </p>
                </div>
              </div>

              {/* Plan / cycle switcher (giữ ngắn, có thể đổi nhanh) */}
              <div
                className="pay-summary-rows"
                style={{ paddingTop: "0.5rem", borderTop: "1px solid #262a33" }}
              >
                <div className="pay-summary-row">
                  <span>Billing cycle</span>
                  <div style={{ display: "inline-flex", gap: 4 }}>
                    <button
                      type="button"
                      className="pay-secondary-btn"
                      onClick={() => setCycle("monthly")}
                      style={
                        cycle === "monthly"
                          ? { borderColor: "#c0c1ff", color: "#c0c1ff" }
                          : undefined
                      }
                    >
                      Monthly
                    </button>
                    <button
                      type="button"
                      className="pay-secondary-btn"
                      onClick={() => setCycle("annual")}
                      style={
                        cycle === "annual"
                          ? { borderColor: "#c0c1ff", color: "#c0c1ff" }
                          : undefined
                      }
                    >
                      Annual
                    </button>
                  </div>
                </div>
              </div>
            </section>

            {/* Activation form */}
            <section className="pay-form-card" aria-label="Activation">
              <div className="pay-form-head">
                <span className="material-symbols-outlined">badge</span>
                <h4>Activation &amp; invoice details</h4>
              </div>

              <div className="pay-field">
                <label className="pay-label" htmlFor="pay-email">
                  METANOIA account email *
                </label>
                <input
                  id="pay-email"
                  type="email"
                  className="pay-input"
                  placeholder="name@company.com"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                />
              </div>

              <div className="pay-field">
                <label className="pay-label" htmlFor="pay-name">
                  Full name
                </label>
                <input
                  id="pay-name"
                  type="text"
                  className="pay-input"
                  placeholder="Your full name"
                  value={fullName}
                  onChange={(e) => setFullName(e.target.value)}
                />
              </div>

              <label className="pay-checkbox-row">
                <input
                  type="checkbox"
                  checked={wantInvoice}
                  onChange={(e) => setWantInvoice(e.target.checked)}
                />
                <span>
                  Issue VAT e-invoice (for businesses or schools)
                </span>
              </label>
            </section>

            {/* Mini badges */}
            <div className="pay-badges">
              <span className="pay-badge">
                <span className="material-symbols-outlined">verified_user</span>
                Cancel anytime
              </span>
              <span className="pay-badge">
                <span className="material-symbols-outlined">security</span>
                AES-256 encryption
              </span>
              <span className="pay-badge">
                <span className="material-symbols-outlined">replay</span>
                7-day refund
              </span>
            </div>
          </div>

          {/* ============== Right column ============== */}
          <div className="pay-col">
            <section className="pay-method" aria-label="Payment method">
              <span className="pay-method-eyebrow">Payment method</span>

              {/* Method tabs */}
              <div className="pay-method-tabs" role="tablist">
                <button
                  type="button"
                  role="tab"
                  aria-selected={gateway === "VietQR"}
                  className={`pay-method-tab ${
                    gateway === "VietQR" ? "is-active" : ""
                  }`}
                  onClick={() => setGateway("VietQR")}
                >
                  <span className="material-symbols-outlined tab-icon">
                    qr_code_scanner
                  </span>
                  <span className="tab-name">VietQR</span>
                  <span className="tab-sub">Napas 24/7</span>
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={gateway === "MoMo"}
                  className={`pay-method-tab momo ${
                    gateway === "MoMo" ? "is-active" : ""
                  }`}
                  onClick={() => setGateway("MoMo")}
                >
                  <span className="material-symbols-outlined tab-icon">
                    account_balance_wallet
                  </span>
                  <span className="tab-name">MoMo</span>
                  <span className="tab-sub">One-tap</span>
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={gateway === "Visa"}
                  className={`pay-method-tab card ${
                    gateway === "Visa" ? "is-active" : ""
                  }`}
                  onClick={() => setGateway("Visa")}
                >
                  <span className="material-symbols-outlined tab-icon">
                    credit_card
                  </span>
                  <span className="tab-name">Visa / MC</span>
                  <span className="tab-sub">International</span>
                </button>
              </div>

              {/* Panel based on gateway */}
              {gateway === "VietQR" && payment.bankInfo && (
                <>
                  <div className="pay-panel">
                    <div className="pay-panel-qr">
                      {/* QR thật từ VietQR API (vietqr.io/image).
                         URL lấy từ payment.qrData (mock tạo sẵn đúng chuẩn). */}
                      {payment.qrData ? (
                        <img
                          src={payment.qrData}
                          alt="VietQR code"
                          className="pay-qr-img"
                          loading="lazy"
                          width={180}
                          height={180}
                        />
                      ) : (
                        <div className="pay-qr-empty">
                          VietQR code chưa sẵn sàng, vui lòng chuyển khoản thủ công theo thông tin bên dưới.
                        </div>
                      )}
                    </div>
                    <div className="pay-panel-info">
                      <h5>Scan the Napas 24/7 QR code</h5>
                      <p>
                        Open any bank app (MBBank, Vietcombank, Techcombank,
                        VPBank…) and scan this QR code to complete payment
                        instantly.
                      </p>
                      <div
                        className={`pay-panel-status ${
                          isCancelled ? "is-cancelled" : "is-waiting"
                        }`}
                      >
                        <span
                          className={`dot ${isCancelled ? "is-static" : ""}`}
                        />
                        {isCancelled
                          ? "Transaction cancelled"
                          : remainingSec != null
                          ? `Awaiting transaction… (${formatMmSs(remainingSec)} remaining)`
                          : "Awaiting transaction…"}
                      </div>
                    </div>
                  </div>

                  <div className="pay-panel-bank" aria-label="Bank transfer details">
                    <div className="pay-panel-bank-row">
                      <span className="key">Beneficiary bank</span>
                      <span className="val">{payment.bankInfo.bankName}</span>
                    </div>
                    <div className="pay-panel-bank-row">
                      <span className="key">Account number</span>
                      <span className="val mono">
                        {payment.bankInfo.accountNumber}
                      </span>
                    </div>
                    <div className="pay-panel-bank-row">
                      <span className="key">Account holder</span>
                      <span className="val">{payment.bankInfo.accountHolder}</span>
                    </div>
                    <div className="pay-panel-bank-row">
                      <span className="key">Exact amount</span>
                      <span className="val primary mono">
                        {formatVnd(cycleTotal)}
                      </span>
                    </div>
                    <div className="pay-panel-bank-row">
                      <span className="key">Transfer content</span>
                      <span className="pay-transfer-content">
                        {payment.bankInfo.transferContent}
                      </span>
                    </div>
                  </div>
                </>
              )}

              {gateway === "MoMo" && (
                <div className="pay-panel">
                  <div className="pay-panel-qr">
                    {/* PayOS không render QR inline — gateway HOST 1 page
                       trọn vẹn (QR + form + confirm). FE chỉ redirect/tab.
                       Khi BE hook thật: chỉ cần set tx.checkoutUrl từ
                       response.data.checkoutUrl của PayOS API. */}
                    {payment.checkoutUrl ? (
                      <button
                        type="button"
                        className="pay-momo-open"
                        onClick={() =>
                          window.open(
                            payment.checkoutUrl!,
                            "_blank",
                            "noopener,noreferrer",
                          )
                        }
                      >
                        <span className="material-symbols-outlined">
                          open_in_new
                        </span>
                        <span>Open PayOS checkout</span>
                      </button>
                    ) : (
                      <div className="pay-qr-empty">
                        PayOS checkout chưa sẵn sàng.
                      </div>
                    )}
                  </div>
                  <div className="pay-panel-info">
                    <h5>Pay with PayOS (MoMo / Visa / QR)</h5>
                    <p>
                      Tap <b>Open PayOS checkout</b> to open the hosted payment
                      page in a new tab. The QR code, card form and all
                      payment methods are provided directly by PayOS.
                      You'll return here after paying — this page will
                      update within a few seconds.
                    </p>
                    <div className="pay-panel-status is-waiting">
                      <span className="dot" />
                      {isCancelled
                        ? "Transaction cancelled"
                        : "Waiting for PayOS confirmation…"}
                    </div>
                  </div>
                </div>
              )}

              {gateway === "Visa" && (
                <div className="pay-panel" style={{ flexDirection: "column", alignItems: "stretch" }}>
                  <div className="pay-field">
                    <label className="pay-label" htmlFor="pay-card-no">
                      Card number
                    </label>
                    <input
                      id="pay-card-no"
                      className="pay-input"
                      placeholder="1234 5678 9012 3456"
                      inputMode="numeric"
                      disabled={isCancelled}
                    />
                  </div>
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0.75rem" }}>
                    <div className="pay-field">
                      <label className="pay-label">Expiry</label>
                      <input
                        className="pay-input"
                        placeholder="MM/YY"
                        inputMode="numeric"
                        disabled={isCancelled}
                      />
                    </div>
                    <div className="pay-field">
                      <label className="pay-label">CVC</label>
                      <input
                        className="pay-input"
                        placeholder="123"
                        inputMode="numeric"
                        disabled={isCancelled}
                      />
                    </div>
                  </div>
                  <div
                    className={`pay-panel-status ${
                      isCancelled ? "is-cancelled" : "is-waiting"
                    }`}
                    style={{ paddingTop: 0 }}
                  >
                    <span
                      className={`dot ${isCancelled ? "is-static" : ""}`}
                    />
                    {isCancelled
                      ? "Transaction cancelled"
                      : "Waiting for 3-D Secure verification…"}
                  </div>
                </div>
              )}

              {/* CTA */}
              <button
                type="button"
                className="pay-cta"
                onClick={() => void markAsPaid()}
                disabled={isCancelled || payment.status === "paid"}
              >
                <span className="material-symbols-outlined">verified</span>
                <span>I have completed the transfer</span>
                <span className="material-symbols-outlined">arrow_forward</span>
              </button>

              {/* Nút phụ: poll thủ công (kéo status từ gateway) */}
              {!isCancelled && payment.status !== "paid" && (
                <button
                  type="button"
                  className="pay-secondary-btn"
                  style={{ alignSelf: "center" }}
                  onClick={() => void doSync(true)}
                >
                  <span className="material-symbols-outlined">refresh</span>
                  Check status
                </button>
              )}

              {!isCancelled && (
                <button
                  type="button"
                  className="pay-secondary-btn"
                  style={{ alignSelf: "center" }}
                  onClick={() => void handleCancel()}
                >
                  <span className="material-symbols-outlined">close</span>
                  Cancel transaction
                </button>
              )}

              {isCancelled && (
                <button
                  type="button"
                  className="pay-cta"
                  onClick={() => navigate("/pricing")}
                >
                  <span>Back to pricing</span>
                  <span className="material-symbols-outlined">arrow_forward</span>
                </button>
              )}
            </section>

            {/* Trust strip */}
            <div className="pay-trust" aria-label="Security & support">
              <div>
                <span className="material-symbols-outlined ico-shield">
                  verified_user
                </span>
                PCI-DSS L1 · ISO 27001
              </div>
              <span>TLS 1.3 end-to-end</span>
              <div>
                <span className="material-symbols-outlined ico-support">
                  support_agent
                </span>
                Support 24/7
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

/* ============================================================
 * QR rendering policy
 * ------------------------------------------------------------
 * KHÔNG dùng QR placeholder SVG — QR phải đến từ gateway thật:
 *   - VietQR: BE trả URL `https://vietqr.io/image?account=...&amount=...`
 *             → render trực tiếp qua <img src>.
 *   - MoMo:    Gateway trả deeplink `momoapp://...?orderCode=...`
 *             → render nút "Open MoMo app" (không có QR vì MoMo yêu cầu
 *               mở app, không quét từ desktop).
 *   - Visa/MC: Form nhập số thẻ → không có QR.
 * Nếu gateway chưa trả qrData → UI hiện placeholder text + chuyển khoản
 * thủ công theo bankInfo hoặc nút mở app, không bao giờ tự dựng QR.
 * ============================================================ */
