/* ============================================================
 * Lưu trữ giao dịch thanh toán đang chờ (FE-only, localStorage).
 * ----------------------------------------------------------
 * BE quy định: sau khi bấm "Mua", FE lưu `paymentId` để dùng cho
 * bước sync/cancel. Nếu user đóng tab rồi quay lại từ PayOS,
 * FE đọc lại từ đây để biết đang confirm giao dịch nào.
 *
 * Key: "metanoia:pending-payment"
 * ============================================================ */

export interface PendingPayment {
  /** Id giao dịch trả về từ POST /api/payments/checkout. */
  paymentId: string;
  /** Id gói đã mua. */
  planId: string;
  /** Mã đơn PayOS (orderCode) — dùng để tìm lại giao dịch khi mất paymentId. */
  orderCode: number;
  /** Số tiền (VND). */
  amount: number;
  /** Trang thanh toán hosted của PayOS. */
  checkoutUrl: string;
  /** Chuỗi QR (URL, base64 hoặc data-URI) do PayOS trả về. */
  qrCode: string;
  /** Hạn dùng của link (ISO timestamp). */
  expiresAt: string;
  /** Thời điểm tạo link. */
  createdAt: string;
}

const PENDING_KEY = "metanoia:pending-payment";

export function savePendingPayment(payment: PendingPayment): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(PENDING_KEY, JSON.stringify(payment));
  } catch {
    // localStorage bị chặn (private mode) — FE vẫn chạy được, chỉ mất
    // khả năng khôi phục paymentId sau khi đóng tab.
  }
}

export function readPendingPayment(): PendingPayment | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(PENDING_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as PendingPayment;
    return parsed?.paymentId ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Đọc giao dịch pending, nhưng chỉ trả về nếu khớp `orderCode` mà PayOS
 * gửi kèm trong URL.
 *
 * ⚠️ Vì sao cần check này:
 * - localStorage chỉ giữ **một** giao dịch pending. Nếu user bấm "Mua" gói B
 *   khi gói A vẫn đang pending (hoặc gói A đã hết hạn nhưng chưa bị xoá),
 *   bản ghi sẽ bị ghi đè bằng gói B.
 * - PayOS luôn gửi `orderCode` trong query khi redirect về. Nếu ta dùng
 *   `paymentId` trong localStorage mà **không** đối chiếu `orderCode`, FE có
 *   thể sync nhầm giao dịch và báo "Thanh toán thành công" cho sai gói.
 *
 * @param orderCodeFromUrl `orderCode` lấy từ query URL (PayOS trả về).
 *                           Bỏ qua (null) nếu URL không có.
 */
export function readPendingPaymentForOrder(
  orderCodeFromUrl: number | null,
): PendingPayment | null {
  const pending = readPendingPayment();
  if (!pending) return null;

  // URL không có orderCode → không có cách nào đối chiếu → tin bản ghi local.
  if (orderCodeFromUrl == null || !Number.isFinite(orderCodeFromUrl)) {
    return pending;
  }

  // URL có orderCode → bắt buộc phải khớp, nếu lệch thì coi như mất.
  return pending.orderCode === orderCodeFromUrl ? pending : null;
}

export function clearPendingPayment(): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(PENDING_KEY);
  } catch {
    // ignore
  }
}

/**
 * Chuẩn hoá `qrCode` từ PayOS thành URL ảnh để render thẳng bằng <img>.
 *
 * PayOS có thể trả:
 *   - data-URI sẵn  : "data:image/png;base64,iVBOR..."
 *   - URL ảnh       : "https://cdn.payos.vn/....png"
 *   - base64 thô    : "iVBORw0KGgo..."
 */
export function resolveQrImageUrl(qrCode: string | null | undefined): string {
  if (!qrCode) return "";
  const raw = qrCode.trim();
  if (!raw) return "";
  if (raw.startsWith("data:")) return raw;
  if (raw.startsWith("http://") || raw.startsWith("https://")) return raw;
  // Base64 thô — bọc thành data-URI PNG.
  return `data:image/png;base64,${raw}`;
}
