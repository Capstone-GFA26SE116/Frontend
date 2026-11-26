import { useCallback, useEffect, useMemo, useState } from "react";
import {
  listGroupScheduleSlots,
  type GroupScheduleSlotDto,
  type GroupTaskDto,
} from "../../lib/group-api";
import { useNotificationsContext } from "../../components/focus/notifications-context-state";
import { signalAffectsSchedule } from "../../hooks/useNotifications";
import { fmtGroupDateTime, fmtMinutes } from "./group-logic";
import "./group-schedule.css";

/**
 * ===========================================================
 * <GroupScheduleBoard> — LỊCH TUẦN CỦA NHÓM.
 * ===========================================================
 *
 * Trả lời câu hỏi "nhóm này làm tới đâu rồi?" theo góc nhìn thời gian:
 *  - Ai đang làm việc gì, khung giờ nào trong tuần.
 *  - Khung giờ nào đã xong / đang chạy / còn trôi / bị huỷ.
 *  - Tổng giờ đã cam kết vs giờ đã hoàn thành.
 *
 * Nguồn dữ liệu:
 *  - Slot của việc nhóm: `GET /api/group-tasks/{taskId}/schedule-slots`
 *    (mục 10 của cập nhật BE — slot nhóm có `taskId = null`).
 *  - Giờ cố định của việc: `fixedStart` / `fixedEnd` (họp, hẹn).
 *
 * Giao diện theo `DESIGN.md`: canvas #101010 · hairline #3d3a39 ·
 * accent #00d992 · card radius 8px · pill 9999px.
 */

/* ---------- Date helpers (week starts Monday) ---------- */
function startOfWeek(d: Date): Date {
  const r = new Date(d);
  const day = r.getDay();
  r.setDate(r.getDate() + (day === 0 ? -6 : 1 - day));
  r.setHours(0, 0, 0, 0);
  return r;
}
function addDays(d: Date, n: number): Date {
  const r = new Date(d);
  r.setDate(r.getDate() + n);
  return r;
}
function isSameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}
function fmtTime(d: Date): string {
  return d.toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

const WEEKDAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const MONTH_LABELS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

/* ===========================================================
 * Shape nội bộ
 * =========================================================== */

/** Một khối lịch trong tuần (slot nhóm hoặc giờ cố định của việc). */
interface BoardBlock {
  key: string;
  title: string;
  /** Id việc nhóm (để bấm vào mở đúng việc). */
  groupTaskId: string;
  start: Date;
  end: Date;
  /** Người được giao. */
  assigneeId?: string | null;
  /** Tên người được giao (đã resolve). */
  assigneeName: string;
  /** `slot` = khung giờ thật, `fixed` = giờ cố định của việc. */
  kind: "slot" | "fixed";
  /** Trạng thái (slot) — `null` với giờ cố định. */
  status: string | null;
  /** Phút đã định (slot) — `null` với giờ cố định. */
  minutes: number | null;
  /** Slot đã đóng (Cancelled / Done / Skipped / Missed). */
  closed: boolean;
  /** Slot đang chạy (Approved / Due / InProgress). */
  active: boolean;
}

/** Trạng thái slot → tone màu (khớp `slotStatusTone` bên dưới). */
function slotTone(status: string | null): "done" | "active" | "todo" | "skipped" {
  const s = (status ?? "").trim().toLowerCase();
  if (s === "done") return "done";
  if (s === "approved" || s === "due" || s === "inprogress") return "active";
  if (s === "proposed") return "todo";
  return "skipped";
}

/** Trạng thái slot → nhãn tiếng Anh. */
function slotLabel(status: string | null): string {
  const s = (status ?? "").trim().toLowerCase();
  if (s === "proposed") return "Proposed";
  if (s === "approved") return "Approved";
  if (s === "due") return "Due";
  if (s === "inprogress") return "In Progress";
  if (s === "done") return "Done";
  if (s === "skipped") return "Skipped";
  if (s === "missed") return "Missed";
  if (s === "cancelled") return "Cancelled";
  return status ?? "—";
}

/** Slot đã đóng (không còn dùng). */
function isClosedStatus(status: string | null): boolean {
  const s = (status ?? "").trim().toLowerCase();
  return (
    s === "cancelled" ||
    s === "done" ||
    s === "skipped" ||
    s === "missed"
  );
}

/** Slot đang chiếm giờ (được tính vào "đang làm"). */
function isActiveStatus(status: string | null): boolean {
  const s = (status ?? "").trim().toLowerCase();
  return (
    s === "approved" || s === "due" || s === "inprogress" || s === "overrun"
  );
}

export interface GroupScheduleBoardProps {
  /** Id nhóm (để nạp lại khi có thay đổi). */
  groupId: string;
  /** Danh sách việc của nhóm. */
  tasks: GroupTaskDto[];
  /** Id → tên thành viên (để hiện "ai đang làm"). */
  memberNames: Record<string, string>;
  /** Tên nhóm — hiện ở tiêu đề. */
  groupName?: string | null;
  /** Đã archive → không cho tạo slot mới. */
  archived?: boolean;
  /** Bấm vào 1 khối lịch → mở việc nhóm tương ứng. */
  onOpenTask?: (groupTaskId: string) => void;
}

export function GroupScheduleBoard({
  groupId,
  tasks,
  memberNames,
  groupName,
  onOpenTask,
}: GroupScheduleBoardProps) {
  /** Tuần đang xem (luôn là 00:00 của thứ Hai). */
  const [anchor, setAnchor] = useState(() => startOfWeek(new Date()));
  const [slots, setSlots] = useState<GroupScheduleSlotDto[]>([]);
  const [loading, setLoading] = useState(true);

  /* ---------- Nạp slot của toàn bộ việc trong nhóm ---------- */
  const loadSlots = useCallback(async () => {
    if (!groupId) return;
    setLoading(true);
    const all: GroupScheduleSlotDto[] = [];
    for (const t of tasks) {
      const res = await listGroupScheduleSlots(t.id);
      if (res.ok) all.push(...(res.data ?? []));
    }
    setSlots(all);
    setLoading(false);
  }, [groupId, tasks]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- data-fetch pattern
    void loadSlots();
  }, [loadSlots]);

  /**
   * Mục 10 (BE cập nhật): `GroupStatusChanged` → slot chưa bắt đầu của người
   * cũ bị huỷ (việc giao lại / người rời nhóm) → nạp lại lịch nhóm.
   */
  const notif = useNotificationsContext();

  useEffect(() => {
    return notif.onSignal((signal) => {
      if (!signalAffectsSchedule(signal)) return;
      void loadSlots();
    });
  }, [notif, loadSlots]);

  /* ---------- Chuẩn hoá thành khối lịch ---------- */
  const blocks = useMemo<BoardBlock[]>(() => {
    const out: BoardBlock[] = [];

    // 1) Slot nhóm.
    for (const s of slots) {
      const start = new Date(s.startTime);
      const end = new Date(s.endTime);
      if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) continue;
      const task = tasks.find((t) => t.id === s.groupTaskId);
      const owner = s.userId ?? task?.assigneeId ?? null;
      out.push({
        key: `slot-${s.id}`,
        title: s.taskTitle ?? task?.title ?? "Group task",
        groupTaskId: s.groupTaskId,
        start,
        end,
        assigneeId: owner,
        assigneeName: owner
          ? (memberNames[owner] ?? "Unassigned")
          : "Unassigned",
        kind: "slot",
        status: s.status ?? null,
        minutes:
          s.proposedMinutes > 0
            ? s.proposedMinutes
            : Math.max(
                0,
                Math.round((end.getTime() - start.getTime()) / 60000),
              ),
        closed: isClosedStatus(s.status),
        active: isActiveStatus(s.status),
      });
    }

    // 2) Giờ cố định của việc (họp, hẹn) — chưa có slot nào phủ.
    for (const t of tasks) {
      if (!t.fixedStart || !t.fixedEnd) continue;
      const start = new Date(t.fixedStart);
      const end = new Date(t.fixedEnd);
      if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) continue;
      // Nếu việc đã có slot phủ đúng khung giờ này → bỏ qua (tránh trùng).
      const covered = slots.some(
        (s) =>
          s.groupTaskId === t.id &&
          new Date(s.startTime).getTime() === start.getTime() &&
          new Date(s.endTime).getTime() === end.getTime(),
      );
      if (covered) continue;
      out.push({
        key: `fixed-${t.id}`,
        title: t.title,
        groupTaskId: t.id,
        start,
        end,
        assigneeId: t.assigneeId ?? null,
        assigneeName: t.assigneeId
          ? (memberNames[t.assigneeId] ?? "Unassigned")
          : "Unassigned",
        kind: "fixed",
        status: null,
        minutes: Math.max(0, Math.round((end.getTime() - start.getTime()) / 60000)),
        closed: false,
        active: false,
      });
    }

    return out.sort((a, b) => a.start.getTime() - b.start.getTime());
  }, [slots, tasks, memberNames]);

  /* ---------- Lọc theo tuần đang xem ---------- */
  const weekStart = useMemo(() => startOfWeek(anchor), [anchor]);
  const weekEnd = useMemo(() => {
    const e = addDays(weekStart, 7);
    e.setHours(0, 0, 0, 0);
    return e;
  }, [weekStart]);

  const weekBlocks = useMemo(
    () =>
      blocks.filter(
        (b) =>
          b.start.getTime() < weekEnd.getTime() &&
          b.end.getTime() > weekStart.getTime(),
      ),
    [blocks, weekStart, weekEnd],
  );

  /** 7 cột ngày, mỗi cột là 1 danh sách khối. */
  const days = useMemo(
    () =>
      Array.from({ length: 7 }).map((_, i) => {
        const date = addDays(weekStart, i);
        const next = addDays(date, 1);
        return {
          date,
          blocks: weekBlocks.filter(
            (b) =>
              b.start.getTime() < next.getTime() &&
              b.end.getTime() > date.getTime(),
          ),
        };
      }),
    [weekStart, weekBlocks],
  );

  /* ---------- Thống kê tuần ---------- */
  const stats = useMemo(() => {
    const booked = weekBlocks.reduce((sum, b) => sum + (b.minutes ?? 0), 0);
    const done = weekBlocks
      .filter((b) => b.closed && b.status?.toLowerCase() === "done")
      .reduce((sum, b) => sum + (b.minutes ?? 0), 0);
    const active = weekBlocks.filter((b) => b.active).length;
    const cancelled = weekBlocks.filter(
      (b) => b.closed && b.status?.toLowerCase() === "cancelled",
    ).length;
    return { booked, done, active, cancelled, total: weekBlocks.length };
  }, [weekBlocks]);

  /** Tiêu đề khoảng tuần. */
  const periodLabel = useMemo(() => {
    const s = weekStart;
    const e = addDays(weekStart, 6);
    const sameMonth = s.getMonth() === e.getMonth();
    if (sameMonth) {
      return `${s.getDate()} – ${e.getDate()} ${MONTH_LABELS[s.getMonth()]} ${s.getFullYear()}`;
    }
    return `${s.getDate()} ${MONTH_LABELS[s.getMonth()]} – ${e.getDate()} ${MONTH_LABELS[e.getMonth()]} ${e.getFullYear()}`;
  }, [weekStart]);

  /* ---------- Tiến độ theo thành viên trong tuần ---------- */
  /** Mỗi thành viên: giờ đã cam kết / đã xong / số khối. */
  const perMember = useMemo(() => {
    const map = new Map<
      string,
      { name: string; booked: number; done: number; blocks: number }
    >();
    for (const b of weekBlocks) {
      const key = b.assigneeId ?? "__unassigned__";
      const cur =
        map.get(key) ??
        {
          name: b.assigneeName,
          booked: 0,
          done: 0,
          blocks: 0,
        };
      cur.booked += b.minutes ?? 0;
      cur.blocks += 1;
      if (b.status?.toLowerCase() === "done") cur.done += b.minutes ?? 0;
      map.set(key, cur);
    }
    return [...map.entries()].sort((a, b) => b[1].booked - a[1].booked);
  }, [weekBlocks]);

  const today = new Date();

  return (
    <div className="gsb">
      {/* ---------- Header: điều hướng tuần ---------- */}
      <div className="gsb-head">
        <div className="gsb-head-text">
          <span className="gsb-eyebrow">Group schedule</span>
          <h2 className="gsb-title">
            {groupName ? `${groupName} · ` : ""}
            {periodLabel}
          </h2>
        </div>
        <div className="gsb-nav">
          <button
            type="button"
            className="gdt-btn gdt-btn--ghost gdt-btn--sm"
            onClick={() => setAnchor(addDays(anchor, -7))}
          >
            <span className="material-symbols-outlined gdt-btn-icon">
              chevron_left
            </span>
            <span>Prev</span>
          </button>
          <button
            type="button"
            className="gdt-btn gdt-btn--ghost gdt-btn--sm"
            onClick={() => setAnchor(startOfWeek(new Date()))}
          >
            <span>Today</span>
          </button>
          <button
            type="button"
            className="gdt-btn gdt-btn--ghost gdt-btn--sm"
            onClick={() => setAnchor(addDays(anchor, 7))}
          >
            <span>Next</span>
            <span className="material-symbols-outlined gdt-btn-icon">
              chevron_right
            </span>
          </button>
        </div>
      </div>

      {/* ---------- Thống kê tuần ---------- */}
      <div className="gsb-stats">
        <span className="gsb-stat">
          <span className="gsb-stat-value">{stats.total}</span>
          <span className="gsb-stat-label">blocks</span>
        </span>
        <span className="gsb-stat">
          <span className="gsb-stat-value">{fmtMinutes(stats.booked)}</span>
          <span className="gsb-stat-label">booked</span>
        </span>
        <span className="gsb-stat gsb-stat--accent">
          <span className="gsb-stat-value">{fmtMinutes(stats.done)}</span>
          <span className="gsb-stat-label">completed</span>
        </span>
        <span className="gsb-stat">
          <span className="gsb-stat-value">{stats.active}</span>
          <span className="gsb-stat-label">in progress</span>
        </span>
        {stats.cancelled > 0 && (
          <span className="gsb-stat gsb-stat--danger">
            <span className="gsb-stat-value">{stats.cancelled}</span>
            <span className="gsb-stat-label">cancelled</span>
          </span>
        )}
      </div>

      {/* ---------- Bảng 7 ngày ---------- */}
      {loading ? (
        <p className="gdt-empty">Loading the group schedule…</p>
      ) : weekBlocks.length === 0 ? (
        <div className="gsb-empty">
          <span className="material-symbols-outlined gsb-empty-icon">
            event_busy
          </span>
          <p className="gsb-empty-title">Nothing scheduled this week</p>
          <p className="gsb-empty-text">
            Open a task in the Tasks tab and add a time slot so the whole team
            can see who is working on what.
          </p>
        </div>
      ) : (
        <div className="gsb-grid">
          {days.map((d, i) => {
            const isToday = isSameDay(d.date, today);
            return (
              <div
                key={d.date.toISOString()}
                className={`gsb-day${isToday ? " gsb-day--today" : ""}`}
              >
                <div className="gsb-day-head">
                  <span className="gsb-day-name">{WEEKDAY_LABELS[i]}</span>
                  <span className="gsb-day-date">{d.date.getDate()}</span>
                  {d.blocks.length > 0 && (
                    <span className="gsb-day-count">{d.blocks.length}</span>
                  )}
                </div>
                <div className="gsb-day-body">
                  {d.blocks.length === 0 ? (
                    <span className="gsb-day-empty">—</span>
                  ) : (
                    d.blocks.map((b) => {
                      const tone = slotTone(b.status);
                      return (
                        <button
                          type="button"
                          key={b.key}
                          className={`gsb-block gsb-block--${tone}${
                            b.closed ? " gsb-block--closed" : ""
                          }${b.kind === "fixed" ? " gsb-block--fixed" : ""}`}
                          title={`${b.title} · ${b.assigneeName} · ${fmtTime(
                            b.start,
                          )} – ${fmtTime(b.end)}`}
                          onClick={() => onOpenTask?.(b.groupTaskId)}
                        >
                          <span className="gsb-block-title">{b.title}</span>
                          <span className="gsb-block-meta">
                            {fmtTime(b.start)} – {fmtTime(b.end)}
                          </span>
                          <span className="gsb-block-foot">
                            <span className="gsb-block-owner">
                              {b.assigneeName}
                            </span>
                            {b.status && (
                              <span
                                className={`gsb-block-status gsb-block-status--${tone}`}
                              >
                                {slotLabel(b.status)}
                              </span>
                            )}
                            {b.kind === "fixed" && (
                              <span className="gsb-block-status">Fixed</span>
                            )}
                          </span>
                        </button>
                      );
                    })
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* ---------- Tiến độ theo thành viên trong tuần ---------- */}
      {perMember.length > 0 && (
        <div className="gsb-members">
          <span className="gsb-eyebrow">Who is working on what</span>
          <ul className="gsb-member-list">
            {perMember.map(([id, m]) => {
              const pct =
                m.booked > 0 ? Math.round((m.done / m.booked) * 100) : 0;
              return (
                <li key={id} className="gsb-member">
                  <span className="gsb-member-name">{m.name}</span>
                  <span className="gsb-member-blocks">
                    {m.blocks} block{m.blocks > 1 ? "s" : ""}
                  </span>
                  <span className="gsb-member-bar">
                    <span
                      className="gsb-member-fill"
                      style={{ width: `${pct}%` }}
                      role="progressbar"
                      aria-valuenow={pct}
                      aria-valuemin={0}
                      aria-valuemax={100}
                      aria-label={`Completed time for ${m.name}`}
                    />
                  </span>
                  <span className="gsb-member-time">
                    {fmtMinutes(m.done)} / {fmtMinutes(m.booked)}
                  </span>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {/* ---------- Danh sách slot đã huỷ (gần nhất) ---------- */}
      {stats.cancelled > 0 && (
        <div className="gsb-cancelled">
          <span className="gsb-eyebrow">Cancelled this week</span>
          <ul className="gsb-cancelled-list">
            {weekBlocks
              .filter(
                (b) => b.closed && b.status?.toLowerCase() === "cancelled",
              )
              .map((b) => (
                <li key={b.key} className="gsb-cancelled-item">
                  <span className="gsb-cancelled-title">{b.title}</span>
                  <span className="gsb-cancelled-meta">
                    {fmtGroupDateTime(b.start.toISOString())} ·{" "}
                    {b.assigneeName}
                  </span>
                </li>
              ))}
          </ul>
        </div>
      )}
    </div>
  );
}
