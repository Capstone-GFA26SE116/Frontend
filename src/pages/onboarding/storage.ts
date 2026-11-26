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
    title: "Student / Trainee",
    desc:
      "Manage your class schedule, graduation projects, large assignments and build focused study habits.",
    icon: "school",
  },
  {
    id: "freelancer",
    title: "Freelancer / Self-employed",
    desc:
      "Balance multiple client projects, track independent deadlines and avoid burnout while working alone.",
    icon: "laptop_mac",
  },
  {
    id: "engineer",
    title: "Engineer / Researcher",
    desc:
      "Develop deep technical projects, protect your Deep Work hours and conduct academic research.",
    icon: "memory",
  },
  {
    id: "self",
    title: "Other / Self-learning & personal growth",
    desc:
      "Optimise your personal time budget and keep enough energy for your long-term goals.",
    icon: "auto_awesome",
  },
];

export const SECTOR_OPTIONS: ReadonlyArray<{ id: SectorId; label: string }> = [
  { id: "it_programming", label: "Information Technology / Programming" },
  { id: "design_content", label: "Design & Content Creation" },
  { id: "business_marketing", label: "Business / Marketing" },
  { id: "engineering_cs", label: "Engineering & Computer Science" },
  { id: "language_social", label: "Languages & Social Sciences" },
  { id: "biomed_health", label: "Biomedicine & Health" },
  { id: "other", label: "Other..." },
];

export const GOAL_OPTIONS: ReadonlyArray<{
  id: GoalId;
  title: string;
  desc: string;
}> = [
  {
    id: "deep_work",
    title: "Protect deep focus hours (Deep Work)",
    desc: "Automatically block distracting notifications while you handle your most important work",
  },
  {
    id: "no_miss_deadline",
    title: "Never miss an assignment or project deadline",
    desc: "Spread progress intelligently across the days so nothing piles up at the last minute",
  },
  {
    id: "google_calendar_sync",
    title: "Smart scheduling synced with Google Calendar",
    desc: "Inherit all your existing events and automatically find free time to work in",
  },
  {
    id: "biorhythm_balance",
    title: "Balance your biorhythm and avoid late nights",
    desc: "Gentle reminders and a healthy rest cycle that keeps you sharp",
  },
];
