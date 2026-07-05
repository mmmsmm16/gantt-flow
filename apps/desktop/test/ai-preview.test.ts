// AI プレビューの決定論（危険地帯 4）と、承認バッチ適用の 1 undo。
//  - 同じ ops → 同じ preview.result.project / nodeMap（buildAiPreview を 2 回呼んで deep-equal）。
//  - 全 op で作るので view は却下予定ノードも含む。
//  - applyApprovedBatch 後に承認分が反映され、undo 一発で全 op が消える。
import { describe, it, expect, beforeEach } from 'vitest';
import { type BatchOp, type Project } from '@gantt-flow/core';
import type { FlowTaskNode } from '@gantt-flow/core';
import { buildAiPreview } from '../src/ai/preview';
import { resolveApproved, applyEdits, type DecisionMap } from '../src/ai/decisions';
import { createAppStore } from '../src/store';

const emptyProject = (): Project => ({
  schemaVersion: 1,
  meta: { id: 'p', title: 'テスト', createdAt: '', updatedAt: '', appVersion: '' },
  core: { tasks: {}, dependencies: {}, assignees: {} },
  details: {},
  flow: { byLevel: [] },
  manual: { procedures: {}, assets: {} },
});

const ops: BatchOp[] = [
  { op: 'add_task', ref: 'a', name: '受注', level: 'medium', assignee: '営業' },
  { op: 'add_task', ref: 'b', name: '出荷', level: 'medium', assignee: '倉庫' },
  { op: 'add_dependency', from: 'a', to: 'b' },
  { op: 'set_procedure', task: 'a', purpose: '受注を確定する' },
];

describe('buildAiPreview（決定論）', () => {
  it('同じ ops → 同じ result.project / view / nodeMap（2 回呼んで deep-equal）', () => {
    const p = emptyProject();
    const a = buildAiPreview(p, ops, 'medium');
    const b = buildAiPreview(p, ops, 'medium');
    expect(b.result.project).toEqual(a.result.project);
    expect(b.view).toEqual(a.view);
    expect(b.nodeMap).toEqual(a.nodeMap);
    expect(b.ops).toEqual(a.ops);
  });

  it('全 op で作るので view は全提案タスクのノードを含む', () => {
    const preview = buildAiPreview(emptyProject(), ops, 'medium');
    const taskNodes = Object.values(preview.view.nodes).filter(
      (n): n is FlowTaskNode => n.kind === 'task',
    );
    expect(taskNodes.length).toBe(2); // 受注・出荷（却下判定に依らず両方）
  });

  it('ref 未指定の add_task にも __p 注入で nodeMap が引ける', () => {
    const bare: BatchOp[] = [{ op: 'add_task', name: '検品', level: 'medium' }];
    const preview = buildAiPreview(emptyProject(), bare, 'medium');
    expect(preview.ops[0]).toMatchObject({ ref: '__p0' });
    expect(preview.nodeMap.opToTaskId.get(0)).toBeDefined();
  });

  it('op.ref="__p0" が既存でも合成 ref と衝突せず全単射を保つ（レビュー指摘: __p ref 衝突）', () => {
    // op[0] は ref 未指定なので素朴な実装なら '__p0' を注入するが、op[1] が明示的に
    // ref='__p0' を名乗っている。衝突すれば aliases['__p0'] が後勝ちで上書きされ、
    // op[0] と op[1] が同じ taskId に化ける（プレビュー対応の誤り＋本番適用の誤配線）。
    const collideOps: BatchOp[] = [
      { op: 'add_task', name: '検品', level: 'medium' },
      { op: 'add_task', ref: '__p0', name: '出荷', level: 'medium' },
    ];
    const preview = buildAiPreview(emptyProject(), collideOps, 'medium');
    // 注入された ref 自体が衝突していないこと。
    expect(preview.ops[0]).toMatchObject({ ref: '__p0_' });
    expect(preview.ops[1]).toMatchObject({ ref: '__p0' });
    // nodeMap が全単射を保っている（2 op が別々の taskId に解決される）こと。
    const idA = preview.nodeMap.opToTaskId.get(0);
    const idB = preview.nodeMap.opToTaskId.get(1);
    expect(idA).toBeDefined();
    expect(idB).toBeDefined();
    expect(idA).not.toBe(idB);
    const taskNodes = Object.values(preview.view.nodes).filter(
      (n): n is FlowTaskNode => n.kind === 'task',
    );
    expect(taskNodes.length).toBe(2); // 衝突していれば 1 個に潰れる
  });

  it('AI が同一 ref を複数 producer で宣言したら後発をリネームし警告を積む（D-04）', () => {
    const dupOps: BatchOp[] = [
      { op: 'add_task', ref: 'x', name: '受注', level: 'medium' }, // 先発: ref='x' のまま
      { op: 'add_task', ref: 'x', name: '出荷', level: 'medium' }, // 後発: 'x_2' へ振替
    ];
    const preview = buildAiPreview(emptyProject(), dupOps, 'medium');
    expect(preview.ops[0]).toMatchObject({ ref: 'x' });
    expect(preview.ops[1]).toMatchObject({ ref: 'x_2' });
    expect(preview.warnings).toHaveLength(1);
    expect(preview.warnings[0]).toContain('x');
    // 2 op が別々の taskId に解決される（後勝ちで 1 個に潰れない）。
    const idA = preview.nodeMap.opToTaskId.get(0);
    const idB = preview.nodeMap.opToTaskId.get(1);
    expect(idA).toBeDefined();
    expect(idB).toBeDefined();
    expect(idA).not.toBe(idB);
    const taskNodes = Object.values(preview.view.nodes).filter(
      (n): n is FlowTaskNode => n.kind === 'task',
    );
    expect(taskNodes.length).toBe(2);
  });

  it('重複が無ければ warnings は空（既存挙動を変えない）', () => {
    const preview = buildAiPreview(emptyProject(), ops, 'medium');
    expect(preview.warnings).toEqual([]);
  });
});

describe('applyApprovedBatch（1 undo）', () => {
  beforeEach(() => {
    // node 環境向けの localStorage シム（store 内部でトースト等が触っても落ちないように）。
    if (typeof (globalThis as { localStorage?: unknown }).localStorage === 'undefined') {
      const m = new Map<string, string>();
      (globalThis as { localStorage?: unknown }).localStorage = {
        getItem: (k: string) => m.get(k) ?? null,
        setItem: (k: string, v: string) => void m.set(k, String(v)),
        removeItem: (k: string) => void m.delete(k),
        clear: () => m.clear(),
        key: (i: number) => [...m.keys()][i] ?? null,
        get length() {
          return m.size;
        },
      };
    }
  });

  it('承認分を適用し、undo 一発で全 op が消える', () => {
    const s = createAppStore();
    const project = s.getState().project;
    const preview = buildAiPreview(project, ops, s.getState().level, s.getState().scopeParentId);

    const decisions: DecisionMap = { 0: 'approved', 1: 'approved', 2: 'approved', 3: 'approved' };
    const finalOps = applyEdits(preview.ops, {});
    const { apply } = resolveApproved(finalOps, decisions);
    const applyOps = apply.map((i) => finalOps[i]!);

    const before = Object.keys(s.getState().project.core.tasks).length;
    s.getState().applyApprovedBatch(applyOps);

    const names = Object.values(s.getState().project.core.tasks).map((t) => t.name);
    expect(names).toContain('受注');
    expect(names).toContain('出荷');
    expect(Object.keys(s.getState().project.core.dependencies).length).toBe(1);
    expect(s.getState().canUndo).toBe(true);

    // undo 一発で全提案が消える（1 スナップショット）。
    s.getState().undo();
    expect(Object.keys(s.getState().project.core.tasks).length).toBe(before);
    expect(Object.keys(s.getState().project.core.dependencies).length).toBe(0);
  });

  it('空の applyOps は履歴を汚さない（no-op）', () => {
    const s = createAppStore();
    const canUndoBefore = s.getState().canUndo;
    s.getState().applyApprovedBatch([]);
    expect(s.getState().canUndo).toBe(canUndoBefore);
  });
});
