import { describe, expect, it } from 'vitest';
import { counter, emptyProject } from './helpers';
import { addTask, addDependency } from '../src/commands';
import { deriveProcedureNav } from '../src/sync/procedureNav';

describe('deriveProcedureNav', () => {
  it('末端工程を依存＋order で直列化し、並行を ∥ フラグにする', () => {
    const g = counter();
    let p = emptyProject();
    p = addTask(p, { name: '中', level: 'medium', id: 'M', order: 0 }, g);
    p = addTask(p, { name: 'A', level: 'small', parentId: 'M', id: 'A', order: 0 }, g);
    p = addTask(p, { name: 'B', level: 'small', parentId: 'M', id: 'B', order: 1 }, g);
    p = addTask(p, { name: 'C', level: 'small', parentId: 'M', id: 'C', order: 2 }, g);
    p = addDependency(p, 'A', 'B', g); // A→B、C は独立（A と並行）
    const nav = deriveProcedureNav(p.core, 'M', p.manual);
    expect(nav.map((n) => [n.taskId, n.layer, n.parallel])).toEqual([
      ['A', 0, true],
      ['C', 0, true],
      ['B', 1, false],
    ]);
  });

  it('hasProcedure は手順書に steps が 1 件以上あるときだけ true', () => {
    const g = counter();
    let p = emptyProject();
    p = addTask(p, { name: '中', level: 'medium', id: 'M', order: 0 }, g);
    p = addTask(p, { name: 'A', level: 'small', parentId: 'M', id: 'A', order: 0 }, g);
    const nav = deriveProcedureNav(p.core, 'M', p.manual);
    expect(nav.map((n) => n.hasProcedure)).toEqual([false]);
  });

  it('循環した依存でも無限ループしない（visited ガード）', () => {
    const g = counter();
    let p = emptyProject();
    p = addTask(p, { name: '中', level: 'medium', id: 'M', order: 0 }, g);
    p = addTask(p, { name: 'A', level: 'small', parentId: 'M', id: 'A', order: 0 }, g);
    p = addTask(p, { name: 'B', level: 'small', parentId: 'M', id: 'B', order: 1 }, g);
    p = addDependency(p, 'A', 'B', g);
    p = addDependency(p, 'B', 'A', g); // 通常は addDependency の exists ガードで循環にはならないが、念のため
    expect(() => deriveProcedureNav(p.core, 'M', p.manual)).not.toThrow();
  });
});
