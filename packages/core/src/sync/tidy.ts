// フローの自動整列（明示的なレイアウト操作）。reconcile と違い「手動配置を保持しない」のが目的で、
// ユーザーが「整列」を押したときだけ呼ぶ純粋関数。依存の前後関係で左→右に段（layer）を作り、
// 担当レーンで縦位置を決める。付随オブジェクト（帳票/情報/課題）は工程ノードへ再吸着する。
import type { Core, TaskDetail, FlowLevelView, FlowTaskNode, Id } from '../model/types';
import { SIZE, placeInputDoc, placeOutputDoc, placeClear } from './autoPlace';

const MARGIN_X = 120;
const MARGIN_Y = 40;
const COL_W = 220;
const ROW_H = 120;

const sameScope = (a: Id | undefined, b: Id | undefined): boolean =>
  (a ?? undefined) === (b ?? undefined);

export function tidyFlowView(
  core: Core,
  details: Record<Id, TaskDetail>,
  view: FlowLevelView,
): FlowLevelView {
  const next: FlowLevelView = structuredClone(view);
  const taskNodes = Object.values(next.nodes).filter((n): n is FlowTaskNode => n.kind === 'task');
  const idsInView = new Set(taskNodes.map((n) => n.taskId));

  // 依存（このスコープ・両端が表示中）で longest-path 段組み。
  const deps = Object.values(core.dependencies).filter(
    (d) => sameScope(d.scopeParentId, view.scopeParentId) && idsInView.has(d.from) && idsInView.has(d.to),
  );
  const layer = new Map<Id, number>();
  for (const n of taskNodes) layer.set(n.taskId, 0);
  for (let iter = 0; iter < taskNodes.length; iter++) {
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

  // レーン順（担当）→ 縦位置。未割当は最上段。
  const laneOrderByAssignee = new Map<Id, number>();
  for (const lane of Object.values(next.lanes)) {
    if (lane.assigneeId) laneOrderByAssignee.set(lane.assigneeId, lane.order);
  }
  const laneOrderOf = (taskId: Id): number => {
    const a = core.tasks[taskId]?.assigneeId;
    return a ? laneOrderByAssignee.get(a) ?? 0 : 0;
  };

  // 決定論順に配置。同一（レーン×段）が重なるときは縦に少しずらす。
  const sorted = [...taskNodes].sort((a, b) => {
    const ta = core.tasks[a.taskId];
    const tb = core.tasks[b.taskId];
    return (ta?.order ?? 0) - (tb?.order ?? 0) || a.taskId.localeCompare(b.taskId);
  });
  const slotCount = new Map<string, number>();
  for (const node of sorted) {
    const col = layer.get(node.taskId) ?? 0;
    const row = laneOrderOf(node.taskId);
    const key = `${row}:${col}`;
    const slot = slotCount.get(key) ?? 0;
    slotCount.set(key, slot + 1);
    node.x = MARGIN_X + col * COL_W;
    node.y = MARGIN_Y + row * ROW_H + slot * (SIZE.task.h + 14);
  }

  // 付随オブジェクトを工程ノードへ再吸着（帳票/情報＝角、課題＝空きスペース）。
  const taskNodeByTask = new Map<Id, FlowTaskNode>();
  for (const n of Object.values(next.nodes)) if (n.kind === 'task') taskNodeByTask.set(n.taskId, n);

  for (const taskId of idsInView) {
    const owner = taskNodeByTask.get(taskId);
    if (!owner) continue;
    const d = details[taskId];
    const inputs = d?.inputs ?? [];
    const outputs = d?.outputs ?? [];
    const inIndex = new Map(inputs.map((it, i) => [it.id, i]));
    const outIndex = new Map(outputs.map((it, i) => [it.id, i]));
    for (const n of Object.values(next.nodes)) {
      if (n.kind === 'doc' && n.taskId === taskId) {
        const pos =
          n.io === 'input'
            ? placeInputDoc(owner, inIndex.get(n.ioId) ?? 0)
            : placeOutputDoc(owner, outIndex.get(n.ioId) ?? 0);
        n.x = pos.x;
        n.y = pos.y;
      }
    }
  }
  // 課題ノードは他ノード確定後にまとめて空きへ寄せる（衝突回避）。
  for (const n of Object.values(next.nodes)) {
    if (n.kind === 'issue') {
      const owner = taskNodeByTask.get(n.taskId);
      if (!owner) continue;
      const pos = placeClear(owner, Object.values(next.nodes).filter((m) => m.id !== n.id));
      n.x = pos.x;
      n.y = pos.y;
    }
  }

  return next;
}
