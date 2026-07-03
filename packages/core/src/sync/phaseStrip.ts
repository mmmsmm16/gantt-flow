// フェーズ帯（大工程ヘッダストリップ）の導出（docs/superpowers/specs/2026-07-03-phase-strip-design.md）。
// 表示中のタスクノードの祖先をたどり、大工程ごとに x 範囲の帯を計算する。保存しない。
// bands.ts と同じ導出パターンだが、こちらは上部の固定帯用に x 軸のみ・大工程のみ。
import type { Core, FlowLevelView, FlowTaskNode, Id } from '../model/types';
import { SIZE } from './autoPlace';

export interface PhaseSegment {
  taskId: Id; // フェーズ＝大工程タスク
  label: string;
  x: number;
  width: number;
}

const PAD_X = 12; // bands.ts の帯と同じ左右余白

export function derivePhaseStrip(core: Core, view: FlowLevelView): PhaseSegment[] {
  if (view.level === 'large') return []; // ノード自体がフェーズなので帯は出さない
  const taskNodes = Object.values(view.nodes).filter((n): n is FlowTaskNode => n.kind === 'task');
  const acc = new Map<Id, { minX: number; maxX: number }>();

  for (const node of taskNodes) {
    const right = node.x + SIZE.task.w;
    let parentId = core.tasks[node.taskId]?.parentId;
    const visited = new Set<Id>(); // 親参照に循環があっても止まる（bands.ts と同じ保険）
    while (parentId && !visited.has(parentId)) {
      visited.add(parentId);
      const ancestor = core.tasks[parentId];
      if (!ancestor) break;
      if (ancestor.level === 'large') {
        const cur = acc.get(parentId);
        if (cur) {
          cur.minX = Math.min(cur.minX, node.x);
          cur.maxX = Math.max(cur.maxX, right);
        } else {
          acc.set(parentId, { minX: node.x, maxX: right });
        }
        break;
      }
      parentId = ancestor.parentId;
    }
  }

  const segs: PhaseSegment[] = [];
  for (const [taskId, v] of acc) {
    segs.push({
      taskId,
      label: core.tasks[taskId]!.name,
      x: v.minX - PAD_X,
      width: v.maxX - v.minX + PAD_X * 2,
    });
  }
  // 重なりは許容（依存順レイアウトでは大工程ごとの x 範囲は排他でない）。詰め直さない。
  segs.sort((a, b) => a.x - b.x || a.taskId.localeCompare(b.taskId));
  return segs;
}
