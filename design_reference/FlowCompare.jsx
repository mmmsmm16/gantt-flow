// gantt-flow As-Is / To-Be 比較 — 画面4 工程フロー比較（スイムレーン）
// 切替: 軸（工程順 / 時系列LT）・難易度色・差分強調。上下フローは横スクロール同期。
// 差分は To-Be 側に集約: 新規（As-Isに無い）/ 廃止ゴースト（As-Isにあったが無くなった）/ 移動（元位置ゴースト）。
// As-Is 側は現状をそのまま表示（差分注記なし）。
const { Segment: FcSegment } = window.GantFlowDesign_cece4e;

const FG = { railW: 84, x0: 96, colW: 124, taskW: 104, taskH: 32, laneH: 56, ctrlW: 52, dayW: 40, gap: 18 };

// 時系列目盛り: 営業日スケールから「週/月」の見やすい刻みを選ぶ（年月単位の業務にも対応）
function niceTickStep(span) {
  const target = Math.max(Math.ceil(span / 7), Math.ceil(80 / FG.dayW));
  const nice = [1, 2, 5, 10, 20, 40, 80, 120];
  return nice.find((s) => s >= target) || target;
}
function tickLabel(d, step) {
  if (d === 0) return '開始';
  if (step >= 20) return (Math.round((d / 20) * 10) / 10) + 'か月'; // 20営業日≒1か月
  if (step >= 5) return (d / 5) + '週';                            // 5営業日＝1週
  return d + '日';
}

function buildDiff(asIsG, toBeG) {
  const a = {}; asIsG.nodes.forEach((n) => { a[n.id] = n; });
  const b = {}; toBeG.nodes.forEach((n) => { b[n.id] = n; });
  const state = {};
  new Set([...Object.keys(a), ...Object.keys(b)]).forEach((id) => {
    const x = a[id], y = b[id];
    if (x && !y) state[id] = 'deleted';
    else if (!x && y) state[id] = 'added';
    else if (x.lane !== y.lane) state[id] = 'moved';
    else if (x.lt !== y.lt || x.diff !== y.diff) state[id] = 'changed';
    else state[id] = 'unchanged';
  });
  const deletedIds = Object.keys(a).filter((id) => !b[id]);
  return { state, a, b, deletedIds };
}

function effortOf(id, phase) {
  const r = window.GF_CMP.rows.find((x) => x.id === id);
  if (!r) return 0;
  return phase === 'asis' ? r.asIs.effort : r.toBe.effort;
}

function rectOf(n, axis, span) {
  const isTask = n.kind === 'task';
  const h = isTask ? FG.taskH : 26;
  const y = n.lane * FG.laneH + (FG.laneH - h) / 2;
  let x, w;
  if (axis === 'time') {
    const g = FG.gap;
    x = FG.x0 + (n.t0 || 0) * FG.dayW + (isTask ? g / 2 : 0);
    w = isTask ? Math.max(n.lt * FG.dayW - g, 26) : FG.ctrlW;
    if (n.kind === 'end') x = FG.x0 + span * FG.dayW - FG.ctrlW;
  } else {
    x = FG.x0 + n.col * FG.colW + (isTask ? 0 : (FG.taskW - FG.ctrlW) / 2);
    w = isTask ? FG.taskW : FG.ctrlW;
  }
  return { x, y, w, h, cx: x + w / 2, cy: y + h / 2 };
}

function CmpNode({ node, scenario, axis, diffColor, diffEmph, state, span, baseline }) {
  const isTask = node.kind === 'task';
  const tmode = axis === 'time';
  if (tmode && !isTask) return null; // 時系列では開始/終了マーカーを出さない（重なり防止）
  const r = rectOf(node, axis, span);

  const box = ['cmp-cnode', `k-${node.kind}`];
  if (tmode && isTask) box.push('tmode');
  if (isTask && diffColor && node.diff) box.push(`diff-${node.diff.toLowerCase()}`);
  if (!baseline) {
    if (state === 'added') box.push('added');
    if (state === 'moved') box.push('moved');
    if (state === 'changed') box.push('changed');
    if (isTask && diffEmph && state === 'unchanged') box.push('dim');
  }

  // 上部タグは To-Be 側のみ・工程順モードのみ（時系列は枠線/リングで状態表示）
  let tag = null;
  if (!baseline && !tmode) {
    if (state === 'added') tag = { t: '＋ 新規', cls: 'new' };
    else if (state === 'moved') tag = { t: '↕ 移動', cls: 'move' };
    else if (node.tag && (!diffEmph || state !== 'unchanged')) tag = { t: node.tag, cls: node.tagTone || 'accent' };
  }

  return (
    <div className="cmp-cnode-wrap" style={{ left: r.x, top: r.y, width: r.w, height: r.h }}>
      {tag ? <span className={`cmp-cnode-tag ${tag.cls}`}>{tag.t}</span> : null}
      <div className={box.join(' ')} title={`${node.name}${node.lt ? ' ・ LT ' + node.lt + '日' : ''}${node.diff ? ' ・ 難易度 ' + node.diff : ''}`}>
        <span className="nm">{node.name}</span>
      </div>
      {!tmode && isTask && node.lt ? <span className="cmp-cnode-lt">{node.lt}日</span> : null}
    </div>
  );
}

// To-Be 側に出す「廃止された工程」ゴースト（As-Is にあったが To-Be で無くなった）
function RemovedGhost({ node, axis, span, tmode }) {
  if (tmode && node.kind !== 'task') return null;
  const r = rectOf(node, axis, span);
  return (
    <div className="cmp-cnode-wrap" style={{ left: r.x, top: r.y, width: r.w, height: r.h }}>
      {!tmode ? <span className="cmp-cnode-tag del">廃止</span> : null}
      <div className="cmp-cnode deleted" title={`${node.name}（To-Beで廃止）`}>
        <span className="nm">{node.name}</span>
      </div>
    </div>
  );
}

function Strip({ graph, lanes, scenario, axis, diffColor, diffEmph, diff, width, tickStep, meta }) {
  const tmode = axis === 'time';
  const baseline = scenario === 'asis';
  const span = graph.span;
  const canvasH = lanes.length * FG.laneH;
  const topPad = tmode ? 36 : 14;
  const byId = {}; graph.nodes.forEach((n) => { byId[n.id] = n; });

  const ticks = [];
  if (tmode) { for (let d = 0; d <= span + 0.001; d += tickStep) ticks.push(d); }

  return (
    <div className="cmp-strip2">
      <div className="cmp-strip2-head">
        <span className={`cmp-flowstrip-tag ${scenario}`}>{scenario === 'asis' ? 'As-Is（現状）' : 'To-Be（改善後）'}</span>
        <span className="cmp-flowstrip-meta">{meta}</span>
      </div>
      <div className="cmp-flowgrid" style={{ width, height: canvasH + topPad }}>
        {tmode ? (
          <div className="cmp-ruler" style={{ position: 'absolute', top: 14, left: 0, width, height: 18 }}>
            {ticks.map((d) => <div key={d} className="cmp-ruler-tick" style={{ left: FG.x0 + d * FG.dayW }}><span>{tickLabel(d, tickStep)}</span></div>)}
          </div>
        ) : null}
        <div style={{ position: 'absolute', top: topPad, left: 0, right: 0, height: canvasH }}>
          {lanes.map((_, i) => i % 2 === 1 ? <div key={`s${i}`} className="cmp-lane-row stripe" style={{ top: i * FG.laneH, height: FG.laneH }} /> : null)}
          {lanes.map((_, i) => i > 0 ? <div key={`l${i}`} className="cmp-lane-line" style={{ top: i * FG.laneH }} /> : null)}

          <svg className="cmp-flow-edges" width={width} height={canvasH}>
            <defs>
              <marker id={`fc2-arrow-${scenario}`} viewBox="0 0 10 10" refX="5" refY="5" markerWidth="7.5" markerHeight="7.5" orient="auto-start-reverse">
                <path d="M0,0 L10,5 L0,10 z" fill="var(--arrow)" />
              </marker>
            </defs>
            {/* 移動の元位置→新位置リンク（To-Be のみ） */}
            {!baseline ? graph.nodes.map((n) => {
              if (diff.state[n.id] !== 'moved' || (tmode && n.kind !== 'task')) return null;
              const old = diff.a[n.id]; const nr = rectOf(n, axis, span);
              const oy = old.lane * FG.laneH + FG.laneH / 2;
              return <line key={`mv-${n.id}`} x1={nr.cx} y1={oy} x2={nr.cx} y2={nr.cy} stroke="var(--amber)" strokeWidth="1.4" strokeDasharray="3 3" />;
            }) : null}
            {graph.edges.map(([from, to]) => {
              if (tmode && (byId[from].kind !== 'task' || byId[to].kind !== 'task')) return null;
              const a = rectOf(byId[from], axis, span); const b = rectOf(byId[to], axis, span);
              const sx = a.x + a.w, sy = a.cy, ty = b.cy;
              const endX = b.x - 5;             // 矢じりの隙間
              // 縦移動はターゲット直前のレーン間ギャップで行い、ノードに重ならないようにする
              const vx = sy === ty ? endX : Math.max(sx + 8, b.x - 12);
              const dd = sy === ty
                ? `M ${sx} ${sy} L ${endX} ${ty}`
                : `M ${sx} ${sy} L ${vx} ${sy} L ${vx} ${ty} L ${endX} ${ty}`;
              const dim = !baseline && diffEmph && diff.state[from] === 'unchanged' && diff.state[to] === 'unchanged';
              return <path key={`${from}-${to}`} d={dd} stroke="var(--edge)" strokeWidth="1.5" fill="none" opacity={dim ? 0.28 : 1} markerEnd={`url(#fc2-arrow-${scenario})`} />;
            })}
          </svg>

          {/* 移動の元位置ゴースト（To-Be のみ） */}
          {!baseline ? graph.nodes.map((n) => {
            if (diff.state[n.id] !== 'moved' || (tmode && n.kind !== 'task')) return null;
            const old = diff.a[n.id]; const nr = rectOf(n, axis, span);
            const gy = old.lane * FG.laneH + (FG.laneH - FG.taskH) / 2;
            return (
              <div key={`gh-${n.id}`} className="cmp-ghost" style={{ left: nr.x, top: gy, width: nr.w, height: FG.taskH }}>
                <span>元: {lanes[old.lane]}</span>
              </div>
            );
          }) : null}

          {/* 廃止された工程ゴースト（To-Be のみ） */}
          {!baseline ? diff.deletedIds.map((id) => (
            <RemovedGhost key={`rm-${id}`} node={diff.a[id]} axis={axis} span={span} tmode={tmode} />
          )) : null}

          {graph.nodes.map((n) => (
            <CmpNode key={n.id} node={n} scenario={scenario} axis={axis} diffColor={diffColor} diffEmph={diffEmph} state={diff.state[n.id]} span={span} baseline={baseline} />
          ))}

          {lanes.map((name, i) => (
            <div key={name} className="cmp-lane-label" style={{ top: i * FG.laneH, height: FG.laneH, width: FG.railW }}>{name}</div>
          ))}
        </div>
      </div>
    </div>
  );
}

function FlowCompare() {
  const { flow, totals } = window.GF_CMP;
  const l = totals.lt;
  const [level, setLevel] = React.useState('medium');
  const [axis, setAxis] = React.useState('order');
  const [diffColor, setDiffColor] = React.useState(true);
  const [diffEmph, setDiffEmph] = React.useState(true);
  const lv = flow.levels[level];
  const diff = React.useMemo(() => buildDiff(lv.asIs, lv.toBe), [level]);

  const maxSpan = Math.max(lv.asIs.span, lv.toBe.span);
  const tickStep = niceTickStep(maxSpan);

  const width = axis === 'time'
    ? FG.x0 + maxSpan * FG.dayW + 48
    : FG.x0 + (Math.max(lv.asIs.cols, lv.toBe.cols) - 1) * FG.colW + FG.taskW + 28;

  return (
    <div className="cmp-flowcmp">
      <div className="cmp-flowcmp-head">
        <h3 className="cmp-flowcmp-title">工程フロー比較 <span className="cmp-flowcmp-sub">As-Is / To-Be ・ スイムレーン</span></h3>
      </div>

      <div className="cmp-flow-controls">
        <span className="ctl"><span className="ctl-label">粒度</span>
          <FcSegment options={[{ value: 'large', label: '大' }, { value: 'medium', label: '中' }, { value: 'small', label: '小' }]} value={level} onChange={setLevel} /></span>
        <span className="ctl"><span className="ctl-label">横軸</span>
          <FcSegment options={[{ value: 'order', label: '工程順' }, { value: 'time', label: '時系列(LT)' }]} value={axis} onChange={setAxis} /></span>
        <span className="ctl"><span className="ctl-label">難易度色</span>
          <FcSegment options={[{ value: 'on', label: 'ON' }, { value: 'off', label: 'OFF' }]} value={diffColor ? 'on' : 'off'} onChange={(v) => setDiffColor(v === 'on')} /></span>
        <span className="ctl"><span className="ctl-label">差分強調</span>
          <FcSegment options={[{ value: 'on', label: 'ON' }, { value: 'off', label: 'OFF' }]} value={diffEmph ? 'on' : 'off'} onChange={(v) => setDiffEmph(v === 'on')} /></span>
        <span className="push" />
        <span className="cmp-flowcmp-legend">
          {diffColor ? <React.Fragment>
            <span className="cmp-leg"><span className="cmp-auto-dot h" />高</span>
            <span className="cmp-leg"><span className="cmp-auto-dot m" />中</span>
            <span className="cmp-leg"><span className="cmp-auto-dot l" />低</span>
          </React.Fragment> : null}
        </span>
      </div>

      <div className="cmp-diff-legend">
        <span className="dl">As-Is は現状をそのまま表示</span>
        <span className="dl new">＋ 新規（As-Isに無い工程）</span>
        <span className="dl del">廃止（To-Beで無くなった）</span>
        <span className="dl move">↕ 移動（担当変更・元位置をゴースト）</span>
        <span className="dl unc">変化なし（淡色）</span>
      </div>

      <div className="cmp-flowsync">
        <Strip graph={lv.asIs} lanes={lv.lanes} scenario="asis" axis={axis} diffColor={diffColor} diffEmph={diffEmph} diff={diff} width={width} tickStep={tickStep}
          meta={<span>リードタイム <b>{l.asIs}日</b> ・ 直列・停滞大</span>} />
        <Strip graph={lv.toBe} lanes={lv.lanes} scenario="tobe" axis={axis} diffColor={diffColor} diffEmph={diffEmph} diff={diff} width={width} tickStep={tickStep}
          meta={<span>リードタイム <b>{l.toBe}日</b> <span className="good">−14日</span> ・ 並行化＋電子承認</span>} />
      </div>

      <div className="cmp-callout">
        <b>比較の見方：</b>As-Is は現状フローをそのまま表示。差分注記は <b>To-Be 側に集約</b>し、<b>新規</b>（As-Isに無い工程）・<b>廃止</b>（無くなった工程をゴースト表示）・<b>移動</b>（担当変更・元位置をゴースト）を明示。<b>難易度色</b>でノードを塗り分け、<b>差分強調</b>で据え置き工程を淡く。<b>時系列軸</b>で停滞（待ち）が見える。上下は<b>横スクロール同期</b>。
      </div>
    </div>
  );
}

window.FlowCompare = FlowCompare;
