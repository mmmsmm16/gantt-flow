// 設定ダイアログ(ツールバーの歯車 / ⌘, / パレット)。タブ: 一般 / ショートカット / データ。
//  一般       … テーマ、シングルキー操作(Vim 風)の ON/OFF(既定 OFF)
//  ショートカット … キーの変更・無効化(KeybindingsEditor)
//  データ     … 設定のエクスポート/インポート(JSON 1 ファイルで持ち運び)
import { useEffect, useRef } from 'react';
import { useUI } from './useUI';
import { useFocusTrap } from './useFocusTrap';
import { KeybindingsEditor } from './KeybindingsEditor';
import { collectSettings, parseSettingsFile, applySettings } from '../settings';

const TABS: { key: 'general' | 'keys' | 'data'; label: string }[] = [
  { key: 'general', label: '一般' },
  { key: 'keys', label: 'ショートカット' },
  { key: 'data', label: 'データ' },
];

function exportSettingsFile(): string {
  const json = JSON.stringify(collectSettings(), null, 2);
  // ファイル名はローカル日付(toISOString=UTC だと午前9時前に前日の日付になる)
  const d = new Date();
  const date = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  const name = `gantt-flow-settings-${date}.json`;
  const url = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
  return name;
}

function importSettingsFile(): void {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.json,application/json';
  input.onchange = async () => {
    const file = input.files?.[0];
    if (!file) return;
    const result = parseSettingsFile(await file.text());
    if (!result.ok) {
      useUI.getState().toast(result.error, 'error');
      return;
    }
    applySettings(result.settings);
    if (result.warnings.length) {
      useUI.getState().toast(`設定を取り込みました（${result.warnings.join(' / ')}）`, 'info');
    } else {
      useUI.getState().toast('設定を取り込みました。', 'success');
    }
  };
  input.click();
}

export function SettingsDialog() {
  const open = useUI((s) => s.overlay === 'settings');
  const tab = useUI((s) => s.settingsTab);
  const setTab = useUI((s) => s.setSettingsTab);
  const theme = useUI((s) => s.theme);
  const setTheme = useUI((s) => s.setTheme);
  const singleKey = useUI((s) => s.singleKey);
  const setSingleKey = useUI((s) => s.setSingleKey);
  const minimap = useUI((s) => s.minimap);
  const toggleMinimap = useUI((s) => s.toggleMinimap);
  const tobeEnabled = useUI((s) => s.tobeEnabled);
  const setTobeEnabled = useUI((s) => s.setTobeEnabled);
  const close = () => useUI.getState().setOverlay(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  useFocusTrap(dialogRef, open);

  // Esc は useGlobalHotkeys の「最上位レイヤを閉じる」一元処理が担う(個別リスナー不要)。
  // ショートカットタブのキーキャプチャ中は KeybindingsEditor の capture リスナーが先に止める。
  useEffect(() => {
    if (open) closeRef.current?.focus();
  }, [open]);

  if (!open) return null;

  return (
    <div className="modal-backdrop" onMouseDown={close}>
      <div
        className="modal settings-modal"
        role="dialog"
        aria-modal="true"
        aria-label="設定"
        ref={dialogRef}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="help-head">
          <h3 className="modal-title">設定</h3>
          <button ref={closeRef} className="x" aria-label="閉じる" title="閉じる" onClick={close}>
            ×
          </button>
        </div>

        <div className="settings-tabs" role="tablist" aria-label="設定カテゴリ">
          {TABS.map((t) => (
            <button
              key={t.key}
              role="tab"
              aria-selected={tab === t.key}
              className={`settings-tab${tab === t.key ? ' on' : ''}`}
              onClick={() => setTab(t.key)}
            >
              {t.label}
            </button>
          ))}
        </div>

        {tab === 'general' && (
          <div className="settings-body">
            <section className="settings-section">
              <h4>テーマ</h4>
              <div className="settings-radio-row" role="radiogroup" aria-label="テーマ">
                <label className={`settings-radio${theme === 'light' ? ' on' : ''}`}>
                  <input
                    type="radio"
                    name="theme"
                    checked={theme === 'light'}
                    onChange={() => setTheme('light')}
                  />
                  ライト
                </label>
                <label className={`settings-radio${theme === 'dark' ? ' on' : ''}`}>
                  <input
                    type="radio"
                    name="theme"
                    checked={theme === 'dark'}
                    onChange={() => setTheme('dark')}
                  />
                  ダーク
                </label>
              </div>
            </section>

            <section className="settings-section">
              <h4>キーボード操作</h4>
              <label className="settings-toggle">
                <input
                  type="checkbox"
                  checked={singleKey}
                  onChange={(e) => setSingleKey(e.target.checked)}
                />
                <span>
                  <strong>シングルキー操作を有効にする</strong>
                  <small>
                    j/k で行移動、n で工程追加、c で接続、g t/g f で画面移動などの
                    修飾キーなしの操作を有効化します。OFF でも矢印キー・Enter・Ctrl/⌘ 系の操作は使えます。
                  </small>
                </span>
              </label>
            </section>

            <section className="settings-section">
              <h4>フロー図</h4>
              <label className="settings-toggle">
                <input type="checkbox" checked={minimap} onChange={toggleMinimap} />
                <span>
                  <strong>ミニマップを表示する</strong>
                  <small>フロー右下の全体俯瞰マップ。大きな図で現在地を確認しながら移動できます。</small>
                </span>
              </label>
            </section>

            <section className="settings-section">
              <h4>改善提案（α版）</h4>
              <label className="settings-toggle">
                <input type="checkbox" checked={tobeEnabled} onChange={(e) => setTobeEnabled(e.target.checked)} />
                <span>
                  <strong>
                    As-Is / To-Be 比較を使う<span className="settings-badge">α版</span>
                  </strong>
                  <small>現状(As-Is)と改善後(To-Be)を、工数とリードタイムの2軸で比較する機能。ツールバーに「比較」ボタンが出ます。まだ開発中の α 版で、仕様や表示は変わることがあります（既定オフ）。</small>
                </span>
              </label>
            </section>
          </div>
        )}

        {tab === 'keys' && (
          <div className="settings-body">
            <KeybindingsEditor />
          </div>
        )}

        {tab === 'data' && (
          <div className="settings-body">
            <section className="settings-section">
              <h4>設定のエクスポート / インポート</h4>
              <p className="settings-desc">
                テーマ・シングルキー操作・ショートカットのカスタマイズ・表の列設定を
                1 つの JSON ファイルとして保存し、別の PC やメンバーに引き継げます。
              </p>
              <div className="modal-actions">
                <button
                  className="primary"
                  onClick={() => {
                    const name = exportSettingsFile();
                    useUI.getState().toast(`設定を書き出しました（${name}）`, 'success');
                  }}
                >
                  エクスポート（保存）
                </button>
                <button onClick={importSettingsFile}>インポート（読み込み）</button>
              </div>
              <p className="settings-desc settings-note">
                インポートすると現在の設定は上書きされます（プロジェクトのデータには影響しません）。
              </p>
            </section>
          </div>
        )}
      </div>
    </div>
  );
}
