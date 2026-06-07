// アプリ状態（Zustand）。core のコマンド＋reconcileProject＋history を薄く包む。
// 「コマンド → reconcileProject → history.push」が 1 編集＝1 undo 単位（docs/01-architecture §6）。
import { create } from 'zustand';
import { createStore, type StateCreator } from 'zustand/vanilla';
import {
  type Project,
  type Id,
  type ProcessLevel,
  type FlowNodeId,
  type FlowLevelView,
  type ControlKind,
  type IoKind,
  type IssueTarget,
  type TaskDetailPatch,
  type IoItem,
  type IssueItem,
  type ImportReport,
  CURRENT_SCHEMA_VERSION,
  uuid,
  createHistory,
  reconcileProject,
  ensureLevelView,
  importCsv,
  rowsToProject,
  addTask as cAddTask,
  renameTask as cRenameTask,
  setTaskLevel as cSetTaskLevel,
  setTaskCode as cSetTaskCode,
  setAssignee as cSetAssignee,
  addAssignee as cAddAssignee,
  addDependency as cAddDependency,
  removeDependency as cRemoveDependency,
  addIoItem as cAddIoItem,
  removeIoItem as cRemoveIoItem,
  updateIoItem as cUpdateIoItem,
  addIssueItem as cAddIssueItem,
  removeIssueItem as cRemoveIssueItem,
  updateIssueItem as cUpdateIssueItem,
  updateTaskDetail as cUpdateTaskDetail,
  deleteTask as cDeleteTask,
  reorderTask as cReorderTask,
  reparentTask as cReparentTask,
} from '@gantt-flow/core';

const RANK: Record<ProcessLevel, number> = { large: 0, medium: 1, small: 2, detail: 3 };
const LEVELS: ProcessLevel[] = ['large', 'medium', 'small', 'detail'];

export const findView = (
  p: Project,
  level: ProcessLevel,
  scopeParentId?: Id,
): FlowLevelView | undefined =>
  p.flow.byLevel.find(
    (v) => v.level === level && (v.scopeParentId ?? undefined) === (scopeParentId ?? undefined),
  );

function initialProject(): Project {
  const now = new Date().toISOString();
  const base: Project = {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    meta: { id: uuid(), title: '新規プロジェクト', createdAt: now, updatedAt: now, appVersion: '0.0.0' },
    core: { tasks: {}, dependencies: {}, assignees: {} },
    details: {},
    flow: { byLevel: [] },
  };
  return reconcileProject(ensureLevelView(base, 'medium'), uuid);
}

export interface AppState {
  project: Project;
  canUndo: boolean;
  canRedo: boolean;
  selectedTaskId?: Id;
  level: ProcessLevel;
  scopeParentId?: Id;
  showIssues: boolean;
  dirty: boolean;

  addTask: (name: string) => void;
  addRootTask: (level: ProcessLevel) => void;
  addChildTask: (parentId: Id) => void;
  removeTask: (taskId: Id) => void;
  setTaskLevel: (taskId: Id, level: ProcessLevel) => void;
  setTaskCode: (taskId: Id, code: string | undefined) => void;
  renameTask: (taskId: Id, name: string) => void;
  setAssigneeByName: (taskId: Id, name: string) => void;
  addDependency: (from: Id, to: Id) => void;
  removeDependency: (depId: Id) => void;
  addSiblingOf: (taskId: Id) => Id | undefined;
  moveTaskUp: (taskId: Id) => void;
  moveTaskDown: (taskId: Id) => void;
  indentTask: (taskId: Id) => void;
  outdentTask: (taskId: Id) => void;
  dropTask: (dragId: Id, targetId: Id, mode: 'before' | 'after' | 'child') => void;
  addIo: (taskId: Id, io: 'inputs' | 'outputs', name: string) => void;
  updateIo: (taskId: Id, ioId: Id, patch: Partial<Pick<IoItem, 'name' | 'kind' | 'formInfo'>>) => void;
  removeIo: (taskId: Id, ioId: Id) => void;
  addIssue: (taskId: Id, text: string) => void;
  updateIssue: (taskId: Id, issueId: Id, patch: Partial<Pick<IssueItem, 'issue' | 'measure' | 'target'>>) => void;
  removeIssue: (taskId: Id, issueId: Id) => void;
  updateDetail: (taskId: Id, patch: TaskDetailPatch) => void;
  moveNode: (nodeId: FlowNodeId, x: number, y: number) => void;
  addControlNode: (control: ControlKind) => void;
  addComment: (text: string) => void;
  connect: (source: FlowNodeId, target: FlowNodeId) => void;
  setEdgeLabel: (edgeId: Id, label: string) => void;
  deleteFlowNode: (nodeId: FlowNodeId) => void;
  deleteEdge: (edgeId: Id) => void;
  select: (taskId?: Id) => void;
  setLevel: (level: ProcessLevel) => void;
  setScope: (scopeParentId?: Id) => void;
  toggleIssues: () => void;
  undo: () => void;
  redo: () => void;
  markSaved: () => void;
  loadProject: (project: Project) => void;
  importCsvText: (text: string) => ImportReport;
  importRows: (rows: string[][]) => ImportReport;
  newProject: () => void;
}

export const appStateCreator: StateCreator<AppState> = (set, get) => {
  const history = createHistory<Project>(initialProject());
  // 未保存検知: 最後に保存/開いた時点の Project 参照。現在がこれと異なれば dirty。
  let savedRef: Project | null = history.current();

  const sync = (extra: Partial<AppState> = {}) =>
    set({
      project: history.current(),
      canUndo: history.canUndo(),
      canRedo: history.canRedo(),
      dirty: history.current() !== savedRef,
      ...extra,
    });

  // core/details を変えるコマンド: 現在ビューを保証 → reconcile → 履歴 push（1 undo 単位）
  const commit = (p: Project) => {
    const withView = ensureLevelView(p, get().level, get().scopeParentId);
    history.push(reconcileProject(withView, uuid));
    sync();
  };

  // 現在ビューのオーバーレイ（制御ノード/コメント/手動エッジ等）を直接編集して履歴に積む。
  const editView = (fn: (view: FlowLevelView, project: Project) => void) => {
    const { level, scopeParentId } = get();
    const p = structuredClone(get().project);
    const view = p.flow.byLevel.find(
      (v) => v.level === level && (v.scopeParentId ?? undefined) === (scopeParentId ?? undefined),
    );
    if (!view) return;
    fn(view, p);
    history.push(p);
    sync();
  };

  // ファイルを開く/新規/取り込み: 既定ビューを保証して履歴をリセット（undo 不可の境界）
  const adopt = (p: Project, level: ProcessLevel, scopeParentId?: Id, dirtyAfter = false) => {
    const reconciled = reconcileProject(ensureLevelView(p, level, scopeParentId), uuid);
    history.reset(reconciled);
    savedRef = dirtyAfter ? null : reconciled; // 開く/新規=保存済みベース、取込=未保存
    set({
      project: reconciled,
      canUndo: false,
      canRedo: false,
      dirty: dirtyAfter,
      selectedTaskId: undefined,
      level,
      scopeParentId,
    });
  };

  const defaultScopeFor = (level: ProcessLevel): Id | undefined => {
    if (level === 'large') return undefined;
    const parentRank = RANK[level] - 1;
    const parentLevel = LEVELS[parentRank]!;
    const candidate = Object.values(get().project.core.tasks).find((t) => t.level === parentLevel);
    return candidate?.id;
  };

  // 同一親グループの兄弟を order 昇順で返す。
  const siblingsOf = (taskId: Id) =>
    Object.values(get().project.core.tasks)
      .filter(
        (o) =>
          (o.parentId ?? undefined) ===
          (get().project.core.tasks[taskId]?.parentId ?? undefined),
      )
      .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));

  // reparent は実質変化があるときだけコミット（深さ超過・循環などの no-op で履歴を汚さない）。
  const commitReparent = (taskId: Id, newParentId: Id | undefined, index?: number) => {
    const cur = get().project;
    const applied = cReparentTask(cur, taskId, newParentId, index);
    const a = cur.core.tasks[taskId];
    const b = applied.core.tasks[taskId];
    if (a && b && (a.parentId !== b.parentId || a.level !== b.level || a.order !== b.order)) {
      commit(applied);
    }
  };

  return {
    project: history.current(),
    canUndo: false,
    canRedo: false,
    dirty: false,
    selectedTaskId: undefined,
    level: 'medium',
    scopeParentId: undefined,
    showIssues: true,

    addTask: (name) =>
      commit(
        cAddTask(
          get().project,
          { name: name || '新規作業', level: get().level, parentId: get().scopeParentId },
          uuid,
        ),
      ),

    addRootTask: (level) =>
      commit(cAddTask(get().project, { name: '新規工程', level, parentId: undefined }, uuid)),

    addChildTask: (parentId) => {
      const parent = get().project.core.tasks[parentId];
      if (!parent) return;
      const childLevel = LEVELS[RANK[parent.level] + 1] ?? 'detail';
      commit(cAddTask(get().project, { name: '新規工程', level: childLevel, parentId }, uuid));
    },

    removeTask: (taskId) => commit(cDeleteTask(get().project, taskId)),

    setTaskLevel: (taskId, level) => commit(cSetTaskLevel(get().project, taskId, level)),
    setTaskCode: (taskId, code) => commit(cSetTaskCode(get().project, taskId, code)),

    renameTask: (taskId, name) => commit(cRenameTask(get().project, taskId, name)),

    setAssigneeByName: (taskId, name) => {
      let p = get().project;
      const trimmed = name.trim();
      if (!trimmed) {
        commit(cSetAssignee(p, taskId, undefined));
        return;
      }
      const existing = Object.values(p.core.assignees).find((a) => a.name === trimmed);
      let assigneeId: Id;
      if (existing) {
        assigneeId = existing.id;
      } else {
        p = cAddAssignee(p, { name: trimmed, kind: 'department' }, uuid);
        assigneeId = Object.values(p.core.assignees).find((a) => a.name === trimmed)!.id;
      }
      commit(cSetAssignee(p, taskId, assigneeId));
    },

    addDependency: (from, to) => {
      if (!from || !to || from === to) return;
      commit(cAddDependency(get().project, from, to, uuid));
    },

    removeDependency: (depId) => commit(cRemoveDependency(get().project, depId)),

    // 「次行を追加」: 同じ親・同じ粒度の兄弟を末尾に足し、新タスクの id を返す（フォーカス用）。
    addSiblingOf: (taskId) => {
      const t = get().project.core.tasks[taskId];
      if (!t) return undefined;
      const before = new Set(Object.keys(get().project.core.tasks));
      commit(cAddTask(get().project, { name: '', level: t.level, parentId: t.parentId }, uuid));
      return Object.keys(get().project.core.tasks).find((id) => !before.has(id));
    },

    moveTaskUp: (taskId) => {
      const sibs = siblingsOf(taskId);
      const idx = sibs.findIndex((t) => t.id === taskId);
      if (idx > 0) commit(cReorderTask(get().project, taskId, idx - 1));
    },
    moveTaskDown: (taskId) => {
      const sibs = siblingsOf(taskId);
      const idx = sibs.findIndex((t) => t.id === taskId);
      if (idx >= 0 && idx < sibs.length - 1) commit(cReorderTask(get().project, taskId, idx + 1));
    },
    indentTask: (taskId) => {
      const sibs = siblingsOf(taskId);
      const idx = sibs.findIndex((t) => t.id === taskId);
      if (idx > 0) commitReparent(taskId, sibs[idx - 1]!.id); // 直前の兄弟の子へ
    },
    outdentTask: (taskId) => {
      const t = get().project.core.tasks[taskId];
      if (!t || t.parentId === undefined) return; // 既に root
      const parent = get().project.core.tasks[t.parentId];
      if (!parent) return;
      const gpSibs = Object.values(get().project.core.tasks)
        .filter((o) => (o.parentId ?? undefined) === (parent.parentId ?? undefined))
        .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
      const parentIdx = gpSibs.findIndex((o) => o.id === parent.id);
      commitReparent(taskId, parent.parentId, parentIdx + 1); // 親の直後（祖父母の子）へ
    },
    dropTask: (dragId, targetId, mode) => {
      if (dragId === targetId) return;
      const drag = get().project.core.tasks[dragId];
      const target = get().project.core.tasks[targetId];
      if (!drag || !target) return;
      if (mode === 'child') {
        commitReparent(dragId, targetId);
        return;
      }
      const targetParent = target.parentId;
      const sibs = Object.values(get().project.core.tasks)
        .filter((o) => (o.parentId ?? undefined) === (targetParent ?? undefined))
        .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
      const ti = sibs.findIndex((o) => o.id === targetId);
      if ((drag.parentId ?? undefined) === (targetParent ?? undefined)) {
        const di = sibs.findIndex((o) => o.id === dragId); // 同一グループ → 並べ替え
        const tiPost = di < ti ? ti - 1 : ti;
        commit(cReorderTask(get().project, dragId, mode === 'after' ? tiPost + 1 : tiPost));
      } else {
        commitReparent(dragId, targetParent, mode === 'after' ? ti + 1 : ti); // 別グループ → 移動
      }
    },

    addIo: (taskId, io, name) => {
      const lv = get().project.core.tasks[taskId]?.level;
      const kind: IoKind = lv === 'small' || lv === 'detail' ? 'info' : 'doc';
      commit(cAddIoItem(get().project, taskId, io, { name: name || '帳票', kind }, uuid));
    },
    updateIo: (taskId, ioId, patch) => commit(cUpdateIoItem(get().project, taskId, ioId, patch)),
    removeIo: (taskId, ioId) => commit(cRemoveIoItem(get().project, taskId, ioId)),

    addIssue: (taskId, text) => commit(cAddIssueItem(get().project, taskId, { issue: text || '課題' }, uuid)),
    updateIssue: (taskId, issueId, patch) => commit(cUpdateIssueItem(get().project, taskId, issueId, patch)),
    removeIssue: (taskId, issueId) => commit(cRemoveIssueItem(get().project, taskId, issueId)),
    updateDetail: (taskId, patch) => commit(cUpdateTaskDetail(get().project, taskId, patch)),

    // フロー上のドラッグ確定。別レーンに落ちたら担当を書き戻す（唯一の逆方向同期）。
    moveNode: (nodeId, x, y) => {
      const { level, scopeParentId } = get();
      const p = structuredClone(get().project);
      const vi = p.flow.byLevel.findIndex(
        (v) => v.level === level && (v.scopeParentId ?? undefined) === (scopeParentId ?? undefined),
      );
      const view = p.flow.byLevel[vi];
      const node = view?.nodes[nodeId];
      if (!view || !node) return;
      node.x = x;
      node.y = y;

      if (node.kind === 'task') {
        const laneOrder = Math.max(0, Math.round((y - 40) / 120));
        const lane = Object.values(view.lanes).find((l) => l.order === laneOrder);
        const task = p.core.tasks[node.taskId];
        if (lane?.assigneeId && task && task.assigneeId !== lane.assigneeId) {
          task.assigneeId = lane.assigneeId; // 逆同期: レーン → 担当
          history.push(reconcileProject(p, uuid));
          sync();
          return;
        }
      }
      history.push(p);
      sync();
    },

    // フロー固有要素（制御ノード/コメント/手動エッジ）の編集。view を直接いじって push。
    addControlNode: (control) =>
      editView((view) => {
        const id = uuid();
        const k = Object.values(view.nodes).filter((n) => n.kind === 'control').length;
        view.nodes[id] = { id, kind: 'control', control, x: 420 + k * 28, y: 44 + k * 18 };
      }),
    addComment: (text) =>
      editView((view) => {
        const id = uuid();
        const k = Object.values(view.nodes).filter((n) => n.kind === 'comment').length;
        view.nodes[id] = { id, kind: 'comment', text: text || 'メモ', x: 420, y: 320 + k * 24 };
      }),
    connect: (source, target) =>
      editView((view) => {
        if (source === target) return;
        if (Object.values(view.edges).some((e) => e.source === source && e.target === target)) return;
        const id = uuid();
        view.edges[id] = { id, source, target, pinned: true, role: 'flow' };
      }),
    setEdgeLabel: (edgeId, label) =>
      editView((view) => {
        const e = view.edges[edgeId];
        if (e) e.label = label || undefined;
      }),
    deleteFlowNode: (nodeId) =>
      editView((view) => {
        const n = view.nodes[nodeId];
        if (!n || (n.kind !== 'control' && n.kind !== 'comment')) return; // 図固有要素のみ削除可
        delete view.nodes[nodeId];
        for (const e of Object.values(view.edges)) {
          if (e.source === nodeId || e.target === nodeId) delete view.edges[e.id];
        }
      }),
    deleteEdge: (edgeId) =>
      editView((view) => {
        delete view.edges[edgeId];
      }),

    select: (taskId) => set({ selectedTaskId: taskId }),

    setLevel: (level) => {
      const scopeParentId = defaultScopeFor(level);
      const reconciled = reconcileProject(ensureLevelView(get().project, level, scopeParentId), uuid);
      history.replaceTop(reconciled); // 粒度切替はビュー状態（undo 対象外）
      set({ project: reconciled, level, scopeParentId, selectedTaskId: undefined });
    },

    setScope: (scopeParentId) => {
      const reconciled = reconcileProject(ensureLevelView(get().project, get().level, scopeParentId), uuid);
      history.replaceTop(reconciled);
      set({ project: reconciled, scopeParentId, selectedTaskId: undefined });
    },

    toggleIssues: () => set({ showIssues: !get().showIssues }),

    undo: () => {
      if (history.undo()) sync();
    },
    redo: () => {
      if (history.redo()) sync();
    },
    markSaved: () => {
      savedRef = history.current();
      set({ dirty: false });
    },

    loadProject: (project) => {
      const first = project.flow.byLevel[0];
      adopt(project, first?.level ?? 'medium', first?.scopeParentId);
    },
    importCsvText: (text) => {
      const { project, report } = importCsv(text, uuid);
      const hasLarge = Object.values(project.core.tasks).some((t) => t.level === 'large');
      adopt(project, hasLarge ? 'large' : 'medium', undefined, true);
      return report;
    },
    importRows: (rows) => {
      const { project, report } = rowsToProject(rows, uuid);
      const hasLarge = Object.values(project.core.tasks).some((t) => t.level === 'large');
      adopt(project, hasLarge ? 'large' : 'medium', undefined, true);
      return report;
    },
    newProject: () => adopt(initialProject(), 'medium', undefined),
  };
};

export const useApp = create<AppState>(appStateCreator);
export const createAppStore = () => createStore<AppState>(appStateCreator);
