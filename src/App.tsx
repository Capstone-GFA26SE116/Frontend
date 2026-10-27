import { Route, Routes } from "react-router-dom";
import { AuthLayout } from "./layouts/AuthLayout";
import { SiteLayout } from "./layouts/SiteLayout";
import { LoginPage } from "./pages/login/Login";
import { RegisterPage } from "./pages/register/Register";
import { LandingPage } from "./pages/landing/Landing";
import { DashboardPage } from "./pages/dashboard/Dashboard";
import { OnboardingPage } from "./pages/onboarding/Onboarding";
import { PricingPage } from "./pages/pricing/Pricing";
import { ProjectsPage } from "./pages/projects/Projects";
import { ClientsPage } from "./pages/clients/Clients";
import { ProjectDetailPage } from "./pages/project-detail/ProjectDetail";
import { PlanningPage } from "./pages/planning/Planning";
import { MilestonesPage } from "./pages/milestones/Milestones";
import { SchedulePage } from "./pages/schedule/Schedule";
import { CopilotPage } from "./pages/copilot/Copilot";
import { PaymentsPage } from "./pages/payments/Payments";
import { ProfilePage } from "./pages/profile/Profile";
import { GoogleCalendarCallbackPage } from "./pages/auth/GoogleCalendarCallback";
import {
  ProtectedRoute,
  RedirectIfAuthenticated,
} from "./router/ProtectedRoute";
import { ErrorBoundary } from "./components/ErrorBoundary";
import type { ReactNode } from "react";

/**
 * Bọc mỗi route trong ErrorBoundary để 1 trang lỗi không làm trắng toàn bộ ứng
 * dụng — người dùng vẫn điều hướng được sang trang khác.
 */
function guarded(label: string, node: ReactNode) {
  return <ErrorBoundary label={label}>{node}</ErrorBoundary>;
}

/**
 * Bảng định tuyến chính của METANOIA.
 *
 *  /                  -> Landing (công khai)
 *  /pricing           -> Bảng giá & Lựa chọn gói (công khai, SiteLayout)
 *  /checkout          -> Trang thanh toán (public, SiteLayout) — nhận ?plan=pro&cycle=annual
 *  /login             -> Trang đăng nhập (nếu đã login -> /dashboard)
 *  /register          -> Trang đăng ký (nếu đã login -> /dashboard)
 *  /onboarding        -> Cần đăng nhập; lần đầu sẽ được ProtectedRoute đẩy vào đây
 *  /dashboard         -> Cần đăng nhập + đã hoàn tất onboarding (Lịch ngày)
 *  /projects          -> Cần đăng nhập + đã hoàn tất onboarding (Không gian dự án)
 *  /projects/:id/milestones -> Quản lý milestone của dự án
 *  /clients           -> Cần đăng nhập + đã hoàn tất onboarding (Danh bạ khách hàng)
 *  /schedule          -> Cần đăng nhập + đã hoàn tất onboarding (Lịch Tuần & Tháng)
 *  /copilot           -> Cần đăng nhập + đã hoàn tất onboarding (AI Schedule Coordinator)
 *  /profile           -> Cần đăng nhập + đã hoàn tất onboarding (Hồ sơ người dùng)
 *
 * Mọi route khác đều fallback về Landing.
 */
function App() {
  return (
    <Routes>
      <Route path="/" element={guarded("Trang chủ", <LandingPage />)} />

      <Route
        element={
          <RedirectIfAuthenticated>
            <AuthLayout />
          </RedirectIfAuthenticated>
        }
      >
        <Route path="/login" element={guarded("Đăng nhập", <LoginPage />)} />
        <Route path="/register" element={guarded("Đăng ký", <RegisterPage />)} />
      </Route>

      {/* SiteLayout: header + footer chuẩn, cho trang marketing public. */}
      <Route element={<SiteLayout />}>
        <Route path="/pricing" element={guarded("Bảng giá", <PricingPage />)} />
        <Route path="/checkout" element={guarded("Thanh toán", <PaymentsPage />)} />
      </Route>

      {/* Dashboard + Onboarding: cần auth, vẫn dùng SiteLayout để có
          header/footer chuẩn + nav active. ProtectedRoute bọc ngoài. */}
      <Route
        element={
          <ProtectedRoute>
            <SiteLayout />
          </ProtectedRoute>
        }
      >
        <Route path="/onboarding" element={guarded("Thiết lập", <OnboardingPage />)} />
        <Route path="/dashboard" element={guarded("Lịch ngày", <DashboardPage />)} />
        <Route path="/projects" element={guarded("Dự án", <ProjectsPage />)} />
        <Route path="/clients" element={guarded("Khách hàng", <ClientsPage />)} />
        <Route
          path="/projects/:projectId"
          element={guarded("Chi tiết dự án", <ProjectDetailPage />)}
        />
        <Route
          path="/projects/:projectId/planning"
          element={guarded("Lập kế hoạch", <PlanningPage />)}
        />
        <Route
          path="/projects/:projectId/milestones"
          element={guarded("Milestones", <MilestonesPage />)}
        />
        <Route
          path="/projects/:projectId/schedule"
          element={guarded("Lịch dự án", <SchedulePage />)}
        />
        <Route path="/schedule" element={guarded("Lịch tuần & tháng", <SchedulePage />)} />
        <Route path="/copilot" element={guarded("AI Copilot", <CopilotPage />)} />
        <Route path="/profile" element={guarded("Hồ sơ", <ProfilePage />)} />
        {/* Google Calendar OAuth callback — BE redirect về đây kèm ?calendar=... */}
        <Route
          path="/auth/google/callback"
          element={guarded("Google Calendar", <GoogleCalendarCallbackPage />)}
        />
      </Route>

      <Route path="*" element={guarded("Trang chủ", <LandingPage />)} />
    </Routes>
  );
}

export default App;
