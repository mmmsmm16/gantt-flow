import { describe, it, expect } from 'vitest';
import {
  totalEffortMinutes,
  criticalPathDays,
  totalWaitDays,
  diffByDifficulty,
  leafLtDays,
  leafEffortMinutes,
  leafDifficulty,
  computeCompare,
  projectScenarioCore,
  HOURS_PER_DAY,
} from '../src/compare';
import { addTask, addDependency, updateTaskToBe, copyAsIsToToBe } from '../src/commands';
import { counter, emptyProject, taskIdByName } from './helpers';

// A→B→D と A→C→D（B と C は並行）。C が As-Is の長い枝（LT7）でクリティカルパス。
function build() {
  const g = counter('c');
  let p = emptyProject();
  for (const name of ['A', 'B', 'C', 'D']) p = addTask(p, { name, level: 'medium' }, g);
  const id = (n: string) => taskIdByName(p, n);
  p = addDependency(p, id('A'), id('B'), g);
  p = addDependency(p, id('B'), id('D'), g);
  p = addDependency(p, id('A'), id('C'), g);
  p = addDependency(p, id('C'), id('D'), g);
  p.details[id('A')] = { taskId: id('A'), effortMinutes: 60, ltDays: 1, difficulty: 'M' };
  p.details[id('B')] = { taskId: id('B'), effortMinutes: 120, ltDays: 3, difficulty: 'H' };
  // C: As-Is 長い枝。To-Be で短縮（並行化・前倒し）＋難易度 H→L・工数 60→30。
  p.details[id('C')] = {
    taskId: id('C'),
    effortMinutes: 60,
    ltDays: 7,
    difficulty: 'H',
    toBe: { effortMinutes: 30, ltDays: 2, difficulty: 'L' },
  };
  p.details[id('D')] = { taskId: id('D'), effortMinutes: 120, ltDays: 2, difficulty: 'M' };
  return { p, id };
}

describe('compare: As-Is / To-Be の2軸集計', () => {
  it('総工数＝末端の総和（To-Be は toBe.effortMinutes を優先）', () => {
    const { p } = build();
    expect(totalEffortMinutes(p.core, p.details, 'asis')).toBe(360); // 60+120+60+120
    expect(totalEffortMinutes(p.core, p.details, 'tobe')).toBe(330); // C のみ 60→30
  });

  it('リードタイム＝クリティカルパス。並行枝は加算されず、短縮で別経路がクリティカルになる', () => {
    const { p } = build();
    // As-Is: A→C→D = 1+7+2 = 10（A→B→D = 6 より長い）
    expect(criticalPathDays(p.core, p.details, 'asis')).toBe(10);
    // To-Be: C を 7→2 に短縮 → A→C→D=5、A→B→D=6 がクリティカルに
    expect(criticalPathDays(p.core, p.details, 'tobe')).toBe(6);
  });

  it('待ち時間＝リードタイム − 工数(日換算)', () => {
    const { p } = build();
    // As-Is: 10 − 360/60/8 = 10 − 0.75 = 9.25
    expect(totalWaitDays(p.core, p.details, 'asis')).toBeCloseTo(9.25, 5);
    // To-Be: 6 − 330/60/8 = 6 − 0.6875 = 5.3125
    expect(totalWaitDays(p.core, p.details, 'tobe')).toBeCloseTo(5.3125, 5);
    expect(HOURS_PER_DAY).toBe(8);
  });

  it('業務難易度 H/M/L の構成（工程数・工数）が As-Is→To-Be で変わる', () => {
    const { p } = build();
    expect(diffByDifficulty(p.core, p.details, 'asis', 'count')).toEqual({ H: 2, M: 2, L: 0 });
    expect(diffByDifficulty(p.core, p.details, 'tobe', 'count')).toEqual({ H: 1, M: 2, L: 1 });
    expect(diffByDifficulty(p.core, p.details, 'asis', 'effort')).toEqual({ H: 180, M: 180, L: 0 });
    expect(diffByDifficulty(p.core, p.details, 'tobe', 'effort')).toEqual({ H: 120, M: 180, L: 30 });
  });

  it('To-Be 未設定の工程は As-Is と同一にフォールバックする', () => {
    const { p, id } = build();
    const a = p.details[id('A')]; // toBe 無し
    expect(leafEffortMinutes(a, 'tobe')).toBe(leafEffortMinutes(a, 'asis'));
    expect(leafLtDays(a, 'tobe')).toBe(leafLtDays(a, 'asis'));
    expect(leafDifficulty(a, 'tobe')).toBe(leafDifficulty(a, 'asis'));
  });

  it('computeCompare は画面1が必要な全集計を返す', () => {
    const { p } = build();
    const c = computeCompare(p.core, p.details);
    expect(c.effortMinutes).toEqual({ asis: 360, tobe: 330, delta: -30 });
    expect(c.ltDays).toEqual({ asis: 10, tobe: 6, delta: -4 });
    expect(c.leafCount).toEqual({ asis: 4, tobe: 4 });
    expect(c.difficulty.count.tobe).toEqual({ H: 1, M: 2, L: 1 });
  });
});

describe('compare: 構造差分（lifecycle・依存 phase）', () => {
  it('lifecycle added は As-Is に出ず、removed は To-Be に出ない（工数・難易度に反映）', () => {
    const g = counter('lc');
    let p = emptyProject();
    for (const name of ['X', 'NEW', 'OLD']) p = addTask(p, { name, level: 'medium' }, g);
    const id = (n: string) => taskIdByName(p, n);
    p.details[id('X')] = { taskId: id('X'), effortMinutes: 60, difficulty: 'M' };
    p.details[id('NEW')] = { taskId: id('NEW'), effortMinutes: 30, difficulty: 'L', toBe: { lifecycle: 'added' } };
    p.details[id('OLD')] = { taskId: id('OLD'), effortMinutes: 120, difficulty: 'H', toBe: { lifecycle: 'removed' } };
    // As-Is: X+OLD = 180、To-Be: X+NEW = 90
    expect(totalEffortMinutes(p.core, p.details, 'asis')).toBe(180);
    expect(totalEffortMinutes(p.core, p.details, 'tobe')).toBe(90);
    expect(diffByDifficulty(p.core, p.details, 'asis', 'count')).toEqual({ H: 1, M: 1, L: 0 }); // OLD,X
    expect(diffByDifficulty(p.core, p.details, 'tobe', 'count')).toEqual({ H: 0, M: 1, L: 1 }); // X,NEW
  });

  it('依存の phase で並行化を表現（To-Be で直列依存を外すと LT が短縮）', () => {
    const g = counter('ph');
    let p = emptyProject();
    for (const name of ['A', 'B']) p = addTask(p, { name, level: 'medium' }, g);
    const id = (n: string) => taskIdByName(p, n);
    p.details[id('A')] = { taskId: id('A'), ltDays: 3 };
    p.details[id('B')] = { taskId: id('B'), ltDays: 4 };
    // As-Is 専用の直列依存 A→B（To-Be では並行＝依存なし）
    p = addDependency(p, id('A'), id('B'), g);
    const depId = Object.keys(p.core.dependencies)[0]!;
    p.core.dependencies[depId]!.phase = 'asis';
    expect(criticalPathDays(p.core, p.details, 'asis')).toBe(7); // A→B 直列
    expect(criticalPathDays(p.core, p.details, 'tobe')).toBe(4); // 並行＝max(3,4)
  });

  it('projectScenarioCore は lifecycle/担当移動/依存phase を反映した core を返す', () => {
    const g = counter('pc');
    let p = emptyProject();
    p = addTask(p, { name: 'A', level: 'medium' }, g);
    p = addTask(p, { name: 'NEW', level: 'medium' }, g);
    const id = (n: string) => taskIdByName(p, n);
    p.details[id('NEW')] = { taskId: id('NEW'), toBe: { lifecycle: 'added' } };
    p.details[id('A')] = { taskId: id('A'), toBe: { assigneeId: 'lane2' } };
    const asis = projectScenarioCore(p.core, p.details, 'asis');
    const tobe = projectScenarioCore(p.core, p.details, 'tobe');
    expect(Object.keys(asis.tasks)).toEqual([id('A')]); // NEW は As-Is に無い
    expect(Object.keys(tobe.tasks).sort()).toEqual([id('A'), id('NEW')].sort());
    expect(tobe.tasks[id('A')]!.assigneeId).toBe('lane2'); // To-Be で担当移動
  });
});

describe('compare: To-Be 編集コマンド', () => {
  it('updateTaskToBe は既存 toBe キーを保ったまま部分更新する（浅マージで潰さない）', () => {
    const { p, id } = build();
    let p2 = updateTaskToBe(p, id('A'), { ltDays: 5 });
    expect(p2.details[id('A')]!.toBe).toEqual({ ltDays: 5 });
    p2 = updateTaskToBe(p2, id('A'), { effortMinutes: 30 });
    expect(p2.details[id('A')]!.toBe).toEqual({ ltDays: 5, effortMinutes: 30 }); // ltDays が消えない
  });

  it('updateTaskToBe で undefined はキー削除、全消去で toBe 自体が undefined になる', () => {
    const { p, id } = build();
    let p2 = updateTaskToBe(p, id('A'), { ltDays: 5, effortMinutes: 30 });
    p2 = updateTaskToBe(p2, id('A'), { ltDays: undefined });
    expect(p2.details[id('A')]!.toBe).toEqual({ effortMinutes: 30 });
    p2 = updateTaskToBe(p2, id('A'), { effortMinutes: undefined });
    expect(p2.details[id('A')]!.toBe).toBeUndefined();
  });

  it('copyAsIsToToBe は As-Is 現状値を toBe へ複製する', () => {
    const { p, id } = build();
    const p2 = copyAsIsToToBe(p, id('B')); // B: effort120/lt3/H・toBe無し
    expect(p2.details[id('B')]!.toBe).toMatchObject({ effortMinutes: 120, ltDays: 3, difficulty: 'H' });
  });
});
