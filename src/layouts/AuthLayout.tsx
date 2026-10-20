import { Link, Outlet, useLocation } from "react-router-dom";
import { MetanoiaLogo } from "../components/MetanoiaLogo";
import "./auth-layout.css";

/**
 * Layout 2 cột dùng cho trang Login & Register (theo DESIGN.md — Voltagent):
 *  - Cột trái (≥lg): hero panel — hairline card trên canvas, dot grid depth cue,
 *    quote `display-lg` 36px / weight 400 / tracking -0.9px, bullets body-md.
 *  - Cột phải: form đăng nhập / đăng ký render qua <Outlet />.
 *
 * Brand rules đã được apply:
 *  - Single electric-green accent cho monogram + bullets + pulse.
 *  - KHÔNG backdrop-filter blur, KHÔNG box-shadow material.
 *  - Wordmark "METANOIA" qua component MetanoiaLogo (đã re-skin voltagent).
 *  - Inter (weight 400) làm body & quote; Mono (SF Mono / JetBrains Mono) cho tag.
 *
 * Responsive: dưới `lg` ẩn hero panel, chỉ hiển thị cột form.
 */
export function AuthLayout() {
  return (
    <div className="auth-layout">
      <div className="auth-grid">
        {/* LEFT: Hero — chỉ hiện từ lg trở lên */}
        <aside className="auth-hero" aria-hidden="true">
          {/* Subtle dot-grid depth cue (1px primary @ 8% trên canvas, mask radial fade) */}
          <div className="auth-hero-bg" />

          {/* Branding bar trên cùng — dùng MetanoiaLogo component (đã voltagent) */}
          <div className="auth-hero-brand">
            <MetanoiaLogo size={36} tone="dark" />
            <div className="auth-hero-brand-text">
              <span className="auth-version-pill">v2.4 Cognitive Engine</span>
            </div>
          </div>

          {/* Hairline card giữa hero — DESIGN.md card-feature chrome */}
          <div className="auth-hero-card-wrap">
            <div className="auth-hero-card">
              <div className="auth-hero-card-divider" />
              <div className="auth-hero-quote">
                <span className="material-symbols-outlined auth-hero-quote-icon">
                  neurology
                </span>
                <blockquote>
                  “Điều phối lịch trình thông minh theo nhịp sinh học cá nhân.”
                </blockquote>
              </div>
              <ul className="auth-hero-bullets">
                <li>
                  <span className="material-symbols-outlined auth-hero-bullet-icon">
                    auto_awesome
                  </span>
                  <p>
                    Tự động chống ảo tưởng thời gian (
                    <span className="auth-accent">Planning Fallacy</span>) với
                    thuật toán bù trừ K_bias
                  </p>
                </li>
                <li>
                  <span className="material-symbols-outlined auth-hero-bullet-icon">
                    timelapse
                  </span>
                  <p>
                    Bảo vệ các khung giờ{" "}
                    <span className="auth-strong">Deep Work</span> &amp; đệm
                    nghỉ tái tạo năng lượng
                  </p>
                </li>
                <li>
                  <span className="material-symbols-outlined auth-hero-bullet-icon">
                    shield_lock
                  </span>
                  <p>Mã hóa &amp; bảo mật dữ liệu nhận thức cục bộ</p>
                </li>
              </ul>
            </div>
          </div>

          {/* Footer micro social proof — Voltagent hairline divider + green live dot */}
          <div className="auth-hero-footer">
            <span className="auth-pulse" aria-hidden="true">
              <span className="auth-pulse-ring" />
              <span className="auth-pulse-dot" />
            </span>
            <p>
              Dành riêng cho sinh viên kỹ thuật, nghiên cứu sinh và các chuyên
              gia độc lập.
            </p>
          </div>
        </aside>

        {/* RIGHT: Form */}
        <main className="auth-form-panel">
          {/* Top bar: link Register + logo mobile */}
          <div className="auth-form-topbar">
            <div className="auth-mobile-logo">
              <MetanoiaLogo size={28} tone="dark" />
            </div>
            <OutletTopRightLink />
          </div>

          <div className="auth-form-shell">
            <Outlet />
          </div>

          <div className="auth-form-bottom">
            <p>
              Được bảo vệ bởi giao thức ẩn danh hóa dữ liệu METANOIA. Không
              quảng cáo, không thương mại hóa dữ liệu cá nhân.
            </p>
          </div>
        </main>
      </div>
    </div>
  );
}

/**
 * Link "Đăng ký ngay" / "Đăng nhập" ở góc trên bên phải form.
 * Đặt tách component riêng để không phụ thuộc path hiện tại.
 */
function OutletTopRightLink() {
  const location = useLocation();
  const isLogin = location.pathname.startsWith("/login");
  return (
    <div className="auth-topbar-text">
      {isLogin ? "Chưa có tài khoản?" : "Đã có tài khoản?"}
      <Link
        to={isLogin ? "/register" : "/login"}
        className="auth-topbar-link"
      >
        {isLogin ? "Đăng ký ngay" : "Đăng nhập"}
      </Link>
    </div>
  );
}
