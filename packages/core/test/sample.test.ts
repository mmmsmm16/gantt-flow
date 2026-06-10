import { describe, it, expect } from 'vitest';
import { createSampleProject } from '../src/sample';
import { reconcileProject } from '../src/sync/reconcileProject';
import { computeCodes } from '../src/codes';
import { effortRollupMinutes } from '../src/metrics';
import { ProjectSchema } from '../src/model/schema';
import { counter } from './helpers';
import { taskIdByName } from './helpers';

describe('createSampleProject', () => {
  it('決定論的: 同じ idGen 入力なら同一出力（バイト安定）', () => {
    const a = createSampleProject(counter());
    const b = createSampleProject(counter());
    expect(a).toEqual(b);
  });

  it('スキーマに適合する（保存可能な正しい形）', () => {
    const p = createSampleProject(counter());
    expect(() => ProjectSchema.parse(p)).not.toThrow();
  });

  it('部門・大中小工程・前後関係・I/O・課題を一通り含む', () => {
    const p = createSampleProject(counter());
    const tasks = Object.values(p.core.tasks);
    expect(Object.keys(p.core.assignees)).toHaveLength(4);
    expect(tasks.filter((t) => t.level === 'large')).toHaveLength(3);
    expect(tasks.filter((t) => t.level === 'medium').length).toBeGreaterThanOrEqual(8);
    expect(tasks.filter((t) => t.level === 'small')).toHaveLength(3);
    expect(Object.keys(p.core.dependencies).length).toBeGreaterThanOrEqual(8);
    const hasIssue = Object.values(p.details).some((d) => (d.issues?.length ?? 0) > 0);
    const hasIo = Object.values(p.details).some(
      (d) => (d.inputs?.length ?? 0) + (d.outputs?.length ?? 0) > 0,
    );
    expect(hasIssue).toBe(true);
    expect(hasIo).toBe(true);
  });

  it('既定ビュー（中・スコープ=受注業務）と全体ビュー（大）が同期済み', () => {
    const p = createSampleProject(counter());
    const large = p.flow.byLevel.find((v) => v.level === 'large' && !v.scopeParentId);
    const medium = p.flow.byLevel.find((v) => v.level === 'medium' && v.scopeParentId);
    expect(large).toBeDefined();
    expect(medium).toBeDefined();
    // 中ビューには受注業務配下の中工程ノードと、依存由来のエッジが並ぶ
    const taskNodes = Object.values(medium!.nodes).filter((n) => n.kind === 'task');
    expect(taskNodes.length).toBe(4);
    expect(Object.keys(medium!.edges).length).toBeGreaterThanOrEqual(3);
  });

  it('冪等: もう一度 reconcile しても変化しない', () => {
    const p = createSampleProject(counter());
    const again = reconcileProject(p, counter('x'));
    expect(again.flow).toEqual(p.flow);
  });

  it('工数ロールアップ: 注文受付（中・小をもつ）は子の合計', () => {
    const p = createSampleProject(counter());
    const m1 = taskIdByName(p, '注文受付');
    // 小工程 10 + 15 + 20 = 45 分
    expect(effortRollupMinutes(p.core, p.details, m1)).toBe(45);
  });

  it('工程No が階層採番される', () => {
    const p = createSampleProject(counter());
    const codes = computeCodes(p.core);
    const m1 = taskIdByName(p, '注文受付');
    expect(codes[m1]).toBe('1-1');
  });
});
