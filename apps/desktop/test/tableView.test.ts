import { describe, it, expect } from 'vitest';
import { createAppStore } from '../src/store';
import { prevCandidates } from '../src/suggestions';
import { buildPrevCandidateIndex } from '../src/TableView';
import { useUI, OUTLINE_OPTIONAL_COLUMNS } from '../src/ui/useUI';

describe('TableView: buildPrevCandidateIndex（前工程候補の前計算）', () => {
  it('全工程で prevCandidates と同じ候補(順序含む)を返す', () => {
    const s = createAppStore();
    // ルート直下の兄弟(同じ粒度)
    s.getState().addTask('A');
    s.getState().addTask('B');
    s.getState().addTask('C');
    const byName = (name: string) =>
      Object.values(s.getState().project.core.tasks).find((t) => t.name === name)!;
    // 依存(両向き判定の対象)と粒度違いを混ぜる
    s.getState().addDependency(byName('B').id, byName('A').id);
    s.getState().setTaskLevel(byName('C').id, 'small');
    // 子階層(親が違うグループ)
    s.getState().addChildTask(byName('A').id);
    s.getState().addChildTask(byName('A').id);

    const p = s.getState().project;
    const candidatesFor = buildPrevCandidateIndex(p);
    for (const id of Object.keys(p.core.tasks)) {
      expect(candidatesFor(id).map((t) => t.id)).toEqual(prevCandidates(p, id).map((t) => t.id));
    }
  });

  it('存在しない工程は空配列', () => {
    const s = createAppStore();
    s.getState().addTask('A');
    expect(buildPrevCandidateIndex(s.getState().project)('missing')).toEqual([]);
  });
});

describe('工程表の任意列: 記述子(OUTLINE_OPTIONAL_COLUMNS)と表示トグルの整合', () => {
  it('記述子は従来の列(キー・ラベル・幅・順序)をそのまま保持している', () => {
    expect(OUTLINE_OPTIONAL_COLUMNS.map((c) => [c.key, c.label, c.width])).toEqual([
      ['prev', '前工程', 132],
      ['effort', '工数', 78],
      ['io', 'I/O・課題', 224],
    ]);
  });

  it('columnVisibility は記述子のキーをすべて持ち、既定は全列表示', () => {
    const vis = useUI.getState().columnVisibility;
    expect(Object.keys(vis).sort()).toEqual(OUTLINE_OPTIONAL_COLUMNS.map((c) => c.key).slice().sort());
    for (const c of OUTLINE_OPTIONAL_COLUMNS) expect(vis[c.key]).toBe(true);
  });

  it('toggleColumn は記述子の全キーで切り替えられる', () => {
    for (const c of OUTLINE_OPTIONAL_COLUMNS) {
      const before = useUI.getState().columnVisibility[c.key];
      useUI.getState().toggleColumn(c.key);
      expect(useUI.getState().columnVisibility[c.key]).toBe(!before);
      useUI.getState().toggleColumn(c.key); // 元に戻す
      expect(useUI.getState().columnVisibility[c.key]).toBe(before);
    }
  });
});
