// 画面下部のステータスバー。工程数・担当数・合計工数・現在ビュー・保存状態を一目で。
// 右側にアクティブペイン別のキー操作ヒントと g リーダー待機チップ(発見性)。
import { useEffect, useMemo, useState } from 'react';
import type { ProcessLevel } from '@gantt-flow/core';
import { computeEffortRollups, computeHearingProgress, formatHours } from '@gantt-flow/core';
import { getActiveKeymap, chordKeys, type KeyBinding } from '../keymap';
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

// アクティブペイン別のキー操作ヒント（右側の st-hint）。表示するキーは実効キーマップ
// （getActiveKeymap＝ユーザー上書き＋シングルキーOFFフィルタ適用済み）から解決するので、
// 「見えるヒント」と「実際に効くキー」が常に一致する。各スロットは候補 binding id を
// 優先順に持ち、実効キーマップに在る最初のものを採用する（単キーは OFF 時に消えるため、
// 自動的に矢印/修飾キー版へ落ちる＝OFF時は修飾キー系のみ・ON時は単キーも表示）。
export interface KeyHint {
  keys: string;
  label: string;
}
interface HintSpec {
  label: string;
  slots: string[][];
}

const PANE_HINT_SPECS: Record<'table' | 'flow', HintSpec[]> = {
  table: [
    { label: '移動', slots: [['row-next', 'row-next-arrow'], ['row-prev', 'row-prev-arrow']] },
    { label: '編集', slots: [['row-edit']] },
    { label: '追加', slots: [['row-add']] },
    { label: 'コマンド', slots: [['palette']] },
    { label: '一覧', slots: [['help']] },
  ],
  flow: [
    { label: '選択', slots: [['node-left'], ['node-right']] },
    { label: '接続', slots: [['connect-mode']] },
    { label: 'コマンド', slots: [['palette']] },
    { label: '一覧', slots: [['help']] },
  ],
};

function keyOf(km: KeyBinding[], ids: string[]): string | null {
  for (const id of ids) {
    const b = km.find((x) => x.id === id);
    if (b) return chordKeys(b.chord, b.leader).join('');
  }
  return null;
}

// pane のキーヒントを実効キーマップから生成（最大 max 個。トーン・密度は従来維持）。
export function paneKeyHints(km: KeyBinding[], pane: 'table' | 'flow', max = 5): KeyHint[] {
  const out: KeyHint[] = [];
  for (const spec of PANE_HINT_SPECS[pane]) {
    const parts = spec.slots.map((s) => keyOf(km, s)).filter((x): x is string => x !== null);
    if (parts.length === 0) continue;
    out.push({ keys: parts.join('/'), label: spec.label });
    if (out.length >= max) break;
  }
  return out;
}

export function StatusBar() {
  const project = useApp((s) => s.project);
  const level = useApp((s) => s.level);
  const scopeParentId = useApp((s) => s.scopeParentId);
  const selectedTaskId = useApp((s) => s.selectedTaskId);
  const dirty = useApp((s) => s.dirty);
  const activePane = useUI((s) => s.activePane);
  const mainView = useUI((s) => s.mainView);
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
  const selectedName = selectedTaskId ? project.core.tasks[selectedTaskId]?.name : null;
  // ヒアリング進捗（末端工程のうち着手済=heard+review+done の割合）。サマリと同一集計を共有。
  const hearing = useMemo(
    () => computeHearingProgress(project.core, project.details),
    [project.core, project.details],
  );
  const setOverlay = useUI((s) => s.setOverlay);
  const hearingDone = hearing.total > 0 && hearing.heard === hearing.total;

  // キーヒントは実効キーマップから生成（singleKey トグルでキャッシュが無効化されるので依存に入れる）。
  // 手順書タブは表/フローと操作系が異なる（ステップ選択・削除）ので、その実挙動に合わせた
  // 固定ヒントへ差し替える（ProcedureView の window keydown: Delete=削除 / Esc=選択解除）。
  const hintText = useMemo(
    () =>
      mainView === 'procedure'
        ? 'クリックで選択・Delete で削除・Esc で解除'
        : paneKeyHints(getActiveKeymap(), activePane)
            .map((h) => `${h.keys} ${h.label}`)
            .join('・'),
    // singleKey は再計算トリガ（getActiveKeymap の中身が変わる）。
    [activePane, singleKey, mainView],
  );

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
      <span className="st-sep" aria-hidden="true" />
      <button
        type="button"
        className={`st-item st-hearing${hearingDone ? ' is-done' : ''}`}
        onClick={() => setOverlay('summary')}
        aria-haspopup="dialog"
        title="ヒアリング済みの末端工程数／末端工程の総数。クリックでサマリを開く（未着手・確認待ちの残りを確認）"
      >
        ヒアリング <strong>{hearing.heard}/{hearing.total}</strong>
      </button>
      <span className="st-spacer" />
      {leaderPending ? (
        <span className="st-item st-leader" aria-live="polite" title="g に続けて t=表 / f=フロー / i=課題 / s=サマリ / 1〜4=粒度">
          <kbd>g</kbd> 続けてキーを入力…
        </span>
      ) : (
        <span className="st-item st-hint" title="ショートカット一覧は ? キー">
          {hintText}
        </span>
      )}
      {selectedName && (
        <>
          <span className="st-sep" aria-hidden="true" />
          <span className="st-item st-selected" title="選択中の工程">
            選択: <strong>{selectedName || '（無題）'}</strong>
          </span>
        </>
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
            title="未保存データの自動退避（クラッシュ復旧用）の直近状況。ファイルへの保存（Ctrl+S）とは別物です"
          >
            退避: {persist.autosave.text}
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
