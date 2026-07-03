// gantt-flow As-Is / To-Be 比較 — 例データ（製造業・設計〜試作フロー）
// 工数(touch time)=時間[h]／リードタイム(LT)=日／1日=8h で換算／待ち=LT−工数。
// 改善アプローチ: ベテランの暗黙知を形式知化し、高難度(H)業務を中(M)・低(L)へ。
(function () {
  const HPD = 8; // 1 営業日 = 8h

  // 業務難易度（H=ベテランのみ / M=中堅 / L=誰でも）
  const DIFF = [
    { key: 'H', label: '高', sub: 'ベテランのみ', cls: 'h', color: 'var(--diff-h)' },
    { key: 'M', label: '中', sub: '中堅',         cls: 'm', color: 'var(--diff-m)' },
    { key: 'L', label: '低', sub: '誰でも',       cls: 'l', color: 'var(--diff-l)' },
  ];

  // 工程ごとの As-Is / To-Be（依頼の表に準拠 ＋ 難易度）
  const rows = [
    { id: 'p1', name: '要件確認',          owner: '設計部',     asIs: { effort: 4,  ltDays: 1, diff: 'M' }, toBe: { effort: 4,  ltDays: 1, diff: 'M' }, change: '据え置き',           basis: '' },
    { id: 'p2', name: '基本設計',          owner: '設計部',     asIs: { effort: 16, ltDays: 3, diff: 'H' }, toBe: { effort: 16, ltDays: 3, diff: 'H' }, change: '据え置き',           basis: '構想設計は高度判断が必要で、形式知化の対象外と判断。' },
    { id: 'p3', name: '設計レビュー・承認', owner: '管理部',     asIs: { effort: 2,  ltDays: 5, diff: 'M' }, toBe: { effort: 2,  ltDays: 1, diff: 'L' }, change: '電子承認で待ち削減', basis: 'チェック観点を10項目のリストに形式知化し電子承認に移行。判断基準が明文化され若手でも一次承認が可能。承認待ち 5日→1日。' },
    { id: 'p4', name: '部品手配',          owner: '調達部',     asIs: { effort: 3,  ltDays: 7, diff: 'M' }, toBe: { effort: 3,  ltDays: 2, diff: 'L' }, change: '設計と並行・前倒し', basis: '発注先選定を標準部品テンプレ化し、基本設計と並行で前倒し発注。手配リードタイム 7日→2日。' },
    { id: 'p5', name: '試作製作',          owner: '製造部',     asIs: { effort: 20, ltDays: 4, diff: 'H' }, toBe: { effort: 20, ltDays: 4, diff: 'M' }, change: '手順書化',           basis: 'ベテランの段取りノウハウを作業手順書＋動画にして中堅へ移譲。難易度 高→中。' },
    { id: 'p6', name: '検査',              owner: '品質保証部', asIs: { effort: 4,  ltDays: 2, diff: 'H' }, toBe: { effort: 1,  ltDays: 1, diff: 'L' }, change: '検査一部自動・基準明確化', basis: '画像検査を一部自動化し、合否基準を数値で明文化。熟練の目視判断が不要になり難易度 高→低、工数 4h→1h。' },
  ];

  // ── 集計 ──
  // 工数は総和。LT は「クリティカルパス」で、権威値（As-Is 22日 → To-Be 8日）を採用する。
  //   ※ To-Be は per-row LT の単純和（12日）より小さい。部品手配を設計と並行化し、
  //     承認を前倒ししたことでクリティカルパスから外れるため（＝並行化の効果）。
  const sum = (sel) => rows.reduce((s, r) => s + sel(r), 0);
  const effAsIs = sum((r) => r.asIs.effort);   // 49h
  const effToBe = sum((r) => r.toBe.effort);   // 46h
  const ltAsIs  = 22;                          // クリティカルパス（権威値）
  const ltToBe  = 8;                           // クリティカルパス（並行化反映・権威値）
  const ltRowSumToBe = sum((r) => r.toBe.ltDays); // 12（参考: 単純和）

  // 待ち時間（日）= LT − 工数（時間→日換算）
  const waitAsIs = ltAsIs - effAsIs / HPD;     // 15.875日
  const waitToBe = ltToBe - effToBe / HPD;     // 2.25日
  const workAsIs = effAsIs / HPD;
  const workToBe = effToBe / HPD;

  // 難易度の構成（工程数ベース／工数ベース）
  const diffCount = (phase) => {
    const c = { H: 0, M: 0, L: 0 };
    rows.forEach((r) => { c[r[phase].diff] += 1; });
    return c;
  };
  const diffEffort = (phase) => {
    const c = { H: 0, M: 0, L: 0 };
    rows.forEach((r) => { c[r[phase].diff] += r[phase].effort; });
    return c;
  };

  // 工程別の待ち削減（日）
  const waitOf = (s) => s.ltDays - s.effort / HPD;
  const perRow = rows.map((r) => ({
    ...r,
    waitAsIs: waitOf(r.asIs),
    waitToBe: waitOf(r.toBe),
    waitCut: waitOf(r.asIs) - waitOf(r.toBe),
  }));

  // ── 工程フロー（スイムレーン）As-Is / To-Be ──
  // lane: 0=設計部 1=管理部 2=調達部 3=製造部 4=品質保証部
  const flowLanes = ['設計部', '管理部', '調達部', '製造部', '品質保証部'];
  const flowAsIs = {
    nodes: [
      { id: 's',  kind: 'start', name: '開始', lane: 0, col: 0, t0: 0 },
      { id: 'p1', kind: 'task',  name: '要件確認', lane: 0, col: 1, diff: 'M', lt: 1, t0: 0 },
      { id: 'p2', kind: 'task',  name: '基本設計', lane: 0, col: 2, diff: 'H', lt: 3, t0: 1 },
      { id: 'p3', kind: 'task',  name: '設計レビュー・承認', lane: 1, col: 3, diff: 'M', lt: 5, t0: 4, wait: '待ち5日' },
      { id: 'p4', kind: 'task',  name: '部品手配', lane: 2, col: 4, diff: 'M', lt: 7, t0: 9, wait: '待ち7日' },
      { id: 'p5', kind: 'task',  name: '試作製作', lane: 3, col: 5, diff: 'H', lt: 4, t0: 16 },
      { id: 'xDel', kind: 'task', name: '実績台帳記入', lane: 1, col: 6, diff: 'M', lt: 2, t0: 20 },
      { id: 'p6', kind: 'task',  name: '検査', lane: 4, col: 6, diff: 'H', lt: 2, t0: 20 },
      { id: 'e',  kind: 'end',   name: '完了', lane: 4, col: 7, t0: 22 },
    ],
    edges: [['s','p1'],['p1','p2'],['p2','p3'],['p3','p4'],['p4','p5'],['p5','p6'],['p6','e'],['p5','xDel'],['xDel','e']],
    cols: 8, span: 22,
  };
  const flowToBe = {
    nodes: [
      { id: 's',  kind: 'start', name: '開始', lane: 0, col: 0, t0: 0 },
      { id: 'p1', kind: 'task',  name: '要件確認', lane: 0, col: 1, diff: 'M', lt: 1, t0: 0 },
      { id: 'p2', kind: 'task',  name: '基本設計', lane: 0, col: 2, diff: 'H', lt: 3, t0: 1 },
      { id: 'p4', kind: 'task',  name: '部品手配', lane: 2, col: 2, diff: 'L', lt: 2, t0: 1, tag: '並行化', tagTone: 'accent' },
      { id: 'p3', kind: 'task',  name: '設計レビュー・承認', lane: 0, col: 3, diff: 'L', lt: 1, t0: 4, tag: '電子承認', tagTone: 'good' },
      { id: 'xNew', kind: 'task', name: '検査自動化設定', lane: 4, col: 3, diff: 'L', lt: 1, t0: 4 },
      { id: 'p5', kind: 'task',  name: '試作製作', lane: 3, col: 4, diff: 'M', lt: 4, t0: 4 },
      { id: 'p6', kind: 'task',  name: '検査', lane: 4, col: 5, diff: 'L', lt: 1, t0: 7, tag: '−1日', tagTone: 'good' },
      { id: 'e',  kind: 'end',   name: '完了', lane: 4, col: 6, t0: 8 },
    ],
    edges: [['s','p1'],['p1','p2'],['p2','p3'],['p3','p5'],['p1','p4'],['p4','p5'],['xNew','p6'],['p5','p6'],['p6','e']],
    cols: 7, span: 8,
  };

  // ── 大工程ビュー（フェーズ粒度・2レーン） ──
  const largeLanes = ['設計', '製作・検査'];
  const flowLargeAsIs = {
    nodes: [
      { id: 's',  kind: 'start', name: '開始', lane: 0, col: 0, t0: 0 },
      { id: 'g1', kind: 'task',  name: '設計', lane: 0, col: 1, diff: 'H', lt: 9, t0: 0 },
      { id: 'g2', kind: 'task',  name: '製作・検査', lane: 1, col: 2, diff: 'H', lt: 13, t0: 9 },
      { id: 'e',  kind: 'end',   name: '完了', lane: 1, col: 3, t0: 22 },
    ],
    edges: [['s', 'g1'], ['g1', 'g2'], ['g2', 'e']],
    cols: 4, span: 22,
  };
  const flowLargeToBe = {
    nodes: [
      { id: 's',  kind: 'start', name: '開始', lane: 0, col: 0, t0: 0 },
      { id: 'g1', kind: 'task',  name: '設計', lane: 0, col: 1, diff: 'H', lt: 4, t0: 0 },
      { id: 'g2', kind: 'task',  name: '製作・検査', lane: 1, col: 2, diff: 'M', lt: 4, t0: 4 },
      { id: 'e',  kind: 'end',   name: '完了', lane: 1, col: 3, t0: 8 },
    ],
    edges: [['s', 'g1'], ['g1', 'g2'], ['g2', 'e']],
    cols: 4, span: 8,
  };

  // ── 小工程ビュー（基本設計・検査を細分化） ──
  const flowSmallAsIs = {
    nodes: [
      { id: 's',   kind: 'start', name: '開始', lane: 0, col: 0, t0: 0 },
      { id: 'p1',  kind: 'task',  name: '要件確認', lane: 0, col: 1, diff: 'M', lt: 1, t0: 0 },
      { id: 'p2a', kind: 'task',  name: '構想設計', lane: 0, col: 2, diff: 'H', lt: 2, t0: 1 },
      { id: 'p2b', kind: 'task',  name: '詳細設計', lane: 0, col: 3, diff: 'H', lt: 1, t0: 3 },
      { id: 'p3',  kind: 'task',  name: '設計レビュー・承認', lane: 1, col: 4, diff: 'M', lt: 5, t0: 4 },
      { id: 'p4',  kind: 'task',  name: '部品手配', lane: 2, col: 5, diff: 'M', lt: 7, t0: 9 },
      { id: 'p5',  kind: 'task',  name: '試作製作', lane: 3, col: 6, diff: 'H', lt: 4, t0: 16 },
      { id: 'p6a', kind: 'task',  name: '寸法検査', lane: 4, col: 7, diff: 'H', lt: 1, t0: 20 },
      { id: 'p6b', kind: 'task',  name: '機能検査', lane: 4, col: 8, diff: 'H', lt: 1, t0: 21 },
      { id: 'e',   kind: 'end',   name: '完了', lane: 4, col: 9, t0: 22 },
    ],
    edges: [['s','p1'],['p1','p2a'],['p2a','p2b'],['p2b','p3'],['p3','p4'],['p4','p5'],['p5','p6a'],['p6a','p6b'],['p6b','e']],
    cols: 10, span: 22,
  };
  const flowSmallToBe = {
    nodes: [
      { id: 's',   kind: 'start', name: '開始', lane: 0, col: 0, t0: 0 },
      { id: 'p1',  kind: 'task',  name: '要件確認', lane: 0, col: 1, diff: 'M', lt: 1, t0: 0 },
      { id: 'p2a', kind: 'task',  name: '構想設計', lane: 0, col: 2, diff: 'H', lt: 2, t0: 1 },
      { id: 'p2b', kind: 'task',  name: '詳細設計', lane: 0, col: 3, diff: 'M', lt: 1, t0: 3 },
      { id: 'p4',  kind: 'task',  name: '部品手配', lane: 2, col: 2, diff: 'L', lt: 2, t0: 1, tag: '並行化', tagTone: 'accent' },
      { id: 'p3',  kind: 'task',  name: '設計レビュー・承認', lane: 0, col: 4, diff: 'L', lt: 1, t0: 4, tag: '電子承認', tagTone: 'good' },
      { id: 'xNew', kind: 'task', name: '検査自動化設定', lane: 4, col: 4, diff: 'L', lt: 1, t0: 4 },
      { id: 'p5',  kind: 'task',  name: '試作製作', lane: 3, col: 5, diff: 'M', lt: 4, t0: 4 },
      { id: 'p6a', kind: 'task',  name: '寸法検査', lane: 4, col: 6, diff: 'L', lt: 1, t0: 7, tag: '自動化', tagTone: 'good' },
      { id: 'e',   kind: 'end',   name: '完了', lane: 4, col: 7, t0: 8 },
    ],
    edges: [['s','p1'],['p1','p2a'],['p2a','p2b'],['p2b','p3'],['p3','p5'],['p1','p4'],['p4','p5'],['xNew','p6a'],['p5','p6a'],['p6a','e']],
    cols: 8, span: 8,
  };

  window.GF_CMP = {
    HPD, DIFF, rows, perRow,
    totals: {
      effort: { asIs: effAsIs, toBe: effToBe, delta: effToBe - effAsIs, unit: 'h' },
      lt:     { asIs: ltAsIs,  toBe: ltToBe,  delta: ltToBe - ltAsIs,   unit: '日', rowSumToBe: ltRowSumToBe },
      wait:   { asIs: waitAsIs, toBe: waitToBe, work: { asIs: workAsIs, toBe: workToBe } },
      diff:   {
        count:  { asIs: diffCount('asIs'),  toBe: diffCount('toBe') },
        effort: { asIs: diffEffort('asIs'), toBe: diffEffort('toBe') },
        leafCount: rows.length, totalEffort: { asIs: effAsIs, toBe: effToBe },
      },
    },
    flow: {
      lanes: flowLanes, asIs: flowAsIs, toBe: flowToBe,
      levels: {
        large:  { lanes: largeLanes, asIs: flowLargeAsIs, toBe: flowLargeToBe },
        medium: { lanes: flowLanes,  asIs: flowAsIs,       toBe: flowToBe },
        small:  { lanes: flowLanes,  asIs: flowSmallAsIs,  toBe: flowSmallToBe },
      },
    },
    fmt: {
      pct: (delta, base) => (base === 0 ? '0%' : (delta > 0 ? '+' : '') + Math.round((delta / base) * 100) + '%'),
      signed: (v, unit) => (v > 0 ? '+' : v < 0 ? '−' : '±') + Math.abs(Math.round(v * 10) / 10) + unit,
      days: (v) => (Math.round(v * 10) / 10) + '日',
    },
  };
})();
