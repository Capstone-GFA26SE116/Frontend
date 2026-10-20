import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../../auth/AuthContext";
import {
  getCurrentPlan,
  setCurrentPlan,
  type PlanKey,
} from "../../lib/api-client";
import { useStaggeredMount } from "../../hooks/useStaggeredMount";
import "./pricing.css";

/* ----- Types ----- */
type BillingCycle = "monthly" | "annual";
type PlanId = PlanKey;

interface PlanPricing {
  monthly: { price: string; period: string; total: string };
  annual: {
    price: string; // price per month when billed annually
    period: string;
    total: string; // full-year total
    savings: string;
  };
}

const PLAN_PRICING: Record<"pro" | "team", PlanPricing> = {
  pro: {
    monthly: {
      price: "149.000đ",
      period: "/ tháng",
      total: "149.000đ",
    },
    annual: {
      price: "119.000đ",
      period: "/ tháng",
      total: "1.428.000đ",
      savings: "Tiết kiệm 360.000đ / năm",
    },
  },
  team: {
    monthly: {
      price: "399.000đ",
      period: "/ tháng",
      total: "399.000đ",
    },
    annual: {
      price: "319.000đ",
      period: "/ tháng",
      total: "3.828.000đ",
      savings: "Tiết kiệm 960.000đ / năm",
    },
  },
};

/* ----- Trang Bảng giá & Lựa chọn gói -----
 * - Hero: title + subtitle + toggle monthly/annual.
 * - 3 plan cards: Starter (free), Pro (hero tier, nâng cấp -> /checkout),
 *   Team (chọn -> /checkout).
 * - Bảng so sánh tính năng (Feature Comparison Matrix).
 * - 2 FAQ ngắn.
 * - 3 proof cards: "Tiết kiệm 14h / tuần", "Tối ưu tải nhận thức", "Bảo toàn ngữ cảnh".
 *
 * KHÔNG có form thanh toán tại đây (đã tách sang /checkout).
 */
export function PricingPage() {
  const navigate = useNavigate();
  const { isAuthenticated } = useAuth();
  const [billing, setBilling] = useState<BillingCycle>("annual");

  /** Plan user đang dùng thật sự (chỉ meaningful khi đã login). */
  const currentPlan: PlanId | null = isAuthenticated
    ? getCurrentPlan()
    : null;

  /**
   * Auto-select default plan (chỉ khi user chưa login):
   *  - Chưa login           → Pro (gợi ý nâng cấp)
   *  - Đã login + chưa plan → Starter (Khởi đầu — gói user đang dùng)
   *  - Đã login + có plan   → plan hiện tại của user (nhưng sẽ render disabled)
   */
  const initialPlan: PlanId = (() => {
    if (!isAuthenticated) return "pro";
    return currentPlan ?? "starter";
  })();

  /* ----- Selected plan (click anywhere on card).
     Khi user đã login + có plan → mặc định null, vì plan đó sẽ tự "current"
     chứ không phải "selected". ---------- */
  const [selectedPlan, setSelectedPlan] = useState<PlanId | null>(
    currentPlan ? null : initialPlan,
  );
  /* Ripple position (px within card) for click feedback */
  const [ripple, setRipple] = useState<
    | { variant: PlanId; x: number; y: number; key: number }
    | null
  >(null);

  function selectPlan(variant: PlanId, e?: React.MouseEvent) {
    // Card đang là plan hiện tại → block toggle, không ripple.
    if (variant === currentPlan) return;

    // ripple effect
    if (e && e.currentTarget instanceof HTMLElement) {
      const rect = e.currentTarget.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      setRipple({ variant, x, y, key: Date.now() });
      // tự clear ripple sau khi animation chạy xong
      window.setTimeout(
        () => setRipple((r) => (r?.key === ripple?.key ? null : r)),
        650,
      );
    }
    setSelectedPlan((prev) => (prev === variant ? null : variant));
  }

  /**
   * Stagger groups — pattern giống Dashboard:
   *  - Page: 5 sections fade-up ngay khi mount (subtle, không delay nhiều).
   *  - Plans: 3 plan cards lệch nhau 110ms (Pro là hero -> giữa 0/1/2).
   *  - Compare: 8 dòng bảng lệch nhau 50ms -> hiệu ứng "dòng chảy" khi load.
   *  - FAQ + Proof: 2 + 3 cards fade-up nhẹ.
   *  - Price block: re-animate khi user toggle billing (trigger = billing).
   */
  const pageAnim = useStaggeredMount(0, 30);
  const plansAnim = useStaggeredMount(110, 160);
  const compareAnim = useStaggeredMount(50, 240, "compare"); // trigger cố định, chỉ chạy 1 lần
  const faqAnim = useStaggeredMount(80, 360);
  const proofAnim = useStaggeredMount(90, 460);
  // Price block: trigger lại mỗi khi billing đổi -> user thấy giá "chảy" lại.
  const priceAnim = useStaggeredMount(0, 0, billing);

  function goCheckout(plan: PlanId, cycle: BillingCycle) {
    // Sau này nối backend sẽ truyền plan + cycle sang trang checkout.
    navigate(`/checkout?plan=${plan}&cycle=${cycle}`);
  }

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
            Hệ thống Điều phối Nhận thức v2.4
          </span>
          <h1 className="pricing-title">
            Lựa chọn gói đồng hành thông minh cùng METANOIA
          </h1>
          <p className="pricing-subtitle">
            Tối ưu hóa thời gian và năng lượng cho Freelancer và Remote Worker
            với hệ thống AI tự tiến hóa. Hỗ trợ thanh toán nội địa tiện lợi
            qua VietQR, MoMo, VNPay và thẻ quốc tế.
          </p>

          {/* Billing toggle */}
          <div
            className="pricing-toggle"
            role="tablist"
            aria-label="Chu kỳ thanh toán"
          >
            <button
              type="button"
              role="tab"
              aria-selected={billing === "monthly"}
              onClick={() => setBilling("monthly")}
              className={
                "pricing-toggle-btn" +
                (billing === "monthly" ? " pricing-toggle-btn--active" : "")
              }
            >
              Thanh toán theo tháng
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={billing === "annual"}
              onClick={() => setBilling("annual")}
              className={
                "pricing-toggle-btn" +
                (billing === "annual" ? " pricing-toggle-btn--active" : "")
              }
            >
              <span>Thanh toán theo năm</span>
              <span className="pricing-save-pill">
                <span className="material-symbols-outlined">bolt</span>
                TIẾT KIỆM 20%
              </span>
            </button>
          </div>
        </div>
      </section>

      {/* 3 plan cards */}
      <section
        className={
          "pricing-section pricing-plans" +
          (pageAnim.mounted ? " pricing-plans--in" : "")
        }
      >
        <div className="pricing-container">
          <div className="pricing-plan-grid">
            <PlanCard
              variant="starter"
              eyebrow={isAuthenticated ? "Gói của bạn" : "Khởi đầu"}
              icon="person"
              title="Cá nhân khởi đầu"
              desc="Phù hợp cho freelancer và cá nhân làm việc độc lập bước đầu thiết lập kỷ luật và quản lý lịch trình cơ bản."
              price={currentPlan === "starter" ? "Đang dùng" : "0đ"}
              priceSuffix={
                currentPlan === "starter" ? "— miễn phí" : "/ trọn đời"
              }
              features={[
                { ok: true, text: "Sắp xếp theo hạn chót & khung giờ rảnh" },
                { ok: true, text: "Đồng bộ 1 Google Calendar" },
                { ok: true, text: "Tối đa 50 nhiệm vụ / tháng" },
                { ok: false, text: "Ma trận Eisenhower AI tự động" },
                { ok: false, text: "Vector memory lưu trữ ngữ cảnh" },
              ]}
              cta={
                isAuthenticated
                  ? currentPlan === "starter"
                    ? {
                        // User đã login + đang ở Starter → disabled
                        label: "Đang dùng gói này",
                        onClick: () => navigate("/dashboard"),
                        icon: "arrow_forward",
                      }
                    : currentPlan === "pro" || currentPlan === "team"
                      ? {
                          // User đã login + đang ở Pro/Team → downgrade về Starter
                          label: "Chuyển về Khởi đầu",
                          onClick: () => {
                            setCurrentPlan("starter");
                            navigate("/dashboard");
                          },
                          icon: "arrow_downward",
                        }
                      : {
                          // User đã login + CHƯA có plan → đăng ký Starter (miễn phí)
                          label: "Bắt đầu miễn phí",
                          onClick: () => {
                            setCurrentPlan("starter");
                            navigate("/dashboard");
                          },
                          icon: "arrow_forward",
                        }
                  : {
                      label: "Đăng ký miễn phí",
                      onClick: () => navigate("/register"),
                      icon: "arrow_forward",
                    }
              }
              current={currentPlan === "starter"}
              selected={selectedPlan === "starter"}
              onSelect={(e) => selectPlan("starter", e)}
              ripple={ripple && ripple.variant === "starter" ? ripple : null}
              animation={{
                mounted: plansAnim.mounted,
                delayStyle: plansAnim.getDelay(0),
              }}
            />

            <PlanCard
              variant="pro"
              eyebrow="Hiệu suất tối đa"
              icon="psychology"
              title="Chuyên nghiệp & Freelancer Pro"
              desc="Tối ưu năng suất cho remote worker và freelancer: giữ trạng thái Deep Work, quản lý đa khách hàng và cân bằng nhịp sinh học."
              billing={billing}
              pricing={PLAN_PRICING.pro}
              features={[
                {
                  ok: true,
                  text: "Ma trận Eisenhower AI tự động phân loại mức độ ưu tiên",
                  emphasize: true,
                },
                {
                  ok: true,
                  text: "Thuật toán K_bias tự tiến hóa theo nhịp sinh học",
                },
                {
                  ok: true,
                  text: "Đồng bộ tức thì SignalR qua đa thiết bị & lịch làm việc",
                },
                { ok: true, text: "Phân rã dự án & Macro Task không giới hạn" },
                {
                  ok: true,
                  text: "Tích hợp pgvector lưu trữ ngữ cảnh khách hàng trọn đời",
                },
              ]}
              cta={
                isAuthenticated
                  ? currentPlan === "pro"
                    ? {
                        // Đã login + đang ở Pro → disabled
                        label: "Đang dùng gói này",
                        onClick: () => navigate("/dashboard"),
                        icon: "arrow_forward",
                      }
                    : {
                        // Đã login + chưa ở Pro (starter/null/team) → nâng cấp lên Pro
                        label: "Nâng cấp lên Pro",
                        onClick: () => goCheckout("pro", billing),
                        primary: true,
                        icon: "arrow_forward",
                      }
                  : {
                      label: "Nâng cấp gói Pro ngay",
                      onClick: () => goCheckout("pro", billing),
                      primary: true,
                      icon: "arrow_forward",
                    }
              }
              current={currentPlan === "pro"}
              selected={selectedPlan === "pro"}
              onSelect={(e) => selectPlan("pro", e)}
              ripple={ripple && ripple.variant === "pro" ? ripple : null}
              animation={{
                mounted: plansAnim.mounted,
                delayStyle: plansAnim.getDelay(1),
              }}
              priceAnimation={{
                mounted: priceAnim.mounted,
                bumpKey: priceAnim.bumpKey,
              }}
            />

            <PlanCard
              variant="team"
              eyebrow="Hợp tác từ xa"
              icon="groups"
              title="Nhóm Chuyên gia & Studio"
              desc="Dành cho nhóm làm việc từ xa 4 - 6 thành viên, phối hợp dự án linh hoạt, điều phối deadline chéo và cân bằng tải công việc."
              billing={billing}
              pricing={PLAN_PRICING.team}
              features={[
                { ok: true, text: "Bao gồm 4 - 6 thành viên team remote" },
                { ok: true, text: "Phối hợp lịch biểu & cân bằng tải công việc nhóm" },
                { ok: true, text: "Bảng tổng phổ năng lượng & Burnout cảnh báo sớm" },
                {
                  ok: true,
                  text: "Xuất báo cáo tiến độ dự án & Timesheet 1-click (PDF/Notion/CSV)",
                },
                { ok: true, text: "Bộ nhớ ngữ cảnh dự án dùng chung (Shared Team Vector)" },
              ]}
              cta={
                isAuthenticated
                  ? currentPlan === "team"
                    ? {
                        // Đã login + đang ở Team → disabled
                        label: "Đang dùng gói này",
                        onClick: () => navigate("/dashboard"),
                        accent: true,
                        icon: "arrow_forward",
                      }
                    : {
                        // Đã login + chưa ở Team (starter/null/pro) → nâng cấp lên Team
                        label: "Chọn gói Studio",
                        onClick: () => goCheckout("team", billing),
                        accent: true,
                        icon: "arrow_forward",
                      }
                  : {
                      label: "Chọn gói Studio",
                      onClick: () => goCheckout("team", billing),
                      accent: true,
                      icon: "arrow_forward",
                    }
              }
              current={currentPlan === "team"}
              selected={selectedPlan === "team"}
              onSelect={(e) => selectPlan("team", e)}
              ripple={ripple && ripple.variant === "team" ? ripple : null}
              animation={{
                mounted: plansAnim.mounted,
                delayStyle: plansAnim.getDelay(2),
              }}
              priceAnimation={{
                mounted: priceAnim.mounted,
                bumpKey: priceAnim.bumpKey,
              }}
            />
          </div>
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
              So sánh chuyên sâu
            </span>
            <h2 className="pricing-section-title">
              Chi tiết đặc quyền theo từng gói
            </h2>
            <p className="pricing-section-desc">
              Được thiết kế chuẩn mực phục vụ từ cá nhân làm việc độc lập đến
              các remote studio và đội ngũ chuyên gia linh hoạt.
            </p>
          </div>

          <div className="pricing-table-wrap">
            <table className="pricing-table">
              <thead>
                <tr>
                  <th className="pricing-th-feature">Tính năng &amp; Năng lực AI</th>
                  <th className="pricing-th-plan">Cá nhân khởi đầu</th>
                  <th className="pricing-th-plan pricing-th-plan--hero">
                    Chuyên nghiệp &amp; Freelancer
                  </th>
                  <th className="pricing-th-plan">Nhóm Chuyên gia &amp; Studio</th>
                </tr>
              </thead>
              <tbody>
                <CompareRow
                  index={0}
                  animation={{
                    mounted: compareAnim.mounted,
                    delayStyle: compareAnim.getDelay(0),
                  }}
                  feature="Phân rã dự án (Macro → Sub-tasks)"
                  starter="50 nhiệm vụ / tháng"
                  pro={{ text: "Không giới hạn", tone: "primary", emphasis: true }}
                  team={{ text: "Không giới hạn", tone: "secondary", emphasis: true }}
                />
                <CompareRow
                  index={1}
                  animation={{
                    mounted: compareAnim.mounted,
                    delayStyle: compareAnim.getDelay(1),
                  }}
                  feature="Ma trận Eisenhower AI tự động"
                  starter={false}
                  pro
                  team
                />
                <CompareRow
                  index={2}
                  animation={{
                    mounted: compareAnim.mounted,
                    delayStyle: compareAnim.getDelay(2),
                  }}
                  feature="Thuật toán nhịp sinh học K_bias"
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
                  feature="Bộ nhớ ngữ cảnh pgvector"
                  starter="Lưu 7 ngày"
                  pro={{ text: "Vĩnh viễn (Personal)", tone: "primary", emphasis: true }}
                  team={{ text: "Vĩnh viễn (Shared Team)", tone: "secondary", emphasis: true }}
                />
                <CompareRow
                  index={4}
                  animation={{
                    mounted: compareAnim.mounted,
                    delayStyle: compareAnim.getDelay(4),
                  }}
                  feature="Đồng bộ đa thiết bị & Lịch"
                  starter="Google Calendar"
                  pro={{ text: "SignalR Real-time", tone: "plain" }}
                  team={{ text: "SignalR + Webhook Web", tone: "plain" }}
                />
                <CompareRow
                  index={5}
                  animation={{
                    mounted: compareAnim.mounted,
                    delayStyle: compareAnim.getDelay(5),
                  }}
                  feature="Cân bằng năng lượng & Cảnh báo quá tải"
                  starter={false}
                  pro={{ text: "Cá nhân", tone: "plain" }}
                  team={{
                    text: "Cả nhóm (Workload Balancing)",
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
                  feature="Báo cáo tiến độ dự án & Timesheet"
                  starter={false}
                  pro={{ text: "Markdown / PDF", tone: "plain" }}
                  team={{
                    text: "PDF + Notion + CSV",
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
                  feature="Hỗ trợ kỹ thuật"
                  starter="Cộng đồng Discord"
                  pro={{ text: "Ưu tiên < 2h", tone: "primary", emphasis: true }}
                  team={{ text: "Kỹ sư AI hỗ trợ 1:1", tone: "secondary", emphasis: true }}
                />
              </tbody>
            </table>
          </div>

          <div className="pricing-faq-grid">
            <FaqItem
              index={0}
              animation={{
                mounted: faqAnim.mounted,
                delayStyle: faqAnim.getDelay(0),
              }}
              icon="help_outline"
              q="Tôi có thể hủy đăng ký bất cứ lúc nào không?"
              a="Hoàn toàn có thể. Bạn có thể hủy gia hạn chỉ với 1 cú click trong cài đặt tài khoản. Tài khoản vẫn duy trì toàn bộ quyền lợi cho đến hết kỳ hạn đã thanh toán."
            />
            <FaqItem
              index={1}
              animation={{
                mounted: faqAnim.mounted,
                delayStyle: faqAnim.getDelay(1),
              }}
              icon="verified"
              q="Chính sách hoàn tiền trong 7 ngày áp dụng ra sao?"
              a="Nếu hệ thống điều phối AI không giúp bạn cải thiện ít nhất 20% hiệu suất làm việc và xử lý dự án trong 7 ngày đầu, bạn sẽ được hoàn 100% chi phí không cần giải trình."
            />
          </div>
        </div>
      </section>

      {/* 3 proof cards */}
      <section
        className={
          "pricing-section pricing-proof" +
          (pageAnim.mounted ? " pricing-proof--in" : "")
        }
      >
        <div className="pricing-container">
          <div className="pricing-proof-grid">
            <ProofCard
              index={0}
              animation={{
                mounted: proofAnim.mounted,
                delayStyle: proofAnim.getDelay(0),
              }}
              icon="speed"
              tone="primary"
              title="Tiết kiệm 14h / tuần"
              body="Theo dữ liệu đo đạc thực tế từ 1.200 kỹ sư và freelancer sử dụng cơ chế sắp xếp tác vụ tự động của METANOIA."
            />
            <ProofCard
              index={1}
              animation={{
                mounted: proofAnim.mounted,
                delayStyle: proofAnim.getDelay(1),
              }}
              icon="psychology_alt"
              tone="secondary"
              title="Tối ưu tải nhận thức"
              body="Thuật toán K_bias tự động hoãn các công việc có độ phức tạp cao vào những khung giờ năng lượng sụt giảm."
            />
            <ProofCard
              index={2}
              animation={{
                mounted: proofAnim.mounted,
                delayStyle: proofAnim.getDelay(2),
              }}
              icon="sync_saved_locally"
              tone="tertiary"
              title="Bảo toàn ngữ cảnh"
              body="Không bao giờ quên các quyết định quan trọng và yêu cầu khách hàng với bộ nhớ ngữ nghĩa vector hỗ trợ truy vấn tức thì."
            />
          </div>
        </div>
      </section>
    </div>
  );
}

/* =========================================================
 * Sub-components
 * ========================================================= */

interface FeatureItem {
  ok: boolean;
  text: string;
  emphasize?: boolean;
}

type PlanVariant = "starter" | "pro" | "team";

interface PlanCardProps {
  variant: PlanVariant;
  eyebrow: string;
  icon: string;
  title: string;
  desc: string;
  features: FeatureItem[];
  cta: {
    label: string;
    onClick?: () => void;
    disabled?: boolean;
    /** Primary style (tím - cho Pro). */
    primary?: boolean;
    /** Accent style (emerald gradient - cho Team). */
    accent?: boolean;
    icon?: string;
  };
  /* Pricing: nếu là starter thì price cố định; pro/team thì đổi theo billing */
  price?: string;
  priceSuffix?: string;
  billing?: BillingCycle;
  pricing?: PlanPricing;
  /** Animation cho cả card (mount stagger). */
  animation: {
    mounted: boolean;
    delayStyle: { animationDelay: string };
  };
  /** Animation riêng cho price block (re-run khi toggle billing). */
  priceAnimation?: {
    mounted: boolean;
    bumpKey: number;
  };
  /** Plan đang được chọn (highlight + "Selected" badge). */
  selected?: boolean;
  /**
   * Card này là plan user ĐANG dùng (chỉ khi đã login và có plan):
   *  - disabled: bỏ ripple, click không toggle selected, CTA disabled.
   *  - hiển thị badge "Đang dùng" thay "Đã chọn" / "Khuyên dùng".
   *  - CSS: opacity nhẹ + grayscale + cursor not-allowed.
   */
  current?: boolean;
  /** Click handler cho toàn bộ card (CTA vẫn hoạt động bình thường). */
  onSelect?: (e: React.MouseEvent) => void;
  /** Ripple effect: tọa độ trong card + key để remount animation. */
  ripple?: { x: number; y: number; key: number } | null;
}

function PlanCard(props: PlanCardProps) {
  const isPro = props.variant === "pro";
  const isStarter = props.variant === "starter";

  // Lấy giá hiển thị
  let displayPrice = props.price ?? "";
  let displayPeriod = props.priceSuffix ?? "";
  let originalPrice: string | null = null;
  let savingsNote: string | null = null;

  if (!isStarter && props.pricing && props.billing) {
    const tier = props.billing === "annual" ? props.pricing.annual : props.pricing.monthly;
    displayPrice = tier.price;
    displayPeriod = tier.period;
    if (props.billing === "annual") {
      originalPrice = isPro ? "149.000đ" : "399.000đ";
      savingsNote = isPro
        ? "Thanh toán năm 1.428.000đ/năm (Tiết kiệm 360.000đ)"
        : "Thanh toán năm 3.828.000đ/năm (Tiết kiệm 960.000đ)";
    }
  }

  return (
    <article
      className={
        "pricing-plan" +
        (isPro ? " pricing-plan--pro" : "") +
        (isStarter ? " pricing-plan--starter" : "") +
        (props.animation.mounted ? " pricing-plan--in" : "") +
        (props.selected ? " pricing-plan--selected" : "") +
        (props.current ? " pricing-plan--current" : "")
      }
      style={props.animation.delayStyle}
      onClick={props.current ? undefined : props.onSelect}
      role="button"
      tabIndex={props.cta.disabled || props.current ? -1 : 0}
      aria-pressed={props.selected ?? false}
      aria-current={props.current ? "true" : undefined}
      onKeyDown={(e) => {
        if (props.current || !props.onSelect) return;
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          props.onSelect(e as unknown as React.MouseEvent);
        }
      }}
    >
      {/* Ripple effect khi click (bỏ qua nếu card là plan hiện tại) */}
      {props.ripple && !props.current && (
        <span
          key={props.ripple.key}
          className="pricing-plan-ripple"
          style={{
            left: props.ripple.x,
            top: props.ripple.y,
          }}
          aria-hidden="true"
        />
      )}

      {/* Badge logic:
          - current: "Đang dùng ✓" (ưu tiên cao nhất)
          - selected: "Đã chọn"
          - pro mặc định: "Khuyên dùng" */}
      {props.current ? (
        <span className="pricing-plan-badge pricing-plan-badge--current">
          <span className="material-symbols-outlined">verified</span>
          Đang dùng
        </span>
      ) : props.selected ? (
        <span className="pricing-plan-badge pricing-plan-badge--selected">
          <span className="material-symbols-outlined">check_circle</span>
          Đã chọn
        </span>
      ) : isPro ? (
        <span className="pricing-plan-badge">
          <span className="material-symbols-outlined">auto_awesome</span>
          Khuyên dùng
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
            {props.eyebrow}
          </span>
          <span
            className={
              "pricing-plan-icon" +
              (isPro ? " pricing-plan-icon--pro" : "")
            }
            aria-hidden="true"
          >
            <span className="material-symbols-outlined">{props.icon}</span>
          </span>
        </div>

        <h3 className="pricing-plan-title">{props.title}</h3>
        <p className="pricing-plan-desc">{props.desc}</p>

        {/* Giá — có key bumpKey để remount khi toggle billing -> animation
            chạy lại mỗi lần chuyển monthly <-> annual. */}
        {isStarter ? (
          <div className="pricing-price pricing-price--static">
            <span className="pricing-price-amount">{displayPrice}</span>
            <span className="pricing-price-period">{displayPeriod}</span>
          </div>
        ) : (
          <div
            key={props.priceAnimation?.bumpKey ?? 0}
            className={
              "pricing-price pricing-price--dynamic" +
              (props.priceAnimation?.mounted
                ? " pricing-price--in"
                : "")
            }
          >
            <div className="pricing-price-row">
              <div className="pricing-price-main">
                <span className="pricing-price-amount">{displayPrice}</span>
                <span className="pricing-price-period">{displayPeriod}</span>
              </div>
              {originalPrice && (
                <div className="pricing-price-side">
                  <span className="pricing-price-original">{originalPrice}</span>
                  <span className="pricing-price-discount">-20%</span>
                </div>
              )}
            </div>
            {savingsNote && (
              <div className="pricing-price-savings">
                <span className="material-symbols-outlined">verified</span>
                <span>{savingsNote}</span>
              </div>
            )}
          </div>
        )}

        <div className="pricing-plan-divider" />

        <ul className="pricing-plan-features">
          {props.features.map((f, i) => (
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
          props.cta.onClick?.();
        }}
        disabled={props.cta.disabled || props.current}
        aria-disabled={props.cta.disabled || props.current || undefined}
        className={
          "pricing-plan-cta" +
          (props.cta.primary ? " pricing-plan-cta--primary" : "") +
          (props.cta.accent && !props.cta.primary
            ? " pricing-plan-cta--accent"
            : "") +
          (props.cta.disabled || props.current
            ? " pricing-plan-cta--disabled"
            : "")
        }
      >
        <span>
          {props.current
            ? props.variant === "starter"
              ? "Đang dùng gói này"
              : "Đang dùng gói này"
            : props.cta.label}
        </span>
        <span className="material-symbols-outlined">
          {props.current ? "verified" : props.cta.icon}
        </span>
      </button>
    </article>
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
  // string | CompareCell
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

function FaqItem({
  icon,
  q,
  a,
  animation,
}: {
  icon: string;
  q: string;
  a: string;
  index: number;
  animation: {
    mounted: boolean;
    delayStyle: { animationDelay: string };
  };
}) {
  return (
    <div
      className={"pricing-faq" + (animation.mounted ? " pricing-faq--in" : "")}
      style={animation.delayStyle}
    >
      <h4 className="pricing-faq-q">
        <span className="material-symbols-outlined pricing-faq-icon">
          {icon}
        </span>
        {q}
      </h4>
      <p className="pricing-faq-a">{a}</p>
    </div>
  );
}

function ProofCard({
  icon,
  title,
  body,
  tone,
  animation,
}: {
  icon: string;
  title: string;
  body: string;
  tone: "primary" | "secondary" | "tertiary";
  index: number;
  animation: {
    mounted: boolean;
    delayStyle: { animationDelay: string };
  };
}) {
  return (
    <div
      className={
        "pricing-proof-card" +
        (animation.mounted ? " pricing-proof-card--in" : "")
      }
      style={animation.delayStyle}
    >
      <div className="pricing-proof-head">
        <div className={`pricing-proof-icon pricing-proof-icon--${tone}`}>
          <span className="material-symbols-outlined">{icon}</span>
        </div>
        <span className="pricing-proof-title">{title}</span>
      </div>
      <p className="pricing-proof-body">{body}</p>
    </div>
  );
}
