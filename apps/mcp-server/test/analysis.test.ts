import { describe, it, expect } from 'vitest';
import { type Project, uuid, runBatch, type BatchOp } from '@gantt-flow/core';
import { computeCriticalPath, formatCriticalPath, formatAutomationCandidates, formatWorkload } from '../src/analysis.js';

const empty = (): Project =>
  ({ schemaVersion: 1, meta: { id: 'x', title: '', createdAt: '', updatedAt: '', appVersion: '0' }, core: { tasks: {}, dependencies: {}, assignees: {} }, details: {}, flow: { byLevel: [] } } as unknown as Project);

// A(LT2)→B(LT3)→C(LT1) 直列 ＋ 並行 D(LT5, 依存なし)。CP = A+B+C = 6 日（D は別経路で 5）。
function sample(): Project {
  const ops: BatchOp[] = [
    { op: 'add_task', ref: 'a', name: 'A', level: 'detail', assignee: '営業' },
    { op: 'add_task', ref: 'b', name: 'B', level: 'detail', assignee: '経理' },
    { op: 'add_task', ref: 'c', name: 'C', level: 'detail', assignee: '営業' },
    { op: 'add_task', ref: 'd', name: 'D', level: 'detail', assignee: '倉庫' },
    { op: 'add_dependency', from: 'a', to: 'b' },
    { op: 'add_dependency', from: 'b', to: 'c' },
    { op: 'set_detail', task: 'a', patch: { ltDays: 2, effortMinutes: 60, difficulty: 'L', automation: 'manual' } },
    { op: 'set_detail', task: 'b', patch: { ltDays: 3, effortMinutes: 240, difficulty: 'H', automation: 'manual' } },
    { op: 'set_detail', task: 'c', patch: { ltDays: 1, effortMinutes: 30, difficulty: 'M', automation: 'system' } },
    { op: 'set_detail', task: 'd', patch: { ltDays: 5, effortMinutes: 120, difficulty: 'M', automation: 'partial' } },
  ];
  return runBatch(empty(), ops, uuid, new Date().toISOString()).project;
}

describe('analyze_critical_path', () => {
  it('律速する工程列と総日数を復元する', () => {
    const p = sample();
    const cp = computeCriticalPath(p.core, p.details, 'asis');
    expect(cp.totalDays).toBe(6); // A2+B3+C1
    expect(cp.steps.map((s) => p.core.tasks[s.id]?.name)).toEqual(['A', 'B', 'C']);
    expect(formatCriticalPath(p, 'asis')).toContain('6日');
  });
});

describe('analyze_automation_candidates', () => {
  it('手作業×高工数×ベテラン依存(B) を上位に出す', () => {
    const p = sample();
    const out = formatAutomationCandidates(p);
    const firstLine = out.split('\n').find((l) => l.includes('('))!;
    expect(firstLine).toContain('B'); // 手作業240分×H が最上位
    expect(out).toContain('ベテラン依存(H)');
  });
});

describe('analyze_workload', () => {
  it('担当別の工数を多い順に出す（営業=A60+C30=90分が経理240より下）', () => {
    const p = sample();
    const out = formatWorkload(p, 'asis');
    // 経理(B=240分) が最上位
    const names = out.split('\n').filter((l) => l.startsWith('  ')).map((l) => l.trim().split(':')[0]);
    expect(names[0]).toBe('経理');
    expect(out).toContain('ベテラン依存1'); // 経理に H が1件
  });
});
