import { useEffect, useRef, useState, type FormEvent } from "react";
import { Link, useLocation, useNavigate, useSearchParams } from "react-router-dom";
import { useAuth } from "../../auth/AuthContext";
import type { AuthError } from "../../auth/types";
import { getPostLoginPath } from "../../auth/post-login-redirect";
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
  const initialized = useRef(false);

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
   */
  const postLoginPath = getPostLoginPath(from);

  // Initialize Google Identity Services (GIS) — tạo nút đăng nhập Google thật.
  // Dùng accounts.id (Sign In With Google) thay vì initTokenClient vì BE expect idToken (JWT),
  // còn initTokenClient chỉ trả access_token (chỉ dùng gọi Google API).
  useEffect(() => {
    if (initialized.current) return;
    initialized.current = true;

    const clientId = (import.meta.env.VITE_GOOGLE_CLIENT_ID as string) || "";
    if (!clientId || clientId === "YOUR_GOOGLE_CLIENT_ID.apps.googleusercontent.com") {
      // Chưa có Client ID → giữ nút mock, không làm gì
      return;
    }

    // Load GIS script
    const script = document.createElement("script");
    script.src = "https://accounts.google.com/gsi/client";
    script.async = true;
    script.defer = true;
    script.onload = () => {
      if (typeof window === "undefined") return;
      const w = window as unknown as { google?: unknown };
      if (!w.google) return;
      const g = w.google as {
        accounts: {
          id: {
            initialize: (config: Record<string, unknown>) => {
              prompt: (opts?: Record<string, unknown>) => void;
            };
            renderButton: (
              parent: HTMLElement,
              options: Record<string, unknown>,
            ) => void;
          };
        };
      };
      g.accounts.id.initialize({
        client_id: clientId,
        callback: async (response: { credential?: string; error?: string }) => {
          if (response.error || !response.credential) {
            setError("Đăng nhập Google thất bại. Vui lòng thử lại.");
            setGoogleLoading(false);
            return;
          }
          // response.credential chính là idToken (JWT) — gửi cho BE để verify.
          const res = await loginWithGoogle(response.credential);
          setGoogleLoading(false);
          if (res.ok) navigate(postLoginPath, { replace: true });
          else setError(mapError(res.error));
        },
        auto_select: false,
        cancel_on_tap_outside: true,
      });

      // Render nút Google chính chủ vào placeholder, đè lên nút mock.
      const placeholder = document.getElementById("google-signin-btn");
      if (placeholder) {
        // Ẩn nút mock đi (vẫn giữ DOM để không vỡ layout)
        placeholder.style.display = "none";
        const host = document.createElement("div");
        host.id = "google-signin-host";
        host.style.width = "100%";
        placeholder.parentElement?.appendChild(host);
        g.accounts.id.renderButton(host, {
          type: "standard",
          theme: "outline",
          size: "large",
          text: "continue_with",
          shape: "pill",
          width: 360,
        });
      }
    };
    document.head.appendChild(script);
  }, [loginWithGoogle, navigate, postLoginPath]);

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
      navigate(postLoginPath, { replace: true });
    } else {
      setError(mapError(res.error));
    }
  }

  async function handleGoogle() {
    setError(null);
    setGoogleLoading(true);
    // Nếu chưa có Client ID → fallback về mock.
    const clientId = (import.meta.env.VITE_GOOGLE_CLIENT_ID as string) || "";
    if (!clientId || clientId === "YOUR_GOOGLE_CLIENT_ID.apps.googleusercontent.com") {
      // Mock fallback: gọi loginWithGoogle với placeholder token
      const res = await loginWithGoogle("mock_token");
      setGoogleLoading(false);
      if (res.ok) navigate(postLoginPath, { replace: true });
      else setError("Chế độ phát triển: Google OAuth chưa được cấu hình. Vui lòng thêm VITE_GOOGLE_CLIENT_ID vào .env");
      return;
    }
    // Có Client ID → forward click xuống nút GIS chính chủ đã được renderButton()
    // trong useEffect. Forwarding click (thay vì gọi prompt() trực tiếp) đảm bảo:
    //   1. GIS popup OAuth mở đúng cách cho cả user chưa có session Google
    //      (One Tap prompt() fail với "Not signed in" trong trường hợp này).
    //   2. Toàn bộ flow OAuth (popup, callback id_token) do GIS xử lý — không bị
    //      custom logic can thiệp.
    //   3. Mọi error từ GIS sẽ bị catch bởi callback 'error' đã đăng ký trong
    //      initialize() → hiển thị qua setError(...).
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
        <button
          type="button"
          id="google-signin-btn"
          onClick={handleGoogle}
          disabled={googleLoading || submitting}
          className="metanoia-google-btn login-google-btn"
        >
          <GoogleIcon />
          <span>
            {googleLoading ? "Đang kết nối Google..." : "Tiếp tục với Google"}
          </span>
        </button>
        <div className="login-sso-hint">
          <span className="login-sso-dot" aria-hidden="true" />
          <span>Đồng bộ tức thì Google Calendar</span>
        </div>
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
