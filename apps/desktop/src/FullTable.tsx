// 全項目フル表（完全な工程表ビュー）。全工程を行・全フィールドを列にした 1 枚の編集グリッド。
// 粒度は 大/中/小/詳細工程の 4 列（各行は自分の粒度の列に作業名、上位列に親の工程名を再掲）。
// 課題/方策は独立列。列の表示切替・並べ替え・幅のドラッグ調整、テキスト列は折り返して全文表示。
// 行操作（追加/削除/選択）と Enter でのセル移動をやりやすく。
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ProcessTask, ProcessLevel, Id, Automation, Difficulty, IoKind, Dependency, TaskStatus } from '@gantt-flow/core';
import { computeCodes, computeEffortRollups, effortMinutesToHours, formatHours, bridgePredMap, isMilestone } from '@gantt-flow/core';
import { useApp } from './store';
import { collectIoNames, buildPrevCandidateIndex } from './suggestions';
import { PrevCandidateOptions } from './PrevCandidateOptions';
import { validateEffort, markEffortInvalid, clearEffortInvalid, isEffortBlurUnchanged } from './parseEffort';
import { cancelEditOnEscape, selectAllOnFocus, nameEscapeAction } from './inputBehaviors';
import { nameLenClass, nameLenTitle, onNameInput } from './nameLimit';
import { isImeKeyEvent } from './keymap';
import { confirmRemoveTasks, removeDependencyWithUndo, removeIoWithUndo, removeIssueWithUndo } from './taskOps';
import { useUI } from './ui/useUI';
import { STATUS_OPTIONS, statusSelectClass } from './statusUi';
import { useFlashIds } from './ui/useFlash';
import { Menu, MenuCheckItem } from './ui/Menu';
import { useRowSelectionKeys, scrollRowIntoView } from './ui/useRowSelectionKeys';
import { useRowMultiSelect } from './ui/useRowMultiSelect';
import { TASK_COLORS } from './theme';
import * as Icons from './ui/icons';

const AUTOMATION: { key: Automation | ''; label: string }[] = [
  { key: '', label: '—' },
  { key: 'manual', label: '手作業' },
  { key: 'system', label: 'システム自動' },
  { key: 'partial', label: '一部自動' },
];
const DIFFICULTY: (Difficulty | '')[] = ['', 'H', 'M', 'L'];
const DIFF_RANK: Record<string, number> = { H: 3, M: 2, L: 1, '': 0 };
// 状況（ヒアリング進行）のソート順（ソート固有。表示は statusUi の STATUS_OPTIONS に一元化）。
const STATUS_RANK: Record<string, number> = { done: 4, review: 3, heard: 2, todo: 1, '': 0 };

// 列定義のシングルソース（この配列の並び＝表示順）。既定幅・表示切替メニュー・並べ替え可否・
// h/l 列カーソルの対象はすべてここから導出するので、列の追加・並べ替えはこの配列だけを編集する。
export interface FtCol {
  key: string;
  /** ヘッダと列メニューの表示名。 */
  label: string;
  /** 既定の列幅(px)。 */
  width: number;
  /** ヘッダ th の追加クラス（粒度列は sticky 系を動的に付けるので不要）。 */
  cls?: string;
  /** 列メニューで表示切替できる列（No. と操作列以外）。 */
  optional?: boolean;
  /** h/l 列カーソルの対象（data-cell キー。粒度列は data-cell="name" として先頭に別枠で入る）。 */
  cursorable?: boolean;
  /** ヘッダクリックで並べ替えできる列。 */
  sortable?: boolean;
  /** 粒度列（大/中/小/詳細）。 */
  level?: ProcessLevel;
}
export const FT_COLUMNS: readonly FtCol[] = [
  { key: 'no', label: 'No.', width: 48 },
  { key: 'large', label: '大工程', width: 110, optional: true, sortable: true, level: 'large' },
  { key: 'medium', label: '中工程', width: 110, optional: true, sortable: true, level: 'medium' },
  { key: 'small', label: '小工程', width: 110, optional: true, sortable: true, level: 'small' },
  { key: 'detail', label: '詳細工程', width: 110, optional: true, sortable: true, level: 'detail' },
  { key: 'assignee', label: '担当', width: 110, cls: 'ft-c-assignee', optional: true, cursorable: true, sortable: true },
  { key: 'status', label: '状況', width: 104, cls: 'ft-c-status', optional: true, cursorable: true, sortable: true },
  { key: 'prev', label: '前工程', width: 150, cls: 'ft-c-prev', optional: true, cursorable: true },
  { key: 'effort', label: '工数', width: 64, cls: 'ft-c-effort', optional: true, cursorable: true, sortable: true },
  { key: 'how', label: '業務内容', width: 200, cls: 'ft-c-text', optional: true, cursorable: true },
  { key: 'system', label: '使用システム', width: 170, cls: 'ft-c-text', optional: true, cursorable: true },
  { key: 'inputs', label: '入力', width: 168, cls: 'ft-c-io', optional: true, cursorable: true },
  { key: 'outputs', label: '出力', width: 168, cls: 'ft-c-io', optional: true, cursorable: true },
  { key: 'issue', label: '課題', width: 200, cls: 'ft-c-issue', optional: true, cursorable: true },
  { key: 'measure', label: '方策', width: 200, cls: 'ft-c-issue', optional: true, cursorable: true },
  { key: 'note', label: '備考', width: 200, cls: 'ft-c-text', optional: true, cursorable: true },
  { key: 'volume', label: 'ボリューム', width: 130, cls: 'ft-c-sm', optional: true, cursorable: true },
  { key: 'exception', label: '例外対応', width: 180, cls: 'ft-c-text', optional: true, cursorable: true },
  { key: 'automation', label: '自動化', width: 108, cls: 'ft-c-auto', optional: true, cursorable: true, sortable: true },
  { key: 'dataLink', label: 'データ連携先', width: 140, cls: 'ft-c-sm', optional: true, cursorable: true },
  { key: 'regulation', label: '関連規程', width: 140, cls: 'ft-c-sm', optional: true, cursorable: true },
  { key: 'difficulty', label: '難易度', width: 62, cls: 'ft-c-diff', optional: true, cursorable: true, sortable: true },
  { key: 'act', label: '', width: 96 },
];
const LEVELS: { key: ProcessLevel; label: string }[] = FT_COLUMNS.flatMap((c) =>
  c.level ? [{ key: c.level, label: c.label }] : [],
);
const DEFAULT_W: Record<string, number> = Object.fromEntries(FT_COLUMNS.map((c) => [c.key, c.width]));
const TOGGLE_COLS = FT_COLUMNS.filter((c) => c.optional);
const SORTABLE = new Set(FT_COLUMNS.filter((c) => c.sortable).map((c) => c.key));
// 大規模案件での描画負荷対策: まず CHUNK 行だけ描画し、末尾に近づいたら追加で描画する
// （行の編集状態を壊さない逐次レンダリング。仮想化と違い描画済み行は外さない）。
const ROW_CHUNK = 150;

function flatten(tasks: ProcessTask[]): ProcessTask[] {
  const byParent = new Map<Id | undefined, ProcessTask[]>();
  for (const t of tasks) {
    const k = t.parentId ?? undefined;
    const arr = byParent.get(k);
    if (arr) arr.push(t);
    else byParent.set(k, [t]);
  }
  for (const arr of byParent.values()) arr.sort((a, b) => a.order - b.order);
  const out: ProcessTask[] = [];
  const walk = (parentId: Id | undefined) => {
    for (const t of byParent.get(parentId) ?? []) {
      out.push(t);
      walk(t.id);
    }
  };
  walk(undefined);
  return out;
}

function ancestryNames(t: ProcessTask, byId: Record<Id, ProcessTask>): Partial<Record<ProcessLevel, string>> {
  const out: Partial<Record<ProcessLevel, string>> = {};
  let cur: ProcessTask | undefined = t;
  while (cur) {
    out[cur.level] = cur.name;
    cur = cur.parentId ? byId[cur.parentId] : undefined;
  }
  return out;
}

// ヘッダセル。FullTable の中で定義するとレンダーごとにコンポーネントの同一性が変わり
// 全ヘッダが再マウントされてしまう（フォーカス喪失・無駄な描画）ため、モジュールスコープに置く。
function Th({
  k,
  label,
  cls,
  style,
  sort,
  clickSort,
  startResize,
}: {
  k: string;
  label: string;
  cls?: string;
  style?: React.CSSProperties;
  sort: { key: string; dir: 'asc' | 'desc' } | null;
  clickSort: (key: string) => void;
  startResize: (key: string, e: React.PointerEvent) => void;
}) {
  const active = sort?.key === k;
  return (
    <th className={`${cls ?? ''}${active ? ' sorted' : ''}`} style={style}>
      {SORTABLE.has(k) ? (
        <button className="ft-sort" onClick={() => clickSort(k)} title={`${label}で並べ替え`}>
          {label}
          <span className="ft-sortmark">{active ? (sort!.dir === 'asc' ? '▲' : '▼') : '⇅'}</span>
        </button>
      ) : (
        label
      )}
      <span className="ft-resize" onPointerDown={(e) => startResize(k, e)} title="ドラッグで列幅を調整" />
    </th>
  );
}

export function FullTable() {
  const project = useApp((s) => s.project);
  const selectedTaskId = useApp((s) => s.selectedTaskId);
  const select = useApp((s) => s.select);
  const renameTask = useApp((s) => s.renameTask);
  const removeTask = useApp((s) => s.removeTask);
  const setAssigneeByName = useApp((s) => s.setAssigneeByName);
  const updateDetail = useApp((s) => s.updateDetail);
  const addIo = useApp((s) => s.addIo);
  const updateIo = useApp((s) => s.updateIo);
  const addIssue = useApp((s) => s.addIssue);
  const addIssueWithMeasure = useApp((s) => s.addIssueWithMeasure);
  const updateIssue = useApp((s) => s.updateIssue);
  const addDependency = useApp((s) => s.addDependency);
  const addRootTask = useApp((s) => s.addRootTask);
  const addMilestone = useApp((s) => s.addMilestone);
  const addSiblingOf = useApp((s) => s.addSiblingOf);
  const duplicateTask = useApp((s) => s.duplicateTask);
  const pasteRowsAsTasks = useApp((s) => s.pasteRowsAsTasks);
  // フローのレーン移動で担当が書き戻った工程は、担当セルを一時ハイライトして変更点を示す。
  const lastAssigneeSync = useApp((s) => s.lastAssigneeSync);
  const assigneeFlash = useFlashIds(lastAssigneeSync);
  const ftColumns = useUI((s) => s.ftColumns);
  const toggleFtColumn = useUI((s) => s.toggleFtColumn);
  const ftColWidths = useUI((s) => s.ftColWidths);
  const setFtColWidth = useUI((s) => s.setFtColWidth);

  const [sort, setSort] = useState<{ key: string; dir: 'asc' | 'desc' } | null>(null);
  // 絞り込み（AND 条件）。担当・課題あり・工数未入力・自動化区分。
  const [filters, setFilters] = useState<{
    assignee: string;
    issues: boolean;
    noEffort: boolean;
    automation: Automation | '';
  }>({ assignee: '', issues: false, noEffort: false, automation: '' });
  const [resizing, setResizing] = useState<{ key: string; w: number } | null>(null);
  const [focusTask, setFocusTask] = useState<Id | null>(null);
  // 複合セル（課題/入出力）へ追加した直後、その新しい入力欄へフォーカス＆全選択する対象。
  // 追加 op の直後に {taskId, cell} を立て、再描画後に当該セルの最後の入力へ寄せる。
  const [addFocus, setAddFocus] = useState<{ taskId: Id; cell: string } | null>(null);
  // 逐次レンダリング: 現在描画している行数（センチネルが見えたら増やす）。
  const [renderCount, setRenderCount] = useState(ROW_CHUNK);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const tableRef = useRef<HTMLTableElement>(null);

  const byId = project.core.tasks;
  // プロジェクト由来の導出はコミット時のみ変わる。選択移動や列カーソル移動の再レンダリングで
  // 全体を再計算しないよう useMemo で固定する（特にブリッジ導出と工程番号は全件走査）。
  // To-Be 新設工程(toBe.lifecycle='added')は As-Is の工程表には出さない。
  const tasks = useMemo(
    () => Object.values(byId).filter((t) => project.details[t.id]?.toBe?.lifecycle !== 'added'),
    [byId, project.details],
  );
  const codes = useMemo(() => computeCodes(project.core), [project.core]);
  // 親(大)同士の接続から導出される前工程(フローのブリッジと同じ)。表でも見せて同期ずれを無くす。
  const bridgePreds = useMemo(() => bridgePredMap(project.core), [project.core]);
  const assigneeNames = useMemo(
    () => [...new Set(Object.values(project.core.assignees).map((a) => a.name))],
    [project.core.assignees],
  );
  const ioNames = useMemo(() => collectIoNames(project), [project]);
  const parentsWithChildren = useMemo(
    () => new Set(tasks.map((t) => t.parentId).filter(Boolean) as Id[]),
    [tasks],
  );
  // 行ごとの deps.filter 走査を避けるため、前工程（to が自分）の依存を一度だけ束ねておく。
  const predsByTo = useMemo(() => {
    const m = new Map<Id, Dependency[]>();
    for (const dep of Object.values(project.core.dependencies)) {
      const arr = m.get(dep.to);
      if (arr) arr.push(dep);
      else m.set(dep.to, [dep]);
    }
    return m;
  }, [project.core.dependencies]);
  // 前工程セルの候補はアウトライン・パレットと共用のインデックス(prevCandidates と同結果)に一本化。
  // コミット時に 1 回だけ構築し、行ごとに全工程・全依存をなめ直さない(O(行×全件) の再計算を防ぐ)。
  const prevCandidatesOf = useMemo(() => buildPrevCandidateIndex(project), [project]);
  // 集計工数(親=子孫の合計)。ソート比較器・行表示から effortRollupMinutes を呼ぶと毎回
  // 全マップを再構築して O(n²) になるため、コミット時に 1 回だけ計算して Map 参照にする。
  const effortRollups = useMemo(
    () => computeEffortRollups(project.core, project.details),
    [project.core, project.details],
  );

  const vis = (k: string) => ftColumns[k] !== false;
  const width = (k: string) => (resizing?.key === k ? resizing.w : ftColWidths[k] ?? DEFAULT_W[k]!);
  const visibleCols = FT_COLUMNS.filter((c) => !c.optional || vis(c.key));
  const visLevels = LEVELS.filter((l) => vis(l.key));
  const levelLeft = (key: ProcessLevel) => {
    let x = width('no');
    for (const l of visLevels) {
      if (l.key === key) return x;
      x += width(l.key);
    }
    return x;
  };
  const lastStickyKey = visLevels.length ? visLevels[visLevels.length - 1]!.key : null;

  // センチネル（表の末尾）が見えたら次のチャンクを描画。
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el) return undefined;
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) setRenderCount((c) => c + ROW_CHUNK);
    });
    io.observe(el);
    return () => io.disconnect();
  });

  const sortValue = (key: string, t: ProcessTask): number | string => {
    if (key === 'effort') return effortRollups.get(t.id) ?? 0;
    if (key === 'assignee') return t.assigneeId ? project.core.assignees[t.assigneeId]?.name ?? '' : '';
    if (key === 'difficulty') return DIFF_RANK[project.details[t.id]?.difficulty ?? ''] ?? 0;
    if (key === 'status') return STATUS_RANK[project.details[t.id]?.status ?? ''] ?? 0;
    if (key === 'automation') return project.details[t.id]?.automation ?? '';
    if (key === 'large' || key === 'medium' || key === 'small' || key === 'detail')
      return ancestryNames(t, byId)[key] ?? '';
    return 0;
  };

  const flat = useMemo(() => flatten(tasks), [tasks]);
  let rows = flat;
  if (sort) {
    rows = [...flat].sort((x, y) => {
      const a = sortValue(sort.key, x);
      const b = sortValue(sort.key, y);
      const c = typeof a === 'number' && typeof b === 'number' ? a - b : String(a).localeCompare(String(b), 'ja');
      return c * (sort.dir === 'asc' ? 1 : -1);
    });
  }

  // 絞り込みを適用（表示行を減らすだけ。階層の文脈列は各行が祖先名を出すので破綻しない）。
  const filterActive =
    !!filters.assignee || filters.issues || filters.noEffort || !!filters.automation;
  if (filterActive) {
    rows = rows.filter((t) => {
      const d = project.details[t.id];
      if (filters.assignee) {
        const name = t.assigneeId ? project.core.assignees[t.assigneeId]?.name ?? '' : '';
        if (name !== filters.assignee) return false;
      }
      if (filters.issues && !(d?.issues ?? []).some((i) => i.issue.trim())) return false;
      if (filters.noEffort) {
        // 工数未入力＝末端工程で effortMinutes が無い（親はロールアップ表示なので対象外）。
        if (parentsWithChildren.has(t.id) || d?.effortMinutes != null) return false;
      }
      if (filters.automation && d?.automation !== filters.automation) return false;
      return true;
    });
  }
  const clearFilters = () =>
    setFilters({ assignee: '', issues: false, noEffort: false, automation: '' });

  // 逐次レンダリング: 描画するのは先頭 renderCount 行。末尾センチネルが見えたら拡張。
  const renderRows = rows.length > renderCount ? rows.slice(0, renderCount) : rows;
  const hasMore = rows.length > renderCount;

  // 新規追加した工程の作業名にフォーカス（連続入力）。行が未描画なら、その行まで一度だけ
  // 描画数を広げる。絞り込みで行が出ない・名前列が非表示などで入力が現れない場合は諦める
  // （renderCount を伸ばし続ける無限再レンダリングを防ぐ）。
  // 新規作成直後の作業名へ即フォーカス＆全選択（描画直後に同期実行＝空振り防止）。
  useLayoutEffect(() => {
    if (!focusTask) return;
    const el = tableRef.current?.querySelector<HTMLInputElement>(`input[data-task="${CSS.escape(focusTask)}"]`);
    if (el) {
      el.focus();
      el.select();
      setFocusTask(null);
      return;
    }
    const idx = rows.findIndex((t) => t.id === focusTask);
    if (idx >= renderCount) setRenderCount(Math.ceil((idx + 1) / ROW_CHUNK) * ROW_CHUNK);
    else setFocusTask(null);
  }, [focusTask, rows, renderCount]);

  // 複合セルへの追加直後、新しい入力欄（そのセルの末尾の input/textarea）へフォーカス＆全選択。
  // 既定文字（「課題」「帳票」）が選択状態になるので、そのまま打てば置き換わる＝直感的に編集できる。
  useLayoutEffect(() => {
    if (!addFocus) return;
    const cellEl = tableRef.current?.querySelector(
      `tr[data-taskid="${CSS.escape(addFocus.taskId)}"] [data-cell="${CSS.escape(addFocus.cell)}"]`,
    );
    const inputs = cellEl?.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('input, textarea');
    const last = inputs && inputs.length ? inputs[inputs.length - 1] : null;
    if (last) {
      last.focus();
      last.select();
    }
    setAddFocus(null);
  }, [addFocus, project]);

  const clickSort = (key: string) =>
    setSort((cur) => (cur?.key !== key ? { key, dir: 'asc' } : cur.dir === 'asc' ? { key, dir: 'desc' } : null));

  // 行選択モード(編集外のキーボード操作)。アウトラインと同じ操作系を共有フックで。
  const activePane = useUI((s) => s.activePane);
  // 列カーソルの対象(表示中の列を定義順で。data-cell 属性と対応)。粒度列は自分の作業名
  // セル(data-cell="name")としてまとめて先頭に置く。I/O・課題・方策・前工程は複合セル
  // (td に data-cell を付け、Enter で中の最初の入力へ)。
  const cursorColumns = [
    'name',
    ...FT_COLUMNS.filter((c) => c.cursorable && vis(c.key)).map((c) => c.key),
  ];
  // 末尾ゴースト行: 最終行と同じ親・粒度で新規工程を起こし、その作業名入力へフォーカス（連続入力）。
  const addGhostRow = () => {
    const last = rows[rows.length - 1];
    if (!last) return;
    const nid = addSiblingOf(last.id);
    if (nid) setFocusTask(nid);
  };
  const { colIdx, editNavKeyDown } = useRowSelectionKeys({
    enabled: activePane === 'table',
    orderedIds: rows.map((t) => t.id),
    columns: cursorColumns,
    beginEdit: (id) => setFocusTask(id), // 自粒度の作業名入力へ(未描画なら描画数を広げて待つ)
    onEditNavPastEnd: addGhostRow, // 最終行で Enter 下移動 → 末尾に新規行を起こす
  });
  const cursorCol = cursorColumns[colIdx];
  const cellCursorCls = (taskId: Id, key: string) =>
    taskId === selectedTaskId && activePane === 'table' && cursorCol === key ? ' cell-cursor' : '';

  // キーボード移動で選択が未描画領域に入ったら、その行まで描画数を広げる。
  useEffect(() => {
    if (!selectedTaskId) return;
    const idx = rows.findIndex((t) => t.id === selectedTaskId);
    if (idx >= renderCount) setRenderCount(Math.ceil((idx + 1) / ROW_CHUNK) * ROW_CHUNK);
  }, [selectedTaskId, rows, renderCount]);

  // 選択中の工程が変わったら、その行が画面外のとき視点を寄せる（フロー→表追従）。
  // renderCount を deps に入れない＝ユーザーのスクロール（行追加描画）で視点が戻らないように。
  // 上の effect が同コミットで描画数を広げるので、rAF 後には対象行が描画済み。
  useEffect(() => {
    if (!selectedTaskId) return;
    const raf = requestAnimationFrame(() => scrollRowIntoView(selectedTaskId));
    return () => cancelAnimationFrame(raf);
  }, [selectedTaskId]);

  // 行クリック（通常＝単一選択、Ctrl/⌘＝トグル、Shift＝範囲）と一括操作は共有フックに集約。
  // 範囲は表示順（ソート・絞り込み反映済み）の rows 内で解決する。
  const {
    marked,
    onRowClick,
    clear: clearMarked,
    bulkAssign,
    bulkLevel,
    bulkEffort,
    bulkDelete,
  } = useRowMultiSelect({ orderedIds: rows.map((r) => r.id), onActivate: select });

  // クリップボード（Excel/表計算）の各行を工程として一括追加。タブ区切り [作業名, 担当?]。
  const onPasteRows = async () => {
    let text: string;
    try {
      text = await navigator.clipboard.readText();
    } catch {
      useUI.getState().toast('クリップボードを読み取れませんでした（ブラウザの許可が必要です）。', 'error');
      return;
    }
    const parsed = text.replace(/\r\n?/g, '\n').split('\n').map((l) => l.split('\t'));
    const n = pasteRowsAsTasks(parsed);
    if (n) useUI.getState().toast(`${n}件の工程を貼り付けました。`, 'success');
    else useUI.getState().toast('貼り付ける行がありませんでした。', 'info');
  };

  // 列幅のドラッグ調整。
  const startResize = (key: string, e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const startW = width(key);
    setResizing({ key, w: startW });
    const onMove = (ev: PointerEvent) => setResizing({ key, w: Math.max(40, startW + (ev.clientX - startX)) });
    const onUp = (ev: PointerEvent) => {
      setFtColWidth(key, Math.max(40, startW + (ev.clientX - startX)));
      setResizing(null);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  const taskOfEvent = (e: React.KeyboardEvent): Id | null =>
    (e.target as HTMLElement).closest('tr')?.getAttribute('data-taskid') ?? null;

  // キーボード操作:
  //  Ctrl/⌘+Enter … 現在行の次に行を追加（連続入力）
  //  Ctrl/⌘+Delete … 現在行を削除（確認あり）
  //  Enter/Tab（セル内編集中）… 確定して下/上・右/左の編集可能セルへ移動
  //  （editNavKeyDown=アウトラインと共通の規約。textarea の Enter は改行優先）
  const onGridKeyDown = (e: React.KeyboardEvent) => {
    if (isImeKeyEvent(e)) return; // IME 変換確定の Enter でセル移動しない
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault();
      const id = taskOfEvent(e);
      if (id) {
        const nid = addSiblingOf(id);
        if (nid) setFocusTask(nid);
      }
      return;
    }
    if ((e.ctrlKey || e.metaKey) && (e.key === 'd' || e.key === 'D')) {
      e.preventDefault();
      const id = taskOfEvent(e) ?? selectedTaskId;
      if (id) {
        const nid = duplicateTask(id);
        if (nid) setFocusTask(nid);
      }
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key === 'Delete') {
      e.preventDefault();
      const id = taskOfEvent(e);
      if (id) void confirmRemoveTasks([id]);
      return;
    }
    editNavKeyDown(e);
  };

  // ＋大/＋中: 追加した工程の作業名入力へフォーカスして即編集（末尾に空行が増えて止まる問題を
  // 解消・子追加/キーボード n と挙動統一）。未描画なら focus 用 effect が描画数を広げて待つ。
  const addRootAndEdit = (level: ProcessLevel) => {
    const id = addRootTask(level);
    if (id) setFocusTask(id);
  };

  // マイルストーンを追加（現在の表示粒度/スコープ。addMilestone が選択まで行うので即フォーカスのみ）。
  const addMilestoneAndEdit = () => {
    const id = addMilestone();
    if (id) setFocusTask(id);
  };

  if (flat.length === 0) {
    return (
      <div className="ft-empty">
        <p>工程がありません。</p>
        <button className="primary" onClick={() => addRootAndEdit('large')}>
          ＋ 大工程を追加
        </button>
      </div>
    );
  }

  return (
    <div className={`ft-wrap${resizing ? ' resizing' : ''}`}>
      <div className="ft-actions">
        <button className="primary" title="大工程を追加" onClick={() => addRootAndEdit('large')}>
          <Icons.BoxPlus />大
        </button>
        <button title="中工程を追加" onClick={() => addRootAndEdit('medium')}>
          <Icons.BoxPlus />中
        </button>
        <button
          className="ms-add"
          title="マイルストーンを追加（節目。子工程・担当・工数は持たない）"
          onClick={addMilestoneAndEdit}
        >
          <Icons.MilestoneDiamond />マイルストーン
        </button>
        <button onClick={onPasteRows} title="クリップボード（Excel など）の各行を工程として追加。列はタブ区切りで [作業名, 担当]。">
          貼り付けで追加
        </button>
        <Menu
          className="icon-btn menu-trigger col-menu"
          title="表示する列"
          label={
            <>
              <Icons.Columns />列<Icons.ChevronDown />
            </>
          }
        >
          {TOGGLE_COLS.map((c) => (
            <MenuCheckItem key={c.key} label={c.label} checked={vis(c.key)} onChange={() => toggleFtColumn(c.key)} />
          ))}
        </Menu>
        {sort && (
          <button className="ft-clear-sort" onClick={() => setSort(null)} title="工程順に戻す">
            並べ替え解除
          </button>
        )}
        {marked.size > 0 ? (
          <span className="ft-bulk" role="group" aria-label="一括操作">
            <strong>{marked.size}件選択中</strong>
            <button onClick={bulkAssign}>担当</button>
            <button onClick={bulkLevel}>粒度</button>
            <button onClick={bulkEffort}>工数</button>
            <button className="danger" onClick={bulkDelete}>まとめて削除</button>
            <button className="ft-bulk-clear" onClick={clearMarked}>選択解除</button>
          </span>
        ) : (
          <span className="ft-hint">
            h/l・←→＝セル移動・Enter＝編集（編集中: Enter/Tab＝下/右のセルへ） /
            Ctrl+Enter＝行追加・Ctrl+D＝複製・Ctrl+Delete＝削除。
          </span>
        )}
      </div>
      <div className="ft-filters" role="group" aria-label="絞り込み">
        <span className="ft-filter-label">
          <Icons.Filter />
          絞り込み
        </span>
        <select
          className="ft-filter-sel"
          value={filters.assignee}
          aria-label="担当で絞り込み"
          onChange={(e) => setFilters((f) => ({ ...f, assignee: e.target.value }))}
        >
          <option value="">担当: すべて</option>
          {assigneeNames.map((n) => (
            <option key={n} value={n}>
              担当: {n}
            </option>
          ))}
        </select>
        <button
          className={`ft-filter-chip${filters.issues ? ' on' : ''}`}
          aria-pressed={filters.issues}
          onClick={() => setFilters((f) => ({ ...f, issues: !f.issues }))}
        >
          課題あり
        </button>
        <button
          className={`ft-filter-chip${filters.noEffort ? ' on' : ''}`}
          aria-pressed={filters.noEffort}
          onClick={() => setFilters((f) => ({ ...f, noEffort: !f.noEffort }))}
        >
          工数未入力
        </button>
        <select
          className="ft-filter-sel"
          value={filters.automation}
          aria-label="自動化区分で絞り込み"
          onChange={(e) => setFilters((f) => ({ ...f, automation: e.target.value as Automation | '' }))}
        >
          <option value="">自動化: すべて</option>
          {AUTOMATION.filter((a) => a.key).map((a) => (
            <option key={a.key} value={a.key}>
              自動化: {a.label}
            </option>
          ))}
        </select>
        {filterActive && (
          <>
            <button className="ft-filter-clear" onClick={clearFilters}>
              絞り込み解除
            </button>
            <span className="ft-filter-count">
              {rows.length} / {flat.length} 件
            </span>
          </>
        )}
      </div>
      <datalist id="ft-assignees">
        {assigneeNames.map((n) => (
          <option key={n} value={n} />
        ))}
      </datalist>
      <datalist id="ft-io-names">
        {ioNames.map((n) => (
          <option key={n} value={n} />
        ))}
      </datalist>
      <div className="ft-scroll">
      <table className="ft" ref={tableRef} onKeyDown={onGridKeyDown}>
        <colgroup>
          {/* minWidth も明示(UX#14): table-layout:fixed + width:max-content で列は本来縮まないが、
              念のための保険として各列の下限を width と同じ値に固定し、常に横スクロールへ回す
              （縮んで右固定のアクション列と重なるのを防ぐ）。 */}
          {visibleCols.map((c) => (
            <col key={c.key} style={{ width: width(c.key), minWidth: width(c.key) }} />
          ))}
        </colgroup>
        <thead>
          <tr>
            {visibleCols.map((c) => {
              if (c.key === 'no')
                return (
                  <th key="no" className="ft-c-no ft-sticky" style={{ left: 0 }} title="工程順に戻す">
                    <button className="ft-sort" onClick={() => setSort(null)}>
                      No.
                    </button>
                  </th>
                );
              if (c.key === 'act') return <th key="act" className="ft-c-act ft-sticky-r"></th>;
              return (
                <Th
                  key={c.key}
                  k={c.key}
                  label={c.label}
                  cls={c.level ? `ft-c-level ft-sticky${c.level === lastStickyKey ? ' ft-sticky-last' : ''}` : c.cls}
                  style={c.level ? { left: levelLeft(c.level) } : undefined}
                  sort={sort}
                  clickSort={clickSort}
                  startResize={startResize}
                />
              );
            })}
          </tr>
        </thead>
        <tbody>
          {renderRows.map((t) => {
            const d = project.details[t.id];
            const ms = isMilestone(project.core, t.id);
            const hasChildren = parentsWithChildren.has(t.id);
            const assigneeName = t.assigneeId ? project.core.assignees[t.assigneeId]?.name ?? '' : '';
            const anc = ancestryNames(t, byId);
            const issues = d?.issues ?? [];
            // 各セルも列定義の並びから描画する（ヘッダ・colgroup と確実に揃える）。
            const cell = (c: FtCol): React.ReactNode => {
              if (c.level) {
                const own = c.level === t.level;
                const name = anc[c.level];
                return (
                  <td
                    key={c.key}
                    className={`ft-c-level ft-sticky${c.level === lastStickyKey ? ' ft-sticky-last' : ''} ${own ? 'own' : name ? 'anc' : 'blank'}`}
                    style={{ left: levelLeft(c.level) }}
                    onClick={(e) => e.stopPropagation()}
                  >
                    {own ? (
                      <span className="ft-name-cell">
                        {ms && <span className="ms-badge" title="マイルストーン" aria-hidden="true" />}
                        <input
                          className={`ft-in ft-name lvl-${c.level}${d?.textColor ? ' colored-text' : ''}${cellCursorCls(t.id, 'name')}${nameLenClass(t.name)}`}
                          title={nameLenTitle(t.name)}
                          onInput={onNameInput}
                          data-cell="name"
                          style={
                            d?.textColor
                              ? ({ '--task-text': TASK_COLORS[d.textColor].text } as React.CSSProperties)
                              : undefined
                          }
                          defaultValue={t.name}
                          placeholder={c.label}
                          aria-label={c.label}
                          data-task={t.id}
                          key={`name-${t.name}`}
                          {...selectAllOnFocus}
                          // Enter/Tab のセル移動は表全体の onGridKeyDown(editNavKeyDown)が担う。
                          // Escape: 未コミット新規行(name==='')は行削除、既存行はリネーム取り消し(#1/#2)。
                          onKeyDown={(e) => {
                            if (isImeKeyEvent(e)) return;
                            if (e.key !== 'Escape') return;
                            e.stopPropagation();
                            if (nameEscapeAction(t.name) === 'remove') {
                              removeTask(t.id);
                              return;
                            }
                            e.currentTarget.value = t.name;
                            e.currentTarget.blur();
                          }}
                          onBlur={(e) => e.target.value !== t.name && renameTask(t.id, e.target.value)}
                        />
                      </span>
                    ) : name !== undefined ? (
                      <span className="ft-anc" title={name}>
                        {name}
                      </span>
                    ) : null}
                  </td>
                );
              }
              switch (c.key) {
                case 'no':
                  return (
                    <td key="no" className="ft-c-no ft-sticky" style={{ left: 0 }} title={codes[t.id]}>
                      {ms ? <span className="ms-cell-blank">—</span> : codes[t.id]}
                    </td>
                  );
                case 'assignee':
                  return ms ? (
                    <td key={c.key} className="ft-c-assignee" onClick={(e) => e.stopPropagation()}>
                      <span className="ms-cell-blank" title="マイルストーンは担当を持ちません">—</span>
                    </td>
                  ) : (
                    <td
                      key={c.key}
                      className={`ft-c-assignee${assigneeFlash.has(t.id) ? ' cell-flash' : ''}`}
                      onClick={(e) => e.stopPropagation()}
                    >
                      <input
                        className={`ft-in${cellCursorCls(t.id, 'assignee')}`}
                        data-cell="assignee"
                        list="ft-assignees"
                        defaultValue={assigneeName}
                        placeholder="（未割当）"
                        aria-label="担当"
                        key={`asg-${assigneeName}`}
                        {...selectAllOnFocus}
                        onKeyDown={cancelEditOnEscape}
                        onBlur={(e) => e.target.value !== assigneeName && setAssigneeByName(t.id, e.target.value)}
                      />
                    </td>
                  );
                case 'status':
                  return (
                    <td key={c.key} className="ft-c-status" onClick={(e) => e.stopPropagation()}>
                      <select
                        className={`ft-in ft-status ${statusSelectClass(d)}${cellCursorCls(t.id, 'status')}`}
                        data-cell="status"
                        value={d?.status ?? ''}
                        aria-label="状況（ヒアリング進行）"
                        onChange={(e) => updateDetail(t.id, { status: (e.target.value || undefined) as TaskStatus | undefined })}
                      >
                        {STATUS_OPTIONS.map((s) => (
                          <option key={s.key} value={s.key}>
                            {s.label}
                          </option>
                        ))}
                      </select>
                    </td>
                  );
                case 'prev': {
                  const preds = predsByTo.get(t.id) ?? [];
                  const prevCands = prevCandidatesOf(t.id);
                  return (
                    <td key={c.key} className={`ft-c-prev${cellCursorCls(t.id, 'prev')}`} data-cell="prev" onClick={(e) => e.stopPropagation()}>
                      <div className="ft-prev">
                        {preds.map((dep) => (
                          <span className="ft-pill" key={dep.id}>
                            {byId[dep.from]?.name ?? ''}
                            <button className="ft-x" aria-label="前工程を解除" title="前工程を解除" onClick={() => removeDependencyWithUndo(dep.id)}>
                              ×
                            </button>
                          </span>
                        ))}
                        {(bridgePreds[t.id] ?? []).map((fromId) => (
                          <span
                            className="ft-pill derived"
                            key={`br-${fromId}`}
                            title="大工程同士の接続から自動で繋がっています（フローの矢印と同じ）"
                          >
                            ⤷ {byId[fromId]?.name ?? ''}
                          </span>
                        ))}
                        {prevCands.length > 0 && (
                          <select
                            className="ft-add ft-add-sel"
                            value=""
                            aria-label="前工程を追加"
                            title="前工程を追加"
                            onChange={(e) => e.target.value && addDependency(e.target.value, t.id)}
                          >
                            <option value="">＋</option>
                            <PrevCandidateOptions
                              candidates={prevCands}
                              parentName={(pid) => (pid ? (byId[pid]?.name ?? '別グループ') : '最上位')}
                            />
                          </select>
                        )}
                      </div>
                    </td>
                  );
                }
                case 'effort':
                  return (
                    <td key={c.key} className="ft-c-effort" onClick={(e) => e.stopPropagation()}>
                      {ms ? (
                        <span className="ms-cell-blank" title="マイルストーンは工数を持ちません">—</span>
                      ) : hasChildren ? (
                        <span className="ft-roll" title="子の合計（自動）">
                          {formatHours(effortRollups.get(t.id) ?? 0)}
                        </span>
                      ) : (
                        <input
                          className={`ft-in ft-num${cellCursorCls(t.id, 'effort')}`}
                          data-cell="effort"
                          // #3 type=number をやめて text + inputMode=decimal（ホイール誤変更・カンマ黙殺を解消）。
                          type="text"
                          inputMode="decimal"
                          defaultValue={d?.effortMinutes != null ? effortMinutesToHours(d.effortMinutes) : ''}
                          placeholder="例: 2 / 0.5"
                          aria-label="工数（時間）"
                          key={`eff-${d?.effortMinutes ?? ''}`}
                          onKeyDown={cancelEditOnEscape}
                          onBlur={(e) => {
                            const res = validateEffort(e.target.value);
                            if (!res.ok) {
                              // 不正値（数値でない・負・無限大）: 打った文字は残し、セルを不正表示にして
                              // commit だけブロックする（無音で値を破棄せず、修正を促す）。理由はトーストで即提示。
                              markEffortInvalid(e.target, res.message);
                              useUI.getState().toast(`${res.message}（例: 2 や 0.5）`, 'error');
                              return;
                            }
                            clearEffortInvalid(e.target);
                            if (isEffortBlurUnchanged(e.target.value, d?.effortMinutes)) return; // 無編集 blur は書き換えない
                            if (res.minutes !== d?.effortMinutes) updateDetail(t.id, { effortMinutes: res.minutes });
                          }}
                        />
                      )}
                    </td>
                  );
                case 'how':
                  return <WrapCell key={c.key} value={d?.how} onCommit={(v) => updateDetail(t.id, { how: v })} k={t.id} cell="how" cursor={cellCursorCls(t.id, 'how') !== ''} />;
                case 'system':
                  return <WrapCell key={c.key} value={d?.system} onCommit={(v) => updateDetail(t.id, { system: v })} k={t.id} cell="system" cursor={cellCursorCls(t.id, 'system') !== ''} />;
                case 'inputs':
                  return <IoCell key={c.key} items={d?.inputs ?? []} direction="in" cell="inputs" cursor={cellCursorCls(t.id, 'inputs') !== ''} onAdd={() => { addIo(t.id, 'inputs', '帳票'); setAddFocus({ taskId: t.id, cell: 'inputs' }); }} onRename={(id, name) => updateIo(t.id, id, { name })} onKind={(id, kind) => updateIo(t.id, id, { kind })} onRemove={(id) => removeIoWithUndo(t.id, id)} />;
                case 'outputs':
                  return <IoCell key={c.key} items={d?.outputs ?? []} direction="out" cell="outputs" cursor={cellCursorCls(t.id, 'outputs') !== ''} onAdd={() => { addIo(t.id, 'outputs', '帳票'); setAddFocus({ taskId: t.id, cell: 'outputs' }); }} onRename={(id, name) => updateIo(t.id, id, { name })} onKind={(id, kind) => updateIo(t.id, id, { kind })} onRemove={(id) => removeIoWithUndo(t.id, id)} />;
                case 'issue':
                  return (
                    <td key={c.key} className={`ft-c-issue${cellCursorCls(t.id, 'issue')}`} data-cell="issue" onClick={(e) => e.stopPropagation()}>
                      <div className="ft-issues">
                        {issues.map((iss) => (
                          <div className="ft-issue-row" key={iss.id}>
                            <AutoTextarea value={iss.issue} placeholder="課題" onCommit={(v) => updateIssue(t.id, iss.id, { issue: v })} />
                            <button className="ft-x" aria-label="課題を削除" title="課題を削除" onClick={() => removeIssueWithUndo(t.id, iss.id)}>
                              ×
                            </button>
                          </div>
                        ))}
                        <button className="ft-add" onClick={() => { addIssue(t.id, '課題'); setAddFocus({ taskId: t.id, cell: 'issue' }); }}>
                          ＋課題
                        </button>
                      </div>
                    </td>
                  );
                case 'measure':
                  return (
                    <td key={c.key} className={`ft-c-issue${cellCursorCls(t.id, 'measure')}`} data-cell="measure" onClick={(e) => e.stopPropagation()}>
                      <div className="ft-issues">
                        {issues.map((iss) => (
                          <div className="ft-issue-row" key={iss.id}>
                            <AutoTextarea value={iss.measure ?? ''} placeholder="方策" onCommit={(v) => updateIssue(t.id, iss.id, { measure: v || undefined })} />
                          </div>
                        ))}
                        {issues.length === 0 && (
                          // 課題が無くても方策を直接入力できる（入力時に課題を起票）。
                          <AutoTextarea value="" placeholder="方策" onCommit={(v) => v.trim() && addIssueWithMeasure(t.id, v)} />
                        )}
                      </div>
                    </td>
                  );
                case 'note':
                  return <WrapCell key={c.key} value={d?.note} onCommit={(v) => updateDetail(t.id, { note: v || undefined })} k={t.id} cell="note" cursor={cellCursorCls(t.id, 'note') !== ''} />;
                case 'volume':
                  return <WrapCell key={c.key} value={d?.volume} onCommit={(v) => updateDetail(t.id, { volume: v || undefined })} k={t.id} cell="volume" cursor={cellCursorCls(t.id, 'volume') !== ''} />;
                case 'exception':
                  return <WrapCell key={c.key} value={d?.exception} onCommit={(v) => updateDetail(t.id, { exception: v || undefined })} k={t.id} cell="exception" cursor={cellCursorCls(t.id, 'exception') !== ''} />;
                case 'automation':
                  return ms ? (
                    <td key={c.key} className="ft-c-auto" onClick={(e) => e.stopPropagation()}>
                      <span className="ms-cell-blank">—</span>
                    </td>
                  ) : (
                    <td key={c.key} className="ft-c-auto" onClick={(e) => e.stopPropagation()}>
                      <select className={`ft-in${cellCursorCls(t.id, 'automation')}`} data-cell="automation" value={d?.automation ?? ''} aria-label="自動化区分" onChange={(e) => updateDetail(t.id, { automation: (e.target.value || undefined) as Automation | undefined })}>
                        {AUTOMATION.map((a) => (
                          <option key={a.key} value={a.key}>
                            {a.label}
                          </option>
                        ))}
                      </select>
                    </td>
                  );
                case 'dataLink':
                  return <WrapCell key={c.key} value={d?.dataLink} onCommit={(v) => updateDetail(t.id, { dataLink: v || undefined })} k={t.id} cell="dataLink" cursor={cellCursorCls(t.id, 'dataLink') !== ''} />;
                case 'regulation':
                  return <WrapCell key={c.key} value={d?.regulation} onCommit={(v) => updateDetail(t.id, { regulation: v || undefined })} k={t.id} cell="regulation" cursor={cellCursorCls(t.id, 'regulation') !== ''} />;
                case 'difficulty':
                  return ms ? (
                    <td key={c.key} className="ft-c-diff" onClick={(e) => e.stopPropagation()}>
                      <span className="ms-cell-blank">—</span>
                    </td>
                  ) : (
                    <td key={c.key} className="ft-c-diff" onClick={(e) => e.stopPropagation()}>
                      <select className={`ft-in${cellCursorCls(t.id, 'difficulty')}`} data-cell="difficulty" value={d?.difficulty ?? ''} aria-label="難易度" onChange={(e) => updateDetail(t.id, { difficulty: (e.target.value || undefined) as Difficulty | undefined })}>
                        {DIFFICULTY.map((x) => (
                          <option key={x} value={x}>
                            {x || '—'}
                          </option>
                        ))}
                      </select>
                    </td>
                  );
                case 'act':
                  return (
                    <td key={c.key} className="ft-c-act ft-sticky-r" onClick={(e) => e.stopPropagation()}>
                      <div className="ft-rowact">
                        <button
                          className="ft-rowbtn"
                          aria-label="次の行を追加"
                          title="次の行を追加（同じ粒度）"
                          onClick={() => {
                            const id = addSiblingOf(t.id);
                            if (id) setFocusTask(id);
                          }}
                        >
                          ＋
                        </button>
                        <button
                          className="ft-rowbtn"
                          aria-label={`「${t.name}」を複製`}
                          title="この行を複製（Ctrl+D）"
                          onClick={() => {
                            const nid = duplicateTask(t.id);
                            if (nid) setFocusTask(nid);
                          }}
                        >
                          ⧉
                        </button>
                        <button
                          className="ft-rowbtn danger"
                          aria-label={`「${t.name}」を削除`}
                          title="この行を削除"
                          onClick={() => void confirmRemoveTasks([t.id])}
                        >
                          <Icons.Trash />
                        </button>
                      </div>
                    </td>
                  );
                default:
                  return null;
              }
            };
            return (
              <tr
                key={t.id}
                data-taskid={t.id}
                className={`${t.id === selectedTaskId ? 'sel' : ''}${hasChildren ? ' parent' : ''}${marked.has(t.id) ? ' marked' : ''}${ms ? ' is-milestone' : ''}`}
                onClickCapture={(e) => {
                  // 修飾クリック（Ctrl/⌘/Shift）＝複数選択。各セルの stopPropagation より先に
                  // capture 段で拾い、入力へのフォーカス／テキスト選択を止める（preventDefault）。
                  // 修飾なしのクリックは従来どおり行を選択する（onRowClick 内 select）。
                  if (e.ctrlKey || e.metaKey || e.shiftKey) {
                    e.preventDefault();
                    e.stopPropagation();
                  }
                  onRowClick(e, t.id);
                }}
              >
                {visibleCols.map(cell)}
              </tr>
            );
          })}
          {/* 末尾ゴースト行: Excel 流に「一番下の空行へ直接入力」できる入口。絞り込み中・逐次レンダ
              の途中は出さない（追加行がフィルタに合致しない・末尾でない混乱を避ける）。 */}
          {!hasMore && !filterActive && rows.length > 0 && (
            <tr className="ft-ghost" onClick={addGhostRow}>
              <td colSpan={visibleCols.length}>＋ 新しい工程…</td>
            </tr>
          )}
        </tbody>
      </table>
      {filterActive && rows.length === 0 && (
        <div className="ft-empty-filter">条件に一致する工程がありません。</div>
      )}
      {hasMore && (
        <div className="ft-more" ref={sentinelRef}>
          {renderRows.length} / {rows.length} 行を表示中…（スクロールで続きを表示）
        </div>
      )}
      </div>
    </div>
  );
}

// 折り返し対応の自動伸縮テキストエリア（全文表示。Enter は改行）。
function AutoTextarea({
  value,
  onCommit,
  placeholder,
  cell,
  cursor,
}: {
  value: string | undefined;
  onCommit: (v: string) => void;
  placeholder?: string;
  cell?: string;
  cursor?: boolean;
}) {
  const grow = (el: HTMLTextAreaElement | null) => {
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 220)}px`;
  };
  return (
    <textarea
      className={`ft-in ft-area${cursor ? ' cell-cursor' : ''}`}
      data-cell={cell}
      rows={1}
      placeholder={placeholder}
      defaultValue={value ?? ''}
      key={`v-${value ?? ''}`}
      ref={grow}
      onInput={(e) => grow(e.currentTarget)}
      onKeyDown={cancelEditOnEscape}
      onBlur={(e) => e.target.value !== (value ?? '') && onCommit(e.target.value)}
    />
  );
}

function WrapCell({
  value,
  onCommit,
  cell,
  cursor,
}: {
  value: string | undefined;
  onCommit: (v: string) => void;
  k: Id;
  cell?: string;
  cursor?: boolean;
}) {
  return (
    <td className="ft-c-text" onClick={(e) => e.stopPropagation()}>
      <AutoTextarea value={value} onCommit={onCommit} cell={cell} cursor={cursor} />
    </td>
  );
}

function IoCell({
  items,
  direction,
  onAdd,
  onRename,
  onKind,
  onRemove,
  cell,
  cursor,
}: {
  items: { id: Id; name: string; kind: IoKind }[];
  direction: 'in' | 'out';
  onAdd: () => void;
  onRename: (id: Id, name: string) => void;
  onKind: (id: Id, kind: IoKind) => void;
  onRemove: (id: Id) => void;
  cell?: string;
  cursor?: boolean;
}) {
  return (
    <td className={`ft-c-io${cursor ? ' cell-cursor' : ''}`} data-cell={cell} onClick={(e) => e.stopPropagation()}>
      <div className="ft-io">
        {items.map((it) => (
          // 色は入出力の向き（フローと統一）。種別(帳票/情報)はセレクトの値で区別。
          <span className={`ft-iochip ${direction}`} key={it.id}>
            {/* 触れただけの blur で履歴と未保存フラグを汚さない（変化があるときだけコミット）。 */}
            <input className="ft-io-name" list="ft-io-names" defaultValue={it.name} key={`ion-${it.name}`} aria-label="名称" {...selectAllOnFocus} onKeyDown={cancelEditOnEscape} onBlur={(e) => e.target.value !== it.name && onRename(it.id, e.target.value)} />
            <select className="ft-io-kind" value={it.kind} aria-label="種別" onChange={(e) => onKind(it.id, e.target.value as IoKind)}>
              <option value="doc">帳票</option>
              <option value="info">情報</option>
            </select>
            <button className="ft-x" aria-label="削除" title="入出力を削除" onClick={() => onRemove(it.id)}>
              ×
            </button>
          </span>
        ))}
        <button className="ft-add" onClick={onAdd}>
          ＋
        </button>
      </div>
    </td>
  );
}
