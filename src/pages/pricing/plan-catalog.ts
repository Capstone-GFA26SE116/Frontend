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
    eyebrow: "Khởi đầu",
    desc: "Phù hợp cho freelancer và cá nhân làm việc độc lập bước đầu thiết lập kỷ luật và quản lý lịch trình cơ bản.",
    features: [
      { ok: true, text: "Sắp xếp theo hạn chót & khung giờ rảnh" },
      { ok: true, text: "Đồng bộ 1 Google Calendar" },
      { ok: true, text: "Ma trận Eisenhower AI tự động phân loại mức độ ưu tiên" },
      { ok: false, text: "Vector memory lưu trữ ngữ cảnh" },
    ],
    limits: {
      tasks: "50 nhiệm vụ / tháng",
      ai: "—",
      memory: "Lưu 7 ngày",
      storage: "—",
      projects: "—",
      support: "Cộng đồng Discord",
    },
  },
  pro: {
    tier: "pro",
    icon: "psychology",
    eyebrow: "Hiệu suất tối đa",
    desc: "Tối ưu năng suất cho remote worker và freelancer: giữ trạng thái Deep Work, quản lý đa khách hàng và cân bằng nhịp sinh học.",
    features: [
      {
        ok: true,
        text: "Ma trận Eisenhower AI tự động phân loại mức độ ưu tiên",
        emphasize: true,
      },
      { ok: true, text: "Thuật toán K_bias tự tiến hóa theo nhịp sinh học" },
      {
        ok: true,
        text: "Đồng bộ tức thì SignalR qua đa thiết bị & lịch làm việc",
      },
      { ok: true, text: "Phân rã dự án & Macro Task không giới hạn" },
      {
        ok: true,
        text: "Tích hợp pgvector lưu trữ ngữ cảnh khách hàng trọn đời",
      },
    ],
    limits: {
      tasks: "Không giới hạn",
      ai: "Có",
      memory: "Vĩnh viễn (Personal)",
      storage: "—",
      projects: "Không giới hạn",
      support: "Ưu tiên < 2h",
    },
  },
  team: {
    tier: "team",
    icon: "groups",
    eyebrow: "Hợp tác từ xa",
    desc: "Dành cho nhóm làm việc từ xa 4 - 6 thành viên, phối hợp dự án linh hoạt, điều phối deadline chéo và cân bằng tải công việc.",
    features: [
      { ok: true, text: "Bao gồm 4 - 6 thành viên team remote" },
      { ok: true, text: "Phối hợp lịch biểu & cân bằng tải công việc nhóm" },
      { ok: true, text: "Bảng tổng phổ năng lượng & Burnout cảnh báo sớm" },
      {
        ok: true,
        text: "Xuất báo cáo tiến độ dự án & Timesheet 1-click (PDF/Notion/CSV)",
      },
      { ok: true, text: "Bộ nhớ ngữ cảnh dự án dùng chung (Shared Team Vector)" },
    ],
    limits: {
      tasks: "Không giới hạn",
      ai: "Có",
      memory: "Vĩnh viễn (Shared Team)",
      storage: "—",
      projects: "Không giới hạn",
      support: "Kỹ sư AI hỗ trợ 1:1",
    },
  },
};

/** Tên hiển thị tiếng Việt fallback khi BE trả `name = null`. */
const TIER_FALLBACK_NAME: Record<PlanTier, string> = {
  free: "Cá nhân khởi đầu",
  pro: "Chuyên nghiệp & Freelancer Pro",
  team: "Nhóm Chuyên gia & Studio",
};

/**
 * Suy ra tier từ tên gói của BE.
 *
 * BE đặt tên tiếng Việt ("Gói Miễn Phí", "Gói Pro", "Gói Nhóm") hoặc
 * tiếng Anh ("Free", "Professional", "Team") — ta nhận diện theo từ khoá.
 */
export function inferTier(name: string | null, price: number): PlanTier {
  const n = (name ?? "").trim().toLowerCase();
  if (/team|studio|nhóm|chuyên gia|organization|doanh nghiệp/.test(n)) {
    return "team";
  }
  if (/pro|professional|chuyên nghiệp|freelancer/.test(n)) return "pro";
  if (price === 0) return "free";
  if (/free|miễn phí|khởi đầu|starter|basic|cá nhân/.test(n)) return "free";
  // Gói trả phí không nhận diện được -> coi như pro (gói trung gian).
  return "pro";
}

/** Số tháng tương đương từ `durationDays` (BE có thể dùng 30/90/365). */
export function durationToMonths(durationDays: number): number {
  if (durationDays >= 360) return 12;
  if (durationDays >= 85) return 3;
  if (durationDays >= 28) return 1;
  return Math.max(1, Math.round(durationDays / 30));
}

/** Nhãn thời hạn hiển thị: "30 ngày", "3 tháng", "12 tháng". */
export function durationLabel(durationDays: number): string {
  const m = durationToMonths(durationDays);
  if (durationDays >= 360) return m === 12 ? "12 tháng" : `${m} tháng`;
  if (durationDays >= 28) return `${m} tháng`;
  return `${durationDays} ngày`;
}

/** Định dạng hạn mức số (null = không giới hạn). */
export function formatLimit(value: number | null, unit: string): string {
  if (value == null) return "Không giới hạn";
  return `${value.toLocaleString("vi-VN")} ${unit}`;
}

/** Định dạng tiền VND: 149.000đ */
export function formatVnd(amount: number): string {
  return `${amount.toLocaleString("vi-VN")}đ`;
}

/** Chuyển 1 plan của BE thành view model cho UI. */
export function toPlanView(plan: SubscriptionPlanDto): PlanView {
  const tier = inferTier(plan.name, plan.price);
  const meta = TIER_META[tier];
  const months = durationToMonths(plan.durationDays);

  return {
    id: plan.id,
    name: plan.name?.trim() || TIER_FALLBACK_NAME[tier],
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
