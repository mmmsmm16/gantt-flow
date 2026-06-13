// 現在のフロービューを SVG 文字列に書き出す（画像出力。依存ライブラリ不要）。
// 配色は theme.ts の FLOW_LIGHT を単一の真実とする（出力は共有/印刷前提で常にライト）。
import {
  SIZE,
  deriveBands,
  ioIconRect,
  IO_ICON,
  issueLineTarget,
  issuePrimaryIds,
  laneLayout,
  nodeSize,
  routeEdge,
  sourceChipLayout,
  type Project,
  type FlowLevelView,
  type FlowNode,
  type Rect,
} from '@gantt-flow/core';
import { FLOW_LIGHT, TASK_COLORS } from './theme';
import { ioInfoChipPath } from './flowShapes';

// 画面の --font-ui と揃える（WYSIWYG・DESIGN §8）。欧文 Inter / 和文 Meiryo UI → OS。
// styles.css と同期。出力 SVG は font-family を埋め込まないため、Inter 未導入の第三者
// 環境では従来どおり次の家系へフォールバックする（見え方は据え置き、作図者の手元では一致）。
const FONT_STACK =
  "'Inter', 'Meiryo UI', system-ui, -apple-system, 'Hiragino Kaku Gothic ProN', 'Yu Gothic UI', 'Noto Sans JP', Meiryo, sans-serif";

const esc = (s: string) =>
  s.replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[c]!);

export function buildFlowSvg(project: Project, view: FlowLevelView): string {
  const nodes = Object.values(view.nodes);

  // レーン幾何（可変高さ）。担当レーンが無いビューはスイムレーンを描かない。
  const BAND_TOP = 24;
  const LABEL_W = 96;
  const boxes = laneLayout(view.lanes);
  const hasLanes = boxes.length > 0;
  const laneBottom = hasLanes ? boxes[boxes.length - 1]!.top + boxes[boxes.length - 1]!.height : BAND_TOP;

  // 図の範囲。入力 I/O アイコンや出所チップは工程の左上・真上へはみ出すため、
  // 正方向(max)だけでなく負方向(min)へも広げる（viewBox を 0,0 に固定すると切れる）。
  let minX = 0;
  let minY = 0;
  let maxX = 600;
  let maxY = 300;
  const grow = (r: Rect) => {
    minX = Math.min(minX, r.x);
    minY = Math.min(minY, r.y);
    maxX = Math.max(maxX, r.x + r.w + 60);
    maxY = Math.max(maxY, r.y + r.h + 60);
  };
  for (const n of nodes) {
    if (n.kind === 'doc') continue; // I/O はタスクへ集約表示（下で算入）
    grow({ x: n.x, y: n.y, ...nodeSize(n) });
    if (n.kind === 'task') {
      const d = project.details[n.taskId];
      const inputs = d?.inputs ?? [];
      const plain = inputs.filter((it) => !it.source?.trim()).length;
      if (plain) grow(ioIconRect(n, 'input', plain));
      const outs = d?.outputs?.length ?? 0;
      if (outs) grow(ioIconRect(n, 'output', outs));
      inputs
        .filter((it) => it.source?.trim())
        .forEach((it, i) => grow(sourceChipLayout(n, it.source ?? '', i, boxes)));
    }
  }
  if (hasLanes) maxY = Math.max(maxY, laneBottom + 40);
  // 負側にはみ出した分は少し余白を足す（はみ出しが無ければ従来どおり原点 0,0）。
  if (minX < 0) minX -= 12;
  if (minY < 0) minY -= 12;
  const width = maxX - minX;
  const height = maxY - minY;

  const parts: string[] = [];
  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="${minX} ${minY} ${width} ${height}" font-family="${FONT_STACK}">`,
  );
  parts.push(`<rect x="${minX}" y="${minY}" width="100%" height="100%" fill="${FLOW_LIGHT.bg}"/>`);
  parts.push(
    `<defs><marker id="a" markerWidth="9" markerHeight="9" refX="7.5" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 z" fill="${FLOW_LIGHT.arrow}"/></marker></defs>`,
  );

  // bands（メンバー工程の範囲に収め、深いほど太線で外側を包む）
  for (const b of deriveBands(project.core, view)) {
    const sw = b.level === 'large' ? 1.6 : 1;
    const dash = b.level === 'large' ? '10 5' : '6 4';
    parts.push(
      `<rect x="${b.x}" y="${b.top}" width="${b.width}" height="${b.height}" rx="12" fill="none" stroke="${FLOW_LIGHT.band}" stroke-width="${sw}" stroke-dasharray="${dash}"/>`,
    );
    const label = (b.level === 'large' ? '大' : b.level === 'medium' ? '中' : '小') + ': ' + b.label;
    parts.push(
      `<text x="${b.x + 6}" y="${b.top + 14}" font-size="11" fill="${FLOW_LIGHT.bandLabel}">${esc(label)}</text>`,
    );
  }

  // swimlanes: 左ラベル列 + 可変高さの水平区切り（並行工程で太く / 手動リサイズを保持）。
  // 担当レーンが無いビューでは描かない（「担当者名の無いレーン」を出さない）。
  if (hasLanes) {
    parts.push(
      `<rect x="0" y="${BAND_TOP}" width="${LABEL_W}" height="${laneBottom - BAND_TOP}" fill="${FLOW_LIGHT.laneColBg}"/>`,
    );
    boxes.forEach((box, i) => {
      if (i % 2 === 1)
        parts.push(
          `<rect x="${LABEL_W}" y="${box.top}" width="${maxX}" height="${box.height}" fill="${FLOW_LIGHT.laneStripe}"/>`,
        );
      parts.push(
        `<line x1="0" y1="${box.top}" x2="${maxX}" y2="${box.top}" stroke="${FLOW_LIGHT.laneLine}" stroke-width="1.2"/>`,
      );
    });
    parts.push(
      `<line x1="0" y1="${laneBottom}" x2="${maxX}" y2="${laneBottom}" stroke="${FLOW_LIGHT.laneLine}" stroke-width="1.2"/>`,
    );
    parts.push(
      `<line x1="${LABEL_W}" y1="${BAND_TOP}" x2="${LABEL_W}" y2="${laneBottom}" stroke="${FLOW_LIGHT.laneDivider}" stroke-width="1.4"/>`,
    );
    for (const box of boxes) {
      // レーンの帯の中央に担当名（画面と揃える）。
      parts.push(
        `<text x="${LABEL_W / 2}" y="${box.top + box.height / 2 + 4}" font-size="12" font-weight="600" fill="${FLOW_LIGHT.laneTitle}" text-anchor="middle">${esc(box.lane.title)}</text>`,
      );
    }
  }

  // edges: 直角コネクタ。他ノードと重ならない通り道を routeEdge が選ぶ(画面と同一ロジック)。
  const edgeObstacles = nodes
    .filter((n) => n.kind === 'task' || n.kind === 'control' || n.kind === 'comment')
    .map((n) => ({ id: n.id, x: n.x, y: n.y, w: nodeSize(n).w, h: nodeSize(n).h }));
  for (const e of Object.values(view.edges)) {
    const s = view.nodes[e.source];
    const t = view.nodes[e.target];
    if (!s || !t) continue;
    const ss = nodeSize(s);
    const ts = nodeSize(t);
    const route = routeEdge(
      { x: s.x, y: s.y, w: ss.w, h: ss.h },
      { x: t.x, y: t.y, w: ts.w, h: ts.h },
      edgeObstacles.filter((o) => o.id !== e.source && o.id !== e.target),
    );
    parts.push(
      `<path d="${route.d}" fill="none" stroke="${FLOW_LIGHT.edge}" stroke-width="1.8" marker-end="url(#a)"/>`,
    );
    if (e.label) {
      parts.push(
        `<text x="${route.label.x}" y="${route.label.y - 4}" font-size="11" fill="${FLOW_LIGHT.edgeLabel}" text-anchor="middle">${esc(e.label)}</text>`,
      );
    }
  }

  // 課題は工程ごとに1枚へ集約（代表ノードのみ描画。選定規則は画面 FlowCanvas と共有）。
  const issuePrimaryId = issuePrimaryIds(nodes, project.details);
  const isPrimaryIssue = (n: FlowNode) => n.kind === 'issue' && issuePrimaryId.get(n.taskId) === n.id;
  const issueTextsOf = (taskId: string): string[] =>
    (project.details[taskId]?.issues ?? []).map((i) => i.issue).filter((t) => t.trim().length > 0);
  const truncate = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

  // issue lines（代表のみ。終点の規則は画面と共有: issueLineTarget）
  for (const n of nodes) {
    if (n.kind !== 'issue' || !isPrimaryIssue(n)) continue;
    const t = view.nodes[n.targetNodeId];
    if (!t) continue;
    const c = issueLineTarget(t, nodes, project.details);
    parts.push(
      `<line x1="${n.x + SIZE.issue.w / 2}" y1="${n.y + SIZE.issue.h / 2}" x2="${c.x}" y2="${c.y}" stroke="${FLOW_LIGHT.issueLine}" stroke-width="1"/>`,
    );
  }

  // nodes
  for (const n of nodes) {
    const s = nodeSize(n);
    const cx = n.x + s.w / 2;
    if (n.kind === 'task') {
      const name = project.core.tasks[n.taskId]?.name ?? '';
      // 工程カラー(任意)。塗りは淡背景+濃枠、文字色は text を使用(未設定は既定)。
      const d = project.details[n.taskId];
      const fill = d?.fillColor ? TASK_COLORS[d.fillColor].fill : FLOW_LIGHT.task.fill;
      const stroke = d?.fillColor ? TASK_COLORS[d.fillColor].base : FLOW_LIGHT.task.stroke;
      const textFill = d?.textColor ? TASK_COLORS[d.textColor].text : FLOW_LIGHT.task.text;
      parts.push(
        `<rect x="${n.x}" y="${n.y}" width="${s.w}" height="${s.h}" rx="9" fill="${fill}" stroke="${stroke}" stroke-width="1.5"/>`,
      );
      parts.push(
        `<text x="${cx}" y="${n.y + s.h / 2 + 4}" font-size="13" font-weight="600" fill="${textFill}" text-anchor="middle">${esc(name)}</text>`,
      );
    } else if (n.kind === 'issue') {
      if (!isPrimaryIssue(n)) continue; // 集約: 代表のみ描画
      const texts = issueTextsOf(n.taskId);
      const lines = texts.length ? texts : ['課題'];
      const lineH = 15;
      const padY = 7;
      const boxH = Math.max(s.h, padY * 2 + lines.length * lineH);
      parts.push(
        `<rect x="${n.x}" y="${n.y}" width="${s.w}" height="${boxH}" rx="6" fill="${FLOW_LIGHT.issue.fill}" stroke="${FLOW_LIGHT.issue.stroke}" stroke-width="1.5"/>`,
      );
      lines.forEach((tx, i) => {
        const label = texts.length > 1 ? `・${tx}` : tx;
        parts.push(
          `<text x="${n.x + 8}" y="${n.y + padY + i * lineH + 11}" font-size="11" font-weight="600" fill="${FLOW_LIGHT.issue.stroke}">${esc(truncate(label, 16))}</text>`,
        );
      });
    } else if (n.kind === 'comment') {
      parts.push(
        `<rect x="${n.x}" y="${n.y}" width="${s.w}" height="${s.h}" rx="4" fill="${FLOW_LIGHT.comment.fill}" stroke="${FLOW_LIGHT.comment.stroke}" stroke-width="1.4"/>`,
      );
      parts.push(
        `<text x="${cx}" y="${n.y + s.h / 2 + 4}" font-size="11" fill="${FLOW_LIGHT.comment.text}" text-anchor="middle">${esc(n.text)}</text>`,
      );
    } else if (n.kind === 'control') {
      const label = { start: '開始', end: '終了', decision: '判断', merge: '合流' }[n.control];
      if (n.control === 'decision' || n.control === 'merge') {
        const mx = n.x + s.w / 2;
        const my = n.y + s.h / 2;
        parts.push(
          `<polygon points="${mx},${n.y} ${n.x + s.w},${my} ${mx},${n.y + s.h} ${n.x},${my}" fill="${FLOW_LIGHT.control.fill}" stroke="${FLOW_LIGHT.control.stroke}" stroke-width="1.6"/>`,
        );
      } else {
        parts.push(
          `<rect x="${n.x}" y="${n.y}" width="${s.w}" height="${s.h}" rx="16" fill="${FLOW_LIGHT.control.fill}" stroke="${FLOW_LIGHT.control.stroke}" stroke-width="1.6"/>`,
        );
      }
      parts.push(
        `<text x="${cx}" y="${n.y + s.h / 2 + 4}" font-size="11" fill="${FLOW_LIGHT.control.text}" text-anchor="middle">${esc(label)}</text>`,
      );
    }
  }

  // I/O 集約アイコン（最後に描画＝工程の上に重ねる。入力=左上 / 出力=右下、複数は1枚に列挙）
  const drawIoIcon = (
    task: FlowNode,
    io: 'input' | 'output',
    items: { name: string; kind: 'doc' | 'info' }[],
  ): void => {
    if (!items.length) return;
    const r = ioIconRect(task, io, items.length);
    const pal = io === 'input' ? FLOW_LIGHT.ioIn : FLOW_LIGHT.ioOut;
    if (items[0]?.kind === 'info') {
      // 情報=3 角丸＋1 角を立てた角丸ボックス（DESIGN §8・画面と一致＝WYSIWYG）
      parts.push(
        `<path d="${ioInfoChipPath(r, io)}" fill="${pal.fill}" stroke="${pal.stroke}" stroke-width="1.4"/>`,
      );
    } else {
      // 帳票=下辺が波打つ書類形
      const w = r.w;
      const wave = 6;
      parts.push(
        `<path d="M${r.x},${r.y} h${w} v${r.h - wave} q${-w / 4},${wave} ${-w / 2},0 q${-w / 4},${-wave} ${-w / 2},0 z" fill="${pal.fill}" stroke="${pal.stroke}" stroke-width="1.4"/>`,
      );
    }
    items.forEach((it, i) => {
      const ty = r.y + IO_ICON.padTop + i * IO_ICON.line + IO_ICON.line - 3;
      parts.push(
        `<text x="${r.x + r.w / 2}" y="${ty}" font-size="10.5" font-weight="600" fill="${pal.stroke}" text-anchor="middle">${esc(it.name || '帳票')}</text>`,
      );
    });
  };
  for (const n of nodes) {
    if (n.kind !== 'task') continue;
    const d = project.details[n.taskId];
    const inputs = d?.inputs ?? [];
    const plain = inputs.filter((it) => !it.source?.trim());
    const sourced = inputs.filter((it) => it.source?.trim());
    drawIoIcon(n, 'input', plain);
    drawIoIcon(n, 'output', d?.outputs ?? []);
    // 出所付き入力帳票: 出所部署のレーンに帳票を置き、工程へ点線で結ぶ
    // （レーン照合・チップ矩形・「外部:」表示の規則は画面と共有: sourceChipLayout）。
    const pal = FLOW_LIGHT.ioIn;
    sourced.forEach((it, i) => {
      const chip = sourceChipLayout(n, it.source ?? '', i, boxes);
      const cx = chip.x + chip.w / 2;
      parts.push(
        `<line x1="${chip.line.x1}" y1="${chip.line.y1}" x2="${chip.line.x2}" y2="${chip.line.y2}" stroke="${pal.stroke}" stroke-width="1.4" stroke-dasharray="4 3"/>`,
      );
      parts.push(
        `<rect x="${chip.x}" y="${chip.y}" width="${chip.w}" height="${chip.h}" rx="6" fill="${pal.fill}" stroke="${pal.stroke}" stroke-width="1.2"/>`,
      );
      parts.push(
        `<text x="${cx}" y="${chip.y + 13}" font-size="11" font-weight="600" fill="${pal.stroke}" text-anchor="middle">${esc(it.name || '帳票')}</text>`,
      );
      parts.push(
        `<text x="${cx}" y="${chip.y + 24}" font-size="8.5" fill="${FLOW_LIGHT.bandLabel}" text-anchor="middle">${esc(chip.label)}</text>`,
      );
    });
  }

  parts.push('</svg>');
  return parts.join('');
}

// 画像出力用に、タイトル・出力日のヘッダーと凡例（ノードの形・色の意味）を上下に足した
// 装飾版 SVG を作る。元の図は入れ子 <svg> として位置だけずらして埋め込む（座標系を保つ）。
export function decorateFlowSvg(
  inner: string,
  opts: { title: string; subtitle?: string },
): string {
  const m = inner.match(/width="(\d+(?:\.\d+)?)" height="(\d+(?:\.\d+)?)"/);
  const w = Math.max(560, m ? Number(m[1]) : 800);
  const h = m ? Number(m[2]) : 600;
  const headH = 56;
  const legendH = 44;
  const total = h + headH + legendH;
  const nested = inner.replace('<svg ', `<svg x="0" y="${headH}" `);

  const L = FLOW_LIGHT;
  // 凡例の各項目（形＝意味、色＝向き）。横に並べる。
  const items: { label: string; draw: (x: number) => string }[] = [
    { label: '工程', draw: (x) => `<rect x="${x}" y="-9" width="22" height="16" rx="4" fill="${L.task.fill}" stroke="${L.task.stroke}" stroke-width="1.3"/>` },
    { label: '判断', draw: (x) => `<polygon points="${x + 11},-10 ${x + 22},0 ${x + 11},10 ${x},0" fill="${L.control.fill}" stroke="${L.control.stroke}" stroke-width="1.3"/>` },
    { label: 'インプット', draw: (x) => `<rect x="${x}" y="-9" width="22" height="16" rx="4" fill="${L.ioIn.fill}" stroke="${L.ioIn.stroke}" stroke-width="1.3"/>` },
    { label: 'アウトプット', draw: (x) => `<rect x="${x}" y="-9" width="22" height="16" rx="4" fill="${L.ioOut.fill}" stroke="${L.ioOut.stroke}" stroke-width="1.3"/>` },
    { label: '課題', draw: (x) => `<rect x="${x}" y="-9" width="22" height="16" rx="3" fill="${L.issue.fill}" stroke="${L.issue.stroke}" stroke-width="1.3"/>` },
  ];
  let lx = 16;
  const legendParts: string[] = [];
  for (const it of items) {
    legendParts.push(it.draw(lx));
    legendParts.push(`<text x="${lx + 28}" y="4" font-size="11" fill="${L.task.text}">${esc(it.label)}</text>`);
    lx += 30 + it.label.length * 12 + 18;
  }

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${total}" viewBox="0 0 ${w} ${total}" font-family="${FONT_STACK}">`,
    `<rect width="100%" height="100%" fill="${L.bg}"/>`,
    `<text x="16" y="26" font-size="18" font-weight="600" fill="${L.task.text}">${esc(opts.title)}</text>`,
    opts.subtitle ? `<text x="16" y="44" font-size="11" fill="${L.bandLabel}">${esc(opts.subtitle)}</text>` : '',
    `<line x1="0" y1="${headH - 1}" x2="${w}" y2="${headH - 1}" stroke="${L.laneLine}" stroke-width="1"/>`,
    nested,
    `<line x1="0" y1="${headH + h}" x2="${w}" y2="${headH + h}" stroke="${L.laneLine}" stroke-width="1"/>`,
    `<g transform="translate(0, ${headH + h + 26})">${legendParts.join('')}</g>`,
    '</svg>',
  ].join('');
}
