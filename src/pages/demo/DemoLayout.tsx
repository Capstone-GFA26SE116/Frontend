import { Link, Outlet } from "react-router-dom";
import { MetanoiaLogo } from "../../components/MetanoiaLogo";
import { useDemoSections } from "./useDemoSections";
import "./demo.css";

/**
 * ============================================================
 * DemoLayout — layout cho trang chủ (trang marketing 1 trang)
 * ============================================================
 *
 * Trang chủ là MỘT trang marketing dài — cuộn xuống lần lượt thấy
 * Today → Schedule → Projects → Groups → Pricing.
 *
 * Khác SiteLayout:
 * - Không gọi bất kỳ API thật nào (dữ liệu đến từ `demo-data.ts`).
 * - Chỉ MỘT header: logo + nav section (jump tới từng mục) + CTA.
 *
 * Toàn bộ class prefix `.demo-*`.
 */

export function DemoLayout() {
  const { sections, activeId } = useDemoSections();

  return (
    <div className="demo">
      {/* ---------- Banner demo ---------- */}
      <div className="demo-banner" role="status">
        <div className="demo-banner-inner">
          <span className="demo-banner-icon" aria-hidden="true">
            <span className="material-symbols-outlined">visibility</span>
          </span>
          <div className="demo-banner-text">
            <strong>You are viewing a sample workspace</strong>
            <span>
              Everything here is sample data — no account needed, nothing is
              saved.
            </span>
          </div>
          <div className="demo-banner-actions">
            <Link to="/register" className="demo-banner-cta">
              Get started free
            </Link>
            <Link to="/login" className="demo-banner-link">
              Log in
            </Link>
          </div>
        </div>
      </div>

      {/* ---------- Header (1 header duy nhất) ---------- */}
      <header className="demo-header">
        <div className="demo-header-inner">
          <div className="demo-header-left">
            <Link to="/" className="demo-brand" aria-label="METANOIA">
              <MetanoiaLogo size={28} withWordmark tone="dark" />
            </Link>
          </div>
          {/* Nav section — bấm để nhảy tới mục tương ứng */}
          <nav className="demo-nav" aria-label="Page sections">
            {sections.map((s) => (
              <a
                key={s.id}
                href={`#${s.id}`}
                className={
                  "demo-nav-link" +
                  (activeId === s.id ? " demo-nav-link--active" : "")
                }
              >
                <span
                  className="material-symbols-outlined demo-nav-icon"
                  aria-hidden="true"
                >
                  {s.icon}
                </span>
                <span>{s.label}</span>
              </a>
            ))}
          </nav>

          <div className="demo-header-right">
            <Link to="/pricing" className="demo-header-link">
              Full pricing
            </Link>
            <Link to="/register" className="demo-header-cta">
              Get started free
            </Link>
          </div>
        </div>
      </header>

      {/* ---------- Nội dung ---------- */}
      <main className="demo-main">
        <Outlet />
      </main>

      {/* ---------- Footer ---------- */}
      <footer className="demo-footer">
        <div className="demo-footer-inner">
          <div className="demo-footer-left">
            <MetanoiaLogo size={22} tone="dark" />
          </div>
          {/*
           * Nav section — bấm để nhảy tới mục tương ứng trên trang.
           *
           * ⚠️ KHÔNG thêm link "Pricing" riêng: `DEMO_SECTIONS` đã có sẵn
           * mục Pricing (anchor `#pricing`) → thêm nữa sẽ bị trùng.
           */}
          <nav className="demo-footer-nav" aria-label="Secondary">
            {sections.map((s) => (
              <a key={s.id} href={`#${s.id}`} className="demo-footer-link">
                {s.label}
              </a>
            ))}
          </nav>
          {/* Cột phải rỗng để nav luôn nằm giữa (logo | nav | spacer). */}
          <div className="demo-footer-right" aria-hidden="true" />
        </div>
      </footer>
    </div>
  );
}
