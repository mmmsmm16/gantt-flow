// コア変更コマンド。すべて純粋: (project, args, idGen) => project'（core/details のみ更新、flow は触らない）。
// 履歴(undo/redo)はストア層がスナップショットで持つ（`docs/01-architecture.md` §6）。
import type {
  Project,
  ProcessTask,
  ProcessLevel,
  Dependency,
  Assignee,
  IoItem,
  IoKind,
  IssueItem,
  IssueTarget,
  TaskDetail,
  TaskDetailToBe,
  Id,
} from '../model/types';
import type { IdGen } from '../ids';

const clone = <T>(x: T): T => structuredClone(x);

const LEVEL_RANK: Record<ProcessLevel, number> = { large: 0, medium: 1, small: 2, detail: 3 };
const LEVELS_ORDER: ProcessLevel[] = ['large', 'medium', 'small', 'detail'];

function ensureDetail(p: Project, taskId: Id): TaskDetail {
  let d = p.details[taskId];
  if (!d) {
    d = { taskId };
    p.details[taskId] = d;
  }
  return d;
}

export interface AddTaskArgs {
  name: string;
  level: ProcessLevel;
  parentId?: Id;
  assigneeId?: Id;
  order?: number;
  id?: Id; // 呼び出し側で発番済みの ID を使う（省略時は idGen で発番）。作成 ID をキー差分で探さなくて済む。
}

export function addTask(p: Project, args: AddTaskArgs, idGen: IdGen): Project {
  const next = clone(p);
  const id = args.id ?? idGen();
  const siblings = Object.values(next.core.tasks).filter(
    (t) => (t.parentId ?? undefined) === (args.parentId ?? undefined),
  );
  const order =
    args.order ??
    (siblings.length ? Math.max(...siblings.map((s) => s.order)) + 1 : 0);
  const task: ProcessTask = {
    id,
    name: args.name,
    level: args.level,
    order,
    parentId: args.parentId,
    assigneeId: args.assigneeId,
  };
  next.core.tasks[id] = task;
  next.details[id] = { taskId: id };
  return next;
}

export function renameTask(p: Project, taskId: Id, name: string): Project {
  const next = clone(p);
  const task = next.core.tasks[taskId];
  if (task) task.name = name;
  return next;
}

export function setTaskLevel(p: Project, taskId: Id, level: ProcessLevel): Project {
  const next = clone(p);
  const task = next.core.tasks[taskId];
  if (task) task.level = level;
  return next;
}

// 工程No の手動上書き。空なら未設定（木の位置から自動採番に戻す）。
export function setTaskCode(p: Project, taskId: Id, code: string | undefined): Project {
  const next = clone(p);
  const task = next.core.tasks[taskId];
  if (task) task.code = code && code.trim() ? code.trim() : undefined;
  return next;
}

export function setAssignee(p: Project, taskId: Id, assigneeId: Id | undefined): Project {
  const next = clone(p);
  const task = next.core.tasks[taskId];
  if (task) task.assigneeId = assigneeId;
  return next;
}

export interface AddAssigneeArgs {
  name: string;
  kind: Assignee['kind'];
}

export function addAssignee(p: Project, args: AddAssigneeArgs, idGen: IdGen): Project {
  const next = clone(p);
  const id = idGen();
  next.core.assignees[id] = { id, name: args.name, kind: args.kind };
  return next;
}

// 依存（流れ）を追加。スコープは from の親（= 同一スコープ内の兄弟同士を結ぶ）。
export function addDependency(p: Project, from: Id, to: Id, idGen: IdGen): Project {
  const next = clone(p);
  if (from === to) return next;
  // 実在しない工程への依存は保存ファイルの strict 検証（dependency.from/to は FATAL）で
  // 再オープン不能になるため、コア層でも no-op にする（UI 層のガードと二重防御）。
  if (!next.core.tasks[from] || !next.core.tasks[to]) return next;
  const exists = Object.values(next.core.dependencies).some(
    (d) => d.from === from && d.to === to,
  );
  if (exists) return next;
  const id = idGen();
  const dep: Dependency = {
    id,
    from,
    to,
    type: 'FS',
    scopeParentId: next.core.tasks[from]?.parentId,
  };
  next.core.dependencies[id] = dep;
  return next;
}

export function removeDependency(p: Project, depId: Id): Project {
  const next = clone(p);
  delete next.core.dependencies[depId];
  return next;
}

// 依存の所属シナリオを変更（並行化＝As-Is専用にすると To-Be では繋がらない／To-Be専用で新接続）。
// undefined=両方。
export function setDependencyPhase(p: Project, depId: Id, phase: 'asis' | 'tobe' | undefined): Project {
  const next = clone(p);
  const dep = next.core.dependencies[depId];
  if (!dep) return next;
  if (phase) dep.phase = phase;
  else delete dep.phase;
  return next;
}

// 並行工程を追加: 基準工程 ref と同じ親・粒度・担当の新工程を ref の直後（order）に作り、
// ref の「前工程のみ」をコピーする（A→B→C で B に並行追加 → A→新 のみ。新→C は張らない＝
// 後続の繋ぎ方はユーザーに委ねる仕様）。details はコピーしない（addTask の空詳細のまま）。
export function addParallelTask(p: Project, refId: Id, idGen: IdGen, newId?: Id): Project {
  const ref = p.core.tasks[refId];
  if (!ref) return clone(p);
  const id = newId ?? idGen();
  let next = addTask(
    p,
    { name: '新規工程', level: ref.level, parentId: ref.parentId, assigneeId: ref.assigneeId, id },
    idGen,
  );
  // ref の直後へ挿入（同一親の兄弟内 index + 1）
  const siblings = Object.values(next.core.tasks)
    .filter((t) => (t.parentId ?? undefined) === (ref.parentId ?? undefined))
    .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
  next = reorderTask(next, id, siblings.findIndex((t) => t.id === refId) + 1);
  // 前工程のみコピー（追加で依存集合が変わるため、先に収集してから処理する）
  const preds = Object.values(next.core.dependencies)
    .filter((d) => d.to === refId)
    .map((d) => d.from);
  for (const from of preds) next = addDependency(next, from, id, idGen);
  return next;
}

// 既存工程 B(taskId) を、基準工程 Y(baseId) と「並行」（同じ前後関係）にする。
// 手順の順序が重要: ①B の旧前後を収集 → ②直結で補完(heal: A→[B]→C を A→C に) →
// ③B が端点の依存を撤去 → ④撤去後に Y の前後を収集して B へコピー。
// ④を③より先にやると、B↔Y 間に依存があるケースで Y の前後に B 自身が混入して崩れる。
export function makeParallel(p: Project, taskId: Id, baseId: Id, idGen: IdGen): Project {
  const task = p.core.tasks[taskId];
  const base = p.core.tasks[baseId];
  if (taskId === baseId || !task || !base || task.level !== base.level) return clone(p);

  // ① B の旧 前/後 を収集
  const deps0 = Object.values(p.core.dependencies);
  const oldPreds = deps0.filter((d) => d.to === taskId).map((d) => d.from);
  const oldSuccs = deps0.filter((d) => d.from === taskId).map((d) => d.to);

  // ② heal: 旧前×旧後を直結補完（自己ループ・重複は addDependency のガード任せ）
  let next = clone(p);
  for (const a of oldPreds) for (const c of oldSuccs) next = addDependency(next, a, c, idGen);

  // ③ B が端点の依存を撤去（削除で集合が変わるため id を集めてから消す）
  const incident = Object.values(next.core.dependencies)
    .filter((d) => d.from === taskId || d.to === taskId)
    .map((d) => d.id);
  for (const depId of incident) next = removeDependency(next, depId);

  // ④ 基準 Y の前後を B へコピー（③の後なので Y の前後に B は含まれない）
  const deps1 = Object.values(next.core.dependencies);
  for (const d of deps1) {
    if (d.to === baseId) next = addDependency(next, d.from, taskId, idGen);
    if (d.from === baseId) next = addDependency(next, taskId, d.to, idGen);
  }
  return next;
}

// タスク削除: サブツリーごと削除し、削除点の前後を繋ぎ直す（A→[X]→B を A→B に）。
export function deleteTask(p: Project, taskId: Id): Project {
  const next = clone(p);
  if (!next.core.tasks[taskId]) return next;

  // サブツリー（taskId とその子孫）を集める
  const toRemove = new Set<Id>();
  const stack: Id[] = [taskId];
  while (stack.length) {
    const cur = stack.pop()!;
    if (toRemove.has(cur)) continue;
    toRemove.add(cur);
    for (const t of Object.values(next.core.tasks)) {
      if (t.parentId === cur) stack.push(t.id);
    }
  }

  // 繋ぎ直し: 削除する taskId 本体の前後にブリッジ依存を張る
  const deps = Object.values(next.core.dependencies);
  const preds = deps.filter((d) => d.to === taskId).map((d) => d.from);
  const succs = deps.filter((d) => d.from === taskId).map((d) => d.to);
  for (const a of preds) {
    for (const b of succs) {
      if (a === b || toRemove.has(a) || toRemove.has(b)) continue;
      const already = Object.values(next.core.dependencies).some(
        (d) => d.from === a && d.to === b,
      );
      if (already) continue;
      const id = idGenFromTask(next, a); // 決定論不要のここは uuid 経由でなく安定化のため
      next.core.dependencies[id] = {
        id,
        from: a,
        to: b,
        type: 'FS',
        scopeParentId: next.core.tasks[a]?.parentId,
      };
    }
  }

  // 削除対象に触れる依存を除去
  for (const d of Object.values(next.core.dependencies)) {
    if (toRemove.has(d.from) || toRemove.has(d.to)) {
      delete next.core.dependencies[d.id];
    }
  }
  // タスク本体と詳細を除去
  for (const id of toRemove) {
    delete next.core.tasks[id];
    delete next.details[id];
  }
  return next;
}

// タスク削除（配下を残す版）。対象 1 件だけ消し、直下の子（とその子孫）は祖父へ昇格させて保持する。
// 子のサブツリーは粒度を 1 段上げ、依存は維持（対象本体の前後はブリッジ）。
export function deleteTaskKeepChildren(p: Project, taskId: Id): Project {
  const next = clone(p);
  const target = next.core.tasks[taskId];
  if (!target) return next;
  const grandparentId = target.parentId;

  // 対象本体の前後をブリッジ（A→[対象]→B を A→B に）。
  const deps = Object.values(next.core.dependencies);
  const preds = deps.filter((d) => d.to === taskId).map((d) => d.from);
  const succs = deps.filter((d) => d.from === taskId).map((d) => d.to);
  for (const a of preds) {
    for (const b of succs) {
      if (a === b) continue;
      if (Object.values(next.core.dependencies).some((d) => d.from === a && d.to === b)) continue;
      const id = idGenFromTask(next, a);
      next.core.dependencies[id] = { id, from: a, to: b, type: 'FS', scopeParentId: next.core.tasks[a]?.parentId };
    }
  }
  // 対象が端点の依存だけ撤去（子の依存は残す）。
  for (const d of Object.values(next.core.dependencies)) {
    if (d.from === taskId || d.to === taskId) delete next.core.dependencies[d.id];
  }
  // 子同士の依存（スコープ＝対象）は、子の昇格に合わせてスコープも祖父へ付け替える。
  for (const d of Object.values(next.core.dependencies)) {
    if (d.scopeParentId === taskId) d.scopeParentId = grandparentId;
  }

  // 対象の子孫（対象自身は除く）の粒度を 1 段上げる（対象が消えて 1 階層浅くなるため）。
  const directChildren = Object.values(next.core.tasks)
    .filter((t) => t.parentId === taskId)
    .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
  const subtree = new Set<Id>();
  const stack = directChildren.map((c) => c.id);
  while (stack.length) {
    const cur = stack.pop()!;
    if (subtree.has(cur)) continue;
    subtree.add(cur);
    for (const t of Object.values(next.core.tasks)) if (t.parentId === cur) stack.push(t.id);
  }
  for (const id of subtree) {
    const t = next.core.tasks[id]!;
    t.level = LEVELS_ORDER[Math.max(0, LEVEL_RANK[t.level] - 1)]!;
  }

  // 直下の子を祖父へ付け替え、対象がいた位置へ差し込む（order 正規化）。
  const groupNoTarget = Object.values(next.core.tasks)
    .filter((t) => t.id !== taskId && (t.parentId ?? undefined) === (grandparentId ?? undefined) && !subtree.has(t.id))
    .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
  const at = (() => {
    const withTarget = Object.values(next.core.tasks)
      .filter((t) => (t.parentId ?? undefined) === (grandparentId ?? undefined) && (t.id === taskId || !subtree.has(t.id)))
      .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
    const i = withTarget.findIndex((t) => t.id === taskId);
    return i < 0 ? groupNoTarget.length : i;
  })();
  for (const c of directChildren) c.parentId = grandparentId;
  const finalOrder = [...groupNoTarget.slice(0, at), ...directChildren, ...groupNoTarget.slice(at)];
  finalOrder.forEach((t, i) => (t.order = i));

  delete next.core.tasks[taskId];
  delete next.details[taskId];
  return next;
}

// 兄弟内での並べ替え。toIndex は同一親グループ内の目標位置。order を 0..n-1 に正規化する。
export function reorderTask(p: Project, taskId: Id, toIndex: number): Project {
  const next = clone(p);
  const task = next.core.tasks[taskId];
  if (!task) return next;
  const siblings = Object.values(next.core.tasks)
    .filter((t) => (t.parentId ?? undefined) === (task.parentId ?? undefined))
    .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
  const from = siblings.findIndex((t) => t.id === taskId);
  if (from < 0) return next;
  const to = Math.max(0, Math.min(siblings.length - 1, toIndex));
  if (to === from) return next;
  const [moved] = siblings.splice(from, 1);
  siblings.splice(to, 0, moved!);
  siblings.forEach((t, i) => (t.order = i));
  return next;
}

// サブツリーを別親へ移動。level は新しい深さに合わせて再計算（レベルスキップ禁止）。
// 移動ルート(taskId)が端点の依存は撤去（旧兄弟との流れは無効になるため）。
// 循環（自分の子孫の下へ）・深さ超過（detail より深い）になる移動は no-op。
export function reparentTask(
  p: Project,
  taskId: Id,
  newParentId: Id | undefined,
  index?: number,
): Project {
  const next = clone(p);
  const task = next.core.tasks[taskId];
  if (!task) return next;
  if (newParentId === taskId) return next;
  const newParent = newParentId ? next.core.tasks[newParentId] : undefined;
  if (newParentId && !newParent) return next;

  // 移動サブツリー（taskId とその子孫）
  const subtree = new Set<Id>();
  const stack: Id[] = [taskId];
  while (stack.length) {
    const cur = stack.pop()!;
    if (subtree.has(cur)) continue;
    subtree.add(cur);
    for (const t of Object.values(next.core.tasks)) if (t.parentId === cur) stack.push(t.id);
  }
  if (newParentId && subtree.has(newParentId)) return next; // 循環防止

  // 新しい深さに合わせて level をシフト。サブツリーが範囲外（large 未満 / detail 超）なら中止。
  const newRank = newParent ? LEVEL_RANK[newParent.level] + 1 : 0;
  if (newRank > 3) return next; // detail の子は作れない
  const delta = newRank - LEVEL_RANK[task.level];
  for (const id of subtree) {
    const r = LEVEL_RANK[next.core.tasks[id]!.level] + delta;
    if (r < 0 || r > 3) return next;
  }
  for (const id of subtree) {
    const t = next.core.tasks[id]!;
    t.level = LEVELS_ORDER[LEVEL_RANK[t.level] + delta]!;
  }

  // 親を付け替え、order を決定（index 指定なら挿入位置、なければ末尾）。
  task.parentId = newParentId;
  const newSiblings = Object.values(next.core.tasks)
    .filter((t) => t.id !== taskId && (t.parentId ?? undefined) === (newParentId ?? undefined))
    .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
  if (index === undefined || index >= newSiblings.length) {
    task.order = newSiblings.length ? Math.max(...newSiblings.map((s) => s.order)) + 1 : 0;
  } else {
    const at = Math.max(0, index);
    newSiblings.forEach((s, i) => (s.order = i < at ? i : i + 1));
    task.order = at;
  }

  // 移動ルートが端点の依存を撤去（旧兄弟との流れは無効）。サブツリー内部の依存は保持。
  for (const dep of Object.values(next.core.dependencies)) {
    if (dep.from === taskId || dep.to === taskId) delete next.core.dependencies[dep.id];
  }
  return next;
}

// ---- 工程表詳細: スカラ項目の更新（行インスペクタ用） ----

export type TaskDetailPatch = Partial<
  Pick<
    TaskDetail,
    | 'how'
    | 'system'
    | 'effortMinutes'
    | 'ltDays'
    | 'note'
    | 'volume'
    | 'exception'
    | 'automation'
    | 'dataLink'
    | 'regulation'
    | 'difficulty'
    | 'status'
    | 'fillColor'
    | 'textColor'
  >
>;

export function updateTaskDetail(p: Project, taskId: Id, patch: TaskDetailPatch): Project {
  const next = clone(p);
  if (!next.core.tasks[taskId]) return next;
  const d = ensureDetail(next, taskId);
  Object.assign(d, patch);
  return next;
}

// To-Be 差分の部分更新（read-merge-write）。toBe はネスト obj なので updateTaskDetail の
// 浅いマージに混ぜると既存 toBe を丸ごと置換してしまう。専用にして既存キーを保つ。
// patch の値が undefined のキーは toBe から削除（「現状に戻す＝差分なし」を表現できる）。
export function updateTaskToBe(p: Project, taskId: Id, patch: Partial<TaskDetailToBe>): Project {
  const next = clone(p);
  if (!next.core.tasks[taskId]) return next;
  const d = ensureDetail(next, taskId);
  const merged: TaskDetailToBe = { ...d.toBe };
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) delete (merged as Record<string, unknown>)[k];
    else (merged as Record<string, unknown>)[k] = v;
  }
  d.toBe = Object.keys(merged).length > 0 ? merged : undefined;
  return next;
}

/** As-Is の現状値を To-Be の起点へ複製（インスペクタ「現状を複製」）。既存 toBe は上書き。 */
export function copyAsIsToToBe(p: Project, taskId: Id): Project {
  const next = clone(p);
  const d = next.details[taskId];
  if (!next.core.tasks[taskId] || !d) return next;
  next.details[taskId] = {
    ...d,
    toBe: {
      effortMinutes: d.effortMinutes,
      ltDays: d.ltDays,
      difficulty: d.difficulty,
      automation: d.automation,
      rationale: d.toBe?.rationale,
    },
  };
  return next;
}

// ---- 工程表詳細: I/O（帳票/情報） ----

export interface AddIoArgs {
  name: string;
  kind: IoKind;
  formInfo?: string;
  source?: string; // 出所（他部署など）。入力帳票で「どこから来るか」
}

export function addIoItem(
  p: Project,
  taskId: Id,
  io: 'inputs' | 'outputs',
  args: AddIoArgs,
  idGen: IdGen,
): Project {
  const next = clone(p);
  if (!next.core.tasks[taskId]) return next;
  const d = ensureDetail(next, taskId);
  const item: IoItem = { id: idGen(), name: args.name, kind: args.kind, formInfo: args.formInfo, source: args.source };
  d[io] = [...(d[io] ?? []), item];
  return next;
}

export function removeIoItem(p: Project, taskId: Id, ioId: Id): Project {
  const next = clone(p);
  const d = next.details[taskId];
  if (!d) return next;
  if (d.inputs) d.inputs = d.inputs.filter((i) => i.id !== ioId);
  if (d.outputs) d.outputs = d.outputs.filter((i) => i.id !== ioId);
  return next;
}

export function updateIoItem(
  p: Project,
  taskId: Id,
  ioId: Id,
  patch: Partial<Pick<IoItem, 'name' | 'kind' | 'formInfo' | 'source'>>,
): Project {
  const next = clone(p);
  const d = next.details[taskId];
  if (!d) return next;
  const item = [...(d.inputs ?? []), ...(d.outputs ?? [])].find((i) => i.id === ioId);
  if (item) Object.assign(item, patch);
  return next;
}

// ---- 工程表詳細: 課題 ----

export interface AddIssueArgs {
  issue: string;
  measure?: string;
  target?: IssueTarget;
}

export function addIssueItem(p: Project, taskId: Id, args: AddIssueArgs, idGen: IdGen): Project {
  const next = clone(p);
  if (!next.core.tasks[taskId]) return next;
  const d = ensureDetail(next, taskId);
  const item: IssueItem = {
    id: idGen(),
    issue: args.issue,
    measure: args.measure,
    target: args.target,
  };
  d.issues = [...(d.issues ?? []), item];
  return next;
}

export function removeIssueItem(p: Project, taskId: Id, issueId: Id): Project {
  const next = clone(p);
  const d = next.details[taskId];
  if (d?.issues) d.issues = d.issues.filter((i) => i.id !== issueId);
  return next;
}

export function updateIssueItem(
  p: Project,
  taskId: Id,
  issueId: Id,
  patch: Partial<Pick<IssueItem, 'issue' | 'measure' | 'target'>>,
): Project {
  const next = clone(p);
  const item = next.details[taskId]?.issues?.find((i) => i.id === issueId);
  if (item) Object.assign(item, patch);
  return next;
}

// deleteTask 内のブリッジ依存 ID。テスト容易性のため決定論的な合成キーにする。
function idGenFromTask(p: Project, from: Id): Id {
  let n = 0;
  let id = `dep_bridge_${from}_${n}`;
  while (p.core.dependencies[id]) id = `dep_bridge_${from}_${++n}`;
  return id;
}
