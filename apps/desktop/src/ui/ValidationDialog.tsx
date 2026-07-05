// 納品前チェック（検証パネル）。lintProject の結果をセクション別に一覧し、行クリックで
// 該当工程（手順書タブ or 工程表）へジャンプする。読み取り専用＝ドメインも undo 履歴も汚さない。
// IssueListDialog と同型（overlay='validate'・useFocusTrap・Esc は closeTopLayer 任せ）。
import { useEffect, useMemo, useRef } from 'react';
import { computeCodes, lintProject, type LintIssue } from '@gantt-flow/core';
import { useApp } from '../store';
import { useUI } from './useUI';
import { useFocusTrap } from './useFocusTrap';
import { revealTask } from '../taskOps';
import { groupLintIssues, planLintJump } from '../validationPanel';

export function ValidationDialog() {
  const open = useUI((s) => s.overlay === 'validate');
  const project = useApp((s) => s.project);
  const close = () => useUI.getState().setOverlay(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  useFocusTrap(dialogRef, open);

  const codes = useMemo(() => computeCodes(project.core), [project.core]);
  const issues = useMemo(() => (open ? lintProject(project) : []), [open, project]);
  const groups = useMemo(() => groupLintIssues(issues), [issues]);
  const errorCount = issues.filter((i) => i.severity === 'error').length;

  // Esc は useGlobalHotkeys の「最上位レイヤを閉じる」一元処理が担う(個別リスナー不要)。
  useEffect(() => {
    if (open) closeRef.current?.focus();
  }, [open]);

  if (!open) return null;

  // 行クリックのジャンプ。procedure=手順書タブの章へ / table=工程表へ / none=非クリック。
  const jump = (iss: LintIssue) => {
    const plan = planLintJump(iss, useApp.getState().project.core);
    const app = useApp.getState();
    const ui = useUI.getState();
    if (plan.kind === 'procedure') {
      app.select(plan.taskId);
      ui.setProcedureMidId(plan.midId);
      ui.setMainView('procedure');
      ui.focusProcedureChapter(plan.taskId);
      ui.setOverlay(null);
    } else if (plan.kind === 'table') {
      ui.setMainView('work');
      revealTask(plan.taskId);
      ui.setOverlay(null);
    }
  };

  return (
    <div className="modal-backdrop" onMouseDown={close}>
      <div
        className="modal validate-modal"
        role="dialog"
        aria-modal="true"
        aria-label="納品前チェック"
        ref={dialogRef}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="help-head">
          <h3 className="modal-title">
            納品前チェック{' '}
            {issues.length > 0 && (
              <span className={`vd-badge ${errorCount > 0 ? 'error' : 'warn'}`}>{issues.length}件</span>
            )}
          </h3>
          <button ref={closeRef} className="x" aria-label="閉じる" title="閉じる" onClick={close}>
            ×
          </button>
        </div>

        {issues.length === 0 ? (
          <p className="vd-ok">✔ 問題は見つかりませんでした。</p>
        ) : (
          <div className="vd-scroll">
            {groups.map((g) => (
              <section className="vd-section" key={g.category}>
                <h4 className="vd-section-h">
                  {g.label} <span className="vd-section-n">{g.issues.length}</span>
                </h4>
                <ul className="vd-list">
                  {g.issues.map((iss, i) => {
                    const plan = planLintJump(iss, project.core);
                    const clickable = plan.kind !== 'none';
                    const name = iss.taskId ? project.core.tasks[iss.taskId]?.name ?? '' : '';
                    const code = iss.taskId ? codes[iss.taskId] ?? '' : '';
                    return (
                      <li
                        key={`${iss.ref}-${i}`}
                        className={`vd-row${clickable ? ' clickable' : ''}${iss.severity === 'error' ? ' error' : ''}`}
                        role={clickable ? 'button' : undefined}
                        tabIndex={clickable ? 0 : undefined}
                        title={clickable ? 'クリックでこの工程へ移動' : undefined}
                        onClick={clickable ? () => jump(iss) : undefined}
                        onKeyDown={
                          clickable
                            ? (e) => {
                                if (e.key === 'Enter' || e.key === ' ') {
                                  e.preventDefault();
                                  jump(iss);
                                }
                              }
                            : undefined
                        }
                      >
                        {code && <span className="vd-code">{code}</span>}
                        {name ? (
                          <span className="vd-name">{name}</span>
                        ) : (
                          <span className="vd-name dim">{iss.ref}</span>
                        )}
                        <span className="vd-msg">{iss.message}</span>
                      </li>
                    );
                  })}
                </ul>
              </section>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
