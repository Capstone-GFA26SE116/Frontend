/**
 * Các kiểu dữ liệu dùng chung cho Auth.
 *
 * Lưu ý cho đồ án: đây là phiên bản mock lưu trong localStorage.
 * Khi nối backend thật, các field này sẽ map sang response từ API
 * (email, displayName, token, refreshToken...).
 */
export interface User {
  id: string;
  email: string;
  name: string;
  /** Thời điểm tạo tài khoản (ISO string). */
  createdAt: string;
  /** URL ảnh đại diện (từ Google cho OAuth user). */
  avatarUrl?: string;
}

export interface StoredCredentials {
  /** id trỏng ẩn danh hoá sang bản gác user tương ứng. */
  userId: string;
  /**
   * Mật khẩu hash giả lập bằng base64 (KHÔNG dùng cho production).
   * Chỉ phục vụ demo đồ án; backend thật phải dùng bcrypt/argon2.
   */
  passwordHash: string;
}

/**
 * Payload trả về cho useAuth().login / register.
 * Trong bản mock, token là chuỗi UUID giả lập.
 */
export interface AuthSession {
  user: User;
  token: string;
}

export type AuthError =
  | "email_exists"
  | "user_not_found"
  | "wrong_password"
  | "invalid_email"
  | "weak_password"
  | "google_auth_failed"
  | "session_expired"
  | "unknown";