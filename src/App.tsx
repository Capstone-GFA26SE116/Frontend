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
import { ProjectDetailPage } from "./pages/project-detail/ProjectDetail";
import { PlanningPage } from "./pages/planning/Planning";
import { SchedulePage } from "./pages/schedule/Schedule";
import { CopilotPage } from "./pages/copilot/Copilot";
import { PaymentsPage } from "./pages/payments/Payments";
import {
  ProtectedRoute,
  RedirectIfAuthenticated,
} from "./router/ProtectedRoute";

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
 *  /schedule          -> Cần đăng nhập + đã hoàn tất onboarding (Lịch Tuần & Tháng)
 *  /copilot           -> Cần đăng nhập + đã hoàn tất onboarding (AI Schedule Coordinator)
 *
 * Mọi route khác đều fallback về Landing.
 */
function App() {
  return (
    <Routes>
      <Route path="/" element={<LandingPage />} />

      <Route
        element={
          <RedirectIfAuthenticated>
            <AuthLayout />
          </RedirectIfAuthenticated>
        }
      >
        <Route path="/login" element={<LoginPage />} />
        <Route path="/register" element={<RegisterPage />} />
      </Route>

      {/* SiteLayout: header + footer chuẩn, cho trang marketing public. */}
      <Route element={<SiteLayout />}>
        <Route path="/pricing" element={<PricingPage />} />
        <Route path="/checkout" element={<PaymentsPage />} />
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
        <Route path="/onboarding" element={<OnboardingPage />} />
        <Route path="/dashboard" element={<DashboardPage />} />
        <Route path="/projects" element={<ProjectsPage />} />
        <Route path="/projects/:projectId" element={<ProjectDetailPage />} />
        <Route path="/projects/:projectId/planning" element={<PlanningPage />} />
        <Route path="/projects/:projectId/schedule" element={<SchedulePage />} />
        <Route path="/schedule" element={<SchedulePage />} />
        <Route path="/copilot" element={<CopilotPage />} />
      </Route>

      <Route path="*" element={<LandingPage />} />
    </Routes>
  );
}

export default App;
