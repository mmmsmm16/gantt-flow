import { useEffect, useMemo, useRef, useState } from 'react';
import type { ProcessTask, ProcessLevel, Id } from '@gantt-flow/core';
import { computeCodes, computeEffortRollups, formatHours, bridgePredMap } from '@gantt-flow/core';
import { useApp } from './store';
import { buildPrevCandidateIndex } from './suggestions';
import { parseEffortHoursToMinutes } from './parseEffort';
import { useUI, OUTLINE_OPTIONAL_COLUMNS } from './ui/useUI';
import { Menu, MenuCheckItem } from './ui/Menu';
import { useRowSelectionKeys } from './ui/useRowSelectionKeys';
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
  const indentTask = useApp((s) => s.indentTask);
  const outdentTask = useApp((s) => s.outdentTask);
  const dropTask = useApp((s) => s.dropTask);
  const addDependency = useApp((s) => s.addDependency);
  const addIo = useApp((s) => s.addIo);
  const updateIo = useApp((s) => s.updateIo);
  const removeIo = useApp((s) => s.removeIo);
  const tableWide = useUI((s) => s.tableWide);
  const toggleTableWide = useUI((s) => s.toggleTableWide);
  const columnVisibility = useUI((s) => s.columnVisibility);
  const toggleColumn = useUI((s) => s.toggleColumn);

  const tasks = Object.values(project.core.tasks);
  // 折りたたみ状態は useUI に置く(コマンドパレットの全折りたたみ/全展開と共有・非マウント時も保持)。
  const collapsed = useUI((s) => s.outlineCollapsed);
  const setCollapsed = useUI((s) => s.setOutlineCollapsed);
  const rows = buildOutline(tasks, collapsed);
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
  const { colIdx } = useRowSelectionKeys({
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
  });
  const cursorCol = cursorColumns[colIdx];
  // 選択行のカーソル列のセルを強調する(キーボードで「いまどのセルか」を示す)。
  const cellCursorCls = (taskId: Id, key: string) =>
    taskId === selectedTaskId && activePane === 'table' && cursorCol === key ? ' cell-cursor' : '';

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
        {parentsWithChildren.size > 0 && (
          <span className="outline-collapse">
            <button onClick={() => setCollapsed(new Set())} title="すべて展開">
              全展開
            </button>
            <button
              onClick={() => setCollapsed(new Set(parentsWithChildren))}
              title="すべて折りたたみ"
            >
              全折りたたみ
            </button>
          </span>
        )}
        <Menu
          className="icon-btn menu-trigger col-menu"
          title="表示する列"
          label={
            <>
              <Icons.Columns />
              列<Icons.ChevronDown />
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
          <div className="outline-scroll">
          <table
            className="grid"
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
                          className={`name-input${detail?.textColor ? ' colored-text' : ''}${cellCursorCls(t.id, 'name')}`}
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
                            if (e.key === 'Enter') {
                              // 確定して選択モードへ(誤挿入防止のため行追加はしない。追加は n / Ctrl+Enter)。
                              e.preventDefault();
                              e.stopPropagation(); // blur 後にグローバルの Enter(セル編集)が再発火しないように
                              commitName(t, e.currentTarget.value);
                              e.currentTarget.blur();
                            } else if (e.key === 'Escape') {
                              e.stopPropagation(); // グローバルの Esc(選択解除)を発火させない
                              e.currentTarget.value = t.name;
                              e.currentTarget.blur();
                            } else if (e.key === 'Tab') {
                              e.preventDefault();
                              commitName(t, e.currentTarget.value);
                              if (e.shiftKey) outdentTask(t.id);
                              else indentTask(t.id);
                              setFocusId(t.id);
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
                    <td className="c-assignee">
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
                      <div className="io-chips">
                        {(
                          [
                            ['in', detail?.inputs ?? [], '入力'],
                            ['out', detail?.outputs ?? [], '出力'],
                          ] as const
                        ).flatMap(([dir, items, label]) =>
                          items.map((item) => (
                            <span className={`io-chip ${dir}`} key={item.id}>
                              <input
                                className="io-chip-name"
                                defaultValue={item.name}
                                aria-label={`${label}名`}
                                // 触れただけの blur で履歴と未保存フラグを汚さない（変化があるときだけコミット）。
                                onBlur={(e) => {
                                  if (e.target.value !== item.name) updateIo(t.id, item.id, { name: e.target.value });
                                }}
                              />
                              <button
                                className="io-chip-x"
                                aria-label={`${label}を削除`}
                                onClick={() => removeIo(t.id, item.id)}
                              >
                                ×
                              </button>
                            </span>
                          )),
                        )}
                        <button
                          className="io-add"
                          title="入力を追加"
                          onClick={() => addIo(t.id, 'inputs', '帳票')}
                        >
                          ＋入
                        </button>
                        <button
                          className="io-add"
                          title="出力を追加"
                          onClick={() => addIo(t.id, 'outputs', '帳票')}
                        >
                          ＋出
                        </button>
                        {issueCount > 0 && (
                          <span
                            className="chip chip-issue io-issue"
                            title="課題（クリックでインスペクタ）"
                            onClick={() => {
                              select(t.id);
                              useUI.getState().setInspectorOpen(true);
                            }}
                          >
                            課題{issueCount}
                          </span>
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
