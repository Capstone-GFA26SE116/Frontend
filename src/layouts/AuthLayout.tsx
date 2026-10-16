import { Outlet } from "react-router-dom";
import "./auth-layout.css";

/**
 * Layout 2 cột dùng cho trang Login & Register:
 *  - Cột trái (≥lg): hero panel — ảnh nền, glassmorphism card giới thiệu METANOIA.
 *  - Cột phải: form đăng nhập / đăng ký render qua <Outlet />.
 *
 * Theme: dark (#0f131c) + glassmorphism, lấy cảm hứng từ Material 3 / Tailwind UI
 * với typography Inter + Material Symbols.
 *
 * Responsive: dưới `lg` ẩn hero panel, chỉ hiển thị cột form.
 */
export function AuthLayout() {
  return (
    <div className="auth-layout">
      <div className="auth-grid">
        {/* LEFT: Hero — chỉ hiện từ lg trở lên */}
        <aside className="auth-hero" aria-hidden="true">
          {/* Ảnh nền + vignettes gradient để chữ nổi */}
          <div className="auth-hero-bg">
            <img
              alt=""
              className="auth-hero-img"
              src="https://lh3.googleusercontent.com/aida-public/AB6AXuBp4M2S4u6ciWwouxOwCu7IYEc7uWsul3Y1-WcBM30HWp6QXMn599UplaFHo7Uz5dTaS7bcWy46CiRDk1h4Ozpf9iZO7iTYAn04ZDpXo4o_Msdp1QBlVp1xILcJ8p9Knxp_18RjFPKY2vnYYmxPyYeQ-av7fdDqxGcVlPd-w8m3EUIFKeHd8tl2oRFwZ-R4ofjwqPF6qTDMmOp8pzC6NYrF4opq86gtB9x2KkLYrAs8wt-KP-qWh2glig"
            />
            <div className="auth-hero-vignette auth-hero-vignette--bottom" />
            <div className="auth-hero-vignette auth-hero-vignette--sides" />
            <div className="auth-hero-blob auth-hero-blob--tr" />
            <div className="auth-hero-blob auth-hero-blob--bl" />
          </div>

          {/* Branding bar trên cùng */}
          <div className="auth-hero-brand">
            <div className="auth-monogram">M</div>
            <div className="auth-hero-brand-text">
              <span className="auth-wordmark">METANOIA</span>
              <span className="auth-version-pill">v2.4 Cognitive Engine</span>
            </div>
          </div>

          {/* Glassmorphism card chính giữa */}
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

          {/* Footer micro social proof */}
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
              <div className="auth-monogram auth-monogram--sm">M</div>
              <span className="auth-wordmark auth-wordmark--sm">METANOIA</span>
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
import { Link, useLocation } from "react-router-dom";
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
