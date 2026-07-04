// 表示専用ミラー窓の共有ロジック（マルチディスプレイ対応）。
// 主窓（編集画面）が現在の表示状態（project スナップショット＋ビュー設定）を
// BroadcastChannel('gf-mirror') に発行し、別ウィンドウ（?mirror=flow|table）の
// 閲覧専用ミラーが受信して描画する。編集は主窓のみ・ミラーは read-only。
//
// なぜ SVG/HTML 文字列で描くか（FlowCanvas 再利用ではなく）:
//  - FlowCanvas/TableView は useApp シングルトンと双方向に密結合した「編集用」UI。
//    ミラーは別ウィンドウ＝別モジュールインスタンスで、閲覧専用（操作 UI 無し）が要件。
//  - buildFlowSvg / projectToRows は core の純粋関数で、受信スナップショットだけで
//    決定論的に描ける＝ミラーには最も堅牢（手動配置の x/y もそのまま保持される）。
//
// Tauri ネイティブの多窓（WebviewWindow）は capability 追加が必要なため現状は TODO。
// まずは同一オリジンの window.open + BroadcastChannel（ブラウザ）で実装する。
import type { Project, ProcessLevel } from '@gantt-flow/core';

/** 同一オリジン内でミラー窓と主窓をつなぐチャネル名。 */
export const MIRROR_CHANNEL = 'gf-mirror';

/** ミラーが表示する対象。 */
export type MirrorKind = 'flow' | 'table';

/** 主窓が発行する「いま表示している状態」。project は不変スナップショット。 */
export interface MirrorState {
  project: Project;
  level: ProcessLevel;
  scopeParentId?: string;
  showIssues: boolean;
}

/** チャネル上を流れるメッセージ。 */
export type MirrorMessage =
  | { type: 'state'; state: MirrorState } // 主窓 → ミラー（現在状態）
  | { type: 'hello' } // ミラー → 主窓（接続時に現在状態を要求）
  | { type: 'bye' }; // 主窓 → ミラー（主窓が閉じる＝接続待ちへ）

const hasBroadcastChannel = (): boolean => typeof BroadcastChannel !== 'undefined';

/** URL の ?mirror=flow|table を解釈。未指定/不正は null（＝通常アプリとして起動）。 */
export function parseMirrorParam(search: string): MirrorKind | null {
  const v = new URLSearchParams(search).get('mirror');
  return v === 'flow' || v === 'table' ? v : null;
}

/** アプリ状態からミラーへ送る最小の状態を切り出す（発行対象のフィールドを一元化）。 */
export function pickMirrorState(s: {
  project: Project;
  level: ProcessLevel;
  scopeParentId?: string;
  showIssues: boolean;
}): MirrorState {
  return {
    project: s.project,
    level: s.level,
    scopeParentId: s.scopeParentId,
    showIssues: s.showIssues,
  };
}

/** 発行済み状態 a から b で実質的に表示が変わるか。project は不変更新なので参照比較で足りる
 *（選択やホバー等、ミラーに関係ない store 変化では再発行しない）。 */
export function mirrorStateChanged(a: MirrorState | null, b: MirrorState): boolean {
  if (!a) return true;
  return (
    a.project !== b.project ||
    a.level !== b.level ||
    (a.scopeParentId ?? undefined) !== (b.scopeParentId ?? undefined) ||
    a.showIssues !== b.showIssues
  );
}

/** テスト差し替え可能な最小チャネル IF（BroadcastChannel を薄く包む）。 */
export interface MirrorChannel {
  postMessage(msg: MirrorMessage): void;
  onmessage: ((msg: MirrorMessage) => void) | null;
  close(): void;
}

/** 実 BroadcastChannel を MirrorChannel として開く（非対応環境では null）。 */
export function openMirrorChannel(): MirrorChannel | null {
  if (!hasBroadcastChannel()) return null;
  const ch = new BroadcastChannel(MIRROR_CHANNEL);
  const wrap: MirrorChannel = {
    postMessage: (m) => ch.postMessage(m),
    onmessage: null,
    close: () => ch.close(),
  };
  ch.onmessage = (e: MessageEvent) => wrap.onmessage?.(e.data as MirrorMessage);
  return wrap;
}

/** 主窓が購読する store の抽象（テストで store と分離するため）。 */
export interface MirrorSource {
  subscribe(listener: () => void): () => void;
  getState(): MirrorState;
}

export interface PublisherOptions {
  /** 連続編集を束ねる猶予（既定 100ms）。 */
  debounceMs?: number;
  /** テスト用のチャネル注入。省略時は実 BroadcastChannel。 */
  channel?: MirrorChannel;
}

/**
 * 主窓側の発行を開始する。store の変化を購読し、ミラーに関係する状態が変わったときだけ
 * デバウンスして {type:'state'} を流す。ミラーの {type:'hello'} には即応答し、
 * ページ離脱（pagehide）で {type:'bye'} を送る（ミラー側は接続待ち表示へ）。
 * 返り値のクリーンアップで購読解除＋チャネルを閉じる。
 */
export function startMirrorPublisher(source: MirrorSource, opts: PublisherOptions = {}): () => void {
  const ch = opts.channel ?? openMirrorChannel();
  if (!ch) return () => {}; // BroadcastChannel 非対応: ミラー無効（主窓は通常どおり動く）
  const debounceMs = opts.debounceMs ?? 100;
  let last: MirrorState | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const publishNow = () => {
    if (timer) {
      clearTimeout(timer);
      timer = undefined;
    }
    const s = source.getState();
    last = s;
    ch.postMessage({ type: 'state', state: s });
  };
  const schedule = () => {
    if (!mirrorStateChanged(last, source.getState())) return; // 無関係な変化は無視
    if (timer) clearTimeout(timer);
    timer = setTimeout(publishNow, debounceMs);
  };

  ch.onmessage = (msg) => {
    if (msg?.type === 'hello') publishNow(); // 新しいミラー接続に現在状態で即応答
  };
  const unsub = source.subscribe(schedule);

  // 主窓が閉じる/離脱するときにミラーへ通知（接続待ち表示へ）。
  const onHide = () => ch.postMessage({ type: 'bye' });
  const wired = typeof window !== 'undefined';
  if (wired) window.addEventListener('pagehide', onHide);

  return () => {
    if (timer) clearTimeout(timer);
    unsub();
    if (wired) window.removeEventListener('pagehide', onHide);
    ch.close();
  };
}

/** ミラー側の受信を購読する。接続時に {type:'hello'} を送って現在状態を要求する。 */
export function subscribeMirror(handlers: {
  onState: (s: MirrorState) => void;
  onBye: () => void;
}): () => void {
  const ch = openMirrorChannel();
  if (!ch) return () => {};
  ch.onmessage = (msg) => {
    if (msg?.type === 'state') handlers.onState(msg.state);
    else if (msg?.type === 'bye') handlers.onBye();
  };
  ch.postMessage({ type: 'hello' });
  return () => ch.close();
}

/**
 * ミラー窓を開く（同一オリジンの別ウィンドウ）。名前付きターゲットなので、既に開いている
 * 同種のミラーがあれば新規に増やさず前面化する。
 * TODO(tauri): Tauri 配下では WebviewWindow でネイティブ窓を開きたい（capability に
 *   webview 生成権限の最小追加が必要）。現状は window.open にフォールバック。
 */
export function openMirrorWindow(kind: MirrorKind): Window | null {
  if (typeof window === 'undefined') return null;
  const url = `${window.location.pathname}?mirror=${kind}`;
  return window.open(url, `gf-mirror-${kind}`, 'width=1200,height=800');
}
