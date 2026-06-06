import type { ProcessTask, ProcessLevel, Id } from '@gantt-flow/core';
import { useApp } from './store';

const LEVEL_OPTS: { key: ProcessLevel; label: string }[] = [
  { key: 'large', label: '大' },
  { key: 'medium', label: '中' },
  { key: 'small', label: '小' },
  { key: 'detail', label: '詳細' },
];

interface Row {
  task: ProcessTask;
  depth: number;
}

function buildOutline(tasks: ProcessTask[]): Row[] {
  const byParent = new Map<Id | undefined, ProcessTask[]>();
  for (const t of tasks) {
    const key = t.parentId ?? undefined;
    const arr = byParent.get(key);
    if (arr) arr.push(t);
    else byParent.set(key, [t]);
  }
  for (const arr of byParent.values()) arr.sort((a, b) => a.order - b.order);
  const rows: Row[] = [];
  const walk = (parentId: Id | undefined, depth: number) => {
    for (const t of byParent.get(parentId) ?? []) {
      rows.push({ task: t, depth });
      walk(t.id, depth + 1);
    }
  };
  walk(undefined, 0);
  return rows;
}

export function TableView() {
  const project = useApp((s) => s.project);
  const selectedTaskId = useApp((s) => s.selectedTaskId);
  const select = useApp((s) => s.select);
  const setFlowLevel = useApp((s) => s.setLevel);
  const setScope = useApp((s) => s.setScope);
  const renameTask = useApp((s) => s.renameTask);
  const setTaskLevel = useApp((s) => s.setTaskLevel);
  const setAssigneeByName = useApp((s) => s.setAssigneeByName);
  const addDependency = useApp((s) => s.addDependency);
  const addIo = useApp((s) => s.addIo);
  const addIssue = useApp((s) => s.addIssue);
  const addRootTask = useApp((s) => s.addRootTask);
  const addChildTask = useApp((s) => s.addChildTask);
  const removeTask = useApp((s) => s.removeTask);

  const rows = buildOutline(Object.values(project.core.tasks));

  const openRow = (t: ProcessTask) => {
    select(t.id);
    setFlowLevel(t.level);
    setScope(t.parentId);
  };

  return (
    <div className="outline">
      <div className="outline-actions">
        <button className="primary" onClick={() => addRootTask('large')}>
          ＋ 大工程
        </button>
        <button onClick={() => addRootTask('medium')}>＋ 中工程</button>
      </div>

      {rows.length === 0 ? (
        <p className="empty">「＋ 大工程」または「＋ 中工程」から作業を追加してください。</p>
      ) : (
        <table className="grid">
          <thead>
            <tr>
              <th className="c-level">粒度</th>
              <th>作業名</th>
              <th className="c-assignee">担当</th>
              <th className="c-prev">前工程</th>
              <th className="c-io">I/O・課題</th>
              <th className="c-act"></th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ task: t, depth }) => {
              const detail = project.details[t.id];
              const assigneeName = t.assigneeId
                ? project.core.assignees[t.assigneeId]?.name ?? ''
                : '';
              const ioCount = (detail?.inputs?.length ?? 0) + (detail?.outputs?.length ?? 0);
              const issueCount = detail?.issues?.length ?? 0;
              const siblings = Object.values(project.core.tasks).filter(
                (o) => o.id !== t.id && (o.parentId ?? undefined) === (t.parentId ?? undefined) && o.level === t.level,
              );
              return (
                <tr
                  key={t.id}
                  className={t.id === selectedTaskId ? 'selected' : ''}
                  onClick={() => openRow(t)}
                >
                  <td className="c-level" onClick={(e) => e.stopPropagation()}>
                    <select
                      className={`lvl lvl-${t.level}`}
                      value={t.level}
                      onChange={(e) => setTaskLevel(t.id, e.target.value as ProcessLevel)}
                    >
                      {LEVEL_OPTS.map((l) => (
                        <option key={l.key} value={l.key}>
                          {l.label}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td>
                    <div className="name-cell" style={{ paddingLeft: depth * 18 }}>
                      {depth > 0 && <span className="tree-twig">└</span>}
                      <input
                        defaultValue={t.name}
                        onClick={(e) => e.stopPropagation()}
                        onBlur={(e) => {
                          if (e.target.value !== t.name) renameTask(t.id, e.target.value);
                        }}
                      />
                    </div>
                  </td>
                  <td className="c-assignee">
                    <input
                      className="assignee"
                      defaultValue={assigneeName}
                      placeholder="（未割当）"
                      onClick={(e) => e.stopPropagation()}
                      onBlur={(e) => {
                        if (e.target.value !== assigneeName) setAssigneeByName(t.id, e.target.value);
                      }}
                    />
                  </td>
                  <td className="c-prev" onClick={(e) => e.stopPropagation()}>
                    <select
                      value=""
                      onChange={(e) => {
                        if (e.target.value) addDependency(e.target.value, t.id);
                      }}
                    >
                      <option value="">＋前工程…</option>
                      {siblings.map((o) => (
                        <option key={o.id} value={o.id}>
                          {o.name}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td className="c-io" onClick={(e) => e.stopPropagation()}>
                    <button onClick={() => addIo(t.id, 'inputs', prompt('入力（帳票名）') ?? '')}>＋入</button>
                    <button onClick={() => addIo(t.id, 'outputs', prompt('出力（帳票名）') ?? '')}>＋出</button>
                    <button onClick={() => addIssue(t.id, prompt('課題') ?? '')}>＋課題</button>
                    {(ioCount > 0 || issueCount > 0) && (
                      <span className="counts">
                        I/O {ioCount}・課題 {issueCount}
                      </span>
                    )}
                  </td>
                  <td className="c-act" onClick={(e) => e.stopPropagation()}>
                    {t.level !== 'detail' && (
                      <button title="子工程を追加" onClick={() => addChildTask(t.id)}>
                        ＋子
                      </button>
                    )}
                    <button
                      className="danger"
                      title="削除"
                      onClick={() => {
                        if (confirm(`「${t.name}」を削除します（配下も削除）。`)) removeTask(t.id);
                      }}
                    >
                      ×
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}
