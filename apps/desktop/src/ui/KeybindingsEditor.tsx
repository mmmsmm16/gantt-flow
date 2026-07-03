// ショートカット編集エディタ(SettingsDialog の「ショートカット」タブの中身)。
// 既定キーマップ(keymap.ts)を個人の好みに上書き/無効化できる。
// 「変更」→ 次の打鍵をキャプチャ → 重複していれば確認(相手を無効化して置き換え)。
// 重複検出はシングルキーOFFのフィルタ前のキーマップで行う(ONに戻したとき衝突しないように)。
// シングルキーOFF中の該当行はグレーアウト表示(設定は保持・動作だけ無効)。
import { useEffect, useMemo, useState } from 'react';
import { useUI } from './useUI';
import {
  DEFAULT_KEYMAP,
  loadOverrides,
  saveOverrides,
  resolveKeymap,
  findConflict,
  chordFromEvent,
  chordKeys,
  isSingleKeyBinding,
  type KeyBinding,
  type KeymapOverrides,
} from '../keymap';

// グループ表示順(keymap.ts の help.group と一致)。
const GROUP_ORDER = [
  '全体',
  '工程カラー(選択中の工程)',
  '画面移動(g リーダー)',
  '工程表(行選択モード)',
  '工程フロー',
];

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

export function KeybindingsEditor() {
  const singleKey = useUI((s) => s.singleKey);
  const [overrides, setOverrides] = useState<KeymapOverrides>(() => loadOverrides());
  // キーキャプチャ中のバインド id(「新しいキーを押してください」状態)。
  const [capturing, setCapturing] = useState<string | null>(null);

  // フィルタ前(上書きのみ適用)のキーマップ。重複検出と表示の基準。
  const effective = useMemo(() => resolveKeymap(DEFAULT_KEYMAP, overrides), [overrides]);

  const apply = (next: KeymapOverrides) => {
    setOverrides(next);
    saveOverrides(next);
  };

  // キャプチャ: 次の打鍵を Chord 化して割り当てる(修飾キー単押しは待つ・Esc は取消)。
  // 任意のキーを記録するモーダルな横取りなので、ここだけは window capture で全キーを
  // stopPropagation で止める(Esc も「キャプチャ取消」として消費し、一元 Esc 処理へ流さない)。
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
      // shift は必ず明示(true/false)で記録する。不問(undefined)にすると Shift 有無で
      // 区別している既存バインド(Ctrl+Z / Ctrl+Shift+Z 等)を実行時に影で覆ってしまう。
      const chord = chordFromEvent(e);
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

  const groups = GROUP_ORDER.map((title) => ({
    title,
    items: DEFAULT_KEYMAP.filter((b) => groupOf(b) === title),
  })).filter((g) => g.items.length > 0);

  const hasCustom = Object.keys(overrides).length > 0;

  return (
    <div className="keybind-editor">
      {!singleKey && (
        <p className="keybind-note">
          シングルキー操作が OFF のため、薄く表示されたキーは現在動作しません（設定は保持されます）。
        </p>
      )}
      {hasCustom && (
        <div className="keybind-toolbar">
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
        </div>
      )}

      <div className="keybind-scroll">
        {groups.map((g) => (
          <section key={g.title} className="keybind-group">
            <h4>{g.title}</h4>
            {g.items.map((b) => {
              const ov = overrides[b.id];
              const disabled = ov === null;
              const eff = effective.find((x) => x.id === b.id);
              // OFF中の単キー(ただし lowRisk は設定に関わらず有効なので薄く表示しない。UX#12)
              const inactive = !singleKey && eff !== undefined && isSingleKeyBinding(eff) && !eff.lowRisk;
              const isCapturing = capturing === b.id;
              return (
                <div
                  key={b.id}
                  className={`keybind-row${disabled ? ' disabled' : ''}${inactive ? ' inactive' : ''}`}
                >
                  <span className="kb-label">
                    {labelOf(b)}
                    {!singleKey && b.lowRisk && !disabled && (
                      <span className="kb-lowrisk" title="低リスクな操作のため、シングルキー設定に関わらず既定で有効です">
                        既定でON
                      </span>
                    )}
                  </span>
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
                        {ov !== undefined && (
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
    </div>
  );
}
