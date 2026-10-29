import { createContext, useContext } from "react";
import type {
  FocusSelfReportRequest,
  FocusStartRequest,
  FocusStopReason,
} from "../../lib/api-client";

/**
 * ============================================================
 * Context cho Focus Session.
 * ============================================================
 *
 * Vì sao cần Context (không truyền props):
 *  - `FocusManager` sống ở SiteLayout (cấp cao nhất), còn nút Start/Stop
 *    nằm ở trang /schedule (cấp thấp hơn nhiều tầng) → prop-drilling qua
 *    mấy trung gian là rối.
 *  - Context cho phép bất kỳ trang nào cần thao tác focus đều dùng chung 1
 *    nguồn sự thật.
 */

/** Các hành động mà UI bên ngoài (trang lịch) cần gọi. */
export interface FocusActions {
  /**
   * Bắt đầu phiên làm việc.
   *
   * Tự xử lý 3 trường hợp đặc biệt theo spec:
   *  - 409 (đã có phiên chạy) → chuyển sang phiên đó, không báo lỗi đỏ.
   *  - warning STARTED_VERY_EARLY → mở hộp thoại hỏi user có giữ không.
   *  - startedEarlyMinutes > 0 → toast nhẹ "bắt đầu sớm X phút".
   */
  start: (req: FocusStartRequest) => Promise<void>;
  /** Mở hộp thoại chọn lý do dừng. */
  openStopDialog: () => void;
  /** Mở hộp thoại khai báo giờ đã làm việc. */
  openSelfReportDialog: (taskId?: string) => void;
  /** true khi đang gọi API — dùng để disable nút. */
  busy: boolean;
  /** Task đang chọn trong hộp thoại self-report. */
  selfReportTaskId: string;
  /** Đổi task đang chọn cho hộp thoại self-report. */
  setSelfReportTaskId: (taskId: string) => void;
  /** Danh sách task để chọn trong hộp thoại self-report. */
  selfReportTasks: Array<{ id: string; title: string }>;
  /**
   * `scheduleSlotId` của phiên đang chạy (null nếu không có phiên).
   *
   * Trang lịch dùng để biết slot nào đang chạy, và chặn nút Start của các
   * slot khác (BE sẽ trả 409 nếu đã có phiên).
   */
  currentSlotId: string | null;
  /** true khi đang có phiên làm việc chạy. */
  hasActiveSession: boolean;
  /**
   * Phút dự kiến của phiên đang chạy (0 = không xác định).
   *
   * `GET /api/focus/current` KHÔNG trả `plannedMinutes` — chỉ response của
   * `POST /api/focus/start` có. Sau khi reload trang, ta lấy lại từ
   * `proposedMinutes` của slot tương ứng qua `seedPlannedMinutes`.
   */
  plannedMinutes: number;
  /**
   * Cung cấp phút dự kiến cho phiên đang chạy khi ta chưa biết.
   *
   * Trang lịch gọi hàm này với `proposedMinutes` của slot đang chạy → đồng
   * hồ vẽ được thanh tiến trình và mốc "còn bao lâu".
   */
  seedPlannedMinutes: (minutes: number) => void;
  /**
   * Đăng ký callback được gọi khi trạng thái slot có thể đã đổi (sau
   * start/stop/confirm) — trang lịch dùng để refetch.
   *
   * Quan trọng: khi user bấm Stop ở thanh đồng hồ global (đang ở trang
   * khác), trang lịch cũng cần cập nhật → callback này giải quyết chuyện đó.
   */
  onSlotChanged: (fn: () => void) => () => void;
}

const FocusActionsContext = createContext<FocusActions | null>(null);

export const FocusActionsProvider = FocusActionsContext.Provider;

export function useFocusActions(): FocusActions {
  const ctx = useContext(FocusActionsContext);
  if (!ctx) {
    throw new Error(
      "useFocusActions must be used within a <FocusActionsProvider>",
    );
  }
  return ctx;
}

/** Re-export cho tiện khi import. */
export type { FocusSelfReportRequest, FocusStartRequest, FocusStopReason };
