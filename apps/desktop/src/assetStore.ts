// 画像バイナリのセッション内メモリ層（最大の落とし穴対策）。
//
// 設計の核心:
//  - 画像バイナリは Project の外に置く（undo/autosave/dirty に一切乗らない）。Project が持つのは
//    StepImage.file（内容ハッシュ由来の安定名）だけ。実バイトはこの Map に保持し、描画は blob URL。
//  - 保存時は「現 project が参照する分のみ」を ZIP assets へ書く（= 保存時 GC）。ただし本メモリは
//    消さない（保存後に undo で画像が復活しても生きているように）。同じ理由で store.ts の
//    removeStepImage は Project 側の参照を消すだけで、ここ（bytesByFile/urlByFile）には触れない
//    （画像を消す undo で復活しても生きているように、意図して残す）。
//  - 二窓では画像追加時に bytes を BroadcastChannel の専用 asset メッセージで配る（snapshot には
//    載せない＝重いバイナリを毎編集で配らない）。配布口は dualwindow.ts が setAssetSink で差し込む。
//
// UI/OS 依存（Blob/URL）はここに閉じる（core は非依存を保つ）。

// file 名 → 実バイト。名前が内容ハッシュ由来なので「同一内容 ⇒ 同名 ⇒ 共有」。
const bytesByFile = new Map<string, Uint8Array>();
// file 名 → 生成済み blob URL（遅延生成・キャッシュ）。
const urlByFile = new Map<string, string>();

// MIME → 拡張子。安全な文字のみを名前へ使う（path traversal / 変な文字を作らない）。
const EXT_BY_MIME: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
  'image/bmp': 'bmp',
  'image/avif': 'avif',
};
const EXT_TO_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  bmp: 'image/bmp',
  avif: 'image/avif',
};

function extForMime(mime: string): string {
  return EXT_BY_MIME[mime.toLowerCase().split(';')[0]!.trim()] ?? 'bin';
}
function mimeForFile(file: string): string {
  const ext = file.slice(file.lastIndexOf('.') + 1).toLowerCase();
  return EXT_TO_MIME[ext] ?? 'application/octet-stream';
}

/**
 * 内容ハッシュ由来の安定名（例 "1a2b3c4d5e6f7089.png"）。依存追加を避け、別シードの
 * FNV-1a 32bit を 2 本 1 パスで回して 64bit 相当（16 桁 hex）にする。長さも混ぜて衝突を減らす。
 * 要件は「同一内容 ⇒ 同名」のみ（暗号強度は不要）。出力は [0-9a-z.] のみ＝ファイル名として安全。
 */
export function contentHashName(bytes: Uint8Array, mime: string): string {
  let h1 = 0x811c9dc5;
  let h2 = (0x811c9dc5 ^ 0x9e3779b9) >>> 0;
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i]!;
    h1 = Math.imul(h1 ^ b, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ b, 0x01000193) >>> 0;
  }
  h1 = Math.imul(h1 ^ (bytes.length & 0xffff), 0x01000193) >>> 0;
  h2 = Math.imul(h2 ^ (bytes.length >>> 16), 0x01000193) >>> 0;
  const hex = h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0');
  return `${hex}.${extForMime(mime)}`;
}

/** メモリへ格納（冪等・重複は共有）。名前は内容由来なので既存があれば同一内容＝上書きしない。 */
export function putAsset(file: string, bytes: Uint8Array): void {
  if (!bytesByFile.has(file)) bytesByFile.set(file, bytes);
}

export function getAssetBytes(file: string): Uint8Array | undefined {
  return bytesByFile.get(file);
}

export function hasAsset(file: string): boolean {
  return bytesByFile.has(file);
}

/** 描画用 blob URL（遅延生成・キャッシュ）。DOM 非対応環境（テスト node）では undefined。 */
export function getAssetUrl(file: string): string | undefined {
  const bytes = bytesByFile.get(file);
  if (!bytes) return undefined;
  const cached = urlByFile.get(file);
  if (cached) return cached;
  if (typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') return undefined;
  // Uint8Array は実行時に有効な BlobPart（新しい lib.dom の型狭化を避けてキャストで受ける）。
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: mimeForFile(file) }));
  urlByFile.set(file, url);
  return url;
}

/** 保存用に参照分だけ抽出（メモリからのコピー参照・GC はしない）。 */
export function snapshotAssets(files: Iterable<string>): Record<string, Uint8Array> {
  const out: Record<string, Uint8Array> = {};
  for (const f of files) {
    const b = bytesByFile.get(f);
    if (b) out[f] = b;
  }
  return out;
}

/** open / external-watch で読み込んだ assets をメモリへ投入する。 */
export function ingestAssets(assets: Record<string, Uint8Array>): void {
  for (const [file, bytes] of Object.entries(assets)) putAsset(file, bytes);
}

// ---- 二窓 bytes 配布（配布口は dualwindow.ts が差し込む） ----
type AssetSink = (file: string, bytes: Uint8Array) => void;
let sink: AssetSink | null = null;

/** dualwindow の leader/follower ランタイムが自窓のチャネル送出口を登録/解除する。 */
export function setAssetSink(s: AssetSink | null): void {
  sink = s;
}

/** 追加した画像 bytes を相手窓へ配る（sink 未登録＝単独窓なら no-op）。 */
export function broadcastAsset(file: string, bytes: Uint8Array): void {
  sink?.(file, bytes);
}

/** メモリ層から「keep に無いエントリ」だけ削除する（生成済み blob URL は revokeObjectURL
    してから解放）。プロジェクト切替（＝undo 履歴をリセットするアクション: newProject/
    loadSample/loadTemplate/loadProject/restoreProject/importCsvText/importRows）で、
    採用する新プロジェクトが参照するファイル名の集合（core の collectReferencedAssetFiles）を
    keep に渡して呼ぶ。
    「全消し」ではなく「参照保持プルーン」にしているのは、loadProject の直前に
    openProjectFromFile が ingestAssets で開いたファイルの画像 bytes を先に取り込んでいるため
    ＝ここで keep を無視して全消しすると、開いたばかりのファイルの画像まで消してしまう
    （実際に踏んだ Critical リグレッション）。new/sample/template/import 系は生成した
    プロジェクトが画像を参照しないため keep が空集合になり、結果として従来どおり前プロジェクトの
    画像を丸ごと解放する（メモリ回収という目的は変わらない）。
    reloadFromExternal（同一プロジェクトの外部更新）では呼ばない: pollExternal が
    ingestAssets → onChange(reloadFromExternal) の順で呼ぶため、ここでプルーンすると同型の事故
    （直前に取り込んだ bytes を巻き添えで消す）が起きる。加えて undo 継続中は編集前の画像も
    要るため、そもそも参照分だけに絞ってはいけない。 */
export function pruneAssetStore(keep: Set<string>): void {
  const revocable = typeof URL !== 'undefined' && typeof URL.revokeObjectURL === 'function';
  const files = new Set<string>([...bytesByFile.keys(), ...urlByFile.keys()]);
  for (const file of files) {
    if (keep.has(file)) continue;
    const url = urlByFile.get(file);
    if (url) {
      if (revocable) URL.revokeObjectURL(url);
      urlByFile.delete(file);
    }
    bytesByFile.delete(file);
  }
}

/** メモリ層を空にする（pruneAssetStore(空集合) の別名）。テストのリセット等、
    「本当に全部消したい」場面でのみ使う。 */
export function clearAssetStore(): void {
  pruneAssetStore(new Set());
}

/** テスト専用: メモリ層をクリアする（blob URL も解放）＋ sink も外す。 */
export function __resetAssetStoreForTest(): void {
  clearAssetStore();
  sink = null;
}
