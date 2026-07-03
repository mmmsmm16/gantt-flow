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

  it('MSがないビュー → []', () => {
    const g = counter();
    const n = counter('n');
    let p = emptyProject();
    p = addTask(p, { name: 'X', level: 'medium' }, g);
    p = addTask(p, { name: 'Y', level: 'medium' }, g);

    const res = reconcileFlow(p.core, p.details, emptyView('medium'), n);
    const guides = deriveMilestoneGuides(p.core, res.view);
    expect(guides).toHaveLength(0);
  });

  it('複数MSは x → taskId でソート（作成順と異なる配置を検証）', () => {
    const g = counter();
    const n = counter('n');
    let p = emptyProject();
    // A → B → C（依存チェーン、右へ配置される）
    p = addTask(p, { name: 'A', level: 'medium' }, g);
    p = addTask(p, { name: 'B', level: 'medium' }, g);
    p = addTask(p, { name: 'C', level: 'medium' }, g);
    // MS1 を先に作成（遅いタスク C に紐付く）
    p = addTask(p, { name: 'MS1', level: 'medium', kind: 'milestone' }, g);
    // MS2 を後に作成（早いタスク A に紐付く）
    p = addTask(p, { name: 'MS2', level: 'medium', kind: 'milestone' }, g);

    // 依存を設定：A → B → C
    p = addDependency(p, taskIdByName(p, 'A'), taskIdByName(p, 'B'), g);
    p = addDependency(p, taskIdByName(p, 'B'), taskIdByName(p, 'C'), g);

    // 各 MS を紐付け：MS1→C（右）、MS2→A（左）
    p = addDependency(p, taskIdByName(p, 'C'), taskIdByName(p, 'MS1'), g);
    p = addDependency(p, taskIdByName(p, 'A'), taskIdByName(p, 'MS2'), g);

    const res = reconcileFlow(p.core, p.details, emptyView('medium'), n);
    const guides = deriveMilestoneGuides(p.core, res.view);

    // MS1（C 由来）と MS2（A 由来）は存在
    expect(guides.length).toBeGreaterThanOrEqual(2);

    // C は A の右に配置されるはず → MS1.x > MS2.x（作成順 MS1, MS2 と逆順にソート）
    const ms2Guide = guides.find((g) => g.taskId === taskIdByName(p, 'MS2'))!;
    const ms1Guide = guides.find((g) => g.taskId === taskIdByName(p, 'MS1'))!;
    expect(ms2Guide.x).toBeLessThan(ms1Guide.x);

    // ソート済み配列で MS2 が MS1 より前（昇順でソート済み、作成順 MS1→MS2 と逆）
    const ms2Index = guides.findIndex((g) => g.taskId === taskIdByName(p, 'MS2'));
    const ms1Index = guides.findIndex((g) => g.taskId === taskIdByName(p, 'MS1'));
    expect(ms2Index).toBeLessThan(ms1Index);
  });

  it('複数の前工程から guide.x = max(対象ノード.x + SIZE.task.w)', () => {
    const g = counter();
    const n = counter('n');
    let p = emptyProject();
    // X と Y は独立、Z は X←Y チェーンで右へ
    p = addTask(p, { name: 'X', level: 'medium' }, g);
    p = addTask(p, { name: 'Y', level: 'medium' }, g);
    p = addTask(p, { name: 'Z', level: 'medium' }, g);
    p = addTask(p, { name: 'MS', level: 'medium', kind: 'milestone' }, g);

    // X → Y → Z（Z が最も右）
    p = addDependency(p, taskIdByName(p, 'X'), taskIdByName(p, 'Y'), g);
    p = addDependency(p, taskIdByName(p, 'Y'), taskIdByName(p, 'Z'), g);

    // MS は X と Z 両方に依存（2つの前工程）
    p = addDependency(p, taskIdByName(p, 'X'), taskIdByName(p, 'MS'), g);
    p = addDependency(p, taskIdByName(p, 'Z'), taskIdByName(p, 'MS'), g);

    const res = reconcileFlow(p.core, p.details, emptyView('medium'), n);
    const guides = deriveMilestoneGuides(p.core, res.view);
    const msGuide = guides.find((g) => g.taskId === taskIdByName(p, 'MS'))!;

    // 前工程ノードの取得
    const taskNodes = Object.values(res.view.nodes).filter((n): n is FlowTaskNode => n.kind === 'task');
    const xNode = taskNodes.find((n) => n.taskId === taskIdByName(p, 'X'))!;
    const zNode = taskNodes.find((n) => n.taskId === taskIdByName(p, 'Z'))!;

    // Z が X より右（チェーン構造）
    expect(zNode.x).toBeGreaterThan(xNode.x);

    // guide.x は max(X.x + SIZE.task.w, Z.x + SIZE.task.w) + 40 = Z.x + SIZE.task.w + 40
    const expectedX = Math.max(xNode.x + SIZE.task.w, zNode.x + SIZE.task.w) + 40;
    expect(msGuide.x).toBe(expectedX);
    expect(msGuide.x).toBe(zNode.x + SIZE.task.w + 40);
  });

  // v2: 粒度非依存化（docs/superpowers/specs/2026-07-04-milestone-design.md §v2）
  // 対象工程がこのビューに居ないとき、代表ノードへ自動変換して縦線の x を決める。
  describe('v2: 粒度非依存化（代表ノードへの自動変換）', () => {
    it('①小ビュー: 対象(中)工程の子孫（この小ビューで見えているノード群）の右端最大 + 40', () => {
      const g = counter();
      const n = counter('n');
      let p = emptyProject();
      p = addTask(p, { name: 'M', level: 'medium' }, g);
      const mId = taskIdByName(p, 'M');
      p = addTask(p, { name: 'S1', level: 'small', parentId: mId }, g);
      p = addTask(p, { name: 'S2', level: 'small', parentId: mId }, g);
      // MS はこのビュー自身の粒度（小）で作る（reconcileFlow 未変更のまま、自ノードは通常通り存在させる）。
      p = addTask(p, { name: 'MS', level: 'small', kind: 'milestone' }, g);
      // 入依存: M(中) → MS(小)。MS 依存は同一レベル前提の対象外（spec v2）。
      p = addDependency(p, mId, taskIdByName(p, 'MS'), g);

      const res = reconcileFlow(p.core, p.details, emptyView('small'), n);
      const guides = deriveMilestoneGuides(p.core, res.view);
      const msGuide = guides.find((gd) => gd.taskId === taskIdByName(p, 'MS'))!;
      expect(msGuide.bound).toBe(true);

      const nodes = taskNodes(res.view);
      const s1 = nodes.find((nd) => nd.taskId === taskIdByName(p, 'S1'))!;
      const s2 = nodes.find((nd) => nd.taskId === taskIdByName(p, 'S2'))!;
      // M 自身のノードはこの小ビューには存在しない
      expect(nodes.find((nd) => nd.taskId === mId)).toBeUndefined();

      const expectedX = Math.max(s1.x + SIZE.task.w, s2.x + SIZE.task.w) + 40;
      expect(msGuide.x).toBe(expectedX);
    });

    it('②大ビュー: 対象(小)工程の大祖先ノードの右端 + 40', () => {
      const g = counter();
      const n = counter('n');
      let p = emptyProject();
      p = addTask(p, { name: 'L', level: 'large' }, g);
      const lId = taskIdByName(p, 'L');
      p = addTask(p, { name: 'M', level: 'medium', parentId: lId }, g);
      const mId = taskIdByName(p, 'M');
      p = addTask(p, { name: 'S1', level: 'small', parentId: mId }, g);
      // MS は大ビュー自身の粒度（大）で作る。
      p = addTask(p, { name: 'MS', level: 'large', kind: 'milestone' }, g);
      // 入依存: S1(小) → MS(大)。
      p = addDependency(p, taskIdByName(p, 'S1'), taskIdByName(p, 'MS'), g);

      const res = reconcileFlow(p.core, p.details, emptyView('large'), n);
      const guides = deriveMilestoneGuides(p.core, res.view);
      const msGuide = guides.find((gd) => gd.taskId === taskIdByName(p, 'MS'))!;
      expect(msGuide.bound).toBe(true);

      const nodes = taskNodes(res.view);
      const lNode = nodes.find((nd) => nd.taskId === lId)!;
      // S1・M 自身のノードはこの大ビューには存在しない
      expect(nodes.find((nd) => nd.taskId === taskIdByName(p, 'S1'))).toBeUndefined();
      expect(nodes.find((nd) => nd.taskId === mId)).toBeUndefined();

      expect(msGuide.x).toBe(lNode.x + SIZE.task.w + 40);
    });

    it('③混在: 直接可視の対象 と 代表へ変換される対象 の max', () => {
      const g = counter();
      const n = counter('n');
      let p = emptyProject();
      // T1: このビュー(中)に直接存在する対象工程
      p = addTask(p, { name: 'T1', level: 'medium' }, g);
      // P(大) の子 C(中) はこの中ビューに直接見える → P の代表ノードになる
      p = addTask(p, { name: 'P', level: 'large' }, g);
      const pId = taskIdByName(p, 'P');
      p = addTask(p, { name: 'C', level: 'medium', parentId: pId }, g);
      p = addTask(p, { name: 'MS', level: 'medium', kind: 'milestone' }, g);
      p = addDependency(p, taskIdByName(p, 'T1'), taskIdByName(p, 'MS'), g);
      p = addDependency(p, pId, taskIdByName(p, 'MS'), g); // P(大) → MS(中)

      const res = reconcileFlow(p.core, p.details, emptyView('medium'), n);
      const guides = deriveMilestoneGuides(p.core, res.view);
      const msGuide = guides.find((gd) => gd.taskId === taskIdByName(p, 'MS'))!;
      expect(msGuide.bound).toBe(true);

      const nodes = taskNodes(res.view);
      const t1 = nodes.find((nd) => nd.taskId === taskIdByName(p, 'T1'))!;
      const c = nodes.find((nd) => nd.taskId === taskIdByName(p, 'C'))!;
      expect(nodes.find((nd) => nd.taskId === pId)).toBeUndefined();

      const expectedX = Math.max(t1.x + SIZE.task.w, c.x + SIZE.task.w) + 40;
      expect(msGuide.x).toBe(expectedX);
    });
  });
});
