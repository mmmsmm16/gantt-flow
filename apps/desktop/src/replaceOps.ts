// プロジェクトを丸ごと置き換える経路（新規/取り込み/サンプル/テンプレート/最近のファイル）の
// 共通ガード。App.tsx のクロージャに埋めず単体テストできる形にする(#7 の再発防止)。
import { useApp } from './store';
import { useUI } from './ui/useUI';

/**
 * 置換前の確認。未保存(dirty)のときだけ確認し、失うものが無いクリーンな状態では確認なしで
 * true を返す(置換系すべてで同じ基準に揃える＝新規のクリーン時の過剰確認と、取り込みの
 * 無警告置換の両方を解消)。
 */
export async function confirmReplace(title: string): Promise<boolean> {
  if (!useApp.getState().dirty) return true;
  return useUI.getState().confirm({
    title,
    message: '未保存の変更があります。続行すると失われます。よろしいですか？',
    confirmLabel: '続行',
    danger: true,
  });
}

/**
 * 取り込み(CSV/Excel)の入口を一本化するゲート。confirmReplace を必ず openPicker より前に
 * 通し、キャンセル時は openPicker を一切呼ばない(= 何も開かない・何も取り込まれない)。
 * openPicker はファイル選択 UI を開く副作用のみを担う(呼ばれる＝ゲート通過を意味する)。
 * 戻り値: ゲートを通って openPicker を呼んだら true、キャンセルで何もしなければ false。
 */
export async function gatedImport(openPicker: () => void): Promise<boolean> {
  if (!(await confirmReplace('CSV / Excel を取り込む'))) return false;
  openPicker();
  return true;
}
