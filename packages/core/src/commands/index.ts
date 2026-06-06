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
  Id,
} from '../model/types';
import type { IdGen } from '../ids';

const clone = <T>(x: T): T => structuredClone(x);

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
}

export function addTask(p: Project, args: AddTaskArgs, idGen: IdGen): Project {
  const next = clone(p);
  const id = idGen();
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

// ---- 工程表詳細: I/O（帳票/情報） ----

export interface AddIoArgs {
  name: string;
  kind: IoKind;
  formInfo?: string;
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
  const item: IoItem = { id: idGen(), name: args.name, kind: args.kind, formInfo: args.formInfo };
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

// deleteTask 内のブリッジ依存 ID。テスト容易性のため決定論的な合成キーにする。
function idGenFromTask(p: Project, from: Id): Id {
  let n = 0;
  let id = `dep_bridge_${from}_${n}`;
  while (p.core.dependencies[id]) id = `dep_bridge_${from}_${++n}`;
  return id;
}
