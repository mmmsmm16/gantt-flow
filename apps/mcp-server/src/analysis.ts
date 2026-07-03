// 工数/リードタイムの分析・示唆（読み取り専用の純関数）。お金より工数・LT・難易度・自動化に焦点。
// クリティカルパス算出は core/compare.ts の criticalPathDays と同型(finish DP)。ここでは「どの工程が
// LT を律速するか」を復元し、自動化候補・担当別負荷も出す。
import {
  computeCodes,
  formatMinutes,
  AUTOMATION_LABEL,
  leafLtDays,
  leafEffortMinutes,
  leafDifficulty,
  taskInPhase,
  depInPhase,
  type Core,
  type TaskDetail,
  type Id,
  type Project,
  type Phase,
} from '@gantt-flow/core';

function leafIds(core: Core, details: Record<Id, TaskDetail>, phase: Phase): Id[] {
  const hasChild = new Set<Id>();
  for (const t of Object.values(core.tasks)) if (t.parentId) hasChild.add(t.parentId);
  return Object.values(core.tasks)
    .filter((t) => !hasChild.has(t.id) && taskInPhase(details[t.id], phase))
    .map((t) => t.id);
}

// ---- クリティカルパス（LT を律速する工程列を復元） ----

export interface CriticalPath {
  totalDays: number;
  steps: { id: Id; days: number }[];
}

export function computeCriticalPath(core: Core, details: Record<Id, TaskDetail>, phase: Phase): CriticalPath {
  const ids = Object.keys(core.tasks).filter((id) => taskInPhase(details[id], phase));
  const inPhase = new Set(ids);
  const weight = new Map<Id, number>(ids.map((id) => [id, leafLtDays(details[id], phase)]));
  const deps = Object.values(core.dependencies).filter(
    (d) => depInPhase(phase, d.phase) && inPhase.has(d.from) && inPhase.has(d.to),
  );
  const finish = new Map<Id, number>(ids.map((id) => [id, weight.get(id) ?? 0]));
  for (let iter = 0; iter < ids.length; iter++) {
    let changed = false;
    for (const d of deps) {
      const cand = (finish.get(d.from) ?? 0) + (weight.get(d.to) ?? 0);
      if (cand > (finish.get(d.to) ?? 0)) {
        finish.set(d.to, cand);
        changed = true;
      }
    }
    if (!changed) break;
  }
  // 終端（最大 finish）から先行を辿って経路を復元。
  let end: Id | undefined;
  let max = 0;
  for (const id of ids) {
    const f = finish.get(id) ?? 0;
    if (f >= max) {
      max = f;
      end = id;
    }
  }
  const steps: { id: Id; days: number }[] = [];
  let cur = end;
  const seen = new Set<Id>();
  while (cur && !seen.has(cur)) {
    const node: Id = cur; // クロージャで絞り込みが外れないよう確定させる
    seen.add(node);
    const w = weight.get(node) ?? 0;
    steps.unshift({ id: node, days: w });
    if ((finish.get(node) ?? 0) <= w) break; // 先行の寄与なし＝経路の起点
    cur = deps
      .filter((d) => d.to === node)
      .map((d) => d.from)
      .find((f) => (finish.get(f) ?? 0) + w === (finish.get(node) ?? 0));
  }
  return { totalDays: max, steps };
}

export function formatCriticalPath(project: Project, phase: Phase): string {
  const { core, details } = project;
  const cp = computeCriticalPath(core, details, phase);
  if (cp.steps.length === 0) return 'クリティカルパスを構成する工程がありません（依存とリードタイムを入力してください）。';
  const codes = computeCodes(core);
  const lines = cp.steps.map((s) => {
    const t = core.tasks[s.id];
    const d = details[s.id];
    const wait = d?.ltDays !== undefined && d?.effortMinutes !== undefined ? d.ltDays - d.effortMinutes / (60 * 8) : undefined;
    const waitNote = wait !== undefined && wait > 0.05 ? ` うち待ち≒${Math.round(wait * 10) / 10}日` : '';
    return `  ${codes[s.id] ?? '?'} ${t?.name ?? s.id} … ${s.days}日${waitNote}  {id:${s.id}}`;
  });
  return [
    `リードタイム(${phase === 'tobe' ? 'To-Be' : 'As-Is'})＝クリティカルパス: ${Math.round(cp.totalDays * 10) / 10}日`,
    `律速する工程列（ここを短縮/並行化すると LT が縮む）:`,
    ...lines,
  ].join('\n');
}

// ---- 自動化/形式知化の候補（手作業×高工数×ベテラン依存） ----

export function formatAutomationCandidates(project: Project): string {
  const { core, details } = project;
  const codes = computeCodes(core);
  const leaves = leafIds(core, details, 'asis');
  const scored = leaves
    .map((id) => {
      const d = details[id];
      const eff = d?.effortMinutes ?? 0;
      const manual = (d?.automation ?? 'manual') === 'manual';
      const hard = d?.difficulty === 'H';
      // スコア: 手作業ほど・工数が大きいほど・ベテラン依存ほど高い（形式知化/自動化の効きが大きい）。
      const score = (manual ? 1 : d?.automation === 'partial' ? 0.4 : 0) * eff * (hard ? 2 : d?.difficulty === 'M' ? 1.2 : 1);
      return { id, eff, manual, hard, automation: d?.automation, score, hasHow: !!d?.how?.trim() };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 15);
  if (scored.length === 0) return '自動化候補（手作業の工程）がありません。工数・自動化区分を入力すると検出できます。';
  const lines = scored.map((x) => {
    const t = core.tasks[x.id];
    const tags = [
      x.manual ? '手作業' : x.automation === 'partial' ? '一部自動' : '',
      x.hard ? 'ベテラン依存(H)' : '',
      x.hasHow ? '' : '手順未形式知化',
    ]
      .filter(Boolean)
      .join('・');
    return `  ${codes[x.id] ?? '?'} ${t?.name ?? x.id}（${formatMinutes(x.eff)}${tags ? ' / ' + tags : ''}）  {id:${x.id}}`;
  });
  return ['自動化/形式知化の候補（効き目の大きい順＝手作業×高工数×ベテラン依存）:', ...lines].join('\n');
}

// ---- 担当別の負荷（ボトルネック人員） ----

export function formatWorkload(project: Project, phase: Phase): string {
  const { core, details } = project;
  const leaves = leafIds(core, details, phase);
  type Agg = { effort: number; count: number; hard: number };
  const byAssignee = new Map<string, Agg>();
  for (const id of leaves) {
    const t = core.tasks[id];
    const key = t?.assigneeId ?? '__none__';
    const a = byAssignee.get(key) ?? { effort: 0, count: 0, hard: 0 };
    a.effort += leafEffortMinutes(details[id], phase);
    a.count += 1;
    if (leafDifficulty(details[id], phase) === 'H') a.hard += 1;
    byAssignee.set(key, a);
  }
  if (byAssignee.size === 0) return '担当別の負荷を出す末端工程がありません。';
  const rows = [...byAssignee.entries()]
    .map(([key, a]) => ({
      name: key === '__none__' ? '(担当未設定)' : core.assignees[key]?.name ?? key,
      ...a,
    }))
    .sort((a, b) => b.effort - a.effort);
  const total = rows.reduce((s, r) => s + r.effort, 0) || 1;
  const lines = rows.map(
    (r) => `  ${r.name}: ${formatMinutes(r.effort)}（${Math.round((100 * r.effort) / total)}% / ${r.count}工程${r.hard ? ` / ベテラン依存${r.hard}` : ''}）`,
  );
  return [`担当別の負荷(${phase === 'tobe' ? 'To-Be' : 'As-Is'})・工数の多い順（偏り＝ボトルネック人員）:`, ...lines].join('\n');
}
