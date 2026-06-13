// 課題一覧ビュー。工程横断で「課題 / 対象工程 / 担当 / 方策」を一覧（コンサル定番の納品物）。
// 行クリックでその工程へジャンプ。Excel 出力にも対応。データモデルは変更しない（IssueItem[] を集計）。
import { useEffect, useMemo, useRef } from 'react';
import { computeCodes } from '@gantt-flow/core';
import { useApp } from '../store';
import { useUI } from './useUI';
import { useFocusTrap } from './useFocusTrap';
import { exportIssuesExcel } from '../persistence';
import * as Icons from './icons';

export function IssueListDialog() {
  const open = useUI((s) => s.overlay === 'issues');
  const project = useApp((s) => s.project);
  const close = () => useUI.getState().setOverlay(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  useFocusTrap(dialogRef, open);

  const codes = useMemo(() => computeCodes(project.core), [project.core]);
  const rows = useMemo(() => {
    const tasks = Object.values(project.core.tasks).sort((a, b) =>
      (codes[a.id] ?? '').localeCompare(codes[b.id] ?? '', undefined, { numeric: true }),
    );
    const out: { taskId: string; code: string; name: string; assignee: string; issue: string; measure: string }[] = [];
    for (const t of tasks) {
      const assignee = t.assigneeId ? project.core.assignees[t.assigneeId]?.name ?? '' : '';
      for (const iss of project.details[t.id]?.issues ?? []) {
        if (!iss.issue.trim() && !iss.measure?.trim()) continue;
        out.push({ taskId: t.id, code: codes[t.id] ?? '', name: t.name, assignee, issue: iss.issue, measure: iss.measure ?? '' });
      }
    }
    return out;
  }, [project, codes]);

  // Esc は useGlobalHotkeys の「最上位レイヤを閉じる」一元処理が担う(個別リスナー不要)。
  useEffect(() => {
    if (open) closeRef.current?.focus();
  }, [open]);

  if (!open) return null;

  const jump = (taskId: string) => {
    const a = useApp.getState();
    const t = a.project.core.tasks[taskId];
    if (!t) return;
    a.select(taskId);
    a.setLevel(t.level);
    a.setScope(t.parentId);
    close();
  };

  return (
    <div className="modal-backdrop" onMouseDown={close}>
      <div
        className="modal issues-modal"
        role="dialog"
        aria-modal="true"
        aria-label="課題一覧"
        ref={dialogRef}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="help-head">
          <h3 className="modal-title">
            課題一覧 <span className="issues-count">{rows.length}件</span>
          </h3>
          <div className="issues-head-actions">
            <button
              className="issues-export"
              onClick={() => {
                const n = exportIssuesExcel(useApp.getState().project);
                useUI.getState().toast(`出力しました（${n}）`, 'success');
              }}
              disabled={rows.length === 0}
            >
              <Icons.Download />
              Excel 出力
            </button>
            <button ref={closeRef} className="x" aria-label="閉じる" title="閉じる" onClick={close}>
              ×
            </button>
          </div>
        </div>
        {rows.length === 0 ? (
          <p className="issues-empty">課題が登録されていません。表やインスペクタで工程に課題を追加すると、ここに一覧されます。</p>
        ) : (
          <div className="issues-scroll">
            <table className="issues-table">
              <thead>
                <tr>
                  <th className="il-no">No.</th>
                  <th className="il-task">工程</th>
                  <th className="il-assignee">担当</th>
                  <th className="il-issue">課題</th>
                  <th className="il-measure">方策</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={i} onClick={() => jump(r.taskId)} title="クリックでこの工程へ移動">
                    <td className="il-no">{r.code}</td>
                    <td className="il-task">{r.name}</td>
                    <td className="il-assignee">{r.assignee}</td>
                    <td className="il-issue">{r.issue}</td>
                    <td className="il-measure">{r.measure}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
