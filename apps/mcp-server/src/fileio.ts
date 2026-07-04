// ファイル I/O。デスクトップ版は Rust(fsstore) がアトミック保存するが、MCP サーバは Node から
// 直接 .gflow(v2 ZIP コンテナ)を読み書きする。シリアライズ/パースは @gantt-flow/core の純粋変換に
// 委ねる（= アプリと完全に同じ形式・検証）。旧単一 JSON は読み込みのみ後方互換。
// 書き込みは temp+rename で原子的置換にする。
import { readFile, open, rename, unlink } from 'node:fs/promises';
import { dirname, basename, join } from 'node:path';
import {
  serializeContainer,
  deserializeContainer,
  collectReferencedAssetFiles,
  type Project,
} from '@gantt-flow/core';

/** 読み込んだプロジェクトと、同梱されていた画像 assets（キーは assets/ を除いた相対名）。 */
export interface LoadedProject {
  project: Project;
  assets: Record<string, Uint8Array>;
}

/** .gflow を読み、Project + assets へパースする（v2 ZIP / 旧単一 JSON いずれも可。不正なら core が throw）。
 *  assets は MCP 自身は生成しないが、write-through で落とさないよう保持する（画像を握って書き戻す）。 */
export async function loadProjectContainer(path: string): Promise<LoadedProject> {
  const buf = await readFile(path); // encoding 指定なし = Buffer
  const c = deserializeContainer(new Uint8Array(buf));
  return { project: c.project, assets: c.assets };
}

/** .gflow を読み Project だけを返す（後方互換の薄いラッパ。assets も要るときは loadProjectContainer）。 */
export async function loadProjectFile(path: string): Promise<Project> {
  return (await loadProjectContainer(path)).project;
}

/**
 * Project を path へアトミックに書き込む（同一ディレクトリの一時ファイル→rename）。常に v2 (ZIP)。
 * rename 前に fsync（電源断等で tmp が中途半端な内容のまま残らないようにする）。
 * assets は「現 project が参照する分だけ」書く（保存時 GC）。MCP は画像を生成しないが、open 時に
 * 保持した既存 assets をここで書き戻すことで write-through 保存でも画像が落ちない。
 */
export async function saveProjectFile(
  path: string,
  project: Project,
  assets: Record<string, Uint8Array> = {},
): Promise<void> {
  const referenced = collectReferencedAssetFiles(project);
  const picked: Record<string, Uint8Array> = {};
  for (const [file, data] of Object.entries(assets)) {
    if (referenced.has(file)) picked[file] = data;
  }
  const bytes = serializeContainer(project, picked);
  const tmp = join(dirname(path), `.${basename(path)}.tmp-${process.pid}-${Date.now()}`);
  const fh = await open(tmp, 'w');
  try {
    await fh.write(bytes);
    await fh.sync();
  } finally {
    await fh.close();
  }
  try {
    await rename(tmp, path);
  } catch (err) {
    await unlink(tmp).catch(() => undefined); // rename 失敗時は一時ファイルを片付ける
    throw err;
  }
}
