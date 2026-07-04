// ファイル I/O。デスクトップ版は Rust(fsstore) がアトミック保存するが、MCP サーバは Node から
// 直接 .gflow(v2 ZIP コンテナ)を読み書きする。シリアライズ/パースは @gantt-flow/core の純粋変換に
// 委ねる（= アプリと完全に同じ形式・検証）。旧単一 JSON は読み込みのみ後方互換。
// 書き込みは temp+rename で原子的置換にする。
import { readFile, writeFile, rename, unlink } from 'node:fs/promises';
import { dirname, basename, join } from 'node:path';
import { serializeContainer, deserializeContainer, type Project } from '@gantt-flow/core';

/** .gflow を読み、Project へパースする（v2 ZIP / 旧単一 JSON いずれも可。不正なら core が throw）。 */
export async function loadProjectFile(path: string): Promise<Project> {
  const buf = await readFile(path); // encoding 指定なし = Buffer
  return deserializeContainer(new Uint8Array(buf)).project;
}

/** Project を path へアトミックに書き込む（同一ディレクトリの一時ファイル→rename）。常に v2 (ZIP)。 */
export async function saveProjectFile(path: string, project: Project): Promise<void> {
  const bytes = serializeContainer(project);
  const tmp = join(dirname(path), `.${basename(path)}.tmp-${process.pid}-${Date.now()}`);
  await writeFile(tmp, bytes);
  try {
    await rename(tmp, path);
  } catch (err) {
    await unlink(tmp).catch(() => undefined); // rename 失敗時は一時ファイルを片付ける
    throw err;
  }
}
