import { describe, it, expect } from 'vitest';
import { effortRollupMinutes, computeEffortRollups, effortMinutesToHours } from '../src/metrics';
import { deriveBands } from '../src/sync/bands';
import type { Core, TaskDetail, Id, ProcessLevel, ProcessTask, FlowLevelView } from '../src/model/types';

function task(id: string, level: ProcessLevel, parentId?: string, order = 0): ProcessTask {
  return { id, name: id, level, parentId, order };
}

function coreOf(tasks: ProcessTask[]): Core {
  return {
    tasks: Object.fromEntries(tasks.map((t) => [t.id, t])),
    dependencies: {},
    assignees: {},
  };
}

function detailsOf(entries: [Id, number][]): Record<Id, TaskDetail> {
  return Object.fromEntries(entries.map(([taskId, effortMinutes]) => [taskId, { taskId, effortMinutes }]));
}

describe('metrics: computeEffortRollups', () => {
  it('木構造で末端の合計が親へ積み上がる（単一タスク版と一致）', () => {
    const core = coreOf([
      task('root', 'large'),
      task('m1', 'medium', 'root'),
      task('m2', 'medium', 'root'),
      task('s1', 'small', 'm1'),
      task('s2', 'small', 'm1'),
    ]);
    const details = detailsOf([
      ['s1', 30],
      ['s2', 15],
      ['m2', 60],
      ['m1', 999], // 親に直接入った値は無視され、子の合計が勝つ
    ]);
    const rollups = computeEffortRollups(core, details);
    expect(rollups.get('s1')).toBe(30);
    expect(rollups.get('m1')).toBe(45);
    expect(rollups.get('m2')).toBe(60);
    expect(rollups.get('root')).toBe(105);
    for (const id of Object.keys(core.tasks)) {
      expect(effortRollupMinutes(core, details, id)).toBe(rollups.get(id));
    }
  });

  it('詳細のないタスクは 0', () => {
    const core = coreOf([task('a', 'medium')]);
    expect(effortRollupMinutes(core, {}, 'a')).toBe(0);
    expect(computeEffortRollups(core, {}).get('a')).toBe(0);
  });

  it('親子循環があっても無限再帰せず終了する', () => {
    const core = coreOf([
      task('a', 'medium', 'b'),
      task('b', 'medium', 'a'),
      task('ok', 'medium'),
    ]);
    const details = detailsOf([['ok', 10]]);
    const rollups = computeEffortRollups(core, details);
    expect(rollups.get('ok')).toBe(10);
    expect(Number.isFinite(rollups.get('a'))).toBe(true);
    expect(Number.isFinite(rollups.get('b'))).toBe(true);
    expect(() => effortRollupMinutes(core, details, 'a')).not.toThrow();
  });

  it('自己参照（parentId = 自分）でも終了する', () => {
    const core = coreOf([task('a', 'medium', 'a')]);
    expect(() => effortRollupMinutes(core, {}, 'a')).not.toThrow();
  });
});

describe('metrics: effortMinutesToHours', () => {
  it('60 分刻みなら丸めても値は変わらない', () => {
    expect(effortMinutesToHours(0)).toBe(0);
    expect(effortMinutesToHours(60)).toBe(1);
    expect(effortMinutesToHours(90)).toBe(1.5);
    expect(effortMinutesToHours(120)).toBe(2);
  });

  it('循環小数になる半端な分は小数1位に丸める（0.1666… を画面に出さない）', () => {
    expect(effortMinutesToHours(10)).toBeCloseTo(0.2, 5); // 10/60=0.1666… → 0.2
    expect(effortMinutesToHours(100)).toBeCloseTo(1.7, 5); // 100/60=1.6666… → 1.7
    expect(effortMinutesToHours(1)).toBeCloseTo(0, 5); // 1/60=0.0166… → 0.0
  });

  it('四捨五入の境界（0.05刻み相当）でも安定する', () => {
    expect(effortMinutesToHours(63)).toBeCloseTo(1.1, 5); // 63/60=1.05 → 1.1
    expect(effortMinutesToHours(57)).toBeCloseTo(1, 5); // 57/60=0.95 → 1.0（切り上げ）
  });
});

describe('bands: deriveBands の循環ガード', () => {
  function viewWithNode(taskId: Id): FlowLevelView {
    return {
      level: 'small',
      nodes: { n1: { id: 'n1', kind: 'task', taskId, x: 100, y: 100 } },
      edges: {},
      lanes: {},
      orientation: 'horizontal',
    };
  }

  it('祖先に循環があってもハングせず、循環一周分の帯を返す', () => {
    // c の親 b、b の親 a、a の親 b（a↔b で循環）
    const core = coreOf([
      task('a', 'large', 'b'),
      task('b', 'medium', 'a'),
      task('c', 'small', 'b'),
    ]);
    const bands = deriveBands(core, viewWithNode('c'));
    expect(bands.map((x) => x.taskId).sort()).toEqual(['a', 'b']);
  });

  it('通常の木では従来どおり祖先ごとの帯を返す', () => {
    const core = coreOf([
      task('a', 'large'),
      task('b', 'medium', 'a'),
      task('c', 'small', 'b'),
    ]);
    const bands = deriveBands(core, viewWithNode('c'));
    expect(bands.map((x) => x.taskId).sort()).toEqual(['a', 'b']);
    expect(bands.find((x) => x.taskId === 'b')?.depth).toBe(1);
    expect(bands.find((x) => x.taskId === 'a')?.depth).toBe(2);
  });
});
