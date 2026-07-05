// ComparisonDialog の集約リファクタ（perRow/struct/c を buildCompareReport へ置換）で
// 画面の数字が一切変わらないことを固定する。置換前にインラインで持っていた式を本テストへ
// 移植し、buildCompareReport から導出した表示形状（perRow/struct/c）と厳密一致を検証する。
import { describe, it, expect } from 'vitest';
import {
  createSampleProject,
  buildCompareReport,
  computeCompare,
  leafEffortMinutes,
  leafLtDays,
  type Project,
} from '@gantt-flow/core';

const gen = (prefix: string) => {
  let n = 0;
  return () => `${prefix}-${++n}`;
};

// サンプルへ To-Be 差分を数件入れて changed/lifecycle/移動/自動化の経路も通す。
function fixture(): Project {
  const base = createSampleProject(gen('cmp'));
  const leaves = Object.values(base.core.tasks).filter(
    (t) => !Object.values(base.core.tasks).some((c) => c.parentId === t.id),
  );
  const details = { ...base.details };
  const a = leaves[0];
  const b = leaves[1];
  if (a) details[a.id] = { ...details[a.id], taskId: a.id, toBe: { effortMinutes: 15, ltDays: 1, difficulty: 'L' } };
  if (b) details[b.id] = { ...details[b.id], taskId: b.id, toBe: { lifecycle: 'removed' } };
  return { ...base, details };
}

// ---- 置換前(インライン)の式を移植したもの ----
function oldPerRow(project: Project) {
  const tasks = Object.values(project.core.tasks);
  const hasChild = new Set(tasks.map((t) => t.parentId).filter(Boolean) as string[]);
  return tasks
    .filter((t) => !hasChild.has(t.id))
    .map((t) => {
      const d = project.details[t.id];
      const aEff = leafEffortMinutes(d, 'asis') / 60;
      const bEff = leafEffortMinutes(d, 'tobe') / 60;
      const aLt = leafLtDays(d, 'asis');
      const bLt = leafLtDays(d, 'tobe');
      return {
        id: t.id,
        name: t.name,
        owner: t.assigneeId ? project.core.assignees[t.assigneeId]?.name ?? '' : '',
        aEff,
        bEff,
        aLt,
        bLt,
        ltCut: aLt - bLt,
        changed: !!d?.toBe,
      };
    })
    .filter((r) => r.aEff || r.bEff || r.aLt || r.bLt);
}

function oldStruct(project: Project) {
  const added: string[] = [];
  const removed: string[] = [];
  const moved: string[] = [];
  for (const t of Object.values(project.core.tasks)) {
    const tb = project.details[t.id]?.toBe;
    if (!tb) continue;
    if (tb.lifecycle === 'added') added.push(t.name);
    else if (tb.lifecycle === 'removed') removed.push(t.name);
    if (tb.assigneeId && tb.assigneeId !== t.assigneeId) moved.push(t.name);
  }
  const parallelized = Object.values(project.core.dependencies).filter((d) => d.phase === 'asis').length;
  return { added, removed, moved, parallelized };
}

// buildCompareReport から画面の perRow 形状を導出（ComparisonDialog の adapter と同一）。
function newPerRow(project: Project) {
  return buildCompareReport(project.core, project.details).rows.map((r) => {
    const t = project.core.tasks[r.taskId];
    return {
      id: r.taskId,
      name: r.name,
      owner: t?.assigneeId ? project.core.assignees[t.assigneeId]?.name ?? '' : '',
      aEff: r.effortMinutes.asis / 60,
      bEff: r.effortMinutes.tobe / 60,
      aLt: r.ltDays.asis,
      bLt: r.ltDays.tobe,
      ltCut: r.ltCutDays,
      changed: r.changed,
    };
  });
}

describe('ComparisonDialog 集約リファクタの数字不変性', () => {
  it('perRow（工程別差分）が置換前後で厳密一致する', () => {
    const p = fixture();
    expect(newPerRow(p)).toEqual(oldPerRow(p));
  });

  it('struct（構造差分）が置換前後で厳密一致する', () => {
    const p = fixture();
    expect(buildCompareReport(p.core, p.details).struct).toEqual(oldStruct(p));
  });

  it('c（KPI）＝ report.totals が computeCompare と厳密一致する', () => {
    const p = fixture();
    expect(buildCompareReport(p.core, p.details).totals).toEqual(computeCompare(p.core, p.details));
  });
});
