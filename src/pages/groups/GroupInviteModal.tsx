import { useCallback, useEffect, useState } from "react";
import type { ApiErr } from "../../lib/api-client";
import {
  createGroupInvitation,
  listGroupInvitations,
  revokeGroupInvitation,
  type GroupInvitationCreatedDto,
  type GroupInvitationDto,
  type GroupRole,
} from "../../lib/group-api";
import { invitationStatusLabel, normalizeRole, roleLabel } from "./group-logic";
import "./groups.css";

/* ===========================================================
 * Modal mời thành viên vào nhóm — dùng chung
 * ===========================================================
 *
 * Tách riêng khỏi `/groups` để dùng được ở cả:
 *  - `/groups`            (danh sách nhóm → nút "Invite")
 *  - `/groups/:groupId`   (tab Members → nút "Invite")
 *
 * API (spec BE GROUP_FE.md):
 *  - POST   /api/groups/{id}/invitations
 *  - GET    /api/groups/{id}/invitations
 *  - DELETE /api/groups/{id}/invitations/{invId}
 * =========================================================== */

/** Tone hiển thị cho vai trò. */
function roleTone(role: string): "leader" | "member" | "viewer" {
  const r = normalizeRole(role);
  if (r === "Leader") return "leader";
  if (r === "Member") return "member";
  return "viewer";
}

export function GroupInviteModal({
  groupId,
  groupName,
  onClose,
  onInvited,
  onError,
}: {
  /** Id nhóm cần mời. */
  groupId: string;
  /** Tên nhóm — hiển thị trong tiêu đề modal. */
  groupName: string;
  /** Đóng modal. */
  onClose: () => void;
  /** Gửi lời mời thành công (VD: refresh danh sách thành viên). */
  onInvited?: (invite: GroupInvitationCreatedDto) => void;
  /**
   * Báo lỗi API ra ngoài (VD: mở `GroupErrorDialog`).
   *
   * Nhận nguyên `ApiErr` để bên ngoài tự ánh xạ sang thông điệp tiếng Anh
   * theo bảng lỗi chung (`group-errors.ts`).
   */
  onError?: (err: ApiErr) => void;
}) {
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<GroupRole>("Member");
  const [inviting, setInviting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Lời mời vừa tạo — hiện `acceptToken` (chỉ BE trả 1 lần). */
  const [createdInvite, setCreatedInvite] =
    useState<GroupInvitationCreatedDto | null>(null);
  /** Lời mời đang chờ của nhóm (Leader xem). */
  const [pendingInvites, setPendingInvites] = useState<GroupInvitationDto[]>([]);

  /* Nạp danh sách lời mời đang chờ khi mở modal. */
  const loadPending = useCallback(async () => {
    const res = await listGroupInvitations(groupId);
    if (res.ok) setPendingInvites(res.data ?? []);
  }, [groupId]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- data-fetch pattern
    void loadPending();
  }, [loadPending]);

  /* Đóng modal bằng phím Esc. */
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const trimmed = email.trim();
    if (!trimmed) {
      setError("Please enter an email to invite.");
      return;
    }
    setError(null);
    setInviting(true);
    const res = await createGroupInvitation(groupId, {
      email: trimmed,
      role,
    });
    setInviting(false);
    if (!res.ok) {
      setError(res.error ?? "Could not send this invitation.");
      onError?.(res as ApiErr);
      return;
    }
    setCreatedInvite(res.data);
    setEmail("");
    onInvited?.(res.data);
    await loadPending();
  }

  async function handleRevoke(invitationId: string) {
    const res = await revokeGroupInvitation(groupId, invitationId);
    if (!res.ok) {
      setError(res.error ?? "Could not revoke this invitation.");
      onError?.(res as ApiErr);
      return;
    }
    setPendingInvites((prev) => prev.filter((i) => i.id !== invitationId));
  }

  return (
    <div className="grp-modal-backdrop" onClick={onClose} role="presentation">
      <div
        className="grp-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="grp-invite-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="grp-modal-head">
          <h2 id="grp-invite-title" className="grp-modal-title">
            <span
              className="material-symbols-outlined grp-modal-title-icon"
              aria-hidden="true"
            >
              person_add
            </span>
            Invite to {groupName}
          </h2>
          <button
            type="button"
            className="grp-modal-close"
            onClick={onClose}
            aria-label="Close"
          >
            <span className="material-symbols-outlined">close</span>
          </button>
        </div>

        <form className="grp-form" onSubmit={handleSubmit}>
          <div className="grp-field">
            <label className="grp-label" htmlFor="grp-f-invite-email">
              Email *
            </label>
            <input
              id="grp-f-invite-email"
              type="email"
              className="grp-input"
              placeholder="teammate@company.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
            />
          </div>

          <div className="grp-field">
            <label className="grp-label" htmlFor="grp-f-invite-role">
              Role
            </label>
            <select
              id="grp-f-invite-role"
              className="grp-input"
              value={role}
              onChange={(e) => setRole(e.target.value as GroupRole)}
            >
              <option value="Member">Member — work on tasks, change status</option>
              <option value="Viewer">Viewer — read only</option>
              <option value="Leader">Leader — manage the group</option>
            </select>
          </div>

          {error && (
            <p className="grp-form-error">
              <span className="material-symbols-outlined" aria-hidden="true">
                error
              </span>
              {error}
            </p>
          )}

          {/* Token chỉ BE trả 1 lần — Leader dùng để gửi link thủ công. */}
          {createdInvite && (
            <div className="grp-token-box">
              <span className="grp-token-label">
                Accept token (shown only once)
              </span>
              <code className="grp-token-value">{createdInvite.acceptToken}</code>
              <span className="grp-token-hint">
                Share this link with the invitee:{" "}
                <code>/groups?token={createdInvite.acceptToken}</code>
              </span>
            </div>
          )}

          <div className="grp-form-actions">
            <button type="button" className="grp-btn grp-btn--ghost" onClick={onClose}>
              Close
            </button>
            <button
              type="submit"
              className="grp-btn grp-btn--primary"
              disabled={inviting}
            >
              <span className="material-symbols-outlined grp-btn-icon">
                send
              </span>
              Send invite
            </button>
          </div>
        </form>

        {/* Lời mời đang chờ của nhóm */}
        {pendingInvites.length > 0 && (
          <div className="grp-pending">
            <h3 className="grp-pending-title">Pending invitations</h3>
            <ul className="grp-pending-list">
              {pendingInvites.map((inv) => (
                <li key={inv.id} className="grp-pending-item">
                  <span className="grp-pending-email">{inv.email}</span>
                  <span className={`grp-role grp-role--${roleTone(inv.role)}`}>
                    {roleLabel(inv.role)}
                  </span>
                  <span className="grp-pending-status">
                    {invitationStatusLabel(inv.status)}
                  </span>
                  {inv.status === "Pending" && (
                    <button
                      type="button"
                      className="grp-btn grp-btn--ghost grp-btn--sm"
                      onClick={() => void handleRevoke(inv.id)}
                    >
                      Revoke
                    </button>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}
