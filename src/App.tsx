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
import {
  PaymentCancelPage,
  PaymentSuccessPage,
} from "./pages/payments/PaymentResult";
import { ProfilePage } from "./pages/profile/Profile";
import { NotificationsPage } from "./pages/notifications/Notifications";
import { GoogleCalendarCallbackPage } from "./pages/auth/GoogleCalendarCallback";
import {
  ProtectedRoute,
  RedirectIfAuthenticated,
} from "./router/ProtectedRoute";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { NotificationsProvider } from "./components/focus/notifications-context";
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
 *  /payment/success   -> Kết quả thanh toán thành công (PayOS ReturnUrl)
 *  /payment/cancel    -> Đã hủy thanh toán (PayOS CancelUrl)
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
 *  /notifications     -> Cần đăng nhập + đã hoàn tất onboarding (Hộp thư thông báo)
 *
 * Mọi route khác đều fallback về Landing.
 */
function App() {
  return (
    /*
     * `NotificationsProvider` bọc TOÀN BỘ app (không chỉ route đã đăng nhập)
     * vì:
     *  1. `SiteLayout` dùng chung cho trang public (`/pricing`) và trang đã
     *     đăng nhập → nếu provider chỉ bọc route protected, trang public sẽ
     *     crash khi `useNotificationsContext()` không tìm thấy provider.
     *  2. Chỉ có 1 SignalR connection cho toàn app → không nhận trùng thông
     *     báo, badge luôn khớp server.
     *
     * Provider tự biết user đã đăng nhập chưa (qua `useAuth`) nên ở trang
     * public nó không gọi API nào.
     */
    <NotificationsProvider>
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
      </Route>

      {/* Kết quả thanh toán — PayOS redirect về đây (ReturnUrl / CancelUrl).
          Cần đăng nhập vì FE phải gọi sync + refetch /api/me. */}
      <Route
        element={
          <ProtectedRoute>
            <SiteLayout />
          </ProtectedRoute>
        }
      >
        <Route
          path="/payment/success"
          element={guarded("Thanh toán thành công", <PaymentSuccessPage />)}
        />
        <Route
          path="/payment/cancel"
          element={guarded("Đã hủy thanh toán", <PaymentCancelPage />)}
        />
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
        <Route
          path="/notifications"
          element={guarded("Thông báo", <NotificationsPage />)}
        />
        {/* Google Calendar OAuth callback — BE redirect về đây kèm ?calendar=... */}
        <Route
          path="/auth/google/callback"
          element={guarded("Google Calendar", <GoogleCalendarCallbackPage />)}
        />
      </Route>

      <Route path="*" element={guarded("Trang chủ", <LandingPage />)} />
      </Routes>
    </NotificationsProvider>
  );
}

export default App;
