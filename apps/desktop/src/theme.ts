// 配色の単一の真実（ライト＝出力パレット）。
// ライト/ダークの「ライト側」かつ「画像出力」が参照する正準値をここに集約する。
//   - SVG 画像出力（flowSvg.ts）は共有/印刷前提で常にライト。
//   - styles.css の :root（ライト値）はこの値に合わせる（同期はコメントで明示）。
// ダークテーマは出力に乗らないため CSS（[data-theme="dark"]）のみに存在する。

import type { TaskColor } from '@gantt-flow/core';

// 工程カラー(8色プリセット)の正準値(ライト)。base=濃枠・ドット / fill=淡背景 / text=文字色。
// 画面(styles.css の CSS 変数注入)と SVG/PNG/印刷出力(flowSvg.ts)の両方がこれを参照する。
// ダークテーマの見え方は styles.css 側で color-mix により導出する(ここにダーク値は持たない)。
export const TASK_COLORS: Record<TaskColor, { base: string; fill: string; text: string }> = {
  red: { base: '#dc2626', fill: '#fee2e2', text: '#b91c1c' },
  orange: { base: '#ea580c', fill: '#ffedd5', text: '#c2410c' },
  yellow: { base: '#ca8a04', fill: '#fef9c3', text: '#a16207' },
  green: { base: '#16a34a', fill: '#dcfce7', text: '#15803d' },
  teal: { base: '#0d9488', fill: '#ccfbf1', text: '#0f766e' },
  blue: { base: '#2563eb', fill: '#dbeafe', text: '#1d4ed8' },
  purple: { base: '#9333ea', fill: '#f3e8ff', text: '#7e22ce' },
  gray: { base: '#6b7280', fill: '#f3f4f6', text: '#4b5563' },
};

export const TASK_COLOR_LABELS: Record<TaskColor, string> = {
  red: '赤',
  orange: 'オレンジ',
  yellow: '黄',
  green: '緑',
  teal: '青緑',
  blue: '青',
  purple: '紫',
  gray: 'グレー',
};

/** UI/コマンドで使う表示順。 */
export const TASK_COLOR_KEYS: TaskColor[] = ['red', 'orange', 'yellow', 'green', 'teal', 'blue', 'purple', 'gray'];

export const FLOW_LIGHT = {
  bg: '#ffffff',
  arrow: '#64748b',
  edge: '#94a3b8',
  edgeLabel: '#64748b',
  issueLine: '#cbd5e1',
  band: '#cbd5e1',
  bandLabel: '#64748b',
  laneColBg: '#f8fafc',
  laneStripe: 'rgba(2,6,23,0.04)',
  laneLine: '#e2e8f0',
  laneDivider: '#cbd5e1',
  laneTitle: '#1e293b',
  task: { fill: '#ffffff', stroke: '#94a3b8', text: '#1e293b' },
  ioIn: { fill: '#d6efee', stroke: '#0e8a8a' },
  ioOut: { fill: '#fbe3ca', stroke: '#c2540b' },
  issue: { fill: '#fee2e2', stroke: '#dc2626' },
  comment: { fill: '#fef9c3', stroke: '#ca8a04', text: '#854d0e' },
  control: { fill: '#ffffff', stroke: '#94a3b8', text: '#64748b' },
  // マイルストーン（琥珀の菱形＋縦破線＋ラベル）。styles.css の --amber 系（ライト値）と同期。
  ms: { fill: '#f6ecc6', stroke: '#b9820a', text: '#7a5407' },
} as const;
