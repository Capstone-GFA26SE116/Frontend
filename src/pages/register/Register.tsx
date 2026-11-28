import { useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { useAuth } from "../../auth/AuthContext";
import type { AuthError } from "../../auth/types";
import { getPostLoginPath } from "../../auth/post-login-redirect";
import { useGoogleIdentity } from "../../auth/useGoogleIdentity";
import loginHeroWebp from "../../login-hero.webp";
import loginHeroPng from "../../login-hero.png";
// Register dùng CHUNG stylesheet với Login để 2 trang hiển thị giống hệt.
import "../login/login.css";

/**
 * Sign-up page.
 *
 * ⚠️ Google-only — from now on every account is created through Google
 * Identity Services. The old email/password form (name / email / password /
 * confirm) was removed: the backend has no real email+password endpoint, so
 * the form was only a localStorage mock.
 *
 * Flow:
 *  - Click "Sign up with Google" → forward click to the official GIS button.
 *  - GIS returns an `idToken` → `useAuth().loginWithGoogle(idToken)`.
 *  - Brand-new account (`isNewUser`) → straight to /onboarding.
 *  - Existing account → normal post-login destination (admin → /admin).
 *  - Failure → inline alert, no technical details leaked.
 *
 * Visual: identical split-screen to /login (hero image left, form right).
 */
export function RegisterPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const { loginWithGoogle } = useAuth();

  const [error, setError] = useState<string | null>(null);
  const [googleLoading, setGoogleLoading] = useState(false);

  const from = (location.state as { from?: string } | null)?.from;

  /**
   * Google Identity Services (GIS) — shared hook with the Login page.
   * `accounts.id` is used (Sign In With Google) because the backend needs the
   * idToken (JWT), while `initTokenClient` only returns an access_token.
   */
  const google = useGoogleIdentity({
    hostId: "register-google-signin-host",
    onCredential: async (idToken: string) => {
      setGoogleLoading(true);
      const res = await loginWithGoogle(idToken);
      setGoogleLoading(false);
      if (res.ok) {
        /*
         * A brand-new account has `onboardingCompleted === false` → send the
         * user straight to onboarding. Otherwise use the regular post-login
         * destination (admin → /admin).
         */
        const target =
          res.session.user.onboardingCompleted === false
            ? "/onboarding"
            : getPostLoginPath(from, res.session.user);
        navigate(target, { replace: true });
      } else {
        setError(mapError(res.error));
      }
    },
  });

  /** Google unavailable (403 / missing Client ID) → no button, clear guidance. */
  const googleBroken =
    google.status === "failed" || google.status === "unconfigured";
  /** The Google button is usable once GIS has rendered it. */
  const googleReady = google.status === "ready";

  async function handleGoogle() {
    setError(null);

    if (google.status === "unconfigured") {
      setError(
        "Google Sign-In is not configured on this environment. Please contact an administrator.",
      );
      return;
    }

    if (google.status === "failed") {
      setError(
        google.message ??
          "Google Sign-In is currently unavailable. Please try again in a moment.",
      );
      return;
    }

    if (google.status !== "ready") {
      setError("Google Sign-In is still loading. Please try again in a moment.");
      return;
    }

    setGoogleLoading(true);
    /*
     * Forward the click to the official GIS button rendered by renderButton().
     * This keeps the whole OAuth flow (popup + id_token callback) inside
     * Google, which is the only reliable path for users without a Google
     * session.
     */
    const host = document.getElementById("register-google-signin-host");
    const innerBtn = host?.querySelector<HTMLElement>(
      'div[role="button"], button, iframe',
    );
    if (innerBtn) {
      innerBtn.click();
      window.setTimeout(() => setGoogleLoading(false), 800);
    } else {
      setGoogleLoading(false);
      setError("Google Sign-In is still loading. Please try again in a moment.");
    }
  }

  return (
    <div className="login">
      {/* ================= Split card ================= */}
      <div className="login-split">
        {/* ---------- LEFT: visual panel ---------- */}
        <aside className="login-visual" aria-hidden="true">
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

          {/* Dot-grid depth cue — hairline, fading out at the edges. */}
          <div className="login-visual-bg" />

          {/* Dark scrim on top → the logo in the image stays readable. */}
          <div className="login-visual-scrim" />
        </aside>

        {/* ---------- RIGHT: form panel ---------- */}
        <main className="login-form-panel">
          {/* Top bar — "Back to website" in the top-right corner */}
          <div className="login-panel-top">
            <Link to="/" className="login-visual-back">
              <span className="material-symbols-outlined">arrow_back</span>
              <span>Back to website</span>
            </Link>
          </div>

          {/* Header — eyebrow only (mirrors /login) */}
          <header className="login-header">
            <span className="login-eyebrow">SIGN-UP PORTAL</span>
          </header>

          {/* Google SSO — the only sign-up method */}
          <div className="login-sso">
            {/*
              ⚠️ The host `register-google-signin-host` MUST always exist in the
              DOM — the hook renders the official button into it. Hiding it
              entirely would surface a misleading "button not found" error
              instead of the real cause (403 / missing Client ID).
            */}
            <div
              id="register-google-signin-host"
              className="login-google-gis-host"
              hidden={googleBroken}
            />
            {!googleBroken && (
              <>
                <button
                  type="button"
                  id="register-google-btn"
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
                        ? "Sign up with Google"
                        : "Loading Google Sign-In..."}
                  </span>
                </button>
                <div className="login-sso-hint">
                  <span className="login-sso-dot" aria-hidden="true" />
                  <span>Instant Google Calendar sync</span>
                </div>
              </>
            )}

            {/* Warning when Google cannot be used → explicit guidance. */}
            {googleBroken && (
              <div className="login-banner login-banner--warning" role="status">
                <span className="material-symbols-outlined login-banner-icon">
                  info
                </span>
                <div className="login-banner-body">
                  <strong>Google Sign-Up is currently unavailable</strong>
                  <span className="login-banner-text">
                    {google.message ??
                      "Google Sign-Up is not configured on this environment."}
                  </span>
                  {/* Retry — lỗi mạng / cache hỏng là tạm thời. */}
                  {google.status === "failed" && (
                    <button
                      type="button"
                      className="login-banner-action"
                      onClick={google.reload}
                    >
                      <span
                        className="material-symbols-outlined"
                        aria-hidden="true"
                      >
                        refresh
                      </span>
                      <span>Retry</span>
                    </button>
                  )}
                </div>
              </div>
            )}
          </div>

          {/* Shared error alert */}
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
            <span className="login-divider-text">OR</span>
            <div className="login-divider-line" />
          </div>

          {/* CTA — already have an account */}
          <Link to="/login" className="login-register">
            <span className="material-symbols-outlined" aria-hidden="true">
              login
            </span>
            <span className="login-register-text">Sign in to your account</span>
            <span
              className="material-symbols-outlined login-register-arrow"
              aria-hidden="true"
            >
              arrow_forward
            </span>
          </Link>
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
      return "Google Sign-Up failed. Please try again.";
    case "session_expired":
      return "Your session has expired. Please sign in again.";
    case "email_exists":
      return "This email is already registered. Please sign in instead.";
    default:
      return "Sign-up failed. Please try again.";
  }
}
