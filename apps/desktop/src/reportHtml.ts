// 改善効果レポート（自己完結 HTML 1 ファイル）の生成器。純関数・副作用ゼロ
// （DOM/localStorage/store に触れない）。集計は core の buildCompareReport（画面と同一）。
// 出力は常にライトテーマ・自己完結: 外部 URL 参照ゼロ・<script> タグを一切持たない静的 HTML。
// 画面のインタラクションは無く、@media print で A4 縦・カード単位 break-inside:avoid の帳票になる。
// ユーザ文字列はすべて escapeHtml を通す（XSS 規律。handbook.ts と同じ流儀）。
import type { Project } from '@gantt-flow/core';
import { buildCompareReport, round1, HOURS_PER_DAY, type CompareReport } from '@gantt-flow/core';

export interface ImprovementReportOptions {
  /** 出力日表記用（省略時のみ new Date()。テストは固定値でバイト安定に）。 */
  now?: string;
}

const escapeHtml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function localDateYmd(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

const h1 = (min: number): number => round1(min / 60); // 分→時間（小数1位）
const num = (v: number): string => String(round1(v));

// 2 本の横棒（As-Is / To-Be）。preserveAspectRatio=none で幅いっぱいに伸ばす静的 SVG。
function twoBars(asis: number, tobe: number): string {
  const max = Math.max(asis, tobe, 1);
  const w = (v: number) => (v <= 0 ? 0 : Math.max(1.5, (v / max) * 100));
  return (
    `<svg class="bars" viewBox="0 0 100 30" preserveAspectRatio="none" aria-hidden="true">` +
    `<rect class="b-asis" x="0" y="3" width="${num(w(asis))}" height="9"/>` +
    `<rect class="b-tobe" x="0" y="18" width="${num(w(tobe))}" height="9"/>` +
    `</svg>`
  );
}

// KPI カード 1 枚。higherBetter=自動化率のみ（高いほど良い）。それ以外は減少が改善。
function kpiCard(opt: {
  title: string;
  sub: string;
  asis: number;
  tobe: number;
  unit: string;
  higherBetter?: boolean;
}): string {
  const { title, sub, asis, tobe, unit, higherBetter } = opt;
  const delta = tobe - asis;
  const good = higherBetter ? delta > 0 : delta < 0;
  const flat = Math.abs(delta) < 0.05;
  const tone = flat ? 'flat' : good ? 'good' : 'bad';
  const sign = delta > 0 ? '+' : delta < 0 ? '−' : '±';
  const pctBase = asis === 0 ? null : Math.round((delta / asis) * 100);
  const pct = pctBase === null ? '' : ` <span class="pct">${pctBase > 0 ? '+' : ''}${pctBase}%</span>`;
  return (
    `<section class="kpi">` +
    `<div class="kpi-head"><span class="kpi-title">${escapeHtml(title)}</span>` +
    `<span class="kpi-sub">${escapeHtml(sub)}</span></div>` +
    `<div class="kpi-nums"><span class="v-asis">${num(asis)}<span class="u">${escapeHtml(unit)}</span></span>` +
    `<span class="arrow">→</span>` +
    `<span class="v-tobe">${num(tobe)}<span class="u">${escapeHtml(unit)}</span></span></div>` +
    twoBars(asis, tobe) +
    `<div class="kpi-legend"><span><i class="sw asis"></i>As-Is</span><span><i class="sw tobe"></i>To-Be</span></div>` +
    `<div class="kpi-delta ${tone}">${flat ? '±0' : `${sign}${num(Math.abs(delta))}${escapeHtml(unit)}`}${flat ? '' : pct}</div>` +
    `</section>`
  );
}

const DIFF_SEG: { key: 'H' | 'M' | 'L'; label: string }[] = [
  { key: 'H', label: '高（ベテラン依存）' },
  { key: 'M', label: '中（中堅）' },
  { key: 'L', label: '低（誰でも）' },
];

// 難易度 H/M/L の積み上げバー（工程数）。0 件のセグメントは描かない静的 SVG。
function diffStack(counts: { H: number; M: number; L: number }): string {
  const total = counts.H + counts.M + counts.L || 1;
  let x = 0;
  const segs = DIFF_SEG.map((d) => {
    const w = (counts[d.key] / total) * 100;
    if (w <= 0) return '';
    const rect = `<rect class="d-${d.key.toLowerCase()}" x="${num(x)}" y="0" width="${num(w)}" height="14"/>`;
    x += w;
    return rect;
  }).join('');
  return `<svg class="stack" viewBox="0 0 100 14" preserveAspectRatio="none" aria-hidden="true">${segs}</svg>`;
}

function difficultySection(report: CompareReport): string {
  const c = report.totals.difficulty.count;
  const row = (label: string, counts: { H: number; M: number; L: number }) =>
    `<div class="dstack-row"><span class="tag">${label}</span>${diffStack(counts)}` +
    `<span class="dnums">高 ${counts.H}・中 ${counts.M}・低 ${counts.L}</span></div>`;
  return (
    `<section class="card">` +
    `<h2 class="card-title">業務難易度の構成（工程数）</h2>` +
    row('As-Is', c.asis) +
    row('To-Be', c.tobe) +
    `<ul class="dlegend">${DIFF_SEG.map((d) => `<li><i class="dot d-${d.key.toLowerCase()}"></i>${escapeHtml(d.label)}</li>`).join('')}</ul>` +
    `<p class="card-note">高難度（ベテラン依存）の工程を、標準化により中〜低へ移すことがねらいです。</p>` +
    `</section>`
  );
}

// 担当別 Before/After（横棒 SVG ＋ 数表）。工数（h）で As-Is / To-Be を並べる。
function assigneeSection(report: CompareReport): string {
  const rows = report.byAssignee;
  if (rows.length === 0) {
    return `<section class="card"><h2 class="card-title">担当別の工数（Before / After）</h2>` +
      `<p class="card-note">担当が割り当てられた工程がありません。</p></section>`;
  }
  const max = Math.max(...rows.flatMap((r) => [h1(r.asis), h1(r.tobe)]), 1);
  const w = (hours: number) => (hours <= 0 ? 0 : Math.max(1.5, (hours / max) * 100));
  const body = rows
    .map((r) => {
      const a = h1(r.asis);
      const b = h1(r.tobe);
      return (
        `<tr><th scope="row">${escapeHtml(r.name)}</th>` +
        `<td class="barcell">` +
        `<svg class="hbars" viewBox="0 0 100 26" preserveAspectRatio="none" aria-hidden="true">` +
        `<rect class="b-asis" x="0" y="2" width="${num(w(a))}" height="9"/>` +
        `<rect class="b-tobe" x="0" y="14" width="${num(w(b))}" height="9"/></svg></td>` +
        `<td class="numcell">${num(a)}h → <b>${num(b)}h</b></td></tr>`
      );
    })
    .join('');
  return (
    `<section class="card">` +
    `<h2 class="card-title">担当別の工数（Before / After）</h2>` +
    `<table class="atable"><tbody>${body}</tbody></table>` +
    `<div class="kpi-legend"><span><i class="sw asis"></i>As-Is</span><span><i class="sw tobe"></i>To-Be</span></div>` +
    `</section>`
  );
}

const LIFECYCLE_CLASS: Record<string, string> = { added: 'row-added', removed: 'row-removed', kept: '' };

function rowsSection(report: CompareReport): string {
  const body = report.rows
    .map((r) => {
      const cls = [LIFECYCLE_CLASS[r.lifecycle] ?? '', r.changed ? 'row-changed' : 'row-kept']
        .filter(Boolean)
        .join(' ');
      const cut = r.ltCutDays > 0.05 ? `<span class="good">−${num(r.ltCutDays)}日</span>` : '±0';
      const diff = (d?: string) => (d ? escapeHtml(d) : '—');
      const state = r.lifecycle === 'added' ? '新設' : r.lifecycle === 'removed' ? '廃止' : r.changed ? '変更' : '維持';
      return (
        `<tr class="${cls}">` +
        `<td class="c-code">${escapeHtml(r.code)}</td>` +
        `<td class="c-name">${escapeHtml(r.name)}</td>` +
        `<td>${escapeHtml(r.ownerAsis)}</td>` +
        `<td class="num">${num(h1(r.effortMinutes.asis))}h → <b>${num(h1(r.effortMinutes.tobe))}h</b></td>` +
        `<td class="num">${num(r.ltDays.asis)}日 → <b>${num(r.ltDays.tobe)}日</b></td>` +
        `<td class="num">${cut}</td>` +
        `<td class="c-diff">${diff(r.difficultyAsis)} → ${diff(r.difficultyTobe)}</td>` +
        `<td class="c-state">${state}</td>` +
        `</tr>`
      );
    })
    .join('');
  return (
    `<section class="card">` +
    `<h2 class="card-title">工程別の差分</h2>` +
    `<div class="tscroll"><table class="rtable">` +
    `<thead><tr><th>工程No</th><th>工程</th><th>担当</th><th>工数</th><th>リードタイム</th>` +
    `<th>短縮</th><th>難易度</th><th>状態</th></tr></thead>` +
    `<tbody>${body || '<tr><td colspan="8" class="empty">対象の工程がありません。</td></tr>'}</tbody>` +
    `</table></div>` +
    `<p class="card-note">リードタイムは依存のクリティカルパス。並行工程は加算されないため、総リードタイムは各行の単純和より短くなりえます（＝並行化の効果）。</p>` +
    `</section>`
  );
}

function structSection(report: CompareReport): string {
  const s = report.struct;
  const chips: string[] = [];
  if (s.added.length) chips.push(`<span class="chip c-added">新規 ${s.added.length}</span>`);
  if (s.removed.length) chips.push(`<span class="chip c-removed">廃止 ${s.removed.length}</span>`);
  if (s.moved.length) chips.push(`<span class="chip c-moved">担当移動 ${s.moved.length}</span>`);
  if (s.parallelized > 0) chips.push(`<span class="chip c-parallel">並行化 ${s.parallelized}</span>`);
  const body = chips.length
    ? `<div class="chips">${chips.join('')}</div>`
    : `<p class="card-note">構造の変更はありません（工数・リードタイム・難易度のみ変化）。</p>`;
  return `<section class="card"><h2 class="card-title">構造の変更</h2>${body}</section>`;
}

const REPORT_CSS = `
:root{
  --bg:#ffffff;--panel:#f7f8fa;--panel-2:#eef1f4;--ink:#1b222c;--ink-2:#4c5866;--ink-3:#7b8794;
  --line:#e4e8ed;--line-2:#d2d8df;--asis:#8a94a6;--tobe:#0e6f6a;
  --good:#1f7a4d;--bad:#a6371f;--good-tint:#e6f3ec;--bad-tint:#f8ede8;
  --dh:#a6371f;--dm:#a56a12;--dl:#1f7a4d;
  --mincho:'Yu Mincho','YuMincho','Hiragino Mincho ProN','Noto Serif JP','MS PMincho',serif;
  --gothic:'Inter','Yu Gothic UI','Hiragino Kaku Gothic ProN','Noto Sans JP','Meiryo',system-ui,sans-serif;
  --mono:'SFMono-Regular','Cascadia Code',Consolas,monospace;
}
*{box-sizing:border-box;}
body{margin:0;background:var(--panel);color:var(--ink);font-family:var(--gothic);
  font-size:13.5px;line-height:1.7;-webkit-font-smoothing:antialiased;font-feature-settings:"palt" 1;}
.wrap{max-width:960px;margin:0 auto;padding:28px 22px 72px;}
.rep-head{border-bottom:2px solid var(--ink);padding-bottom:14px;margin-bottom:22px;}
.rep-eyebrow{font-family:var(--mono);font-size:10.5px;letter-spacing:.2em;color:var(--tobe);text-transform:uppercase;margin:0 0 6px;font-weight:600;}
.rep-title{font-family:var(--mincho);font-size:27px;font-weight:600;letter-spacing:.03em;margin:0 0 6px;line-height:1.25;}
.rep-meta{margin:0;font-size:11.5px;color:var(--ink-3);font-variant-numeric:tabular-nums;}
.kpi-grid{display:grid;grid-template-columns:repeat(2,1fr);gap:14px;margin-bottom:16px;}
.kpi{background:var(--bg);border:1px solid var(--line);border-radius:12px;padding:15px 16px;break-inside:avoid;}
.kpi-head{display:flex;align-items:baseline;gap:8px;margin-bottom:8px;}
.kpi-title{font-family:var(--mincho);font-size:16px;font-weight:600;}
.kpi-sub{font-size:10.5px;color:var(--ink-3);}
.kpi-nums{display:flex;align-items:baseline;gap:8px;font-variant-numeric:tabular-nums;margin-bottom:9px;}
.v-asis{font-size:16px;color:var(--ink-2);}
.v-tobe{font-size:23px;font-weight:700;color:var(--tobe);}
.kpi-nums .u{font-size:11px;color:var(--ink-3);margin-left:1px;}
.kpi-nums .arrow{color:var(--ink-3);font-size:14px;}
.bars,.hbars{display:block;width:100%;height:26px;}
.stack{display:block;width:100%;height:14px;border-radius:4px;overflow:hidden;}
.b-asis{fill:var(--asis);}.b-tobe{fill:var(--tobe);}
.d-h{fill:var(--dh);}.d-m{fill:var(--dm);}.d-l{fill:var(--dl);}
.kpi-legend{display:flex;gap:14px;margin-top:7px;font-size:10.5px;color:var(--ink-3);}
.kpi-legend .sw{display:inline-block;width:9px;height:9px;border-radius:2px;margin-right:4px;vertical-align:middle;}
.sw.asis{background:var(--asis);}.sw.tobe{background:var(--tobe);}
.kpi-delta{margin-top:9px;font-size:12px;font-weight:700;font-variant-numeric:tabular-nums;}
.kpi-delta .pct{font-weight:600;opacity:.8;margin-left:2px;}
.kpi-delta.good{color:var(--good);}.kpi-delta.bad{color:var(--bad);}.kpi-delta.flat{color:var(--ink-3);}
.card{background:var(--bg);border:1px solid var(--line);border-radius:12px;padding:16px 18px;margin-bottom:16px;break-inside:avoid;}
.card-title{font-family:var(--mincho);font-size:17px;font-weight:600;letter-spacing:.03em;margin:0 0 12px;padding-bottom:7px;border-bottom:1px solid var(--line);}
.card-note{font-size:11px;color:var(--ink-3);margin:11px 0 0;line-height:1.6;}
.dstack-row{display:flex;align-items:center;gap:10px;margin:7px 0;}
.dstack-row .tag{flex:none;width:44px;font-size:11px;font-weight:700;color:var(--ink-2);}
.dstack-row .dnums{flex:none;font-size:11px;color:var(--ink-2);font-variant-numeric:tabular-nums;}
.dstack-row .stack{flex:1;}
.dlegend{list-style:none;display:flex;flex-wrap:wrap;gap:14px;margin:12px 0 0;padding:0;font-size:11px;color:var(--ink-2);}
.dlegend .dot{display:inline-block;width:9px;height:9px;border-radius:2px;margin-right:5px;vertical-align:middle;}
.dot.d-h{background:var(--dh);}.dot.d-m{background:var(--dm);}.dot.d-l{background:var(--dl);}
.atable{width:100%;border-collapse:collapse;}
.atable th[scope=row]{text-align:left;font-weight:600;font-size:12.5px;width:26%;padding:5px 8px 5px 0;color:var(--ink);}
.atable .barcell{width:52%;}.atable .numcell{text-align:right;font-size:12px;font-variant-numeric:tabular-nums;color:var(--ink-2);white-space:nowrap;}
.atable .numcell b{color:var(--tobe);}
.tscroll{overflow-x:auto;}
.rtable{width:100%;border-collapse:collapse;font-size:12px;}
.rtable th,.rtable td{padding:6px 9px;border-bottom:1px solid var(--line);text-align:left;vertical-align:top;}
.rtable thead th{font-size:10.5px;letter-spacing:.06em;color:var(--ink-3);text-transform:uppercase;border-bottom:1.5px solid var(--line-2);white-space:nowrap;}
.rtable td.num{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap;}
.rtable td b{color:var(--tobe);}
.rtable .c-code{font-family:var(--mono);font-size:10.5px;color:var(--ink-3);white-space:nowrap;}
.rtable .c-name{font-weight:600;}
.rtable .c-diff,.rtable .c-state{color:var(--ink-2);white-space:nowrap;}
.rtable .good{color:var(--good);font-weight:700;}
.rtable tr.row-kept{color:var(--ink-3);}
.rtable tr.row-kept .c-name{font-weight:400;color:var(--ink-2);}
.rtable tr.row-changed .c-name{font-weight:700;color:var(--ink);}
.rtable tr.row-added{background:var(--good-tint);}
.rtable tr.row-added .c-name{color:var(--good);}
.rtable tr.row-removed{background:var(--bad-tint);}
.rtable tr.row-removed td{text-decoration:line-through;color:var(--bad);}
.rtable td.empty{text-align:center;color:var(--ink-3);text-decoration:none;}
.chips{display:flex;flex-wrap:wrap;gap:8px;}
.chip{font-size:12px;font-weight:700;border-radius:999px;padding:4px 12px;border:1px solid var(--line-2);}
.c-added{color:var(--good);background:var(--good-tint);border-color:#b5ddc4;}
.c-removed{color:var(--bad);background:var(--bad-tint);border-color:#e0b6a8;}
.c-moved{color:#6a53a6;background:#efeaf8;border-color:#cfc2ea;}
.c-parallel{color:#8a5a12;background:#f6ecd6;border-color:#e2c68d;}
.rep-foot{margin-top:26px;padding-top:14px;border-top:1px solid var(--line);font-size:10.5px;color:var(--ink-3);line-height:1.8;}
@media print{
  @page{size:A4 portrait;margin:14mm;}
  body{background:#fff;font-size:11px;}
  .wrap{max-width:none;padding:0;}
  .kpi,.card{box-shadow:none;break-inside:avoid;}
}
`;

/** 改善効果レポート（自己完結 HTML）を返す純関数。<script> を持たない静的 HTML。 */
export function buildImprovementReportHtml(project: Project, opts: ImprovementReportOptions = {}): string {
  const report = buildCompareReport(project.core, project.details);
  const t = report.totals;
  const now = opts.now ? new Date(opts.now) : new Date();
  const dateY = localDateYmd(now);
  const title = project.meta.title || 'プロジェクト';

  const kpis =
    kpiCard({ title: '工数', sub: 'タッチタイム総和', asis: h1(t.effortMinutes.asis), tobe: h1(t.effortMinutes.tobe), unit: 'h' }) +
    kpiCard({ title: 'リードタイム', sub: '着手〜完了・停滞含む', asis: t.ltDays.asis, tobe: t.ltDays.tobe, unit: '日' }) +
    kpiCard({ title: '待ち時間', sub: 'リードタイム − 工数', asis: t.waitDays.asis, tobe: t.waitDays.tobe, unit: '日' }) +
    kpiCard({ title: '自動化率', sub: 'システム＋一部自動', asis: report.automationRatePct.asis, tobe: report.automationRatePct.tobe, unit: '%', higherBetter: true });

  const head =
    `<header class="rep-head">` +
    `<p class="rep-eyebrow">Improvement Report</p>` +
    `<h1 class="rep-title">${escapeHtml(title)} 改善効果レポート</h1>` +
    `<p class="rep-meta">出力日 ${escapeHtml(dateY)} ・ As-Is / To-Be 比較 ・ gantt-flow で生成</p>` +
    `</header>`;

  const foot =
    `<footer class="rep-foot">` +
    `定義: リードタイム＝依存グラフのクリティカルパス（最長経路）／待ち時間＝リードタイム − 工数（日換算）／1 営業日＝${HOURS_PER_DAY}h。<br>` +
    `自動化率＝(システム自動 ＋ 一部自動) ÷ 末端工程数 × 100。To-Be 側の自動化が未入力の工程は As-Is と同一として集計します。<br>` +
    `${escapeHtml(title)} ／ ${escapeHtml(dateY)} 版 ・ gantt-flow（appVersion ${escapeHtml(project.meta.appVersion || '')}）。本書は社内限りです。` +
    `</footer>`;

  return (
    `<!doctype html><html lang="ja"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width, initial-scale=1">` +
    `<title>${escapeHtml(title)} 改善効果レポート</title>` +
    `<style>${REPORT_CSS}</style>` +
    `</head><body><div class="wrap">` +
    head +
    `<div class="kpi-grid">${kpis}</div>` +
    difficultySection(report) +
    assigneeSection(report) +
    rowsSection(report) +
    structSection(report) +
    foot +
    `</div></body></html>`
  );
}
