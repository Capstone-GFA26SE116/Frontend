/**
 * ============================================================
 * Dữ liệu mẫu cho chế độ DEMO (không cần đăng nhập)
 * ============================================================
 *
 * Mục đích: cho khách (guest) xem trước "shape" của sản phẩm mà KHÔNG
 * cần tạo tài khoản và không chạm vào dữ liệu thật.
 *
 * ⚠️ NGUYÊN TẮC AN TOÀN
 * - Mọi id ở đây đều là chuỗi giả (`demo-*`) → không thể trùng id thật.
 * - Mọi request khi bật demo đều bị chặn ở tầng `apiFetch` (xem
 *   `api-client.ts` → `demoFetch`) → không có request nào chạm network.
 * - Chỉ bật demo khi user CHƯA đăng nhập và đang ở trang chủ `/`.
 *
 * Toàn bộ class prefix `.demo-*`.
 */

/* ---------- Kiểu ngày giả (đồng bộ với app thật) ---------- */

/** Ngày hôm nay dạng `YYYY-MM-DD` (giờ địa phương). */
export function demoToday(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** Cộng `n` ngày vào chuỗi ngày `YYYY-MM-DD`. */
export function demoAddDays(iso: string, n: number): string {
  const d = new Date(`${iso}T00:00:00`);
  d.setDate(d.getDate() + n);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** ISO timestamp (không có `Z` → giờ địa phương). */
function demoIso(dateIso: string, hhmm: string): string {
  return `${dateIso}T${hhmm}:00`;
}

/* ============================================================
 * Projects
 * =========================================================== */

export interface DemoProject {
  id: string;
  userId: string;
  name: string;
  description: string;
  startDate: string;
  deadline: string;
  status: string;
  clientId: string | null;
  client: {
    id: string;
    name: string;
    contactEmail: string;
    phone: string;
  } | null;
  createdAt: string;
}

export interface DemoTask {
  id: string;
  projectId: string;
  userId: string;
  title: string;
  description: string;
  taskType: string;
  status: string;
  domainId: string | null;
  milestoneId: string | null;
  deadline: string | null;
  estimatedMinutes: number;
  aiEstimatedMinutes: number;
  fixedStart: string | null;
  fixedEnd: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface DemoMilestone {
  id: string;
  projectId: string;
  name: string;
  startDate: string | null;
  endDate: string | null;
  dueDate: string | null;
  status: string;
  orderIndex: number;
  revisionCount: number;
  deliveredAt: string | null;
  approvedAt: string | null;
  createdAt: string;
}

/** Milestone + task của dự án mẫu. */
export interface DemoMilestoneBundle {
  milestone: DemoMilestone;
  tasks: DemoTask[];
}

const DEMO_USER_ID = "demo-user-001";

/* ---------- Dự án mẫu ---------- */

export function demoProjects(): DemoProject[] {
  const t = demoToday();
  return [
    {
      id: "demo-p-001",
      userId: DEMO_USER_ID,
      name: "Bloom Coffee — Website",
      description:
        "Marketing site + online reservations for the Bloom Coffee shop.",
      startDate: demoAddDays(t, -12),
      deadline: demoAddDays(t, 18),
      status: "Active",
      clientId: "demo-c-001",
      client: {
        id: "demo-c-001",
        name: "Bloom Coffee",
        contactEmail: "hello@bloomcoffee.vn",
        phone: "0901 234 567",
      },
      createdAt: demoAddDays(t, -14),
    },
    {
      id: "demo-p-002",
      userId: DEMO_USER_ID,
      name: "Smart Logistics Platform",
      description:
        "Logistics management platform: shipments, warehouse, drivers, routing, tracking.",
      startDate: demoAddDays(t, -30),
      deadline: demoAddDays(t, 46),
      status: "Active",
      clientId: "demo-c-002",
      client: {
        id: "demo-c-002",
        name: "Dai Phat Logistics",
        contactEmail: "ops@daiphat.vn",
        phone: "0903 987 654",
      },
      createdAt: demoAddDays(t, -32),
    },
    {
      id: "demo-p-003",
      userId: DEMO_USER_ID,
      name: "Minh Long Interior — Brand",
      description:
        "Brand identity and website for the Minh Long furniture collection.",
      startDate: demoAddDays(t, -5),
      deadline: demoAddDays(t, 9),
      status: "Active",
      clientId: "demo-c-003",
      client: {
        id: "demo-c-003",
        name: "Minh Long Interior",
        contactEmail: "studio@minhlong.vn",
        phone: "0912 345 678",
      },
      createdAt: demoAddDays(t, -6),
    },
    {
      id: "demo-p-004",
      userId: DEMO_USER_ID,
      name: "Healthcare appointment app",
      description: "MVP for booking appointments + basic patient records.",
      startDate: demoAddDays(t, -40),
      deadline: demoAddDays(t, -2),
      status: "Completed",
      clientId: null,
      client: null,
      createdAt: demoAddDays(t, -42),
    },
  ];
}

/* ---------- Milestone + task mẫu ---------- */

export function demoMilestones(): DemoMilestoneBundle[] {
  const t = demoToday();
  const created = demoAddDays(t, -10);

  const mk = (
    id: string,
    projectId: string,
    name: string,
    orderIndex: number,
    dueOffset: number,
    status: string,
  ): DemoMilestone => ({
    id,
    projectId,
    name,
    startDate: demoAddDays(t, dueOffset - 7),
    endDate: demoAddDays(t, dueOffset),
    dueDate: demoAddDays(t, dueOffset),
    status,
    orderIndex,
    revisionCount: 0,
    deliveredAt: null,
    approvedAt: null,
    createdAt: created,
  });

  const task = (
    id: string,
    projectId: string,
    milestoneId: string,
    title: string,
    taskType: string,
    status: string,
    est: number,
    deadlineOffset: number,
    description = "",
  ): DemoTask => ({
    id,
    projectId,
    userId: DEMO_USER_ID,
    title,
    description,
    taskType,
    status,
    domainId: null,
    milestoneId,
    deadline: demoAddDays(t, deadlineOffset),
    estimatedMinutes: est,
    aiEstimatedMinutes: est,
    fixedStart: null,
    fixedEnd: null,
    createdAt: created,
    updatedAt: created,
  });

  return [
    /* ---- Bloom Coffee ---- */
    {
      milestone: mk("demo-ms-001", "demo-p-001", "Design", 1, 3, "Active"),
      tasks: [
        task(
          "demo-t-001",
          "demo-p-001",
          "demo-ms-001",
          "Homepage wireframe",
          "Design",
          "Done",
          120,
          1,
        ),
        task(
          "demo-t-002",
          "demo-p-001",
          "demo-ms-001",
          "Color palette + typography",
          "Design",
          "Done",
          90,
          2,
        ),
        task(
          "demo-t-003",
          "demo-p-001",
          "demo-ms-001",
          "Review design with the client",
          "Meeting",
          "InProgress",
          60,
          3,
        ),
      ],
    },
    {
      milestone: mk("demo-ms-002", "demo-p-001", "Development", 2, 12, "Active"),
      tasks: [
        task(
          "demo-t-004",
          "demo-p-001",
          "demo-ms-002",
          "Build the reservation form",
          "Coding",
          "InProgress",
          240,
          8,
        ),
        task(
          "demo-t-005",
          "demo-p-001",
          "demo-ms-002",
          "Send confirmation emails to the shop",
          "Coding",
          "Todo",
          150,
          10,
        ),
        task(
          "demo-t-006",
          "demo-p-001",
          "demo-ms-002",
          "Integrate Google Maps",
          "Coding",
          "Todo",
          120,
          12,
        ),
      ],
    },
    {
      milestone: mk("demo-ms-003", "demo-p-001", "Handover", 3, 18, "Active"),
      tasks: [
        task(
          "demo-t-007",
          "demo-p-001",
          "demo-ms-003",
          "Test the full reservation flow",
          "Testing",
          "Todo",
          120,
          15,
        ),
        task(
          "demo-t-008",
          "demo-p-001",
          "demo-ms-003",
          "Deploy to hosting + handover",
          "Deployment",
          "Todo",
          90,
          18,
        ),
      ],
    },

    /* ---- Smart Logistics ---- */
    {
      milestone: mk("demo-ms-004", "demo-p-002", "Requirements & Architecture", 1, 6, "Active"),
      tasks: [
        task(
          "demo-t-009",
          "demo-p-002",
          "demo-ms-004",
          "Design shipment/warehouse/driver schema",
          "Coding",
          "InProgress",
          180,
          4,
        ),
        task(
          "demo-t-010",
          "demo-p-002",
          "demo-ms-004",
          "Set up repository + API architecture",
          "Coding",
          "Todo",
          120,
          6,
        ),
      ],
    },
    {
      milestone: mk("demo-ms-005", "demo-p-002", "Core modules", 2, 20, "Active"),
      tasks: [
        task(
          "demo-t-011",
          "demo-p-002",
          "demo-ms-005",
          "Shipment management API",
          "Coding",
          "Todo",
          180,
          13,
        ),
        task(
          "demo-t-012",
          "demo-p-002",
          "demo-ms-005",
          "Warehouse + inventory logic",
          "Coding",
          "Todo",
          120,
          16,
        ),
        task(
          "demo-t-013",
          "demo-p-002",
          "demo-ms-005",
          "Driver task assignment",
          "Coding",
          "Todo",
          120,
          20,
        ),
      ],
    },
    {
      milestone: mk("demo-ms-006", "demo-p-002", "Advanced features", 3, 36, "Active"),
      tasks: [
        task(
          "demo-t-014",
          "demo-p-002",
          "demo-ms-006",
          "Route optimization service",
          "Coding",
          "Todo",
          180,
          28,
        ),
        task(
          "demo-t-015",
          "demo-p-002",
          "demo-ms-006",
          "Real-time tracking",
          "Coding",
          "Todo",
          120,
          32,
        ),
      ],
    },

    /* ---- Minh Long ---- */
    {
      milestone: mk("demo-ms-007", "demo-p-003", "Brand & Website", 1, 9, "Active"),
      tasks: [
        task(
          "demo-t-016",
          "demo-p-003",
          "demo-ms-007",
          "Design the new logo",
          "Design",
          "InProgress",
          150,
          4,
        ),
        task(
          "demo-t-017",
          "demo-p-003",
          "demo-ms-007",
          "Build the product catalogue",
          "Coding",
          "Todo",
          180,
          9,
        ),
      ],
    },
  ];
}

/* ============================================================
 * Calendar / lịch ngày
 * =========================================================== */

export interface DemoCalendarItem {
  id: string;
  title: string;
  start: string;
  end: string;
  /** Task của project (nếu có) → hiển thị badge AI. */
  taskId: string | null;
  projectId: string | null;
  projectName: string | null;
  isFixed: boolean;
  description: string | null;
}

/** Lịch trong ngày (dùng cho Dashboard + Schedule). */
export function demoCalendarItems(dayOffset = 0): DemoCalendarItem[] {
  const d = demoAddDays(demoToday(), dayOffset);
  const base = [
    {
      id: "demo-cal-001",
      title: "Deep work — Write project spec",
      start: "09:00",
      end: "10:30",
      taskId: "demo-t-009",
      projectId: "demo-p-002",
      projectName: "Smart Logistics Platform",
      isFixed: false,
      description: "Highest-focus window of the day.",
    },
    {
      id: "demo-cal-002",
      title: "Review pull request #248",
      start: "11:00",
      end: "11:45",
      taskId: "demo-t-004",
      projectId: "demo-p-001",
      projectName: "Bloom Coffee — Website",
      isFixed: false,
      description: null,
    },
    {
      id: "demo-cal-003",
      title: "Sync with client",
      start: "14:00",
      end: "15:00",
      taskId: "demo-t-003",
      projectId: "demo-p-001",
      projectName: "Bloom Coffee — Website",
      isFixed: true,
      description: "Fixed meeting — cannot be moved.",
    },
    {
      id: "demo-cal-004",
      title: "Sprint planning meeting",
      start: "16:00",
      end: "17:00",
      taskId: null,
      projectId: null,
      projectName: null,
      isFixed: true,
      description: "Team meeting — keep as is.",
    },
  ];

  return base.map((b) => ({
    ...b,
    start: demoIso(d, b.start),
    end: demoIso(d, b.end),
  }));
}

/* ============================================================
 * Groups
 * =========================================================== */

export interface DemoGroupMember {
  userId: string;
  fullName: string;
  email: string;
  role: string;
  joinedAt: string;
}

export interface DemoGroup {
  id: string;
  name: string;
  description: string;
  status: string;
  createdAt: string;
  memberCount: number;
}

export function demoGroups(): DemoGroup[] {
  const t = demoToday();
  return [
    {
      id: "demo-g-001",
      name: "Bloom Coffee — Team",
      description: "Team delivering the Bloom Coffee website.",
      status: "Active",
      createdAt: demoAddDays(t, -10),
      memberCount: 4,
    },
    {
      id: "demo-g-002",
      name: "Logistics Core",
      description: "Team building the core logistics platform.",
      status: "Active",
      createdAt: demoAddDays(t, -28),
      memberCount: 6,
    },
    {
      id: "demo-g-003",
      name: "Brand 2026",
      description: "2026 brand identity project group.",
      status: "Archived",
      createdAt: demoAddDays(t, -120),
      memberCount: 3,
    },
  ];
}

export function demoGroupMembers(groupId: string): DemoGroupMember[] {
  const t = demoToday();
  const base: DemoGroupMember[] = [
    {
      userId: "demo-user-001",
      fullName: "Minh Anh Nguyen",
      email: "minhanh@demo.io",
      role: "Leader",
      joinedAt: demoAddDays(t, -30),
    },
    {
      userId: "demo-user-002",
      fullName: "Thu Ha Tran",
      email: "thuha@demo.io",
      role: "Member",
      joinedAt: demoAddDays(t, -28),
    },
    {
      userId: "demo-user-003",
      fullName: "Quoc Bao Le",
      email: "quocbao@demo.io",
      role: "Member",
      joinedAt: demoAddDays(t, -25),
    },
    {
      userId: "demo-user-004",
      fullName: "Ngoc Anh Pham",
      email: "ngocanh@demo.io",
      role: "Member",
      joinedAt: demoAddDays(t, -20),
    },
  ];
  if (groupId === "demo-g-002") {
    base.push(
      {
        userId: "demo-user-005",
        fullName: "Thanh Long Vo",
        email: "thanhlong@demo.io",
        role: "Member",
        joinedAt: demoAddDays(t, -18),
      },
      {
        userId: "demo-user-006",
        fullName: "Hoai Nam Do",
        email: "hoainam@demo.io",
        role: "Viewer",
        joinedAt: demoAddDays(t, -12),
      },
    );
  }
  return base;
}

/* ============================================================
 * Gói đăng ký (mẫu cho trang /pricing)
 * ----------------------------------------------------------
 * BE yêu cầu token cho `GET /api/subscription-plans` → khách chưa đăng nhập
 * nhận 401. Bảng giá là trang marketing công khai nên phải hiển thị được
 * cho khách → dùng dữ liệu mẫu.
 *
 * Giá khớp với bảng giá cũ của FE:
 *   Free  — 0đ / trọn đời
 *   Pro   — 149.000đ / tháng  ·  1.428.000đ / năm
 *   Team  — 399.000đ / tháng  ·  3.828.000đ / năm
 * ============================================================ */

/** Id giả của các gói mẫu (không dùng để thanh toán thật). */
const DEMO_PLAN_IDS = {
  free: "demo-plan-free",
  proMonthly: "demo-plan-pro-monthly",
  proAnnual: "demo-plan-pro-annual",
  teamMonthly: "demo-plan-team-monthly",
  teamAnnual: "demo-plan-team-annual",
} as const;

/** Danh sách gói mẫu, đúng shape `SubscriptionPlanDto` của BE. */
export function demoSubscriptionPlans(): Array<{
  id: string;
  name: string | null;
  price: number;
  durationDays: number;
  aiCallLimit: number | null;
  storageLimitMb: number;
  projectLimit: number | null;
  isActive: boolean;
}> {
  return [
    {
      id: DEMO_PLAN_IDS.free,
      name: "Free",
      price: 0,
      durationDays: 36500,
      aiCallLimit: 50,
      storageLimitMb: 1024,
      projectLimit: 1,
      isActive: true,
    },
    {
      id: DEMO_PLAN_IDS.proMonthly,
      name: "Pro",
      price: 149000,
      durationDays: 30,
      aiCallLimit: null,
      storageLimitMb: 10240,
      projectLimit: null,
      isActive: true,
    },
    {
      id: DEMO_PLAN_IDS.proAnnual,
      name: "Pro",
      price: 1428000,
      durationDays: 365,
      aiCallLimit: null,
      storageLimitMb: 10240,
      projectLimit: null,
      isActive: true,
    },
    {
      id: DEMO_PLAN_IDS.teamMonthly,
      name: "Team",
      price: 399000,
      durationDays: 30,
      aiCallLimit: null,
      storageLimitMb: 51200,
      projectLimit: null,
      isActive: true,
    },
    {
      id: DEMO_PLAN_IDS.teamAnnual,
      name: "Team",
      price: 3828000,
      durationDays: 365,
      aiCallLimit: null,
      storageLimitMb: 51200,
      projectLimit: null,
      isActive: true,
    },
  ];
}

/* ============================================================
 * Bảng định tuyến API demo
 * =========================================================== */

/** Kết quả match của demo interceptor. */
export interface DemoMatch {
  /** Dữ liệu trả về. */
  data: unknown;
  /** `true` nếu request này bị demo thay thế. */
  handled: boolean;
}

/**
 * Thử match một path + method vào dữ liệu demo.
 *
 * @param method HTTP method (chữ thường).
 * @param path Path API (đã có `/api/...`).
 */
export function demoMatch(method: string, path: string): DemoMatch {
  const m = method.toLowerCase();
  const p = path.split("?")[0];

  /* ---- GET /api/projects ---- */
  if (m === "get" && p === "/api/projects") {
    return { data: demoProjects(), handled: true };
  }

  /* ---- GET /api/projects/{id} ---- */
  if (m === "get" && /^\/api\/projects\/[^/]+$/.test(p)) {
    const id = p.split("/")[3];
    const proj = demoProjects().find((x) => x.id === id);
    return { data: proj ?? null, handled: true };
  }

  /* ---- GET /api/projects/{id}/progress ---- */
  if (m === "get" && /^\/api\/projects\/[^/]+\/progress$/.test(p)) {
    return {
      data: { percent: 42, done: 5, total: 12 },
      handled: true,
    };
  }

  /* ---- GET /api/projects/{id}/milestones ---- */
  if (m === "get" && /^\/api\/projects\/[^/]+\/milestones$/.test(p)) {
    const id = p.split("/")[3];
    return {
      data: demoMilestones()
        .filter((b) => b.milestone.projectId === id)
        .map((b) => b.milestone),
      handled: true,
    };
  }

  /* ---- GET /api/projects/{id}/tasks ---- */
  if (m === "get" && /^\/api\/projects\/[^/]+\/tasks$/.test(p)) {
    const id = p.split("/")[3];
    return {
      data: demoMilestones()
        .filter((b) => b.milestone.projectId === id)
        .flatMap((b) => b.tasks),
      handled: true,
    };
  }

  /* ---- GET /api/projects/{id}/subtasks ---- */
  if (m === "get" && /^\/api\/projects\/[^/]+\/subtasks$/.test(p)) {
    return { data: [], handled: true };
  }

  /* ---- GET /api/projects/filter ---- */
  if (m === "get" && p === "/api/projects/filter") {
    return { data: demoProjects(), handled: true };
  }

  /* ---- GET /api/calendar (dùng cho Dashboard + Schedule) ---- */
  if (m === "get" && (p === "/api/calendar" || p === "/api/calendar/items")) {
    return { data: demoCalendarItems(0), handled: true };
  }

  /* ---- GET /api/domains ---- */
  if (m === "get" && p === "/api/domains") {
    return {
      data: [
        { id: "demo-dom-001", name: "Coding" },
        { id: "demo-dom-002", name: "Design" },
        { id: "demo-dom-003", name: "Meeting" },
        { id: "demo-dom-004", name: "Testing" },
        { id: "demo-dom-005", name: "Deployment" },
      ],
      handled: true,
    };
  }

  /* ---- GET /api/groups ---- */
  if (m === "get" && p === "/api/groups") {
    return { data: demoGroups(), handled: true };
  }

  /* ---- GET /api/groups/{id}/members ---- */
  if (m === "get" && /^\/api\/groups\/[^/]+\/members$/.test(p)) {
    const id = p.split("/")[3];
    return { data: demoGroupMembers(id), handled: true };
  }

  /* ---- GET /api/groups/{id}/milestones ---- */
  if (m === "get" && /^\/api\/groups\/[^/]+\/milestones$/.test(p)) {
    return { data: [], handled: true };
  }

  /* ---- GET /api/groups/{id}/tasks ---- */
  if (m === "get" && /^\/api\/groups\/[^/]+\/tasks$/.test(p)) {
    return { data: [], handled: true };
  }

  /* ---- GET /api/notifications ---- */
  if (m === "get" && p === "/api/notifications") {
    return { data: [], handled: true };
  }

  /* ---- GET /api/subscription-plans ----
   * BE yêu cầu token cho endpoint này → khách chưa đăng nhập sẽ nhận 401.
   * Trả dữ liệu mẫu (giá khớp bảng giá cũ của FE) để trang /pricing hiển thị
   * được cho khách. */
  if (m === "get" && p === "/api/subscription-plans") {
    return { data: demoSubscriptionPlans(), handled: true };
  }

  /* ---- GET /api/me ---- */
  if (m === "get" && p === "/api/me") {
    return {
      data: {
        userId: DEMO_USER_ID,
        email: "demo@metanoia.app",
        fullName: "Demo User",
        role: "User",
        avatarUrl: null,
        onboardingCompleted: true,
      },
      handled: true,
    };
  }

  /* ---- Mọi thứ khác: chặn, không cho gọi network ---- */
  if (m === "get") {
    return { data: [], handled: true };
  }

  /* ---- Ghi (POST/PUT/DELETE): báo lỗi thân thiện, KHÔNG gọi network ---- */
  return {
    data: null,
    handled: true,
  };
}
