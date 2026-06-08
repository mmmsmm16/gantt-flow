import { useEffect } from 'react';
import { findView, useApp } from './store';
import { type ProcessLevel } from '@gantt-flow/core';
import { TableView } from './TableView';
import { FullTable } from './FullTable';
import { FlowCanvas } from './FlowCanvas';
import { Inspector } from './Inspector';
import {
  saveProjectToFile,
  openProjectFromFile,
  readTableFile,
  exportExcelFile,
  exportCsvFile,
  exportSvgFile,
} from './persistence';
import { useUI } from './ui/useUI';
import { Modal, Toaster } from './ui/Dialogs';
import * as Icons from './ui/icons';
import { Menu, MenuItem } from './ui/Menu';
import { Welcome } from './ui/Welcome';
import { HelpDialog } from './ui/HelpDialog';
import { StatusBar } from './ui/StatusBar';
import { CommandPalette } from './ui/CommandPalette';
import { takeAutosaveForRestore, clearAutosave } from './autosave';

const LEVELS: { key: ProcessLevel; label: string }[] = [
  { key: 'large', label: '大' },
  { key: 'medium', label: '中' },
  { key: 'small', label: '小' },
  { key: 'detail', label: '詳細' },
];
const PARENT_LEVEL: Record<ProcessLevel, ProcessLevel | null> = {
  large: null,
  medium: 'large',
  small: 'medium',
  detail: 'small',
};

export function App() {
  const project = useApp((s) => s.project);
  const level = useApp((s) => s.level);
  const scopeParentId = useApp((s) => s.scopeParentId);
  const showIssues = useApp((s) => s.showIssues);
  const canUndo = useApp((s) => s.canUndo);
  const canRedo = useApp((s) => s.canRedo);
  const dirty = useApp((s) => s.dirty);

  const setLevel = useApp((s) => s.setLevel);
  const setScope = useApp((s) => s.setScope);
  const toggleIssues = useApp((s) => s.toggleIssues);
  const undo = useApp((s) => s.undo);
  const redo = useApp((s) => s.redo);

  const selectedTaskId = useApp((s) => s.selectedTaskId);
  const isEmpty = Object.keys(project.core.tasks).length === 0;
  const theme = useUI((s) => s.theme);
  const toggleTheme = useUI((s) => s.toggleTheme);
  const tableWide = useUI((s) => s.tableWide);
  const tableMode = useUI((s) => s.tableMode);
  const setTableMode = useUI((s) => s.setTableMode);
  const fullMode = tableMode === 'full';
  const parentLevel = PARENT_LEVEL[level];
  const scopeOptions = parentLevel
    ? Object.values(project.core.tasks).filter((t) => t.level === parentLevel)
    : [];

  const onSave = () => {
    const name = saveProjectToFile(useApp.getState().project);
    useApp.getState().markSaved();
    useUI.getState().toast(`保存しました（${name}）`, 'success');
  };
  const onOpen = async () => {
    try {
      const p = await openProjectFromFile();
      if (p) {
        useApp.getState().loadProject(p);
        useUI.getState().toast('開きました。', 'success');
      }
    } catch {
      useUI.getState().toast('ファイルを開けませんでした（形式が不正です）。', 'error');
    }
  };
  const onNew = async () => {
    const ok = await useUI.getState().confirm({
      title: '新規プロジェクト',
      message: '新規プロジェクトを作成します。未保存の変更は失われます。',
      confirmLabel: '作成',
      danger: true,
    });
    if (ok) useApp.getState().newProject();
  };
  const onImport = () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.csv,.xlsx,text/csv';
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;
      try {
        const report = useApp.getState().importRows(await readTableFile(file));
        const c = report.created;
        let msg = `工程 ${c.tasks} / 入出力 ${c.ios} / 課題 ${c.issues} / 依存 ${c.dependencies} を取り込みました。`;
        if (report.unresolvedDeps.length)
          msg += `\n\n未解決の前工程: ${report.unresolvedDeps.length}件（行 ${report.unresolvedDeps
            .map((u) => u.row)
            .join(', ')}）`;
        if (report.hierarchyIssues.length) msg += `\n粒度/親の問題: ${report.hierarchyIssues.length}件`;
        if (report.warnings.length) msg += `\n警告: ${report.warnings.join(' / ')}`;
        void useUI.getState().confirm({
          title: '取り込み結果',
          message: msg,
          confirmLabel: '閉じる',
          hideCancel: true,
        });
      } catch {
        useUI.getState().toast('取り込みに失敗しました（CSV / Excel を確認してください）。', 'error');
      }
    };
    input.click();
  };
  const onSample = () => {
    useApp.getState().loadSample();
    useUI.getState().toast('サンプルを開きました。表を編集するとフローに反映されます。', 'success');
  };
  const onExportExcel = () => {
    const n = exportExcelFile(useApp.getState().project);
    useUI.getState().toast(`出力しました（${n}）`, 'success');
  };
  const onExportCsv = () => {
    const n = exportCsvFile(useApp.getState().project);
    useUI.getState().toast(`出力しました（${n}）`, 'success');
  };
  const onExportSvg = () => {
    const st = useApp.getState();
    const view = findView(st.project, st.level, st.scopeParentId);
    if (view) {
      const name = exportSvgFile(st.project, view);
      useUI.getState().toast(`出力しました（${name}）`, 'success');
    }
  };

  // グローバルショートカット: Ctrl/⌘+K=パレット, Ctrl/⌘+S=保存, Ctrl/⌘+Z=戻す,
  // Ctrl+Y / Ctrl+Shift+Z=やり直し, ?=ヘルプ。IME 変換中は無視。テキスト編集中の
  // undo/redo はネイティブ優先（保存・パレットは常に握る）。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.isComposing) return;
      const el = document.activeElement;
      const editable =
        el instanceof HTMLElement &&
        (el.tagName === 'INPUT' ||
          el.tagName === 'TEXTAREA' ||
          el.tagName === 'SELECT' ||
          el.isContentEditable);

      // 修飾なし: ? でショートカット一覧（編集中は無視）。
      if (!e.ctrlKey && !e.metaKey && !e.altKey) {
        if (e.key === '?' && !editable) {
          e.preventDefault();
          useUI.getState().setOverlay(useUI.getState().overlay === 'help' ? null : 'help');
        }
        return;
      }
      if (!(e.ctrlKey || e.metaKey)) return;

      const k = e.key.toLowerCase();
      if (k === 'k') {
        e.preventDefault();
        useUI.getState().setOverlay(useUI.getState().overlay === 'palette' ? null : 'palette');
        return;
      }
      if (k === 's') {
        e.preventDefault();
        onSave();
        return;
      }
      if (editable) return;
      if (k === 'z' && !e.shiftKey) {
        e.preventDefault();
        useApp.getState().undo();
      } else if (k === 'y' || (k === 'z' && e.shiftKey)) {
        e.preventDefault();
        useApp.getState().redo();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // 未保存のまま閉じようとしたら確認（データ消失の防止）。
  useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (useApp.getState().dirty) {
        e.preventDefault();
        e.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, []);

  // 起動時: 自動退避データがあれば復元を提案（クラッシュ/誤クローズからの復旧）。
  useEffect(() => {
    const saved = takeAutosaveForRestore();
    if (!saved) return;
    void (async () => {
      const ok = await useUI.getState().confirm({
        title: '前回の作業を復元しますか？',
        message:
          '保存されていない作業が見つかりました（自動退避）。復元するとその状態から再開できます。破棄すると元に戻せません。',
        confirmLabel: '復元する',
        cancelLabel: '破棄',
      });
      if (ok) {
        useApp.getState().restoreProject(saved);
        useUI.getState().toast('前回の未保存データを復元しました。保存をお忘れなく。', 'success');
      } else {
        clearAutosave();
      }
    })();
  }, []);

  return (
    <div className="app">
      <a className="skip-link" href="#main-table">
        工程表へスキップ
      </a>
      <header className="toolbar" role="banner">
        <span className="brand">
          <svg className="brand-mark" width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
            <rect className="bg" width="18" height="18" rx="5" />
            <rect className="bar" x="3.5" y="3.8" width="8" height="2.2" rx="1.1" />
            <rect className="bar b2" x="6" y="7.9" width="8.5" height="2.2" rx="1.1" />
            <rect className="bar b3" x="3.5" y="12" width="6" height="2.2" rx="1.1" />
          </svg>
          <span className="brand-name">
            gantt-<span className="brand-accent">flow</span>
          </span>
        </span>
        <span className="spacer" />

        <span className="tool-group" role="group" aria-label="履歴">
          <button className="icon-btn" onClick={undo} disabled={!canUndo} aria-label="戻す" title="戻す (Ctrl+Z)">
            <Icons.Undo />
          </button>
          <button
            className="icon-btn"
            onClick={redo}
            disabled={!canRedo}
            aria-label="やり直し"
            title="やり直し (Ctrl+Y)"
          >
            <Icons.Redo />
          </button>
        </span>

        <span className="tool-group" role="group" aria-label="ファイル">
          <button className="icon-btn" onClick={onNew} aria-label="新規" title="新規プロジェクト">
            <Icons.FilePlus />
          </button>
          <button
            className="icon-btn"
            onClick={onImport}
            aria-label="取り込み"
            title="取り込み（CSV / Excel）"
          >
            <Icons.Upload />
          </button>
          <button className="icon-btn" onClick={onOpen} aria-label="開く" title="開く">
            <Icons.FolderOpen />
          </button>
          <button
            className={`icon-btn${dirty ? ' has-unsaved' : ''}`}
            onClick={onSave}
            aria-label={dirty ? '保存（未保存の変更あり）' : '保存'}
            title="保存 (Ctrl+S)"
          >
            <Icons.Save />
          </button>
        </span>

        <Menu
          className="icon-btn menu-trigger"
          title="出力"
          label={
            <>
              <Icons.Download />
              <Icons.ChevronDown />
            </>
          }
        >
          <MenuItem onClick={onExportExcel}>Excel (.xlsx)</MenuItem>
          <MenuItem onClick={onExportCsv}>CSV (.csv)</MenuItem>
          <MenuItem onClick={onExportSvg}>画像 (SVG)</MenuItem>
        </Menu>

        <button
          className="icon-btn"
          onClick={toggleTheme}
          aria-label={theme === 'dark' ? 'ライトテーマに切替' : 'ダークテーマに切替'}
          title={theme === 'dark' ? 'ライトに切替' : 'ダークに切替'}
        >
          {theme === 'dark' ? <Icons.Sun /> : <Icons.Moon />}
        </button>
        <button
          className="icon-btn"
          onClick={() => useUI.getState().setOverlay('help')}
          aria-label="キーボードショートカット"
          title="キーボードショートカット (?)"
        >
          <Icons.Keyboard />
        </button>
      </header>
      {isEmpty ? (
        <Welcome onSample={onSample} onImport={onImport} onOpen={onOpen} />
      ) : (
        <div
          className={`panes${!fullMode && selectedTaskId ? ' with-inspector' : ''}${
            tableWide || fullMode ? ' table-wide' : ''
          }`}
        >
          <section className="pane table-pane" id="main-table" tabIndex={-1} aria-label="工程表（手順一覧表）">
            <div className="table-head">
              <h2>工程表（手順一覧表）</h2>
              <span className="seg table-mode-seg" role="group" aria-label="表示モード">
                <button className={!fullMode ? 'on' : ''} onClick={() => setTableMode('outline')}>
                  アウトライン
                </button>
                <button className={fullMode ? 'on' : ''} onClick={() => setTableMode('full')}>
                  全項目表
                </button>
              </span>
            </div>
            {fullMode ? <FullTable /> : <TableView />}
          </section>
          {!tableWide && !fullMode && (
            <section className="pane flow-pane" aria-label="工程フロー図">
              <div className="flow-head">
                <h2>工程フロー</h2>
                <span className="seg" role="group" aria-label="粒度">
                  {LEVELS.map((l) => (
                    <button
                      key={l.key}
                      className={l.key === level ? 'on' : ''}
                      onClick={() => setLevel(l.key)}
                      title={`${l.label}工程の粒度で表示`}
                    >
                      {l.label}
                    </button>
                  ))}
                </span>
                {parentLevel && (
                  <select
                    className="scope"
                    value={scopeParentId ?? ''}
                    onChange={(e) => setScope(e.target.value || undefined)}
                    title="表示するスコープ（親工程）"
                  >
                    <option value="">（スコープ: 全体）</option>
                    {scopeOptions.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.name}
                      </option>
                    ))}
                  </select>
                )}
                <button
                  className={`icon-btn toggle-btn${showIssues ? ' on' : ''}`}
                  onClick={toggleIssues}
                  aria-pressed={showIssues}
                  aria-label="課題レイヤの表示切替"
                  title={showIssues ? '課題レイヤを隠す' : '課題レイヤを表示'}
                >
                  {showIssues ? <Icons.Eye /> : <Icons.EyeOff />}
                </button>
              </div>
              <FlowCanvas />
            </section>
          )}
          {!fullMode && selectedTaskId && (
            <section className="pane inspector-pane">
              <Inspector />
            </section>
          )}
        </div>
      )}
      {!isEmpty && <StatusBar />}
      <CommandPalette
        onNew={onNew}
        onSave={onSave}
        onOpen={onOpen}
        onImport={onImport}
        onSample={onSample}
        onExportExcel={onExportExcel}
        onExportCsv={onExportCsv}
        onExportSvg={onExportSvg}
      />
      <HelpDialog />
      <Modal />
      <Toaster />
    </div>
  );
}
