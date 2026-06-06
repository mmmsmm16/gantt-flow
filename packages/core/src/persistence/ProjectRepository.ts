// 永続化の境界 IF（`docs/05-persistence.md` §3・§5）。実装は Tauri(Rust)側。ここは型のみ。
import type { Project } from '../model/types';

export interface LoadReport {
  migratedFrom?: number; // マイグレーション前の schemaVersion
  quarantined: number; // 退避した壊れた参照の数
}

// 助言ロックの中身（`docs/05-persistence.md` §3）。
export interface LockInfo {
  user: string;
  host: string;
  sessionId: string;
  openedAt: string;
  heartbeatAt: string;
  appVersion: string;
}

export type AcquireResult =
  | { ok: true }
  | { ok: false; held: LockInfo; stale: boolean };

export interface ProjectRepository {
  open(path: string): Promise<{ project: Project; report: LoadReport }>;
  save(path: string, project: Project): Promise<void>; // アトミック書き込み
  statUpdatedAt(path: string): Promise<string | null>; // 競合検知用
  writeAutosave(path: string, project: Project, owner: LockInfo): Promise<void>;

  // --- 同時編集（助言ロック） ---
  acquireLock(path: string, owner: LockInfo): Promise<AcquireResult>;
  refreshLock(path: string, owner: LockInfo): Promise<void>; // ハートビート
  releaseLock(path: string, owner: LockInfo): Promise<void>;
  readLock(path: string): Promise<LockInfo | null>;
}
