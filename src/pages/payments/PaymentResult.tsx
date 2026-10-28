import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import {
  cancelPayment,
  getMe,
  listInvoices,
  listPaymentTransactions,
  listUserSubscriptions,
  syncPayment,
  type InvoiceDto,
  type MeResponse,
  type PaymentTransactionDto,
} from "../../lib/api-client";
import {
  clearPendingPayment,
  readPendingPaymentForOrder,
} from "../payments/payment-storage";
import "./payment-result.css";

/* ============================================================
 * Trang kết quả thanh toán — /payment/success và /payment/cancel
 * ----------------------------------------------------------
 * BE quy định rõ:
 *   "FE không được tự kết luận 'đã trả tiền' dựa vào URL PayOS chuyển
 *    về. Backend mới là nơi xác nhận. FE chỉ gọi sync rồi đọc status."
 *
 * Luồng xử lý:
 *   1. Đọc `paymentId` từ localStorage (lưu lúc bấm "Mua").
 *      Nếu mất (đóng tab) → dùng `orderCode` từ URL rồi gọi
 *      GET /api/payment-transactions để tìm đúng giao dịch.
 *   2. Gọi POST /api/payments/{id}/sync.
 *   3. Đọc `status`:
 *        Succeeded → "Thanh toán thành công" → refetch /api/me + /api/invoices
 *        Pending   → "Đang xử lý" → gọi lại sync sau 3s, tối đa ~10 lần
 *        Cancelled → "Bạn đã hủy thanh toán"
 *        Expired   → "Link đã hết hạn" → cho tạo lại
 *        Failed    → "Thanh toán thất bại" → cho thử lại
 *   4. 503 = PayOS tạm lỗi → giữ màn hình "Đang xử lý" và thử lại,
 *      KHÔNG báo thất bại.
 * ============================================================ */

type Outcome = "pending" | "success" | "cancelled" | "expired" | "failed";

/** Số lần sync tối đa khi status vẫn Pending. */
const MAX_SYNC_ATTEMPTS = 10;
/** Khoảng cách giữa 2 lần sync (ms). */
const SYNC_INTERVAL_MS = 3000;
/**
 * Sau khi hết lượt poll, chuyển sang nhắc user đợi thay vì báo thất bại.
 * BE xác nhận `sync` hỏi thẳng PayOS (không phụ thuộc webhook) và worker
 * đối soát quét mỗi 60s → tối đa khoảng 3 phút là có gói.
 */
const ADVICE_AFTER_ATTEMPTS = 10;

export interface PaymentResultPageProps {
  /** "success" = PayOS trả về, "cancel" = user hủy. */
  variant: "success" | "cancel";
}

/** Trang thành công — PayOS ReturnUrl trỏ tới. */
export function PaymentSuccessPage() {
  return <PaymentResultPage variant="success" />;
}

/** Trang hủy — PayOS CancelUrl trỏ tới. */
export function PaymentCancelPage() {
  return <PaymentResultPage variant="cancel" />;
}

export function PaymentResultPage({ variant }: PaymentResultPageProps) {
  const [params] = useSearchParams();
  const navigate = useNavigate();

  const [status, setStatus] = useState<Outcome>("pending");
  const [tx, setTx] = useState<PaymentTransactionDto | null>(null);
  const [me, setMe] = useState<MeResponse | null>(null);
  const [invoice, setInvoice] = useState<InvoiceDto | null>(null);
  const [hasScheduled, setHasScheduled] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  /** paymentId đang xử lý (ref để timer đọc được giá trị mới nhất). */
  const paymentIdRef = useRef<string | null>(null);
  /** Đã dừng polling (khi đã có kết quả cuối). */
  const settledRef = useRef(false);

  const orderCodeParam = params.get("orderCode");
  const cancelFlag = params.get("cancel");

  /* ---------- Tìm paymentId: localStorage → orderCode ---------- */
  const resolvePaymentId = useCallback(async (): Promise<string | null> => {
    // 1. localStorage (đường happy path) — chỉ dùng khi orderCode khớp.
    const code = Number(orderCodeParam);
    const hasCode = Number.isFinite(code) && code > 0;
    const pending = readPendingPaymentForOrder(hasCode ? code : null);
    if (pending?.paymentId) {
      paymentIdRef.current = pending.paymentId;
      return pending.paymentId;
    }

    // 2. Tìm theo orderCode trong lịch sử giao dịch (fallback khi mất local).
    if (!hasCode) return null;

    const res = await listPaymentTransactions();
    if (!res.ok) return null;
    const found = res.data.find((t) => t.orderCode === code);
    if (found) {
      paymentIdRef.current = found.id;
      return found.id;
    }
    return null;
  }, [orderCodeParam]);

  /* ---------- Sync 1 lần ---------- */
  const runSync = useCallback(async () => {
    const pid = paymentIdRef.current;
    if (!pid) {
      setStatus(variant === "cancel" ? "cancelled" : "failed");
      setError(
        variant === "cancel"
          ? "Bạn đã hủy thanh toán."
          : "Không tìm thấy giao dịch để xác nhận. Vui lòng thử lại.",
      );
      return;
    }

    /* Mỗi lần sync là một lần thử mới → cho phép polling chạy lại. */
    settledRef.current = false;

    const res = await syncPayment(pid);

    if (!res.ok) {
      // 503 = PayOS tạm lỗi → giữ "Đang xử lý" và thử lại, KHÔNG báo lỗi.
      if (res.status === 503) {
        setStatus("pending");
        setError(null);
        return;
      }
      setError(res.error ?? "Không xác nhận được trạng thái thanh toán.");
      setStatus("failed");
      return;
    }

    setTx(res.data);
    const s = (res.data.status ?? "").toLowerCase();

    if (s === "succeeded" || s === "paid") {
      settledRef.current = true;
      setStatus("success");
      setError(null);
      clearPendingPayment();
      return;
    }
    if (s === "cancelled" || s === "canceled") {
      settledRef.current = true;
      setStatus("cancelled");
      clearPendingPayment();
      return;
    }
    if (s === "expired") {
      settledRef.current = true;
      setStatus("expired");
      clearPendingPayment();
      return;
    }
    if (s === "failed") {
      settledRef.current = true;
      setStatus("failed");
      clearPendingPayment();
      return;
    }
    // Pending → giữ màn hình "Đang xử lý".
    setStatus("pending");
  }, [variant]);

  /* ---------- Bootstrap: tìm paymentId rồi sync ---------- */
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const pid = await resolvePaymentId();
      if (cancelled) return;
      if (!pid) {
        // Không tìm thấy giao dịch. Nếu PayOS báo cancel → coi như đã hủy.
        setStatus(variant === "cancel" ? "cancelled" : "failed");
        setError(
          variant === "cancel"
            ? "Bạn đã hủy thanh toán."
            : "Không tìm thấy giao dịch. Nếu bạn đã thanh toán, hãy kiểm tra lịch sử giao dịch.",
        );
        return;
      }
      await runSync();
    })();
    return () => {
      cancelled = true;
    };
  }, [resolvePaymentId, runSync, variant]);

  /* ---------- Polling khi còn Pending ---------- */
  useEffect(() => {
    if (status !== "pending" || settledRef.current) return;
    if (attempt >= MAX_SYNC_ATTEMPTS) return;

    const t = window.setTimeout(() => {
      setAttempt((a) => a + 1);
      void runSync();
    }, SYNC_INTERVAL_MS);
    return () => window.clearTimeout(t);
  }, [status, attempt, runSync]);

  /* ---------- Thành công: refetch /api/me + /api/invoices + gói đang chờ ---------- */
  useEffect(() => {
    if (status !== "success") return;
    let cancelled = false;
    void (async () => {
      /* ---- 1. /api/me — có thể cần retry nhẹ ----
       * BE cấp gói trong lúc xử lý `sync`, nhưng `/api/me` đọc từ bản ghi
       * subscription nên đôi khi chưa kịp phản ánh. Thử lại vài lần trước
       * khi chấp nhận kết quả để tránh hiện "gói cũ" một cách nhầm lẫn. */
      let meData: MeResponse | null = null;
      for (let i = 0; i < 3; i++) {
        const meRes = await getMe();
        if (meRes.ok) {
          meData = meRes.data;
          // Đã thấy gói khác gói trước → dừng, đã đúng.
          if (meData.currentSubscription) break;
        }
        if (i < 2) await new Promise((r) => setTimeout(r, 1200));
      }
      if (!cancelled && meData) setMe(meData);

      /* ---- 2. Hoá đơn ---- */
      const invRes = await listInvoices();
      if (!cancelled && invRes.ok && invRes.data.length > 0) {
        // Hoá đơn mới nhất.
        const sorted = [...invRes.data].sort(
          (a, b) =>
            new Date(b.issuedAt).getTime() - new Date(a.issuedAt).getTime(),
        );
        setInvoice(sorted[0]);
      }

      /* ---- 3. Gói đang chờ (Scheduled) ----
       * Khi user mua gói mới trong khi gói cũ còn hạn, gói mới được xếp hàng. */
      const subRes = await listUserSubscriptions();
      if (!cancelled && subRes.ok) {
        setHasScheduled(
          subRes.data.some(
            (s) => (s.status ?? "").toLowerCase() === "scheduled",
          ),
        );
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [status]);

  /* ---------- Hủy đơn đang chờ (nút phụ) ---------- */
  async function handleCancelTx() {
    const pid = paymentIdRef.current;
    if (!pid) return;
    const res = await cancelPayment(pid);
    if (res.ok) {
      setTx(res.data);
      settledRef.current = true;
      setStatus("cancelled");
      setError(null);
      clearPendingPayment();
      return;
    }
    /* Đơn đã kết thúc (Succeeded/Cancelled) hoặc lỗi tạm thời → báo, không crash. */
    setError(res.error ?? "Không hủy được đơn thanh toán này.");
  }

  /* ---------- View model ---------- */
  const view = (() => {
    switch (status) {
      case "success":
        return {
          tone: "ok" as const,
          icon: "check_circle",
          title: "Thanh toán thành công",
          detail:
            "Gói của bạn đã được kích hoạt. Cảm ơn bạn đã đồng hành cùng METANOIA.",
        };
      case "cancelled":
        return {
          tone: "warn" as const,
          icon: "block",
          title: "Bạn đã hủy thanh toán",
          detail:
            "Không có khoản tiền nào bị trừ. Bạn có thể chọn gói và thanh toán lại bất cứ lúc nào.",
        };
      case "expired":
        return {
          tone: "warn" as const,
          icon: "timer_off",
          title: "Link thanh toán đã hết hạn",
          detail:
            "Link PayOS chỉ sống trong 15 phút. Hãy tạo một link mới để tiếp tục.",
        };
      case "failed":
        return {
          tone: "err" as const,
          icon: "error",
          title: "Thanh toán thất bại",
          detail: error ?? "Có lỗi xảy ra khi xác nhận thanh toán.",
        };
      default: {
        /* Hết lượt poll → nhắc user đợi thêm (không báo thất bại). */
        const exhausted = attempt >= ADVICE_AFTER_ATTEMPTS;
        return {
          tone: "pending" as const,
          icon: "progress_activity",
          title: exhausted
            ? "Thanh toán đang được xác nhận"
            : "Đang xử lý thanh toán",
          detail: exhausted
            ? "Hệ thống thanh toán đang xác nhận giao dịch của bạn. Gói sẽ được cấp tự động trong khoảng 1–3 phút nữa — bạn có thể để nguyên trang này mở, hoặc kiểm tra lại sau."
            : "Chúng tôi đang xác nhận với hệ thống thanh toán. Vui lòng không đóng trang này.",
        };
      }
    }
  })();

  const planName = me?.currentSubscription?.planName ?? null;
  const endAt = me?.currentSubscription?.endAt ?? null;

  return (
    <section className="prs">
      <div className="prs-container">
        <div className={`prs-card prs-card--${view.tone}`}>
          <div className="prs-grid" aria-hidden="true" />

          <div className="prs-icon" aria-hidden="true">
            <span
              className={
                "material-symbols-outlined" +
                (view.tone === "pending" ? " prs-icon--spin" : "")
              }
            >
              {view.icon}
            </span>
          </div>

          <span className="prs-eyebrow">Thanh toán</span>
          <h1 className="prs-title">{view.title}</h1>
          <p className="prs-detail">{view.detail}</p>

          {/* Thông tin giao dịch */}
          {tx && (
            <dl className="prs-meta">
              {tx.orderCode ? (
                <div className="prs-meta-row">
                  <dt>Mã đơn</dt>
                  <dd className="prs-mono">{tx.orderCode}</dd>
                </div>
              ) : null}
              {tx.amount ? (
                <div className="prs-meta-row">
                  <dt>Số tiền</dt>
                  <dd className="prs-mono">
                    {tx.amount.toLocaleString("vi-VN")}đ
                  </dd>
                </div>
              ) : null}
              {tx.status ? (
                <div className="prs-meta-row">
                  <dt>Trạng thái</dt>
                  <dd className="prs-mono">{tx.status}</dd>
                </div>
              ) : null}
              {planName && status === "success" ? (
                <div className="prs-meta-row">
                  <dt>Gói</dt>
                  <dd className="prs-mono">{planName}</dd>
                </div>
              ) : null}
              {endAt && status === "success" ? (
                <div className="prs-meta-row">
                  <dt>Hết hạn</dt>
                  <dd className="prs-mono">
                    {new Date(endAt).toLocaleDateString("vi-VN")}
                  </dd>
                </div>
              ) : null}
            </dl>
          )}

          {/* Gói đang chờ (Scheduled) */}
          {status === "success" && hasScheduled && (
            <div className="prs-note">
              <span className="material-symbols-outlined">event_repeat</span>
              <span>
                Gói mới của bạn đã được xếp hàng và sẽ tự kích hoạt sau khi
                gói hiện tại hết hạn — không mất ngày đã trả.
              </span>
            </div>
          )}

          {/* Hoá đơn */}
          {status === "success" && invoice && (
            <div className="prs-invoice">
              <div className="prs-invoice-head">
                <span className="material-symbols-outlined">receipt_long</span>
                <span>Hoá đơn {invoice.invoiceNumber ?? ""}</span>
              </div>
              <div className="prs-invoice-body">
                <span>
                  {invoice.planName ?? "—"} ·{" "}
                  {invoice.amount.toLocaleString("vi-VN")}đ
                </span>
                <span className="prs-mono">
                  {invoice.periodStart} → {invoice.periodEnd}
                </span>
              </div>
            </div>
          )}

          {/* Đếm số lần đang chờ */}
          {status === "pending" && (
            <div className="prs-progress" aria-hidden="true">
              <span
                className="prs-progress-bar"
                style={{
                  width: `${Math.min(100, (attempt / MAX_SYNC_ATTEMPTS) * 100)}%`,
                }}
              />
            </div>
          )}

          {/* Hết lượt poll — nhắc user có thể kiểm tra lại sau */}
          {status === "pending" && attempt >= ADVICE_AFTER_ATTEMPTS && (
            <div className="prs-note">
              <span className="material-symbols-outlined">schedule</span>
              <span>
                Đã kiểm tra {attempt} lần. Hệ thống đối soát của chúng tôi quét
                mỗi 60 giây — gói sẽ tự được cấp, kể cả khi bạn đã đóng trang
                này.
              </span>
            </div>
          )}

          {/* Hành động */}
          <div className="prs-actions">
            {status === "success" ? (
              <>
                <button
                  type="button"
                  className="prs-btn prs-btn--primary"
                  onClick={() => navigate("/dashboard", { replace: true })}
                >
                  <span className="material-symbols-outlined">today</span>
                  Về trang hôm nay
                </button>
                <Link to="/profile" className="prs-btn prs-btn--ghost">
                  <span className="material-symbols-outlined">badge</span>
                  Xem gói của tôi
                </Link>
              </>
            ) : status === "pending" ? (
              <>
                <button
                  type="button"
                  className="prs-btn prs-btn--primary"
                  onClick={() => {
                    setAttempt(0);
                    void runSync();
                  }}
                >
                  <span className="material-symbols-outlined">refresh</span>
                  Kiểm tra lại
                </button>
                {/* Hủy đơn đang chờ (chỉ Pending mới hủy được). */}
                <button
                  type="button"
                  className="prs-btn prs-btn--ghost"
                  onClick={() => void handleCancelTx()}
                >
                  <span className="material-symbols-outlined">close</span>
                  Hủy thanh toán
                </button>
                <Link to="/pricing" className="prs-btn prs-btn--ghost">
                  <span className="material-symbols-outlined">arrow_back</span>
                  Về bảng giá
                </Link>
              </>
            ) : (
              <>
                <Link to="/pricing" className="prs-btn prs-btn--primary">
                  <span className="material-symbols-outlined">shopping_bag</span>
                  Tạo link thanh toán mới
                </Link>
                {(status === "failed" || status === "expired") && (
                  <button
                    type="button"
                    className="prs-btn prs-btn--ghost"
                    onClick={() => {
                      setAttempt(0);
                      void runSync();
                    }}
                  >
                    <span className="material-symbols-outlined">refresh</span>
                    Thử lại
                  </button>
                )}
              </>
            )}
          </div>

          {/* Gợi ý khi hết hạn / thất bại */}
          {(status === "expired" || status === "failed") && (
            <p className="prs-hint">
              Nếu bạn đã thanh toán nhưng vẫn thấy thông báo này, hãy kiểm tra
              lịch sử giao dịch trong hồ sơ. Hệ thống đối soát tự động mỗi 60
              giây nên gói sẽ được cấp ngay khi PayOS ghi nhận.
            </p>
          )}
        </div>

        {/* Thông báo cancel từ query (PayOS trả về cancel=true) */}
        {cancelFlag === "true" && status === "pending" && (
          <p className="prs-note prs-note--standalone">
            <span className="material-symbols-outlined">info</span>
            <span>Bạn đã chọn huỷ trên trang PayOS.</span>
          </p>
        )}
      </div>
    </section>
  );
}
