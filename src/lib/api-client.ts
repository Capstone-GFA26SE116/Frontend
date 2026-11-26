/**
 * Lớp gọi API cho METANOIA FE.
 *
 * Quy ước:
 * - Base URL đọc từ VITE_API_URL (.env).
 * - Mọi request tự động gắn Authorization: Bearer <token> nếu có session.
 * - Refresh token được xử lý tự động khi access token hết hạn.
 * - Chuẩn response: `{ ok: true, data: T }` hoặc `{ ok: false, error: string }`.
 */

import { isDemoMode } from "./demo-mode";
import { demoMatch } from "./demo-data";

const BASE_URL = import.meta.env.VITE_API_URL as string;
const SESSION_KEY = "metanoia:session";
const REFRESH_KEY = "metanoia:refresh";

/* ---------- session helpers ---------- */

interface StoredSession {
  token: string;
  email: string;
}

interface StoredRefresh {
  refreshToken: string;
  expiresAt: string;
}

export function getAccessToken(): string | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const s: StoredSession = JSON.parse(raw);
    return s.token ?? null;
  } catch {
    return null;
  }
}

export function getRefreshToken(): string | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(REFRESH_KEY);
    if (!raw) return null;
    const s: StoredRefresh = JSON.parse(raw);
    return s.refreshToken ?? null;
  } catch {
    return null;
  }
}

export function saveTokens(accessToken: string, refreshToken: string, _expiresAt: string, refreshExpiresAt: string): void {
  if (typeof window === "undefined") return;
  try {
    // Lưu session với email rỗng (sẽ được fetch từ /api/me sau)
    const session: StoredSession = { token: accessToken, email: "" };
    window.localStorage.setItem(SESSION_KEY, JSON.stringify(session));
    const refresh: StoredRefresh = { refreshToken, expiresAt: refreshExpiresAt };
    window.localStorage.setItem(REFRESH_KEY, JSON.stringify(refresh));
  } catch (e) {
    console.error("[api] Failed to save tokens:", e);
  }
}

export function clearTokens(): void {
  if (typeof window === "undefined") return;
  window.localStorage.removeItem(SESSION_KEY);
  window.localStorage.removeItem(REFRESH_KEY);
}

export function isRefreshExpired(expiresAt: string): boolean {
  return new Date(expiresAt) <= new Date();
}

/* ---------- typed response wrapper ---------- */

export type ApiOk<T> = { ok: true; data: T };
export type ApiErr = {
  ok: false;
  error: string;
  status?: number;
  /**
   * Payload phụ của lỗi (BE hay gửi kèm `details`).
   *
   * Quan trọng với Focus Session: 409 của `POST /api/focus/start` trả
   * `details` chính là phiên đang chạy — FE cần đọc nó để chuyển sang
   * màn hình phiên đó thay vì báo lỗi đỏ.
   */
  details?: unknown;
  /**
   * Mã lỗi kỹ thuật do BE trả (VD: `GOOGLE_RECONNECT_REQUIRED`).
   *
   * Dùng để **rẽ nhánh logic** theo mã (VD 409 + code này → gợi ý user
   * kết nối lại Google) thay vì đoán qua message.
   */
  errorCode?: string;
};
export type ApiResult<T> = ApiOk<T> | ApiErr;

/* ---------- error message extraction ---------- */

/**
 * Rút ra chuỗi lỗi từ 1 value bất kỳ của body lỗi.
 *
 * Vì sao cần: FastAPI / ASP.NET trả nhiều shape khác nhau, và **phần lớn
 * không phải string**:
 *
 * - `{ "message": "..." }`                          → chuỗi
 * - `{ "detail": { "code": "chat_in_progress" } } }`  → OBJECT  ← gây crash React
 * - `{ "error": { "code": "...", "message": "..." } }` → OBJECT lồng
 * - `{ "errors": [{ "message": "..." }] }`            → mảng object
 *
 * Nếu gán thẳng object vào biến kiểu `string` rồi render, React ném
 * "Objects are not valid as a React child" và **sập cả trang** vì không có
 * ErrorBoundary. Hàm này ép mọi shape về string an toàn.
 */
function extractMessage(v: unknown, depth = 0): string | null {
  if (v == null) return null;
  if (typeof v === "string") {
    const s = v.trim();
    return s ? s : null;
  }
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  // Chống vòng lặp / cấu trúc lồng sâu (detail.detail.detail...)
  if (depth > 4 || typeof v !== "object") return null;

  if (Array.isArray(v)) {
    for (const item of v) {
      const got = extractMessage(item, depth + 1);
      if (got) return got;
    }
    return null;
  }

  const rec = v as Record<string, unknown>;
  // Thứ tự ưu tiên: message > detail > error > title > code.
  // Bỏ qua `code` trước vì nó thường là mã kỹ thuật ("chat_in_progress"),
  // đọc cho người dùng không hiểu gì.
  for (const key of ["message", "detail", "error", "title", "reason"]) {
    const got = extractMessage(rec[key], depth + 1);
    if (got) return got;
  }
  // Không có field nào là chuỗi → stringify làm lồng ngắn gọn.
  try {
    const json = JSON.stringify(v);
    return json && json !== "{}" ? json.slice(0, 200) : null;
  } catch {
    return null;
  }
}

/**
 * Kiểm tra 1 chuỗi `detail` từ BE có phải **thông điệp kỹ thuật** hay không.
 *
 * VD 502 → `"AI unavailable, try again"` — đây là câu kỹ thuật của hạ tầng,
 * không phải lời giải thích cho người dùng. Khi đó nên dùng thông điệp
 * theo HTTP status (đã dịch sẵn) thay vì đưa thẳng câu này lên UI.
 *
 * ⚠️ Chỉ khớp với cụm từ **hạ tầng** cụ thể — không dùng quy tắc "câu ngắn
 * không có dấu chấm" vì nhiều thông điệp hợp lệ cho người dùng cũng ngắn
 * và không có dấu chấm (VD: "Your message is too long").
 *
 * @param s Chuỗi lấy từ `detail`/`message` của body lỗi.
 */
function isTechnicalDetail(s: string): boolean {
  const t = s.trim().toLowerCase();
  if (!t) return false;
  const technicalPhrases = [
    "ai unavailable",
    "service unavailable",
    "temporarily unavailable",
    "bad gateway",
    "gateway timeout",
    "internal server error",
    "upstream error",
    "try again later",
  ];
  return technicalPhrases.some((p) => t.includes(p));
}

/**
 * Rút ra **mã lỗi kỹ thuật** từ body lỗi của BE.
 *
 * BE trả mã ở nhiều vị trí khác nhau:
 *   - `{ "code": "GOOGLE_RECONNECT_REQUIRED" }`
 *   - `{ "error": "GOOGLE_RECONNECT_REQUIRED" }`
 *   - `{ "errorCode": "GOOGLE_RECONNECT_REQUIRED" }`
 *   - `{ "detail": { "code": "GOOGLE_RECONNECT_REQUIRED" } }`  (ProblemDetails)
 *
 * Chỉ dùng cho logic (VD: 409 → gợi ý kết nối lại Google), không hiển thị
 * trực tiếp cho user.
 */
function extractErrorCode(v: unknown, depth = 0): string | null {
  if (v == null || depth > 4) return null;
  if (typeof v === "string") {
    const s = v.trim();
    // Chỉ nhận mã dạng `UPPER_SNAKE` để tránh nuốt nhầm message thường.
    return /^[A-Z][A-Z0-9_]{2,}$/.test(s) ? s : null;
  }
  if (typeof v !== "object") return null;
  if (Array.isArray(v)) {
    for (const item of v) {
      const got = extractErrorCode(item, depth + 1);
      if (got) return got;
    }
    return null;
  }
  const rec = v as Record<string, unknown>;
  for (const key of ["code", "errorCode", "error_code"]) {
    const got = extractErrorCode(rec[key], depth + 1);
    if (got) return got;
  }
  for (const key of ["error", "detail", "details"]) {
    const got = extractErrorCode(rec[key], depth + 1);
    if (got) return got;
  }
  return null;
}

/**
 * Chuỗi thông báo lỗi thân thiện cho từng mã HTTP của AI service.
 *
 * Theo spec BE "API AI cho màn hình" — bảng "Mã lỗi chung".
 */
function friendlyStatusMessage(status: number): string {
  switch (status) {
    case 401:
      return "Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại.";
    case 403:
      return "Tài khoản của bạn không có quyền dùng tính năng này.";
    case 404:
      return "Không tìm thấy dữ liệu. Có thể task đã bị xoá hoặc bạn chưa tải lại trang.";
    case 409:
      return "AI đang xử lý yêu cầu trước cho task này. Vui lòng đợi vài giây rồi thử lại.";
    case 422:
      return "Dữ liệu gửi lên không hợp lệ. Vui lòng thử lại.";
    case 429:
      return "Bạn đã dùng hết lượt AI cho lúc này. Vui lòng thử lại sau.";
    case 502:
      // Spec BE: "AI đang bận, thử lại" + nút Thử lại; không bị trừ lượt.
      return "AI đang bận, thử lại sau.";
    default:
      return `Lỗi máy chủ (HTTP ${status}). Vui lòng thử lại sau.`;
  }
}

/**
 * Dịch **mã lỗi nghiệp vụ** của AI service sang thông báo cho user.
 *
 * Spec BE (bảng "Mã lỗi chung"):
 *   - 403 `plan_feature_locked` → "Tính năng này có ở gói cao hơn"
 *   - 409 `no_active_plan`      → nhắc chọn gói
 *   - 409 `project_limit`       → số còn tạo được + nút nâng cấp
 *   - 409 `already_applied` / `not_latest_draft` / `project_closed` /
 *     `domain_inactive`         → tải lại chat, báo ngắn
 *
 * Trả `null` nếu không khớp mã nào → caller dùng message mặc định.
 */
function translateAiError(
  code: string | null,
  body: unknown,
): string | null {
  if (!code) return null;

  switch (code) {
    case "plan_feature_locked":
      return "Tính năng này có ở gói cao hơn. Hãy nâng cấp để dùng.";
    case "no_active_plan":
      return "Bạn chưa có gói đang hoạt động. Hãy chọn gói để dùng tiếp.";
    case "project_limit": {
      // Body: {code, limit, used, wanted}
      const rec = (body ?? {}) as Record<string, unknown>;
      const limit = Number(rec.limit);
      const used = Number(rec.used);
      const wanted = Number(rec.wanted);
      if (Number.isFinite(limit) && Number.isFinite(used)) {
        const left = Math.max(0, limit - used);
        const suffix = Number.isFinite(wanted)
          ? ` (bạn đang chọn ${wanted})`
          : "";
        return `Gói của bạn còn tạo được ${left} dự án${suffix}.`;
      }
      return "Bạn đã dùng hết số dự án của gói. Hãy nâng cấp gói.";
    }
    case "already_applied":
      return "Bản nháp này đã được áp dụng. Hãy tải lại chat.";
    case "not_latest_draft":
      return "Bản nháp không còn là bản mới nhất. Hãy tải lại chat.";
    case "project_closed":
      return "Dự án đã đóng — không thể tiếp tục chat.";
    case "domain_inactive":
      return "Loại việc đã bị tắt. Hãy tải lại chat.";
    default:
      return null;
  }
}

/**
 * Rút mã lỗi **của AI service** — khác `extractErrorCode` của BE ở chỗ
 * chấp nhận cả mã `snake_case` thường (`plan_feature_locked`, `no_active_plan`…).
 *
 * Mã `UPPER_SNAKE` của BE vẫn được nhận.
 */
function extractAiErrorCode(v: unknown, depth = 0): string | null {
  if (v == null || depth > 4) return null;
  if (typeof v === "string") {
    const s = v.trim();
    // `snake_case` hoặc `UPPER_SNAKE`, tối thiểu 4 ký tự, có gạch dưới.
    return /^[a-z][a-z0-9]*(?:_[a-z0-9]+)+$|^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/.test(
      s,
    )
      ? s
      : null;
  }
  if (typeof v !== "object") return null;
  if (Array.isArray(v)) {
    for (const item of v) {
      const got = extractAiErrorCode(item, depth + 1);
      if (got) return got;
    }
    return null;
  }
  const rec = v as Record<string, unknown>;
  for (const key of ["code", "errorCode", "error_code"]) {
    const got = extractAiErrorCode(rec[key], depth + 1);
    if (got) return got;
  }
  for (const key of ["detail", "details"]) {
    const got = extractAiErrorCode(rec[key], depth + 1);
    if (got) return got;
  }
  return null;
}

/* ---------- core fetch ---------- */

/**
 * Đọc body JSON một cách "an toàn".
 *
 * Một số API của BE trả **204 No Content** (không có thân), ví dụ:
 *   - `GET /api/focus/current` khi không có phiên nào đang chạy
 *   - `POST /api/notifications/{id}/read`
 *
 * `res.json()` sẽ ném lỗi `Unexpected end of JSON input` với các response
 * đó → `apiFetch` rơi vào catch → trả về lỗi mạng giả, khiến UI hiển thị
 * "Không kết nối được máy chủ" thay vì "không có phiên đang chạy".
 * Hàm này trả `null` cho body rỗng / 204, và ném lỗi cho JSON hỏng.
 */
async function readJson(res: Response): Promise<unknown> {
  // 204 / 205 không có body theo chuẩn HTTP.
  if (res.status === 204 || res.status === 205) return null;

  const text = await res.text();
  if (!text) return null; // body rỗng → coi như "không có dữ liệu"

  try {
    return JSON.parse(text);
  } catch {
    // Body không phải JSON (vd: HTML error page từ proxy) → trả text thô,
    // để `extractMessage` không lỗi.
    return text;
  }
}

async function apiFetch<T>(
  path: string,
  options: RequestInit = {},
): Promise<ApiResult<T>> {
  /*
   * ⚠️ CHẾ ĐỘ DEMO (guest chưa đăng nhập, đang ở trang chủ `/`).
   *
   * Chặn request TRƯỚC khi chạm network và trả dữ liệu mẫu. Nhờ vậy:
   * - Guest không bao giờ thấy/ghi dữ liệu thật.
   * - Demo không tiêu tốn quota AI của bất kỳ ai.
   * - Không có request nào thoát ra ngoài → không rò rỉ token.
   */
  if (isDemoMode()) {
    const method = options.method ?? "GET";
    const match = demoMatch(method, path);
    if (match.handled) {
      /* Ghi (POST/PUT/DELETE) không được phép trong demo. */
      if (method.toUpperCase() !== "GET") {
        return {
          ok: false,
          status: 403,
          error:
            "This is a read-only demo. Create a free account to make changes.",
        };
      }
      return { ok: true, data: match.data as T };
    }
  }

  const url = `${BASE_URL}${path}`;
  const token = getAccessToken();
  /*
   * `hadToken` = request này có gắn Authorization hay không.
   * Dùng để phân biệt 2 trường hợp khi BE trả 401:
   *   - có token nhưng hết hạn / không hợp lệ → phiên hết hạn → redirect /login.
   *   - không có token (khách chưa đăng nhập) → endpoint cần auth → KHÔNG
   *     redirect (đá khách khỏi trang public như /pricing).
   */
  const hadToken = !!token;

  const headers: Record<string, string> = {
    // ⚠️ KHÔNG tự đặt `Content-Type` khi body là FormData — trình duyệt phải
    // tự thêm `boundary` của multipart. Đặt tay sẽ làm BE không đọc được file.
    ...(options.body instanceof FormData
      ? {}
      : { "Content-Type": "application/json" }),
    ...(options.headers as Record<string, string> | undefined),
  };

  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }

  try {
    const res = await fetch(url, { ...options, headers });

    // Nếu 401 → thử refresh
    if (res.status === 401) {
      const refreshed = await tryRefresh();
      if (refreshed.ok) {
        // Gọi lại request với token mới
        const newToken = getAccessToken();
        if (newToken) {
          headers["Authorization"] = `Bearer ${newToken}`;
          const retry = await fetch(url, { ...options, headers });
          if (!retry.ok) {
            const body = await retry.text().catch(() => "");
            let msg = friendlyStatusMessage(retry.status);
            let details: unknown;
            if (body) {
              try {
                const parsed = JSON.parse(body);
                msg = extractMessage(parsed) ?? msg;
                if (parsed && typeof parsed === "object" && "details" in parsed) {
                  details = (parsed as { details?: unknown }).details;
                }
              } catch {
                msg = body.slice(0, 200) || msg;
              }
            }
            return details !== undefined
              ? { ok: false, error: msg, status: retry.status, details }
              : { ok: false, error: msg, status: retry.status };
          }
          /*
           * ⚠️ Phải đọc `retry`, KHÔNG phải `res` — `res` là response 401 đã
           * bị body-consume, đọc nó sẽ trả `null` dù request đã thành công.
           */
          const data = await readJson(retry);
          return { ok: true, data: data as T };
        }
      }
      // Refresh thất bại hoặc không có refresh token → logout
      clearTokens();
      /*
       * ⚠️ Đang ở route DEMO + token rác → KHÔNG đá guest ra khỏi demo.
       * Demo là trang công khai, mất token không phải lý do để redirect.
       *
       * ⚠️ QUAN TRỌNG: nếu user CHƯA TỪNG đăng nhập (không có token nào)
       * thì 401 chỉ nghĩa là "endpoint này cần auth" — KHÔNG phải "phiên hết
       * hạn". Redirect /login lúc đó sẽ đá khách khỏi trang public (vd
       * /pricing gọi GET /api/subscription-plans) → họ bị "văng ra" ngoài.
       * Chỉ redirect khi thực sự có session mà session đó không còn hợp lệ.
       */
      if (!isDemoMode() && hadToken) {
        window.location.href = "/login";
      }
      return { ok: false, error: "session_expired", status: 401 };
    }

    if (!res.ok) {
      let msg = friendlyStatusMessage(res.status);
      let details: unknown;
      let errorCode: string | undefined;
      try {
        const body = await res.json();
        msg = extractMessage(body) ?? msg;
        // Mã lỗi kỹ thuật (VD `GOOGLE_RECONNECT_REQUIRED`) để caller rẽ nhánh.
        const code = extractErrorCode(body);
        if (code) errorCode = code;
        // Giữ lại `details` để caller xử lý lỗi có ngữ cảnh
        // (vd: 409 của focus/start trả về phiên đang chạy).
        if (body && typeof body === "object") {
          const rec = body as Record<string, unknown>;
          if ("details" in rec) {
            details = rec.details;
          } else if ("detail" in rec && rec.detail && typeof rec.detail === "object") {
            // ASP.NET `ProblemDetails` dùng `detail` (số ít) — có thể chứa
            // object `details` bên trong.
            const inner = rec.detail as Record<string, unknown>;
            if ("details" in inner) details = inner.details;
          }
        }
      } catch {
        // Body không phải JSON (vd: HTML error page từ proxy) → giữ msg mặc định.
      }
      return {
        ok: false,
        error: msg,
        status: res.status,
        ...(details !== undefined ? { details } : {}),
        ...(errorCode !== undefined ? { errorCode } : {}),
      };
    }

    const data = await readJson(res);
    return { ok: true, data: data as T };
  } catch (err) {
    // Network error hoặc JSON parse lỗi. `err.message` luôn là string nên an toàn,
    // nhưng thêm prefix để người dùng biết đây là lỗi kết nối chứ không phải
    // lỗi dữ liệu.
    const raw = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      error: `Không kết nối được máy chủ. Vui lòng kiểm tra mạng và thử lại. (${raw})`,
    };
  }
}

/* ---------- token refresh ---------- */

async function tryRefresh(): Promise<{ ok: boolean }> {
  const refreshToken = getRefreshToken();
  if (!refreshToken) return { ok: false };

  const refresh = await fetch(`${BASE_URL}/api/Auth/refresh`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ refreshToken }),
  });

  if (!refresh.ok) return { ok: false };

  try {
    const data = await refresh.json();
    if (data.accessToken && data.refreshToken) {
      saveTokens(
        data.accessToken,
        data.refreshToken,
        data.expiresAtUtc,
        data.refreshTokenExpiresAtUtc,
      );
      return { ok: true };
    }
  } catch {
    // ignore
  }

  return { ok: false };
}

/* ---------- public API helpers ---------- */

export async function get<T>(path: string): Promise<ApiResult<T>> {
  return apiFetch<T>(path, { method: "GET" });
}

/** `body` optional vì một số POST (archive/restore/logout) không gửi payload. */
export async function post<T>(
  path: string,
  body?: unknown,
): Promise<ApiResult<T>> {
  return apiFetch<T>(path, {
    method: "POST",
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

export async function put<T>(
  path: string,
  body: unknown,
): Promise<ApiResult<T>> {
  return apiFetch<T>(path, {
    method: "PUT",
    body: JSON.stringify(body),
  });
}

export async function del<T>(path: string): Promise<ApiResult<T>> {
  return apiFetch<T>(path, { method: "DELETE" });
}

/* ---------- auth-specific ---------- */

export interface AuthResponseDto {
  userId: string;
  email: string | null;
  fullName: string | null;
  role: string | null;
  /** URL avatar (Google picture) nếu có. */
  avatarUrl: string | null;
  accessToken: string;
  expiresAtUtc: string;
  refreshToken: string;
  refreshTokenExpiresAtUtc: string;
  /**
   * `true` khi tài khoản **vừa được tạo** hoặc **vừa được nhận** (tài khoản
   * Admin tạo sẵn, chủ nhân đăng nhập Google lần đầu).
   *
   * FE dùng để đưa người mới vào màn hình onboarding. Đăng nhập thường và
   * `POST /api/auth/refresh` luôn trả `false`.
   *
   * Spec: `FE_CHANGES.md` mục 1.1.
   */
  isNewUser?: boolean;
}

export async function loginWithGoogle(idToken: string): Promise<ApiResult<AuthResponseDto>> {
  const result = await post<AuthResponseDto>("/api/Auth/google", { idToken });
  if (result.ok) {
    saveTokens(
      result.data.accessToken,
      result.data.refreshToken,
      result.data.expiresAtUtc,
      result.data.refreshTokenExpiresAtUtc,
    );
  }
  return result;
}

export async function logoutApi(): Promise<void> {
  const refreshToken = getRefreshToken();
  await post("/api/Auth/logout", { refreshToken }).catch(() => {
    // ignore errors on logout
  });
  clearTokens();
}

/**
 * Gói thuê bao hiện tại của user (BE trả về trong GET /api/me).
 */
export interface CurrentSubscriptionDto {
  subscriptionId: string;
  planId: string;
  planName: string | null;
  /** ISO timestamp hết hạn. null = gói Miễn phí không hết hạn. */
  endAt: string | null;
}

/**
 * Response của `GET /api/me` (MeDto).
 *
 * Lưu ý: BE đã mở rộng payload (thêm `currentSubscription`,
 * `defaultBufferMinutes`, `reminderLeadMinutes`). Các field mới để
 * `?` optional để FE vẫn chạy với BE deploy cũ trả shape cũ.
 */
export interface MeResponse {
  id: string;
  email: string | null;
  fullName: string | null;
  role: string | null;
  /** URL ảnh đại diện từ Google (nếu có). */
  avatarUrl?: string | null;
  onboardingCompleted: boolean;
  timeZone: string | null;
  workDayStart: string;
  workDayEnd: string;
  worksOnWeekend: boolean;
  googleCalendarStatus: string | null;
  /** Tên gói hiện tại (BE deploy cũ). */
  currentPlanName?: string | null;
  /** Gói thuê bao hiện tại (BE deploy mới). */
  currentSubscription?: CurrentSubscriptionDto | null;
  /** Phút buffer mặc định giữa 2 block (BE deploy mới). */
  defaultBufferMinutes?: number;
  /** Phút nhắc trước khi block bắt đầu (BE deploy mới). */
  reminderLeadMinutes?: number;
}

export async function getMe(): Promise<ApiResult<MeResponse>> {
  const res = await get<MeResponse>("/api/me");
  /* MOCK: nếu đã từng gọi PUT /api/me/profile trong phiên này, áp overlay
     để lần load sau vẫn thấy tên mới (BE thật sẽ tự lưu — overlay này
     chỉ để test FE trước khi BE ready). */
  if (res.ok && MOCK_PROFILE_OVERLAY) {
    return {
      ok: true,
      data: { ...res.data, ...MOCK_PROFILE_OVERLAY },
    };
  }
  return res;
}

/* ---------- onboarding ---------- */

/**
 * Mức "làm lố" — quy đổi thành hệ số nhân cho giờ làm việc của từng loại
 * công việc: Rarely 1.10 · Sometimes 1.25 · Often 1.50 · Always 1.80.
 *
 * ⚠️ `overrunLevel` CHỈ có tác dụng khi chọn ít nhất 1 loại công việc —
 * không có cột riêng, được lưu riêng cho từng domain đã chọn.
 * Spec: `FE_CHANGES.md` mục 1.2.
 */
export type OverrunLevel = "Rarely" | "Sometimes" | "Often" | "Always";

export const OVERRUN_LEVELS: OverrunLevel[] = [
  "Rarely",
  "Sometimes",
  "Often",
  "Always",
];

/**
 * Body của `POST /api/me/onboarding`.
 *
 * ⚠️ 6 trường BẮT BUỘC — thiếu bất kỳ trường nào BE trả `400` và **không
 * lưu gì**:
 *   `timeZone`, `workDayStart`, `workDayEnd`, `worksOnWeekend`,
 *   `defaultBufferMinutes`, `reminderLeadMinutes`.
 *
 * Còn lại (`productiveHours`, `domainIds`, `overrunLevel`) là tuỳ chọn.
 */
export interface OnboardingRequest {
  /** Tên IANA, VD `Asia/Ho_Chi_Minh`. */
  timeZone: string;
  /** `HH:mm:ss`. */
  workDayStart: string;
  /** `HH:mm:ss` — phải sau `workDayStart`. */
  workDayEnd: string;
  worksOnWeekend: boolean;
  /** 0–120 phút. */
  defaultBufferMinutes: number;
  /** 0–120 phút. */
  reminderLeadMinutes: number;
  /** Giờ (0–23) user làm hiệu quả. Có thể bỏ trống. */
  productiveHours?: number[];
  /** ID các loại công việc (domain) user hay làm. Có thể bỏ trống. */
  domainIds?: string[];
  /** Mức làm lố. Chỉ gửi khi đã chọn ít nhất 1 domain. */
  overrunLevel?: OverrunLevel;
}

/**
 * `POST /api/me/onboarding` — lưu câu trả lời onboarding.
 *
 * Thành công trả `MeDto` với `onboardingCompleted = true`. Gọi lại được để
 * sửa câu trả lời — cờ không bao giờ quay về `false`.
 */
export async function submitOnboarding(
  body: OnboardingRequest,
): Promise<ApiResult<MeResponse>> {
  return post<MeResponse>("/api/me/onboarding", body);
}

/**
 * `PUT /api/me/settings` — đổi cài đặt giờ làm.
 *
 * ⚠️ Hành vi mới: khi `workDayStart`/`workDayEnd` đổi, BE **tính lại** 24
 * điểm giờ làm việc theo khung mới. FE không cần làm gì thêm.
 */
export interface UpdateSettingsRequest {
  workDayStart: string;
  workDayEnd: string;
  worksOnWeekend: boolean;
  defaultBufferMinutes: number;
  reminderLeadMinutes: number;
  timeZone: string;
}

export async function updateSettings(
  body: UpdateSettingsRequest,
): Promise<ApiResult<MeResponse>> {
  return put<MeResponse>("/api/me/settings", body);
}

/* ---------- profile update ---------- */

/**
 * Body của `PUT /api/me/profile`.
 * Swagger hiện chỉ nhận `fullName`; để optional-safe, các field khác
 * không gửi kèm để tránh BE validate lỗi.
 */
export interface UpdateProfileRequest {
  fullName: string;
}

/**
 * MOCKED: `PUT /api/me/profile`
 * BE vừa trả Swagger nhưng chưa ổn định → ta mock để FE test được luồng
 * đổi tên. Khi BE ready, thay thân hàm bằng:
 *
 *   return put<MeResponse>("/api/me/profile", body);
 *
 * Response shape giống hệt `GET /api/me` (MeResponse).
 */
export async function updateProfile(
  body: UpdateProfileRequest,
): Promise<ApiResult<MeResponse>> {
  const fullName = (body.fullName ?? "").trim();

  if (!fullName) {
    return delay({
      ok: false,
      error: "Tên hiển thị không được để trống.",
      status: 400,
    });
  }
  if (fullName.length > 100) {
    return delay({
      ok: false,
      error: "Tên hiển thị tối đa 100 ký tự.",
      status: 400,
    });
  }

  /* Gộp vào overlay để `getMe()` sau đó trả về tên mới. */
  MOCK_PROFILE_OVERLAY = { ...(MOCK_PROFILE_OVERLAY ?? {}), fullName };

  const base = MOCK_PROFILE_BASE;
  const merged: MeResponse = {
    ...base,
    ...(MOCK_PROFILE_OVERLAY ?? {}),
    fullName,
  };

  return delay({ ok: true, data: merged }, 500);
}

/**
 * Trì hoãn một promise (mô phỏng latency network cho các call mock).
 */
function delay<T>(value: T, ms = 600): Promise<T> {
  return new Promise((res) => setTimeout(() => res(value), ms));
}

/**
 * Mock overlay cho profile — `null` nghĩa là chưa update lần nào
 * (getMe trả nguyên response thật).
 */
let MOCK_PROFILE_OVERLAY: Partial<MeResponse> | null = null;

/**
 * Profile mặc định dùng để dựng response cho `PUT /api/me/profile`.
 * Khớp shape `MeResponse` + ví dụ trong Swagger.
 */
const MOCK_PROFILE_BASE: MeResponse = {
  id: "3fa85f64-5717-4562-b3fc-2c963f66afa6",
  email: "user@metanoia.app",
  fullName: "Metanoia User",
  role: "student",
  avatarUrl: null,
  onboardingCompleted: true,
  timeZone: "Asia/Ho_Chi_Minh",
  workDayStart: "08:00:00",
  workDayEnd: "17:00:00",
  worksOnWeekend: false,
  googleCalendarStatus: "not_connected",
  currentPlanName: "Free plan",
  currentSubscription: null,
  defaultBufferMinutes: 15,
  reminderLeadMinutes: 10,
};

/** Reset overlay — dùng cho test / logout. */
export function resetMockProfile(): void {
  MOCK_PROFILE_OVERLAY = null;
}

/* ---------- projects ---------- */

export interface CreateProjectRequest {
  name: string;
  description: string;
  /** ISO date `YYYY-MM-DD`. */
  startDate: string;
  /** ISO date `YYYY-MM-DD`. */
  deadline: string;
  /** UUID của client. Có thể bỏ trống (null) cho dự án nội bộ. */
  clientId: string | null;
}

export interface ProjectDto {
  id: string;
  userId: string;
  name: string;
  description: string;
  startDate: string;
  deadline: string;
  status: string;
  clientId: string;
  client: ProjectClientDto | null;
  createdAt: string;
}

/** Client lồng trong Project response (GET /api/projects/filter). */
export interface ProjectClientDto {
  id: string;
  name: string;
  contactEmail: string;
  phone: string;
}

export async function createProject(
  body: CreateProjectRequest,
): Promise<ApiResult<ProjectDto>> {
  return post<ProjectDto>("/api/projects", body);
}

/**
 * Trạng thái project — enum THẬT của backend.
 *
 * ⚠️ Code cũ trong FE giả định `"active" | "pending" | "completed"`, nhưng
 * `pending` **không tồn tại** → mọi project có status lạ (kể cả `Archived`)
 * rơi vào nhánh `else` và bị hiển thị như "Active".
 *
 * Nguồn: enum `ProjectStatus` của backend — `Active`, `OnHold`, `Completed`,
 * `Archived`. Bản `OnHold` = tạm dừng (vẫn chat/Apply được, xem FR-08b-1 #28).
 */
export const PROJECT_STATUSES = [
  "Active",
  "OnHold",
  "Completed",
  "Archived",
] as const;

export type ProjectStatusValue = (typeof PROJECT_STATUSES)[number];

/** Chuẩn hoá status của project về dạng chuẩn (fallback `Active`). */
export function normalizeProjectStatus(
  raw: string | null | undefined,
): ProjectStatusValue {
  const v = (raw ?? "").trim().toLowerCase();
  if (v === "onhold" || v === "on_hold" || v === "on-hold") return "OnHold";
  if (v === "completed" || v === "complete" || v === "done") return "Completed";
  if (v === "archived" || v === "archive") return "Archived";
  return "Active";
}

/**
 * Project đã bị archive (xoá mềm) không được hiển thị ở bất kỳ danh sách
 * chọn nào — task/milestone của nó cũng không nên xuất hiện trên lịch.
 */
export function isProjectArchived(
  p: Pick<ProjectDto, "status">,
): boolean {
  return normalizeProjectStatus(p.status) === "Archived";
}

export async function listProjects(
  params: { includeArchived?: boolean } = {},
): Promise<ApiResult<ProjectDto[]>> {
  const qs =
    params.includeArchived === true ? "?includeArchived=true" : "";
  const res = await get<ProjectDto[]>(`/api/projects${qs}`);
  if (!res.ok) return res;
  /*
   * Lọc thêm ở FE (defense in depth).
   *
   * Backend có param `includeArchived` — nhưng ta không muốn phụ thuộc vào
   * default của server (đã từng xảy ra: dự án đã archive vẫn hiện lại).
   * Lọc ở FE đảm bảo dự án đã archive KHÔNG BAO GIỜ xuất hiện.
   */
  return {
    ...res,
    data: res.data.filter((p) => !isProjectArchived(p)),
  };
}

/**
 * Lấy danh sách ID của các project đã `Archived`.
 *
 * Mục đích: các màn khác (đặc biệt là `/schedule`) nhận data đã merge từ BE
 * (task, subtask, milestone, slot) — BE không lọc project đã archive, nên FE
 * cần biết ID nào bị archive để **loại khỏi lịch**.
 *
 * Gọi `GET /api/projects?includeArchived=true` rồi lọc `Archived` ở FE.
 * Nếu BE không hỗ trợ param này → trả về set rỗng (không ẩn gì, an toàn).
 */
export async function listArchivedProjectIds(): Promise<Set<string>> {
  const res = await get<ProjectDto[]>("/api/projects?includeArchived=true");
  if (!res.ok || !Array.isArray(res.data)) return new Set<string>();
  return new Set(
    res.data.filter((p) => isProjectArchived(p)).map((p) => p.id),
  );
}

/**
 * Lấy chi tiết 1 project theo id.
 *
 * GET /api/projects/{projectId}  -> ProjectDto
 *
 * Dùng cho trang ProjectDetail (/projects/:projectId).
 */
export async function getProject(
  projectId: string,
): Promise<ApiResult<ProjectDto>> {
  if (!projectId) {
    return {
      ok: false,
      status: 0,
      error: "Project id is required",
    };
  }
  return get<ProjectDto>(`/api/projects/${encodeURIComponent(projectId)}`);
}

/* ===========================================================
 * Mock tạm — GET /api/projects/filter
 *
 * BE chưa có endpoint này, nên mình hardcode 1 danh sách dự án
 * và lọc theo query params ngay trong FE để UI hoạt động trong
 * lúc chờ BE.
 *
 * Khi BE có endpoint thật:
 *   1. Bỏ khối MOCK_PROJECTS bên dưới
 *   2. Thay body của hàm bằng: return get<ProjectDto[]>("/api/projects/filter", params)
 *   3. (Cập nhật hàm `get` để nhận query string nếu cần)
 * =========================================================== */

/** UUID mặc định để filter "dự án của tôi". Thay bằng userId từ auth khi có. */
export const CURRENT_USER_ID = "3fa85f64-5717-4562-b3fc-2c963f66afa6";

/**
 * Mock data cho GET /api/projects/filter.
 *
 * Hiện tại RỖNG — vì user chưa tạo dự án nào qua POST /api/projects
 * (mock trả `[]` cho filterProjects), nên UI sẽ hiện empty state.
 */

/** Params cho GET /api/projects/filter. Tất cả optional. */
export interface ProjectFilter {
  userId?: string;
  name?: string;
  status?: string;
  clientId?: string;
}

/**
 * GET /api/projects/filter — gọi thẳng Backend (BE có rồi).
 *
 * Build query string từ params (chỉ những field non-empty).
 * Endpoint này trả về ProjectDto[] cho user hiện tại (đã filter ở BE).
 *
 * ⚠️ Dự án đã `Archived` bị loại khỏi kết quả (xem `listProjects`).
 *   Nếu user **cố tình** lọc theo `status=Archived` (để xem dự án đã lưu
 *   trữ) thì ta vẫn trả về — chỉ lọc khi `status` KHÔNG được chỉ định.
 */
export async function filterProjects(
  params: ProjectFilter = {},
): Promise<ApiResult<ProjectDto[]>> {
  const sp = new URLSearchParams();
  if (params.userId) sp.set("userId", params.userId.trim());
  if (params.name) sp.set("name", params.name.trim());
  if (params.status) sp.set("status", params.status.trim());
  if (params.clientId) sp.set("clientId", params.clientId.trim());
  const qs = sp.toString();
  const path = qs
    ? `/api/projects/filter?${qs}`
    : `/api/projects/filter`;
  const res = await get<ProjectDto[]>(path);
  if (!res.ok) return res;
  // Chỉ lọc Archived khi user không lọc theo status cụ thể.
  if (params.status?.trim().toLowerCase() === "archived") return res;
  return {
    ...res,
    data: res.data.filter((p) => !isProjectArchived(p)),
  };
}

/* ---------- project actions ---------- */

export interface UpdateProjectRequest {
  name?: string;
  description?: string;
  startDate?: string;
  deadline?: string;
  clientId?: string | null;
}

/**
 * PUT /api/projects/{projectId}
 * Cập nhật thông tin project.
 */
export async function updateProject(
  projectId: string,
  body: UpdateProjectRequest,
): Promise<ApiResult<ProjectDto>> {
  return put<ProjectDto>(`/api/projects/${encodeURIComponent(projectId)}`, body);
}

/**
 * POST /api/projects/{projectId}/archive
 * Đưa project vào trạng thái archive.
 */
export async function archiveProject(
  projectId: string,
): Promise<ApiResult<ProjectDto>> {
  return post<ProjectDto>(`/api/projects/${encodeURIComponent(projectId)}/archive`);
}

/**
 * POST /api/projects/{projectId}/restore
 * Khôi phục project từ archive.
 */
export async function restoreProject(
  projectId: string,
): Promise<ApiResult<ProjectDto>> {
  return post<ProjectDto>(`/api/projects/${encodeURIComponent(projectId)}/restore`);
}

/** Task con bên trong progress response. */
export interface ProjectProgressTaskDto {
  taskId: string;
  title: string;
  status: string;
  isCompleted: boolean;
  estimatedMinutes: number;
  actualMinutes: number;
}

/** Response từ GET /api/projects/{projectId}/progress. */
export interface ProjectProgressDto {
  projectId: string;
  name: string;
  status: string;
  deadline: string;
  totalTasks: number;
  completedTasks: number;
  progressPercent: number;
  estimatedMinutes: number;
  actualMinutes: number;
  varianceMinutes: number;
  tasks: ProjectProgressTaskDto[];
}

/**
 * GET /api/projects/{projectId}/progress
 * Lấy tiến độ chi tiết của 1 project.
 */
export async function getProjectProgress(
  projectId: string,
): Promise<ApiResult<ProjectProgressDto>> {
  return get<ProjectProgressDto>(
    `/api/projects/${encodeURIComponent(projectId)}/progress`,
  );
}

/* ---------- clients (CRUD đầy đủ) ---------- */

/**
 * DTO trả về từ GET /api/clients và GET /api/clients/{clientId}.
 * BE dùng camelCase và trường `contactEmail` / `createdAt`.
 */
export interface ClientDto {
  id: string;
  name: string;
  contactEmail: string | null;
  phone: string | null;
  notes: string | null;
  createdAt: string;
}

export interface ClientRequest {
  name: string;
  contactEmail: string;
  phone: string;
  notes: string;
}

export async function listClients(): Promise<ApiResult<ClientDto[]>> {
  return get<ClientDto[]>("/api/clients");
}

/**
 * GET /api/clients/filter?userId&name
 * Lọc theo owner và/hoặc tên (BE so khớp tương đối).
 */
export async function filterClients(params: {
  userId?: string;
  name?: string;
} = {}): Promise<ApiResult<ClientDto[]>> {
  const sp = new URLSearchParams();
  if (params.userId) sp.set("userId", params.userId.trim());
  if (params.name) sp.set("name", params.name.trim());
  const qs = sp.toString();
  return get<ClientDto[]>(`/api/clients/filter${qs ? `?${qs}` : ""}`);
}

export async function getClient(
  clientId: string,
): Promise<ApiResult<ClientDto>> {
  return get<ClientDto>(`/api/clients/${encodeURIComponent(clientId)}`);
}

export async function createClient(
  body: ClientRequest,
): Promise<ApiResult<ClientDto>> {
  return post<ClientDto>("/api/clients", body);
}

export async function updateClient(
  clientId: string,
  body: ClientRequest,
): Promise<ApiResult<ClientDto>> {
  return put<ClientDto>(
    `/api/clients/${encodeURIComponent(clientId)}`,
    body,
  );
}

export async function deleteClient(
  clientId: string,
): Promise<ApiResult<void>> {
  return del<void>(`/api/clients/${encodeURIComponent(clientId)}`);
}

/** @deprecated Giữ alias cũ cho code đang import CreateClientRequest. */
export type CreateClientRequest = ClientRequest;

/* ================================================================
 * TASKS
 * ================================================================ */

/** DTO trả về từ GET /api/projects/{projectId}/tasks và GET /api/tasks/{taskId}. */
export interface TaskDto {
  id: string;
  projectId: string;
  userId: string;
  title: string;
  description: string;
  taskType: string;
  status: string;
  domainId: string | null;
  milestoneId: string | null;
  deadline: string | null;
  estimatedMinutes: number;
  aiEstimatedMinutes: number;
  fixedStart: string | null;
  fixedEnd: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Params tạo task mới. */
export interface CreateTaskRequest {
  title: string;
  description?: string;
  taskType?: string;
  status?: string;
  domainId?: string | null;
  milestoneId?: string | null;
  deadline?: string | null;
  estimatedMinutes?: number;
  aiEstimatedMinutes?: number;
  fixedStart?: string | null;
  fixedEnd?: string | null;
}

/**
 * GET /api/projects/{projectId}/tasks
 * Lấy danh sách task thuộc 1 project.
 */
export async function listTasks(
  projectId: string,
): Promise<ApiResult<TaskDto[]>> {
  return get<TaskDto[]>(
    `/api/projects/${encodeURIComponent(projectId)}/tasks`,
  );
}

/**
 * POST /api/projects/{projectId}/tasks
 * Tạo task mới trong 1 project.
 */
export async function createTask(
  projectId: string,
  body: CreateTaskRequest,
): Promise<ApiResult<TaskDto>> {
  return post<TaskDto>(
    `/api/projects/${encodeURIComponent(projectId)}/tasks`,
    body,
  );
}

/**
 * GET /api/tasks/{taskId}
 */
export async function getTask(taskId: string): Promise<ApiResult<TaskDto>> {
  return get<TaskDto>(`/api/tasks/${encodeURIComponent(taskId)}`);
}

/**
 * PUT /api/tasks/{taskId}
 */
export async function updateTask(
  taskId: string,
  body: Partial<CreateTaskRequest>,
): Promise<ApiResult<TaskDto>> {
  return put<TaskDto>(`/api/tasks/${encodeURIComponent(taskId)}`, body);
}

/**
 * DELETE /api/tasks/{taskId}
 */
export async function deleteTask(taskId: string): Promise<ApiResult<void>> {
  return del<void>(`/api/tasks/${encodeURIComponent(taskId)}`);
}

/* ================================================================
 * SUBTASKS
 * ================================================================ */

/** DTO trả về từ GET /api/tasks/{taskId}/subtasks. */
export interface SubtaskDto {
  id: string;
  taskId: string;
  title: string;
  description: string | null;
  estimatedMinutes: number;
  orderIndex: number;
  status: string;
  scheduledStart: string | null;
  scheduledEnd: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Params tạo subtask mới. */
export interface CreateSubtaskRequest {
  title: string;
  description?: string;
  estimatedMinutes?: number;
  orderIndex?: number;
  status?: string;
  scheduledStart?: string | null;
  scheduledEnd?: string | null;
}

/**
 * GET /api/tasks/{taskId}/subtasks
 */
export async function listSubtasks(
  taskId: string,
): Promise<ApiResult<SubtaskDto[]>> {
  return get<SubtaskDto[]>(
    `/api/tasks/${encodeURIComponent(taskId)}/subtasks`,
  );
}

/**
 * POST /api/tasks/{taskId}/subtasks
 */
export async function createSubtask(
  taskId: string,
  body: CreateSubtaskRequest,
): Promise<ApiResult<SubtaskDto>> {
  return post<SubtaskDto>(
    `/api/tasks/${encodeURIComponent(taskId)}/subtasks`,
    body,
  );
}

/**
 * PUT /api/subtasks/{subtaskId}
 */
export async function updateSubtask(
  subtaskId: string,
  body: Partial<CreateSubtaskRequest>,
): Promise<ApiResult<SubtaskDto>> {
  return put<SubtaskDto>(
    `/api/subtasks/${encodeURIComponent(subtaskId)}`,
    body,
  );
}

/**
 * DELETE /api/subtasks/{subtaskId}
 */
export async function deleteSubtask(
  subtaskId: string,
): Promise<ApiResult<void>> {
  return del<void>(`/api/subtasks/${encodeURIComponent(subtaskId)}`);
}

/* ================================================================
 * Đánh dấu Task / Subtask là XONG
 * ----------------------------------------------------------
 * ⚠️ QUY TẮC QUAN TRỌNG (spec FOCUS_SESSION_FE (1).md mục 6.3):
 *
 *   1. `PUT /api/tasks/{id}` và `PUT /api/subtasks/{id}` **THAY THẾ TOÀN BỘ**
 *      → phải gửi **đủ** các trường, không chỉ `status`. Gửi thiếu →
 *      BE có thể xoá field (VD: mất `estimatedMinutes`, mất `domainId`).
 *
 *   2. **Stop KHÔNG đánh dấu xong.** Spec mục 1:
 *      "Stop `Completed` chỉ làm slot thành `Done`, không đánh dấu task hay
 *       subtask xong." Việc này phải gọi API riêng.
 *
 *   3. Khi task chuyển `Done`, backend báo dịch vụ AI để học từ thời gian
 *      thực tế (lỗi AI chỉ ghi log, không làm hỏng việc cập nhật).
 *
 *   4. Task `Done` KHÔNG làm subtask tự `Done` (và ngược lại) → FE tự
 *      quyết định có hỏi "Đánh dấu cả các subtask còn lại là xong?" không.
 * ============================================================ */

/**
 * Đánh dấu 1 SUBTASK là `Done`.
 *
 * Gửi **đủ** `title`, `estimatedMinutes`, `orderIndex`, `status` — đúng như
 * mẫu trong spec mục 6.3.
 *
 * ⚠️ `SubTaskRequestDto` của BE có `additionalProperties: false` và **KHÔNG
 * có** field `description` → gửi thêm field lạ sẽ bị BE từ chối (400).
 * Vì vậy ta **không** gửi `description`.
 *
 * @param sub  Subtask đầy đủ (lấy từ `GET /api/tasks/{id}/subtasks`).
 */
export async function markSubtaskDone(
  sub: Pick<
    SubtaskDto,
    "id" | "title" | "estimatedMinutes" | "orderIndex"
  > & { description?: string | null },
): Promise<ApiResult<SubtaskDto>> {
  return updateSubtask(sub.id, {
    title: sub.title,
    estimatedMinutes: sub.estimatedMinutes,
    orderIndex: sub.orderIndex,
    status: "Done",
  });
}

/**
 * Đánh dấu 1 TASK là `Done`.
 *
 * Gửi **đủ** mọi trường theo spec mục 6.3:
 * `title`, `description`, `taskType`, `domainId`, `milestoneId`, `deadline`,
 * `estimatedMinutes`, `aiEstimatedMinutes`, `fixedStart`, `fixedEnd` — chỉ
 * đổi `status` thành `Done`.
 *
 * @param task Task đầy đủ (lấy từ `GET /api/tasks/{id}`).
 */
export async function markTaskDone(
  task: TaskDto,
): Promise<ApiResult<TaskDto>> {
  return updateTask(task.id, {
    title: task.title,
    description: task.description,
    taskType: task.taskType,
    domainId: task.domainId,
    milestoneId: task.milestoneId,
    deadline: task.deadline,
    estimatedMinutes: task.estimatedMinutes,
    aiEstimatedMinutes: task.aiEstimatedMinutes,
    fixedStart: task.fixedStart,
    fixedEnd: task.fixedEnd,
    status: "Done",
  });
}

/* ================================================================
 * MILESTONES (milestone = mốc thời gian / phase của project)
 * ================================================================ */

export interface MilestoneDto {
  id: string;
  projectId: string;
  name: string;
  startDate: string | null;
  endDate: string | null;
  dueDate: string | null;
  status: string;
  orderIndex: number;
  revisionCount: number;
  deliveredAt: string | null;
  approvedAt: string | null;
  createdAt: string;
}

/** Params tạo milestone. BE Swagger: name, orderIndex>=1, dueDate, status, revisionCount. */
export interface CreateMilestoneRequest {
  name: string;
  orderIndex: number;
  dueDate?: string | null;
  startDate?: string | null;
  endDate?: string | null;
  status?: string;
  revisionCount?: number;
  /**
   * Chỉ dùng khi `status = "Delivered"` và BE trả 409
   * `MILESTONE_HAS_OPEN_TASKS` → gửi lại cùng body kèm `confirmOpenTasks: true`
   * để giao giai đoạn dù còn task dở (task dở giữ nguyên).
   *
   * Spec `FOCUS_START_STOP_REWORK_FE.md` mục 8.
   */
  confirmOpenTasks?: boolean;
}

/**
 * Chi tiết trong lỗi 409 `MILESTONE_HAS_OPEN_TASKS`.
 *
 * BE trả: `{ openTaskCount, openSubTaskCount, tasks: [{ id, title, status,
 * openSubTaskCount }] }`.
 */
export interface MilestoneOpenTasksDetails {
  openTaskCount: number;
  openSubTaskCount: number;
  tasks: {
    id: string;
    title: string;
    status: string;
    openSubTaskCount: number;
  }[];
}

/**
 * GET /api/projects/{projectId}/milestones
 */
export async function listMilestones(
  projectId: string,
): Promise<ApiResult<MilestoneDto[]>> {
  return get<MilestoneDto[]>(
    `/api/projects/${encodeURIComponent(projectId)}/milestones`,
  );
}

/**
 * GET /api/milestones/{milestoneId}
 */
export async function getMilestone(
  milestoneId: string,
): Promise<ApiResult<MilestoneDto>> {
  return get<MilestoneDto>(
    `/api/milestones/${encodeURIComponent(milestoneId)}`,
  );
}

/**
 * POST /api/projects/{projectId}/milestones
 */
export async function createMilestone(
  projectId: string,
  body: CreateMilestoneRequest,
): Promise<ApiResult<MilestoneDto>> {
  return post<MilestoneDto>(
    `/api/projects/${encodeURIComponent(projectId)}/milestones`,
    body,
  );
}

/**
 * PUT /api/milestones/{milestoneId}
 */
export async function updateMilestone(
  milestoneId: string,
  body: Partial<CreateMilestoneRequest>,
): Promise<ApiResult<MilestoneDto>> {
  return put<MilestoneDto>(
    `/api/milestones/${encodeURIComponent(milestoneId)}`,
    body,
  );
}

/**
 * DELETE /api/milestones/{milestoneId}
 */
export async function deleteMilestone(
  milestoneId: string,
): Promise<ApiResult<void>> {
  return del<void>(`/api/milestones/${encodeURIComponent(milestoneId)}`);
}

/* ================================================================
 * SCHEDULE SLOTS
 * ----------------------------------------------------------
 * Schedule Slot = "khung giờ đặt lịch" cho task/subtask trên calendar.
 * Sau khi tạo task/subtask, cần tạo slot để:
 *   - Hiển thị trên calendar
 *   - Trigger notification
 *   - Sync với Google Calendar (nếu có googleEventId)
 *
 * Các endpoint:
 *   GET  /api/tasks/{taskId}/schedule-slots    → danh sách slot của task
 *   POST /api/tasks/{taskId}/schedule-slots    → tạo slot mới
 *   GET  /api/schedule-slots/{slotId}          → lấy 1 slot
 *   PUT  /api/schedule-slots/{slotId}          → update slot
 *   DELETE /api/schedule-slots/{slotId}        → xóa slot
 *   GET  /api/schedule-slots/{slotId}/changes  → lịch sử thay đổi
 *   POST /api/schedule-slots/{slotId}/changes  → log thay đổi mới
 *   GET  /api/schedule-change-logs/{logId}     → lấy 1 log
 * ================================================================ */

/** Schedule Slot DTO — trả về từ GET/POST/PUT */
/**
 * Slot đang **chiếm giờ** mà 1 slot mới sẽ chồng lên.
 *
 * BE trả kèm trong `details.overlaps` của lỗi `409 SLOT_OVERLAP`.
 * Spec: `FE_CHANGES.md` mục 3.2.
 */
export interface SlotOverlapDto {
  slotId: string;
  /**
   * Task cá nhân bị chồng — `null` nếu bên chồng là **slot của việc nhóm**.
   * (Mục 10 của cập nhật BE: slot nhóm có `groupTaskId` riêng.)
   */
  taskId: string | null;
  /** Việc nhóm bị chồng (slot nhóm) — `null` nếu bên chồng là việc cá nhân. */
  groupTaskId?: string | null;
  /** Tên việc bị chồng (dùng để hiển thị trong thông điệp lỗi). */
  taskTitle: string;
  status: string;
  start: string; // ISO 8601
  end: string; // ISO 8601
}

/**
 * Trùng giờ khi duyệt đề xuất AI.
 *
 * Ở màn duyệt lịch, `slot` là slot **đề xuất** (sắp bị chồng) và `with` là
 * slot **đang chiếm giờ**. Cấu trúc khác `SlotOverlapDto` vì thêm `with`.
 */
export interface ProposalOverlapDto {
  /** Slot đề xuất bị chồng. */
  slotId: string;
  /** `null` nếu slot đề xuất thuộc việc nhóm. */
  taskId: string | null;
  /** Việc nhóm của slot đề xuất (slot nhóm). */
  groupTaskId?: string | null;
  taskTitle: string;
  start: string;
  end: string;
  /** Slot đang chiếm giờ. */
  with: {
    slotId: string;
    taskId: string | null;
    groupTaskId?: string | null;
    taskTitle: string;
    status: string;
    start: string;
    end: string;
  };
}

/** Mã lỗi khi slot chồng giờ (HTTP 409). */
export const SLOT_OVERLAP_CODE = "SLOT_OVERLAP";

/**
 * Kiểm tra 1 lỗi API có phải `409 SLOT_OVERLAP` không.
 *
 * BE trả `{ message, code: "SLOT_OVERLAP", details: { overlaps: [...] } }`.
 */
export function isSlotOverlapError(err: {
  status?: number;
  errorCode?: string;
  details?: unknown;
}): boolean {
  if (err.status !== 409) return false;
  if (err.errorCode === SLOT_OVERLAP_CODE) return true;
  // Một số BE bản cũ chỉ trả `code` trong body → đã được map sang errorCode.
  const details = err.details as { code?: string } | undefined;
  return details?.code === SLOT_OVERLAP_CODE;
}

/**
 * Rút danh sách slot chồng giờ ra từ `details` của lỗi 409.
 *
 * Hỗ trợ 2 shape:
 *   - `{ overlaps: SlotOverlapDto[] }` — tạo/sửa slot.
 *   - `{ overlaps: ProposalOverlapDto[] }` — duyệt đề xuất (có `with`).
 */
export function extractOverlaps(details: unknown): SlotOverlapDto[] {
  if (!details || typeof details !== "object") return [];
  const overlaps = (details as { overlaps?: unknown }).overlaps;
  if (!Array.isArray(overlaps)) return [];
  return overlaps.filter(
    (o): o is SlotOverlapDto =>
      !!o && typeof o === "object" && "slotId" in (o as object),
  );
}

/**
 * Rút danh sách trùng giờ của đề xuất (shape có `with`).
 */
export function extractProposalOverlaps(details: unknown): ProposalOverlapDto[] {
  if (!details || typeof details !== "object") return [];
  const overlaps = (details as { overlaps?: unknown }).overlaps;
  if (!Array.isArray(overlaps)) return [];
  return overlaps.filter(
    (o): o is ProposalOverlapDto =>
      !!o && typeof o === "object" && "with" in (o as object),
  );
}

/**
 * Trạng thái schedule slot — phải khớp enum phía backend:
 * "Trạng thái không hợp lệ. Chọn một trong: Proposed, Approved, Done, Skipped, Missed, Cancelled."
 */
export type ScheduleSlotStatus =
  | "Proposed"
  | "Approved"
  | "Done"
  | "Skipped"
  | "Missed"
  | "Cancelled";

export interface ScheduleSlotDto {
  id: string;
  /**
   * Task cá nhân gắn với slot — `null` với **slot của việc nhóm**.
   *
   * ⚠️ Mục 10 của cập nhật BE: `taskId` có thể `null` trong MỌI API slot.
   * Slot nhóm thay bằng `groupTaskId` / `groupSubTaskId` / `userId`.
   */
  taskId: string | null;
  subTaskId: string | null;
  /** Việc nhóm gắn với slot (slot nhóm) — `null` với slot cá nhân. */
  groupTaskId?: string | null;
  /** Việc con của việc nhóm (slot nhóm) — `null` với slot cá nhân. */
  groupSubTaskId?: string | null;
  /** Người được giao slot nhóm — `null` với slot cá nhân. */
  userId?: string | null;
  /** Tên nhóm (chỉ có trong lịch gộp `GET /api/calendar`). */
  groupName?: string | null;
  scheduleProposalId: string | null;
  startTime: string; // ISO 8601
  endTime: string; // ISO 8601
  originalStartTime: string | null;
  isManualOverride: boolean;
  proposedMinutes: number;
  kbiasUsed: number;
  explanation: string | null;
  status: ScheduleSlotStatus;
  googleEventId: string | null;
  syncFailed: boolean;
}

/** Request body cho POST /api/tasks/{taskId}/schedule-slots */
export interface CreateScheduleSlotRequest {
  subTaskId?: string | null;
  scheduleProposalId?: string | null;
  startTime: string; // ISO 8601
  endTime: string; // ISO 8601
  originalStartTime?: string | null;
  isManualOverride?: boolean;
  kbiasUsed?: number;
  explanation?: string | null;
  status?: ScheduleSlotStatus;
}

/** Request body cho PUT /api/schedule-slots/{slotId} */
export interface UpdateScheduleSlotRequest {
  subTaskId?: string | null;
  /**
   * Việc con của việc nhóm — dùng khi sửa **slot nhóm** (mục 10 của cập
   * nhật BE). Slot nhóm dùng chung endpoint `PUT /api/schedule-slots/{id}`.
   */
  groupSubTaskId?: string | null;
  scheduleProposalId?: string | null;
  startTime?: string;
  endTime?: string;
  originalStartTime?: string | null;
  isManualOverride?: boolean;
  kbiasUsed?: number;
  explanation?: string | null;
  status?: ScheduleSlotStatus;
}

/** Schedule Slot Change DTO — log thay đổi của 1 slot */
export interface ScheduleSlotChangeDto {
  id: string;
  scheduleSlotId: string;
  changeType: "rescheduled" | "duration_changed" | "status_changed" | "manual_override";
  source: string; // "user" | "ai" | "calendar_sync" | "notification_reminder"
  oldStart: string | null;
  oldEnd: string | null;
  newStart: string | null;
  newEnd: string | null;
  changedAt: string; // ISO 8601
}

/** Request body cho POST /api/schedule-slots/{slotId}/changes */
export interface CreateScheduleSlotChangeRequest {
  changeType: "rescheduled" | "duration_changed" | "status_changed" | "manual_override";
  source: string;
  oldStart?: string | null;
  oldEnd?: string | null;
  newStart?: string | null;
  newEnd?: string | null;
}

/**
 * GET /api/tasks/{taskId}/schedule-slots
 * Lấy danh sách tất cả slot thuộc 1 task.
 */
export async function listScheduleSlotsByTask(
  taskId: string,
): Promise<ApiResult<ScheduleSlotDto[]>> {
  if (!taskId) {
    return { ok: false, status: 0, error: "Task id is required" };
  }
  return get<ScheduleSlotDto[]>(
    `/api/tasks/${encodeURIComponent(taskId)}/schedule-slots`,
  );
}

/**
 * POST /api/tasks/{taskId}/schedule-slots
 * Tạo slot mới cho task (ghi xuống DB thật).
 */
export async function createScheduleSlot(
  taskId: string,
  body: CreateScheduleSlotRequest,
): Promise<ApiResult<ScheduleSlotDto>> {
  if (!taskId) {
    return { ok: false, status: 0, error: "Task id is required" };
  }
  return post<ScheduleSlotDto>(
    `/api/tasks/${encodeURIComponent(taskId)}/schedule-slots`,
    body,
  );
}

/**
 * GET /api/schedule-slots/{slotId}
 * Lấy chi tiết 1 slot.
 */
export async function getScheduleSlot(
  slotId: string,
): Promise<ApiResult<ScheduleSlotDto>> {
  if (!slotId) {
    return { ok: false, status: 0, error: "Slot id is required" };
  }
  return get<ScheduleSlotDto>(
    `/api/schedule-slots/${encodeURIComponent(slotId)}`,
  );
}

/**
 * PUT /api/schedule-slots/{slotId}
 * Cập nhật slot (đổi giờ, status, v.v.).
 */
export async function updateScheduleSlot(
  slotId: string,
  body: UpdateScheduleSlotRequest,
): Promise<ApiResult<ScheduleSlotDto>> {
  if (!slotId) {
    return { ok: false, status: 0, error: "Slot id is required" };
  }
  return put<ScheduleSlotDto>(
    `/api/schedule-slots/${encodeURIComponent(slotId)}`,
    body,
  );
}

/**
 * DELETE /api/schedule-slots/{slotId}
 * Xóa slot.
 */
export async function deleteScheduleSlot(
  slotId: string,
): Promise<ApiResult<{ deleted: boolean; slotId: string }>> {
  if (!slotId) {
    return { ok: false, status: 0, error: "Slot id is required" };
  }
  return del<{ deleted: boolean; slotId: string }>(
    `/api/schedule-slots/${encodeURIComponent(slotId)}`,
  );
}

/**
 * GET /api/schedule-slots/{slotId}/changes
 * Lấy lịch sử thay đổi của 1 slot.
 */
export async function listScheduleSlotChanges(
  slotId: string,
): Promise<ApiResult<ScheduleSlotChangeDto[]>> {
  if (!slotId) {
    return { ok: false, status: 0, error: "Slot id is required" };
  }
  return get<ScheduleSlotChangeDto[]>(
    `/api/schedule-slots/${encodeURIComponent(slotId)}/changes`,
  );
}

/**
 * POST /api/schedule-slots/{slotId}/changes
 * Log thay đổi mới cho slot (dùng khi có sự kiện từ bên ngoài như calendar sync).
 */
export async function createScheduleSlotChange(
  slotId: string,
  body: CreateScheduleSlotChangeRequest,
): Promise<ApiResult<ScheduleSlotChangeDto>> {
  if (!slotId) {
    return { ok: false, status: 0, error: "Slot id is required" };
  }
  return post<ScheduleSlotChangeDto>(
    `/api/schedule-slots/${encodeURIComponent(slotId)}/changes`,
    body,
  );
}

/**
 * GET /api/schedule-change-logs/{logId}
 * Lấy chi tiết 1 log thay đổi.
 */
export async function getScheduleSlotChange(
  logId: string,
): Promise<ApiResult<ScheduleSlotChangeDto>> {
  if (!logId) {
    return { ok: false, status: 0, error: "Change log id is required" };
  }
  return get<ScheduleSlotChangeDto>(
    `/api/schedule-change-logs/${encodeURIComponent(logId)}`,
  );
}

/* ================================================================
 * SCHEDULE PROPOSE — AI đề xuất khung giờ (chưa ghi vào calendar)
 * ================================================================ */

/**
 * Request body cho POST /schedule/propose.
 * - `task_ids`: chỉ nhận task thuộc loại **Flexible** (BE từ chối task Fixed).
 * - `language`: mã ngôn ngữ để AI viết `explanation` (vd "vi" → tiếng Việt).
 */
export interface ProposeScheduleRequest {
  task_ids: string[];
  language?: string;
}

/** 1 khung giờ AI đề xuất. `start`/`end` là ISO 8601 **UTC** (kèm hậu tố Z). */
export interface ProposedSlotDto {
  slot_id: string;
  task_id: string;
  subtask_id: string | null;
  start: string; // ISO 8601 UTC
  end: string; // ISO 8601 UTC
  proposed_minutes: number;
  explanation: string | null;
}

/** Cảnh báo không chặn — đề xuất vẫn được trả về kèm. */
export interface ScheduleWarningDto {
  task_id: string;
  type: string;
  needed_minutes: number;
  free_minutes: number;
  message: string | null;
  /** Ngày bị cảnh báo (ISO date) — BE có thể trả về. */
  day?: string | null;
  /** Tổng số phút công suất trong ngày — BE có thể trả về. */
  capacity_minutes?: number | null;
}

export interface ProposeScheduleResponse {
  proposal_id: string;
  is_feasible: boolean;
  missing_minutes: number;
  explanation: string | null;
  slots: ProposedSlotDto[];
  warnings: ScheduleWarningDto[];
}

/**
 * POST {AI_BASE_URL}/schedule/propose
 * Nhờ AI tính khung giờ cho các task Flexible.
 *
 * ⚠️ Endpoint này thuộc **AI service** (VITE_AI_API_URL), không phải backend
 * METANOIA — nên phải gọi qua `aiFetch`, không phải `post`.
 *
 * Lưu ý: API **không** ghi gì vào calendar. Người dùng phải duyệt từng slot rồi
 * mới gọi `createScheduleSlot` (kèm `scheduleProposalId`) để ghi thật — hàm đó
 * thuộc backend nên dùng `post`.
 */
export async function proposeSchedule(
  body: ProposeScheduleRequest,
): Promise<ApiResult<ProposeScheduleResponse>> {
  const ids = (body.task_ids ?? []).filter(
    (id) => typeof id === "string" && id.length > 0,
  );
  if (ids.length === 0) {
    // Chặn sớm: AI service trả 422 nếu task_ids rỗng, thông báo rõ ràng hơn cho UI.
    return { ok: false, status: 0, error: "Cần ít nhất 1 task để xếp lịch." };
  }
  return aiFetch<ProposeScheduleResponse>("/schedule/propose", {
    method: "POST",
    body: JSON.stringify({
      task_ids: ids,
      language: body.language ?? "vi",
    }),
  });
}

/* ---------- POST /schedule/overrun — "Cần thêm X phút" ---------- */

/** Loại overrun mà AI xử lý. */
export type OverrunKind = "extend" | "reschedule" | "partial" | "none";

/** 1 slot bị dời do kéo dài. */
export interface OverrunMoveDto {
  slot_id: string;
  task_id: string | null;
  subtask_id: string | null;
  old_start: string;
  old_end: string;
  new_start: string;
  new_end: string;
  explanation: string | null;
}

/** 1 slot không xếp lại được. */
export interface OverrunNotPlacedDto {
  slot_id: string;
  task_id: string | null;
  reason: string | null;
}

export interface OverrunResponse {
  kind: OverrunKind;
  /** Slot đã được kéo dài. */
  extended: boolean;
  /** Các slot bị dời. */
  moves: OverrunMoveDto[];
  /** Các slot không xếp lại được. */
  not_placed: OverrunNotPlacedDto[];
  /** Slot có vượt qua cuối ngày không. */
  past_day_end: boolean;
  /** Câu tóm tắt cho user. */
  summary: string | null;
}

/**
 * POST /schedule/overrun
 * User báo "Chưa xong, cần thêm X phút" cho 1 slot đang chạy.
 *
 * AI tính cách kéo dài/dời slot (không ghi thẳng vào DB). User đồng ý thì
 * FE gọi Backend `PUT /api/schedule-slots/{id}` cho từng slot trong `moves`.
 *
 * `extra_minutes` 5–480.
 */
export async function reportOverrun(
  body: {
    slot_id: string;
    extra_minutes: number;
    language?: string;
  },
): Promise<ApiResult<OverrunResponse>> {
  if (!body.slot_id) return { ok: false, error: "slot_id is required" };
  const extra = Math.round(body.extra_minutes);
  if (!Number.isFinite(extra) || extra < 5 || extra > 480) {
    return {
      ok: false,
      error: "Số phút thêm phải từ 5 đến 480 phút.",
    };
  }
  return aiFetch<OverrunResponse>("/schedule/overrun", {
    method: "POST",
    body: JSON.stringify({
      slot_id: body.slot_id,
      extra_minutes: extra,
      language: body.language ?? "vi",
    }),
  });
}

/* ================================================================
 * DOMAINS (domain = lĩnh vực / chủ đề của task)
 * ================================================================ */

export interface DomainDto {
  id: string;
  name: string;
  color: string;
}

/**
 * GET /api/domains
 * Lấy danh sách tất cả domain (không phụ thuộc project).
 */
export async function listDomains(): Promise<ApiResult<DomainDto[]>> {
  return get<DomainDto[]>("/api/domains");
}

/* ================================================================
 * CALENDAR
 * GET /api/calendar?from=&to=&includeCancelled=
 * Response: { from, to, googleCalendarStatus, timeZone, workDayStart, workDayEnd, worksOnWeekend, items[] }
 * ================================================================ */

export interface CalendarItemDto {
  source: string;
  id: string;
  title: string;
  start: string;
  end: string;
  isAllDay: boolean;
  status: string;
  /**
   * Task cá nhân — `null` với **slot của việc nhóm** (mục 10 của cập nhật BE).
   *
   * ⚠️ Khi `taskId = null`, mọi trường dự án / khách hàng / loại công việc
   * cũng là `null` → màn lịch phải hiển thị theo `groupName` + tiêu đề việc
   * nhóm, KHÔNG điều hướng sang trang task cá nhân.
   */
  taskId: string | null;
  subTaskId: string | null;
  /** Việc nhóm (slot nhóm) — `null` với lịch cá nhân. */
  groupTaskId?: string | null;
  /** Việc con của việc nhóm (slot nhóm). */
  groupSubTaskId?: string | null;
  /** Người được giao slot nhóm. */
  userId?: string | null;
  /** Nhóm sở hữu slot — chỉ có với slot nhóm. */
  groupId?: string | null;
  /** Tên nhóm — chỉ có với slot nhóm. */
  groupName?: string | null;
  projectId: string | null;
  /** Chi tiết mở rộng (từ task/subtask gốc) */
  subTaskTitle?: string | null;
  projectName?: string | null;
  clientName?: string | null;
  domainName?: string | null;
  taskType?: string | null;
  taskStatus?: string | null;
  taskDeadline?: string | null;
  proposedMinutes?: number;
  explanation?: string | null;
  isManualOverride?: boolean;
  syncFailed?: boolean;
  /** Có event tương ứng trên Google Calendar hay không. */
  googleEventId?: string | null;
}

export interface CalendarResponseDto {
  from: string;
  to: string;
  googleCalendarStatus: string;
  /** Thông tin timezone & work hours */
  timeZone?: string;
  workDayStart?: string | null;
  workDayEnd?: string | null;
  worksOnWeekend?: boolean;
  items: CalendarItemDto[];
}

export async function listCalendar(params: {
  from: string; // ISO date-time
  to: string;
  includeCancelled?: boolean;
}): Promise<ApiResult<CalendarResponseDto>> {
  const qs = new URLSearchParams();
  qs.set("from", params.from);
  qs.set("to", params.to);
  if (params.includeCancelled !== undefined) {
    qs.set("includeCancelled", String(params.includeCancelled));
  }
  return apiFetch<CalendarResponseDto>(`/api/calendar?${qs.toString()}`, {
    method: "GET",
  });
}

/* ================================================================
 * GOOGLE CALENDAR — tích hợp tài khoản Google của user
 *
 * BE đã deploy đủ 9 endpoint (tag `GoogleCalendar` trong swagger.json).
 *
 * Luồng OAuth:
 *   1. FE redirect CẢ TRANG tới `GET /api/google-calendar/connect`
 *      (endpoint này trả 302 sang trang consent của Google).
 *   2. User đồng ý → Google gọi `GET /api/google-calendar/callback`.
 *   3. BE lưu token rồi redirect về FE (kèm query báo thành công/lỗi).
 *   4. FE gọi `GET /api/google-calendar/status` để biết đã kết nối chưa.
 *
 * Vì bước 1 là redirect toàn trang nên KHÔNG fetch() được — fetch sẽ hỏng
 * vì CORS + không mang được header Authorization. Do đó hàm
 * `getGoogleCalendarConnectUrl()` chỉ trả URL để component tự
 * `window.location.assign()`.
 * ================================================================ */

export interface GoogleCalendarStatusDto {
  isConnected: boolean;
  status: string | null;
  /** ISO datetime — thời điểm access token Google hết hạn. */
  tokenExpiresAt: string | null;
}

export interface CalendarEventDto {
  id: string;
  title: string | null;
  description: string | null;
  location: string | null;
  /** ISO datetime. */
  start: string;
  /** ISO datetime. */
  end: string;
  htmlLink: string | null;
}

export interface CalendarEventRequestDto {
  title: string;
  description?: string;
  location?: string;
  /** ISO datetime. */
  start: string;
  /** ISO datetime. */
  end: string;
}

/**
 * Chiều đồng bộ Google Calendar.
 *
 * - `FromGoogle` (mặc định): Google → METANOIA.
 * - `ToGoogle`: METANOIA → Google (đẩy slot lên).
 * - `Both`: kéo về trước, rồi đẩy lên.
 */
export type GoogleCalendarSyncDirection = "FromGoogle" | "ToGoogle" | "Both";

/**
 * Chế độ đồng bộ mà BE thực hiện.
 *
 * - `Incremental`: không chọn ngày → kéo về theo `syncToken` (chỉ phần thay đổi).
 * - `Range`: có chọn ngày → lấy đầy đủ trong khoảng.
 */
export type GoogleCalendarSyncMode = "Incremental" | "Range";

/**
 * Response của `POST /api/google-calendar/sync`.
 *
 * ⚠️ BE mới bổ sung nhóm số liệu phía **đẩy lên** (`pushed*`) bên cạnh nhóm
 * phía **kéo về** (`added`/`updated`/`cancelled`). Các field `pushed*` và `mode`
 * có thể `null` nếu BE cũ → ta dùng `?` để không vỡ.
 */
export interface GoogleCalendarSyncResultDto {
  /* ---- Phía kéo về (Google → METANOIA) ---- */
  /** Sự kiện Google mới thêm vào METANOIA. */
  added: number;
  /** Sự kiện Google đã cập nhật. */
  updated: number;
  /** Sự kiện bị xoá bên Google → đánh dấu huỷ. */
  cancelled: number;

  /* ---- Phía đẩy lên (METANOIA → Google) ---- */
  /** Sự kiện Google mới được tạo từ slot. */
  pushedCreated?: number;
  /** Sự kiện Google đã được cập nhật từ slot. */
  pushedUpdated?: number;
  /** Sự kiện Google đã bị xoá (slot bị huỷ/bỏ qua/hoãn). */
  pushedDeleted?: number;
  /** Số slot không đẩy được (Google lỗi). */
  pushFailed?: number;
  /** Tối đa 5 dòng lỗi đầu tiên. */
  pushErrors?: string[] | null;

  /* ---- Metadata ---- */
  /** Chiều đã đồng bộ (BE echo lại). */
  direction?: GoogleCalendarSyncDirection;
  /** Chế độ: `Incremental` (theo syncToken) hay `Range` (theo ngày). */
  mode?: GoogleCalendarSyncMode;
  /** Đầu khoảng thực tế đã dùng (UTC). null = không giới hạn phía đó. */
  rangeFromUtc?: string | null;
  /** Đầu ngày kế tiếp của `to` (không gồm). null = không giới hạn. */
  rangeToUtc?: string | null;
}

/**
 * Tuỳ chọn cho `POST /api/google-calendar/sync`.
 *
 * ⚠️ `from` / `to` là **ngày theo múi giờ người dùng**, dạng `yyyy-MM-dd`
 * (spec `GOOGLE_CALENDAR_SYNC_FE.md` mục 1). FE **không** chuyển sang UTC —
 * BE tự quy đổi theo timezone đã cài trong `PUT /api/me/settings`.
 */
export interface GoogleCalendarSyncOptions {
  /** Ngày bắt đầu (`yyyy-MM-dd`). Bỏ trống = không giới hạn phía trước. */
  from?: string | null;
  /** Ngày kết thúc (`yyyy-MM-dd`). Bỏ trống = không giới hạn phía sau. */
  to?: string | null;
  /** Chiều đồng bộ. Mặc định `FromGoogle` khi không gửi. */
  direction?: GoogleCalendarSyncDirection;
}

/**
 * URL dự phòng để bắt đầu OAuth khi không gọi được API (BE cũ trả 302).
 *
 * ⚠️ Endpoint `/api/google-calendar/connect` yêu cầu JWT, nên redirect thẳng
 * vào URL này sẽ 401. Luôn ưu tiên `fetchGoogleCalendarAuthorizationUrl()`.
 */
export function getGoogleCalendarConnectUrl(): string {
  return `${BASE_URL}/api/google-calendar/connect`;
}

export interface GoogleCalendarConnectDto {
  /** URL consent của Google (đã chứa `state` mã hoá userId, sống 10 phút). */
  authorizationUrl: string;
}

/**
 * GET /api/google-calendar/connect — yêu cầu Bearer token.
 *
 * BE trả `{ authorizationUrl }` thay vì 302, nên FE phải:
 *   1. gọi endpoint này kèm Authorization (để BE biết user nào),
 *   2. rồi `window.location.assign(authorizationUrl)` để sang trang Google.
 *
 * Không thể `window.location.assign()` thẳng endpoint vì trình duyệt không
 * gắn được header Authorization vào một điều hướng.
 */
export async function fetchGoogleCalendarAuthorizationUrl(): Promise<
  ApiResult<GoogleCalendarConnectDto>
> {
  return get<GoogleCalendarConnectDto>("/api/google-calendar/connect");
}

/**
 * GET /api/google-calendar/status
 * Trạng thái kết nối của user hiện tại.
 */
export async function getGoogleCalendarStatus(): Promise<
  ApiResult<GoogleCalendarStatusDto>
> {
  return get<GoogleCalendarStatusDto>("/api/google-calendar/status");
}

/**
 * DELETE /api/google-calendar/disconnect
 * Huỷ liên kết — BE xoá token Google đã lưu.
 * Trả 200 không body nên dùng `apiFetch<void>` thay vì `del<T>`.
 */
export async function disconnectGoogleCalendar(): Promise<ApiResult<void>> {
  return apiFetch<void>("/api/google-calendar/disconnect", {
    method: "DELETE",
  });
}

/**
 * POST /api/google-calendar/sync
 * Đồng bộ giữa schedule slot của METANOIA và Google Calendar.
 *
 * Theo spec `GOOGLE_CALENDAR_SYNC_FE.md` mục 1:
 *   - Query params: `from`, `to` (ngày `yyyy-MM-dd` theo múi giờ user),
 *     `direction` (`FromGoogle` | `ToGoogle` | `Both`).
 *   - Không có body.
 *   - Bỏ trống cả `from` lẫn `to` → hành vi cũ (incremental theo `syncToken`).
 *
 * ⚠️ `from`/`to` là **ngày theo múi giờ người dùng** → ta gửi nguyên chuỗi
 * `yyyy-MM-dd`, KHÔNG chuyển sang UTC. BE tự quy đổi.
 */
export async function syncGoogleCalendar(
  options?: GoogleCalendarSyncOptions,
): Promise<ApiResult<GoogleCalendarSyncResultDto>> {
  const qs = new URLSearchParams();
  if (options?.from) qs.set("from", options.from);
  if (options?.to) qs.set("to", options.to);
  if (options?.direction) qs.set("direction", options.direction);

  const query = qs.toString();
  const url = query
    ? `/api/google-calendar/sync?${query}`
    : "/api/google-calendar/sync";

  // Endpoint nhận POST **không có body** → gửi body rỗng cho an toàn với
  // proxy/BE cũ yêu cầu `Content-Type: application/json`.
  //
  // ⚠️ Debug: bật `VITE_DEBUG_GCAL_SYNC=true` trong `.env` để log URL đầy đủ
  // (kèm query `direction`/`from`/`to`) ra console. Tắt lại sau khi xong.
  const debug = import.meta.env.VITE_DEBUG_GCAL_SYNC === "true";
  if (debug) {
    console.log(
      "[gcal-sync] POST",
      `${BASE_URL}${url}`,
      JSON.stringify(options ?? {}),
    );
  }

  const res = await post<GoogleCalendarSyncResultDto>(url, {});
  if (debug) {
    // Log dạng 1 dòng JSON cho dễ copy vào chat.
    console.log(
      "[gcal-sync] RES",
      res.ok ? JSON.stringify(res.data) : JSON.stringify(res),
    );
  }
  return res;
}

/**
 * GET /api/google-calendar/events?from=&to=
 * Đọc event TRỰC TIẾP từ Google Calendar (không phải schedule slot nội bộ).
 */
export async function listGoogleCalendarEvents(
  from: string,
  to: string,
): Promise<ApiResult<CalendarEventDto[]>> {
  const qs = new URLSearchParams();
  qs.set("from", from);
  qs.set("to", to);
  return apiFetch<CalendarEventDto[]>(
    `/api/google-calendar/events?${qs.toString()}`,
    { method: "GET" },
  );
}

/**
 * POST /api/google-calendar/events
 * Tạo event mới trên Google Calendar.
 */
export async function createGoogleCalendarEvent(
  body: CalendarEventRequestDto,
): Promise<ApiResult<CalendarEventDto>> {
  return post<CalendarEventDto>("/api/google-calendar/events", body);
}

/**
 * PUT /api/google-calendar/events/{eventId}
 */
export async function updateGoogleCalendarEvent(
  eventId: string,
  body: CalendarEventRequestDto,
): Promise<ApiResult<CalendarEventDto>> {
  return put<CalendarEventDto>(
    `/api/google-calendar/events/${encodeURIComponent(eventId)}`,
    body,
  );
}

/**
 * DELETE /api/google-calendar/events/{eventId}
 * Trả 200 không body → dùng `apiFetch<void>`.
 */
export async function deleteGoogleCalendarEvent(
  eventId: string,
): Promise<ApiResult<void>> {
  return apiFetch<void>(
    `/api/google-calendar/events/${encodeURIComponent(eventId)}`,
    { method: "DELETE" },
  );
}

/* ================================================================
 * AI SERVICE (METANOIA Neural Engine)
 *
 * Base URL riêng (VITE_AI_API_URL), không dùng apiFetch chung.
 * Vẫn dùng Bearer accessToken METANOIA để AI service xác thực.
 *
 * Endpoints (xem Swagger):
 *   GET  /memory/similar?task_id=&limit=          -> SimilarResponse
 *   GET  /chat/tasks/{task_id}                    -> TaskChatResponse
 *   POST /chat/tasks/{task_id}/messages           -> ChatTurnResponse
 *   POST /chat/tasks/{task_id}/apply              -> AppliedResponse
 *   POST /schedule/propose                        -> ProposeScheduleResponse
 * ================================================================ */

const AI_BASE_URL =
  (import.meta.env.VITE_AI_API_URL as string | undefined)?.replace(/\/+$/, "") ?? "";

/* ---------- low-level aiFetch (riêng AI service) ---------- */

async function aiFetchRaw<T>(
  path: string,
  options: RequestInit = {},
): Promise<ApiResult<T>> {
  if (!AI_BASE_URL) {
    return {
      ok: false,
      error:
        "VITE_AI_API_URL is not configured. Add it to .env (see README).",
    };
  }
  const url = `${AI_BASE_URL}${path}`;
  const token = getAccessToken();

  const headers: Record<string, string> = {
    Accept: "application/json",
    ...(options.headers as Record<string, string> | undefined),
  };
  if (!(options.body instanceof FormData) && options.body !== undefined) {
    headers["Content-Type"] = "application/json";
  }
  if (token) headers["Authorization"] = `Bearer ${token}`;

  try {
    const res = await fetch(url, { ...options, headers });

    // Đọc body 1 lần dưới dạng text, rồi thử parse JSON — tránh lỗi "body already read".
    const rawText = await res.text();

    if (!res.ok) {
      // `detail` của FastAPI có thể là OBJECT ({code, message}) — không được gán
      // thẳng vào biến string, nếu không React sẽ crash khi render.
      let msg = friendlyStatusMessage(res.status);
      let parsed: unknown = null;
      try {
        parsed = rawText ? JSON.parse(rawText) : null;
      } catch {
        parsed = null;
      }
      // Ưu tiên thông báo theo mã lỗi nghiệp vụ của AI service (spec BE).
      const code = extractAiErrorCode(parsed);
      const translated = translateAiError(code, parsed);
      if (translated) {
        msg = translated;
      } else {
        // `detail` dạng chuỗi thuần (VD 502 → "AI unavailable, try again")
        // là thông điệp kỹ thuật của BE — KHÔNG đưa thẳng cho user.
        // Ưu tiên thông điệp theo HTTP status (đã dịch sẵn) nếu có.
        const extracted = extractMessage(parsed);
        if (extracted && !isTechnicalDetail(extracted)) {
          msg = extracted;
        } else if (rawText && !res.headers.get("content-type")?.includes("json")) {
          // body không phải JSON (vd: HTML error page từ App Service proxy 502)
          const snippet = rawText.slice(0, 120).replace(/\s+/g, " ").trim();
          if (snippet) msg = `Lỗi máy chủ (HTTP ${res.status}): ${snippet}`;
        }
      }
      return { ok: false, error: msg, status: res.status, errorCode: code ?? undefined };
    }

    // ok → parse JSON từ text đã đọc
    const data: unknown = rawText ? JSON.parse(rawText) : null;
    return { ok: true, data: data as T };
  } catch (err) {
    // Lỗi mạng / CORS / parse — không có HTTP status.
    console.error("[aiFetch] error for", url, err);
    return {
      ok: false,
      error:
        "Can't reach the AI service. Check your internet connection and try again.",
    };
  }
}

/**
 * Gọi AI service, tự refresh token khi gặp 401.
 *
 * AI service dùng **cùng** access token của METANOIA BE (BE xác thực rồi
 * proxy sang AI). Nên khi access token hết hạn, AI cũng trả 401 y hệt BE.
 *
 * `apiFetch` (BE) đã tự refresh + retry; `aiFetch` trước đây thì không →
 * các màn hình AI (Copilot, Project AI Chat, Briefing) sẽ chết khi token
 * hết hạn. Hàm này bổ sung cùng hành vi cho AI.
 *
 * Retry **tối đa 1 lần**: 401 sau khi refresh = token vẫn không hợp lệ →
 * trả lỗi, không refresh nữa (tránh loop vô hạn).
 *
 * ⚠️ Được export để `lib/group-ai-api.ts` dùng lại cho AI của nhóm
 *    (`GROUP_AI_FE.md`) — cùng cơ chế Bearer + refresh + parse lỗi.
 */
export async function aiFetch<T>(
  path: string,
  options: RequestInit = {},
): Promise<ApiResult<T>> {
  const first = await aiFetchRaw<T>(path, options);
  if (first.ok || first.status !== 401) return first;

  const refreshed = await tryRefresh();
  if (!refreshed.ok) return first;

  const retry = await aiFetchRaw<T>(path, options);
  if (retry.ok || retry.status !== 401) return retry;

  /*
   * `hadToken` = trước khi xoá token, user có phiên hay không.
   * Nếu KHÔNG có token (chưa từng đăng nhập) → 401 chỉ là "endpoint cần
   * auth" → KHÔNG redirect /login (đá khách khỏi trang public).
   */
  const hadToken = getAccessToken() !== null;

  // Refresh xong vẫn 401 → token không hợp lệ → đăng xuất như BE.
  clearTokens();
  /*
   * Đang ở route demo → không đá guest ra (demo là trang công khai).
   */
  if (!isDemoMode() && hadToken) {
    window.location.href = "/login";
  }
  return { ok: false, error: "session_expired", status: 401 };
}

/* ---------- types (xem openapi.json của AI service) ---------- */

export type ChatRole = "user" | "assistant";
export type ReplyKind = "question" | "draft";
export type SearchMode = "hybrid" | "text_only" | "none";
export type SimilarOutcome = "done" | "skipped";
export type EstimateSource = "user" | "ai";

export interface AiSubtask {
  title: string;
  estimated_minutes: number;
  order_index: number;
  reason?: string | null;
}

export interface DraftResponse {
  message_id: string;
  subtasks: AiSubtask[];
  your_estimate_minutes: number;
  adjusted_minutes: number;
  subtask_total_minutes: number;
  adjusted_is_hint: boolean;
  warning: string | null;
}

export interface AiMessage {
  id: string;
  role: ChatRole;
  kind: ReplyKind | null;
  content: string;
  created_at: string; // ISO 8601
  draft: DraftResponse | null;
}

export interface TaskChatResponse {
  task_id: string;
  messages: AiMessage[];
  latest_draft: DraftResponse | null;
  applied: boolean;
}

export interface ChatTurnResponse {
  task_id: string;
  user_message: AiMessage;
  ai_message: AiMessage;
}

export interface SimilarItem {
  task_id: string;
  title: string;
  domain: string;
  outcome: SimilarOutcome;
  estimated_minutes: number;
  actual_minutes: number;
  estimate_source: EstimateSource;
  ratio: number | null;
  similarity: number;
  /** Thời điểm hoàn thành (ISO) — spec BE: `finished_at`. */
  finished_at?: string | null;
  /** Lý do đã dừng — spec BE: `stop_reasons[]`. */
  stop_reasons?: string[] | null;
}

export interface SummaryResponse {
  count: number;
  done_count: number;
  average_ratio: number | null;
}

export interface SimilarResponse {
  task_id: string;
  search_mode: SearchMode;
  items: SimilarItem[];
  summary: SummaryResponse;
}

export interface EditedAiSubtask {
  title: string;
  estimated_minutes: number;
}

export interface ApplyRequest {
  message_id: string;
  subtasks?: EditedAiSubtask[] | null;
}

export interface AppliedSubtask {
  id: string;
  title: string;
  estimated_minutes: number;
  order_index: number;
}

export interface AppliedResponse {
  task_id: string;
  subtasks: AppliedSubtask[];
}

/* ---------- public AI helpers ---------- */

/**
 * GET /memory/similar?task_id=&limit=
 * Trả về tối đa `limit` task quá khứ giống task hiện tại (cho RAG).
 * Không tốn quota AI.
 */
export async function getSimilarMemory(
  taskId: string,
  limit?: number,
): Promise<ApiResult<SimilarResponse>> {
  if (!taskId) {
    return { ok: false, error: "task_id is required" };
  }
  const qs = new URLSearchParams();
  qs.set("task_id", taskId);
  if (limit !== undefined && limit !== null) {
    qs.set("limit", String(Math.max(1, Math.min(10, limit))));
  }
  return aiFetch<SimilarResponse>(`/memory/similar?${qs.toString()}`, {
    method: "GET",
  });
}

/**
 * GET /chat/tasks/{task_id}
 * Lấy toàn bộ messages + draft mới nhất của chat theo task.
 * Không gọi AI — chỉ đọc.
 */
export async function getTaskChat(
  taskId: string,
): Promise<ApiResult<TaskChatResponse>> {
  if (!taskId) return { ok: false, error: "task_id is required" };
  return aiFetch<TaskChatResponse>(
    `/chat/tasks/${encodeURIComponent(taskId)}`,
    { method: "GET" },
  );
}

/** Chờ 1 khoảng (ms) rồi resolve — dùng cho retry backoff. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * POST /chat/tasks/{task_id}/messages
 * Gửi 1 message từ user — tốn 1 AI call khi AI trả lời.
 *
 * Tự retry khi gặp **409 Conflict**: trường hợp này xảy ra khi AI đang xử lý
 * yêu cầu trước cho cùng task (double-submit, hoặc request trước chưa xong).
 * Đây là lỗi **tạm thời** — chờ một chút rồi gửi lại thường thành công.
 *
 * Retry tối đa 2 lần, backoff 1.5s rồi 3s. Các lỗi khác (401/403/422/429/5xx)
 * không retry vì retry sẽ chỉ tốn thêm quota AI.
 */
export async function sendTaskMessage(
  taskId: string,
  message: string,
): Promise<ApiResult<ChatTurnResponse>> {
  if (!taskId) return { ok: false, error: "task_id is required" };
  const trimmed = message.trim();
  if (!trimmed) return { ok: false, error: "message is empty" };

  const MAX_RETRIES = 2;
  const BACKOFF_MS = [1500, 3000];

  let last: ApiResult<ChatTurnResponse> = {
    ok: false,
    error: "Không gửi được tin nhắn.",
  };

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    last = await aiFetch<ChatTurnResponse>(
      `/chat/tasks/${encodeURIComponent(taskId)}/messages`,
      { method: "POST", body: JSON.stringify({ message: trimmed }) },
    );
    if (last.ok) return last;
    if (last.status !== 409) return last;
    if (attempt === MAX_RETRIES) break;
    console.warn(
      `[sendTaskMessage] 409 Conflict — thử lại sau ${BACKOFF_MS[attempt]}ms (lần ${attempt + 1}/${MAX_RETRIES})`,
    );
    await sleep(BACKOFF_MS[attempt]);
  }

  return last;
}

/**
 * POST /chat/tasks/{task_id}/apply
 * Apply draft mới nhất (hoặc list đã edit) thành subtasks thật.
 * Không tốn AI quota.
 */
export async function applyTaskChat(
  taskId: string,
  messageId: string,
  subtasks?: EditedAiSubtask[] | null,
): Promise<ApiResult<AppliedResponse>> {
  if (!taskId) return { ok: false, error: "task_id is required" };
  if (!messageId) return { ok: false, error: "message_id is required" };
  const body: ApplyRequest = {
    message_id: messageId,
    subtasks: subtasks ?? null,
  };
  return aiFetch<AppliedResponse>(
    `/chat/tasks/${encodeURIComponent(taskId)}/apply`,
    { method: "POST", body: JSON.stringify(body) },
  );
}

/* ============================================================
 * PROJECT CHAT — FR-08b-1 (AI chat mức dự án)
 * ----------------------------------------------------------
 * Chat AI theo *project* (không phải task): user dán brief của khách,
 * AI hỏi lại nếu thiếu thông tin, rồi đưa bản nháp milestone + task
 * Flexible. User bấm Apply → BE tạo Milestone + Task thật.
 *
 * Tất cả endpoint thuộc **AI service** (VITE_AI_API_URL) → dùng `aiFetch`.
 *
 *   POST /chat/projects/{project_id}/conversations   → mở cuộc chat mới
 *   GET  /chat/projects/{project_id}/conversations   → danh sách cuộc chat
 *   GET  /chat/conversations/{id}                    → lịch sử + draft
 *   POST /chat/conversations/{id}/messages           → gửi tin (tốn 1 lượt AI)
 *   POST /chat/conversations/{id}/apply              → ghi milestone + task
 *
 * Quy tắc quan trọng:
 *   - Mỗi cuộc chat chỉ Apply được **1 lần** (BE trả 409 `already_applied`).
 *   - `message_id` của apply phải là **bản nháp mới nhất** (409 `not_latest_draft`).
 *   - Chỉ endpoint `messages` mới tốn lượt AI.
 * ============================================================ */

export type ProjectConversationStatus = "open" | "applied" | "closed";
/**
 * Loại tin AI.
 * - `discuss`  : bàn bạc — có `content` + `notes` + cờ `ready_to_plan`.
 * - `draft`    : bản nháp milestone + task.
 * - `question` : AI hỏi lại (chỉ có `content`).
 */
export type ProjectReplyKind = "discuss" | "question" | "draft";
export type ProjectEstimateSource = "user" | "ai";
/** Lý do 1 task bị bỏ qua khi Apply (trùng việc đã có / trùng trong bản nháp). */
export type ProjectSkipReason = "existing_task" | "in_draft";

export interface ProjectConversationDto {
  conversation_id: string;
  title: string;
  status: ProjectConversationStatus;
  created_at: string;
}

export interface ProjectDomainDto {
  id: string;
  name: string;
}

export interface ProjectDomainNumbersDto {
  domain: string;
  estimated_minutes: number;
  adjusted_minutes: number;
}

export interface ProjectNumbersDto {
  by_domain: ProjectDomainNumbersDto[];
  total_estimated_minutes: number;
  total_adjusted_minutes: number;
  days_left: number | null;
  adjusted_is_hint: boolean;
}

export interface ProjectDraftDto {
  message_id: string;
  milestones: ProjectDraftMilestoneDto[];
  reminders: string[];
  numbers: ProjectNumbersDto;
  warnings: string[];
  /** `true` = bản nháp này đã được áp dụng → ẩn nút Apply, hiện nhãn. */
  applied?: boolean;
}

export interface ProjectChatMessageDto {
  id: string;
  role: ChatRole;
  kind: ProjectReplyKind | null;
  content: string;
  created_at: string;
  draft: ProjectDraftDto | null;
  /** Ghi chú đi kèm cho tin loại `discuss`. */
  notes?: ProjectChatNotesDto | null;
  /** `true` → AI đã đủ thông tin, bật nút "Lên kế hoạch". */
  ready_to_plan?: boolean;
}

export interface ProjectChatDto {
  conversation_id: string;
  project_id: string;
  status: ProjectConversationStatus;
  messages: ProjectChatMessageDto[];
  latest_draft: ProjectDraftDto | null;
  applied: boolean;
}

export interface ProjectChatTurnDto {
  conversation_id: string;
  user_message: ProjectChatMessageDto;
  ai_message: ProjectChatMessageDto;
}

export interface AppliedProjectTaskDto {
  id: string;
  title: string;
  estimated_minutes: number;
  estimate_source: ProjectEstimateSource;
}

export interface AppliedProjectMilestoneDto {
  id: string;
  title: string;
  deadline: string;
  tasks: AppliedProjectTaskDto[];
  /**
   * `true` = milestone này đã tồn tại, task được **thêm vào** nó
   * (thay vì tạo milestone mới) → UI hiện "Đã thêm vào cột mốc …".
   */
  reused?: boolean;
}

export interface SkippedProjectTaskDto {
  title: string;
  reason: ProjectSkipReason;
}

export interface AppliedProjectBreakdownDto {
  milestones: AppliedProjectMilestoneDto[];
  skipped: SkippedProjectTaskDto[];
}

/** Việc con gửi kèm lúc Apply — bỏ field = giữ việc con của AI, `[]` = không việc con. */
export interface EditedProjectSubtask {
  title: string;
  estimated_minutes: number;
}

/** Task sửa tay lúc Apply — cùng shape với `EditedMilestone` của AI service. */
export interface EditedProjectTask {
  key?: string | null;
  title: string;
  domain_id: string;
  estimated_minutes: number;
  /**
   * Việc con.
   * - `undefined` (bỏ field) → giữ nguyên việc con AI sinh.
   * - `[]` → không có việc con.
   */
  subtasks?: EditedProjectSubtask[];
}

export interface EditedProjectMilestone {
  key?: string | null;
  title: string;
  deadline?: string | null;
  tasks: EditedProjectTask[];
}

/**
 * POST /chat/projects/{project_id}/conversations
 * Mở cuộc chat mới cho 1 project. Không tốn lượt AI.
 *
 * 409 → project đã đóng (`Completed` / `Archived`).
 */
export async function startProjectConversation(
  projectId: string,
): Promise<ApiResult<ProjectConversationDto>> {
  if (!projectId) return { ok: false, error: "project_id is required" };
  return aiFetch<ProjectConversationDto>(
    `/chat/projects/${encodeURIComponent(projectId)}/conversations`,
    { method: "POST" },
  );
}

/**
 * GET /chat/projects/{project_id}/conversations
 * Danh sách cuộc chat của project (mới nhất trước).
 */
export async function listProjectConversations(
  projectId: string,
): Promise<ApiResult<ProjectConversationDto[]>> {
  if (!projectId) return { ok: false, error: "project_id is required" };
  return aiFetch<ProjectConversationDto[]>(
    `/chat/projects/${encodeURIComponent(projectId)}/conversations`,
    { method: "GET" },
  );
}

/**
 * GET /chat/conversations/{conversation_id}
 * Lấy lịch sử tin nhắn + bản nháp mới nhất của cuộc chat. Không gọi AI.
 */
export async function getProjectChat(
  conversationId: string,
): Promise<ApiResult<ProjectChatDto>> {
  if (!conversationId) return { ok: false, error: "conversation_id is required" };
  return aiFetch<ProjectChatDto>(
    `/chat/conversations/${encodeURIComponent(conversationId)}`,
    { method: "GET" },
  );
}

/**
 * POST /chat/conversations/{conversation_id}/messages
 * Gửi 1 tin nhắn (brief của khách) — **tốn 1 lượt AI** khi AI trả lời.
 *
 * Retry tự động khi gặp **409**: BE trả 409 khi cuộc chat đã Apply, project đã
 * đóng, hoặc chưa có gói `Active`. 3 trường hợp này đều là lỗi vĩnh viễn →
 * retry sẽ chỉ tốn thêm lượt AI. Vì vậy **không** retry 409 ở đây (khác với
 * `sendTaskMessage` của FR-08a, nơi 409 là lỗi tạm thời).
 */
export async function sendProjectChatMessage(
  conversationId: string,
  message: string,
  mode: ProjectChatMode = "discuss",
  documentIds?: string[] | null,
): Promise<ApiResult<ProjectChatTurnDto>> {
  if (!conversationId) return { ok: false, error: "conversation_id is required" };
  const trimmed = message.trim();

  // `mode: "plan"` là nút "Lên kế hoạch" → message gửi lại để trống.
  if (mode === "discuss") {
    if (!trimmed) return { ok: false, error: "message is empty" };
    if (trimmed.length > 8000) {
      return {
        ok: false,
        error: "Tin nhắn vượt quá 8.000 ký tự. Vui lòng dán phần chính của brief.",
      };
    }
  }

  const body: {
    message: string;
    mode: ProjectChatMode;
    document_ids?: string[];
  } = { message: trimmed, mode };
  if (documentIds && documentIds.length > 0) body.document_ids = documentIds;

  return aiFetch<ProjectChatTurnDto>(
    `/chat/conversations/${encodeURIComponent(conversationId)}/messages`,
    { method: "POST", body: JSON.stringify(body) },
  );
}

/**
 * POST /chat/conversations/{conversation_id}/messages/files
 * Gửi tin nhắn **kèm file đính kèm** — tối đa 3 file/tin.
 *
 * Dùng `multipart/form-data`:
 *   - `message`   : nội dung tin (có thể rỗng nếu chỉ đính kèm file)
 *   - `mode`      : "discuss" | "plan"
 *   - `files[]`   : file thực (pdf, docx, txt, md, xlsx, csv)
 *   - `document_ids[]`: id tài liệu đã có sẵn trong dự án
 */
export async function sendProjectChatMessageWithFiles(
  conversationId: string,
  message: string,
  files: File[],
  mode: ProjectChatMode = "discuss",
  documentIds?: string[] | null,
): Promise<ApiResult<ProjectChatTurnDto>> {
  if (!conversationId) return { ok: false, error: "conversation_id is required" };
  if (files.length === 0) {
    return {
      ok: false,
      error: "Cần ít nhất 1 file để gửi. Dùng ô chat để gửi tin không kèm file.",
    };
  }
  if (files.length > 3) {
    return { ok: false, error: "Tối đa 3 file cho mỗi tin nhắn." };
  }

  const form = new FormData();
  form.append("message", message.trim());
  form.append("mode", mode);
  for (const f of files) form.append("files[]", f);
  for (const id of documentIds ?? []) form.append("document_ids[]", id);

  return aiFetch<ProjectChatTurnDto>(
    `/chat/conversations/${encodeURIComponent(conversationId)}/messages/files`,
    { method: "POST", body: form },
  );
}

/**
 * POST /chat/conversations/{conversation_id}/apply
 * Ghi bản nháp thành Milestone + Task thật. Không tốn lượt AI.
 *
 * `milestones` = null → dùng nguyên bản nháp. Truyền mảng → sửa tay
 * (đổi title / phút / domain / deadline, thêm / bỏ task / milestone).
 *
 * 409 → `not_latest_draft` | `already_applied` | `project_closed`.
 */
export async function applyProjectBreakdown(
  conversationId: string,
  messageId: string,
  milestones?: EditedProjectMilestone[] | null,
): Promise<ApiResult<AppliedProjectBreakdownDto>> {
  if (!conversationId) return { ok: false, error: "conversation_id is required" };
  if (!messageId) return { ok: false, error: "message_id is required" };
  const body: { message_id: string; milestones: EditedProjectMilestone[] | null } = {
    message_id: messageId,
    milestones: milestones ?? null,
  };
  return aiFetch<AppliedProjectBreakdownDto>(
    `/chat/conversations/${encodeURIComponent(conversationId)}/apply`,
    { method: "POST", body: JSON.stringify(body) },
  );
}

/* ================================================================
 * AI SERVICE — BỔ SUNG THEO SPEC "API AI cho màn hình (gửi FE)"
 * ------------------------------------------------------------
 * Các thay đổi so với bản cũ:
 *  1. `mode` cho endpoint messages: "discuss" (ô chat) | "plan" (nút).
 *  2. `notes` trong tin AI loại "discuss" + cờ `ready_to_plan`.
 *  3. `reason` cho milestone, `subtasks[]` cho task trong bản nháp.
 *  4. `apply-and-schedule` (nút chính) + `schedule` + `schedule_error`.
 *  5. `reused` trên milestone kết quả Apply.
 *  6. Nhập từ file: `/projects/import/preview` + `/projects/import`.
 *  7. Đính kèm file trong chat: `/chat/conversations/{id}/messages/files`.
 *  8. Lịch sử chat: `/chat/conversations?q=`.
 * ================================================================ */

/** Chế độ gửi tin nhắn — `discuss` (ô chat) hoặc `plan` (nút "Lên kế hoạch"). */
export type ProjectChatMode = "discuss" | "plan";

/**
 * Ghi chú đi kèm tin AI loại `discuss`.
 * Mỗi mảng là danh sách câu/ý dạng text do AI sinh ra.
 */
export interface ProjectChatNotesDto {
  /** Đã rõ — những gì AI đã nắm được. */
  clear?: string[] | null;
  /** Còn thiếu — thông tin AI cần user bổ sung. */
  missing?: string[] | null;
  /** Nên hỏi thêm — câu hỏi gợi ý. */
  questions?: string[] | null;
  /** Rủi ro — điểm AI thấy dễ sót. */
  risks?: string[] | null;
}

/** Việc con của 1 task trong bản nháp (chỉ có khi task > 2 giờ). */
export interface ProjectDraftSubtaskDto {
  title: string;
  estimated_minutes: number;
  reason: string | null;
}

/** 1 việc trong bản nháp — giờ có thêm `subtasks[]`. */
export interface ProjectDraftTaskDto {
  key: string | null;
  title: string;
  domain: ProjectDomainDto;
  estimated_minutes: number;
  reason: string | null;
  /** Việc con — chỉ AI sinh khi task > 2 giờ. */
  subtasks?: ProjectDraftSubtaskDto[] | null;
}

/** 1 cột mốc trong bản nháp — giờ có thêm `reason` (vì sao có giai đoạn này). */
export interface ProjectDraftMilestoneDto {
  key: string | null;
  title: string;
  deadline: string; // ISO date YYYY-MM-DD
  /** Vì sao AI chia giai đoạn này. */
  reason?: string | null;
  tasks: ProjectDraftTaskDto[];
}

/* ---------- apply-and-schedule (nút chính) ---------- */

/** Lý do xếp lịch thất bại sau khi việc đã được tạo. */
export type ScheduleErrorCode =
  | "quota_exceeded"
  | "no_active_plan"
  | "plan_feature_locked"
  | "schedule_failed";

/** Kết quả xếp lịch trả về từ `apply-and-schedule`. */
export interface AppliedScheduleDto {
  proposal_id: string | null;
  is_feasible: boolean;
  missing_minutes: number;
  explanation: string | null;
  slots: ProposedSlotDto[];
  warnings: ScheduleWarningDto[];
}

/**
 * Response của `POST /chat/conversations/{id}/apply-and-schedule`.
 *
 * ⚠️ Shape thật (đối chiếu OpenAPI của AI service):
 *   201 {`applied`: AppliedResponse, `schedule`, `schedule_error`}
 *
 * Trong đó `applied` là **object** `{milestones[], skipped[]}` — KHÔNG phải
 * boolean, và `milestones[]` **KHÔNG nằm ở top-level**.
 *
 * Endpoint `apply` (nút phụ "Chỉ áp dụng") trả thẳng `AppliedResponse`:
 *   201 {`milestones[]`, `skipped[]`}
 */
export interface ApplyAndScheduleResponseDto {
  /**
   * Kết quả ghi bản nháp thành milestone + task.
   * Có thể `null` nếu BE báo lỗi nghiệp vụ mà vẫn trả 200.
   */
  applied?: AppliedProjectBreakdownDto | null;
  /** Đề xuất lịch — có thể `null` nếu không có gì để xếp. */
  schedule?: AppliedScheduleDto | null;
  /** Mã lỗi xếp lịch — việc vẫn đã được tạo. */
  schedule_error?: ScheduleErrorCode | null;
}

/**
 * POST /chat/conversations/{conversation_id}/apply-and-schedule
 * **Nút chính**: ghi bản nháp thành Milestone + Task **và** xếp lịch luôn.
 *
 * Tốn 1 lượt AI (phần xếp lịch).
 *
 * - `milestones` = null → dùng nguyên bản nháp; truyền mảng → sửa tay.
 * - `schedule_error` ≠ null → việc **đã được tạo**, chỉ chưa xếp được lịch
 *   → UI hiện "Đã tạo việc, chưa xếp được lịch" + nút Xếp lịch.
 */
export async function applyAndScheduleProjectBreakdown(
  conversationId: string,
  messageId: string,
  milestones?: EditedProjectMilestone[] | null,
  language: "vi" | "en" = "vi",
): Promise<ApiResult<ApplyAndScheduleResponseDto>> {
  if (!conversationId) return { ok: false, error: "conversation_id is required" };
  if (!messageId) return { ok: false, error: "message_id is required" };
  const body: {
    message_id: string;
    milestones: EditedProjectMilestone[] | null;
    language: "vi" | "en";
  } = {
    message_id: messageId,
    milestones: milestones ?? null,
    language,
  };
  return aiFetch<ApplyAndScheduleResponseDto>(
    `/chat/conversations/${encodeURIComponent(conversationId)}/apply-and-schedule`,
    { method: "POST", body: JSON.stringify(body) },
  );
}

/* ---------- Nhập từ file → nhiều dự án ---------- */

/** Ngôn ngữ của file nhập vào. */
export type ImportLanguage = "vi" | "en";

/** 1 dự án AI đọc được từ file. */
export interface ImportPreviewProjectDto {
  name: string;
  description: string | null;
  deadline: string | null;
  /** Dự án nằm ở đâu trong file (vd "Sheet Việc tháng 12, rows 2-3"). */
  source: string | null;
  /** Nội dung tóm tắt — hiện qua nút "Xem brief". */
  brief: string | null;
}

/** Lý do file không đọc được (422 `{code, file}`). */
export type ImportErrorCode =
  | "unsupported_type"
  | "no_text"
  | "unreadable"
  | "too_large";

export interface ImportPreviewResponseDto {
  file_name: string;
  projects: ImportPreviewProjectDto[];
  /** Cảnh báo (vd "file có 12 dự án nhưng gói chỉ còn 3 slot"). */
  warnings: string[];
  /** Số dự án tối đa được tạo — `null` = không giới hạn. */
  project_limit: number | null;
  /** Số dự án còn có thể tạo. */
  projects_left: number | null;
}

/** 1 dự án sau khi tạo — kèm conversation để mở chat luôn. */
export interface ImportedProjectDto {
  project_id: string;
  conversation_id: string | null;
  name: string;
}

/** Request body của `POST /projects/import` — danh sách đã sửa. */
export interface ImportProjectsRequest {
  file_name: string;
  language: ImportLanguage;
  projects: Array<{
    name: string;
    description?: string | null;
    deadline?: string | null;
  }>;
}

/**
 * POST /projects/import/preview
 * Upload file (xlsx, csv, pdf, docx, txt, md — tối đa 20 MB) → AI đọc ra
 * danh sách dự án để user xem trước & sửa. Tốn 1 lượt AI.
 *
 * Gói Free không dùng được bước xem trước (403 `plan_feature_locked`).
 */
export async function previewProjectImport(
  file: File,
  language: ImportLanguage = "vi",
): Promise<ApiResult<ImportPreviewResponseDto>> {
  const form = new FormData();
  form.append("file", file);
  form.append("language", language);
  return aiFetch<ImportPreviewResponseDto>("/projects/import/preview", {
    method: "POST",
    body: form,
  });
}

/**
 * POST /projects/import
 * Tạo dự án từ danh sách đã sửa ở bước xem trước. Không tốn lượt AI.
 *
 * 409 `project_limit` → gói hết chỗ tạo dự án (không dự án nào được tạo).
 */
export async function importProjects(
  body: ImportProjectsRequest,
): Promise<ApiResult<ImportedProjectDto[]>> {
  if (!body.file_name) return { ok: false, error: "file_name is required" };
  if (body.projects.length === 0) {
    return { ok: false, error: "Cần ít nhất 1 dự án để tạo." };
  }
  return aiFetch<ImportedProjectDto[]>("/projects/import", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

/* ---------- Lịch sử chat ---------- */

/** Phạm vi của 1 cuộc chat trong lịch sử. */
export type ChatHistoryScope = "project" | "task";

/** Tin nhắn cuối cùng của 1 cuộc chat (để preview trong danh sách). */
export interface ChatHistoryLastMessageDto {
  role: ChatRole;
  preview: string | null;
  created_at: string;
}

/** 1 dòng trong danh sách lịch sử chat. */
export interface ChatHistoryItemDto {
  conversation_id: string;
  scope: ChatHistoryScope;
  /** Tên dự án — chỉ có khi `scope = "project"`. */
  project?: { id: string; name: string } | null;
  /** Task — chỉ có khi `scope = "task"`. */
  task?: { id: string; name: string } | null;
  status: string;
  /** `true` → hiện nhãn "Đã áp dụng". */
  applied: boolean;
  message_count: number;
  last_message: ChatHistoryLastMessageDto | null;
  /** Vị trí khớp khi tìm kiếm — để tô đậm & cuộn tới đúng tin. */
  match?: { message_id: string; snippet: string } | null;
}

export interface ChatHistoryResponseDto {
  items: ChatHistoryItemDto[];
  /** Còn trang sau không. */
  has_more: boolean;
}

/**
 * GET /chat/conversations?q=&limit=&offset=
 * Lịch sử chat của user (chat dự án + chat chia nhỏ task), tin mới nhất trước.
 * Không tốn lượt AI.
 *
 * - `q` ≤ 100 ký tự — tìm trong tin nhắn, tên dự án, tên task.
 * - `limit` 1–50 (mặc định 20), `offset` 0–1000.
 */
export async function listChatHistory(params?: {
  q?: string;
  limit?: number;
  offset?: number;
}): Promise<ApiResult<ChatHistoryResponseDto>> {
  const qs = new URLSearchParams();
  const q = (params?.q ?? "").trim();
  if (q) qs.set("q", q.slice(0, 100));
  if (params?.limit !== undefined) {
    qs.set("limit", String(Math.max(1, Math.min(50, params.limit))));
  }
  if (params?.offset !== undefined) {
    qs.set("offset", String(Math.max(0, Math.min(1000, params.offset))));
  }
  const suffix = qs.toString();
  return aiFetch<ChatHistoryResponseDto>(
    `/chat/conversations${suffix ? `?${suffix}` : ""}`,
    { method: "GET" },
  );
}

/* ============================================================
 * BRIEFING — bản tóm tắt hôm nay (AI service)
 * ----------------------------------------------------------
 * GET /briefing/today?language=vi|en
 *
 * Endpoint READ-ONLY của AI service: gộp sẵn task + slot + lịch Google
 * + hồ sơ năng suất của user thành 1 payload duy nhất. **Không tốn
 * quota AI, không gọi LLM.**
 *
 * ⚠️ `language` chỉ nhận `vi` | `en` — giá trị khác → BE trả 422.
 * Wrapper dưới đây tự chuẩn hoá nên FE không bao giờ gửi giá trị lạ.
 *
 * Phạm vi dùng: trang /briefing (mới). KHÔNG dùng `schedule[]` để thay
 * thế `GET /api/calendar` của BE — calendar BE giàu thông tin hơn
 * (subTaskId, googleEventId, syncFailed, isManualOverride) và cần cho các
 * hành động tương tác (bấm slot để bắt đầu focus).
 * ============================================================ */

export type BriefingLanguage = "vi" | "en";

/**
 * Nguồn của 1 dòng trong lịch hôm nay.
 *
 * ⚠️ Từ 25/11 (AI PR #58): slot của **việc nhóm** xuất hiện với
 * `kind: "group"` và `task_id` = **id việc nhóm** (không phải task cá
 * nhân). Bấm vào phải mở việc nhóm, KHÔNG mở `/tasks/{id}`.
 */
export type BriefingScheduleKind = "slot" | "fixed" | "google" | "group";

/** Vì sao task nằm trong danh sách "nên làm hôm nay". */
export type BriefingReasonCode =
  | "overdue"
  | "at_risk"
  | "in_progress"
  | "deadline_soon"
  | "bias";

export interface BriefingScheduleItem {
  kind: BriefingScheduleKind;
  start: string;
  end: string;
  title: string;
  /**
   * Id của task.
   *
   * ⚠️ Với `kind: "group"` đây là **id việc nhóm** (`groupTaskId`), KHÔNG
   * phải task cá nhân → bấm vào phải mở `/groups/{groupId}`.
   */
  task_id: string | null;
  /**
   * Id của nhóm (chỉ có với `kind: "group"`) — dùng để deep-link.
   */
  group_id?: string | null;
  status: "Approved" | "Done" | null;
}

export interface BriefingTopTask {
  task_id: string;
  title: string;
  project_name: string;
  deadline: string;
  remaining_minutes: number;
  reasons: { code: BriefingReasonCode; text: string }[];
  similar_warning: { text: string } | null;
}

export interface BriefingAtRisk {
  task_id: string;
  title: string;
  deadline: string;
  missing_minutes: number;
}

export interface BriefingProductiveHint {
  ranges: { start: string; end: string }[];
  text: string;
}

export interface BriefingResponse {
  date: string;
  time_zone: string;
  calendar_connected: boolean;
  has_pending_proposal: boolean;
  schedule: BriefingScheduleItem[];
  all_day: { title: string }[];
  top_tasks: BriefingTopTask[];
  at_risk: BriefingAtRisk[];
  productive_hint: BriefingProductiveHint | null;
}

/**
 * GET /briefing/today?language=vi|en
 *
 * @param language Ngôn ngữ của phần text AI viết (`vi` | `en`).
 *   Mọi giá trị khác bị ép về `vi` — BE trả 422 nếu gửi giá trị lạ.
 */
export async function getTodayBriefing(
  language: BriefingLanguage = "vi",
): Promise<ApiResult<BriefingResponse>> {
  const lang: BriefingLanguage = language === "en" ? "en" : "vi";
  return aiFetch<BriefingResponse>(`/briefing/today?language=${lang}`, {
    method: "GET",
  });
}

/* ================================================================
 * ANALYTICS — Thống kê (AI service, không tốn lượt AI)
 * ----------------------------------------------------------
 * GET /analytics/overview?range=&by=&limit=
 * GET /analytics/breakdown?range=&by=&limit=
 *
 * - `range`: khoảng thời gian (vd "7d", "30d", "month").
 * - `by`   : chi tiết theo loại việc / khách / dự án / task.
 * - `limit`: giới hạn số dòng breakdown.
 * ================================================================ */

/** Khoảng thời gian của báo cáo. */
export type AnalyticsRange = "7d" | "30d" | "90d" | "month" | "quarter";

/** Chiều chi tiết của báo cáo. */
export type AnalyticsBreakdownBy = "domain" | "client" | "project" | "task";

/** 1 dòng breakdown — mức hay ước thiếu theo 1 nhóm. */
export interface AnalyticsBreakdownItemDto {
  /** Nhóm (tên domain / khách / dự án / task). */
  name: string;
  /** Mã nhóm nếu có. */
  id: string | null;
  /** Tỉ lệ hoàn thành (0–1 hoặc 0–100 tuỳ BE). */
  completion_rate: number;
  /** Số task đã hoàn thành. */
  completed_tasks: number;
  /** Tổng số task. */
  total_tasks: number;
  /** Mức hay ước thiếu theo thói quen (phút). */
  estimated_minutes: number;
  /** Phút thực tế đã dùng. */
  actual_minutes: number;
  /** Xu hướng so với kỳ trước (%). */
  trend: number[];
}

/** Response của `/analytics/overview`. */
export interface AnalyticsOverviewDto {
  range: string;
  /** Tỉ lệ hoàn thành tổng. */
  completion_rate: number;
  /** Mức hay ước thiếu (phút). */
  estimated_minutes: number;
  /** Phút thực tế. */
  actual_minutes: number;
  /** Số task hoàn thành / tổng số task. */
  completed_tasks: number;
  total_tasks: number;
  /** Câu nhận xét do AI viết. */
  insights: { text: string }[];
}

/** Response của `/analytics/breakdown`. */
export interface AnalyticsBreakdownDto {
  range: string;
  by: AnalyticsBreakdownBy;
  /** Các nhóm + mức hay ước thiếu theo loại việc. */
  domains: {
    /** Tên nhóm. */
    text: string;
    /** Mức hay ước thiếu (phút). */
    estimated_minutes: number;
    /** Phút thực tế. */
    actual_minutes: number;
    /** Tỉ lệ hoàn thành. */
    completion_rate: number;
    /** Xu hướng. */
    trend: number[];
  }[];
  insights: { text: string }[];
}

/**
 * GET /analytics/overview — tổng quan tỉ lệ hoàn thành + mức hay ước thiếu.
 * Không tốn lượt AI.
 */
export async function getAnalyticsOverview(params?: {
  range?: AnalyticsRange;
  by?: AnalyticsBreakdownBy;
  limit?: number;
}): Promise<ApiResult<AnalyticsOverviewDto>> {
  const qs = new URLSearchParams();
  if (params?.range) qs.set("range", params.range);
  if (params?.by) qs.set("by", params.by);
  if (params?.limit !== undefined) {
    qs.set("limit", String(Math.max(1, Math.min(50, params.limit))));
  }
  const suffix = qs.toString();
  return aiFetch<AnalyticsOverviewDto>(
    `/analytics/overview${suffix ? `?${suffix}` : ""}`,
    { method: "GET" },
  );
}

/**
 * GET /analytics/breakdown — chi tiết theo loại việc / khách / dự án / task.
 * Không tốn lượt AI.
 */
export async function getAnalyticsBreakdown(params?: {
  range?: AnalyticsRange;
  by?: AnalyticsBreakdownBy;
  limit?: number;
}): Promise<ApiResult<AnalyticsBreakdownDto>> {
  const qs = new URLSearchParams();
  if (params?.range) qs.set("range", params.range);
  if (params?.by) qs.set("by", params.by);
  if (params?.limit !== undefined) {
    qs.set("limit", String(Math.max(1, Math.min(50, params.limit))));
  }
  const suffix = qs.toString();
  return aiFetch<AnalyticsBreakdownDto>(
    `/analytics/breakdown${suffix ? `?${suffix}` : ""}`,
    { method: "GET" },
  );
}

/* ================================================================
 * GIỜ HIỆU QUẢ — productive hours (AI service, không tốn lượt AI)
 * ----------------------------------------------------------
 * PUT /profile/productive-hours/onboarding   → {blocks}
 * GET /profile/productive-hours
 *
 * - `hours[]`  : điểm từng giờ (0–1) — biểu đồ nhiệt 24 giờ.
 * - `top_hours`: các khung giờ tốt nhất để xếp lịch.
 * - `onboarded`: user đã khai báo giờ hiệu quả chưa.
 * ================================================================ */

/** 1 khung giờ user khai báo tập trung tốt. */
export interface ProductiveHoursBlock {
  /** Giờ bắt đầu (0–23). */
  start: number;
  /** Giờ kết thúc (0–24). */
  end: number;
}

export interface ProductiveHoursDto {
  /** User đã hoàn tất bước khai báo giờ hiệu quả chưa. */
  onboarded: boolean;
  /** Điểm từng giờ trong ngày (0–1). */
  hours: number[];
  /** Các khung giờ hiệu quả nhất. */
  top_hours: { start: string; end: string }[];
}

/**
 * GET /profile/productive-hours
 * Điểm hiệu quả từng giờ + các khung giờ tốt nhất. Không tốn lượt AI.
 */
export async function getProductiveHours(): Promise<
  ApiResult<ProductiveHoursDto>
> {
  return aiFetch<ProductiveHoursDto>("/profile/productive-hours", {
    method: "GET",
  });
}

/**
 * PUT /profile/productive-hours/onboarding
 * Lưu các khung giờ user khai báo là giờ hiệu quả. Không tốn lượt AI.
 */
export async function saveProductiveHoursOnboarding(
  blocks: ProductiveHoursBlock[],
): Promise<ApiResult<ProductiveHoursDto>> {
  if (!Array.isArray(blocks) || blocks.length === 0) {
    return {
      ok: false,
      error: "Cần chọn ít nhất 1 khung giờ hiệu quả.",
    };
  }
  return aiFetch<ProductiveHoursDto>(
    "/profile/productive-hours/onboarding",
    { method: "PUT", body: JSON.stringify({ blocks }) },
  );
}

/* ============================================================
 * Subscription plans (GET /api/subscription-plans)
 * ----------------------------------------------------------
 * Nguồn sự thật cho trang /pricing. Mỗi gói có:
 *   id, name, price (VND), durationDays, aiCallLimit (null = không
 *   giới hạn), storageLimitMb, projectLimit (null = không giới
 *   hạn), isActive.
 *
 * Chỉ gói `isActive = true` VÀ `price > 0` mới mua được.
 * Gói Miễn phí (price = 0) không có nút mua.
 * ============================================================ */

export interface SubscriptionPlanDto {
  id: string;
  name: string | null;
  /** Giá (VND, số nguyên) cho 1 chu kỳ `durationDays`. */
  price: number;
  /** Thời hạn 1 chu kỳ thanh toán (ngày). */
  durationDays: number;
  /** null = không giới hạn. */
  aiCallLimit: number | null;
  /** Dung lượng lưu trữ (MB). */
  storageLimitMb: number;
  /** null = không giới hạn. */
  projectLimit: number | null;
  isActive: boolean;
}

export async function listSubscriptionPlans(): Promise<
  ApiResult<SubscriptionPlanDto[]>
> {
  return get<SubscriptionPlanDto[]>("/api/subscription-plans");
}

/* ============================================================
 * Payments — PayOS checkout
 * ----------------------------------------------------------
 * Luồng chuẩn (theo spec BE):
 *
 *   Trang bảng giá ──▶ bấm "Mua" ──▶ POST /api/payments/checkout
 *        ▲                                  │ trả checkoutUrl
 *        │                                  ▼
 *   refetch /api/me  ◀─ trang kết quả ◀─ PayOS (khách quét QR, trả tiền)
 *                            ▲                │
 *                            │   PayOS redirect về ReturnUrl / CancelUrl
 *                            └── POST /api/payments/{id}/sync
 *
 * ⚠️ Nguyên tắc quan trọng: FE KHÔNG tự kết luận "đã trả tiền" dựa
 * vào URL PayOS chuyển về. Backend mới là nơi xác nhận. FE chỉ gọi
 * `sync` rồi đọc `status`.
 *
 * Endpoints:
 *   POST /api/payments/checkout          → tạo link thanh toán
 *   POST /api/payments/{id}/sync          → xác nhận lại với server
 *   POST /api/payments/{id}/cancel        → hủy đơn Pending
 *   GET  /api/payment-transactions        → lịch sử giao dịch của user
 *   GET  /api/invoices                    → hóa đơn của user
 *   GET  /api/invoices/{invoiceId}        → chi tiết 1 hóa đơn
 *   GET  /api/user-subscriptions          → các gói (kể cả Scheduled)
 *
 * Việc FE KHÔNG làm:
 *   - Không gọi /api/payos/webhook (PayOS gọi vào backend).
 *   - Không gọi confirm-webhook (việc của Admin).
 *   - Không tự tính hạn gói hay tự cấp quyền — luôn đọc lại /api/me.
 * ============================================================ */

/**
 * Trạng thái giao dịch theo spec BE.
 *
 * BE trả `status` kiểu string tự do (nullable), nên ta dùng union lỏng
 * để vẫn có autocomplete mà không ép chặt (BE có thể thêm trạng thái mới).
 */
export type PaymentStatus =
  | "Pending"
  | "Succeeded"
  | "Cancelled"
  | "Expired"
  | "Failed"
  | (string & {});

/** Response của `POST /api/payments/checkout` (CheckoutResultDto). */
export interface PaymentCheckoutDto {
  /** Id giao dịch — lưu lại để dùng cho bước sync/cancel. */
  paymentId: string;
  /** Mã đơn hàng (PayOS orderCode). */
  orderCode: number;
  /** Trạng thái ban đầu (thường là "Pending"). */
  status: string | null;
  /** URL trang thanh toán PayOS (hosted page có QR + CK + form thẻ). */
  checkoutUrl: string | null;
  /** Chuỗi QR code (URL hoặc base64) do PayOS trả về. */
  qrCode: string | null;
  /** Hạn dùng của link (ISO timestamp, ~15 phút). */
  expiresAt: string;
  /** true = backend tái sử dụng link còn sống thay vì tạo mới. */
  reused: boolean;
}

/** Response của `POST /api/payments/{id}/sync` (PaymentTransactionDto). */
export interface PaymentTransactionDto {
  id: string;
  userId: string;
  planId: string;
  orderCode: number;
  /** Cổng thanh toán (luôn là "PayOS" ở flow hiện tại). */
  gateway: string | null;
  /** Số tiền (VND). */
  amount: number;
  /** "Pending" | "Succeeded" | "Cancelled" | "Expired" | "Failed". */
  status: string | null;
  createdAt: string;
  expiresAt: string | null;
  paidAt: string | null;
  webhookReceivedAt: string | null;
}

/** Hoá đơn của user (GET /api/invoices — InvoiceDto). */
export interface InvoiceDto {
  id: string;
  paymentTransactionId: string;
  /** Mã hoá đơn dạng "MTN-2026-000001". */
  invoiceNumber: string | null;
  planName: string | null;
  amount: number;
  billingName: string | null;
  billingEmail: string | null;
  /** Ngày bắt đầu kỳ (YYYY-MM-DD). */
  periodStart: string;
  /** Ngày kết thúc kỳ (YYYY-MM-DD). */
  periodEnd: string;
  issuedAt: string;
}

/** Gói thuê bao của user (GET /api/user-subscriptions — UserSubscriptionDto). */
export interface UserSubscriptionDto {
  id: string;
  userId: string;
  planId: string;
  paymentTransactionId: string | null;
  startAt: string;
  /** null = gói Miễn phí không hết hạn. */
  endAt: string | null;
  /** "Active" (đang chạy) | "Scheduled" (xếp hàng) | ... */
  status: string | null;
  aiCallsUsed: number;
  quotaResetAt: string;
  createdAt: string;
}

/* ============================================================
 * Checkout / Sync / Cancel
 * ============================================================ */

/**
 * POST /api/payments/checkout
 *
 * Tạo link thanh toán PayOS cho 1 gói. Body chỉ cần `planId`.
 *
 * Lưu ý hành vi BE:
 *  - Bấm mua nhiều lần → BE tái sử dụng link còn sống (`reused = true`),
 *    FE cứ dùng `checkoutUrl` trả về.
 *  - Nếu đơn đã trả xong → `status` có thể là "Succeeded" và không có
 *    link → FE phải kiểm tra `status` trước khi redirect.
 *  - 503 = PayOS không kết nối được → hiện "Thử lại sau ít phút".
 */
export async function createPaymentCheckout(
  planId: string,
): Promise<ApiResult<PaymentCheckoutDto>> {
  if (!planId) {
    return { ok: false, error: "planId is required", status: 400 };
  }
  return post<PaymentCheckoutDto>("/api/payments/checkout", { planId });
}

/**
 * POST /api/payments/{paymentId}/sync
 *
 * Kéo trạng thái mới nhất từ server. An toàn khi gọi nhiều lần.
 *
 * ⚠️ 503 nghĩa là PayOS tạm lỗi → giữ màn hình "Đang xử lý" và thử lại,
 * KHÔNG báo thất bại.
 */
export async function syncPayment(
  paymentId: string,
): Promise<ApiResult<PaymentTransactionDto>> {
  if (!paymentId) {
    return { ok: false, error: "paymentId is required", status: 400 };
  }
  return post<PaymentTransactionDto>(
    `/api/payments/${encodeURIComponent(paymentId)}/sync`,
  );
}

/**
 * POST /api/payments/{paymentId}/cancel
 *
 * Chỉ hủy được đơn Pending. Đơn đã Succeeded trả lỗi 400.
 * Gọi lại với đơn đã kết thúc không gây lỗi (BE tự xử lý idempotent).
 */
export async function cancelPayment(
  paymentId: string,
): Promise<ApiResult<PaymentTransactionDto>> {
  if (!paymentId) {
    return { ok: false, error: "paymentId is required", status: 400 };
  }
  return post<PaymentTransactionDto>(
    `/api/payments/${encodeURIComponent(paymentId)}/cancel`,
  );
}

/* ============================================================
 * Lịch sử + hoá đơn + gói đang chờ
 * ============================================================ */

/** GET /api/payment-transactions — người dùng chỉ thấy giao dịch của mình. */
export async function listPaymentTransactions(): Promise<
  ApiResult<PaymentTransactionDto[]>
> {
  return get<PaymentTransactionDto[]>("/api/payment-transactions");
}

/** GET /api/invoices — danh sách hoá đơn của chính người dùng. */
export async function listInvoices(): Promise<ApiResult<InvoiceDto[]>> {
  return get<InvoiceDto[]>("/api/invoices");
}

/** GET /api/invoices/{invoiceId} — chi tiết 1 hoá đơn. */
export async function getInvoice(
  invoiceId: string,
): Promise<ApiResult<InvoiceDto>> {
  return get<InvoiceDto>(`/api/invoices/${encodeURIComponent(invoiceId)}`);
}

/**
 * GET /api/user-subscriptions
 *
 * Dùng để hiện gói "đang chờ" (status = "Scheduled") khi user mua gói
 * mới trong khi gói cũ còn hạn — gói mới sẽ chạy sau khi gói cũ hết hạn.
 */
export async function listUserSubscriptions(): Promise<
  ApiResult<UserSubscriptionDto[]>
> {
  return get<UserSubscriptionDto[]>("/api/user-subscriptions");
}

/**
 * Helpers (FE-only) — dùng cho admin UI / dashboard.
 * ----------------------------------------------------------------
 */

/* ============================================================
 * FOCUS SESSION — bấm giờ làm việc (Start / Stop)
 * ----------------------------------------------------------
 * Theo spec BE (FOCUS_SESSION_FE.md) + swagger live:
 *
 *   POST /api/focus/start                  → bắt đầu phiên (201)
 *   GET  /api/focus/current                → phiên đang chạy (200) | 204
 *   POST /api/focus/{sessionId}/stop       → dừng phiên
 *   GET  /api/focus/pending-confirmation   → phiên bị hệ thống tự ngắt
 *   POST /api/focus/{sessionId}/confirm    → xác nhận / sửa / loại bỏ
 *   POST /api/focus/self-report            → khai báo giờ làm việc
 *   GET  /api/focus/{slotId}/time-summary  → tổng kết 1 slot
 *
 * (Đường cũ `/api/FocusSession/...` vẫn chạy, nhưng ta dùng đường mới.)
 *
 * ⚠️ Nguyên tắc quan trọng:
 *  - Đồng hồ lấy từ SERVER (`elapsedSeconds`), KHÔNG tính bằng
 *    `Date.now() - startedAt` vì user có thể đổi giờ máy.
 *  - FE không tự gửi giờ ở bất kỳ API nào, trừ `self-report`.
 *  - 409 khi start = đã có phiên đang chạy → KHÔNG báo lỗi đỏ, mà
 *    chuyển sang hiển thị phiên đó (trường hợp mở 2 tab).
 * ============================================================ */

/** Cách ghi nhận thời gian của 1 phiên. */
export type CaptureMethod = "Timer" | "SelfReported" | "AutoTimeout";

/** Lý do dừng phiên. */
export type FocusStopReason =
  | "Completed"
  | "Interrupted"
  | "Blocked"
  | "Other";

/**
 * Trạng thái của 1 schedule slot (mở rộng so với bản cũ của FE).
 *
 * BE hiện trả `status` kiểu string tự do nên ta dùng union lỏng
 * (`| (string & {})`) để vẫn autocomplete mà không ép chặt.
 */
export type FocusSlotStatus =
  | "Proposed"
  | "Approved"
  | "Due"
  | "InProgress"
  | "Overrun"
  | "Done"
  | "Missed"
  | "Skipped"
  | "Cancelled"
  | "Postponed"
  | (string & {});

/** Body của `POST /api/focus/start`. */
export interface FocusStartRequest {
  /** Bắt buộc. */
  taskId: string;
  /**
   * null = làm việc ngoài lịch.
   *
   * Theo spec mục 5.1, khi làm ngoài lịch thì `plannedMinutes = 0` và
   * `expectedEndAt = startedAt`. Ta vẫn gửi `null` (BE chấp nhận null) —
   * nhưng **không** gửi `subTaskId` khi không có (xem `buildFocusStartBody`).
   */
  scheduleSlotId?: string | null;
  /**
   * Subtask của phiên — **phải lấy từ slot** (spec mục 6.1).
   *
   * Backend KHÔNG tự suy ra `subTaskId` từ slot: nếu slot gắn subtask mà
   * ta không gửi `subTaskId`, phiên sẽ **không** có nhãn subtask.
   */
  subTaskId?: string | null;
}

/** Response 201 của `POST /api/focus/start`. */
export interface FocusStartResponse {
  sessionId: string;
  startedAt: string;
  captureMethod: CaptureMethod;
  /** 0 = làm việc ngoài lịch (không gắn slot). */
  plannedMinutes: number;
  expectedEndAt: string;
  /** Số phút bắt đầu sớm hơn slot (0 = đúng giờ). */
  startedEarlyMinutes: number;
  /**
   * "STARTED_VERY_EARLY" = bắt đầu sớm hơn 2 giờ so với giờ slot.
   * Phiên ĐÃ được tạo — FE cần hỏi lại user rồi mới quyết định giữ hay Stop.
   */
  warning: string | null;
}

/** Response 200 của `GET /api/focus/current`. */
export interface FocusCurrentResponse {
  sessionId: string;
  taskId: string;
  taskTitle: string | null;
  scheduleSlotId: string | null;
  startedAt: string;
  /** Giây đã làm — do SERVER tính, đây là nguồn sự thật cho đồng hồ. */
  elapsedSeconds: number;
  /** Giờ của server tại lúc response (để FE đồng bộ lệch). */
  serverTime: string;
  isOverrun: boolean;
}

/** Body của `POST /api/focus/{sessionId}/stop`. */
export interface FocusStopRequest {
  stopReason: FocusStopReason;
  note?: string | null;
}

/** Response của `POST /api/focus/{sessionId}/stop`. */
export interface FocusStopResponse {
  sessionId: string;
  endedAt: string;
  /** Phút của phiên vừa dừng. */
  sessionMinutes: number;
  /** Tổng phút của mọi phiên thuộc task đó. */
  taskTotalMinutes: number;
  /**
   * true (với Completed/Other) → nên hỏi "bạn thấy thế nào / xong chưa?".
   * false (Interrupted/Blocked) → user sẽ quay lại, không cần hỏi.
   */
  checkInRequired: boolean;
}

/** 1 phần tử của `GET /api/focus/pending-confirmation`. */
export interface FocusPendingConfirmationItem {
  sessionId: string;
  taskId: string;
  taskTitle: string | null;
  scheduleSlotId: string | null;
  startedAt: string;
  endedAt: string;
  /** Số phút hệ thống tự tính — mặc định điền vào ô nhập. */
  systemMinutes: number;
}

/**
 * Trạng thái vòng đời của 1 phiên làm việc.
 *
 * Theo spec `FOCUS_START_STOP_REWORK_FE.md` mục 6:
 *   - `Running`           → đang chạy
 *   - `Stopped`           → dừng thường (Timer) hoặc tự khai (SelfReported)
 *   - `PendingConfirmation`→ hệ thống tự ngắt, chờ người dùng xác nhận
 *   - `Confirmed`         → tự ngắt đã được xác nhận
 *   - `Discarded`         → tự ngắt bị loại bỏ (không tính)
 */
export type FocusSessionState =
  | "Running"
  | "Stopped"
  | "PendingConfirmation"
  | "Confirmed"
  | "Discarded"
  | (string & {});

/**
 * 1 phiên trong `GET /api/focus/task/{taskId}/sessions`.
 *
 * ⚠️ `GET /api/focus/current` **KHÔNG** trả `subTaskId` (spec mục 5) →
 * sau khi reload trang, muốn biết phiên đang chạy thuộc subtask nào thì
 * lấy phiên có `state = "Running"` ở API này.
 */
export interface FocusTaskSessionDto {
  sessionId: string;
  taskId: string;
  /** Subtask của phiên (null nếu phiên task-only). */
  subTaskId: string | null;
  scheduleSlotId: string | null;
  state: FocusSessionState;
  captureMethod: CaptureMethod;
  startedAt: string;
  endedAt: string | null;
  /** Phút thực tế (null nếu phiên chưa kết thúc hoặc bị loại bỏ). */
  minutes: number | null;
  stopReason: FocusStopReason | null;
  note: string | null;
}

/**
 * GET /api/focus/task/{taskId}/sessions — mọi phiên của 1 task.
 *
 * Dùng để: (1) biết phiên `Running` thuộc subtask nào sau khi reload trang,
 * (2) hiển thị lịch sử phiên theo task.
 */
export async function listTaskFocusSessions(
  taskId: string,
): Promise<ApiResult<FocusTaskSessionDto[]>> {
  if (!taskId) {
    return { ok: false, error: "taskId is required", status: 400 };
  }
  return get<FocusTaskSessionDto[]>(
    `/api/focus/task/${encodeURIComponent(taskId)}/sessions`,
  );
}

/** Body của `POST /api/focus/{sessionId}/confirm`. */
export interface FocusConfirmRequest {
  confirmed: boolean;
  /** Sửa lại số phút (1..1440). null = giữ nguyên systemMinutes. */
  correctedMinutes?: number | null;
}

/** Body của `POST /api/focus/self-report` — chỗ DUY NHẤT FE gửi giờ. */
export interface FocusSelfReportRequest {
  taskId: string;
  scheduleSlotId?: string | null;
  startedAt: string;
  endedAt: string;
  stopReason: FocusStopReason;
  note?: string | null;
}

/** 1 phiên trong `GET /api/focus/{slotId}/time-summary`. */
export interface FocusSessionSummaryItem {
  sessionId: string;
  startedAt: string;
  endedAt: string | null;
  minutes: number;
  captureMethod: CaptureMethod;
  stopReason: FocusStopReason;
  /**
   * Trạng thái phiên (spec mục 6): `Running`, `Stopped`,
   * `PendingConfirmation`, `Confirmed`, `Discarded`.
   *
   * BE có thể chưa trả field này ở time-summary → optional.
   */
  state?: FocusSessionState;
}

/** Response của `GET /api/focus/{slotId}/time-summary`. */
export interface FocusTimeSummaryResponse {
  plannedMinutes: number;
  /** Chỉ cộng các phiên đáng tin (không tính phiên AutoTimeout chưa xác nhận). */
  actualMinutes: number;
  sessionCount: number;
  sessions: FocusSessionSummaryItem[] | null;
}

/**
 * POST /api/focus/start — bắt đầu phiên làm việc.
 *
 * Xử lý 409 đặc biệt: `details` trong body lỗi chính là phiên đang chạy
 * (cùng shape với `GET /current`). FE cần bắt được case này để chuyển sang
 * màn hình phiên đang chạy thay vì báo lỗi.
 */
export async function startFocusSession(
  body: FocusStartRequest,
): Promise<ApiResult<FocusStartResponse>> {
  if (!body.taskId) {
    return { ok: false, error: "taskId is required", status: 400 };
  }
  return post<FocusStartResponse>("/api/focus/start", {
    taskId: body.taskId,
    scheduleSlotId: body.scheduleSlotId ?? null,
    subTaskId: body.subTaskId ?? null,
  });
}

/**
 * GET /api/focus/current — phiên đang chạy.
 *
 * 204 = không có phiên nào → `ApiResult` vẫn là `ok: true` với `data`
 * = null, để phân biệt với lỗi mạng.
 */
export async function getCurrentFocusSession(): Promise<
  ApiResult<FocusCurrentResponse | null>
> {
  const res = await apiFetch<FocusCurrentResponse | null>(
    "/api/focus/current",
    { method: "GET" },
  );
  if (!res.ok) return res;
  return { ok: true, data: res.data ?? null };
}

/** POST /api/focus/{sessionId}/stop — dừng phiên. */
export async function stopFocusSession(
  sessionId: string,
  body: FocusStopRequest,
): Promise<ApiResult<FocusStopResponse>> {
  if (!sessionId) {
    return { ok: false, error: "sessionId is required", status: 400 };
  }
  return post<FocusStopResponse>(
    `/api/focus/${encodeURIComponent(sessionId)}/stop`,
    { stopReason: body.stopReason, note: body.note ?? null },
  );
}

/**
 * GET /api/focus/pending-confirmation — các phiên bị hệ thống tự ngắt
 * (quá 2x thời lượng dự kiến) và chưa được xác nhận.
 */
export async function listPendingFocusConfirmations(): Promise<
  ApiResult<FocusPendingConfirmationItem[]>
> {
  const res = await apiFetch<FocusPendingConfirmationItem[] | null>(
    "/api/focus/pending-confirmation",
    { method: "GET" },
  );
  if (!res.ok) return res;
  return { ok: true, data: res.data ?? [] };
}

/** POST /api/focus/{sessionId}/confirm — xác nhận / sửa / loại bỏ phiên. */
export async function confirmFocusSession(
  sessionId: string,
  body: FocusConfirmRequest,
): Promise<ApiResult<{ message?: string }>> {
  if (!sessionId) {
    return { ok: false, error: "sessionId is required", status: 400 };
  }
  return post<{ message?: string }>(
    `/api/focus/${encodeURIComponent(sessionId)}/confirm`,
    {
      confirmed: body.confirmed,
      correctedMinutes: body.correctedMinutes ?? null,
    },
  );
}

/**
 * POST /api/focus/self-report — khai báo thời gian đã làm việc.
 *
 * ⚠️ Đây là API DUY NHẤT FE được gửi giờ. `startedAt`/`endedAt` phải là
 * quá khứ, `endedAt > startedAt`, và dài tối đa 24 giờ.
 */
export async function selfReportFocusSession(
  body: FocusSelfReportRequest,
): Promise<ApiResult<{ sessionId?: string }>> {
  if (!body.taskId) {
    return { ok: false, error: "taskId is required", status: 400 };
  }
  return post<{ sessionId?: string }>("/api/focus/self-report", {
    taskId: body.taskId,
    scheduleSlotId: body.scheduleSlotId ?? null,
    startedAt: body.startedAt,
    endedAt: body.endedAt,
    stopReason: body.stopReason,
    note: body.note ?? null,
  });
}

/** GET /api/focus/{slotId}/time-summary — tổng kết thời gian của 1 slot. */
export async function getFocusTimeSummary(
  slotId: string,
): Promise<ApiResult<FocusTimeSummaryResponse>> {
  if (!slotId) {
    return { ok: false, error: "slotId is required", status: 400 };
  }
  return get<FocusTimeSummaryResponse>(
    `/api/focus/${encodeURIComponent(slotId)}/time-summary`,
  );
}

/* ============================================================
 * NOTIFICATIONS — hộp thư + Web Push + SignalR
 * ----------------------------------------------------------
 *   GET  /api/notifications?unreadOnly&take  → danh sách (mới nhất trước)
 *   POST /api/notifications/{id}/read         → đánh dấu đã đọc (204)
 *   POST /api/notifications/read-all          → đánh dấu hết ({ updated })
 *   GET  /api/notifications/vapid-public-key  → { publicKey } cho Web Push
 *   POST /api/notifications/subscribe         → lưu subscription của thiết bị
 *   POST /api/notifications/unsubscribe       → gỡ subscription
 *
 * ⚠️ `type` trong hộp thư chỉ là nhóm lớn ("SlotReminder" | "MissedSlot").
 * Loại chi tiết (`actionType`) chỉ có ở SignalR và Web Push — nên muốn biết
 * chính xác loại gì thì dựa vào `title` + `scheduleSlotId` + trạng thái slot.
 * ============================================================ */

/** Loại thông báo (nhóm lớn — BE giới hạn ở 2 giá trị này). */
/**
 * Loại thông báo.
 *
 * - Nhánh cá nhân: `SlotReminder` | `MissedSlot`.
 * - Nhóm: `GroupInvited` | `GroupAssigned` | `GroupStatusChanged` |
 *   `GroupMention` | `GroupChangeRequested` | `GroupChangeDecided`.
 */
export type NotificationType =
  | "SlotReminder"
  | "MissedSlot"
  | "GroupInvited"
  | "GroupAssigned"
  | "GroupStatusChanged"
  | "GroupMention"
  | "GroupChangeRequested"
  | "GroupChangeDecided"
  | (string & {});


/**
 * Loại hành động chi tiết — chỉ xuất hiện qua SignalR / Web Push.
 */
export type NotificationActionType =
  | "PRE_START_REMINDER"
  | "START_PROMPT"
  | "NOT_STARTED"
  | "NEAR_END"
  | "OVERRUN"
  | "AUTO_TIMEOUT"
  | "CHECK_IN"
  | "MISSED_SLOT"
  | (string & {});

/** 1 thông báo trong hộp thư. */
export interface NotificationDto {
  id: string;
  type: NotificationType | null;
  title: string | null;
  message: string | null;
  scheduleSlotId: string | null;
  /**
   * Thông báo nhóm: id nhóm liên quan (rỗng với thông báo thường).
   * Bấm vào thông báo nhóm sẽ mở thẳng nhóm / việc của nhóm.
   */
  groupId?: string | null;
  /** Thông báo nhóm: id việc của nhóm (với việc con là việc CHA của nó). */
  groupTaskId?: string | null;
  sentAt: string | null;
  isRead: boolean;
  readAt: string | null;
}

/** GET /api/notifications — danh sách thông báo (mới nhất trước, tối đa 100). */
export async function listNotifications(params?: {
  unreadOnly?: boolean;
  take?: number;
}): Promise<ApiResult<NotificationDto[]>> {
  const qs = new URLSearchParams();
  qs.set("unreadOnly", String(params?.unreadOnly ?? false));
  qs.set("take", String(params?.take ?? 50));
  return get<NotificationDto[]>(`/api/notifications?${qs.toString()}`);
}

/** POST /api/notifications/{notificationId}/read — đánh dấu 1 thông báo đã đọc. */
export async function markNotificationRead(
  notificationId: string,
): Promise<ApiResult<void>> {
  if (!notificationId) {
    return { ok: false, error: "notificationId is required", status: 400 };
  }
  return post<void>(
    `/api/notifications/${encodeURIComponent(notificationId)}/read`,
  );
}

/** POST /api/notifications/read-all — đánh dấu toàn bộ đã đọc. */
export async function markAllNotificationsRead(): Promise<
  ApiResult<{ updated: number }>
> {
  return post<{ updated: number }>("/api/notifications/read-all");
}

/** GET /api/notifications/vapid-public-key — khoá công khai cho Web Push. */
export async function getVapidPublicKey(): Promise<
  ApiResult<{ publicKey: string }>
> {
  const res = await apiFetch<{ publicKey?: string } | null>(
    "/api/notifications/vapid-public-key",
    { method: "GET" },
  );
  if (!res.ok) return res;
  return { ok: true, data: { publicKey: res.data?.publicKey ?? "" } };
}

/** Body đăng ký / gỡ Web Push subscription. */
export interface PushSubscriptionDto {
  endpoint: string;
  keys: {
    p256dh: string;
    auth: string;
  };
}

/** POST /api/notifications/subscribe — lưu subscription của thiết bị này. */
export async function subscribePushNotifications(
  sub: PushSubscriptionDto,
): Promise<ApiResult<void>> {
  return post<void>("/api/notifications/subscribe", {
    endpoint: sub.endpoint,
    keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth },
  });
}

/** POST /api/notifications/unsubscribe — gỡ subscription của thiết bị này. */
export async function unsubscribePushNotifications(
  sub: PushSubscriptionDto,
): Promise<ApiResult<void>> {
  return post<void>("/api/notifications/unsubscribe", {
    endpoint: sub.endpoint,
    keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth },
  });
}

/* ================================================================
 * PROJECT DOCUMENTS — kho tài liệu của dự án
 * ----------------------------------------------------------
 * Nguồn: spec `PROJECT_DOCUMENTS_FE (1).md` (BE gửi) + swagger-live.
 *
 *   GET    /api/projects/{projectId}/documents        → tài liệu của 1 dự án
 *   GET    /api/documents/by-project/{projectId}     → giống API trên
 *   GET    /api/documents                            → tài liệu của tôi (mọi dự án)
 *   GET    /api/documents/by-user/{userId}           → của 1 người (Admin xem người khác)
 *   GET    /api/documents/all                        → toàn hệ thống, có phân trang
 *   POST   /api/projects/{projectId}/documents/files  → tải file lên (multipart)
 *   POST   /api/projects/{projectId}/documents/links  → thêm liên kết
 *   GET    /api/documents/{documentId}               → chi tiết 1 tài liệu
 *   PUT    /api/documents/{documentId}               → sửa name / tag / linkUrl
 *   DELETE /api/documents/{documentId}               → xoá
 *   GET    /api/documents/{documentId}/download       → tải file về (chỉ loại File)
 *
 * ⚠️ Lưu ý quan trọng khi tải về: API cần header `Authorization` nên
 * **không** dùng thẻ `<a href>` trực tiếp (trình duyệt không gửi được
 * header) — phải fetch → blob → objectURL → click. Xem `downloadProjectDocument`.
 * ================================================================ */

/** Nhãn phân loại tài liệu. BE trả 400 nếu gửi giá trị ngoài danh sách này. */
export type DocumentTag = "Brief" | "Contract" | "Design" | "Other";

/** Loại tài liệu: `File` (tải lên, có file để tải về) | `Link` (mở `linkUrl`). */
export type DocumentSourceType = "File" | "Link";

/** 1 tài liệu trong kho của dự án. */
export interface ProjectDocumentDto {
  id: string;
  projectId: string;
  /** Tên hiển thị — đồng thời là tên file khi tải về. */
  name: string | null;
  sourceType: DocumentSourceType | null;
  /** Chỉ có với loại `Link`. */
  linkUrl: string | null;
  /** Chỉ có với loại `File`. */
  sizeBytes: number | null;
  tag: DocumentTag | null;
  uploadedAt: string;
}

/** Tài liệu trong danh sách gom nhiều dự án — có thêm tên dự án + chủ dự án. */
export interface ProjectDocumentListItemDto extends ProjectDocumentDto {
  projectName: string | null;
  userId: string;
}

/** Thân trả về của `GET /api/documents/all` (API duy nhất có phân trang). */
export interface PagedResult<T> {
  items: T[];
  page: number;
  pageSize: number;
  totalCount: number;
}

/** Body gửi lên khi tạo / sửa tài liệu. */
export interface ProjectDocumentRequest {
  name?: string | null;
  tag?: DocumentTag | null;
  /** Chỉ dùng cho loại `Link`. Gửi `linkUrl` cho tài liệu `File` → BE trả 400. */
  linkUrl?: string | null;
}

/** Bộ lọc chung cho các API danh sách. */
export interface DocumentListFilters {
  search?: string;
  tag?: DocumentTag;
  sourceType?: DocumentSourceType;
  projectId?: string;
}

/**
 * Giới hạn kích thước 1 file — BE chặn ở 20 MB (và 413 nếu request > ~21 MB).
 * FE nên chặn sớm để khỏi tốn băng thông.
 */
export const MAX_DOCUMENT_FILE_BYTES = 20 * 1024 * 1024;

/** Dựng query string từ bộ lọc (bỏ qua giá trị rỗng). */
function documentQuery(filters: DocumentListFilters = {}): string {
  const sp = new URLSearchParams();
  if (filters.search?.trim()) sp.set("search", filters.search.trim());
  if (filters.tag) sp.set("tag", filters.tag);
  if (filters.sourceType) sp.set("sourceType", filters.sourceType);
  if (filters.projectId?.trim()) sp.set("projectId", filters.projectId.trim());
  const qs = sp.toString();
  return qs ? `?${qs}` : "";
}

/** GET /api/projects/{projectId}/documents — tài liệu của 1 dự án. */
export async function listProjectDocuments(
  projectId: string,
  filters: Omit<DocumentListFilters, "projectId"> = {},
): Promise<ApiResult<ProjectDocumentDto[]>> {
  if (!projectId) {
    return { ok: false, error: "projectId is required", status: 400 };
  }
  return get<ProjectDocumentDto[]>(
    `/api/projects/${encodeURIComponent(projectId)}/documents${documentQuery(filters)}`,
  );
}

/** GET /api/documents — tài liệu của tôi qua mọi dự án. */
export async function listMyDocuments(
  filters: DocumentListFilters = {},
): Promise<ApiResult<ProjectDocumentListItemDto[]>> {
  return get<ProjectDocumentListItemDto[]>(
    `/api/documents${documentQuery(filters)}`,
  );
}

/** GET /api/documents/by-user/{userId} — tài liệu của 1 người (Admin). */
export async function listUserDocuments(
  userId: string,
  filters: Omit<DocumentListFilters, "projectId"> = {},
): Promise<ApiResult<ProjectDocumentListItemDto[]>> {
  if (!userId) {
    return { ok: false, error: "userId is required", status: 400 };
  }
  return get<ProjectDocumentListItemDto[]>(
    `/api/documents/by-user/${encodeURIComponent(userId)}${documentQuery(filters)}`,
  );
}

/** GET /api/documents/all — toàn hệ thống, có phân trang (chỉ Admin). */
export async function listAllDocuments(params: {
  page?: number;
  pageSize?: number;
  search?: string;
  tag?: DocumentTag;
  sourceType?: DocumentSourceType;
  projectId?: string;
  userId?: string;
} = {}): Promise<ApiResult<PagedResult<ProjectDocumentListItemDto>>> {
  const sp = new URLSearchParams();
  const page = params.page ?? 1;
  const pageSize = params.pageSize ?? 20;
  sp.set("page", String(Math.max(1, page)));
  sp.set("pageSize", String(Math.min(100, Math.max(1, pageSize))));
  if (params.search?.trim()) sp.set("search", params.search.trim());
  if (params.tag) sp.set("tag", params.tag);
  if (params.sourceType) sp.set("sourceType", params.sourceType);
  if (params.projectId?.trim()) sp.set("projectId", params.projectId.trim());
  if (params.userId?.trim()) sp.set("userId", params.userId.trim());
  return get<PagedResult<ProjectDocumentListItemDto>>(
    `/api/documents/all?${sp.toString()}`,
  );
}

/** GET /api/documents/{documentId} — chi tiết 1 tài liệu. */
export async function getProjectDocument(
  documentId: string,
): Promise<ApiResult<ProjectDocumentDto>> {
  if (!documentId) {
    return { ok: false, error: "documentId is required", status: 400 };
  }
  return get<ProjectDocumentDto>(
    `/api/documents/${encodeURIComponent(documentId)}`,
  );
}

/**
 * POST /api/projects/{projectId}/documents/files — tải file lên.
 *
 * ⚠️ `multipart/form-data`: tên field phải viết hoa đúng (`File`, `Name`, `Tag`)
 * và **không** tự đặt `Content-Type` (trình duyệt tự thêm `boundary`).
 */
export async function uploadProjectDocument(
  projectId: string,
  file: File,
  opts: { name?: string; tag?: DocumentTag } = {},
): Promise<ApiResult<ProjectDocumentDto>> {
  if (!projectId) {
    return { ok: false, error: "projectId is required", status: 400 };
  }
  if (file.size > MAX_DOCUMENT_FILE_BYTES) {
    return {
      ok: false,
      error: "File vượt quá giới hạn 20 MB. Vui lòng chọn file nhỏ hơn.",
      status: 400,
    };
  }
  const form = new FormData();
  form.append("File", file);
  if (opts.name?.trim()) form.append("Name", opts.name.trim());
  if (opts.tag) form.append("Tag", opts.tag);

  return apiFetch<ProjectDocumentDto>(
    `/api/projects/${encodeURIComponent(projectId)}/documents/files`,
    { method: "POST", body: form },
  );
}

/** POST /api/projects/{projectId}/documents/links — thêm liên kết. */
export async function createProjectDocumentLink(
  projectId: string,
  body: ProjectDocumentRequest,
): Promise<ApiResult<ProjectDocumentDto>> {
  if (!projectId) {
    return { ok: false, error: "projectId is required", status: 400 };
  }
  return post<ProjectDocumentDto>(
    `/api/projects/${encodeURIComponent(projectId)}/documents/links`,
    {
      name: body.name ?? null,
      tag: body.tag ?? "Other",
      linkUrl: body.linkUrl ?? null,
    },
  );
}

/**
 * PUT /api/documents/{documentId} — sửa.
 *
 * ⚠️ API này là **partial update** (khác `PUT` thay thế toàn bộ ở các API
 * khác): chỉ trường nào gửi lên mới được đổi, bỏ trường = giữ nguyên.
 */
export async function updateProjectDocument(
  documentId: string,
  body: ProjectDocumentRequest,
): Promise<ApiResult<ProjectDocumentDto>> {
  if (!documentId) {
    return { ok: false, error: "documentId is required", status: 400 };
  }
  return put<ProjectDocumentDto>(
    `/api/documents/${encodeURIComponent(documentId)}`,
    body,
  );
}

/** DELETE /api/documents/{documentId} — xoá tài liệu (kèm file nếu có). */
export async function deleteProjectDocument(
  documentId: string,
): Promise<ApiResult<void>> {
  if (!documentId) {
    return { ok: false, error: "documentId is required", status: 400 };
  }
  return del<void>(`/api/documents/${encodeURIComponent(documentId)}`);
}

/**
 * Tải file của 1 tài liệu về máy.
 *
 * API cần header `Authorization` → không dùng được thẻ `<a href>` trực tiếp.
 * Cách này: fetch → blob → objectURL → click thẻ `<a download>` → revoke.
 *
 * @param downloadName Tên file khi tải về. Mặc định lấy `name` của tài liệu.
 */
export async function downloadProjectDocument(
  documentId: string,
  downloadName?: string,
): Promise<ApiResult<void>> {
  if (!documentId) {
    return { ok: false, error: "documentId is required", status: 400 };
  }

  const url = `${BASE_URL}/api/documents/${encodeURIComponent(documentId)}/download`;
  const token = getAccessToken();

  let res: Response;
  try {
    res = await fetch(url, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
  } catch (err) {
    const raw = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      error: `Không kết nối được máy chủ. Vui lòng kiểm tra mạng và thử lại. (${raw})`,
    };
  }

  if (!res.ok) {
    // 404 = dòng tài liệu còn nhưng file đã mất ở server → cần tải lại.
    if (res.status === 404) {
      return {
        ok: false,
        status: 404,
        error: "File không còn trong kho lưu trữ. Hãy tải file lên lại.",
      };
    }
    let msg = friendlyStatusMessage(res.status);
    try {
      const body = await res.json();
      msg = extractMessage(body) ?? msg;
    } catch {
      // Body không phải JSON → giữ msg mặc định.
    }
    return { ok: false, status: res.status, error: msg };
  }

  const blob = await res.blob();
  const objectUrl = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = objectUrl;
  a.download = downloadName || "document";
  document.body.append(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(objectUrl);

  return { ok: true, data: undefined };
}

