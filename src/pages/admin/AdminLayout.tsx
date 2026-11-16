import { useMemo } from "react";
import { Link, NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";
import { useAuth } from "../../auth/AuthContext";
import { isAdminUser } from "../../auth/types";
import { MetanoiaLogo } from "../../components/MetanoiaLogo";
import "./admin.css";

/**
 * Layout khu vực quản trị.
 *
 * - Sidebar trái: điều hướng các module Admin.
 * - Header: breadcrumb + nút quay lại app + avatar Admin.
 *
 * Toàn bộ class prefix `.adm-*` (xem `admin.css`).
 */

interface AdminNavItem {
  to: string;
  label: string;
  icon: string;
  /** Đường dẫn con cũng được coi là active (vd `/admin/users/abc`). */
  matchPrefix?: string;
  /** Mô tả ngắn hiển thị dưới tiêu đề trang. */
  description?: string;
}

const ADMIN_NAV: AdminNavItem[] = [
  {
    to: "/admin",
    label: "Tổng quan",
    icon: "dashboard",
    matchPrefix: "/admin",
    description: "Số liệu doanh thu, người dùng và trạng thái gói đăng ký.",
  },
  {
    to: "/admin/revenue",
    label: "Doanh thu",
    icon: "monitoring",
    description: "Báo cáo doanh thu theo ngày, tháng hoặc gói đăng ký.",
  },
  {
    to: "/admin/users",
    label: "Người dùng",
    icon: "group",
    description: "Tìm kiếm, đổi vai trò, khoá hoặc xoá tài khoản.",
  },
  {
    to: "/admin/plans",
    label: "Gói đăng ký",
    icon: "workspace_premium",
    description: "Tạo, chỉnh sửa và tắt các gói đăng ký.",
  },
  {
    to: "/admin/transactions",
    label: "Giao dịch & Hoá đơn",
    icon: "receipt_long",
    description: "Theo dõi giao dịch thanh toán và hoá đơn đã phát hành.",
  },
  {
    to: "/admin/audit-logs",
    label: "Nhật ký thao tác",
    icon: "history",
    description: "Mọi thay đổi do Admin thực hiện, kèm lý do thao tác.",
  },
  {
    to: "/admin/maintenance",
    label: "Bảo trì dữ liệu",
    icon: "build",
    description: "Kiểm tra toàn vẹn dữ liệu và đồng bộ trạng thái dự án.",
  },
];

export function AdminLayout() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();

  /** Module đang mở — dùng cho breadcrumb + mô tả trang. */
  const activeItem = useMemo(() => {
    const exact = ADMIN_NAV.find((item) => item.to === location.pathname);
    if (exact) return exact;
    return ADMIN_NAV.find(
      (item) =>
        item.matchPrefix &&
        location.pathname.startsWith(item.matchPrefix) &&
        item.to !== "/admin",
    );
  }, [location.pathname]);

  function handleLogout() {
    logout();
    navigate("/login", { replace: true });
  }

  return (
    <div className="adm">
      {/* ============ Sidebar ============ */}
      <aside className="adm-sidebar">
        <div className="adm-sidebar__brand">
          <Link to="/admin" className="adm-brand-link" aria-label="METANOIA Admin">
            <MetanoiaLogo size={28} tone="dark" />
            <span className="adm-brand-text">
              <strong>METANOIA</strong>
              <span>Console</span>
            </span>
          </Link>
          <span className="adm-badge">Admin</span>
        </div>

        <nav className="adm-nav" aria-label="Quản trị">
          {ADMIN_NAV.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.to === "/admin"}
              className={({ isActive }) =>
                "adm-nav-item" +
                (isActive || (item.matchPrefix && location.pathname.startsWith(item.matchPrefix))
                  ? " adm-nav-item--active"
                  : "")
              }
            >
              <span className="material-symbols-outlined adm-nav-icon" aria-hidden="true">
                {item.icon}
              </span>
              <span className="adm-nav-label">{item.label}</span>
            </NavLink>
          ))}
        </nav>

        <div className="adm-sidebar__foot">
          <Link to="/dashboard" className="adm-back-link">
            <span className="material-symbols-outlined" aria-hidden="true">
              arrow_back
            </span>
            Về METANOIA
          </Link>
          <div className="adm-admin-card">
            <div className="adm-admin-card__top">
              {user?.avatarUrl ? (
                <img
                  className="adm-admin-card__avatar"
                  src={user.avatarUrl}
                  alt=""
                  onError={(e) => {
                    (e.currentTarget as HTMLImageElement).style.display = "none";
                  }}
                />
              ) : (
                <span className="adm-admin-card__avatar adm-admin-card__avatar--fallback">
                  <span className="material-symbols-outlined" aria-hidden="true">
                    shield_person
                  </span>
                </span>
              )}
              <div className="adm-admin-card__info">
                <strong>{user?.name ?? "Admin"}</strong>
                <span>{user?.email}</span>
              </div>
            </div>
            <button
              type="button"
              className="adm-btn adm-btn--outline adm-btn--sm adm-btn--block"
              onClick={handleLogout}
            >
              <span className="material-symbols-outlined" aria-hidden="true">
                logout
              </span>
              Đăng xuất
            </button>
          </div>
        </div>
      </aside>

      {/* ============ Main ============ */}
      <div className="adm-main">
        <header className="adm-topbar">
          <div className="adm-topbar__left">
            <span className="adm-topbar__eyebrow">METANOIA CONTROL</span>
            <span className="adm-topbar__divider" aria-hidden="true" />
            {/* Breadcrumb module hiện tại */}
            <nav className="adm-crumb" aria-label="Đường dẫn quản trị">
              <Link to="/admin" className="adm-crumb__link">
                Admin
              </Link>
              {activeItem && activeItem.to !== "/admin" && (
                <>
                  <span className="material-symbols-outlined adm-crumb__sep" aria-hidden="true">
                    chevron_right
                  </span>
                  <span className="adm-crumb__current">{activeItem.label}</span>
                </>
              )}
            </nav>
          </div>
          <div className="adm-topbar__right">
            <span className="adm-topbar__role">
              <span className="material-symbols-outlined" aria-hidden="true">
                shield
              </span>
              {isAdminUser(user) ? "Quản trị viên" : "Truy cập bị giới hạn"}
            </span>
            <span className="adm-topbar__divider" aria-hidden="true" />
            <span className="adm-live-dot" aria-hidden="true" />
            <span className="adm-topbar__status">Hệ thống hoạt động</span>
          </div>
        </header>

        <main className="adm-content">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
