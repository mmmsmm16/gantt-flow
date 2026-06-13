// 画面下部のステータスバー。工程数・担当数・合計工数・現在ビュー・保存状態を一目で。
// 右側にアクティブペイン別のキー操作ヒントと g リーダー待機チップ(発見性)。
import { useMemo } from 'react';
import type { ProcessLevel } from '@gantt-flow/core';
import { computeEffortRollups, formatHours } from '@gantt-flow/core';
import { useApp } from '../store';
import { useUI } from './useUI';

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
  const activePane = useUI((s) => s.activePane);
  const leaderPending = useUI((s) => s.leaderPending);
  const singleKey = useUI((s) => s.singleKey);

  // To-Be 新設工程(toBe.lifecycle='added')は As-Is の集計に含めない。
  const tasks = Object.values(project.core.tasks).filter((t) => project.details[t.id]?.toBe?.lifecycle !== 'added');
  const byLevel = (l: ProcessLevel) => tasks.filter((t) => t.level === l).length;
  const roots = tasks.filter((t) => !t.parentId);
  // 集計工数はコミット時に 1 回だけ計算（ルートごとに effortRollupMinutes を呼ぶと
  // そのたび全マップを再構築して O(n²) になる）。
  const effortRollups = useMemo(
    () => computeEffortRollups(project.core, project.details),
    [project.core, project.details],
  );
  const totalMin = roots.reduce((s, t) => s + (effortRollups.get(t.id) ?? 0), 0);
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
      {leaderPending ? (
        <span className="st-item st-leader" aria-live="polite" title="g に続けて t=表 / f=フロー / i=課題 / s=サマリ / 1〜4=粒度">
          <kbd>g</kbd> 続けてキーを入力…
        </span>
      ) : (
        <span className="st-item st-hint" title="ショートカット一覧は ? キー">
          {activePane === 'table'
            ? singleKey
              ? 'j/k 移動・Enter 編集・n 追加・? 一覧'
              : '↑↓ 移動・Enter 編集・⌘K コマンド・? 一覧'
            : singleKey
              ? '矢印で選択・Alt+矢印で移動・c 接続・? 一覧'
              : '矢印で選択・Alt+矢印で移動・⌘K コマンド・? 一覧'}
        </span>
      )}
      <span className="st-sep" aria-hidden="true" />
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
