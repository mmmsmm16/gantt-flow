// ハンドブック（HTML）出力の生成器。純関数・副作用ゼロ（DOM/localStorage/store に一切触れない）。
// 見た目は手順書タブ（ProcedureView.tsx）から編集 UI を除いたもの
// （spec: docs/superpowers/specs/2026-07-04-procedure-layer-design.md A. ハンドブック出力）。
// 出力は常にライトテーマ・自己完結（外部 URL 参照ゼロ・画像は data URI・JS ゼロ）。
// 場所エイリアス解決(aliases)・画像バイト(assets)は呼び出し側が渡す（core/localStorage/assetStore の
// セッションメモリを直接読まない＝node 環境でもゴールデンテストできる）。
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type {
  Project,
  Id,
  ProcessTask,
  StepRef,
  StepCond,
  StepImage,
  ProcedureStep,
  Manual,
} from '@gantt-flow/core';
import { computeCodes, deriveProcedureNav } from '@gantt-flow/core';
import { buildFlowSvg, decorateFlowSvg } from './flowSvg';
import { resolveLocator, type ResolvedLocator } from './locationAliases';
import { isLeaf, ancestorsOf, resolveRef } from './procShared';
import { mimeForFile } from './assetStore';
import { bytesToB64 } from './b64';
import { MarkdownLite } from './markdownLite';

export interface HandbookOptions {
  /** 場所エイリアス対応表（loadLocationAliases() の結果を渡す。空なら全て disconnected 表記）。 */
  aliases: Record<string, string>;
  /** 参照される画像バイト（snapshotAssets(collectReferencedAssetFiles(project)) の結果を渡す）。 */
  assets: Record<string, Uint8Array>;
  /** 出力日表記用（省略時のみ new Date()。テストは固定値でバイト安定に）。 */
  now?: string;
}

const LEVEL_LABEL: Record<string, string> = { large: '大', medium: '中', small: '小', detail: '詳細' };

const escapeHtml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// 手順書本文(bodyMd)・条件の対処(thenMd)を MarkdownLite で読み取り専用レンダリング(XSS 安全実証済み)。
const md = (text: string): string => renderToStaticMarkup(createElement(MarkdownLite, { text }));

function localDateYmd(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

const byOrder = (ts: ProcessTask[]): ProcessTask[] =>
  [...ts].sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));

function nameOf(project: Project, codes: Record<Id, string>, id: Id): string {
  const t = project.core.tasks[id];
  return `${codes[id] ? codes[id] + ' ' : ''}${t?.name ?? ''}`;
}

function assigneeNameOf(project: Project, id: Id): string | undefined {
  const aid = project.core.tasks[id]?.assigneeId;
  return aid ? project.core.assignees[aid]?.name : undefined;
}

// 資料の場所表記。url ロケータのみ実 URL への <a> を許す（自己完結の例外＝台帳の場所表記）。
function locatorHtml(loc: ResolvedLocator): string {
  if (loc.state === 'url' && /^https?:\/\//.test(loc.display)) {
    return `<a href="${escapeHtml(loc.display)}">${escapeHtml(loc.display)}</a>`;
  }
  return escapeHtml(loc.display);
}

// タスクへのアンカー id は文書内で一意にする（中工程が自身しか末端を持たない/大工程が中工程を
// 持たないフォールバックでは同じ taskId に複数回行き着きうるため、初出のみ付与する）。
function anchorAttr(used: Set<Id>, id: Id): string {
  if (used.has(id)) return '';
  used.add(id);
  return ` id="hb-task-${escapeHtml(id)}"`;
}

// ---- 目次・フロー図 ----

function buildToc(project: Project, codes: Record<Id, string>): string {
  const core = project.core;
  const roots = byOrder(Object.values(core.tasks).filter((t) => !t.parentId));
  const items = roots
    .map((large) => {
      const mids = byOrder(Object.values(core.tasks).filter((t) => t.parentId === large.id));
      const list = mids.length
        ? `<ul>${mids
            .map(
              (m) =>
                `<li><a href="#hb-task-${escapeHtml(m.id)}">${escapeHtml(nameOf(project, codes, m.id))}</a></li>`,
            )
            .join('')}</ul>`
        : '';
      return `<li><a href="#hb-task-${escapeHtml(large.id)}">${escapeHtml(nameOf(project, codes, large.id))}</a>${list}</li>`;
    })
    .join('');
  return (
    `<nav class="hb-toc"><h2>目次</h2>` +
    `<ul><li><a href="#hb-flows">業務フロー図</a></li></ul>` +
    `<ul class="hb-toc-tree">${items}</ul></nav>`
  );
}

// レベル別フロー図（タスクノードが 1 つ以上あるレベル/スコープのみ・画面と同じ buildFlowSvg/decorateFlowSvg）。
function buildFlowsSection(project: Project): string {
  const cards: string[] = [];
  for (const view of project.flow.byLevel) {
    const taskNodes = Object.values(view.nodes).filter((n) => n.kind === 'task').length;
    if (taskNodes === 0) continue;
    const scopeName = view.scopeParentId ? project.core.tasks[view.scopeParentId]?.name : undefined;
    const label = `${LEVEL_LABEL[view.level] ?? view.level}${scopeName ? `（${scopeName}）` : ''}`;
    const svg = decorateFlowSvg(buildFlowSvg(project, view), {
      title: label,
      subtitle: project.meta.title || 'プロジェクト',
    });
    cards.push(`<div class="hb-flow-card"><div class="hb-flow-scroll">${svg}</div></div>`);
  }
  return cards.join('');
}

// ---- 本文（大工程 → 中工程 → 末端章） ----

function buildRefChip(project: Project, opts: HandbookOptions, ref: StepRef): string {
  const r = resolveRef(project, ref);
  if (r.broken) {
    return `<span class="proc-chip broken">🔗 ${escapeHtml(r.label)}（リンク切れ）</span>`;
  }
  if (ref.kind === 'asset') {
    const asset = project.manual.assets[ref.assetId];
    const loc = resolveLocator(asset?.locator, opts.aliases);
    const locHtml = loc.display ? ` — ${locatorHtml(loc)}` : '';
    return `<span class="proc-chip ref">📚 ${escapeHtml(r.label)}${locHtml}</span>`;
  }
  const icon = ref.kind === 'io' ? '📄' : '🔗';
  return `<span class="proc-chip io">${icon} ${escapeHtml(r.label)}</span>`;
}

function buildShot(opts: HandbookOptions, img: StepImage): string {
  const bytes = opts.assets[img.file];
  const body = bytes
    ? `<img src="data:${mimeForFile(img.file)};base64,${bytesToB64(bytes)}" alt="${escapeHtml(img.caption || 'ステップ画像')}">`
    : `<div class="proc-shot-missing">画像が見つかりません</div>`;
  const caption = img.caption?.trim() ? `<figcaption>${escapeHtml(img.caption)}</figcaption>` : '';
  return `<figure class="proc-shot">${body}${caption}</figure>`;
}

function buildCond(project: Project, codes: Record<Id, string>, c: StepCond): string {
  const target = c.targetTaskId ? project.core.tasks[c.targetTaskId] : undefined;
  const jump = c.targetTaskId
    ? target
      ? `<a class="proc-c-link" href="#hb-task-${escapeHtml(c.targetTaskId)}">→ ${escapeHtml(nameOf(project, codes, c.targetTaskId))}</a>`
      : `<span class="proc-c-link broken">→ リンク切れ</span>`
    : '';
  return (
    `<div class="proc-cond">` +
    `<div class="proc-cond-row"><span class="proc-cond-if">⚠ 〜の場合:</span>` +
    `<span class="proc-cond-when">${escapeHtml(c.when)}</span></div>` +
    (c.thenMd.trim() ? `<div class="proc-cond-then">${md(c.thenMd)}</div>` : '') +
    (jump ? `<div class="proc-cond-jump"><span class="proc-cond-label">飛び先:</span>${jump}</div>` : '') +
    `</div>`
  );
}

function buildStep(project: Project, opts: HandbookOptions, codes: Record<Id, string>, step: ProcedureStep, i: number): string {
  const bodyHtml = (step.bodyMd ?? '').trim() !== '' ? `<div class="proc-detail">${md(step.bodyMd ?? '')}</div>` : '';
  const condsHtml = step.conds.map((c) => buildCond(project, codes, c)).join('');
  const refsHtml =
    step.refs.length > 0
      ? `<div class="proc-chips">${step.refs.map((r) => buildRefChip(project, opts, r)).join('')}</div>`
      : '';
  const imagesHtml =
    step.images.length > 0
      ? `<div class="proc-shots">${step.images.map((img) => buildShot(opts, img)).join('')}</div>`
      : '';
  return (
    `<div class="proc-step">` +
    `<span class="proc-stepno">${i + 1}</span>` +
    `<div class="proc-step-body">` +
    `<div class="proc-step-top">${escapeHtml(step.action)}</div>` +
    (step.why?.trim() ? `<div class="proc-why">${escapeHtml(step.why)}</div>` : '') +
    bodyHtml +
    condsHtml +
    refsHtml +
    imagesHtml +
    `</div></div>`
  );
}

// 末端工程 1 件分の章。手順書が無ければ「（手順書未作成）」の 1 行のみ（工程自体は載せる＝全体像を保つ）。
function buildLeafChapter(project: Project, opts: HandbookOptions, codes: Record<Id, string>, used: Set<Id>, taskId: Id): string {
  const t = project.core.tasks[taskId];
  if (!t) return '';
  const d = project.details[taskId];
  const doc = project.manual.procedures[taskId];
  const steps = doc?.steps ?? [];
  const metaParts: string[] = [];
  const asg = assigneeNameOf(project, taskId);
  if (asg) metaParts.push(`担当: ${escapeHtml(asg)}`);
  if (d?.effortMinutes != null) metaParts.push(`${d.effortMinutes}分`);

  const stepsHtml =
    steps.length === 0
      ? `<div class="hb-noproc">（手順書未作成）</div>`
      : steps.map((s, i) => buildStep(project, opts, codes, s, i)).join('');

  return (
    `<article class="proc-chap"${anchorAttr(used, taskId)}>` +
    `<div class="proc-chap-h"><h4>${escapeHtml(nameOf(project, codes, taskId))}</h4>` +
    (metaParts.length ? `<span class="proc-meta">${metaParts.join(' ・ ')}</span>` : '') +
    `</div>` +
    (d?.how?.trim() ? `<div class="proc-chap-purpose"><b>目的:</b> ${escapeHtml(d.how)}</div>` : '') +
    stepsHtml +
    `</article>`
  );
}

// 中工程 1 件分の節（ProcedureView の「配下末端の縦フローナビ」と同じ deriveProcedureNav 順）。
// mid 自身が末端(子なし)なら、ProcedureView と同様に mid 自身を単一の末端章として扱う。
function buildMidSection(project: Project, opts: HandbookOptions, codes: Record<Id, string>, used: Set<Id>, mid: ProcessTask): string {
  const core = project.core;
  const manual = project.manual;
  let navItems = deriveProcedureNav(core, mid.id, manual);
  if (navItems.length === 0 && isLeaf(core, mid.id)) {
    navItems = [
      {
        taskId: mid.id,
        name: mid.name,
        layer: 0,
        parallel: false,
        hasProcedure: (manual.procedures[mid.id]?.steps.length ?? 0) > 0,
      },
    ];
  }
  const crumb = ancestorsOf(core, mid.id)
    .map((p) => escapeHtml(nameOf(project, codes, p.id)))
    .join(' / ');
  const purpose = manual.procedures[mid.id]?.purpose?.trim();
  const body =
    navItems.length === 0
      ? `<div class="hb-noproc">この中工程には末端工程がありません。</div>`
      : navItems.map((n) => buildLeafChapter(project, opts, codes, used, n.taskId)).join('');

  return (
    `<section class="hb-section"${anchorAttr(used, mid.id)}>` +
    `<div class="proc-crumb">${crumb ? `${crumb} / ` : ''}<b>${escapeHtml(nameOf(project, codes, mid.id))}</b></div>` +
    `<h3>${escapeHtml(nameOf(project, codes, mid.id))}</h3>` +
    (purpose
      ? `<div class="proc-purpose"><span class="proc-purpose-tag">この工程群の目的</span>${escapeHtml(purpose)}</div>`
      : '') +
    body +
    `</section>`
  );
}

// 大工程 1 件分の章グループ。子(中工程候補)が無ければ自身を唯一の中工程として扱う（取りこぼし防止）。
function buildLargeChapter(project: Project, opts: HandbookOptions, codes: Record<Id, string>, used: Set<Id>, large: ProcessTask): string {
  const core = project.core;
  const midCandidates = byOrder(Object.values(core.tasks).filter((t) => t.parentId === large.id));
  const mids = midCandidates.length > 0 ? midCandidates : [large];
  const sections = mids.map((m) => buildMidSection(project, opts, codes, used, m)).join('');
  return (
    `<section class="hb-chapter"${anchorAttr(used, large.id)}>` +
    `<h2>${escapeHtml(nameOf(project, codes, large.id))}</h2>` +
    sections +
    `</section>`
  );
}

function buildMain(project: Project, opts: HandbookOptions, codes: Record<Id, string>, used: Set<Id>): string {
  const roots = byOrder(Object.values(project.core.tasks).filter((t) => !t.parentId));
  return `<main>${roots.map((large) => buildLargeChapter(project, opts, codes, used, large)).join('')}</main>`;
}

// ---- 資料台帳一覧 ----

function usageOf(manual: Manual, assetId: Id): { tasks: number; steps: number } {
  let tasks = 0;
  let steps = 0;
  for (const doc of Object.values(manual.procedures)) {
    const n = doc.steps.reduce(
      (acc, s) => acc + (s.refs.some((r) => r.kind === 'asset' && r.assetId === assetId) ? 1 : 0),
      0,
    );
    if (n > 0) {
      tasks += 1;
      steps += n;
    }
  }
  return { tasks, steps };
}

function buildAssetsSection(project: Project, opts: HandbookOptions): string {
  const assets = Object.values(project.manual.assets).sort((a, b) => a.name.localeCompare(b.name, 'ja'));
  if (assets.length === 0) return '';
  const rows = assets
    .map((a) => {
      const u = usageOf(project.manual, a.id);
      const loc = resolveLocator(a.locator, opts.aliases);
      const locHtml = loc.display ? locatorHtml(loc) : '（未設定）';
      return (
        `<div class="hb-asset">` +
        `<div class="hb-asset-name">${escapeHtml(a.name)}</div>` +
        (a.desc?.trim() ? `<div class="hb-asset-desc">${escapeHtml(a.desc)}</div>` : '') +
        `<div class="hb-asset-loc">${locHtml}</div>` +
        `<div class="hb-asset-use">使用: ${u.tasks}工程・${u.steps}ステップ</div>` +
        `</div>`
      );
    })
    .join('');
  return `<section class="hb-assets"><h2>資料台帳</h2>${rows}</section>`;
}

// ---- CSS（ライト :root トークンを値ごとインライン化 + .proc-* コンテンツ系を抽出 + シェル新規）。
// 出典: apps/desktop/src/styles.css:38-156 (:root トークン) / :6150-6869 (.procedure-view 配下)。
// 編集系（input/textarea/button/:hover/:focus）は含めない＝出力に編集アフォーダンスを持ち込まない。
const FONT_STACK =
  "'Inter', 'Meiryo UI', system-ui, -apple-system, 'Hiragino Kaku Gothic ProN', 'Yu Gothic UI', 'Noto Sans JP', Meiryo, sans-serif";
const FONT_MONO = "'Cascadia Code', ui-monospace, 'SF Mono', Consolas, 'Yu Gothic UI', monospace";

const HANDBOOK_CSS = `
*{box-sizing:border-box;}
body{margin:0;font-family:${FONT_STACK};color:#28303c;background:#eceef2;font-size:13px;line-height:1.6;}
a{color:#5271a5;}
h1,h2,h3,h4{font-weight:600;margin:0 0 8px;}
.hb-cover{padding:48px 32px 32px;background:#ffffff;border-bottom:1px solid #e2e6ec;}
.hb-cover h1{font-size:24px;margin:0 0 8px;}
.hb-cover-meta{font-size:12px;color:#5b6573;}
.hb-toc{padding:16px 32px;background:#f3f5f8;border-bottom:1px solid #e2e6ec;}
.hb-toc h2{font-size:15px;}
.hb-toc ul{margin:0 0 8px;padding-left:20px;}
.hb-toc li{margin:2px 0;}
.hb-toc a{text-decoration:none;}
.hb-toc a:hover{text-decoration:underline;}
.hb-flows{padding:16px 32px;}
.hb-flow-card{margin-bottom:16px;}
.hb-flow-scroll{overflow-x:auto;border:1px solid #e2e6ec;border-radius:10px;background:#ffffff;}
.hb-flow-scroll svg{display:block;}
main{padding:0 32px 32px;}
.hb-chapter{margin:32px 0;padding-top:8px;}
.hb-chapter h2{font-size:20px;border-bottom:2px solid #cdd4de;padding-bottom:8px;}
.hb-section{margin:20px 0 32px;}
.hb-section h3{font-size:16px;margin-top:0;}
.proc-crumb{font-size:12px;color:#5b6573;margin-bottom:4px;}
.proc-crumb b{color:#28303c;}
.proc-purpose{margin:12px 0 24px;padding:8px 12px;border-left:3px solid #5271a5;background:#e1e8f3;border-radius:0 7px 7px 0;max-width:60em;}
.proc-purpose-tag{display:block;font-size:11px;font-weight:600;color:#5271a5;letter-spacing:.06em;margin-bottom:4px;}
.hb-noproc{margin:8px 0;color:#5b6573;font-size:13px;font-style:italic;}

.proc-chap{margin:0 0 24px;}
.proc-chap-h{display:flex;align-items:baseline;gap:12px;border-bottom:1px solid #e2e6ec;padding-bottom:8px;flex-wrap:wrap;}
.proc-chap-h h4{font-size:15px;margin:0;}
.proc-meta{font-size:12px;color:#5b6573;}
.proc-chap-purpose{font-size:13px;color:#5b6573;margin:8px 0 12px;}
.proc-chap-purpose b{color:#28303c;font-weight:600;}

.proc-step{display:flex;gap:12px;padding:8px;border-bottom:1px dashed #e2e6ec;}
.proc-step:last-of-type{border-bottom:0;}
.proc-stepno{flex:none;width:24px;height:24px;border-radius:50%;margin-top:2px;background:#f3f5f8;border:1px solid #e2e6ec;display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:600;color:#5b6573;}
.proc-step-body{flex:1;min-width:0;}
.proc-step-top{font-size:13px;font-weight:600;color:#28303c;}
.proc-why{margin-top:1px;font-size:12px;color:#5b6573;}
.proc-why::before{content:'目的: ';color:#5271a5;font-weight:600;}

.proc-detail{margin:8px 0 0;font-size:13px;color:#28303c;max-width:58em;}
.proc-detail .md-p{margin:0 0 8px;}
.proc-detail .md-p:last-child{margin-bottom:0;}
.proc-detail .md-ul,.proc-detail .md-ol{margin:4px 0;padding-left:1.4em;}
.proc-detail code{font-family:${FONT_MONO};font-size:.92em;background:#f3f5f8;border:1px solid #e2e6ec;border-radius:4px;padding:0 4px;}

.proc-cond{margin-top:8px;padding:8px 12px;border:1px solid #d9b667;background:#f6ecc6;border-radius:7px;max-width:56em;}
.proc-cond-row{display:flex;align-items:center;gap:6px;flex-wrap:wrap;}
.proc-cond-if{font-weight:600;color:#7a5407;font-size:12px;flex:none;}
.proc-cond-when{font-weight:600;color:#7a5407;font-size:13px;}
.proc-cond-then{margin-top:4px;font-size:13px;color:#28303c;}
.proc-cond-then .md-p{margin:0 0 4px;}
.proc-cond-jump{display:flex;align-items:center;gap:6px;margin-top:4px;flex-wrap:wrap;}
.proc-cond-label{font-size:11px;color:#5b6573;}
.proc-c-link{color:#5271a5;text-decoration:underline;text-underline-offset:2px;font-size:12px;}
.proc-c-link.broken{color:#d6452f;text-decoration:none;}

.proc-chips{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px;}
.proc-chip{display:inline-flex;align-items:center;gap:4px;font-size:12px;border:1px solid #e2e6ec;border-radius:999px;padding:2px 10px;color:#5b6573;background:#ffffff;}
.proc-chip.ref{color:#0e8a8a;background:#d6efee;border-color:#8fcbc9;}
.proc-chip.io{color:#5271a5;background:#e1e8f3;border-color:#9bb0cf;}
.proc-chip.broken{color:#d6452f;background:#fbe4de;border-color:#e59683;}
.proc-chip a{color:inherit;text-decoration:underline;}

.proc-shots{display:flex;flex-wrap:wrap;gap:8px;margin-top:8px;}
.proc-shot{margin:0;max-width:260px;border:1px solid #e2e6ec;border-radius:7px;background:#ffffff;padding:4px;}
.proc-shot img{display:block;max-width:100%;height:auto;border-radius:4px;}
.proc-shot-missing{display:flex;align-items:center;justify-content:center;min-height:64px;padding:8px;font-size:12px;color:#d6452f;background:#fbe4de;border-radius:4px;}
.proc-shot figcaption{margin-top:4px;font-size:12px;color:#5b6573;}

.hb-assets{padding:16px 32px 32px;}
.hb-asset{padding:8px 0;border-bottom:1px solid #e2e6ec;}
.hb-asset-name{font-weight:600;}
.hb-asset-desc{font-size:12px;color:#5b6573;margin-top:2px;}
.hb-asset-loc{font-size:12px;color:#28303c;margin-top:2px;word-break:break-all;}
.hb-asset-use{font-size:11px;color:#5b6573;margin-top:2px;}

.hb-foot{padding:16px 32px 32px;font-size:11px;color:#5b6573;}

@media print {
  body{background:#ffffff;}
  .hb-flow-scroll{overflow:visible;border:none;}
  .hb-chapter + .hb-chapter{break-before:page;}
}
`;

// ---- 本体 ----

export function buildHandbookHtml(project: Project, opts: HandbookOptions): string {
  const codes = computeCodes(project.core);
  const now = opts.now ? new Date(opts.now) : new Date();
  const title = project.meta.title || 'プロジェクト';
  const used = new Set<Id>();

  const toc = buildToc(project, codes);
  const flows = buildFlowsSection(project);
  const main = buildMain(project, opts, codes, used);
  const assetsSection = buildAssetsSection(project, opts);
  const footer =
    `<footer class="hb-foot">生成: gantt-flow ／ ${localDateYmd(now)} ／ ` +
    `schemaVersion ${project.schemaVersion} ／ appVersion ${escapeHtml(project.meta.appVersion || '')}</footer>`;

  return (
    `<!doctype html><html lang="ja"><head><meta charset="utf-8">` +
    `<title>${escapeHtml(title)} 業務ハンドブック</title>` +
    `<style>${HANDBOOK_CSS}</style>` +
    `</head><body>` +
    `<header class="hb-cover"><h1>${escapeHtml(title)} 業務ハンドブック</h1>` +
    `<div class="hb-cover-meta">出力日: ${localDateYmd(now)} ／ gantt-flow で生成</div></header>` +
    toc +
    `<section class="hb-flows" id="hb-flows"><h2>業務フロー図</h2>` +
    (flows || `<div class="hb-noproc">フロー図はありません。</div>`) +
    `</section>` +
    main +
    assetsSection +
    footer +
    `</body></html>`
  );
}

