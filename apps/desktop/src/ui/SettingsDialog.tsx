// 設定ダイアログ(ツールバーの歯車 / ⌘, / パレット)。タブ: 一般 / ショートカット / データ。
//  一般       … テーマ、シングルキー操作(Vim 風)の ON/OFF(既定 OFF)
//  ショートカット … キーの変更・無効化(KeybindingsEditor)
//  データ     … 設定のエクスポート/インポート(JSON 1 ファイルで持ち運び)
import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { useUI } from './useUI';
import { useFocusTrap } from './useFocusTrap';
import { KeybindingsEditor } from './KeybindingsEditor';
import { collectSettings, parseSettingsFile, applySettings } from '../settings';
import {
  AI_MODELS,
  KEY_PREFIX,
  LS,
  getApiKey,
  saveProviderSettings,
  setApiKey,
  type AiModel,
  type AiProviderKind,
} from '../ai/config';

const TABS: { key: 'general' | 'keys' | 'data' | 'ai'; label: string }[] = [
  { key: 'general', label: '一般' },
  { key: 'ai', label: 'AI アシスト' },
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

        {tab === 'ai' && (
          <div className="settings-body">
            <AiSettings />
          </div>
        )}

        {tab === 'keys' && (
          <div className="settings-body">
            <KeybindingsEditor />
          </div>
        )}

        {/* AI アシストタブは AiSettings（下部）で描画。 */}
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

// ---- AI アシスト設定タブ ----
// 見た目の正: scratchpad/ai-assist-mock.html の設定セクション。styles.css は本タスクでは
// 触らない方針のため、既存の .settings-* クラス＋トークン参照のインライン style で再現する。

const MODEL_LABEL: Record<AiModel, string> = {
  'claude-opus-4-8': 'Claude Opus 4.8',
  'claude-sonnet-5': 'Claude Sonnet 5',
  'claude-haiku-4-5': 'Claude Haiku 4.5',
};

const inputStyle: CSSProperties = {
  width: '100%',
  padding: '7px 10px',
  borderRadius: 'var(--radius-sm)',
  border: '1px solid var(--line)',
  background: 'var(--input-bg)',
  color: 'var(--ink)',
  fontSize: 'var(--fs-body)',
  boxSizing: 'border-box',
};
const btnStyle: CSSProperties = {
  padding: '7px 12px',
  borderRadius: 'var(--radius-sm)',
  border: '1px solid var(--line)',
  background: 'var(--btn-bg)',
  color: 'var(--ink)',
  cursor: 'pointer',
  fontSize: 'var(--fs-label)',
  whiteSpace: 'nowrap',
};
const fieldLabelStyle: CSSProperties = {
  display: 'block',
  fontSize: 'var(--fs-label)',
  color: 'var(--faint)',
  marginBottom: 4,
};
const checkStyle: CSSProperties = {
  display: 'flex',
  gap: 8,
  alignItems: 'center',
  fontSize: 'var(--fs-label)',
  color: 'var(--muted)',
  cursor: 'pointer',
};
const midStyle: CSSProperties = {
  fontFamily: 'var(--font-mono, monospace)',
  fontSize: 11,
  color: 'var(--faint)',
  marginLeft: 'auto',
};
const badgeStyle: CSSProperties = {
  fontSize: 10,
  padding: '1px 6px',
  borderRadius: 999,
  background: 'var(--accent-soft)',
  color: 'var(--accent-strong)',
  fontWeight: 600,
};

function readLs(key: string): string {
  try {
    return localStorage.getItem(key) ?? '';
  } catch {
    return '';
  }
}

function AiSettings() {
  const aiEnabled = useUI((s) => s.aiEnabled);
  const setAiEnabled = useUI((s) => s.setAiEnabled);

  const [kind, setKind] = useState<AiProviderKind>(
    readLs(LS.provider) === 'azure-openai' ? 'azure-openai' : 'anthropic',
  );
  const [model, setModel] = useState<AiModel>(() => {
    const m = readLs(LS.model);
    return (AI_MODELS as string[]).includes(m) ? (m as AiModel) : AI_MODELS[0]!;
  });
  const [anthropicKey, setAnthropicKey] = useState<string>(() => getApiKey('anthropic') ?? '');
  const [azureKey, setAzureKey] = useState<string>(() => getApiKey('azure-openai') ?? '');
  // 「この PC に保存」の初期状態＝当該キーが localStorage 平文に存在するか。
  const [persistAnthropic, setPersistAnthropic] = useState<boolean>(
    () => readLs(KEY_PREFIX + 'anthropic') !== '',
  );
  const [persistAzure, setPersistAzure] = useState<boolean>(
    () => readLs(KEY_PREFIX + 'azure-openai') !== '',
  );
  const [showKey, setShowKey] = useState(false);

  const azureInit = (() => {
    try {
      return JSON.parse(readLs(LS.azure) || '{}') as {
        endpoint?: string;
        deployment?: string;
        apiVersion?: string;
      };
    } catch {
      return {};
    }
  })();
  const [endpoint, setEndpoint] = useState(azureInit.endpoint ?? '');
  const [deployment, setDeployment] = useState(azureInit.deployment ?? '');
  const [apiVersion, setApiVersion] = useState(azureInit.apiVersion ?? '2024-10-21');

  const disabled = !aiEnabled;

  const save = () => {
    saveProviderSettings({
      kind,
      model,
      azure: {
        endpoint: endpoint.trim(),
        deployment: deployment.trim(),
        apiVersion: apiVersion.trim(),
      },
    });
    if (kind === 'anthropic') setApiKey('anthropic', anthropicKey, persistAnthropic);
    else setApiKey('azure-openai', azureKey, persistAzure);
    useUI.getState().toast('AI 設定を保存しました。', 'success');
  };

  return (
    <>
      <section className="settings-section">
        <h4>AI アシスト</h4>
        <label className="settings-toggle">
          <input
            type="checkbox"
            checked={aiEnabled}
            onChange={(e) => setAiEnabled(e.target.checked)}
          />
          <span>
            <strong>
              AI アシストを有効にする<span className="settings-badge">実験的</span>
            </strong>
            <small>
              既定はオフです。オフの間はネットワーク通信を一切行いません。オンにすると、ヒアリングメモから
              工程・手順書の変更提案を作成できます（提案はフロー上で承認/否認できます）。
            </small>
          </span>
        </label>
      </section>

      <section
        className="settings-section"
        style={disabled ? { opacity: 0.55, pointerEvents: 'none' } : undefined}
        aria-disabled={disabled}
      >
        <h4>プロバイダ</h4>
        <p className="settings-desc">
          利用する LLM プロバイダを選び、ご自身の API キーを入力します。従量課金は選んだプロバイダの
          アカウントに発生します。
        </p>
        <div className="settings-radio-row" role="radiogroup" aria-label="AI プロバイダ">
          {(['anthropic', 'azure-openai'] as AiProviderKind[]).map((k) => (
            <label key={k} className={`settings-radio${kind === k ? ' on' : ''}`}>
              <input
                type="radio"
                name="ai-provider"
                checked={kind === k}
                onChange={() => setKind(k)}
                disabled={disabled}
              />
              {k === 'anthropic' ? 'Anthropic' : 'Azure OpenAI'}
            </label>
          ))}
        </div>

        {kind === 'anthropic' && (
          <div style={{ marginTop: 14, display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div>
              <label style={fieldLabelStyle}>Anthropic API キー</label>
              <div style={{ display: 'flex', gap: 8 }}>
                <input
                  type={showKey ? 'text' : 'password'}
                  value={anthropicKey}
                  onChange={(e) => setAnthropicKey(e.target.value)}
                  placeholder="sk-ant-…"
                  aria-label="Anthropic API キー"
                  disabled={disabled}
                  style={{ ...inputStyle, flex: 1, fontFamily: 'var(--font-mono, monospace)' }}
                />
                <button type="button" onClick={() => setShowKey((v) => !v)} style={btnStyle}>
                  {showKey ? '隠す' : '表示'}
                </button>
              </div>
            </div>
            <label style={checkStyle}>
              <input
                type="checkbox"
                checked={persistAnthropic}
                onChange={(e) => setPersistAnthropic(e.target.checked)}
              />
              <span>
                この PC に保存する（<strong>平文</strong>で localStorage
                に保存されます。共有 PC では推奨しません）
              </span>
            </label>

            <div>
              <label style={fieldLabelStyle}>モデル</label>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {AI_MODELS.map((m, i) => (
                  <label
                    key={m}
                    className={`settings-radio${model === m ? ' on' : ''}`}
                    style={{ justifyContent: 'flex-start' }}
                  >
                    <input
                      type="radio"
                      name="ai-model"
                      checked={model === m}
                      onChange={() => setModel(m)}
                      disabled={disabled}
                    />
                    <span>{MODEL_LABEL[m]}</span>
                    {i === 0 && <span style={badgeStyle}>既定</span>}
                    <code style={midStyle}>{m}</code>
                  </label>
                ))}
              </div>
            </div>
          </div>
        )}

        {kind === 'azure-openai' && (
          <div style={{ marginTop: 14, display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div>
              <label style={fieldLabelStyle}>エンドポイント</label>
              <input
                value={endpoint}
                onChange={(e) => setEndpoint(e.target.value)}
                placeholder="https://my-resource.openai.azure.com"
                aria-label="Azure エンドポイント"
                disabled={disabled}
                style={{ ...inputStyle, fontFamily: 'var(--font-mono, monospace)' }}
              />
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
              <div>
                <label style={fieldLabelStyle}>デプロイ名</label>
                <input
                  value={deployment}
                  onChange={(e) => setDeployment(e.target.value)}
                  placeholder="gpt-4o-deploy"
                  aria-label="デプロイ名"
                  disabled={disabled}
                  style={{ ...inputStyle, fontFamily: 'var(--font-mono, monospace)' }}
                />
              </div>
              <div>
                <label style={fieldLabelStyle}>API バージョン</label>
                <input
                  value={apiVersion}
                  onChange={(e) => setApiVersion(e.target.value)}
                  placeholder="2024-10-21"
                  aria-label="API バージョン"
                  disabled={disabled}
                  style={{ ...inputStyle, fontFamily: 'var(--font-mono, monospace)' }}
                />
              </div>
            </div>
            <div>
              <label style={fieldLabelStyle}>Azure API キー</label>
              <div style={{ display: 'flex', gap: 8 }}>
                <input
                  type={showKey ? 'text' : 'password'}
                  value={azureKey}
                  onChange={(e) => setAzureKey(e.target.value)}
                  aria-label="Azure API キー"
                  disabled={disabled}
                  style={{ ...inputStyle, flex: 1, fontFamily: 'var(--font-mono, monospace)' }}
                />
                <button type="button" onClick={() => setShowKey((v) => !v)} style={btnStyle}>
                  {showKey ? '隠す' : '表示'}
                </button>
              </div>
            </div>
            <label style={checkStyle}>
              <input
                type="checkbox"
                checked={persistAzure}
                onChange={(e) => setPersistAzure(e.target.checked)}
              />
              <span>
                この PC に保存する（<strong>平文</strong>で localStorage
                に保存されます。共有 PC では推奨しません）
              </span>
            </label>
          </div>
        )}

        <div className="settings-actions" style={{ marginTop: 16 }}>
          <button className="primary" onClick={save}>
            保存
          </button>
        </div>

        <p
          className="settings-desc settings-note"
          style={{ display: 'flex', gap: 6, alignItems: 'flex-start', marginTop: 12 }}
        >
          <span aria-hidden>🔒</span>
          <span>
            キーは当社サーバー等の外部には送信されません。<strong>選んだプロバイダの API との通信にのみ</strong>
            使用します。工程データとメモは提案生成の対象範囲だけを送信します。
          </span>
        </p>
      </section>
    </>
  );
}
