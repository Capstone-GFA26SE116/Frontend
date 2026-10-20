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
  status: "scheduled" | "in_progress" | "completed" | "cancelled";
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
  status?: "scheduled" | "in_progress" | "completed" | "cancelled";
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
  status?: "scheduled" | "in_progress" | "completed" | "cancelled";
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

/* ----- Mock stores (in-memory) ----- */
const MOCK_SCHEDULE_SLOTS: Map<string, ScheduleSlotDto> = new Map();
const MOCK_SCHEDULE_SLOT_CHANGES: Map<string, ScheduleSlotChangeDto> = new Map();

/**
 * Tạo UUID v4 mock (giống pattern đã dùng ở payments).
 */
function genSlotId(): string {
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
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
  const slots = Array.from(MOCK_SCHEDULE_SLOTS.values()).filter(
    (s) => s.taskId === taskId,
  );
  return delay({ ok: true, data: slots });
}

/**
 * POST /api/tasks/{taskId}/schedule-slots
 * Tạo slot mới cho task.
 */
export async function createScheduleSlot(
  taskId: string,
  body: CreateScheduleSlotRequest,
): Promise<ApiResult<ScheduleSlotDto>> {
  if (!taskId) {
    return { ok: false, status: 0, error: "Task id is required" };
  }

  const id = genSlotId();
  const now = new Date().toISOString();

  const slot: ScheduleSlotDto = {
    id,
    taskId,
    subTaskId: body.subTaskId ?? null,
    scheduleProposalId: body.scheduleProposalId ?? null,
    startTime: body.startTime,
    endTime: body.endTime,
    originalStartTime: body.originalStartTime ?? null,
    isManualOverride: body.isManualOverride ?? false,
    proposedMinutes: body.startTime && body.endTime
      ? Math.round((new Date(body.endTime).getTime() - new Date(body.startTime).getTime()) / 60000)
      : 0,
    kbiasUsed: body.kbiasUsed ?? 0,
    explanation: body.explanation ?? null,
    status: body.status ?? "scheduled",
    googleEventId: null,
    syncFailed: false,
  };

  MOCK_SCHEDULE_SLOTS.set(id, slot);

  // Auto-log tạo slot
  const change: ScheduleSlotChangeDto = {
    id: genSlotId(),
    scheduleSlotId: id,
    changeType: "manual_override",
    source: "user",
    oldStart: null,
    oldEnd: null,
    newStart: body.startTime,
    newEnd: body.endTime,
    changedAt: now,
  };
  MOCK_SCHEDULE_SLOT_CHANGES.set(change.id, change);

  return delay({ ok: true, data: slot });
}

/**
 * GET /api/schedule-slots/{slotId}
 * Lấy chi tiết 1 slot.
 */
export async function getScheduleSlot(
  slotId: string,
): Promise<ApiResult<ScheduleSlotDto>> {
  const slot = MOCK_SCHEDULE_SLOTS.get(slotId);
  if (!slot) {
    return { ok: false, status: 404, error: "Schedule slot not found" };
  }
  return delay({ ok: true, data: slot });
}

/**
 * PUT /api/schedule-slots/{slotId}
 * Cập nhật slot (đổi giờ, status, v.v.).
 */
export async function updateScheduleSlot(
  slotId: string,
  body: UpdateScheduleSlotRequest,
): Promise<ApiResult<ScheduleSlotDto>> {
  const existing = MOCK_SCHEDULE_SLOTS.get(slotId);
  if (!existing) {
    return { ok: false, status: 404, error: "Schedule slot not found" };
  }

  const now = new Date().toISOString();

  // Log thay đổi nếu có thay đổi thời gian
  if (
    body.startTime !== undefined || body.endTime !== undefined ||
    body.status !== undefined
  ) {
    const change: ScheduleSlotChangeDto = {
      id: genSlotId(),
      scheduleSlotId: slotId,
      changeType: body.isManualOverride ? "manual_override" : "rescheduled",
      source: body.isManualOverride ? "user" : "ai",
      oldStart: existing.startTime,
      oldEnd: existing.endTime,
      newStart: body.startTime ?? existing.startTime,
      newEnd: body.endTime ?? existing.endTime,
      changedAt: now,
    };
    MOCK_SCHEDULE_SLOT_CHANGES.set(change.id, change);
  }

  const updated: ScheduleSlotDto = {
    ...existing,
    subTaskId: body.subTaskId !== undefined ? body.subTaskId : existing.subTaskId,
    scheduleProposalId: body.scheduleProposalId !== undefined ? body.scheduleProposalId : existing.scheduleProposalId,
    startTime: body.startTime ?? existing.startTime,
    endTime: body.endTime ?? existing.endTime,
    originalStartTime: body.originalStartTime !== undefined ? body.originalStartTime : existing.originalStartTime,
    isManualOverride: body.isManualOverride ?? existing.isManualOverride,
    proposedMinutes: body.startTime && body.endTime
      ? Math.round((new Date(body.endTime).getTime() - new Date(body.startTime).getTime()) / 60000)
      : existing.proposedMinutes,
    kbiasUsed: body.kbiasUsed ?? existing.kbiasUsed,
    explanation: body.explanation !== undefined ? body.explanation : existing.explanation,
    status: body.status ?? existing.status,
  };

  MOCK_SCHEDULE_SLOTS.set(slotId, updated);
  return delay({ ok: true, data: updated });
}

/**
 * DELETE /api/schedule-slots/{slotId}
 * Xóa slot.
 */
export async function deleteScheduleSlot(
  slotId: string,
): Promise<ApiResult<{ deleted: boolean; slotId: string }>> {
  const exists = MOCK_SCHEDULE_SLOTS.has(slotId);
  if (!exists) {
    return { ok: false, status: 404, error: "Schedule slot not found" };
  }

  // Xóa tất cả changes liên quan
  for (const [changeId, change] of MOCK_SCHEDULE_SLOT_CHANGES) {
    if (change.scheduleSlotId === slotId) {
      MOCK_SCHEDULE_SLOT_CHANGES.delete(changeId);
    }
  }

  MOCK_SCHEDULE_SLOTS.delete(slotId);
  return delay({ ok: true, data: { deleted: true, slotId } });
}

/**
 * GET /api/schedule-slots/{slotId}/changes
 * Lấy lịch sử thay đổi của 1 slot.
 */
export async function listScheduleSlotChanges(
  slotId: string,
): Promise<ApiResult<ScheduleSlotChangeDto[]>> {
  if (!MOCK_SCHEDULE_SLOTS.has(slotId)) {
    return { ok: false, status: 404, error: "Schedule slot not found" };
  }

  const changes = Array.from(MOCK_SCHEDULE_SLOT_CHANGES.values())
    .filter((c) => c.scheduleSlotId === slotId)
    .sort((a, b) => new Date(b.changedAt).getTime() - new Date(a.changedAt).getTime());

  return delay({ ok: true, data: changes });
}

/**
 * POST /api/schedule-slots/{slotId}/changes
 * Log thay đổi mới cho slot (dùng khi có sự kiện từ bên ngoài như calendar sync).
 */
export async function createScheduleSlotChange(
  slotId: string,
  body: CreateScheduleSlotChangeRequest,
): Promise<ApiResult<ScheduleSlotChangeDto>> {
  if (!MOCK_SCHEDULE_SLOTS.has(slotId)) {
    return { ok: false, status: 404, error: "Schedule slot not found" };
  }

  const change: ScheduleSlotChangeDto = {
    id: genSlotId(),
    scheduleSlotId: slotId,
    changeType: body.changeType,
    source: body.source,
    oldStart: body.oldStart ?? null,
    oldEnd: body.oldEnd ?? null,
    newStart: body.newStart ?? null,
    newEnd: body.newEnd ?? null,
    changedAt: new Date().toISOString(),
  };

  MOCK_SCHEDULE_SLOT_CHANGES.set(change.id, change);
  return delay({ ok: true, data: change });
}

/**
 * GET /api/schedule-change-logs/{logId}
 * Lấy chi tiết 1 log thay đổi.
 */
export async function getScheduleSlotChange(
  logId: string,
): Promise<ApiResult<ScheduleSlotChangeDto>> {
  const change = MOCK_SCHEDULE_SLOT_CHANGES.get(logId);
  if (!change) {
    return { ok: false, status: 404, error: "Schedule slot change not found" };
  }
  return delay({ ok: true, data: change });
}

/** Reset tất cả mock schedule slots (test teardown). */
export function __resetMockScheduleSlots(): void {
  MOCK_SCHEDULE_SLOTS.clear();
  MOCK_SCHEDULE_SLOT_CHANGES.clear();
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

  // [DEBUG] log outgoing request
  // eslint-disable-next-line no-console
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
    // eslint-disable-next-line no-console
    console.log("[aiFetch] ←", res.status, res.statusText, url, {
      contentType: res.headers.get("content-type"),
      bodyPreview: rawText.slice(0, 500),
    });

    if (!res.ok) {
      // Cố parse JSON, fallback text thuần
      let msg = `HTTP ${res.status}`;
      try {
        const body = rawText ? JSON.parse(rawText) : null;
        msg = body?.message ?? body?.error ?? body?.title ?? body?.detail ?? msg;
      } catch {
        // body không phải JSON (vd: HTML error page từ App Service proxy 502)
        if (rawText) msg = `HTTP ${res.status} – ${rawText.slice(0, 120).replace(/\s+/g, " ")}`;
      }
      return { ok: false, error: msg, status: res.status };
    }

    // ok → parse JSON từ text đã đọc
    const data: unknown = rawText ? JSON.parse(rawText) : null;
    return { ok: true, data: data as T };
  } catch (err) {
    // [DEBUG] log network / CORS / parse error
    // eslint-disable-next-line no-console
    console.error("[aiFetch] ✖ error for", url, err);
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

/* ============================================================
 * Plan identifiers
 * ----------------------------------------------------------
 * Source of truth cho plan FE/BE hiểu. PricingPage re-export
 * từ đây để đồng bộ.
 * ============================================================ */

export type PlanKey = "starter" | "pro" | "team";

/* ============================================================
 * Current plan helpers (mock persistence)
 * ----------------------------------------------------------
 * Lưu plan user đang dùng vào localStorage, dùng để Pricing
 * auto-select gói hiện tại. Sau khi BE ready, thay bằng
 * `GET /api/users/me` hoặc `GET /api/payment-transactions/me`.
 * ============================================================ */

const USER_PLAN_KEY = "metanoia:user-plan";

export function getCurrentPlan(): PlanKey | null {
  if (typeof window === "undefined") return null;
  const v = window.localStorage.getItem(USER_PLAN_KEY);
  if (v === "pro" || v === "team" || v === "starter") return v;
  return null;
}

export function setCurrentPlan(plan: PlanKey | null): void {
  if (typeof window === "undefined") return;
  if (plan === null) {
    window.localStorage.removeItem(USER_PLAN_KEY);
    return;
  }
  window.localStorage.setItem(USER_PLAN_KEY, plan);
}

/* ============================================================
 * Payments
 * ----------------------------------------------------------
 * MOCKED: Hiện tại BE chưa ready, ta wrap các endpoint từ Swagger
 * và trả mock data có delay mô phỏng network. Thay thế bằng
 * `fetch thật` (post/get/del) khi BE ready.
 *
 * Endpoints tham khảo (Swagger):
 *   POST   /api/payments/checkout                      → tạo payment
 *   POST   /api/payments/{paymentId}/sync              → đồng bộ trạng thái
 *   POST   /api/payments/{paymentId}/cancel             → hủy
 *   POST   /api/payments/{paymentId}/refunds            → hoàn tiền
 * ============================================================ */

export type PaymentStatus =
  | "pending"
  | "waiting"
  | "processing"
  | "paid"
  | "cancelled"
  | "failed"
  | "refunded";

export type PaymentGateway = "VietQR" | "MoMo" | "Visa" | "MasterCard";

export interface PaymentTransactionDto {
  id: string;
  userId: string;
  planId: string;
  orderCode: number;
  gateway: string;
  amount: number;
  status: PaymentStatus;
  createdAt: string;
  expiresAt: string | null;
  paidAt: string | null;
  webhookReceivedAt: string | null;
  /** URL trang PayOS thanh Checkout (QR + nút CK + form Visa/MC all-in-one). */
  checkoutUrl?: string | null;
  qrCodeUrl?: string | null;
  qrData?: string | null;
  bankInfo?: {
    bankName: string;
    accountNumber: string;
    accountHolder: string;
    transferContent: string;
  } | null;
}

export interface CreateCheckoutRequest {
  planId: string;
  cycle: "monthly" | "annual";
  gateway: PaymentGateway;
  email: string;
  fullName?: string;
  amount?: number;
  /** Alias used by FE checkout UI — not sent to BE. */
  plan?: string;
}

export interface RefundRequest {
  reason: string;
}

/**
 * PaymentRefund — theo Swagger spec
 * (POST /api/payments/{paymentId}/refunds trả về object này,
 *  KHÔNG phải PaymentTransactionDto).
 */
export interface PaymentRefundDto {
  id: string;
  paymentTransactionId: string;
  userId: string;
  amount: number;
  reason: string;
  source: string; // "user" | "admin" | "system" | …
  status: "pending" | "processing" | "completed" | "rejected";
  adminNote?: string | null;
  bankReference?: string | null;
  createdAt: string;
  processedAt?: string | null;
}

/**
 * Body cho POST /api/payment-transactions
 * (BE cho phép tạo tx thủ công — admin/internal).
 */
export interface CreatePaymentTransactionRequest {
  userId: string;
  planId: string;
  orderCode: number;
  gateway: string;
  amount: number;
  status: PaymentStatus;
  expiresAt?: string | null;
  paidAt?: string | null;
  webhookReceivedAt?: string | null;
}

/**
 * Body cho PUT /api/payment-transactions/{paymentId}
 * Cập nhật 1 số trường (status, paidAt, …).
 */
export interface UpdatePaymentTransactionRequest {
  userId?: string;
  planId?: string;
  orderCode?: number;
  gateway?: string;
  amount?: number;
  status?: PaymentStatus;
  expiresAt?: string | null;
  paidAt?: string | null;
  webhookReceivedAt?: string | null;
}

/* ----- Mock store (in-memory) ----- */
const MOCK_PAYMENTS: Map<string, PaymentTransactionDto> = new Map();
const MOCK_REFUNDS: Map<string, PaymentRefundDto> = new Map();
function genId(): string {
  // RFC4122-ish uuid v4 (mock)
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}
function genOrderCode(): number {
  // META PRO <5 số ngẫu nhiên> (giống PayOS)
  return Math.floor(10000 + Math.random() * 90000);
}
function delay<T>(value: T, ms = 600): Promise<T> {
  return new Promise((res) => setTimeout(() => res(value), ms));
}

/**
 * POST /api/payments/checkout
 * Mock trả về payment pending cùng QR / bank info.
 */
export async function createCheckout(
  body: CreateCheckoutRequest,
): Promise<ApiResult<PaymentTransactionDto>> {
  // Validation
  if (!body.planId) return { ok: false, error: "planId is required" };
  if (!body.email || !/^\S+@\S+\.\S+$/.test(body.email))
    return { ok: false, error: "A valid email is required" };

  const now = new Date();
  const id = genId();
  const orderCode = genOrderCode();
  const transferContent = `META ${body.planId.toUpperCase()} ${orderCode}`;
  const amount = body.amount ?? (body.cycle === "annual" ? 1_428_000 : 149_000);

  const tx: PaymentTransactionDto = {
    id,
    userId: "00000000-0000-0000-0000-000000000000", // mock user
    planId: body.planId,
    orderCode,
    gateway: body.gateway,
    amount,
    status: "waiting",
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + 15 * 60 * 1000).toISOString(), // +15min
    paidAt: null,
    webhookReceivedAt: null,
    // ============================================================
    // PayOS (MoMo gateway được map tương đương) flow:
    //   - PayOS KHÔNG trả QR kiểu VietQR. Mỗi checkout trả về
    //     `checkoutUrl` = hosted page có sẵn QR + form + nút CK.
    //   - FE không tự dựng QR, chỉ mở/redirect sang checkoutUrl.
    //   - Mock: tạo URL dạng PayOS-merchant để test UI flow.
    // ============================================================
    qrCodeUrl: null,
    qrData:
      body.gateway === "VietQR"
        ? buildVietQRUrl({
            account: "998824078899",
            bank: "MBBank",
            amount,
            content: transferContent,
          })
        : body.gateway === "MoMo"
        ? `https://pay.payos.vn/merchant/${orderCode}?amount=${amount}&content=${encodeURIComponent(transferContent)}`
        : null,
    checkoutUrl:
      body.gateway === "MoMo"
        ? `https://pay.payos.vn/merchant/${orderCode}?amount=${amount}&content=${encodeURIComponent(transferContent)}`
        : null,
    bankInfo:
      body.gateway === "VietQR"
        ? {
            bankName: "MBBank (Military Commercial Joint Stock Bank)",
            accountNumber: "9988 2407 8899",
            accountHolder: "CONG TY CONG NGHE METANOIA LABS",
            transferContent,
          }
        : null,
  };

  MOCK_PAYMENTS.set(id, tx);
  return delay({ ok: true, data: tx });
}

/* ============================================================
 * QR URL policy
 * ------------------------------------------------------------
 * QR phải đến từ GATEWAY THẬT, không tự dựng SVG giả:
 *   - VietQR: URL https://api.vietqr.io/image?account=...&bank=...
 *             (mock tạo URL đúng chuẩn cho test — link này thật)
 *   - MoMo:   deeplink `momoapp://...?orderCode=...` (gateway mới có)
 *             → FE render thành nút "Open MoMo app".
 *   - Visa/MC: không có QR.
 * Khi BE thật kết nối PayOS/MoMo thì chỉ cần thay nguồn qrData ở đây
 * (không đổi gì ở FE render).
 * ============================================================ */
function buildVietQRUrl(args: {
  account: string;
  bank: string;
  amount: number;
  content: string;
}): string {
  const q = new URLSearchParams({
    account: args.account,
    bank: args.bank,
    amount: String(args.amount),
    content: args.content,
    template: "compact2",
  });
  return `https://api.vietqr.io/image?${q.toString()}`;
}

/**
 * POST /api/payments/{paymentId}/sync
 *
 * Vai trò đúng (giống PayOS / MoMo / Stripe thật): kéo trạng thái mới nhất
 * từ CỔNG THANH TOÁN về. Cổng KHÔNG tự báo "paid" — chỉ khi user thật sự
 * chuyển khoản, webhook của cổng gọi về server mới chuyển sang "paid".
 *
 * Vậy nên mock này chỉ:
 *   - Trả status hiện tại của tx.
 *   - Nếu đã quá `expiresAt` → tự hạ về "cancelled" (hết hạn QR).
 *   - KHÔNG tự ý đổi sang "paid" (tránh bug "chưa thanh toán mà success").
 *
 * Muốn test "paid" trên mock: gọi `simulatePayOSWebhook(id)` (dev helper)
 * hoặc click nút "Tôi đã chuyển khoản" trên UI.
 */
export async function syncPayment(
  paymentId: string,
): Promise<ApiResult<PaymentTransactionDto>> {
  const tx = MOCK_PAYMENTS.get(paymentId);
  if (!tx) return delay({ ok: false, error: "Payment not found", status: 404 });

  // Tx đã chốt (paid/cancelled/refunded) → giữ nguyên, không đổi.
  if (
    tx.status === "paid" ||
    tx.status === "cancelled" ||
    tx.status === "refunded" ||
    tx.status === "failed"
  ) {
    return delay({ ok: true, data: tx });
  }

  // Hết hạn QR (expiresAt < now) khi đang waiting → hủy.
  if (tx.expiresAt && new Date(tx.expiresAt).getTime() <= Date.now()) {
    tx.status = "cancelled";
    MOCK_PAYMENTS.set(paymentId, tx);
    return delay({ ok: true, data: tx });
  }

  // Còn waiting → giữ nguyên để dashboard hiện "đang chờ thanh toán".
  return delay({ ok: true, data: tx });
}

/**
 * FE-DEV ONLY — giả lập PayOS server GỌI WEBHOOK về BE.
 *
 * Luồng PayOS thật:
 *   1. User quét QR + CK xong bên banking app.
 *   2. PayOS server nhận tiền → gọi `POST {BE_URL}/api/payos/webhook`
 *      với body { data: { orderCode, status: "PAID" } }.
 *   3. BE nhận webhook → cập nhật `transactions.status = "paid"`.
 *   4. FE poll `GET /api/payment-transactions/{id}` → thấy "paid".
 *
 * Vì BE mock + FE cùng process, ta gọi thẳng `payosWebhook()` ở FE,
 * rồi `syncPayment()` để kéo status mới nhất về. Đây là thứ mô phỏng
 * đúng vai trò "PayOS server → webhook → BE".
 *
 * Không có trong Swagger. Khi BE ready: bỏ hàm này, BE tự nhận webhook.
 */
export async function simulatePayOSWebhook(
  paymentId: string,
): Promise<ApiResult<PaymentTransactionDto>> {
  const tx = MOCK_PAYMENTS.get(paymentId);
  if (!tx) return delay({ ok: false, error: "Payment not found", status: 404 });
  if (tx.status === "cancelled" || tx.status === "refunded")
    return delay({
      ok: false,
      error: `Cannot mark a ${tx.status} payment as paid`,
      status: 409,
    });
  if (tx.status === "paid") return delay({ ok: true, data: tx });

  // Bước 1: Giả lập PayOS gọi webhook về BE → cập nhật tx.
  const webhookRes = await payosWebhook({
    data: { orderCode: tx.orderCode, status: "PAID" },
  });
  if (!webhookRes.ok) return delay({ ok: false, error: webhookRes.error });

  // Bước 2: FE poll lại status từ "BE" → status lúc này là "paid".
  const after = MOCK_PAYMENTS.get(paymentId);
  return delay({ ok: true, data: after ?? tx });
}

/**
 * POST /api/payments/{paymentId}/cancel
 */
export async function cancelPayment(
  paymentId: string,
): Promise<ApiResult<PaymentTransactionDto>> {
  const tx = MOCK_PAYMENTS.get(paymentId);
  if (!tx) return delay({ ok: false, error: "Payment not found", status: 404 });
  if (tx.status === "paid")
    return delay({ ok: false, error: "Cannot cancel a paid payment", status: 409 });
  tx.status = "cancelled";
  MOCK_PAYMENTS.set(paymentId, tx);
  return delay({ ok: true, data: tx });
}

/**
 * POST /api/payments/{paymentId}/refunds
 * (Swagger spec trả về PaymentRefund, KHÔNG phải PaymentTransaction.)
 */
export async function refundPayment(
  paymentId: string,
  body: RefundRequest,
): Promise<ApiResult<PaymentRefundDto>> {
  const tx = MOCK_PAYMENTS.get(paymentId);
  if (!tx) return delay({ ok: false, error: "Payment not found", status: 404 });
  if (tx.status !== "paid")
    return delay({
      ok: false,
      error: "Only paid payments can be refunded",
      status: 409,
    });
  if (!body.reason?.trim())
    return delay({ ok: false, error: "Reason is required" });

  // Update tx sang "refunded" để listPaymentTransactions() đồng bộ.
  tx.status = "refunded";
  MOCK_PAYMENTS.set(paymentId, tx);

  // Lưu refund riêng để tra cứu.
  const refund: PaymentRefundDto = {
    id: genId(),
    paymentTransactionId: paymentId,
    userId: tx.userId,
    amount: tx.amount,
    reason: body.reason,
    source: "user",
    status: "completed",
    adminNote: null,
    bankReference: null,
    createdAt: new Date().toISOString(),
    processedAt: new Date().toISOString(),
  };
  MOCK_REFUNDS.set(refund.id, refund);
  return delay({ ok: true, data: refund });
}

/**
 * GET /api/payments/{paymentId}/refunds — danh sách refunds của 1 payment
 * (helper FE, không có trong Swagger nhưng tiện cho list lịch sử).
 */
export async function listRefundsByPayment(
  paymentId: string,
): Promise<ApiResult<PaymentRefundDto[]>> {
  const refunds = Array.from(MOCK_REFUNDS.values()).filter(
    (r) => r.paymentTransactionId === paymentId,
  );
  return delay({ ok: true, data: refunds });
}

/**
 * GET /api/payment-transactions (tất cả tx của user — dùng cho list payment history)
 */
export async function listPaymentTransactions(): Promise<
  ApiResult<PaymentTransactionDto[]>
> {
  return delay({ ok: true, data: Array.from(MOCK_PAYMENTS.values()) });
}

/**
 * GET /api/payment-transactions/{paymentId}
 */
export async function getPaymentTransaction(
  paymentId: string,
): Promise<ApiResult<PaymentTransactionDto>> {
  const tx = MOCK_PAYMENTS.get(paymentId);
  if (!tx) return delay({ ok: false, error: "Payment not found", status: 404 });
  return delay({ ok: true, data: tx });
}

/* ============================================================
 * Payment-transactions CRUD còn lại (POST/PUT/DELETE)
 * + PayOS webhook endpoints
 * ============================================================ */

/**
 * POST /api/payment-transactions
 * Tạo 1 transaction thủ công (admin / internal / import).
 */
export async function createPaymentTransaction(
  body: CreatePaymentTransactionRequest,
): Promise<ApiResult<PaymentTransactionDto>> {
  if (!body.userId)
    return delay({ ok: false, error: "userId is required" });
  if (!body.planId)
    return delay({ ok: false, error: "planId is required" });
  if (!body.gateway)
    return delay({ ok: false, error: "gateway is required" });
  if (typeof body.amount !== "number" || body.amount <= 0)
    return delay({ ok: false, error: "amount must be > 0" });
  if (!Number.isFinite(body.orderCode))
    return delay({ ok: false, error: "orderCode is required" });

  const now = new Date();
  const tx: PaymentTransactionDto = {
    id: genId(),
    userId: body.userId,
    planId: body.planId,
    orderCode: body.orderCode,
    gateway: body.gateway,
    amount: body.amount,
    status: body.status,
    createdAt: now.toISOString(),
    expiresAt: body.expiresAt ?? null,
    paidAt: body.paidAt ?? null,
    webhookReceivedAt: body.webhookReceivedAt ?? null,
    qrCodeUrl: null,
    qrData: null,
    bankInfo: null,
  };
  MOCK_PAYMENTS.set(tx.id, tx);
  return delay({ ok: true, data: tx });
}

/**
 * PUT /api/payment-transactions/{paymentId}
 * Partial update — chỉ các field truyền vào mới được thay đổi.
 */
export async function updatePaymentTransaction(
  paymentId: string,
  body: UpdatePaymentTransactionRequest,
): Promise<ApiResult<PaymentTransactionDto>> {
  const tx = MOCK_PAYMENTS.get(paymentId);
  if (!tx) return delay({ ok: false, error: "Payment not found", status: 404 });

  const next: PaymentTransactionDto = {
    ...tx,
    userId: body.userId ?? tx.userId,
    planId: body.planId ?? tx.planId,
    orderCode: body.orderCode ?? tx.orderCode,
    gateway: body.gateway ?? tx.gateway,
    amount: body.amount ?? tx.amount,
    status: body.status ?? tx.status,
    expiresAt:
      body.expiresAt === undefined ? tx.expiresAt : body.expiresAt,
    paidAt: body.paidAt === undefined ? tx.paidAt : body.paidAt,
    webhookReceivedAt:
      body.webhookReceivedAt === undefined
        ? tx.webhookReceivedAt
        : body.webhookReceivedAt,
  };

  MOCK_PAYMENTS.set(paymentId, next);
  return delay({ ok: true, data: next });
}

/**
 * DELETE /api/payment-transactions/{paymentId}
 * Xóa tx khỏi store. Trả về 200 + message text.
 */
export async function deletePaymentTransaction(
  paymentId: string,
): Promise<ApiResult<{ deleted: boolean; paymentId: string }>> {
  const exists = MOCK_PAYMENTS.has(paymentId);
  if (!exists)
    return delay({
      ok: false,
      error: "Payment not found",
      status: 404,
    });
  MOCK_PAYMENTS.delete(paymentId);
  // cleanup refunds của payment này
  for (const [rid, r] of MOCK_REFUNDS) {
    if (r.paymentTransactionId === paymentId) MOCK_REFUNDS.delete(rid);
  }
  return delay({ ok: true, data: { deleted: true, paymentId } });
}

/**
 * POST /api/payos/webhook
 * PayOS gọi để báo trạng thái thanh toán thay đổi.
 *
 * PayOS docs: status string trong `data.status` là uppercase
 *   "PAID" | "PENDING" | "CANCELLED" | "PROCESSING" | "FAILED".
 *
 * Ở mock: parse body.orderCode → tìm tx → map về PaymentStatus (lowercase)
 * → cập nhật status + paidAt + webhookReceivedAt.
 */
export async function payosWebhook(
  body: unknown,
): Promise<ApiResult<{ received: true; updated?: string }>> {
  // Lỏng tay: chấp nhận vài shape khác nhau từ PayOS docs.
  const orderCode =
    (body as { data?: { orderCode?: number }; orderCode?: number })?.data
      ?.orderCode ??
    (body as { orderCode?: number })?.orderCode;
  const rawStatus =
    (body as { data?: { status?: string }; status?: string })?.data?.status ??
    (body as { status?: string })?.status ??
    "PAID";

  if (typeof orderCode !== "number") {
    return delay({
      ok: false,
      error: "Missing orderCode in webhook payload",
    });
  }

  // Map PayOS status (uppercase) → PaymentStatus (lowercase).
  const mappedStatus = mapPayOSStatus(rawStatus);

  // Tìm tx có orderCode khớp.
  let foundId: string | null = null;
  for (const [id, t] of MOCK_PAYMENTS) {
    if (t.orderCode === orderCode) {
      foundId = id;
      const now = new Date().toISOString();
      const next: PaymentTransactionDto = {
        ...t,
        status: mappedStatus,
        webhookReceivedAt: now,
        paidAt:
          mappedStatus === "paid"
            ? t.paidAt ?? now
            : t.paidAt,
      };
      MOCK_PAYMENTS.set(id, next);
      break;
    }
  }

  return delay({
    ok: true,
    data: { received: true, updated: foundId ?? undefined },
  });
}

/** Map PayOS status string → PaymentStatus enum. */
function mapPayOSStatus(raw: string): PaymentStatus {
  const s = raw.toUpperCase();
  switch (s) {
    case "PAID":
      return "paid";
    case "PENDING":
    case "WAITING":
      return "waiting";
    case "PROCESSING":
      return "processing";
    case "CANCELLED":
    case "CANCELED":
      return "cancelled";
    case "FAILED":
      return "failed";
    case "REFUNDED":
      return "refunded";
    default:
      return "waiting";
  }
}

/**
 * POST /api/payos/confirm-webhook
 * PayOS gọi 1 lần khi đăng ký webhook URL — mock chỉ OK.
 * (Spec: trả về { success: true } hoặc tương tự; mình trả { confirmed: true }.)
 */
export async function confirmPayosWebhook(): Promise<ApiResult<{ confirmed: true }>> {
  return delay({ ok: true, data: { confirmed: true } });
}

/**
 * Helpers (FE-only) — không có trong Swagger, dùng cho admin UI / dashboard.
 * ----------------------------------------------------------------
 */

/** Xoá tất cả mock payments + refunds (test teardown). */
export function __resetMockPayments(): void {
  MOCK_PAYMENTS.clear();
  MOCK_REFUNDS.clear();
}

/** Lấy tất cả refunds (admin / debug). */
export async function listAllRefunds(): Promise<ApiResult<PaymentRefundDto[]>> {
  return delay({ ok: true, data: Array.from(MOCK_REFUNDS.values()) });
}

