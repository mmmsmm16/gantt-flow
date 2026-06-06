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
  CURRENT_SCHEMA_VERSION,
  uuid,
  createHistory,
  reconcileProject,
  ensureLevelView,
  importCsv,
  addTask as cAddTask,
  renameTask as cRenameTask,
  setAssignee as cSetAssignee,
  addAssignee as cAddAssignee,
  addDependency as cAddDependency,
  addIoItem as cAddIoItem,
  addIssueItem as cAddIssueItem,
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

  addTask: (name: string) => void;
  renameTask: (taskId: Id, name: string) => void;
  setAssigneeByName: (taskId: Id, name: string) => void;
  addDependency: (from: Id, to: Id) => void;
  addIo: (taskId: Id, io: 'inputs' | 'outputs', name: string) => void;
  addIssue: (taskId: Id, text: string) => void;
  moveNode: (nodeId: FlowNodeId, x: number, y: number) => void;
  select: (taskId?: Id) => void;
  setLevel: (level: ProcessLevel) => void;
  setScope: (scopeParentId?: Id) => void;
  toggleIssues: () => void;
  undo: () => void;
  redo: () => void;
  loadProject: (project: Project) => void;
  importCsvText: (text: string) => void;
  newProject: () => void;
}

export const appStateCreator: StateCreator<AppState> = (set, get) => {
  const history = createHistory<Project>(initialProject());

  const sync = (extra: Partial<AppState> = {}) =>
    set({
      project: history.current(),
      canUndo: history.canUndo(),
      canRedo: history.canRedo(),
      ...extra,
    });

  // core/details を変えるコマンド: 現在ビューを保証 → reconcile → 履歴 push（1 undo 単位）
  const commit = (p: Project) => {
    const withView = ensureLevelView(p, get().level, get().scopeParentId);
    history.push(reconcileProject(withView, uuid));
    sync();
  };

  // ファイルを開く/新規/取り込み: 既定ビューを保証して履歴をリセット（undo 不可の境界）
  const adopt = (p: Project, level: ProcessLevel, scopeParentId?: Id) => {
    const reconciled = reconcileProject(ensureLevelView(p, level, scopeParentId), uuid);
    history.reset(reconciled);
    set({
      project: reconciled,
      canUndo: false,
      canRedo: false,
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

  return {
    project: history.current(),
    canUndo: false,
    canRedo: false,
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

    addIo: (taskId, io, name) =>
      commit(cAddIoItem(get().project, taskId, io, { name: name || '帳票', kind: 'doc' }, uuid)),

    addIssue: (taskId, text) => commit(cAddIssueItem(get().project, taskId, { issue: text || '課題' }, uuid)),

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

    loadProject: (project) => {
      const first = project.flow.byLevel[0];
      adopt(project, first?.level ?? 'medium', first?.scopeParentId);
    },
    importCsvText: (text) => {
      const { project } = importCsv(text, uuid);
      const hasLarge = Object.values(project.core.tasks).some((t) => t.level === 'large');
      adopt(project, hasLarge ? 'large' : 'medium', undefined);
    },
    newProject: () => adopt(initialProject(), 'medium', undefined),
  };
};

export const useApp = create<AppState>(appStateCreator);
export const createAppStore = () => createStore<AppState>(appStateCreator);
