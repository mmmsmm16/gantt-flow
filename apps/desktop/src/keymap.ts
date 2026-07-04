// キーバインドの単一の真実。既定キーマップ・照合・g リーダー・ユーザー上書き(resolveKeymap)を
// 純粋関数で提供する(React 非依存・ユニットテスト可能)。ディスパッチは ui/useGlobalHotkeys.ts。
//
// 設計:
//  - 1 バインディング = 1 エントリ(id で識別)。同じ action に複数のキーを割り当てられる
//    (例: j と ↓)。ユーザー上書きは「binding id → Chord | null(無効化)」で保存する。
//  - context: 'global' は常に有効。'table' / 'flow' はアクティブペインに応じて有効。
//    'connect' は接続モード中だけ(useGlobalHotkeys の pushKeyContext)最優先で有効。
//  - Esc の優先順位(契約): レイヤを閉じる(closeTopLayer) → モーダルコンテキストのバインド
//    ('connect' の connect.cancel 等) → 入力系のフォーカスは blur のみ → 非編集要素の
//    フォーカスは blur しつつ同じ押下で row-clear / node-clear へ(キャンセル・選択解除に
//    2 回押しを要求しない)。実装は useGlobalHotkeys の planEscFocus。
//  - leader: true のエントリは「g を押した後の 2 打目」(1 秒以内)。
//  - fixed: true は慣習として固定のキー(Delete/Esc 等)。ヘルプには出すが上書き対象にしない。

export type KeyContext = 'global' | 'table' | 'flow' | 'connect';

export interface Chord {
  /** e.key の小文字('arrowdown' / 'f6' / '?' など)。code 指定時は省略可。 */
  key?: string;
  /** 物理キーで判定したい場合の e.code('Digit1' など)。 */
  code?: string;
  /** Ctrl または ⌘(どちらでも一致)。既定 false。 */
  mod?: boolean;
  /** Shift。undefined なら不問('?' や '+' など Shift が打鍵に含まれるキー向け)。 */
  shift?: boolean;
  /** Alt/Option。既定 false。 */
  alt?: boolean;
}

export interface KeyBinding {
  id: string;
  action: string;
  context: KeyContext;
  chord: Chord;
  /** g リーダーの 2 打目か。 */
  leader?: boolean;
  /** 慣習キー(Delete/Esc/Enter 等)。ヘルプに出すがカスタマイズ対象にしない。 */
  fixed?: boolean;
  /** シングルキー操作(既定OFF)の対象でも、低リスク(誤爆しても即 undo できる/実害が小さい)
      なため設定に関わらず既定で有効にする(UX#12)。fixed とは違いユーザーは変更/無効化できる
      (無効化すれば当然 OFF になる。resolveKeymap の上書き適用がフィルタより先に効くため)。 */
  lowRisk?: boolean;
  /** ヘルプ一覧に出す場合のグループとラベル(無指定は補助キー=一覧に出さない)。 */
  help?: { group: string; label: string };
}

// ---- 既定キーマップ ----
// グループ名は HelpDialog の見出しと一致させる。
const G = {
  global: '全体',
  nav: '画面移動(g リーダー)',
  table: '工程表(行選択モード)',
  flow: '工程フロー',
  color: '工程カラー(選択中の工程)',
} as const;

export const DEFAULT_KEYMAP: KeyBinding[] = [
  // --- グローバル ---
  { id: 'palette', action: 'global.palette', context: 'global', chord: { key: 'k', mod: true }, help: { group: G.global, label: 'コマンドパレット / 検索' } },
  { id: 'palette-slash', action: 'global.palette', context: 'global', chord: { key: '/' } , help: { group: G.global, label: 'コマンドパレットを開く' } },
  { id: 'save', action: 'global.save', context: 'global', chord: { key: 's', mod: true, shift: false }, help: { group: G.global, label: '保存' } },
  // ファイル操作(OS 標準に倣う)。Ctrl+N/Ctrl+O はブラウザ既定(新規ウィンドウ/ファイルを開く)と
  // 衝突するため、発火時に preventDefault で奪う(dispatch が true を返すと useGlobalHotkeys が実行)。
  // Tauri では既定動作が無いので問題ない。編集中(入力欄フォーカス)は useGlobalHotkeys の editable
  // ガードで通さない(誤って新規作成が走らないよう、ネイティブに委ねる)。
  { id: 'file-new', action: 'global.new', context: 'global', chord: { key: 'n', mod: true, shift: false }, help: { group: G.global, label: '新規プロジェクト' } },
  { id: 'file-open', action: 'global.open', context: 'global', chord: { key: 'o', mod: true }, help: { group: G.global, label: '保存ファイルを開く' } },
  // Ctrl+Shift+S=別名保存。save(Ctrl+S)は上で shift:false に固定したので影に隠れない。
  { id: 'save-as', action: 'global.saveAs', context: 'global', chord: { key: 's', mod: true, shift: true }, help: { group: G.global, label: '名前を付けて保存' } },
  { id: 'undo', action: 'global.undo', context: 'global', chord: { key: 'z', mod: true, shift: false }, help: { group: G.global, label: '元に戻す' } },
  { id: 'undo-u', action: 'global.undo', context: 'global', chord: { key: 'u' } },
  { id: 'redo', action: 'global.redo', context: 'global', chord: { key: 'y', mod: true }, help: { group: G.global, label: 'やり直し' } },
  { id: 'redo-shift-z', action: 'global.redo', context: 'global', chord: { key: 'z', mod: true, shift: true } },
  { id: 'help', action: 'global.help', context: 'global', chord: { key: '?' }, fixed: true, help: { group: G.global, label: 'ショートカット一覧' } },
  { id: 'print', action: 'global.print', context: 'global', chord: { key: 'p', mod: true }, help: { group: G.global, label: '印刷 / PDF' } },
  { id: 'table-mode', action: 'global.tableMode', context: 'global', chord: { key: 'v' }, help: { group: G.global, label: '表モード切替(アウトライン⇄全項目)' } },
  { id: 'pane-table', action: 'pane.table', context: 'global', chord: { key: '1', mod: true }, help: { group: G.global, label: '表ペインへ' } },
  { id: 'pane-flow', action: 'pane.flow', context: 'global', chord: { key: '2', mod: true }, help: { group: G.global, label: 'フローペインへ' } },
  { id: 'pane-toggle', action: 'pane.toggle', context: 'global', chord: { key: 'f6' }, help: { group: G.global, label: 'ペインを切り替え' } },
  { id: 'settings', action: 'global.settings', context: 'global', chord: { key: ',', mod: true }, help: { group: G.global, label: '設定を開く' } },
  // パレットで最後に実行した repeatable なコマンドを、いま選択中の工程へ再適用(Vim の . 相当)。
  { id: 'repeat-last', action: 'global.repeatLast', context: 'global', chord: { key: '.', mod: true }, help: { group: G.global, label: '直前のコマンドを再実行(パレット)' } },
  // 作業エリアを最大化する集中モード(上部ツールバー＋各ビューの操作バーを隠す/戻す)。
  { id: 'toggle-chrome', action: 'global.toggleChrome', context: 'global', chord: { key: '\\', mod: true }, help: { group: G.global, label: '集中モード(ツールバー・操作バーを隠す)' } },

  // --- 工程カラーのクイック変更(よく使う 既定/青/赤 のみ。他の色はパレットから) ---
  // Mac の Option+数字は記号入力になるため e.code(Digit*)で物理キー判定する。
  // 修飾(Alt)付き=シングルキーOFFでも常に使える。
  { id: 'fill-none', action: 'color.fillNone', context: 'global', chord: { code: 'Digit1', alt: true, shift: false }, help: { group: G.color, label: '塗り色: なし(既定)' } },
  { id: 'fill-blue', action: 'color.fillBlue', context: 'global', chord: { code: 'Digit2', alt: true, shift: false }, help: { group: G.color, label: '塗り色: 青' } },
  { id: 'fill-red', action: 'color.fillRed', context: 'global', chord: { code: 'Digit3', alt: true, shift: false }, help: { group: G.color, label: '塗り色: 赤' } },
  { id: 'text-none', action: 'color.textNone', context: 'global', chord: { code: 'Digit1', alt: true, shift: true }, help: { group: G.color, label: '文字色: なし(既定)' } },
  { id: 'text-blue', action: 'color.textBlue', context: 'global', chord: { code: 'Digit2', alt: true, shift: true }, help: { group: G.color, label: '文字色: 青' } },
  { id: 'text-red', action: 'color.textRed', context: 'global', chord: { code: 'Digit3', alt: true, shift: true }, help: { group: G.color, label: '文字色: 赤' } },

  // --- g リーダー(画面移動) ---
  // 小文字 g t / g f = 分割のままそのペインをアクティブ化（フォーカス移動）。
  // Shift 版 g T / g F = そのペインを全画面トグル。shift は明示（未指定だと Shift 版と二重一致する）。
  // g リーダーの画面移動は編集を伴わないビュー切替＝低リスク。既定で有効(UX#12。表示先を変える
  // だけで元に戻すのも一手)。少なくとも t/f/d(表/フロー/分割)を常時使えるようにする。
  { id: 'go-table', action: 'pane.table', context: 'global', chord: { key: 't', shift: false }, leader: true, lowRisk: true, help: { group: G.nav, label: '工程表ペインをアクティブ（分割）' } },
  { id: 'go-flow', action: 'pane.flow', context: 'global', chord: { key: 'f', shift: false }, leader: true, lowRisk: true, help: { group: G.nav, label: 'フローペインをアクティブ（分割）' } },
  { id: 'go-table-full', action: 'layout.tableToggle', context: 'global', chord: { key: 't', shift: true }, leader: true, help: { group: G.nav, label: '工程表を全画面 / 分割に戻す' } },
  { id: 'go-flow-full', action: 'layout.flowToggle', context: 'global', chord: { key: 'f', shift: true }, leader: true, help: { group: G.nav, label: 'フローを全画面 / 分割に戻す' } },
  { id: 'go-split', action: 'layout.split', context: 'global', chord: { key: 'd' }, leader: true, lowRisk: true, help: { group: G.nav, label: '分割表示（工程表＋フロー）' } },
  { id: 'go-issues', action: 'view.issues', context: 'global', chord: { key: 'i' }, leader: true, help: { group: G.nav, label: '課題一覧を開く' } },
  { id: 'go-summary', action: 'view.summary', context: 'global', chord: { key: 's' }, leader: true, help: { group: G.nav, label: 'サマリを開く' } },
  { id: 'go-level-1', action: 'level.large', context: 'global', chord: { key: '1' }, leader: true, help: { group: G.nav, label: '粒度: 大' } },
  { id: 'go-level-2', action: 'level.medium', context: 'global', chord: { key: '2' }, leader: true, help: { group: G.nav, label: '粒度: 中' } },
  { id: 'go-level-3', action: 'level.small', context: 'global', chord: { key: '3' }, leader: true, help: { group: G.nav, label: '粒度: 小' } },
  { id: 'go-level-4', action: 'level.detail', context: 'global', chord: { key: '4' }, leader: true, help: { group: G.nav, label: '粒度: 詳細' } },

  // --- 表(行選択モード) ---
  { id: 'row-next', action: 'table.next', context: 'table', chord: { key: 'j' }, help: { group: G.table, label: '下の行を選択' } },
  { id: 'row-next-arrow', action: 'table.next', context: 'table', chord: { key: 'arrowdown' } },
  { id: 'row-prev', action: 'table.prev', context: 'table', chord: { key: 'k' }, help: { group: G.table, label: '上の行を選択' } },
  { id: 'row-prev-arrow', action: 'table.prev', context: 'table', chord: { key: 'arrowup' } },
  { id: 'row-first', action: 'table.first', context: 'table', chord: { key: 'g' }, leader: true, help: { group: G.table, label: '先頭の行へ(g g)' } },
  { id: 'row-last', action: 'table.last', context: 'table', chord: { key: 'g', shift: true }, help: { group: G.table, label: '末尾の行へ(G)' } },
  { id: 'col-left', action: 'table.left', context: 'table', chord: { key: 'arrowleft' }, help: { group: G.table, label: '左右のセルへ移動' } },
  { id: 'col-left-h', action: 'table.left', context: 'table', chord: { key: 'h' } },
  { id: 'col-right', action: 'table.right', context: 'table', chord: { key: 'arrowright' } },
  { id: 'col-right-l', action: 'table.right', context: 'table', chord: { key: 'l' } },
  { id: 'row-edit', action: 'table.edit', context: 'table', chord: { key: 'enter' }, fixed: true, help: { group: G.table, label: '選択セルを編集(Esc で選択モードへ)' } },
  { id: 'row-edit-f2', action: 'table.edit', context: 'table', chord: { key: 'f2' }, fixed: true },
  { id: 'row-clear', action: 'table.clear', context: 'table', chord: { key: 'escape' }, fixed: true, help: { group: G.table, label: '選択を解除' } },
  // n=次工程追加は誤操作しても即 undo できる低リスクな操作なので、シングルキー設定に
  // 関わらず既定で有効にする(UX#12。他の単キー行操作は引き続き設定でON)。
  { id: 'row-add', action: 'table.addSibling', context: 'table', chord: { key: 'n', shift: false }, lowRisk: true, help: { group: G.table, label: '次に工程を追加して編集' } },
  // 子工程追加も兄弟追加(row-add)と同じく誤操作しても即 undo でき、実害が小さいので既定で有効(UX#12)。
  { id: 'row-add-child', action: 'table.addChild', context: 'table', chord: { key: 'n', shift: true }, lowRisk: true, help: { group: G.table, label: '子工程を追加して編集' } },
  { id: 'row-move-up', action: 'table.moveUp', context: 'table', chord: { key: 'arrowup', alt: true }, help: { group: G.table, label: '行を上へ移動' } },
  { id: 'row-move-down', action: 'table.moveDown', context: 'table', chord: { key: 'arrowdown', alt: true }, help: { group: G.table, label: '行を下へ移動' } },
  { id: 'row-indent', action: 'table.indent', context: 'table', chord: { key: 'tab', shift: false }, fixed: true, help: { group: G.table, label: '字下げ(子にする)' } },
  { id: 'row-outdent', action: 'table.outdent', context: 'table', chord: { key: 'tab', shift: true }, fixed: true, help: { group: G.table, label: '字上げ(親に出す)' } },
  { id: 'row-duplicate', action: 'table.duplicate', context: 'table', chord: { key: 'd', mod: true }, help: { group: G.table, label: '行を複製' } },
  { id: 'row-delete', action: 'table.delete', context: 'table', chord: { key: 'delete' }, fixed: true, help: { group: G.table, label: '行を削除(確認あり)' } },
  // 折りたたみはビュー操作のみ(データを変えない)＝低リスク。既定で有効(UX#12)。
  { id: 'row-collapse', action: 'table.collapse', context: 'table', chord: { key: ' ' }, lowRisk: true, help: { group: G.table, label: '折りたたみ(アウトライン)' } },
  // アウトラインのクイックフィルタ。ブラウザ既定の検索と重なるため preventDefault 前提で奪う
  // (「/」は global.palette 済みなので使わない)。
  { id: 'table-find', action: 'table.find', context: 'table', chord: { key: 'f', mod: true }, help: { group: G.table, label: 'クイックフィルタ(作業名・担当)' } },

  // --- フロー ---
  // 矢印=選択を隣のノードへ移す(表の ↑↓ と同じ操作体系)。未選択なら左上のノードを選択。
  { id: 'node-left', action: 'flow.left', context: 'flow', chord: { key: 'arrowleft' }, help: { group: G.flow, label: '選択を隣のノードへ移す' } },
  { id: 'node-left-h', action: 'flow.left', context: 'flow', chord: { key: 'h' } },
  { id: 'node-right', action: 'flow.right', context: 'flow', chord: { key: 'arrowright' } },
  { id: 'node-right-l', action: 'flow.right', context: 'flow', chord: { key: 'l' } },
  { id: 'node-up', action: 'flow.up', context: 'flow', chord: { key: 'arrowup' } },
  { id: 'node-up-k', action: 'flow.up', context: 'flow', chord: { key: 'k' } },
  { id: 'node-down', action: 'flow.down', context: 'flow', chord: { key: 'arrowdown' } },
  { id: 'node-down-j', action: 'flow.down', context: 'flow', chord: { key: 'j' } },
  // Alt+矢印 / Alt+H/J/K/L=選択ノードの位置を移動(表の Alt+↑↓=行移動 と同じ体系)。
  // shift: false を明示する(Alt+Shift は下の「整列ジャンプ」。不問にすると配列順で
  // こちらが先に一致し、整列ジャンプが永遠に発火しない)。
  // Mac の Option+英字は記号入力になるため、文字キーは e.code(KeyH 等)で物理判定する。
  { id: 'node-move-left', action: 'flow.moveLeft', context: 'flow', chord: { key: 'arrowleft', alt: true, shift: false }, help: { group: G.flow, label: 'ノードを移動(Alt+矢印 / Alt+H/J/K/L)' } },
  { id: 'node-move-left-h', action: 'flow.moveLeft', context: 'flow', chord: { code: 'KeyH', alt: true, shift: false } },
  { id: 'node-move-right', action: 'flow.moveRight', context: 'flow', chord: { key: 'arrowright', alt: true, shift: false } },
  { id: 'node-move-right-l', action: 'flow.moveRight', context: 'flow', chord: { code: 'KeyL', alt: true, shift: false } },
  { id: 'node-move-up', action: 'flow.moveUp', context: 'flow', chord: { key: 'arrowup', alt: true, shift: false } },
  { id: 'node-move-up-k', action: 'flow.moveUp', context: 'flow', chord: { code: 'KeyK', alt: true, shift: false } },
  { id: 'node-move-down', action: 'flow.moveDown', context: 'flow', chord: { key: 'arrowdown', alt: true, shift: false } },
  { id: 'node-move-down-j', action: 'flow.moveDown', context: 'flow', chord: { code: 'KeyJ', alt: true, shift: false } },
  // Alt+Shift+方向=整列ジャンプ(その方向の隣のノードの列(x)/行(中央 y)へぴったり揃えて移動)。
  { id: 'node-align-left', action: 'flow.alignLeft', context: 'flow', chord: { key: 'arrowleft', alt: true, shift: true }, help: { group: G.flow, label: '隣のノードに揃えて移動(Alt+Shift+方向)' } },
  { id: 'node-align-left-h', action: 'flow.alignLeft', context: 'flow', chord: { code: 'KeyH', alt: true, shift: true } },
  { id: 'node-align-right', action: 'flow.alignRight', context: 'flow', chord: { key: 'arrowright', alt: true, shift: true } },
  { id: 'node-align-right-l', action: 'flow.alignRight', context: 'flow', chord: { code: 'KeyL', alt: true, shift: true } },
  { id: 'node-align-up', action: 'flow.alignUp', context: 'flow', chord: { key: 'arrowup', alt: true, shift: true } },
  { id: 'node-align-up-k', action: 'flow.alignUp', context: 'flow', chord: { code: 'KeyK', alt: true, shift: true } },
  { id: 'node-align-down', action: 'flow.alignDown', context: 'flow', chord: { key: 'arrowdown', alt: true, shift: true } },
  { id: 'node-align-down-j', action: 'flow.alignDown', context: 'flow', chord: { code: 'KeyJ', alt: true, shift: true } },
  // ズームはデータを変えないビュー操作＝低リスク。既定で有効(UX#12。0/f でいつでも戻せる)。
  { id: 'zoom-in', action: 'flow.zoomIn', context: 'flow', chord: { key: '+' }, lowRisk: true, help: { group: G.flow, label: 'ズームイン' } },
  { id: 'zoom-in-eq', action: 'flow.zoomIn', context: 'flow', chord: { key: '=' }, lowRisk: true },
  { id: 'zoom-out', action: 'flow.zoomOut', context: 'flow', chord: { key: '-' }, lowRisk: true, help: { group: G.flow, label: 'ズームアウト' } },
  { id: 'zoom-reset', action: 'flow.zoomReset', context: 'flow', chord: { key: '0' }, lowRisk: true, help: { group: G.flow, label: 'ズームを 100% に' } },
  { id: 'zoom-fit', action: 'flow.fit', context: 'flow', chord: { key: 'f' }, lowRisk: true, help: { group: G.flow, label: '全体表示(フィット)' } },
  { id: 'node-rename', action: 'flow.rename', context: 'flow', chord: { key: 'enter' }, fixed: true, help: { group: G.flow, label: '工程名をその場編集' } },
  { id: 'node-rename-f2', action: 'flow.rename', context: 'flow', chord: { key: 'f2' }, fixed: true },
  // 接続モードは Esc 一発で取消でき(接続を確定するまで何も変えない)＝低リスク。既定で有効(UX#12)。
  { id: 'connect-mode', action: 'flow.connect', context: 'flow', chord: { key: 'c' }, lowRisk: true, help: { group: G.flow, label: '接続モード(矢印で候補 → Enter)' } },
  // 次工程の追加(表の n / Shift+N=行追加と同じ体系)。n=右隣へ作成して依存を接続し名前編集まで、
  // Shift+N=接続なしで追加。未選択時はビューポート中央へ(接続なし)。
  { id: 'node-add-next', action: 'flow.addNext', context: 'flow', chord: { key: 'n', shift: false }, help: { group: G.flow, label: '次工程を追加して接続(名前を編集)' } },
  { id: 'node-add-next-plain', action: 'flow.addNextNoConnect', context: 'flow', chord: { key: 'n', shift: true }, help: { group: G.flow, label: '工程を追加(接続なし)' } },
  // I/O の追加(選択中の工程)。i/o は単キー、Alt+I/O は常時有効の代替(Mac の Option 記号対策で code 判定)。
  { id: 'add-input', action: 'flow.addInput', context: 'flow', chord: { key: 'i' }, help: { group: G.flow, label: '入力を追加(選択工程)' } },
  { id: 'add-input-alt', action: 'flow.addInput', context: 'flow', chord: { code: 'KeyI', alt: true } },
  { id: 'add-output', action: 'flow.addOutput', context: 'flow', chord: { key: 'o' }, help: { group: G.flow, label: '出力を追加(選択工程)' } },
  { id: 'add-output-alt', action: 'flow.addOutput', context: 'flow', chord: { code: 'KeyO', alt: true } },
  // 並行工程: p=並行工程を追加(前工程を写して直下へ)、Shift+P=基準を選んで並行化(ピッカー)。
  // Alt 版は常時有効の代替(i/o と同じ規約。Mac の Option 記号対策で code 判定)。
  { id: 'add-parallel', action: 'flow.addParallel', context: 'flow', chord: { key: 'p', shift: false }, help: { group: G.flow, label: '並行工程を追加(選択工程の直下)' } },
  { id: 'add-parallel-alt', action: 'flow.addParallel', context: 'flow', chord: { code: 'KeyP', alt: true, shift: false } },
  { id: 'make-parallel', action: 'flow.makeParallel', context: 'flow', chord: { key: 'p', shift: true }, help: { group: G.flow, label: '基準を選んで並行にする(Shift+P)' } },
  { id: 'make-parallel-alt', action: 'flow.makeParallel', context: 'flow', chord: { code: 'KeyP', alt: true, shift: true } },
  // Delete/Backspace=選択要素の削除、Esc=選択解除(表の row-delete / row-clear と同じ体系)。
  { id: 'node-delete', action: 'flow.delete', context: 'flow', chord: { key: 'delete' }, fixed: true, help: { group: G.flow, label: '選択中の要素を削除' } },
  { id: 'node-delete-bs', action: 'flow.delete', context: 'flow', chord: { key: 'backspace' }, fixed: true },
  { id: 'node-clear', action: 'flow.clear', context: 'flow', chord: { key: 'escape' }, fixed: true, help: { group: G.flow, label: '選択を解除' } },

  // --- 接続モード(c の 2 打目以降。FlowCanvas が pushKeyContext('connect') した間だけ有効) ---
  // 慣習キーのみで構成(fixed)なので、シングルキーOFFやカスタマイズの影響を受けない。
  { id: 'connect-next', action: 'connect.next', context: 'connect', chord: { key: 'tab', shift: false }, fixed: true },
  { id: 'connect-prev', action: 'connect.prev', context: 'connect', chord: { key: 'tab', shift: true }, fixed: true },
  { id: 'connect-left', action: 'connect.left', context: 'connect', chord: { key: 'arrowleft' }, fixed: true },
  { id: 'connect-left-h', action: 'connect.left', context: 'connect', chord: { key: 'h' }, fixed: true },
  { id: 'connect-right', action: 'connect.right', context: 'connect', chord: { key: 'arrowright' }, fixed: true },
  { id: 'connect-right-l', action: 'connect.right', context: 'connect', chord: { key: 'l' }, fixed: true },
  { id: 'connect-up', action: 'connect.up', context: 'connect', chord: { key: 'arrowup' }, fixed: true },
  { id: 'connect-up-k', action: 'connect.up', context: 'connect', chord: { key: 'k' }, fixed: true },
  { id: 'connect-down', action: 'connect.down', context: 'connect', chord: { key: 'arrowdown' }, fixed: true },
  { id: 'connect-down-j', action: 'connect.down', context: 'connect', chord: { key: 'j' }, fixed: true },
  { id: 'connect-commit', action: 'connect.commit', context: 'connect', chord: { key: 'enter' }, fixed: true },
  { id: 'connect-cancel', action: 'connect.cancel', context: 'connect', chord: { key: 'escape' }, fixed: true },
  { id: 'connect-cancel-c', action: 'connect.cancel', context: 'connect', chord: { key: 'c' }, fixed: true },
];

// ---- 照合 ----

/** IME 変換中のキー入力か(Enter で誤確定・Esc で誤キャンセルしないためのガード)。
    ネイティブ KeyboardEvent と React 合成イベント(isComposing は nativeEvent 側)の両方を受ける。 */
export function isImeKeyEvent(e: {
  isComposing?: boolean;
  keyCode?: number;
  nativeEvent?: { isComposing?: boolean; keyCode?: number };
}): boolean {
  return (
    e.isComposing === true ||
    e.keyCode === 229 ||
    e.nativeEvent?.isComposing === true ||
    e.nativeEvent?.keyCode === 229
  );
}

/** 編集中(テキスト入力中)の要素か。単キー系のバインドはこの間すべて無効。 */
export function isEditableTarget(el: Element | null): boolean {
  return (
    el instanceof HTMLElement &&
    (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable)
  );
}

/** フォーカス中の要素が「操作系」か(tagName / role / contentEditable から純粋に判定)。
    固定キー(Enter/Delete 等)を、無関係なボタン・リンク・入力・メニュー項目・タブに
    フォーカスがある間にペインのアクションへ横取りさせないためのガードに使う。
    ※ role="button" の要素(フローのノード div 等)は該当させない=そこでの Enter/Delete は
      従来どおりペイン側の操作へ通す(横取り防止の対象はネイティブの操作系のみ)。 */
export function isInteractiveRole(
  tagName: string | null | undefined,
  role: string | null | undefined,
  contentEditable: boolean,
): boolean {
  const tag = (tagName ?? '').toUpperCase();
  if (tag === 'BUTTON' || tag === 'A' || tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') {
    return true;
  }
  if (contentEditable) return true;
  return role === 'menuitem' || role === 'tab';
}

/** document.activeElement 等から isInteractiveRole を判定する DOM ラッパー(React 非依存)。 */
export function isInteractiveTarget(el: Element | null): boolean {
  if (!el) return false;
  return isInteractiveRole(
    el.tagName,
    el.getAttribute('role'),
    (el as HTMLElement).isContentEditable === true,
  );
}

/** KeyboardEvent 互換の最小型(テストでプレーンオブジェクトを渡せるように)。 */
export interface KeyLike {
  key: string;
  code?: string;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}

/** キーキャプチャ(ショートカット編集)の打鍵を Chord にする。shift は必ず明示する
    (undefined=不問にすると Shift 有無で区別している既存バインドまで実行時に一致してしまう)。 */
export function chordFromEvent(e: KeyLike): Chord {
  return {
    key: e.key.toLowerCase(),
    ...(e.ctrlKey || e.metaKey ? { mod: true } : {}),
    ...(e.altKey ? { alt: true } : {}),
    shift: e.shiftKey,
  };
}

export function eventMatches(e: KeyLike, c: Chord): boolean {
  if (c.code) {
    if (e.code !== c.code) return false;
  } else if (c.key) {
    if (e.key.toLowerCase() !== c.key) return false;
  } else {
    return false;
  }
  if ((e.ctrlKey || e.metaKey) !== (c.mod ?? false)) return false;
  if (e.altKey !== (c.alt ?? false)) return false;
  if (c.shift !== undefined && e.shiftKey !== c.shift) return false;
  return true;
}

/**
 * 有効なコンテキスト列(優先順)からバインディングを探す。
 * leaderActive のときはリーダー 2 打目のみ、そうでなければ通常打鍵のみが対象。
 */
export function findBinding(
  e: KeyLike,
  keymap: KeyBinding[],
  contexts: KeyContext[],
  leaderActive: boolean,
): KeyBinding | undefined {
  for (const ctx of contexts) {
    const hit = keymap.find(
      (b) => b.context === ctx && !!b.leader === leaderActive && eventMatches(e, b.chord),
    );
    if (hit) return hit;
  }
  return undefined;
}

// ---- g リーダー(1 秒タイムアウト) ----

export function createLeaderTracker(timeoutMs = 1000, now: () => number = () => Date.now()) {
  let armedAt: number | null = null;
  return {
    /** g を押した(待機開始)。 */
    arm(): void {
      armedAt = now();
    },
    /** 待機中か(タイムアウトを考慮)。 */
    isPending(): boolean {
      if (armedAt === null) return false;
      if (now() - armedAt > timeoutMs) {
        armedAt = null;
        return false;
      }
      return true;
    },
    /** 2 打目で消費。待機中だったら true。 */
    consume(): boolean {
      const pending = this.isPending();
      armedAt = null;
      return pending;
    },
    cancel(): void {
      armedAt = null;
    },
  };
}

// ---- ユーザー上書き(カスタマイズ) ----

/** binding id → 上書き Chord(null = 無効化)。localStorage に保存する形。 */
export type KeymapOverrides = Record<string, Chord | null>;

/** 既定キーマップに上書きを適用した「実効キーマップ」を返す。fixed は上書き不可。 */
export function resolveKeymap(defaults: KeyBinding[], overrides: KeymapOverrides): KeyBinding[] {
  const out: KeyBinding[] = [];
  for (const b of defaults) {
    if (b.fixed) {
      out.push(b);
      continue;
    }
    const ov = overrides[b.id];
    if (ov === null) continue; // 無効化
    out.push(ov ? { ...b, chord: ov } : b);
  }
  return out;
}

/** 同一コンテキスト(+リーダー有無)で同じキーを持つ別バインディングを返す(重複検出)。 */
export function findConflict(
  keymap: KeyBinding[],
  target: KeyBinding,
  chord: Chord,
): KeyBinding | undefined {
  const sameKey = (a: Chord, b: Chord) =>
    (a.code ?? '') === (b.code ?? '') &&
    (a.key ?? '') === (b.key ?? '') &&
    (a.mod ?? false) === (b.mod ?? false) &&
    (a.alt ?? false) === (b.alt ?? false) &&
    // shift 不問(undefined)は実行時(eventMatches)に Shift あり/なし両方へ一致するため、
    // 衝突判定でもワイルドカードとして両方に当てる(影に隠れるバインドを見逃さない)。
    (a.shift === undefined || b.shift === undefined || a.shift === b.shift);
  return keymap.find(
    (b) =>
      b.id !== target.id &&
      !!b.leader === !!target.leader &&
      (b.context === target.context || b.context === 'global' || target.context === 'global') &&
      sameKey(b.chord, chord),
  );
}

// ---- シングルキー操作(Vim 風)のフィルタ ----
// 修飾なしの単キー(j/k/n/c/f/v/u///+/-/0/Space/gリーダー等)は誤爆しやすく学習コストが高いため、
// 既定では無効。設定で ON にすると使えるようになる。矢印・Ctrl/⌘系・F2/F6・fixed(Enter/Esc/
// Delete/Tab/?)は常時有効。判定はユーザー上書き適用後の chord に対して行う。
// lowRisk: true の単キー(表の n=次工程追加)は例外で、設定に関わらず既定で有効(UX#12)。

export function isSingleKeyChord(c: Chord): boolean {
  // Shift 単独も「修飾あり」として扱う(mod/alt と同列)。Shift+P / Shift+N のような明示的な
  // 修飾つき打鍵は誤爆しにくいので、シングルキーOFFの巻き添えで無効化しない(UX#12)。
  if (c.mod || c.alt || c.shift) return false;
  if (c.key && c.key.length === 1) return true;
  // 防御: code ベース(KeyJ/Digit1 等)で単キーを割り当てた場合も拾う
  if (!c.key && !!c.code && /^(Key|Digit)/.test(c.code)) return true;
  return false;
}

export function isSingleKeyBinding(b: KeyBinding): boolean {
  return !b.fixed && (!!b.leader || isSingleKeyChord(b.chord));
}

/** シングルキー操作が OFF のとき、該当バインドを取り除いた実効キーマップを返す。
    lowRisk なバインドは OFF 中でも残す(UX#12。ユーザー上書きでの無効化は resolveKeymap が
    先に効くので、そちらで無効化されていれば当然ここには来ない)。 */
export function filterKeymapForSingleKey(keymap: KeyBinding[], enabled: boolean): KeyBinding[] {
  return enabled ? keymap : keymap.filter((b) => b.lowRisk || !isSingleKeyBinding(b));
}

const SINGLE_KEY_KEY = 'gf-single-key';

/** シングルキー操作(Vim 風)が有効か。既定は false(OFF)。 */
export function loadSingleKeyEnabled(): boolean {
  try {
    return localStorage.getItem(SINGLE_KEY_KEY) === '1';
  } catch {
    return false;
  }
}

export function saveSingleKeyEnabled(enabled: boolean): void {
  try {
    if (enabled) localStorage.setItem(SINGLE_KEY_KEY, '1');
    else localStorage.removeItem(SINGLE_KEY_KEY);
  } catch {
    /* 永続化失敗は無視 */
  }
  invalidateKeymapCache();
}

// ---- 実効キーマップ(既定 + ユーザー上書き) ----

const OVERRIDES_KEY = 'gf-keybindings-v1';
let cachedKeymap: KeyBinding[] | null = null;

export function loadOverrides(): KeymapOverrides {
  try {
    const raw = localStorage.getItem(OVERRIDES_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as KeymapOverrides;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {}; // 壊れた保存値は無視して既定にフォールバック
  }
}

export function saveOverrides(overrides: KeymapOverrides): void {
  try {
    if (Object.keys(overrides).length === 0) localStorage.removeItem(OVERRIDES_KEY);
    else localStorage.setItem(OVERRIDES_KEY, JSON.stringify(overrides));
  } catch {
    /* 永続化失敗は無視(メモリ上は反映済み) */
  }
  invalidateKeymapCache();
}

/** 設定変更(上書き/シングルキー)時にキャッシュを破棄して次回再計算させる。 */
export function invalidateKeymapCache(): void {
  cachedKeymap = null;
}

/** いま有効なキーマップ(既定 + ユーザー上書き + シングルキーOFFのフィルタ)。
    表示(ヘルプ)と動作の両方がこれを参照する=見えるものと効くものが常に一致。 */
export function getActiveKeymap(): KeyBinding[] {
  if (!cachedKeymap) {
    // 上書き適用 → フィルタの順(カスタムで単キー化したバインドも OFF 時は消える)
    cachedKeymap = filterKeymapForSingleKey(
      resolveKeymap(DEFAULT_KEYMAP, loadOverrides()),
      loadSingleKeyEnabled(),
    );
  }
  return cachedKeymap;
}

// ---- 表示 ----

const KEY_LABEL: Record<string, string> = {
  arrowup: '↑',
  arrowdown: '↓',
  arrowleft: '←',
  arrowright: '→',
  enter: 'Enter',
  escape: 'Esc',
  delete: 'Delete',
  tab: 'Tab',
  f2: 'F2',
  f6: 'F6',
  ' ': 'Space',
};

const isMac =
  typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

/** Chord を表示用の kbd 配列にする(例: {key:'k',mod:true} → ['⌘','K']) */
export function chordKeys(c: Chord, leader?: boolean): string[] {
  const keys: string[] = [];
  if (leader) keys.push('g');
  if (c.mod) keys.push(isMac ? '⌘' : 'Ctrl');
  if (c.alt) keys.push(isMac ? '⌥' : 'Alt');
  if (c.shift) keys.push('Shift');
  const base = c.code ? c.code.replace(/^Digit|^Key/, '') : (c.key ?? '');
  keys.push(KEY_LABEL[base] ?? (base.length === 1 ? base.toUpperCase() : base));
  return keys;
}
