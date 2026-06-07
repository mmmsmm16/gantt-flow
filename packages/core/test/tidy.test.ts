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

  it('並行（同レーン・依存なし）の工程はレーンを太くしサブ行に積む / 逐次は太くしない', () => {
    const gen = counter();
    // 担当 1 名のレーンに、依存のない 2 工程（並行）と、別途その後続（逐次）を置く。
    let p = emptyProject();
    p = addAssignee(p, { name: '担当', kind: 'department' }, gen);
    const who = Object.keys(p.core.assignees)[0]!;
    p = addTask(p, { name: 'A', level: 'large' }, gen);
    p = addTask(p, { name: 'B', level: 'large' }, gen);
    const a = taskIdByName(p, 'A');
    const b = taskIdByName(p, 'B');
    p = setAssignee(p, a, who);
    p = setAssignee(p, b, who);
    p = ensureLevelView(p, 'large');
    p = reconcileProject(p, gen);
    const view = p.flow.byLevel.find((v) => v.level === 'large')!;

    // 並行（A・B に依存なし）→ レーンが太くなり、サブ行で y が異なる
    const parallel = tidyFlowView(p.core, p.details, view);
    const lane = Object.values(parallel.lanes)[0]!;
    expect(laneHeight(lane)).toBeGreaterThan(LANE_DEFAULT_H);
    const ay = (Object.values(parallel.nodes).find((n) => n.kind === 'task' && n.taskId === a) as FlowTaskNode).y;
    const by = (Object.values(parallel.nodes).find((n) => n.kind === 'task' && n.taskId === b) as FlowTaskNode).y;
    expect(ay).not.toBe(by);

    // 逐次（A→B 依存）→ 別段になり並行解消 → レーンは既定の高さに戻る
    const p2 = reconcileProject(addDependency(p, a, b, gen), gen);
    const view2 = p2.flow.byLevel.find((v) => v.level === 'large')!;
    const seq = tidyFlowView(p2.core, p2.details, view2);
    expect(laneHeight(Object.values(seq.lanes)[0]!)).toBe(LANE_DEFAULT_H);
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
