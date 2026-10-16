/**
 * Kho lưu trữ localStorage cho METANOIA (bản mock auth).
 *
 * Cấu trúc key:
 * - metanoia:users         -> Record<emailLowercase, User>
 * - metanoia:credentials   -> Record<emailLowercase, StoredCredentials>
 * - metanoia:session       -> { token, email } | null
 *
 * Khi đổi sang backend thật, các hàm trong file này sẽ được thay bằng
 * các call tới API (fetch / axios) — phần UI không cần sửa.
 */

import type { StoredCredentials, User } from "./types";

const USERS_KEY = "metanoia:users";
const CREDS_KEY = "metanoia:credentials";
const SESSION_KEY = "metanoia:session";

/** Hash giả lập — chỉ để demo. KHÔNG dùng cho production. */
export function fakeHash(password: string): string {
  // base64 đủ để demo "đúng mật khẩu / sai mật khẩu".
  // Không có tính chất bảo mật; bài đồ án ghi rõ điểm này.
  if (typeof window === "undefined") return "";
  return window.btoa(unescape(encodeURIComponent(password)));
}

function safeParse<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function readUsers(): Record<string, User> {
  return safeParse<Record<string, User>>(
    window.localStorage.getItem(USERS_KEY),
    {},
  );
}

function writeUsers(users: Record<string, User>): void {
  window.localStorage.setItem(USERS_KEY, JSON.stringify(users));
}

function readCredentials(): Record<string, StoredCredentials> {
  return safeParse<Record<string, StoredCredentials>>(
    window.localStorage.getItem(CREDS_KEY),
    {},
  );
}

function writeCredentials(creds: Record<string, StoredCredentials>): void {
  window.localStorage.setItem(CREDS_KEY, JSON.stringify(creds));
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export interface CreateUserRecord {
  email: string;
  name: string;
  password: string;
}

export function createUser({ email, name, password }: CreateUserRecord): User {
  const normalized = normalizeEmail(email);
  const users = readUsers();
  if (users[normalized]) {
    throw new Error("email_exists");
  }
  const user: User = {
    id: crypto.randomUUID(),
    email: normalized,
    name: name.trim(),
    createdAt: new Date().toISOString(),
  };
  users[normalized] = user;
  writeUsers(users);

  const creds = readCredentials();
  creds[normalized] = {
    userId: user.id,
    passwordHash: fakeHash(password),
  };
  writeCredentials(creds);

  return user;
}

export interface VerifyResult {
  ok: boolean;
  reason?: "user_not_found" | "wrong_password";
  user?: User;
}

export function verifyCredentials(
  email: string,
  password: string,
): VerifyResult {
  const normalized = normalizeEmail(email);
  const creds = readCredentials();
  const record = creds[normalized];
  if (!record) return { ok: false, reason: "user_not_found" };
  if (record.passwordHash !== fakeHash(password)) {
    return { ok: false, reason: "wrong_password" };
  }
  const users = readUsers();
  const user = users[normalized];
  if (!user) return { ok: false, reason: "user_not_found" };
  return { ok: true, user };
}

export interface StoredSession {
  token: string;
  email: string;
}

export function saveSession(session: StoredSession): void {
  window.localStorage.setItem(SESSION_KEY, JSON.stringify(session));
}

export function readSession(): StoredSession | null {
  return safeParse<StoredSession | null>(
    window.localStorage.getItem(SESSION_KEY),
    null,
  );
}

export function clearSession(): void {
  window.localStorage.removeItem(SESSION_KEY);
}

export function findUserByEmail(email: string): User | null {
  return readUsers()[normalizeEmail(email)] ?? null;
}