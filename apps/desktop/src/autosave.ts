// クラッシュ/誤って閉じた時の自動復旧。未保存(dirty)の変更を localStorage にデバウンス保存し、
// 起動時に未保存データが残っていれば復元を提案する。
// キーはプロジェクト ID（meta.id）ごとに分ける: 別タブで別プロジェクトを保存しても、
// このタブの復旧データが消されない（dirty 解消時はそのプロジェクトの分だけ消す）。
import { serializeProject, deserializeProject, type Project } from '@gantt-flow/core';
import { useApp } from './store';

const PREFIX = 'gf-autosave-v1:'; // プロジェクト ID ごとのエントリ
const LEGACY_KEY = 'gf-autosave-v1'; // 旧形式（単一キー・生 JSON）。読み取りのみ対応
const MAX_ENTRIES = 5; // 復旧エントリの上限（古いものから削除）
const DEBOUNCE_MS = 1000;
let timer: ReturnType<typeof setTimeout> | undefined;

interface Entry {
  at: number; // 退避時刻（epoch ms）
  json: string; // serializeProject の結果
}

const keyFor = (p: Project): string => PREFIX + p.meta.id;

function listKeys(): string[] {
  const keys: string[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k && (k === LEGACY_KEY || k.startsWith(PREFIX))) keys.push(k);
  }
  return keys;
}

function readEntry(key: string): Entry | null {
  const raw = localStorage.getItem(key);
  if (!raw) return null;
  if (key === LEGACY_KEY) return { at: 0, json: raw };
  try {
    const e = JSON.parse(raw) as Partial<Entry>;
    return typeof e.json === 'string' ? { at: typeof e.at === 'number' ? e.at : 0, json: e.json } : null;
  } catch {
    return null;
  }
}

// 復元を提案したエントリのキー。clearAutosave()（引数なし）はこれを消す。
let offeredKey: string | null = null;

function newestEntry(): { key: string; at: number; project: Project } | null {
  let best: { key: string; at: number; project: Project } | null = null;
  for (const key of listKeys()) {
    const e = readEntry(key);
    if (!e) continue;
    try {
      const p = deserializeProject(e.json);
      // 工程が 1 件も無いものは復元対象にしない（実質空）。
      if (Object.keys(p.core.tasks).length === 0) continue;
      if (!best || e.at > best.at) best = { key, at: e.at, project: p };
    } catch {
      /* 壊れたエントリは無視 */
    }
  }
  return best;
}

/** 最新の復旧データを 1 件返す（複数プロジェクト分あれば退避時刻が最も新しいもの）。 */
export function loadAutosave(): Project | null {
  try {
    const found = newestEntry();
    if (!found) return null;
    offeredKey = found.key;
    return found.project;
  } catch {
    return null;
  }
}

// 起動時の復元提案は 1 セッション 1 回だけ（React StrictMode の二重実行などで重複させない）。
let restoreConsumed = false;
export function takeAutosaveForRestore(): Project | null {
  if (restoreConsumed) return null;
  restoreConsumed = true;
  return loadAutosave();
}

/**
 * 復旧データを消す。project を渡すとそのプロジェクトの分だけ、省略時は直近に復元提案した
 * エントリだけを消す（他のタブ/プロジェクトの復旧データには触れない）。
 */
export function clearAutosave(project?: Project): void {
  if (timer) clearTimeout(timer);
  try {
    if (project) {
      localStorage.removeItem(keyFor(project));
    } else if (offeredKey) {
      localStorage.removeItem(offeredKey);
      offeredKey = null;
    }
  } catch {
    /* localStorage 不可は無視 */
  }
}

// エントリの増えすぎ防止: 新しい順に MAX_ENTRIES 件だけ残す（書いたばかりの keep は常に残す）。
function prune(keep: string): void {
  const entries = listKeys()
    .map((key) => ({ key, at: key === keep ? Infinity : readEntry(key)?.at ?? -1 }))
    .sort((a, b) => b.at - a.at);
  for (const e of entries.slice(MAX_ENTRIES)) localStorage.removeItem(e.key);
}

function write(p: Project): void {
  try {
    localStorage.setItem(keyFor(p), JSON.stringify({ at: Date.now(), json: serializeProject(p) } satisfies Entry));
    prune(keyFor(p));
  } catch {
    /* 容量超過/不可は無視（自動復旧はベストエフォート） */
  }
}

// dirty な変更をデバウンス保存。dirty→clean（保存/開く/新規）になったら、
// clean になったプロジェクトの復旧データを消す。
export function initAutosave(): void {
  let wasDirty = useApp.getState().dirty;
  useApp.subscribe((state) => {
    if (state.dirty) {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => write(useApp.getState().project), DEBOUNCE_MS);
    } else if (wasDirty) {
      clearAutosave(state.project); // 未保存が解消されたのはこのプロジェクト → その分だけ消す
    }
    wasDirty = state.dirty;
  });
}
