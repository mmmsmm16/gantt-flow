// 参照整合性チェック（`docs/02-data-model.md` §6）。壊れた参照を列挙する（呼び出し側が quarantine 等に使う）。
import type { Project } from './model/types';
import { isMilestone } from './milestone';

export interface ValidationIssue {
  kind: string;
  ref: string;
  message: string;
}

// 読込を拒否すべき整合性問題の kind（依存の端点欠落・親欠落・親子循環）。
// detail.task の孤児詳細は実害がないので除外。persistence（読込拒否）と lint（error 昇格）が共有する。
export const FATAL_ISSUE_KINDS = new Set(['dependency.from', 'dependency.to', 'task.parent', 'task.cycle']);

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

  // 手順書（WARN: いずれも FATAL_ISSUE_KINDS に含めない＝再オープンは可能）。
  // 末端でない工程に手順書がある（対象の孤児 doc は deleteTask 掃除済み前提なのでスキップ）。
  for (const taskId of Object.keys(project.manual.procedures)) {
    if (!tasks[taskId]) continue;
    const hasChild = Object.values(tasks).some((t) => t.parentId === taskId);
    if (hasChild) {
      issues.push({ kind: 'procedure.nonLeaf', ref: taskId, message: `工程 ${taskId} は末端でない（子を持つ）ため手順書の対象外` });
    }
  }
  // cond の飛び先 / asset 参照のダングリング（削除では消さない＝ここでリンク切れを警告する）。
  for (const doc of Object.values(project.manual.procedures)) {
    for (const step of doc.steps) {
      for (const cond of step.conds) {
        if (cond.targetTaskId && !tasks[cond.targetTaskId]) {
          issues.push({ kind: 'procedure.danglingTarget', ref: step.id, message: `飛び先 ${cond.targetTaskId} が存在しない` });
        }
      }
      for (const ref of step.refs) {
        if (ref.kind === 'asset' && !project.manual.assets[ref.assetId]) {
          issues.push({ kind: 'procedure.danglingAsset', ref: step.id, message: `資料 ${ref.assetId} が資料台帳に存在しない` });
        }
      }
    }
  }

  return issues;
}
