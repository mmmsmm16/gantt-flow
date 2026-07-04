// 表・インスペクタの入力フィールドで共有する挙動（快適化B1）。
// 作業名入力にだけ実装されていた「Escape=取り消し」「クリックで全選択」を全フィールドへ横展開し、
// 経路ごとの食い違い（P1/P3）を解消する。純粋判定はここに置いてユニットテスト可能にする。
import type { FocusEvent, KeyboardEvent, MouseEvent } from 'react';
import { isImeKeyEvent } from './keymap';

// Escape=取り消しを全ての自由記述フィールドへ統一する共通 onKeyDown。
// 非制御 input/textarea の現在値を defaultValue（＝マウント時＝直近の確定値）へ戻してから blur する。
// onBlur コミットは「値が変わっていなければ書かない」実装なので、これで入力が破棄されコミットされない。
// stopPropagation でグローバルの Esc（入力の blur-only 経路・行/ノードの選択解除）を発火させない
//（グローバル listener は window の bubble 段なので、ここで止めれば横取りされない）。
export function cancelEditOnEscape(
  e: KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>,
): void {
  if (isImeKeyEvent(e)) return; // IME 変換確定の Esc で誤キャンセルしない
  if (e.key !== 'Escape') return;
  e.stopPropagation();
  const el = e.currentTarget;
  el.value = el.defaultValue; // 打った内容を捨てて確定値へ戻す
  el.blur();
}

// クリックでの命名・担当編集を、キーボード経路（focusCell が .select() する F2/Enter）と揃える。
// 未フォーカスからのクリックだけ全選択して「そのまま打てば置換」にし、フォーカス済みの再クリックは
// キャレット設置を尊重する（表計算流: 1 回目＝全選択で上書き / 2 回目以降＝途中挿入）。
// 修飾クリック（Ctrl/⌘/Shift）は複数選択に委ねるため素通しする。
// input/textarea 双方へ spread できるよう要素型は緩めに取る。
export const selectAllOnFocus = {
  onFocus: (e: FocusEvent<HTMLInputElement | HTMLTextAreaElement>) => e.currentTarget.select(),
  onMouseDown: (e: MouseEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    if (e.ctrlKey || e.metaKey || e.shiftKey) return; // 複数選択の修飾クリックを邪魔しない
    const el = e.currentTarget;
    if (document.activeElement !== el) {
      // 既定の mousedown を止めて手動 focus → onFocus の全選択を mouseup のキャレット設置が潰さない。
      e.preventDefault();
      el.focus();
    }
  },
};

// 作業名入力の Escape の扱い（純粋・テスト可能）。
// 直前に作った未コミットの新規行（確定名が空文字＝＋大/＋中/n/ゴースト行の起点）は行ごと削除し、
// 表とフローに空「作業名」ゴーストを残さない。既に名前が付いた既存行は従来どおり取り消し（defaultValue へ戻す）。
export function nameEscapeAction(committedName: string): 'remove' | 'restore' {
  return committedName === '' ? 'remove' : 'restore';
}
