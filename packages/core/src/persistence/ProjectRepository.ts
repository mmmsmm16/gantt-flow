// 永続化の境界 IF（`docs/05-persistence.md` §3・§5）。実装は Tauri(Rust)側。ここは型のみ。
// LockInfo / AcquireResult は Rust 側（crates/fsstore, serde rename_all = "camelCase"）の
// ワイヤ形式と完全一致させる。時刻は epoch ms の number。
import type { Project } from '../model/types';

export interface LoadReport {
  migratedFrom?: number; // マイグレーション前の schemaVersion
  quarantined: number; // 退避した壊れた参照の数
}

// 助言ロックの中身（`docs/05-persistence.md` §3）。`<file>.lock` に保存される JSON と同形。
export interface LockInfo {
  user: string;
  host: string;
  sessionId: string;
  openedAt: number; // epoch ms
  heartbeatAt: number; // epoch ms（保持側が定期更新）
  appVersion: string;
}

// invoke('acquire_lock') の戻り値そのまま（{ ok: true } | { ok: false, held, stale }）。
export type AcquireResult =
  | { ok: true }
  | { ok: false; held: LockInfo; stale: boolean };

export interface ProjectRepository {
  open(path: string): Promise<{ project: Project; report: LoadReport }>;
  save(path: string, project: Project): Promise<void>; // アトミック書き込み
  statUpdatedAt(path: string): Promise<string | null>; // 競合検知用（epoch ms の文字列）
  writeAutosave(path: string, project: Project, owner: LockInfo): Promise<void>;

  // --- 同時編集（助言ロック） ---
  // staleAfterMs: heartbeatAt がこれより古いロックを stale（引き継ぎ候補）とみなすしきい値。
  // 実装は invoke('acquire_lock', { path, owner, staleAfterMs, nowMs: Date.now() }) を呼ぶ。
  acquireLock(path: string, owner: LockInfo, staleAfterMs: number): Promise<AcquireResult>;
  // stale ロックの引き継ぎ。expected には確認時に読んだロック（acquire の held）を渡す。
  // 内容が変わっていた（先に他セッションが引き継いだ等）場合は false。
  stealLock(path: string, owner: LockInfo, expected?: LockInfo): Promise<boolean>;
  refreshLock(path: string, owner: LockInfo): Promise<void>; // ハートビート
  releaseLock(path: string, owner: LockInfo): Promise<void>;
  readLock(path: string): Promise<LockInfo | null>;
}
