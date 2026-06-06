import { describe, it, expect } from 'vitest';
import { addTask, addDependency, reorderTask, reparentTask } from '../src/commands';
import { counter, emptyProject, taskIdByName } from './helpers';

describe('reorderTask', () => {
  it('兄弟を末尾へ移動し order を 0..n-1 に正規化', () => {
    const g = counter();
    let p = emptyProject();
    p = addTask(p, { name: 'A', level: 'medium' }, g);
    p = addTask(p, { name: 'B', level: 'medium' }, g);
    p = addTask(p, { name: 'C', level: 'medium' }, g);
    p = reorderTask(p, taskIdByName(p, 'A'), 2); // A を末尾へ
    const order = (n: string) => p.core.tasks[taskIdByName(p, n)]!.order;
    expect(order('B')).toBe(0);
    expect(order('C')).toBe(1);
    expect(order('A')).toBe(2);
  });

  it('範囲外 index はクランプ／同位置は no-op', () => {
    const g = counter();
    let p = emptyProject();
    p = addTask(p, { name: 'A', level: 'medium' }, g);
    p = addTask(p, { name: 'B', level: 'medium' }, g);
    const before = structuredClone(p);
    expect(reorderTask(p, taskIdByName(p, 'A'), 0)).toEqual(before); // 同位置
    const moved = reorderTask(p, taskIdByName(p, 'A'), 99); // クランプ→末尾
    expect(moved.core.tasks[taskIdByName(moved, 'A')]!.order).toBe(1);
  });
});

describe('reparentTask', () => {
  it('直前の兄弟の子にして level を一段深く・移動ルートの依存を撤去', () => {
    const g = counter();
    let p = emptyProject();
    p = addTask(p, { name: 'A', level: 'medium' }, g);
    p = addTask(p, { name: 'B', level: 'medium' }, g);
    p = addDependency(p, taskIdByName(p, 'A'), taskIdByName(p, 'B'), g); // A→B
    const aId = taskIdByName(p, 'A');
    const bId = taskIdByName(p, 'B');
    p = reparentTask(p, bId, aId); // B を A の子へ（インデント）
    expect(p.core.tasks[bId]!.parentId).toBe(aId);
    expect(p.core.tasks[bId]!.level).toBe('small'); // medium → small
    expect(Object.values(p.core.dependencies).some((d) => d.from === bId || d.to === bId)).toBe(
      false,
    );
  });

  it('親なし(root)へ移すと level=large（アウトデント）', () => {
    const g = counter();
    let p = emptyProject();
    p = addTask(p, { name: 'P', level: 'large' }, g);
    p = addTask(p, { name: 'C', level: 'medium', parentId: taskIdByName(p, 'P') }, g);
    const cId = taskIdByName(p, 'C');
    p = reparentTask(p, cId, undefined);
    expect(p.core.tasks[cId]!.parentId).toBeUndefined();
    expect(p.core.tasks[cId]!.level).toBe('large');
  });

  it('自分の子孫の下へは移動しない（循環防止・no-op）', () => {
    const g = counter();
    let p = emptyProject();
    p = addTask(p, { name: 'P', level: 'large' }, g);
    p = addTask(p, { name: 'C', level: 'medium', parentId: taskIdByName(p, 'P') }, g);
    const pId = taskIdByName(p, 'P');
    const cId = taskIdByName(p, 'C');
    const before = structuredClone(p);
    expect(reparentTask(p, pId, cId)).toEqual(before);
  });

  it('detail を超える深さになる移動は no-op', () => {
    const g = counter();
    let p = emptyProject();
    p = addTask(p, { name: 'S', level: 'small' }, g);
    p = addTask(p, { name: 'D', level: 'detail', parentId: taskIdByName(p, 'S') }, g);
    p = addTask(p, { name: 'S2', level: 'small' }, g);
    const sId = taskIdByName(p, 'S');
    const s2Id = taskIdByName(p, 'S2');
    const before = structuredClone(p);
    // S(small)→S2 の子(detail) になると配下 D(detail) が範囲外 → 中止
    expect(reparentTask(p, sId, s2Id)).toEqual(before);
  });

  it('サブツリー内部の依存は保持し、移動ルートの依存のみ撤去・level を一括シフト', () => {
    const g = counter();
    let p = emptyProject();
    p = addTask(p, { name: 'P', level: 'large' }, g);
    const pId = taskIdByName(p, 'P');
    p = addTask(p, { name: 'X', level: 'medium', parentId: pId }, g);
    p = addTask(p, { name: 'Y', level: 'medium', parentId: pId }, g);
    const xId = taskIdByName(p, 'X');
    p = addTask(p, { name: 'a', level: 'small', parentId: xId }, g);
    p = addTask(p, { name: 'b', level: 'small', parentId: xId }, g);
    p = addDependency(p, taskIdByName(p, 'a'), taskIdByName(p, 'b'), g); // a→b（X 内部）
    p = addDependency(p, xId, taskIdByName(p, 'Y'), g); // X→Y（X が端点）
    p = reparentTask(p, xId, undefined); // X を root へ

    const aId = taskIdByName(p, 'a');
    const bId = taskIdByName(p, 'b');
    expect(Object.values(p.core.dependencies).some((d) => d.from === xId || d.to === xId)).toBe(
      false,
    ); // X→Y は撤去
    expect(Object.values(p.core.dependencies).some((d) => d.from === aId && d.to === bId)).toBe(
      true,
    ); // a→b は保持
    expect(p.core.tasks[xId]!.level).toBe('large'); // medium→large
    expect(p.core.tasks[aId]!.level).toBe('medium'); // small→medium
  });
});
