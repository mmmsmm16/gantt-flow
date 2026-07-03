// gantt-flow As-Is / To-Be 比較 — 共通の可視化部品
// 既存サマリの「横棒バー＋積み上げ＋ドット凡例」の語彙に合わせる。

const { Tabs: CbTabs, Clock: CbClock } = window.GantFlowDesign_cece4e;

// As-Is | To-Be | Δ の下線タブ
function PhaseTabs({ value, onChange }) {
  return (
    <CbTabs
      options={[{ value: 'asis', label: 'As-Is' }, { value: 'tobe', label: 'To-Be' }, { value: 'delta', label: 'Δ（差分）' }]}
      value={value}
      onChange={onChange}
    />
  );
}

// Δ ピル（良化=緑/悪化=赤/据え置き=中間）。減少が良いか悪いかは betterWhenDown で決める。
function DeltaPill({ delta, base, unit, betterWhenDown = true, small = false }) {
  const F = window.GF_CMP.fmt;
  let tone = 'flat';
  if (delta !== 0) {
    const improved = betterWhenDown ? delta < 0 : delta > 0;
    tone = improved ? 'good' : 'bad';
  }
  const arrow = delta < 0 ? '▼' : delta > 0 ? '▲' : '–';
  return (
    <span className={`cmp-delta ${tone} ${small ? 'cmp-delta-sm' : ''}`.trim()}>
      <span>{arrow} {F.signed(delta, unit)}</span>
      {base ? <span className="pct">{F.pct(delta, base)}</span> : null}
    </span>
  );
}

// 主要数値 As-Is → To-Be
function Headline({ from, to, unit, big }) {
  return (
    <div className={`cmp-headline ${big ? 'big' : ''}`.trim()}>
      <span className="cmp-from">{from}{unit}</span>
      <span className="cmp-arrow">→</span>
      <span className="cmp-to">{to}<span className="unit">{unit}</span></span>
    </div>
  );
}

// 比較バー（As-Is / To-Be の 2 段）。共有スケールで短縮が一目で分かる。
function CompareBars({ asIs, toBe, unit, max }) {
  const m = max || Math.max(asIs, toBe, 1);
  return (
    <div className="cmp-bars">
      <div className="cmp-bar-row">
        <span className="cmp-bar-tag">As-Is</span>
        <span className="cmp-bar-track"><span className="cmp-bar-fill asis" style={{ width: `${(asIs / m) * 100}%` }} /></span>
        <span className="cmp-bar-val">{asIs}{unit}</span>
      </div>
      <div className="cmp-bar-row">
        <span className="cmp-bar-tag">To-Be</span>
        <span className="cmp-bar-track"><span className="cmp-bar-fill tobe" style={{ width: `${(toBe / m) * 100}%` }} /></span>
        <span className="cmp-bar-val">{toBe}{unit}</span>
      </div>
    </div>
  );
}

// 待ち内訳バー（実作業 vs 待ち）。待ち比率が高いほど赤く。
function WaitBreakdown({ workDays, waitDays, label }) {
  const total = workDays + waitDays;
  const waitPct = total ? (waitDays / total) * 100 : 0;
  const F = window.GF_CMP.fmt;
  return (
    <div className="cmp-split-row" title={`${label}: 実作業 ${F.days(workDays)} / 待ち ${F.days(waitDays)}`}>
      <span className="cmp-bar-tag">{label}</span>
      <span className="cmp-split-track">
        <span className="cmp-split-work" style={{ width: `${total ? (workDays / total) * 100 : 0}%` }} />
        <span className={`cmp-split-wait ${waitPct >= 50 ? 'hi' : 'lo'}`} style={{ width: `${waitPct}%` }} />
      </span>
    </div>
  );
}

// 業務難易度 積み上げバー（H/M/L）。mode='count'（工程数）or 'effort'（工数h）。
function DiffStack({ counts, total, unit }) {
  const DIFF = window.GF_CMP.DIFF;
  return (
    <span className="cmp-auto-track">
      {DIFF.map((d) => {
        const n = counts[d.key] || 0;
        const pct = total ? (n / total) * 100 : 0;
        if (!pct) return null;
        return (
          <span key={d.key} className="cmp-auto-seg" style={{ width: `${pct}%`, background: d.color }} title={`${d.label}（${d.sub}）: ${n}${unit || ''}`}>
            {pct >= 12 ? <span className="seg-lab">{n}{unit || ''}</span> : null}
          </span>
        );
      })}
    </span>
  );
}

function DiffLegend() {
  const DIFF = window.GF_CMP.DIFF;
  return (
    <ul className="cmp-auto-legend">
      {DIFF.map((d) => (
        <li key={d.key}><span className={`cmp-auto-dot ${d.cls}`} />{d.label}・{d.sub}</li>
      ))}
    </ul>
  );
}

// 工程差分テーブル（工数 As-Is→To-Be / LT As-Is→To-Be / 待ち削減）
function DiffTable() {
  const { perRow, fmt } = window.GF_CMP;
  const maxCut = Math.max(...perRow.map((r) => r.waitCut), 1);
  return (
    <div className="cmp-table-wrap">
      <div className="cmp-table-cap">工程別の差分</div>
      <table className="cmp-table">
        <thead>
          <tr>
            <th>工程</th>
            <th>担当</th>
            <th className="num">工数</th>
            <th className="num">リードタイム</th>
            <th className="num">待ち削減</th>
          </tr>
        </thead>
        <tbody>
          {perRow.map((r) => (
            <tr key={r.id}>
              <td>{r.name}</td>
              <td className="flow">{r.owner}</td>
              <td className="num flow">{r.asIs.effort}h <b>→ {r.toBe.effort}h</b></td>
              <td className="num flow">{r.asIs.ltDays}日 <b>→ {r.toBe.ltDays}日</b>{r.id === 'p4' ? <span style={{ color: 'var(--accent)', fontWeight: 'var(--fw-strong)' }}> 並行</span> : null}</td>
              <td className="num">
                {r.waitCut > 0.05 ? (
                  <span className="cmp-cut-bar">
                    <span className="cmp-cut-track"><span className="cmp-cut-fill" style={{ width: `${(r.waitCut / maxCut) * 100}%` }} /></span>
                    <span style={{ color: 'var(--ok)', fontWeight: 'var(--fw-strong)' }}>−{fmt.days(r.waitCut).replace('日', '')}日</span>
                  </span>
                ) : <span className="cmp-cut-zero">±0</span>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div style={{ fontSize: 'var(--fs-caption)', color: 'var(--faint)', padding: 'var(--sp-2) var(--sp-3)', borderTop: '1px solid var(--line-faint)', lineHeight: 1.6 }}>
        ※ To-Be の総リードタイムは <b style={{ color: 'var(--ink)' }}>8日</b>（各行の単純和 {window.GF_CMP.totals.lt.rowSumToBe}日より短い）。部品手配を設計と<b style={{ color: 'var(--ink)' }}>並行化</b>し、クリティカルパスから外したため。
      </div>
    </div>
  );
}

Object.assign(window, { PhaseTabs, DeltaPill, Headline, CompareBars, WaitBreakdown, DiffStack, DiffLegend, DiffTable });
