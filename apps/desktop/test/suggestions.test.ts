import { describe, it, expect } from 'vitest';
import { createAppStore } from '../src/store';
import { prevCandidates, buildPrevCandidateIndex, collectIoNames } from '../src/suggestions';

describe('suggestions: prevCandidates', () => {
  it('同じ粒度の工程が候補になり、既存の前後関係(両向き)・粒度違いは除外される', () => {
    const s = createAppStore();
    s.getState().addTask('A');
    s.getState().addTask('B');
    s.getState().addTask('C');
    const byName = (name: string) =>
      Object.values(s.getState().project.core.tasks).find((t) => t.name === name)!;
    const a = byName('A');
    const b = byName('B');
    const c = byName('C');

    // 最初は A の候補に B, C が出る
    expect(prevCandidates(s.getState().project, a.id).map((t) => t.name)).toEqual(['B', 'C']);

    // B→A の依存を張ると、A の候補から B が消える(逆向きも判定するので A の succ 側も除外)
    s.getState().addDependency(b.id, a.id);
    expect(prevCandidates(s.getState().project, a.id).map((t) => t.name)).toEqual(['C']);
    // B の候補からも A が消える(逆依存)
    expect(prevCandidates(s.getState().project, b.id).map((t) => t.name)).toEqual(['C']);

    // 粒度が違う兄弟は候補に出ない
    s.getState().setTaskLevel(c.id, 'small');
    expect(prevCandidates(s.getState().project, a.id)).toHaveLength(0);
  });

  it('同じ粒度なら別の親グループの工程も候補に出る（粒度跨ぎは出ない）', () => {
    const s = createAppStore();
    s.getState().addRootTask('large');
    const l1 = Object.values(s.getState().project.core.tasks)[0]!;
    s.getState().addChildTask(l1.id); // 中工程(親=l1)
    s.getState().addChildTask(l1.id); // 中工程(親=l1)
    const rootMediumId = s.getState().addRootTask('medium')!; // ルート直下の中工程(親が違う)
    const children = Object.values(s.getState().project.core.tasks).filter((t) => t.parentId === l1.id);
    expect(children).toHaveLength(2);
    const cands = prevCandidates(s.getState().project, children[0]!.id);
    // 兄弟(children[1]) と 別グループの中工程(rootMedium) の両方が同粒度候補に出る（仕様拡大）
    expect(cands.map((t) => t.id).sort()).toEqual([children[1]!.id, rootMediumId].sort());
    // 大工程(l1)は粒度が違うので候補に出ない
    expect(cands.map((t) => t.id)).not.toContain(l1.id);
  });
});

// 意味の単一ソースは prevCandidates。前計算インデックスはその等価実装であることを
// 全タスクに対する突き合わせ（プロパティ的テスト）で固定する。
describe('suggestions: buildPrevCandidateIndex（前工程候補の前計算）', () => {
  it('サンプルプロジェクトの全工程で prevCandidates と同じ候補(順序含む)を返す', () => {
    const s = createAppStore();
    // ルート直下の兄弟(同じ粒度)＋粒度違い
    s.getState().addTask('A');
    s.getState().addTask('B');
    s.getState().addTask('C');
    s.getState().addTask('D');
    const byName = (name: string) =>
      Object.values(s.getState().project.core.tasks).find((t) => t.name === name)!;
    // 依存は両向き判定の対象（B→A と A→C で pred 側・succ 側の除外を両方踏む）
    s.getState().addDependency(byName('B').id, byName('A').id);
    s.getState().addDependency(byName('A').id, byName('C').id);
    s.getState().setTaskLevel(byName('D').id, 'small');
    // 子階層(親が違うグループ)。A の子同士にも依存を張る。
    s.getState().addChildTask(byName('A').id);
    s.getState().addChildTask(byName('A').id);
    s.getState().addChildTask(byName('A').id);
    s.getState().addChildTask(byName('B').id);
    const aChildren = Object.values(s.getState().project.core.tasks).filter(
      (t) => t.parentId === byName('A').id,
    );
    s.getState().addDependency(aChildren[0]!.id, aChildren[1]!.id);

    const p = s.getState().project;
    const candidatesFor = buildPrevCandidateIndex(p);
    for (const id of Object.keys(p.core.tasks)) {
      expect(candidatesFor(id).map((t) => t.id)).toEqual(prevCandidates(p, id).map((t) => t.id));
    }
  });

  it('別の親グループの同粒度工程もインデックスの候補に含まれる（widening が前計算側にも効く）', () => {
    const s = createAppStore();
    s.getState().addRootTask('large');
    const l1 = Object.values(s.getState().project.core.tasks)[0]!;
    s.getState().addRootTask('large');
    const l2 = Object.values(s.getState().project.core.tasks).filter((t) => t.level === 'large')[1]!;
    const a1 = s.getState().addChildTask(l1.id)!; // 中工程(親=l1)
    const b1 = s.getState().addChildTask(l2.id)!; // 中工程(親=l2・別グループ)
    const candidatesFor = buildPrevCandidateIndex(s.getState().project);
    expect(candidatesFor(a1).map((t) => t.id)).toContain(b1);
  });

  it('存在しない工程は空配列（prevCandidates と同じ）', () => {
    const s = createAppStore();
    s.getState().addTask('A');
    const p = s.getState().project;
    expect(buildPrevCandidateIndex(p)('missing')).toEqual(prevCandidates(p, 'missing'));
    expect(buildPrevCandidateIndex(p)('missing')).toEqual([]);
  });
});

describe('suggestions: collectIoNames', () => {
  it('全工程の I/O 名を頻度順・重複なしで返す', () => {
    const s = createAppStore();
    s.getState().addTask('A');
    s.getState().addTask('B');
    const ids = Object.values(s.getState().project.core.tasks).map((t) => t.id);
    s.getState().addIo(ids[0]!, 'inputs', '受注伝票');
    s.getState().addIo(ids[1]!, 'inputs', '受注伝票');
    s.getState().addIo(ids[1]!, 'outputs', '納品書');
    expect(collectIoNames(s.getState().project)).toEqual(['受注伝票', '納品書']);
  });
});
