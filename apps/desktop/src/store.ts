// アプリ状態（Zustand）。core のコマンド＋reconcileProject＋history を薄く包むだけ。
// 「コマンド → reconcileProject → history.push」が 1 編集＝1 undo 単位（docs/01-architecture §6）。
import { create } from 'zustand';
import { createStore, type StateCreator } from 'zustand/vanilla';
import {
  type Project,
  type Id,
  type FlowNodeId,
  CURRENT_SCHEMA_VERSION,
  uuid,
  createHistory,
  reconcileProject,
  ensureLevelView,
  addTask as cAddTask,
  renameTask as cRenameTask,
  setAssignee as cSetAssignee,
  addAssignee as cAddAssignee,
  addDependency as cAddDependency,
  addIoItem as cAddIoItem,
  addIssueItem as cAddIssueItem,
} from '@gantt-flow/core';

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

  addTask: (name: string) => void;
  renameTask: (taskId: Id, name: string) => void;
  setAssigneeByName: (taskId: Id, name: string) => void;
  addDependency: (from: Id, to: Id) => void;
  addIo: (taskId: Id, io: 'inputs' | 'outputs', name: string) => void;
  addIssue: (taskId: Id, text: string) => void;
  moveNode: (nodeId: FlowNodeId, x: number, y: number) => void;
  select: (taskId?: Id) => void;
  undo: () => void;
  redo: () => void;
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

  // core/details を変えるコマンド: reconcile して履歴に積む（1 undo 単位）
  const commit = (p: Project) => {
    history.push(reconcileProject(p, uuid));
    sync();
  };

  return {
    project: history.current(),
    canUndo: false,
    canRedo: false,
    selectedTaskId: undefined,

    addTask: (name) => commit(cAddTask(get().project, { name: name || '新規作業', level: 'medium' }, uuid)),

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

    // フローのオーバーレイ移動（ドラッグ確定）。reconcile 不要、配置だけ変えて履歴に積む。
    moveNode: (nodeId, x, y) => {
      const p = structuredClone(get().project);
      const view = p.flow.byLevel[0];
      const node = view?.nodes[nodeId];
      if (!node) return;
      node.x = x;
      node.y = y;
      history.push(p);
      sync();
    },

    select: (taskId) => set({ selectedTaskId: taskId }),

    undo: () => {
      if (history.undo()) sync();
    },
    redo: () => {
      if (history.redo()) sync();
    },
  };
};

// React 用シングルトン
export const useApp = create<AppState>(appStateCreator);

// テスト用にヘッドレスな vanilla ストアを作る
export const createAppStore = () => createStore<AppState>(appStateCreator);
