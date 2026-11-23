import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useNotificationsContext } from "../../components/focus/notifications-context-state";
import type { NotificationDto } from "../../lib/api-client";
import "./notifications.css";

/**
 * ===========================================================
 * Trang /notifications — hộp thư thông báo
 * ===========================================================
 *
 * API:
 *   GET  /api/notifications?unreadOnly=false&take=50 → danh sách (mới nhất trước)
 *   POST /api/notifications/{id}/read                 → đánh dấu đã đọc (204)
 *   POST /api/notifications/read-all                  → đánh dấu hết
 *
 * Lưu ý từ spec: `type` trong hộp thư chỉ là nhóm lớn ("SlotReminder" |
 * "MissedSlot") — muốn biết chính xác loại gì thì dựa vào `title` +
 * `scheduleSlotId` + trạng thái slot. `actionType` chi tiết chỉ có ở
 * SignalR và Web Push.
 *
 * ⚠️ Thông báo của NHÓM (spec BE GROUP_FE.md mục 6) có thêm `groupId` và
 * `groupTaskId` → bấm vào sẽ mở thẳng nhóm / việc của nhóm.
 */

/** Các type thông báo của nhóm (mục 6 + mục 10 của GROUP_FE.md). */
const GROUP_NOTIFICATION_TYPES = new Set([
  "GroupInvited",
  "GroupAssigned",
  "GroupStatusChanged",
  "GroupMention",
  "GroupChangeRequested",
  "GroupChangeDecided",
]);

/** Icon theo nhóm loại thông báo. */
function iconFor(n: NotificationDto): string {
  const t = (n.type ?? "").toLowerCase();
  if (t === "missedslot") return "event_busy";
  if (GROUP_NOTIFICATION_TYPES.has(n.type ?? "")) {
    if (t === "groupinvited") return "group_add";
    if (t === "groupassigned") return "assignment_ind";
    if (t === "groupstatuschanged") return "published_with_changes";
    if (t === "groupmention") return "alternate_email";
    if (t === "groupchangerequested") return "edit_calendar";
    if (t === "groupchangedecided") return "event_available";
    return "groups";
  }
  const title = (n.title ?? "").toLowerCase();
  if (title.includes("bỏ lỡ")) return "event_busy";
  if (title.includes("quá giờ") || title.includes("overrun")) return "timer_off";
  if (title.includes("tự ngắt")) return "timer_off";
  if (title.includes("sắp")) return "schedule";
  if (title.includes("xong")) return "sentiment_satisfied";
  return "notifications";
}


/** Định dạng thời gian tương đối: "vừa xong" / "5 phút trước" / "2 giờ trước". */
function formatRelative(iso: string | null): string {
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
  return d.toLocaleDateString("vi-VN");
}

export function NotificationsPage() {
  // Dùng CHUNG instance với header (1 SignalR connection cho toàn app).
  const notif = useNotificationsContext();
  const navigate = useNavigate();
  const [filter, setFilter] = useState<"all" | "unread">("all");

  useEffect(() => {
    document.title = "Thông báo · METANOIA";
  }, []);

  const visible = notif.notifications.filter((n) =>
    filter === "unread" ? !n.isRead : true,
  );

  const handleMarkRead = useCallback(
    (id: string) => {
      void notif.markRead(id);
    },
    [notif],
  );

  /**
   * Mở thông báo nhóm → đi thẳng nhóm / việc của nhóm.
   *
   * Theo spec GROUP_FE.md mục 6:
   *  - `GroupInvited` → danh sách lời mời (không có groupTaskId).
   *  - `GroupAssigned` / `GroupStatusChanged` / `GroupMention` → chi tiết
   *    việc `groupTaskId` (với việc con là VIỆC CHA của nó).
   */
  const handleOpen = useCallback(
    (n: NotificationDto) => {
      const groupId = n.groupId;
      if (!groupId) return;
      if (n.groupTaskId) {
        navigate(`/groups/${groupId}`);
        return;
      }
      navigate("/groups");
    },
    [navigate],
  );

  /** Thông báo này có liên kết nhóm để mở không? */
  const groupLinkOf = (n: NotificationDto): string | null => {
    if (!n.groupId) return null;
    if (n.groupTaskId) return `/groups/${n.groupId}`;
    return "/groups";
  };

  return (
    <div className="nt-page">
      <div className="nt-container">
        {/* ----- Header ----- */}
        <header className="nt-header">
          <div className="nt-header-text">
            <span className="nt-eyebrow">
              <span className="nt-eyebrow-dot" aria-hidden="true" />
              Thông báo
            </span>
            <p className="nt-sub">
              Nhắc việc, hết giờ và trạng thái phiên làm việc của bạn.
            </p>
          </div>

          <div className="nt-header-actions">
            <div className="nt-filters" role="group" aria-label="Lọc thông báo">
              <button
                type="button"
                className={`nt-filter${filter === "all" ? " nt-filter--on" : ""}`}
                onClick={() => setFilter("all")}
              >
                Tất cả
              </button>
              <button
                type="button"
                className={`nt-filter${filter === "unread" ? " nt-filter--on" : ""}`}
                onClick={() => setFilter("unread")}
              >
                Chưa đọc
                {notif.unreadCount > 0 && (
                  <span className="nt-filter-count">{notif.unreadCount}</span>
                )}
              </button>
            </div>

            {notif.unreadCount > 0 && (
              <button
                type="button"
                className="nt-btn nt-btn--ghost"
                onClick={() => void notif.markAllRead()}
                disabled={notif.loading}
              >
                <span className="material-symbols-outlined">done_all</span>
                <span>Đánh dấu đã đọc</span>
              </button>
            )}
          </div>
        </header>

        {/* ----- Push notification ----- */}
        <section className="nt-push">
          <div className="nt-push-text">
            <span className="nt-push-title">Thông báo hệ thống</span>
            <span className="nt-push-desc">
              {notif.pushUnsupported
                ? "Trình duyệt này không hỗ trợ Web Push."
                : notif.pushEnabled
                  ? "Đã bật — bạn sẽ nhận thông báo kể cả khi đóng tab."
                  : "Bật để nhận thông báo kể cả khi đóng tab."}
            </span>
          </div>
          {notif.pushUnsupported ? null : notif.pushEnabled ? (
            <button
              type="button"
              className="nt-btn nt-btn--ghost"
              onClick={() => void notif.disablePush()}
            >
              <span className="material-symbols-outlined">notifications_off</span>
              <span>Tắt</span>
            </button>
          ) : (
            <button
              type="button"
              className="nt-btn nt-btn--primary"
              onClick={() => void notif.enablePush()}
            >
              <span className="material-symbols-outlined">notifications_active</span>
              <span>Bật thông báo</span>
            </button>
          )}
        </section>

        {/* ----- Danh sách ----- */}
        {notif.loading && notif.notifications.length === 0 ? (
          <div className="nt-state">
            <span className="material-symbols-outlined nt-state-icon nt-state-icon--spin">
              progress_activity
            </span>
            <p>Đang tải thông báo…</p>
          </div>
        ) : notif.error ? (
          <div className="nt-state nt-state--error">
            <span className="material-symbols-outlined nt-state-icon">error</span>
            <p>{notif.error}</p>
            <button
              type="button"
              className="nt-btn nt-btn--ghost"
              onClick={() => void notif.refresh()}
            >
              Thử lại
            </button>
          </div>
        ) : visible.length === 0 ? (
          <div className="nt-state">
            <span className="material-symbols-outlined nt-state-icon">
              notifications_off
            </span>
            <p>
              {filter === "unread"
                ? "Bạn đã đọc hết thông báo."
                : "Chưa có thông báo nào."}
            </p>
          </div>
        ) : (
          <ul className="nt-list">
            {visible.map((n) => {
              const groupLink = groupLinkOf(n);
              return (
                <li
                  key={n.id}
                  className={`nt-item${n.isRead ? "" : " nt-item--unread"}`}
                >
                  <span className="nt-item-icon" aria-hidden="true">
                    <span className="material-symbols-outlined">
                      {iconFor(n)}
                    </span>
                  </span>
                  <div className="nt-item-body">
                    <span className="nt-item-title">{n.title ?? "Thông báo"}</span>
                    {n.message && (
                      <span className="nt-item-msg">{n.message}</span>
                    )}
                    <span className="nt-item-meta">
                      {formatRelative(n.sentAt)}
                      {n.type ? ` · ${n.type}` : ""}
                      {n.scheduleSlotId ? " · có gắn slot" : ""}
                    </span>
                  </div>

                  {/* Thông báo nhóm → mở thẳng nhóm / việc của nhóm. */}
                  {groupLink && (
                    <button
                      type="button"
                      className="nt-item-open"
                      onClick={() => handleOpen(n)}
                      title="Mở trong nhóm"
                      aria-label="Mở trong nhóm"
                    >
                      <span className="material-symbols-outlined">
                        open_in_new
                      </span>
                    </button>
                  )}

                  {!n.isRead && (
                    <button
                      type="button"
                      className="nt-item-mark"
                      onClick={() => handleMarkRead(n.id)}
                      aria-label="Đánh dấu đã đọc"
                      title="Đánh dấu đã đọc"
                    >
                      <span className="material-symbols-outlined">done</span>
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
