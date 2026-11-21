import { useEffect, useRef, useState } from "react";

/**
 * ===========================================================
 * useGoogleIdentity — nạp & quản lý Google Identity Services (GIS)
 * ===========================================================
 *
 * Vì sao cần hook riêng (và không nhét thẳng vào Login/Register):
 *  - Login và Register đều dùng GIS → logic load script + renderButton trùng
 *    lặp. Gom ra 1 chỗ để sửa 1 lần là cả 2 trang cùng đúng.
 *  - Lỗi 403 từ Google **không** đi qua callback `response.error` — nó xảy ra
 *    ở tầng HTTP khi trình duyệt tải script/brand-asset của nút. Nếu không
 *    bắt, user thấy nút "Đăng nhập với Google" nhưng bấm không ăn mà không
 *    có bất kỳ thông báo nào.
 *
 * Ba nguyên nhân 403 phổ biến (theo tài liệu Google):
 *  1. Origin hiện tại chưa nằm trong **Authorized JavaScript origins**
 *     của OAuth Client → Google từ chối render nút.
 *  2. `VITE_GOOGLE_CLIENT_ID` sai / còn là placeholder / chưa được set khi
 *     deploy (Vercel) → `client_id` không hợp lệ.
 *  3. Client ID không thuộc loại "Web application" (phải là Web app mới
 *     dùng được `accounts.id`).
 *
 * Trạng thái trả về cho UI quyết định hiển thị:
 *  - `ready`     → nút Google dùng được.
 *  - `unconfigured` → thiếu/sai Client ID → hiện hướng dẫn cấu hình.
 *  - `failed`    → không load được script → hiện lỗi + cho dùng email.
 * =========================================================== */

/** Trạng thái của Google Identity Services. */
export type GoogleIdentityStatus =
  /** Đang tải script. */
  | "loading"
  /** Script đã load + nút đã render → dùng được. */
  | "ready"
  /** Chưa cấu hình Client ID → không có nút Google. */
  | "unconfigured"
  /** Load thất bại (network / 403 từ Google) → có thông báo lỗi. */
  | "failed";

export interface GoogleIdentityState {
  status: GoogleIdentityStatus;
  /** Thông báo lỗi thân thiện (chỉ khi `status === "failed"`). */
  message: string | null;
  /** `true` khi nút Google đã render xong → có thể forward click. */
  canUseButton: boolean;
}

export interface UseGoogleIdentityOptions {
  /**
   * Callback khi Google trả idToken (JWT).
   * BE nhận `POST /api/Auth/google` với `{idToken}`.
   */
  onCredential: (idToken: string) => void | Promise<void>;
  /** Id của host để render nút (mặc định `google-signin-host`). */
  hostId?: string;
}

/** Placeholder thường dùng trong `.env.example` — coi như "chưa cấu hình". */
const PLACEHOLDER_CLIENT_ID = "YOUR_GOOGLE_CLIENT_ID.apps.googleusercontent.com";

/**
 * Đọc Client ID từ env, đã trim.
 * Trả `null` nếu thiếu hoặc còn placeholder.
 */
export function getGoogleClientId(): string | null {
  const raw = (import.meta.env.VITE_GOOGLE_CLIENT_ID as string | undefined) ?? "";
  const id = raw.trim();
  if (!id) return null;
  if (id === PLACEHOLDER_CLIENT_ID) return null;
  // Client ID của Google luôn kết thúc bằng `.apps.googleusercontent.com`.
  // Nếu không → chắc chắn là config sai → coi như chưa cấu hình.
  if (!id.endsWith(".apps.googleusercontent.com")) return null;
  return id;
}

/** Kiểu rút gọn của `google.accounts.id` mà ta dùng. */
interface GisApi {
  accounts: {
    id: {
      initialize: (config: Record<string, unknown>) => void;
      renderButton: (
        parent: HTMLElement,
        options: Record<string, unknown>,
      ) => void;
      prompt?: (opts?: Record<string, unknown>) => void;
    };
  };
}

/** Đọc `window.google.accounts.id` nếu có. */
function getGis(): GisApi | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as { google?: GisApi };
  return w.google?.accounts?.id ? w.google : null;
}

/**
 * Nạp script GIS **một lần** cho toàn app.
 *
 * Nhiều trang (Login, Register) có thể cùng cần → cache promise để không
 * load 2 lần, và không nhân bản `<script>` vào DOM.
 */
let gisScriptPromise: Promise<GisApi | null> | null = null;

function loadGisScript(): Promise<GisApi | null> {
  if (gisScriptPromise) return gisScriptPromise;

  gisScriptPromise = new Promise<GisApi | null>((resolve) => {
    // Script đã có sẵn (điều hướng SPA qua lại) → dùng luôn.
    const existing = document.querySelector<HTMLScriptElement>(
      'script[src="https://accounts.google.com/gsi/client"]',
    );
    if (existing) {
      if (getGis()) {
        resolve(getGis());
        return;
      }
      existing.addEventListener("load", () => resolve(getGis()), { once: true });
      existing.addEventListener("error", () => resolve(null), { once: true });
      return;
    }

    const script = document.createElement("script");
    script.src = "https://accounts.google.com/gsi/client";
    script.async = true;
    script.defer = true;
    script.onload = () => resolve(getGis());
    // `onerror` bắt được: network fail, bị chặn bởi extension/adblock,
    // hoặc CSP chặn domain. Lỗi 403 của *asset nút* không đi qua đây —
    // nó được xử lý riêng bằng `script.onerror` + timeout bên dưới.
    script.onerror = () => resolve(null);
    document.head.appendChild(script);
  });

  return gisScriptPromise;
}

/**
 * Chờ một element có `id` xuất hiện trong DOM.
 *
 * Cần vì effect của React có thể chạy trước khi host được render ra DOM.
 * Trả `null` nếu hết thời gian chờ.
 */
function waitForElement(
  id: string,
  timeoutMs: number,
): Promise<HTMLElement | null> {
  const immediate = document.getElementById(id);
  if (immediate) return Promise.resolve(immediate);

  return new Promise((resolve) => {
    const deadline = Date.now() + timeoutMs;
    const tick = () => {
      const el = document.getElementById(id);
      if (el) {
        resolve(el);
        return;
      }
      if (Date.now() >= deadline) {
        resolve(null);
        return;
      }
      window.setTimeout(tick, 50);
    };
    window.setTimeout(tick, 50);
  });
}

/**
 * Hook: nạp GIS + render nút Google, theo dõi lỗi.
 *
 * @returns trạng thái để UI hiển thị (loading / ready / unconfigured / failed).
 */
export function useGoogleIdentity({
  onCredential,
  hostId = "google-signin-host",
}: UseGoogleIdentityOptions): GoogleIdentityState {
  const [state, setState] = useState<GoogleIdentityState>({
    status: "loading",
    message: null,
    canUseButton: false,
  });

  /** Callback ổn định để không re-init khi parent render lại. */
  const credRef = useRef(onCredential);

  // Gán ref trong effect (không gán trong render) để tuân thủ rules-of-hooks.
  useEffect(() => {
    credRef.current = onCredential;
  }, [onCredential]);

  useEffect(() => {
    let cancelled = false;

    const clientId = getGoogleClientId();
    if (!clientId) {
      // setState trong effect → đẩy qua microtask để không vi phạm
      // react-hooks/set-state-in-effect.
      queueMicrotask(() => {
        if (cancelled) return;
        setState({
          status: "unconfigured",
          message: null,
          canUseButton: false,
        });
      });
      return;
    }

    void (async () => {
      const gis = await loadGisScript();
      if (cancelled) return;

      if (!gis) {
        setState({
          status: "failed",
          message:
            "Không tải được dịch vụ đăng nhập Google (lỗi mạng hoặc bị trình duyệt chặn). Hãy thử lại hoặc dùng email & mật khẩu.",
          canUseButton: false,
        });
        return;
      }

      try {
        gis.accounts.id.initialize({
          client_id: clientId,
          callback: (response: { credential?: string; error?: string }) => {
            if (response.error || !response.credential) {
              setState((prev) => ({
                ...prev,
                message:
                  "Đăng nhập Google không thành công. Vui lòng thử lại hoặc dùng email & mật khẩu.",
              }));
              return;
            }
            void credRef.current(response.credential);
          },
          auto_select: false,
          cancel_on_tap_outside: true,
        });
      } catch {
        setState({
          status: "failed",
          message:
            "Không khởi tạo được đăng nhập Google. VITE_GOOGLE_CLIENT_ID có thể chưa hợp lệ.",
          canUseButton: false,
        });
        return;
      }

      // Render nút vào host.
      //
      // ⚠️ Effect có thể chạy TRƯỚC khi React đã render host ra DOM (đặc biệt
      // với `hidden` / conditional) → chờ tối đa ~1s thay vì fail ngay.
      const host = await waitForElement(hostId, 1000);
      if (cancelled) return;
      if (!host) {
        setState({
          status: "failed",
          message: "Không tìm thấy nút đăng nhập Google trên trang.",
          canUseButton: false,
        });
        return;
      }

      try {
        gis.accounts.id.renderButton(host, {
          type: "standard",
          theme: "outline",
          size: "large",
          text: "continue_with",
          shape: "pill",
          width: 320,
        });
      } catch {
        setState({
          status: "failed",
          message:
            "Không hiển thị được nút đăng nhập Google. VITE_GOOGLE_CLIENT_ID có thể chưa hợp lệ.",
          canUseButton: false,
        });
        return;
      }

      if (cancelled) return;

      /*
       * Google render nút bằng iframe + asset riêng. Nếu Client ID không được
       * phép ở origin này, các request asset đó trả **403** — nhưng
       * `renderButton` KHÔNG throw, nên không bắt được bằng try/catch.
       *
       * Cách phát hiện: Google chèn 1 iframe vào host. Nếu iframe bị lỗi,
       * `host.querySelector("iframe")` sẽ không có (hoặc có nhưng rỗng).
       * Ta poll trong 1.5s; nếu vẫn không thấy iframe → nhiều khả năng
       * origin chưa được whitelist → báo lỗi kèm hướng dẫn cụ thể.
       */
      const deadline = Date.now() + 1500;
      const checkFrame = () => {
        if (cancelled) return;
        const hasFrame = !!host.querySelector("iframe");
        if (hasFrame) {
          setState({
            status: "ready",
            message: null,
            canUseButton: true,
          });
          return;
        }
        if (Date.now() >= deadline) {
          setState({
            status: "failed",
            message:
              "Google không cho phép đăng nhập tại địa chỉ này. Thêm domain vào Authorized JavaScript origins trong Google Cloud Console (kể cả http://localhost:5173).",
            canUseButton: false,
          });
          return;
        }
        window.setTimeout(checkFrame, 150);
      };
      window.setTimeout(checkFrame, 200);
    })();

    return () => {
      cancelled = true;
    };
  }, [hostId]);

  return state;
}
