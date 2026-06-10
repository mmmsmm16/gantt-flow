// クラッシュ/誤って閉じた時の自動復旧。未保存(dirty)の変更を localStorage にデバウンス保存し、
// 起動時に未保存データが残っていれば復元を提案する。ファイル保存/新規/開く で復旧データは消す。
import { serializeProject, deserializeProject, type Project } from '@gantt-flow/core';
import { useApp } from './store';

const KEY = 'gf-autosave-v1';
const DEBOUNCE_MS = 1000;
let timer: ReturnType<typeof setTimeout> | undefined;

export function loadAutosave(): Project | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const p = deserializeProject(raw);
    // 工程が 1 件も無いものは復元対象にしない（実質空）。
    return Object.keys(p.core.tasks).length > 0 ? p : null;
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

export function clearAutosave(): void {
  if (timer) clearTimeout(timer);
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* localStorage 不可は無視 */
  }
}

function write(p: Project): void {
  try {
    localStorage.setItem(KEY, serializeProject(p));
  } catch {
    /* 容量超過/不可は無視（自動復旧はベストエフォート） */
  }
}

// dirty な変更をデバウンス保存。dirty→clean（保存/開く/新規）になったら復旧データを消す。
export function initAutosave(): void {
  let wasDirty = useApp.getState().dirty;
  useApp.subscribe((state) => {
    if (state.dirty) {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => write(useApp.getState().project), DEBOUNCE_MS);
    } else if (wasDirty) {
      clearAutosave(); // 保存・新規・開く 等で未保存が解消 → 復旧データ不要
    }
    wasDirty = state.dirty;
  });
}
