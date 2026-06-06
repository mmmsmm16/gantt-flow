// ヘッドレスな編集セッション相当（コマンド→reconcileProject→履歴push）を直接合成して検証。
// 実際の Zustand ストア(apps/desktop)はこの組み合わせを薄く包むだけ。
import { describe, it, expect } from 'vitest';
import { addTask, addIoItem } from '../src/commands';
import { reconcileProject, ensureLevelView } from '../src/sync/reconcileProject';
import { createHistory } from '../src/history/history';
import type { FlowTaskNode, FlowDocNode, Project } from '../src/model/types';
import { counter, emptyProject, taskIdByName } from './helpers';

const view0 = (p: Project) => p.flow.byLevel[0]!;
const tasks = (p: Project) =>
  Object.values(view0(p).nodes).filter((n): n is FlowTaskNode => n.kind === 'task');
const docs = (p: Project) =>
  Object.values(view0(p).nodes).filter((n): n is FlowDocNode => n.kind === 'doc');

describe('reconcileProject / ensureLevelView', () => {
  it('ensureLevelView は無ければ追加、あれば no-op', () => {
    let p = emptyProject();
    p = ensureLevelView(p, 'medium');
    expect(p.flow.byLevel).toHaveLength(1);
    p = ensureLevelView(p, 'medium');
    expect(p.flow.byLevel).toHaveLength(1);
    p = ensureLevelView(p, 'small');
    expect(p.flow.byLevel).toHaveLength(2);
  });

  it('全ビューを core/details に同期する', () => {
    const g = counter();
    const n = counter('n');
    let p = emptyProject();
    p = ensureLevelView(p, 'medium');
    p = addTask(p, { name: 'A', level: 'medium' }, g);
    p = reconcileProject(p, n);
    expect(tasks(p)).toHaveLength(1);
  });

  it('reconcileProject は冪等', () => {
    const g = counter();
    const n = counter('n');
    let p = emptyProject();
    p = ensureLevelView(p, 'medium');
    p = addTask(p, { name: 'A', level: 'medium' }, g);
    const p1 = reconcileProject(p, n);
    const p2 = reconcileProject(p1, n);
    expect(p2).toEqual(p1);
  });
});

describe('編集セッション（command → reconcileProject → history）', () => {
  it('undo/redo の往復で Project が完全一致（フロー配置含む）', () => {
    const g = counter();
    const n = counter('n');
    let p = ensureLevelView(emptyProject(), 'medium');
    p = reconcileProject(p, n); // 初期状態
    const hist = createHistory<Project>(p);

    // 編集1: 作業追加
    let p1 = addTask(hist.current(), { name: 'A', level: 'medium' }, g);
    p1 = reconcileProject(p1, n);
    hist.push(p1);
    expect(tasks(hist.current())).toHaveLength(1);

    // 編集2: I/O 追加
    const aId = taskIdByName(p1, 'A');
    let p2 = addIoItem(hist.current(), aId, 'inputs', { name: '注文書', kind: 'doc' }, g);
    p2 = reconcileProject(p2, n);
    hist.push(p2);
    expect(docs(hist.current())).toHaveLength(1);

    // undo → 編集1 の状態に完全一致
    const undone = hist.undo()!;
    expect(undone).toEqual(p1);
    expect(docs(undone)).toHaveLength(0);

    // redo → 編集2 の状態に完全一致
    const redone = hist.redo()!;
    expect(redone).toEqual(p2);
    expect(docs(redone)).toHaveLength(1);
  });

  it('手動でノードを動かして undo すると位置も戻る', () => {
    const g = counter();
    const n = counter('n');
    let p = ensureLevelView(emptyProject(), 'medium');
    p = addTask(p, { name: 'A', level: 'medium' }, g);
    p = reconcileProject(p, n);
    const hist = createHistory<Project>(p);

    // ドラッグ確定（位置変更を 1 エントリとして push）
    const moved = structuredClone(hist.current());
    const node = tasks(moved)[0]!;
    moved.flow.byLevel[0]!.nodes[node.id] = { ...node, x: 1234, y: 5678 };
    hist.push(moved);
    expect((tasks(hist.current())[0]!).x).toBe(1234);

    const back = hist.undo()!;
    expect((tasks(back)[0]!).x).not.toBe(1234); // 元の自動配置位置に戻る
  });
});
