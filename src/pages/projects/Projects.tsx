import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type FormEvent,
} from "react";
import { createPortal } from "react-dom";
import { Link, useNavigate } from "react-router-dom";
import { useStaggeredMount } from "../../hooks/useStaggeredMount";
import {
  createClient,
  createProject,
  filterProjects,
  getProjectProgress,
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

/** Rút gọn chuỗi dài về 1 dòng, thêm "…" nếu bị cắt. */
function truncate(s: string, max = 120): string {
  const t = s.trim();
  if (t.length <= max) return t;
  return t.slice(0, max).trimEnd() + "…";
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
    // Progress thật lấy từ GET /api/projects/{id}/progress (xem loadProgressFor).
    // `/api/projects/filter` không trả field progress, nên khởi tạo 0 và để
    // request song song điền vào — tránh hiển thị số giả (trước đây hardcode 35).
    progress: 0,
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
    insightIcon: "description",
    insightTone: "primary",
    insight: d.description ? truncate(d.description) : "No description",
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

/** Icon cho từng trạng thái ở rail trái — Material Symbols. */
const STATUS_ICONS: Record<"all" | ProjectStatus, string> = {
  all: "apps",
  active: "bolt",
  pending: "hourglass_top",
  completed: "task_alt",
};

export function ProjectsPage() {
  const navigate = useNavigate();
  const [projects, setProjects] = useState<Project[]>([]);
  const [clients, setClients] = useState<ClientDto[]>([]);
  const [listLoading, setListLoading] = useState(true);
  const [listError, setListError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<"all" | ProjectStatus>("all");
  /** Lọc theo client ở rail trái — "" = tất cả client. */
  const [clientFilter, setClientFilter] = useState<string>("");
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
        // Danh sách dự án không kèm progress → gọi /progress song song.
        // Không block UI: card hiện ngay, số liệu cập nhật khi về.
        void loadProgressFor(projRes.data.map((p) => p.id), () => cancelled);
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

  /**
   * Lấy progress thật cho từng project qua GET /api/projects/{id}/progress.
   *
   * `/api/projects/filter` KHÔNG trả field progress nào, nên phải gọi N+1.
   * Chạy song song (Promise.all) để không cộng dồn latency.
   * - `isCancelled` để tránh setState sau khi unmount.
   * - Project nào lỗi thì giữ nguyên giá trị hiện tại (không reset về 0).
   */
  async function loadProgressFor(
    projectIds: string[],
    isCancelled: () => boolean = () => false,
  ) {
    if (projectIds.length === 0) return;

    const results = await Promise.all(
      projectIds.map(async (id) => {
        const res = await getProjectProgress(id);
        return { id, res };
      }),
    );
    if (isCancelled()) return;

    const byId = new Map<
      string,
      Extract<Awaited<ReturnType<typeof getProjectProgress>>, { ok: true }>["data"]
    >();
    for (const { id, res } of results) {
      if (res.ok) byId.set(id, res.data);
    }
    if (byId.size === 0) return;

    setProjects((prev) =>
      prev.map((p) => {
        const prog = byId.get(p.id);
        if (!prog) return p;
        // BE khai báo progressPercent là number nhưng vẫn phòng null/undefined
        // → Math.round(null) === 0, còn undefined sẽ ra NaN và làm hỏng
        // `width: NaN%` của progress bar.
        const rawPercent = Number(prog.progressPercent);
        const safePercent = Number.isFinite(rawPercent) ? rawPercent : 0;
        return {
          ...p,
          progress: Math.max(0, Math.min(100, Math.round(safePercent))),
          doneTasks: prog.completedTasks ?? 0,
          totalTasks: prog.totalTasks ?? 0,
        };
      }),
    );
  }

  /** Đếm status để hiển thị "(N)" cạnh filter chip. */
  const counts = useMemo(() => {
    return {
      all: projects.length,
      active: projects.filter((p) => p.status === "active").length,
      pending: projects.filter((p) => p.status === "pending").length,
      completed: projects.filter((p) => p.status === "completed").length,
    };
  }, [projects]);

  /** Trung bình tiến độ portfolio — dùng cho meter ở rail trái. */
  const avgProgress = useMemo(() => {
    if (projects.length === 0) return 0;
    const sum = projects.reduce((acc, p) => acc + (p.progress || 0), 0);
    return Math.round(sum / projects.length);
  }, [projects]);

  /** Tổng task đã xong / tổng task — dùng cho KPI "Tasks done". */
  const taskStats = useMemo(() => {
    let done = 0;
    let total = 0;
    for (const p of projects) {
      done += p.doneTasks || 0;
      total += p.totalTasks || 0;
    }
    return {
      done,
      total,
      pct: total === 0 ? 0 : Math.round((done / total) * 100),
    };
  }, [projects]);

  /** Áp dụng search + filter, giữ placeholder card ở cuối. */
  const filteredProjects = useMemo(() => {
    const q = search.trim().toLowerCase();
    return projects.filter((p) => {
      if (filter !== "all" && p.status !== filter) return false;
      if (clientFilter && p.clientId !== clientFilter) return false;
      if (!q) return true;
      return (
        p.name.toLowerCase().includes(q) ||
        p.client.toLowerCase().includes(q) ||
        p.clientTag.toLowerCase().includes(q)
      );
    });
  }, [projects, search, filter, clientFilter]);

  /**
   * Data cho rail trái.
   * - `clientRows`: gộp client từ API + client xuất hiện trong project (đề phòng
   *   client bị xoá khỏi danh mục nhưng project vẫn tham chiếu tới), kèm số đếm.
   * - `deadlineRows`: tối đa 4 project có deadline gần nhất, bỏ project đã xong.
   */
  const clientRows = useMemo(() => {
    const map = new Map<string, { id: string; name: string; count: number }>();
    for (const c of clients) {
      map.set(c.id, { id: c.id, name: c.name, count: 0 });
    }
    for (const p of projects) {
      if (!p.clientId) continue;
      const existing = map.get(p.clientId);
      if (existing) existing.count += 1;
      else
        map.set(p.clientId, {
          id: p.clientId,
          name: p.client || "Unknown client",
          count: 1,
        });
    }
    return [...map.values()].sort((a, b) => {
      if (b.count !== a.count) return b.count - a.count;
      return a.name.localeCompare(b.name);
    });
  }, [clients, projects]);

  const deadlineRows = useMemo(() => {
    return projects
      .filter((p) => p.status !== "completed" && p.deadline !== "Not set")
      .slice()
      .sort((a, b) => a.daysLeft - b.daysLeft)
      .slice(0, 4);
  }, [projects]);

  /** Project có deadline gần nhất (bỏ project đã hoàn thành) — cho KPI. */
  const nearestDeadline = deadlineRows[0] ?? null;

  /** Có filter nào đang bật không — dùng để hiện nút "Clear". */
  const hasActiveFilter = filter !== "all" || clientFilter !== "" || search !== "";

  function clearAllFilters() {
    setFilter("all");
    setClientFilter("");
    setSearch("");
  }

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
    // Project mới tạo chưa có task → progress 0, nhưng vẫn hỏi BE cho chắc.
    void loadProgressFor([res.data.id]);
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
      (c.contactEmail ?? "").toLowerCase().includes(q) ||
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
      <div className="proj-container">
        {/* ================= 1. Header (span toàn bộ chiều ngang) ================= */}
        <header
          className={
            "proj-header" + (headerAnim.mounted ? " proj-header--in" : "")
          }
        >
          <div className="proj-header-text">
            <h1 className="proj-eyebrow">
              <span className="proj-eyebrow-dot" aria-hidden="true" />
              <span>Project Workspace</span>
            </h1>
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
              className="proj-btn proj-btn--ghost proj-btn--with-label"
              onClick={() => navigate("/clients")}
              title="Manage clients"
            >
              <span className="material-symbols-outlined proj-btn-icon">
                group
              </span>
              <span>Clients</span>
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

        {/* ================= Rail trái: portfolio navigator ================= */}
        <aside
          className={
            "proj-rail" + (headerAnim.mounted ? " proj-rail--in" : "")
          }
          aria-label="Portfolio filters"
        >
          {/* --- 1. Hero: ring progress + status band --- */}
          <div className="proj-rail-hero">
            <div className="proj-rail-hero-head">
              <span className="proj-rail-live">
                <span className="proj-rail-live-dot" aria-hidden="true" />
                <span>AI Ready</span>
              </span>
              <span className="proj-rail-hero-count">
                {counts.all} total
              </span>
            </div>

            <div className="proj-rail-ring-row">
              <div
                className="proj-rail-ring"
                style={
                  { "--ring-pct": `${avgProgress}%` } as CSSProperties
                }
                role="img"
                aria-label={`${avgProgress}% average progress across ${counts.all} projects`}
              >
                <div className="proj-rail-ring-inner">
                  <span className="proj-rail-ring-value">{avgProgress}</span>
                  <span className="proj-rail-ring-unit">%</span>
                </div>
              </div>
              <div className="proj-rail-ring-meta">
                <span className="proj-rail-ring-title">Portfolio</span>
                <span className="proj-rail-ring-sub">
                  {avgProgress === 0
                    ? "No progress logged yet"
                    : avgProgress >= 75
                      ? "On track"
                      : avgProgress >= 40
                        ? "Steady pace"
                        : "Needs attention"}
                </span>
                <span className="proj-rail-ring-tasks">
                  {taskStats.done}/{taskStats.total} tasks
                </span>
              </div>
            </div>

            {/* Segmented distribution — thay cho 3 con số rời rạc */}
            <div
              className="proj-rail-segments"
              aria-hidden="true"
              title={`${counts.active} active · ${counts.pending} pending · ${counts.completed} completed`}
            >
              {counts.active > 0 && (
                <span
                  className="proj-rail-seg proj-rail-seg--active"
                  style={{ flexGrow: counts.active }}
                />
              )}
              {counts.pending > 0 && (
                <span
                  className="proj-rail-seg proj-rail-seg--pending"
                  style={{ flexGrow: counts.pending }}
                />
              )}
              {counts.completed > 0 && (
                <span
                  className="proj-rail-seg proj-rail-seg--done"
                  style={{ flexGrow: counts.completed }}
                />
              )}
            </div>
          </div>

          <span className="proj-rail-divider" aria-hidden="true" />

          {/* --- 2. Status --- */}
          <nav className="proj-rail-block" aria-label="Filter by status">
            <span className="proj-rail-label">Status</span>
            <ul className="proj-rail-list">
              {STATUS_FILTERS.map((f) => {
                const active = filter === f.id;
                return (
                  <li key={f.id}>
                    <button
                      type="button"
                      className={
                        "proj-rail-item" + (active ? " proj-rail-item--active" : "")
                      }
                      aria-current={active ? "true" : undefined}
                      onClick={() => setFilter(f.id)}
                    >
                      <span
                        className={
                          "material-symbols-outlined proj-rail-item-icon" +
                          (active ? " proj-rail-item-icon--active" : "")
                        }
                        aria-hidden="true"
                      >
                        {STATUS_ICONS[f.id]}
                      </span>
                      <span className="proj-rail-item-label">{f.label}</span>
                      <span className="proj-rail-item-count">
                        {counts[f.id]}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </nav>

          <span className="proj-rail-divider" aria-hidden="true" />

          {/* --- 3. Clients --- */}
          {clientRows.length > 0 && (
            <nav className="proj-rail-block" aria-label="Filter by client">
              <span className="proj-rail-label">Clients</span>
              <ul className="proj-rail-list">
                {clientRows.slice(0, 6).map((c) => {
                  const active = clientFilter === c.id;
                  return (
                    <li key={c.id}>
                      <button
                        type="button"
                        className={
                          "proj-rail-item" +
                          (active ? " proj-rail-item--active" : "")
                        }
                        aria-current={active ? "true" : undefined}
                        onClick={() => setClientFilter(active ? "" : c.id)}
                        title={c.name}
                      >
                        <span
                          className={
                            "proj-rail-avatar" +
                            (active ? " proj-rail-avatar--active" : "")
                          }
                          aria-hidden="true"
                        >
                          {c.name.trim().charAt(0).toUpperCase() || "?"}
                        </span>
                        <span className="proj-rail-item-label">{c.name}</span>
                        <span className="proj-rail-item-count">{c.count}</span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </nav>
          )}

          <span className="proj-rail-divider" aria-hidden="true" />

          {/* --- 4. Deadlines --- */}
          {deadlineRows.length > 0 && (
            <div className="proj-rail-block">
              <span className="proj-rail-label">Deadlines</span>
              <ul className="proj-rail-list proj-rail-list--deadlines">
                {deadlineRows.map((p) => {
                  const overdue = p.daysLeft < 0;
                  const soon = !overdue && p.daysLeft <= 3;
                  const tone = overdue ? "overdue" : soon ? "soon" : "calm";
                  return (
                    <li key={p.id}>
                      <button
                        type="button"
                        className="proj-rail-deadline"
                        onClick={() => navigate(`/projects/${p.id}`)}
                        title={p.name}
                      >
                        <span
                          className={
                            "proj-rail-deadline-bar proj-rail-deadline-bar--" +
                            tone
                          }
                          aria-hidden="true"
                        />
                        <span className="proj-rail-deadline-body">
                          <span className="proj-rail-deadline-name">
                            {p.name}
                          </span>
                          <span
                            className={
                              "proj-rail-deadline-days" +
                              (overdue
                                ? " proj-rail-deadline-days--overdue"
                                : soon
                                  ? " proj-rail-deadline-days--soon"
                                  : "")
                            }
                          >
                            {overdue
                              ? `${Math.abs(p.daysLeft)}d overdue`
                              : p.daysLeft === 0
                                ? "Due today"
                                : `in ${p.daysLeft}d`}
                          </span>
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>
          )}

          {/* --- 5. Footer: clear filters + hint --- */}
          <div className="proj-rail-foot">
            {hasActiveFilter ? (
              <button
                type="button"
                className="proj-rail-clear"
                onClick={clearAllFilters}
              >
                <span className="material-symbols-outlined" aria-hidden="true">
                  filter_alt_off
                </span>
                <span>Clear filters</span>
              </button>
            ) : (
              <span className="proj-rail-foot-hint">
                <span className="material-symbols-outlined" aria-hidden="true">
                  layers
                </span>
                <span>Showing all {counts.all} projects</span>
              </span>
            )}
          </div>
        </aside>

        {/* ================= Nội dung chính ================= */}
        <div className="proj-main">
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
            label="AI Progress"
            value={`${avgProgress}%`}
            unit={projects.length === 0 ? "No data" : "Portfolio avg"}
            unitTone="primary"
            icon="auto_awesome"
            iconTone="primary"
            progress={avgProgress}
            foot={
              projects.length === 0
                ? "Create a project to start"
                : `${taskStats.done}/${taskStats.total} tasks completed`
            }
            valueTone="primary"
            mounted={kpiAnim.mounted}
            delayStyle={kpiAnim.getDelay(1)}
          />
          <KpiCard
            label="Tasks done"
            value={String(taskStats.done)}
            unit={`/ ${taskStats.total}`}
            unitTone="secondary"
            unitAsBadge
            icon="check_circle"
            iconTone="tertiary"
            progress={taskStats.pct}
            foot={
              taskStats.total === 0
                ? "No tasks scheduled yet"
                : `${taskStats.pct}% of all tasks across the portfolio`
            }
            mounted={kpiAnim.mounted}
            delayStyle={kpiAnim.getDelay(2)}
          />
          <KpiCard
            label="Nearest deadline"
            value={
              nearestDeadline
                ? nearestDeadline.daysLeft < 0
                  ? `${Math.abs(nearestDeadline.daysLeft)} days late`
                  : nearestDeadline.daysLeft === 0
                    ? "Today"
                    : `In ${nearestDeadline.daysLeft} day${nearestDeadline.daysLeft === 1 ? "" : "s"}`
                : "None set"
            }
            icon="timer"
            iconTone="error"
            progress={
              nearestDeadline
                ? Math.max(4, Math.min(100, 100 - nearestDeadline.daysLeft * 8))
                : 0
            }
            progressPulse={!!nearestDeadline && nearestDeadline.daysLeft <= 3}
            foot={nearestDeadline ? nearestDeadline.name : "No upcoming deadline"}
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
              <span className="proj-section-title">Portfolio</span>
              <span className="proj-section-pill">
                {projects.length} project{projects.length === 1 ? "" : "s"}
              </span>
            </div>
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
              <h4 className="proj-add-title">New Project</h4>
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
                    if (r.ok) {
                      setProjects(r.data.map(dtoToProject));
                      void loadProgressFor(r.data.map((p) => p.id));
                    } else setListError(r.error);
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
              desc="Nhập mục tiêu lớn, deadline và mức năng lượng hiện có của bạn."
              delayStyle={pipelineAnim.getDelay(0)}
            />
            <PipelineStep
              step="STEP 02"
              stepTone="primary"
              icon="call_split"
              iconTone="secondary"
              title="AI Auto-Decomposition"
              desc="Epic được chia thành subtask ≤45 phút, bù trừ K_bias theo thói quen của bạn."
              delayStyle={pipelineAnim.getDelay(1)}
            />
            <PipelineStep
              step="STEP 03"
              icon="calendar_clock"
              iconTone="tertiary"
              title="Adaptive Schedule Sync"
              desc="Tự xếp vào khung focus, đồng bộ Google Calendar và dời lịch khi có biến động."
              delayStyle={pipelineAnim.getDelay(2)}
            />
          </div>
        </section>
        </div>
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
                      {c.contactEmail ? ` (${c.contactEmail})` : ""}
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
                      className="proj-cf-overlay"
                      onClick={() => {
                        if (!clientSubmitting) setClientInlineOpen(false);
                      }}
                    >
                      <div
                        className="proj-cf"
                        role="region"
                        aria-label="Create new client"
                        onClick={(e) => e.stopPropagation()}
                      >
                      <div className="proj-cf__head">
                        <div className="proj-cf__heading">
                          <p className="proj-cf__eyebrow">
                            <span
                              className="proj-cf__eyebrow-dot"
                              aria-hidden="true"
                            />
                            New client
                          </p>
                          <h2 className="proj-cf__title">
                            Create a client record
                          </h2>
                          <p className="proj-cf__desc">
                            Saved immediately and selected in the project
                            form.
                          </p>
                        </div>
                        <button
                          type="button"
                          className="proj-cf__close"
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
                        className="proj-cf__form"
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
                        <div className="proj-cf__field">
                          <label
                            className="proj-cf__label"
                            htmlFor="client-f-name"
                          >
                            Client name
                            <span className="proj-cf__req">*</span>
                          </label>
                          <input
                            id="client-f-name"
                            name="clientName"
                            type="text"
                            className="proj-cf__input"
                            placeholder="e.g. Techcombank Bank…"
                            required
                            autoFocus
                          />
                        </div>

                        <div className="proj-cf__row">
                          <div className="proj-cf__field">
                            <label
                              className="proj-cf__label"
                              htmlFor="client-f-email"
                            >
                              Contact email
                              <span className="proj-cf__opt">optional</span>
                            </label>
                            <input
                              id="client-f-email"
                              name="contactEmail"
                              type="email"
                              className="proj-cf__input"
                              placeholder="contact@example.com"
                            />
                          </div>
                          <div className="proj-cf__field">
                            <label
                              className="proj-cf__label"
                              htmlFor="client-f-phone"
                            >
                              Phone
                              <span className="proj-cf__opt">optional</span>
                            </label>
                            <input
                              id="client-f-phone"
                              name="phone"
                              type="tel"
                              className="proj-cf__input"
                              placeholder="0901 234 567"
                            />
                          </div>
                        </div>

                        <div className="proj-cf__field">
                          <label
                            className="proj-cf__label"
                            htmlFor="client-f-notes"
                          >
                            Notes
                            <span className="proj-cf__opt">optional</span>
                          </label>
                          <textarea
                            id="client-f-notes"
                            name="notes"
                            rows={2}
                            className="proj-cf__input proj-cf__input--textarea"
                            placeholder="Short description…"
                          />
                        </div>

                        <div className="proj-cf__actions">
                          <button
                            type="button"
                            className="proj-cf__btn proj-cf__btn--ghost"
                            onClick={() => setClientInlineOpen(false)}
                            disabled={clientSubmitting}
                          >
                            Cancel
                          </button>
                          <button
                            type="submit"
                            className="proj-cf__btn proj-cf__btn--primary"
                            disabled={clientSubmitting}
                          >
                            <span
                              className={
                                "material-symbols-outlined proj-cf__btn-icon" +
                                (clientSubmitting
                                  ? " proj-cf__btn-icon--spin"
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
                                    {c.contactEmail || c.phone
                                      ? [c.contactEmail, c.phone]
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

      {/* ================= AI Copilot FAB (góc phải dưới) ================= */}
      <button
        type="button"
        className="proj-fab"
        onClick={() => navigate("/copilot")}
        aria-label="Mở AI Copilot"
        title="Mở AI Copilot"
      >
        <span className="proj-fab-glow" aria-hidden="true" />
        <span className="material-symbols-outlined proj-fab-icon" aria-hidden="true">
          smart_toy
        </span>
      </button>

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
        <p className="proj-insight-text">{prj.insight}</p>
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
              className="proj-action proj-action--plain proj-action--flex"
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
              className="proj-action proj-action--ai proj-action--flex"
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
