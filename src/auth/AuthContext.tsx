import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import type { AuthError, AuthSession, User } from "./types";
import {
  clearSession,
  createUser,
  findUserByEmail,
  normalizeEmail,
  readSession,
  saveSession,
  verifyCredentials,
} from "./storage";
import {
  loginWithGoogle as loginWithGoogleApi,
  logoutApi,
  getMe,
  clearTokens,
  getAccessToken,
  type AuthResponseDto,
} from "../lib/api-client";

interface AuthContextValue {
  user: User | null;
  token: string | null;
  isAuthenticated: boolean;
  isReady: boolean;
  login: (
    email: string,
    password: string,
  ) => Promise<{ ok: true; session: AuthSession } | { ok: false; error: AuthError }>;
  register: (
    name: string,
    email: string,
    password: string,
  ) => Promise<{ ok: true; session: AuthSession } | { ok: false; error: AuthError }>;
  /**
   * Tạo tài khoản mới KHÔNG auto-login.
   * Dùng cho flow "đăng ký xong phải đăng nhập lại" — tránh bị ProtectedRoute
   * đẩy sang /onboarding giữa chừng vì user vừa tạo lại authenticated.
   * Trả về user (đã normalize email) để Register có thể prefill vào form Login.
   */
  createAccount: (
    name: string,
    email: string,
    password: string,
  ) => Promise<{ ok: true; user: User } | { ok: false; error: AuthError }>;
  loginWithGoogle: (idToken: string) => Promise<
    { ok: true; session: AuthSession } | { ok: false; error: AuthError }
  >;
  logout: () => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function validateEmail(email: string): boolean {
  return EMAIL_RE.test(email.trim());
}

function validatePassword(password: string): boolean {
  // Demo: tối thiểu 8 ký tự. Backend thật sẽ có rule mạnh hơn.
  return password.length >= 8;
}

function generateToken(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return `demo_${crypto.randomUUID()}`;
  }
  return `demo_${Math.random().toString(36).slice(2)}_${Date.now()}`;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [token, setToken] = useState<string | null>(null);
  // isReady = true sau khi đã đọc xong localStorage (tránh flash redirect).
  const [isReady, setIsReady] = useState(false);

  // Khôi phục session khi mount.
  // Với backend thật: đọc access token từ localStorage → gọi /api/me để lấy profile.
  // Với mock (chưa có token): fallback về logic localStorage cũ.
  useEffect(() => {
    const session = readSession();
    const token = getAccessToken();
    if (token) {
      // Có token → fetch user từ BE
      getMe().then((res) => {
        if (res.ok) {
          const u: User = {
            id: res.data.id,
            email: res.data.email ?? "",
            name: res.data.fullName ?? "Người dùng",
            createdAt: new Date().toISOString(),
            avatarUrl: res.data.avatarUrl ?? undefined,
          };
          setUser(u);
          setToken(token);
        } else {
          // Token hết hạn hoặc invalid → xoá
          clearTokens();
          clearSession();
        }
        setIsReady(true);
      });
    } else if (session) {
      // Mock fallback
      const u = findUserByEmail(session.email);
      if (u) {
        setUser(u);
        setToken(session.token);
      } else {
        clearSession();
      }
      setIsReady(true);
    } else {
      setIsReady(true);
    }
  }, []);

  const loginWithGoogle = useCallback(async (idToken: string) => {
    const res = await loginWithGoogleApi(idToken);
    if (!res.ok) {
      return { ok: false as const, error: "google_auth_failed" as AuthError };
    }
    const dto: AuthResponseDto = res.data;
    const u: User = {
      id: dto.userId,
      email: dto.email ?? "",
      name: dto.fullName ?? "Người dùng",
      createdAt: new Date().toISOString(),
      avatarUrl: dto.avatarUrl ?? undefined,
    };
    // Lưu vào localStorage để mock code vẫn hoạt động nếu cần
    saveSession({ token: dto.accessToken, email: u.email });
    setUser(u);
    setToken(dto.accessToken);
    return { ok: true as const, session: { user: u, token: dto.accessToken } };
  }, []);

  const login = useCallback<AuthContextValue["login"]>(async (email, password) => {
    if (!validateEmail(email)) return { ok: false, error: "invalid_email" };
    if (!validatePassword(password)) return { ok: false, error: "weak_password" };
    const result = verifyCredentials(email, password);
    if (!result.ok || !result.user) {
      return { ok: false, error: result.reason ?? "unknown" };
    }
    const t = generateToken();
    saveSession({ token: t, email: result.user.email });
    setUser(result.user);
    setToken(t);
    return { ok: true as const, session: { user: result.user, token: t } };
  }, []);

  const register = useCallback<AuthContextValue["register"]>(
    async (name, email, password) => {
      if (!name.trim()) return { ok: false, error: "unknown" };
      if (!validateEmail(email)) return { ok: false, error: "invalid_email" };
      if (!validatePassword(password)) return { ok: false, error: "weak_password" };
      const normalized = normalizeEmail(email);
      if (findUserByEmail(normalized)) {
        return { ok: false, error: "email_exists" };
      }
      try {
        const u = createUser({ name, email, password });
        const t = generateToken();
        saveSession({ token: t, email: u.email });
        setUser(u);
        setToken(t);
        return { ok: true as const, session: { user: u, token: t } };
      } catch (err) {
        const msg = err instanceof Error ? err.message : "unknown";
        return { ok: false, error: msg as AuthError };
      }
    },
    [],
  );

  const logout = useCallback(() => {
    // Gọi BE logout (fire-and-forget), rồi xoá local state
    logoutApi().catch(() => {
      // ignore
    });
    clearSession();
    clearTokens();
    setUser(null);
    setToken(null);
  }, []);

  /**
   * Tạo tài khoản mới nhưng KHÔNG set user/token/session.
   * Vì vậy ProtectedRoute sẽ thấy user vẫn null => không redirect đi đâu.
   * Hữu ích cho flow: tạo xong -> navigate /login để user đăng nhập thủ công.
   */
  const createAccount = useCallback<AuthContextValue["createAccount"]>(
    async (name, email, password) => {
      if (!name.trim()) return { ok: false, error: "unknown" };
      if (!validateEmail(email)) return { ok: false, error: "invalid_email" };
      if (!validatePassword(password)) {
        return { ok: false, error: "weak_password" };
      }
      const normalized = normalizeEmail(email);
      if (findUserByEmail(normalized)) {
        return { ok: false, error: "email_exists" };
      }
      try {
        const u = createUser({ name, email, password });
        return { ok: true as const, user: u };
      } catch (err) {
        const msg = err instanceof Error ? err.message : "unknown";
        return { ok: false, error: msg as AuthError };
      }
    },
    [],
  );

  const value = useMemo<AuthContextValue>(
    () => ({
      user,
      token,
      isAuthenticated: user !== null,
      isReady,
      login,
      register,
      createAccount,
      loginWithGoogle,
      logout,
    }),
    [user, token, isReady, login, register, createAccount, loginWithGoogle, logout],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error("useAuth must be used within an <AuthProvider>");
  }
  return ctx;
}