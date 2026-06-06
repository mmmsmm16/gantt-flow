import { useEffect, useRef, useState } from 'react';
import type { ProcessTask, ProcessLevel, Id } from '@gantt-flow/core';
import { effortRollupMinutes, formatMinutes } from '@gantt-flow/core';
import { useApp } from './store';
import { useUI } from './ui/useUI';

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
  const updateDetail = useApp((s) => s.updateDetail);
  const addRootTask = useApp((s) => s.addRootTask);
  const addChildTask = useApp((s) => s.addChildTask);
  const addSiblingOf = useApp((s) => s.addSiblingOf);
  const removeTask = useApp((s) => s.removeTask);
  const tableWide = useUI((s) => s.tableWide);
  const toggleTableWide = useUI((s) => s.toggleTableWide);

  const tasks = Object.values(project.core.tasks);
  const rows = buildOutline(tasks);
  const parentsWithChildren = new Set(tasks.map((t) => t.parentId).filter(Boolean) as Id[]);
  const assigneeNames = [...new Set(Object.values(project.core.assignees).map((a) => a.name))];

  // 新しく追加した行の作業名入力にフォーカスする（連続入力）。
  const [focusId, setFocusId] = useState<Id | null>(null);
  const nameRefs = useRef<Map<Id, HTMLInputElement>>(new Map());
  useEffect(() => {
    if (!focusId) return;
    nameRefs.current.get(focusId)?.focus();
    setFocusId(null);
  }, [focusId, rows.length]);

  const openRow = (t: ProcessTask) => {
    select(t.id);
    setFlowLevel(t.level);
    setScope(t.parentId);
  };

  const commitName = (t: ProcessTask, value: string) => {
    if (value !== t.name) renameTask(t.id, value);
  };

  return (
    <div className="outline">
      <div className="outline-actions">
        <button className="primary" onClick={() => addRootTask('large')}>
          ＋ 大工程
        </button>
        <button onClick={() => addRootTask('medium')}>＋ 中工程</button>
        <button
          className="wide-toggle"
          onClick={toggleTableWide}
          aria-pressed={tableWide}
          title={tableWide ? 'フローを表示して分割に戻す' : 'フローを畳んで表を全幅にする'}
        >
          {tableWide ? '↔ 分割に戻す' : '⤢ 表を広く'}
        </button>
      </div>

      {rows.length === 0 ? (
        <p className="empty">「＋ 大工程」または「＋ 中工程」から作業を追加してください。</p>
      ) : (
        <>
          <datalist id="assignee-names">
            {assigneeNames.map((n) => (
              <option key={n} value={n} />
            ))}
          </datalist>
          <table className="grid">
            <thead>
              <tr>
                <th className="c-level">粒度</th>
                <th>作業名</th>
                <th className="c-assignee">担当</th>
                <th className="c-effort">工数</th>
                <th className="c-detail">内訳</th>
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
                const hasChildren = parentsWithChildren.has(t.id);
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
                        aria-label="粒度"
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
                          className="name-input"
                          ref={(el) => {
                            if (el) nameRefs.current.set(t.id, el);
                            else nameRefs.current.delete(t.id);
                          }}
                          defaultValue={t.name}
                          placeholder="作業名"
                          aria-label="作業名"
                          onClick={(e) => e.stopPropagation()}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') {
                              e.preventDefault();
                              commitName(t, e.currentTarget.value);
                              const id = addSiblingOf(t.id);
                              if (id) setFocusId(id);
                            } else if (e.key === 'Escape') {
                              e.currentTarget.value = t.name;
                              e.currentTarget.blur();
                            }
                          }}
                          onBlur={(e) => commitName(t, e.target.value)}
                        />
                      </div>
                    </td>
                    <td className="c-assignee">
                      <input
                        className="assignee"
                        list="assignee-names"
                        defaultValue={assigneeName}
                        placeholder="（未割当）"
                        aria-label="担当"
                        onClick={(e) => e.stopPropagation()}
                        onBlur={(e) => {
                          if (e.target.value !== assigneeName) setAssigneeByName(t.id, e.target.value);
                        }}
                      />
                    </td>
                    <td className="c-effort" onClick={(e) => e.stopPropagation()}>
                      {hasChildren ? (
                        <span className="effort-roll" title="子の合計（自動）">
                          {formatMinutes(effortRollupMinutes(project.core, project.details, t.id))}
                        </span>
                      ) : (
                        <input
                          className="effort-input"
                          type="number"
                          min={0}
                          defaultValue={detail?.effortMinutes ?? ''}
                          placeholder="分"
                          aria-label="工数（分）"
                          onClick={(e) => e.stopPropagation()}
                          onBlur={(e) =>
                            updateDetail(t.id, {
                              effortMinutes: e.target.value ? Number(e.target.value) : undefined,
                            })
                          }
                        />
                      )}
                    </td>
                    <td className="c-detail">
                      {ioCount > 0 || issueCount > 0 ? (
                        <span className="detail-chips">
                          {ioCount > 0 && <span className="chip chip-io">IO{ioCount}</span>}
                          {issueCount > 0 && <span className="chip chip-issue">課題{issueCount}</span>}
                        </span>
                      ) : (
                        <span className="detail-empty">—</span>
                      )}
                    </td>
                    <td className="c-act" onClick={(e) => e.stopPropagation()}>
                      {t.level !== 'detail' && (
                        <button
                          title="子工程を追加"
                          aria-label="子工程を追加"
                          onClick={() => addChildTask(t.id)}
                        >
                          ＋子
                        </button>
                      )}
                      <button
                        className="danger"
                        title="削除"
                        aria-label={`「${t.name}」を削除`}
                        onClick={async () => {
                          const ok = await useUI.getState().confirm({
                            title: '工程を削除',
                            message: `「${t.name}」を削除します（配下の工程も削除されます）。`,
                            confirmLabel: '削除',
                            danger: true,
                          });
                          if (ok) removeTask(t.id);
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
        </>
      )}
    </div>
  );
}
