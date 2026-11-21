import { useEffect, useState, type FormEvent } from "react";
import { Link, useLocation, useNavigate, useSearchParams } from "react-router-dom";
import { useAuth } from "../../auth/AuthContext";
import type { AuthError } from "../../auth/types";
import { getPostLoginPath } from "../../auth/post-login-redirect";
import { useGoogleIdentity } from "../../auth/useGoogleIdentity";
import "./login.css";

/**
 * Trang đăng nhập.
 *
 * Flow:
 *  - Nhập email + password -> validate phía client (UX nhanh).
 *  - Gọi useAuth().login -> nếu ok thì điều hướng về trang đích.
 *  - Nếu sai, hiện thông báo lỗi bằng tiếng Việt, không leak lý do kỹ thuật.
 *
 * Sau khi đăng ký thành công, Register sẽ redirect về /login với query
 * `?email=...&registered=1` để:
 *  - Pre-fill ô email (user chỉ cần nhập lại mật khẩu).
 *  - Hiển thị banner "Đăng ký thành công" màu xanh secondary.
 *
 * Visual: dark glassmorphism, prefix class `.login-*`, dùng Material Symbols
 * cho icon trong input + nút toggle mật khẩu.
 */
export function LoginPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams, setSearchParams] = useSearchParams();
  const { login, loginWithGoogle } = useAuth();

  const registeredFlag = searchParams.get("registered") === "1";
  // Trim để chắc chắn không có khoảng trắng thừa do URL encode sai.
  const prefillEmail = (searchParams.get("email") ?? "").trim();

  const [email, setEmail] = useState(prefillEmail);
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [remember, setRemember] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [googleLoading, setGoogleLoading] = useState(false);
  // Banner chỉ hiện 1 lần rồi user dismiss / navigate đi thì xoá khỏi URL
  // để tránh F5 lại vẫn thấy.
  const [showSuccessBanner, setShowSuccessBanner] = useState(registeredFlag);

  // Đồng bộ email + banner với URL khi user navigate giữa các query khác nhau
  // (vd: từ /login?email=a&registered=1 sang /login?email=b thì phải update).
  useEffect(() => {
    setEmail(prefillEmail);
    setShowSuccessBanner(registeredFlag);
  }, [prefillEmail, registeredFlag]);

  // Focus vào ô password nếu email đã được prefill, để user chỉ cần gõ tiếp.
  useEffect(() => {
    if (prefillEmail && document.getElementById("password")) {
      document.getElementById("password")?.focus({ preventScroll: true });
    }
  }, [prefillEmail]);

  const from =
    (location.state as { from?: string } | null)?.from;
  /**
   * Đích đi sau login: ưu tiên `from` > Landing (lần đầu) > Dashboard.
   * `from` là deep-link user muốn tới trước khi bị redirect về /login.
   *
   * Riêng tài khoản Admin → luôn vào thẳng `/admin` (xem `getPostLoginPath`).
   * Vì `user` trong context chỉ cập nhật sau re-render, mỗi flow login sẽ
   * gọi lại `getPostLoginPath(from, res.session.user)` với user chính xác
   * từ response BE.
   */

  /*
   * Google Identity Services (GIS) — dùng `accounts.id` (Sign In With Google)
   * vì BE cần idToken (JWT), còn `initTokenClient` chỉ trả access_token.
   *
   * Hook tự lo: nạp script, render nút, và **bắt lỗi 403 từ Google** (origin
   * chưa whitelist / Client ID sai) → trả về `status` + `message` để hiện
   * hướng dẫn thay vì im lặng.
   */
  const google = useGoogleIdentity({
    onCredential: async (idToken: string) => {
      setGoogleLoading(true);
      const res = await loginWithGoogle(idToken);
      setGoogleLoading(false);
      if (res.ok) {
        navigate(getPostLoginPath(from, res.session.user), { replace: true });
      } else {
        setError(mapError(res.error));
      }
    },
  });

  /** Google lỗi → ưu tiên dùng form email & mật khẩu. */
  const googleBroken = google.status === "failed" || google.status === "unconfigured";
  /** Nút Google có dùng được không (đã render xong). */
  const googleReady = google.status === "ready";

  function dismissSuccessBanner() {
    setShowSuccessBanner(false);
    // Xoá query khỏi URL nhưng giữ nguyên trang.
    const next = new URLSearchParams(searchParams);
    next.delete("registered");
    setSearchParams(next, { replace: true });
  }

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    const res = await login(email, password);
    setSubmitting(false);
    if (res.ok) {
      // Dùng user từ response để quyết định đích: Admin → /admin.
      navigate(getPostLoginPath(from, res.session.user), { replace: true });
    } else {
      setError(mapError(res.error));
    }
  }

  async function handleGoogle() {
    setError(null);

    // Chưa cấu hình Client ID → báo rõ, cho user dùng form email.
    if (google.status === "unconfigured") {
      setError(
        "Đăng nhập Google chưa được cấu hình trên môi trường này. Vui lòng dùng email & mật khẩu.",
      );
      return;
    }

    // Script/asset lỗi (403 do origin chưa whitelist, network fail) → báo rõ.
    if (google.status === "failed") {
      setError(
        google.message ??
          "Đăng nhập Google đang lỗi. Vui lòng dùng email & mật khẩu.",
      );
      return;
    }

    // Script chưa xong → bấm lại sau.
    if (google.status !== "ready") {
      setError("Đang tải Google Sign-In, vui lòng thử lại sau giây lát.");
      return;
    }

    setGoogleLoading(true);
    /*
     * Có Client ID + script đã load → forward click xuống nút GIS chính chủ
     * đã được renderButton().
     *
     * Forwarding click (thay vì gọi prompt() trực tiếp) đảm bảo:
     *   1. GIS popup OAuth mở đúng cách cho cả user chưa có session Google
     *      (One Tap prompt() fail với "Not signed in" trong trường hợp này).
     *   2. Toàn bộ flow OAuth (popup, callback id_token) do GIS xử lý — không bị
     *      custom logic can thiệp.
     *   3. Mọi error từ GIS sẽ bị catch bởi callback 'error' đã đăng ký trong
     *      initialize() → hiển thị qua setError(...).
     */
    const host = document.getElementById("google-signin-host");
    const innerBtn = host?.querySelector<HTMLElement>(
      'div[role="button"], button, iframe',
    );
    if (innerBtn) {
      innerBtn.click();
      // GIS sẽ tự mở popup OAuth. Callback đã đăng ký trong useEffect sẽ nhận
      // id_token và xử lý navigate / setError. Reset loading ở đây cho UI
      // không bị kẹt "Đang kết nối..." khi user đóng popup.
      // (GIS callback cũng setGoogleLoading(false) khi nhận được response/error.)
      window.setTimeout(() => setGoogleLoading(false), 800);
    } else {
      // GIS chưa load xong hoặc chưa renderButton xong — fallback về prompt().
      const w = window as unknown as { google?: unknown };
      const g = w.google as {
        accounts?: { id?: { prompt?: () => void } };
      };
      if (g.accounts?.id?.prompt) {
        g.accounts.id.prompt();
        window.setTimeout(() => setGoogleLoading(false), 800);
      } else {
        setGoogleLoading(false);
        setError("Đang tải Google Sign-In, vui lòng thử lại sau giây lát.");
      }
    }
  }

  const emailError = error && error.includes("email") ? error : null;

  return (
    <div className="login">
      {/* Header */}
      <div className="login-header">
        <span className="login-eyebrow">CỔNG ĐĂNG NHẬP</span>
        <h1 className="login-title">Chào mừng trở lại</h1>
        <p className="login-subtitle">
          Tiếp tục tối ưu hóa thời gian và năng lượng làm việc của bạn.
        </p>
      </div>

      {/* Success banner: hiện sau khi đăng ký thành công */}
      {showSuccessBanner && (
        <div className="login-banner login-banner--success" role="status">
          <span className="material-symbols-outlined login-banner-icon">
            check_circle
          </span>
          <div className="login-banner-body">
            <strong className="login-banner-title">Đăng ký thành công!</strong>
            <span className="login-banner-text">
              Tài khoản của bạn đã sẵn sàng. Vui lòng đăng nhập để tiếp tục.
            </span>
          </div>
          <button
            type="button"
            onClick={dismissSuccessBanner}
            className="login-banner-close"
            aria-label="Đóng thông báo"
          >
            <span className="material-symbols-outlined">close</span>
          </button>
        </div>
      )}

      {/* Google SSO */}
      <div className="login-sso">
        {/*
          Nút primary chỉ hiện khi Google **dùng được** (đã render xong).
          Khi Google lỗi (403 do origin chưa whitelist / thiếu Client ID) →
          ẩn nút để user không bấm vào nút chết, kèm cảnh báo rõ nguyên nhân.

          ⚠️ Host `google-signin-host` PHẢI luôn tồn tại trong DOM — hook
          renderButton vào đó. Nếu ẩn luôn host, hook sẽ báo nhầm "không tìm
          thấy nút" thay vì lỗi thật (403 / thiếu Client ID).
        */}
        <div
          id="google-signin-host"
          className="login-google-gis-host"
          hidden={googleBroken}
        />
        {!googleBroken && (
          <>
            {/* Button primary hiển thị */}
            <button
              type="button"
              id="google-signin-btn"
              onClick={handleGoogle}
              disabled={googleLoading || submitting || !googleReady}
              className="metanoia-google-btn login-google-btn"
            >
              <GoogleIcon />
              <span>
                {googleLoading
                  ? "Đang kết nối Google..."
                  : googleReady
                    ? "Tiếp tục với Google"
                    : "Đang tải Google Sign-In…"}
              </span>
            </button>
            <div className="login-sso-hint">
              <span className="login-sso-dot" aria-hidden="true" />
              <span>Đồng bộ tức thì Google Calendar</span>
            </div>
          </>
        )}

        {/* Cảnh báo khi Google không dùng được → hướng dẫn cụ thể. */}
        {googleBroken && (
          <div className="login-banner login-banner--warning" role="status">
            <span className="material-symbols-outlined login-banner-icon">
              info
            </span>
            <div className="login-banner-body">
              <strong>Đăng nhập Google đang không khả dụng</strong>
              <span className="login-banner-text">
                {google.message ??
                  "Đăng nhập Google chưa được cấu hình trên môi trường này."}{" "}
                Bạn vẫn có thể đăng nhập bằng email &amp; mật khẩu bên dưới.
              </span>
            </div>
          </div>
        )}
      </div>

      {/* Divider */}
      <div className="login-divider">
        <div className="login-divider-line" />
        <span className="login-divider-text">HOẶC VỚI EMAIL</span>
        <div className="login-divider-line" />
      </div>

      {/* Form */}
      <form className="login-form" onSubmit={handleSubmit} noValidate>
        {/* Email */}
        <div className="login-field">
          <label className="login-field-label" htmlFor="email">
            Email
          </label>
          <div className="login-input-wrap">
            <input
              id="email"
              name="email"
              type="email"
              autoComplete="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="nguyenvana@gmail.com"
              className="login-input"
            />
            <span
              className="material-symbols-outlined login-input-icon"
              aria-hidden="true"
            >
              alternate_email
            </span>
          </div>
          {emailError && <span className="login-field-error">{emailError}</span>}
        </div>

        {/* Password */}
        <div className="login-field">
          <div className="login-field-row">
            <label className="login-field-label" htmlFor="password">
              Mật khẩu
            </label>
            <a href="#" className="login-link">
              Quên mật khẩu?
            </a>
          </div>
          <div className="login-input-wrap">
            <input
              id="password"
              name="password"
              type={showPassword ? "text" : "password"}
              autoComplete="current-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••••••"
              className="login-input login-input--with-toggle"
            />
            <button
              type="button"
              onClick={() => setShowPassword((v) => !v)}
              className="login-toggle"
              aria-label={showPassword ? "Ẩn mật khẩu" : "Hiện mật khẩu"}
            >
              <span className="material-symbols-outlined" aria-hidden="true">
                {showPassword ? "visibility_off" : "visibility"}
              </span>
            </button>
          </div>
        </div>

        {/* Remember */}
        <div className="login-remember">
          <input
            id="remember"
            type="checkbox"
            checked={remember}
            onChange={(e) => setRemember(e.target.checked)}
            className="login-checkbox-input"
          />
          <label htmlFor="remember" className="login-checkbox-label">
            <span className="login-checkbox-box" aria-hidden="true">
              <svg
                className="login-checkbox-check"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="3"
              >
                <polyline points="20 6 9 17 4 12" />
              </svg>
            </span>
            Ghi nhớ phiên đăng nhập trên thiết bị này
          </label>
        </div>

        {error && !emailError && (
          <div className="login-alert" role="alert">
            {error}
          </div>
        )}

        {/* Submit */}
        <button
          type="submit"
          disabled={submitting || googleLoading}
          className="login-submit"
        >
          <span>{submitting ? "Đang đăng nhập..." : "Đăng nhập vào Không gian làm việc"}</span>
          {!submitting && (
            <span className="material-symbols-outlined" aria-hidden="true">
              arrow_forward
            </span>
          )}
        </button>
      </form>

      {/* Mobile-only: link đến Register (desktop đã có ở top-right) */}
      <p className="login-mobile-link">
        Chưa có tài khoản?{" "}
        <Link to="/register" className="login-link login-link--strong">
          Đăng ký ngay
        </Link>
      </p>
    </div>
  );
}

/* ---------- icons + error mapping ---------- */

function GoogleIcon() {
  return (
    <svg
      className="metanoia-google-icon login-google-icon"
      viewBox="0 0 24 24"
      aria-hidden="true"
    >
      <path
        d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
        fill="#4285F4"
      />
      <path
        d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
        fill="#34A853"
      />
      <path
        d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.06H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.94l2.85-2.22.81-.63z"
        fill="#FBBC05"
      />
      <path
        d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.06l3.66 2.84c.87-2.6 3.3-4.52 6.16-4.52z"
        fill="#EA4335"
      />
    </svg>
  );
}

function mapError(code: AuthError): string {
  switch (code) {
    case "invalid_email":
      return "Email chưa đúng định dạng.";
    case "weak_password":
      return "Mật khẩu phải có ít nhất 8 ký tự.";
    case "user_not_found":
      return "Tài khoản không tồn tại. Vui lòng đăng ký trước.";
    case "wrong_password":
      return "Mật khẩu không đúng.";
    case "email_exists":
      return "Email này đã được dùng để đăng ký.";
    case "google_auth_failed":
      return "Đăng nhập Google thất bại. Vui lòng thử lại.";
    case "session_expired":
      return "Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại.";
    default:
      return "Đăng nhập thất bại. Vui lòng thử lại.";
  }
}
