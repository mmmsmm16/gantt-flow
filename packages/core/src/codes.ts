// 工程No（階層番号）の採番。`t.code` があれば優先し、その値を子の prefix にも使う。
// 出力(exportRows)・工程表ビュー・インスペクタで共有する単一ロジック。
import type { Core, Id, ProcessTask } from './model/types';

export function computeCodes(core: Core): Record<Id, string> {
  const byParent = new Map<Id | undefined, ProcessTask[]>();
  for (const t of Object.values(core.tasks)) {
    const key = t.parentId ?? undefined;
    const arr = byParent.get(key);
    if (arr) arr.push(t);
    else byParent.set(key, [t]);
  }
  for (const arr of byParent.values()) arr.sort((a, b) => a.order - b.order);

  const codes: Record<Id, string> = {};
  const walk = (parentId: Id | undefined, prefix: string) => {
    let i = 0;
    for (const t of byParent.get(parentId) ?? []) {
      if (t.kind === 'milestone') continue; // 節目は採番せず、番号も飛ばさない
      i += 1;
      const no = t.code ?? (prefix ? `${prefix}-${i}` : `${i}`);
      codes[t.id] = no;
      walk(t.id, no);
    }
  };
  walk(undefined, '');
  return codes;
}
