import { describe, it, expect } from 'vitest';
import {
  addTask,
  addDependency,
  addParallelTask,
  makeParallel,
  deleteTask,
  deleteTaskKeepChildren,
  reparentTask,
} from '../src/commands';
import { computeCodes } from '../src/codes';
import { isMilestone } from '../src/milestone';
import { ProjectSchema } from '../src/model/schema';
import { counter, emptyProject, taskIdByName } from './helpers';

function base() {
  const g = counter();
  let p = emptyProject();
  p = addTask(p, { name: 'A', level: 'medium' }, g);
  p = addTask(p, { name: 'B', level: 'medium' }, g);
  p = addTask(p, { name: '節目', level: 'medium', kind: 'milestone' }, g);
  p = addTask(p, { name: 'C', level: 'medium' }, g);
  return { p, g };
}

describe('milestone core', () => {
  it('addTask kind:milestone → isMilestone が真・通常タスクは偽', () => {
    const { p } = base();
    expect(isMilestone(p.core, taskIdByName(p, '節目'))).toBe(true);
    expect(isMilestone(p.core, taskIdByName(p, 'A'))).toBe(false);
  });

  it('入依存（工程→MS）は張れるが、出依存（MS→工程）は no-op', () => {
    const { p, g } = base();
    const ms = taskIdByName(p, '節目');
    const a = taskIdByName(p, 'A');
    const p2 = addDependency(p, a, ms, g);
    expect(Object.values(p2.core.dependencies).some((d) => d.from === a && d.to === ms)).toBe(true);
    const p3 = addDependency(p2, ms, taskIdByName(p, 'C'), g);
    expect(Object.values(p3.core.dependencies).some((d) => d.from === ms)).toBe(false);
  });

  it('MS を親にする addTask / reparentTask は no-op', () => {
    const { p, g } = base();
    const ms = taskIdByName(p, '節目');
    const before = Object.keys(p.core.tasks).length;
    const p2 = addTask(p, { name: '子', level: 'small', parentId: ms }, g);
    expect(Object.keys(p2.core.tasks).length).toBe(before);
    const p3 = reparentTask(p, taskIdByName(p, 'C'), ms);
    expect(p3.core.tasks[taskIdByName(p, 'C')]!.parentId).not.toBe(ms);
  });

  it('deleteTask のブリッジは MS を経由しない（不正データからの防御）', () => {
    const { p, g } = base();
    const a = taskIdByName(p, 'A');
    const b = taskIdByName(p, 'B');
    const c = taskIdByName(p, 'C');
    const ms = taskIdByName(p, '節目');
    // A → B を張る
    let q = addDependency(p, a, b, g);
    // 出依存ガードを迂回して MS → B を直接注入（ディスクから読んだ不正データの再現）
    q = structuredClone(q);
    q.core.dependencies['bad-dep'] = { id: 'bad-dep', from: ms, to: b, type: 'FS', scopeParentId: undefined };
    // B → C を張って、B が後続を持つようにする（ブリッジ生成が走る条件）
    q = addDependency(q, b, c, g);
    // B を削除
    const afterDelete = deleteTask(q, b);
    // MS からの出依存が存在しないこと、A → C ブリッジが作られたことを確認
    expect(Object.values(afterDelete.core.dependencies).some((d) => d.from === ms)).toBe(false);
    expect(Object.values(afterDelete.core.dependencies).some((d) => d.from === a && d.to === c)).toBe(true);
  });

  it('deleteTaskKeepChildren のブリッジも MS を経由しない（不正データからの防御）', () => {
    const { p, g } = base();
    const a = taskIdByName(p, 'A');
    const b = taskIdByName(p, 'B');
    const c = taskIdByName(p, 'C');
    const ms = taskIdByName(p, '節目');
    // A → B を張る
    let q = addDependency(p, a, b, g);
    // 出依存ガードを迂回して MS → B を直接注入（ディスクから読んだ不正データの再現）
    q = structuredClone(q);
    q.core.dependencies['bad-dep'] = { id: 'bad-dep', from: ms, to: b, type: 'FS', scopeParentId: undefined };
    // B → C を張って、B が後続を持つようにする（ブリッジ生成が走る条件）
    q = addDependency(q, b, c, g);
    // B を削除（子を残す）
    const afterDeleteKeep = deleteTaskKeepChildren(q, b);
    // MS からの出依存が存在しないこと、A → C ブリッジが作られたことを確認
    expect(Object.values(afterDeleteKeep.core.dependencies).some((d) => d.from === ms)).toBe(false);
    expect(Object.values(afterDeleteKeep.core.dependencies).some((d) => d.from === a && d.to === c)).toBe(true);
  });

  it('computeCodes は MS を採番せず、兄弟の番号も飛ばない', () => {
    const { p } = base();
    const codes = computeCodes(p.core);
    expect(codes[taskIdByName(p, '節目')]).toBeUndefined();
    expect(codes[taskIdByName(p, 'A')]).toBe('1');
    expect(codes[taskIdByName(p, 'B')]).toBe('2');
    expect(codes[taskIdByName(p, 'C')]).toBe('3'); // MS がいても 3（4 にならない）
  });

  it('addParallelTask は MS を基準にすると no-op', () => {
    const { p, g } = base();
    const ms = taskIdByName(p, '節目');
    const before = Object.keys(p.core.tasks).length;
    const p2 = addParallelTask(p, ms, g);
    expect(Object.keys(p2.core.tasks).length).toBe(before);
  });

  it('makeParallel は MS が対象/基準のどちらでも no-op', () => {
    const { p, g } = base();
    const ms = taskIdByName(p, '節目');
    const a = taskIdByName(p, 'A');
    const c = taskIdByName(p, 'C');
    const depsBefore = Object.keys(p.core.dependencies).length;
    const p2 = makeParallel(p, ms, a, g); // MS を対象にする
    expect(Object.keys(p2.core.dependencies).length).toBe(depsBefore);
    const p3 = makeParallel(p, c, ms, g); // MS を基準にする
    expect(Object.keys(p3.core.dependencies).length).toBe(depsBefore);
  });

  it('kind なしの既存データはそのまま Zod を通る（後方互換）', () => {
    const { p } = base();
    delete (p.core.tasks[taskIdByName(p, 'A')] as unknown as Record<string, unknown>)['kind'];
    const result = ProjectSchema.safeParse(p);
    expect(result.success).toBe(true);
  });
});
