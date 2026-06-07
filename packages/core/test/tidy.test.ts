import { describe, it, expect } from 'vitest';
import { tidyFlowView } from '../src/sync/tidy';
import { createSampleProject } from '../src/sample';
import { counter, taskIdByName } from './helpers';
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
