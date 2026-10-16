import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from "react";
import { createPortal } from "react-dom";
import { Link, useNavigate } from "react-router-dom";
import { useStaggeredMount } from "../../hooks/useStaggeredMount";
import {
  createClient,
  createProject,
  filterProjects,
  listClients,
  type ApiResult,
  type ClientDto,
  type ProjectDto,
} from "../../lib/api-client";
import "./projects.css";

/* ===========================================================
 * Projects & Workspaces — Trang chủ quản lý dự án (authenticated)
 *
 * Scope:
 *  - 1) Header (tiêu đề + CTA "Tạo dự án mới" + nút cấu hình AI)
 *  - 2) Command strip: search + status filter chips + view toggle
 *  - 3) 4 KPI telemetry cards (active / progress / K_bias / deadline)
 *  - 4) Grid 3 cột: 3 project cards (Fintech / Ecom / R&D) + placeholder
 *  - 5) AI Pipeline Preview (3 bước)
 *  - 6) Modal tạo dự án (form + AI toggle) + toast
 *
 * Class prefix `.proj-*`. Render trong <SiteLayout />.
 * =========================================================== */

type ProjectStatus = "active" | "pending" | "completed";
type ViewMode = "grid" | "list";

/**
 * View-model cho UI: gộp DTO từ BE + thông tin derived (daysLeft, badge…).
 * Tách khỏi `ProjectDto` để không lẫn field phái sinh với field từ server.
 */
interface Project {
  id: string;
  name: string;
  client: string;
  clientId: string;
  deadline: string; // dd/MM/yyyy
  daysLeft: number;
  status: ProjectStatus;
  /** % hoàn thành (0-100) */
  progress: number;
  /** số task hiện tại */
  doneTasks: number;
  /** tổng task */
  totalTasks: number;
  /** Loại badge trên top: "ai" | "allocating" | "pending" */
  badgeKind: "ai" | "allocating" | "pending";
  /** Tone màu badge */
  badgeTone: "secondary" | "primary" | "tertiary";
  /** Nhãn badge (vd: "AI Orchestrated") */
  badgeLabel: string;
  /** Nhãn client (vd: "FinTech Client") */
  clientTag: string;
  /** AI insight block (icon + text) */
  insightIcon: string;
  insightTone: "primary" | "secondary" | "tertiary";
  insight: string;
  /** Tùy chỉnh text trên progress bar */
  progressLabel?: string;
  /** 2 nút action ở footer */
  primaryAction: { label: string; icon: string; tone?: "primary" | "plain" };
  secondaryAction: {
    label: string;
    icon: string;
    variant?: "primary" | "plain";
  };
}

/* ---------- helpers ---------- */

/** Convert ISO `YYYY-MM-DD` -> localized date string for UI. */
function fmtDate(iso: string | null | undefined): string {
  if (!iso) return "Not set";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "Not set";
  return d.toLocaleDateString("en-US");
}

/** Số ngày còn lại từ hôm nay tới deadline (âm = quá hạn). */
function daysUntil(deadlineIso: string): number {
  const d = new Date(deadlineIso);
  if (Number.isNaN(d.getTime())) return 0;
  const now = new Date();
  // Chuẩn hoá về đầu ngày để tránh lệch do giờ.
  const a = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  const b = Date.UTC(d.getFullYear(), d.getMonth(), d.getDate());
  return Math.round((b - a) / 86_400_000);
}

/** Map `ProjectDto` từ BE -> view-model `Project` cho UI. */
/**
 * Map `ProjectDto` từ BE -> view-model `Project` cho UI.
 *
 * Response shape mới (từ GET /api/projects/filter):
 *  - `status` là string tự do: "active" | "pending" | "completed" | ...
 *  - `client` là object lồng (id/name/contactEmail/phone), null với dự án nội bộ
 *  - `createdAt` là ISO datetime
 *
 * Field phái sinh (progress, doneTasks, badge...) chưa có từ BE,
 * nên tạm lấy theo `status` để UI có visual đẹp ngay.
 */
function dtoToProject(d: ProjectDto): Project {
  const days = daysUntil(d.deadline);
  const clientName = d.client?.name ?? "Internal";
  const status: ProjectStatus =
    d.status === "completed"
      ? "completed"
      : d.status === "pending"
        ? "pending"
        : "active";

  return {
    id: d.id,
    name: d.name,
    client: clientName,
    clientId: d.clientId,
    deadline: fmtDate(d.deadline),
    daysLeft: days,
    status,
    // Phái sinh theo status — placeholder cho tới khi BE trả progress.
    progress: status === "completed" ? 100 : status === "pending" ? 10 : 35,
    doneTasks: 0,
    totalTasks: 0,
    badgeKind:
      status === "completed" ? "ai" : status === "pending" ? "pending" : "ai",
    badgeTone:
      status === "completed"
        ? "tertiary"
        : status === "pending"
          ? "tertiary"
          : "secondary",
    badgeLabel:
      status === "completed"
        ? "Completed"
        : status === "pending"
          ? "Awaiting launch"
          : "AI Orchestrated",
    clientTag: clientName,
    insightIcon:
      status === "completed" ? "task_alt" : status === "pending" ? "auto_mode" : "neurology",
    insightTone:
      status === "completed"
        ? "tertiary"
        : status === "pending"
          ? "tertiary"
          : "primary",
    insight:
      status === "completed"
        ? `Project completed. <span class="text-tertiary font-medium">${clientName}</span> has been delivered.`
        : status === "pending"
          ? `Project awaiting launch. AI will auto-decompose tasks as soon as you click <strong class="text-on-surface">Start</strong>.`
          : `AI is tracking progress. <strong class="text-on-surface">${Math.max(days, 0)} days</strong> left until deadline.`,
    primaryAction: {
      label: status === "completed" ? "Open details" : "View & Orchestrate",
      icon: status === "completed" ? "open_in_new" : "arrow_forward",
      tone: "plain",
    },
    secondaryAction: {
      label: status === "completed" ? "View report" : "AI Chunking",
      icon: status === "completed" ? "assessment" : "bolt",
      variant: "primary",
    },
  };
}

const STATUS_FILTERS: { id: "all" | ProjectStatus; label: string }[] = [
  { id: "all", label: "All" },
  { id: "active", label: "Active" },
  { id: "pending", label: "Pending" },
  { id: "completed", label: "Completed" },
];

export function ProjectsPage() {
  const navigate = useNavigate();
  const [projects, setProjects] = useState<Project[]>([]);
  const [clients, setClients] = useState<ClientDto[]>([]);
  const [listLoading, setListLoading] = useState(true);
  const [listError, setListError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<"all" | ProjectStatus>("all");
  const [view, setView] = useState<ViewMode>("grid");
  const [modalOpen, setModalOpen] = useState(false);
  const [clientInlineOpen, setClientInlineOpen] = useState(false);
  const [clientSubmitting, setClientSubmitting] = useState(false);
  const clientInlineFormRef = useRef<HTMLFormElement | null>(null);
  const [selectedClientId, setSelectedClientId] = useState("");
  // --- Client browser modal state ---
  const [clientBrowserOpen, setClientBrowserOpen] = useState(false);
  const [clientBrowserLoading, setClientBrowserLoading] = useState(false);
  const [clientBrowserError, setClientBrowserError] = useState<string | null>(
    null,
  );
  const [clientBrowserList, setClientBrowserList] = useState<
    Extract<ApiResult<ClientDto[]>, { ok: true }>["data"] | null
  >(null);
  const [clientBrowserSearch, setClientBrowserSearch] = useState("");
  const projectFormRef = useRef<HTMLFormElement | null>(null);
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);
  const [chunkingId, setChunkingId] = useState<string | null>(null);
  const [toast, setToast] = useState<{
    visible: boolean;
    text: string;
    icon: string;
    tone: "primary" | "success" | "info" | "error";
  }>({ visible: false, text: "", icon: "check_circle", tone: "success" });

  /** Stagger groups (pattern giống Dashboard / Pricing). */
  const headerAnim = useStaggeredMount(0, 30);
  const kpiAnim = useStaggeredMount(80, 120);
  const cardsAnim = useStaggeredMount(110, 240, projects.length);
  const pipelineAnim = useStaggeredMount(0, 360);

  /* ---------- Load danh sách dự án + danh sách client ---------- */
  useEffect(() => {
    let cancelled = false;

    async function loadAll() {
      setListLoading(true);
      setListError(null);
      const [projRes, clientRes] = await Promise.all([
        filterProjects({}),
        listClients(),
      ]);
      if (cancelled) return;

      if (projRes.ok) {
        console.log(
          "[Projects] API returned",
          projRes.data.length,
          "projects:",
          projRes.data,
        );
        setProjects(projRes.data.map(dtoToProject));
      } else {
        console.error("[Projects] API error:", projRes);
        setListError(projRes.error);
      }

      if (clientRes.ok) {
        setClients(clientRes.data);
      }
      // Lỗi load clients không block — user vẫn tạo được nếu biết clientId
      // hoặc khi backend populate sẵn.

      setListLoading(false);
    }

    loadAll();
    return () => {
      cancelled = true;
    };
  }, []);

  /** Đếm status để hiển thị "(N)" cạnh filter chip. */
  const counts = useMemo(() => {
    return {
      all: projects.length,
      active: projects.filter((p) => p.status === "active").length,
      pending: projects.filter((p) => p.status === "pending").length,
      completed: projects.filter((p) => p.status === "completed").length,
    };
  }, [projects]);

  /** Áp dụng search + filter, giữ placeholder card ở cuối. */
  const filteredProjects = useMemo(() => {
    const q = search.trim().toLowerCase();
    return projects.filter((p) => {
      if (filter !== "all" && p.status !== filter) return false;
      if (!q) return true;
      return (
        p.name.toLowerCase().includes(q) ||
        p.client.toLowerCase().includes(q) ||
        p.clientTag.toLowerCase().includes(q)
      );
    });
  }, [projects, search, filter]);

  function showToast(
    text: string,
    icon = "check_circle",
    tone: "primary" | "success" | "info" | "error" = "success",
  ) {
    setToast({ visible: true, text, icon, tone });
    window.setTimeout(() => setToast((t) => ({ ...t, visible: false })), 3200);
  }

  async function handleCreateProject(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const fd = new FormData(form);

    const name = (fd.get("name") as string)?.trim();
    const description = (fd.get("description") as string)?.trim() ?? "";
    const startDate = (fd.get("startDate") as string)?.trim();
    const deadline = (fd.get("deadline") as string)?.trim();
    const clientId = (fd.get("clientId") as string)?.trim();

    // Validate client — match BE schema (name required, dates required, clientId UUID)
    if (!name) {
      showToast("Project name is required.", "error", "error");
      return;
    }
    if (!startDate) {
      showToast("Please pick a start date.", "error", "error");
      return;
    }
    if (!deadline) {
      showToast("Please pick a deadline.", "error", "error");
      return;
    }
    if (new Date(deadline) < new Date(startDate)) {
      showToast("Deadline must be after the start date.", "error", "error");
      return;
    }
    // clientId là optional — nếu rỗng thì gửi null (dự án nội bộ).
    const finalClientId = clientId ? clientId : null;

    const submitBtn = form.querySelector<HTMLButtonElement>(
      'button[type="submit"]',
    );
    if (submitBtn) submitBtn.disabled = true;

    const res = await createProject({
      name,
      description,
      startDate,
      deadline,
      clientId: finalClientId,
    });

    if (submitBtn) submitBtn.disabled = false;

    if (!res.ok) {
      // res.error is a string error code from BE; show a friendly message
      showToast(
        `Failed to create project: ${res.error}`,
        "error",
        "error",
      );
      return;
    }

    setProjects((prev) => [dtoToProject(res.data), ...prev]);
    setModalOpen(false);
    form.reset();
    setSelectedClientId("");
    setClientInlineOpen(false);
    showToast(
      `Project "${res.data.name}" has been created!`,
      "check_circle",
      "success",
    );
  }

  /**
   * Create a new client from the mini-form inside the create-project modal.
   * On success: prepend to `clients`, auto-select in the project dropdown,
   * close the inline mini-form BUT keep the project modal open so the user
   * can keep filling in the rest of the project fields.
   */
  async function handleCreateClient(form: HTMLFormElement) {
    // The project-create modal also contains a <form>, so submitting this
    // inner form would normally bubble up and ALSO submit the outer one.
    // We read FormData from `form` directly (the inner form ref) and rely
    // on the React onSubmit handler to call preventDefault — but to be
    // safe against native event ordering, we also stop propagation here.
    if (form) {
      const fd = new FormData(form);
      const name = (fd.get("clientName") as string)?.trim();
      const contactEmail = (fd.get("contactEmail") as string)?.trim() ?? "";
      const phone = (fd.get("phone") as string)?.trim() ?? "";
      const notes = (fd.get("notes") as string)?.trim() ?? "";

      if (!name) {
        showToast("Client name is required.", "error", "error");
        return;
      }

      setClientSubmitting(true);
      let res;
      try {
        res = await createClient({ name, contactEmail, phone, notes });
      } catch (err) {
        // Network/exception (e.g. backend down, CORS, offline) — log so the
        // dev can see it in DevTools console.
        // eslint-disable-next-line no-console
        console.error("[createClient] network/exception:", err);
        setClientSubmitting(false);
        showToast(
          `Failed to create client: ${err instanceof Error ? err.message : "Network error"}`,
          "error",
          "error",
        );
        return;
      }
      setClientSubmitting(false);

      if (!res.ok) {
        // eslint-disable-next-line no-console
        console.error("[createClient] backend returned error:", res.error, res);
        const status = res.status ? ` [HTTP ${res.status}]` : "";
        const hint =
          res.status === 401
            ? " — your session may have expired, try logging in again."
            : res.status === 400
              ? " — please double-check the input values."
              : res.status === 500
                ? " — server error, try again in a moment."
                : "";
        showToast(
          `Failed to create client${status}: ${res.error}${hint}`,
          "error",
          "error",
        );
        return;
      }

      setClients((prev) => [res.data, ...prev]);
      form.reset();
      setClientInlineOpen(false);
      // Auto-select newly created client in the project dropdown.
      setSelectedClientId(res.data.id);
      showToast(
        `Client "${res.data.name}" has been created! You can keep filling the project.`,
        "check_circle",
        "success",
      );
    }
  }

  /**
   * Open the "Browse clients" modal. We re-fetch the full list from the
   * backend on every open so it's always up to date (cheap endpoint).
   * The list shows ALL clients; the user can search by name/email/phone.
   * Clicking a row sets `selectedClientId` (the same field the <select>
   * uses) and closes the modal.
   */
  async function openClientBrowser() {
    setClientBrowserOpen(true);
    setClientBrowserSearch("");
    setClientBrowserLoading(true);
    setClientBrowserError(null);
    setClientBrowserList(null);
    const res = await listClients();
    setClientBrowserLoading(false);
    if (res.ok) {
      setClientBrowserList(res.data);
    } else {
      setClientBrowserError(
        res.status === 401
          ? "Your session has expired. Please log in again."
          : (res.error ?? "Failed to load clients."),
      );
    }
  }

  function pickClientFromBrowser(id: string) {
    setSelectedClientId(id);
    setClientBrowserOpen(false);
  }

  const filteredClientBrowser = (clientBrowserList ?? []).filter((c: ClientDto) => {
    const q = clientBrowserSearch.trim().toLowerCase();
    if (!q) return true;
    return (
      (c.name ?? "").toLowerCase().includes(q) ||
      (c.email ?? "").toLowerCase().includes(q) ||
      (c.phone ?? "").toLowerCase().includes(q)
    );
  });

  function handleAiChunking(projectId: string) {
    setChunkingId(projectId);
    window.setTimeout(() => {
      setChunkingId(null);
    showToast(
      "AI finished decomposing tasks into the Deep Work frame!",
      "auto_awesome",
      "primary",
    );
    }, 1200);
  }

  function handleApprovePending(projectId: string) {
    setProjects((prev) =>
      prev.map((p) =>
        p.id === projectId
          ? {
              ...p,
              status: "active",
              badgeKind: "ai",
              badgeTone: "secondary",
              badgeLabel: "AI Orchestrated",
              progressLabel: undefined,
            }
          : p,
      ),
    );
    showToast(
      "Approved and scheduled 18 tasks into Google / Bio Calendar!",
      "event_available",
      "success",
    );
  }

  function handleDeleteProject(projectId: string) {
    const p = projects.find((x) => x.id === projectId);
    setProjects((prev) => prev.filter((x) => x.id !== projectId));
    setOpenMenuId(null);
    showToast(`Project "${p?.name ?? ""}" has been deleted`, "delete", "info");
  }

  // Đóng dropdown khi click ra ngoài.
  useEffect(() => {
    function onClickOutside() {
      setOpenMenuId(null);
    }
    document.addEventListener("click", onClickOutside);
    return () => document.removeEventListener("click", onClickOutside);
  }, []);

  // Phím tắt ⌘K / Ctrl+K focus search.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        document
          .getElementById("proj-search-input")
          ?.focus({ preventScroll: true });
      }
      if (e.key === "Escape") {
        if (clientInlineOpen && !clientSubmitting) {
          setClientInlineOpen(false);
        } else if (modalOpen) {
          setModalOpen(false);
        }
      }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [modalOpen, clientInlineOpen]);

  return (
    <div className="proj">
      {/* Ambient glow blobs */}
      <div className="proj-ambient proj-ambient--left" aria-hidden="true" />
      <div className="proj-ambient proj-ambient--right" aria-hidden="true" />

      <div className="proj-container">
        {/* ================= 1. Header ================= */}
        <header
          className={
            "proj-header" + (headerAnim.mounted ? " proj-header--in" : "")
          }
        >
          <div className="proj-header-text">
            <div className="proj-eyebrow">
              <span className="proj-eyebrow-dot" />
              <span>Multi-Project Operations Workspace</span>
              <span className="proj-eyebrow-sep">/</span>
              <span className="proj-eyebrow-soft">Cognitive Workspace</span>
            </div>
            <h1 className="proj-title">Project Management Workspace</h1>
            <p className="proj-subtitle">
              Centralize your project portfolio. AI automatically analyzes
              goals, generates detailed tasks, chunks them into focused sessions
              and adapts scheduling to your bio-rhythm.
            </p>
          </div>
          <div className="proj-header-actions">
            <button
              type="button"
              className="proj-btn proj-btn--primary"
              onClick={() => setModalOpen(true)}
              id="open-new-project-btn"
            >
              <span className="material-symbols-outlined proj-btn-icon proj-btn-icon--rotate">
                add
              </span>
              <span>New project</span>
            </button>
            <button
              type="button"
              className="proj-btn proj-btn--ghost"
              title="Configure AI Agent"
            >
              <span className="material-symbols-outlined proj-btn-icon">
                tune
              </span>
            </button>
          </div>
        </header>

        {/* ================= 2. Command strip ================= */}
        <div
          className={
            "proj-command" + (headerAnim.mounted ? " proj-command--in" : "")
          }
        >
          <div className="proj-search">
            <span className="material-symbols-outlined proj-search-icon">
              search
            </span>
            <input
              id="proj-search-input"
              type="text"
              className="proj-search-input"
              placeholder="Search by project name, client, tags or goals…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            <kbd className="proj-kbd">⌘K</kbd>
          </div>

          <div className="proj-chips" role="tablist" aria-label="Filter by status">
            {STATUS_FILTERS.map((f) => {
              const active = filter === f.id;
              return (
                <button
                  key={f.id}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  onClick={() => setFilter(f.id)}
                  className={
                    "proj-chip" + (active ? " proj-chip--active" : "")
                  }
                >
                  <span>{f.label}</span>
                  <span className="proj-chip-count">
                    {counts[f.id]}
                  </span>
                </button>
              );
            })}
          </div>

          <div className="proj-view">
            <button
              type="button"
              className={
                "proj-view-btn" + (view === "grid" ? " proj-view-btn--active" : "")
              }
              title="Grid view"
              onClick={() => setView("grid")}
            >
              <span className="material-symbols-outlined">grid_view</span>
            </button>
            <button
              type="button"
              className={
                "proj-view-btn" + (view === "list" ? " proj-view-btn--active" : "")
              }
              title="List view"
              onClick={() => setView("list")}
            >
              <span className="material-symbols-outlined">view_list</span>
            </button>
            <button
              type="button"
              className="proj-view-btn proj-view-btn--bare"
              title="Advanced filters"
            >
              <span className="material-symbols-outlined">filter_list</span>
            </button>
          </div>
        </div>

        {/* ================= 3. KPI Telemetry ================= */}
        <section className="proj-kpi">
          <KpiCard
            label="Active projects"
            value={String(
              projects.filter((p) => p.status === "active").length,
            )}
            unit={`/ ${projects.length} Active`}
            unitTone="secondary"
            icon="account_tree"
            iconTone="secondary"
            progress={
              projects.length === 0
                ? 0
                : Math.round(
                    (projects.filter((p) => p.status === "active").length /
                      projects.length) *
                      100,
                  )
            }
            foot={
              projects.length === 0
                ? "No projects yet"
                : `${projects.filter((p) => p.status === "pending").length} projects awaiting launch`
            }
            mounted={kpiAnim.mounted}
            delayStyle={kpiAnim.getDelay(0)}
          />
          <KpiCard
            label="AI allocation progress"
            value="84%"
            unit="+12% this week"
            unitTone="primary"
            icon="auto_awesome"
            iconTone="primary"
            progress={84}
            foot="Auto-scheduled & task-chunked"
            valueTone="primary"
            mounted={kpiAnim.mounted}
            delayStyle={kpiAnim.getDelay(1)}
          />
          <KpiCard
            label="Projected cognitive load"
            value="1.18x"
            unit="Balanced"
            unitTone="secondary"
            unitAsBadge
            icon="psychology"
            iconTone="tertiary"
            progress={59}
            foot="No bio-rhythm conflicts"
            mounted={kpiAnim.mounted}
            delayStyle={kpiAnim.getDelay(2)}
          />
          <KpiCard
            label="Nearest deadline"
            value="In 3 days"
            icon="timer"
            iconTone="error"
            progress={80}
            progressPulse
            foot="Milestone Backend API (FinTech)"
            footEmphasized
            valueTone="error"
            mounted={kpiAnim.mounted}
            delayStyle={kpiAnim.getDelay(3)}
          />
        </section>

        {/* ================= 4. Project Cards ================= */}
        <section className="proj-section">
          <div className="proj-section-head">
            <div className="proj-section-head-left">
              <span className="proj-section-title">Active Project Portfolio</span>
              <span className="proj-section-pill">
                {projects.length} Workspaces
              </span>
            </div>
            <span className="proj-section-hint">
              Click the 3 dots to manage (Edit / Delete / Archive)
            </span>
          </div>

          <div
            className={
              "proj-grid" +
              (view === "list" ? " proj-grid--list" : "") +
              (cardsAnim.mounted ? " proj-grid--in" : "")
            }
          >
            {filteredProjects.map((p, i) => (
              <ProjectCard
                key={p.id}
                project={p}
                index={i}
                delayStyle={cardsAnim.getDelay(i)}
                mounted={cardsAnim.mounted}
                isMenuOpen={openMenuId === p.id}
                isChunking={chunkingId === p.id}
                onToggleMenu={(e) => {
                  e.stopPropagation();
                  setOpenMenuId((cur) => (cur === p.id ? null : p.id));
                }}
                onAiChunk={() => handleAiChunking(p.id)}
                onApprove={() => handleApprovePending(p.id)}
                onDelete={() => handleDeleteProject(p.id)}
                onOpen={() => navigate(`/projects/${p.id}`)}
              />
            ))}

            {/* Placeholder card (tạo mới) */}
            <button
              type="button"
              className={
                "proj-add" + (cardsAnim.mounted ? " proj-add--in" : "")
              }
              style={cardsAnim.getDelay(filteredProjects.length)}
              onClick={() => setModalOpen(true)}
            >
              <div className="proj-add-icon">
                <span className="material-symbols-outlined">add</span>
              </div>
              <div className="proj-add-text">
                <h4 className="proj-add-title">Create New Project</h4>
                <p className="proj-add-desc">
                  Or import quickly from{" "}
                  <strong>Notion, Trello, GitHub</strong>. Let METANOIA AI
                  analyze and generate an optimal schedule automatically.
                </p>
              </div>
              <div className="proj-add-arrow">
                <span>Start scaffolding</span>
                <span className="material-symbols-outlined">arrow_forward</span>
              </div>
            </button>
          </div>

          {/* Loading / Error / Empty states */}
          {listLoading ? (
            <div className="proj-empty" role="status">
              <span
                className="material-symbols-outlined proj-empty-spin"
                aria-hidden="true"
              >
                progress_activity
              </span>
              <p>Loading project list…</p>
            </div>
          ) : listError ? (
            <div className="proj-empty proj-empty--error" role="alert">
              <span className="material-symbols-outlined" aria-hidden="true">
                error
              </span>
              <p>Failed to load project list: {listError}</p>
              <button
                type="button"
                className="proj-btn proj-btn--ghost"
                onClick={() => {
                  // Re-trigger effect
                  setListLoading(true);
                  setListError(null);
                  (async () => {
                    const r = await filterProjects({});
                    if (r.ok) setProjects(r.data.map(dtoToProject));
                    else setListError(r.error);
                    setListLoading(false);
                  })();
                }}
              >
                <span className="material-symbols-outlined">refresh</span>
                Retry
              </button>
            </div>
          ) : filteredProjects.length === 0 ? (
            <div className="proj-empty">
              <span className="material-symbols-outlined">search_off</span>
              <p>
                {projects.length === 0
                  ? "You don't have any projects yet. Click the button above to create your first one."
                  : "No projects match the current filter."}
              </p>
            </div>
          ) : null}
        </section>

        {/* ================= 5. AI Pipeline Preview ================= */}
        <section
          className={
            "proj-pipeline" +
            (pipelineAnim.mounted ? " proj-pipeline--in" : "")
          }
        >
          <div className="proj-pipeline-head">
            <div className="proj-pipeline-head-text">
              <div className="proj-pipeline-eyebrow">
                <span className="material-symbols-outlined">schema</span>
                <span>AI Cognitive Pipeline</span>
              </div>
              <h2 className="proj-pipeline-title">
                From Raw Goals to Hour-Optimized Schedules
              </h2>
              <p className="proj-pipeline-desc">
                How the METANOIA algorithm protects your cognitive energy: no
                more overwhelm when facing massive macro epics.
              </p>
            </div>
            <button
              type="button"
              className="proj-btn proj-btn--ghost"
              onClick={() => {
                showToast(
                  "Launching AI decomposition demo in Sandbox…",
                  "smart_toy",
                  "primary",
                );
                window.setTimeout(() => setModalOpen(true), 400);
              }}
            >
              <span className="material-symbols-outlined proj-btn-icon proj-btn-icon--primary">
                smart_toy
              </span>
              <span>Try sample decomposition with AI Copilot</span>
            </button>
          </div>

          <div className="proj-steps">
            <PipelineStep
              step="STEP 01"
              icon="flag"
              iconTone="primary"
              title="Initialize Goals"
              desc="Enter project name, core objectives, deadline and estimated time budget (Scope)."
              delayStyle={pipelineAnim.getDelay(0)}
            />
            <PipelineStep
              step="STEP 02"
              stepTone="primary"
              icon="call_split"
              iconTone="secondary"
              title="AI Auto-Decomposition"
              desc="Breaks down macro goals into 45–90 min sub-tasks, auto-tagged with Eisenhower matrix & focus depth."
              delayStyle={pipelineAnim.getDelay(1)}
            />
            <PipelineStep
              step="STEP 03"
              icon="calendar_clock"
              iconTone="tertiary"
              title="Adaptive Schedule Sync"
              desc="Aligns with your personal bio-rhythm, auto-reserving recovery buffer time after heavy tasks."
              delayStyle={pipelineAnim.getDelay(2)}
            />
          </div>
        </section>
      </div>

      {/* ================= Modal tạo dự án ================= */}
      {modalOpen && (
        <div
          className="proj-modal-backdrop"
          onClick={(e) => {
            if (e.target === e.currentTarget) setModalOpen(false);
          }}
        >
          <div className="proj-modal" role="dialog" aria-modal="true">
            <div className="proj-modal-head">
              <div>
                <div className="proj-modal-eyebrow">
                  <span className="material-symbols-outlined">add_circle</span>
                  <span>Initialize new workspace</span>
                </div>
                <h2 className="proj-modal-title">Create Project &amp; Activate AI</h2>
              </div>
              <button
                type="button"
                className="proj-modal-close"
                onClick={() => setModalOpen(false)}
                aria-label="Close"
              >
                <span className="material-symbols-outlined">close</span>
              </button>
            </div>

            <form
              ref={projectFormRef}
              className="proj-form"
              onSubmit={handleCreateProject}
            >
              <div className="proj-field">
                <label className="proj-label" htmlFor="proj-f-name">
                  Project name *
                </label>
                <input
                  id="proj-f-name"
                  name="name"
                  type="text"
                  className="proj-input"
                  placeholder="e.g. AI Copilot Workflow, Redesign B2B Portal…"
                  required
                  autoFocus
                />
              </div>

              <div className="proj-field">
                <div className="proj-label-row">
                  <label className="proj-label" htmlFor="proj-f-client">
                    Client
                    <span className="proj-label-optional"> (optional)</span>
                  </label>
                  {!clientInlineOpen && (
                    <div className="proj-label-row-actions">
                      <button
                        type="button"
                        className="proj-link-btn"
                        onClick={openClientBrowser}
                        title="Browse all clients"
                      >
                        <span
                          className="material-symbols-outlined proj-link-btn-icon"
                          aria-hidden="true"
                        >
                          list
                        </span>
                        Browse
                      </button>
                      <button
                        type="button"
                        className="proj-link-btn"
                        onClick={() => setClientInlineOpen(true)}
                      >
                        <span
                          className="material-symbols-outlined proj-link-btn-icon"
                          aria-hidden="true"
                        >
                          add
                        </span>
                        New client
                      </button>
                    </div>
                  )}
                </div>

                <select
                  id="proj-f-client"
                  name="clientId"
                  className="proj-input"
                  value={selectedClientId}
                  onChange={(e) => setSelectedClientId(e.target.value)}
                  disabled={clientInlineOpen}
                >
                  <option value="">— None / Internal —</option>
                  {clients.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                      {c.company ? ` (${c.company})` : ""}
                    </option>
                  ))}
                </select>

                {clients.length === 0 && !clientInlineOpen && (
                  <p className="proj-field-hint">
                    No clients yet. Click{" "}
                    <strong>New client</strong> above to add one quickly.
                  </p>
                )}

                {/* Inline expand — create-client form appears right under the dropdown */}
                {clientInlineOpen &&
                  createPortal(
                    <div
                      className="proj-inline-create-overlay"
                      onClick={() => {
                        if (!clientSubmitting) setClientInlineOpen(false);
                      }}
                    >
                      <div
                        className="proj-inline-create"
                        role="region"
                        aria-label="Create new client"
                        onClick={(e) => e.stopPropagation()}
                      >
                      <div className="proj-inline-create-head">
                        <span className="material-symbols-outlined proj-inline-create-icon">
                          person_add
                        </span>
                        <div>
                          <p className="proj-inline-create-title">
                            New client
                          </p>
                          <p className="proj-inline-create-desc">
                            Fill quickly — will be auto-selected after
                            creation.
                          </p>
                        </div>
                        <button
                          type="button"
                          className="proj-inline-create-close"
                          onClick={() => setClientInlineOpen(false)}
                          aria-label="Close create-client form"
                          disabled={clientSubmitting}
                        >
                          <span className="material-symbols-outlined">
                            close
                          </span>
                        </button>
                      </div>

                      <form
                        className="proj-inline-create-form"
                        ref={(el) => {
                          clientInlineFormRef.current = el;
                        }}
                        onSubmit={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          handleCreateClient(e.currentTarget);
                        }}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" && !e.shiftKey) {
                            const target = e.target as HTMLElement;
                            if (target.tagName === "TEXTAREA") return;
                            e.preventDefault();
                            if (clientInlineFormRef.current) {
                              clientInlineFormRef.current.requestSubmit();
                            }
                          }
                        }}
                      >
                        <div className="proj-inline-row proj-inline-row--name">
                          <label
                            className="proj-label"
                            htmlFor="client-f-name"
                          >
                            Client name *
                          </label>
                          <input
                            id="client-f-name"
                            name="clientName"
                            type="text"
                            className="proj-input"
                            placeholder="e.g. Techcombank Bank…"
                            required
                            autoFocus
                          />
                        </div>

                        <div className="proj-inline-row">
                          <div className="proj-inline-half">
                            <label
                              className="proj-label"
                              htmlFor="client-f-email"
                            >
                              Contact email
                            </label>
                            <input
                              id="client-f-email"
                              name="contactEmail"
                              type="email"
                              className="proj-input"
                              placeholder="contact@example.com"
                            />
                          </div>
                          <div className="proj-inline-half">
                            <label
                              className="proj-label"
                              htmlFor="client-f-phone"
                            >
                              Phone
                            </label>
                            <input
                              id="client-f-phone"
                              name="phone"
                              type="tel"
                              className="proj-input"
                              placeholder="0901 234 567"
                            />
                          </div>
                        </div>

                        <div className="proj-inline-row">
                          <label
                            className="proj-label"
                            htmlFor="client-f-notes"
                          >
                            Notes
                          </label>
                          <textarea
                            id="client-f-notes"
                            name="notes"
                            rows={2}
                            className="proj-input proj-input--textarea"
                            placeholder="Short description…"
                          />
                        </div>

                        <div className="proj-inline-actions">
                          <button
                            type="button"
                            className="proj-btn proj-btn--text"
                            onClick={() => setClientInlineOpen(false)}
                            disabled={clientSubmitting}
                          >
                            Cancel
                          </button>
                          <button
                            type="submit"
                            className="proj-btn proj-btn--primary proj-btn--sm"
                            disabled={clientSubmitting}
                          >
                            <span
                              className={
                                "material-symbols-outlined proj-btn-icon" +
                                (clientSubmitting
                                  ? " proj-btn-icon--spin"
                                  : "")
                              }
                            >
                              {clientSubmitting
                                ? "progress_activity"
                                : "check"}
                            </span>
                            <span>
                              {clientSubmitting
                                ? "Creating…"
                                : "Create & select"}
                            </span>
                          </button>
                        </div>
                      </form>
                      </div>
                    </div>,
                    document.body,
                  )}
              </div>

              <div className="proj-field-row">
                <div className="proj-field">
                  <label className="proj-label" htmlFor="proj-f-start">
                    Start date *
                  </label>
                  <input
                    id="proj-f-start"
                    name="startDate"
                    type="date"
                    className="proj-input"
                    required
                  />
                </div>
                <div className="proj-field">
                  <label className="proj-label" htmlFor="proj-f-deadline">
                    Deadline *
                  </label>
                  <input
                    id="proj-f-deadline"
                    name="deadline"
                    type="date"
                    className="proj-input"
                    required
                  />
                </div>
              </div>

              <div className="proj-field">
                <label className="proj-label" htmlFor="proj-f-desc">
                  Core scope &amp; objectives
                </label>
                <textarea
                  id="proj-f-desc"
                  name="description"
                  rows={3}
                  className="proj-input proj-input--textarea"
                  placeholder="Enter your macro goal. AI will use this to auto-decompose into 45-90 min Deep Work sessions…"
                />
              </div>

              <div className="proj-form-actions">
                <button
                  type="button"
                  className="proj-btn proj-btn--text"
                  onClick={() => setModalOpen(false)}
                >
                  Cancel
                </button>
                <button type="submit" className="proj-btn proj-btn--primary">
                  <span className="material-symbols-outlined proj-btn-icon">
                    add_task
                  </span>
                  <span>Create project</span>
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ================= Client browser modal ================= */}
      {clientBrowserOpen && (
        <div
          className="proj-modal-overlay"
          onClick={() => {
            if (!clientBrowserLoading) setClientBrowserOpen(false);
          }}
        >
          <div
            className="proj-modal proj-modal--client-browser"
            role="dialog"
            aria-modal="true"
            aria-labelledby="client-browser-title"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="proj-modal-head">
              <div>
                <h3 id="client-browser-title" className="proj-modal-title">
                  Choose a client
                </h3>
                <p className="proj-modal-sub">
                  Pick from all clients in your workspace. The selected
                  client will be linked to this project.
                </p>
              </div>
              <button
                type="button"
                className="proj-modal-close"
                onClick={() => setClientBrowserOpen(false)}
                aria-label="Close"
                disabled={clientBrowserLoading}
              >
                <span className="material-symbols-outlined">close</span>
              </button>
            </div>

            <div className="proj-browser-search">
              <span
                className="material-symbols-outlined proj-browser-search-icon"
                aria-hidden="true"
              >
                search
              </span>
              <input
                type="text"
                className="proj-input proj-browser-search-input"
                placeholder="Search by name, email or phone…"
                value={clientBrowserSearch}
                onChange={(e) => setClientBrowserSearch(e.target.value)}
                autoFocus
                disabled={clientBrowserLoading}
              />
              {clientBrowserSearch && (
                <button
                  type="button"
                  className="proj-browser-search-clear"
                  onClick={() => setClientBrowserSearch("")}
                  aria-label="Clear search"
                >
                  <span className="material-symbols-outlined">close</span>
                </button>
              )}
            </div>

            <div className="proj-browser-body">
              {clientBrowserLoading && (
                <div className="proj-browser-state">
                  <span className="material-symbols-outlined proj-btn-icon proj-btn-icon--spin">
                    progress_activity
                  </span>
                  <p>Loading clients…</p>
                </div>
              )}

              {!clientBrowserLoading && clientBrowserError && (
                <div className="proj-browser-state proj-browser-state--error">
                  <span className="material-symbols-outlined">error</span>
                  <p>{clientBrowserError}</p>
                  <button
                    type="button"
                    className="proj-btn proj-btn--text proj-btn--sm"
                    onClick={openClientBrowser}
                  >
                    Retry
                  </button>
                </div>
              )}

              {!clientBrowserLoading &&
                !clientBrowserError &&
                clientBrowserList && (
                  <>
                    {filteredClientBrowser.length === 0 ? (
                      <div className="proj-browser-state">
                        <span className="material-symbols-outlined">
                          person_off
                        </span>
                        <p>
                          {clientBrowserList.length === 0
                            ? "No clients yet. Create one first."
                            : "No clients match your search."}
                        </p>
                      </div>
                    ) : (
                      <ul className="proj-browser-list">
                        {filteredClientBrowser.map((c: ClientDto) => {
                          const isSelected = selectedClientId === c.id;
                          return (
                            <li
                              key={c.id}
                              className={
                                "proj-browser-item" +
                                (isSelected
                                  ? " proj-browser-item--selected"
                                  : "")
                              }
                            >
                              <button
                                type="button"
                                className="proj-browser-item-btn"
                                onClick={() => pickClientFromBrowser(c.id)}
                              >
                                <span className="proj-browser-item-avatar">
                                  {(c.name ?? "?").trim().charAt(0).toUpperCase()}
                                </span>
                                <span className="proj-browser-item-body">
                                  <span className="proj-browser-item-name">
                                    {c.name}
                                    {isSelected && (
                                      <span
                                        className="material-symbols-outlined proj-browser-item-check"
                                        aria-label="Currently selected"
                                      >
                                        check_circle
                                      </span>
                                    )}
                                  </span>
                                  <span className="proj-browser-item-meta">
                                    {c.email || c.phone
                                      ? [c.email, c.phone]
                                          .filter(Boolean)
                                          .join(" • ")
                                      : "No contact info"}
                                  </span>
                                </span>
                              </button>
                            </li>
                          );
                        })}
                      </ul>
                    )}
                    <div className="proj-browser-footer">
                      <span>
                        {filteredClientBrowser.length} of{" "}
                        {clientBrowserList.length} client
                        {clientBrowserList.length === 1 ? "" : "s"}
                      </span>
                    </div>
                  </>
                )}
            </div>
          </div>
        </div>
      )}

      {/* ================= Toast ================= */}
      <div
        className={"proj-toast" + (toast.visible ? " proj-toast--show" : "")}
        role="status"
        aria-live="polite"
      >
        <span
          className={
            "material-symbols-outlined proj-toast-icon proj-toast-icon--" +
            toast.tone
          }
        >
          {toast.icon}
        </span>
        <span>{toast.text}</span>
      </div>
    </div>
  );
}

/* ===========================================================
 * Sub-components
 * =========================================================== */

interface KpiCardProps {
  label: string;
  value: string;
  unit?: string;
  unitTone?: "secondary" | "primary";
  unitAsBadge?: boolean;
  icon: string;
  iconTone: "secondary" | "primary" | "tertiary" | "error";
  valueTone?: "primary" | "error";
  progress: number;
  progressPulse?: boolean;
  foot: string;
  footEmphasized?: boolean;
  mounted: boolean;
  delayStyle: { animationDelay: string };
}

function KpiCard(p: KpiCardProps) {
  return (
    <div
      className={"proj-kpi-card" + (p.mounted ? " proj-kpi-card--in" : "")}
      style={p.delayStyle}
    >
      <div className="proj-kpi-head">
        <span className="proj-kpi-label">{p.label}</span>
        <div className={`proj-kpi-icon proj-kpi-icon--${p.iconTone}`}>
          <span className="material-symbols-outlined">{p.icon}</span>
        </div>
      </div>
      <div>
        <div className="proj-kpi-value-row">
          <span
            className={
              "proj-kpi-value" +
              (p.valueTone ? ` proj-kpi-value--${p.valueTone}` : "")
            }
          >
            {p.value}
          </span>
          {p.unit &&
            (p.unitAsBadge ? (
              <span className={`proj-kpi-badge proj-kpi-badge--${p.unitTone}`}>
                {p.unit}
              </span>
            ) : (
              <span className={`proj-kpi-unit proj-kpi-unit--${p.unitTone}`}>
                {p.unit}
              </span>
            ))}
        </div>
        <p
          className={
            "proj-kpi-foot" +
            (p.footEmphasized ? " proj-kpi-foot--em" : "")
          }
        >
          {p.foot}
        </p>
      </div>
      <div className="proj-kpi-bar">
        <div
          className={
            "proj-kpi-bar-fill" +
            (p.progressPulse ? " proj-kpi-bar-fill--pulse" : "")
          }
          style={{ width: `${p.progress}%` }}
        />
      </div>
    </div>
  );
}

interface ProjectCardProps {
  project: Project;
  index: number;
  mounted: boolean;
  delayStyle: { animationDelay: string };
  isMenuOpen: boolean;
  isChunking: boolean;
  onToggleMenu: (e: React.MouseEvent) => void;
  onAiChunk: () => void;
  onApprove: () => void;
  onDelete: () => void;
  onOpen: () => void;
}

function ProjectCard(p: ProjectCardProps) {
  const { project: prj } = p;
  const isPending = prj.status === "pending";

  return (
    <article
      className={
        "proj-card" +
        (p.mounted ? " proj-card--in" : "") +
        (isPending ? " proj-card--pending" : "")
      }
      style={p.delayStyle}
      data-status={prj.status}
      role="button"
      tabIndex={0}
      onClick={p.onOpen}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          p.onOpen();
        }
      }}
    >
      <div className="proj-card-top">
        <div className="proj-card-badges">
          <span
            className={`proj-badge proj-badge--${prj.badgeTone} ${
              prj.badgeKind === "allocating" || prj.badgeKind === "pending"
                ? "proj-badge--pulse"
                : ""
            }`}
          >
            <span
              className={`proj-badge-dot proj-badge-dot--${prj.badgeTone}`}
            />
            {prj.badgeLabel}
          </span>
          <span className="proj-client-tag">{prj.clientTag}</span>
        </div>
        <div className="proj-menu">
          <button
            type="button"
            className="proj-menu-trigger"
            aria-label="Project options"
            onClick={p.onToggleMenu}
          >
            <span className="material-symbols-outlined">more_vert</span>
          </button>
          {p.isMenuOpen && (
            <div className="proj-menu-list" role="menu">
              <button type="button" className="proj-menu-item">
                <span className="material-symbols-outlined">edit</span>
                Edit project
              </button>
              <button type="button" className="proj-menu-item">
                <span className="material-symbols-outlined proj-menu-item-icon--primary">
                  speed
                </span>
                Set cognitive load
              </button>
              <button type="button" className="proj-menu-item">
                <span className="material-symbols-outlined">archive</span>
                Archive project
              </button>
              <div className="proj-menu-sep" />
              <button
                type="button"
                className="proj-menu-item proj-menu-item--danger"
                onClick={(e) => {
                  e.stopPropagation();
                  p.onDelete();
                }}
              >
                <span className="material-symbols-outlined">delete</span>
                Delete project
              </button>
            </div>
          )}
        </div>
      </div>

      <div className="proj-card-body">
        <h3 className="proj-card-title">{prj.name}</h3>
        <div className="proj-card-meta">
          <span className="proj-card-meta-item">
            <span className="material-symbols-outlined proj-card-meta-icon">
              calendar_today
            </span>
            Due: {prj.deadline}
          </span>
          <span className="proj-card-meta-sep">•</span>
          <span
            className={`proj-card-deadline proj-card-deadline--${
              prj.daysLeft <= 7 ? "error" : "secondary"
            }`}
          >
            {isPending ? "Just launched" : `${prj.daysLeft} days left`}
          </span>
        </div>
      </div>

      <div className="proj-card-progress">
        <div className="proj-card-progress-head">
          <span className="proj-card-progress-label">
            {prj.progressLabel ?? "Work progress"}
          </span>
          {prj.progressLabel ? (
            <span className="proj-card-progress-meta proj-card-progress-meta--pending">
              {prj.totalTasks} suggested tasks ready
            </span>
          ) : (
            <span className="proj-card-progress-meta">
              {prj.progress}%{" "}
              <span className="proj-card-progress-meta-soft">
                ({prj.doneTasks}/{prj.totalTasks} tasks)
              </span>
            </span>
          )}
        </div>
        <div className="proj-card-progress-bar">
          <div
            className={`proj-card-progress-fill proj-card-progress-fill--${prj.badgeTone}`}
            style={{ width: `${prj.progress}%` }}
          />
        </div>
      </div>

      <div className={`proj-insight proj-insight--${prj.insightTone}`}>
        <span
          className={`material-symbols-outlined proj-insight-icon proj-insight-icon--${prj.insightTone}`}
        >
          {prj.insightIcon}
        </span>
        <p
          className="proj-insight-text"
          dangerouslySetInnerHTML={{ __html: prj.insight }}
        />
      </div>

      <div className="proj-card-actions">
        {isPending ? (
          <>
            <button
              type="button"
              className="proj-action proj-action--primary proj-action--flex"
              onClick={(e) => {
                e.stopPropagation();
                p.onApprove();
              }}
            >
              <span className="material-symbols-outlined proj-action-icon">
                check_circle
              </span>
              <span>{prj.primaryAction.label}</span>
            </button>
            <button
              type="button"
              className="proj-action proj-action--plain"
            >
              <span className="material-symbols-outlined proj-action-icon">
                {prj.secondaryAction.icon}
              </span>
              <span>{prj.secondaryAction.label}</span>
            </button>
          </>
        ) : (
          <>
            {/* 2-direction split: Manual (planning) vs AI (execution) */}
            <Link
              to={`/projects/${prj.id}/planning`}
              className="proj-action proj-action--plain proj-action--flex"
              title="Manually decompose project into tasks and schedule them on calendar"
            >
              <span className="material-symbols-outlined proj-action-icon">
                checklist
              </span>
              <span>Manual decompose</span>
            </Link>
            <Link
              to={`/projects/${prj.id}/execution`}
              className="proj-action proj-action--ai"
              title="AI auto-decompose + schedule (coming soon)"
              onClick={(e) => {
                e.preventDefault();
                p.onAiChunk();
              }}
            >
              <span
                className={
                  "material-symbols-outlined" +
                  (p.isChunking ? " proj-action-icon--spin" : " proj-action-icon")
                }
              >
                {p.isChunking ? "refresh" : "auto_awesome"}
              </span>
              <span>{p.isChunking ? "Chunking…" : "AI decompose"}</span>
            </Link>
          </>
        )}
      </div>
    </article>
  );
}

function PipelineStep({
  step,
  stepTone = "muted",
  icon,
  iconTone,
  title,
  desc,
  delayStyle,
}: {
  step: string;
  stepTone?: "muted" | "primary";
  icon: string;
  iconTone: "primary" | "secondary" | "tertiary";
  title: string;
  desc: string;
  delayStyle: { animationDelay: string };
}) {
  return (
    <div className="proj-step" style={delayStyle}>
      <div className="proj-step-head">
        <span className={`proj-step-tag proj-step-tag--${stepTone}`}>{step}</span>
        <span className={`material-symbols-outlined proj-step-icon proj-step-icon--${iconTone}`}>
          {icon}
        </span>
      </div>
      <h3 className="proj-step-title">{title}</h3>
      <p className="proj-step-desc">{desc}</p>
    </div>
  );
}
