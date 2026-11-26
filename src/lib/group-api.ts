/**
 * ===========================================================
 * API client cho NHÁNH GROUP (nhóm làm việc).
 * ===========================================================
 *
 * Theo spec BE: `GROUP_FE.md`.
 *
 * - Mọi endpoint đều cần `Authorization: Bearer ...` → dùng `get/put/post/del`
 *   từ `api-client.ts` (đã tự refresh token, tự parse lỗi, trả
 *   `{ ok, data }` | `{ ok, error, status, details, errorCode }`).
 * - JSON camelCase, id là uuid string, thời gian là ISO 8601, ngày là
 *   `yyyy-MM-dd`.
 * - Mọi danh sách trả về là mảng (rỗng nếu không có), KHÔNG phân trang
 *   (trừ nhật ký hoạt động dùng `skip`/`take`).
 *
 * ⚠️ Nhánh cá nhân (`/api/projects`, `/api/tasks`…) KHÔNG đổi — file này
 *   chỉ thêm phần group, không sửa logic cũ.
 */

import { del, get, post, put, type ApiResult } from "./api-client";

/* ===========================================================
 * Enum / type dùng chung
 * =========================================================== */

/** Vai trò thành viên trong nhóm. */
export const GROUP_ROLES = ["Leader", "Member", "Viewer"] as const;
export type GroupRole = (typeof GROUP_ROLES)[number];

/** Trạng thái nhóm. */
export type GroupStatus = "Active" | "Archived";

/** Trạng thái việc / việc con. */
export type GroupTaskStatus = "ToDo" | "InProgress" | "Done" | "Skipped";

/** Trạng thái giai đoạn (milestone). */
export type GroupMilestoneStatus =
  | "Planned"
  | "InProgress"
  | "Delivered"
  | "InRevision"
  | "Approved";

/** Mức ưu tiên. */
export type GroupPriority = "Low" | "Medium" | "High";

/** Trạng thái lời mời. */
export type GroupInvitationStatus =
  | "Pending"
  | "Accepted"
  | "Declined"
  | "Expired"
  | "Revoked";

/** Trạng thái đề xuất đổi giờ. */
export type GroupChangeRequestStatus =
  | "Pending"
  | "Approved"
  | "Rejected"
  | "Cancelled";

/** Lý do dừng phiên làm việc của nhóm. */
export type GroupFocusStopReason =
  | "Completed"
  | "Interrupted"
  | "Blocked"
  | "Other";

/** Nguồn của khoảng bận (người nhận đã có lịch trùng). */
export type GroupBusySource = "PersonalSchedule" | "GoogleCalendar" | "GroupTask";

/** Loại thông báo của nhóm. */
export type GroupNotificationType =
  | "GroupInvited"
  | "GroupAssigned"
  | "GroupStatusChanged"
  | "GroupMention"
  | "GroupChangeRequested"
  | "GroupChangeDecided";

/* ===========================================================
 * DTO — response
 * =========================================================== */

export interface GroupDto {
  id: string;
  name: string;
  description?: string | null;
  ownerId: string;
  startDate?: string | null;
  deadline?: string | null;
  status: GroupStatus | string;
  createdAt: string;
  /** Vai trò của người đang gọi trong nhóm này (Leader | Member | Viewer). */
  myRole: GroupRole | string;
  memberCount: number;
}

export interface GroupMemberDto {
  userId: string;
  fullName: string;
  email: string;
  role: GroupRole | string;
  joinedAt: string;
}

export interface GroupInvitationDto {
  id: string;
  groupId: string;
  groupName: string;
  email: string;
  role: GroupRole | string;
  status: GroupInvitationStatus | string;
  invitedById: string;
  invitedByName: string;
  createdAt: string;
  expiresAt: string;
  respondedAt?: string | null;
}

/** Kết quả tạo lời mời — có thêm `acceptToken` (chỉ trả 1 lần). */
export interface GroupInvitationCreatedDto extends GroupInvitationDto {
  acceptToken: string;
}

export interface GroupMilestoneDto {
  id: string;
  groupId: string;
  name: string;
  orderIndex: number;
  dueDate?: string | null;
  status: GroupMilestoneStatus | string;
  deliveredAt?: string | null;
  revisionCount: number;
}

/** Việc còn mở trong giai đoạn (dùng cho cảnh báo 409). */
export interface GroupOpenTaskDto {
  id: string;
  title: string;
  status: GroupTaskStatus | string;
  openSubTaskCount: number;
}

export interface GroupTaskDto {
  id: string;
  groupId: string;
  milestoneId?: string | null;
  assigneeId?: string | null;
  assigneeName?: string | null;
  title: string;
  description?: string | null;
  priority: GroupPriority | string;
  status: GroupTaskStatus | string;
  deadline?: string | null;
  /** Giờ cố định (họp, hẹn) — ISO 8601. */
  fixedStart?: string | null;
  fixedEnd?: string | null;
  estimatedMinutes?: number | null;
  subTaskCount: number;
  subTaskDoneCount: number;
  createdAt: string;
  completedAt?: string | null;
}

export interface GroupSubTaskDto {
  id: string;
  groupTaskId: string;
  assigneeId?: string | null;
  assigneeName?: string | null;
  title: string;
  estimatedMinutes?: number | null;
  orderIndex: number;
  status: GroupTaskStatus | string;
  completedById?: string | null;
  completedAt?: string | null;
}

export interface GroupCommentDto {
  id: string;
  groupTaskId: string;
  authorId: string;
  authorName: string;
  content: string;
  createdAt: string;
  editedAt?: string | null;
}

export interface GroupActivityDto {
  id: string;
  actorId: string;
  actorName: string;
  entityType: string;
  entityId?: string | null;
  action: string;
  oldValue?: string | null;
  newValue?: string | null;
  createdAt: string;
}

export interface GroupMemberProgressDto {
  userId: string;
  fullName: string;
  role: GroupRole | string;
  assignedTasks: number;
  doneTasks: number;
  assignedSubTasks: number;
  doneSubTasks: number;
  /** Giờ làm thực tế của người này trong nhóm (phút). */
  trackedMinutes: number;
  /* ---- Bộ đếm tín hiệu tiến độ (mục 10 của cập nhật BE) ---- */
  /** Việc đã quá hạn mà chưa xong. */
  overdueTasks?: number;
  /** Việc chưa có khung giờ nào trên lịch. */
  unscheduledTasks?: number;
  /** Việc có nguy cơ trễ hạn. */
  atRiskTasks?: number;
  /** Việc đứng yên (không có tiến độ trong thời gian đáng lẽ). */
  staleTasks?: number;
}

/* ===========================================================
 * Tín hiệu tiến độ của nhóm (mục 10 của cập nhật BE)
 * ----------------------------------------------------------
 * `GET /api/groups/{id}/progress` trả thêm `signals` — tóm tắt 4 loại
 * rủi ro để FE hiển thị ngay: quá hạn, chưa có lịch, nguy cơ trễ,
 * đứng yên.
 * =========================================================== */

/** Loại tín hiệu tiến độ. */
export type GroupSignalType =
  | "Overdue"
  | "Unscheduled"
  | "AtRisk"
  | "Stale";

export interface GroupSignalDto {
  /** Loại tín hiệu — dùng để chọn icon + màu. */
  type: GroupSignalType | string;
  /** Số việc bị ảnh hưởng. */
  count: number;
  /** Danh sách việc cụ thể (có thể rỗng nếu BE chỉ gửi tổng). */
  taskIds?: string[];
  /** Tiêu đề việc (kèm theo `taskIds` nếu BE gửi). */
  taskTitles?: string[];
  /** Ghi chú giải thích thêm (VD: "3 tasks have no time slot yet"). */
  message?: string | null;
}

export interface GroupMilestoneProgressDto {
  milestoneId: string;
  name: string;
  status: GroupMilestoneStatus | string;
  dueDate?: string | null;
  totalTasks: number;
  doneTasks: number;
}

export interface GroupProgressDto {
  groupId: string;
  totalTasks: number;
  /** Tổng giờ làm thực tế của cả nhóm (phút). */
  totalTrackedMinutes: number;
  totalEstimatedMinutes: number;
  tasksByStatus: Record<string, number>;
  remainingTasks: number;
  unassignedTasks: number;
  completedPercent: number;
  members: GroupMemberProgressDto[];
  milestones: GroupMilestoneProgressDto[];
  /**
   * Tín hiệu tiến độ (mục 10 của cập nhật BE) — quá hạn, chưa có lịch,
   * nguy cơ trễ, đứng yên. Có thể rỗng nếu BE cũ chưa trả.
   */
  signals?: GroupSignalDto[];
}

export interface MyGroupTaskDto {
  taskId: string;
  groupId: string;
  groupName: string;
  title: string;
  status: GroupTaskStatus | string;
  priority: GroupPriority | string;
  deadline?: string | null;
  fixedStart?: string | null;
  fixedEnd?: string | null;
}

export interface MyGroupSubTaskDto {
  subTaskId: string;
  taskId: string;
  groupId: string;
  groupName: string;
  taskTitle: string;
  title: string;
  status: GroupTaskStatus | string;
}

export interface MyGroupWorkDto {
  tasks: MyGroupTaskDto[];
  subTasks: MyGroupSubTaskDto[];
}

/* ---------- Focus (đợt 2) ---------- */

export interface GroupFocusStartResponseDto {
  sessionId: string;
  groupTaskId: string;
  subTaskId?: string | null;
  /**
   * Slot đã chọn khi bấm Start (mục 10 của cập nhật BE).
   *
   * BE gửi kèm `scheduleSlotId` trong body Start → FE dùng để biết đang
   * làm đúng khung giờ nào (hiển thị trên UI + đồng bộ với lịch).
   */
  scheduleSlotId?: string | null;
  startedAt: string;
  taskStatus: GroupTaskStatus | string;
  subTaskStatus?: GroupTaskStatus | string | null;
}

export interface GroupFocusStopResponseDto {
  sessionId: string;
  endedAt: string;
  sessionMinutes: number;
  myTaskMinutes: number;
  taskTotalMinutes: number;
  taskStatus: GroupTaskStatus | string;
  subTaskStatus?: GroupTaskStatus | string | null;
  /** True khi phiên bị cắt theo giới hạn 12 giờ (quên bấm Stop). */
  wasCapped: boolean;
}

export interface GroupFocusSessionDto {
  id: string;
  groupTaskId: string;
  subTaskId?: string | null;
  userId: string;
  userName: string;
  startedAt: string;
  endedAt?: string | null;
  minutes: number;
  isRunning: boolean;
  stopReason?: GroupFocusStopReason | string | null;
  note?: string | null;
}

export interface GroupFocusCurrentDto {
  sessionId: string;
  groupId: string;
  groupName: string;
  groupTaskId: string;
  taskTitle: string;
  subTaskId?: string | null;
  subTaskTitle?: string | null;
  /**
   * Slot đang chạy (mục 10 của cập nhật BE) — `null` nếu phiên được bắt
   * đầu mà không chọn slot.
   */
  scheduleSlotId?: string | null;
  startedAt: string;
  elapsedSeconds: number;
  serverTime: string;
  estimatedMinutes?: number | null;
}

export interface GroupTimeByUserDto {
  userId: string;
  fullName: string;
  minutes: number;
  sessionCount: number;
}

export interface GroupTimeBySubTaskDto {
  subTaskId?: string | null;
  title?: string | null;
  minutes: number;
}

export interface GroupTaskTimeDto {
  groupTaskId: string;
  estimatedMinutes?: number | null;
  totalMinutes: number;
  sessionCount: number;
  byUser: GroupTimeByUserDto[];
  bySubTask: GroupTimeBySubTaskDto[];
  sessions: GroupFocusSessionDto[];
}

/* ---------- Đề xuất đổi giờ (đợt 2) ---------- */

export interface GroupBusyPeriodDto {
  start: string;
  end: string;
  source: GroupBusySource | string;
}

export interface GroupWorkloadDto {
  assignedMinutes: number;
  capacityMinutes: number;
  isOverloaded: boolean;
}

export interface GroupAssigneeAvailabilityDto {
  assigneeId: string;
  isBusy: boolean;
  conflicts: GroupBusyPeriodDto[];
  workload?: GroupWorkloadDto | null;
  needsConfirmation: boolean;
}

export interface GroupChangeRequestDto {
  id: string;
  groupTaskId: string;
  taskTitle: string;
  requestedById: string;
  requestedByName: string;
  currentFixedStart?: string | null;
  currentFixedEnd?: string | null;
  currentDeadline?: string | null;
  newFixedStart?: string | null;
  newFixedEnd?: string | null;
  newDeadline?: string | null;
  reason: string;
  status: GroupChangeRequestStatus | string;
  decidedById?: string | null;
  decidedByName?: string | null;
  decidedAt?: string | null;
  decisionNote?: string | null;
  createdAt: string;
}

/* ===========================================================
 * DTO — request
 * =========================================================== */

export interface GroupRequest {
  name: string;
  description?: string | null;
  startDate?: string | null;
  deadline?: string | null;
}

export interface GroupMemberRoleRequest {
  role: GroupRole | string;
}

export interface GroupInvitationRequest {
  email: string;
  role?: GroupRole | string;
}

export interface GroupInvitationTokenRequest {
  token: string;
}

export interface GroupMilestoneRequest {
  name: string;
  orderIndex: number;
  dueDate?: string | null;
  status?: GroupMilestoneStatus | string | null;
  /** Vẫn chuyển sang Delivered dù còn việc chưa xong (sau khi đã nhận 409). */
  confirmOpenTasks?: boolean;
}

export interface GroupTaskRequest {
  title: string;
  description?: string | null;
  priority?: GroupPriority | string | null;
  milestoneId?: string | null;
  assigneeId?: string | null;
  deadline?: string | null;
  estimatedMinutes?: number | null;
  fixedStart?: string | null;
  fixedEnd?: string | null;
  /** Vẫn giao dù người nhận bận/quá tải (sau khi đã nhận 409). */
  confirmConflicts?: boolean;
}

export interface GroupTaskStatusRequest {
  status: GroupTaskStatus | string;
}

export interface GroupAssigneeRequest {
  assigneeId?: string | null;
  confirmConflicts?: boolean;
}

export interface GroupSubTaskRequest {
  title: string;
  estimatedMinutes?: number | null;
  orderIndex?: number | null;
  assigneeId?: string | null;
}

export interface GroupCommentRequest {
  content: string;
}

export interface GroupFocusStartRequest {
  subTaskId?: string | null;
  /**
   * Slot nhóm được chọn khi bấm Start (mục 10 của cập nhật BE).
   *
   * Gửi kèm để BE biết phiên này gắn với khung giờ nào.
   */
  scheduleSlotId?: string | null;
}

export interface GroupFocusStopRequest {
  stopReason: GroupFocusStopReason | string;
  note?: string | null;
}

export interface GroupChangeRequestCreate {
  newFixedStart?: string | null;
  newFixedEnd?: string | null;
  newDeadline?: string | null;
  reason: string;
}

export interface GroupChangeDecision {
  note?: string | null;
  confirmConflicts?: boolean;
}

/* ===========================================================
 * Chi tiết lỗi 409 — parse từ `details` của ApiErr
 * =========================================================== */

/**
 * Chi tiết lỗi 409 `GROUP_ASSIGNEE_BUSY`.
 *
 * BE trả:
 * ```json
 * { "code": "GROUP_ASSIGNEE_BUSY", "message": "...",
 *   "details": { "assigneeId": "guid", "isBusy": true,
 *     "conflicts": [ { "start": "...", "end": "...", "source": "PersonalSchedule" } ],
 *     "workload": { "assignedMinutes": 3500, "capacityMinutes": 3000,
 *                   "isOverloaded": true } } }
 * ```
 */
export interface GroupAssigneeBusyDetails {
  assigneeId: string;
  isBusy: boolean;
  conflicts: GroupBusyPeriodDto[];
  workload: GroupWorkloadDto | null;
}

/**
 * Đọc `details` của lỗi 409 `GROUP_ASSIGNEE_BUSY` → null nếu shape lệch.
 */
export function parseAssigneeBusyDetails(
  details: unknown,
): GroupAssigneeBusyDetails | null {
  if (!details || typeof details !== "object") return null;
  const d = details as Record<string, unknown>;
  const conflictsRaw = Array.isArray(d.conflicts) ? d.conflicts : [];
  const conflicts: GroupBusyPeriodDto[] = conflictsRaw
    .filter((c): c is Record<string, unknown> => !!c && typeof c === "object")
    .map((c) => ({
      start: typeof c.start === "string" ? c.start : "",
      end: typeof c.end === "string" ? c.end : "",
      source: (typeof c.source === "string" ? c.source : "PersonalSchedule") as
        | GroupBusySource
        | string,
    }));
  const wl =
    d.workload && typeof d.workload === "object"
      ? (d.workload as Record<string, unknown>)
      : null;
  return {
    assigneeId: typeof d.assigneeId === "string" ? d.assigneeId : "",
    isBusy: d.isBusy === true,
    conflicts,
    workload: wl
      ? {
          assignedMinutes:
            typeof wl.assignedMinutes === "number" ? wl.assignedMinutes : 0,
          capacityMinutes:
            typeof wl.capacityMinutes === "number" ? wl.capacityMinutes : 0,
          isOverloaded: wl.isOverloaded === true,
        }
      : null,
  };
}

/**
 * Chi tiết lỗi 409 `MILESTONE_HAS_OPEN_TASKS`.
 *
 * BE trả `{ openTaskCount, openSubTaskCount, tasks: [...] }`.
 */
export interface GroupMilestoneOpenTasksDetails {
  openTaskCount: number;
  openSubTaskCount: number;
  tasks: GroupOpenTaskDto[];
}

/** Đọc `details` của lỗi 409 `MILESTONE_HAS_OPEN_TASKS`. */
export function parseMilestoneOpenTasksDetails(
  details: unknown,
): GroupMilestoneOpenTasksDetails | null {
  if (!details || typeof details !== "object") return null;
  const d = details as Record<string, unknown>;
  const tasksRaw = Array.isArray(d.tasks) ? d.tasks : [];
  const tasks: GroupOpenTaskDto[] = tasksRaw
    .filter((t): t is Record<string, unknown> => !!t && typeof t === "object")
    .map((t) => ({
      id: typeof t.id === "string" ? t.id : "",
      title: typeof t.title === "string" ? t.title : "(không rõ tên)",
      status: (typeof t.status === "string" ? t.status : "ToDo") as
        | GroupTaskStatus
        | string,
      openSubTaskCount:
        typeof t.openSubTaskCount === "number" ? t.openSubTaskCount : 0,
    }));
  return {
    openTaskCount:
      typeof d.openTaskCount === "number" ? d.openTaskCount : tasks.length,
    openSubTaskCount:
      typeof d.openSubTaskCount === "number" ? d.openSubTaskCount : 0,
    tasks,
  };
}

/* ===========================================================
 * 2. Nhóm và thành viên
 * =========================================================== */

/** GET /api/groups?includeArchived=false — nhóm của tôi. */
export async function listGroups(params?: {
  includeArchived?: boolean;
}): Promise<ApiResult<GroupDto[]>> {
  const qs = new URLSearchParams();
  qs.set("includeArchived", String(params?.includeArchived ?? false));
  return get<GroupDto[]>(`/api/groups?${qs.toString()}`);
}

/** POST /api/groups — người tạo thành Leader. */
export async function createGroup(
  body: GroupRequest,
): Promise<ApiResult<GroupDto>> {
  return post<GroupDto>("/api/groups", body);
}

/** GET /api/groups/{id} — kèm `myRole`. */
export async function getGroup(groupId: string): Promise<ApiResult<GroupDto>> {
  return get<GroupDto>(`/api/groups/${encodeURIComponent(groupId)}`);
}

/** PUT /api/groups/{id} — Leader. */
export async function updateGroup(
  groupId: string,
  body: GroupRequest,
): Promise<ApiResult<GroupDto>> {
  return put<GroupDto>(`/api/groups/${encodeURIComponent(groupId)}`, body);
}

/** POST /api/groups/{id}/archive */
export async function archiveGroup(
  groupId: string,
): Promise<ApiResult<void>> {
  return post<void>(`/api/groups/${encodeURIComponent(groupId)}/archive`);
}

/** POST /api/groups/{id}/restore */
export async function restoreGroup(
  groupId: string,
): Promise<ApiResult<void>> {
  return post<void>(`/api/groups/${encodeURIComponent(groupId)}/restore`);
}

/** GET /api/groups/{id}/members */
export async function listGroupMembers(
  groupId: string,
): Promise<ApiResult<GroupMemberDto[]>> {
  return get<GroupMemberDto[]>(
    `/api/groups/${encodeURIComponent(groupId)}/members`,
  );
}

/** PUT /api/groups/{id}/members/{userId} — đổi vai trò. Hạ Leader cuối → 400. */
export async function updateGroupMemberRole(
  groupId: string,
  userId: string,
  body: GroupMemberRoleRequest,
): Promise<ApiResult<void>> {
  return put<void>(
    `/api/groups/${encodeURIComponent(groupId)}/members/${encodeURIComponent(userId)}`,
    body,
  );
}

/** DELETE /api/groups/{id}/members/{userId} — Leader xoá. 204. */
export async function removeGroupMember(
  groupId: string,
  userId: string,
): Promise<ApiResult<void>> {
  return del<void>(
    `/api/groups/${encodeURIComponent(groupId)}/members/${encodeURIComponent(userId)}`,
  );
}

/** POST /api/groups/{id}/leave — tự rời. Leader cuối không rời được (400). */
export async function leaveGroup(groupId: string): Promise<ApiResult<void>> {
  return post<void>(`/api/groups/${encodeURIComponent(groupId)}/leave`);
}

/* ===========================================================
 * 3. Lời mời
 * =========================================================== */

/** POST /api/groups/{id}/invitations — Leader. Trả `acceptToken` (1 lần). */
export async function createGroupInvitation(
  groupId: string,
  body: GroupInvitationRequest,
): Promise<ApiResult<GroupInvitationCreatedDto>> {
  return post<GroupInvitationCreatedDto>(
    `/api/groups/${encodeURIComponent(groupId)}/invitations`,
    body,
  );
}

/** GET /api/groups/{id}/invitations — Leader. */
export async function listGroupInvitations(
  groupId: string,
): Promise<ApiResult<GroupInvitationDto[]>> {
  return get<GroupInvitationDto[]>(
    `/api/groups/${encodeURIComponent(groupId)}/invitations`,
  );
}

/** DELETE /api/groups/{id}/invitations/{invId} — thu hồi. 204. */
export async function revokeGroupInvitation(
  groupId: string,
  invitationId: string,
): Promise<ApiResult<void>> {
  return del<void>(
    `/api/groups/${encodeURIComponent(groupId)}/invitations/${encodeURIComponent(invitationId)}`,
  );
}

/** GET /api/group-invitations — lời mời đang chờ gửi tới TÔI. */
export async function listMyGroupInvitations(): Promise<
  ApiResult<GroupInvitationDto[]>
> {
  return get<GroupInvitationDto[]>("/api/group-invitations");
}

/** POST /api/group-invitations/{id}/accept — trả GroupDto (có `myRole`). */
export async function acceptGroupInvitation(
  invitationId: string,
): Promise<ApiResult<GroupDto>> {
  return post<GroupDto>(
    `/api/group-invitations/${encodeURIComponent(invitationId)}/accept`,
  );
}

/** POST /api/group-invitations/accept-by-token — body `{ token }`. */
export async function acceptGroupInvitationByToken(
  token: string,
): Promise<ApiResult<GroupDto>> {
  return post<GroupDto>("/api/group-invitations/accept-by-token", { token });
}

/** POST /api/group-invitations/{id}/decline — 204. */
export async function declineGroupInvitation(
  invitationId: string,
): Promise<ApiResult<void>> {
  return post<void>(
    `/api/group-invitations/${encodeURIComponent(invitationId)}/decline`,
  );
}

/* ===========================================================
 * 4. Giai đoạn, việc, việc con
 * =========================================================== */

/** GET /api/groups/{id}/milestones */
export async function listGroupMilestones(
  groupId: string,
): Promise<ApiResult<GroupMilestoneDto[]>> {
  return get<GroupMilestoneDto[]>(
    `/api/groups/${encodeURIComponent(groupId)}/milestones`,
  );
}

/** POST /api/groups/{id}/milestones */
export async function createGroupMilestone(
  groupId: string,
  body: GroupMilestoneRequest,
): Promise<ApiResult<GroupMilestoneDto>> {
  return post<GroupMilestoneDto>(
    `/api/groups/${encodeURIComponent(groupId)}/milestones`,
    body,
  );
}

/** GET /api/group-milestones/{id} */
export async function getGroupMilestone(
  milestoneId: string,
): Promise<ApiResult<GroupMilestoneDto>> {
  return get<GroupMilestoneDto>(
    `/api/group-milestones/${encodeURIComponent(milestoneId)}`,
  );
}

/** PUT /api/group-milestones/{id} — Leader. */
export async function updateGroupMilestone(
  milestoneId: string,
  body: GroupMilestoneRequest,
): Promise<ApiResult<GroupMilestoneDto>> {
  return put<GroupMilestoneDto>(
    `/api/group-milestones/${encodeURIComponent(milestoneId)}`,
    body,
  );
}

/** DELETE /api/group-milestones/{id} — Leader. */
export async function deleteGroupMilestone(
  milestoneId: string,
): Promise<ApiResult<void>> {
  return del<void>(`/api/group-milestones/${encodeURIComponent(milestoneId)}`);
}

/** GET /api/groups/{id}/tasks?status=&assigneeId=&milestoneId= */
export async function listGroupTasks(
  groupId: string,
  params?: {
    status?: string | null;
    assigneeId?: string | null;
    milestoneId?: string | null;
  },
): Promise<ApiResult<GroupTaskDto[]>> {
  const qs = new URLSearchParams();
  if (params?.status) qs.set("status", params.status);
  if (params?.assigneeId) qs.set("assigneeId", params.assigneeId);
  if (params?.milestoneId) qs.set("milestoneId", params.milestoneId);
  const suffix = qs.toString() ? `?${qs.toString()}` : "";
  return get<GroupTaskDto[]>(
    `/api/groups/${encodeURIComponent(groupId)}/tasks${suffix}`,
  );
}

/** POST /api/groups/{id}/tasks — Leader. */
export async function createGroupTask(
  groupId: string,
  body: GroupTaskRequest,
): Promise<ApiResult<GroupTaskDto>> {
  return post<GroupTaskDto>(
    `/api/groups/${encodeURIComponent(groupId)}/tasks`,
    body,
  );
}

/** GET /api/group-tasks/{id} */
export async function getGroupTask(
  taskId: string,
): Promise<ApiResult<GroupTaskDto>> {
  return get<GroupTaskDto>(`/api/group-tasks/${encodeURIComponent(taskId)}`);
}

/**
 * PUT /api/group-tasks/{id} — Leader.
 * ⚠️ PUT KHÔNG đổi status và người được giao (dùng endpoint riêng cho 2 việc đó).
 */
export async function updateGroupTask(
  taskId: string,
  body: GroupTaskRequest,
): Promise<ApiResult<GroupTaskDto>> {
  return put<GroupTaskDto>(`/api/group-tasks/${encodeURIComponent(taskId)}`, body);
}

/** DELETE /api/group-tasks/{id} — Leader. */
export async function deleteGroupTask(
  taskId: string,
): Promise<ApiResult<void>> {
  return del<void>(`/api/group-tasks/${encodeURIComponent(taskId)}`);
}

/** PUT /api/group-tasks/{id}/status — body `{ status }`. */
export async function updateGroupTaskStatus(
  taskId: string,
  body: GroupTaskStatusRequest,
): Promise<ApiResult<GroupTaskDto>> {
  return put<GroupTaskDto>(
    `/api/group-tasks/${encodeURIComponent(taskId)}/status`,
    body,
  );
}

/**
 * PUT /api/group-tasks/{id}/assignee — Leader. Body `{ assigneeId | null }`.
 *
 * ⚠️ `confirmConflicts` chỉ áp dụng cho VIỆC, không áp dụng cho việc con.
 */
export async function updateGroupTaskAssignee(
  taskId: string,
  body: GroupAssigneeRequest,
): Promise<ApiResult<GroupTaskDto>> {
  return put<GroupTaskDto>(
    `/api/group-tasks/${encodeURIComponent(taskId)}/assignee`,
    body,
  );
}

/** GET /api/group-tasks/{id}/subtasks */
export async function listGroupSubTasks(
  taskId: string,
): Promise<ApiResult<GroupSubTaskDto[]>> {
  return get<GroupSubTaskDto[]>(
    `/api/group-tasks/${encodeURIComponent(taskId)}/subtasks`,
  );
}

/** POST /api/group-tasks/{id}/subtasks */
export async function createGroupSubTask(
  taskId: string,
  body: GroupSubTaskRequest,
): Promise<ApiResult<GroupSubTaskDto>> {
  return post<GroupSubTaskDto>(
    `/api/group-tasks/${encodeURIComponent(taskId)}/subtasks`,
    body,
  );
}

/** GET /api/group-subtasks/{id} */
export async function getGroupSubTask(
  subTaskId: string,
): Promise<ApiResult<GroupSubTaskDto>> {
  return get<GroupSubTaskDto>(
    `/api/group-subtasks/${encodeURIComponent(subTaskId)}`,
  );
}

/** PUT /api/group-subtasks/{id} */
export async function updateGroupSubTask(
  subTaskId: string,
  body: GroupSubTaskRequest,
): Promise<ApiResult<GroupSubTaskDto>> {
  return put<GroupSubTaskDto>(
    `/api/group-subtasks/${encodeURIComponent(subTaskId)}`,
    body,
  );
}

/** DELETE /api/group-subtasks/{id} */
export async function deleteGroupSubTask(
  subTaskId: string,
): Promise<ApiResult<void>> {
  return del<void>(`/api/group-subtasks/${encodeURIComponent(subTaskId)}`);
}

/**
 * PUT /api/group-subtasks/{id}/status — body `{ status }`.
 *
 * ⚠️ Sau khi đổi, PHẢI gọi lại việc cha (`getGroupTask`) vì status việc cha
 * có thể tự suy theo việc con.
 */
export async function updateGroupSubTaskStatus(
  subTaskId: string,
  body: GroupTaskStatusRequest,
): Promise<ApiResult<GroupSubTaskDto>> {
  return put<GroupSubTaskDto>(
    `/api/group-subtasks/${encodeURIComponent(subTaskId)}/status`,
    body,
  );
}

/** PUT /api/group-subtasks/{id}/assignee — Leader. */
export async function updateGroupSubTaskAssignee(
  subTaskId: string,
  body: GroupAssigneeRequest,
): Promise<ApiResult<GroupSubTaskDto>> {
  return put<GroupSubTaskDto>(
    `/api/group-subtasks/${encodeURIComponent(subTaskId)}/assignee`,
    body,
  );
}

/* ===========================================================
 * 5. Bình luận, nhật ký, tiến độ, việc của tôi
 * =========================================================== */

/** GET /api/group-tasks/{id}/comments */
export async function listGroupComments(
  taskId: string,
): Promise<ApiResult<GroupCommentDto[]>> {
  return get<GroupCommentDto[]>(
    `/api/group-tasks/${encodeURIComponent(taskId)}/comments`,
  );
}

/** POST /api/group-tasks/{id}/comments — nhắc tên bằng `@email`. */
export async function createGroupComment(
  taskId: string,
  body: GroupCommentRequest,
): Promise<ApiResult<GroupCommentDto>> {
  return post<GroupCommentDto>(
    `/api/group-tasks/${encodeURIComponent(taskId)}/comments`,
    body,
  );
}

/** PUT /api/group-comments/{id} — chỉ tác giả. */
export async function updateGroupComment(
  commentId: string,
  body: GroupCommentRequest,
): Promise<ApiResult<GroupCommentDto>> {
  return put<GroupCommentDto>(
    `/api/group-comments/${encodeURIComponent(commentId)}`,
    body,
  );
}

/** DELETE /api/group-comments/{id} — tác giả hoặc Leader. */
export async function deleteGroupComment(
  commentId: string,
): Promise<ApiResult<void>> {
  return del<void>(`/api/group-comments/${encodeURIComponent(commentId)}`);
}

/** GET /api/groups/{id}/activity?skip=0&take=50 — mới nhất trước. */
export async function listGroupActivity(
  groupId: string,
  params?: { skip?: number; take?: number },
): Promise<ApiResult<GroupActivityDto[]>> {
  const qs = new URLSearchParams();
  qs.set("skip", String(params?.skip ?? 0));
  qs.set("take", String(params?.take ?? 50));
  return get<GroupActivityDto[]>(
    `/api/groups/${encodeURIComponent(groupId)}/activity?${qs.toString()}`,
  );
}

/** GET /api/groups/{id}/progress */
export async function getGroupProgress(
  groupId: string,
): Promise<ApiResult<GroupProgressDto>> {
  return get<GroupProgressDto>(
    `/api/groups/${encodeURIComponent(groupId)}/progress`,
  );
}

/** GET /api/my-group-tasks — việc + việc con được giao cho tôi. */
export async function listMyGroupWork(): Promise<ApiResult<MyGroupWorkDto>> {
  return get<MyGroupWorkDto>("/api/my-group-tasks");
}

/* ===========================================================
 * 7. Bấm giờ làm việc của nhóm (đợt 2)
 * =========================================================== */

/**
 * POST /api/group-tasks/{taskId}/focus/start
 *
 * ⚠️ Việc CÓ việc con thì bắt buộc gửi `subTaskId` (BE trả 400 nếu thiếu).
 */
export async function startGroupFocus(
  taskId: string,
  body?: GroupFocusStartRequest,
): Promise<ApiResult<GroupFocusStartResponseDto>> {
  return post<GroupFocusStartResponseDto>(
    `/api/group-tasks/${encodeURIComponent(taskId)}/focus/start`,
    body ?? {},
  );
}

/**
 * POST /api/group-focus/{sessionId}/stop
 *
 * ⚠️ `note` BẮT BUỘC với `Blocked` và `Other`.
 */
export async function stopGroupFocus(
  sessionId: string,
  body: GroupFocusStopRequest,
): Promise<ApiResult<GroupFocusStopResponseDto>> {
  return post<GroupFocusStopResponseDto>(
    `/api/group-focus/${encodeURIComponent(sessionId)}/stop`,
    body,
  );
}

/** GET /api/group-focus/current — 204 nếu không có phiên nào đang chạy. */
export async function getCurrentGroupFocus(): Promise<
  ApiResult<GroupFocusCurrentDto | null>
> {
  return get<GroupFocusCurrentDto | null>("/api/group-focus/current");
}

/** GET /api/group-tasks/{taskId}/time — mọi thành viên xem được. */
export async function getGroupTaskTime(
  taskId: string,
): Promise<ApiResult<GroupTaskTimeDto>> {
  return get<GroupTaskTimeDto>(
    `/api/group-tasks/${encodeURIComponent(taskId)}/time`,
  );
}

/* ===========================================================
 * 8. Kiểm tra lịch khi giao việc (đợt 2)
 * =========================================================== */

/**
 * GET /api/group-tasks/{taskId}/assignee-check?assigneeId=...
 *
 * Leader xem trước trước khi giao. Member gọi API này nhận 403.
 */
export async function getGroupAssigneeCheck(
  taskId: string,
  assigneeId: string,
): Promise<ApiResult<GroupAssigneeAvailabilityDto>> {
  const qs = new URLSearchParams();
  qs.set("assigneeId", assigneeId);
  return get<GroupAssigneeAvailabilityDto>(
    `/api/group-tasks/${encodeURIComponent(taskId)}/assignee-check?${qs.toString()}`,
  );
}

/* ===========================================================
 * 9. Đề xuất đổi giờ (đợt 2)
 * =========================================================== */

/** POST /api/group-tasks/{taskId}/change-requests — người được giao. */
export async function createGroupChangeRequest(
  taskId: string,
  body: GroupChangeRequestCreate,
): Promise<ApiResult<GroupChangeRequestDto>> {
  return post<GroupChangeRequestDto>(
    `/api/group-tasks/${encodeURIComponent(taskId)}/change-requests`,
    body,
  );
}

/**
 * GET /api/groups/{groupId}/change-requests?status=Pending
 *
 * Leader thấy mọi đề xuất, Member chỉ thấy của mình, Viewer nhận 403.
 */
export async function listGroupChangeRequests(
  groupId: string,
  params?: { status?: GroupChangeRequestStatus | string | null },
): Promise<ApiResult<GroupChangeRequestDto[]>> {
  const qs = new URLSearchParams();
  if (params?.status) qs.set("status", params.status);
  const suffix = qs.toString() ? `?${qs.toString()}` : "";
  return get<GroupChangeRequestDto[]>(
    `/api/groups/${encodeURIComponent(groupId)}/change-requests${suffix}`,
  );
}

/** GET /api/group-tasks/{taskId}/change-requests */
export async function listGroupTaskChangeRequests(
  taskId: string,
  params?: { status?: GroupChangeRequestStatus | string | null },
): Promise<ApiResult<GroupChangeRequestDto[]>> {
  const qs = new URLSearchParams();
  if (params?.status) qs.set("status", params.status);
  const suffix = qs.toString() ? `?${qs.toString()}` : "";
  return get<GroupChangeRequestDto[]>(
    `/api/group-tasks/${encodeURIComponent(taskId)}/change-requests${suffix}`,
  );
}

/**
 * POST /api/group-change-requests/{id}/approve — Leader.
 *
 * ⚠️ Giờ mới trùng lịch người nhận → 409 `GROUP_ASSIGNEE_BUSY`, gửi lại kèm
 * `confirmConflicts: true`.
 */
export async function approveGroupChangeRequest(
  changeRequestId: string,
  body?: GroupChangeDecision,
): Promise<ApiResult<GroupChangeRequestDto>> {
  return post<GroupChangeRequestDto>(
    `/api/group-change-requests/${encodeURIComponent(changeRequestId)}/approve`,
    body ?? {},
  );
}

/** POST /api/group-change-requests/{id}/reject — Leader. `note` BẮT BUỘC. */
export async function rejectGroupChangeRequest(
  changeRequestId: string,
  body: { note: string },
): Promise<ApiResult<GroupChangeRequestDto>> {
  return post<GroupChangeRequestDto>(
    `/api/group-change-requests/${encodeURIComponent(changeRequestId)}/reject`,
    body,
  );
}

/** POST /api/group-change-requests/{id}/cancel — chỉ người đề xuất. */
export async function cancelGroupChangeRequest(
  changeRequestId: string,
): Promise<ApiResult<GroupChangeRequestDto>> {
  return post<GroupChangeRequestDto>(
    `/api/group-change-requests/${encodeURIComponent(changeRequestId)}/cancel`,
  );
}

/* ===========================================================
 * 10. Slot dùng chung cho việc nhóm (mục 10 của cập nhật BE)
 * ----------------------------------------------------------
 * Slot nhóm dùng CHUNG 2 endpoint sửa/hủy với slot cá nhân:
 *   PUT    /api/schedule-slots/{id}
 *   DELETE /api/schedule-slots/{id}
 * Riêng tạo + xem thì dùng endpoint của việc nhóm:
 *   POST /api/group-tasks/{taskId}/schedule-slots
 *   GET  /api/group-tasks/{taskId}/schedule-slots
 *
 * ⚠️ Slot nhóm cũng bị luật không chồng giờ: 409 `SLOT_OVERLAP` với
 * `details.overlaps[]` — phần tử có `groupTaskId` khi bên chồng là slot
 * của việc nhóm.
 * =========================================================== */

/**
 * DTO của 1 slot nhóm.
 *
 * ⚠️ `taskId` là `null` — slot nhóm KHÔNG thuộc task cá nhân.
 */
export interface GroupScheduleSlotDto {
  id: string;
  /** Luôn `null` với slot nhóm (xem `ScheduleSlotDto.taskId`). */
  taskId: string | null;
  subTaskId: string | null;
  /** Việc nhóm sở hữu slot. */
  groupTaskId: string;
  /** Việc con của việc nhóm (nếu slot gắn với việc con). */
  groupSubTaskId?: string | null;
  /** Người được giao slot. */
  userId?: string | null;
  /** Tên việc nhóm (BE có thể trả kèm để hiển thị). */
  taskTitle?: string | null;
  /** Tên nhóm. */
  groupName?: string | null;
  scheduleProposalId: string | null;
  startTime: string; // ISO 8601
  endTime: string; // ISO 8601
  originalStartTime: string | null;
  isManualOverride: boolean;
  proposedMinutes: number;
  kbiasUsed: number;
  explanation: string | null;
  status: GroupScheduleSlotStatus | string;
  googleEventId: string | null;
  syncFailed: boolean;
}

/** Trạng thái schedule slot (enum BE). */
export type GroupScheduleSlotStatus =
  | "Proposed"
  | "Approved"
  | "Done"
  | "Skipped"
  | "Missed"
  | "Cancelled";

/** Body của `POST /api/group-tasks/{taskId}/schedule-slots`. */
export interface CreateGroupScheduleSlotRequest {
  groupSubTaskId?: string | null;
  startTime: string; // ISO 8601
  endTime: string; // ISO 8601
  originalStartTime?: string | null;
  isManualOverride?: boolean;
  kbiasUsed?: number;
  explanation?: string | null;
  status?: GroupScheduleSlotStatus | string;
}

/**
 * GET /api/group-tasks/{taskId}/schedule-slots
 *
 * Danh sách slot của 1 việc nhóm.
 */
export async function listGroupScheduleSlots(
  taskId: string,
): Promise<ApiResult<GroupScheduleSlotDto[]>> {
  if (!taskId) {
    return { ok: false, status: 0, error: "Group task id is required" };
  }
  return get<GroupScheduleSlotDto[]>(
    `/api/group-tasks/${encodeURIComponent(taskId)}/schedule-slots`,
  );
}

/**
 * POST /api/group-tasks/{taskId}/schedule-slots
 *
 * ⚠️ 409 `SLOT_OVERLAP` nếu khung giờ chồng slot khác (kể cả slot nhóm).
 */
export async function createGroupScheduleSlot(
  taskId: string,
  body: CreateGroupScheduleSlotRequest,
): Promise<ApiResult<GroupScheduleSlotDto>> {
  if (!taskId) {
    return { ok: false, status: 0, error: "Group task id is required" };
  }
  return post<GroupScheduleSlotDto>(
    `/api/group-tasks/${encodeURIComponent(taskId)}/schedule-slots`,
    body,
  );
}
