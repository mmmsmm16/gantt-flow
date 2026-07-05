// フロントの保存/開く/取り込み/出力。
// バックエンドは 2 系統（呼び出し側の API は共通）:
// - Tauri 配下: window.__TAURI__ 経由で Rust(fsstore) のコマンドを呼ぶ。
//   アトミック保存（fsync+rename）＋助言ロック（開く時）＋mtime 競合検知（保存時）。
// - ブラウザ: File System Access API（showSaveFilePicker）で「同一ファイルへ上書き」。
//   ハンドルを覚えておく＝2 回目以降はダイアログ無しで上書き。非対応ブラウザはダウンロード。
import * as XLSX from 'xlsx';
import {
  serializeProject,
  serializeContainer,
  deserializeContainer,
  collectReferencedAssetFiles,
  projectToRows,
  projectToCsv,
  computeCodes,
  parseCsv,
  type Project,
  type FlowLevelView,
  type LockInfo,
  type AcquireResult,
} from '@gantt-flow/core';
import { bytesToB64, b64ToBytes } from './b64';
import { buildFlowSvg, decorateFlowSvg } from './flowSvg';
import { snapshotAssets, ingestAssets, hasAsset } from './assetStore';
import { buildHandbookHtml } from './handbook';
import { loadLocationAliases } from './locationAliases';
import { useUI, type LockUiState } from './ui/useUI';

// 助言ロックの状態変化・更新失敗を UI へ伝える(沈黙させない)。UI 未初期化でも落とさない(fail-open)。
function notifyLock(state: LockUiState | null): void {
  try {
    useUI.getState().setLockState(state);
  } catch {
    /* UI ストア未初期化などは無視 */
  }
}
function reportLockFailure(): void {
  try {
    useUI.getState().notePersistFailure('lock');
  } catch {
    /* 無視 */
  }
}

// File System Access API は一部ブラウザのみ。lib.dom に未収録のため使う範囲だけ最小宣言する
//（既存の lib 型と衝突しないよう独自名で定義）。
interface FsWritable {
  write(data: BlobPart | Uint8Array): Promise<void>;
  close(): Promise<void>;
}
interface FsFileHandle {
  readonly name: string;
  createWritable(): Promise<FsWritable>;
  getFile(): Promise<File>;
  requestPermission?(opts: { mode: 'read' | 'readwrite' }): Promise<PermissionState>;
}
interface FsPickerType {
  description?: string;
  accept: Record<string, string[]>;
}
declare global {
  interface Window {
    // Tauri 2 のグローバルブリッジ（tauri.conf.json の withGlobalTauri: true）。使う範囲だけ宣言。
    __TAURI__?: {
      core: { invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> };
    };
    showSaveFilePicker?: (opts?: {
      suggestedName?: string;
      types?: FsPickerType[];
    }) => Promise<FsFileHandle>;
    showOpenFilePicker?: (opts?: {
      types?: FsPickerType[];
      multiple?: boolean;
    }) => Promise<FsFileHandle[]>;
  }
}

// プロジェクトの保存拡張子。中身は JSON のままだが、専用拡張子にすることで
// OS のファイル関連付け（tauri.conf.json の bundle.fileAssociations）でダブルクリック時に
// 本アプリで開け、テキストエディタへの誤関連付けを避ける。
export const PROJECT_EXT = '.gflow';

// 保存/開くのファイルピッカー種別。保存時は先頭の拡張子（.gflow）が既定になり、
// 開く時は旧 .json も選べる（後方互換: 拡張子変更前に保存したファイルを読める）。
const PROJECT_TYPES: FsPickerType[] = [
  {
    description: 'gantt-flow プロジェクト',
    accept: { 'application/json': [PROJECT_EXT, '.json'] },
  },
];

// ---- Tauri バックエンド ----

export const isTauri = (): boolean =>
  typeof window !== 'undefined' && window.__TAURI__ !== undefined;

// Rust 側コマンド呼び出し。JS 側キーは camelCase（Tauri 2 が snake_case 引数へ自動変換）。
// エラーは文字列で reject される（Rust 側 map_err(|e| e.to_string())）。
const invoke = <T>(cmd: string, args: Record<string, unknown> = {}): Promise<T> =>
  window.__TAURI__!.core.invoke<T>(cmd, args);

const APP_VERSION = '0.0.0';
// このアプリ実行（ウィンドウ）ごとの識別子。助言ロックの自他判定に使う。
const SESSION_ID =
  typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

const LOCK_REFRESH_MS = 30_000; // ハートビート間隔
const LOCK_STALE_MS = 90_000; // 3×間隔（docs/05-persistence.md §3）を超えたら引き継ぎ候補

// WebView からは OS のユーザー名/ホスト名を取得できないため、表示用のベストエフォート値。
const makeOwner = (): LockInfo => {
  const now = Date.now();
  return {
    user: 'gantt-flow ユーザー',
    host: typeof navigator !== 'undefined' && navigator.platform ? navigator.platform : 'unknown',
    sessionId: SESSION_ID,
    openedAt: now,
    heartbeatAt: now,
    appVersion: APP_VERSION,
  };
};

// 開いている/保存先。ブラウザは File System Access のハンドル、Tauri は絶対パスを覚える。
// これがあると次回の保存はダイアログ無しで同じファイルへ上書きする。
let fileHandle: FsFileHandle | null = null;
let filePath: string | null = null;
// Tauri: 競合検知用。開く/保存のたびに mtime を記録し、次の保存前に比較する。
let lastKnownMtime: string | null = null;
// Tauri: 保持中の助言ロック。
let lockPath: string | null = null;
let lockOwner: LockInfo | null = null;
let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
// 外部変更ウォッチ（片方向ライブ同期）。savingNow は自分の保存中フラグ、
// lastSeenExternalMtime は「外部変更として通知済みの mtime」（同一変更の二重通知を防ぐ）。
let savingNow = false;
let watchTimer: ReturnType<typeof setInterval> | undefined;
let watchBusy = false;
let lastSeenExternalMtime: string | null = null;

const basename = (p: string): string => p.split(/[\\/]/).pop() || p;

// stat 失敗は「不明」扱い（保存自体の失敗は save_project 側で検知される）。
const statMtime = async (path: string): Promise<string | null> => {
  try {
    return await invoke<string | null>('stat_updated_at', { path });
  } catch {
    return null;
  }
};

function stopHeartbeat(): void {
  if (heartbeatTimer !== undefined) clearInterval(heartbeatTimer);
  heartbeatTimer = undefined;
}

let unloadHookInstalled = false;
function installUnloadHook(): void {
  // beforeunload は「閉じる」を取り消せるため使わない（取り消されてもロックが消えてしまう）。
  if (unloadHookInstalled || typeof window === 'undefined' || typeof window.addEventListener !== 'function')
    return;
  unloadHookInstalled = true;
  window.addEventListener('pagehide', () => void releaseHeldLock());
}

function beginHolding(path: string, owner: LockInfo): void {
  stopHeartbeat();
  lockPath = path;
  lockOwner = owner;
  installUnloadHook();
  notifyLock('holding'); // 編集ロック保持中(StatusBar 表示)
  heartbeatTimer = setInterval(() => {
    if (!lockPath || !lockOwner) return;
    lockOwner = { ...lockOwner, heartbeatAt: Date.now() };
    // Rust 側は保持者(sessionId)が一致しない限り上書きを拒否して Err を返す。
    // 失敗＝ロックを失った（奪取された等）か IO 不調なので、ハートビートを止めて
    // 他セッションの正当なロックを乱さない（助言ロックの安全側）。
    void invoke('refresh_lock', { path: lockPath, owner: lockOwner }).catch(() => {
      // 沈黙させない: ロック更新の失敗を可視化し、読み取り専用扱いへ落とす（編集は妨げない）。
      stopHeartbeat();
      notifyLock('readonly');
      reportLockFailure();
    });
  }, LOCK_REFRESH_MS);
}

async function releaseHeldLock(): Promise<void> {
  stopHeartbeat();
  const path = lockPath;
  const owner = lockOwner;
  lockPath = null;
  lockOwner = null;
  if (!path || !owner) return;
  try {
    await invoke('release_lock', { path, owner });
  } catch {
    /* 解放失敗は放置（残ったロックは stale 引き継ぎで回収される） */
  }
}

/** 他セッションのロックを検出したときの判断。stale=true は放置されたロック（引き継ぎ候補）。 */
export type LockDecision = 'takeover' | 'proceed' | 'cancel';
export interface OpenOptions {
  /** 省略時はロック無しで続行（呼び出し側が確認 UI を持たない場合のベストエフォート）。
   *  held: null は保持者不明（.lock が読めない）— 表示は「保持者不明」、奪取は提示しない。 */
  confirmLock?: (held: LockInfo | null, stale: boolean) => Promise<LockDecision>;
}

type LockAttempt = { status: 'locked'; owner: LockInfo } | { status: 'unlocked' | 'cancelled' };

async function acquireLockFor(
  path: string,
  confirmLock?: OpenOptions['confirmLock'],
): Promise<LockAttempt> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const owner = makeOwner();
    let res: AcquireResult;
    try {
      res = await invoke<AcquireResult>('acquire_lock', {
        path,
        owner,
        staleAfterMs: LOCK_STALE_MS,
        nowMs: Date.now(),
      });
    } catch {
      return { status: 'unlocked' }; // ロックは助言的: 取得の失敗自体で「開く」を妨げない
    }
    if (res.ok) return { status: 'locked', owner };
    const decision = confirmLock ? await confirmLock(res.held, res.stale) : 'proceed';
    if (decision === 'cancel') return { status: 'cancelled' };
    if (decision === 'proceed') return { status: 'unlocked' };
    // 保持者不明（held: null）のロックは奪取の期待値が無いので、取り直して再判断する。
    if (!res.held) continue;
    // takeover: 確認時に見たロック(held)からの引き継ぎ。内容が変わっていたら（先を越された等）
    // false が返るので、取り直して再判断する。
    try {
      const stolen = await invoke<boolean>('steal_lock', { path, owner, expected: res.held });
      if (stolen) return { status: 'locked', owner };
    } catch {
      return { status: 'unlocked' };
    }
  }
  return { status: 'cancelled' }; // 競合が解消しない場合は安全側（開かない）に倒す
}

export function hasFileHandle(): boolean {
  return fileHandle !== null || filePath !== null;
}
export function currentFileName(): string | null {
  if (filePath !== null) return basename(filePath);
  return fileHandle?.name ?? null;
}
/** 新規/取り込み等で「保存先を忘れる」（次の保存でピッカーを出す）。ロックも返す。 */
export function forgetFileHandle(): void {
  fileHandle = null;
  filePath = null;
  lastKnownMtime = null;
  lastSeenExternalMtime = null;
  notifyLock(null); // 保存先を忘れる＝ロック表示も消す
  void releaseHeldLock();
}

const fsSupported = (): boolean =>
  typeof window !== 'undefined' && typeof window.showSaveFilePicker === 'function';

const isAbort = (err: unknown): boolean =>
  err instanceof DOMException && err.name === 'AbortError';

const safeName = (title: string) =>
  (title.trim() || 'project').replace(/[^\w\-一-龠ぁ-んァ-ヶ。、ー]/g, '_');

function download(name: string, data: BlobPart | Uint8Array, mime: string): void {
  // Uint8Array は実行時に有効な BlobPart。新しい lib.dom の型狭化を避けるためここで受ける。
  const url = URL.createObjectURL(new Blob([data as BlobPart], { type: mime }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

// 保存の結果。呼び出し側はこれで成功・キャンセル・競合を区別する（失敗は throw）。
export type SaveOutcome =
  | { kind: 'saved'; name: string } // 保存先ファイルへ書き込んだ
  | { kind: 'downloaded'; name: string } // 上書き不可の環境のためダウンロードに保存した（ブラウザ）
  | { kind: 'cancelled' } // ユーザーがピッカーをキャンセル
  | { kind: 'conflict' }; // Tauri: 開いた後にファイルが他で変更されている（force で上書き可）

// 保存。Tauri ではアトミック保存＋mtime 競合検知、ブラウザでは File System Access で上書き。
// 書き込みの失敗は throw する（黙ってダウンロードに逃げない: 成功扱いになると dirty が消え、
// 復旧データも消えてしまうため）。
// 保存はモジュール内で直列化する: 実行中の保存があれば、その完了（lastKnownMtime の更新まで）
// を待ってから次を実行する。アトミック保存のリネームで変わる自分の mtime を、並行した
// 2 回目の保存が「他者の変更」と誤検出するのを防ぐ。
let saveQueue: Promise<unknown> = Promise.resolve();

/** 保存前チェック（最後の安全網）: project が参照する画像のうち、assetStore に bytes が無い
 *  ＝このまま保存すると ZIP assets/ へ書けず永久に失われるファイル名の一覧を返す（純粋・OS 非依存）。
 *  クラッシュ復旧（localStorage・画像なし）後などに起こりうる無言の画像消失を、App の doSave が
 *  この結果を見て確認ダイアログで食い止めるために使う。空配列なら欠落なし＝そのまま保存してよい。 */
export function missingReferencedAssets(project: Project): string[] {
  return [...collectReferencedAssetFiles(project)].filter((file) => !hasAsset(file));
}

export function saveProjectToFile(
  project: Project,
  opts: { saveAs?: boolean; force?: boolean } = {},
): Promise<SaveOutcome> {
  const run = saveQueue.then(() => doSaveProjectToFile(project, opts));
  saveQueue = run.catch(() => undefined); // 失敗は呼び出し側へ伝播しつつ、次の保存は塞がない
  return run;
}

async function doSaveProjectToFile(
  project: Project,
  opts: { saveAs?: boolean; force?: boolean },
): Promise<SaveOutcome> {
  savingNow = true; // 外部変更ウォッチャに「今の mtime 変化は自分の保存」と知らせる
  try {
    return await doSave(project, opts);
  } finally {
    savingNow = false;
  }
}

async function doSave(
  project: Project,
  opts: { saveAs?: boolean; force?: boolean },
): Promise<SaveOutcome> {
  // 保存時 GC: 現 project から参照される画像だけを ZIP assets/ へ書く（assetStore のメモリは消さない
  // ＝保存後に undo で画像が復活しても生きている）。参照されない孤児はここで自然に落ちる（意図）。
  const bytes = serializeContainer(project, snapshotAssets(collectReferencedAssetFiles(project)));
  const suggested = `${safeName(project.meta.title)}${PROJECT_EXT}`;
  if (isTauri()) return saveTauri(bytes, suggested, opts);
  if (fsSupported()) {
    if (!fileHandle || opts.saveAs) {
      try {
        fileHandle = await window.showSaveFilePicker!({
          suggestedName: suggested,
          types: PROJECT_TYPES,
        });
      } catch (err) {
        if (isAbort(err)) return { kind: 'cancelled' };
        throw err;
      }
    }
    const w = await fileHandle.createWritable();
    await w.write(bytes);
    await w.close();
    void rememberRecent(fileHandle);
    return { kind: 'saved', name: fileHandle.name };
  }
  // File System Access 非対応ブラウザのみダウンロード（呼び出し側は「上書きではない」と分かる）。
  download(suggested, bytes, 'application/octet-stream');
  return { kind: 'downloaded', name: suggested };
}

async function saveTauri(
  bytes: Uint8Array,
  suggested: string,
  opts: { saveAs?: boolean; force?: boolean },
): Promise<SaveOutcome> {
  let path = filePath;
  let picked = false;
  if (!path || opts.saveAs) {
    path = await invoke<string | null>('pick_save_path', { suggestedName: suggested });
    if (path === null) return { kind: 'cancelled' };
    // 拡張子（.gflow）の補完と保存先の許可登録は Rust 側 pick_save_path が行う。ここで
    // 別の文字列へ書き換えると、許可リストに載ったパスと一致せず save_project が弾かれる。
    picked = true;
  }
  // 競合検知: 覚えているファイルへの上書きで、開く/前回保存の後に他者が変更していないか。
  // ピッカーで選び直した場合は明示的な上書き意思なので確認しない。
  if (!picked && !opts.force && lastKnownMtime !== null) {
    const mtime = await statMtime(path);
    if (mtime !== null && mtime !== lastKnownMtime) return { kind: 'conflict' };
  }
  await invoke<null>('save_project', { path, contentsB64: bytesToB64(bytes) });
  lastKnownMtime = await statMtime(path);
  if (filePath !== path) {
    fileHandle = null;
    filePath = path;
    // 保存先が変わったらロックも移す（ベストエフォート: 取れなくても保存自体は完了している）。
    await releaseHeldLock();
    const savedPath = path; // 閉包用に固定（この保存が対象としたパス）
    void acquireLockFor(savedPath).then(async (r) => {
      if (r.status !== 'locked') return;
      // 取得待ちの間にさらに保存先が変わっていたら、このロックは古い対象 → 保持せず返す
      //（無条件に beginHolding すると現在の保存先のロック/ハートビートを上書きしてしまう）。
      if (filePath !== savedPath) {
        try {
          await invoke('release_lock', { path: savedPath, owner: r.owner });
        } catch {
          /* 解放失敗は放置（残ったロックは stale 引き継ぎで回収される） */
        }
        return;
      }
      beginHolding(savedPath, r.owner);
    });
  }
  return { kind: 'saved', name: basename(path) };
}

/** プロジェクトをファイルとしてダウンロード保存する（クラッシュ時の退避など最終手段）。 */
export function downloadProjectJson(project: Project): string {
  const name = `${safeName(project.meta.title)}${PROJECT_EXT}`;
  download(name, serializeProject(project), 'application/json');
  return name;
}

// ---- 外部変更の監視（片方向ライブ同期。Tauri のみ・ポーリング） ----
// 別プロセス（MCP サーバ等）が現在開いているファイルを書き換えたら検知して onChange へ渡す。
// 自分の保存とは lastKnownMtime / savingNow で区別する。ブラウザは絶対パスを持たないため対象外。

// 外部変更監視の恒久失敗（共有フォルダが見えない・権限喪失など）を可視化するためのカウンタ。
// stat が連続で失敗し閾値に達したら 1 回だけ通知し、成功（stat が読めた）でリセットする。
// 書き込み途中の一時的な読込失敗（deserialize throw）は stat が読めていれば失敗に数えない
//（数十秒に渡り stat すら通らない＝監視自体が壊れている場合だけ知らせる）。
let watchFailCount = 0;
let watchFailNotified = false;
const WATCH_FAIL_THRESHOLD = 30; // 1 秒間隔なら約 30 秒の連続失敗

function resetWatchFailure(): void {
  watchFailCount = 0;
  watchFailNotified = false;
}
function noteWatchFailure(): void {
  watchFailCount += 1;
  if (watchFailCount < WATCH_FAIL_THRESHOLD || watchFailNotified) return;
  watchFailNotified = true; // 1 回だけ（毎秒スパムしない）
  try {
    useUI.getState().toast('共有ファイルの変更監視に失敗しています', 'info');
  } catch {
    /* UI 未初期化などは無視（fail-open） */
  }
}

/** 監視を開始（既存の監視は止めて張り替え）。intervalMs ごとに mtime を比較する。 */
export function startExternalWatch(onChange: (project: Project) => void, intervalMs = 1000): void {
  if (!isTauri()) return;
  stopExternalWatch();
  resetWatchFailure(); // 張り替えのたびに失敗計数はまっさらから
  watchTimer = setInterval(() => void pollExternal(onChange), intervalMs);
}

export function stopExternalWatch(): void {
  if (watchTimer !== undefined) clearInterval(watchTimer);
  watchTimer = undefined;
}

// 外部変更を「反映/無視」と確定したら呼ぶ。直近に観測した外部 mtime を既知へ昇格させ、
// 同じ変更で再び発火しないようにする（保存時の競合検知の基準も更新される）。
export function acknowledgeExternalChange(): void {
  if (lastSeenExternalMtime !== null) lastKnownMtime = lastSeenExternalMtime;
}

async function pollExternal(onChange: (project: Project) => void): Promise<void> {
  if (watchBusy || savingNow || filePath === null || lastKnownMtime === null) return;
  watchBusy = true;
  let statOk = false; // stat が読めた＝監視は機能している（失敗計数の判定に使う）
  try {
    const mtime = await statMtime(filePath);
    if (mtime === null) return; // stat 失敗＝監視できていない（finally で失敗計上）
    statOk = true;
    // 変化なし / 自分の保存後で既知 / 既に通知済みの同一変更 ならスキップ。
    if (mtime === lastKnownMtime || mtime === lastSeenExternalMtime) return;
    const b64 = await invoke<string>('open_project', { path: filePath });
    const c = deserializeContainer(b64ToBytes(b64)); // 書き込み途中の壊れた中間状態なら throw → 次回拾う
    ingestAssets(c.assets); // 外部変更で増減した画像をメモリ層へ取り込む
    const project = c.project;
    lastSeenExternalMtime = mtime;
    onChange(project);
  } catch {
    /* 監視はベストエフォート（読み取り失敗は次のポーリングで再試行） */
  } finally {
    watchBusy = false;
    // stat が通れば監視は生きている（一時的な読込失敗はここで許容）。連続して stat すら
    // 通らないときだけ失敗を積み、閾値で 1 回通知する。
    if (statOk) resetWatchFailure();
    else noteWatchFailure();
  }
}

// ---- 出力（Phase4） ----

/** ローカル時刻の YYYY-MM-DD（toISOString は UTC のため、日本では 0〜9 時に前日になる）。 */
export function localDateYmd(d = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// 出力/印刷アクション前の確認要否（工程 0 件の無警告出力を防ぐ・UX16位以下）。
// 呼び出し側（App）が useUI.confirm() で実際の確認を出す。ここは判定だけの純関数。
export function isEmptyProjectForOutput(project: Project): boolean {
  return Object.keys(project.core.tasks).length === 0;
}

export function exportCsvFile(project: Project): string {
  const name = `${safeName(project.meta.title)}.csv`;
  download(name, '﻿' + projectToCsv(project), 'text/csv;charset=utf-8');
  return name;
}

// 課題一覧を Excel に書き出す（コンサル定番の納品物「課題一覧表」）。
export function exportIssuesExcel(project: Project): string {
  const codes = computeCodes(project.core);
  const rows: string[][] = [['工程No', '工程', '担当', '課題', '方策']];
  const ordered = Object.values(project.core.tasks).sort((a, b) =>
    (codes[a.id] ?? '').localeCompare(codes[b.id] ?? '', undefined, { numeric: true }),
  );
  for (const t of ordered) {
    const assignee = t.assigneeId ? project.core.assignees[t.assigneeId]?.name ?? '' : '';
    for (const iss of project.details[t.id]?.issues ?? []) {
      if (!iss.issue.trim() && !iss.measure?.trim()) continue;
      rows.push([codes[t.id] ?? '', t.name, assignee, iss.issue, iss.measure ?? '']);
    }
  }
  const name = `${safeName(project.meta.title)}-課題一覧.xlsx`;
  const ws = XLSX.utils.aoa_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, '課題一覧');
  const buf = XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer;
  download(name, buf, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  return name;
}

export function exportExcelFile(project: Project): string {
  const name = `${safeName(project.meta.title)}.xlsx`;
  // 人間が読む納品物なので前工程は作業名で出す（工程No は CSV ラウンドトリップ用）。
  const ws = XLSX.utils.aoa_to_sheet(projectToRows(project, { depRef: 'name' }));
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, '工程表');
  const buf = XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer;
  download(name, buf, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  return name;
}

// 図に「タイトル・出力日・凡例」を載せた装飾版 SVG（共有/提出用）。
function decoratedSvg(project: Project, view: FlowLevelView): string {
  return decorateFlowSvg(buildFlowSvg(project, view), {
    title: project.meta.title || 'プロジェクト',
    subtitle: `業務フロー図 / 出力日: ${localDateYmd()}`,
  });
}

export function exportSvgFile(project: Project, view: FlowLevelView): string {
  const name = `${safeName(project.meta.title)}-flow.svg`;
  download(name, decoratedSvg(project, view), 'image/svg+xml');
  return name;
}

const loadImage = (url: string): Promise<HTMLImageElement> =>
  new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = url;
  });

// PNG 出力: 装飾版 SVG を 2倍解像度でラスタライズ（Word/PowerPoint へ貼りやすい）。
export async function exportPngFile(project: Project, view: FlowLevelView): Promise<string> {
  const name = `${safeName(project.meta.title)}-flow.png`;
  const svg = decoratedSvg(project, view);
  const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml;charset=utf-8' }));
  try {
    const img = await loadImage(url);
    const w = img.naturalWidth || 1000;
    const h = img.naturalHeight || 700;
    const scale = 2;
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(w * scale);
    canvas.height = Math.round(h * scale);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('canvas 2d context unavailable');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.scale(scale, scale);
    ctx.drawImage(img, 0, 0, w, h);
    const png = await new Promise<Blob | null>((res) => canvas.toBlob(res, 'image/png'));
    // toBlob は図が大きすぎる等で null を返しうる。黙って成功扱いにせず失敗として伝える。
    if (!png) throw new Error('PNG への変換に失敗しました（図が大きすぎる可能性があります）');
    download(name, png, 'image/png');
  } finally {
    URL.revokeObjectURL(url);
  }
  return name;
}

// ハンドブック（自己完結 HTML 1 ファイル）出力。場所エイリアス・画像バイトはここで組んで
// buildHandbookHtml（純関数）へ渡す（生成器自身は localStorage/assetStore に触れない）。
export function exportHandbookFile(project: Project): string {
  const name = `${safeName(project.meta.title)}-handbook.html`;
  const html = buildHandbookHtml(project, {
    aliases: loadLocationAliases(),
    assets: snapshotAssets(collectReferencedAssetFiles(project)),
  });
  download(name, html, 'text/html;charset=utf-8');
  return name;
}

const escapeHtml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// 印刷 / PDF: 工程表（全項目）＋現在のフロー図を 1 枚の印刷用 HTML にまとめ、
// 隠し iframe で印刷ダイアログを出す（ブラウザの「PDF として保存」で PDF 化できる）。
// ポップアップブロックを避けるため window.open ではなく iframe を使う。
// 戻り値は成否（true=印刷用ドキュメントを組めた / false=iframe の文書が使えず出せなかった）。
// 呼び出し側（App.onPrint）が false のとき error トーストで沈黙を破る。
export function printProjectAndFlow(project: Project, view: FlowLevelView | undefined): boolean {
  const title = project.meta.title || 'プロジェクト';
  // 印刷も人間が読む出力なので前工程は作業名（XLSX 出力と同じ方針）。
  const rows = projectToRows(project, { depRef: 'name' });
  const header = rows[0] ?? [];
  const body = rows.slice(1);
  const thead = `<tr>${header.map((h) => `<th>${escapeHtml(h)}</th>`).join('')}</tr>`;
  const tbody = body
    .map((r) => `<tr>${r.map((c) => `<td>${escapeHtml(c).replace(/\n/g, '<br>')}</td>`).join('')}</tr>`)
    .join('');
  const svg = view ? buildFlowSvg(project, view) : '';
  const today = localDateYmd();
  const html = `<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>${escapeHtml(title)}</title>
<style>
  * { box-sizing: border-box; }
  body { font-family: system-ui, -apple-system, "Hiragino Kaku Gothic ProN", Meiryo, sans-serif; color: #1a1a1a; margin: 16mm; }
  h1 { font-size: 18px; margin: 0 0 2px; }
  .meta { color: #666; font-size: 11px; margin-bottom: 14px; }
  h2 { font-size: 13px; margin: 18px 0 6px; border-bottom: 2px solid #333; padding-bottom: 2px; }
  table { border-collapse: collapse; width: 100%; font-size: 10px; table-layout: fixed; }
  th, td { border: 1px solid #bbb; padding: 3px 5px; text-align: left; vertical-align: top; word-break: break-word; }
  th { background: #f0f0f0; }
  .figure { margin-top: 6px; }
  .figure svg { max-width: 100%; height: auto; }
  @media print { @page { size: A4 landscape; margin: 12mm; } h2 { break-before: page; } h2:first-of-type { break-before: auto; } }
</style></head><body>
  <h1>${escapeHtml(title)}</h1>
  <div class="meta">工程表・業務フロー図 / 出力日: ${today}</div>
  <h2>工程表（手順一覧表）</h2>
  <table><thead>${thead}</thead><tbody>${tbody}</tbody></table>
  ${svg ? `<h2>業務フロー図</h2><div class="figure">${svg}</div>` : ''}
</body></html>`;

  const iframe = document.createElement('iframe');
  iframe.setAttribute('aria-hidden', 'true');
  Object.assign(iframe.style, { position: 'fixed', right: '0', bottom: '0', width: '0', height: '0', border: '0' });
  iframe.onload = () => {
    const win = iframe.contentWindow;
    if (!win) return;
    win.focus();
    win.print();
    setTimeout(() => iframe.remove(), 1000); // 印刷ダイアログ後に後片付け
  };
  document.body.appendChild(iframe);
  const doc = iframe.contentWindow?.document;
  if (!doc) {
    iframe.remove();
    return false;
  }
  doc.open();
  doc.write(html);
  doc.close();
  return true;
}

// ---- 取り込み（CSV / Excel → 行列） ----
export async function readTableFile(file: File): Promise<string[][]> {
  if (file.name.toLowerCase().endsWith('.csv')) {
    // RFC 4180 のクオート（"a, b"・""・改行入りセル）に対応した core のパーサを使う。
    // 自前の split(',') ではエクスポートした CSV すら正しく読み戻せない。
    return parseCsv(await file.text());
  }
  const wb = XLSX.read(await file.arrayBuffer(), { type: 'array' });
  const sheet = wb.Sheets[wb.SheetNames[0]!]!;
  const rows = XLSX.utils.sheet_to_json<string[]>(sheet, { header: 1, raw: false, defval: '' });
  return rows.map((r) => r.map((c) => String(c ?? '')));
}

// 開く。Tauri ではダイアログ→読み込み→助言ロック取得（他セッションが保持していれば
// opts.confirmLock で判断を仰ぐ）。ブラウザはピッカーでハンドルを取得（以後の保存は上書き）。
// 非対応ブラウザは <input type=file>。不正なファイルは throw（Zod / 整合性エラー）。
export async function openProjectFromFile(opts: OpenOptions = {}): Promise<Project | null> {
  if (isTauri()) {
    const path = await invoke<string | null>('pick_open_path', {});
    if (path === null) return null;
    // mtime は読む「前」に取る（読んでいる間の変更を、次の保存で競合として拾う側に倒す）。
    const mtime = await statMtime(path);
    const b64 = await invoke<string>('open_project', { path });
    const c = deserializeContainer(b64ToBytes(b64)); // 不正なら throw
    ingestAssets(c.assets); // 開いたファイルの画像をメモリ層へ
    const project = c.project;
    // 助言ロックの付け替え。同じファイルの開き直しは保持中のロックをそのまま使う
    //（一度手放すと、確認のキャンセルや取得失敗で「今の状態のまま」ロックだけ失ってしまう）。
    if (lockPath !== path) {
      // 別パス: 新しいロックの取得（or ユーザーの続行判断）が確定してから旧ロックを返す。
      const lock = await acquireLockFor(path, opts.confirmLock);
      if (lock.status === 'cancelled') return null; // 開くのをやめる（今の状態・旧ロックは変えない）
      await releaseHeldLock(); // 前に開いていたファイルのロックを返す
      if (lock.status === 'locked') beginHolding(path, lock.owner);
      else notifyLock('readonly'); // ロック未取得のまま続行＝読み取り専用として明示する
    }
    fileHandle = null;
    filePath = path;
    lastKnownMtime = mtime;
    lastSeenExternalMtime = null; // 開き直しで前ファイルの観測値を持ち越さない
    return project;
  }
  if (typeof window !== 'undefined' && typeof window.showOpenFilePicker === 'function') {
    let handles: FsFileHandle[];
    try {
      handles = await window.showOpenFilePicker({ types: PROJECT_TYPES, multiple: false });
    } catch (err) {
      if (isAbort(err)) return null;
      throw err;
    }
    const handle = handles[0];
    if (!handle) return null;
    const file = await handle.getFile();
    const c = deserializeContainer(new Uint8Array(await file.arrayBuffer())); // 不正なら throw
    ingestAssets(c.assets);
    const project = c.project;
    fileHandle = handle; // 検証成功後にだけ保存先として採用
    filePath = null;
    void rememberRecent(handle);
    return project;
  }
  return new Promise((resolve, reject) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.gflow,.json,application/json';
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) {
        resolve(null);
        return;
      }
      try {
        const buf = new Uint8Array(await file.arrayBuffer());
        const c = deserializeContainer(buf); // 不正なら throw（Zod）
        ingestAssets(c.assets);
        const project = c.project;
        fileHandle = null; // input 経由は上書き不可（毎回ダウンロード保存）
        filePath = null;
        resolve(project);
      } catch (err) {
        reject(err);
      }
    };
    input.click();
  });
}

// ---- 最近使ったファイル（IndexedDB にファイルハンドルを保存して再オープン可能に） ----
// File System Access API のハンドルは構造化複製で永続化でき、再オープン時に権限を求めて読める。
const RECENT_DB = 'gantt-flow';
const RECENT_STORE = 'recent';

interface RecentRecord {
  name: string;
  at: number;
  handle: FsFileHandle;
}

export function recentFilesSupported(): boolean {
  return typeof indexedDB !== 'undefined' && fsSupported();
}

function openRecentDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(RECENT_DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(RECENT_STORE, { keyPath: 'name' });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function rememberRecent(handle: FsFileHandle): Promise<void> {
  if (!recentFilesSupported()) return;
  try {
    const db = await openRecentDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(RECENT_STORE, 'readwrite');
      tx.objectStore(RECENT_STORE).put({ name: handle.name, at: nowMs(), handle } satisfies RecentRecord);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  } catch {
    /* IndexedDB 不可は無視（最近使ったファイルはベストエフォート） */
  }
}

// Date.now を 1 か所に閉じ込め（呼び出しは UI イベント起点なので問題ない）。
const nowMs = (): number => Date.now();

export async function listRecentFiles(): Promise<{ name: string; at: number }[]> {
  if (!recentFilesSupported()) return [];
  try {
    const db = await openRecentDb();
    const all = await new Promise<RecentRecord[]>((resolve, reject) => {
      const tx = db.transaction(RECENT_STORE, 'readonly');
      const r = tx.objectStore(RECENT_STORE).getAll();
      r.onsuccess = () => resolve(r.result as RecentRecord[]);
      r.onerror = () => reject(r.error);
    });
    db.close();
    return all.map((x) => ({ name: x.name, at: x.at })).sort((a, b) => b.at - a.at).slice(0, 6);
  } catch {
    return [];
  }
}

// 最近使ったファイルを開く。権限を求めて読み、保存先（fileHandle）にも採用する。
export async function openRecentFile(name: string): Promise<Project | null> {
  const db = await openRecentDb();
  const rec = await new Promise<RecentRecord | undefined>((resolve, reject) => {
    const tx = db.transaction(RECENT_STORE, 'readonly');
    const r = tx.objectStore(RECENT_STORE).get(name);
    r.onsuccess = () => resolve(r.result as RecentRecord | undefined);
    r.onerror = () => reject(r.error);
  });
  db.close();
  const handle = rec?.handle;
  if (!handle) return null;
  if (handle.requestPermission) {
    const perm = await handle.requestPermission({ mode: 'read' });
    if (perm !== 'granted') return null;
  }
  const file = await handle.getFile();
  const c = deserializeContainer(new Uint8Array(await file.arrayBuffer()));
  ingestAssets(c.assets);
  const project = c.project;
  fileHandle = handle;
  filePath = null;
  void rememberRecent(handle);
  return project;
}
