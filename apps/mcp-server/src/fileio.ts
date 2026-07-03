// ファイル I/O。デスクトップ版は Rust(fsstore) がアトミック保存するが、MCP サーバは Node から
// 直接 .gflow(JSON) を読み書きする。シリアライズ/パースは @gantt-flow/core の純粋変換に委ねる
// （= アプリと完全に同じ形式・検証）。書き込みは temp+rename で原子的置換にする。
import { readFile, writeFile, rename, unlink } from 'node:fs/promises';
import { dirname, basename, join } from 'node:path';
import { serializeProject, deserializeProject, type Project } from '@gantt-flow/core';

/** .gflow / .json を読み、Project へパースする（不正なら core が throw）。 */
export async function loadProjectFile(path: string): Promise<Project> {
  const text = await readFile(path, 'utf8');
  return deserializeProject(text);
}

/** Project を path へアトミックに書き込む（同一ディレクトリの一時ファイル→rename）。 */
export async function saveProjectFile(path: string, project: Project): Promise<void> {
  const json = serializeProject(project);
  const tmp = join(dirname(path), `.${basename(path)}.tmp-${process.pid}-${Date.now()}`);
  await writeFile(tmp, json, 'utf8');
  try {
    await rename(tmp, path);
  } catch (err) {
    await unlink(tmp).catch(() => undefined); // rename 失敗時は一時ファイルを片付ける
    throw err;
  }
}
