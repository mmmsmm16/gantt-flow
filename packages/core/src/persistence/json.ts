// JSON シリアライズ（`docs/05-persistence.md` §2 Phase1）。環境非依存の文字列⇄Project 変換。
// ファイル I/O（アトミック書き込み・ロック等）は Tauri 側が担い、ここはコアの純粋変換に限る。
import { ProjectSchema } from '../model/schema';
import { migrate, migrations, CURRENT_SCHEMA_VERSION, type Migration } from './migrate';
import { validate, type ValidationIssue } from '../validate';
import type { Project } from '../model/types';

export function serializeProject(project: Project): string {
  return JSON.stringify(project);
}

export interface DeserializeOptions {
  migrations?: Migration[];
}

// 対応版より新しいファイル。Zod は未知フィールドを黙って削ぎ落とすため、
// そのまま読み込んで再保存すると新版のデータが恒久的に失われる。読込自体を拒否する。
export class SchemaVersionTooNewError extends Error {
  readonly fileVersion: number;
  readonly supportedVersion: number;
  constructor(fileVersion: number, supportedVersion: number) {
    super(
      `このファイルは新しいバージョンの gantt-flow で作成されています` +
        `（ファイルの版: ${fileVersion} / このアプリが対応する版: ${supportedVersion} まで）。` +
        `最新のアプリで開いてください。`,
    );
    this.name = 'SchemaVersionTooNewError';
    this.fileVersion = fileVersion;
    this.supportedVersion = supportedVersion;
  }
}

// instanceof はバンドル境界をまたぐと壊れることがあるため name で判定する。
export function isSchemaVersionTooNewError(error: unknown): error is SchemaVersionTooNewError {
  return error instanceof Error && error.name === 'SchemaVersionTooNewError';
}

// 参照整合性の破綻（依存の端点欠落・親欠落・親子循環）。黙って読み込むと
// 描画のハングや集計の無限再帰につながるため、問題を列挙して読込を拒否する。
export class ProjectIntegrityError extends Error {
  readonly issues: ValidationIssue[];
  constructor(issues: ValidationIssue[]) {
    const lines = issues.map((i) => `- [${i.kind}] ${i.ref}: ${i.message}`).join('\n');
    super(`プロジェクトファイルの参照整合性が壊れています。\n${lines}`);
    this.name = 'ProjectIntegrityError';
    this.issues = issues;
  }
}

export function isProjectIntegrityError(error: unknown): error is ProjectIntegrityError {
  return error instanceof Error && error.name === 'ProjectIntegrityError';
}

// 読込を拒否すべき整合性問題（detail.task の孤児詳細は実害がないので除外）。
const FATAL_ISSUE_KINDS = new Set(['dependency.from', 'dependency.to', 'task.parent', 'task.cycle']);

// 文字列 → 版チェック → マイグレーション → Zod 検証 → 参照整合性検証 → Project。
// 構造不正は ZodError、新しすぎる版は SchemaVersionTooNewError、参照破綻は ProjectIntegrityError を投げる。
export function deserializeProject(json: string, opts: DeserializeOptions = {}): Project {
  const raw: unknown = JSON.parse(json);
  const list = opts.migrations ?? migrations;
  const supported = list.reduce((max, m) => Math.max(max, m.to), CURRENT_SCHEMA_VERSION);
  const fileVersion =
    typeof raw === 'object' && raw !== null
      ? (raw as Record<string, unknown>).schemaVersion
      : undefined;
  if (typeof fileVersion === 'number' && fileVersion > supported) {
    throw new SchemaVersionTooNewError(fileVersion, supported);
  }
  const migrated = migrate(raw, opts.migrations);
  const project = ProjectSchema.parse(migrated) as Project;
  const fatal = validate(project).filter((i) => FATAL_ISSUE_KINDS.has(i.kind));
  if (fatal.length > 0) throw new ProjectIntegrityError(fatal);
  return project;
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
