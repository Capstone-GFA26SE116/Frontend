import { useId, useMemo, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import {
  confirmExcelPlan,
  previewExcelPlan,
  type PlanIssue,
  type PlanPreview,
  type PlanRow,
  type SavedPlan,
} from "../../lib/excel-plan-api";
import { indexPlan, projectKey, selectedRows, type RowKind } from "./excel-plan-tree";

const issueText: Record<string, string> = {
  duplicate: "Mã bị trùng",
  unknown_project: "Chưa xác định được dự án",
  unknown_milestone: "Chưa xác định được cột mốc",
  unknown_domain: "Chọn một loại việc trong METANOIA",
  invalid_minutes: "Nhập số phút nguyên dương",
  required_or_too_long: "Thiếu giá trị hoặc vượt độ dài cho phép",
  too_long: "Vượt độ dài cho phép",
  invalid_date: "Nhập ngày theo YYYY-MM-DD",
  missing_deadline: "Nhập hạn cho công việc, cột mốc hoặc dự án",
  past_project_deadline: "Hạn dự án đã qua. Hãy sửa hoặc để trống.",
};

const fileErrors: Record<string, string> = {
  xlsx_required: "Hãy chọn file .xlsx.",
  workbook_too_large: "File vượt giới hạn kích thước.",
  unreadable_workbook: "Không đọc được workbook. Hãy mở lại file bằng Excel để kiểm tra.",
  expected_sheet: "Thiếu sheet hoặc có hai tên cho cùng một sheet.",
  invalid_headers: "Dòng tiêu đề khác mẫu. Hãy kiểm tra tên cột.",
  column_limit: "Sheet vượt giới hạn 64 cột.",
  sheet_limit: "Sheet vượt giới hạn 5.000 dòng hoặc 64 cột.",
  formula_cell: "Hãy dán công thức thành giá trị trước khi nhập.",
};

const label: Record<Exclude<keyof PlanRow, "source">, string> = {
  project_code: "Mã dự án",
  milestone_code: "Mã cột mốc",
  name: "Tên",
  description: "Mô tả",
  deadline: "Hạn (YYYY-MM-DD)",
  estimated_minutes: "Thời lượng (phút)",
  domain: "Loại việc",
};

const fields: Record<RowKind, Array<Exclude<keyof PlanRow, "source">>> = {
  projects: ["project_code", "name", "description", "deadline"],
  milestones: ["project_code", "milestone_code", "name", "deadline"],
  tasks: ["project_code", "milestone_code", "name", "estimated_minutes", "domain", "deadline"],
};

type EditorProps = {
  kind: RowKind;
  row: PlanRow;
  issues: PlanIssue[];
  domains: string[];
  kept: boolean;
  canToggle: boolean;
  projectCodes: string[];
  milestoneCodes: string[];
  onToggle: () => void;
  onEdit: (field: keyof PlanRow, value: string) => void;
  counts?: string;
  children?: ReactNode;
};

function RowEditor({
  kind, row, issues, domains, kept, canToggle, projectCodes, milestoneCodes,
  onToggle, onEdit, counts, children,
}: EditorProps) {
  const listId = useId();
  const [open, setOpen] = useState(false);
  return (
    <div className="pim-plan-row">
      <input type="checkbox" checked={kept} disabled={!canToggle} onChange={onToggle}
        aria-label={`Nhập ${row.name || row.source}`} />
      <details onToggle={(event) => setOpen(event.currentTarget.open)}>
        <summary>
          <strong>{row.name || "Chưa có tên"}</strong>
          <span className="pim-plan-meta">{counts || row.source}</span>
          {issues.length > 0 && <span className="pim-plan-issue">{issues.length} cần xem</span>}
        </summary>
        {open && (
          <>
            <p className="pim-plan-meta">{row.source}</p>
            <div className="pim-plan-fields">
              {fields[kind].map((field) => (
                <label key={field}>
                  {label[field]}
                  {field === "domain" ? (
                    <select className="pim-input" value={row.domain}
                      onChange={(event) => onEdit(field, event.target.value)}>
                      <option value="">Chọn loại việc</option>
                      {row.domain && !domains.includes(row.domain) &&
                        <option value={row.domain}>{row.domain}</option>}
                      {domains.map((domain) => <option key={domain}>{domain}</option>)}
                    </select>
                  ) : (
                    <input className="pim-input" value={row[field]}
                      list={field === "project_code" && kind !== "projects" ? `${listId}-project`
                        : field === "milestone_code" && kind === "tasks" ? `${listId}-milestone` : undefined}
                      placeholder={kind === "tasks" && field === "deadline" ? "Dùng hạn cột mốc hoặc dự án" : undefined}
                      inputMode={field === "estimated_minutes" ? "numeric" : undefined}
                      onChange={(event) => onEdit(field, event.target.value)} />
                  )}
                  {issues.filter((issue) => issue.field === field).map((issue) => (
                    <small key={issue.code} className="pim-plan-issue">{issueText[issue.code] ?? issue.code}</small>
                  ))}
                </label>
              ))}
            </div>
            {kind !== "projects" && <datalist id={`${listId}-project`}>
              {projectCodes.map((code) => <option key={code} value={code} />)}
            </datalist>}
            {kind === "tasks" && <datalist id={`${listId}-milestone`}>
              {milestoneCodes.map((code) => <option key={code} value={code} />)}
            </datalist>}
            {children}
          </>
        )}
      </details>
    </div>
  );
}

export function ExcelPlanImport({ onSwitch }: { onSwitch: () => void }) {
  const fileId = useId();
  const [filename, setFilename] = useState("");
  const [preview, setPreview] = useState<PlanPreview | null>(null);
  const [excluded, setExcluded] = useState<Set<string>>(new Set());
  const [saved, setSaved] = useState<SavedPlan | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const pending = useRef(false);
  const request = useRef<{ payload: string; id: string } | null>(null);

  const tree = useMemo(() => preview ? indexPlan(preview.rows) : null, [preview]);
  const selected = useMemo(
    () => preview ? selectedRows(preview.rows, excluded) : null,
    [preview, excluded],
  );
  const selectedSources = useMemo(() => new Set(
    selected ? [...selected.projects, ...selected.milestones, ...selected.tasks].map((row) => row.source) : [],
  ), [selected]);
  const issuesBySource = useMemo(() => {
    const indexed = new Map<string, PlanIssue[]>();
    for (const issue of preview?.issues ?? []) {
      const bucket = indexed.get(issue.source) ?? [];
      bucket.push(issue);
      indexed.set(issue.source, bucket);
    }
    return indexed;
  }, [preview]);
  const projectCodes = useMemo(
    () => [...new Set(preview?.rows.projects.map((row) => row.project_code).filter(Boolean))],
    [preview],
  );
  const codesByProject = useMemo(() => {
    const index = new Map<string, Set<string>>();
    for (const row of preview?.rows.milestones ?? []) {
      if (!row.milestone_code) continue;
      const key = projectKey(row);
      const codes = index.get(key) ?? new Set<string>();
      codes.add(row.milestone_code);
      index.set(key, codes);
    }
    return new Map([...index].map(([key, codes]) => [key, [...codes]]));
  }, [preview]);
  const limit = Math.min(preview?.projects_left ?? 20, 20);
  const overLimit = (selected?.projects.length ?? 0) > limit;

  async function upload(file: File | undefined) {
    if (!file || pending.current) return;
    setError("");
    if (!file.name.toLowerCase().endsWith(".xlsx") || file.size > 20 * 1024 * 1024) {
      setError("Hãy chọn file .xlsx tối đa 20 MB.");
      return;
    }
    pending.current = true;
    setBusy(true);
    try {
      const result = await previewExcelPlan(file);
      if (!result.ok) {
        const detail = result.details as { source?: string } | undefined;
        const message = fileErrors[result.errorCode ?? ""] ?? result.error;
        setError(detail?.source ? `${message} (${detail.source})` : message);
        return;
      }
      setFilename(file.name);
      setPreview(result.data);
      setSaved(null);
      setExcluded(new Set());
      request.current = null;
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }

  async function save() {
    if (!selected?.projects.length || overLimit || pending.current) return;
    const payload = JSON.stringify(selected);
    if (request.current?.payload !== payload) {
      request.current = { payload, id: crypto.randomUUID() };
    }
    pending.current = true;
    setBusy(true);
    setError("");
    try {
      const result = await confirmExcelPlan(selected, request.current.id);
      if (result.ok) {
        setSaved(result.data);
        return;
      }
      const detail = result.details as { issues?: PlanIssue[] } | undefined;
      if (result.errorCode === "invalid_plan" && Array.isArray(detail?.issues)) {
        const issues = detail.issues;
        setPreview((current) => current && { ...current, issues });
        setError("Hãy sửa các dòng cần xem hoặc bỏ chọn chúng trước khi tạo.");
      } else if (result.errorCode === "partial_import") {
        setError("Một phần dự án của lần nhập này đã bị xóa. Hãy kiểm tra danh sách dự án.");
      } else {
        setError(result.error);
      }
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }

  function edit(kind: RowKind, row: PlanRow, field: keyof PlanRow, value: string) {
    setPreview((current) => {
      if (!current) return current;
      const rows = current.rows[kind].map((item) =>
        item.source === row.source ? { ...item, [field]: value } : item,
      );
      return {
        ...current,
        rows: { ...current.rows, [kind]: rows },
        issues: current.issues.filter((issue) => issue.source !== row.source || issue.field !== field),
      };
    });
  }

  function renderRow(kind: RowKind, row: PlanRow, children?: ReactNode, counts?: string) {
    return (
      <RowEditor key={row.source} kind={kind} row={row} counts={counts}
        kept={selectedSources.has(row.source)} canToggle={selectedSources.has(row.source) || excluded.has(row.source)}
        projectCodes={projectCodes} milestoneCodes={codesByProject.get(projectKey(row)) ?? []}
        issues={issuesBySource.get(row.source) ?? []}
        domains={preview?.domains ?? []} onEdit={(field, value) => edit(kind, row, field, value)}
        onToggle={() => setExcluded((previous) => {
          const next = new Set(previous);
          if (next.has(row.source)) next.delete(row.source);
          else if (selectedSources.has(row.source)) next.add(row.source);
          return next;
        })}>
        {children}
      </RowEditor>
    );
  }

  const reviewRows = useMemo(() => {
    if (!preview || !tree) return [];
    const orphanSources = new Set(
      [...tree.orphanMilestones, ...tree.orphanTasks].map((row) => row.source),
    );
    return (Object.keys(preview.rows) as RowKind[]).flatMap((kind) =>
      preview.rows[kind]
        .filter((row) => orphanSources.has(row.source) || issuesBySource.has(row.source))
        .map((row) => ({ kind, row })),
    );
  }, [preview, tree, issuesBySource]);
  const needsReview = reviewRows.filter(({ row }) => selectedSources.has(row.source)).length;
  return (
    <section className="pim">
      <div className="pim-subbar"><div className="pim-subbar-inner">
        <Link className="pim-breadcrumb-link" to="/projects">Về danh sách dự án</Link>
      </div></div>
      <div className="pim-container">
        <header className="pim-header">
          <h1 className="pim-title">Nhập kế hoạch Excel</h1>
          <p className="pim-subtitle">Xem trước và chỉnh sửa dự án, cột mốc và công việc trước khi tạo.</p>
          <div className="pim-plan-actions">
            <a href={`${import.meta.env.BASE_URL}metanoia-plan-template.xlsx`} download className="pim-btn pim-btn--ghost">
              Tải mẫu Excel
            </a>
            <button type="button" className="pim-btn pim-btn--ghost" disabled={busy} onClick={onSwitch}>
              Nhập brief với AI
            </button>
          </div>
        </header>

        {error && <div className="pim-banner pim-banner--error" role="alert">{error}</div>}

        {saved ? (
          <div className="pim-card">
            <h2 className="pim-card-title" role="status">
              Đã tạo {saved.projects.length} dự án, {saved.milestone_count} cột mốc và {saved.task_count} công việc
            </h2>
            <ul className="pim-plan-results">
              {saved.projects.map((project) => (
                <li key={project.project_id}>
                  <Link className="pim-breadcrumb-link" to={`/projects/${project.project_id}/execution`}>{project.name}</Link>
                </li>
              ))}
            </ul>
            <button type="button" className="pim-btn pim-btn--ghost" onClick={() => { setSaved(null); setPreview(null); }}>
              Nhập file khác
            </button>
          </div>
        ) : (
          <>
            <div className="pim-card">
              <div className="pim-drop pim-plan-drop"
                onDragOver={(event) => event.preventDefault()}
                onDrop={(event) => { event.preventDefault(); void upload(event.dataTransfer.files[0]); }}>
                <label className="pim-btn pim-btn--ghost" htmlFor={fileId}>
                  {preview ? "Chọn file khác" : "Chọn file Excel"}
                </label>
                <input id={fileId} type="file" accept=".xlsx"
                  disabled={busy}
                  onChange={(event) => {
                    const file = event.currentTarget.files?.[0];
                    event.currentTarget.value = "";
                    void upload(file);
                  }} />
                <p className="pim-drop-hint" role="status">
                  {busy ? "Đang xử lý…" : preview ? filename : "Kéo thả .xlsx vào đây · Tối đa 20 MB"}
                </p>
              </div>
            </div>
            {preview && tree && selected && (
              <div className="pim-card">
                <h2 className="pim-card-title">Xem trước kế hoạch</h2>
                <p className="pim-plan-meta">
                  {selected.projects.length} dự án · {selected.milestones.length} cột mốc · {selected.tasks.length} công việc
                  {needsReview > 0 && ` · ${needsReview} vấn đề cần xem`}
                </p>
                {overLimit && <p role="alert" className="pim-plan-issue">Bạn có thể nhập tối đa {limit} dự án trong lần này.</p>}
                {preview.rows.projects.length === 0 && <p>Sheet Projects chưa có dữ liệu.</p>}
                <fieldset disabled={busy} className="pim-plan-tree">
                  {preview.rows.projects.map((project) => {
                    const milestones = tree.milestonesFor(project);
                    const tasks = milestones.reduce((count, row) => count + tree.tasksFor(row).length, 0);
                    return renderRow("projects", project,
                      milestones.map((milestone) => {
                        const children = tree.tasksFor(milestone);
                        return renderRow("milestones", milestone,
                          children.map((task) => renderRow("tasks", task, undefined,
                            `${task.estimated_minutes || "?"} phút`)),
                          `${children.length} công việc`);
                      }),
                      `${milestones.length} cột mốc · ${tasks} công việc`);
                  })}
                  {reviewRows.length > 0 && (
                    <details className="pim-plan-review">
                      <summary className="pim-card-title">Cần xem ({reviewRows.length} dòng)</summary>
                      <p className="pim-plan-meta">Mở từng dòng để sửa dữ liệu hoặc bỏ chọn.</p>
                      {reviewRows.map(({ kind, row }) => renderRow(kind, row))}
                    </details>
                  )}
                </fieldset>
                <div className="pim-actions">
                  <button type="button" className="pim-btn pim-btn--primary"
                    disabled={busy || overLimit || !selected.projects.length} onClick={() => void save()}>
                    Tạo {selected.projects.length} dự án, {selected.milestones.length} cột mốc, {selected.tasks.length} công việc
                  </button>
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </section>
  );
}
