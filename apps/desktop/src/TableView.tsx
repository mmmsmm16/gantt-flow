import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { ProcessTask, ProcessLevel, Id, TaskDetail, TaskStatus } from '@gantt-flow/core';
import { computeCodes, computeEffortRollups, effortMinutesToHours, formatHours, bridgePredMap, isMilestone } from '@gantt-flow/core';
import { useApp } from './store';
import { buildPrevCandidateIndex } from './suggestions';
import { PrevCandidateOptions } from './PrevCandidateOptions';
import { validateEffort, markEffortInvalid, clearEffortInvalid, isEffortBlurUnchanged } from './parseEffort';
import { cancelEditOnEscape, selectAllOnFocus, nameEscapeAction } from './inputBehaviors';
import { nameLenClass, nameLenTitle, onNameInput } from './nameLimit';
import { useUI, OUTLINE_OPTIONAL_COLUMNS } from './ui/useUI';
import { STATUS_OPTIONS, statusSelectClass } from './statusUi';
import { useFlashIds } from './ui/useFlash';
import { Menu, MenuCheckItem, MenuItem } from './ui/Menu';
import { useRowSelectionKeys, scrollRowIntoView, shouldRoveRowFocus } from './ui/useRowSelectionKeys';
import { useRowMultiSelect } from './ui/useRowMultiSelect';
import { filterOutlineRows } from './outlineFilter';
import { revealTask, selectTask, confirmRemoveTasks, toastUndo, removeDependencyWithUndo } from './taskOps';
import { isImeKeyEvent, isEditableTarget } from './keymap';
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

// 実機FB: アウトラインの「入出」列＝入力→出力の順、「課題」列＝課題文の一覧。
// 件数バッジをクリックするとポップオーバーで名称/課題文を並べ、項目クリックで
// インスペクタの該当セクションへ寄せる（受け口 focusInspectorIo は FB-1 の I/O 経路を再利用）。
export type OutlineIoGroup = 'inputs' | 'outputs';
export interface OutlineIoItem {
  id: Id;
  name: string;
  io: OutlineIoGroup;
}
export interface OutlineIssueItem {
  id: Id;
  text: string;
}

// 入出セルの一覧項目（入力→出力の順）。各項目は Inspector の該当 I/O へ寄せる io/ioId を持つ。
export function outlineIoItems(detail: TaskDetail | undefined): OutlineIoItem[] {
  return [
    ...(detail?.inputs ?? []).map((it) => ({ id: it.id, name: it.name, io: 'inputs' as const })),
    ...(detail?.outputs ?? []).map((it) => ({ id: it.id, name: it.name, io: 'outputs' as const })),
  ];
}

// 課題セルの一覧項目。課題文（issue）だけを並べる（方策 measure は Inspector 側で見る）。
export function outlineIssueItems(detail: TaskDetail | undefined): OutlineIssueItem[] {
  return (detail?.issues ?? []).map((it) => ({ id: it.id, text: it.issue }));
}

// セル内ポップオーバー。.outline-scroll の overflow に切られないよう fixed で出し、外側クリック /
// Esc（registerTransientLayer 経由）/ 再スクロールで閉じる。トリガは <button> なので Enter/Space で
// 開き、開いたら先頭項目へフォーカスして ↑↓/Home/End で移動できる（Menu と同じ規約）。
function CellPopover({
  label,
  title,
  ariaLabel,
  children,
}: {
  label: ReactNode;
  title: string;
  ariaLabel: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const openedAt = useRef(0);

  const openAt = () => {
    const r = btnRef.current?.getBoundingClientRect();
    if (r) setPos({ left: Math.max(8, Math.min(r.left, window.innerWidth - 260)), top: r.bottom + 4 });
    openedAt.current = performance.now();
    setOpen(true);
  };
  const close = () => {
    setOpen(false);
    btnRef.current?.focus();
  };

  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e: PointerEvent) => {
      const target = e.target as Node;
      if (btnRef.current?.contains(target) || popRef.current?.contains(target)) return;
      setOpen(false);
    };
    // スクロールで固定配置がトリガから離れるため閉じる。ただし開いた直後は、行選択に伴う
    // 自動スクロール（selectedTaskId の scrollRowIntoView）で即閉じないよう猶予を置く。
    const onScroll = () => {
      if (performance.now() - openedAt.current > 300) setOpen(false);
    };
    window.addEventListener('pointerdown', onDown);
    window.addEventListener('scroll', onScroll, true); // capture=内側スクローラも拾う
    const unregister = useUI.getState().registerTransientLayer(() => setOpen(false));
    popRef.current?.querySelector<HTMLElement>('.menu-item')?.focus(); // 開いたら先頭項目へ
    return () => {
      window.removeEventListener('pointerdown', onDown);
      window.removeEventListener('scroll', onScroll, true);
      unregister();
    };
  }, [open]);

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        className="io-pop-trigger"
        title={title}
        aria-label={ariaLabel}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => (open ? close() : openAt())}
      >
        {label}
      </button>
      {open && pos && (
        <div
          ref={popRef}
          className="menu io-pop"
          role="menu"
          style={{ left: pos.left, top: pos.top }}
          onClick={() => setOpen(false)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.preventDefault();
              e.stopPropagation();
              close();
              return;
            }
            if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return;
            e.preventDefault();
            e.stopPropagation();
            const items = Array.from(popRef.current?.querySelectorAll<HTMLElement>('.menu-item') ?? []);
            if (items.length === 0) return;
            const i = items.indexOf(document.activeElement as HTMLElement);
            let next: number;
            if (e.key === 'Home') next = 0;
            else if (e.key === 'End') next = items.length - 1;
            else if (i < 0) next = e.key === 'ArrowDown' ? 0 : items.length - 1;
            else next = (i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
            items[next]!.focus();
          }}
        >
          {children}
        </div>
      )}
    </>
  );
}

export function TableView() {
  const project = useApp((s) => s.project);
  const selectedTaskId = useApp((s) => s.selectedTaskId);
  const select = useApp((s) => s.select);
  const renameTask = useApp((s) => s.renameTask);
  const removeTask = useApp((s) => s.removeTask);
  const setTaskLevel = useApp((s) => s.setTaskLevel);
  const setAssigneeByName = useApp((s) => s.setAssigneeByName);
  const updateDetail = useApp((s) => s.updateDetail);
  const addRootTask = useApp((s) => s.addRootTask);
  const addChildTask = useApp((s) => s.addChildTask);
  const addMilestone = useApp((s) => s.addMilestone);
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
  // 文字列は useUI に置く＝表⇄フロー切替や粒度変更で TableView が再マウントされても揮発しない(#26)。
  const findQuery = useUI((s) => s.outlineFilter);
  const setFindQuery = useUI((s) => s.setOutlineFilter);
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
  // 新規作成直後の作業名へ即フォーカス＆全選択（描画直後に同期実行＝空振り防止）。
  useLayoutEffect(() => {
    if (!focusId) return;
    const el = nameRefs.current.get(focusId);
    if (el) {
      el.focus();
      el.select();
    }
    setFocusId(null);
  }, [focusId, rows.length]);

  // 両窓編集同期: 発信元窓の focusHint が「表での作成→即リネーム」を要求したら、その行を選択して
  // 作業名入力へフォーカスする（他の追加経路＝addRootAndEdit と同じ select + setFocusId 経路）。
  // フォロワー窓が、リーダーから届いた新工程 id を受けて開く。seq でトリガ（再マウントの二重発火防止）。
  const renameRequest = useUI((s) => s.renameRequest);
  const consumedRenameSeq = useRef(useUI.getState().renameRequest?.seq ?? 0);
  useEffect(() => {
    if (renameRequest && renameRequest.surface === 'table' && renameRequest.seq > consumedRenameSeq.current) {
      consumedRenameSeq.current = renameRequest.seq;
      select(renameRequest.taskId);
      setFocusId(renameRequest.taskId);
    }
  }, [renameRequest]);

  // 選択中の工程が変わったら、その行が画面外のとき視点を寄せる（フロー→表追従）。
  // 'nearest' なので表側の操作で既に見えている時は動かない。畳まれて未描画なら no-op。
  // あわせて roving focus: 表がアクティブかつ編集中でないときは選択行に実 DOM フォーカスを移す
  //（スクリーンリーダーが選択行を読み、フォーカスリングが選択に追従する）。フローからの選択同期や
  // セル編集中はフォーカスを奪わない（shouldRoveRowFocus のガード）。
  useEffect(() => {
    if (!selectedTaskId) return;
    const raf = requestAnimationFrame(() => {
      scrollRowIntoView(selectedTaskId);
      const active = document.activeElement;
      const inTable = !active || active === document.body || !!active.closest?.('#main-table');
      if (
        shouldRoveRowFocus({
          activePane: useUI.getState().activePane,
          editable: isEditableTarget(active),
          inTable,
        })
      ) {
        document
          .querySelector<HTMLElement>(`tr[data-taskid="${CSS.escape(selectedTaskId)}"]`)
          ?.focus({ preventScroll: true });
      }
    });
    return () => cancelAnimationFrame(raf);
  }, [selectedTaskId]);

  const toggleCollapse = useUI((s) => s.toggleOutlineCollapsed);

  // 行クリック(通常＝選択＋粒度同期のみ、Ctrl/⌘＝トグル、Shift＝範囲)と一括操作は全項目表と
  // 共有のフックに集約。範囲は表示中の行(rows・折りたたみ配下は除外)内で解決。
  // C-01: クリックは選択だけで詳細パネルを開かない（selectTask）。詳細を開くのは行の
  // ダブルクリック(revealTask)・詳細トグルボタン・パレット。既に開いていれば選択追従で対象が
  // 切り替わる。スコープ追従の規則はパレット等と共通の selectTask/revealTask(taskOps.ts)に集約。
  const {
    marked,
    onRowClick,
    clear: clearMarked,
    bulkAssign,
    bulkDelete,
  } = useRowMultiSelect({ orderedIds: rows.map((r) => r.task.id), onActivate: selectTask });

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
      selectTask(id); // 編集開始時のみフローの粒度/スコープを同期(j/k 中はしない)。C-01: Enter で詳細は開かない
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
    onEditNavPastEnd: () => addGhostRow(), // 最終行で Enter 下移動 → 末尾に新規行を起こす
  });
  const cursorCol = cursorColumns[colIdx];
  // 選択行のカーソル列のセルを強調する(キーボードで「いまどのセルか」を示す)。
  const cellCursorCls = (taskId: Id, key: string) =>
    taskId === selectedTaskId && activePane === 'table' && cursorCol === key ? ' cell-cursor' : '';

  const commitName = (t: ProcessTask, value: string) => {
    if (value === t.name) return;
    renameTask(t.id, value);
    // Excel 流の「選択セルへ打鍵＝全置換」で既存名を気づかず潰す事故の安全網。
    // 旧名の面影が残らない全置換のときだけ「元に戻す」付きで知らせる（部分修正では出さない）。
    const old = t.name.trim();
    if (old && value.trim() && !value.includes(old) && !old.includes(value.trim())) {
      toastUndo(`「${old}」を「${value.trim()}」に変更しました`);
    }
  };

  // 入出/課題セルのポップオーバー項目クリック: 工程を選択し詳細パネルを開く。I/O は FB-1 の
  // 受け口（focusInspectorIo）で該当項目まで寄せる。課題はセクションを開くだけ（受け口を追加しない）。
  const openIoInspector = (taskId: Id, io: OutlineIoGroup, ioId: Id) => {
    select(taskId);
    const ui = useUI.getState();
    ui.setInspectorOpen(true);
    ui.focusInspectorIo(io, ioId);
  };
  const openIssueInspector = (taskId: Id) => {
    select(taskId);
    useUI.getState().setInspectorOpen(true);
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

  // マイルストーンを追加（現在の表示粒度/スコープ。addMilestone が選択まで行うので即フォーカスのみ）。
  const addMilestoneAndEdit = () => {
    const id = addMilestone();
    if (id) setFocusId(id);
  };

  // 末尾ゴースト行: 最終行と同じ親・粒度で新規工程を起こし、その作業名入力へフォーカス（連続入力）。
  const addGhostRow = () => {
    const last = rows[rows.length - 1];
    if (!last) return;
    const nid = addSiblingOf(last.task.id);
    if (nid) {
      select(nid);
      setFocusId(nid);
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
        <button
          className="ms-add"
          title="マイルストーンを追加（節目。子工程・担当・工数は持たない）"
          onClick={addMilestoneAndEdit}
        >
          <Icons.MilestoneDiamond />マイルストーン
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
        {marked.size > 0 && (
          <span className="ft-bulk" role="group" aria-label="一括操作">
            <strong>{marked.size}件選択中</strong>
            <button onClick={bulkAssign}>担当を一括設定</button>
            <button className="danger" onClick={bulkDelete}>まとめて削除</button>
            <button className="ft-bulk-clear" onClick={clearMarked}>選択解除</button>
          </span>
        )}
      </div>

      {rows.length === 0 ? (
        findActive ? (
          <p className="empty">「{findQuery}」に一致する工程がありません。</p>
        ) : (
          <div className="empty empty-cta">
            <p>まだ工程がありません。最初の作業を追加しましょう。</p>
            <div className="empty-actions">
              <button className="primary" onClick={() => addRootAndEdit('large')}>
                ＋ 大工程を追加
              </button>
              <button onClick={() => addRootAndEdit('medium')}>＋ 中工程を追加</button>
            </div>
          </div>
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
            role="grid"
            aria-label="工程表（手順一覧）"
            aria-rowcount={rows.length}
            onKeyDown={editNavKeyDown}
            style={{
              // 固定列の合計 + 作業名の最小幅 + 表示中の任意列。狭いペインではペインが横スクロールする。
              minWidth: 354 + 160 + visibleOptionalColumns.reduce((sum, c) => sum + c.width, 0),
            }}
          >
            <thead>
              <tr role="row">
                <th className="c-grip" role="columnheader" aria-hidden="true"></th>
                <th className="c-code" role="columnheader">No.</th>
                <th className="c-level" role="columnheader">粒度</th>
                <th className="c-name" role="columnheader">作業名</th>
                <th className="c-assignee" role="columnheader">担当</th>
                {visibleOptionalColumns.flatMap((c) =>
                  c.key === 'io'
                    ? [
                        <th key="io" className="c-io" role="columnheader">入出</th>,
                        <th key="issue" className="c-issue" role="columnheader">課題</th>,
                      ]
                    : [
                        <th key={c.key} className={`c-${c.key}`} role="columnheader">
                          {c.label}
                        </th>,
                      ],
                )}
                <th className="c-act" role="columnheader"></th>
              </tr>
            </thead>
            <tbody>
              {rows.map(({ task: t, depth, ancestorLines, isLast }) => {
                const detail = project.details[t.id];
                const ms = isMilestone(project.core, t.id);
                const assigneeName = t.assigneeId
                  ? project.core.assignees[t.assigneeId]?.name ?? ''
                  : '';
                const ioItems = outlineIoItems(detail);
                const inItems = ioItems.filter((i) => i.io === 'inputs');
                const outItems = ioItems.filter((i) => i.io === 'outputs');
                const issueItems = outlineIssueItems(detail);
                const hasChildren = parentsWithChildren.has(t.id);
                const preds = deps.filter((dep) => dep.to === t.id);
                const candidates = columnVisibility.prev ? prevCandidatesFor(t.id) : [];
                return (
                  <tr
                    key={t.id}
                    data-taskid={t.id}
                    role="row"
                    // roving focus: 選択行だけ実フォーカスを受ける（キー操作で選択に追従・SR が読む）。
                    tabIndex={-1}
                    aria-selected={t.id === selectedTaskId}
                    className={[
                      t.id === selectedTaskId ? 'selected' : '',
                      dragId === t.id ? 'dragging' : '',
                      dropInfo?.id === t.id ? `drop-${dropInfo.mode}` : '',
                      hasChildren ? 'is-parent' : '',
                      depth > 0 ? 'is-child' : '',
                      ms ? 'is-milestone' : '',
                      marked.has(t.id) ? 'marked' : '',
                    ]
                      .filter(Boolean)
                      .join(' ')}
                    onClickCapture={(e) => {
                      // 修飾クリック（Ctrl/⌘/Shift）＝複数選択。各セルの stopPropagation より先に
                      // capture 段で拾い、入力へのフォーカス／テキスト選択を止める（preventDefault）。
                      // 修飾なしのクリックは行を選択するだけ（onRowClick 内 selectTask。C-01: 詳細は開かない）。
                      if (e.ctrlKey || e.metaKey || e.shiftKey) {
                        e.preventDefault();
                        e.stopPropagation();
                      }
                      onRowClick(e, t.id);
                    }}
                    onDoubleClick={(e) => {
                      // C-01: 詳細パネルを開く明示操作＝行のダブルクリック（修飾中の範囲/複数選択は除く）。
                      if (e.ctrlKey || e.metaKey || e.shiftKey) return;
                      revealTask(t.id);
                    }}
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
                    <td className="c-grip" role="gridcell" onClick={(e) => e.stopPropagation()}>
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
                    <td className="c-code" role="gridcell" title={codes[t.id]}>
                      {ms ? <span className="ms-cell-blank">—</span> : codes[t.id]}
                    </td>
                    <td className="c-level" role="gridcell" onClick={(e) => e.stopPropagation()}>
                      {ms ? (
                        <span className="ms-cell-blank" title="マイルストーンは粒度を持ちません">—</span>
                      ) : (
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
                      )}
                    </td>
                    <td className="c-name" role="gridcell">
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
                        {ms && <span className="ms-badge" title="マイルストーン" aria-hidden="true" />}
                        <input
                          className={`name-input${detail?.textColor ? ' colored-text' : ''}${matched.has(t.id) ? ' name-match' : ''}${cellCursorCls(t.id, 'name')}${nameLenClass(t.name)}`}
                          title={nameLenTitle(t.name)}
                          onInput={onNameInput}
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
                          {...selectAllOnFocus}
                          onKeyDown={(e) => {
                            if (isImeKeyEvent(e)) return; // IME 変換の確定 Enter/Tab/Esc を編集操作にしない
                            // Enter/Tab は表全体の editNavKeyDown(両ビュー共通のセル移動規約)に任せる。
                            // インデントは行選択モードの Tab(table.indent)に一本化した。
                            if (e.key === 'Escape') {
                              e.stopPropagation(); // グローバルの Esc(選択解除)を発火させない
                              // #1 直前作成の未コミット行(name==='')は Escape で行ごと削除しゴーストを残さない。
                              if (nameEscapeAction(t.name) === 'remove') {
                                removeTask(t.id);
                                return;
                              }
                              e.currentTarget.value = t.name; // 既存行は従来どおりリネーム取り消し
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
                    <td className={`c-assignee${assigneeFlash.has(t.id) ? ' cell-flash' : ''}`} role="gridcell">
                      {ms ? (
                        <span className="ms-cell-blank" title="マイルストーンは担当を持ちません">—</span>
                      ) : (
                        <input
                          className={`assignee${cellCursorCls(t.id, 'assignee')}`}
                          data-cell="assignee"
                          list="assignee-names"
                          defaultValue={assigneeName}
                          key={`asg-${assigneeName}`}
                          placeholder="（未割当）"
                          aria-label="担当"
                          onClick={(e) => e.stopPropagation()}
                          {...selectAllOnFocus}
                          onKeyDown={cancelEditOnEscape}
                          onBlur={(e) => {
                            if (e.target.value !== assigneeName) setAssigneeByName(t.id, e.target.value);
                          }}
                        />
                      )}
                    </td>
                    {columnVisibility.status && (
                    <td className="c-status" role="gridcell" onClick={(e) => e.stopPropagation()}>
                      <select
                        className={`ol-status ${statusSelectClass(detail)}${cellCursorCls(t.id, 'status')}`}
                        data-cell="status"
                        value={detail?.status ?? ''}
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
                    )}
                    {columnVisibility.prev && (
                    <td className="c-prev" role="gridcell" onClick={(e) => e.stopPropagation()}>
                      <div className="ft-prev">
                        {preds.map((dep) => (
                          <span className="ft-pill" key={dep.id}>
                            {project.core.tasks[dep.from]?.name ?? ''}
                            <button
                              className="ft-x"
                              aria-label="前工程を解除"
                              title="前工程を解除"
                              onClick={() => removeDependencyWithUndo(dep.id)}
                            >
                              ×
                            </button>
                          </span>
                        ))}
                        {(bridgePreds[t.id] ?? []).map((fromId) => (
                          <span
                            key={`br-${fromId}`}
                            className="ft-pill derived"
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
                            <PrevCandidateOptions
                              candidates={candidates}
                              parentName={(pid) => (pid ? (project.core.tasks[pid]?.name ?? '別グループ') : '最上位')}
                            />
                          </select>
                        )}
                      </div>
                    </td>
                    )}
                    {columnVisibility.effort && (
                    <td className="c-effort" role="gridcell" onClick={(e) => e.stopPropagation()}>
                      {ms ? (
                        <span className="ms-cell-blank" title="マイルストーンは工数を持ちません">—</span>
                      ) : hasChildren ? (
                        <span className="effort-roll" title="子の合計（自動）">
                          {formatHours(effortRollups.get(t.id) ?? 0)}
                        </span>
                      ) : (
                        <input
                          className={`effort-input${cellCursorCls(t.id, 'effort')}`}
                          data-cell="effort"
                          // #3 type=number をやめて text + inputMode=decimal に統一（ホイール誤変更・
                          // カンマ黙殺を解消。カンマ/全角は parseEffort が正規化）。To-Be 欄と同じ型。
                          type="text"
                          inputMode="decimal"
                          defaultValue={detail?.effortMinutes != null ? effortMinutesToHours(detail.effortMinutes) : ''}
                          placeholder="例: 2 / 0.5"
                          aria-label="工数（時間）"
                          onClick={(e) => e.stopPropagation()}
                          onKeyDown={cancelEditOnEscape}
                          onBlur={(e) => {
                            const res = validateEffort(e.target.value);
                            if (!res.ok) {
                              // 不正値: 打った文字は残し、セルを不正表示にして commit だけブロック（理由はトーストで即提示）。
                              markEffortInvalid(e.target, res.message);
                              useUI.getState().toast(`${res.message}（例: 2 や 0.5）`, 'error');
                              return;
                            }
                            clearEffortInvalid(e.target);
                            if (isEffortBlurUnchanged(e.target.value, detail?.effortMinutes)) return; // 無編集 blur は書き換えない
                            if (res.minutes !== detail?.effortMinutes) updateDetail(t.id, { effortMinutes: res.minutes });
                          }}
                        />
                      )}
                    </td>
                    )}
                    {columnVisibility.io && (
                      <>
                        {/* 実機FB: 入出（入力→出力）と課題を別列に分離。件数バッジをクリックで
                            名称/課題文のポップオーバー、項目クリックでインスペクタの該当箇所へ。 */}
                        <td
                          className={`c-io${cellCursorCls(t.id, 'io')}`}
                          role="gridcell"
                          data-cell="io"
                          onClick={(e) => e.stopPropagation()}
                        >
                          {ioItems.length === 0 ? (
                            <span className="io-empty">—</span>
                          ) : (
                            <CellPopover
                              title="入力・出力の名称一覧（クリックで詳細へ）"
                              ariaLabel={`入力 ${inItems.length} 件・出力 ${outItems.length} 件（クリックで名称一覧）`}
                              label={
                                <>
                                  {inItems.length > 0 && (
                                    <span className="io-pip in">
                                      <span className="io-dot" />入{inItems.length}
                                    </span>
                                  )}
                                  {outItems.length > 0 && (
                                    <span className="io-pip out">
                                      <span className="io-dot" />出{outItems.length}
                                    </span>
                                  )}
                                </>
                              }
                            >
                              {inItems.length > 0 && <div className="menu-caption">入力</div>}
                              {inItems.map((it) => (
                                <MenuItem key={it.id} onClick={() => openIoInspector(t.id, 'inputs', it.id)}>
                                  <span className="io-dot in" />
                                  <span className="io-pop-name">{it.name || '（名称なし）'}</span>
                                </MenuItem>
                              ))}
                              {outItems.length > 0 && <div className="menu-caption">出力</div>}
                              {outItems.map((it) => (
                                <MenuItem key={it.id} onClick={() => openIoInspector(t.id, 'outputs', it.id)}>
                                  <span className="io-dot out" />
                                  <span className="io-pop-name">{it.name || '（名称なし）'}</span>
                                </MenuItem>
                              ))}
                            </CellPopover>
                          )}
                        </td>
                        <td className="c-issue" role="gridcell" data-cell="issue" onClick={(e) => e.stopPropagation()}>
                          {issueItems.length === 0 ? (
                            <span className="io-empty">—</span>
                          ) : (
                            <CellPopover
                              title="課題の一覧（クリックで詳細へ）"
                              ariaLabel={`課題 ${issueItems.length} 件（クリックで一覧）`}
                              label={
                                <span className="io-pip issue">
                                  <span className="io-dot" />課題{issueItems.length}
                                </span>
                              }
                            >
                              {issueItems.map((it) => (
                                <MenuItem key={it.id} onClick={() => openIssueInspector(t.id)}>
                                  <span className="io-dot issue" />
                                  <span className="io-pop-name">{it.text || '（内容なし）'}</span>
                                </MenuItem>
                              ))}
                            </CellPopover>
                          )}
                        </td>
                      </>
                    )}
                    <td className="c-act" role="gridcell" onClick={(e) => e.stopPropagation()}>
                      {t.level !== 'detail' && !ms && (
                        <button
                          title="子工程を追加"
                          aria-label="子工程を追加"
                          onClick={() => {
                            const nid = addChildTask(t.id);
                            if (nid) {
                              // 折りたたまれた親の下に作ると新しい行が見えないため、先に展開する。
                              if (collapsed.has(t.id)) toggleCollapse(t.id);
                              select(nid);
                              setFocusId(nid); // #6 他の追加経路と同じく作業名へ即フォーカス＆全選択
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
              {/* 末尾ゴースト行: 「一番下の空行へ直接入力」の入口。検索絞り込み中は出さない。 */}
              {!findActive && rows.length > 0 && (
                <tr className="outline-ghost" role="row" onClick={addGhostRow}>
                  <td colSpan={6 + visibleOptionalColumns.length + (columnVisibility.io ? 1 : 0)} role="gridcell">＋ 新しい工程…</td>
                </tr>
              )}
            </tbody>
          </table>
          </div>
        </>
      )}
    </div>
  );
}
