// 表の行「複数選択」（一括操作用）。アウトライン（TableView）と全項目表（FullTable）で共有する。
//   Ctrl/⌘+クリック … マークをトグル（アンカーも更新）
//   Shift+クリック   … アンカーから当該行までを範囲マーク（表示行のみ・折りたたみ配下は対象外）
//   通常クリック     … 複数選択を解除し、onActivate（単一選択・詳細表示など）を呼ぶ
//   Esc             … 複数選択だけを解除（選択・インスペクタは維持。もう一度 Esc で通常の選択解除へ）
// 一括操作（削除・担当設定）は taskOps に集約したものを呼ぶ（両ビューで実装を共有）。
import { useEffect, useRef, useState, type MouseEvent } from 'react';
import type { Id } from '@gantt-flow/core';
import { useApp } from '../store';
import { useUI } from './useUI';
import { isEditableTarget, isImeKeyEvent } from '../keymap';
import { scrollRowIntoView } from './useRowSelectionKeys';
import { confirmRemoveTasks, bulkSetAssignee } from '../taskOps';

export interface ClickMods {
  shift: boolean;
  ctrl: boolean; // Ctrl または ⌘（メタ）
}

/**
 * 行クリックのマーク遷移（DOM 非依存の純粋関数。テスト可能にするため hook から切り出す）。
 * activate=true のときだけ呼び出し側は通常の単一選択/詳細表示を行う。
 */
export function nextMarked(
  cur: Set<Id>,
  anchor: Id | null,
  orderedIds: readonly Id[],
  id: Id,
  mods: ClickMods,
): { marked: Set<Id>; anchor: Id | null; activate: boolean } {
  if (mods.shift && anchor) {
    const a = orderedIds.indexOf(anchor);
    const b = orderedIds.indexOf(id);
    if (a >= 0 && b >= 0) {
      const [lo, hi] = a < b ? [a, b] : [b, a];
      const next = new Set(cur);
      for (let i = lo; i <= hi; i++) next.add(orderedIds[i]!);
      return { marked: next, anchor, activate: false };
    }
    // アンカーが可視行に無い（折りたたみ等で消えた）ときは何もしない。
    return { marked: cur, anchor, activate: false };
  }
  if (mods.ctrl) {
    const next = new Set(cur);
    // 単一選択（marked が空）から複数選択へ移る初回は、直前に選んだ行（anchor）も一緒にマークする。
    // 「行 A をクリック → Ctrl/⌘+クリックで行 B」で A も選択に含める、標準的な複数選択の挙動。
    if (next.size === 0 && anchor !== null && anchor !== id) next.add(anchor);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return { marked: next, anchor: id, activate: false };
  }
  // 修飾なし: 複数選択を解除して単一選択へ。
  return { marked: new Set(), anchor: id, activate: true };
}

/**
 * Shift+↑/↓ による行マーク拡張（キーボード。DOM 非依存の純粋関数）。
 * 選択行(sel)をカーソルとして dir 方向の隣接行へ選択を 1 つ動かしつつ、アンカーからその行までを
 * 範囲マークする（Shift+クリックと同じ nextMarked を流用＝マウスと挙動を一致させる）。
 * 未選択・端（移動先なし）・sel が可視行に無いときは null を返す（通常の↑↓へ委ねる）。
 */
export function markExtendByKey(
  cur: Set<Id>,
  anchor: Id | null,
  sel: Id | null,
  orderedIds: readonly Id[],
  dir: 1 | -1,
): { marked: Set<Id>; anchor: Id; sel: Id } | null {
  if (!sel) return null;
  const i = orderedIds.indexOf(sel);
  if (i < 0) return null;
  const j = i + dir;
  if (j < 0 || j >= orderedIds.length) return null; // 端: これ以上広げない
  const target = orderedIds[j]!;
  // 起点(アンカー)は既存アンカーが可視ならそれ、無ければ現在行。以後の Shift 連打で伸縮する基準。
  const eff = anchor && orderedIds.indexOf(anchor) >= 0 ? anchor : sel;
  const res = nextMarked(cur, eff, orderedIds, target, { shift: true, ctrl: false });
  return { marked: res.marked, anchor: eff, sel: target };
}

export interface RowMultiSelect {
  /** マーク済み（複数選択）の工程 ID。行の marked クラス判定に使う。 */
  marked: Set<Id>;
  /** 行クリック処理: 修飾なし=onActivate、Ctrl/⌘=トグル、Shift=範囲。 */
  onRowClick: (e: MouseEvent, id: Id) => void;
  /** 複数選択を解除。 */
  clear: () => void;
  /** 一括: 担当を設定（マイルストーンは除外）。適用したら解除。 */
  bulkAssign: () => Promise<void>;
  /** 一括: 削除（確認あり）。適用したら解除。 */
  bulkDelete: () => Promise<void>;
}

export function useRowMultiSelect(opts: {
  /** 表示順の工程 ID（折りたたみ・絞り込み反映済みの可視行）。範囲選択はこの順序内で行う。 */
  orderedIds: Id[];
  /** 修飾キーなしのクリック時の動作（単一選択・詳細表示など。ビューごとに異なる）。 */
  onActivate: (id: Id) => void;
}): RowMultiSelect {
  const [marked, setMarked] = useState<Set<Id>>(new Set());
  const [anchor, setAnchor] = useState<Id | null>(null);

  const clear = () => setMarked((m) => (m.size ? new Set() : m));

  const onRowClick = (e: MouseEvent, id: Id) => {
    const res = nextMarked(marked, anchor, opts.orderedIds, id, {
      shift: e.shiftKey,
      ctrl: e.ctrlKey || e.metaKey,
    });
    if (res.marked !== marked) setMarked(res.marked);
    setAnchor(res.anchor);
    if (res.activate) opts.onActivate(id);
  };

  // Esc で複数選択を解除する（選択・インスペクタは維持）。グローバル Esc（選択解除）より先に
  // 捕まえて消費するため capture 段階の window リスナーで受ける。ダイアログ/オーバーレイ/
  // メニュー表示中や入力編集中は横取りしない（それぞれの Esc を優先）。
  useEffect(() => {
    if (marked.size === 0) return undefined;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || isImeKeyEvent(e)) return;
      const ui = useUI.getState();
      if (ui.dialog || ui.overlay || ui.busy || ui.tourStep !== null || ui.hasTransientLayer()) return;
      if (isEditableTarget(document.activeElement)) return; // 編集中はまず blur を優先
      setMarked(new Set());
      e.preventDefault();
      e.stopImmediatePropagation();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [marked.size]);

  // Shift+↑/↓ でキーボードから範囲マークを作る/広げる（マウスの Shift+クリックと同じ nextMarked）。
  // グローバルの ↑↓（行移動）より先に捕まえて消費するため capture 段階で受ける。表が非アクティブ・
  // ダイアログ/オーバーレイ表示中・セル編集中は横取りせず通常の行移動へ委ねる。最新状態は ref 経由で
  // 読み、初回のみ登録する（orderedIds は毎レンダ変わりうるため deps に入れず再登録の揺れを避ける）。
  const markedRef = useRef(marked);
  markedRef.current = marked;
  const anchorRef = useRef(anchor);
  anchorRef.current = anchor;
  const orderedRef = useRef(opts.orderedIds);
  orderedRef.current = opts.orderedIds;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
      if (!e.shiftKey || e.ctrlKey || e.metaKey || e.altKey || isImeKeyEvent(e)) return;
      const ui = useUI.getState();
      if (ui.activePane !== 'table') return; // 表がアクティブなときだけ
      if (ui.dialog || ui.overlay || ui.busy || ui.tourStep !== null || ui.hasTransientLayer()) return;
      if (isEditableTarget(document.activeElement)) return; // セル編集中は通常のセル移動を優先
      const sel = useApp.getState().selectedTaskId ?? null;
      const res = markExtendByKey(
        markedRef.current,
        anchorRef.current,
        sel,
        orderedRef.current,
        e.key === 'ArrowDown' ? 1 : -1,
      );
      if (!res) return; // 未選択・端: 通常の↑↓（選択移動）へ委ねる
      e.preventDefault();
      e.stopImmediatePropagation(); // グローバルの table.next/prev（行移動）を撃たせない
      setMarked(res.marked);
      setAnchor(res.anchor);
      useApp.getState().select(res.sel);
      scrollRowIntoView(res.sel);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

  const bulkAssign = async () => {
    if (await bulkSetAssignee([...marked])) clear();
  };
  const bulkDelete = async () => {
    if (await confirmRemoveTasks([...marked])) clear();
  };

  return { marked, onRowClick, clear, bulkAssign, bulkDelete };
}
