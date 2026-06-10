import { describe, it, expect } from 'vitest';
import { createAppStore } from '../src/store';
import { prevCandidates, collectIoNames } from '../src/suggestions';

describe('suggestions: prevCandidates', () => {
  it('同じ親・同じ粒度の兄弟だけが候補になり、既存の前後関係(両向き)は除外される', () => {
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

  it('親が違う工程は候補に出ない', () => {
    const s = createAppStore();
    s.getState().addRootTask('large');
    const l1 = Object.values(s.getState().project.core.tasks)[0]!;
    s.getState().addChildTask(l1.id);
    s.getState().addChildTask(l1.id);
    s.getState().addRootTask('medium'); // ルート直下の中工程(親が違う)
    const children = Object.values(s.getState().project.core.tasks).filter((t) => t.parentId === l1.id);
    expect(children).toHaveLength(2);
    const cands = prevCandidates(s.getState().project, children[0]!.id);
    expect(cands.map((t) => t.id)).toEqual([children[1]!.id]); // 兄弟のみ
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
