import { useCallback, useEffect, useRef, useState } from "react";

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
  /**
   * Thử nạp lại script GIS + render nút (dùng khi lỗi mạng/cache).
   *
   * Cần thiết vì `net::ERR_CACHE_READ_FAILURE` là lỗi tạm thời — bấm
   * "Retry" sẽ tải bản mới (URL cache-busting) mà không cần F5 trang.
   */
  reload: () => void;
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

/** URL gốc của Google Identity Services client. */
const GIS_SRC = "https://accounts.google.com/gsi/client";

/**
 * Cache-busting cho script GIS.
 *
 * ⚠️ Vì sao cần: khi cache HTTP của trình duyệt bị hỏng cho domain
 * `accounts.google.com` (symptom: `net::ERR_CACHE_READ_FAILURE`), script GIS
 * tải về **nửa vời / sai** → code bên trong Google chạy lỗi
 * `Uncaught ReferenceError: gis is not defined` và nút Google không bao giờ
 * render. Thêm query param ngẫu nhiên buộc browser tải bản mới, bỏ qua
 * cache hỏng.
 */
function gisUrl(): string {
  const bust = Math.random().toString(36).slice(2, 10);
  return `${GIS_SRC}?v=${bust}`;
}

/**
 * Xoá cache hỏng của browser cho domain Google.
 *
 * `caches` là Cache Storage API (dùng cho SW/PWA) — nếu script bị cache
 * hỏng ở đó, xoá giúp browser tải lại từ network. Bọc try/catch vì
 * `caches` có thể không tồn tại (http, Safari cũ).
 */
async function purgeGoogleCaches(): Promise<void> {
  try {
    if (typeof caches === "undefined") return;
    const keys = await caches.keys();
    await Promise.all(
      keys
        .filter((k) => /google|gsi/i.test(k))
        .map((k) => caches.delete(k).catch(() => false)),
    );
  } catch {
    // Bỏ qua — không ảnh hưởng luồng đăng nhập.
  }
}

/**
 * Tạo thẻ script GIS và chờ load.
 *
 * - Cache-busting URL để né cache hỏng.
 * - Timeout: script bị treo (network chậm / bị chặn) → trả `null` thay vì
 *   để UI kẹt vô hạn ở trạng thái "loading".
 */
function injectGisScript(url: string): Promise<GisApi | null> {
  return new Promise<GisApi | null>((resolve) => {
    /*
     * ⚠️ Xoá `window.google` dở dang trước khi nạp lại.
     *
     * Khi script GIS bị tải nửa vời (cache hỏng), Google đã set
     * `window.google` nhưng chưa định nghĩa `accounts.id` → code bên trong
     * Google ném `Uncaught ReferenceError: gis is not defined`. Script mới
     * sẽ tự bỏ qua (vì `window.google` đã tồn tại) → `getGis()` vẫn null
     * → nút không bao giờ render. Xoá đi để script mới init sạch.
     */
    const w = window as unknown as { google?: unknown };
    if (w.google && !getGis()) {
      delete w.google;
    }

    const script = document.createElement("script");
    script.src = url;
    script.async = true;
    script.defer = true;

    // Timeout 8s — nếu script không bao giờ load → coi như thất bại.
    const timer = window.setTimeout(() => resolve(null), 8000);

    script.onload = () => {
      window.clearTimeout(timer);
      resolve(getGis());
    };
    // `onerror` bắt được: network fail, bị chặn bởi extension/adblock,
    // hoặc CSP chặn domain. Lỗi 403 của *asset nút* không đi qua đây —
    // nó được xử lý riêng bằng poll iframe bên dưới.
    script.onerror = () => {
      window.clearTimeout(timer);
      resolve(null);
    };

    document.head.appendChild(script);
  });
}

function loadGisScript(): Promise<GisApi | null> {
  if (gisScriptPromise) return gisScriptPromise;

  gisScriptPromise = (async () => {
    // 1) Script đã có sẵn (điều hướng SPA qua lại) → dùng luôn.
    const existing = document.querySelector<HTMLScriptElement>(
      `script[src^="${GIS_SRC}"]`,
    );
    if (existing) {
      const ready = getGis();
      if (ready) return ready;
      // Script cũ đang tải (hoặc đã hỏng) → chờ load, hết giờ thì thử lại
      // bằng URL mới (cache-busting).
      const loaded = await new Promise<boolean>((resolve) => {
        const timer = window.setTimeout(() => resolve(false), 3000);
        existing.addEventListener(
          "load",
          () => {
            window.clearTimeout(timer);
            resolve(true);
          },
          { once: true },
        );
        existing.addEventListener(
          "error",
          () => {
            window.clearTimeout(timer);
            resolve(false);
          },
          { once: true },
        );
      });
      if (loaded && getGis()) return getGis();
      // Xoá script hỏng → nạp lại bản sạch.
      existing.remove();
    }

    // 2) Nạp bản cache-busting (né cache hỏng gây `gis is not defined`).
    const gis = await injectGisScript(gisUrl());
    if (gis) return gis;

    // 3) Xoá cache hỏng + thử lại 1 lần nữa.
    await purgeGoogleCaches();
    const retry = await injectGisScript(gisUrl());
    return retry;
  })();

  return gisScriptPromise;
}

/**
 * Xoá script GIS đang tải + reset cache promise → lần `loadGisScript()` sau
 * sẽ nạp lại từ đầu (URL cache-busting).
 *
 * Dùng cho nút "Retry" khi load thất bại (cache hỏng / mạng lỗi).
 */
export function resetGisScript(): void {
  gisScriptPromise = null;
  document
    .querySelectorAll<HTMLScriptElement>(`script[src^="${GIS_SRC}"]`)
    .forEach((s) => s.remove());
  /*
   * Xoá `window.google` để script mới init lại từ đầu.
   *
   * ⚠️ Luôn xoá (kể cả khi `accounts.id` đang tồn tại): nếu giữ lại, script
   * Google mới thấy `window.google` đã có → **không** re-define
   * `accounts.id.renderButton` → nút không render lại sau khi Retry.
   */
  const w = window as unknown as { google?: unknown };
  delete w.google;
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
  const [state, setState] = useState<
    Omit<GoogleIdentityState, "reload">
  >({
    status: "loading",
    message: null,
    canUseButton: false,
  });

  /**
   * Số lần thử nạp GIS — tăng mỗi lần bấm "Retry".
   *
   * Dùng làm dependency của effect → effect chạy lại từ đầu, nạp script
   * mới (URL cache-busting) và render lại nút.
   */
  const [attempt, setAttempt] = useState(0);

  /** Callback ổn định để không re-init khi parent render lại. */
  const credRef = useRef(onCredential);

  // Gán ref trong effect (không gán trong render) để tuân thủ rules-of-hooks.
  useEffect(() => {
    credRef.current = onCredential;
  }, [onCredential]);

  /**
   * Thử lại: xoá script GIS cũ + cache promise → effect chạy lại nhờ
   * `attempt` tăng → nạp bản mới từ network.
   */
  const reload = useCallback(() => {
    resetGisScript();
    setAttempt((n) => n + 1);
  }, []);

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
            "Could not load Google Sign-In (network error or blocked by the browser). Please try again.",
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
                  "Google Sign-In was not successful. Please try again.",
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
            "Could not initialize Google Sign-In. VITE_GOOGLE_CLIENT_ID may be invalid.",
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
          message: "Could not find the Google Sign-In button on this page.",
          canUseButton: false,
        });
        return;
      }

      // Xoá nút cũ (nếu có) để không render chồng 2 nút Google.
      host.replaceChildren();

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
            "Could not render the Google Sign-In button. VITE_GOOGLE_CLIENT_ID may be invalid.",
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
              "Google does not allow sign-in at this address. Add the domain to Authorized JavaScript origins in Google Cloud Console (including http://localhost:5173).",
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
  }, [hostId, attempt]);

  return { ...state, reload };
}
