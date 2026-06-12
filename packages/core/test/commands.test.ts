import { describe, it, expect } from 'vitest';
import {
  addTask,
  renameTask,
  setAssignee,
  addAssignee,
  addDependency,
  addParallelTask,
  makeParallel,
  removeDependency,
  deleteTask,
  deleteTaskKeepChildren,
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

  it('addTask は id 指定があればそれを使う（省略時は idGen 発番）', () => {
    const g = counter();
    let p = emptyProject();
    p = addTask(p, { name: 'A', level: 'medium', id: 'fixed-id' }, g);
    expect(p.core.tasks['fixed-id']).toBeDefined();
    expect(p.core.tasks['fixed-id']!.name).toBe('A');
    expect(p.details['fixed-id']).toEqual({ taskId: 'fixed-id' });
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

  it('addDependency は実在しない工程への依存を作らない（strict 検証で開けないファイルを防ぐ）', () => {
    const g = counter();
    let p = emptyProject();
    p = addTask(p, { name: 'A', level: 'medium' }, g);
    const a = taskIdByName(p, 'A');
    p = addDependency(p, a, 'ghost', g); // to が不在
    p = addDependency(p, 'ghost', a, g); // from が不在
    expect(Object.keys(p.core.dependencies)).toHaveLength(0);
    expect(validate(p)).toHaveLength(0);
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

  it('deleteTaskKeepChildren は配下を残し、1段繰り上げて依存を維持する', () => {
    const g = counter();
    let p = emptyProject();
    p = addTask(p, { name: '大', level: 'large' }, g);
    const L = taskIdByName(p, '大');
    p = addTask(p, { name: '中', level: 'medium', parentId: L }, g);
    const M = taskIdByName(p, '中');
    p = addTask(p, { name: '小', level: 'small', parentId: M }, g);
    const S = taskIdByName(p, '小');
    p = addTask(p, { name: '詳', level: 'detail', parentId: S }, g);
    const D = taskIdByName(p, '詳');
    // 中を削除 → 小・詳は残り、1段ずつ繰り上げ。小は大の子（中レベル）に。
    p = deleteTaskKeepChildren(p, M);
    expect(p.core.tasks[M]).toBeUndefined();
    expect(p.details[M]).toBeUndefined();
    expect(p.core.tasks[S]).toBeDefined();
    expect(p.core.tasks[S]!.parentId).toBe(L); // 祖父へ昇格
    expect(p.core.tasks[S]!.level).toBe('medium'); // 小→中
    expect(p.core.tasks[D]!.level).toBe('small'); // 詳→小（サブツリーごと繰り上げ）
    expect(p.core.tasks[D]!.parentId).toBe(S); // 親子関係は維持
    expect(validate(p)).toHaveLength(0);
  });

  it('deleteTaskKeepChildren は子同士の依存スコープを祖父へ付け替える', () => {
    const g = counter();
    let p = emptyProject();
    p = addTask(p, { name: '大', level: 'large' }, g);
    const L = taskIdByName(p, '大');
    p = addTask(p, { name: '中', level: 'medium', parentId: L }, g);
    const M = taskIdByName(p, '中');
    p = addTask(p, { name: '小1', level: 'small', parentId: M }, g);
    p = addTask(p, { name: '小2', level: 'small', parentId: M }, g);
    const s1 = taskIdByName(p, '小1');
    const s2 = taskIdByName(p, '小2');
    p = addDependency(p, s1, s2, g); // scope = 中
    p = deleteTaskKeepChildren(p, M);
    // 小1/小2 は大の子になり、依存のスコープも大へ追従（スコープビューで矢印が消えない）
    const dep = Object.values(p.core.dependencies).find((d) => d.from === s1 && d.to === s2);
    expect(dep).toBeDefined();
    expect(dep!.scopeParentId).toBe(L);
    // さらに大を削除 → ルート昇格に合わせてスコープは未設定（ルート）になる
    p = deleteTaskKeepChildren(p, L);
    const dep2 = Object.values(p.core.dependencies).find((d) => d.from === s1 && d.to === s2);
    expect(dep2!.scopeParentId).toBeUndefined();
    expect(validate(p)).toHaveLength(0);
  });

  it('deleteTaskKeepChildren は前後をブリッジする（A→[X]→B ⇒ A→B）', () => {
    const g = counter();
    let p = emptyProject();
    p = addTask(p, { name: 'A', level: 'medium' }, g);
    p = addTask(p, { name: 'X', level: 'medium' }, g);
    p = addTask(p, { name: 'B', level: 'medium' }, g);
    const a = taskIdByName(p, 'A');
    const x = taskIdByName(p, 'X');
    const b = taskIdByName(p, 'B');
    p = addDependency(p, a, x, g);
    p = addDependency(p, x, b, g);
    p = deleteTaskKeepChildren(p, x);
    expect(p.core.tasks[x]).toBeUndefined();
    const deps = Object.values(p.core.dependencies);
    expect(deps.some((d) => d.from === a && d.to === b)).toBe(true);
    expect(deps.some((d) => d.from === x || d.to === x)).toBe(false);
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

  it('addParallelTask は前工程のみコピーし、属性は基準と同じ・order は基準の直後になる', () => {
    const g = counter();
    let p = emptyProject();
    p = addAssignee(p, { name: '営業', kind: 'department' }, g);
    const who = assigneeIdByName(p, '営業');
    p = addTask(p, { name: 'A', level: 'medium' }, g);
    p = addTask(p, { name: 'B', level: 'medium', assigneeId: who }, g);
    p = addTask(p, { name: 'C', level: 'medium' }, g);
    const a = taskIdByName(p, 'A');
    const b = taskIdByName(p, 'B');
    const c = taskIdByName(p, 'C');
    p = addDependency(p, a, b, g);
    p = addDependency(p, b, c, g);

    p = addParallelTask(p, b, g, 'new-id');
    const nu = p.core.tasks['new-id']!;
    const deps = Object.values(p.core.dependencies);
    // 前工程 A→新 はコピーされ、後続 新→C は張られない
    expect(deps.some((d) => d.from === a && d.to === 'new-id')).toBe(true);
    expect(deps.some((d) => d.from === 'new-id')).toBe(false);
    // 属性は基準と同じ、order は基準の直後、詳細は空
    expect(nu.level).toBe('medium');
    expect(nu.assigneeId).toBe(who);
    expect(nu.order).toBe(p.core.tasks[b]!.order + 1);
    expect(p.details['new-id']).toEqual({ taskId: 'new-id' });
    expect(validate(p)).toHaveLength(0);
  });

  it('addParallelTask は基準が不在なら no-op', () => {
    const g = counter();
    const p = emptyProject();
    const q = addParallelTask(p, 'missing', g);
    expect(Object.keys(q.core.tasks)).toHaveLength(0);
  });

  it('makeParallel: X→Y→B→C で B を Y と並行にすると X→{Y,B}→C になる', () => {
    const g = counter();
    let p = emptyProject();
    for (const name of ['X', 'Y', 'B', 'C']) p = addTask(p, { name, level: 'medium' }, g);
    const id = (n: string) => taskIdByName(p, n);
    p = addDependency(p, id('X'), id('Y'), g);
    p = addDependency(p, id('Y'), id('B'), g);
    p = addDependency(p, id('B'), id('C'), g);

    p = makeParallel(p, id('B'), id('Y'), g);
    const pairs = Object.values(p.core.dependencies)
      .map((d) => `${p.core.tasks[d.from]!.name}→${p.core.tasks[d.to]!.name}`)
      .sort();
    expect(pairs).toEqual(['B→C', 'X→B', 'X→Y', 'Y→C']);
    expect(validate(p)).toHaveLength(0);
  });

  it('makeParallel: 別チェーンの工程を並行化すると旧チェーンは heal で直結される', () => {
    const g = counter();
    let p = emptyProject();
    for (const name of ['A', 'B', 'D', 'X', 'Y', 'C']) p = addTask(p, { name, level: 'medium' }, g);
    const id = (n: string) => taskIdByName(p, n);
    p = addDependency(p, id('A'), id('B'), g);
    p = addDependency(p, id('B'), id('D'), g);
    p = addDependency(p, id('X'), id('Y'), g);
    p = addDependency(p, id('Y'), id('C'), g);

    p = makeParallel(p, id('B'), id('Y'), g);
    const pairs = Object.values(p.core.dependencies)
      .map((d) => `${p.core.tasks[d.from]!.name}→${p.core.tasks[d.to]!.name}`)
      .sort();
    // 旧チェーン A→[B]→D は A→D に heal、B は Y と同じ前後（X→B, B→C）
    expect(pairs).toEqual(['A→D', 'B→C', 'X→B', 'X→Y', 'Y→C']);
  });

  it('makeParallel: 既に同じ依存があっても重複しない', () => {
    const g = counter();
    let p = emptyProject();
    for (const name of ['X', 'Y', 'B']) p = addTask(p, { name, level: 'medium' }, g);
    const id = (n: string) => taskIdByName(p, n);
    p = addDependency(p, id('X'), id('Y'), g);
    p = addDependency(p, id('X'), id('B'), g); // コピー予定の依存が既に存在

    p = makeParallel(p, id('B'), id('Y'), g);
    const xb = Object.values(p.core.dependencies).filter(
      (d) => d.from === id('X') && d.to === id('B'),
    );
    expect(xb).toHaveLength(1);
  });

  it('makeParallel: 同一 ID・粒度違いは no-op', () => {
    const g = counter();
    let p = emptyProject();
    p = addTask(p, { name: 'P', level: 'large' }, g);
    p = addTask(p, { name: 'B', level: 'medium', parentId: taskIdByName(p, 'P') }, g);
    const big = taskIdByName(p, 'P');
    const b = taskIdByName(p, 'B');
    const before = Object.keys(p.core.dependencies).length;
    let q = makeParallel(p, b, b, g);
    expect(Object.keys(q.core.dependencies)).toHaveLength(before);
    q = makeParallel(p, b, big, g); // 粒度違い
    expect(Object.keys(q.core.dependencies)).toHaveLength(before);
  });
});
