import { describe, it, expect } from 'vitest';
import {
  addTask,
  addIoItem,
  addIssueItem,
  updateTaskDetail,
  updateIoItem,
  updateIssueItem,
} from '../src/commands';
import { effortRollupMinutes, formatMinutes } from '../src/metrics';
import { counter, emptyProject, taskIdByName } from './helpers';

describe('詳細編集コマンド', () => {
  it('updateTaskDetail でスカラ項目を更新', () => {
    const g = counter();
    let p = emptyProject();
    p = addTask(p, { name: 'A', level: 'medium' }, g);
    const id = taskIdByName(p, 'A');
    p = updateTaskDetail(p, id, { how: '手順', effortMinutes: 30, difficulty: 'H' });
    expect(p.details[id]!.how).toBe('手順');
    expect(p.details[id]!.effortMinutes).toBe(30);
    expect(p.details[id]!.difficulty).toBe('H');
  });

  it('updateIoItem で帳票/情報・様式を変更', () => {
    const g = counter();
    let p = emptyProject();
    p = addTask(p, { name: 'A', level: 'medium' }, g);
    const id = taskIdByName(p, 'A');
    p = addIoItem(p, id, 'inputs', { name: '注文書', kind: 'doc' }, g);
    const ioId = p.details[id]!.inputs![0]!.id;
    p = updateIoItem(p, id, ioId, { kind: 'info', formInfo: '様式B' });
    expect(p.details[id]!.inputs![0]!.kind).toBe('info');
    expect(p.details[id]!.inputs![0]!.formInfo).toBe('様式B');
  });

  it('updateIssueItem で方策・対象を変更', () => {
    const g = counter();
    let p = emptyProject();
    p = addTask(p, { name: 'A', level: 'medium' }, g);
    const id = taskIdByName(p, 'A');
    p = addIssueItem(p, id, { issue: '漏れ' }, g);
    const issueId = p.details[id]!.issues![0]!.id;
    p = updateIssueItem(p, id, issueId, { measure: 'チェック', target: { kind: 'task' } });
    expect(p.details[id]!.issues![0]!.measure).toBe('チェック');
    expect(p.details[id]!.issues![0]!.target).toEqual({ kind: 'task' });
  });
});

describe('工数の集計', () => {
  it('親 = 子孫の末端工数の合計、末端は自分の値', () => {
    const g = counter();
    let p = emptyProject();
    p = addTask(p, { name: '親', level: 'medium' }, g);
    const parentId = taskIdByName(p, '親');
    p = addTask(p, { name: '子1', level: 'small', parentId }, g);
    p = addTask(p, { name: '子2', level: 'small', parentId }, g);
    p = updateTaskDetail(p, taskIdByName(p, '子1'), { effortMinutes: 10 });
    p = updateTaskDetail(p, taskIdByName(p, '子2'), { effortMinutes: 5 });

    expect(effortRollupMinutes(p.core, p.details, taskIdByName(p, '子1'))).toBe(10);
    expect(effortRollupMinutes(p.core, p.details, parentId)).toBe(15);
    expect(formatMinutes(90)).toBe('1時間30分');
  });
});
