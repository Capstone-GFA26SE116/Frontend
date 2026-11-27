/**
 * ===========================================================
 * Bộ lọc lỗi từ bên thứ ba (extension trình duyệt + Google GIS)
 * ===========================================================
 *
 * Vấn đề: khi đăng nhập bằng Google, trang `/login` bị các extension trình
 * duyệt inject script vào (Google Translate, adblocker, extension "Google
 * Login"...). Các script đó gọi `chrome.runtime.sendMessage(...)` tới
 * background service worker — nhưng service worker đã ngủ/nhận ứng dụng
 * đã đóng → Chrome ném:
 *
 *   Uncaught (in promise) Error: Could not establish connection.
 *   Receiving end does not exist.
 *
 * Lỗi này **không phải do app**, nhưng vẫn hiện đỏ trong Console và gây
 * nhiễu khi debug. Ở đây ta nuốt đúng các mẫu lỗi đã biết (extension +
 * GIS), và để mọi lỗi khác đi nguyên vẹn.
 *
 * ⚠️ Chỉ lọc theo mẫu chữ rất đặc trưng → không nuốt lỗi thật của app.
 */

/** Các mẫu lỗi nổi tiếng từ extension trình duyệt / Google GIS. */
const IGNORED_PATTERNS: RegExp[] = [
  // extension gọi chrome.runtime.sendMessage khi không có receiver.
  /Could not establish connection\.?/i,
  /Receiving end does not exist/i,
  // Unchecked runtime.lastError (do chính extension log ra).
  /Unchecked runtime\.lastError/i,
  // contentScript của Google Translate (đọc thuộc tính 'sourceLang').
  /reading 'sourceLang'/i,
  /reading "sourceLang"/i,
  // Script GIS bị cache hỏng → biến `gis` bên trong bundle của Google chưa
  // được khai báo.
  /\bgis is not defined\b/i,
];

/** Kiểm tra message có khớp mẫu nào cần bỏ qua không. */
function shouldIgnore(message: string): boolean {
  return IGNORED_PATTERNS.some((re) => re.test(message));
}

/** Rút message từ mọi dạng "reason" của unhandledrejection. */
function extractMessage(reason: unknown): string {
  if (typeof reason === "string") return reason;
  if (reason instanceof Error) return `${reason.name}: ${reason.message}`;
  if (reason && typeof reason === "object") {
    const r = reason as { message?: unknown; name?: unknown };
    return [r.name, r.message]
      .filter((v) => typeof v === "string")
      .join(": ");
  }
  return String(reason);
}

/** Đã cài đặt hay chưa (tránh cài 2 lần khi HMR). */
let installed = false;

/**
 * Cài bộ lọc. Gọi 1 lần ở đầu `main.tsx`, trước khi render React.
 *
 * Hiệu quả:
 *  - `unhandledrejection` của extension → `preventDefault()` → Console không
 *    còn báo đỏ "Uncaught (in promise) ...".
 *  - `error` từ script bên thứ ba → `stopPropagation()` + `preventDefault()`
 *    → không hiện dòng đỏ trong Console.
 */
export function installThirdPartyErrorFilter(): void {
  if (installed) return;
  if (typeof window === "undefined") return;
  installed = true;

  window.addEventListener("unhandledrejection", (event) => {
    const message = extractMessage(event.reason);
    if (shouldIgnore(message)) {
      event.preventDefault();
    }
  });

  window.addEventListener("error", (event) => {
    /*
     * Chỉ lọc lỗi tới từ resource BÊN NGOÀI app (script của extension inject,
     * asset của Google trong iframe). Lỗi runtime của chính app luôn được
     * giữ nguyên để không che mất bug thật.
     *
     * - `event.target` là element lỗi (script/img/iframe) → lỗi tải resource.
     * - `event.target` là `window` → lỗi runtime JS → KHÔNG lọc.
     */
    const target = event.target as
      | (EventTarget & { src?: string; tagName?: string })
      | null;

    const isExternalResource =
      !!target &&
      target !== window &&
      typeof target === "object" &&
      "src" in target &&
      typeof target.src === "string" &&
      target.src.length > 0;

    const message = event.message ?? "";
    if (shouldIgnore(message)) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    if (isExternalResource) {
      // Script bên ngoài (extension) load lỗi → nuốt để Console sạch.
      event.preventDefault();
      event.stopPropagation();
    }
  });
}
