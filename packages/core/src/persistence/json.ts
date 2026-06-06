// JSON シリアライズ（`docs/05-persistence.md` §2 Phase1）。環境非依存の文字列⇄Project 変換。
// ファイル I/O（アトミック書き込み・ロック等）は Tauri 側が担い、ここはコアの純粋変換に限る。
import { ProjectSchema } from '../model/schema';
import { migrate, type Migration } from './migrate';
import type { Project } from '../model/types';

export function serializeProject(project: Project): string {
  return JSON.stringify(project);
}

export interface DeserializeOptions {
  migrations?: Migration[];
}

// 文字列 → マイグレーション → Zod 検証 → Project。構造不正は ZodError を投げる。
export function deserializeProject(json: string, opts: DeserializeOptions = {}): Project {
  const raw: unknown = JSON.parse(json);
  const migrated = migrate(raw, opts.migrations);
  return ProjectSchema.parse(migrated) as Project;
}

// 検証のみ（投げずに成否を返す）。
export function tryDeserializeProject(
  json: string,
  opts: DeserializeOptions = {},
): { ok: true; project: Project } | { ok: false; error: unknown } {
  try {
    return { ok: true, project: deserializeProject(json, opts) };
  } catch (error) {
    return { ok: false, error };
  }
}
