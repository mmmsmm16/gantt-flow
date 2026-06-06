import type { ProcessLevel } from '@gantt-flow/core';
import { useApp } from './store';
import { TableView } from './TableView';
import { FlowCanvas } from './FlowCanvas';
import { saveProjectToFile, openProjectFromFile } from './persistence';

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
      alert('ファイルを開けませんでした（形式が不正です）。');
    }
  };
  const onNew = () => {
    if (confirm('新規プロジェクトを作成します。未保存の変更は失われます。')) {
      useApp.getState().newProject();
    }
  };
  const onImport = () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.csv,text/csv';
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;
      useApp.getState().importCsvText(await file.text());
    };
    input.click();
  };

  return (
    <div className="app">
      <header className="toolbar">
        <strong className="brand">gantt-flow</strong>
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
        <button onClick={onImport}>取り込み(CSV)</button>
        <button onClick={onOpen}>開く</button>
        <button onClick={onSave}>保存</button>
      </header>
      <div className="panes">
        <section className="pane table-pane">
          <h2>工程表（手順一覧表）</h2>
          <TableView />
        </section>
        <section className="pane flow-pane">
          <h2>工程フロー</h2>
          <FlowCanvas />
        </section>
      </div>
    </div>
  );
}
