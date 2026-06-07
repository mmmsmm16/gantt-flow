// キーボードショートカット一覧。? もしくはツールバーのヘルプから開く。発見性とアクセシビリティ向け。
import { useEffect, useRef } from 'react';
import { useUI } from './useUI';
import { useFocusTrap } from './useFocusTrap';

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

const GROUPS: Group[] = [
  {
    title: '全体',
    items: [
      { keys: [MOD, 'K'], label: 'コマンドパレット / 検索' },
      { keys: [MOD, 'S'], label: '保存' },
      { keys: [MOD, 'Z'], label: '元に戻す' },
      { keys: [MOD, 'Y'], label: 'やり直し' },
      { keys: ['?'], label: 'このショートカット一覧' },
    ],
  },
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
    title: '工程フロー',
    items: [
      { keys: ['ダブルクリック'], label: '工程を作成' },
      { keys: ['ハンドル ○ をドラッグ'], label: '矢印（前後関係）を引く' },
      { keys: ['空白をドラッグ'], label: '画面をパン（移動）' },
      { keys: [MOD, 'ホイール'], label: '拡大 / 縮小' },
      { keys: ['Delete'], label: '選択中の制御ノード / 付箋 / 矢印を削除' },
      { keys: ['ダブルクリック（矢印）'], label: '分岐ラベルを編集' },
      { keys: ['右クリック（矢印）'], label: '矢印を削除' },
    ],
  },
];

export function HelpDialog() {
  const open = useUI((s) => s.overlay === 'help');
  const close = () => useUI.getState().setOverlay(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  useFocusTrap(dialogRef, open);

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
          {GROUPS.map((g) => (
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
      </div>
    </div>
  );
}
