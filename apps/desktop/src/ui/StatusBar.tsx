// 画面下部のステータスバー。工程数・担当数・合計工数・現在ビュー・保存状態を一目で。
import type { ProcessLevel } from '@gantt-flow/core';
import { effortRollupMinutes, formatHours } from '@gantt-flow/core';
import { useApp } from '../store';

const LEVEL_LABEL: Record<ProcessLevel, string> = {
  large: '大',
  medium: '中',
  small: '小',
  detail: '詳細',
};

export function StatusBar() {
  const project = useApp((s) => s.project);
  const level = useApp((s) => s.level);
  const scopeParentId = useApp((s) => s.scopeParentId);
  const dirty = useApp((s) => s.dirty);

  const tasks = Object.values(project.core.tasks);
  const byLevel = (l: ProcessLevel) => tasks.filter((t) => t.level === l).length;
  const roots = tasks.filter((t) => !t.parentId);
  const totalMin = roots.reduce((s, t) => s + effortRollupMinutes(project.core, project.details, t.id), 0);
  const assignees = Object.keys(project.core.assignees).length;
  const scopeName = scopeParentId ? project.core.tasks[scopeParentId]?.name : null;

  return (
    <footer className="statusbar" aria-label="ステータス">
      <span className="st-item" title="工程の総数（粒度別の内訳）">
        工程 <strong>{tasks.length}</strong>
        <span className="st-sub">
          （大{byLevel('large')}・中{byLevel('medium')}・小{byLevel('small')}・詳細{byLevel('detail')}）
        </span>
      </span>
      <span className="st-sep" aria-hidden="true" />
      <span className="st-item" title="登場する担当（部門/個人）の数">
        担当 <strong>{assignees}</strong>
      </span>
      <span className="st-sep" aria-hidden="true" />
      <span className="st-item" title="末端工程の合計工数（自動集計）">
        合計工数 <strong>{formatHours(totalMin)}</strong>
      </span>
      <span className="st-spacer" />
      <span className="st-item st-view" title="フローで表示中の粒度とスコープ">
        表示: {LEVEL_LABEL[level]}
        {scopeName ? ` / ${scopeName}` : ' / 全体'}
      </span>
      <span className="st-sep" aria-hidden="true" />
      <span className={`st-item st-save${dirty ? ' is-dirty' : ''}`} aria-live="polite">
        <span className="st-dot" aria-hidden="true" />
        {dirty ? '未保存' : '保存済み'}
      </span>
    </footer>
  );
}
