import { aiFetch } from "./api-client";

export interface PlanRow {
  source: string;
  project_code: string;
  milestone_code: string;
  name: string;
  description: string;
  deadline: string;
  estimated_minutes: string;
  domain: string;
}

export interface PlanRows {
  projects: PlanRow[];
  milestones: PlanRow[];
  tasks: PlanRow[];
}

export interface PlanIssue {
  source: string;
  field: string;
  code: string;
}

export interface PlanPreview {
  rows: PlanRows;
  domains: string[];
  issues: PlanIssue[];
  project_limit: number | null;
  projects_left: number | null;
}

export interface SavedPlan {
  projects: { project_id: string; name: string }[];
  milestone_count: number;
  task_count: number;
}

export function previewExcelPlan(file: File) {
  const body = new FormData();
  body.append("file", file);
  return aiFetch<PlanPreview>("/projects/import/plan/preview", { method: "POST", body });
}

export function confirmExcelPlan(rows: PlanRows, requestId: string) {
  return aiFetch<SavedPlan>("/projects/import/plan", {
    method: "POST",
    body: JSON.stringify({ ...rows, request_id: requestId }),
  });
}
