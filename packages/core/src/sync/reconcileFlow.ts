// 同期の心臓部（`docs/04-sync-spec.md`）。指定粒度ビューを現在のコアに合わせて再構築する純粋関数。
// 不変条件: 「対象タスク 1 件 ⇄ タスクノード 1 個」/ 手動配置(x,y)は保持
//          / pinned エッジは依存変更では消さない（端点ノードが消えたら撤去） / 冪等。
// v1 スコープ: タスクノード + 依存由来エッジ + 自動配置 + レーン。I/O・課題オブジェクトは次段で追加。
import type {
  Core,
  ProcessLevel,
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
import { placeInputDoc, placeOutputDoc, placeClear, obstaclesFor } from './autoPlace';
import { laneTaskBaseY } from './lanes';

export interface SyncReport {
  added: FlowNodeId[]; // 自動追加したノード
  removed: FlowNodeId[]; // 対象外/削除で撤去したノード（孤立）
}

const MARGIN_X = 120; // レーン名の列（左）を空けて、その右からノードを並べる
const COL_W = 220;
// 縦位置は lanes.ts の laneTaskBaseY（可変レーン高さに対応）に集約。

const sameScope = (a: Id | undefined, b: Id | undefined): boolean =>
  (a ?? undefined) === (b ?? undefined);

// ---- 親(上位粒度)の依存から導出する「大またぎブリッジ」 ----
// 親同士が繋がっていれば、子の「末端 → 先頭」を 1 本繋いで流れを見せる。
// フロー(全体スコープ)の描画と工程表の前工程表示の両方がこれを使う＝同期ずれを構造的に防ぐ。

export interface ParentBridge {
  /** 前側(親依存の from)の子のうち、後続を持たない末端(無ければ並び順の最後)。 */
  from: Id;
  /** 後側(親依存の to)の子のうち、先行を持たない先頭(無ければ並び順の最初)。 */
  to: Id;
  /** 由来となった親レベルの依存。 */
  viaDepId: Id;
}

/** 指定粒度の子タスクに対して、親レベルの依存から導出されるブリッジ接続を返す(純関数)。 */
export function deriveParentBridges(core: Core, level: ProcessLevel): ParentBridge[] {
  const kids = Object.values(core.tasks).filter((t) => t.level === level);
  const byParent = new Map<Id, typeof kids>();
  for (const t of kids) {
    if (!t.parentId) continue;
    const arr = byParent.get(t.parentId) ?? byParent.set(t.parentId, []).get(t.parentId)!;
    arr.push(t);
  }
  for (const arr of byParent.values()) arr.sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
  const kidIds = new Set(kids.map((t) => t.id));
  const sameLevelDeps = Object.values(core.dependencies).filter(
    (d) => kidIds.has(d.from) && kidIds.has(d.to),
  );
  const hasSucc = (taskId: Id) => sameLevelDeps.some((d) => d.from === taskId);
  const hasPred = (taskId: Id) => sameLevelDeps.some((d) => d.to === taskId);
  const out: ParentBridge[] = [];
  for (const pd of Object.values(core.dependencies)) {
    const fromKids = byParent.get(pd.from);
    const toKids = byParent.get(pd.to);
    if (!fromKids?.length || !toKids?.length) continue; // 両端の親に子がいる依存のみ
    const terminals = fromKids.filter((t) => !hasSucc(t.id));
    const initials = toKids.filter((t) => !hasPred(t.id));
    const a = (terminals.length ? terminals : fromKids)[
      terminals.length ? terminals.length - 1 : fromKids.length - 1
    ]!;
    const b = (initials.length ? initials : toKids)[0]!;
    out.push({ from: a.id, to: b.id, viaDepId: pd.id });
  }
  return out;
}

/** 全粒度ぶんのブリッジを「taskId → 導出された前工程の taskId[]」にまとめる(工程表の表示用)。 */
export function bridgePredMap(core: Core): Record<Id, Id[]> {
  const map: Record<Id, Id[]> = {};
  for (const level of ['medium', 'small', 'detail'] as const) {
    for (const br of deriveParentBridges(core, level)) {
      (map[br.to] ??= []).push(br.from);
    }
  }
  return map;
}

// ユーザーが手で作った経路（pinned 直結、または A→判断→B のような制御ノード経由＝端点が pinned）
// だけをたどって to に到達できるか。導出エッジ（依存から自動生成。非 pinned）はたどらない。
// → 依存を明示的に増やせば直接の矢印が必ず描かれる（線形チェーンの推移的な省略をしない）。
function reachableFlow(
  edges: Record<Id, { source: FlowNodeId; target: FlowNodeId; role?: 'flow' | 'ioLink'; pinned?: boolean }>,
  from: FlowNodeId,
  to: FlowNodeId,
): boolean {
  if (from === to) return true;
  const adj = new Map<FlowNodeId, FlowNodeId[]>();
  for (const e of Object.values(edges)) {
    if (e.role === 'ioLink' || !e.pinned) continue; // pinned（ユーザー経路）のみ
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

  // 全体スコープ: 大より下の粒度で scope 未指定なら「すべての親を横断」＝この粒度の全タスク。
  // （大は最上位なので未指定＝親なし全件で従来どおり。中/小/詳細の未指定だけ全体扱い）
  const allScope = view.scopeParentId === undefined && view.level !== 'large';

  // 1. 対象タスク（この粒度・このスコープの兄弟）を決定論順で。
  //    全体スコープでは親(大)ごとに固めて並べ、大の囲いが重ならないようにする。
  const parentOrder = (t: { parentId?: Id }): number =>
    t.parentId ? core.tasks[t.parentId]?.order ?? 0 : 0;
  const targets = Object.values(core.tasks)
    // To-Be 新設工程(toBe.lifecycle='added')は As-Is フローには出さない。
    // To-Be 投影では呼び出し側(buildScenarioView)が details の 'added' マーカーを外して描く。
    .filter(
      (t) =>
        t.level === view.level &&
        (allScope || sameScope(t.parentId, view.scopeParentId)) &&
        details[t.id]?.toBe?.lifecycle !== 'added',
    )
    .sort((a, b) => parentOrder(a) - parentOrder(b) || a.order - b.order || a.id.localeCompare(b.id));
  const targetIds = new Set(targets.map((t) => t.id));
  // 横位置は targets の並び順（親=大ごとに固めた連番）で詰めて配置する。
  // グループごとに固まるので大の囲いは重ならない（間隔は空けない）。

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

  // 3. 孤立ノード撤去: 対象外になったタスクのノードを消す（移動/削除）→ report
  //    タスクノードだけでなく、そのタスク由来の I/O（doc）・課題（issue）ノードも一緒に消す。
  for (const n of Object.values(next.nodes)) {
    if (
      (n.kind === 'task' || n.kind === 'doc' || n.kind === 'issue') &&
      !targetIds.has(n.taskId)
    ) {
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
        existing.y = laneTaskBaseY(next.lanes, laneOrderOf(t.assigneeId));
      }
      return;
    }
    const id = idGen();
    const node: FlowTaskNode = {
      id,
      kind: 'task',
      taskId: t.id,
      x: MARGIN_X + i * COL_W,
      y: laneTaskBaseY(next.lanes, laneOrderOf(t.assigneeId)),
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
      (allScope || sameScope(d.scopeParentId, view.scopeParentId)) &&
      targetIds.has(d.from) &&
      targetIds.has(d.to),
  );

  // 全体スコープ: 親(大)レベルの依存を、子(中)の「末端→先頭」に 1 本ブリッジして
  // 大をまたぐ流れを見せる（親が繋がっていれば子も繋ぐ）。導出は deriveParentBridges に
  // 一元化(工程表の前工程表示と共有=同期ずれを構造的に防ぐ)。
  const bridges: { from: FlowNodeId; to: FlowNodeId; depId: Id }[] = [];
  if (allScope) {
    for (const br of deriveParentBridges(core, view.level)) {
      const s = nodeIdByTask.get(br.from);
      const t2 = nodeIdByTask.get(br.to);
      if (s && t2) bridges.push({ from: s, to: t2, depId: br.viaDepId });
    }
  }
  const depIds = new Set([...depsInScope.map((d) => d.id), ...bridges.map((b) => b.depId)]);

  // 5a. 不要な導出エッジを撤去。pinned が守るのは「依存の変化」からだけで、
  //     端点ノードが消えたエッジは pinned でも撤去する（選択も描画もできない幽霊になるため）。
  for (const e of Object.values(next.edges)) {
    const depGone = e.derivedFromDependencyId && !depIds.has(e.derivedFromDependencyId);
    const danglingEndpoint = !next.nodes[e.source] || !next.nodes[e.target];
    if (danglingEndpoint || (!e.pinned && depGone)) delete next.edges[e.id];
  }

  // 5b. 各依存に導出エッジを 1 本保証。ただし
  //     ・既存の導出エッジは端点更新で使い回す
  //     ・ユーザー経路（pinned 直結 or A→判断→B）で既に到達可能なら直接エッジを張らない
  const derivedByDep = new Map<Id, FlowEdge>();
  for (const e of Object.values(next.edges)) {
    if (e.derivedFromDependencyId) derivedByDep.set(e.derivedFromDependencyId, e);
  }
  // 直接依存が張った端点対。同じ対に解決されたブリッジは張らない（同一区間の二重矢印防止）。
  const directPairs = new Set<string>();
  for (const d of depsInScope) {
    const s = nodeIdByTask.get(d.from);
    const t = nodeIdByTask.get(d.to);
    if (!s || !t) continue;
    const existing = derivedByDep.get(d.id);
    if (existing) {
      existing.source = s;
      existing.target = t;
      directPairs.add(`${s}->${t}`);
      continue;
    }
    if (reachableFlow(next.edges, s, t)) continue; // 既存経路を尊重
    const id = idGen();
    next.edges[id] = { id, source: s, target: t, derivedFromDependencyId: d.id, role: 'flow' };
    directPairs.add(`${s}->${t}`);
  }

  // 5c. 全体スコープの大またぎブリッジ（親の依存 1 本 ⇄ 子の末端→先頭エッジ 1 本）。
  //     直接依存と同じ端点対に解決された場合は直接依存のエッジを優先し、ブリッジ側は出さない。
  for (const br of bridges) {
    const duplicatesDirect = directPairs.has(`${br.from}->${br.to}`);
    const existing = derivedByDep.get(br.depId);
    if (existing) {
      if (duplicatesDirect) {
        delete next.edges[existing.id];
        continue;
      }
      existing.source = br.from;
      existing.target = br.to;
      continue;
    }
    if (duplicatesDirect || reachableFlow(next.edges, br.from, br.to)) continue;
    const id = idGen();
    next.edges[id] = { id, source: br.from, target: br.to, derivedFromDependencyId: br.depId, role: 'flow' };
  }

  // 6. I/O・課題オブジェクト: 表(TaskDetail)を源泉に存在を導出。配置/表示は安定IDで保持。
  //    帳票/情報は工程の角に重ねて配置、課題は重ならない空きへ。
  //    既存ノードの索引は走査 1 回でタスク別にまとめる（対象数×全ノードの再走査を避ける）。
  const docsByTask = new Map<Id, FlowDocNode[]>();
  const issuesByTask = new Map<Id, FlowIssueNote[]>();
  for (const n of Object.values(next.nodes)) {
    if (n.kind === 'doc') {
      const arr = docsByTask.get(n.taskId);
      if (arr) arr.push(n);
      else docsByTask.set(n.taskId, [n]);
    } else if (n.kind === 'issue') {
      const arr = issuesByTask.get(n.taskId);
      if (arr) arr.push(n);
      else issuesByTask.set(n.taskId, [n]);
    }
  }
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
    for (const n of docsByTask.get(t.id) ?? []) docByIo.set(n.ioId, n);
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
    for (const n of docsByTask.get(t.id) ?? []) {
      if (!wantIo.has(n.ioId)) {
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
    for (const n of issuesByTask.get(t.id) ?? []) noteByIssue.set(n.issueId, n);
    const wantIssue = new Set<Id>();
    for (const item of issues) {
      wantIssue.add(item.id);
      const existing = noteByIssue.get(item.id);
      if (existing) {
        existing.targetNodeId = resolveTarget(item.target); // x/y・visible は保持
        continue;
      }
      const id = idGen();
      const pos = placeClear(
        taskNode,
        obstaclesFor(Object.values(next.nodes), Object.values(next.edges)),
      );
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
    for (const n of issuesByTask.get(t.id) ?? []) {
      if (!wantIssue.has(n.issueId)) {
        delete next.nodes[n.id];
        report.removed.push(n.id);
      }
    }
  }

  // 7. 端点を失ったエッジの後始末。6 で消えた doc/issue ノードに繋がっていたエッジは
  //    pinned でもここで撤去し、1 回の reconcile で幽霊エッジが残らないようにする（冪等性の維持）。
  for (const e of Object.values(next.edges)) {
    if (!next.nodes[e.source] || !next.nodes[e.target]) delete next.edges[e.id];
  }

  return { view: next, report };
}
