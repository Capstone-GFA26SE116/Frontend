import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { AuthProvider } from "./auth/AuthContext";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { installThirdPartyErrorFilter } from "./lib/third-party-error-filter";
import "./index.css";
import App from "./App.tsx";

/*
 * Lọc lỗi từ extension trình duyệt + Google GIS (không nuốt lỗi của app).
 * Phải cài TRƯỚC khi render React để bắt được lỗi phát sinh sớm.
 */
installThirdPartyErrorFilter();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    {/* Lớp ngoài: nếu chính Provider/Router hỏng thì vẫn còn nút tải lại trang. */}
    <ErrorBoundary label="Ứng dụng">
      <BrowserRouter>
        <AuthProvider>
          <App />
        </AuthProvider>
      </BrowserRouter>
    </ErrorBoundary>
  </StrictMode>,
);