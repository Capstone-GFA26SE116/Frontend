/**
 * Chặn lỗi render để 1 phần hỏng không kéo sập cả trang.
 *
 * Vì sao cần: React khi gặp lỗi trong render sẽ **unmount toàn bộ cây** nếu
 * không có boundary. Trước đây chỉ cần một response lỗi có body kiểu object
 * (vd: FastAPI trả `{ "detail": { "code": "..." } }`) là trang trắng xóa —
 * người dùng mất toàn bộ state, phải F5.
 *
 * Có boundary thì chỉ vùng bọc bị thay bằng thông báo, phần còn lại vẫn chạy.
 */
import { Component, type ErrorInfo, type ReactNode } from "react";
import "./error-boundary.css";

interface Props {
  children: ReactNode;
  /** Nhãn hiển thị trên thông báo lỗi, giúp biết vùng nào hỏng. */
  label?: string;
}

interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // Giữ lại log để debug; trong console của trình duyệt là đủ.
    // eslint-disable-next-line no-console
    console.error("[ErrorBoundary]", this.props.label ?? "app", error, info.componentStack);
  }

  private reset = () => {
    this.setState({ error: null });
  };

  render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <div className="meb" role="alert">
        <div className="meb-card">
          <span className="material-symbols-outlined meb-icon">error</span>
          <h2 className="meb-title">
            {this.props.label ? `${this.props.label} gặp lỗi` : "Đã xảy ra lỗi"}
          </h2>
          <p className="meb-msg">
            Ứng dụng gặp lỗi khi hiển thị dữ liệu. Bạn có thể thử lại hoặc tải lại trang —
            dữ liệu của bạn vẫn được giữ nguyên.
          </p>
          <pre className="meb-detail">{error.message}</pre>
          <div className="meb-actions">
            <button type="button" className="meb-btn meb-btn--primary" onClick={this.reset}>
              <span className="material-symbols-outlined">refresh</span>
              Thử lại
            </button>
            <button
              type="button"
              className="meb-btn"
              onClick={() => window.location.reload()}
            >
              <span className="material-symbols-outlined">restart_alt</span>
              Tải lại trang
            </button>
          </div>
        </div>
      </div>
    );
  }
}