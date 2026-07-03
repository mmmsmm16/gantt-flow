// 参照整合性チェック（`docs/02-data-model.md` §6）。壊れた参照を列挙する（呼び出し側が quarantine 等に使う）。
import type { Project } from './model/types';
import { isMilestone } from './milestone';

export interface ValidationIssue {
  kind: string;
  ref: string;
  message: string;
}

export function validate(project: Project): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const { tasks, dependencies } = project.core;

  // 依存の端点が実在
  for (const d of Object.values(dependencies)) {
    if (!tasks[d.from]) issues.push({ kind: 'dependency.from', ref: d.id, message: `from ${d.from} が存在しない` });
    if (!tasks[d.to]) issues.push({ kind: 'dependency.to', ref: d.id, message: `to ${d.to} が存在しない` });
  }

  // parentId が実在 + 循環なし（木である）
  for (const t of Object.values(tasks)) {
    if (t.parentId && !tasks[t.parentId]) {
      issues.push({ kind: 'task.parent', ref: t.id, message: `parentId ${t.parentId} が存在しない` });
    }
  }
  for (const t of Object.values(tasks)) {
    const seen = new Set<string>();
    let cur = t.parentId;
    while (cur) {
      if (cur === t.id || seen.has(cur)) {
        issues.push({ kind: 'task.cycle', ref: t.id, message: '親子関係に循環がある' });
        break;
      }
      seen.add(cur);
      cur = tasks[cur]?.parentId;
    }
  }

  // 詳細の taskId が実在
  for (const d of Object.values(project.details)) {
    if (!tasks[d.taskId]) issues.push({ kind: 'detail.task', ref: d.taskId, message: '対応タスクが存在しない' });
  }

  // マイルストーンは子を持てない・出依存を張れない（WARN: FATAL_ISSUE_KINDS に含めない＝再オープンは可能）
  for (const t of Object.values(tasks)) {
    if (t.parentId && isMilestone(project.core, t.parentId)) {
      issues.push({ kind: 'milestone.child', ref: t.id, message: `親 ${t.parentId} がマイルストーンで子を持てない` });
    }
  }
  for (const d of Object.values(dependencies)) {
    if (isMilestone(project.core, d.from)) {
      issues.push({ kind: 'milestone.outgoing', ref: d.id, message: `from ${d.from} はマイルストーンで出依存を張れない` });
    }
  }

  return issues;
}
