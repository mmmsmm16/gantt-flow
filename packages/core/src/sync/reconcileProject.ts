// Project 全体の同期（ストアが各編集後に呼ぶ「ストア更新」ステップ。`docs/01-architecture.md` §4）。
// flow.byLevel の各粒度ビューを現在の core/details に合わせて reconcile する純粋関数。
import { reconcileFlow, type SyncReport } from './reconcileFlow';
import type { Project, ProcessLevel, Id, FlowLevelView } from '../model/types';
import type { IdGen } from '../ids';

// ビュー単位の SyncReport。どのビューの報告かは level + scopeParentId で同定する
// （byLevel の添字は ensureLevelView の追加順に依存し安定しないため、添字では持たない）。
export interface ViewSyncReport {
  level: ProcessLevel;
  scopeParentId?: Id;
  report: SyncReport;
}

/** reconcileProject と同じ同期を行い、各ビューの SyncReport（追加/撤去ノード）も返す。
    UI 側が「同期でどこが変わったか」を示すための口（既存の reconcileProject はこの薄い包み）。 */
export function reconcileProjectWithReport(
  project: Project,
  idGen: IdGen,
): { project: Project; reports: ViewSyncReport[] } {
  // reconcileFlow は view を内部で clone する純関数なので、ここで flow まで deep clone すると
  // 各ビューを二重に複製してしまう。flow 以外だけ clone し、ビューは reconcileFlow に任せる。
  const next = structuredClone({ ...project, flow: { byLevel: [] as FlowLevelView[] } });
  const reports: ViewSyncReport[] = [];
  next.flow.byLevel = project.flow.byLevel.map((view) => {
    const r = reconcileFlow(next.core, next.details, view, idGen);
    reports.push({
      level: view.level,
      ...(view.scopeParentId ? { scopeParentId: view.scopeParentId } : {}),
      report: r.report,
    });
    return r.view;
  });
  return { project: next, reports };
}

export function reconcileProject(project: Project, idGen: IdGen): Project {
  return reconcileProjectWithReport(project, idGen).project;
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
