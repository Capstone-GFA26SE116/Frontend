import { useCallback, useMemo, useRef, useState } from "react";
import {
  createScheduleSlot,
  proposeSchedule,
  type ProposeScheduleResponse,
  type ProposedSlotDto,
  type ScheduleWarningDto,
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

/**
 * Task đủ điều kiện để nhờ AI xếp lịch.
 *
 * - `flexible`: BE chỉ nhận task loại Flexible (task Fixed đã ghim giờ rồi).
 * - chưa có `fixedStart`/`fixedEnd`: tránh xếp đè lịch đã ghim.
 * - chưa có schedule slot: tránh xếp trùng.
 * - chưa xong / chưa huỷ: không xếp lịch cho việc đã kết thúc.
 */
export function collectSchedulableTasks(
  tasks: TaskDto[],
  scheduledTaskIds: Set<string>,
): TaskDto[] {
  return tasks.filter((t) => {
    if (!t.id) return false;
    if (scheduledTaskIds.has(t.id)) return false;
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
 * Gộp nhiều proposal (mỗi proposal ứng với 1 task) thành 1 để UI hiển thị chung.
 *
 * Quan trọng: mỗi task có `proposal_id` riêng. Hàm này trả kèm
 * `proposalIdBySlot` để khi duyệt, ta gửi đúng `scheduleProposalId` của task
 * đó — dùng chung 1 id sẽ bị backend từ chối.
 *
 * - `is_feasible`: true chỉ khi mọi proposal đều feasible.
 * - `missing_minutes`: tổng số phút thiếu của các proposal không feasible.
 * - `slots` / `warnings`: nối lại, giữ nguyên thứ tự.
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
  toast: ProposalToastApi;
}) {
  const { scheduledTaskIds, tasksById, toast } = opts;

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
   * Gọi AI đề xuất lịch cho 1 task.
   *
   * ⚠️ Gửi **đúng 1 task** mỗi lần. Nếu gom nhiều task vào 1 request, một
   * task không xếp được (vd: quá hạn, hoặc `estimatedMinutes = 0`) sẽ kéo theo
   * cả những task còn lại: AI trả `is_feasible: false` cho cả request và UI báo
   * "Còn thiếu Xh so với ước lượng" dù các task kia hoàn toàn ổn. Tách từng
   * task để một task hỏng không ảnh hưởng task khác.
   */
  const runOne = useCallback(
    async (taskId: string): Promise<ProposeScheduleResponse | null> => {
      const res = await proposeSchedule({ task_ids: [taskId], language: "vi" });
      return res.ok ? res.data : null;
    },
    [],
  );

  /**
   * Gọi AI đề xuất lịch cho 1 danh sách task.
   *
   * Mỗi task 1 request riêng, chạy song song → 1 proposal riêng cho mỗi task,
   * rồi gộp lại để UI hiện chung. Task nào không xếp được sẽ không làm hỏng
   * các task còn lại.
   *
   * `taskIds` bỏ trống → tự lấy mọi task Flexible chưa có lịch.
   */
  const run = useCallback(
    async (taskIds?: string[]) => {
      if (inFlight.current) return;
      const pool = taskIds?.length
        ? (taskIds.map((id) => tasksById.get(id)).filter(Boolean) as TaskDto[])
        : collectSchedulableTasks(Array.from(tasksById.values()), scheduledTaskIds);

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

      // Song song, 1 task = 1 request → kết quả tách bạch theo từng task.
      const responses = await Promise.all(pool.map((t) => runOne(t.id)));

      inFlight.current = false;
      setLoading(false);

      const okList = responses.filter(Boolean) as ProposeScheduleResponse[];
      const failedCount = pool.length - okList.length;

      if (okList.length === 0) {
        const msg = "Không gọi được AI cho bất kỳ task nào.";
        setError(msg);
        toast.error("Không lấy được đề xuất", msg);
        return;
      }

      const merged = mergeProposals(okList);
      setProposal(merged);

      if (merged.slots.length === 0) {
        // Cảnh báo vẫn được giữ trong `merged.warnings` → UI hiện lý do cụ thể.
        toast.info("AI chưa tìm được chỗ trống", merged.explanation ?? undefined);
      } else if (failedCount > 0) {
        toast.info(
          "Một số task không lấy được đề xuất",
          `${okList.length}/${pool.length} task thành công.`,
        );
      }
    },
    [scheduledTaskIds, tasksById, toast, runOne],
  );

  /**
   * Ghi các slot đang chọn vào calendar.
   *
   * Duyệt **từng slot** một lần gọi API để 1 slot lỗi không chặn các slot còn
   * lại. Trả về số slot tạo thành công để caller refresh dữ liệu.
   */
  const approve = useCallback(async (): Promise<number> => {
    if (!proposal || approving) return 0;
    const slots = selectedSlots;
    if (slots.length === 0) {
      toast.info("Chưa chọn khung giờ nào", "Hãy tick ít nhất 1 slot để thêm vào lịch.");
      return 0;
    }

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

    if (failed.length === 0) {
      toast.success(`Đã thêm ${created} khung giờ`, "Lịch đã cập nhật cho các slot được duyệt.");
      reset();
      return created;
    }

    // Một phần thành công → bỏ chọn sẵn slot lỗi, giữ panel mở để duyệt lại.
    const failedKeys = new Set(failed.map((f) => f.key));
    setExcluded(failedKeys);
    toast.error(
      `${created}/${slots.length} khung giờ đã thêm`,
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