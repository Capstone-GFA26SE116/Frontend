/**
 * ===========================================================
 * Gợi ý người làm cho việc nhóm (AI)
 * ===========================================================
 *
 * Spec: `GROUP_AI_FE.md` mục 1.
 *
 * Luồng: Leader bấm "Suggest assignee" → AI trả danh sách xếp hạng →
 * Leader chọn 1 người → FE gọi Backend `PUT /api/group-tasks/{id}/assignee`.
 *
 * ⚠️ AI **không** giao việc và **không** trả tên/email (riêng tư) — chỉ trả
 *    `user_id`. FE ghép tên từ `GET /api/groups/{id}/members`.
 *
 * Giao diện theo `DESIGN.md` (prefix `.gai-*`):
 *   canvas #101010, canvas-soft #1a1a1a, hairline #3d3a39
 *   primary #00d992 (accent duy nhất), radius card 8px / button 6px
 */

import { useMemo } from "react";
import type {
  GroupAssigneeSuggestionDto,
  GroupAssigneeSuggestionsDto,
} from "../../lib/group-ai-api";
import { reasonsSkippedNote } from "./group-ai-errors";
import "./group-ai.css";

export interface GroupAiMember {
  userId: string;
  fullName: string;
  role: string;
}

/** Bản chỉnh sửa trước khi gửi BE (Leader có thể đổi người làm). */
export interface GroupAiSuggestionOverride {
  title: string;
  estimatedMinutes: string;
  assigneeId: string;
}

export interface GroupAssigneeSuggestionsModalProps {
  /** Task đang xét — dùng cho tiêu đề. */
  taskTitle: string;
  /** Dữ liệu AI trả về. */
  data: GroupAssigneeSuggestionsDto | null;
  /** Danh sách thành viên để ghép `user_id` → tên. */
  members: GroupAiMember[];
  /** Đang gọi AI (hiện spinner trong nút). */
  loading: boolean;
  /** Lỗi đã dịch sang tiếng Anh (đã hiện qua GroupErrorDialog). */
  onClose: () => void;
  /** Leader chọn người → gọi BE giao việc. */
  onAssign: (userId: string) => void;
  /** Gọi lại AI (tốn thêm 1 lượt — cần cảnh báo). */
  onRetry?: () => void;
  /** Danh sách loại công việc (Coding, Design…) để AI dùng đúng ước lượng. */
  domains?: { id: string; name: string }[];
  /** Loại công việc đang chọn. */
  domainId?: string;
  /** Đổi loại công việc → gọi lại AI. */
  onDomainChange?: (domainId: string) => void;
}

/** "2699" phút → "45h" / "6h 5m". */
function fmtFreeMinutes(min: number | null | undefined): string {
  if (min == null || !Number.isFinite(min)) return "—";
  if (min < 60) return `${Math.round(min)}m`;
  const h = Math.floor(min / 60);
  const m = Math.round(min % 60);
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

/** ISO có offset → hiển thị giờ địa phương, gọn gàng. */
function fmtFreeWindow(start: string, end: string): string {
  const s = new Date(start);
  const e = new Date(end);
  if (Number.isNaN(s.getTime()) || Number.isNaN(e.getTime())) {
    return `${start} → ${end}`;
  }
  const day = s.toLocaleDateString(undefined, {
    weekday: "short",
    day: "numeric",
    month: "short",
  });
  const t1 = s.toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const t2 = e.toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  return `${day}, ${t1} → ${t2}`;
}

/** Nhãn tone cho `fits`. */
function fitsLabel(fits: boolean | null): {
  label: string;
  tone: "ok" | "warn" | "unknown";
} {
  if (fits === true) return { label: "Fits the deadline", tone: "ok" };
  if (fits === false) return { label: "May not fit", tone: "warn" };
  return { label: "No estimate yet", tone: "unknown" };
}

/**
 * Modal gợi ý người làm.
 *
 * Trả về `null` (không render) khi chưa có dữ liệu và không đang tải —
 * trạng thái "loading" được xử lý bởi component cha (nút bấm hiện spinner).
 */
export function GroupAssigneeSuggestionsModal({
  taskTitle,
  data,
  members,
  loading,
  onClose,
  onAssign,
  onRetry,
  domains,
  domainId,
  onDomainChange,
}: GroupAssigneeSuggestionsModalProps) {
  /** Ghép `user_id` → thông tin thành viên. */
  const memberMap = useMemo(() => {
    const map = new Map<string, GroupAiMember>();
    for (const m of members) map.set(m.userId, m);
    return map;
  }, [members]);

  const suggestions: GroupAssigneeSuggestionDto[] = data?.suggestions ?? [];
  const skippedNote = reasonsSkippedNote(data?.reasons_skipped);

  return (
    <div className="gai-backdrop" role="presentation" onClick={onClose}>
      <div
        className="gai-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="gai-sug-title"
        onClick={(e) => e.stopPropagation()}
      >
        {/* ---------- Đầu ---------- */}
        <div className="gai-head">
          <span className="gai-head-icon" aria-hidden="true">
            <span className="material-symbols-outlined">auto_awesome</span>
          </span>
          <div className="gai-head-text">
            <span className="gai-eyebrow">AI suggestion</span>
            <h2 id="gai-sug-title" className="gai-title">
              Who should take this on?
            </h2>
            <p className="gai-subtitle">{taskTitle}</p>
          </div>
          <button
            type="button"
            className="gai-close"
            onClick={onClose}
            aria-label="Close"
          >
            <span className="material-symbols-outlined">close</span>
          </button>
        </div>

        {/* ---------- Thân ---------- */}
        <div className="gai-body">
          {/*
           * Chọn loại công việc — AI dùng đúng thói quen ước lượng của mỗi
           * người theo loại việc (spec mục 1). Không chọn vẫn chạy được.
           */}
          {domains && domains.length > 0 && (
            <div className="gai-domain-picker">
              <label className="gai-field-label" htmlFor="gai-sug-domain">
                Work type
              </label>
              <select
                id="gai-sug-domain"
                className="gai-select"
                value={domainId ?? ""}
                onChange={(e) => onDomainChange?.(e.target.value)}
                disabled={loading}
              >
                <option value="">Any work type</option>
                {domains.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name}
                  </option>
                ))}
              </select>
              <span className="gai-domain-hint">
                Helps AI estimate each member more accurately.
              </span>
            </div>
          )}

          {loading && (
            <div className="gai-state" role="status">
              <span className="material-symbols-outlined gai-spin">progress_activity</span>
              <span>AI is ranking the best people for this task…</span>
            </div>
          )}

          {!loading && suggestions.length === 0 && (
            <div className="gai-state">
              <span className="material-symbols-outlined">group_off</span>
              <span>
                No one in this group can be assigned work right now. Add a
                member first.
              </span>
            </div>
          )}

          {!loading && skippedNote && (
            <div className="gai-note" role="status">
              <span className="material-symbols-outlined" aria-hidden="true">
                info
              </span>
              <span>{skippedNote}</span>
            </div>
          )}

          {!loading && suggestions.length > 0 && (
            <ul className="gai-list">
              {suggestions.map((s) => {
                const member = memberMap.get(s.user_id);
                const name = member?.fullName ?? "Unknown member";
                const fits = fitsLabel(s.fits);
                return (
                  <li key={s.user_id} className="gai-item">
                    <div className="gai-item-main">
                      {/* Hạng */}
                      <span
                        className={
                          "gai-rank" + (s.rank === 1 ? " gai-rank--top" : "")
                        }
                        aria-label={`Rank ${s.rank}`}
                      >
                        {s.rank === 1 ? (
                          <span
                            className="material-symbols-outlined"
                            aria-hidden="true"
                            style={{ fontVariationSettings: "'FILL' 1" }}
                          >
                            workspace_premium
                          </span>
                        ) : (
                          s.rank
                        )}
                      </span>

                      {/* Thông tin */}
                      <div className="gai-item-body">
                        <div className="gai-item-title-row">
                          <span className="gai-item-name">{name}</span>
                          <span className="gai-role">{s.role}</span>
                          {s.is_current_assignee && (
                            <span className="gai-tag gai-tag--current">
                              Currently on it
                            </span>
                          )}
                          {s.busy_at_fixed_time && (
                            <span className="gai-tag gai-tag--busy">
                              <span
                                className="material-symbols-outlined"
                                aria-hidden="true"
                              >
                                warning
                              </span>
                              Busy at that time
                            </span>
                          )}
                        </div>

                        {/* Chỉ số */}
                        <div className="gai-metrics">
                          <span
                            className={`gai-metric gai-metric--${fits.tone}`}
                          >
                            <span
                              className="material-symbols-outlined"
                              aria-hidden="true"
                            >
                              {fits.tone === "ok"
                                ? "check_circle"
                                : fits.tone === "warn"
                                  ? "error"
                                  : "help"}
                            </span>
                            {fits.label}
                          </span>
                          <span className="gai-metric">
                            <span
                              className="material-symbols-outlined"
                              aria-hidden="true"
                            >
                              hourglass_empty
                            </span>
                            {fmtFreeMinutes(s.free_minutes)} free
                          </span>
                          {s.group_work_minutes > 0 && (
                            <span className="gai-metric">
                              <span
                                className="material-symbols-outlined"
                                aria-hidden="true"
                              >
                                work
                              </span>
                              {fmtFreeMinutes(s.group_work_minutes)} of group
                              work
                            </span>
                          )}
                        </div>

                        {/* Khung giờ trống */}
                        {s.free_times.length > 0 && (
                          <div className="gai-slots">
                            {s.free_times.map((ft, i) => (
                              <span key={i} className="gai-slot">
                                {fmtFreeWindow(ft.start, ft.end)}
                              </span>
                            ))}
                          </div>
                        )}

                        {/* Lý do của AI */}
                        {s.reason && (
                          <p className="gai-reason">{s.reason}</p>
                        )}
                      </div>
                    </div>

                    {/* Hành động */}
                    <div className="gai-item-actions">
                      <button
                        type="button"
                        className="gai-btn gai-btn--primary"
                        onClick={() => onAssign(s.user_id)}
                        disabled={loading}
                      >
                        <span
                          className="material-symbols-outlined"
                          aria-hidden="true"
                        >
                          person_check
                        </span>
                        Giao việc
                      </button>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        {/* ---------- Chân ---------- */}
        <div className="gai-actions">
          {onRetry && (
            <button
              type="button"
              className="gai-btn gai-btn--ghost"
              onClick={onRetry}
              disabled={loading}
            >
              <span className="material-symbols-outlined" aria-hidden="true">
                refresh
              </span>
              Run again
            </button>
          )}
          <button
            type="button"
            className="gai-btn gai-btn--ghost"
            onClick={onClose}
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
