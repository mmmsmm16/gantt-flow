// gantt-flow As-Is / To-Be 比較 — 画面1（工数 / LT を左右2カラムで対等に対比）
const { Button: BModButton, Segment: BSegment, Clock: BClock, ChartBar: BChart, Sparkles: BSpark, Download: BDownload } = window.GantFlowDesign_cece4e;

function SummaryModal() {
  const { totals } = window.GF_CMP;
  const [phase, setPhase] = React.useState('delta');
  const [diffMode, setDiffMode] = React.useState('count'); // count | effort
  const e = totals.effort, l = totals.lt, w = totals.wait, d = totals.diff;

  const counts = diffMode === 'count' ? d.count : d.effort;
  const total = diffMode === 'count' ? d.leafCount : d.totalEffort;
  const unit = diffMode === 'count' ? '' : 'h';
  const hAsIs = (diffMode === 'count' ? d.count.asIs.H : d.effort.asIs.H);
  const hToBe = (diffMode === 'count' ? d.count.toBe.H : d.effort.toBe.H);

  return (
    <div className="cmp-root">
      <div className="cmp-appbg">
        <div className="cmp-appbg-toolbar"><span className="cmp-appbg-brand">gantt-flow</span></div>
        <div className="cmp-appbg-body"><div className="cmp-ghost-pane" /><div className="cmp-ghost-pane" /></div>
      </div>

      <div className="cmp-backdrop">
        <div className="cmp-modal" style={{ '--cmp-modal-w': '1080px' }}>
          <div className="cmp-modal-head">
            <h3 className="cmp-modal-title">改善効果サマリ <span className="cmp-modal-sub">受注〜試作フロー ・ As-Is / To-Be</span></h3>
            <BModButton size="sm"><BDownload /><span style={{ marginLeft: 6 }}>書き出し</span></BModButton>
            <button className="cmp-x" aria-label="閉じる">×</button>
          </div>

          <div className="cmp-tabrow">
            <window.PhaseTabs value={phase} onChange={setPhase} />
            <span className="cmp-tab-legend">
              <span className="cmp-leg"><span className="sw asis" />As-Is</span>
              <span className="cmp-leg"><span className="sw tobe" />To-Be</span>
            </span>
          </div>

          <div className="cmp-body">
            {/* 2軸を左右で対等に */}
            <div className="cmp-cards layout-b">
              {/* 工数（左） */}
              <section className="cmp-card is-feature">
                <div className="cmp-axis-head">
                  <span className="cmp-card-icon"><BClock /></span>
                  <span className="ax-title">工数</span>
                  <span className="ax-sub">タッチタイム・総和</span>
                  <span style={{ marginLeft: 'auto' }}><window.DeltaPill delta={e.delta} base={e.asIs} unit="h" /></span>
                </div>
                <window.Headline from={e.asIs} to={e.toBe} unit="h" big />
                <window.CompareBars asIs={e.asIs} toBe={e.toBe} unit="h" />
                <div className="cmp-auto-delta">設計・試作の手作業は据え置き。検査の自動化で −3h。</div>
              </section>

              {/* リードタイム（右） */}
              <section className="cmp-card is-feature">
                <div className="cmp-axis-head">
                  <span className="cmp-card-icon"><BChart /></span>
                  <span className="ax-title">リードタイム</span>
                  <span className="ax-sub">着手〜完了・停滞含む</span>
                  <span style={{ marginLeft: 'auto' }}><window.DeltaPill delta={l.delta} base={l.asIs} unit="日" /></span>
                </div>
                <window.Headline from={l.asIs} to={l.toBe} unit="日" big />
                <window.CompareBars asIs={l.asIs} toBe={l.toBe} unit="日" />
                <div className="cmp-wait">
                  <div className="cmp-wait-cap">うち待ち時間<span className="push">実作業 ／ 待ち</span></div>
                  <window.WaitBreakdown workDays={w.work.asIs} waitDays={w.asIs} label="As-Is" />
                  <window.WaitBreakdown workDays={w.work.toBe} waitDays={w.toBe} label="To-Be" />
                  <div className="cmp-wait-legend">
                    <span><span className="dot" style={{ background: 'var(--accent)' }} />実作業</span>
                    <span><span className="dot" style={{ background: 'var(--red)' }} />待ち</span>
                    <span style={{ marginLeft: 'auto', color: 'var(--ok)', fontWeight: 'var(--fw-strong)' }}>待ち −13.6日</span>
                  </div>
                </div>
              </section>
            </div>

            {/* 業務難易度の変化 ＋ 差分テーブルを下段に横並び */}
            <div style={{ display: 'grid', gridTemplateColumns: '340px 1fr', gap: 'var(--sp-3)', marginTop: 'var(--sp-3)' }}>
              <section className="cmp-card">
                <div className="cmp-diff-head">
                  <span className="cmp-card-icon"><BSpark /></span>
                  <span className="cmp-card-title">業務難易度の変化</span>
                  <span className="push" />
                  <BSegment
                    options={[{ value: 'count', label: '工程数' }, { value: 'effort', label: '工数' }]}
                    value={diffMode}
                    onChange={setDiffMode}
                  />
                </div>
                <div className="cmp-diff-metric">
                  <span className="lead">高難度（ベテラン依存）</span>
                  <span className="val"><span className="from">{hAsIs}{unit || '工程'}</span> → {hToBe}{unit || '工程'}</span>
                  <window.DeltaPill delta={hToBe - hAsIs} base={hAsIs} unit={unit || '工程'} small />
                </div>
                <div className="cmp-auto-row"><span className="cmp-bar-tag">As-Is</span><window.DiffStack counts={counts.asIs} total={total.asIs} unit={unit} /></div>
                <div className="cmp-auto-row"><span className="cmp-bar-tag">To-Be</span><window.DiffStack counts={counts.toBe} total={total.toBe} unit={unit} /></div>
                <window.DiffLegend />
                <div className="cmp-auto-delta">暗黙知を形式知化し、<b style={{ color: 'var(--ink)' }}>誰でもできる（低）</b>業務へ移行。ベテラン依存を縮小。</div>
              </section>
              <window.DiffTable />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

window.SummaryModal = SummaryModal;
