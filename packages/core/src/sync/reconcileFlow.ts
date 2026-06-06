// 同期の心臓部（`docs/04-sync-spec.md`）。指定粒度ビューを現在のコアに合わせて再構築する純粋関数。
// 不変条件: 「対象タスク 1 件 ⇄ タスクノード 1 個」/ 手動配置(x,y)は保持 / pinned エッジは消さない / 冪等。
// v1 スコープ: タスクノード + 依存由来エッジ + 自動配置 + レーン。I/O・課題オブジェクトは次段で追加。
import type {
  Core,
  TaskDetail,
  FlowLevelView,
  FlowTaskNode,
  FlowDocNode,
  FlowIssueNote,
  FlowEdge,
  IssueTarget,
  Id,
  FlowNodeId,
} from '../model/types';
import type { IdGen } from '../ids';
import { placeInputDoc, placeOutputDoc, placeClear } from './autoPlace';

export interface SyncReport {
  added: FlowNodeId[]; // 自動追加したノード
  removed: FlowNodeId[]; // 対象外/削除で撤去したノード（孤立）
}

const MARGIN_X = 120; // レーン名の列（左）を空けて、その右からノードを並べる
const MARGIN_Y = 40;
const COL_W = 220;
const ROW_H = 120;

const sameScope = (a: Id | undefined, b: Id | undefined): boolean =>
  (a ?? undefined) === (b ?? undefined);

// flow エッジ（ioLink を除く）をたどって from から to に到達できるか。
// ユーザーが A→判断→B のように経路を作っていれば、直接 A→B を張らないための判定。
function reachableFlow(
  edges: Record<Id, { source: FlowNodeId; target: FlowNodeId; role?: 'flow' | 'ioLink' }>,
  from: FlowNodeId,
  to: FlowNodeId,
): boolean {
  if (from === to) return true;
  const adj = new Map<FlowNodeId, FlowNodeId[]>();
  for (const e of Object.values(edges)) {
    if (e.role === 'ioLink') continue;
    const list = adj.get(e.source);
    if (list) list.push(e.target);
    else adj.set(e.source, [e.target]);
  }
  const seen = new Set<FlowNodeId>([from]);
  const queue: FlowNodeId[] = [from];
  while (queue.length) {
    const cur = queue.shift()!;
    for (const nxt of adj.get(cur) ?? []) {
      if (nxt === to) return true;
      if (!seen.has(nxt)) {
        seen.add(nxt);
        queue.push(nxt);
      }
    }
  }
  return false;
}

export function reconcileFlow(
  core: Core,
  details: Record<Id, TaskDetail>,
  view: FlowLevelView,
  idGen: IdGen,
): { view: FlowLevelView; report: SyncReport } {
  const next: FlowLevelView = structuredClone(view);
  const report: SyncReport = { added: [], removed: [] };

  // 1. 対象タスク（この粒度・このスコープの兄弟）を決定論順で
  const targets = Object.values(core.tasks)
    .filter((t) => t.level === view.level && sameScope(t.parentId, view.scopeParentId))
    .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
  const targetIds = new Set(targets.map((t) => t.id));

  // 2. レーン: 参照される担当ごとに 1 本（既存は再利用、無ければ作成）
  const laneByAssignee = new Map<Id, Id>();
  for (const lane of Object.values(next.lanes)) {
    if (lane.assigneeId) laneByAssignee.set(lane.assigneeId, lane.id);
  }
  const ensureLane = (assigneeId: Id | undefined): Id | undefined => {
    if (!assigneeId) return undefined;
    const existing = laneByAssignee.get(assigneeId);
    if (existing) return existing;
    const id = idGen();
    const order = Object.keys(next.lanes).length;
    next.lanes[id] = {
      id,
      assigneeId,
      title: core.assignees[assigneeId]?.name ?? assigneeId,
      order,
    };
    laneByAssignee.set(assigneeId, id);
    return id;
  };
  // 決定論的なレーン生成順（対象タスクのソート順）
  for (const t of targets) ensureLane(t.assigneeId);
  const laneOrderOf = (assigneeId: Id | undefined): number => {
    if (!assigneeId) return 0;
    const id = laneByAssignee.get(assigneeId);
    return (id && next.lanes[id]?.order) || 0;
  };

  // 3. 孤立ノード撤去: 対象外になったタスクノードを消す（移動/削除）→ report
  for (const n of Object.values(next.nodes)) {
    if (n.kind === 'task' && !targetIds.has(n.taskId)) {
      delete next.nodes[n.id];
      report.removed.push(n.id);
    }
  }

  // 4. タスクノード保証: 既存は x/y 据え置き（担当のみ更新）、無ければ自動配置
  const taskNodeByTask = new Map<Id, FlowTaskNode>();
  for (const n of Object.values(next.nodes)) {
    if (n.kind === 'task') taskNodeByTask.set(n.taskId, n);
  }
  targets.forEach((t, i) => {
    const laneId = t.assigneeId ? laneByAssignee.get(t.assigneeId) : undefined;
    const existing = taskNodeByTask.get(t.id);
    if (existing) {
      // 担当（レーン）が変わったら、そのレーンの行へ縦移動（横位置 x は保持）
      if (existing.laneId !== laneId) {
        existing.laneId = laneId;
        existing.y = MARGIN_Y + laneOrderOf(t.assigneeId) * ROW_H;
      }
      return;
    }
    const id = idGen();
    const node: FlowTaskNode = {
      id,
      kind: 'task',
      taskId: t.id,
      x: MARGIN_X + i * COL_W,
      y: MARGIN_Y + laneOrderOf(t.assigneeId) * ROW_H,
      laneId,
    };
    next.nodes[id] = node;
    taskNodeByTask.set(t.id, node);
    report.added.push(id);
  });

  // 5. エッジ: コア依存を導出エッジに反映（pinned/ユーザー経路は尊重・消さない）
  const nodeIdByTask = new Map<Id, FlowNodeId>();
  for (const n of Object.values(next.nodes)) {
    if (n.kind === 'task') nodeIdByTask.set(n.taskId, n.id);
  }
  const depsInScope = Object.values(core.dependencies).filter(
    (d) =>
      sameScope(d.scopeParentId, view.scopeParentId) &&
      targetIds.has(d.from) &&
      targetIds.has(d.to),
  );
  const depIds = new Set(depsInScope.map((d) => d.id));

  // 5a. 不要な導出エッジを撤去（pinned は残す / 端点消失も撤去）
  for (const e of Object.values(next.edges)) {
    const depGone = e.derivedFromDependencyId && !depIds.has(e.derivedFromDependencyId);
    const danglingEndpoint = !next.nodes[e.source] || !next.nodes[e.target];
    if (!e.pinned && (depGone || danglingEndpoint)) delete next.edges[e.id];
  }

  // 5b. 各依存に導出エッジを 1 本保証。ただし
  //     ・既存の導出エッジは端点更新で使い回す
  //     ・ユーザー経路（pinned 直結 or A→判断→B）で既に到達可能なら直接エッジを張らない
  const derivedByDep = new Map<Id, FlowEdge>();
  for (const e of Object.values(next.edges)) {
    if (e.derivedFromDependencyId) derivedByDep.set(e.derivedFromDependencyId, e);
  }
  for (const d of depsInScope) {
    const s = nodeIdByTask.get(d.from);
    const t = nodeIdByTask.get(d.to);
    if (!s || !t) continue;
    const existing = derivedByDep.get(d.id);
    if (existing) {
      existing.source = s;
      existing.target = t;
      continue;
    }
    if (reachableFlow(next.edges, s, t)) continue; // 既存経路を尊重
    const id = idGen();
    next.edges[id] = { id, source: s, target: t, derivedFromDependencyId: d.id, role: 'flow' };
  }

  // 6. I/O・課題オブジェクト: 表(TaskDetail)を源泉に存在を導出。配置/表示は安定IDで保持。
  //    帳票/情報は工程の角に重ねて配置、課題は重ならない空きへ。
  for (const t of targets) {
    const taskNodeId = nodeIdByTask.get(t.id);
    if (!taskNodeId) continue;
    const taskNode = next.nodes[taskNodeId] as FlowTaskNode;
    const d = details[t.id];
    const inputs = d?.inputs ?? [];
    const outputs = d?.outputs ?? [];
    const issues = d?.issues ?? [];

    // 6a. I/O ノード（IoItem 1件 ⇔ doc ノード 1個）
    const docByIo = new Map<Id, FlowDocNode>();
    for (const n of Object.values(next.nodes)) {
      if (n.kind === 'doc' && n.taskId === t.id) docByIo.set(n.ioId, n);
    }
    const ensureDoc = (ioId: Id, io: 'input' | 'output', index: number) => {
      const existing = docByIo.get(ioId);
      if (existing) {
        existing.io = io; // x/y は保持
        return;
      }
      const id = idGen();
      const pos = io === 'input' ? placeInputDoc(taskNode, index) : placeOutputDoc(taskNode, index);
      const node: FlowDocNode = { id, kind: 'doc', io, taskId: t.id, ioId, x: pos.x, y: pos.y };
      next.nodes[id] = node;
      docByIo.set(ioId, node);
      report.added.push(id);
    };
    const wantIo = new Set<Id>();
    inputs.forEach((item, k) => {
      wantIo.add(item.id);
      ensureDoc(item.id, 'input', k);
    });
    outputs.forEach((item, k) => {
      wantIo.add(item.id);
      ensureDoc(item.id, 'output', k);
    });
    for (const n of Object.values(next.nodes)) {
      if (n.kind === 'doc' && n.taskId === t.id && !wantIo.has(n.ioId)) {
        delete next.nodes[n.id];
        report.removed.push(n.id);
      }
    }

    // 6b. 課題ノード（IssueItem 1件 ⇔ issue ノード 1個）。対象を解決（消失時はタスクへ寄せる）。
    const resolveTarget = (target: IssueTarget | undefined): FlowNodeId => {
      if (target && target.kind === 'io') {
        const doc = docByIo.get(target.ioId);
        if (doc && next.nodes[doc.id]) return doc.id; // 実在する doc のみ。消失時はタスクへ
      }
      return taskNode.id;
    };
    const noteByIssue = new Map<Id, FlowIssueNote>();
    for (const n of Object.values(next.nodes)) {
      if (n.kind === 'issue' && n.taskId === t.id) noteByIssue.set(n.issueId, n);
    }
    const wantIssue = new Set<Id>();
    for (const item of issues) {
      wantIssue.add(item.id);
      const existing = noteByIssue.get(item.id);
      if (existing) {
        existing.targetNodeId = resolveTarget(item.target); // x/y・visible は保持
        continue;
      }
      const id = idGen();
      const pos = placeClear(taskNode, Object.values(next.nodes));
      const node: FlowIssueNote = {
        id,
        kind: 'issue',
        taskId: t.id,
        issueId: item.id,
        targetNodeId: resolveTarget(item.target),
        x: pos.x,
        y: pos.y,
        visible: true,
      };
      next.nodes[id] = node;
      noteByIssue.set(item.id, node);
      report.added.push(id);
    }
    for (const n of Object.values(next.nodes)) {
      if (n.kind === 'issue' && n.taskId === t.id && !wantIssue.has(n.issueId)) {
        delete next.nodes[n.id];
        report.removed.push(n.id);
      }
    }
  }

  return { view: next, report };
}
