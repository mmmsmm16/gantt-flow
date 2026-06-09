// フローの自動整列（明示的なレイアウト操作）。reconcile と違い「手動配置を保持しない」のが目的で、
// ユーザーが「整列」を押したときだけ呼ぶ純粋関数。依存の前後関係で左→右に段（layer）を作り、
// 担当レーンで縦位置を決める。付随オブジェクト（帳票/情報/課題）は工程ノードへ再吸着する。
import type { Core, TaskDetail, FlowLevelView, FlowTaskNode, Id } from '../model/types';
import { SIZE, placeInputDoc, placeOutputDoc, placeClear, obstaclesFor } from './autoPlace';
import { laneTaskBaseY, LANE_DEFAULT_H } from './lanes';

const MARGIN_X = 120;
const COL_W = 220;
const ROW_SUB = SIZE.task.h + 20; // 並行（同レーン同段）工程を縦に積む間隔
const LANE_PAD = LANE_DEFAULT_H - ROW_SUB; // 1 段なら既定高さに一致するよう調整

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
  // 全体スコープ（中/小/詳細で scope 未指定＝親横断ビュー）では reconcileFlow と同様、
  // 親をまたいだ依存もすべて対象にする。これを忘れると依存が認識されず全工程が col0 に
  // 縦積みされる（＝「依存があるのに縦に整列される」バグ）。
  const allScope = view.scopeParentId === undefined && view.level !== 'large';
  const deps = Object.values(core.dependencies).filter(
    (d) =>
      (allScope || sameScope(d.scopeParentId, view.scopeParentId)) &&
      idsInView.has(d.from) &&
      idsInView.has(d.to),
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

  // 決定論順。同一（レーン×段）に同居する工程は「並行」とみなし、サブ行（slot）へ縦積み。
  const sorted = [...taskNodes].sort((a, b) => {
    const ta = core.tasks[a.taskId];
    const tb = core.tasks[b.taskId];
    return (ta?.order ?? 0) - (tb?.order ?? 0) || a.taskId.localeCompare(b.taskId);
  });

  // 整列の対象から外すノード:
  //  ・固定(pinned) … ユーザーが位置を確定したもの（並行配置など）→ 動かさない。
  //  ・無依存(孤立) … 前後関係が一切無い工程 → 縦に積まずに、置いた位置のまま残す（謎の縦整列を防ぐ）。
  const hasDep = (taskId: Id): boolean => deps.some((d) => d.from === taskId || d.to === taskId);
  const layoutNodes = sorted.filter((n) => !n.pinned && hasDep(n.taskId));

  // パス1: 各ノードの 段(col)・レーン(order)・サブ行(slot) を決め、レーンごとの最大サブ行数を集計。
  const place = new Map<Id, { col: number; lane: number; slot: number }>();
  const slotCount = new Map<string, number>();
  const laneRows = new Map<number, number>();
  for (const node of layoutNodes) {
    const col = layer.get(node.taskId) ?? 0;
    const lane = laneOrderOf(node.taskId);
    const key = `${lane}:${col}`;
    const slot = slotCount.get(key) ?? 0;
    slotCount.set(key, slot + 1);
    place.set(node.id, { col, lane, slot });
    laneRows.set(lane, Math.max(laneRows.get(lane) ?? 1, slot + 1));
  }

  // レーン高さ＝並行度に合わせて拡縮（並行があるレーンだけ太く・逐次なら既定のまま）。
  for (const lane of Object.values(next.lanes)) {
    const rows = laneRows.get(lane.order) ?? 1;
    lane.height = Math.max(LANE_DEFAULT_H, LANE_PAD + rows * ROW_SUB);
  }

  // パス2: 確定したレーン高さ（累積）を使ってノード座標を決める（固定・孤立は触らない）。
  for (const node of layoutNodes) {
    const p = place.get(node.id)!;
    node.x = MARGIN_X + p.col * COL_W;
    node.y = laneTaskBaseY(next.lanes, p.lane) + p.slot * ROW_SUB;
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
      const pos = placeClear(
        owner,
        obstaclesFor(
          Object.values(next.nodes).filter((m) => m.id !== n.id),
          Object.values(next.edges),
        ),
      );
      n.x = pos.x;
      n.y = pos.y;
    }
  }

  return next;
}
