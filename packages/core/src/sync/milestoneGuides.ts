// マイルストーン縦線の導出（bands パターン・保存しない）。spec: docs/superpowers/specs/2026-07-04-milestone-design.md
import type { Core, FlowLevelView, FlowTaskNode, Id } from '../model/types';
import { SIZE } from './autoPlace';
import { isMilestone } from '../milestone';

export interface MilestoneGuide {
  taskId: Id;
  label: string;
  x: number; // 縦線の x（モデル座標）
  bound: boolean; // 対象工程あり＝自動追従中
}

const MARGIN = 40; // 対象工程の右端から縦線までの余白

export function deriveMilestoneGuides(core: Core, view: FlowLevelView): MilestoneGuide[] {
  const taskNodes = Object.values(view.nodes).filter((n): n is FlowTaskNode => n.kind === 'task');
  const nodeByTask = new Map(taskNodes.map((n) => [n.taskId, n]));
  const out: MilestoneGuide[] = [];
  for (const n of taskNodes) {
    if (!isMilestone(core, n.taskId)) continue;
    const t = core.tasks[n.taskId]!;
    const xs = Object.values(core.dependencies)
      .filter((d) => d.to === t.id)
      .map((d) => nodeByTask.get(d.from))
      .filter((sn): sn is FlowTaskNode => !!sn)
      .map((sn) => sn.x + SIZE.task.w);
    const bound = xs.length > 0;
    out.push({ taskId: t.id, label: t.name, x: bound ? Math.max(...xs) + MARGIN : n.x, bound });
  }
  out.sort((a, b) => a.x - b.x || a.taskId.localeCompare(b.taskId));
  return out;
}
