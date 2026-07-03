import { describe, it, expect } from 'vitest';
import {
  addDependency,
  addIoItem,
  addTask,
  createSampleProject,
  deriveMilestoneGuides,
  ioIconRect,
  issuePrimaryIds,
  laneLayout,
  reconcileProject,
  sourceChipLayout,
  updateTaskDetail,
  type FlowNode,
  type Project,
} from '@gantt-flow/core';
import { buildFlowSvg } from '../src/flowSvg';
import { TASK_COLORS, FLOW_LIGHT } from '../src/theme';

// 決定論 idGen（テスト用）。prefix を変えれば createSampleProject 側の 'id-N' 採番と衝突しない
// 別系列の id を発番できる（サンプル生成後に追加コマンドを重ねる場合に使う）。
function counter(prefix = 'id') {
  let i = 0;
  return () => `${prefix}-${i++}`;
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

// 中（スコープ＝受注業務）のビュー。レーンがあり I/O 描画のテストに使う。
const mediumView = (p: Project) => p.flow.byLevel.find((v) => v.level === 'medium' && v.scopeParentId)!;
const firstTaskNode = (p: Project) =>
  Object.values(mediumView(p).nodes).find(
    (n): n is Extract<FlowNode, { kind: 'task' }> => n.kind === 'task',
  )!;
const parseViewBox = (svg: string) => {
  const m = svg.match(/viewBox="(-?[\d.]+) (-?[\d.]+) ([\d.]+) ([\d.]+)"/);
  expect(m).not.toBeNull();
  const [x, y, w, h] = m!.slice(1).map(Number);
  return { x: x!, y: y!, w: w!, h: h! };
};

describe('buildFlowSvg の出力範囲（I/O のはみ出し）', () => {
  it('原点より左上へはみ出す入力 I/O アイコンも viewBox に含める（負方向へ拡張）', () => {
    let p = createSampleProject(counter());
    const taskId = firstTaskNode(p).taskId;
    let j = 0;
    for (let i = 0; i < 6; i++) {
      p = addIoItem(p, taskId, 'inputs', { name: `入力${i}`, kind: 'doc' }, () => `io-${j++}`);
    }
    const view = mediumView(p);
    const n = Object.values(view.nodes).find(
      (nn): nn is Extract<FlowNode, { kind: 'task' }> => nn.kind === 'task' && nn.taskId === taskId,
    )!;
    // 工程を左端・最上段レーン付近へ置く → 入力アイコンは x<0 / y<0 へはみ出す
    n.x = 20;
    n.y = 80;
    const plain = (p.details[taskId]?.inputs ?? []).filter((it) => !it.source?.trim()).length;
    const r = ioIconRect({ x: n.x, y: n.y }, 'input', plain);
    expect(r.x).toBeLessThan(0); // 前提: 本当に左へはみ出している
    expect(r.y).toBeLessThan(0);

    const svg = buildFlowSvg(p, view);
    const vb = parseViewBox(svg);
    expect(vb.x).toBeLessThanOrEqual(r.x);
    expect(vb.y).toBeLessThanOrEqual(r.y);
    expect(vb.x + vb.w).toBeGreaterThanOrEqual(r.x + r.w);
    expect(vb.y + vb.h).toBeGreaterThanOrEqual(r.y + r.h);
    // 背景もはみ出し領域を覆う（原点 0,0 固定の rect だと負側が透ける）
    expect(svg).toContain(`<rect x="${vb.x}" y="${vb.y}" width="100%" height="100%"`);
  });

  it('はみ出しが無い図は従来どおり viewBox が 0 0 起点', () => {
    const p = createSampleProject(counter());
    const large = p.flow.byLevel.find((v) => v.level === 'large' && !v.scopeParentId)!;
    const svg = buildFlowSvg(p, large);
    expect(svg).toMatch(/viewBox="0 0 \d/);
  });
});

describe('出所付き入力帳票（チップ配置は sourceChipLayout を画面と共有）', () => {
  it('レーンに無い出所は「外部:」付きで工程の真上、レーン一致（空白ゆれ吸収）は工程行に置く', () => {
    let p = createSampleProject(counter());
    const taskId = firstTaskNode(p).taskId;
    let j = 0;
    p = addIoItem(p, taskId, 'inputs', { name: '注文FAX', kind: 'doc', source: '取引先' }, () => `io-${j++}`);
    p = addIoItem(p, taskId, 'inputs', { name: '指示書', kind: 'doc', source: '営業部 ' }, () => `io-${j++}`);
    const view = mediumView(p);
    const n = Object.values(view.nodes).find(
      (nn): nn is Extract<FlowNode, { kind: 'task' }> => nn.kind === 'task' && nn.taskId === taskId,
    )!;
    const boxes = laneLayout(view.lanes);
    const svg = buildFlowSvg(p, view);

    // 出所がレーンに無い → 「外部:」付き・工程の真上に浮く
    const chip0 = sourceChipLayout({ x: n.x, y: n.y }, '取引先', 0, boxes);
    expect(chip0.label).toBe('外部: 取引先');
    expect(chip0.y).toBe(n.y - chip0.h - 30);
    expect(svg).toContain(`<rect x="${chip0.x}" y="${chip0.y}" width="${chip0.w}" height="${chip0.h}" rx="6"`);
    expect(svg).toContain('外部: 取引先');

    // 出所がレーン名と一致（末尾空白を吸収）→ そのレーンの工程行・「外部:」は付かない
    const chip1 = sourceChipLayout({ x: n.x, y: n.y }, '営業部 ', 1, boxes);
    const sales = boxes.find((b) => b.lane.title === '営業部')!;
    expect(chip1.y).toBe(sales.base);
    expect(chip1.label).toBe('営業部 ');
    expect(svg).toContain(`<rect x="${chip1.x}" y="${chip1.y}" width="${chip1.w}" height="${chip1.h}" rx="6"`);
    expect(svg).not.toContain('外部: 営業部');
  });
});

describe('issuePrimaryIds（課題の代表ノード選定。画面と画像出力で共有）', () => {
  const issueNode = (id: string, taskId: string, issueId: string): FlowNode => ({
    id,
    kind: 'issue',
    taskId,
    issueId,
    targetNodeId: 'tgt',
    x: 0,
    y: 0,
    visible: true,
  });

  it('details の課題順で先頭に対応するノードを代表に選ぶ', () => {
    const nodes = [issueNode('n2', 't1', 'i2'), issueNode('n1', 't1', 'i1')];
    const m = issuePrimaryIds(nodes, { t1: { issues: [{ id: 'i1' }, { id: 'i2' }] } });
    expect(m.get('t1')).toBe('n1');
  });

  it('順序が不明な課題は末尾扱い・同順はノード id 昇順で決定論', () => {
    const nodes = [issueNode('nb', 't1', 'ix'), issueNode('na', 't1', 'iy')];
    expect(issuePrimaryIds(nodes, {}).get('t1')).toBe('na');
  });
});

describe('buildFlowSvg のマイルストーン描画（菱形・縦線・ラベル）', () => {
  it('紐付きマイルストーンは菱形(rotate45)＋破線ガイド＋ラベルを描き、レーン内の工程boxは描かない', () => {
    let p = createSampleProject(counter());
    const view = mediumView(p);
    const parentId = view.scopeParentId!;
    const taskId = firstTaskNode(p).taskId; // 同スコープの既存工程 → MS の前工程にする
    const g = counter('ms1');
    p = addTask(p, { name: '検収完了', level: 'medium', parentId, kind: 'milestone', id: 'ms1-task' }, g);
    p = addDependency(p, taskId, 'ms1-task', g);
    p = reconcileProject(p, g); // 新規MSタスクのノードを追加配置

    const view2 = mediumView(p);
    const guide = deriveMilestoneGuides(p.core, view2).find((x) => x.taskId === 'ms1-task')!;
    expect(guide.bound).toBe(true); // 前工程あり＝自動追従

    const svg = buildFlowSvg(p, view2);
    expect(svg).toContain('rotate(45'); // 菱形（回転した角丸四角）
    expect(svg).toContain('opacity="0.55"'); // MS 縦破線ガイド（bands の破線と区別できる固有の属性）
    expect(svg).toContain('検収完了'); // MS ラベル

    // レーン内の通常工程box(rx="9")の数は、非MS工程の数と一致する＝MSはboxとして描かない
    const nonMsTaskCount = Object.values(view2.nodes).filter(
      (n): n is Extract<FlowNode, { kind: 'task' }> => n.kind === 'task' && n.taskId !== 'ms1-task',
    ).length;
    const taskRectCount = (svg.match(/rx="9"/g) ?? []).length;
    expect(taskRectCount).toBe(nonMsTaskCount);
  });

  it('MSがあると viewBox の minY は -30 以下まで拡張する（余白無しは既存テストで 0 起点を確認済み）', () => {
    let p = createSampleProject(counter());
    const view = mediumView(p);
    const parentId = view.scopeParentId!;
    const taskId = firstTaskNode(p).taskId;
    const g = counter('ms2');
    p = addTask(p, { name: 'MS', level: 'medium', parentId, kind: 'milestone', id: 'ms2-task' }, g);
    p = addDependency(p, taskId, 'ms2-task', g);
    p = reconcileProject(p, g);

    const svg = buildFlowSvg(p, mediumView(p));
    const vb = parseViewBox(svg);
    expect(vb.y).toBeLessThanOrEqual(-30);
  });

  it('未紐付けマイルストーンは縦線の x が菱形（自ノード）の x と一致する', () => {
    let p = createSampleProject(counter());
    const view = mediumView(p);
    const parentId = view.scopeParentId!;
    const g = counter('ms3');
    p = addTask(p, { name: '未紐付けMS', level: 'medium', parentId, kind: 'milestone', id: 'ms3-task' }, g);
    p = reconcileProject(p, g); // 依存なし＝前工程を持たない

    const view2 = mediumView(p);
    const guide = deriveMilestoneGuides(p.core, view2).find((x) => x.taskId === 'ms3-task')!;
    expect(guide.bound).toBe(false); // 未紐付け＝自ノードの x を使う

    const svg = buildFlowSvg(p, view2);
    expect(svg).toContain(`x1="${guide.x}"`); // 縦線の始点 x が guide.x（自ノードの x）と一致
  });
});
