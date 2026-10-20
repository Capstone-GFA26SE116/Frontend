import { useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useAuth } from "../../auth/AuthContext";
import type { AuthError } from "../../auth/types";
import { getPostLoginPath } from "../../auth/post-login-redirect";
import "./register.css";

/**
 * Trang đăng ký.
 *
 * Validate mạnh hơn trang Login: bắt buộc họ tên, xác nhận mật khẩu,
 * đồng thời kiểm tra email chưa tồn tại.
 *
 * Sau khi đăng ký thành công: dùng `createAccount` (KHÔNG auto-login) rồi
 * redirect về `/login?email=...&registered=1` để user đăng nhập lại.
 *
 * Tại sao không dùng `register()` + `logout()`?
 *  - `register()` set user/token -> ProtectedRoute thấy authenticated
 *    -> đẩy user mới (chưa onboarding) sang /onboarding thay vì /login.
 *  - `createAccount` chỉ tạo user record, không đụng session -> flow
 *    rõ ràng "đăng ký xong phải đăng nhập".
 *
 * Visual: dark glassmorphism, prefix `.register-*`, đồng bộ với Login.
 */
export function RegisterPage() {
  const navigate = useNavigate();
  const { createAccount, loginWithGoogle } = useAuth();

  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [agree, setAgree] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [googleLoading, setGoogleLoading] = useState(false);

  function redirectToLoginWithPrefill(prefillEmail: string) {
    // URLSearchParams.toString() tự encode; email chỉ chứa @ và . nên
    // không lo mất ký tự. Nếu sau này cho phép email phức tạp, có thể
    // dùng encodeURIComponent thay vì toString().
    const params = new URLSearchParams({
      email: prefillEmail,
      registered: "1",
    });
    navigate(`/login?${params.toString()}`, { replace: true });
  }

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);

    if (!name.trim()) return setError("Vui lòng nhập họ và tên.");
    if (password !== confirm) {
      return setError("Mật khẩu xác nhận không khớp.");
    }
    if (!agree) {
      return setError("Bạn cần đồng ý điều khoản trước khi tạo tài khoản.");
    }

    setSubmitting(true);
    // createAccount KHÔNG set session -> không bị ProtectedRoute đẩy đi.
    const res = await createAccount(name, email, password);
    setSubmitting(false);
    if (res.ok) {
      redirectToLoginWithPrefill(res.user.email);
    } else {
      setError(mapError(res.error));
    }
  }

  async function handleGoogle() {
    setError(null);
    setGoogleLoading(true);
    // Nếu đã init GIS (có Client ID) → nút bấm sẽ trigger requestAccessToken
    const clientId = (import.meta.env.VITE_GOOGLE_CLIENT_ID as string) || "";
    if (!clientId || clientId === "YOUR_GOOGLE_CLIENT_ID.apps.googleusercontent.com") {
      // Mock fallback
      const res = await loginWithGoogle("mock_token");
      setGoogleLoading(false);
      if (res.ok) navigate(getPostLoginPath(undefined), { replace: true });
      else setError("Chế độ phát triển: Google OAuth chưa được cấu hình. Vui lòng thêm VITE_GOOGLE_CLIENT_ID vào .env");
    }
  }

  const passwordTooShort = password.length > 0 && password.length < 8;
  const passwordMismatch = confirm.length > 0 && password !== confirm;

  return (
    <div className="register">
      {/* Header */}
      <div className="register-header">
        <span className="register-eyebrow">CỔNG ĐĂNG KÝ</span>
        <h1 className="register-title">Tạo không gian làm việc</h1>
        <p className="register-subtitle">
          Chỉ mất một phút. Lịch thông minh sẽ bắt đầu học thói quen của bạn từ
          ngày đầu tiên.
        </p>
      </div>

      {/* Google SSO */}
      <div className="register-sso">
        <button
          type="button"
          onClick={handleGoogle}
          disabled={googleLoading || submitting}
          className="metanoia-google-btn register-google-btn"
        >
          <GoogleIcon />
          <span>
            {googleLoading ? "Đang kết nối Google..." : "Đăng ký với Google"}
          </span>
        </button>
        <div className="register-sso-hint">
          <span className="register-sso-dot" aria-hidden="true" />
          <span>Đồng bộ tức thì Google Calendar</span>
        </div>
      </div>

      {/* Divider */}
      <div className="register-divider">
        <div className="register-divider-line" />
        <span className="register-divider-text">HOẶC VỚI EMAIL</span>
        <div className="register-divider-line" />
      </div>

      {/* Form */}
      <form className="register-form" onSubmit={handleSubmit} noValidate>
        {/* Name */}
        <div className="register-field">
          <label className="register-field-label" htmlFor="name">
            Họ và tên
          </label>
          <div className="register-input-wrap">
            <input
              id="name"
              name="name"
              type="text"
              autoComplete="name"
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Nguyễn Văn A"
              className="register-input"
            />
            <span
              className="material-symbols-outlined register-input-icon"
              aria-hidden="true"
            >
              person
            </span>
          </div>
        </div>

        {/* Email */}
        <div className="register-field">
          <label className="register-field-label" htmlFor="email">
            Email
          </label>
          <div className="register-input-wrap">
            <input
              id="email"
              name="email"
              type="email"
              autoComplete="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="nguyenvana@gmail.com"
              className="register-input"
            />
            <span
              className="material-symbols-outlined register-input-icon"
              aria-hidden="true"
            >
              alternate_email
            </span>
          </div>
        </div>

        {/* Password */}
        <div className="register-field">
          <label className="register-field-label" htmlFor="password">
            Mật khẩu
          </label>
          <div className="register-input-wrap">
            <input
              id="password"
              name="password"
              type={showPassword ? "text" : "password"}
              autoComplete="new-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••••••"
              className="register-input register-input--with-toggle"
            />
            <button
              type="button"
              onClick={() => setShowPassword((v) => !v)}
              className="register-toggle"
              aria-label={showPassword ? "Ẩn mật khẩu" : "Hiện mật khẩu"}
            >
              <span className="material-symbols-outlined" aria-hidden="true">
                {showPassword ? "visibility_off" : "visibility"}
              </span>
            </button>
          </div>
          {passwordTooShort ? (
            <span className="register-field-error">
              Mật khẩu phải có ít nhất 8 ký tự.
            </span>
          ) : (
            <span className="register-field-hint">Ít nhất 8 ký tự.</span>
          )}
        </div>

        {/* Confirm */}
        <div className="register-field">
          <label className="register-field-label" htmlFor="confirm">
            Xác nhận mật khẩu
          </label>
          <div className="register-input-wrap">
            <input
              id="confirm"
              name="confirm"
              type={showPassword ? "text" : "password"}
              autoComplete="new-password"
              required
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              placeholder="••••••••••••"
              className="register-input"
            />
            <span
              className="material-symbols-outlined register-input-icon"
              aria-hidden="true"
            >
              lock
            </span>
          </div>
          {passwordMismatch && (
            <span className="register-field-error">
              Mật khẩu xác nhận không khớp.
            </span>
          )}
        </div>

        {/* Terms */}
        <div className="register-terms">
          <input
            id="agree"
            type="checkbox"
            checked={agree}
            onChange={(e) => setAgree(e.target.checked)}
            className="register-checkbox-input"
          />
          <label htmlFor="agree" className="register-checkbox-label">
            <span className="register-checkbox-box" aria-hidden="true">
              <svg
                className="register-checkbox-check"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="3"
              >
                <polyline points="20 6 9 17 4 12" />
              </svg>
            </span>
            <span>
              Tôi đồng ý với{" "}
              <a href="#" className="register-link register-link--strong">
                Điều khoản dịch vụ
              </a>{" "}
              và{" "}
              <a href="#" className="register-link register-link--strong">
                Chính sách bảo mật
              </a>{" "}
              của METANOIA.
            </span>
          </label>
        </div>

        {error && (
          <div className="register-alert" role="alert">
            {error}
          </div>
        )}

        {/* Submit */}
        <button
          type="submit"
          disabled={submitting || googleLoading}
          className="register-submit"
        >
          <span>
            {submitting ? "Đang tạo tài khoản..." : "Tạo tài khoản"}
          </span>
          {!submitting && (
            <span className="material-symbols-outlined" aria-hidden="true">
              arrow_forward
            </span>
          )}
        </button>
      </form>

      <p className="register-mobile-link">
        Đã có tài khoản?{" "}
        <Link to="/login" className="register-link register-link--strong">
          Đăng nhập
        </Link>
      </p>
    </div>
  );
}

/* ---------- icons + error mapping ---------- */

function GoogleIcon() {
  return (
    <svg
      className="metanoia-google-icon register-google-icon"
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
    case "email_exists":
      return "Email này đã được đăng ký. Bạn có thể đăng nhập.";
    case "user_not_found":
      return "Không tìm thấy tài khoản.";
    case "wrong_password":
      return "Mật khẩu không đúng.";
    default:
      return "Đăng ký thất bại. Vui lòng thử lại.";
  }
}
