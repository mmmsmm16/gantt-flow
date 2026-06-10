import { describe, it, expect } from 'vitest';
import { addTask, addDependency } from '../src/commands';
import { deriveParentBridges, bridgePredMap } from '../src/sync/reconcileFlow';
import { counter, emptyProject, taskIdByName } from './helpers';

// L1(m1→m2) → L2(m3→m4) の親依存からブリッジ(m2→m3)が導出されるプロジェクトを作る
function build() {
  const g = counter();
  let p = emptyProject();
  p = addTask(p, { name: 'L1', level: 'large' }, g);
  p = addTask(p, { name: 'L2', level: 'large' }, g);
  const l1 = taskIdByName(p, 'L1');
  const l2 = taskIdByName(p, 'L2');
  p = addTask(p, { name: 'm1', level: 'medium', parentId: l1 }, g);
  p = addTask(p, { name: 'm2', level: 'medium', parentId: l1 }, g);
  p = addTask(p, { name: 'm3', level: 'medium', parentId: l2 }, g);
  p = addTask(p, { name: 'm4', level: 'medium', parentId: l2 }, g);
  p = addDependency(p, taskIdByName(p, 'm1'), taskIdByName(p, 'm2'), g); // L1 内の流れ
  p = addDependency(p, taskIdByName(p, 'm3'), taskIdByName(p, 'm4'), g); // L2 内の流れ
  p = addDependency(p, l1, l2, g); // 親(大)同士の接続
  return { p, g };
}

describe('deriveParentBridges: 親の依存 → 子の末端→先頭ブリッジ', () => {
  it('L1→L2 の依存から「L1 の末端(m2) → L2 の先頭(m3)」が導出される', () => {
    const { p } = build();
    const bridges = deriveParentBridges(p.core, 'medium');
    expect(bridges).toHaveLength(1);
    expect(bridges[0]!.from).toBe(taskIdByName(p, 'm2'));
    expect(bridges[0]!.to).toBe(taskIdByName(p, 'm3'));
    // 由来は親依存
    const parentDep = Object.values(p.core.dependencies).find(
      (d) => d.from === taskIdByName(p, 'L1') && d.to === taskIdByName(p, 'L2'),
    )!;
    expect(bridges[0]!.viaDepId).toBe(parentDep.id);
  });

  it('子に内部の流れが無ければ並び順の最後→最初で繋ぐ', () => {
    const g = counter();
    let p = emptyProject();
    p = addTask(p, { name: 'L1', level: 'large' }, g);
    p = addTask(p, { name: 'L2', level: 'large' }, g);
    p = addTask(p, { name: 'a', level: 'medium', parentId: taskIdByName(p, 'L1') }, g);
    p = addTask(p, { name: 'b', level: 'medium', parentId: taskIdByName(p, 'L1') }, g);
    p = addTask(p, { name: 'c', level: 'medium', parentId: taskIdByName(p, 'L2') }, g);
    p = addDependency(p, taskIdByName(p, 'L1'), taskIdByName(p, 'L2'), g);
    const bridges = deriveParentBridges(p.core, 'medium');
    expect(bridges).toHaveLength(1);
    expect(bridges[0]!.from).toBe(taskIdByName(p, 'b')); // order 最後
    expect(bridges[0]!.to).toBe(taskIdByName(p, 'c'));
  });

  it('親同士が繋がっていなければブリッジは無い。片側に子が無くても無い', () => {
    const g = counter();
    let p = emptyProject();
    p = addTask(p, { name: 'L1', level: 'large' }, g);
    p = addTask(p, { name: 'L2', level: 'large' }, g);
    p = addTask(p, { name: 'a', level: 'medium', parentId: taskIdByName(p, 'L1') }, g);
    expect(deriveParentBridges(p.core, 'medium')).toHaveLength(0); // 親依存なし
    p = addDependency(p, taskIdByName(p, 'L1'), taskIdByName(p, 'L2'), g);
    expect(deriveParentBridges(p.core, 'medium')).toHaveLength(0); // L2 に子なし
  });
});

describe('bridgePredMap: 工程表の前工程表示用マップ', () => {
  it('to 側の先頭工程に from 側の末端が「導出された前工程」として載る', () => {
    const { p } = build();
    const map = bridgePredMap(p.core);
    expect(map[taskIdByName(p, 'm3')]).toEqual([taskIdByName(p, 'm2')]);
    expect(map[taskIdByName(p, 'm1')]).toBeUndefined();
  });
});
