// スキーマ versioning とマイグレーション（`docs/05-persistence.md` §4）。
// 版の昇順に純粋関数を適用。読込時はメモリ上でのみ適用し、明示保存まで書き戻さない（呼び出し側の責務）。

export const CURRENT_SCHEMA_VERSION = 2;

export interface Migration {
  to: number; // この版へ引き上げる
  up: (raw: Record<string, unknown>) => Record<string, unknown>;
}

// v1 が初版。以後の破壊的変更はここに up を追加する。
export const migrations: Migration[] = [
  {
    to: 2,
    up: (raw) => ({
      ...raw,
      manual: (raw.manual as unknown) ?? { procedures: {}, assets: {} }, // 既存 manual は温存
    }),
  },
];

// raw.schemaVersion から現行まで、該当するマイグレーションを順に適用する。
export function migrate(
  raw: unknown,
  list: Migration[] = migrations,
): Record<string, unknown> {
  let cur = (raw ?? {}) as Record<string, unknown>;
  const from = typeof cur.schemaVersion === 'number' ? cur.schemaVersion : 0;
  for (const m of [...list].filter((m) => m.to > from).sort((a, b) => a.to - b.to)) {
    cur = m.up(cur);
    cur.schemaVersion = m.to;
  }
  return cur;
}
