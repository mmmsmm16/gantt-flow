// 表の「行選択モード」のキー操作(編集外)。アウトライン(TableView)と全項目表(FullTable)で
// 同じ操作系を共有する。キーの照合とガードは useGlobalHotkeys が済ませており、
// ここは 'table' コンテキストのアクション(table.*)を実行するだけ。
// j/k での高速移動中はフロー側の粒度/スコープ同期(openRow 相当)を行わず、編集開始時のみ同期する。
import { useEffect, useRef } from 'react';
import type { Id } from '@gantt-flow/core';
import { useApp } from '../store';
import { useUI } from './useUI';
import { registerContextHandler } from './useGlobalHotkeys';

export interface RowSelectionOpts {
  /** このビューが操作対象のとき true(activePane==='table' かつ自分が表示中)。 */
  enabled: boolean;
  /** 表示順の工程 ID(折りたたみ・ソート・絞り込み反映済み)。 */
  orderedIds: Id[];
  /** 名前編集を開始する(対象行の入力へフォーカス。再レンダ後のフォーカスは呼び出し側が保証)。 */
  beginEdit: (taskId: Id) => void;
  /** 折りたたみトグル(アウトラインのみ)。 */
  toggleCollapse?: (taskId: Id) => void;
}

function scrollRowIntoView(taskId: Id): void {
  document
    .querySelector(`tr[data-taskid="${CSS.escape(taskId)}"]`)
    ?.scrollIntoView({ block: 'nearest' });
}

export function useRowSelectionKeys(opts: RowSelectionOpts): void {
  // ハンドラは初回登録のみ・中身は ref 経由で常に最新を見る(再登録の揺れを避ける)。
  const optsRef = useRef(opts);
  optsRef.current = opts;

  useEffect(() => {
    return registerContextHandler('table', (action) => {
      const o = optsRef.current;
      if (!o.enabled) return false;
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
        case 'table.edit':
          if (!sel || idx < 0) return false;
          o.beginEdit(sel);
          return true;
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
          // addChildTask は新 ID を返さないため、追加前後の差分から特定してフォーカスする。
          const before = new Set(Object.keys(app.project.core.tasks));
          app.addChildTask(sel);
          const nid = Object.keys(useApp.getState().project.core.tasks).find((id) => !before.has(id));
          if (nid) {
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
          const t = app.project.core.tasks[sel];
          if (!t) return false;
          void useUI
            .getState()
            .confirm({
              title: '工程を削除',
              message: `「${t.name || '（無題）'}」を削除します（配下の工程は1つ上の階層へ繰り上げて残します）。`,
              confirmLabel: '削除',
              danger: true,
            })
            .then((ok) => {
              if (ok) {
                const a = useApp.getState();
                // 削除後は近い行へ選択を移す(連続削除しやすく)。
                const next = ids[Math.min(idx + 1, ids.length - 1)];
                a.removeTask(sel);
                a.select(next && next !== sel ? next : undefined);
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
    });
  }, []);
}
