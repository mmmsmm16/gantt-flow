// マイルストーン縦線の導出（bands パターン・保存しない）。spec: docs/superpowers/specs/2026-07-04-milestone-design.md
import type { Core, FlowLevelView, FlowTaskNode, Id, ProcessLevel } from '../model/types';
import { SIZE } from './autoPlace';
import { isMilestone } from '../milestone';

export interface MilestoneGuide {
  taskId: Id;
  label: string;
  x: number; // 縦線の x（モデル座標）
  bound: boolean; // 対象工程あり＝自動追従中
}

const MARGIN = 40; // 対象工程の右端から縦線までの余白
const RANK: Record<ProcessLevel, number> = { large: 0, medium: 1, small: 2, detail: 3 };

// v2 粒度非依存化: 対象工程 targetId をこのビューでの「代表ノード」群へ変換する。
// - 直接そのビューに居ればそれ自身。
// - このビューが対象より細かい（下位の粒度）→ 対象の子孫でこのビューに見えているノード群
//   （直接の子ではなく再帰的に辿る。深い階層でも中間粒度の可視ノードを取りこぼさない）。
// - このビューが対象より粗い（上位の粒度）→ 対象の祖先を辿って最初に見つかる可視ノード。
function representatives(
  core: Core,
  view: FlowLevelView,
  nodeByTask: Map<Id, FlowTaskNode>,
  targetId: Id,
): FlowTaskNode[] {
  const direct = nodeByTask.get(targetId);
  if (direct) return [direct];
  const target = core.tasks[targetId];
  if (!target) return [];

  if (RANK[view.level] > RANK[target.level]) {
    // ビューの方が細かい: 子孫を再帰的に辿り、可視ノードをすべて集める（循環ガード付き）。
    const out: FlowTaskNode[] = [];
    const visited = new Set<Id>();
    const walk = (id: Id): void => {
      for (const child of Object.values(core.tasks)) {
        if (child.parentId !== id || visited.has(child.id)) continue;
        visited.add(child.id);
        const n = nodeByTask.get(child.id);
        if (n) out.push(n);
        walk(child.id);
      }
    };
    walk(targetId);
    return out;
  }

  if (RANK[view.level] < RANK[target.level]) {
    // ビューの方が粗い: 祖先を辿って最初に見つかる可視ノード（循環ガード付き）。
    let parentId = target.parentId;
    const visited = new Set<Id>();
    while (parentId && !visited.has(parentId)) {
      visited.add(parentId);
      const ancestor = core.tasks[parentId];
      if (!ancestor) break;
      const n = nodeByTask.get(parentId);
      if (n) return [n];
      parentId = ancestor.parentId;
    }
    return [];
  }

  return [];
}

export function deriveMilestoneGuides(core: Core, view: FlowLevelView): MilestoneGuide[] {
  const taskNodes = Object.values(view.nodes).filter((n): n is FlowTaskNode => n.kind === 'task');
  const nodeByTask = new Map(taskNodes.map((n) => [n.taskId, n]));
  const out: MilestoneGuide[] = [];
  for (const n of taskNodes) {
    if (!isMilestone(core, n.taskId)) continue;
    const t = core.tasks[n.taskId]!;
    const boundDeps = Object.values(core.dependencies).filter((d) => d.to === t.id);
    const bound = boundDeps.length > 0;
    const xs = boundDeps
      .flatMap((d) => representatives(core, view, nodeByTask, d.from))
      .map((sn) => sn.x + SIZE.task.w);
    out.push({ taskId: t.id, label: t.name, x: xs.length > 0 ? Math.max(...xs) + MARGIN : n.x, bound });
  }
  out.sort((a, b) => a.x - b.x || a.taskId.localeCompare(b.taskId));
  return out;
}
