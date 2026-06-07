import { useEffect } from 'react';
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
import * as Icons from './ui/icons';
import { Menu, MenuItem } from './ui/Menu';

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

  // グローバルショートカット: Ctrl/⌘+Z=戻す, Ctrl+Y / Ctrl+Shift+Z=やり直し, Ctrl/⌘+S=保存。
  // IME 変換中は無視し、テキスト編集中の undo/redo はネイティブを優先（保存は常に握る）。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.isComposing || !(e.ctrlKey || e.metaKey)) return;
      const k = e.key.toLowerCase();
      if (k === 's') {
        e.preventDefault();
        saveProjectToFile(useApp.getState().project);
        return;
      }
      const el = document.activeElement;
      const editable =
        el instanceof HTMLElement &&
        (el.tagName === 'INPUT' ||
          el.tagName === 'TEXTAREA' ||
          el.tagName === 'SELECT' ||
          el.isContentEditable);
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
          <button className="icon-btn" onClick={onSave} aria-label="保存" title="保存 (Ctrl+S)">
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
          <MenuItem onClick={() => exportExcelFile(useApp.getState().project)}>Excel (.xlsx)</MenuItem>
          <MenuItem onClick={() => exportCsvFile(useApp.getState().project)}>CSV (.csv)</MenuItem>
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
