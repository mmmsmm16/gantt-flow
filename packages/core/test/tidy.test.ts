import { describe, it, expect } from 'vitest';
import { tidyFlowView } from '../src/sync/tidy';
import { LANE_DEFAULT_H, laneHeight } from '../src/sync/lanes';
import { createSampleProject } from '../src/sample';
import { reconcileProject, ensureLevelView } from '../src/sync/reconcileProject';
import { addTask, addAssignee, setAssignee, addDependency } from '../src/commands';
import { counter, taskIdByName, emptyProject } from './helpers';
import type { FlowTaskNode } from '../src/model/types';

function mediumView(p: ReturnType<typeof createSampleProject>) {
  return p.flow.byLevel.find((v) => v.level === 'medium' && v.scopeParentId)!;
}
const taskNodeX = (view: ReturnType<typeof mediumView>, taskId: string) =>
  (Object.values(view.nodes).find((n) => n.kind === 'task' && n.taskId === taskId) as FlowTaskNode).x;

describe('tidyFlowView', () => {
  it('依存の前後で左→右に段組みされる（先行ほど左）', () => {
    const p = createSampleProject(counter());
    const view = mediumView(p);
    const tidied = tidyFlowView(p.core, p.details, view);
    const x = (name: string) => taskNodeX(tidied, taskIdByName(p, name));
    // 注文受付 → 与信確認 → 在庫引当 → 受注確定
    expect(x('注文受付')).toBeLessThan(x('与信確認'));
    expect(x('与信確認')).toBeLessThan(x('在庫引当'));
    expect(x('在庫引当')).toBeLessThan(x('受注確定'));
  });

  it('手で散らした配置でも、整列すると決定論的な座標に戻る', () => {
    const p = createSampleProject(counter());
    const view = structuredClone(mediumView(p));
    // 位置を意図的にぐちゃぐちゃに
    for (const n of Object.values(view.nodes)) {
      n.x = 999 - n.x;
      n.y = 777;
    }
    const a = tidyFlowView(p.core, p.details, view);
    const b = tidyFlowView(p.core, p.details, mediumView(p));
    const pos = (v: typeof a) =>
      Object.values(v.nodes)
        .filter((n) => n.kind === 'task')
        .map((n) => `${(n as FlowTaskNode).taskId}:${n.x},${n.y}`)
        .sort();
    expect(pos(a)).toEqual(pos(b));
  });

  it('冪等: 整列をもう一度かけても座標は変わらない', () => {
    const p = createSampleProject(counter());
    const once = tidyFlowView(p.core, p.details, mediumView(p));
    const twice = tidyFlowView(p.core, p.details, once);
    expect(twice.nodes).toEqual(once.nodes);
  });

  it('依存で並行する工程（共通の前工程）はレーンを太くしサブ行に積む / 無依存・逐次は太くしない', () => {
    const gen = counter();
    // 同じ担当レーンに S→B, S→C（B・C は共通の前工程 S を持つ並行）。
    let p = emptyProject();
    p = addAssignee(p, { name: '担当', kind: 'department' }, gen);
    const who = Object.keys(p.core.assignees)[0]!;
    p = addTask(p, { name: 'S', level: 'large' }, gen);
    p = addTask(p, { name: 'B', level: 'large' }, gen);
    p = addTask(p, { name: 'C', level: 'large' }, gen);
    const s = taskIdByName(p, 'S');
    const b = taskIdByName(p, 'B');
    const c = taskIdByName(p, 'C');
    for (const id of [s, b, c]) p = setAssignee(p, id, who);
    p = addDependency(p, s, b, gen);
    p = addDependency(p, s, c, gen);
    p = ensureLevelView(p, 'large');
    p = reconcileProject(p, gen);
    const view = p.flow.byLevel.find((v) => v.level === 'large')!;

    // B・C は同レーン同段（並行）→ レーンが太くなり、サブ行で y が異なる
    const parallel = tidyFlowView(p.core, p.details, view);
    expect(laneHeight(Object.values(parallel.lanes)[0]!)).toBeGreaterThan(LANE_DEFAULT_H);
    const by = (Object.values(parallel.nodes).find((n) => n.kind === 'task' && n.taskId === b) as FlowTaskNode).y;
    const cy = (Object.values(parallel.nodes).find((n) => n.kind === 'task' && n.taskId === c) as FlowTaskNode).y;
    expect(by).not.toBe(cy);

    // 無依存の工程は整列で積まない（位置を保持・レーンも太くしない）
    const g2 = counter();
    let q = emptyProject();
    q = addAssignee(q, { name: '担当', kind: 'department' }, g2);
    const who2 = Object.keys(q.core.assignees)[0]!;
    q = addTask(q, { name: 'X', level: 'large' }, g2);
    q = addTask(q, { name: 'Y', level: 'large' }, g2);
    for (const id of [taskIdByName(q, 'X'), taskIdByName(q, 'Y')]) q = setAssignee(q, id, who2);
    q = ensureLevelView(q, 'large');
    q = reconcileProject(q, g2);
    const vq = q.flow.byLevel.find((v) => v.level === 'large')!;
    const noDep = tidyFlowView(q.core, q.details, vq);
    expect(laneHeight(Object.values(noDep.lanes)[0]!)).toBe(LANE_DEFAULT_H);
  });

  it('固定(pinned)した工程は整列で位置を動かさない', () => {
    const p = createSampleProject(counter());
    const view = mediumView(p);
    const node = Object.values(view.nodes).find(
      (n): n is FlowTaskNode => n.kind === 'task' && p.core.tasks[n.taskId]?.name === '与信確認',
    )!;
    node.pinned = true;
    node.x = 999;
    node.y = 888;
    const tidied = tidyFlowView(p.core, p.details, view);
    const after = tidied.nodes[node.id] as FlowTaskNode;
    expect(after.x).toBe(999);
    expect(after.y).toBe(888);
  });

  it('帳票/情報ノードは工程ノードに再吸着する（近接）', () => {
    const p = createSampleProject(counter());
    const tidied = tidyFlowView(p.core, p.details, mediumView(p));
    const docs = Object.values(tidied.nodes).filter((n) => n.kind === 'doc');
    expect(docs.length).toBeGreaterThan(0);
    for (const doc of docs) {
      const owner = Object.values(tidied.nodes).find(
        (n) => n.kind === 'task' && n.kind === 'task' && (n as FlowTaskNode).taskId === (doc as { taskId: string }).taskId,
      ) as FlowTaskNode;
      // 角に重ねる配置なので、owner から一定距離以内に置かれる
      expect(Math.abs(doc.x - owner.x)).toBeLessThan(200);
      expect(Math.abs(doc.y - owner.y)).toBeLessThan(120);
    }
  });
});
