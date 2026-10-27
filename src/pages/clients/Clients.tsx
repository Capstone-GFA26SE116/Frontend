import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type FormEvent,
  type KeyboardEvent,
} from "react";
import { createPortal } from "react-dom";
import { useStaggeredMount } from "../../hooks/useStaggeredMount";
import { CenterToasts, useCenterToast } from "../../components/Toast";
import {
  createClient,
  deleteClient,
  filterClients,
  listClients,
  listProjects,
  updateClient,
  type ClientDto,
  type ProjectDto,
} from "../../lib/api-client";
import "./clients.css";

/* ===========================================================
 * Clients — Không gian quản lý khách hàng (master–detail)
 *
 * Endpoints:
 *  - GET    /api/clients
 *  - GET    /api/clients/filter?name=
 *  - GET    /api/clients/{clientId}
 *  - POST   /api/clients
 *  - PUT    /api/clients/{clientId}
 *  - DELETE /api/clients/{clientId}
 *  - GET    /api/projects  (để đếm & liệt kê dự án theo client)
 *
 * Class prefix `.cli-*`. Render trong <SiteLayout />.
 * =========================================================== */

interface ClientForm {
  name: string;
  contactEmail: string;
  phone: string;
  notes: string;
}

const EMPTY_FORM: ClientForm = {
  name: "",
  contactEmail: "",
  phone: "",
  notes: "",
};

type SortKey = "name" | "createdAt";

/** Rút gọn chữ cái đầu cho avatar (tối đa 2 ký tự). */
function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].charAt(0).toUpperCase();
  return (
    parts[0].charAt(0) + parts[parts.length - 1].charAt(0)
  ).toUpperCase();
}

/** "27 Oct 2026" — gọn, đọc được, không phụ thuộc locale máy. */
function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

/** Số ngày kể từ lúc tạo — dùng cho nhãn "client since". */
function daysSince(iso: string | null): number | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return null;
  return Math.max(0, Math.floor((Date.now() - t) / 86_400_000));
}

/** Chuẩn hoá status dự án về 3 nhóm để tô màu. */
function statusKind(status: string): "active" | "pending" | "done" {
  const s = (status ?? "").toLowerCase();
  if (s === "completed" || s === "done") return "done";
  if (s === "pending" || s === "draft") return "pending";
  return "active";
}

function prettyStatus(status: string): string {
  const s = (status ?? "").toLowerCase();
  if (s === "completed" || s === "done") return "Completed";
  if (s === "pending") return "Pending";
  if (s === "active") return "Active";
  return status || "Unknown";
}

export function ClientsPage() {
  const [clients, setClients] = useState<ClientDto[]>([]);
  const [projects, setProjects] = useState<ProjectDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [search, setSearch] = useState("");
  const [sortKey, setSortKey] = useState<SortKey>("name");
  /** Kết quả lọc phía server (GET /api/clients/filter) — null = không lọc. */
  const [serverMatchIds, setServerMatchIds] = useState<Set<string> | null>(
    null,
  );

  const [selectedId, setSelectedId] = useState<string | null>(null);

  /* --- Modal tạo / sửa --- */
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<ClientDto | null>(null);
  const [form, setForm] = useState<ClientForm>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  /* --- Modal xác nhận xoá --- */
  const [deleting, setDeleting] = useState<ClientDto | null>(null);
  const [removing, setRemoving] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const [toasts, toast] = useCenterToast();
  const { mounted } = useStaggeredMount(50, 40, clients.length);
  const detailRef = useRef<HTMLElement | null>(null);
  /** Chỉ auto-scroll tới panel khi người dùng chủ động chọn (không phải lúc load). */
  const userPickedRef = useRef(false);

  /** Màn < 1024px: panel chi tiết nằm dưới list → cuộn tới cho thấy ngay. */
  function pickClient(id: string) {
    setSelectedId(id);
    userPickedRef.current = true;
  }

  useEffect(() => {
    if (!userPickedRef.current) return;
    if (typeof window === "undefined") return;
    if (window.matchMedia("(min-width: 1024px)").matches) return;
    detailRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    userPickedRef.current = false;
  }, [selectedId]);

  /* -------------------- Load -------------------- */
  async function load() {
    setLoading(true);
    setLoadError(null);
    setServerMatchIds(null);
    const [clientsRes, projectsRes] = await Promise.all([
      listClients(),
      listProjects(),
    ]);
    setLoading(false);
    if (clientsRes.ok) {
      setClients(clientsRes.data ?? []);
    } else {
      setLoadError(
        clientsRes.status === 401
          ? "Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại."
          : (clientsRes.error ?? "Không tải được danh sách khách hàng."),
      );
    }
    // Dự án chỉ là dữ liệu phụ trợ — lỗi không chặn trang.
    setProjects(projectsRes.ok ? (projectsRes.data ?? []) : []);
  }

  useEffect(() => {
    void load();
  }, []);

  /* -------------------- Derived -------------------- */
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const rows = q
      ? clients.filter((c) => {
          // Nếu đã lọc phía server, ưu tiên tập id server trả về.
          if (serverMatchIds && !serverMatchIds.has(c.id)) return false;
          return (
            (c.name ?? "").toLowerCase().includes(q) ||
            (c.contactEmail ?? "").toLowerCase().includes(q) ||
            (c.phone ?? "").toLowerCase().includes(q) ||
            (c.notes ?? "").toLowerCase().includes(q)
          );
        })
      : clients.slice();

    rows.sort((a, b) => {
      if (sortKey === "createdAt") {
        const av = new Date(a.createdAt).getTime();
        const bv = new Date(b.createdAt).getTime();
        return (Number.isNaN(bv) ? 0 : bv) - (Number.isNaN(av) ? 0 : av);
      }
      return (a.name ?? "").localeCompare(b.name ?? "");
    });
    return rows;
  }, [clients, search, sortKey, serverMatchIds]);

  /** clientId -> danh sách dự án thuộc client đó. */
  const projectsByClient = useMemo(() => {
    const map = new Map<string, ProjectDto[]>();
    for (const p of projects) {
      if (!p.clientId) continue;
      const list = map.get(p.clientId);
      if (list) list.push(p);
      else map.set(p.clientId, [p]);
    }
    return map;
  }, [projects]);

  const stats = useMemo(() => {
    const withEmail = clients.filter((c) => !!c.contactEmail).length;
    const withPhone = clients.filter((c) => !!c.phone).length;
    const withNotes = clients.filter((c) => !!c.notes).length;
    const linked = clients.filter((c) => projectsByClient.has(c.id)).length;
    return {
      total: clients.length,
      withEmail,
      withPhone,
      withNotes,
      linked,
    };
  }, [clients, projectsByClient]);

  /** Tự chọn khách hàng đầu tiên khi danh sách hiển thị có dữ liệu. */
  useEffect(() => {
    if (filtered.length === 0) {
      setSelectedId(null);
      return;
    }
    setSelectedId((prev) =>
      prev && filtered.some((c) => c.id === prev) ? prev : filtered[0].id,
    );
  }, [filtered]);

  const selected = useMemo(
    () => clients.find((c) => c.id === selectedId) ?? null,
    [clients, selectedId],
  );

  const selectedProjects = selected
    ? (projectsByClient.get(selected.id) ?? [])
    : [];

  /** Độ đầy đủ hồ sơ: name (luôn có) + email + phone + notes. */
  const completeness = selected
    ? Math.round(
        ([true, !!selected.contactEmail, !!selected.phone, !!selected.notes]
          .filter(Boolean).length /
          4) *
          100,
      )
    : 0;

  /* -------------------- Handlers -------------------- */
  function openCreate() {
    setEditing(null);
    setForm(EMPTY_FORM);
    setFormError(null);
    setFormOpen(true);
  }

  function openEdit(c: ClientDto) {
    setEditing(c);
    setForm({
      name: c.name ?? "",
      contactEmail: c.contactEmail ?? "",
      phone: c.phone ?? "",
      notes: c.notes ?? "",
    });
    setFormError(null);
    setFormOpen(true);
  }

  function closeForm() {
    if (saving) return;
    setFormOpen(false);
    setEditing(null);
    setFormError(null);
  }

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (saving) return;

    const name = form.name.trim();
    if (!name) {
      setFormError("Tên khách hàng không được để trống.");
      return;
    }
    const email = form.contactEmail.trim();
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      setFormError("Email không đúng định dạng.");
      return;
    }

    const body = {
      name,
      contactEmail: email,
      phone: form.phone.trim(),
      notes: form.notes.trim(),
    };

    setSaving(true);
    setFormError(null);
    const res = editing
      ? await updateClient(editing.id, body)
      : await createClient(body);
    setSaving(false);

    if (!res.ok) {
      setFormError(res.error ?? "Không lưu được khách hàng.");
      return;
    }

    // Cập nhật tại chỗ để không phải tải lại cả danh sách.
    setClients((prev) => {
      if (editing) {
        return prev.map((c) => (c.id === editing.id ? res.data : c));
      }
      return [res.data, ...prev];
    });
    setSelectedId(res.data.id);
    setFormOpen(false);
    setEditing(null);
    toast.success(
      editing ? "Đã cập nhật khách hàng" : "Đã thêm khách hàng",
      res.data.name,
    );
  }

  async function handleDelete() {
    if (!deleting || removing) return;
    setRemoving(true);
    setDeleteError(null);
    const res = await deleteClient(deleting.id);
    setRemoving(false);

    if (!res.ok) {
      setDeleteError(res.error ?? "Không xoá được khách hàng.");
      return;
    }
    setClients((prev) => prev.filter((c) => c.id !== deleting.id));
    toast.success("Đã xoá khách hàng", deleting.name);
    setDeleting(null);
  }

  /** Lọc phía server theo tên — dùng khi danh sách lớn. */
  async function searchOnServer() {
    const name = search.trim();
    if (!name) {
      setServerMatchIds(null);
      void load();
      return;
    }
    setLoading(true);
    setLoadError(null);
    const res = await filterClients({ name });
    setLoading(false);
    if (res.ok) {
      const list = res.data ?? [];
      setServerMatchIds(new Set(list.map((c) => c.id)));
      // Gộp kết quả server vào danh sách hiện có để không mất dữ liệu cũ.
      setClients((prev) => {
        const map = new Map(prev.map((c) => [c.id, c]));
        for (const c of list) map.set(c.id, c);
        return [...map.values()];
      });
    } else {
      setLoadError(res.error ?? "Không lọc được danh sách.");
    }
  }

  async function copyText(text: string, label: string) {
    try {
      await navigator.clipboard.writeText(text);
      toast.success("Đã copy", label);
    } catch {
      toast.error("Không copy được", "Trình duyệt chặn clipboard.");
    }
  }

  /* -------------------- Esc để đóng modal -------------------- */
  useEffect(() => {
    if (!formOpen && !deleting) return;
    function onKey(e: globalThis.KeyboardEvent) {
      if (e.key !== "Escape") return;
      if (deleting) setDeleting(null);
      else closeForm();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [formOpen, deleting, saving]);

  const isEmpty = !loading && !loadError && clients.length === 0;

  return (
    <div className="cli">
      <div className="cli-container">
        {/* ================= Header ================= */}
        <header className={"cli-header" + (mounted ? " cli-header--in" : "")}>
          <div className="cli-header-text">
            <h1 className="cli-eyebrow">
              <span className="cli-eyebrow-dot" aria-hidden="true" />
              <span>Clients</span>
            </h1>
        
          </div>
          <div className="cli-header-actions">
            <span className="cli-header-meta">
              <span className="cli-header-meta-value">{stats.total}</span>
              <span className="cli-header-meta-label">records</span>
            </span>
            <button
              type="button"
              className="cli-btn cli-btn--primary"
              onClick={openCreate}
            >
              <span className="material-symbols-outlined cli-btn-icon cli-btn-icon--rotate">
                add
              </span>
              <span>New client</span>
            </button>
          </div>
        </header>

        {/* ================= KPI telemetry ================= */}
        <section className="cli-kpi" aria-label="Client overview">
          <KpiCard
            label="Total clients"
            value={String(stats.total)}
            unit="records"
            icon="group"
            pct={100}
            foot={
              stats.total === 1
                ? "1 khách hàng trong danh bạ"
                : `${stats.total} khách hàng trong danh bạ`
            }
          />
          <KpiCard
            label="Linked to projects"
            value={String(stats.linked)}
            unit={`/ ${stats.total}`}
            icon="link"
            tone="primary"
            pct={stats.total ? (stats.linked / stats.total) * 100 : 0}
            foot={
              stats.linked === 0
                ? "Chưa gán khách hàng vào dự án nào"
                : `${stats.linked} khách hàng đang có dự án`
            }
          />
          <KpiCard
            label="Reachable"
            value={String(
              clients.filter((c) => !!c.contactEmail || !!c.phone).length,
            )}
            unit={`/ ${stats.total}`}
            icon="call"
            tone="primary"
            pct={
              stats.total
                ? (clients.filter((c) => !!c.contactEmail || !!c.phone).length /
                    stats.total) *
                  100
                : 0
            }
            foot="Có email hoặc số điện thoại"
          />
          <KpiCard
            label="With notes"
            value={String(stats.withNotes)}
            unit={`/ ${stats.total}`}
            icon="sticky_note_2"
            pct={stats.total ? (stats.withNotes / stats.total) * 100 : 0}
            foot="Có ghi chú nội bộ"
          />
        </section>

        {/* ================= Workspace: list + detail ================= */}
        <div className="cli-workspace">
          {/* ---------- List pane ---------- */}
          <section className="cli-listpane" aria-label="Client directory">
            <div className="cli-pane-head">
              <div className="cli-pane-title-row">
                <h2 className="cli-pane-title">Directory</h2>
                <span className="cli-pane-count">
                  {filtered.length}
                  <span className="cli-pane-count-sep">/</span>
                  {clients.length}
                </span>
              </div>
              <div className="cli-pane-tools">
                <div className="cli-search">
                  <span
                    className="material-symbols-outlined cli-search-icon"
                    aria-hidden="true"
                  >
                    search
                  </span>
                  <input
                    type="search"
                    className="cli-search-input"
                    placeholder="Tìm tên, email, SĐT…"
                    value={search}
                    onChange={(e) => {
                      setSearch(e.target.value);
                      // Gõ lại từ đầu → bỏ ràng buộc kết quả server cũ.
                      setServerMatchIds(null);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        void searchOnServer();
                      }
                    }}
                    aria-label="Search clients"
                  />
                  {search && (
                    <button
                      type="button"
                      className="cli-search-clear"
                      onClick={() => {
                        setSearch("");
                        setServerMatchIds(null);
                      }}
                      aria-label="Clear search"
                    >
                      <span className="material-symbols-outlined">close</span>
                    </button>
                  )}
                </div>

                <div className="cli-sort" role="group" aria-label="Sort clients">
                  <button
                    type="button"
                    className={
                      "cli-sort-btn" +
                      (sortKey === "name" ? " cli-sort-btn--on" : "")
                    }
                    onClick={() => setSortKey("name")}
                  >
                    A–Z
                  </button>
                  <button
                    type="button"
                    className={
                      "cli-sort-btn" +
                      (sortKey === "createdAt" ? " cli-sort-btn--on" : "")
                    }
                    onClick={() => setSortKey("createdAt")}
                  >
                    Newest
                  </button>
                </div>

                <button
                  type="button"
                  className="cli-icon-btn"
                  onClick={() => void load()}
                  title="Tải lại danh sách"
                  aria-label="Reload clients"
                >
                  <span className="material-symbols-outlined">refresh</span>
                </button>
              </div>
            </div>

            {/* States */}
            {loading && (
              <div className="cli-skeleton" aria-hidden="true">
                <div className="cli-skeleton-state">
                  <span className="material-symbols-outlined cli-spin">
                    progress_activity
                  </span>
                  <span>Đang tải danh sách khách hàng…</span>
                </div>
                {[0, 1, 2, 3].map((i) => (
                  <div
                    key={i}
                    className="cli-skeleton-row"
                    style={{ animationDelay: `${i * 90}ms` }}
                  >
                    <span className="cli-skeleton-avatar" />
                    <span className="cli-skeleton-lines">
                      <span className="cli-skeleton-line cli-skeleton-line--lg" />
                      <span className="cli-skeleton-line cli-skeleton-line--sm" />
                    </span>
                  </div>
                ))}
              </div>
            )}

            {!loading && loadError && (
              <div className="cli-state cli-state--error">
                <span className="material-symbols-outlined">error</span>
                <span>{loadError}</span>
                <button
                  type="button"
                  className="cli-btn cli-btn--ghost"
                  onClick={() => void load()}
                >
                  Thử lại
                </button>
              </div>
            )}

            {isEmpty && (
              <div className="cli-empty">
                <span className="material-symbols-outlined cli-empty-icon">
                  group_add
                </span>
                <h2 className="cli-empty-title">Chưa có khách hàng nào</h2>
                <p className="cli-empty-sub">
                  Thêm khách hàng đầu tiên để có thể gán vào dự án và theo dõi
                  liên hệ.
                </p>
                <button
                  type="button"
                  className="cli-btn cli-btn--primary"
                  onClick={openCreate}
                >
                  <span className="material-symbols-outlined cli-btn-icon">
                    add
                  </span>
                  <span>Thêm khách hàng</span>
                </button>
              </div>
            )}

            {!loading &&
              !loadError &&
              clients.length > 0 &&
              (filtered.length === 0 ? (
                <div className="cli-noresult">
                  <span className="material-symbols-outlined">search_off</span>
                  <span>Không có khách hàng nào khớp “{search}”.</span>
                  <button
                    type="button"
                    className="cli-btn cli-btn--text"
                    onClick={() => {
                      setSearch("");
                      setServerMatchIds(null);
                    }}
                  >
                    Xoá bộ lọc
                  </button>
                </div>
              ) : (
                <ul className="cli-list">
                  {filtered.map((c, i) => {
                    const active = c.id === selectedId;
                    const linked = projectsByClient.get(c.id)?.length ?? 0;
                    return (
                      <li
                        key={c.id}
                        className={
                          "cli-row" +
                          (mounted ? " cli-row--in" : "") +
                          (active ? " cli-row--active" : "")
                        }
                        style={
                          { animationDelay: `${i * 40}ms` } as CSSProperties
                        }
                      >
                        <button
                          type="button"
                          className="cli-row-btn"
                          onClick={() => pickClient(c.id)}
                          onKeyDown={(e: KeyboardEvent<HTMLButtonElement>) => {
                            if (e.key === "Enter" || e.key === " ") {
                              e.preventDefault();
                              pickClient(c.id);
                            }
                          }}
                          aria-pressed={active}
                          aria-label={`View ${c.name}`}
                        >
                          <span className="cli-row-avatar" aria-hidden="true">
                            {initials(c.name)}
                          </span>

                          <span className="cli-row-main">
                            <span className="cli-row-name-line">
                              <span className="cli-row-name">{c.name}</span>
                              {linked > 0 && (
                                <span className="cli-row-badge">
                                  <span className="material-symbols-outlined">
                                    folder
                                  </span>
                                  {linked}
                                </span>
                              )}
                            </span>
                            <span className="cli-row-meta">
                              <span className="cli-row-meta-item">
                                <span className="material-symbols-outlined">
                                  mail
                                </span>
                                {c.contactEmail || "Chưa có email"}
                              </span>
                              <span className="cli-row-meta-item">
                                <span className="material-symbols-outlined">
                                  call
                                </span>
                                {c.phone || "Chưa có SĐT"}
                              </span>
                            </span>
                          </span>

                          <span
                            className="material-symbols-outlined cli-row-chevron"
                            aria-hidden="true"
                          >
                            chevron_right
                          </span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              ))}
          </section>

          {/* ---------- Detail pane ---------- */}
          <aside
            className="cli-detailpane"
            aria-label="Client detail"
            ref={detailRef}
          >
            {selected ? (
              <ClientDetail
                key={selected.id}
                client={selected}
                projects={selectedProjects}
                completeness={completeness}
                onEdit={() => openEdit(selected)}
                onDelete={() => {
                  setDeleting(selected);
                  setDeleteError(null);
                }}
                onCopy={copyText}
              />
            ) : (
              <div className="cli-detail-empty">
                <span className="material-symbols-outlined">person_search</span>
                <p>Chọn một khách hàng ở danh sách bên trái để xem hồ sơ.</p>
              </div>
            )}
          </aside>
        </div>
      </div>

      {/* ================= Modal: create / edit ================= */}
      {formOpen &&
        createPortal(
          <div
            className="cli-modal-backdrop"
            onClick={(e) => {
              if (e.target === e.currentTarget) closeForm();
            }}
          >
            <div
              className="cli-modal"
              role="dialog"
              aria-modal="true"
              aria-labelledby="cli-modal-title"
            >
              <div className="cli-modal-head">
                <div>
                  <span className="cli-modal-eyebrow">
                    <span className="material-symbols-outlined">
                      {editing ? "edit" : "person_add"}
                    </span>
                    {editing ? "Edit client" : "New client"}
                  </span>
                  <h2 className="cli-modal-title" id="cli-modal-title">
                    {editing ? "Cập nhật khách hàng" : "Thêm khách hàng"}
                  </h2>
                  <p className="cli-modal-sub">
                    {editing
                      ? "Chỉnh sửa thông tin liên hệ và ghi chú nội bộ."
                      : "Điền thông tin liên hệ để gán khách hàng vào dự án."}
                  </p>
                </div>
                <button
                  type="button"
                  className="cli-modal-close"
                  onClick={closeForm}
                  aria-label="Close"
                >
                  <span className="material-symbols-outlined">close</span>
                </button>
              </div>

              <form className="cli-form" onSubmit={handleSubmit}>
                <div className="cli-field">
                  <label className="cli-label" htmlFor="cli-name">
                    Tên khách hàng <span className="cli-req">*</span>
                  </label>
                  <input
                    id="cli-name"
                    className="cli-input"
                    value={form.name}
                    onChange={(e) =>
                      setForm((f) => ({ ...f, name: e.target.value }))
                    }
                    placeholder="VD: Công ty TNHH An Phát"
                    autoFocus
                    maxLength={200}
                  />
                </div>

                <div className="cli-field-row">
                  <div className="cli-field">
                    <label className="cli-label" htmlFor="cli-email">
                      Email liên hệ
                    </label>
                    <input
                      id="cli-email"
                      className="cli-input"
                      type="email"
                      value={form.contactEmail}
                      onChange={(e) =>
                        setForm((f) => ({
                          ...f,
                          contactEmail: e.target.value,
                        }))
                      }
                      placeholder="contact@company.com"
                      maxLength={200}
                    />
                  </div>
                  <div className="cli-field">
                    <label className="cli-label" htmlFor="cli-phone">
                      Số điện thoại
                    </label>
                    <input
                      id="cli-phone"
                      className="cli-input"
                      type="tel"
                      value={form.phone}
                      onChange={(e) =>
                        setForm((f) => ({ ...f, phone: e.target.value }))
                      }
                      placeholder="0901 234 567"
                      maxLength={40}
                    />
                  </div>
                </div>

                <div className="cli-field">
                  <label className="cli-label" htmlFor="cli-notes">
                    Ghi chú
                  </label>
                  <textarea
                    id="cli-notes"
                    className="cli-input cli-input--textarea"
                    value={form.notes}
                    onChange={(e) =>
                      setForm((f) => ({ ...f, notes: e.target.value }))
                    }
                    placeholder="Bối cảnh hợp tác, yêu cầu riêng, đầu mối liên hệ…"
                    rows={4}
                    maxLength={2000}
                  />
                </div>

                {formError && (
                  <div className="cli-form-error" role="alert">
                    <span className="material-symbols-outlined">error</span>
                    <span>{formError}</span>
                  </div>
                )}

                <div className="cli-form-actions">
                  <button
                    type="button"
                    className="cli-btn cli-btn--text"
                    onClick={closeForm}
                    disabled={saving}
                  >
                    Huỷ
                  </button>
                  <button
                    type="submit"
                    className="cli-btn cli-btn--primary"
                    disabled={saving}
                  >
                    {saving ? (
                      <span className="material-symbols-outlined cli-spin">
                        progress_activity
                      </span>
                    ) : (
                      <span className="material-symbols-outlined cli-btn-icon">
                        check
                      </span>
                    )}
                    <span>{editing ? "Lưu thay đổi" : "Tạo khách hàng"}</span>
                  </button>
                </div>
              </form>
            </div>
          </div>,
          document.body,
        )}

      {/* ================= Modal: delete confirm ================= */}
      {deleting &&
        createPortal(
          <div
            className="cli-modal-backdrop"
            onClick={(e) => {
              if (e.target === e.currentTarget && !removing) setDeleting(null);
            }}
          >
            <div
              className="cli-modal cli-modal--confirm"
              role="alertdialog"
              aria-modal="true"
              aria-labelledby="cli-del-title"
            >
              <div className="cli-modal-head">
                <div>
                  <span className="cli-modal-eyebrow cli-modal-eyebrow--danger">
                    <span className="material-symbols-outlined">warning</span>
                    Delete client
                  </span>
                  <h2 className="cli-modal-title" id="cli-del-title">
                    Xoá khách hàng?
                  </h2>
                  <p className="cli-modal-sub">
                    <strong>{deleting.name}</strong> sẽ bị xoá khỏi danh bạ.
                    Các dự án đang gán khách hàng này sẽ mất liên kết.
                  </p>
                </div>
              </div>

              {deleteError && (
                <div className="cli-form-error" role="alert">
                  <span className="material-symbols-outlined">error</span>
                  <span>{deleteError}</span>
                </div>
              )}

              <div className="cli-form-actions">
                <button
                  type="button"
                  className="cli-btn cli-btn--text"
                  onClick={() => setDeleting(null)}
                  disabled={removing}
                >
                  Giữ lại
                </button>
                <button
                  type="button"
                  className="cli-btn cli-btn--danger"
                  onClick={() => void handleDelete()}
                  disabled={removing}
                >
                  {removing ? (
                    <span className="material-symbols-outlined cli-spin">
                      progress_activity
                    </span>
                  ) : (
                    <span className="material-symbols-outlined cli-btn-icon">
                      delete
                    </span>
                  )}
                  <span>Xoá</span>
                </button>
              </div>
            </div>
          </div>,
          document.body,
        )}

      <CenterToasts toasts={toasts} onDismiss={toast.dismiss} />
    </div>
  );
}

/* ===========================================================
 * Client detail panel
 * =========================================================== */
function ClientDetail({
  client,
  projects,
  completeness,
  onEdit,
  onDelete,
  onCopy,
}: {
  client: ClientDto;
  projects: ProjectDto[];
  completeness: number;
  onEdit: () => void;
  onDelete: () => void;
  onCopy: (text: string, label: string) => void;
}) {
  const since = daysSince(client.createdAt);
  const activeProjects = projects.filter(
    (p) => statusKind(p.status) === "active",
  ).length;

  return (
    <div className="cli-detail">
      {/* Cover */}
      <div className="cli-detail-cover">
        <div className="cli-detail-cover-grid" aria-hidden="true" />
        <div className="cli-detail-avatar" aria-hidden="true">
          {initials(client.name)}
        </div>
        <h2 className="cli-detail-name">{client.name}</h2>
        <div className="cli-detail-subline">
          <span className="cli-detail-chip">
            <span className="material-symbols-outlined">badge</span>
            Client since {fmtDate(client.createdAt)}
          </span>
          {since !== null && (
            <span className="cli-detail-chip cli-detail-chip--muted">
              {since === 0 ? "hôm nay" : `${since} ngày`}
            </span>
          )}
        </div>

        <div className="cli-detail-actions">
          <button type="button" className="cli-btn cli-btn--primary" onClick={onEdit}>
            <span className="material-symbols-outlined cli-btn-icon">edit</span>
            <span>Edit</span>
          </button>
          <button
            type="button"
            className="cli-btn cli-btn--ghost cli-btn--ghost-label"
            onClick={onDelete}
          >
            <span className="material-symbols-outlined cli-btn-icon">
              delete
            </span>
            <span>Delete</span>
          </button>
        </div>
      </div>

      {/* Completeness meter */}
      <div className="cli-detail-meter">
        <div className="cli-detail-meter-head">
          <span className="cli-detail-meter-label">Profile completeness</span>
          <span className="cli-detail-meter-value">{completeness}%</span>
        </div>
        <div
          className="cli-detail-meter-track"
          role="progressbar"
          aria-valuenow={completeness}
          aria-valuemin={0}
          aria-valuemax={100}
        >
          <span
            className="cli-detail-meter-fill"
            style={{ width: `${completeness}%` }}
          />
        </div>
        <div className="cli-detail-meter-hint">
          {completeness === 100
            ? "Hồ sơ đầy đủ — sẵn sàng gán vào dự án."
            : "Bổ sung email, số điện thoại và ghi chú để hồ sơ đầy đủ."}
        </div>
      </div>

      {/* Contact tiles */}
      <div className="cli-detail-section">
        <span className="cli-detail-section-label">Contact</span>
        <div className="cli-contact-grid">
          <ContactTile
            icon="mail"
            label="Email"
            value={client.contactEmail}
            href={
              client.contactEmail ? `mailto:${client.contactEmail}` : undefined
            }
            onCopy={() =>
              client.contactEmail &&
              onCopy(client.contactEmail, client.contactEmail)
            }
          />
          <ContactTile
            icon="call"
            label="Phone"
            value={client.phone}
            href={
              client.phone
                ? `tel:${client.phone.replace(/[^\d+]/g, "")}`
                : undefined
            }
            onCopy={() => client.phone && onCopy(client.phone, client.phone)}
          />
        </div>
      </div>

      {/* Notes */}
      <div className="cli-detail-section">
        <span className="cli-detail-section-label">Internal notes</span>
        {client.notes ? (
          <p className="cli-detail-notes">{client.notes}</p>
        ) : (
          <p className="cli-detail-notes cli-detail-notes--empty">
            Chưa có ghi chú nội bộ cho khách hàng này.
          </p>
        )}
      </div>

      {/* Related projects */}
      <div className="cli-detail-section">
        <div className="cli-detail-section-head">
          <span className="cli-detail-section-label">Projects</span>
          <span className="cli-detail-section-count">
            {projects.length}
            {activeProjects > 0 && ` · ${activeProjects} active`}
          </span>
        </div>

        {projects.length === 0 ? (
          <div className="cli-detail-noproj">
            <span className="material-symbols-outlined">folder_off</span>
            <span>Chưa có dự án nào gán khách hàng này.</span>
          </div>
        ) : (
          <ul className="cli-proj-list">
            {projects.map((p) => {
              const kind = statusKind(p.status);
              return (
                <li key={p.id} className="cli-proj">
                  <span
                    className={`cli-proj-dot cli-proj-dot--${kind}`}
                    aria-hidden="true"
                  />
                  <span className="cli-proj-main">
                    <span className="cli-proj-name">{p.name}</span>
                    <span className="cli-proj-meta">
                      {prettyStatus(p.status)}
                      {p.deadline ? ` · due ${fmtDate(p.deadline)}` : ""}
                    </span>
                  </span>
                  <span className={`cli-proj-pill cli-proj-pill--${kind}`}>
                    {kind === "done"
                      ? "Done"
                      : kind === "pending"
                        ? "Pending"
                        : "Active"}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {/* Meta footer */}
      <div className="cli-detail-meta">
        <span className="cli-detail-meta-label">Client ID</span>
        <button
          type="button"
          className="cli-detail-id"
          onClick={() => onCopy(client.id, "Client ID")}
          title="Copy client ID"
        >
          <span>{client.id}</span>
          <span className="material-symbols-outlined">content_copy</span>
        </button>
      </div>
    </div>
  );
}

function ContactTile({
  icon,
  label,
  value,
  href,
  onCopy,
}: {
  icon: string;
  label: string;
  value: string | null;
  href?: string;
  onCopy: () => void;
}) {
  const empty = !value;
  return (
    <div className={"cli-contact" + (empty ? " cli-contact--empty" : "")}>
      <span className="cli-contact-icon">
        <span className="material-symbols-outlined">{icon}</span>
      </span>
      <span className="cli-contact-body">
        <span className="cli-contact-label">{label}</span>
        {empty ? (
          <span className="cli-contact-value cli-contact-value--empty">
            Not provided
          </span>
        ) : href ? (
          <a className="cli-contact-value" href={href}>
            {value}
          </a>
        ) : (
          <span className="cli-contact-value">{value}</span>
        )}
      </span>
      {!empty && (
        <button
          type="button"
          className="cli-contact-copy"
          onClick={onCopy}
          aria-label={`Copy ${label}`}
          title={`Copy ${label}`}
        >
          <span className="material-symbols-outlined">content_copy</span>
        </button>
      )}
    </div>
  );
}

/* -----------------------------------------------------------
 * KPI card — card-feature theo DESIGN.md
 * --------------------------------------------------------- */
function KpiCard({
  label,
  value,
  unit,
  icon,
  foot,
  tone,
  pct,
}: {
  label: string;
  value: string;
  unit: string;
  icon: string;
  foot: string;
  tone?: "primary";
  pct: number;
}) {
  return (
    <div className="cli-kpi-card">
      <div className="cli-kpi-head">
        <span className="cli-kpi-label">{label}</span>
        <span
          className={
            "cli-kpi-icon" + (tone === "primary" ? " cli-kpi-icon--primary" : "")
          }
        >
          <span className="material-symbols-outlined">{icon}</span>
        </span>
      </div>
      <div className="cli-kpi-body">
        <div className="cli-kpi-value-row">
          <span
            className={
              "cli-kpi-value" +
              (tone === "primary" ? " cli-kpi-value--primary" : "")
            }
          >
            {value}
          </span>
          <span className="cli-kpi-unit">{unit}</span>
        </div>
        <div className="cli-kpi-bar">
          <span
            className="cli-kpi-bar-fill"
            style={{ width: `${Math.max(0, Math.min(100, pct))}%` }}
          />
        </div>
        <p className="cli-kpi-foot">{foot}</p>
      </div>
    </div>
  );
}
