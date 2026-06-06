import { useApp } from './store';
import { TableView } from './TableView';
import { FlowCanvas } from './FlowCanvas';

export function App() {
  const addTask = useApp((s) => s.addTask);
  const undo = useApp((s) => s.undo);
  const redo = useApp((s) => s.redo);
  const canUndo = useApp((s) => s.canUndo);
  const canRedo = useApp((s) => s.canRedo);

  return (
    <div className="app">
      <header className="toolbar">
        <strong className="brand">gantt-flow</strong>
        <span className="seg">粒度: 中工程</span>
        <span className="spacer" />
        <button onClick={() => addTask('新規作業')}>＋作業を追加</button>
        <button onClick={undo} disabled={!canUndo}>
          戻す
        </button>
        <button onClick={redo} disabled={!canRedo}>
          やり直し
        </button>
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
