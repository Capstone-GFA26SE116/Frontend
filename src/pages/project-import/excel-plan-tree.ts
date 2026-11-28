import type { PlanRow, PlanRows } from "../../lib/excel-plan-api";

export type RowKind = keyof PlanRows;

export function projectKey(row: PlanRow) {
  return row.project_code.trim().toLowerCase();
}

export function milestoneKey(row: PlanRow) {
  return JSON.stringify([projectKey(row), row.milestone_code.trim().toLowerCase()]);
}

function group(rows: PlanRow[], key: (row: PlanRow) => string) {
  const index = new Map<string, PlanRow[]>();
  for (const row of rows) {
    const value = key(row);
    const bucket = index.get(value) ?? [];
    bucket.push(row);
    index.set(value, bucket);
  }
  return index;
}

export function indexPlan(rows: PlanRows) {
  const projects = group(rows.projects, projectKey);
  const milestones = group(rows.milestones, milestoneKey);
  const byProject = group(rows.milestones, projectKey);
  const byMilestone = group(rows.tasks, milestoneKey);
  const projectIsUnique = (row: PlanRow) =>
    projectKey(row) !== "" && projects.get(projectKey(row))?.length === 1;
  const milestoneIsUnique = (row: PlanRow) =>
    row.milestone_code.trim() !== "" && milestones.get(milestoneKey(row))?.length === 1;
  return {
    milestonesFor(project: PlanRow) {
      return projectIsUnique(project) ? byProject.get(projectKey(project)) ?? [] : [];
    },
    tasksFor(milestone: PlanRow) {
      return projectIsUnique(milestone) && milestoneIsUnique(milestone)
        ? byMilestone.get(milestoneKey(milestone)) ?? []
        : [];
    },
    orphanMilestones: rows.milestones.filter((row) => !projectIsUnique(row)),
    orphanTasks: rows.tasks.filter((row) => !projectIsUnique(row) || !milestoneIsUnique(row)),
  };
}

export function selectedRows(rows: PlanRows, excluded: ReadonlySet<string>): PlanRows {
  const tree = indexPlan(rows);
  const dropped = new Set(excluded);
  for (const project of rows.projects) {
    if (dropped.has(project.source)) {
      for (const milestone of tree.milestonesFor(project)) dropped.add(milestone.source);
    }
  }
  for (const milestone of rows.milestones) {
    if (dropped.has(milestone.source)) {
      for (const task of tree.tasksFor(milestone)) dropped.add(task.source);
    }
  }
  const keep = (row: PlanRow) => !dropped.has(row.source);
  return {
    projects: rows.projects.filter(keep),
    milestones: rows.milestones.filter(keep),
    tasks: rows.tasks.filter(keep),
  };
}
