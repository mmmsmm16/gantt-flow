// 入力補完（オートコンプリート）の候補集め。プロジェクト全体から重複なく集約する。
// 同じ帳票が複数工程に登場するのが業務フローの常なので、表記ゆれ（受注伝票 vs 受注表）を防ぐ。
import type { Project, ProcessTask, Id } from '@gantt-flow/core';

// すべての I/O（帳票/情報）の名称を、出現頻度の高い順に重複なく返す。
export function collectIoNames(project: Project): string[] {
  const count = new Map<string, number>();
  for (const d of Object.values(project.details)) {
    for (const it of [...(d.inputs ?? []), ...(d.outputs ?? [])]) {
      const n = it.name.trim();
      if (n) count.set(n, (count.get(n) ?? 0) + 1);
    }
  }
  return [...count.entries()].sort((a, b) => b[1] - a[1]).map(([n]) => n);
}

// 「前工程」に設定できる候補。同じ親・同じ粒度の兄弟のうち、既に前後関係(どちら向きでも)が
// 張られているものを除外して order 順に返す(表セレクトとパレットの引数コマンドで共用)。
export function prevCandidates(project: Project, taskId: Id): ProcessTask[] {
  const t = project.core.tasks[taskId];
  if (!t) return [];
  const deps = Object.values(project.core.dependencies);
  const predIds = new Set(deps.filter((d) => d.to === taskId).map((d) => d.from));
  const succIds = new Set(deps.filter((d) => d.from === taskId).map((d) => d.to));
  return Object.values(project.core.tasks)
    .filter(
      (o) =>
        o.id !== taskId &&
        (o.parentId ?? undefined) === (t.parentId ?? undefined) &&
        o.level === t.level &&
        !predIds.has(o.id) &&
        !succIds.has(o.id),
    )
    .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
}
