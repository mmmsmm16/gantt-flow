import { findView, useApp } from './store';
import { type ProcessLevel } from '@gantt-flow/core';
import { TableView } from './TableView';
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

  const setLevel = useApp((s) => s.setLevel);
  const setScope = useApp((s) => s.setScope);
  const toggleIssues = useApp((s) => s.toggleIssues);
  const undo = useApp((s) => s.undo);
  const redo = useApp((s) => s.redo);

  const selectedTaskId = useApp((s) => s.selectedTaskId);
  const theme = useUI((s) => s.theme);
  const toggleTheme = useUI((s) => s.toggleTheme);
  const tableWide = useUI((s) => s.tableWide);
  const parentLevel = PARENT_LEVEL[level];
  const scopeOptions = parentLevel
    ? Object.values(project.core.tasks).filter((t) => t.level === parentLevel)
    : [];

  const onSave = () => saveProjectToFile(useApp.getState().project);
  const onOpen = async () => {
    try {
      const p = await openProjectFromFile();
      if (p) useApp.getState().loadProject(p);
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
        useApp.getState().importRows(await readTableFile(file));
      } catch {
        useUI.getState().toast('取り込みに失敗しました（CSV / Excel を確認してください）。', 'error');
      }
    };
    input.click();
  };
  const onExportSvg = () => {
    const st = useApp.getState();
    const view = findView(st.project, st.level, st.scopeParentId);
    if (view) exportSvgFile(st.project, view);
  };

  return (
    <div className="app">
      <header className="toolbar">
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
        <span className="seg">
          粒度
          {LEVELS.map((l) => (
            <button
              key={l.key}
              className={l.key === level ? 'on' : ''}
              onClick={() => setLevel(l.key)}
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
          >
            <option value="">（スコープ: 全体）</option>
            {scopeOptions.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        )}
        <label className="toggle">
          <input type="checkbox" checked={showIssues} onChange={toggleIssues} />
          課題
        </label>
        <span className="spacer" />
        <button onClick={undo} disabled={!canUndo}>
          戻す
        </button>
        <button onClick={redo} disabled={!canRedo}>
          やり直し
        </button>
        <span className="sep" />
        <button onClick={onNew}>新規</button>
        <button onClick={onImport}>取り込み</button>
        <button onClick={onOpen}>開く</button>
        <button onClick={onSave}>保存</button>
        <span className="sep" />
        <span className="export-group">
          出力:
          <button onClick={() => exportExcelFile(useApp.getState().project)}>Excel</button>
          <button onClick={() => exportCsvFile(useApp.getState().project)}>CSV</button>
          <button onClick={onExportSvg}>画像</button>
        </span>
        <span className="sep" />
        <button
          className="theme-toggle"
          onClick={toggleTheme}
          aria-label={theme === 'dark' ? 'ライトテーマに切替' : 'ダークテーマに切替'}
          title={theme === 'dark' ? 'ライトに切替' : 'ダークに切替'}
        >
          {theme === 'dark' ? '☀' : '☾'}
        </button>
      </header>
      <div
        className={`panes${selectedTaskId ? ' with-inspector' : ''}${tableWide ? ' table-wide' : ''}`}
      >
        <section className="pane table-pane">
          <h2>工程表（手順一覧表）</h2>
          <TableView />
        </section>
        {!tableWide && (
          <section className="pane flow-pane">
            <h2>工程フロー</h2>
            <FlowCanvas />
          </section>
        )}
        {selectedTaskId && (
          <section className="pane inspector-pane">
            <Inspector />
          </section>
        )}
      </div>
      <Modal />
      <Toaster />
    </div>
  );
}
