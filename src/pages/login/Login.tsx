import { useState } from "react";
import { Link, useLocation, useNavigate, useSearchParams } from "react-router-dom";
import { useAuth } from "../../auth/AuthContext";
import type { AuthError } from "../../auth/types";
import { getPostLoginPath } from "../../auth/post-login-redirect";
import { useGoogleIdentity } from "../../auth/useGoogleIdentity";
import loginHeroWebp from "../../login-hero.webp";
import loginHeroPng from "../../login-hero.png";
import "./login.css";

/**
 * Trang đăng nhập.
 *
 * ⚠️ Chỉ hỗ trợ **Google Sign-In** — backend (`POST /api/Auth/google`) chỉ
 * nhận `idToken` từ Google Identity Services. Không có endpoint
 * email/password thật, nên form email + mật khẩu cũ chỉ là mock localStorage
 * (`verifyCredentials`) → đã bỏ hoàn toàn khỏi UI.
 *
 * Flow:
 *  - Bấm "Continue with Google" → forward click xuống nút GIS chính thức.
 *  - GIS trả `idToken` → `useAuth().loginWithGoogle(idToken)`.
 *  - Ok → điều hướng tới trang đích (`from` > Landing > Dashboard).
 *  - Lỗi → hiện alert rõ ràng, không leak lý do kỹ thuật.
 *
 * Sau khi đăng ký thành công, Register redirect về /login với query
 * `?registered=1` để hiện banner "Đăng ký thành công".
 *
 * Visual: split-screen 2 cột trong 1 khung card (mẫu tham khảo):
 *   trái = visual panel (logo, quote, dots) · phải = form panel.
 *   Toàn bộ bám DESIGN.md: hairline chrome, single green accent, không shadow.
 */
export function LoginPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams, setSearchParams] = useSearchParams();
  const { loginWithGoogle, isNewUser } = useAuth();

  const registeredFlag = searchParams.get("registered") === "1";
  const [error, setError] = useState<string | null>(null);
  const [googleLoading, setGoogleLoading] = useState(false);
  // Banner chỉ hiện 1 lần rồi user dismiss / navigate đi thì xoá khỏi URL
  // để tránh F5 lại vẫn thấy.
  //
  // Banner derive trực tiếp từ URL (`?registered=1`) + cờ `dismissed` nội bộ
  // → không cần effect đồng bộ (tránh cascading render).
  const [dismissedBanner, setDismissedBanner] = useState(false);
  const showSuccessBanner = registeredFlag && !dismissedBanner;

  const from = (location.state as { from?: string } | null)?.from;

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
        /*
         * `isNewUser = true` → tài khoản vừa được tạo (hoặc vừa được nhận
         * từ Admin) → chưa có onboarding → đưa thẳng vào màn onboarding.
         * Admin vẫn vào /admin (đã xử lý trong `getPostLoginPath`).
         *
         * Spec: `FE_CHANGES.md` mục 1.1 + 1.3.
         */
        const target = isNewUser
          ? "/onboarding"
          : getPostLoginPath(from, res.session.user);
        navigate(target, { replace: true });
      } else {
        setError(mapError(res.error));
      }
    },
  });

  /** Google lỗi → không có đường đăng nhập thay thế → hiện hướng dẫn. */
  const googleBroken =
    google.status === "failed" || google.status === "unconfigured";
  /** Nút Google có dùng được không (đã render xong). */
  const googleReady = google.status === "ready";

  function dismissSuccessBanner() {
    setDismissedBanner(true);
    // Xoá query khỏi URL nhưng giữ nguyên trang.
    const next = new URLSearchParams(searchParams);
    next.delete("registered");
    setSearchParams(next, { replace: true });
  }

  async function handleGoogle() {
    setError(null);

    // Chưa cấu hình Client ID → báo rõ.
    if (google.status === "unconfigured") {
      setError(
        "Google Sign-In is not configured on this environment. Please contact an administrator.",
      );
      return;
    }

    // Script/asset lỗi (403 do origin chưa whitelist, network fail) → báo rõ.
    if (google.status === "failed") {
      setError(
        google.message ??
          "Google Sign-In is currently unavailable. Please try again in a moment.",
      );
      return;
    }

    // Script chưa xong → bấm lại sau.
    if (google.status !== "ready") {
      setError("Google Sign-In is still loading. Please try again in a moment.");
      return;
    }

    setGoogleLoading(true);
    /*
     * Có Client ID + script đã load → forward click xuống nút GIS chính thủc
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
      // GIS chưa load xong hoặc chưa renderButton xong → fallback về prompt().
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

  return (
    <div className="login">
      {/* ================= Split card ================= */}
      <div className="login-split">
        {/* ---------- LEFT: visual panel ---------- */}
        <aside className="login-visual" aria-hidden="true">
          {/* Ảnh minh hoạ sản phẩm — chiếm phần "trống" của panel.
              • WebP làm src chính (54KB), PNG fallback (1.2MB) cho browser cũ.
              • `object-position: left` để khi panel hẹp (thiếu chỗ) ảnh lấy
                từ phía BÊN TRÁI, không lấy ở giữa. */}
          <picture>
            <source srcSet={loginHeroWebp} type="image/webp" />
            <img
              className="login-visual-image"
              src={loginHeroPng}
              alt=""
              loading="eager"
              decoding="async"
              fetchPriority="high"
            />
          </picture>

          {/* Dot-grid depth cue — hairline mờ, mask fade ra rìa. */}
          <div className="login-visual-bg" />

          {/* Scram tối trên/dưới → logo ảnh nổi bật hơn. */}
          <div className="login-visual-scrim" />
        </aside>

        {/* ---------- RIGHT: form panel ---------- */}
        <main className="login-form-panel">
          {/* Thanh trên — nút "Back to website" ở góc phải */}
          <div className="login-panel-top">
            <Link to="/" className="login-visual-back">
              <span className="material-symbols-outlined">arrow_back</span>
              <span>Back to website</span>
            </Link>
          </div>

          {/* Header — chỉ eyebrow (đã bỏ tiêu đề "Đăng nhập") */}
          <header className="login-header">
            <span className="login-eyebrow">SIGN-IN PORTAL</span>
          </header>

          {/* Success banner: hiện sau khi đăng ký thành công */}
          {showSuccessBanner && (
            <div className="login-banner login-banner--success" role="status">
              <span className="material-symbols-outlined login-banner-icon">
                check_circle
              </span>
              <div className="login-banner-body">
                <strong className="login-banner-title">Signed up successfully!</strong>
                <span className="login-banner-text">
                  Your account is ready. Please sign in to continue.
                </span>
              </div>
              <button
                type="button"
                onClick={dismissSuccessBanner}
                className="login-banner-close"
                aria-label="Close notification"
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
                  disabled={googleLoading || !googleReady}
                  className="metanoia-google-btn login-google-btn"
                  aria-busy={googleLoading}
                >
                  <GoogleIcon />
                  <span>
                    {googleLoading
                      ? "Connecting to Google..."
                      : googleReady
                        ? "Continue with Google"
                        : "Loading Google Sign-In..."}
                  </span>
                </button>
                <div className="login-sso-hint">
                  <span className="login-sso-dot" aria-hidden="true" />
                  <span>Instant Google Calendar sync</span>
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
                  <strong>Google Sign-In is currently unavailable</strong>
                  <span className="login-banner-text">
                    {google.message ??
                      "Google Sign-In is not configured on this environment."}
                  </span>
                  {/*
                    Nút "Retry" — lỗi mạng / cache hỏng (`ERR_CACHE_READ_FAILURE`)
                    là tạm thời → nạp lại script GIS không cần F5.
                  */}
                  {google.status === "failed" && (
                    <button
                      type="button"
                      className="login-banner-action"
                      onClick={google.reload}
                    >
                      <span className="material-symbols-outlined" aria-hidden="true">
                        refresh
                      </span>
                      <span>Retry</span>
                    </button>
                  )}
                </div>
              </div>
            )}
          </div>

          {/* Alert lỗi chung */}
          {error && (
            <div className="login-alert" role="alert">
              <span
                className="material-symbols-outlined login-alert-icon"
                aria-hidden="true"
              >
                error
              </span>
              <span>{error}</span>
            </div>
          )}

          {/* Divider */}
          <div className="login-divider">
            <div className="login-divider-line" />
            <span className="login-divider-text">HOẶC</span>
            <div className="login-divider-line" />
          </div>

          {/* CTA đăng ký */}
          <Link to="/register" className="login-register">
            <span className="material-symbols-outlined" aria-hidden="true">
              person_add
            </span>
            <span className="login-register-text">Create a new account</span>
            <span
              className="material-symbols-outlined login-register-arrow"
              aria-hidden="true"
            >
              arrow_forward
            </span>
          </Link>

          {/* Link đăng nhập (desktop) — đã có sẵn ở topbar của AuthLayout */}
          <p className="login-switch">
            <Link to="/login" className="login-link login-link--strong">
              Sign in with a different account
            </Link>
          </p>
        </main>
      </div>
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
    case "google_auth_failed":
      return "Google Sign-In failed. Please try again.";
    case "session_expired":
      return "Your session has expired. Please sign in again.";
    default:
      return "Sign-in failed. Please try again.";
  }
}
