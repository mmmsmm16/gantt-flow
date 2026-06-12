// アウトライン(工程表)のクイックフィルタ。検索語に部分一致する行と、その祖先だけを残す
// (祖先は階層の文脈を保つために表示する)。表示のみの絞り込みでデータには触れない。
// TableView の buildOutline 結果(表示順の行配列)へ適用する純粋関数(React/DOM 非依存)。
import type { Id } from '@gantt-flow/core';

export interface OutlineFilterTask {
  id: Id;
  name: string;
  parentId?: Id;
}

export interface OutlineFilterResult<R> {
  /** 表示する行(一致行とその祖先。元の表示順を保つ)。 */
  rows: R[];
  /** 一致した行の ID(祖先は含まない。ハイライトと件数表示に使う)。 */
  matched: Set<Id>;
}

/** 作業名・担当名への部分一致(大文字小文字は区別しない)。クエリが空白のみなら絞り込まない。 */
export function filterOutlineRows<R extends { task: OutlineFilterTask }>(
  rows: R[],
  query: string,
  assigneeNameOf: (task: R['task']) => string,
): OutlineFilterResult<R> {
  const q = query.trim().toLowerCase();
  if (!q) return { rows, matched: new Set() };
  const byId = new Map<Id, OutlineFilterTask>();
  for (const r of rows) byId.set(r.task.id, r.task);
  const matched = new Set<Id>();
  for (const r of rows) {
    const t = r.task;
    if (t.name.toLowerCase().includes(q) || assigneeNameOf(t).toLowerCase().includes(q)) {
      matched.add(t.id);
    }
  }
  // 一致行の祖先を残す。途中で keep 済みの祖先に当たったら、それより上も登録済み。
  const keep = new Set<Id>(matched);
  for (const id of matched) {
    let cur = byId.get(id);
    while (cur?.parentId && !keep.has(cur.parentId)) {
      keep.add(cur.parentId);
      cur = byId.get(cur.parentId);
    }
  }
  return { rows: rows.filter((r) => keep.has(r.task.id)), matched };
}
