// フロー図の幾何編集（デザイン微修正）。矢印の経路は edgeRoute が node位置+障害物から決定論で
// 算出するため“データ”が無く直接編集できない。代わりに保存データである「ノード位置・pin・
// レーン高さ・向き」を編集し、ノードを動かせば矢印は自動追従する。各関数は (project)=>project' の
// 純関数を返し、session.apply（reconcile→保存）に渡す。reconcile は既存ノードの x/y を保持する。
import {
  computeCodes,
  tidyFlowView,
  type Project,
  type ProcessLevel,
  type Id,
  type FlowLevelView,
  type FlowTaskNode,
  type Orientation,
} from '@gantt-flow/core';

const LANE_MIN_H = 72; // packages/core lanes.ts の LANE_MIN_H と揃える

export function findFlowView(
  p: Project,
  level: ProcessLevel,
  scope?: Id,
): FlowLevelView | undefined {
  return p.flow.byLevel.find(
    (v) => v.level === level && (v.scopeParentId ?? undefined) === (scope ?? undefined),
  );
}

function requireView(p: Project, level: ProcessLevel, scope?: Id): FlowLevelView {
  const v = findFlowView(p, level, scope);
  if (!v) throw new Error(`フロービューがありません（粒度: ${level}）。get_flow_mermaid で利用可能な粒度を確認してください。`);
  return v;
}

function requireTaskNode(v: FlowLevelView, taskId: Id): FlowTaskNode {
  const n = Object.values(v.nodes).find(
    (x): x is FlowTaskNode => x.kind === 'task' && x.taskId === taskId,
  );
  if (!n) throw new Error(`この粒度のフローに工程ノードがありません: ${taskId}（list_flow_layout で位置を確認）`);
  return n;
}

/** 工程ノードを絶対座標へ移動。 */
export function setNodePosition(level: ProcessLevel, scope: Id | undefined, taskId: Id, x: number, y: number) {
  return (p: Project): Project => {
    const next = structuredClone(p);
    const n = requireTaskNode(requireView(next, level, scope), taskId);
    n.x = Math.round(x);
    n.y = Math.round(y);
    return next;
  };
}

/** 工程ノードを相対移動（微調整向き）。 */
export function nudgeNode(level: ProcessLevel, scope: Id | undefined, taskId: Id, dx: number, dy: number) {
  return (p: Project): Project => {
    const next = structuredClone(p);
    const n = requireTaskNode(requireView(next, level, scope), taskId);
    n.x = Math.round(n.x + dx);
    n.y = Math.round(n.y + dy);
    return next;
  };
}

/** 工程ノードの固定(pin)。pin すると整列(auto_layout)で動かさない。 */
export function pinNode(level: ProcessLevel, scope: Id | undefined, taskId: Id, pinned: boolean) {
  return (p: Project): Project => {
    const next = structuredClone(p);
    const n = requireTaskNode(requireView(next, level, scope), taskId);
    if (pinned) n.pinned = true;
    else delete n.pinned;
    return next;
  };
}

/** フローの向き（横/縦）を変更。 */
export function setOrientation(level: ProcessLevel, scope: Id | undefined, orientation: Orientation) {
  return (p: Project): Project => {
    const next = structuredClone(p);
    requireView(next, level, scope).orientation = orientation;
    return next;
  };
}

/** 担当レーンの高さ（px）を変更。 */
export function setLaneHeight(level: ProcessLevel, scope: Id | undefined, assigneeId: Id, height: number) {
  return (p: Project): Project => {
    const next = structuredClone(p);
    const v = requireView(next, level, scope);
    const lane = Object.values(v.lanes).find((l) => l.assigneeId === assigneeId);
    if (!lane) throw new Error(`そのレーンが見つかりません（assigneeId: ${assigneeId}）。list_flow_layout でレーンを確認してください。`);
    lane.height = Math.max(LANE_MIN_H, Math.round(height));
    return next;
  };
}

/** 自動整列（tidy）。手動配置を破棄し、依存の前後で左→右に段組みし直す（pin したノードは保持）。 */
export function autoLayout(level: ProcessLevel, scope: Id | undefined) {
  return (p: Project): Project => {
    const next = structuredClone(p);
    const idx = next.flow.byLevel.findIndex(
      (v) => v.level === level && (v.scopeParentId ?? undefined) === (scope ?? undefined),
    );
    if (idx < 0) throw new Error(`フロービューがありません（粒度: ${level}）。`);
    next.flow.byLevel[idx] = tidyFlowView(next.core, next.details, next.flow.byLevel[idx]!);
    return next;
  };
}

/** 現在のレイアウト（各ノードの座標・レーン・pin、レーン高さ、向き）をテキストで返す。 */
export function formatFlowLayout(p: Project, level: ProcessLevel, scope?: Id): string {
  const v = findFlowView(p, level, scope);
  if (!v) return `フロービューがありません（粒度: ${level}）。`;
  const codes = computeCodes(p.core);
  const laneTitle = (id?: Id) => (id ? Object.values(v.lanes).find((l) => l.id === id)?.title ?? '—' : '—');
  const taskNodes = Object.values(v.nodes).filter((n): n is FlowTaskNode => n.kind === 'task');
  const nodeLines = taskNodes
    .map((n) => {
      const t = p.core.tasks[n.taskId];
      return `${codes[n.taskId] ?? '?'} ${t?.name ?? '?'} @(${Math.round(n.x)},${Math.round(n.y)}) lane:${laneTitle(n.laneId)}${n.pinned ? ' [pinned]' : ''}  {id:${n.taskId}}`;
    })
    .join('\n');
  const laneLines = Object.values(v.lanes)
    .sort((a, b) => a.order - b.order)
    .map((l) => `- ${l.title}（高さ:${l.height ?? '既定'}）{assigneeId:${l.assigneeId ?? 'なし'}}`)
    .join('\n');
  return [
    `粒度: ${level} / 向き: ${v.orientation}`,
    '[ノード位置]',
    nodeLines || '(なし)',
    '[レーン]',
    laneLines || '(なし)',
  ].join('\n');
}
