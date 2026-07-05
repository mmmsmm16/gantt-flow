// 業務リント lintProject の検出/非検出・除外規則・整合性写像・決定論・空/充足を検証。
import { describe, expect, it } from 'vitest';
import { counter, emptyProject } from './helpers';
import {
  addTask,
  setAssignee,
  addAssignee,
  addDependency,
  addIssueItem,
  addIoItem,
  updateTaskDetail,
  upsertProcedure,
  addStep,
} from '../src/commands';
import { lintProject, type LintIssue } from '../src/lint';

const NOW = '2026-07-05T00:00:00.000Z';

// 葉工程を「担当あり・工数あり・手順書あり・課題なし」の充足状態で作るヘルパ。
function fullLeaf(p: ReturnType<typeof emptyProject>, id: string, g: () => string) {
  let out = addTask(p, { name: id, level: 'medium', id }, g);
  out = addAssignee(out, { name: `担当${id}`, kind: 'person' }, () => `asg-${id}`);
  out = setAssignee(out, id, `asg-${id}`);
  out = updateTaskDetail(out, id, { effortMinutes: 30 });
  out = upsertProcedure(out, id, { purpose: 'p' }, NOW);
  out = addStep(out, id, { action: 'やる' }, g, NOW);
  return out;
}

const kinds = (issues: LintIssue[]) => issues.map((i) => i.kind);

describe('lintProject: 納品物チェック（葉工程）', () => {
  it('未整備の葉工程で手順書未作成・担当未割当・工数未入力を検出', () => {
    const g = counter();
    let p = emptyProject();
    p = addTask(p, { name: 'A', level: 'medium', id: 'A' }, g);

    const out = lintProject(p);
    expect(out.some((i) => i.kind === 'procedure.missing' && i.taskId === 'A')).toBe(true);
    expect(out.some((i) => i.kind === 'task.noAssignee' && i.taskId === 'A')).toBe(true);
    expect(out.some((i) => i.kind === 'task.noEffort' && i.taskId === 'A')).toBe(true);
    // すべて warn。
    expect(out.every((i) => i.severity === 'warn')).toBe(true);
  });

  it('充足した葉工程は指摘なし（[]）', () => {
    const g = counter();
    const p = fullLeaf(emptyProject(), 'A', g);
    expect(lintProject(p)).toEqual([]);
  });

  it('工数 0 は未入力とみなす', () => {
    const g = counter();
    let p = fullLeaf(emptyProject(), 'A', g);
    p = updateTaskDetail(p, 'A', { effortMinutes: 0 });
    expect(lintProject(p).some((i) => i.kind === 'task.noEffort' && i.taskId === 'A')).toBe(true);
  });
});

describe('lintProject: 除外規則', () => {
  it('非葉（子を持つ）工程は手順書/担当/工数の対象外', () => {
    const g = counter();
    let p = emptyProject();
    p = addTask(p, { name: '親', level: 'medium', id: 'M' }, g);
    p = fullLeaf(p, 'C', g); // C を葉として充足
    // C を M の子にする（親 M は非葉になる）
    p = addTask(p, { name: '子', level: 'small', parentId: 'M', id: 'K' }, g);
    p = setAssignee(p, 'K', undefined);

    const out = lintProject(p);
    // 親 M は非葉なので M 由来の指摘は出ない。
    expect(out.some((i) => i.taskId === 'M')).toBe(false);
    // 葉 K は未整備なので指摘が出る。
    expect(out.some((i) => i.taskId === 'K')).toBe(true);
  });

  it('マイルストーンは対象外', () => {
    const g = counter();
    let p = emptyProject();
    p = addTask(p, { name: 'MS', level: 'medium', id: 'MS', kind: 'milestone' }, g);
    expect(lintProject(p).some((i) => i.taskId === 'MS')).toBe(false);
  });
});

describe('lintProject: 課題の方策未記入', () => {
  it('課題テキストあり・方策空を検出。両方空はスキップ', () => {
    const g = counter();
    let p = fullLeaf(emptyProject(), 'A', g);
    p = addIssueItem(p, 'A', { issue: '属人化', measure: '' }, () => 'iss-1');
    p = addIssueItem(p, 'A', { issue: '', measure: '' }, () => 'iss-2'); // 両方空→スキップ
    p = addIssueItem(p, 'A', { issue: '手戻り', measure: 'チェックリスト' }, () => 'iss-3'); // 充足→出ない

    const out = lintProject(p).filter((i) => i.category === 'issue');
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ kind: 'issue.noMeasure', taskId: 'A', issueId: 'iss-1' });
  });
});

describe('lintProject: 帳票の受け渡し整合（io）', () => {
  it('繋がる帳票（A出力=B入力）は検出せず、行き止まり出力・出所不明入力だけを warn する', () => {
    const g = counter();
    let p = emptyProject();
    p = fullLeaf(p, 'A', g);
    p = fullLeaf(p, 'B', g);
    // A: 注文書を出力 / B: 注文書を入力（＝繋がる・検出しない）
    p = addIoItem(p, 'A', 'outputs', { name: '注文書', kind: 'doc' }, () => 'io-a-out');
    p = addIoItem(p, 'B', 'inputs', { name: '注文書', kind: 'doc' }, () => 'io-b-in');
    // A: 集計表を出力するが誰も入力しない（＝行き止まり）
    p = addIoItem(p, 'A', 'outputs', { name: '集計表', kind: 'doc' }, () => 'io-a-out2');
    // B: 在庫データを入力するが上流の出力にも source にも根拠が無い（＝出所不明）
    p = addIoItem(p, 'B', 'inputs', { name: '在庫データ', kind: 'doc' }, () => 'io-b-in2');
    // B: 顧客マスタを入力するが source を明記（＝出所あり・検出しない）
    p = addIoItem(p, 'B', 'inputs', { name: '顧客マスタ', kind: 'doc', source: '基幹システム' }, () => 'io-b-in3');

    const io = lintProject(p).filter((i) => i.category === 'io');
    expect(io.map((i) => i.kind).sort()).toEqual(['io.deadEndOutput', 'io.unsourcedInput']);
    expect(io.find((i) => i.kind === 'io.deadEndOutput')).toMatchObject({ ref: 'io-a-out2', taskId: 'A' });
    expect(io.find((i) => i.kind === 'io.unsourcedInput')).toMatchObject({ ref: 'io-b-in2', taskId: 'B' });
  });
});

describe('lintProject: 整合性写像（validate → integrity）', () => {
  it('dependency.from（欠落端点）を error にし taskId を実在端点へ寄せる', () => {
    const g = counter();
    let p = fullLeaf(emptyProject(), 'A', g);
    // A→B の依存を作ってから B を消して端点欠落を再現（直接注入）。
    p = addTask(p, { name: 'B', level: 'medium', id: 'B' }, g);
    p = addDependency(p, 'B', 'A', () => 'dep-1'); // from=B, to=A
    delete p.core.tasks['B']; // from 欠落
    delete p.details['B'];

    const out = lintProject(p);
    const dep = out.find((i) => i.kind === 'dependency.from');
    expect(dep).toBeDefined();
    expect(dep!.category).toBe('integrity');
    expect(dep!.severity).toBe('error');
    expect(dep!.taskId).toBe('A'); // 実在端点
  });

  it('detail.task（孤児詳細）は warn で taskId は undefined', () => {
    const g = counter();
    let p = fullLeaf(emptyProject(), 'A', g);
    p.details['ghost'] = { taskId: 'ghost' }; // 実在しない工程の詳細
    const out = lintProject(p);
    const orphan = out.find((i) => i.kind === 'detail.task');
    expect(orphan).toBeDefined();
    expect(orphan!.severity).toBe('warn');
    expect(orphan!.taskId).toBeUndefined();
  });
});

describe('lintProject: 決定論ソート', () => {
  it('category 固定順（integrity→procedure→assignee→effort→issue）で並ぶ', () => {
    const g = counter();
    let p = emptyProject();
    // 未整備の葉 A（procedure/assignee/effort が出る）＋孤児詳細（integrity）＋課題未記入。
    p = addTask(p, { name: 'A', level: 'medium', id: 'A' }, g);
    p = addIssueItem(p, 'A', { issue: 'x', measure: '' }, () => 'iss-1');
    p.details['ghost'] = { taskId: 'ghost' };

    const cats = lintProject(p).map((i) => i.category);
    const order = ['integrity', 'procedure', 'assignee', 'effort', 'issue', 'io'];
    const idx = cats.map((c) => order.indexOf(c));
    // 単調非減少（＝固定順を守る）。
    expect(idx.every((v, i) => i === 0 || v >= idx[i - 1]!)).toBe(true);
  });

  it('同一 lint を 2 回流しても順序・件数が安定', () => {
    const g = counter();
    let p = emptyProject();
    p = addTask(p, { name: 'A', level: 'medium', id: 'A' }, g);
    p = addTask(p, { name: 'B', level: 'medium', id: 'B' }, g);
    const a = kinds(lintProject(p));
    const b = kinds(lintProject(p));
    expect(a).toEqual(b);
  });
});

describe('lintProject: 空プロジェクト', () => {
  it('工程 0 件は []', () => {
    expect(lintProject(emptyProject())).toEqual([]);
  });
});
