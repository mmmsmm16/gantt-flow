// 資料台帳ドロワー（手順書タブの右パネル）。project.manual.assets の一覧を表示・編集する。
// UI の正: design_reference/procedure-mock.html の .drawer 部分。
// リンク状態は本サイクルでは 2 表示に集約（resolveLocator 参照）:
//  - resolved（alias がローカル対応表にある）＝結合実パス＋「パスをコピー」
//  - disconnected（対応表に無い＝コンサル環境の常態）＝グレー表示・エラー扱いしない
// リンク実在検査（真のリンク切れ）・フォルダを開く機能は将来サイクル（対象外）。
import { useMemo, useState } from 'react';
import type { AssetLocator, Id, Manual } from '@gantt-flow/core';
import { useApp } from './store';
import { useUI } from './ui/useUI';
import { cancelEditOnEscape, selectAllOnFocus } from './inputBehaviors';
import { loadLocationAliases, saveLocationAliases, resolveLocator } from './locationAliases';

const isUrlLocator = (l: AssetLocator | undefined): l is { url: string } => !!l && 'url' in l;

// この資産を参照している StepRef{kind:'asset'} を全工程から数える（逆引き「使用: N工程・Mステップ」）。
function usageOf(manual: Manual, assetId: Id): { tasks: number; steps: number } {
  let tasks = 0;
  let steps = 0;
  for (const doc of Object.values(manual.procedures)) {
    const n = doc.steps.reduce(
      (acc, s) => acc + (s.refs.some((r) => r.kind === 'asset' && r.assetId === assetId) ? 1 : 0),
      0,
    );
    if (n > 0) {
      tasks += 1;
      steps += n;
    }
  }
  return { tasks, steps };
}

// 単一行の非制御入力（ProcedureView の EditLine と同流儀: defaultValue + onBlur コミット +
// Escape 取消 + フォーカス全選択。key で外部変更時に再マウントして defaultValue を更新する）。
function Line(props: {
  value: string;
  placeholder?: string;
  className?: string;
  ariaLabel?: string;
  onCommit: (next: string) => void;
}): JSX.Element {
  return (
    <input
      key={props.value}
      className={props.className}
      defaultValue={props.value}
      placeholder={props.placeholder}
      aria-label={props.ariaLabel}
      onKeyDown={cancelEditOnEscape}
      {...selectAllOnFocus}
      onBlur={(e) => {
        const v = e.target.value;
        if (v !== props.value) props.onCommit(v);
      }}
    />
  );
}

export function AssetLedger(props: { onClose: () => void }): JSX.Element {
  const manual = useApp((s) => s.project.manual);
  const upsertAsset = useApp((s) => s.upsertAsset);
  const updateAsset = useApp((s) => s.updateAsset);
  const removeAsset = useApp((s) => s.removeAsset);

  // 場所エイリアス対応表は各 PC の localStorage（.gflow には含めない）。マウント時に 1 回読み、
  // 登録/削除のたびにローカル state へも反映して即座に表示へ反映する。
  const [aliases, setAliases] = useState<Record<string, string>>(() => loadLocationAliases());
  const [aliasName, setAliasName] = useState('');
  const [aliasPath, setAliasPath] = useState('');

  const assets = useMemo(
    () => Object.values(manual.assets).sort((a, b) => a.name.localeCompare(b.name, 'ja')),
    [manual.assets],
  );

  const registerAlias = () => {
    const name = aliasName.trim();
    const path = aliasPath.trim();
    if (!name || !path) return;
    const next = { ...aliases, [name]: path };
    saveLocationAliases(next);
    setAliases(next);
    setAliasName('');
    setAliasPath('');
  };
  const removeAlias = (name: string) => {
    const next = { ...aliases };
    delete next[name];
    saveLocationAliases(next);
    setAliases(next);
  };

  const copyPath = (text: string) => {
    navigator.clipboard
      .writeText(text)
      .then(() => useUI.getState().toast('パスをコピーしました', 'success'))
      .catch(() => useUI.getState().toast('コピーに失敗しました', 'error'));
  };

  return (
    <aside className="drawer">
      <h4>
        資料台帳<span className="count">{assets.length}</span>
        <button type="button" className="close" aria-label="資料台帳を閉じる" onClick={props.onClose}>
          ×
        </button>
      </h4>

      <details className="alias-box">
        <summary>場所エイリアス（このPCのみ・.gflowには保存されません）</summary>
        {Object.keys(aliases).length === 0 && <div className="alias-empty">未登録</div>}
        {Object.entries(aliases).map(([name, path]) => (
          <div className="alias-row" key={name}>
            <span className="alias-name">{name}</span>
            <span className="alias-path">{path}</span>
            <button type="button" className="x" aria-label={`${name} を削除`} onClick={() => removeAlias(name)}>
              ×
            </button>
          </div>
        ))}
        <div className="alias-add">
          <input
            className="alias-add-name"
            placeholder="alias"
            aria-label="新しいエイリアス名"
            value={aliasName}
            onChange={(e) => setAliasName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && registerAlias()}
          />
          <input
            className="alias-add-path"
            placeholder="実フォルダの絶対パス"
            aria-label="実フォルダの絶対パス"
            value={aliasPath}
            onChange={(e) => setAliasPath(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && registerAlias()}
          />
          <button type="button" className="proc-btn" onClick={registerAlias}>
            登録
          </button>
        </div>
      </details>

      {assets.length === 0 && (
        <p className="issues-empty">
          資料がまだありません。手順書のステップから参照する資料（帳票・マニュアル・チェックリスト等）をここに登録します。
        </p>
      )}

      {assets.map((a) => {
        const usage = usageOf(manual, a.id);
        const r = resolveLocator(a.locator, aliases);
        const urlMode = isUrlLocator(a.locator);
        const curAlias = !urlMode && a.locator && 'alias' in a.locator ? a.locator.alias : '';
        const curRelPath = !urlMode && a.locator && 'relPath' in a.locator ? a.locator.relPath : '';
        return (
          <div className="asset" key={a.id}>
            <div className="hd">
              <Line
                className="nm"
                value={a.name}
                placeholder="資料名"
                ariaLabel="資料名"
                onCommit={(v) => updateAsset(a.id, { name: v })}
              />
              <button
                type="button"
                className="x"
                aria-label={`${a.name || '資料'}を削除`}
                onClick={() => {
                  // 参照中（どこかの工程・ステップから使われている）資料は、削除でリンク切れに
                  // なるため確認を挟む。未参照（usage=0）は従来どおり即削除。
                  if (usage.tasks > 0) {
                    void useUI
                      .getState()
                      .confirm({
                        title: '資料を削除',
                        message: `この資料は ${usage.tasks} 工程・${usage.steps} ステップで使用中です。削除するとリンク切れになります。削除しますか？`,
                        confirmLabel: '削除する',
                        danger: true,
                      })
                      .then((ok) => ok && removeAsset(a.id));
                  } else {
                    removeAsset(a.id);
                  }
                }}
              >
                ×
              </button>
            </div>
            <Line
              className="desc"
              value={a.desc ?? ''}
              placeholder="説明（任意）"
              ariaLabel="資料の説明"
              onCommit={(v) => updateAsset(a.id, { desc: v === '' ? undefined : v })}
            />

            <div className="loc-mode">
              <label>
                <input
                  type="radio"
                  name={`loc-${a.id}`}
                  checked={!urlMode}
                  onChange={() => updateAsset(a.id, { locator: { alias: '', relPath: '' } })}
                />
                フォルダ
              </label>
              <label>
                <input
                  type="radio"
                  name={`loc-${a.id}`}
                  checked={urlMode}
                  onChange={() => updateAsset(a.id, { locator: { url: '' } })}
                />
                URL
              </label>
            </div>

            {urlMode ? (
              <Line
                className="url-input"
                value={a.locator && 'url' in a.locator ? a.locator.url : ''}
                placeholder="https://..."
                ariaLabel="URL"
                onCommit={(v) => updateAsset(a.id, { locator: { url: v } })}
              />
            ) : (
              <div className="loc-row">
                <Line
                  className="alias-input"
                  value={curAlias}
                  placeholder="alias"
                  ariaLabel="エイリアス"
                  onCommit={(v) => updateAsset(a.id, { locator: { alias: v, relPath: curRelPath } })}
                />
                <Line
                  className="relpath-input"
                  value={curRelPath}
                  placeholder="相対パス（例: 契約\単価契約一覧.xlsx）"
                  ariaLabel="相対パス"
                  onCommit={(v) => updateAsset(a.id, { locator: { alias: curAlias, relPath: v } })}
                />
              </div>
            )}

            {a.locator && (
              <div className={`path${r.state === 'disconnected' ? ' disconnected' : ''}`}>
                {r.display}
                {r.state !== 'disconnected' && r.display && (
                  <button type="button" className="copy" onClick={() => copyPath(r.display)}>
                    パスをコピー
                  </button>
                )}
              </div>
            )}

            <div className="use">
              使用: {usage.tasks}工程・{usage.steps}ステップ
            </div>
          </div>
        );
      })}

      <button type="button" className="proc-btn add" onClick={() => upsertAsset({ name: '新規資料' })}>
        ＋ 資料を追加
      </button>
    </aside>
  );
}
