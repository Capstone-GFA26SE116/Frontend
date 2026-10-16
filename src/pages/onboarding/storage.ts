/**
 * Onboarding — lưu lựa chọn cá nhân hoá của user sau lần đăng nhập đầu tiên.
 *
 * Dữ liệu được giữ trong localStorage, key `metanoia:onboarding`, value JSON
 * theo `OnboardingProfile`. Cho phép:
 *  - OnboardingRoute biết user đã hoàn tất chưa để bypass.
 *  - Dashboard (sau này) tham chiếu role/sectors/goals để gợi ý lịch.
 *  - Trang Settings (sau này) cho phép chỉnh sửa lại.
 *
 * Đây là bản mock, lưu local. Khi nối backend sẽ thay bằng POST /onboarding.
 */

const ONBOARDING_KEY = "metanoia:onboarding";

export type RoleId = "student" | "freelancer" | "engineer" | "self";

export type SectorId =
  | "it_programming"
  | "design_content"
  | "business_marketing"
  | "engineering_cs"
  | "language_social"
  | "biomed_health"
  | "other";

export type GoalId =
  | "deep_work"
  | "no_miss_deadline"
  | "google_calendar_sync"
  | "biorhythm_balance";

export interface OnboardingProfile {
  role: RoleId;
  sectors: SectorId[];
  goals: GoalId[];
  completedAt: string; // ISO string
}

function safeParse<T>(raw: string | null): T | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export function readOnboarding(): OnboardingProfile | null {
  if (typeof window === "undefined") return null;
  return safeParse<OnboardingProfile>(window.localStorage.getItem(ONBOARDING_KEY));
}

export function writeOnboarding(profile: OnboardingProfile): void {
  window.localStorage.setItem(ONBOARDING_KEY, JSON.stringify(profile));
}

export function clearOnboarding(): void {
  window.localStorage.removeItem(ONBOARDING_KEY);
}

/** Bảng nhãn + icon cho mỗi lựa chọn — render trong UI. */
export const ROLE_OPTIONS: ReadonlyArray<{
  id: RoleId;
  title: string;
  desc: string;
  icon: string;
}> = [
  {
    id: "student",
    title: "Sinh viên / Học viên",
    desc:
      "Quản lý lịch học, làm đồ án tốt nghiệp, bài tập lớn và rèn luyện thói quen học tập tập trung.",
    icon: "school",
  },
  {
    id: "freelancer",
    title: "Freelancer / Làm việc tự do",
    desc:
      "Cân bằng nhiều dự án khách hàng, theo dõi deadline độc lập và chống kiệt sức khi làm việc một mình.",
    icon: "laptop_mac",
  },
  {
    id: "engineer",
    title: "Kỹ sư / Nhà nghiên cứu",
    desc:
      "Phát triển dự án kỹ thuật chuyên sâu, bảo vệ khung giờ Deep Work và nghiên cứu học thuật.",
    icon: "memory",
  },
  {
    id: "self",
    title: "Khác / Tự học & Phát triển bản thân",
    desc:
      "Tối ưu hóa quỹ thời gian cá nhân và duy trì năng lượng dồi dào cho các mục tiêu dài hạn.",
    icon: "auto_awesome",
  },
];

export const SECTOR_OPTIONS: ReadonlyArray<{ id: SectorId; label: string }> = [
  { id: "it_programming", label: "Công nghệ thông tin / Lập trình" },
  { id: "design_content", label: "Thiết kế & Sáng tạo nội dung" },
  { id: "business_marketing", label: "Kinh tế / Marketing" },
  { id: "engineering_cs", label: "Kỹ thuật & Khoa học máy tính" },
  { id: "language_social", label: "Ngôn ngữ & Xã hội" },
  { id: "biomed_health", label: "Y sinh & Sức khỏe" },
  { id: "other", label: "Khác..." },
];

export const GOAL_OPTIONS: ReadonlyArray<{
  id: GoalId;
  title: string;
  desc: string;
}> = [
  {
    id: "deep_work",
    title: "Bảo vệ các khung giờ tập trung sâu (Deep Work)",
    desc: "Tự động chặn thông báo phiền nhiễu khi đang xử lý việc trọng tâm",
  },
  {
    id: "no_miss_deadline",
    title: "Không bị trễ deadline bài tập / dự án",
    desc: "Phân bổ tiến độ thông minh từng ngày, loại bỏ dồn ứ giờ chót",
  },
  {
    id: "google_calendar_sync",
    title: "Tự động xếp lịch thông minh đồng bộ Google Calendar",
    desc: "Kế thừa toàn bộ sự kiện hiện có và tự tìm khoảng trống làm việc",
  },
  {
    id: "biorhythm_balance",
    title: "Cân bằng nhịp sinh học, tránh thức đêm kiệt sức",
    desc: "Nhắc nhở thả lỏng và duy trì chu kỳ nghỉ ngơi lành mạnh",
  },
];
