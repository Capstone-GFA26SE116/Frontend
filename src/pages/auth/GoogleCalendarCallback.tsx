import { useCallback, useEffect, useMemo } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useGoogleCalendar } from "../../hooks/useGoogleCalendar";
import "./google-calendar-callback.css";

/**
 * Kết quả một lần OAuth Google Calendar — BE redirect về FE kèm query:
 *   ?calendar=connected        → thành công
 *   ?calendar=denied           → user từ chối cấp quyền
 *   ?calendar=error&message=…  → lỗi phía BE/Google
 *
 * Trang này xác nhận lại bằng `GET /api/google-calendar/status` (nguồn sự thật
 * duy nhất — query chỉ là tín hiệu), rồi chuyển user về `/schedule`.
 */
type Outcome = "connected" | "denied" | "error";

export function GoogleCalendarCallbackPage() {
  const [params] = useSearchParams();
  const navigate = useNavigate();

  const raw = (params.get("calendar") ?? "").toLowerCase();
  const message = params.get("message") ?? undefined;

  const outcome: Outcome =
    raw === "connected" ? "connected" : raw === "denied" ? "denied" : "error";

  /** Chỉ gọi status khi BE báo thành công (để xác nhận Status = Active). */
  const gcal = useGoogleCalendar(outcome === "connected");

  /** Chỉ "connected" mới cần chờ status trả về; các nhánh khác hiện ngay. */
  const pending = outcome === "connected" && gcal.loading;
  const reallyConnected = gcal.isConnected;

  const view = useMemo(() => {
    if (pending) {
      return {
        tone: "pending" as const,
        icon: "progress_activity",
        title: "Đang hoàn tất kết nối",
        detail: "Đang xác minh quyền truy cập Google Calendar của bạn…",
      };
    }
    if (outcome === "connected" && reallyConnected) {
      return {
        tone: "ok" as const,
        icon: "check_circle",
        title: "Đã kết nối Google Calendar",
        detail:
          "Sự kiện sẽ được đồng bộ hai chiều với lịch METANOIA của bạn.",
      };
    }
    if (outcome === "connected" && !reallyConnected) {
      return {
        tone: "warn" as const,
        icon: "sync_problem",
        title: "Chưa xác nhận được kết nối",
        detail:
          "Google đã trả về thành công nhưng máy chủ chưa báo Active. Hãy thử đồng bộ lại trong trang lịch.",
      };
    }
    if (outcome === "denied") {
      return {
        tone: "warn" as const,
        icon: "block",
        title: "Bạn đã từ chối cấp quyền",
        detail:
          "METANOIA cần quyền calendar.events để đồng bộ lịch. Bạn có thể thử lại bất cứ lúc nào.",
      };
    }
    return {
      tone: "err" as const,
      icon: "error",
      title: "Kết nối thất bại",
      detail:
        message ?? "Đã có lỗi khi liên kết Google Calendar. Vui lòng thử lại.",
    };
  }, [pending, outcome, reallyConnected, message]);

  const goToSchedule = useCallback(() => {
    navigate("/schedule", {
      replace: true,
      state: {
        calendarResult: { outcome, connected: reallyConnected, message },
      },
    });
  }, [navigate, outcome, reallyConnected, message]);

  /** Tự chuyển về /schedule kèm kết quả để trang lịch hiện toast tương ứng. */
  useEffect(() => {
    if (pending) return;
    const t = window.setTimeout(goToSchedule, 1800);
    return () => window.clearTimeout(t);
  }, [pending, goToSchedule]);

  return (
    <div className="gcb">
      <div className={`gcb-card gcb-card--${view.tone}`}>
        <div className="gcb-grid" aria-hidden="true" />
        <div className="gcb-icon" aria-hidden="true">
          <span className="material-symbols-outlined">{view.icon}</span>
        </div>
        <span className="gcb-eyebrow">Google Calendar</span>
        <h1 className="gcb-title">{view.title}</h1>
        <p className="gcb-detail">{view.detail}</p>

        <div className="gcb-actions">
          <button
            type="button"
            className="gcb-btn gcb-btn--primary"
            onClick={goToSchedule}
          >
            <span className="material-symbols-outlined">arrow_forward</span>
            Đi tới lịch
          </button>
          <button
            type="button"
            className="gcb-btn gcb-btn--ghost"
            onClick={() => navigate("/dashboard", { replace: true })}
          >
            Về Today
          </button>
        </div>

        <span className="gcb-hint">Tự động chuyển trang sau vài giây…</span>
      </div>
    </div>
  );
}
