import { describe, it, expect } from 'vitest';
import { addTask, addDependency } from '../src/commands';
import { reconcileFlow } from '../src/sync/reconcileFlow';
import { deriveMilestoneGuides } from '../src/sync/milestoneGuides';
import { SIZE } from '../src/sync/autoPlace';
import type { FlowTaskNode } from '../src/model/types';
import { counter, emptyProject, emptyView, taskIdByName } from './helpers';

const taskNodes = (v: ReturnType<typeof reconcileFlow>['view']) =>
  Object.values(v.nodes).filter((n): n is FlowTaskNode => n.kind === 'task');

function base() {
  const g = counter();
  let p = emptyProject();
  p = addTask(p, { name: 'A', level: 'medium' }, g);
  p = addTask(p, { name: 'B', level: 'medium' }, g);
  p = addTask(p, { name: 'MS1', level: 'medium', kind: 'milestone' }, g);
  p = addTask(p, { name: 'C', level: 'medium' }, g);
  p = addTask(p, { name: 'MS2', level: 'medium', kind: 'milestone' }, g);
  return { p, g };
}

describe('deriveMilestoneGuides', () => {
  it('紐付きMS: guide.x = 対象工程ノードの x + SIZE.task.w + MARGIN、bound: true', () => {
    const { p, g } = base();
    const n = counter('n');
    let proj = p;
    // A → MS1（MS1 に A が入依存）
    proj = addDependency(proj, taskIdByName(proj, 'A'), taskIdByName(proj, 'MS1'), g);

    const res = reconcileFlow(proj.core, proj.details, emptyView('medium'), n);
    const guides = deriveMilestoneGuides(proj.core, res.view);

    // MS1 は紐付き（A から入依存）
    const ms1Guide = guides.find((guide) => guide.taskId === taskIdByName(proj, 'MS1'))!;
    expect(ms1Guide).toBeDefined();
    expect(ms1Guide.bound).toBe(true);

    // MS1 の x は A の x + SIZE.task.w + 40
    const aNode = taskNodes(res.view).find((n) => n.taskId === taskIdByName(proj, 'A'))!;
    const expectedX = aNode.x + SIZE.task.w + 40;
    expect(ms1Guide.x).toBe(expectedX);
  });

  it('未紐付けMS: guide.x = 自ノードの x、bound: false', () => {
    const { p, g } = base();
    const n = counter('n');
    const res = reconcileFlow(p.core, p.details, emptyView('medium'), n);
    const guides = deriveMilestoneGuides(p.core, res.view);

    // MS1 は未紐付け（依存なし）
    const ms1Guide = guides.find((guide) => guide.taskId === taskIdByName(p, 'MS1'))!;
    expect(ms1Guide).toBeDefined();
    expect(ms1Guide.bound).toBe(false);

    // MS1 の x は MS1 ノードの x と同じ
    const ms1Node = taskNodes(res.view).find((n) => n.taskId === taskIdByName(p, 'MS1'))!;
    expect(ms1Guide.x).toBe(ms1Node.x);
  });

  it('対象工程ノードの x を手動変更 → guide.x が追従', () => {
    const { p, g } = base();
    const n = counter('n');
    let proj = p;
    // A → MS1（MS1 に A が入依存）
    proj = addDependency(proj, taskIdByName(proj, 'A'), taskIdByName(proj, 'MS1'), g);

    const res = reconcileFlow(proj.core, proj.details, emptyView('medium'), n);
    const aNode = taskNodes(res.view).find((n) => n.taskId === taskIdByName(proj, 'A'))!;
    const initialX = deriveMilestoneGuides(proj.core, res.view).find(
      (guide) => guide.taskId === taskIdByName(proj, 'MS1'),
    )!.x;

    // A のノードの x を手動変更
    const newViewWithMovedA = {
      ...res.view,
      nodes: {
        ...res.view.nodes,
        [aNode.id]: { ...aNode, x: aNode.x + 100 },
      },
    };

    // 再度 deriveMilestoneGuides を実行
    const guidesAfter = deriveMilestoneGuides(proj.core, newViewWithMovedA);
    const ms1GuideAfter = guidesAfter.find((guide) => guide.taskId === taskIdByName(proj, 'MS1'))!;

    // guide.x は A の新しい位置に追従
    expect(ms1GuideAfter.x).toBe(initialX + 100);
  });

  it('MSがないビュー → []、2個以上のMSはx → taskId で決定論ソート', () => {
    const g = counter();
    const n = counter('n');
    let p = emptyProject();
    p = addTask(p, { name: 'X', level: 'medium' }, g);
    p = addTask(p, { name: 'Y', level: 'medium' }, g);

    const res = reconcileFlow(p.core, p.details, emptyView('medium'), n);
    const guides = deriveMilestoneGuides(p.core, res.view);
    expect(guides).toHaveLength(0);

    // 複数 MS の場合
    const { p: p2, g: g2 } = base();
    const n2 = counter('n');
    let proj = p2;
    // A → MS1, A → MS2（両方紐付き）
    proj = addDependency(proj, taskIdByName(proj, 'A'), taskIdByName(proj, 'MS1'), g2);
    proj = addDependency(proj, taskIdByName(proj, 'A'), taskIdByName(proj, 'MS2'), g2);

    const res2 = reconcileFlow(proj.core, proj.details, emptyView('medium'), n2);
    const guides2 = deriveMilestoneGuides(proj.core, res2.view);

    // 複数 MS は存在する
    expect(guides2.length).toBeGreaterThan(1);

    // ソート順の確認：x → taskId
    for (let i = 1; i < guides2.length; i++) {
      const prev = guides2[i - 1]!;
      const curr = guides2[i]!;
      expect(prev.x < curr.x || (prev.x === curr.x && prev.taskId.localeCompare(curr.taskId) <= 0)).toBe(
        true,
      );
    }
  });
});
