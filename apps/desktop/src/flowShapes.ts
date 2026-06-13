// フロー I/O チップの形状パス。画面(FlowCanvas)と出力(flowSvg)で共有し、WYSIWYG を保つ。
// 帳票(doc) は各描画側で「下辺が波打つ書類形」を生成。ここでは情報(info)の形を定義する。
//
// 情報(info)= claude design の I/O チップ準拠（DESIGN §8）。
//   3 つの角は角丸・1 つの角だけ立てた角丸ボックス。立てる角はノード側を向ける:
//   入力チップ＝左下を立てる / 出力チップ＝左上を立てる。色に依存せず形で種類を示す。

export interface ChipRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export function ioInfoChipPath(r: ChipRect, io: 'input' | 'output'): string {
  // claude design のチップと同等の丸み。半径はチップ高に比例（約 4 割）させ、
  // 背の高いチップでもしっかり丸く見せる。幅の半分でクランプして潰れを防ぐ。
  const rad = Math.min(Math.round(r.h * 0.42), Math.floor(r.w / 2));
  // 立てる（角丸にしない）コーナー。入力=左下 / 出力=左上。
  const cTL = io === 'output' ? 0 : rad;
  const cTR = rad;
  const cBR = rad;
  const cBL = io === 'input' ? 0 : rad;
  const right = r.x + r.w;
  const bottom = r.y + r.h;
  return [
    `M${r.x + cTL},${r.y}`,
    `L${right - cTR},${r.y}`,
    cTR ? `Q${right},${r.y} ${right},${r.y + cTR}` : '',
    `L${right},${bottom - cBR}`,
    cBR ? `Q${right},${bottom} ${right - cBR},${bottom}` : '',
    `L${r.x + cBL},${bottom}`,
    cBL ? `Q${r.x},${bottom} ${r.x},${bottom - cBL}` : '',
    `L${r.x},${r.y + cTL}`,
    cTL ? `Q${r.x},${r.y} ${r.x + cTL},${r.y}` : '',
    'Z',
  ]
    .filter(Boolean)
    .join(' ');
}

// 帳票(doc)= 書類オブジェクト（DESIGN §8）。角丸（小）の矩形本体＋右上のドッグイア（折り返し三角）。
// 本体とドッグイアの 2 要素で描く（本体=塗り+枠、ドッグイア=塗りのみ＝枠色）。色非依存・白黒可読。
export function ioDocBodyPath(r: ChipRect): string {
  const rad = 3;
  const right = r.x + r.w;
  const bottom = r.y + r.h;
  return [
    `M${r.x + rad},${r.y}`,
    `L${right - rad},${r.y}`,
    `Q${right},${r.y} ${right},${r.y + rad}`,
    `L${right},${bottom - rad}`,
    `Q${right},${bottom} ${right - rad},${bottom}`,
    `L${r.x + rad},${bottom}`,
    `Q${r.x},${bottom} ${r.x},${bottom - rad}`,
    `L${r.x},${r.y + rad}`,
    `Q${r.x},${r.y} ${r.x + rad},${r.y}`,
    'Z',
  ].join(' ');
}

// ドッグイア（右上の折り返し三角）の頂点。塗りつぶしてページの折れ角を表す。
export function ioDocFoldPoints(r: ChipRect): string {
  const fold = Math.min(8, Math.round(r.h * 0.35));
  const right = r.x + r.w;
  return `${right - fold},${r.y} ${right},${r.y} ${right},${r.y + fold}`;
}
