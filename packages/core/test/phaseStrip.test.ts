import { describe, it, expect } from 'vitest';
import { addTask, renameTask } from '../src/commands';
import { reconcileFlow } from '../src/sync/reconcileFlow';
import { derivePhaseStrip } from '../src/sync/phaseStrip';
import type { FlowTaskNode } from '../src/model/types';
import { counter, emptyProject, emptyView, taskIdByName } from './helpers';

const taskNodes = (v: ReturnType<typeof reconcileFlow>['view']) =>
  Object.values(v.nodes).filter((n): n is FlowTaskNode => n.kind === 'task');

// 大2件（見積 / 契約）＋各配下に中2件のプロジェクトを組む共通ヘルパ。
function buildTwoPhases() {
  const g = counter();
  let p = emptyProject();
  p = addTask(p, { name: '見積', level: 'large' }, g);
  p = addTask(p, { name: '契約', level: 'large' }, g);
  const mitsumori = taskIdByName(p, '見積');
  const keiyaku = taskIdByName(p, '契約');
  p = addTask(p, { name: '要件整理', level: 'medium', parentId: mitsumori }, g);
  p = addTask(p, { name: '見積作成', level: 'medium', parentId: mitsumori }, g);
  p = addTask(p, { name: '契約書作成', level: 'medium', parentId: keiyaku }, g);
  p = addTask(p, { name: '締結', level: 'medium', parentId: keiyaku }, g);
  return { p, mitsumori, keiyaku };
}

describe('derivePhaseStrip', () => {
  it('中ビュー → 大工程ごとに1セグメント・x範囲がメンバーを包含・x昇順', () => {
    const { p, mitsumori, keiyaku } = buildTwoPhases();
    const res = reconcileFlow(p.core, p.details, emptyView('medium'), counter('n'));
    const segs = derivePhaseStrip(p.core, res.view);
    expect(segs.map((s) => s.taskId).sort()).toEqual([mitsumori, keiyaku].sort());
    expect(segs.map((s) => s.label)).toContain('見積');
    // 各セグメントはメンバーの x 範囲（±PAD）を包含する
    for (const seg of segs) {
      const members = taskNodes(res.view).filter((n) => p.core.tasks[n.taskId]!.parentId === seg.taskId);
      const minX = Math.min(...members.map((n) => n.x));
      expect(seg.x).toBeLessThanOrEqual(minX);
      expect(seg.x + seg.width).toBeGreaterThan(Math.max(...members.map((n) => n.x)));
    }
    // x 昇順で安定
    const xs = segs.map((s) => s.x);
    expect([...xs].sort((a, b) => a - b)).toEqual(xs);
  });

  it('大ビュー → 常に空（ノード自体がフェーズ）', () => {
    const { p } = buildTwoPhases();
    const res = reconcileFlow(p.core, p.details, emptyView('large'), counter('n'));
    expect(derivePhaseStrip(p.core, res.view)).toEqual([]);
  });

  it('スコープ付きビュー → 単一セグメントに退化', () => {
    const { p, mitsumori } = buildTwoPhases();
    const res = reconcileFlow(p.core, p.details, emptyView('medium', mitsumori), counter('n'));
    const segs = derivePhaseStrip(p.core, res.view);
    expect(segs).toHaveLength(1);
    expect(segs[0]!.taskId).toBe(mitsumori);
  });

  it('x範囲が交差しても詰め直さない（重なりは事実の表現）', () => {
    const { p, mitsumori, keiyaku } = buildTwoPhases();
    const res = reconcileFlow(p.core, p.details, emptyView('medium'), counter('n'));
    // 契約側の1ノードを見積側の領域へ手動移動（手動配置の再現）
    const view = { ...res.view, nodes: { ...res.view.nodes } };
    const moved = taskNodes(res.view).find((n) => p.core.tasks[n.taskId]!.parentId === keiyaku)!;
    view.nodes[moved.id] = { ...moved, x: 0 };
    const segs = derivePhaseStrip(p.core, view);
    const a = segs.find((s) => s.taskId === mitsumori)!;
    const b = segs.find((s) => s.taskId === keiyaku)!;
    expect(b.x).toBeLessThan(a.x + a.width); // 重なったまま返る
  });

  it('リネーム（データのみ編集）→ ラベルだけ変わり x/width 不変', () => {
    const { p, mitsumori } = buildTwoPhases();
    const res = reconcileFlow(p.core, p.details, emptyView('medium'), counter('n'));
    const before = derivePhaseStrip(p.core, res.view);
    const p2 = renameTask(p, mitsumori, '見積フェーズ');
    const after = derivePhaseStrip(p2.core, res.view);
    expect(after.find((s) => s.taskId === mitsumori)!.label).toBe('見積フェーズ');
    expect(after.map(({ label, ...rest }) => rest)).toEqual(before.map(({ label, ...rest }) => rest));
  });
});
