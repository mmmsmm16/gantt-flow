// 現在のフロービューを SVG 文字列に書き出す（画像出力。依存ライブラリ不要）。
import { SIZE, deriveBands, type Project, type FlowLevelView, type FlowNode } from '@gantt-flow/core';

const esc = (s: string) =>
  s.replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[c]!);

function sizeOf(n: FlowNode) {
  if (n.kind === 'task') return SIZE.task;
  if (n.kind === 'doc') return SIZE.doc;
  if (n.kind === 'issue') return SIZE.issue;
  if (n.kind === 'comment') return SIZE.comment;
  return SIZE.control;
}

export function buildFlowSvg(project: Project, view: FlowLevelView): string {
  const nodes = Object.values(view.nodes);
  let maxX = 600;
  let maxY = 300;
  for (const n of nodes) {
    const s = sizeOf(n);
    maxX = Math.max(maxX, n.x + s.w + 60);
    maxY = Math.max(maxY, n.y + s.h + 60);
  }
  const parts: string[] = [];
  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${maxX}" height="${maxY}" viewBox="0 0 ${maxX} ${maxY}" font-family="sans-serif">`,
  );
  parts.push('<rect width="100%" height="100%" fill="#ffffff"/>');
  parts.push(
    '<defs><marker id="a" markerWidth="9" markerHeight="9" refX="7.5" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 z" fill="#64748b"/></marker></defs>',
  );

  // bands
  for (const b of deriveBands(project.core, view)) {
    const top = 8 + (b.depth - 1) * 8;
    parts.push(
      `<rect x="${b.x - 12}" y="${top}" width="${b.width + 24}" height="${maxY - top * 2}" rx="12" fill="none" stroke="#cbd5e1" stroke-dasharray="6 4"/>`,
    );
    const label = (b.level === 'large' ? '大' : b.level === 'medium' ? '中' : '小') + ': ' + b.label;
    parts.push(`<text x="${b.x}" y="${top + 16}" font-size="11" fill="#64748b">${esc(label)}</text>`);
  }

  // swimlanes: 左ラベル列 + 全幅の水平区切り
  const lanes = Object.values(view.lanes).sort((a, b) => a.order - b.order);
  const cnt = Math.max(1, lanes.length);
  const BAND_TOP = 24;
  const LABEL_W = 96;
  parts.push(`<rect x="0" y="${BAND_TOP}" width="${LABEL_W}" height="${cnt * 120}" fill="#f8fafc"/>`);
  for (let i = 0; i < cnt; i++) {
    if (i % 2 === 1)
      parts.push(`<rect x="${LABEL_W}" y="${BAND_TOP + i * 120}" width="${maxX}" height="120" fill="rgba(2,6,23,0.015)"/>`);
  }
  for (let i = 0; i <= cnt; i++) {
    parts.push(`<line x1="0" y1="${BAND_TOP + i * 120}" x2="${maxX}" y2="${BAND_TOP + i * 120}" stroke="#e2e8f0" stroke-width="1.2"/>`);
  }
  parts.push(`<line x1="${LABEL_W}" y1="${BAND_TOP}" x2="${LABEL_W}" y2="${BAND_TOP + cnt * 120}" stroke="#cbd5e1" stroke-width="1.4"/>`);
  for (const lane of lanes) {
    parts.push(
      `<text x="${LABEL_W / 2}" y="${BAND_TOP + lane.order * 120 + 64}" font-size="12" font-weight="700" fill="#1e293b" text-anchor="middle">${esc(lane.title)}</text>`,
    );
  }

  // edges
  for (const e of Object.values(view.edges)) {
    const s = view.nodes[e.source];
    const t = view.nodes[e.target];
    if (!s || !t) continue;
    const ss = sizeOf(s);
    const ts = sizeOf(t);
    const x1 = s.x + ss.w;
    const y1 = s.y + ss.h / 2;
    const x2 = t.x;
    const y2 = t.y + ts.h / 2;
    const dx = Math.max(30, Math.abs(x2 - x1) / 2);
    parts.push(
      `<path d="M${x1},${y1} C${x1 + dx},${y1} ${x2 - dx},${y2} ${x2},${y2}" fill="none" stroke="#94a3b8" stroke-width="1.8" marker-end="url(#a)"/>`,
    );
    if (e.label) {
      parts.push(
        `<text x="${(x1 + x2) / 2}" y="${(y1 + y2) / 2 - 4}" font-size="11" fill="#64748b" text-anchor="middle">${esc(e.label)}</text>`,
      );
    }
  }

  // issue lines
  for (const n of nodes) {
    if (n.kind !== 'issue') continue;
    const t = view.nodes[n.targetNodeId];
    if (!t) continue;
    const ts = sizeOf(t);
    parts.push(
      `<line x1="${n.x + SIZE.issue.w / 2}" y1="${n.y + SIZE.issue.h / 2}" x2="${t.x + ts.w / 2}" y2="${t.y + ts.h / 2}" stroke="#cbd5e1" stroke-width="1"/>`,
    );
  }

  // nodes
  for (const n of nodes) {
    const s = sizeOf(n);
    const cx = n.x + s.w / 2;
    if (n.kind === 'task') {
      const name = project.core.tasks[n.taskId]?.name ?? '';
      parts.push(`<rect x="${n.x}" y="${n.y}" width="${s.w}" height="${s.h}" rx="9" fill="#fff" stroke="#475569" stroke-width="1.5"/>`);
      parts.push(`<text x="${cx}" y="${n.y + s.h / 2 + 4}" font-size="13" font-weight="600" fill="#1e293b" text-anchor="middle">${esc(name)}</text>`);
    } else if (n.kind === 'doc') {
      const d = project.details[n.taskId];
      const item = [...(d?.inputs ?? []), ...(d?.outputs ?? [])].find((i) => i.id === n.ioId);
      const isIn = n.io === 'input';
      const fill = isIn ? '#dbeafe' : '#dcfce7';
      const stroke = isIn ? '#2563eb' : '#15803d';
      if (item?.kind === 'info') {
        parts.push(`<rect x="${n.x}" y="${n.y}" width="${s.w}" height="${s.h}" rx="${s.h / 2}" fill="${fill}" stroke="${stroke}" stroke-width="1.4"/>`);
      } else {
        const w = s.w;
        const h = s.h;
        parts.push(
          `<path d="M${n.x},${n.y} h${w} v${h - 6} q${-w / 4},6 ${-w / 2},0 q${-w / 4},-6 ${-w / 2},0 z" fill="${fill}" stroke="${stroke}" stroke-width="1.4"/>`,
        );
      }
      parts.push(`<text x="${cx}" y="${n.y + s.h / 2 + 4}" font-size="11" font-weight="600" fill="${stroke}" text-anchor="middle">${esc(item?.name ?? '帳票')}</text>`);
    } else if (n.kind === 'issue') {
      parts.push(`<rect x="${n.x}" y="${n.y}" width="${s.w}" height="${s.h}" fill="#fee2e2" stroke="#dc2626" stroke-width="1.5"/>`);
      parts.push(`<text x="${cx}" y="${n.y + s.h / 2 + 4}" font-size="12" font-weight="700" fill="#dc2626" text-anchor="middle">課題</text>`);
    } else if (n.kind === 'comment') {
      parts.push(`<rect x="${n.x}" y="${n.y}" width="${s.w}" height="${s.h}" rx="4" fill="#fef9c3" stroke="#ca8a04" stroke-width="1.4"/>`);
      parts.push(`<text x="${cx}" y="${n.y + s.h / 2 + 4}" font-size="11" fill="#854d0e" text-anchor="middle">${esc(n.text)}</text>`);
    } else if (n.kind === 'control') {
      const label = { start: '開始', end: '終了', decision: '判断', merge: '合流' }[n.control];
      parts.push(`<rect x="${n.x}" y="${n.y}" width="${s.w}" height="${s.h}" rx="16" fill="#fff" stroke="#94a3b8" stroke-width="1.6"/>`);
      parts.push(`<text x="${cx}" y="${n.y + s.h / 2 + 4}" font-size="11" fill="#64748b" text-anchor="middle">${esc(label)}</text>`);
    }
  }

  parts.push('</svg>');
  return parts.join('');
}
