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
  top: number; // 帯の上端（メンバー工程の最上 − 余白）
  height: number; // 帯の高さ（メンバー工程の上下範囲に収める。レーン下端までは伸ばさない）
  label: string; // 祖先の作業名
}

export function deriveBands(core: Core, view: FlowLevelView): Band[] {
  const taskNodes = Object.values(view.nodes).filter((n): n is FlowTaskNode => n.kind === 'task');
  const acc = new Map<Id, { minX: number; maxX: number; minY: number; maxY: number; depth: number }>();

  for (const node of taskNodes) {
    const right = node.x + SIZE.task.w;
    const bottom = node.y + SIZE.task.h;
    let parentId = core.tasks[node.taskId]?.parentId;
    let depth = 1;
    while (parentId) {
      const ancestor = core.tasks[parentId];
      if (!ancestor) break;
      const cur = acc.get(parentId);
      if (cur) {
        cur.minX = Math.min(cur.minX, node.x);
        cur.maxX = Math.max(cur.maxX, right);
        cur.minY = Math.min(cur.minY, node.y);
        cur.maxY = Math.max(cur.maxY, bottom);
      } else {
        acc.set(parentId, { minX: node.x, maxX: right, minY: node.y, maxY: bottom, depth });
      }
      parentId = ancestor.parentId;
      depth += 1;
    }
  }

  // 入れ子（深いほど外側）に見えるよう、深さに応じて余白を広げる。
  // ラベルは帯の上端に出るので、上側は広めに取る（大工程の囲い名が見やすいように）。
  const PAD_X = 12;
  const PAD_TOP = 30;
  const PAD_BOTTOM = 14;
  const STEP = 15; // depth ごとに広げる量（大が中を包む。ラベルが重ならない間隔）
  const bands: Band[] = [];
  for (const [taskId, v] of acc) {
    const a = core.tasks[taskId]!;
    const grow = (v.depth - 1) * STEP;
    bands.push({
      taskId,
      level: a.level,
      depth: v.depth,
      x: v.minX - PAD_X - grow,
      width: v.maxX - v.minX + (PAD_X + grow) * 2,
      top: v.minY - PAD_TOP - grow,
      height: v.maxY - v.minY + PAD_TOP + PAD_BOTTOM + grow * 2,
      label: a.name,
    });
  }
  // 上位（深い）から、同深さは左から。入れ子で描けるよう安定ソート。
  bands.sort((a, b) => b.depth - a.depth || a.x - b.x || a.taskId.localeCompare(b.taskId));
  return bands;
}
