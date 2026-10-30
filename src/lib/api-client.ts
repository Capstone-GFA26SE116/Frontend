/**
 * Lớp gọi API cho METANOIA FE.
 *
 * Quy ước:
 * - Base URL đọc từ VITE_API_URL (.env).
 * - Mọi request tự động gắn Authorization: Bearer <token> nếu có session.
 * - Refresh token được xử lý tự động khi access token hết hạn.
 * - Chuẩn response: `{ ok: true, data: T }` hoặc `{ ok: false, error: string }`.
 */

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

/** Chuỗi thông báo lỗi thân thiện cho từng mã HTTP của AI service. */
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
    default:
      return `Lỗi máy chủ (HTTP ${status}). Vui lòng thử lại sau.`;
  }
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
  const url = `${BASE_URL}${path}`;
  const token = getAccessToken();

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
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
          const data = await readJson(res);
          return { ok: true, data: data as T };
        }
      }
      // Refresh thất bại hoặc không có refresh token → logout
      clearTokens();
      window.location.href = "/login";
      return { ok: false, error: "session_expired", status: 401 };
    }

    if (!res.ok) {
      let msg = friendlyStatusMessage(res.status);
      let details: unknown;
      try {
        const body = await res.json();
        msg = extractMessage(body) ?? msg;
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
      return details !== undefined
        ? { ok: false, error: msg, status: res.status, details }
        : { ok: false, error: msg, status: res.status };
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
    description: sub.description ?? "",
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
  taskId: string;
  subTaskId: string | null;
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
  taskId: string | null;
  subTaskId: string | null;
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

export interface GoogleCalendarSyncResultDto {
  added: number;
  updated: number;
  cancelled: number;
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
 * Đồng bộ 2 chiều giữa schedule slot của METANOIA và Google Calendar.
 */
export async function syncGoogleCalendar(): Promise<
  ApiResult<GoogleCalendarSyncResultDto>
> {
  return post<GoogleCalendarSyncResultDto>("/api/google-calendar/sync", {});
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

  // [DEBUG] log outgoing request
  console.log("[aiFetch] →", options.method ?? "GET", url, {
    headers: { ...headers, Authorization: token ? "Bearer ***" : "(none)" },
    body: options.body instanceof FormData
      ? "[FormData]"
      : typeof options.body === "string"
        ? (() => { try { return JSON.parse(options.body as string); } catch { return options.body; } })()
        : options.body,
  });

  try {
    const res = await fetch(url, { ...options, headers });

    // Đọc body 1 lần dưới dạng text, rồi thử parse JSON — tránh lỗi "body already read".
    const rawText = await res.text();

    // [DEBUG] log incoming response
    console.log("[aiFetch] ←", res.status, res.statusText, url, {
      contentType: res.headers.get("content-type"),
      bodyPreview: rawText.slice(0, 500),
    });

    if (!res.ok) {
      // `detail` của FastAPI có thể là OBJECT ({code, message}) — không được gán
      // thẳng vào biến string, nếu không React sẽ crash khi render.
      let msg = friendlyStatusMessage(res.status);
      try {
        const body = rawText ? JSON.parse(rawText) : null;
        msg = extractMessage(body) ?? msg;
      } catch {
        // body không phải JSON (vd: HTML error page từ App Service proxy 502)
        if (rawText) {
          const snippet = rawText.slice(0, 120).replace(/\s+/g, " ").trim();
          if (snippet) msg = `Lỗi máy chủ (HTTP ${res.status}): ${snippet}`;
        }
      }
      return { ok: false, error: msg, status: res.status };
    }

    // ok → parse JSON từ text đã đọc
    const data: unknown = rawText ? JSON.parse(rawText) : null;
    return { ok: true, data: data as T };
  } catch (err) {
    // [DEBUG] log network / CORS / parse error
    console.error("[aiFetch] ✖ error for", url, err);
    const raw = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      error: `Không kết nối được dịch vụ AI. Vui lòng kiểm tra mạng và thử lại. (${raw})`,
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
 */
async function aiFetch<T>(
  path: string,
  options: RequestInit = {},
): Promise<ApiResult<T>> {
  const first = await aiFetchRaw<T>(path, options);
  if (first.ok || first.status !== 401) return first;

  const refreshed = await tryRefresh();
  if (!refreshed.ok) return first;

  const retry = await aiFetchRaw<T>(path, options);
  if (retry.ok || retry.status !== 401) return retry;

  // Refresh xong vẫn 401 → token không hợp lệ → đăng xuất như BE.
  clearTokens();
  window.location.href = "/login";
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
export type ProjectReplyKind = "question" | "draft";
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

export interface ProjectDraftTaskDto {
  key: string | null;
  title: string;
  domain: ProjectDomainDto;
  estimated_minutes: number;
  reason: string | null;
}

export interface ProjectDraftMilestoneDto {
  key: string | null;
  title: string;
  deadline: string; // ISO date YYYY-MM-DD
  tasks: ProjectDraftTaskDto[];
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
}

export interface ProjectChatMessageDto {
  id: string;
  role: ChatRole;
  kind: ProjectReplyKind | null;
  content: string;
  created_at: string;
  draft: ProjectDraftDto | null;
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
}

export interface SkippedProjectTaskDto {
  title: string;
  reason: ProjectSkipReason;
}

export interface AppliedProjectBreakdownDto {
  milestones: AppliedProjectMilestoneDto[];
  skipped: SkippedProjectTaskDto[];
}

/** Task sửa tay lúc Apply — cùng shape với `EditedMilestone` của AI service. */
export interface EditedProjectTask {
  key?: string | null;
  title: string;
  domain_id: string;
  estimated_minutes: number;
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
): Promise<ApiResult<ProjectChatTurnDto>> {
  if (!conversationId) return { ok: false, error: "conversation_id is required" };
  const trimmed = message.trim();
  if (!trimmed) return { ok: false, error: "message is empty" };
  if (trimmed.length > 8000) {
    return {
      ok: false,
      error: "Tin nhắn vượt quá 8.000 ký tự. Vui lòng dán phần chính của brief.",
    };
  }
  return aiFetch<ProjectChatTurnDto>(
    `/chat/conversations/${encodeURIComponent(conversationId)}/messages`,
    { method: "POST", body: JSON.stringify({ message: trimmed }) },
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

/** Nguồn của 1 dòng trong lịch hôm nay. */
export type BriefingScheduleKind = "slot" | "fixed" | "google";

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
  task_id: string | null;
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
  focusTrackId?: string | null;
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
    focusTrackId: body.focusTrackId ?? null,
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
export type NotificationType = "SlotReminder" | "MissedSlot" | (string & {});

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

