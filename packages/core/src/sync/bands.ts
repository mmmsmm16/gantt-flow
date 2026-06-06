// 親範囲バンドの導出（`docs/02-data-model.md` §4・`docs/03-view-spec.md` §2-2）。
// 表示中の粒度ノードの祖先をたどり、中工程・大工程ごとに横方向の帯（範囲）を計算する。保存しない。
import type { Core, FlowLevelView, FlowTaskNode, Id, ProcessLevel } from '../model/types';
import { SIZE } from './autoPlace';

export interface Band {
  taskId: Id; // 祖先タスク（この帯が表す中/大工程）
  level: ProcessLevel;
  depth: number; // 表示粒度から見た上方向の距離（1 = 直上の親）
  x: number;
  width: number;
  label: string; // 祖先の作業名
}

export function deriveBands(core: Core, view: FlowLevelView): Band[] {
  const taskNodes = Object.values(view.nodes).filter((n): n is FlowTaskNode => n.kind === 'task');
  const acc = new Map<Id, { minX: number; maxX: number; depth: number }>();

  for (const node of taskNodes) {
    const right = node.x + SIZE.task.w;
    let parentId = core.tasks[node.taskId]?.parentId;
    let depth = 1;
    while (parentId) {
      const ancestor = core.tasks[parentId];
      if (!ancestor) break;
      const cur = acc.get(parentId);
      if (cur) {
        cur.minX = Math.min(cur.minX, node.x);
        cur.maxX = Math.max(cur.maxX, right);
      } else {
        acc.set(parentId, { minX: node.x, maxX: right, depth });
      }
      parentId = ancestor.parentId;
      depth += 1;
    }
  }

  const bands: Band[] = [];
  for (const [taskId, v] of acc) {
    const a = core.tasks[taskId]!;
    bands.push({ taskId, level: a.level, depth: v.depth, x: v.minX, width: v.maxX - v.minX, label: a.name });
  }
  // 上位（深い）から、同深さは左から。入れ子で描けるよう安定ソート。
  bands.sort((a, b) => b.depth - a.depth || a.x - b.x || a.taskId.localeCompare(b.taskId));
  return bands;
}
