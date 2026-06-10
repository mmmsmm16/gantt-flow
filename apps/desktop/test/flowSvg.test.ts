import { describe, it, expect } from 'vitest';
import { createSampleProject, updateTaskDetail } from '@gantt-flow/core';
import { buildFlowSvg } from '../src/flowSvg';
import { TASK_COLORS, FLOW_LIGHT } from '../src/theme';

// 決定論 idGen（テスト用）
function counter() {
  let i = 0;
  return () => `id-${i++}`;
}

describe('buildFlowSvg のスイムレーン描画', () => {
  it('担当レーンのあるビューはレーン名を描く', () => {
    const p = createSampleProject(counter());
    const medium = p.flow.byLevel.find((v) => v.level === 'medium' && v.scopeParentId)!;
    const svg = buildFlowSvg(p, medium);
    expect(svg).toContain('営業部'); // レーン名（担当）
    expect(svg).toContain('注文受付'); // 工程名
  });

  it('担当レーンが無いビュー（大/全体）はスイムレーンも「（未割当）」も描かない', () => {
    const p = createSampleProject(counter());
    const large = p.flow.byLevel.find((v) => v.level === 'large' && !v.scopeParentId)!;
    const svg = buildFlowSvg(p, large);
    expect(svg).not.toContain('（未割当）'); // 担当者名の無いレーンを出さない
    expect(svg).not.toContain('営業部'); // 担当レーンは無い
    expect(svg).toContain('受注業務'); // 大工程ノードは描く
  });

  it('工程カラー(塗り/文字色)が SVG の fill/stroke に乗る。未設定は既定色', () => {
    let p = createSampleProject(counter());
    const view = p.flow.byLevel.find((v) => v.level === 'medium' && v.scopeParentId)!;
    const taskNode = Object.values(view.nodes).find(
      (n): n is Extract<typeof n, { kind: 'task' }> => n.kind === 'task',
    )!;
    p = updateTaskDetail(p, taskNode.taskId, { fillColor: 'red', textColor: 'blue' });
    const svg = buildFlowSvg(p, view);
    expect(svg).toContain(`fill="${TASK_COLORS.red.fill}" stroke="${TASK_COLORS.red.base}"`);
    expect(svg).toContain(`fill="${TASK_COLORS.blue.text}"`);
    // 他の工程は既定色のまま
    expect(svg).toContain(`fill="${FLOW_LIGHT.task.fill}" stroke="${FLOW_LIGHT.task.stroke}"`);
  });
});
