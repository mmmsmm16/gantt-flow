// ショートカット設定。既定キーマップ(keymap.ts)を個人の好みに上書き/無効化できる。
// 「変更」→ 次の打鍵をキャプチャ → 重複していれば確認(相手を無効化して置き換え)。
// 保存は localStorage(gf-keybindings-v1)。ヘルプ・動作とも実効キーマップを共有するので常に一致する。
import { useEffect, useMemo, useRef, useState } from 'react';
import { useUI } from './useUI';
import { useFocusTrap } from './useFocusTrap';
import {
  DEFAULT_KEYMAP,
  loadOverrides,
  saveOverrides,
  resolveKeymap,
  findConflict,
  chordKeys,
  type Chord,
  type KeyBinding,
  type KeymapOverrides,
} from '../keymap';

// グループ表示順(keymap.ts の help.group と一致)。
const GROUP_ORDER = ['全体', '画面移動(g リーダー)', '工程表(行選択モード)', '工程フロー'];

// 一覧の行ラベル: help があればそれ、無い補助キーは同 action の代表ラベル＋（別キー）。
function labelOf(b: KeyBinding): string {
  if (b.help) return b.help.label;
  const primary = DEFAULT_KEYMAP.find((o) => o.action === b.action && o.help);
  return primary?.help ? `${primary.help.label}（別キー）` : b.action;
}
function groupOf(b: KeyBinding): string {
  if (b.help) return b.help.group;
  const primary = DEFAULT_KEYMAP.find((o) => o.action === b.action && o.help);
  return primary?.help?.group ?? 'その他';
}

export function KeybindingsDialog() {
  const open = useUI((s) => s.overlay === 'keybindings');
  const close = () => useUI.getState().setOverlay(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  useFocusTrap(dialogRef, open);

  const [overrides, setOverrides] = useState<KeymapOverrides>({});
  // キーキャプチャ中のバインド id(「新しいキーを押してください」状態)。
  const [capturing, setCapturing] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setOverrides(loadOverrides());
      setCapturing(null);
    }
  }, [open]);

  const effective = useMemo(() => resolveKeymap(DEFAULT_KEYMAP, overrides), [overrides]);

  const apply = (next: KeymapOverrides) => {
    setOverrides(next);
    saveOverrides(next);
  };

  // キャプチャ: 次の打鍵を Chord 化して割り当てる(修飾キー単押しは待つ・Esc は取消)。
  useEffect(() => {
    if (!capturing) return undefined;
    const target = DEFAULT_KEYMAP.find((b) => b.id === capturing);
    if (!target) {
      setCapturing(null);
      return undefined;
    }
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === 'Escape') {
        setCapturing(null);
        return;
      }
      if (['Shift', 'Control', 'Meta', 'Alt'].includes(e.key)) return; // 修飾キー単押しは待つ
      const chord: Chord = {
        key: e.key.toLowerCase(),
        ...(e.ctrlKey || e.metaKey ? { mod: true } : {}),
        ...(e.altKey ? { alt: true } : {}),
        ...(e.shiftKey ? { shift: true } : {}),
      };
      const conflict = findConflict(effective, target, chord);
      const doAssign = (extra: KeymapOverrides = {}) =>
        apply({ ...overrides, ...extra, [target.id]: chord });
      setCapturing(null);
      if (conflict && !conflict.fixed) {
        void useUI
          .getState()
          .confirm({
            title: 'キーが重複しています',
            message: `${chordKeys(chord, target.leader).join('+')} は「${labelOf(conflict)}」に割り当て済みです。置き換えますか？（元の割り当ては無効化されます）`,
            confirmLabel: '置き換える',
          })
          .then((ok) => ok && doAssign({ [conflict.id]: null }));
        return;
      }
      if (conflict?.fixed) {
        useUI.getState().toast(`このキーは固定の操作「${labelOf(conflict)}」と重複するため使えません。`, 'error');
        return;
      }
      doAssign();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [capturing, overrides, effective]);

  // ダイアログ自体の Esc クローズ(キャプチャ中はキャプチャ側が先に処理)。
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !capturing) close();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, capturing]);

  if (!open) return null;

  const groups = GROUP_ORDER.map((title) => ({
    title,
    items: DEFAULT_KEYMAP.filter((b) => groupOf(b) === title),
  })).filter((g) => g.items.length > 0);

  const hasCustom = Object.keys(overrides).length > 0;

  return (
    <div className="modal-backdrop" onMouseDown={close}>
      <div
        className="modal keybind-modal"
        role="dialog"
        aria-modal="true"
        aria-label="ショートカット設定"
        ref={dialogRef}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="help-head">
          <h3 className="modal-title">ショートカット設定</h3>
          <div className="issues-head-actions">
            {hasCustom && (
              <button
                className="issues-export"
                onClick={() => {
                  void useUI
                    .getState()
                    .confirm({
                      title: 'すべて既定に戻す',
                      message: 'カスタマイズしたショートカットをすべて既定に戻します。',
                      confirmLabel: '戻す',
                    })
                    .then((ok) => ok && apply({}));
                }}
              >
                すべて既定に戻す
              </button>
            )}
            <button className="x" aria-label="閉じる" onClick={close}>
              ×
            </button>
          </div>
        </div>

        <div className="keybind-scroll">
          {groups.map((g) => (
            <section key={g.title} className="keybind-group">
              <h4>{g.title}</h4>
              {g.items.map((b) => {
                const ov = overrides[b.id];
                const disabled = ov === null;
                const eff = effective.find((x) => x.id === b.id);
                const isCapturing = capturing === b.id;
                return (
                  <div key={b.id} className={`keybind-row${disabled ? ' disabled' : ''}`}>
                    <span className="kb-label">{labelOf(b)}</span>
                    <span className="kb-keys">
                      {isCapturing ? (
                        <span className="kb-capture">新しいキーを押してください…（Esc で取消）</span>
                      ) : disabled ? (
                        <span className="kb-off">無効</span>
                      ) : (
                        chordKeys((eff ?? b).chord, b.leader).map((k, i) => <kbd key={i}>{k}</kbd>)
                      )}
                    </span>
                    <span className="kb-actions">
                      {b.fixed ? (
                        <span className="kb-fixed" title="慣習として固定のキーです">固定</span>
                      ) : (
                        <>
                          <button onClick={() => setCapturing(isCapturing ? null : b.id)}>
                            {isCapturing ? '取消' : '変更'}
                          </button>
                          {!disabled && (
                            <button
                              onClick={() => apply({ ...overrides, [b.id]: null })}
                              title="このキーを無効化"
                            >
                              無効化
                            </button>
                          )}
                          {(ov !== undefined) && (
                            <button
                              onClick={() => {
                                const next = { ...overrides };
                                delete next[b.id];
                                apply(next);
                              }}
                              title="既定のキーに戻す"
                            >
                              既定に戻す
                            </button>
                          )}
                        </>
                      )}
                    </span>
                  </div>
                );
              })}
            </section>
          ))}
        </div>
        <p className="backup-foot">
          変更は即座に保存され、ヘルプ（?）の表示にも反映されます。g リーダーの 2 打目もここで変更できます。
        </p>
      </div>
    </div>
  );
}
