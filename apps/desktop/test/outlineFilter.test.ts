// アウトラインのクイックフィルタ(純粋関数)。一致行と祖先の保持・件数の根拠(matched)・
// 大文字小文字の扱い・担当名一致を固定する。
import { describe, it, expect } from 'vitest';
import { filterOutlineRows } from '../src/outlineFilter';

const row = (id: string, name: string, parentId?: string) => ({ task: { id, name, parentId } });
// 受注(a) > 受付(a1) > システム入力(a11) / Review(a2)、出荷(b) > 梱包(b1) の 2 ツリー。
const rows = [
  row('a', '受注'),
  row('a1', '受付', 'a'),
  row('a11', 'システム入力', 'a1'),
  row('a2', 'Review', 'a'),
  row('b', '出荷'),
  row('b1', '梱包', 'b'),
];
const assignees: Record<string, string> = { a11: '営業部', b1: '物流部' };
const nameOf = (t: { id: string }) => assignees[t.id] ?? '';

describe('filterOutlineRows: クイックフィルタ(表示のみの絞り込み)', () => {
  it('空・空白のみのクエリは絞り込まない(全行・一致なし)', () => {
    expect(filterOutlineRows(rows, '', nameOf).rows).toBe(rows);
    const r = filterOutlineRows(rows, '   ', nameOf);
    expect(r.rows).toHaveLength(rows.length);
    expect(r.matched.size).toBe(0);
  });

  it('作業名の部分一致行とその祖先だけを、表示順のまま残す', () => {
    const r = filterOutlineRows(rows, '入力', nameOf);
    expect(r.rows.map((x) => x.task.id)).toEqual(['a', 'a1', 'a11']);
    // 祖先は matched に含まない(ハイライト・件数は一致行のみ)。
    expect([...r.matched]).toEqual(['a11']);
  });

  it('親が一致しても、一致しない子孫までは表示しない', () => {
    const r = filterOutlineRows(rows, '出荷', nameOf);
    expect(r.rows.map((x) => x.task.id)).toEqual(['b']);
    expect([...r.matched]).toEqual(['b']);
  });

  it('大文字小文字を区別しない', () => {
    const r = filterOutlineRows(rows, 'review', nameOf);
    expect(r.rows.map((x) => x.task.id)).toEqual(['a', 'a2']);
  });

  it('担当名にも部分一致する(祖先は表示されるがハイライトされない)', () => {
    const r = filterOutlineRows(rows, '物流', nameOf);
    expect(r.rows.map((x) => x.task.id)).toEqual(['b', 'b1']);
    expect(r.matched.has('b1')).toBe(true);
    expect(r.matched.has('b')).toBe(false);
  });

  it('一致なしは行ゼロ・一致ゼロ', () => {
    const r = filterOutlineRows(rows, '存在しない語', nameOf);
    expect(r.rows).toEqual([]);
    expect(r.matched.size).toBe(0);
  });
});
