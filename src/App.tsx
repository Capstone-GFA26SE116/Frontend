import { Route, Navigate, Routes } from "react-router-dom";
import { AuthLayout } from "./layouts/AuthLayout";
import { SiteLayout } from "./layouts/SiteLayout";
import { LoginPage } from "./pages/login/Login";
import { RegisterPage } from "./pages/register/Register";
import { DashboardPage } from "./pages/dashboard/Dashboard";
import { BriefingPage } from "./pages/briefing/Briefing";
import { OnboardingPage } from "./pages/onboarding/Onboarding";
import { PricingPage } from "./pages/pricing/Pricing";
import { ProjectsPage } from "./pages/projects/Projects";
import { GroupsPage } from "./pages/groups/Groups";
import { GroupDetailPage } from "./pages/groups/GroupDetail";
import { GroupAiPlannerPage } from "./pages/groups/GroupAiPlannerPage";
import { MyGroupTasksPage } from "./pages/groups/MyGroupTasks";
import { ProjectAiChatPage } from "./pages/project-ai-chat/ProjectAiChat";
import { ProjectImportPage } from "./pages/project-import/ProjectImport";
import { ChatHistoryPage } from "./pages/chat-history/ChatHistory";
import { AnalyticsPage } from "./pages/analytics/Analytics";
import { ProductiveHoursPage } from "./pages/productive-hours/ProductiveHours";
import { ClientsPage } from "./pages/clients/Clients";
import { ProjectDetailPage } from "./pages/project-detail/ProjectDetail";
import { PlanningPage } from "./pages/planning/Planning";
import { MilestonesPage } from "./pages/milestones/Milestones";
import { SchedulePage } from "./pages/schedule/Schedule";
import { CopilotPage } from "./pages/copilot/Copilot";
import { ProjectChatPage } from "./pages/project-chat/ProjectChat";
import { ProjectDocumentsPage } from "./pages/documents/ProjectDocuments";
import { MyDocumentsPage } from "./pages/documents/MyDocuments";
import {
  PaymentCancelPage,
  PaymentSuccessPage,
} from "./pages/payments/PaymentResult";
import { ProfilePage } from "./pages/profile/Profile";
import { NotificationsPage } from "./pages/notifications/Notifications";
import { GoogleCalendarCallbackPage } from "./pages/auth/GoogleCalendarCallback";
import { AdminLayout } from "./pages/admin/AdminLayout";
import { AdminOverview } from "./pages/admin/AdminOverview";
import { AdminRevenue } from "./pages/admin/AdminRevenue";
import { AdminUsers } from "./pages/admin/AdminUsers";
import { AdminPlans } from "./pages/admin/AdminPlans";
import { AdminTransactions } from "./pages/admin/AdminTransactions";
import { AdminAuditLogs } from "./pages/admin/AdminAuditLogs";
import { AdminGroups } from "./pages/admin/AdminGroups";
import { AdminMaintenance } from "./pages/admin/AdminMaintenance";
import {
  AdminRoute,
  ProtectedRoute,
  RedirectIfAuthenticated,
} from "./router/ProtectedRoute";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { NotificationsProvider } from "./components/focus/notifications-context";
import { DemoLayout } from "./pages/demo/DemoLayout";
import { DemoPage } from "./pages/demo/DemoPage";
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
 *  /                  -> Trang chủ (marketing 1 trang, dữ liệu mẫu cho khách)
 *  /demo, /demo/*     -> URL cũ → redirect về trang chủ `/`
 *  /pricing           -> Bảng giá & Lựa chọn gói (công khai, SiteLayout)
 *  /payment/success   -> Kết quả thanh toán thành công (PayOS ReturnUrl)
 *  /payment/cancel    -> Đã hủy thanh toán (PayOS CancelUrl)
 *  /login             -> Trang đăng nhập (nếu đã login -> /dashboard)
 *  /register          -> Trang đăng ký (nếu đã login -> /dashboard)
 *  /onboarding        -> Cần đăng nhập; lần đầu sẽ được ProtectedRoute đẩy vào đây
 *                       (trang fullscreen, KHÔNG dùng SiteLayout — có header/footer riêng)
 *  /dashboard         -> Cần đăng nhập + đã hoàn tất onboarding (Lịch ngày)
 *  /projects          -> Cần đăng nhập + đã hoàn tất onboarding (Không gian dự án)
 *  /groups            -> Nhóm làm việc (spec BE GROUP_FE.md)
 *  /groups/:groupId   -> Chi tiết nhóm: việc, việc con, giai đoạn, thành viên, nhật ký
 *  /my-group-tasks    -> Việc nhóm được giao cho tôi + bấm giờ + đề xuất đổi giờ
 *  /projects/:id/milestones -> Quản lý milestone của dự án
 *  /projects/:id/documents -> Kho tài liệu của dự án
 *  /documents               -> Tất cả tài liệu của tôi (gom mọi dự án)
 *  /clients           -> Cần đăng nhập + đã hoàn tất onboarding (Danh bạ khách hàng)
 *  /schedule          -> Cần đăng nhập + đã hoàn tất onboarding (Lịch Tuần & Tháng)
 *  /copilot           -> Cần đăng nhập + đã hoàn tất onboarding (AI Schedule Coordinator)
 *  /profile           -> Cần đăng nhập + đã hoàn tất onboarding (Hồ sơ người dùng)
 *  /notifications     -> Cần đăng nhập + đã hoàn tất onboarding (Hộp thư thông báo)
 *
 *  /admin             -> Khu vực quản trị — CHỈ role Admin (AdminRoute)
 *  /admin/revenue     -> Báo cáo doanh thu
 *  /admin/users       -> Quản lý người dùng
 *  /admin/plans       -> Quản lý gói đăng ký
 *  /admin/transactions-> Giao dịch & Hoá đơn
 *  /admin/audit-logs  -> Nhật ký thao tác Admin
 *  /admin/maintenance -> Đồng bộ trạng thái dữ liệu cũ
 *
 * Mọi route khác đều fallback về trang chủ `/`.
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
        {/*
          TRANG CHỦ = trang demo (marketing 1 trang dài, dữ liệu mẫu).
          Guest mở `/` thấy ngay sản phẩm — không cần đăng nhập.
        */}
        <Route element={<DemoLayout />}>
          <Route path="/" element={guarded("Trang chủ", <DemoPage />)} />
          {/* URL cũ → gộp về trang chủ. */}
          <Route path="/demo" element={<Navigate to="/" replace />} />
          <Route path="/demo/today" element={<Navigate to="/" replace />} />
          <Route path="/demo/schedule" element={<Navigate to="/" replace />} />
          <Route
            path="/demo/projects"
            element={<Navigate to="/" replace />}
          />
          <Route path="/demo/groups" element={<Navigate to="/" replace />} />
        </Route>

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

      {/* Onboarding — trang khảo sát có header/footer RIÊNG (fullscreen, không
          dùng SiteLayout để tránh trùng nav + header). Vẫn cần đăng nhập. */}
      <Route
        path="/onboarding"
        element={
          <ProtectedRoute>
            {guarded("Thiết lập", <OnboardingPage />)}
          </ProtectedRoute>
        }
      />

      {/* Dashboard + các trang trong app: cần auth, dùng SiteLayout để có
          header/footer chuẩn + nav active. ProtectedRoute bọc ngoài. */}
      <Route
        element={
          <ProtectedRoute>
            <SiteLayout />
          </ProtectedRoute>
        }
      >
        <Route path="/dashboard" element={guarded("Lịch ngày", <DashboardPage />)} />
        {/* Briefing hôm nay — AI service gộp task + lịch + khung giờ tập trung */}
        <Route
          path="/briefing"
          element={guarded("Briefing hôm nay", <BriefingPage />)}
        />
        <Route path="/projects" element={guarded("Dự án", <ProjectsPage />)} />
        {/* Nhóm làm việc — GET/POST /api/groups (spec BE GROUP_FE.md) */}
        <Route path="/groups" element={guarded("Nhóm", <GroupsPage />)} />
        <Route
          path="/groups/:groupId"
          element={guarded("Chi tiết nhóm", <GroupDetailPage />)}
        />
        {/*
         * Chat AI của nhóm — trang riêng, layout 3 cột:
         * lịch sử chat (trái) · khung chat (giữa) · bản nháp plan (phải).
         */}
        <Route
          path="/groups/:groupId/ai"
          element={guarded("Chat AI nhóm", <GroupAiPlannerPage />)}
        />
        {/* Việc nhóm được giao cho tôi — GET /api/my-group-tasks */}
        <Route
          path="/my-group-tasks"
          element={guarded("Việc nhóm của tôi", <MyGroupTasksPage />)}
        />
        {/* Nhập từ file → nhiều dự án (AI service: /projects/import/*) */}
        <Route
          path="/projects/import"
          element={guarded("Nhập từ file", <ProjectImportPage />)}
        />
        <Route path="/clients" element={guarded("Khách hàng", <ClientsPage />)} />
        <Route
          path="/projects/:projectId"
          element={guarded("Chi tiết dự án", <ProjectDetailPage />)}
        />
        <Route
          path="/projects/:projectId/planning"
          element={guarded("Lập kế hoạch", <PlanningPage />)}
        />
        {/* FR-08b-1 — AI chat mức dự án (brief → milestone + task) */}
        <Route
          path="/projects/:projectId/execution"
          element={guarded("AI lập kế hoạch", <ProjectAiChatPage />)}
        />
        <Route
          path="/projects/:projectId/milestones"
          element={guarded("Milestones", <MilestonesPage />)}
        />
        <Route
          path="/projects/:projectId/schedule"
          element={guarded("Lịch dự án", <SchedulePage />)}
        />
        {/* Kho tài liệu của dự án (BE spec: PROJECT_DOCUMENTS_FE) */}
        <Route
          path="/projects/:projectId/documents"
          element={guarded("Tài liệu dự án", <ProjectDocumentsPage />)}
        />
        {/* Chat AI trong dự án — 3 cột (lịch sử chat của dự án + chat + cây dự án) */}
        <Route
          path="/projects/:projectId/chat"
          element={guarded("Chat AI dự án", <ProjectChatPage />)}
        />
        {/* Tất cả tài liệu của tôi (gom mọi dự án) */}
        <Route
          path="/documents"
          element={guarded("Tài liệu của tôi", <MyDocumentsPage />)}
        />
        <Route path="/schedule" element={guarded("Lịch tuần & tháng", <SchedulePage />)} />
        <Route path="/copilot" element={guarded("AI Copilot", <CopilotPage />)} />
        {/* Lịch sử chat — GET /chat/conversations?q= */}
        <Route
          path="/chat-history"
          element={guarded("Lịch sử chat", <ChatHistoryPage />)}
        />
        {/* Thống kê — GET /analytics/overview + /analytics/breakdown */}
        <Route path="/analytics" element={guarded("Thống kê", <AnalyticsPage />)} />
        {/* Giờ hiệu quả — GET/PUT /profile/productive-hours */}
        <Route
          path="/productive-hours"
          element={guarded("Giờ hiệu quả", <ProductiveHoursPage />)}
        />
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

      {/* ============ Khu vực quản trị ============
          Chỉ tài khoản role = Admin mới vào được (AdminRoute).
          BE cũng chặn ở tầng API (403 với user thường). */}
      <Route
        element={
          <AdminRoute>
            <AdminLayout />
          </AdminRoute>
        }
      >
        <Route path="/admin" element={guarded("Tổng quan quản trị", <AdminOverview />)} />
        <Route
          path="/admin/revenue"
          element={guarded("Báo cáo doanh thu", <AdminRevenue />)}
        />
        <Route
          path="/admin/users"
          element={guarded("Quản lý người dùng", <AdminUsers />)}
        />
        <Route
          path="/admin/plans"
          element={guarded("Gói đăng ký", <AdminPlans />)}
        />
        <Route
          path="/admin/transactions"
          element={guarded("Giao dịch & Hoá đơn", <AdminTransactions />)}
        />
        <Route
          path="/admin/audit-logs"
          element={guarded("Nhật ký thao tác", <AdminAuditLogs />)}
        />
        <Route
          path="/admin/groups"
          element={guarded("Quản lý nhóm", <AdminGroups />)}
        />
        <Route
          path="/admin/maintenance"
          element={guarded("Bảo trì dữ liệu", <AdminMaintenance />)}
        />
      </Route>

      <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </NotificationsProvider>
  );
}

export default App;
