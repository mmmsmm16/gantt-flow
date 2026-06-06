import { describe, it, expect } from 'vitest';
import {
  addTask,
  renameTask,
  setAssignee,
  addAssignee,
  addDependency,
  removeDependency,
  deleteTask,
} from '../src/commands';
import { validate } from '../src/validate';
import { counter, emptyProject, taskIdByName, assigneeIdByName } from './helpers';

describe('commands', () => {
  it('addTask は core にタスクと空の詳細を作る', () => {
    const g = counter();
    let p = emptyProject();
    p = addTask(p, { name: 'A', level: 'medium' }, g);
    const id = taskIdByName(p, 'A');
    expect(p.core.tasks[id]).toBeDefined();
    expect(p.details[id]).toEqual({ taskId: id });
    expect(p.core.tasks[id]!.order).toBe(0);
  });

  it('兄弟の order は自動採番される', () => {
    const g = counter();
    let p = emptyProject();
    p = addTask(p, { name: 'A', level: 'medium' }, g);
    p = addTask(p, { name: 'B', level: 'medium' }, g);
    expect(p.core.tasks[taskIdByName(p, 'B')]!.order).toBe(1);
  });

  it('コマンドは元の Project を変更しない（純粋）', () => {
    const g = counter();
    const p0 = emptyProject();
    const p1 = addTask(p0, { name: 'A', level: 'medium' }, g);
    expect(Object.keys(p0.core.tasks)).toHaveLength(0);
    expect(Object.keys(p1.core.tasks)).toHaveLength(1);
  });

  it('addDependency は重複・自己依存を作らない', () => {
    const g = counter();
    let p = emptyProject();
    p = addTask(p, { name: 'A', level: 'medium' }, g);
    p = addTask(p, { name: 'B', level: 'medium' }, g);
    const a = taskIdByName(p, 'A');
    const b = taskIdByName(p, 'B');
    p = addDependency(p, a, b, g);
    p = addDependency(p, a, b, g); // 重複
    p = addDependency(p, a, a, g); // 自己
    expect(Object.keys(p.core.dependencies)).toHaveLength(1);
  });

  it('removeDependency で削除できる', () => {
    const g = counter();
    let p = emptyProject();
    p = addTask(p, { name: 'A', level: 'medium' }, g);
    p = addTask(p, { name: 'B', level: 'medium' }, g);
    p = addDependency(p, taskIdByName(p, 'A'), taskIdByName(p, 'B'), g);
    const depId = Object.keys(p.core.dependencies)[0]!;
    p = removeDependency(p, depId);
    expect(Object.keys(p.core.dependencies)).toHaveLength(0);
  });

  it('deleteTask はサブツリーを消し、詳細も消す', () => {
    const g = counter();
    let p = emptyProject();
    p = addTask(p, { name: '親', level: 'medium' }, g);
    p = addTask(p, { name: '子', level: 'small', parentId: taskIdByName(p, '親') }, g);
    const parentId = taskIdByName(p, '親');
    p = deleteTask(p, parentId);
    expect(Object.keys(p.core.tasks)).toHaveLength(0);
    expect(Object.keys(p.details)).toHaveLength(0);
  });

  it('setAssignee で担当を付け外しできる', () => {
    const g = counter();
    let p = emptyProject();
    p = addAssignee(p, { name: '営業', kind: 'department' }, g);
    p = addTask(p, { name: 'A', level: 'medium' }, g);
    const id = taskIdByName(p, 'A');
    p = setAssignee(p, id, assigneeIdByName(p, '営業'));
    expect(p.core.tasks[id]!.assigneeId).toBe(assigneeIdByName(p, '営業'));
    p = setAssignee(p, id, undefined);
    expect(p.core.tasks[id]!.assigneeId).toBeUndefined();
  });

  it('renameTask 後も参照整合性が保たれる', () => {
    const g = counter();
    let p = emptyProject();
    p = addTask(p, { name: 'A', level: 'medium' }, g);
    p = renameTask(p, taskIdByName(p, 'A'), 'B');
    expect(validate(p)).toHaveLength(0);
  });
});
