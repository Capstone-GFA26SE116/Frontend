import { useCallback, useMemo, useRef, useState } from "react";
import {
  createScheduleSlot,
  proposeSchedule,
  type ProposeScheduleResponse,
  type ProposedSlotDto,
  type ScheduleWarningDto,
  type SubtaskDto,
  type TaskDto,
} from "../lib/api-client";

/* ===========================================================
 * Logic (không phải component) cho AI Schedule Proposal.
 * Tách riêng khỏi ScheduleProposal.tsx để react-refresh chỉ thấy
 * component trong file .tsx.
 * =========================================================== */

export interface ProposalToastApi {
  success: (title: string, detail?: string) => void;
  error: (title: string, detail?: string) => void;
  info: (title: string, detail?: string) => void;
}

/* ===========================================================
 * PHÂN LOẠI & SẮP XẾP PROPOSAL
 *
 * Panel proposal gom slot của nhiều task vào 1 danh sách phẳng → rối.
 * Ở đây ta gom theo TASK, dán nhãn mức độ ưu tiên (quá hạn / thiếu chỗ /
 * sẵn sàng) và sắp xếp lại để người dùng thấy việc gấp nhất trước.
 * =========================================================== */

/** Mức độ ưu tiên của 1 task trong proposal (số nhỏ = nghiêm trọng hơn). */
export type ProposalGroupKind = "overdue" | "tight" | "ready";

export interface ProposalSlotGroup {
  kind: ProposalGroupKind;
  taskId: string;
  title: string;
  /** Deadline của task (ISO) hoặc null nếu task không có deadline. */
  deadline: string | null;
  /** Task đã quá hạn chưa. */
  isOverdue: boolean;
  /** Các warning của AI cho task này (có thể rỗng). */
  warnings: ScheduleWarningDto[];
  /** Slot của task, đã sort theo start tăng dần. */
  slots: ProposedSlotDto[];
  /**
   * Subtask mà nhóm này đại diện (null = nhóm cấp task).
   *
   * AI service trả `subtask_id` trong mỗi slot khi task đã có subtask trong DB
   * (xem sau khi user bấm "Accept" ở /copilot). Nhóm cấp **subtask** cho
   * user tick đúng từng việc con, đúng như mong đợi.
   */
  subtaskId: string | null;
  /** Tiêu đề subtask (null = dùng `title` của task). */
  subtaskTitle: string | null;
  /** Phút ước lượng của subtask (để hiển thị cạnh tiêu đề). */
  subtaskMinutes: number | null;
}

/** Các loại warning cho biết task không xếp được / xếp chưa đủ. */
const TIGHT_WARNING_TYPES = new Set([
  "not_enough_time",
  "insufficient_time",
  "no_free_slot",
]);

const OVERDUE_WARNING_TYPES = new Set(["overdue", "past_deadline"]);

/** Deadline đã qua (so với thời điểm hiện tại). */
function isPastDeadline(deadline: string | null | undefined): boolean {
  if (!deadline) return false;
  const d = new Date(deadline);
  if (Number.isNaN(d.getTime())) return false;
  return d.getTime() < Date.now();
}

/**
 * Xếp hạng 1 task trong proposal.
 *
 * - `overdue`: task đã quá hạn (deadline đã qua, hoặc AI báo `overdue`).
 * - `tight`: AI báo không đủ chỗ trống / thiếu thời gian.
 * - `ready`: còn lại — xếp lịch được bình thường.
 */
export function classifyProposalTask(
  task: TaskDto | undefined,
  warnings: ScheduleWarningDto[],
): ProposalGroupKind {
  const overdueWarning = warnings.some((w) =>
    OVERDUE_WARNING_TYPES.has(w.type),
  );
  if (overdueWarning || isPastDeadline(task?.deadline)) return "overdue";

  const tight = warnings.some((w) => TIGHT_WARNING_TYPES.has(w.type));
  if (tight) return "tight";

  return "ready";
}

/** Thứ tự hiển thị các nhóm: quá hạn → thiếu chỗ → sẵn sàng. */
export const PROPOSAL_GROUP_ORDER: ProposalGroupKind[] = [
  "overdue",
  "tight",
  "ready",
];

/** Nhãn tiếng Việt cho từng nhóm. */
export const PROPOSAL_GROUP_LABELS: Record<ProposalGroupKind, string> = {
  overdue: "Quá hạn",
  tight: "Cần chờ trống",
  ready: "Sẵn sàng",
};

/** Icon Material tương ứng từng nhóm. */
export const PROPOSAL_GROUP_ICONS: Record<ProposalGroupKind, string> = {
  overdue: "warning",
  tight: "event_busy",
  ready: "task_alt",
};

/**
 * Gom slot của proposal thành các nhóm + phân loại + sort.
 *
 * Cấu trúc 2 tầng:
 *   - **Cấp task**: nhóm theo `task_id` — dùng cho tiêu đề, deadline, warning.
 *   - **Cấp subtask**: nếu AI gắn `subtask_id` cho slot, tách tiếp thành
 *     nhóm con theo từng subtask để user tick đúng từng việc con.
 *
 * Sort:
 *   - Slot trong 1 nhóm: `start` tăng dần (sớm nhất trước).
 *   - Nhóm: quá hạn → thiếu chỗ → sẵn sàng; trong cùng loại → deadline sớm nhất.
 *   - Subtask trong 1 task: theo `orderIndex` của subtask (thứ tự user đã duyệt).
 *
 * Task không có slot nào (AI chỉ trả warning) vẫn xuất hiện — để người dùng
 * thấy "task này có vấn đề" chứ không biến mất âm thầm.
 */
export function groupProposalSlots(
  proposal: ProposeScheduleResponse,
  tasksById: Map<string, TaskDto>,
  subtasksById?: Map<string, SubtaskDto>,
): ProposalSlotGroup[] {
  const warningsByTask = new Map<string, ScheduleWarningDto[]>();
  for (const w of proposal.warnings ?? []) {
    const list = warningsByTask.get(w.task_id);
    if (list) list.push(w);
    else warningsByTask.set(w.task_id, [w]);
  }

  const slotsByTask = new Map<string, ProposedSlotDto[]>();
  for (const slot of proposal.slots ?? []) {
    const list = slotsByTask.get(slot.task_id);
    if (list) list.push(slot);
    else slotsByTask.set(slot.task_id, [slot]);
  }

  // Task nào xuất hiện: có slot HOẶC có warning.
  const taskIds = new Set<string>([
    ...slotsByTask.keys(),
    ...warningsByTask.keys(),
  ]);

  const groups: ProposalSlotGroup[] = [];
  for (const taskId of taskIds) {
    const task = tasksById.get(taskId);
    const warnings = warningsByTask.get(taskId) ?? [];
    const taskSlots = slotsByTask.get(taskId) ?? [];

    // Tách slot theo subtask (slot nào không gắn subtask → nhóm cấp task).
    const bySubtask = new Map<string | null, ProposedSlotDto[]>();
    for (const slot of taskSlots) {
      const key = slot.subtask_id ?? null;
      const list = bySubtask.get(key);
      if (list) list.push(slot);
      else bySubtask.set(key, [slot]);
    }

    const sortSlots = (list: ProposedSlotDto[]) =>
      list.slice().sort((a, b) => {
        const sa = parseDate(a.start)?.getTime() ?? 0;
        const sb = parseDate(b.start)?.getTime() ?? 0;
        if (sa !== sb) return sa - sb;
        return (a.end ?? "").localeCompare(b.end ?? "");
      });

    // Nhóm cấp task: chỉ tạo khi task có slot KHÔNG gắn subtask nào.
    // (Nếu mọi slot đều gắn subtask thì nhóm con đã đủ biểu diễn task.)
    const looseSlots = bySubtask.get(null) ?? [];
    if (looseSlots.length > 0 || bySubtask.size === 0) {
      groups.push({
        kind: classifyProposalTask(task, warnings),
        taskId,
        title: task?.title ?? "Task",
        deadline: task?.deadline ?? null,
        isOverdue: isPastDeadline(task?.deadline),
        warnings,
        slots: sortSlots(looseSlots),
        subtaskId: null,
        subtaskTitle: null,
        subtaskMinutes: null,
      });
    }

    // Nhóm cấp subtask — sort theo orderIndex của subtask.
    const subEntries = Array.from(bySubtask.entries())
      .filter((entry): entry is [string, ProposedSlotDto[]] => entry[0] !== null)
      .map(([key, list]) => ({
        subId: key,
        slots: sortSlots(list),
        sub: subtasksById?.get(key),
      }))
      .sort((a, b) => {
        const oa = a.sub?.orderIndex ?? Number.MAX_SAFE_INTEGER;
        const ob = b.sub?.orderIndex ?? Number.MAX_SAFE_INTEGER;
        if (oa !== ob) return oa - ob;
        return (a.sub?.title ?? "").localeCompare(b.sub?.title ?? "");
      });

    for (const entry of subEntries) {
      groups.push({
        // Phân loại theo task cha (deadline / warning của task).
        kind: classifyProposalTask(task, warnings),
        taskId,
        title: task?.title ?? "Task",
        deadline: task?.deadline ?? null,
        isOverdue: isPastDeadline(task?.deadline),
        // Warning chỉ hiện ở nhóm cấp task để tránh lặp.
        warnings: [],
        slots: entry.slots,
        subtaskId: entry.subId,
        subtaskTitle: entry.sub?.title ?? null,
        subtaskMinutes: entry.sub?.estimatedMinutes ?? null,
      });
    }
  }

  // Sort nhóm: nghiêm trọng trước, rồi deadline sớm nhất trước.
  groups.sort((a, b) => {
    const ka = PROPOSAL_GROUP_ORDER.indexOf(a.kind);
    const kb = PROPOSAL_GROUP_ORDER.indexOf(b.kind);
    if (ka !== kb) return ka - kb;

    // Cùng task → giữ thứ tự subtask đã định (orderIndex).
    if (a.taskId === b.taskId) {
      const oa = a.subtaskId
        ? (subtasksById?.get(a.subtaskId)?.orderIndex ?? Number.MAX_SAFE_INTEGER)
        : -1;
      const ob = b.subtaskId
        ? (subtasksById?.get(b.subtaskId)?.orderIndex ?? Number.MAX_SAFE_INTEGER)
        : -1;
      if (oa !== ob) return oa - ob;
    }

    const da = a.deadline ? parseDate(a.deadline)?.getTime() : undefined;
    const db = b.deadline ? parseDate(b.deadline)?.getTime() : undefined;
    // Task không có deadline → đẩy xuống cuối nhóm.
    if (da === undefined && db === undefined) return a.title.localeCompare(b.title);
    if (da === undefined) return 1;
    if (db === undefined) return -1;
    if (da !== db) return da - db;
    return a.title.localeCompare(b.title);
  });

  return groups;
}

/** Bộ lọc đang active trên panel (null = không lọc). */
export type ProposalFilter = ProposalGroupKind | "all";

/** Tổng hợp số liệu để hiển thị dải chip tóm tắt. */
export interface ProposalSummary {
  /** Tổng số nhóm (task hoặc subtask). */
  totalItems: number;
  /** Số nhóm cấp task. */
  totalTasks: number;
  /** Số nhóm cấp subtask. */
  totalSubtasks: number;
  totalSlots: number;
  totalMinutes: number;
  counts: Record<ProposalGroupKind, number>;
}

export function summarizeProposal(groups: ProposalSlotGroup[]): ProposalSummary {
  const counts: Record<ProposalGroupKind, number> = {
    overdue: 0,
    tight: 0,
    ready: 0,
  };
  let totalSlots = 0;
  let totalMinutes = 0;
  let totalSubtasks = 0;
  for (const g of groups) {
    counts[g.kind] += 1;
    totalSlots += g.slots.length;
    if (g.subtaskId) totalSubtasks += 1;
    for (const s of g.slots) totalMinutes += s.proposed_minutes ?? 0;
  }
  return {
    totalItems: groups.length,
    totalTasks: groups.length - totalSubtasks,
    totalSubtasks,
    totalSlots,
    totalMinutes,
    counts,
  };
}

/** Lọc các nhóm theo filter đang chọn. */
export function filterProposalGroups(
  groups: ProposalSlotGroup[],
  filter: ProposalFilter,
): ProposalSlotGroup[] {
  if (filter === "all") return groups;
  return groups.filter((g) => g.kind === filter);
}

/**
 * Task đủ điều kiện để nhờ AI xếp lịch.
 *
 * - `flexible`: BE chỉ nhận task loại Flexible (task Fixed đã ghim giờ rồi).
 * - chưa có `fixedStart`/`fixedEnd`: tránh xếp đè lịch đã ghim.
 * - chưa có schedule slot: tránh xếp trùng.
 * - chưa xong / chưa huỷ: không xếp lịch cho việc đã kết thúc.
 *
 * ⚠️ Ngoại lệ khi task đã có subtask: nếu task **đã có slot** nhưng còn
 * subtask chưa có lịch thì vẫn xếp được — vì AI service tính slot theo từng
 * subtask (trả `subtask_id` cho mỗi slot). Không có ngoại lệ này thì user
 * không bao giờ xếp được phần subtask còn lại của một task.
 *
 * @param subtasks            Tất cả subtask của các task trong danh sách.
 * @param scheduledSubtaskIds Subtask đã có schedule slot.
 */
export function collectSchedulableTasks(
  tasks: TaskDto[],
  scheduledTaskIds: Set<string>,
  subtasks: SubtaskDto[] = [],
  scheduledSubtaskIds: Set<string> = new Set(),
): TaskDto[] {
  // Task nào còn subtask chưa xếp lịch → vẫn xếp được.
  const taskIdsWithPendingSubtask = new Set<string>();
  for (const st of subtasks) {
    if (scheduledSubtaskIds.has(st.id)) continue;
    taskIdsWithPendingSubtask.add(st.taskId);
  }

  return tasks.filter((t) => {
    if (!t.id) return false;
    // Đã có slot → chỉ xếp tiếp được nếu còn subtask chưa có lịch.
    if (scheduledTaskIds.has(t.id) && !taskIdsWithPendingSubtask.has(t.id)) {
      return false;
    }
    if (t.fixedStart || t.fixedEnd) return false;
    if ((t.taskType ?? "").toLowerCase() !== "flexible") return false;
    const status = (t.status ?? "").toLowerCase();
    if (
      status === "done" ||
      status === "completed" ||
      status === "cancelled" ||
      status === "skipped"
    ) {
      return false;
    }
    return true;
  });
}

function parseDate(iso: string): Date | null {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Định dạng khoảng giờ theo giờ địa phương (API trả về UTC). */
export function fmtRange(startIso: string, endIso: string): string {
  const s = parseDate(startIso);
  const e = parseDate(endIso);
  if (!s || !e) return "—";
  const day = s.toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
  const t = (d: Date) =>
    d.toLocaleTimeString(undefined, {
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
  return `${day} · ${t(s)} – ${t(e)}`;
}

export function fmtMinutes(mins: number): string {
  if (!mins || mins <= 0) return "—";
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  if (h === 0) return `${m}m`;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}m`;
}

/**
 * Khóa ổn định cho 1 slot.
 * `slot_id` là duy nhất theo hợp đồng API, nhưng ghép thêm task+start để
 * an toàn nếu BE trả trùng id (thường xảy ra với task tạo 2 slot giống nhau).
 */
export function slotKey(slot: ProposedSlotDto): string {
  return `${slot.slot_id}::${slot.task_id}::${slot.start}`;
}

/**
 * Chuẩn hoá response của `POST /schedule/propose` thành 1 object để UI dùng.
 *
 * ⚠️ Hiện luôn gọi với **1 request duy nhất** chứa tất cả task đã chọn
 * (xem `run()` bên dưới) → `list` luôn có đúng 1 phần tử. Hàm vẫn nhận
 * mảng để giữ API ổn định và dễ test.
 *
 * - `proposalIdBySlot`: map slot → `proposal_id` của request sinh ra nó. Khi
 *   duyệt, ta gửi đúng `scheduleProposalId` tương ứng (dùng chung 1 id sẽ
 *   bị backend từ chối).
 * - `is_feasible` / `missing_minutes`: giữ nguyên theo response của BE. Lưu ý
 *   cờ `is_feasible = false` chỉ áp cho **cả request**, không nên dùng nó để
 *   báo "còn thiếu" cho toàn bộ danh sách — phải báo theo `warning.task_id`.
 */
export function mergeProposals(
  list: ProposeScheduleResponse[],
): ProposeScheduleResponse & { proposalIdBySlot: Map<string, string> } {
  const proposalIdBySlot = new Map<string, string>();
  const slots: ProposedSlotDto[] = [];
  const warnings: ScheduleWarningDto[] = [];
  let missing = 0;

  for (const p of list) {
    if (!p.is_feasible) missing += p.missing_minutes ?? 0;
    for (const s of p.slots ?? []) {
      slots.push(s);
      proposalIdBySlot.set(slotKey(s), p.proposal_id);
    }
    for (const w of p.warnings ?? []) warnings.push(w);
  }

  const base = list[0];
  return {
    ...base,
    is_feasible: list.every((p) => p.is_feasible),
    missing_minutes: missing,
    slots,
    warnings,
    proposalIdBySlot,
  };
}

/* ===========================================================
 * Hook: useScheduleProposal
 * Gom logic gọi API + chọn slot + duyệt, dùng lại được ở nhiều trang.
 * =========================================================== */
export function useScheduleProposal(opts: {
  /** Task đã có lịch (để loại khỏi danh sách xếp). */
  scheduledTaskIds: Set<string>;
  /** Bản đồ taskId -> task, dùng hiển thị tiêu đề trong panel. */
  tasksById: Map<string, TaskDto>;
  /**
   * Danh sách subtask (để biết task nào còn subtask chưa xếp lịch).
   */
  subtasks?: SubtaskDto[];
  /** Subtask đã có schedule slot. */
  scheduledSubtaskIds?: Set<string>;
  toast: ProposalToastApi;
}) {
  const {
    scheduledTaskIds,
    tasksById,
    subtasks,
    scheduledSubtaskIds,
    toast,
  } = opts;

  const [proposal, setProposal] =
    useState<(ProposeScheduleResponse & { proposalIdBySlot?: Map<string, string> }) | null>(
      null,
    );
  const [candidates, setCandidates] = useState<TaskDto[]>([]);
  const [loading, setLoading] = useState(false);
  const [approving, setApproving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** slot_key đang được bỏ chọn (mặc định chọn hết). */
  const [excluded, setExcluded] = useState<Set<string>>(new Set());
  /** Chống gọi trùng khi bấm nút liên tục. */
  const inFlight = useRef(false);
  /** Chống double-approve (state `approving` không đủ vì 2 click cùng tick). */
  const approvingRef = useRef(false);

  const selectedSlots = useMemo(
    () => (proposal?.slots ?? []).filter((s) => !excluded.has(slotKey(s))),
    [proposal, excluded],
  );

  /**
   * Task được AI nhắc tới nhưng không xếp được slot nào.
   * (Chỉ tính task được nhắc qua warnings — task không được nhắc thì không
   * báo, tránh khiến người dùng tưởng thiếu sót.)
   */
  const unscheduledTaskIds = useMemo(() => {
    if (!proposal) return [] as string[];
    const scheduled = new Set((proposal.slots ?? []).map((s) => s.task_id));
    const warned = (proposal.warnings ?? []).map((w) => w.task_id);
    return Array.from(new Set(warned)).filter((id) => !scheduled.has(id));
  }, [proposal]);

  const reset = useCallback(() => {
    setProposal(null);
    setCandidates([]);
    setExcluded(new Set());
    setError(null);
    approvingRef.current = false;
  }, []);

  const close = useCallback(() => {
    if (approving) return;
    reset();
  }, [approving, reset]);

  const toggle = useCallback((slot: ProposedSlotDto) => {
    const key = slotKey(slot);
    setExcluded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const toggleAll = useCallback(
    (on: boolean) => {
      if (!proposal) return;
      setExcluded(on ? new Set() : new Set((proposal.slots ?? []).map(slotKey)));
    },
    [proposal],
  );

  /**
   * Gọi AI đề xuất lịch cho 1 danh sách task.
   *
   * ⚠️ Gửi **1 request duy nhất** chứa TẤT CẢ task đã chọn.
   *
   * Lý do (xác nhận từ BE — đọc DB, chỉ SELECT):
   *   - Gọi song song mỗi task 1 request (`Promise.all`) → các request không
   *     thấy nhau, cùng thấy 1 khung giờ trống nên **cùng chọn khung đó** →
   *     slot trùng giờ. (BE đã thử 2 task trong 1 lần gọi → không trùng.)
   *   - Tốn N lượt quota thay vì 1.
   *   - Request sau tự đánh dấu proposal trước là `Superseded` → đề xuất cũ
   *     đã được duyệt vẫn còn slot trong DB.
   *
   * `taskIds` bỏ trống → tự lấy mọi task Flexible chưa có lịch.
   */
  const run = useCallback(
    async (taskIds?: string[]) => {
      if (inFlight.current) return;
      const pool = taskIds?.length
        ? (taskIds.map((id) => tasksById.get(id)).filter(Boolean) as TaskDto[])
        : collectSchedulableTasks(
            Array.from(tasksById.values()),
            scheduledTaskIds,
            subtasks ?? [],
            scheduledSubtaskIds ?? new Set(),
          );

      if (pool.length === 0) {
        setError("Không còn task Flexible nào chưa có lịch.");
        toast.info("Không có gì để xếp", "Mọi task flexible đều đã có lịch.");
        return;
      }

      inFlight.current = true;
      setLoading(true);
      setError(null);
      setProposal(null);
      setExcluded(new Set());
      setCandidates(pool);

      // ── 1 request gộp TẤT CẢ task ──────────────────────────────
      // `try/finally` để `inFlight` luôn được reset, kể cả khi request throw
      // → không bị kẹt ở trạng thái "đang chạy" sau khi lỗi mạng.
      let res: Awaited<ReturnType<typeof proposeSchedule>>;
      try {
        res = await proposeSchedule({
          task_ids: pool.map((t) => t.id),
          language: "vi",
        });
      } catch (e) {
        const msg = e instanceof Error ? e.message : "Lỗi mạng khi gọi AI xếp lịch.";
        setError(msg);
        toast.error("Không lấy được đề xuất", msg);
        return;
      } finally {
        inFlight.current = false;
        setLoading(false);
      }

      if (!res.ok) {
        // KHÔNG fallback gọi từng task riêng — đó chính là nguồn gây trùng
        // giờ + tốn quota. Báo lỗi và để user thử lại.
        const msg = res.error || "Không gọi được AI để xếp lịch.";
        setError(msg);
        toast.error("Không lấy được đề xuất", msg);
        return;
      }

      const merged = mergeProposals([res.data]);
      setProposal(merged);

      if (merged.slots.length === 0) {
        // Cảnh báo vẫn được giữ trong `merged.warnings` → UI hiện lý do cụ thể.
        toast.info("AI chưa tìm được chỗ trống", merged.explanation ?? undefined);
      }
    },
    [
      scheduledTaskIds,
      tasksById,
      subtasks,
      scheduledSubtaskIds,
      toast,
    ],
  );

  /**
   * Ghi các slot đang chọn vào calendar.
   *
   * Duyệt **từng slot** một lần gọi API để 1 slot lỗi không chặn các slot còn
   * lại. Trả về số slot tạo thành công để caller refresh dữ liệu.
   */
  const approve = useCallback(async (): Promise<number> => {
    if (!proposal || approving) return 0;
    // Chốt bằng ref: `approving` là state nên 2 click trong cùng 1 tick vẫn
    // cùng thấy `approving === false` → tạo trùng slot trong calendar.
    if (approvingRef.current) return 0;
    const slots = selectedSlots;
    if (slots.length === 0) {
      toast.info("Chưa chọn khung giờ nào", "Hãy tick ít nhất 1 khung giờ rồi bấm Apply.");
      return 0;
    }

    approvingRef.current = true;
    setApproving(true);
    const failed: Array<{ key: string; title: string }> = [];
    let created = 0;

    // Mỗi slot thuộc proposal riêng của task đó (nếu đã gộp nhiều task).
    const proposalIdBySlot = proposal.proposalIdBySlot;
    const proposalIdBySlotFn = (slot: ProposedSlotDto): string | undefined =>
      proposalIdBySlot?.get(slotKey(slot));

    for (const slot of slots) {
      const res = await createScheduleSlot(slot.task_id, {
        subTaskId: slot.subtask_id ?? null,
        // Mỗi task có proposal riêng → phải gửi id đúng của task đó, không
        // dùng chung `proposal.proposal_id` (sẽ bị backend từ chối).
        scheduleProposalId: proposalIdBySlotFn(slot) ?? proposal.proposal_id,
        startTime: slot.start,
        endTime: slot.end,
        originalStartTime: slot.start,
        isManualOverride: false,
        kbiasUsed: 0,
        explanation: slot.explanation ?? null,
        status: "Approved",
      });
      if (res.ok) created += 1;
      else {
        failed.push({
          key: slotKey(slot),
          title: tasksById.get(slot.task_id)?.title ?? slot.task_id,
        });
      }
    }

    setApproving(false);
    approvingRef.current = false;

    if (failed.length === 0) {
      toast.success(`Đã apply ${created} khung giờ`, "Lịch đã cập nhật cho các slot được chọn.");
      reset();
      return created;
    }

    // Một phần thành công → bỏ chọn sẵn slot lỗi, giữ panel mở để duyệt lại.
    const failedKeys = new Set(failed.map((f) => f.key));
    setExcluded(failedKeys);
    toast.error(
      `${created}/${slots.length} khung giờ đã apply`,
      `Không tạo được: ${failed.map((f) => f.title).join(", ")}`,
    );
    return created;
  }, [proposal, approving, selectedSlots, tasksById, toast, reset]);

  return {
    proposal,
    candidates,
    loading,
    approving,
    error,
    /** slot_key đang bị bỏ chọn. */
    excluded,
    selectedSlots,
    unscheduledTaskIds,
    run,
    approve,
    toggle,
    toggleAll,
    close,
    reset,
  };
}

export type UseScheduleProposal = ReturnType<typeof useScheduleProposal>;