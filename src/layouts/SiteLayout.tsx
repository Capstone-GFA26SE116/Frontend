import { useEffect, useRef, useState } from "react";
import { Link, NavLink, Outlet, useNavigate } from "react-router-dom";
import { useAuth } from "../auth/AuthContext";
import { MetanoiaLogo } from "../components/MetanoiaLogo";
import { useGoogleCalendar } from "../hooks/useGoogleCalendar";
import { listProjects, listTasks } from "../lib/api-client";
import { FocusManager } from "../components/focus/FocusManager";
import { NotificationToaster } from "../components/focus/NotificationToaster";
import { useNotificationsContext } from "../components/focus/notifications-context-state";
import "./site-layout.css";

/**
 * Layout công khai dùng cho các trang marketing (Pricing, Landing sắp migrate, ...).
 *
 * - Header: logo gradient + nav + AI Ready pill + notifications + auth cta / avatar.
 * - Footer: wordmark + nav + version + copyright.
 * - Toàn bộ class prefix `.site-*`.
 *
 * Khác AuthLayout: AuthLayout có hero panel bên trái, SiteLayout thì full-width
 * 1 cột với header/footer cố định — phù hợp với trang giới thiệu / pricing.
 */
export function SiteLayout() {
  const { isAuthenticated, user, logout } = useAuth();
  const navigate = useNavigate();
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  /**
   * Trạng thái Google Calendar cho item trong user menu.
   * Chỉ gọi API khi đã đăng nhập — tránh 401 → clearTokens → redirect
   * /login khi user đang ở trang public (landing/pricing).
   */
  const gcal = useGoogleCalendar(isAuthenticated);

  /**
   * Thông báo: badge số chưa đọc + SignalR realtime.
   *
   * Dùng CHUNG instance từ `NotificationsProvider` (bọc ở App.tsx) để chỉ
   * có 1 hub connection cho toàn app.
   */
  const notif = useNotificationsContext();

  /**
   * Danh sách task cho hộp thoại "ghi nhận giờ đã làm việc" (self-report).
   *
   * API `POST /api/focus/self-report` bắt buộc có `taskId`, nên cần danh sách
   * task để user chọn. Ta nạp 1 lần khi vào app (rẻ, và danh sách task
   * thay đổi không thường xuyên trong 1 phiên làm việc).
   */
  const [focusTasks, setFocusTasks] = useState<
    Array<{ id: string; title: string }>
  >([]);

  useEffect(() => {
    if (!isAuthenticated) return;
    let cancelled = false;
    void (async () => {
      const projRes = await listProjects();
      if (cancelled) return;
      if (!projRes.ok) return;
      const results = await Promise.all(
        projRes.data.map((p) => listTasks(p.id)),
      );
      if (cancelled) return;
      const flat = results
        .filter((r) => r.ok)
        .flatMap((r) => r.data)
        .filter((t) => t.status !== "Done" && t.status !== "Cancelled")
        .map((t) => ({ id: t.id, title: t.title }));
      setFocusTasks(flat);
    })();
    return () => {
      cancelled = true;
    };
  }, [isAuthenticated]);

  // Đóng menu khi click ra ngoài hoặc nhấn Escape
  useEffect(() => {
    if (!menuOpen) return;
    function onClick(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setMenuOpen(false);
    }
    document.addEventListener("mousedown", onClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [menuOpen]);

  function handleLogout() {
    setMenuOpen(false);
    logout();
  }

  /**
   * Item Google Calendar trong user menu:
   * - Chưa kết nối → bắt đầu OAuth (redirect toàn trang).
   * - Đã kết nối  → mở /schedule để quản lý sync / disconnect.
   */
  function handleGoogleCalendar() {
    setMenuOpen(false);
    if (gcal.isConnected) {
      navigate("/schedule");
    } else {
      // `connect()` là async (gọi API lấy authorizationUrl rồi redirect).
      void gcal.connect();
    }
  }

  return (
    <div className="site">
      <header className="site-header">
        <div className="site-header-inner">
          <div className="site-header-left">
            <Link to="/" className="site-brand" aria-label="METANOIA">
              <MetanoiaLogo size={28} withWordmark tone="dark" />
            </Link>

            <nav className="site-nav" aria-label="Primary">
              <NavLink
                to="/dashboard"
                className={({ isActive }) =>
                  "site-nav-link" + (isActive ? " site-nav-link--active" : "")
                }
              >
                <span className="material-symbols-outlined site-nav-icon" aria-hidden="true">today</span>
                <span>Today</span>
              </NavLink>
              <NavLink
                to="/projects"
                className={({ isActive }) => {
                  // Active on /projects AND any /projects/:projectId subroute
                  const active =
                    isActive ||
                    (typeof window !== "undefined" &&
                      window.location.pathname.startsWith("/projects/"));
                  return (
                    "site-nav-link" + (active ? " site-nav-link--active" : "")
                  );
                }}
              >
                <span className="material-symbols-outlined site-nav-icon" aria-hidden="true">space_dashboard</span>
                <span>Projects</span>
              </NavLink>
              <NavLink
                to="/schedule"
                className={({ isActive }) =>
                  "site-nav-link" + (isActive ? " site-nav-link--active" : "")
                }
              >
                <span className="material-symbols-outlined site-nav-icon" aria-hidden="true">event</span>
                <span>Schedule &amp; Tasks</span>
              </NavLink>
              <NavLink
                to="/copilot"
                className={({ isActive }) =>
                  "site-nav-link" + (isActive ? " site-nav-link--active" : "")
                }
              >
                <span className="material-symbols-outlined site-nav-icon" aria-hidden="true">neurology</span>
                <span>AI Copilot</span>
              </NavLink>
              <NavLink
                to="/pricing"
                className={({ isActive }) =>
                  "site-nav-link" + (isActive ? " site-nav-link--active" : "")
                }
              >
                <span className="material-symbols-outlined site-nav-icon" aria-hidden="true">workspace_premium</span>
                <span>Upgrade</span>
              </NavLink>
            </nav>
          </div>

          <div className="site-header-right">
            <div className="site-ai-pill" title="AI Engine is ready">
              <span className="site-ai-pill-dot" />
              <span className="site-ai-pill-text">AI Ready</span>
            </div>

            {isAuthenticated ? (
              <>
                <Link
                  to="/notifications"
                  aria-label={
                    notif.unreadCount > 0
                      ? `Thông báo (${notif.unreadCount} chưa đọc)`
                      : "Thông báo"
                  }
                  className="site-icon-btn site-icon-btn--link"
                  title="Thông báo"
                >
                  <span className="material-symbols-outlined">notifications</span>
                  {notif.unreadCount > 0 && (
                    <span className="site-icon-btn-count" aria-hidden="true">
                      {notif.unreadCount > 99 ? "99+" : notif.unreadCount}
                    </span>
                  )}
                </Link>
                <span
                  className="site-header-divider"
                  aria-hidden="true"
                />
                <div className="site-avatar-wrap" ref={menuRef}>
                  <button
                    type="button"
                    className="site-avatar-trigger"
                    onClick={() => setMenuOpen((v) => !v)}
                    aria-haspopup="menu"
                    aria-expanded={menuOpen}
                    aria-label="Open account menu"
                    title={user?.email}
                  >
                    {user?.avatarUrl ? (
                      <img
                        alt="Profile"
                        className="site-avatar"
                        src={user.avatarUrl}
                        onError={(e) => {
                          const target = e.currentTarget;
                          target.style.display = "none";
                          const fallback = target.nextElementSibling;
                          if (fallback)
                            (fallback as HTMLElement).style.display = "flex";
                        }}
                      />
                    ) : null}
                    <span
                      className="site-avatar site-avatar--initial"
                      style={{
                        display: user?.avatarUrl ? "none" : "flex",
                      }}
                      aria-hidden="true"
                    >
                      {(user?.name || user?.email || "?")
                        .trim()
                        .charAt(0)
                        .toUpperCase()}
                    </span>
                    <span
                      className="material-symbols-outlined site-avatar-caret"
                      aria-hidden="true"
                    >
                      expand_more
                    </span>
                  </button>

                  {menuOpen && (
                    <div className="site-user-menu" role="menu">
                      <div className="site-user-menu-head">
                        <span className="site-user-menu-name">
                          {user?.name || "Người dùng"}
                        </span>
                        <span className="site-user-menu-email">
                          {user?.email}
                        </span>
                      </div>
                      <div className="site-user-menu-divider" aria-hidden="true" />
                      <Link
                        to="/dashboard"
                        className="site-user-menu-item"
                        role="menuitem"
                        onClick={() => setMenuOpen(false)}
                      >
                        <span
                          className="material-symbols-outlined"
                          aria-hidden="true"
                        >
                          dashboard
                        </span>
                        <span>Workspace</span>
                      </Link>
                      <Link
                        to="/profile"
                        className="site-user-menu-item"
                        role="menuitem"
                        onClick={() => setMenuOpen(false)}
                      >
                        <span
                          className="material-symbols-outlined"
                          aria-hidden="true"
                        >
                          account_circle
                        </span>
                        <span>Profile</span>
                      </Link>
                      <button
                        type="button"
                        className="site-user-menu-item site-user-menu-item--gcal"
                        role="menuitem"
                        onClick={handleGoogleCalendar}
                        disabled={gcal.loading}
                        title={
                          gcal.isConnected
                            ? "Google Calendar đã kết nối"
                            : "Kết nối Google Calendar"
                        }
                      >
                        <span
                          className="material-symbols-outlined"
                          aria-hidden="true"
                        >
                          event_available
                        </span>
                        <span>
                          {gcal.isConnected
                            ? "Google Calendar connected"
                            : "Connect Google Calendar"}
                        </span>
                        {gcal.isConnected && (
                          <span className="site-user-menu-gcal-dot" aria-hidden="true" />
                        )}
                      </button>
                      <button
                        type="button"
                        className="site-user-menu-item site-user-menu-item--danger"
                        role="menuitem"
                        onClick={handleLogout}
                      >
                        <span
                          className="material-symbols-outlined"
                          aria-hidden="true"
                        >
                          logout
                        </span>
                        <span>Log out</span>
                      </button>
                    </div>
                  )}
                </div>
              </>
            ) : (
              <>
                <Link to="/login" className="site-auth-link">
                  Log in
                </Link>
                <Link to="/register" className="site-auth-cta">
                  Get started free
                </Link>
              </>
            )}
          </div>
        </div>
      </header>

      {/*
        Focus Session — thanh đồng hồ + hộp thoại, ở cấp layout để sống
        xuyên suốt các trang (đồng hồ phải chạy cả khi đổi route).

        `<Outlet />` được đặt BÊN TRONG `FocusManager` để
        `<FocusActionsProvider>` bao quanh trang con — nút Start/Stop ở
        trang `/schedule` cần đọc context này. Vì vậy không render
        `<Outlet />` ở `<main>` nữa. */}
      <FocusManager enabled={isAuthenticated} selfReportTasks={focusTasks}>
        <main className="site-main">
          <Outlet />
        </main>
      </FocusManager>

      {/* Toast realtime từ SignalR — dùng CHUNG hook notif với header để chỉ
          có 1 hub connection. */}
      <NotificationToaster />

      <footer className="site-footer">
        <div className="site-footer-inner">
          <div className="site-footer-left">
            <MetanoiaLogo size={22} tone="dark" />
            <span className="site-footer-version">v2.4 Neural Sync</span>
          </div>
          <nav className="site-footer-nav" aria-label="Secondary">
            <Link to="/dashboard" className="site-footer-link">
              Today
            </Link>
            <Link to="/projects" className="site-footer-link">
              Projects
            </Link>
            <Link to="/schedule" className="site-footer-link">
              Schedule &amp; Tasks
            </Link>
            <Link to="/copilot" className="site-footer-link">
              AI Copilot
            </Link>
            <Link to="/pricing" className="site-footer-link">
              Pricing
            </Link>
            <a href="#security" className="site-footer-link">
              Security
            </a>
          </nav>
          <div className="site-footer-meta">
            © 2025 METANOIA AI Labs. Minimal cognitive workspace.
          </div>
        </div>
      </footer>
    </div>
  );
}
