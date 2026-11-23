import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { CenterToasts, useCenterToast } from "../../components/Toast";
import type { ApiErr } from "../../lib/api-client";
import {
  acceptGroupInvitation,
  createGroup,
  declineGroupInvitation,
  listGroups,
  listMyGroupInvitations,
  type GroupDto,
  type GroupInvitationDto,
} from "../../lib/group-api";
import {
  fmtGroupDate,
  fmtRelativeTime,
  normalizeRole,
  roleLabel,
} from "./group-logic";
import { GroupErrorDialog } from "./GroupErrorDialog";
import { GroupInviteModal } from "./GroupInviteModal";
import {
  type GroupErrorDetails,
  type GroupErrorView,
  rawServerMessage,
  toGroupErrorDetails,
  toGroupErrorView,
} from "./group-errors";
import "./groups.css";

/* ===========================================================
 * Trang /groups — Danh sách nhóm làm việc + lời mời
 * ===========================================================
 *
 * API (spec BE GROUP_FE.md):
 *  - GET  /api/groups?includeArchived=false
 *  - POST /api/groups
 *  - GET  /api/group-invitations          (lời mời gửi tới tôi)
 *  - POST /api/group-invitations/{id}/accept
 *  - POST /api/group-invitations/{id}/decline
 *  - POST /api/groups/{id}/invitations     (Leader)
 *  - GET  /api/groups/{id}/invitations     (Leader)
 *  - DELETE /api/groups/{id}/invitations/{invId}
 *
 * Class prefix `.grp-*`. Tuân thủ DESIGN.md.
 * =========================================================== */

/** Tone hiển thị cho vai trò. */
function roleTone(role: string): "leader" | "member" | "viewer" {
  const r = normalizeRole(role);
  if (r === "Leader") return "leader";
  if (r === "Member") return "member";
  return "viewer";
}

export function GroupsPage() {
  const [toasts, toast] = useCenterToast();

  /* ---------- Danh sách nhóm ---------- */
  const [groups, setGroups] = useState<GroupDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [includeArchived, setIncludeArchived] = useState(false);
  const [search, setSearch] = useState("");

  /* ---------- Lời mời gửi tới tôi ---------- */
  const [myInvitations, setMyInvitations] = useState<GroupInvitationDto[]>([]);
  const [invBusyId, setInvBusyId] = useState<string | null>(null);

  /* ---------- Modal tạo nhóm ---------- */
  const [createOpen, setCreateOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({
    name: "",
    description: "",
    startDate: "",
    deadline: "",
  });
  const [formError, setFormError] = useState<string | null>(null);

  /* ---------- Modal mời thành viên ---------- */
  const [inviteOpen, setInviteOpen] = useState(false);
  const [inviteGroup, setInviteGroup] = useState<GroupDto | null>(null);

  /* ---------- Hộp thoại báo lỗi (tiếng Anh) ---------- */
  const [errorDialog, setErrorDialog] = useState<{
    view: GroupErrorView;
    details: GroupErrorDetails;
    raw: string;
  } | null>(null);

  /**
   * Đổi lỗi API thành hộp thoại dễ hiểu (tiếng Anh).
   *
   * @param action Động từ ngắn mô tả thao tác, VD: "accept this invitation".
   */
  const showApiError = useCallback(
    (res: { ok: false } & Record<string, unknown>, action?: string) => {
      const err = res as ApiErr;
      setErrorDialog({
        view: toGroupErrorView(err, undefined, { action }),
        details: toGroupErrorDetails(err, undefined),
        raw: rawServerMessage(err, undefined),
      });
    },
    [],
  );

  useEffect(() => {
    document.title = "Nhóm · METANOIA";
  }, []);

  /* ---------- Nạp danh sách nhóm ---------- */
  const loadGroups = useCallback(async () => {
    setLoading(true);
    const res = await listGroups({ includeArchived });
    setLoading(false);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    setError(null);
    setGroups(res.data ?? []);
  }, [includeArchived]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- data-fetch pattern
    void loadGroups();
  }, [loadGroups]);

  /* ---------- Nạp lời mời gửi tới tôi ---------- */
  const loadMyInvitations = useCallback(async () => {
    const res = await listMyGroupInvitations();
    if (res.ok) setMyInvitations(res.data ?? []);
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- data-fetch pattern
    void loadMyInvitations();
  }, [loadMyInvitations]);

  /* ---------- Lọc + tìm kiếm ---------- */
  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    return groups.filter((g) => {
      if (!q) return true;
      return (
        g.name.toLowerCase().includes(q) ||
        (g.description ?? "").toLowerCase().includes(q)
      );
    });
  }, [groups, search]);

  /* ---------- Tạo nhóm ---------- */
  async function handleCreate(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const name = form.name.trim();
    if (!name) {
      setFormError("Vui lòng nhập tên nhóm.");
      return;
    }
    if (form.startDate && form.deadline) {
      if (new Date(form.deadline) < new Date(form.startDate)) {
        setFormError("Ngày hạn phải sau ngày bắt đầu.");
        return;
      }
    }
    setFormError(null);
    setCreating(true);
    const res = await createGroup({
      name,
      description: form.description.trim() || null,
      startDate: form.startDate || null,
      deadline: form.deadline || null,
    });
    setCreating(false);
    if (!res.ok) {
      setFormError(
        toGroupErrorView(res, undefined, { action: "create this group" }).message,
      );
      showApiError(res, "create this group");
      return;
    }
    setGroups((prev) => [res.data, ...prev]);
    setCreateOpen(false);
    setForm({ name: "", description: "", startDate: "", deadline: "" });
    toast.success("Đã tạo nhóm", `Bạn là Leader của "${res.data.name}".`);
  }

  /* ---------- Mời thành viên ---------- */
  function openInvite(group: GroupDto) {
    setInviteGroup(group);
    setInviteOpen(true);
  }

  /* ---------- Chấp nhận / từ chối lời mời ---------- */
  async function handleAccept(invitation: GroupInvitationDto) {
    setInvBusyId(invitation.id);
    const res = await acceptGroupInvitation(invitation.id);
    setInvBusyId(null);
    if (!res.ok) {
      showApiError(res, "accept this invitation");
      return;
    }
    setMyInvitations((prev) => prev.filter((i) => i.id !== invitation.id));
    setGroups((prev) => [res.data, ...prev]);
    toast.success("Đã tham gia nhóm", `Bạn là ${roleLabel(res.data.myRole)}.`);
  }

  async function handleDecline(invitation: GroupInvitationDto) {
    setInvBusyId(invitation.id);
    const res = await declineGroupInvitation(invitation.id);
    setInvBusyId(null);
    if (!res.ok) {
      showApiError(res, "decline this invitation");
      return;
    }
    setMyInvitations((prev) => prev.filter((i) => i.id !== invitation.id));
    toast.info("Đã từ chối lời mời");
  }

  const pendingMyInvites = myInvitations.filter(
    (i) => i.status === "Pending",
  );

  return (
    <div className="grp">
      <div className="grp-container">
        {/* ================= Header ================= */}
        <header className="grp-header">
          <div className="grp-header-text">
            <h1 className="grp-eyebrow">
              <span className="grp-eyebrow-dot" aria-hidden="true" />
              <span>Group Workspace</span>
            </h1>
            <p className="grp-sub">
              Làm việc cùng nhóm — chia việc, giao người phụ trách, theo dõi
              tiến độ và thời gian thực tế của từng thành viên.
            </p>
          </div>
          <div className="grp-header-actions">
            <button
              type="button"
              className="grp-btn grp-btn--primary"
              onClick={() => {
                setFormError(null);
                setCreateOpen(true);
              }}
            >
              <span className="material-symbols-outlined grp-btn-icon">
                group_add
              </span>
              <span>New group</span>
            </button>
          </div>
        </header>

        {/* ================= Lời mời gửi tới tôi ================= */}
        {pendingMyInvites.length > 0 && (
          <section className="grp-invites">
            <div className="grp-section-head">
              <h2 className="grp-section-title">
                <span className="material-symbols-outlined grp-section-icon">
                  mark_email_unread
                </span>
                Lời mời ({pendingMyInvites.length})
              </h2>
            </div>
            <ul className="grp-invite-list">
              {pendingMyInvites.map((inv) => (
                <li key={inv.id} className="grp-invite">
                  <span className="grp-invite-icon" aria-hidden="true">
                    <span className="material-symbols-outlined">group_add</span>
                  </span>
                  <div className="grp-invite-body">
                    <span className="grp-invite-title">{inv.groupName}</span>
                    <span className="grp-invite-meta">
                      {inv.invitedByName} mời bạn làm{" "}
                      <span
                        className={`grp-role grp-role--${roleTone(inv.role)}`}
                      >
                        {roleLabel(inv.role)}
                      </span>
                      {" · "}
                      {fmtRelativeTime(inv.createdAt)}
                    </span>
                  </div>
                  <div className="grp-invite-actions">
                    <button
                      type="button"
                      className="grp-btn grp-btn--primary grp-btn--sm"
                      onClick={() => void handleAccept(inv)}
                      disabled={invBusyId === inv.id}
                    >
                      Accept
                    </button>
                    <button
                      type="button"
                      className="grp-btn grp-btn--ghost grp-btn--sm"
                      onClick={() => void handleDecline(inv)}
                      disabled={invBusyId === inv.id}
                    >
                      Decline
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          </section>
        )}

        {/* ================= Bộ lọc ================= */}
        <div className="grp-toolbar">
          <div className="grp-search">
            <span
              className="material-symbols-outlined grp-search-icon"
              aria-hidden="true"
            >
              search
            </span>
            <input
              type="search"
              className="grp-search-input"
              placeholder="Search groups…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              aria-label="Tìm nhóm"
            />
          </div>
          <label className="grp-check">
            <input
              type="checkbox"
              checked={includeArchived}
              onChange={(e) => setIncludeArchived(e.target.checked)}
            />
            <span>Show archived</span>
          </label>
        </div>

        {/* ================= Danh sách nhóm ================= */}
        {loading ? (
          <div className="grp-state">
            <span className="material-symbols-outlined grp-state-icon grp-state-icon--spin">
              progress_activity
            </span>
            <p>Đang tải nhóm…</p>
          </div>
        ) : error ? (
          <div className="grp-state grp-state--error">
            <span className="material-symbols-outlined grp-state-icon">
              error
            </span>
            <p>{error}</p>
            <button
              type="button"
              className="grp-btn grp-btn--ghost"
              onClick={() => void loadGroups()}
            >
              Thử lại
            </button>
          </div>
        ) : visible.length === 0 ? (
          <div className="grp-state">
            <span className="material-symbols-outlined grp-state-icon">
              groups
            </span>
            <p>
              {search.trim()
                ? "Không tìm thấy nhóm nào khớp."
                : "Chưa có nhóm nào. Tạo nhóm để bắt đầu làm việc cùng nhau."}
            </p>
            {!search.trim() && (
              <button
                type="button"
                className="grp-btn grp-btn--primary"
                onClick={() => setCreateOpen(true)}
              >
                Tạo nhóm đầu tiên
              </button>
            )}
          </div>
        ) : (
          <ul className="grp-grid">
            {visible.map((g) => (
              <li key={g.id} className="grp-card">
                <div className="grp-card-head">
                  <div className="grp-card-head-text">
                    <Link to={`/groups/${g.id}`} className="grp-card-title">
                      {g.name}
                    </Link>
                    <div className="grp-card-tags">
                      <span
                        className={`grp-role grp-role--${roleTone(g.myRole)}`}
                      >
                        {roleLabel(g.myRole)}
                      </span>
                      {g.status === "Archived" && (
                        <span className="grp-tag grp-tag--archived">Archived</span>
                      )}
                    </div>
                  </div>
                  {normalizeRole(g.myRole) === "Leader" && (
                    <button
                      type="button"
                      className="grp-icon-btn"
                      title="Mời thành viên"
                      aria-label={`Mời thành viên vào ${g.name}`}
                      onClick={() => void openInvite(g)}
                    >
                      <span className="material-symbols-outlined">
                        person_add
                      </span>
                    </button>
                  )}
                </div>

                {g.description && (
                  <p className="grp-card-desc">{g.description}</p>
                )}

                <div className="grp-card-meta">
                  <span className="grp-card-meta-item">
                    <span className="material-symbols-outlined" aria-hidden="true">
                      group
                    </span>
                    {g.memberCount} thành viên
                  </span>
                  {g.startDate && (
                    <span className="grp-card-meta-item">
                      <span
                        className="material-symbols-outlined"
                        aria-hidden="true"
                      >
                        event
                      </span>
                      {fmtGroupDate(g.startDate)}
                    </span>
                  )}
                  {g.deadline && (
                    <span className="grp-card-meta-item">
                      <span
                        className="material-symbols-outlined"
                        aria-hidden="true"
                      >
                        flag
                      </span>
                      {fmtGroupDate(g.deadline)}
                    </span>
                  )}
                </div>

                <div className="grp-card-foot">
                  <Link
                    to={`/groups/${g.id}`}
                    className="grp-btn grp-btn--ghost grp-btn--sm"
                  >
                    Mở nhóm
                    <span
                      className="material-symbols-outlined grp-btn-icon"
                      aria-hidden="true"
                    >
                      arrow_forward
                    </span>
                  </Link>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* ================= Modal tạo nhóm ================= */}
      {createOpen && (
        <div
          className="grp-modal-backdrop"
          onClick={() => setCreateOpen(false)}
          role="presentation"
        >
          <div
            className="grp-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="grp-create-title"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="grp-modal-head">
              <h2 id="grp-create-title" className="grp-modal-title">
                <span
                  className="material-symbols-outlined grp-modal-title-icon"
                  aria-hidden="true"
                >
                  groups
                </span>
                Create group
              </h2>
              <button
                type="button"
                className="grp-modal-close"
                onClick={() => setCreateOpen(false)}
                aria-label="Đóng"
              >
                <span className="material-symbols-outlined">close</span>
              </button>
            </div>

            <form className="grp-form" onSubmit={handleCreate}>
              <div className="grp-field">
                <label className="grp-label" htmlFor="grp-f-name">
                  Group name *
                </label>
                <input
                  id="grp-f-name"
                  type="text"
                  className="grp-input"
                  placeholder="e.g. Website Redesign Squad"
                  value={form.name}
                  onChange={(e) =>
                    setForm((f) => ({ ...f, name: e.target.value }))
                  }
                  required
                />
              </div>

              <div className="grp-field">
                <label className="grp-label" htmlFor="grp-f-desc">
                  Description
                </label>
                <textarea
                  id="grp-f-desc"
                  rows={3}
                  className="grp-input grp-input--textarea"
                  placeholder="Mục tiêu của nhóm…"
                  value={form.description}
                  onChange={(e) =>
                    setForm((f) => ({ ...f, description: e.target.value }))
                  }
                />
              </div>

              <div className="grp-field-row">
                <div className="grp-field">
                  <label className="grp-label" htmlFor="grp-f-start">
                    Start date
                  </label>
                  <input
                    id="grp-f-start"
                    type="date"
                    className="grp-input"
                    value={form.startDate}
                    onChange={(e) =>
                      setForm((f) => ({ ...f, startDate: e.target.value }))
                    }
                  />
                </div>
                <div className="grp-field">
                  <label className="grp-label" htmlFor="grp-f-deadline">
                    Deadline
                  </label>
                  <input
                    id="grp-f-deadline"
                    type="date"
                    className="grp-input"
                    value={form.deadline}
                    onChange={(e) =>
                      setForm((f) => ({ ...f, deadline: e.target.value }))
                    }
                  />
                </div>
              </div>

              {formError && (
                <p className="grp-form-error">
                  <span className="material-symbols-outlined" aria-hidden="true">
                    error
                  </span>
                  {formError}
                </p>
              )}

              <div className="grp-form-actions">
                <button
                  type="button"
                  className="grp-btn grp-btn--ghost"
                  onClick={() => setCreateOpen(false)}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="grp-btn grp-btn--primary"
                  disabled={creating}
                >
                  {creating ? (
                    <span className="material-symbols-outlined grp-btn-icon grp-state-icon--spin">
                      progress_activity
                    </span>
                  ) : (
                    <span className="material-symbols-outlined grp-btn-icon">
                      add_task
                    </span>
                  )}
                  Create group
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ================= Modal mời thành viên ================= */}
      {inviteOpen && inviteGroup && (
        <GroupInviteModal
          groupId={inviteGroup.id}
          groupName={inviteGroup.name}
          onClose={() => setInviteOpen(false)}
          onInvited={() => {
            toast.success(
              "Đã gửi lời mời",
              "Người được mời sẽ thấy lời mời trong hộp thư.",
            );
          }}
          onError={(err) => showApiError(err, "send this invitation")}
        />
      )}

      <GroupErrorDialog
        error={errorDialog?.view ?? null}
        details={errorDialog?.details ?? null}
        rawMessage={errorDialog?.raw || undefined}
        onClose={() => setErrorDialog(null)}
      />

      <CenterToasts toasts={toasts} onDismiss={toast.dismiss} />
    </div>
  );
}
