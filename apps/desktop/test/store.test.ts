import { describe, it, expect } from 'vitest';
import { createAppStore } from '../src/store';
import type { FlowTaskNode, FlowDocNode } from '@gantt-flow/core';

const view0 = (s: ReturnType<typeof createAppStore>) => s.getState().project.flow.byLevel[0]!;
const taskNodes = (s: ReturnType<typeof createAppStore>) =>
  Object.values(view0(s).nodes).filter((n): n is FlowTaskNode => n.kind === 'task');

describe('app store（command → reconcile → history）', () => {
  it('作業追加でフローにノードが出て、undo/redo できる', () => {
    const s = createAppStore();
    expect(taskNodes(s)).toHaveLength(0);
    s.getState().addTask('受付');
    expect(taskNodes(s)).toHaveLength(1);
    expect(s.getState().canUndo).toBe(true);

    s.getState().undo();
    expect(taskNodes(s)).toHaveLength(0);
    s.getState().redo();
    expect(taskNodes(s)).toHaveLength(1);
  });

  it('I/O 追加で doc ノードが現れる', () => {
    const s = createAppStore();
    s.getState().addTask('受付');
    const taskId = taskNodes(s)[0]!.taskId;
    s.getState().addIo(taskId, 'inputs', '注文書');
    const docs = Object.values(view0(s).nodes).filter((n): n is FlowDocNode => n.kind === 'doc');
    expect(docs).toHaveLength(1);
    expect(docs[0]!.io).toBe('input');
  });

  it('ノード移動 → undo で位置が戻る', () => {
    const s = createAppStore();
    s.getState().addTask('受付');
    const node = taskNodes(s)[0]!;
    const origX = node.x;
    s.getState().moveNode(node.id, 555, 666);
    expect((taskNodes(s)[0]!).x).toBe(555);
    s.getState().undo();
    expect((taskNodes(s)[0]!).x).toBe(origX);
  });

  it('担当を付けるとレーンができる', () => {
    const s = createAppStore();
    s.getState().addTask('受付');
    const taskId = taskNodes(s)[0]!.taskId;
    s.getState().setAssigneeByName(taskId, '営業');
    expect(Object.values(view0(s).lanes).length).toBe(1);
  });
});
