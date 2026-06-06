// Project 全体の同期（ストアが各編集後に呼ぶ「ストア更新」ステップ。`docs/01-architecture.md` §4）。
// flow.byLevel の各粒度ビューを現在の core/details に合わせて reconcile する純粋関数。
import { reconcileFlow } from './reconcileFlow';
import type { Project, ProcessLevel, Id, FlowLevelView } from '../model/types';
import type { IdGen } from '../ids';

export function reconcileProject(project: Project, idGen: IdGen): Project {
  const next = structuredClone(project);
  next.flow.byLevel = next.flow.byLevel.map(
    (view) => reconcileFlow(next.core, next.details, view, idGen).view,
  );
  return next;
}

// 指定粒度/スコープのビューが無ければ空で追加する（ユーザーがそのビューを開いた時に使う）。
export function ensureLevelView(
  project: Project,
  level: ProcessLevel,
  scopeParentId?: Id,
): Project {
  const exists = project.flow.byLevel.some(
    (v) => v.level === level && (v.scopeParentId ?? undefined) === (scopeParentId ?? undefined),
  );
  if (exists) return project;
  const next = structuredClone(project);
  const view: FlowLevelView = {
    level,
    nodes: {},
    edges: {},
    lanes: {},
    orientation: 'horizontal',
    ...(scopeParentId ? { scopeParentId } : {}),
  };
  next.flow.byLevel.push(view);
  return next;
}
