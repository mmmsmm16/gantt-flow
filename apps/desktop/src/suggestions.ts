// 入力補完（オートコンプリート）の候補集め。プロジェクト全体から重複なく集約する。
// 同じ帳票が複数工程に登場するのが業務フローの常なので、表記ゆれ（受注伝票 vs 受注表）を防ぐ。
import type { Project } from '@gantt-flow/core';

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
