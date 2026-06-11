// 世代バックアップ。保存のたびに直近 N 世代を localStorage に残し、「昨日の状態に戻す」を
// 可能にする（共有フォルダ運用での誤上書き・誤編集への保険）。autosave（未保存の退避）とは別系統。
import { serializeProject, deserializeProject, type Project } from '@gantt-flow/core';

const KEY = 'gf-backups-v1';
const MAX_GENERATIONS = 5;

export interface BackupEntry {
  at: string; // ISO 日時
  title: string;
  taskCount: number;
  json: string;
}

function readAll(): BackupEntry[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw) as BackupEntry[];
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

function writeAll(entries: BackupEntry[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(entries));
  } catch {
    // 容量超過: 古い世代を削って再試行（それでも無理なら諦める＝ベストエフォート）
    try {
      localStorage.setItem(KEY, JSON.stringify(entries.slice(0, 2)));
    } catch {
      /* 退避不能は無視 */
    }
  }
}

/** 保存成功時に呼ぶ。直前の世代と内容が同じならスキップ。新しい順に MAX 世代まで保持。 */
export function pushBackup(project: Project): void {
  const json = serializeProject(project);
  const all = readAll();
  if (all[0]?.json === json) return; // 変化なし
  const entry: BackupEntry = {
    at: new Date().toISOString(),
    title: project.meta.title || '（無題）',
    taskCount: Object.keys(project.core.tasks).length,
    json,
  };
  writeAll([entry, ...all].slice(0, MAX_GENERATIONS));
}

/** 一覧（新しい順）。json は重いので含めず、復元時に index で引く。 */
export function listBackups(): { at: string; title: string; taskCount: number }[] {
  return readAll().map(({ at, title, taskCount }) => ({ at, title, taskCount }));
}

/** index 番目（新しい順）の世代を Project に復元する。壊れていれば null。 */
export function restoreBackup(index: number): Project | null {
  const e = readAll()[index];
  if (!e) return null;
  try {
    // 復旧経路は lenient: 参照整合性が少し壊れていても救出を優先する（読込拒否で黙って捨てない）。
    return deserializeProject(e.json, { integrity: 'lenient' });
  } catch {
    return null;
  }
}
