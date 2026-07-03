// 画面下部のステータスバー。工程数・担当数・合計工数・現在ビュー・保存状態を一目で。
// 右側にアクティブペイン別のキー操作ヒントと g リーダー待機チップ(発見性)。
import { useEffect, useMemo, useState } from 'react';
import type { ProcessLevel } from '@gantt-flow/core';
import { computeEffortRollups, formatHours } from '@gantt-flow/core';
import { useApp } from '../store';
import { useUI, type PersistKind, type LockUiState } from './useUI';

const LEVEL_LABEL: Record<ProcessLevel, string> = {
  large: '大',
  medium: '中',
  small: '小',
  detail: '詳細',
};

// 自動保存の「n秒前」の緩い相対表記。now を引数に取り決定論的にテストできる。
export function formatRelTime(ms: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 60) return `${s}秒前`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}分前`;
  return `${Math.floor(m / 60)}時間前`;
}

export interface PersistIndicators {
  /** 自動保存インジケータ（text=「n秒前」or「失敗」）。null=表示しない（新規で退避なし）。 */
  autosave: { text: string; failed: boolean } | null;
  /** 助言ロックインジケータ。null=表示しない（ファイル未割当）。 */
  lock: { text: string; readonly: boolean } | null;
}

// StatusBar の永続化インジケータの表示内容を決める純関数（描画から分離してテスト可能に）。
// 保存系（自動保存/バックアップ）の失敗は「失敗」、ロック失敗はロック側で示す。
export function persistIndicators(
  lastAutosaveAt: number | null,
  persistFailure: { kind: PersistKind } | null,
  lockState: LockUiState | null,
  now = Date.now(),
): PersistIndicators {
  const saveFailed = persistFailure != null && persistFailure.kind !== 'lock';
  const autosave = saveFailed
    ? { text: '失敗', failed: true }
    : lastAutosaveAt != null
      ? { text: formatRelTime(lastAutosaveAt, now), failed: false }
      : null;
  const lock =
    lockState != null
      ? {
          text: lockState === 'holding' ? '編集中ロック保持' : '読み取り専用',
          readonly: lockState === 'readonly',
        }
      : null;
  return { autosave, lock };
}

export function StatusBar() {
  const project = useApp((s) => s.project);
  const level = useApp((s) => s.level);
  const scopeParentId = useApp((s) => s.scopeParentId);
  const dirty = useApp((s) => s.dirty);
  const activePane = useUI((s) => s.activePane);
  const leaderPending = useUI((s) => s.leaderPending);
  const singleKey = useUI((s) => s.singleKey);
  // 永続化の健全性（沈黙する失敗を可視化）: 直近の自動保存時刻・失敗・助言ロック状態。
  const lastAutosaveAt = useUI((s) => s.lastAutosaveAt);
  const persistFailure = useUI((s) => s.persistFailure);
  const lockState = useUI((s) => s.lockState);

  // アイドル時も相対時刻を緩やかに更新する（20秒ごと。編集中は再描画が頻繁なので粗くて十分）。
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (lastAutosaveAt == null) return;
    const id = setInterval(() => setTick((n) => n + 1), 20_000);
    return () => clearInterval(id);
  }, [lastAutosaveAt]);

  const persist = useMemo(
    () => persistIndicators(lastAutosaveAt, persistFailure, lockState),
    // tick は相対時刻の緩い再計算トリガ（値自体は使わない）。
    [lastAutosaveAt, persistFailure, lockState, tick],
  );

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
      {persist.autosave && (
        <>
          <span className="st-sep" aria-hidden="true" />
          <span
            className={`st-item st-autosave${persist.autosave.failed ? ' is-failed' : ''}`}
            aria-live="polite"
            title="未保存データの自動退避（クラッシュ復旧用）の直近状況"
          >
            自動保存: {persist.autosave.text}
          </span>
        </>
      )}
      {persist.lock && (
        <>
          <span className="st-sep" aria-hidden="true" />
          <span
            className={`st-item st-lock${persist.lock.readonly ? ' is-readonly' : ''}`}
            title="このファイルの編集ロック状態（同時編集の助言ロック）"
          >
            {persist.lock.text}
          </span>
        </>
      )}
      <span className="st-sep" aria-hidden="true" />
      <span className={`st-item st-save${dirty ? ' is-dirty' : ''}`} aria-live="polite">
        <span className="st-dot" aria-hidden="true" />
        {dirty ? '未保存' : '保存済み'}
      </span>
    </footer>
  );
}
