// 「直前コマンドのリピート」(mod+. / パレット先頭の「もう一度」行)の記録。
// パレットは閉じると unmount されるため、記録は React の外（モジュール変数）に持つ。
// run は useApp.getState() を実行時に読むクロージャ＝選択を移してから再実行すると
// 「いま選択中の工程」へ同じコマンド・同じ引数が適用される（Vim の . 相当）。
// 記録対象の選別（repeatable）はパレット側のコマンド定義が持つ。

export interface LastCommandEntry {
  /** コマンド id（同一性の確認・テスト用）。 */
  id: string;
  /** 表示用（例: 担当を設定 "営業"）。 */
  display: string;
  run: () => void;
}

let last: LastCommandEntry | null = null;

export function recordLastCommand(entry: LastCommandEntry): void {
  last = entry;
}

export function getLastCommand(): LastCommandEntry | null {
  return last;
}

/** 記録があれば再実行して true（mod+. のグローバルアクションから呼ぶ。未記録は no-op）。 */
export function repeatLastCommand(): boolean {
  if (!last) return false;
  last.run();
  return true;
}

/** テスト用: 記録を消す（モジュール変数のためテスト間で漏れる）。 */
export function clearLastCommand(): void {
  last = null;
}

/** 「もう一度: 担当を設定 "営業"」の表示部分を作る。コマンド名の末尾 … を外し、
    引数があれば候補ラベル（色名など value より読める方）を優先して引用付きで添える。 */
export function formatRepeatDisplay(label: string, value?: string, optLabel?: string): string {
  const base = label.replace(/…$/, '');
  const arg = (optLabel ?? value ?? '').trim();
  return arg ? `${base} "${arg}"` : base;
}
