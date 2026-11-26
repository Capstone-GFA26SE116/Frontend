/**
 * ===========================================================
 * Logic dùng chung cho NHÁNH GROUP (nhóm làm việc).
 * ===========================================================
 *
 * Tách riêng khỏi component để:
 *  - Tránh lặp lại logic phân quyền ở nhiều trang.
 *  - Giữ các hàm thuần (pure) → dễ test, dễ đọc.
 *
 * Theo spec BE: `GROUP_FE.md` (mục 1 — bảng phân quyền theo vai trò).
 */

import type {
  GroupChangeRequestDto,
  GroupDto,
  GroupMemberDto,
  GroupMilestoneStatus,
  GroupPriority,
  GroupRole,
  GroupTaskStatus,
} from "../../lib/group-api";

/* ===========================================================
 * Phân quyền theo vai trò
 * =========================================================== */

/** Leader = toàn quyền trong nhóm. */
export function isLeader(group: GroupDto | null): boolean {
  return normalizeRole(group?.myRole) === "Leader";
}

/** Member = xem + đổi status việc của mình + bình luận. */
export function isMember(group: GroupDto | null): boolean {
  const r = normalizeRole(group?.myRole);
  return r === "Member" || r === "Leader";
}

/** Viewer = chỉ xem. */
export function isViewer(group: GroupDto | null): boolean {
  return normalizeRole(group?.myRole) === "Viewer";
}

/** Chuẩn hoá vai trò (BE trả đúng case nhưng ta không nên phụ thuộc). */
export function normalizeRole(role: unknown): GroupRole | "" {
  const s = String(role ?? "").trim().toLowerCase();
  if (s === "leader") return "Leader";
  if (s === "member") return "Member";
  if (s === "viewer") return "Viewer";
  return "";
}

/**
 * Người dùng có được phép **giao việc / đổi người được giao** không.
 *
 * Theo bảng phân quyền: chỉ Leader.
 */
export function canManageTasks(group: GroupDto | null): boolean {
  return isLeader(group);
}

/**
 * Người dùng có được phép **đổi status của việc này** không.
 *
 * Luật (bảng phân quyền):
 *  - Leader: mọi việc.
 *  - Member: việc KHÔNG có việc con, hoặc việc con được giao cho mình.
 *  - Viewer: không.
 */
export function canChangeTaskStatus(
  group: GroupDto | null,
  task: { assigneeId?: string | null; subTaskCount?: number } | null,
  currentUserId: string | null,
  isAssignedSubTask: boolean = false,
): boolean {
  if (!group) return false;
  const role = normalizeRole(group.myRole);
  if (role === "Leader") return true;
  if (role === "Viewer") return false;
  if (role !== "Member") return false;

  // Member: việc không có việc con → được đổi status (kể cả chưa giao).
  const hasSubTasks = (task?.subTaskCount ?? 0) > 0;
  if (!hasSubTasks) return true;

  // Có việc con → chỉ được đổi nếu việc con được giao cho mình,
  // hoặc việc cha được giao cho mình.
  if (isAssignedSubTask) return true;
  if (currentUserId && task?.assigneeId === currentUserId) return true;
  return false;
}

/**
 * Người dùng có được phép **bấm giờ** cho việc này không.
 *
 * Luật (mục 7): chỉ người được giao —
 *  - việc con của mình, hoặc
 *  - việc con chưa giao nếu mình được giao việc cha, hoặc
 *  - việc (không có việc con) giao cho mình.
 */
export function canStartFocus(
  task: { assigneeId?: string | null; subTaskCount?: number } | null,
  subTask: { assigneeId?: string | null } | null,
  currentUserId: string | null,
): boolean {
  if (!task || !currentUserId) return false;
  const hasSubTasks = (task.subTaskCount ?? 0) > 0;

  if (hasSubTasks) {
    // Chọn việc con → phải là của mình.
    if (subTask) return subTask.assigneeId === currentUserId;
    // Chưa chọn việc con → mình được giao việc cha.
    return task.assigneeId === currentUserId;
  }
  // Việc không có việc con → phải giao cho mình.
  return task.assigneeId === currentUserId;
}

/* ===========================================================
 * Gợi ý giờ làm việc nhóm (FR-25 — spec GROUP_AI_FE mục 3)
 * ----------------------------------------------------------
 * AI chỉ xếp được phần việc **của mình**:
 *  - việc con đang mở giao cho mình, hoặc
 *  - việc con chưa giao riêng → tính theo người được giao việc cha, hoặc
 *  - việc không có việc con → chính việc đó.
 *
 * Người khác gọi API sẽ bị `403` → ta ẩn nút.
 * =========================================================== */

/** Việc còn mở (ToDo / InProgress). */
function isOpenGroupTask(status: string): boolean {
  const s = (status ?? "").trim().toLowerCase();
  return (
    s === "todo" ||
    s === "to_do" ||
    s === "inprogress" ||
    s === "in_progress"
  );
}

/**
 * Người dùng có được phép bấm "Suggest times" cho việc này không?
 *
 * @param task Việc nhóm (dùng `assigneeId`, `status`, `fixedStart`).
 * @param subTasks Việc con của việc (để biết có việc con giao cho mình không).
 * @param currentUserId Id của người đang đăng nhập.
 */
export function canSuggestTimes(
  task: {
    assigneeId?: string | null;
    status?: string | null;
    fixedStart?: string | null;
    fixedEnd?: string | null;
    subTaskCount?: number | null;
  } | null,
  subTasks: Array<{
    assigneeId?: string | null;
    status?: string | null;
  }>,
  currentUserId: string | null,
): boolean {
  if (!task || !currentUserId) return false;
  /* Việc đã xong / bị bỏ qua → không gợi ý nữa. */
  if (!isOpenGroupTask(task.status ?? "")) return false;
  /* Việc có giờ cố định → AI trả 409 (spec mục 3). */
  if (task.fixedStart && task.fixedEnd) return false;

  /*
   * Có việc con → mình phải có ít nhất 1 việc con đang mở giao cho mình.
   *
   * ⚠️ Việc con chỉ được nạp khi mở chi tiết việc. Nếu chưa nạp, ta dùng
   * luật "việc con chưa giao riêng → tính theo người được giao việc cha"
   * (đúng như cách AI tính) → người được giao việc cha vẫn thấy nút.
   */
  if (subTasks.length > 0) {
    return subTasks.some(
      (s) =>
        s.assigneeId === currentUserId && isOpenGroupTask(s.status ?? ""),
    );
  }
  if ((task.subTaskCount ?? 0) > 0) {
    return task.assigneeId === currentUserId;
  }

  /* Không có việc con → phần việc của mình = việc cha giao cho mình. */
  return task.assigneeId === currentUserId;
}

/* ===========================================================
 * Format
 * =========================================================== */

/** "27 Oct 2026" — ngày kiểu `yyyy-MM-dd` hoặc ISO. */
export function fmtGroupDate(value?: string | null): string {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

/** "27 Oct, 14:30" — thời gian có giờ. */
export function fmtGroupDateTime(value?: string | null): string {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "—";
  return `${d.toLocaleDateString("en-GB", {
    day: "2-digit",
    month: "short",
  })}, ${d.toLocaleTimeString("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
  })}`;
}

/** "1h 30m" — phút → chuỗi gọn. */
export function fmtMinutes(minutes?: number | null): string {
  if (minutes == null || !Number.isFinite(minutes) || minutes <= 0) return "—";
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  if (h <= 0) return `${m}m`;
  if (m <= 0) return `${h}h`;
  return `${h}h ${m}m`;
}

/** "vừa xong" / "5 phút trước" / "2 giờ trước" / "3 ngày trước". */
export function fmtRelativeTime(iso?: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const diffMs = Date.now() - d.getTime();
  const mins = Math.round(diffMs / 60_000);
  if (mins < 1) return "vừa xong";
  if (mins < 60) return `${mins} phút trước`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} giờ trước`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days} ngày trước`;
  return d.toLocaleDateString("en-GB");
}

/* ===========================================================
 * Nhãn + tone hiển thị
 * =========================================================== */

export type GroupStatusTone =
  | "todo"
  | "active"
  | "done"
  | "skipped"
  | "muted";

/** Nhãn + tone cho status của việc / việc con. */
export function taskStatusLabel(status: string): {
  label: string;
  tone: GroupStatusTone;
} {
  const s = (status ?? "").trim().toLowerCase();
  switch (s) {
    case "inprogress":
    case "in_progress":
      return { label: "In Progress", tone: "active" };
    case "done":
      return { label: "Done", tone: "done" };
    case "skipped":
      return { label: "Skipped", tone: "skipped" };
    case "todo":
    case "to_do":
      return { label: "To Do", tone: "todo" };
    default:
      return { label: status || "—", tone: "muted" };
  }
}

/** Nhãn + tone cho status của giai đoạn. */
export function milestoneStatusLabel(status: string): {
  label: string;
  tone: GroupStatusTone;
} {
  const s = (status ?? "").trim().toLowerCase();
  switch (s) {
    case "planned":
      return { label: "Planned", tone: "todo" };
    case "inprogress":
    case "in_progress":
      return { label: "In Progress", tone: "active" };
    case "delivered":
      return { label: "Delivered", tone: "done" };
    case "inrevision":
    case "revision":
      return { label: "In Revision", tone: "skipped" };
    case "approved":
      return { label: "Approved", tone: "done" };
    default:
      return { label: status || "—", tone: "muted" };
  }
}

/** Nhãn cho mức ưu tiên. */
export function priorityLabel(priority: string): string {
  const s = (priority ?? "").trim().toLowerCase();
  if (s === "low") return "Low";
  if (s === "medium") return "Medium";
  if (s === "high") return "High";
  return priority || "Medium";
}

/** Tone cho mức ưu tiên (High = đỏ, Medium = xanh, Low = xám). */
export function priorityTone(priority: string): "high" | "medium" | "low" {
  const s = (priority ?? "").trim().toLowerCase();
  if (s === "high") return "high";
  if (s === "low") return "low";
  return "medium";
}

/** Nhãn vai trò. */
export function roleLabel(role: string): string {
  const r = normalizeRole(role);
  if (r === "Leader") return "Leader";
  if (r === "Member") return "Member";
  if (r === "Viewer") return "Viewer";
  return role || "—";
}

/** Nhãn lý do dừng phiên làm việc. */
export function stopReasonLabel(reason?: string | null): string {
  const s = (reason ?? "").trim();
  if (s === "Completed") return "Completed";
  if (s === "Interrupted") return "Interrupted";
  if (s === "Blocked") return "Blocked";
  if (s === "Other") return "Other";
  return s || "—";
}

/** Nhãn nguồn khoảng bận. */
export function busySourceLabel(source: string): string {
  const s = (source ?? "").trim();
  if (s === "PersonalSchedule") return "Lịch cá nhân";
  if (s === "GoogleCalendar") return "Google Calendar";
  if (s === "GroupTask") return "Việc nhóm khác";
  return s || "—";
}

/** Nhãn hành động trong nhật ký hoạt động. */
export function activityActionLabel(action: string): string {
  const map: Record<string, string> = {
    Created: "Đã tạo",
    Updated: "Đã cập nhật",
    Deleted: "Đã xoá",
    StatusChanged: "Đổi trạng thái",
    Assigned: "Giao việc",
    RoleChanged: "Đổi vai trò",
    MemberJoined: "Tham gia",
    Removed: "Bị gỡ",
    Left: "Rời nhóm",
    Invited: "Mời",
    InvitationRevoked: "Thu hồi lời mời",
    InvitationDeclined: "Từ chối lời mời",
    Archived: "Lưu trữ",
    Restored: "Khôi phục",
    Started: "Bắt đầu",
    Stopped: "Dừng",
    ChangeRequested: "Đề xuất đổi giờ",
    ChangeApproved: "Duyệt đổi giờ",
    ChangeRejected: "Từ chối đổi giờ",
    ChangeCancelled: "Rút đề xuất",
  };
  return map[action] ?? action ?? "—";
}

/* ===========================================================
 * Tiện ích
 * =========================================================== */

/**
 * Nhãn trạng thái lời mời (Pending / Accepted / Declined / Expired / Revoked).
 */
export function invitationStatusLabel(status: string): string {
  const s = (status ?? "").trim();
  if (s === "Pending") return "Đang chờ";
  if (s === "Accepted") return "Đã chấp nhận";
  if (s === "Declined") return "Đã từ chối";
  if (s === "Expired") return "Đã hết hạn";
  if (s === "Revoked") return "Đã thu hồi";
  return s || "—";
}

/**
 * Tìm 1 thành viên theo id (Leader có thể đổi vai trò / giao việc).
 */
export function findMember(
  members: GroupMemberDto[],
  userId?: string | null,
): GroupMemberDto | null {
  if (!userId) return null;
  return members.find((m) => m.userId === userId) ?? null;
}

/**
 * Kiểm tra 1 đề xuất đổi giờ còn có thể xử lý không.
 *
 * Đề xuất đã xử lý (Approved / Rejected / Cancelled) → không duyệt / từ chối /
 * rút lại được nữa (BE trả 400).
 */
export function isChangeRequestOpen(
  cr: GroupChangeRequestDto | null | undefined,
): boolean {
  return (cr?.status ?? "").trim().toLowerCase() === "pending";
}

/**
 * Đề xuất đổi giờ có thay đổi gì không?
 *
 * Luật BE: phải có ít nhất giờ cố định mới HOẶC deadline mới, và khác giá
 * trị hiện tại.
 */
export function changeRequestHasChange(
  cr: Pick<
    GroupChangeRequestDto,
    | "currentFixedStart"
    | "currentFixedEnd"
    | "currentDeadline"
    | "newFixedStart"
    | "newFixedEnd"
    | "newDeadline"
  >,
): boolean {
  const differs = (a?: string | null, b?: string | null) =>
    (a ?? "") !== (b ?? "");
  const hasFixed =
    !!cr.newFixedStart ||
    !!cr.newFixedEnd ||
    differs(cr.currentFixedStart, cr.newFixedStart) ||
    differs(cr.currentFixedEnd, cr.newFixedEnd);
  const hasDeadline =
    !!cr.newDeadline || differs(cr.currentDeadline, cr.newDeadline);
  return hasFixed || hasDeadline;
}

/* ===========================================================
 * Tín hiệu tiến độ (mục 10 của cập nhật BE)
 * ----------------------------------------------------------
 * `GET /api/groups/{id}/progress` trả `signals` — 4 loại rủi ro:
 * quá hạn, chưa có lịch, nguy cơ trễ, đứng yên.
 * =========================================================== */

/** Nhãn tiếng Anh + tone của từng loại tín hiệu. */
export interface GroupSignalLabel {
  label: string;
  /** Icon Material Symbols. */
  icon: string;
  /** Tone màu: `danger` (đỏ) | `warn` (hổ phách) | `info` (xanh). */
  tone: "danger" | "warn" | "info";
  /** Giải thích ngắn — để người dùng hiểu tín hiệu này nghĩa là gì. */
  hint: string;
}

/** Nhãn + tone cho 1 loại tín hiệu tiến độ. */
export function signalLabel(type: string): GroupSignalLabel {
  const s = (type ?? "").trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (s === "overdue" || s === "overdue_tasks") {
    return {
      label: "Overdue",
      icon: "event_busy",
      tone: "danger",
      hint: "Past the deadline and not finished yet",
    };
  }
  if (s === "unscheduled" || s === "no_schedule" || s === "unscheduled_tasks") {
    return {
      label: "No schedule",
      icon: "schedule",
      tone: "warn",
      hint: "No time slot booked on the calendar yet",
    };
  }
  if (s === "atrisk" || s === "at_risk" || s === "at_risk_tasks") {
    return {
      label: "At risk",
      icon: "trending_up",
      tone: "warn",
      hint: "Unlikely to finish before the deadline",
    };
  }
  if (s === "stale" || s === "stale_tasks") {
    return {
      label: "Stalled",
      icon: "hourglass_empty",
      tone: "warn",
      hint: "No progress for a while",
    };
  }
  return {
    label: type || "Signal",
    icon: "insights",
    tone: "info",
    hint: "",
  };
}

/**
 * Bộ đếm tín hiệu tiến độ của 1 thành viên (mục 10 của cập nhật BE).
 *
 * BE thêm 4 bộ đếm vào `GroupMemberProgressDto`: `overdueTasks`,
 * `unscheduledTasks`, `atRiskTasks`, `staleTasks`. Ta chuẩn hoá về shape
 * giống nhau để render, và bỏ qua bộ đếm bằng 0 (tránh rối).
 */
export interface MemberSignalCounter {
  key: string;
  value: number;
  label: string;
  icon: string;
  tone: "danger" | "warn" | "info";
  hint: string;
}

/** Danh sách bộ đếm tín hiệu của 1 thành viên (bỏ bộ đếm = 0). */
export function memberSignalCounters(
  member: {
    overdueTasks?: number;
    unscheduledTasks?: number;
    atRiskTasks?: number;
    staleTasks?: number;
  },
): MemberSignalCounter[] {
  const all: MemberSignalCounter[] = [
    {
      key: "overdue",
      value: member.overdueTasks ?? 0,
      label: "overdue",
      icon: "event_busy",
      tone: "danger",
      hint: "Past the deadline and not finished yet",
    },
    {
      key: "atRisk",
      value: member.atRiskTasks ?? 0,
      label: "at risk",
      icon: "trending_up",
      tone: "warn",
      hint: "Unlikely to finish before the deadline",
    },
    {
      key: "unscheduled",
      value: member.unscheduledTasks ?? 0,
      label: "no schedule",
      icon: "schedule",
      tone: "warn",
      hint: "No time slot booked on the calendar yet",
    },
    {
      key: "stale",
      value: member.staleTasks ?? 0,
      label: "stalled",
      icon: "hourglass_empty",
      tone: "info",
      hint: "No progress for a while",
    },
  ];
  return all.filter((c) => c.value > 0);
}

/** Tổng số tín hiệu của 1 thành viên (dùng để quyết định có hiện hay không). */
export function memberSignalTotal(member: {
  overdueTasks?: number;
  unscheduledTasks?: number;
  atRiskTasks?: number;
  staleTasks?: number;
}): number {
  return (
    (member.overdueTasks ?? 0) +
    (member.unscheduledTasks ?? 0) +
    (member.atRiskTasks ?? 0) +
    (member.staleTasks ?? 0)
  );
}

/**
 * Tổng các status hợp lệ của việc (dùng cho select).
 */
export const GROUP_TASK_STATUSES: GroupTaskStatus[] = [
  "ToDo",
  "InProgress",
  "Done",
  "Skipped",
];
/** Tổng các status hợp lệ của giai đoạn (dùng cho select). */
export const GROUP_MILESTONE_STATUSES: GroupMilestoneStatus[] = [
  "Planned",
  "InProgress",
  "Delivered",
  "InRevision",
  "Approved",
];

/** Tổng các mức ưu tiên (dùng cho select). */
export const GROUP_PRIORITIES: GroupPriority[] = ["Low", "Medium", "High"];

/**
 * Kiểm tra người dùng có thể rời nhóm không.
 *
 * Leader cuối cùng KHÔNG rời được (BE trả 400) → FE ẩn nút cho trường hợp
 * này để khỏi bấm rồi nhận lỗi.
 */
export function canLeaveGroup(
  group: GroupDto | null,
  members: GroupMemberDto[],
): boolean {
  if (!group) return false;
  if (normalizeRole(group.myRole) === "Viewer") return true;
  if (normalizeRole(group.myRole) === "Member") return true;
  // Leader: chỉ rời được khi còn Leader khác.
  const leaderCount = members.filter(
    (m) => normalizeRole(m.role) === "Leader",
  ).length;
  return leaderCount > 1;
}
