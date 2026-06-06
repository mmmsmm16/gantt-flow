import { useApp } from './store';
import type { ProcessTask } from '@gantt-flow/core';

export function TableView() {
  const project = useApp((s) => s.project);
  const selectedTaskId = useApp((s) => s.selectedTaskId);
  const select = useApp((s) => s.select);
  const renameTask = useApp((s) => s.renameTask);
  const setAssigneeByName = useApp((s) => s.setAssigneeByName);
  const addDependency = useApp((s) => s.addDependency);
  const addIo = useApp((s) => s.addIo);
  const addIssue = useApp((s) => s.addIssue);

  const tasks: ProcessTask[] = Object.values(project.core.tasks).sort(
    (a, b) => a.order - b.order,
  );

  if (tasks.length === 0) {
    return <p className="empty">「＋作業を追加」から始めてください。</p>;
  }

  return (
    <table className="grid">
      <thead>
        <tr>
          <th>作業名</th>
          <th>担当</th>
          <th>前工程</th>
          <th>I/O・課題</th>
        </tr>
      </thead>
      <tbody>
        {tasks.map((t) => {
          const detail = project.details[t.id];
          const assigneeName = t.assigneeId ? project.core.assignees[t.assigneeId]?.name ?? '' : '';
          const ioCount = (detail?.inputs?.length ?? 0) + (detail?.outputs?.length ?? 0);
          const issueCount = detail?.issues?.length ?? 0;
          return (
            <tr
              key={t.id}
              className={t.id === selectedTaskId ? 'selected' : ''}
              onClick={() => select(t.id)}
            >
              <td>
                <input
                  defaultValue={t.name}
                  onClick={(e) => e.stopPropagation()}
                  onBlur={(e) => {
                    if (e.target.value !== t.name) renameTask(t.id, e.target.value);
                  }}
                />
              </td>
              <td>
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
              <td>
                <select
                  value=""
                  onClick={(e) => e.stopPropagation()}
                  onChange={(e) => {
                    if (e.target.value) addDependency(e.target.value, t.id);
                  }}
                >
                  <option value="">＋前工程…</option>
                  {tasks
                    .filter((o) => o.id !== t.id)
                    .map((o) => (
                      <option key={o.id} value={o.id}>
                        {o.name}
                      </option>
                    ))}
                </select>
              </td>
              <td className="io-cell" onClick={(e) => e.stopPropagation()}>
                <button onClick={() => addIo(t.id, 'inputs', prompt('入力（帳票名）') ?? '')}>＋入力</button>
                <button onClick={() => addIo(t.id, 'outputs', prompt('出力（帳票名）') ?? '')}>＋出力</button>
                <button onClick={() => addIssue(t.id, prompt('課題') ?? '')}>＋課題</button>
                <span className="counts">
                  I/O {ioCount} / 課題 {issueCount}
                </span>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
