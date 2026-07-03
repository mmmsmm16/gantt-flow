import { describe, it, expect } from 'vitest';
import { FT_COLUMNS } from '../src/FullTable';

// 列定義のシングルソース化（FT_COLUMNS）が、リファクタ前の各レジストリ
// （COL_ORDER / DEFAULT_W / TOGGLE_COLS / SORTABLE / 列カーソル対象）と
// 完全に一致することを固定する回帰テスト。列の追加・並べ替え時はここも更新する。
describe('FullTable の列定義（FT_COLUMNS）', () => {
  it('表示順がリファクタ前の COL_ORDER と一致する', () => {
    expect(FT_COLUMNS.map((c) => c.key)).toEqual([
      'no', 'large', 'medium', 'small', 'detail', 'assignee', 'status', 'prev', 'effort',
      'how', 'system', 'inputs', 'outputs', 'issue', 'measure', 'note', 'volume',
      'exception', 'automation', 'dataLink', 'regulation', 'difficulty', 'act',
    ]);
  });

  it('既定の列幅がリファクタ前の DEFAULT_W と一致する', () => {
    expect(Object.fromEntries(FT_COLUMNS.map((c) => [c.key, c.width]))).toEqual({
      no: 48, large: 110, medium: 110, small: 110, detail: 110, assignee: 110, status: 104, prev: 150,
      effort: 64, how: 200, system: 170, inputs: 168, outputs: 168, issue: 200, measure: 200,
      note: 200, volume: 130, exception: 180, automation: 108, dataLink: 140, regulation: 140,
      difficulty: 62, act: 96,
    });
  });

  it('列メニュー（表示切替）の対象とラベルがリファクタ前の TOGGLE_COLS と一致する', () => {
    expect(FT_COLUMNS.filter((c) => c.optional).map((c) => [c.key, c.label])).toEqual([
      ['large', '大工程'],
      ['medium', '中工程'],
      ['small', '小工程'],
      ['detail', '詳細工程'],
      ['assignee', '担当'],
      ['status', '状況'],
      ['prev', '前工程'],
      ['effort', '工数'],
      ['how', '業務内容'],
      ['system', '使用システム'],
      ['inputs', 'インプット'],
      ['outputs', 'アウトプット'],
      ['issue', '課題'],
      ['measure', '方策'],
      ['note', '備考'],
      ['volume', 'ボリューム'],
      ['exception', '例外対応'],
      ['automation', '自動化'],
      ['dataLink', 'データ連携先'],
      ['regulation', '関連規程'],
      ['difficulty', '難易度'],
    ]);
  });

  it('列カーソル対象（cursorable）がリファクタ前の手書きリストと同順で一致する', () => {
    expect(FT_COLUMNS.filter((c) => c.cursorable).map((c) => c.key)).toEqual([
      'assignee', 'status', 'prev', 'effort', 'how', 'system', 'inputs', 'outputs',
      'issue', 'measure', 'note', 'volume', 'exception', 'automation',
      'dataLink', 'regulation', 'difficulty',
    ]);
  });

  it('並べ替え可能列がリファクタ前の SORTABLE と一致する', () => {
    expect(new Set(FT_COLUMNS.filter((c) => c.sortable).map((c) => c.key))).toEqual(
      new Set(['large', 'medium', 'small', 'detail', 'assignee', 'status', 'effort', 'difficulty', 'automation']),
    );
  });

  it('No. と操作列は常時表示（optional なし）・粒度列は level がキーと一致する', () => {
    const required = FT_COLUMNS.filter((c) => !c.optional).map((c) => c.key);
    expect(required).toEqual(['no', 'act']);
    for (const c of FT_COLUMNS.filter((c) => c.level)) expect(c.level).toBe(c.key);
  });
});
