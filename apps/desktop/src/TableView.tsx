import { useEffect, useMemo, useRef, useState } from 'react';
import type { ProcessTask, ProcessLevel, Id } from '@gantt-flow/core';
import { computeCodes, computeEffortRollups, formatHours, bridgePredMap } from '@gantt-flow/core';
import { useApp } from './store';
import { buildPrevCandidateIndex } from './suggestions';
import { parseEffortHoursToMinutes } from './parseEffort';
import { useUI, OUTLINE_OPTIONAL_COLUMNS } from './ui/useUI';
import { useFlashIds } from './ui/useFlash';
import { Menu, MenuCheckItem } from './ui/Menu';
import { useRowSelectionKeys, scrollRowIntoView } from './ui/useRowSelectionKeys';
import { filterOutlineRows } from './outlineFilter';
import { revealTask, confirmRemoveTasks } from './taskOps';
import { isImeKeyEvent } from './keymap';
import { TASK_COLORS } from './theme';
import * as Icons from './ui/icons';

const LEVEL_OPTS: { key: ProcessLevel; label: string }[] = [
  { key: 'large', label: '大' },
  { key: 'medium', label: '中' },
  { key: 'small', label: '小' },
  { key: 'detail', label: '詳細' },
];

interface Row {
  task: ProcessTask;
  depth: number;
  // 各祖先（深さ 0..depth-1）が「下に兄弟を持つか」。ツリーガイド線の有無に使う。
  ancestorLines: boolean[];
  isLast: boolean; // 同じ親グループ内で最後の子か（エルボー └ / ├ の出し分け）
}

function buildOutline(tasks: ProcessTask[], collapsed: Set<Id>): Row[] {
  const byParent = new Map<Id | undefined, ProcessTask[]>();
  for (const t of tasks) {
    const key = t.parentId ?? undefined;
    const arr = byParent.get(key);
    if (arr) arr.push(t);
    else byParent.set(key, [t]);
  }
  for (const arr of byParent.values()) arr.sort((a, b) => a.order - b.order);
  const rows: Row[] = [];
  const walk = (parentId: Id | undefined, depth: number, ancestorLines: boolean[]) => {
    const arr = byParent.get(parentId) ?? [];
    arr.forEach((t, i) => {
      const isLast = i === arr.length - 1;
      rows.push({ task: t, depth, ancestorLines, isLast });
      // 折りたたみ配下はスキップ。子には「自分が末子でない＝下に線を続ける」を渡す。
      if (!collapsed.has(t.id)) walk(t.id, depth + 1, [...ancestorLines, !isLast]);
    });
  };
  walk(undefined, 0, []);
  return rows;
}

// ツリーガイド（VS Code 風）の縦線・エルボーを名前セルに重ねる。
const INDENT = 22;
const GUTTER = 10; // 列の中心 x
function TreeGuides({ depth, ancestorLines, isLast }: Omit<Row, 'task'>) {
  if (depth === 0) return null;
  const segs: JSX.Element[] = [];
  for (let j = 0; j < depth; j++) {
    const x = j * INDENT + GUTTER;
    if (j < depth - 1) {
      if (ancestorLines[j]) segs.push(<span key={`v${j}`} className="tg-v" style={{ left: x }} />);
    } else {
      segs.push(<span key="eu" className="tg-seg tg-eu" style={{ left: x }} />);
      if (!isLast) segs.push(<span key="ed" className="tg-seg tg-ed" style={{ left: x }} />);
      segs.push(<span key="eh" className="tg-seg tg-eh" style={{ left: x, width: INDENT - GUTTER }} />);
    }
  }
  return <span className="tree-guides" aria-hidden="true">{segs}</span>;
}

export function TableView() {
  const project = useApp((s) => s.project);
  const selectedTaskId = useApp((s) => s.selectedTaskId);
  const select = useApp((s) => s.select);
  const renameTask = useApp((s) => s.renameTask);
  const setTaskLevel = useApp((s) => s.setTaskLevel);
  const setAssigneeByName = useApp((s) => s.setAssigneeByName);
  const updateDetail = useApp((s) => s.updateDetail);
  const addRootTask = useApp((s) => s.addRootTask);
  const addChildTask = useApp((s) => s.addChildTask);
  const addSiblingOf = useApp((s) => s.addSiblingOf);
  const moveTaskUp = useApp((s) => s.moveTaskUp);
  const moveTaskDown = useApp((s) => s.moveTaskDown);
  const dropTask = useApp((s) => s.dropTask);
  const addDependency = useApp((s) => s.addDependency);
  // フローのレーン移動で担当が書き戻った工程は、担当セルを一時ハイライトして変更点を示す。
  const lastAssigneeSync = useApp((s) => s.lastAssigneeSync);
  const assigneeFlash = useFlashIds(lastAssigneeSync);
  const columnVisibility = useUI((s) => s.columnVisibility);
  const toggleColumn = useUI((s) => s.toggleColumn);

  // To-Be 新設工程(toBe.lifecycle='added')は As-Is の工程表には出さない（比較の To-Be 側にのみ出る）。
  const tasks = Object.values(project.core.tasks).filter((t) => project.details[t.id]?.toBe?.lifecycle !== 'added');
  // 折りたたみ状態は useUI に置く(コマンドパレットの全折りたたみ/全展開と共有・非マウント時も保持)。
  const collapsed = useUI((s) => s.outlineCollapsed);
  const setCollapsed = useUI((s) => s.setOutlineCollapsed);
  // クイックフィルタ(Ctrl/⌘+F)。表示のみの絞り込みで、行追加・移動などのデータ操作には触れない。
  // フィルタ中は折りたたみを無視して全展開で探す(畳まれた配下の一致を取りこぼさない)。
  const [findQuery, setFindQuery] = useState('');
  const findRef = useRef<HTMLInputElement>(null);
  const findActive = findQuery.trim() !== '';
  const { rows, matched } = filterOutlineRows(
    buildOutline(tasks, findActive ? new Set<Id>() : collapsed),
    findQuery,
    (t) => (t.assigneeId ? project.core.assignees[t.assigneeId]?.name ?? '' : ''),
  );
  // 一致行(表示順)。検索ボックスの Enter で次の一致へ循環ジャンプする。
  const matchedIds = findActive ? rows.filter((r) => matched.has(r.task.id)).map((r) => r.task.id) : [];
  const codes = computeCodes(project.core);
  const parentsWithChildren = new Set(tasks.map((t) => t.parentId).filter(Boolean) as Id[]);
  const assigneeNames = [...new Set(Object.values(project.core.assignees).map((a) => a.name))];
  const deps = Object.values(project.core.dependencies);
  // 親(大)同士の接続から導出される前工程(フローのブリッジ矢印と同じもの)。表でも見せて同期ずれを無くす。
  const bridgePreds = bridgePredMap(project.core);
  // 前工程候補のインデックス。プロジェクトが変わったときだけ作り直す(選択移動だけの再レンダーでは再利用)。
  const prevCandidatesFor = useMemo(() => buildPrevCandidateIndex(project), [project]);
  // 集計工数(親=子孫の合計)。行ごとに effortRollupMinutes を呼ぶと毎回全マップを再構築して
  // O(n²) になるため、コミット時に 1 回だけ計算して各行は Map 参照にする。
  const effortRollups = useMemo(
    () => computeEffortRollups(project.core, project.details),
    [project.core, project.details],
  );

  // 新しく追加した行の作業名入力にフォーカスする（連続入力）。
  const [focusId, setFocusId] = useState<Id | null>(null);
  const [dragId, setDragId] = useState<Id | null>(null);
  const [dropInfo, setDropInfo] = useState<{ id: Id; mode: 'before' | 'after' | 'child' } | null>(
    null,
  );
  const nameRefs = useRef<Map<Id, HTMLInputElement>>(new Map());
  useEffect(() => {
    if (!focusId) return;
    nameRefs.current.get(focusId)?.focus();
    setFocusId(null);
  }, [focusId, rows.length]);

  // 選択中の工程が変わったら、その行が画面外のとき視点を寄せる（フロー→表追従）。
  // 'nearest' なので表側の操作で既に見えている時は動かない。畳まれて未描画なら no-op。
  useEffect(() => {
    if (!selectedTaskId) return;
    const raf = requestAnimationFrame(() => scrollRowIntoView(selectedTaskId));
    return () => cancelAnimationFrame(raf);
  }, [selectedTaskId]);

  const toggleCollapse = useUI((s) => s.toggleOutlineCollapsed);

  // 行クリック/編集開始は工程へジャンプ(選択＋粒度同期＋詳細パネル)。
  // スコープ追従の規則はパレット等と共通の revealTask(taskOps.ts)に集約。
  const openRow = (t: ProcessTask) => revealTask(t.id);

  // 行選択モード(編集外のキーボード操作)。j/k=行移動・h/l=列カーソル・Enter=セル編集 などは
  // useGlobalHotkeys → 'table' コンテキスト経由でここに届く。
  const activePane = useUI((s) => s.activePane);
  // 列カーソルの対象(表示順)。行内の data-cell 属性と対応。
  const visibleOptionalColumns = OUTLINE_OPTIONAL_COLUMNS.filter((c) => columnVisibility[c.key]);
  const cursorColumns = ['level', 'name', 'assignee', ...visibleOptionalColumns.map((c) => c.key)];
  const { colIdx, editNavKeyDown } = useRowSelectionKeys({
    enabled: activePane === 'table',
    orderedIds: rows.map((r) => r.task.id),
    columns: cursorColumns,
    beginEdit: (id) => {
      revealTask(id); // 編集開始時のみフローの粒度/スコープを同期(j/k 中はしない)
      setFocusId(id); // 再レンダ後に名前入力へフォーカス
    },
    toggleCollapse: (id) => {
      if (parentsWithChildren.has(id)) toggleCollapse(id);
    },
    openFind: () => {
      const el = findRef.current;
      if (!el) return false;
      el.focus();
      el.select();
      return true;
    },
  });
  const cursorCol = cursorColumns[colIdx];
  // 選択行のカーソル列のセルを強調する(キーボードで「いまどのセルか」を示す)。
  const cellCursorCls = (taskId: Id, key: string) =>
    taskId === selectedTaskId && activePane === 'table' && cursorCol === key ? ' cell-cursor' : '';

  const commitName = (t: ProcessTask, value: string) => {
    if (value !== t.name) renameTask(t.id, value);
  };

  // ＋大/＋中: 追加した工程を選択（→ useEffect が行を可視化）し、名前入力へフォーカスして
  // 即編集を始める（末尾に空の「新規工程」が増えて止まる問題を解消・キーボード n と挙動統一）。
  const addRootAndEdit = (level: ProcessLevel) => {
    const id = addRootTask(level);
    if (id) {
      select(id);
      setFocusId(id);
    }
  };

  // 検索ボックス内のキー操作。Enter=次の一致行へ選択ジャンプ(循環)・Esc=クリアして表へフォーカスを返す。
  // stopPropagation でグローバルの Enter(table.edit)/Esc(blur→選択解除)へ流さない。
  const onFindKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (isImeKeyEvent(e)) return; // IME 変換確定の Enter でジャンプしない
    if (e.key === 'Enter') {
      e.preventDefault();
      e.stopPropagation();
      if (matchedIds.length === 0) return;
      const cur = selectedTaskId ? matchedIds.indexOf(selectedTaskId) : -1;
      const next = matchedIds[(cur + 1) % matchedIds.length]!;
      select(next);
      scrollRowIntoView(next);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      setFindQuery('');
      document.querySelector<HTMLElement>('#main-table')?.focus();
    }
  };

  return (
    <div className="outline">
      <div className="outline-actions">
        <button className="primary" title="大工程を追加" onClick={() => addRootAndEdit('large')}>
          <Icons.BoxPlus />大
        </button>
        <button title="中工程を追加" onClick={() => addRootAndEdit('medium')}>
          <Icons.BoxPlus />中
        </button>
        {parentsWithChildren.size > 0 && (
          <span className="outline-collapse">
            <button onClick={() => setCollapsed(new Set())} title="すべて展開" aria-label="すべて展開">
              <Icons.UnfoldVertical />
            </button>
            <button
              onClick={() => setCollapsed(new Set(parentsWithChildren))}
              title="すべて折りたたみ"
              aria-label="すべて折りたたみ"
            >
              <Icons.FoldVertical />
            </button>
          </span>
        )}
        <span className="outline-find" title="作業名・担当で絞り込み（Ctrl/⌘+F・Enter で次の一致へ・Esc で解除）">
          <Icons.Search />
          <input
            ref={findRef}
            className="outline-find-input"
            type="search"
            value={findQuery}
            placeholder="絞り込み"
            aria-label="クイックフィルタ（作業名・担当に部分一致）"
            onChange={(e) => setFindQuery(e.target.value)}
            onKeyDown={onFindKeyDown}
          />
          {findActive && (
            <span className="outline-find-count" role="status">
              {matchedIds.length}件一致
            </span>
          )}
        </span>
        <Menu
          className="icon-btn menu-trigger col-menu"
          title="表示する列"
          label={
            <>
              <Icons.Columns />
              <Icons.ChevronDown />
            </>
          }
        >
          {OUTLINE_OPTIONAL_COLUMNS.map((c) => (
            <MenuCheckItem
              key={c.key}
              label={c.label}
              checked={columnVisibility[c.key]}
              onChange={() => toggleColumn(c.key)}
            />
          ))}
        </Menu>
      </div>

      {rows.length === 0 ? (
        findActive ? (
          <p className="empty">「{findQuery}」に一致する工程がありません。</p>
        ) : (
          <p className="empty">「＋ 大工程」または「＋ 中工程」から作業を追加してください。</p>
        )
      ) : (
        <>
          <datalist id="assignee-names">
            {assigneeNames.map((n) => (
              <option key={n} value={n} />
            ))}
          </datalist>
          <div className="outline-scroll">
          <table
            className="grid"
            onKeyDown={editNavKeyDown}
            style={{
              // 固定列の合計 + 作業名の最小幅 + 表示中の任意列。狭いペインではペインが横スクロールする。
              minWidth: 354 + 160 + visibleOptionalColumns.reduce((sum, c) => sum + c.width, 0),
            }}
          >
            <thead>
              <tr>
                <th className="c-grip" aria-hidden="true"></th>
                <th className="c-code">No.</th>
                <th className="c-level">粒度</th>
                <th className="c-name">作業名</th>
                <th className="c-assignee">担当</th>
                {visibleOptionalColumns.map((c) => (
                  <th key={c.key} className={`c-${c.key}`}>
                    {c.label}
                  </th>
                ))}
                <th className="c-act"></th>
              </tr>
            </thead>
            <tbody>
              {rows.map(({ task: t, depth, ancestorLines, isLast }) => {
                const detail = project.details[t.id];
                const assigneeName = t.assigneeId
                  ? project.core.assignees[t.assigneeId]?.name ?? ''
                  : '';
                const ioCount = (detail?.inputs?.length ?? 0) + (detail?.outputs?.length ?? 0);
                const issueCount = detail?.issues?.length ?? 0;
                const hasChildren = parentsWithChildren.has(t.id);
                const preds = deps.filter((dep) => dep.to === t.id);
                const candidates = columnVisibility.prev ? prevCandidatesFor(t.id) : [];
                return (
                  <tr
                    key={t.id}
                    data-taskid={t.id}
                    className={[
                      t.id === selectedTaskId ? 'selected' : '',
                      dragId === t.id ? 'dragging' : '',
                      dropInfo?.id === t.id ? `drop-${dropInfo.mode}` : '',
                      hasChildren ? 'is-parent' : '',
                      depth > 0 ? 'is-child' : '',
                    ]
                      .filter(Boolean)
                      .join(' ')}
                    onClick={() => openRow(t)}
                    onDragOver={(e) => {
                      if (!dragId || dragId === t.id) return;
                      e.preventDefault();
                      const rect = e.currentTarget.getBoundingClientRect();
                      const y = e.clientY - rect.top;
                      const mode =
                        y < rect.height * 0.28
                          ? 'before'
                          : y > rect.height * 0.72
                            ? 'after'
                            : 'child';
                      if (dropInfo?.id !== t.id || dropInfo.mode !== mode) {
                        setDropInfo({ id: t.id, mode });
                      }
                    }}
                    onDrop={(e) => {
                      e.preventDefault();
                      if (dragId && dropInfo && dragId !== t.id) {
                        dropTask(dragId, t.id, dropInfo.mode);
                      }
                      setDragId(null);
                      setDropInfo(null);
                    }}
                  >
                    <td className="c-grip" onClick={(e) => e.stopPropagation()}>
                      <span
                        className="row-grip"
                        draggable
                        title="ドラッグで移動（上下＝並べ替え / 中央＝子にする）"
                        aria-label="行をドラッグして移動"
                        onDragStart={(e) => {
                          setDragId(t.id);
                          e.dataTransfer.effectAllowed = 'move';
                        }}
                        onDragEnd={() => {
                          setDragId(null);
                          setDropInfo(null);
                        }}
                      >
                        ⠿
                      </span>
                    </td>
                    <td className="c-code" title={codes[t.id]}>
                      {codes[t.id]}
                    </td>
                    <td className="c-level" onClick={(e) => e.stopPropagation()}>
                      <select
                        className={`lvl lvl-${t.level}${cellCursorCls(t.id, 'level')}`}
                        data-cell="level"
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
                    <td className="c-name">
                      <TreeGuides depth={depth} ancestorLines={ancestorLines} isLast={isLast} />
                      <div className="name-cell" style={{ paddingLeft: depth * INDENT }}>
                        {hasChildren && (
                          <button
                            className={`caret lvl-${t.level}`}
                            aria-label={collapsed.has(t.id) ? '展開' : '折りたたみ'}
                            title={collapsed.has(t.id) ? '展開' : '折りたたみ'}
                            onClick={(e) => {
                              e.stopPropagation();
                              toggleCollapse(t.id);
                            }}
                          >
                            {collapsed.has(t.id) ? '▶' : '▼'}
                          </button>
                        )}
                        {detail?.fillColor && (
                          <span
                            className="color-dot"
                            style={{ background: TASK_COLORS[detail.fillColor].base }}
                            title="工程カラー（塗り色）"
                            aria-hidden="true"
                          />
                        )}
                        <input
                          className={`name-input${detail?.textColor ? ' colored-text' : ''}${matched.has(t.id) ? ' name-match' : ''}${cellCursorCls(t.id, 'name')}`}
                          data-cell="name"
                          style={
                            detail?.textColor
                              ? ({ '--task-text': TASK_COLORS[detail.textColor].text } as React.CSSProperties)
                              : undefined
                          }
                          ref={(el) => {
                            if (el) nameRefs.current.set(t.id, el);
                            else nameRefs.current.delete(t.id);
                          }}
                          // 非制御 input のため、外(フローのリネーム等)で名前が変わったら
                          // key で作り直して defaultValue を反映する(全項目表と同じパターン)。
                          key={`name-${t.name}`}
                          defaultValue={t.name}
                          placeholder="作業名"
                          aria-label="作業名"
                          onClick={(e) => e.stopPropagation()}
                          onKeyDown={(e) => {
                            if (isImeKeyEvent(e)) return; // IME 変換の確定 Enter/Tab/Esc を編集操作にしない
                            // Enter/Tab は表全体の editNavKeyDown(両ビュー共通のセル移動規約)に任せる。
                            // インデントは行選択モードの Tab(table.indent)に一本化した。
                            if (e.key === 'Escape') {
                              e.stopPropagation(); // グローバルの Esc(選択解除)を発火させない
                              e.currentTarget.value = t.name;
                              e.currentTarget.blur();
                            } else if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
                              e.preventDefault();
                              commitName(t, e.currentTarget.value);
                              if (e.key === 'ArrowUp') moveTaskUp(t.id);
                              else moveTaskDown(t.id);
                              setFocusId(t.id);
                            }
                          }}
                          onBlur={(e) => commitName(t, e.target.value)}
                        />
                      </div>
                    </td>
                    <td className={`c-assignee${assigneeFlash.has(t.id) ? ' cell-flash' : ''}`}>
                      <input
                        className={`assignee${cellCursorCls(t.id, 'assignee')}`}
                        data-cell="assignee"
                        list="assignee-names"
                        defaultValue={assigneeName}
                        key={`asg-${assigneeName}`}
                        placeholder="（未割当）"
                        aria-label="担当"
                        onClick={(e) => e.stopPropagation()}
                        onBlur={(e) => {
                          if (e.target.value !== assigneeName) setAssigneeByName(t.id, e.target.value);
                        }}
                      />
                    </td>
                    {columnVisibility.prev && (
                    <td className="c-prev" onClick={(e) => e.stopPropagation()}>
                      {preds.length > 0 && (
                        <span
                          className="prev-names"
                          title={preds.map((d) => project.core.tasks[d.from]?.name ?? '').join('、')}
                        >
                          {preds.map((d) => project.core.tasks[d.from]?.name ?? '').join('、')}
                        </span>
                      )}
                      {(bridgePreds[t.id] ?? []).map((fromId) => (
                        <span
                          key={`br-${fromId}`}
                          className="prev-names derived"
                          title="大工程同士の接続から自動で繋がっています（フローの矢印と同じ・解除は大工程側の接続を削除）"
                        >
                          ⤷ {project.core.tasks[fromId]?.name ?? ''}
                        </span>
                      ))}
                      {candidates.length > 0 && (
                        <select
                          className={`prev-add${cellCursorCls(t.id, 'prev')}`}
                          data-cell="prev"
                          value=""
                          aria-label="前工程を追加"
                          onChange={(e) => {
                            if (e.target.value) addDependency(e.target.value, t.id);
                          }}
                        >
                          <option value="">＋前工程</option>
                          {candidates.map((o) => (
                            <option key={o.id} value={o.id}>
                              {o.name}
                            </option>
                          ))}
                        </select>
                      )}
                    </td>
                    )}
                    {columnVisibility.effort && (
                    <td className="c-effort" onClick={(e) => e.stopPropagation()}>
                      {hasChildren ? (
                        <span className="effort-roll" title="子の合計（自動）">
                          {formatHours(effortRollups.get(t.id) ?? 0)}
                        </span>
                      ) : (
                        <input
                          className={`effort-input${cellCursorCls(t.id, 'effort')}`}
                          data-cell="effort"
                          type="number"
                          min={0}
                          step={0.5}
                          defaultValue={detail?.effortMinutes != null ? detail.effortMinutes / 60 : ''}
                          placeholder="h"
                          aria-label="工数（時間）"
                          onClick={(e) => e.stopPropagation()}
                          onBlur={(e) => {
                            const minutes = parseEffortHoursToMinutes(e.target.value);
                            if (minutes === null) {
                              // 不正値（数値でない・負・無限大）は棄却して表示も元の値へ戻す（インスペクタと同じ規約）。
                              e.target.value =
                                detail?.effortMinutes != null ? String(detail.effortMinutes / 60) : '';
                              useUI.getState().toast('工数は 0 以上の数値（時間）で入力してください', 'error');
                              return;
                            }
                            if (minutes !== detail?.effortMinutes) updateDetail(t.id, { effortMinutes: minutes });
                          }}
                        />
                      )}
                    </td>
                    )}
                    {columnVisibility.io && (
                    <td
                      className={`c-io${cellCursorCls(t.id, 'io')}`}
                      data-cell="io"
                      onClick={(e) => e.stopPropagation()}
                    >
                      {/* 24/22: アウトラインは入/出/課題のドット＋件数の要約のみ。
                          深掘り編集はクリックでインスペクタ、または全項目表で行う。 */}
                      <div
                        className="io-summary"
                        title="クリックで詳細（入出力・課題を編集）"
                        onClick={() => {
                          select(t.id);
                          useUI.getState().setInspectorOpen(true);
                        }}
                      >
                        {ioCount === 0 && issueCount === 0 ? (
                          <span className="io-empty">—</span>
                        ) : (
                          <>
                            {(detail?.inputs?.length ?? 0) > 0 && (
                              <span className="io-pip in">
                                <span className="io-dot" />入{detail?.inputs?.length}
                              </span>
                            )}
                            {(detail?.outputs?.length ?? 0) > 0 && (
                              <span className="io-pip out">
                                <span className="io-dot" />出{detail?.outputs?.length}
                              </span>
                            )}
                            {issueCount > 0 && (
                              <span className="io-pip issue">
                                <span className="io-dot" />課題{issueCount}
                              </span>
                            )}
                          </>
                        )}
                      </div>
                    </td>
                    )}
                    <td className="c-act" onClick={(e) => e.stopPropagation()}>
                      {t.level !== 'detail' && (
                        <button
                          title="子工程を追加"
                          aria-label="子工程を追加"
                          onClick={() => {
                            const nid = addChildTask(t.id);
                            if (nid) {
                              // 折りたたまれた親の下に作ると新しい行が見えないため、先に展開する。
                              if (collapsed.has(t.id)) toggleCollapse(t.id);
                              select(nid);
                            }
                          }}
                        >
                          ＋子
                        </button>
                      )}
                      <button
                        className="danger"
                        title="削除"
                        aria-label={`「${t.name}」を削除`}
                        onClick={() => void confirmRemoveTasks([t.id])}
                      >
                        ×
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          </div>
        </>
      )}
    </div>
  );
}
