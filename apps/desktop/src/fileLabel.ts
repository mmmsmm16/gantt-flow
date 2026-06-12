// ファイル名まわりの表示文字列（ウィンドウタイトル / 最近使ったファイルの最終使用日）。
// React 非依存の純粋関数に分離してテスト可能にする。

/** 保存先が未割当（新規 / サンプル / テンプレート / 取り込み直後）のときの表示名。 */
export const UNTITLED_LABEL = '未保存のプロジェクト';

/** document.title 用。「ファイル名● - gantt-flow」（● は未保存の変更あり）。 */
export function formatWindowTitle(fileName: string | null, dirty: boolean): string {
  return `${fileName ?? UNTITLED_LABEL}${dirty ? '●' : ''} - gantt-flow`;
}

/** 最近使ったファイルの最終使用日。メニューの 1 行に収まる短さを優先し、
    近いものほど細かく（当日=時刻 / 昨日 / 同年=月日 / それ以前=年月日）。 */
export function formatRecentTime(at: number, now: Date = new Date()): string {
  const d = new Date(at);
  const sameDate = (a: Date, b: Date) =>
    a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  if (sameDate(d, now)) {
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }
  // 月初・年初をまたぐ「昨日」も Date のオーバーフロー解決で正しく判定される。
  if (sameDate(d, new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1))) return '昨日';
  if (d.getFullYear() === now.getFullYear()) return `${d.getMonth() + 1}/${d.getDate()}`;
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
}
