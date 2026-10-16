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
export type ApiErr = { ok: false; error: string; status?: number };
export type ApiResult<T> = ApiOk<T> | ApiErr;

/* ---------- core fetch ---------- */

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
            const body = await retry.text().catch(() => "Unknown error");
            return {
              ok: false,
              error: body || `HTTP ${retry.status}`,
              status: retry.status,
            };
          }
          const data = await retry.json();
          return { ok: true, data: data as T };
        }
      }
      // Refresh thất bại hoặc không có refresh token → logout
      clearTokens();
      window.location.href = "/login";
      return { ok: false, error: "session_expired", status: 401 };
    }

    if (!res.ok) {
      let msg = `HTTP ${res.status}`;
      try {
        const body = await res.json();
        msg = body.message ?? body.error ?? body.title ?? msg;
      } catch {
        // ignore
      }
      return { ok: false, error: msg, status: res.status };
    }

    const data = await res.json();
    return { ok: true, data: data as T };
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Network error";
    return { ok: false, error: msg };
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

export async function post<T>(
  path: string,
  body: unknown,
): Promise<ApiResult<T>> {
  return apiFetch<T>(path, {
    method: "POST",
    body: JSON.stringify(body),
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

export interface MeResponse {
  id: string;
  email: string | null;
  fullName: string | null;
  role: string | null;
  /** URL ảnh đại diện từ Google (nếu có). */
  avatarUrl: string | null;
  onboardingCompleted: boolean;
  timeZone: string | null;
  workDayStart: string;
  workDayEnd: string;
  worksOnWeekend: boolean;
  googleCalendarStatus: string | null;
  currentPlanName: string | null;
}

export async function getMe(): Promise<ApiResult<MeResponse>> {
  return get<MeResponse>("/api/me");
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

export async function listProjects(): Promise<ApiResult<ProjectDto[]>> {
  return get<ProjectDto[]>("/api/projects");
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
  return get<ProjectDto[]>(path);
}

/* ---------- clients (cho dropdown clientId) ---------- */

export interface ClientDto {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  company: string | null;
  notes: string | null;
  createdAtUtc: string;
}

export async function listClients(): Promise<ApiResult<ClientDto[]>> {
  return get<ClientDto[]>("/api/clients");
}

export interface CreateClientRequest {
  name: string;
  contactEmail: string;
  phone: string;
  notes: string;
}

export async function createClient(
  body: CreateClientRequest,
): Promise<ApiResult<ClientDto>> {
  return post<ClientDto>("/api/clients", body);
}

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
 * Response: { from, to, googleCalendarStatus, items[] }
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
}

export interface CalendarResponseDto {
  from: string;
  to: string;
  googleCalendarStatus: string;
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
  return apiFetch<CalendarResponseDto>(`/calendar?${qs.toString()}`, {
    method: "GET",
  });
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
 * ================================================================ */

const AI_BASE_URL =
  (import.meta.env.VITE_AI_API_URL as string | undefined)?.replace(/\/+$/, "") ?? "";

/* ---------- low-level aiFetch (riêng AI service) ---------- */

async function aiFetch<T>(
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
    if (!res.ok) {
      let msg = `HTTP ${res.status}`;
      try {
        const body = await res.json();
        msg = body?.message ?? body?.error ?? body?.title ?? msg;
      } catch {
        // ignore
      }
      return { ok: false, error: msg, status: res.status };
    }
    // Một số endpoint (vd. /healthz) có thể trả text — xử lý JSON trước.
    const text = await res.text();
    const data: unknown = text ? JSON.parse(text) : null;
    return { ok: true, data: data as T };
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Network error";
    return { ok: false, error: msg };
  }
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

/**
 * POST /chat/tasks/{task_id}/messages
 * Gửi 1 message từ user — tốn 1 AI call khi AI trả lời.
 */
export async function sendTaskMessage(
  taskId: string,
  message: string,
): Promise<ApiResult<ChatTurnResponse>> {
  if (!taskId) return { ok: false, error: "task_id is required" };
  const trimmed = message.trim();
  if (!trimmed) return { ok: false, error: "message is empty" };
  return aiFetch<ChatTurnResponse>(
    `/chat/tasks/${encodeURIComponent(taskId)}/messages`,
    { method: "POST", body: JSON.stringify({ message: trimmed }) },
  );
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

