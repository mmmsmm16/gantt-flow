import type { Project, FlowLevelView, ProcessLevel, Id } from '../src/model/types';
import type { IdGen } from '../src/ids';

// 決定論的な ID 生成（テスト用）
export function counter(prefix = 'id'): IdGen {
  let i = 0;
  return () => `${prefix}-${String(i++).padStart(3, '0')}`;
}

export function emptyProject(): Project {
  return {
    schemaVersion: 2,
    meta: { id: 'p', title: 'test', createdAt: '', updatedAt: '', appVersion: '0' },
    core: { tasks: {}, dependencies: {}, assignees: {} },
    details: {},
    flow: { byLevel: [] },
    manual: { procedures: {}, assets: {} },
  };
}

export function emptyView(level: ProcessLevel = 'medium', scopeParentId?: Id): FlowLevelView {
  return {
    level,
    scopeParentId,
    nodes: {},
    edges: {},
    lanes: {},
    orientation: 'horizontal',
  };
}

export function taskIdByName(p: Project, name: string): Id {
  const t = Object.values(p.core.tasks).find((t) => t.name === name);
  if (!t) throw new Error(`task not found: ${name}`);
  return t.id;
}

export function assigneeIdByName(p: Project, name: string): Id {
  const a = Object.values(p.core.assignees).find((a) => a.name === name);
  if (!a) throw new Error(`assignee not found: ${name}`);
  return a.id;
}
