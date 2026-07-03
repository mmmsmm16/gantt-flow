// UX#15: 表の roving focus 判定 shouldRoveRowFocus。選択が変わったとき選択行へ実 DOM
// フォーカスを移してよいかを、DOM 非依存の純粋ロジックとして検証する（node 環境）。
// 呼び出し側（TableView）が activeElement から editable / inTable を測って渡す規約。
import { describe, it, expect } from 'vitest';
import { shouldRoveRowFocus } from '../src/ui/useRowSelectionKeys';

describe('shouldRoveRowFocus: 選択行へのフォーカス移動ガード', () => {
  it('表がアクティブ・非編集・表内フォーカスなら移す（キーボードの行移動）', () => {
    expect(shouldRoveRowFocus({ activePane: 'table', editable: false, inTable: true })).toBe(true);
  });

  it('フローがアクティブなら移さない（フロー→表の選択同期でフォーカスを奪わない）', () => {
    expect(shouldRoveRowFocus({ activePane: 'flow', editable: false, inTable: true })).toBe(false);
  });

  it('編集中（入力にフォーカス）なら移さない（セル編集のフォーカスを奪わない）', () => {
    expect(shouldRoveRowFocus({ activePane: 'table', editable: true, inTable: true })).toBe(false);
  });

  it('表の外（ダイアログ等）にフォーカスがあるなら移さない', () => {
    expect(shouldRoveRowFocus({ activePane: 'table', editable: false, inTable: false })).toBe(false);
  });

  it('編集中は表内でもフロー扱いでも常に false（editable が最優先で守られる）', () => {
    expect(shouldRoveRowFocus({ activePane: 'table', editable: true, inTable: false })).toBe(false);
    expect(shouldRoveRowFocus({ activePane: 'flow', editable: true, inTable: true })).toBe(false);
  });
});
