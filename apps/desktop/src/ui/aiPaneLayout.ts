// AI パネル（batch モード）を開いたときのペインレイアウト自動切替（E-01）。
//
// 仮ノードの主戦場はフローなので、パネルを開いたら一時的に「工程フローのみ」へ寄せ、
// 閉じたら開く直前のレイアウトへ戻す。ただしユーザーが開いている間に手動でレイアウトを
// 変えたら、その操作を尊重して復元しない（＝閉じる時点でまだ flow のままのときだけ戻す）。
//
// setPaneLayout 等の副作用だけを持つ薄い純関数群にして、useUI ストアに依存せずテストできるようにする。

export type PaneMode = 'split' | 'table' | 'flow';

/** レイアウト自動切替が読み書きする最小インターフェイス（useUI の部分集合）。 */
export interface PaneLayoutUI {
  tableWide: boolean;
  flowWide: boolean;
  tableMode: 'outline' | 'full';
  setPaneLayout: (mode: PaneMode) => void;
  setTableMode: (mode: 'outline' | 'full') => void;
}

/** 現在の派生レイアウト（tableWide/flowWide から求める）。 */
export function layoutOf(ui: Pick<PaneLayoutUI, 'tableWide' | 'flowWide'>): PaneMode {
  return ui.flowWide ? 'flow' : ui.tableWide ? 'table' : 'split';
}

/** 開く直前の状態を記憶するスナップショット。 */
export interface PaneSnapshot {
  layout: PaneMode;
  tableMode: 'outline' | 'full';
}

/** パネルを開く: 現在レイアウトを記憶してフローのみへ切替える。 */
export function openAiFlowLayout(ui: PaneLayoutUI): PaneSnapshot {
  const snapshot: PaneSnapshot = { layout: layoutOf(ui), tableMode: ui.tableMode };
  ui.setPaneLayout('flow');
  return snapshot;
}

/** パネルを閉じる: ユーザーが手動変更していなければ（今なお flow なら）元のレイアウトへ戻す。 */
export function restoreAiLayout(ui: PaneLayoutUI, snapshot: PaneSnapshot): void {
  if (layoutOf(ui) !== 'flow') return; // 手動でレイアウト変更された → 復元しない（ユーザー操作優先）
  if (snapshot.layout === 'flow') return; // 元から flow なら何もしない
  ui.setPaneLayout(snapshot.layout);
  // 全項目表(full)は table レイアウトでのみ成立。setPaneLayout('table') は outline へ戻すため復元し直す。
  if (snapshot.layout === 'table' && snapshot.tableMode === 'full') ui.setTableMode('full');
}
