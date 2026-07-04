// 手順書タブのナビゲーション導出（決定論・保存しない）。spec: .superpowers/sdd/task-2-brief.md
import type { Core, Id, Manual } from '../model/types';

export interface ProcedureNavItem {
  taskId: Id;
  name: string;
  layer: number; // トポロジ層（0..）。同一 layer = 並行
  parallel: boolean; // 同一 layer に他工程がある
  hasProcedure: boolean; // manual.procedures[taskId] が存在し steps.length > 0
}

// midId 配下の末端工程（子を持たない task）を再帰収集する（milestoneGuides.ts の walk 雛形と同型）。
// 循環（親子関係の破損）があっても visited ガードで止まる。
function collectLeaves(core: Core, midId: Id): Id[] {
  const out: Id[] = [];
  const visited = new Set<Id>();
  const walk = (id: Id): void => {
    for (const child of Object.values(core.tasks)) {
      if (child.parentId !== id || visited.has(child.id)) continue;
      visited.add(child.id);
      const hasChild = Object.values(core.tasks).some((t) => t.parentId === child.id);
      if (hasChild) walk(child.id);
      else out.push(child.id);
    }
  };
  walk(midId);
  return out;
}

export function deriveProcedureNav(core: Core, midId: Id, manual: Manual): ProcedureNavItem[] {
  const leafIds = collectLeaves(core, midId);
  const leafSet = new Set(leafIds);

  // 末端集合内の依存（両端が集合内）だけで longest-path のレイヤを作る（tidy.ts と同じ反復緩和）。
  const deps = Object.values(core.dependencies).filter((d) => leafSet.has(d.from) && leafSet.has(d.to));
  const layer = new Map<Id, number>();
  for (const id of leafIds) layer.set(id, 0);
  for (let iter = 0; iter < leafIds.length; iter++) {
    let changed = false;
    for (const d of deps) {
      const nl = (layer.get(d.from) ?? 0) + 1;
      if (nl > (layer.get(d.to) ?? 0)) {
        layer.set(d.to, nl);
        changed = true;
      }
    }
    if (!changed) break;
  }

  // (layer, order, taskId) の安定ソートで直列化。
  const sorted = [...leafIds].sort((a, b) => {
    const la = layer.get(a) ?? 0;
    const lb = layer.get(b) ?? 0;
    if (la !== lb) return la - lb;
    const oa = core.tasks[a]?.order ?? 0;
    const ob = core.tasks[b]?.order ?? 0;
    if (oa !== ob) return oa - ob;
    return a.localeCompare(b);
  });

  const layerCounts = new Map<number, number>();
  for (const id of leafIds) {
    const l = layer.get(id) ?? 0;
    layerCounts.set(l, (layerCounts.get(l) ?? 0) + 1);
  }

  return sorted.map((taskId) => {
    const l = layer.get(taskId) ?? 0;
    return {
      taskId,
      name: core.tasks[taskId]?.name ?? '',
      layer: l,
      parallel: (layerCounts.get(l) ?? 0) > 1,
      hasProcedure: (manual.procedures[taskId]?.steps.length ?? 0) > 0,
    };
  });
}
