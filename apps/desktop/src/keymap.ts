// キーバインドの単一の真実。既定キーマップ・照合・g リーダー・ユーザー上書き(resolveKeymap)を
// 純粋関数で提供する(React 非依存・ユニットテスト可能)。ディスパッチは ui/useGlobalHotkeys.ts。
//
// 設計:
//  - 1 バインディング = 1 エントリ(id で識別)。同じ action に複数のキーを割り当てられる
//    (例: j と ↓)。ユーザー上書きは「binding id → Chord | null(無効化)」で保存する。
//  - context: 'global' は常に有効。'table' / 'flow' はアクティブペインに応じて有効。
//  - leader: true のエントリは「g を押した後の 2 打目」(1 秒以内)。
//  - fixed: true は慣習として固定のキー(Delete/Esc 等)。ヘルプには出すが上書き対象にしない。

export type KeyContext = 'global' | 'table' | 'flow';

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
  { id: 'save', action: 'global.save', context: 'global', chord: { key: 's', mod: true }, help: { group: G.global, label: '保存' } },
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
  { id: 'go-table', action: 'pane.table', context: 'global', chord: { key: 't' }, leader: true, help: { group: G.nav, label: '表ペインへ' } },
  { id: 'go-flow', action: 'pane.flow', context: 'global', chord: { key: 'f' }, leader: true, help: { group: G.nav, label: 'フローペインへ' } },
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
  { id: 'row-edit', action: 'table.edit', context: 'table', chord: { key: 'enter' }, fixed: true, help: { group: G.table, label: '名前を編集(Esc で戻る)' } },
  { id: 'row-edit-f2', action: 'table.edit', context: 'table', chord: { key: 'f2' }, fixed: true },
  { id: 'row-clear', action: 'table.clear', context: 'table', chord: { key: 'escape' }, fixed: true, help: { group: G.table, label: '選択を解除' } },
  { id: 'row-add', action: 'table.addSibling', context: 'table', chord: { key: 'n', shift: false }, help: { group: G.table, label: '次に工程を追加して編集' } },
  { id: 'row-add-child', action: 'table.addChild', context: 'table', chord: { key: 'n', shift: true }, help: { group: G.table, label: '子工程を追加して編集' } },
  { id: 'row-move-up', action: 'table.moveUp', context: 'table', chord: { key: 'arrowup', alt: true }, help: { group: G.table, label: '行を上へ移動' } },
  { id: 'row-move-down', action: 'table.moveDown', context: 'table', chord: { key: 'arrowdown', alt: true }, help: { group: G.table, label: '行を下へ移動' } },
  { id: 'row-indent', action: 'table.indent', context: 'table', chord: { key: 'tab', shift: false }, fixed: true, help: { group: G.table, label: '字下げ(子にする)' } },
  { id: 'row-outdent', action: 'table.outdent', context: 'table', chord: { key: 'tab', shift: true }, fixed: true, help: { group: G.table, label: '字上げ(親に出す)' } },
  { id: 'row-duplicate', action: 'table.duplicate', context: 'table', chord: { key: 'd', mod: true }, help: { group: G.table, label: '行を複製' } },
  { id: 'row-delete', action: 'table.delete', context: 'table', chord: { key: 'delete' }, fixed: true, help: { group: G.table, label: '行を削除(確認あり)' } },
  { id: 'row-collapse', action: 'table.collapse', context: 'table', chord: { key: ' ' }, help: { group: G.table, label: '折りたたみ(アウトライン)' } },

  // --- フロー ---
  { id: 'node-left', action: 'flow.left', context: 'flow', chord: { key: 'arrowleft' }, help: { group: G.flow, label: 'ノードを移動(Shift で大きく)' } },
  { id: 'node-left-h', action: 'flow.left', context: 'flow', chord: { key: 'h' } },
  { id: 'node-right', action: 'flow.right', context: 'flow', chord: { key: 'arrowright' } },
  { id: 'node-right-l', action: 'flow.right', context: 'flow', chord: { key: 'l' } },
  { id: 'node-up', action: 'flow.up', context: 'flow', chord: { key: 'arrowup' } },
  { id: 'node-up-k', action: 'flow.up', context: 'flow', chord: { key: 'k' } },
  { id: 'node-down', action: 'flow.down', context: 'flow', chord: { key: 'arrowdown' } },
  { id: 'node-down-j', action: 'flow.down', context: 'flow', chord: { key: 'j' } },
  { id: 'zoom-in', action: 'flow.zoomIn', context: 'flow', chord: { key: '+' }, help: { group: G.flow, label: 'ズームイン' } },
  { id: 'zoom-in-eq', action: 'flow.zoomIn', context: 'flow', chord: { key: '=' } },
  { id: 'zoom-out', action: 'flow.zoomOut', context: 'flow', chord: { key: '-' }, help: { group: G.flow, label: 'ズームアウト' } },
  { id: 'zoom-reset', action: 'flow.zoomReset', context: 'flow', chord: { key: '0' }, help: { group: G.flow, label: 'ズームを 100% に' } },
  { id: 'zoom-fit', action: 'flow.fit', context: 'flow', chord: { key: 'f' }, help: { group: G.flow, label: '全体表示(フィット)' } },
  { id: 'node-rename', action: 'flow.rename', context: 'flow', chord: { key: 'enter' }, fixed: true, help: { group: G.flow, label: '工程名をその場編集' } },
  { id: 'node-rename-f2', action: 'flow.rename', context: 'flow', chord: { key: 'f2' }, fixed: true },
  { id: 'connect-mode', action: 'flow.connect', context: 'flow', chord: { key: 'c' }, help: { group: G.flow, label: '接続モード(Tab で候補 → Enter)' } },
];

// ---- 照合 ----

/** 編集中(テキスト入力中)の要素か。単キー系のバインドはこの間すべて無効。 */
export function isEditableTarget(el: Element | null): boolean {
  return (
    el instanceof HTMLElement &&
    (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable)
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
    (a.shift === undefined ? '*' : String(a.shift)) === (b.shift === undefined ? '*' : String(b.shift));
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

export function isSingleKeyChord(c: Chord): boolean {
  if (c.mod || c.alt) return false;
  if (c.key && c.key.length === 1) return true;
  // 防御: code ベース(KeyJ/Digit1 等)で単キーを割り当てた場合も拾う
  if (!c.key && !!c.code && /^(Key|Digit)/.test(c.code)) return true;
  return false;
}

export function isSingleKeyBinding(b: KeyBinding): boolean {
  return !b.fixed && (!!b.leader || isSingleKeyChord(b.chord));
}

/** シングルキー操作が OFF のとき、該当バインドを取り除いた実効キーマップを返す。 */
export function filterKeymapForSingleKey(keymap: KeyBinding[], enabled: boolean): KeyBinding[] {
  return enabled ? keymap : keymap.filter((b) => !isSingleKeyBinding(b));
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
