// Undo/Redo の核（`docs/01-architecture.md` §6）。方式はスナップショット: 状態リスト＋カーソル。
// 汎用ユーティリティ（T はふつう Project）。ストア層(Zustand)がこれを薄く包む。UI 非依存でテスト可能。

export interface HistoryOptions {
  limit?: number; // 保持する最大エントリ数（超過は古い方から破棄）。既定 100。
}

export interface History<T> {
  current(): T;
  push(state: T): void; // 新規エントリ。redo 側は破棄される。
  replaceTop(state: T): void; // 直近エントリを置換（連続ジェスチャ等のコアレッシング）。
  undo(): T | undefined; // 1 つ戻す。戻れなければ undefined。
  redo(): T | undefined; // 1 つ進める。進めなければ undefined。
  reset(state: T): void; // 履歴を破棄し、与えた状態のみにする（ファイルを開く/新規時）。
  canUndo(): boolean;
  canRedo(): boolean;
  size(): number;
}

export function createHistory<T>(initial: T, opts: HistoryOptions = {}): History<T> {
  const limit = Math.max(1, opts.limit ?? 100);
  let stack: T[] = [initial];
  let cursor = 0;

  return {
    current: () => stack[cursor]!,

    push(state: T) {
      // 現在位置より後ろ（redo 分）を捨ててから積む
      stack = stack.slice(0, cursor + 1);
      stack.push(state);
      cursor = stack.length - 1;
      // 上限を超えたら古い方から破棄
      if (stack.length > limit) {
        const over = stack.length - limit;
        stack = stack.slice(over);
        cursor -= over;
      }
    },

    replaceTop(state: T) {
      stack[cursor] = state;
    },

    undo() {
      if (cursor === 0) return undefined;
      cursor -= 1;
      return stack[cursor]!;
    },

    redo() {
      if (cursor >= stack.length - 1) return undefined;
      cursor += 1;
      return stack[cursor]!;
    },

    reset(state: T) {
      stack = [state];
      cursor = 0;
    },

    canUndo: () => cursor > 0,
    canRedo: () => cursor < stack.length - 1,
    size: () => stack.length,
  };
}
