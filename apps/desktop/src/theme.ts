// 配色の単一の真実（ライト＝出力パレット）。
// ライト/ダークの「ライト側」かつ「画像出力」が参照する正準値をここに集約する。
//   - SVG 画像出力（flowSvg.ts）は共有/印刷前提で常にライト。
//   - styles.css の :root（ライト値）はこの値に合わせる（同期はコメントで明示）。
// ダークテーマは出力に乗らないため CSS（[data-theme="dark"]）のみに存在する。

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
} as const;
