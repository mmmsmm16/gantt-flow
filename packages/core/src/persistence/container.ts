// .gflow v2 コンテナ形式（ZIP: project.json + assets/）。旧単一 JSON も後方互換で読める。
// ファイル I/O（保存・ロック）は Tauri / fsstore 側が担い、ここはコアの純粋変換に限る。
import { strFromU8, strToU8, unzipSync, zipSync, type Zippable } from 'fflate';
import type { Project } from '../model/types';
import { deserializeProject, serializeProject, type DeserializeOptions } from './json';

export const PROJECT_ENTRY = 'project.json';
export const ASSETS_DIR = 'assets/';

export type ContainerFormat = 'zip' | 'json';

export interface ContainerData {
  project: Project;
  /** ZIP 内 assets/ 配下（キーは assets/ を除いた相対名） */
  assets: Record<string, Uint8Array>;
  /** 読み込んだファイルの形式。json = 旧単一 JSON（後方互換） */
  format: ContainerFormat;
}

export class ContainerFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ContainerFormatError';
  }
}

// instanceof はバンドル境界をまたぐと壊れることがあるため name で判定する。
export function isContainerFormatError(e: unknown): e is ContainerFormatError {
  return e instanceof Error && e.name === 'ContainerFormatError';
}

const BOM = [0xef, 0xbb, 0xbf] as const;

function stripBom(bytes: Uint8Array): Uint8Array {
  return bytes.length >= 3 && bytes[0] === BOM[0] && bytes[1] === BOM[1] && bytes[2] === BOM[2]
    ? bytes.subarray(3)
    : bytes;
}

/** 先頭バイトで形式判定。UTF-8 BOM・先頭空白は許容。 */
export function detectContainerFormat(bytes: Uint8Array): ContainerFormat | null {
  if (bytes.length >= 2 && bytes[0] === 0x50 && bytes[1] === 0x4b) return 'zip';
  const body = stripBom(bytes);
  let i = 0;
  while (i < body.length && (body[i] === 0x20 || body[i] === 0x09 || body[i] === 0x0a || body[i] === 0x0d)) i++;
  return i < body.length && body[i] === 0x7b ? 'json' : null;
}

// ZIP の DOS 日時は 1980-01-01 未満を表現できず zipSync が例外を投げるため、
// バイト安定化用の固定値には ZIP epoch そのものを使う（new Date(0) = 1970 は不可）。
const FIXED_MTIME = new Date('1980-01-01T00:00:00.000Z');

/** バイト安定な ZIP を生成（mtime 固定・assets キーソート・project.json 先頭）。 */
export function serializeContainer(project: Project, assets: Record<string, Uint8Array> = {}): Uint8Array {
  const mtime = FIXED_MTIME;
  const entries: Zippable = {
    [PROJECT_ENTRY]: [strToU8(serializeProject(project)), { level: 6, mtime }],
  };
  for (const name of Object.keys(assets).sort()) {
    const data = assets[name];
    if (data === undefined) continue; // Object.keys 由来のキーなので実際には常に存在する
    // 画像等は再圧縮の益が薄いので store（level 0）
    entries[ASSETS_DIR + name] = [data, { level: 0, mtime }];
  }
  return zipSync(entries);
}

export function deserializeContainer(bytes: Uint8Array, opts?: DeserializeOptions): ContainerData {
  const format = detectContainerFormat(bytes);
  if (format === 'json') {
    return { project: deserializeProject(strFromU8(stripBom(bytes)), opts), assets: {}, format };
  }
  if (format === 'zip') {
    let files: Record<string, Uint8Array>;
    try {
      files = unzipSync(bytes);
    } catch (e) {
      throw new ContainerFormatError(`ZIP の展開に失敗しました: ${String(e)}`);
    }
    const entry = files[PROJECT_ENTRY];
    if (!entry) throw new ContainerFormatError(`コンテナ内に ${PROJECT_ENTRY} がありません`);
    const assets: Record<string, Uint8Array> = {};
    for (const [path, data] of Object.entries(files)) {
      if (path.startsWith(ASSETS_DIR) && path.length > ASSETS_DIR.length && !path.endsWith('/')) {
        assets[path.slice(ASSETS_DIR.length)] = data;
      }
    }
    return { project: deserializeProject(strFromU8(entry), opts), assets, format };
  }
  throw new ContainerFormatError('不明なファイル形式です（.gflow として読めません）');
}

export function tryDeserializeContainer(
  bytes: Uint8Array,
  opts?: DeserializeOptions,
): { ok: true; data: ContainerData } | { ok: false; error: unknown } {
  try {
    return { ok: true, data: deserializeContainer(bytes, opts) };
  } catch (error) {
    return { ok: false, error };
  }
}
