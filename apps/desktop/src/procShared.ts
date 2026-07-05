// 手順書系ビュー（ProcedureView・handbook）で共有するローカルヘルパ。
// ProcedureView.tsx:18-85 から移設（構造ヘルパは実装そのまま・resolveRef は project 引数へ整理し
// icon/tone は呼び出し側が StepRef['kind'] から作る＝表示ロジックは呼び出し側据え置きで挙動不変）。
import type { Core, Id, Project, ProcessTask, StepRef } from '@gantt-flow/core';

export const hasChildren = (core: Core, id: Id): boolean =>
  Object.values(core.tasks).some((t) => (t.parentId ?? undefined) === id);

export const isLeaf = (core: Core, id: Id): boolean => !!core.tasks[id] && !hasChildren(core, id);

// taskId を含む「中工程」（子があれば自身・末端なら親、無ければ自身）。
// 手順書タブの章ジャンプ（内部の jumpToTask / 外部の procedureFocus）で共有する。
export function midOf(core: Core, taskId: Id): Id | undefined {
  const t = core.tasks[taskId];
  if (!t) return undefined;
  if (hasChildren(core, taskId)) return taskId;
  return t.parentId && core.tasks[t.parentId] ? t.parentId : taskId;
}

// 祖先パス（root..parent、id 自身は含まない）。
export function ancestorsOf(core: Core, id: Id): ProcessTask[] {
  const out: ProcessTask[] = [];
  let cur = core.tasks[id]?.parentId;
  const guard = new Set<Id>();
  while (cur && core.tasks[cur] && !guard.has(cur)) {
    guard.add(cur);
    out.unshift(core.tasks[cur]!);
    cur = core.tasks[cur]!.parentId;
  }
  return out;
}

// 参照(StepRef)の表示解決（見つからない＝ダングリングは broken）。
export function resolveRef(
  project: Project,
  ref: StepRef,
): { label: string; broken: boolean; kind: StepRef['kind'] } {
  if (ref.kind === 'asset') {
    const a = project.manual.assets[ref.assetId];
    return { label: a?.name ?? '削除された資料', broken: !a, kind: 'asset' };
  }
  if (ref.kind === 'io') {
    const d = project.details[ref.taskId];
    const item = [...(d?.inputs ?? []), ...(d?.outputs ?? [])].find((i) => i.id === ref.ioId);
    return { label: item?.name ?? '消えた帳票', broken: !item, kind: 'io' };
  }
  const t = project.core.tasks[ref.taskId];
  return { label: t?.name ?? '消えた工程', broken: !t, kind: 'task' };
}
