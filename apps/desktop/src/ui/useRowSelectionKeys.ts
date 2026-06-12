// 表の「行選択モード」のキー操作(編集外)。アウトライン(TableView)と全項目表(FullTable)で
// 同じ操作系を共有する。キーの照合とガードは useGlobalHotkeys が済ませており、
// ここは 'table' コンテキストのアクション(table.*)を実行するだけ。
// j/k での高速移動中はフロー側の粒度/スコープ同期(openRow 相当)を行わず、編集開始時のみ同期する。
// h/l・←→ で「列カーソル」を動かし、Enter でそのセルの入力へフォーカス(Excel 風)。
// セルの特定は行内の data-cell 属性(コンポーネント側が付与)で行う。
import { useCallback, useEffect, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import type { Id } from '@gantt-flow/core';
import { useApp } from '../store';
import { useUI } from './useUI';
import { confirmRemoveTasks } from '../taskOps';
import { isImeKeyEvent } from '../keymap';
import { registerContextHandler } from './useGlobalHotkeys';

export interface RowSelectionOpts {
  /** このビューが操作対象のとき true(activePane==='table' かつ自分が表示中)。 */
  enabled: boolean;
  /** 表示順の工程 ID(折りたたみ・ソート・絞り込み反映済み)。 */
  orderedIds: Id[];
  /** 列カーソルの対象(表示順の data-cell キー)。Enter でそのセルを編集する。 */
  columns: string[];
  /** 名前編集を開始する(新規行追加時のフォーカス用。再レンダ後のフォーカスは呼び出し側が保証)。 */
  beginEdit: (taskId: Id) => void;
  /** 折りたたみトグル(アウトラインのみ)。 */
  toggleCollapse?: (taskId: Id) => void;
  /** クイックフィルタの検索ボックスへフォーカス(アウトラインのみ。Ctrl/⌘+F)。 */
  openFind?: () => boolean;
}

export function scrollRowIntoView(taskId: Id): void {
  document
    .querySelector(`tr[data-taskid="${CSS.escape(taskId)}"]`)
    ?.scrollIntoView({ block: 'nearest' });
}

// セルを横スクロールで可視範囲に入れる。全項目表の固定列(sticky)の影に隠れないよう、
// 左固定列(No.+粒度列)の右端を「実質の左端」、右固定列(アクション列)の左端を
// 「実質の右端」として補正する(scrollIntoView は sticky のかぶりを考慮しないため)。
function scrollCellVisible(cell: HTMLElement): void {
  cell.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  const scroller = cell.closest('.ft-scroll, .outline-scroll');
  const td = cell.closest('td');
  const row = cell.closest('tr');
  if (!(scroller instanceof HTMLElement) || !td || !row) return;
  if (getComputedStyle(td).position === 'sticky') return; // 固定列は常に見えている
  const sr = scroller.getBoundingClientRect();
  let stickyRight = sr.left; // 左固定列の右端
  let stickyLeft = sr.right; // 右固定列の左端
  for (const c of Array.from(row.children)) {
    if (!(c instanceof HTMLElement)) continue;
    const cs = getComputedStyle(c);
    if (cs.position !== 'sticky') continue;
    const r = c.getBoundingClientRect();
    if (cs.left !== 'auto') stickyRight = Math.max(stickyRight, r.right);
    else if (cs.right !== 'auto') stickyLeft = Math.min(stickyLeft, r.left);
  }
  const cr = td.getBoundingClientRect();
  if (cr.left < stickyRight) scroller.scrollLeft -= stickyRight - cr.left + 8;
  else if (cr.right > stickyLeft) scroller.scrollLeft += cr.right - stickyLeft + 8;
}

// 選択行の指定セル(data-cell)を取得。
function cellOf(taskId: Id, colKey: string | undefined): HTMLElement | null {
  if (!colKey) return null;
  const el = document.querySelector(
    `tr[data-taskid="${CSS.escape(taskId)}"] [data-cell="${CSS.escape(colKey)}"]`,
  );
  return el instanceof HTMLElement ? el : null;
}

// 選択行の指定セル(data-cell)の入力へフォーカスして編集を開始する。
// data-cell が入力要素そのものなら直接、複合セル(I/O・課題・方策・前工程などの
// チップ+ボタン構成)は td 側に付け、中の最初の入力(無ければ追加ボタン)へフォーカスする。
// editableOnly=true(編集中の Enter/Tab セル移動)は input/textarea だけを対象にし、
// select やボタンしか無いセルはスキップ扱いにする(編集可能セルだけを辿る規約)。
export function focusCell(taskId: Id, colKey: string | undefined, editableOnly = false): boolean {
  const el = cellOf(taskId, colKey);
  if (!el) return false;
  // 入力系を優先し、無ければ追加ボタン等へ(×削除ボタンに最初のフォーカスが
  // 当たって Enter 連打で誤削除…を避けるため、button は最後の手段)。
  const editable = el.matches('input, textarea')
    ? el
    : el.querySelector<HTMLElement>('input, textarea');
  const target = editableOnly
    ? editable
    : (editable ??
      (el.matches('select, button')
        ? el
        : (el.querySelector<HTMLElement>('select') ?? el.querySelector<HTMLElement>('button'))));
  if (!target) return false;
  target.focus();
  if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) target.select();
  scrollCellVisible(el);
  return true;
}

export type EditNavDir = 'up' | 'down' | 'left' | 'right';

// 編集中ナビゲーションの移動先解決。tryFocus が true を返す最初のセルまで一方向に辿る
// (編集できない行・列を飛ばす)。DOM 非依存の純粋ロジックとして切り出しテスト可能にする。
export function resolveEditNavTarget(
  grid: { orderedIds: readonly Id[]; columns: readonly string[] },
  from: { taskId: Id; colKey: string },
  dir: EditNavDir,
  tryFocus: (taskId: Id, colKey: string) => boolean,
): { taskId: Id; colKey: string } | null {
  if (dir === 'up' || dir === 'down') {
    const r = grid.orderedIds.indexOf(from.taskId);
    if (r < 0) return null;
    const step = dir === 'down' ? 1 : -1;
    for (let i = r + step; i >= 0 && i < grid.orderedIds.length; i += step) {
      const id = grid.orderedIds[i]!;
      if (tryFocus(id, from.colKey)) return { taskId: id, colKey: from.colKey };
    }
  } else {
    const c = grid.columns.indexOf(from.colKey);
    if (c < 0) return null;
    const step = dir === 'right' ? 1 : -1;
    for (let j = c + step; j >= 0 && j < grid.columns.length; j += step) {
      const key = grid.columns[j]!;
      if (tryFocus(from.taskId, key)) return { taskId: from.taskId, colKey: key };
    }
  }
  return null;
}

// 編集中(セル内入力)の Enter/Tab ナビゲーション(Excel 風)。アウトラインと全項目表で共通の規約:
//  Enter=確定して同列の下セルへ / Shift+Enter=上へ / Tab・Shift+Tab=確定して右/左の編集可能セルへ。
//  確定は各入力の onBlur コミットに任せる(フォーカス移動で blur が走る)。textarea の Enter は
//  改行を優先して奪わない(行追加は Ctrl+Enter のまま)。select・チップ等で入力が無いセルはスキップ。
function handleEditNav(
  e: ReactKeyboardEvent,
  o: RowSelectionOpts,
  setColIdx: (idx: number) => void,
): void {
  if (isImeKeyEvent(e)) return; // IME 変換確定の Enter/Tab を移動にしない
  if (e.ctrlKey || e.metaKey || e.altKey) return; // Ctrl+Enter(行追加)等は呼び出し側の既存処理へ
  if (e.key !== 'Enter' && e.key !== 'Tab') return;
  const t = e.target;
  if (!(t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement)) return; // select 等は既定動作のまま
  if (t instanceof HTMLTextAreaElement && e.key === 'Enter') return; // 複数行セルは Enter=改行
  const colKey = t.closest('[data-cell]')?.getAttribute('data-cell');
  const taskId = t.closest('tr[data-taskid]')?.getAttribute('data-taskid');
  if (!colKey || !taskId) return; // 表のセル外(ヘッダの検索ボックス等)は対象外
  e.preventDefault();
  e.stopPropagation(); // blur 後にグローバルの Enter(table.edit)を再発火させない
  const dir: EditNavDir =
    e.key === 'Enter' ? (e.shiftKey ? 'up' : 'down') : e.shiftKey ? 'left' : 'right';
  const moved = resolveEditNavTarget(
    { orderedIds: o.orderedIds, columns: o.columns },
    { taskId, colKey },
    dir,
    (id, key) => focusCell(id, key, true),
  );
  if (!moved) {
    // 端で移動先が無い Enter は従来どおり確定して選択モードへ(Tab はその場に留まる)。
    if (e.key === 'Enter') t.blur();
    return;
  }
  // 選択と列カーソルを移動先へ追従させる(Esc で選択モードへ戻った直後の j/k・h/l と一致)。
  if (moved.taskId !== taskId) useApp.getState().select(moved.taskId);
  const ci = o.columns.indexOf(moved.colKey);
  if (ci >= 0) setColIdx(ci);
}

// 'table' コンテキストのアクション実行本体。hook の閉包から切り離し、テストから直接呼べる形にする。
// col は列カーソルの読み書き(クランプ済みの現在値と setter)。
export function runTableAction(
  action: string,
  o: RowSelectionOpts,
  col: { get: () => number; set: (idx: number) => void },
): boolean {
  if (!o.enabled) return false;
  // クイックフィルタは行ゼロでも開ける(絞り込みで 0 件になった状態から解除できるように)。
  // 非対応ビュー(全項目表)でも true を返して preventDefault し、ブラウザ検索に
  // 素通りさせない(アプリ内ショートカットのつもりの押下に案内だけ出す)。
  if (action === 'table.find') {
    if (o.openFind?.()) return true;
    useUI.getState().toast('クイックフィルタはアウトライン表示で使えます');
    return true;
  }
  const app = useApp.getState();
  const ids = o.orderedIds;
  if (ids.length === 0) return false;
  const sel = app.selectedTaskId;
  const idx = sel ? ids.indexOf(sel) : -1;

  const moveTo = (i: number) => {
    const id = ids[Math.max(0, Math.min(ids.length - 1, i))];
    if (id) {
      app.select(id);
      scrollRowIntoView(id);
    }
  };

  switch (action) {
    case 'table.next':
      moveTo(idx < 0 ? 0 : idx + 1);
      return true;
    case 'table.prev':
      moveTo(idx < 0 ? 0 : idx - 1);
      return true;
    case 'table.first':
      moveTo(0);
      return true;
    case 'table.last':
      moveTo(ids.length - 1);
      return true;
    case 'table.left':
    case 'table.right': {
      if (!sel || idx < 0 || o.columns.length === 0) return false;
      const cur = Math.min(col.get(), o.columns.length - 1);
      const next =
        action === 'table.left'
          ? Math.max(0, cur - 1)
          : Math.min(o.columns.length - 1, cur + 1);
      col.set(next);
      // 移動先のセルが見切れないように画面も追従(固定列の影も考慮)。
      const cell = cellOf(sel, o.columns[next]);
      if (cell) scrollCellVisible(cell);
      return true;
    }
    case 'table.edit': {
      if (!sel || idx < 0) return false;
      // 列カーソルのセルへフォーカス(無ければ名前編集にフォールバック)。
      const colKey = o.columns[Math.min(col.get(), Math.max(0, o.columns.length - 1))];
      if (focusCell(sel, colKey)) return true;
      o.beginEdit(sel);
      return true;
    }
    case 'table.clear':
      if (!sel) return false; // 未選択の Esc は奪わない
      app.select(undefined);
      return true;
    case 'table.addSibling': {
      if (!sel || idx < 0) return false;
      const nid = app.addSiblingOf(sel);
      if (nid) {
        useApp.getState().select(nid);
        o.beginEdit(nid);
      }
      return true;
    }
    case 'table.addChild': {
      if (!sel || idx < 0) return false;
      const nid = app.addChildTask(sel);
      if (nid) {
        // 折りたたまれた親の下に作ると行が描画されず編集フォーカスも空振りするため、先に展開する。
        const ui = useUI.getState();
        if (ui.outlineCollapsed.has(sel)) ui.toggleOutlineCollapsed(sel);
        useApp.getState().select(nid);
        o.beginEdit(nid);
      }
      return true;
    }
    case 'table.moveUp':
      if (!sel) return false;
      app.moveTaskUp(sel);
      scrollRowIntoView(sel);
      return true;
    case 'table.moveDown':
      if (!sel) return false;
      app.moveTaskDown(sel);
      scrollRowIntoView(sel);
      return true;
    case 'table.indent':
      if (!sel || idx < 0) return false; // 行選択中のみ Tab を奪う
      app.indentTask(sel);
      return true;
    case 'table.outdent':
      if (!sel || idx < 0) return false;
      app.outdentTask(sel);
      return true;
    case 'table.duplicate': {
      if (!sel || idx < 0) return false;
      const nid = app.duplicateTask(sel);
      if (nid) scrollRowIntoView(nid);
      return true;
    }
    case 'table.delete': {
      if (!sel || idx < 0) return false;
      if (!app.project.core.tasks[sel]) return false;
      void confirmRemoveTasks([sel]).then((ok) => {
        if (ok) {
          // 削除後は近い行へ選択を移す(連続削除しやすく)。
          const next = ids[Math.min(idx + 1, ids.length - 1)];
          useApp.getState().select(next && next !== sel ? next : undefined);
        }
      });
      return true;
    }
    case 'table.collapse':
      if (!sel || idx < 0 || !o.toggleCollapse) return false;
      o.toggleCollapse(sel);
      return true;
    default:
      return false;
  }
}

export function useRowSelectionKeys(opts: RowSelectionOpts): {
  colIdx: number;
  /** 編集中(セル内入力)の Enter/Tab セル移動。表(table 要素)の onKeyDown に張る。 */
  editNavKeyDown: (e: ReactKeyboardEvent) => void;
} {
  // ハンドラは初回登録のみ・中身は ref 経由で常に最新を見る(再登録の揺れを避ける)。
  const optsRef = useRef(opts);
  optsRef.current = opts;
  // 列カーソル(h/l・←→ で移動)。行を移っても列は維持する(Excel 風)。
  const [colIdx, setColIdx] = useState(0);
  const colIdxRef = useRef(colIdx);
  colIdxRef.current = Math.min(colIdx, Math.max(0, opts.columns.length - 1));

  useEffect(() => {
    return registerContextHandler('table', (action) =>
      runTableAction(action, optsRef.current, { get: () => colIdxRef.current, set: setColIdx }),
    );
  }, []);

  const editNavKeyDown = useCallback(
    (e: ReactKeyboardEvent) => handleEditNav(e, optsRef.current, setColIdx),
    [],
  );

  return { colIdx: Math.min(colIdx, Math.max(0, opts.columns.length - 1)), editNavKeyDown };
}
