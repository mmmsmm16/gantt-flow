// キーボードショートカット一覧。? もしくはツールバーのヘルプから開く。
// キーボード操作は keymap.ts(実効キーマップ=既定+ユーザー上書き)から自動生成し、
// 表示と実際の動作が常に一致するようにする。マウス操作と編集中キーは固定の説明を併記。
import { useEffect, useMemo, useRef } from 'react';
import { useUI } from './useUI';
import { useFocusTrap } from './useFocusTrap';
import { getActiveKeymap, chordKeys } from '../keymap';

const isMac =
  typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
const MOD = isMac ? '⌘' : 'Ctrl';

interface Shortcut {
  keys: string[];
  label: string;
}
interface Group {
  title: string;
  items: Shortcut[];
}

// keymap に載らない操作(編集中のキー・マウスジェスチャ)は固定で併記する。
const STATIC_GROUPS: Group[] = [
  {
    title: '工程表（作業名の編集中）',
    items: [
      { keys: ['Enter'], label: '次の行を追加' },
      { keys: ['Tab'], label: '字下げ（子にする）' },
      { keys: ['Shift', 'Tab'], label: '字上げ（親に出す）' },
      { keys: ['Alt', '↑ / ↓'], label: '行を上下に移動' },
      { keys: ['Esc'], label: '編集を取り消す' },
    ],
  },
  {
    title: '全項目表（フル表）',
    items: [
      { keys: ['Enter'], label: '作業名で次の行を追加 / セルで下へ移動' },
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
      { keys: ['右クリック（矢印）'], label: '矢印を削除' },
    ],
  },
];

// 実効キーマップから「グループ → ショートカット一覧」を組み立てる。
// 同じ action のサブキー(help なし)は代表エントリに「 / 」で連結して 1 行にまとめる。
function buildKeymapGroups(): Group[] {
  const keymap = getActiveKeymap();
  const groups = new Map<string, Shortcut[]>();
  for (const b of keymap) {
    if (!b.help) continue;
    const alts = keymap.filter((o) => o.action === b.action && o.id !== b.id && !o.help && !!o.leader === !!b.leader);
    const keys = chordKeys(b.chord, b.leader);
    // 代替キー(j と ↓ など)は末尾の 1 打に「j / ↓」のように併記する。
    if (alts.length > 0 && keys.length > 0) {
      const last = keys[keys.length - 1]!;
      const altLabels = alts.map((a) => chordKeys(a.chord, a.leader).join('+'));
      keys[keys.length - 1] = [last, ...altLabels].join(' / ');
    }
    const arr = groups.get(b.help.group) ?? [];
    arr.push({ keys, label: b.help.label });
    groups.set(b.help.group, arr);
  }
  return [...groups.entries()].map(([title, items]) => ({ title, items }));
}

export function HelpDialog() {
  const open = useUI((s) => s.overlay === 'help');
  const close = () => useUI.getState().setOverlay(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  useFocusTrap(dialogRef, open);

  // 開くたびに実効キーマップから再生成(カスタマイズの反映)。
  const groups = useMemo(() => (open ? [...buildKeymapGroups(), ...STATIC_GROUPS] : []), [open]);

  useEffect(() => {
    if (!open) return undefined;
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
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
          <button ref={closeRef} className="x" aria-label="閉じる" onClick={close}>
            ×
          </button>
        </div>
        <div className="help-grid">
          {groups.map((g) => (
            <section key={g.title} className="help-group">
              <h4>{g.title}</h4>
              <dl>
                {g.items.map((s) => (
                  <div key={s.label} className="help-row">
                    <dt>
                      {s.keys.map((k, i) => (
                        <kbd key={i}>{k}</kbd>
                      ))}
                    </dt>
                    <dd>{s.label}</dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
        </div>
        <p className="help-foot">単キーの操作は、テキスト入力中は無効です（誤入力を防ぐため）。</p>
      </div>
    </div>
  );
}
