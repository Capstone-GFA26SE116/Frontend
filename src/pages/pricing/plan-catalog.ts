import type { SubscriptionPlanDto } from "../../lib/api-client";

/* ============================================================
 * Catalogue gói — map từ plan của BE sang UI bảng giá.
 * ----------------------------------------------------------
 * BE là nguồn sự thật cho: tên, giá, thời hạn, hạn mức AI, dung lượng,
 * số dự án tối đa.
 *
 * FE giữ bổ sung: mô tả, icon, danh sách đặc quyền chi tiết, và
 * mapping planId -> "tier" để giữ nguyên bảng so sánh + highlight hero
 * như thiết kế cũ (gói Pro được nâng cao).
 *
 * Quy tắc mua (theo spec BE):
 *   - Chỉ gói `isActive === true` VÀ `price > 0` mới có nút mua.
 *   - Gói Miễn phí (price = 0) không có nút mua.
 * ============================================================ */

/** "Tier" của gói — dùng để style + ánh xạ đặc quyền. */
export type PlanTier = "free" | "pro" | "team";

export interface PlanPrivilege {
  ok: boolean;
  text: string;
  emphasize?: boolean;
}

export interface PlanLimits {
  tasks: string;
  ai: string;
  memory: string;
  storage: string;
  projects: string;
  support: string;
}

export interface PlanView {
  /** Id chuẩn của BE (uuid) — dùng cho POST /api/payments/checkout. */
  id: string;
  /** Tên hiển thị từ BE (có thể null → fallback tên tiếng Việt). */
  name: string;
  /** Tier để style. */
  tier: PlanTier;
  /** Icon Material Symbols. */
  icon: string;
  /** Eyebrow nhỏ trên card. */
  eyebrow: string;
  /** Mô tả dài. */
  desc: string;
  /** Giá (VND). */
  price: number;
  /** Thời hạn 1 chu kỳ (ngày). */
  durationDays: number;
  /** Số tháng tương đương (để hiển thị "/ tháng"). */
  months: number;
  /** null = không giới hạn. */
  aiCallLimit: number | null;
  storageLimitMb: number;
  /** null = không giới hạn. */
  projectLimit: number | null;
  isActive: boolean;
  /** true = gói này mua được (isActive && price > 0). */
  purchasable: boolean;
  /** Danh sách đặc quyền (chi tiết). */
  features: PlanPrivilege[];
  /** Đối chiếu hạn mức định lượng trong bảng so sánh. */
  limits: PlanLimits;
}

/* ---------- Dữ liệu mô tả (FE-owned, không phải từ BE) ---------- */

interface PlanMeta {
  tier: PlanTier;
  icon: string;
  eyebrow: string;
  desc: string;
  features: PlanPrivilege[];
  limits: PlanLimits;
}

/**
 * Metadata cho từng tier. Gom theo tier vì BE có thể đổi tên gói
 * (VD: "Gói Cá Nhân" → "Starter") mà vẫn giữ nguyên quyền.
 */
const TIER_META: Record<PlanTier, PlanMeta> = {
  free: {
    tier: "free",
    icon: "person",
    eyebrow: "Starter",
    desc: "For freelancers and solo workers who want to build a routine and get basic schedule control.",
    features: [
      { ok: true, text: "Sorting by deadline & available time slots" },
      { ok: true, text: "One Google Calendar sync" },
      { ok: true, text: "AI Eisenhower matrix — automatic priority ranking" },
      { ok: false, text: "Vector memory for context storage" },
    ],
    limits: {
      tasks: "50 tasks / month",
      ai: "—",
      memory: "7-day retention",
      storage: "—",
      projects: "—",
      support: "Discord community",
    },
  },
  pro: {
    tier: "pro",
    icon: "psychology",
    eyebrow: "Peak productivity",
    desc: "Built for remote workers and freelancers: protect deep work, manage multiple clients and balance your biological rhythm.",
    features: [
      {
        ok: true,
        text: "AI Eisenhower matrix — automatic priority ranking",
        emphasize: true,
      },
      { ok: true, text: "K_bias algorithm that evolves with your biological rhythm" },
      {
        ok: true,
        text: "Real-time SignalR sync across devices & schedules",
      },
      { ok: true, text: "Unlimited project & macro-task breakdown" },
      {
        ok: true,
        text: "pgvector integration — lifetime client context storage",
      },
    ],
    limits: {
      tasks: "Unlimited",
      ai: "Yes",
      memory: "Lifetime (Personal)",
      storage: "—",
      projects: "Unlimited",
      support: "Priority < 2h",
    },
  },
  team: {
    tier: "team",
    icon: "groups",
    eyebrow: "Remote collaboration",
    desc: "For remote teams of 4–6 members: flexible project coordination, cross-team deadlines and balanced workloads.",
    features: [
      { ok: true, text: "Includes 4–6 remote team members" },
      { ok: true, text: "Shared scheduling & team workload balancing" },
      { ok: true, text: "Energy overview & early burnout warnings" },
      {
        ok: true,
        text: "One-click project progress & timesheet export (PDF/Notion/CSV)",
      },
      { ok: true, text: "Shared project context memory (Shared Team Vector)" },
    ],
    limits: {
      tasks: "Unlimited",
      ai: "Yes",
      memory: "Lifetime (Shared Team)",
      storage: "—",
      projects: "Unlimited",
      support: "1:1 AI engineer support",
    },
  },
};

/**
 * English display names per tier.
 *
 * The API still returns Vietnamese plan names ("Miễn phí", "Tiêu chuẩn"…),
 * so the UI always shows the English tier name to keep /pricing fully
 * in English.
 */
export const TIER_DISPLAY_NAME: Record<PlanTier, string> = {
  free: "Free",
  pro: "Pro",
  team: "Team",
};

/**
 * Suy ra tier từ tên gói của BE.
 *
 * BE hiện tại trả ("Miễn phí", "test", "Tiêu chuẩn"). Ngoài ra vẫn hỗ trợ
 * tên cũ ("Gói Miễn Phí", "Gói Pro", "Gói Nhóm") và tiếng Anh
 * ("Free", "Professional", "Team") — nhận diện theo từ khoá.
 */
export function inferTier(name: string | null, price: number): PlanTier {
  const n = (name ?? "").trim().toLowerCase();
  if (/team|studio|nhóm|chuyên gia|organization|doanh nghiệp/.test(n)) {
    return "team";
  }
  if (/pro|professional|chuyên nghiệp|freelancer|tiêu chuẩn|standard/.test(n)) {
    return "pro";
  }
  if (price === 0) return "free";
  if (/free|miễn phí|khởi đầu|starter|basic|cá nhân/.test(n)) return "free";
  // Gói trả phí không nhận diện được (VD: "test") -> coi như pro.
  return "pro";
}

/** Số tháng tương đương từ `durationDays` (BE có thể dùng 30/90/365). */
export function durationToMonths(durationDays: number): number {
  if (durationDays >= 360) return 12;
  if (durationDays >= 85) return 3;
  if (durationDays >= 28) return 1;
  return Math.max(1, Math.round(durationDays / 30));
}

/** Label for a billing period: "30 days", "3 months", "12 months". */
export function durationLabel(durationDays: number): string {
  const m = durationToMonths(durationDays);
  if (durationDays >= 360) return m === 12 ? "12 months" : `${m} months`;
  if (durationDays >= 28) return `${m} months`;
  return `${durationDays} days`;
}

/** Units that are never pluralised (MB, GB, …). */
const NON_COUNTABLE_UNITS = new Set(["mb", "gb", "tb", "kb"]);

/**
 * Format a numeric limit (null = unlimited).
 *
 * Pass a SINGULAR unit ("call", "project"): a trailing "s" is added unless
 * the value is exactly 1. Non-countable units ("MB") stay as-is.
 */
export function formatLimit(value: number | null, unit: string): string {
  if (value == null) return "Unlimited";
  const plural = NON_COUNTABLE_UNITS.has(unit.toLowerCase())
    ? unit
    : value === 1
      ? unit
      : `${unit}s`;
  return `${value.toLocaleString("en-US")} ${plural}`;
}

/** Format VND amount: 1,428,000₫ */
export function formatVnd(amount: number): string {
  return `${amount.toLocaleString("en-US")}₫`;
}

/** Chuyển 1 plan của BE thành view model cho UI. */
export function toPlanView(plan: SubscriptionPlanDto): PlanView {
  const tier = inferTier(plan.name, plan.price);
  const meta = TIER_META[tier];
  const months = durationToMonths(plan.durationDays);

  return {
    id: plan.id,
    // Always show the English tier name — the API plan names are in
    // Vietnamese, and /pricing is fully in English.
    name: TIER_DISPLAY_NAME[tier],
    tier,
    icon: meta.icon,
    eyebrow: meta.eyebrow,
    desc: meta.desc,
    price: plan.price,
    durationDays: plan.durationDays,
    months,
    aiCallLimit: plan.aiCallLimit,
    storageLimitMb: plan.storageLimitMb,
    projectLimit: plan.projectLimit,
    isActive: plan.isActive,
    purchasable: plan.isActive && plan.price > 0,
    features: meta.features,
    limits: meta.limits,
  };
}

/**
 * Sắp xếp plan theo thứ tự hiển thị: free -> pro -> team.
 * Gói không mua được (isActive = false) đẩy xuống cuối.
 */
export function sortPlanViews(plans: PlanView[]): PlanView[] {
  const order: Record<PlanTier, number> = { free: 0, pro: 1, team: 2 };
  return [...plans].sort((a, b) => {
    if (a.purchasable !== b.purchasable) return a.purchasable ? -1 : 1;
    return order[a.tier] - order[b.tier];
  });
}
