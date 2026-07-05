// キーボードショートカット一覧。? もしくはツールバーのヘルプから開く。
// キーボード操作は keymap.ts(実効キーマップ=既定+ユーザー上書き)から自動生成し、
// 表示と実際の動作が常に一致するようにする。マウス操作と編集中キーは固定の説明を併記。
import { useEffect, useMemo, useRef } from 'react';
import { useUI } from './useUI';
import { useFocusTrap } from './useFocusTrap';
import { DEFAULT_KEYMAP, getActiveKeymap, loadOverrides, resolveKeymap, chordKeys, type KeyBinding } from '../keymap';

const isMac =
  typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
const MOD = isMac ? '⌘' : 'Ctrl';

export interface Shortcut {
  keys: string[];
  label: string;
  /** シングルキー設定が OFF のため今は動かない(行は隠さず薄く表示し、注記を添える。UX#12)。 */
  off?: boolean;
}
export interface Group {
  title: string;
  items: Shortcut[];
}

// keymap に載らない操作(編集中のキー・マウスジェスチャ)は固定で併記する。
const STATIC_GROUPS: Group[] = [
  {
    title: '工程表（セルの編集中）',
    items: [
      { keys: ['Enter'], label: '確定して同じ列の下のセルへ（Shift で上へ）' },
      { keys: ['Tab'], label: '確定して右のセルへ（Shift で左へ）' },
      { keys: ['Esc'], label: '編集をやめて選択モードへ戻る' },
      { keys: ['Alt', '↑ / ↓'], label: '行を上下に移動（作業名のみ）' },
    ],
  },
  {
    title: '全項目表（フル表）',
    items: [
      { keys: [MOD, 'Enter'], label: '現在の行の次に工程を追加' },
      { keys: [MOD, 'D'], label: '現在の行を複製' },
      { keys: [MOD, 'Delete'], label: '現在の行（工程）を削除' },
      { keys: ['ヘッダをドラッグ'], label: '列幅を調整' },
    ],
  },
  {
    title: '工程フロー（マウス）',
    items: [
      { keys: ['ダブルクリック（空白）'], label: '工程を作成' },
      { keys: ['ダブルクリック（工程）'], label: '工程名をその場で編集' },
      { keys: ['ハンドル ○ をドラッグ'], label: '矢印（前後関係）を引く' },
      { keys: ['Shift', 'ドラッグ'], label: '範囲選択（まとめて移動 / 削除）' },
      { keys: [MOD, 'ホイール'], label: '拡大 / 縮小' },
      { keys: ['ダブルクリック（矢印）'], label: '分岐ラベルを編集' },
      { keys: ['右クリック（矢印 / 工程）'], label: '操作メニューを開く（ラベル編集・工程の挿入・削除など）' },
    ],
  },
];

// 実効キーマップから「グループ → ショートカット一覧」を組み立てる(純粋関数。テスト可能)。
// action 単位で 1 行にまとめる(ラベル/グループは DEFAULT_KEYMAP の代表エントリから引く)。
// こうすると代表キー(例: j)がシングルキーOFFや無効化で消えても、残った代替キー(↓)で
// 行が生き残る=「動く操作は必ずヘルプに載る」を保証できる。
// シングルキーOFFで無効な行も消さず、resolvedAll(上書きのみ適用・OFFフィルタ前)から
// キー表記を引いて薄く表示する(UX#12: 存在を隠さない。「設定でONにできます」を添える)。
// ユーザーが上書きでその action を完全に無効化(null)している場合だけ行ごと出さない。
export function buildKeymapGroupsFrom(active: KeyBinding[], resolvedAll: KeyBinding[]): Group[] {
  const groups = new Map<string, Shortcut[]>();
  const seen = new Set<string>();
  for (const def of DEFAULT_KEYMAP) {
    if (!def.help) continue;
    const dedupKey = `${def.action}${def.leader ? ':leader' : ''}`;
    if (seen.has(dedupKey)) continue;
    seen.add(dedupKey);
    const resolvedForAction = resolvedAll.filter((b) => b.action === def.action && !!b.leader === !!def.leader);
    if (resolvedForAction.length === 0) continue; // ユーザーが上書きで全無効化 → 行ごと出さない
    // この action のいま有効なバインド(リーダー有無は別の行として扱う)
    const activesForAction = active.filter((b) => b.action === def.action && !!b.leader === !!def.leader);
    const off = activesForAction.length === 0; // シングルキーOFFで無効(存在は隠さない)
    const basis = off ? resolvedForAction : activesForAction;
    const keysList = basis.map((b) => chordKeys(b.chord, b.leader));
    const keys = keysList[0]!;
    if (keysList.length > 1 && keys.length > 0) {
      // 代替キー(j と ↓ など)は末尾の 1 打に「j / ↓」のように併記する。
      const last = keys[keys.length - 1]!;
      keys[keys.length - 1] = [last, ...keysList.slice(1).map((k) => k.join('+'))].join(' / ');
    }
    const arr = groups.get(def.help.group) ?? [];
    arr.push({ keys, label: def.help.label, off });
    groups.set(def.help.group, arr);
  }
  return [...groups.entries()].map(([title, items]) => ({ title, items }));
}

function buildKeymapGroups(): Group[] {
  const resolvedAll = resolveKeymap(DEFAULT_KEYMAP, loadOverrides());
  return buildKeymapGroupsFrom(getActiveKeymap(), resolvedAll);
}

export function HelpDialog() {
  const open = useUI((s) => s.overlay === 'help');
  const singleKey = useUI((s) => s.singleKey);
  const close = () => useUI.getState().setOverlay(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  useFocusTrap(dialogRef, open);

  // 開くたびに実効キーマップから再生成(カスタマイズ・シングルキー設定の反映)。
  const groups = useMemo(
    () => (open ? [...buildKeymapGroups(), ...STATIC_GROUPS] : []),
    [open, singleKey],
  );

  // Esc は useGlobalHotkeys の「最上位レイヤを閉じる」一元処理が担う(個別リスナー不要)。
  useEffect(() => {
    if (open) closeRef.current?.focus();
  }, [open]);

  if (!open) return null;

  return (
    <div className="modal-backdrop" onMouseDown={close}>
      <div
        className="modal help-modal"
        role="dialog"
        aria-modal="true"
        aria-label="キーボードショートカット"
        ref={dialogRef}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="help-head">
          <h3 className="modal-title">キーボードショートカット</h3>
          <button ref={closeRef} className="x" aria-label="閉じる" title="閉じる" onClick={close}>
            ×
          </button>
        </div>
        <div className="help-grid">
          {groups.map((g) => (
            <section key={g.title} className="help-group">
              <h4>{g.title}</h4>
              <dl>
                {g.items.map((s) => (
                  <div key={s.label} className={`help-row${s.off ? ' help-row-off' : ''}`}>
                    <dt>
                      {s.keys.map((k, i) => (
                        <kbd key={i}>{k}</kbd>
                      ))}
                    </dt>
                    <dd>
                      {s.label}
                      {s.off && <span className="help-off-note">（設定でONにできます）</span>}
                    </dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
        </div>
        <p className="help-foot">
          フローの点線枠の工程は「状況＝未着手（未ヒアリング）」です。状況を進めると実線になります。
        </p>
        <p className="help-foot">
          {singleKey
            ? '単キーの操作は、テキスト入力中は無効です（誤入力を防ぐため）。'
            : '薄く表示された操作は今は無効です。シングルキー操作（j/k 移動・g リーダーなどの修飾キーなしのキー）の設定を ON にすると使えます（次工程追加など一部の低リスクな操作は既定で ON です）。'}
        </p>
      </div>
    </div>
  );
}
