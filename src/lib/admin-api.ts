/**
 * ADMIN API CLIENT — Trang quản trị
 * ----------------------------------------------------------
 * Nguồn: spec `ADMIN_FE.md` (BE gửi) + swagger-live.
 *
 *   GET    /api/admin/users                          → danh sách user (phân trang)
 *   GET    /api/admin/users/{id}                     → chi tiết user
 *   POST   /api/admin/users                          → tạo user trước khi đăng nhập Google
 *   PUT    /api/admin/users/{id}                     → sửa user (đổi role cần lý do)
 *   DELETE /api/admin/users/{id}                     → khóa (xoá mềm) — cần lý do
 *   POST   /api/admin/users/{id}/restore             → khôi phục
 *
 *   GET    /api/subscription-plans                    → tất cả gói (kể cả đã tắt)
 *   POST   /api/subscription-plans                    → tạo gói
 *   PUT    /api/subscription-plans/{id}               → sửa gói — BẮT BUỘC lý do
 *   DELETE /api/subscription-plans/{id}               → xoá gói — BẮT BUỘC lý do
 *
 *   GET    /api/admin/revenue?groupBy=day|month|plan   → báo cáo doanh thu
 *   GET    /api/admin/audit-logs                        → nhật ký thao tác Admin
 *   POST   /api/admin/status-resync?dryRun=             → đồng bộ trạng thái dữ liệu cũ
 *
 *   GET    /api/payment-transactions                    → giao dịch (X-Total-Count)
 *   GET    /api/invoices                                → hoá đơn (X-Total-Count)
 *
 * ⚠️ HEADER `X-Admin-Reason`
 * ----------------------------------------------------------
 * Mọi thao tác ghi bắt buộc lý do đều ghi header `X-Admin-Reason`.
 * Header HTTP chỉ nhận Latin-1 → lý do tiếng Việt có dấu phải `encodeURIComponent`
 * trước, server tự giải mã. Nếu thiếu header → 400 và KHÔNG thực hiện gì.
 */

import { getAccessToken } from "./api-client";

const BASE_URL = import.meta.env.VITE_API_URL as string;

/** Kết quả gọi API — đồng bộ với `ApiResult` trong `api-client.ts`. */
export interface AdminApiResult<T> {
  ok: boolean;
  data?: T;
  error?: string;
  status?: number;
  /** Tổng số dòng (header `X-Total-Count`) cho API có phân trang. */
  totalCount?: number;
}

/* ================================================================
 * LOW-LEVEL FETCH
 * ================================================================ */

function friendlyStatusMessage(status: number): string {
  switch (status) {
    case 400:
      return "Dữ liệu gửi lên không hợp lệ hoặc thiếu lý do thao tác quản trị.";
    case 401:
      return "Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại.";
    case 403:
      return "Tài khoản của bạn không có quyền truy cập khu vực quản trị.";
    case 404:
      return "Không tìm thấy dữ liệu.";
    case 409:
      return "Dữ liệu đang bị thay đổi hoặc xung đột với yêu cầu hiện tại.";
    case 422:
      return "Dữ liệu gửi lên không hợp lệ.";
    default:
      return `Lỗi máy chủ (HTTP ${status}). Vui lòng thử lại sau.`;
  }
}

/** Rút `message` từ body lỗi của BE (hỗ trợ cả ProblemDetails). */
function extractMessage(body: unknown): string | undefined {
  if (!body || typeof body !== "object") return undefined;
  const rec = body as Record<string, unknown>;
  const direct = rec.message;
  if (typeof direct === "string" && direct.trim()) return direct;
  if (Array.isArray(direct)) {
    const first = direct.find((m) => typeof m === "string");
    if (typeof first === "string") return first;
  }
  const detail = rec.detail;
  if (typeof detail === "string" && detail.trim()) return detail;
  if (detail && typeof detail === "object") {
    const inner = detail as Record<string, unknown>;
    if (typeof inner.message === "string") return inner.message;
    if (typeof inner.error === "string") return inner.error;
  }
  const title = rec.title;
  if (typeof title === "string" && title.trim()) return title;
  return undefined;
}

async function readBody(res: Response): Promise<unknown> {
  if (res.status === 204 || res.status === 205) return null;
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/**
 * Gọi API Admin.
 *
 * `reason` → header `X-Admin-Reason` (đã encode). Truyền `reason` rỗng ở thao tác
 * bắt buộc sẽ khiến BE trả 400 — FE nên chặn trước ở UI.
 */
async function adminFetch<T>(
  path: string,
  options: RequestInit & { reason?: string } = {},
): Promise<AdminApiResult<T>> {
  const { reason, headers, ...rest } = options;
  const url = `${BASE_URL}${path}`;

  const h = new Headers(headers);
  h.set("Accept", "application/json");
  if (!h.has("Content-Type") && rest.body !== undefined) {
    h.set("Content-Type", "application/json");
  }
  const token = getAccessToken();
  if (token) h.set("Authorization", `Bearer ${token}`);
  // ⚠️ Bắt buộc encodeURIComponent: header HTTP chỉ nhận Latin-1, lý do
  // tiếng Việt có dấu sẽ làm trình duyệt ném lỗi trước khi request đi.
  if (reason && reason.trim()) {
    h.set("X-Admin-Reason", encodeURIComponent(reason.trim()));
  }

  try {
    const res = await fetch(url, { ...rest, headers: h });

    const totalHeader = res.headers.get("X-Total-Count");
    const totalCount =
      totalHeader !== null && totalHeader !== "" && !Number.isNaN(Number(totalHeader))
        ? Number(totalHeader)
        : undefined;

    if (!res.ok) {
      let body: unknown = null;
      try {
        body = await readBody(res);
      } catch {
        /* body không đọc được → dùng message mặc định */
      }
      const msg = extractMessage(body) ?? friendlyStatusMessage(res.status);
      return {
        ok: false,
        error: msg,
        status: res.status,
        ...(totalCount !== undefined ? { totalCount } : {}),
      };
    }

    const data = (await readBody(res)) as T | null;
    return {
      ok: true,
      data: (data ?? (undefined as unknown as T)),
      ...(totalCount !== undefined ? { totalCount } : {}),
    };
  } catch (err) {
    const raw = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      error: `Không kết nối được máy chủ. Vui lòng kiểm tra mạng và thử lại. (${raw})`,
    };
  }
}

function adminGet<T>(path: string): Promise<AdminApiResult<T>> {
  return adminFetch<T>(path, { method: "GET" });
}

function adminPost<T>(
  path: string,
  body?: unknown,
  reason?: string,
): Promise<AdminApiResult<T>> {
  return adminFetch<T>(path, {
    method: "POST",
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    ...(reason ? { reason } : {}),
  });
}

function adminPut<T>(
  path: string,
  body: unknown,
  reason?: string,
): Promise<AdminApiResult<T>> {
  return adminFetch<T>(path, {
    method: "PUT",
    body: JSON.stringify(body),
    ...(reason ? { reason } : {}),
  });
}

function adminDelete<T>(
  path: string,
  reason?: string,
): Promise<AdminApiResult<T>> {
  return adminFetch<T>(path, {
    method: "DELETE",
    ...(reason ? { reason } : {}),
  });
}

/** Ghép query string, bỏ qua các tham số rỗng. */
function qs(params: Record<string, string | number | boolean | undefined | null>): string {
  const sp = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === "") continue;
    sp.set(key, String(value));
  }
  const s = sp.toString();
  return s ? `?${s}` : "";
}

/* ================================================================
 * USERS — /api/admin/users
 * ================================================================ */

/** 1 dòng trong danh sách người dùng. */
export interface AdminUserListItemDto {
  id: string;
  email: string;
  fullName: string;
  role: string;
  onboardingCompleted: boolean;
  createdAt: string;
  /** Có giá trị → tài khoản đã bị khoá (xoá mềm). */
  deletedAt: string | null;
  currentPlanName: string | null;
  currentPlanEndAt: string | null;
}

export interface AdminPagedResultDto<T> {
  items: T[];
  page: number;
  pageSize: number;
  totalCount: number;
}

/** Gói đăng ký đang hiệu lực của 1 user (rút gọn trong chi tiết). */
export interface AdminUserSubscriptionDto {
  id: string;
  planId: string;
  planName: string;
  status: string;
  startAt: string;
  endAt: string;
  aiCallsUsed: number;
  aiCallLimit: number | null;
}

/** Giao dịch gần đây của 1 user. */
export interface AdminUserPaymentDto {
  id: string;
  orderCode: number;
  planName: string;
  amount: number;
  status: string;
  createdAt: string;
}

/** Chi tiết đầy đủ của 1 người dùng. */
export interface AdminUserDetailDto extends AdminUserListItemDto {
  timeZone: string | null;
  workDayStart: string | null;
  workDayEnd: string | null;
  worksOnWeekend: boolean;
  googleCalendarStatus: string | null;
  projectCount: number;
  taskCount: number;
  paymentCount: number;
  totalPaid: number;
  aiCallCount: number;
  subscriptions: AdminUserSubscriptionDto[];
  recentPayments: AdminUserPaymentDto[];
}

/** Body tạo/sửa người dùng. Field để trống → giữ nguyên (khi sửa). */
export interface AdminUserRequestDto {
  email?: string;
  fullName?: string;
  role?: string;
  timeZone?: string;
  workDayStart?: string;
  workDayEnd?: string;
  worksOnWeekend?: boolean;
  defaultBufferMinutes?: number;
  reminderLeadMinutes?: number;
}

export interface AdminUserListFilters {
  search?: string;
  role?: string;
  includeDeleted?: boolean;
  page?: number;
  pageSize?: number;
}

export async function listAdminUsers(
  filters: AdminUserListFilters = {},
): Promise<AdminApiResult<AdminPagedResultDto<AdminUserListItemDto>>> {
  return adminGet<AdminPagedResultDto<AdminUserListItemDto>>(
    `/api/admin/users${qs({
      search: filters.search,
      role: filters.role,
      includeDeleted: filters.includeDeleted,
      page: filters.page,
      pageSize: filters.pageSize,
    })}`,
  );
}

export async function getAdminUser(
  userId: string,
): Promise<AdminApiResult<AdminUserDetailDto>> {
  if (!userId) return { ok: false, error: "userId is required", status: 400 };
  return adminGet<AdminUserDetailDto>(
    `/api/admin/users/${encodeURIComponent(userId)}`,
  );
}

export async function createAdminUser(
  body: AdminUserRequestDto,
): Promise<AdminApiResult<AdminUserDetailDto>> {
  return adminPost<AdminUserDetailDto>("/api/admin/users", body);
}

/**
 * Sửa người dùng. Đổi `role` → BẮT BUỘC lý do (BE trả 400 nếu thiếu).
 */
export async function updateAdminUser(
  userId: string,
  body: AdminUserRequestDto,
  reason?: string,
): Promise<AdminApiResult<AdminUserDetailDto>> {
  if (!userId) return { ok: false, error: "userId is required", status: 400 };
  return adminPut<AdminUserDetailDto>(
    `/api/admin/users/${encodeURIComponent(userId)}`,
    body,
    reason,
  );
}

/** Khoá tài khoản (xoá mềm) — BẮT BUỘC lý do. */
export async function deleteAdminUser(
  userId: string,
  reason: string,
): Promise<AdminApiResult<void>> {
  if (!userId) return { ok: false, error: "userId is required", status: 400 };
  return adminDelete<void>(
    `/api/admin/users/${encodeURIComponent(userId)}`,
    reason,
  );
}

/** Khôi phục tài khoản đã khoá. */
export async function restoreAdminUser(
  userId: string,
): Promise<AdminApiResult<AdminUserDetailDto>> {
  if (!userId) return { ok: false, error: "userId is required", status: 400 };
  return adminPost<AdminUserDetailDto>(
    `/api/admin/users/${encodeURIComponent(userId)}/restore`,
  );
}

/* ================================================================
 * SUBSCRIPTION PLANS — /api/subscription-plans
 * ================================================================ */

export interface SubscriptionPlanDto {
  id: string;
  name: string;
  /** Giá (đồng). */
  price: number;
  durationDays: number;
  /** `null` = không giới hạn. */
  aiCallLimit: number | null;
  storageLimitMb: number | null;
  projectLimit: number | null;
  isActive: boolean;
}

export interface SubscriptionPlanRequestDto {
  name: string;
  price: number;
  durationDays: number;
  aiCallLimit: number | null;
  storageLimitMb: number | null;
  projectLimit: number | null;
  isActive: boolean;
}

/** Admin thấy TẤT CẢ gói, kể cả gói đã tắt. */
export async function listSubscriptionPlans(): Promise<
  AdminApiResult<SubscriptionPlanDto[]>
> {
  return adminGet<SubscriptionPlanDto[]>("/api/subscription-plans");
}

export async function createSubscriptionPlan(
  body: SubscriptionPlanRequestDto,
): Promise<AdminApiResult<SubscriptionPlanDto>> {
  return adminPost<SubscriptionPlanDto>("/api/subscription-plans", body);
}

/** Sửa gói — BẮT BUỘC lý do. */
export async function updateSubscriptionPlan(
  planId: string,
  body: SubscriptionPlanRequestDto,
  reason: string,
): Promise<AdminApiResult<SubscriptionPlanDto>> {
  if (!planId) return { ok: false, error: "planId is required", status: 400 };
  return adminPut<SubscriptionPlanDto>(
    `/api/subscription-plans/${encodeURIComponent(planId)}`,
    body,
    reason,
  );
}

/**
 * Xoá gói — BẮT BUỘC lý do.
 * Gói đã có người dùng/giao dịch → 400; hãy tắt (`isActive = false`) thay vì xoá.
 */
export async function deleteSubscriptionPlan(
  planId: string,
  reason: string,
): Promise<AdminApiResult<void>> {
  if (!planId) return { ok: false, error: "planId is required", status: 400 };
  return adminDelete<void>(
    `/api/subscription-plans/${encodeURIComponent(planId)}`,
    reason,
  );
}

/* ================================================================
 * REVENUE — /api/admin/revenue
 * ================================================================ */

export type RevenueGroupBy = "day" | "month" | "plan";

/**
 * Tổng doanh thu.
 *
 * ⚠️ BE đã **xoá** `refundedAmount` và `netRevenue` (bỏ hoàn tiền).
 * Doanh thu thực = `grossRevenue`.
 * Spec: `FE_CHANGES.md` mục 4.
 */
export interface RevenueTotalsDto {
  grossRevenue: number;
  succeededTransactions: number;
  averageOrderValue: number;
  invoicesIssued: number;
  newPayingUsers: number;
}

/**
 * 1 dòng doanh thu theo nhóm (ngày / tháng / gói).
 *
 * ⚠️ BE đã **xoá** `refunded` và `net` — dùng `revenue` (chính là doanh thu
 * thực).
 */
export interface RevenueRowDto {
  key: string;
  revenue: number;
  transactions: number;
  sharePercent: number;
}

export interface RevenueReportDto {
  from: string;
  to: string;
  groupBy: string;
  total: RevenueTotalsDto;
  rows: RevenueRowDto[];
  transactionsByStatus: Record<string, number>;
}

export interface RevenueQuery {
  groupBy?: RevenueGroupBy;
  /** ISO 8601, gồm `from`, không gồm `to`. Mặc định 30 ngày gần nhất. */
  from?: string;
  to?: string;
}

export async function getRevenueReport(
  query: RevenueQuery = {},
): Promise<AdminApiResult<RevenueReportDto>> {
  return adminGet<RevenueReportDto>(
    `/api/admin/revenue${qs({
      groupBy: query.groupBy ?? "day",
      from: query.from,
      to: query.to,
    })}`,
  );
}

/* ================================================================
 * GROUPS — /api/admin/groups  (chỉ role Admin)
 * ----------------------------------------------------------
 * Spec: `FE_CHANGES.md` mục 9.
 *
 * ⚠️ 2 thao tác ghi (`archive` / `restore`) BẮT BUỘC header `X-Admin-Reason`.
 * `adminFetch` đã tự encodeURIComponent lý do (header HTTP chỉ nhận Latin-1).
 *
 * Lưu ý: Admin KHÔNG cần là thành viên nhóm, nhưng KHÔNG thấy nội dung
 * bình luận hay lịch cá nhân của nhóm.
 * ================================================================ */

/** Trạng thái nhóm — `Active` hoặc `Archived`. */
export type AdminGroupStatus = "Active" | "Archived";

/** 1 dòng trong danh sách nhóm. */
export interface AdminGroupListItemDto {
  id: string;
  name: string;
  description: string | null;
  status: AdminGroupStatus | string;
  /** Chủ nhóm. */
  ownerId: string | null;
  ownerName: string | null;
  ownerEmail: string | null;
  /** Số thành viên. */
  memberCount: number;
  /** Số việc trong nhóm. */
  taskCount: number;
  createdAt: string;
}

/** Thống kê tổng quan nhóm. */
export interface AdminGroupStatsDto {
  totalGroups: number;
  activeGroups: number;
  archivedGroups: number;
  totalMembers: number;
  totalTasks: number;
  /** Số việc theo trạng thái. */
  tasksByStatus: Record<string, number>;
  /** Nhóm mới trong 30 ngày. */
  newGroupsLast30Days: number;
  /** Lời mời đang chờ. */
  pendingInvitations: number;
  /** Phiên bấm giờ đang chạy. */
  activeFocusSessions: number;
}

/** Thành viên trong chi tiết nhóm. */
export interface AdminGroupMemberDto {
  userId: string;
  fullName: string | null;
  email: string | null;
  /** `Leader` | `Member` | `Viewer`. */
  role: string;
  joinedAt: string | null;
}

/** Báo cáo tiến độ của nhóm. */
export interface AdminGroupProgressDto {
  totalTasks: number;
  completedTasks: number;
  /** 0–100. */
  progressPercent: number;
}

/** Chi tiết 1 nhóm. */
export interface AdminGroupDetailDto {
  id: string;
  name: string;
  description: string | null;
  status: AdminGroupStatus | string;
  ownerId: string | null;
  ownerName: string | null;
  ownerEmail: string | null;
  members: AdminGroupMemberDto[];
  progress: AdminGroupProgressDto | null;
  taskCount: number;
  memberCount: number;
  createdAt: string;
}

/** 1 dòng nhật ký hoạt động của nhóm. */
export interface AdminGroupActivityDto {
  id: string;
  action: string;
  actorName: string | null;
  actorEmail: string | null;
  /** Nội dung mô tả (JSON string hoặc text). */
  detail: string | null;
  createdAt: string;
}

export interface AdminGroupFilters {
  search?: string;
  status?: AdminGroupStatus;
  ownerId?: string;
  page?: number;
  pageSize?: number;
}

/**
 * `GET /api/admin/groups` — danh sách mọi nhóm.
 */
export async function listAdminGroups(
  filters: AdminGroupFilters = {},
): Promise<AdminApiResult<AdminPagedResultDto<AdminGroupListItemDto>>> {
  return adminGet<AdminPagedResultDto<AdminGroupListItemDto>>(
    `/api/admin/groups${qs({
      search: filters.search,
      status: filters.status,
      ownerId: filters.ownerId,
      page: filters.page,
      pageSize: filters.pageSize,
    })}`,
  );
}

/**
 * `GET /api/admin/groups/stats` — số liệu tổng quan nhóm.
 */
export async function getAdminGroupStats(): Promise<
  AdminApiResult<AdminGroupStatsDto>
> {
  return adminGet<AdminGroupStatsDto>("/api/admin/groups/stats");
}

/**
 * `GET /api/admin/groups/{id}` — chi tiết nhóm (chủ nhóm, thành viên, tiến độ).
 */
export async function getAdminGroup(
  groupId: string,
): Promise<AdminApiResult<AdminGroupDetailDto>> {
  if (!groupId) return { ok: false, error: "groupId is required", status: 400 };
  return adminGet<AdminGroupDetailDto>(
    `/api/admin/groups/${encodeURIComponent(groupId)}`,
  );
}

/**
 * `GET /api/admin/groups/{id}/activity` — nhật ký hoạt động của nhóm.
 */
export async function listAdminGroupActivity(
  groupId: string,
  params: { skip?: number; take?: number } = {},
): Promise<AdminApiResult<AdminGroupActivityDto[]>> {
  if (!groupId) return { ok: false, error: "groupId is required", status: 400 };
  return adminGet<AdminGroupActivityDto[]>(
    `/api/admin/groups/${encodeURIComponent(groupId)}/activity${qs({
      skip: params.skip,
      take: params.take,
    })}`,
  );
}

/**
 * `POST /api/admin/groups/{id}/archive` — lưu trữ nhóm.
 *
 * ⚠️ BẮT BUỘC lý do → BE trả `400` nếu thiếu. Nhóm đã `Archived` → `400`.
 * Ghi nhật ký admin + nhật ký nhóm + gửi thông báo `GroupStatusChanged`.
 */
export async function archiveAdminGroup(
  groupId: string,
  reason: string,
): Promise<AdminApiResult<void>> {
  if (!groupId) return { ok: false, error: "groupId is required", status: 400 };
  if (!reason.trim()) {
    return { ok: false, error: "Vui lòng nhập lý do thao tác.", status: 400 };
  }
  return adminPost<void>(
    `/api/admin/groups/${encodeURIComponent(groupId)}/archive`,
    undefined,
    reason,
  );
}

/**
 * `POST /api/admin/groups/{id}/restore` — khôi phục nhóm.
 *
 * ⚠️ BẮT BUỘC lý do → BE trả `400` nếu thiếu. Nhóm không `Archived` → `400`.
 */
export async function restoreAdminGroup(
  groupId: string,
  reason: string,
): Promise<AdminApiResult<void>> {
  if (!groupId) return { ok: false, error: "groupId is required", status: 400 };
  if (!reason.trim()) {
    return { ok: false, error: "Vui lòng nhập lý do thao tác.", status: 400 };
  }
  return adminPost<void>(
    `/api/admin/groups/${encodeURIComponent(groupId)}/restore`,
    undefined,
    reason,
  );
}

/* ================================================================
 * AUDIT LOGS — /api/admin/audit-logs
 * ================================================================ */

export interface AdminAuditLogDto {
  id: string;
  adminId: string;
  adminEmail: string;
  /** `<Bảng>.<Create|Update|Delete>`, riêng status-resync là `StatusResync.Run`. */
  action: string;
  targetType: string;
  targetId: string;
  /** JSON string (có thể null). */
  oldValue: string | null;
  newValue: string | null;
  /** Nội dung header `X-Admin-Reason`. */
  reason: string | null;
  createdAt: string;
}

export interface AdminAuditLogFilters {
  adminId?: string;
  targetType?: string;
  targetId?: string;
  action?: string;
  from?: string;
  to?: string;
  page?: number;
  pageSize?: number;
}

export async function listAdminAuditLogs(
  filters: AdminAuditLogFilters = {},
): Promise<AdminApiResult<AdminPagedResultDto<AdminAuditLogDto>>> {
  return adminGet<AdminPagedResultDto<AdminAuditLogDto>>(
    `/api/admin/audit-logs${qs({
      adminId: filters.adminId,
      targetType: filters.targetType,
      targetId: filters.targetId,
      action: filters.action,
      from: filters.from,
      to: filters.to,
      page: filters.page,
      pageSize: filters.pageSize,
    })}`,
  );
}

/* ================================================================
 * STATUS RESYNC — /api/admin/status-resync
 * ================================================================ */

export interface StatusResyncChangeDto {
  kind: string;
  id: string;
  name: string;
  from: string;
  to: string;
}

export interface StatusResyncReportDto {
  dryRun: boolean;
  tasksChecked: number;
  tasksChanged: number;
  milestonesChanged: number;
  slotsCancelled: number;
  changes: StatusResyncChangeDto[];
  truncated: boolean;
}

/**
 * Đồng bộ lại trạng thái dữ liệu cũ.
 * - `dryRun = true` (mặc định): chạy thử, không lưu, không cần lý do.
 * - `dryRun = false`: chạy thật → BẮT BUỘC lý do.
 */
export async function runStatusResync(
  dryRun: boolean,
  reason?: string,
): Promise<AdminApiResult<StatusResyncReportDto>> {
  return adminPost<StatusResyncReportDto>(
    `/api/admin/status-resync${qs({ dryRun })}`,
    undefined,
    dryRun ? undefined : reason,
  );
}

/* ================================================================
 * PAYMENT TRANSACTIONS — /api/payment-transactions
 * ================================================================ */

export interface PaymentTransactionDto {
  id: string;
  userId: string;
  planId: string;
  orderCode: number;
  gateway: string;
  amount: number;
  status: string;
  createdAt: string;
  expiresAt: string | null;
  paidAt: string | null;
  webhookReceivedAt: string | null;
}

export interface PaymentTransactionFilters {
  status?: string;
  userId?: string;
  planId?: string;
  from?: string;
  to?: string;
  page?: number;
  pageSize?: number;
}

export async function listPaymentTransactions(
  filters: PaymentTransactionFilters = {},
): Promise<AdminApiResult<PaymentTransactionDto[]>> {
  return adminGet<PaymentTransactionDto[]>(
    `/api/payment-transactions${qs({
      status: filters.status,
      userId: filters.userId,
      planId: filters.planId,
      from: filters.from,
      to: filters.to,
      page: filters.page,
      pageSize: filters.pageSize,
    })}`,
  );
}

/* ================================================================
 * INVOICES — /api/invoices
 * ================================================================ */

export interface InvoiceDto {
  id: string;
  paymentTransactionId: string;
  invoiceNumber: string;
  planName: string;
  amount: number;
  billingName: string;
  billingEmail: string;
  periodStart: string;
  periodEnd: string;
  issuedAt: string;
}

export interface InvoiceFilters {
  userId?: string;
  from?: string;
  to?: string;
  search?: string;
  page?: number;
  pageSize?: number;
}

export async function listInvoices(
  filters: InvoiceFilters = {},
): Promise<AdminApiResult<InvoiceDto[]>> {
  return adminGet<InvoiceDto[]>(
    `/api/invoices${qs({
      userId: filters.userId,
      from: filters.from,
      to: filters.to,
      search: filters.search,
      page: filters.page,
      pageSize: filters.pageSize,
    })}`,
  );
}
