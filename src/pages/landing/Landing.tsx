import { useEffect } from "react";
import { Link } from "react-router-dom";
import { MetanoiaLogo } from "../../components/MetanoiaLogo";
import { markLandingSeen } from "../../auth/post-login-redirect";
import "./landing.css";

/**
 * Landing page (trang chủ công khai).
 *
 * Sau khi đồ án có thêm tính năng marketing, đây là nơi dễ dàng mở rộng
 * (giới thiệu, demo, FAQ...). Hiện tại giữ gọn để tập trung vào flow login.
 *
 * Mount → đánh dấu user đã xem landing để login lần sau đi thẳng /dashboard.
 *
 * Toàn bộ class prefix `.landing-*`.
 *
 * NOTE: Bố cục HTML giữ nguyên bản gốc — chỉ áp lại CSS theo tokens
 * trong /DESIGN.md (canvas đen, accent electric-green, hairline borders,
 * Inter + SF Mono). Không thêm section mới, không đổi chữ.
 */
export function LandingPage() {
  useEffect(() => {
    markLandingSeen();
  }, []);

  return (
    <div className="landing">
      <header className="landing-header">
        <MetanoiaLogo size={32} withWordmark />
        <nav className="landing-nav">
          <Link to="/login" className="landing-nav-link">
            Đăng nhập
          </Link>
          <Link to="/register" className="landing-nav-cta">
            Bắt đầu miễn phí
          </Link>
        </nav>
      </header>

      <main className="landing-main">
        <p className="landing-eyebrow">Tác tử LLM nhận biết ngữ cảnh</p>
        <h1 className="landing-headline">
          Lịch ngày càng
          <br />
          <span className="landing-headline-accent">sát thực tế</span> của bạn.
        </h1>
        <p className="landing-subhead">
          METANOIA học thói quen làm việc thật của bạn và tự điều chỉnh — không
          cần bạn phải nhập liệu mỗi ngày.
        </p>

        <div className="landing-cta-row">
          <Link to="/register" className="landing-cta-primary">
            Tạo tài khoản
          </Link>
          <Link to="/login" className="landing-cta-secondary">
            Tôi đã có tài khoản
          </Link>
        </div>
      </main>

      <footer className="landing-footer">
        © 2026 METANOIA 
      </footer>
    </div>
  );
}