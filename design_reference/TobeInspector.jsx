// gantt-flow As-Is / To-Be 比較 — 画面2 To-Be インスペクタ（右パネル・360px）
const {
  Tabs: ITabs, Button: IButton, TextInput: IInput, LevelBadge: ILevel, Chip: IChip,
} = window.GantFlowDesign_cece4e;

const ICopy = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
    <rect x="9" y="9" width="11" height="11" rx="2" /><path d="M5 15V5a2 2 0 0 1 2-2h10" />
  </svg>
);

function DiffPicker({ value }) {
  const DIFF = window.GF_CMP.DIFF;
  return (
    <div className="cmp-auto-pick">
      {DIFF.map((d) => (
        <span key={d.key} className={`cmp-auto-opt ${d.key === value ? 'on' : ''}`.trim()} title={d.sub}>
          <span className={`cmp-auto-dot ${d.cls}`} />{d.label}
        </span>
      ))}
    </div>
  );
}

function TobeInspector() {
  const { rows, HPD, fmt } = window.GF_CMP;
  // 「設計レビュー・承認」を例に（待ち削減が大きく物語が伝わる）
  const row = rows.find((r) => r.id === 'p3');
  const [tab, setTab] = React.useState('tobe');

  const waitAsIs = row.asIs.ltDays - row.asIs.effort / HPD;
  const waitToBe = row.toBe.ltDays - row.toBe.effort / HPD;
  const eDelta = row.toBe.effort - row.asIs.effort;
  const lDelta = row.toBe.ltDays - row.asIs.ltDays;

  return (
    <div className="cmp-root" style={{ padding: 20, display: 'flex', justifyContent: 'center', background: 'var(--bg)' }}>
      <div className="cmp-insp">
        <div className="cmp-insp-head">
          <div className="cmp-insp-eyebrow">
            <ILevel level="medium" />
            <span style={{ fontSize: 'var(--fs-label)', color: 'var(--muted)', fontVariantNumeric: 'tabular-nums' }}>No. 1-3</span>
            <IChip variant="neutral">{row.owner}</IChip>
          </div>
          <h3 className="cmp-insp-title">{row.name}</h3>
        </div>

        <div className="cmp-insp-tabs">
          <ITabs options={[{ value: 'basic', label: '基本' }, { value: 'tobe', label: 'To-Be' }]} value={tab} onChange={setTab} />
        </div>

        <div className="cmp-insp-body">
          {/* 現状を複製 */}
          <div className="cmp-dup">
            <span className="cmp-dup-text">As-Is の現状値を To-Be の起点としてコピーします。</span>
            <IButton size="sm"><ICopy /><span style={{ marginLeft: 5 }}>現状を複製</span></IButton>
          </div>

          {/* To-Be 工数 */}
          <div className="cmp-field">
            <span className="cmp-field-label">To-Be 工数<span className="asis-ref">As-Is {row.asIs.effort}h</span></span>
            <div className="cmp-input-row">
              <IInput size="sm" defaultValue={row.toBe.effort} style={{ width: 80 }} />
              <span className="cmp-unit">時間</span>
              <span className={`cmp-change-inline ${eDelta < 0 ? 'good' : eDelta > 0 ? 'bad' : ''}`.trim()} style={{ marginLeft: 'auto' }}>
                {eDelta === 0 ? '変化なし' : fmt.signed(eDelta, 'h')}
              </span>
            </div>
          </div>

          {/* To-Be リードタイム */}
          <div className="cmp-field">
            <span className="cmp-field-label">To-Be リードタイム<span className="asis-ref">As-Is {row.asIs.ltDays}日</span></span>
            <div className="cmp-input-row">
              <IInput size="sm" defaultValue={row.toBe.ltDays} style={{ width: 80 }} />
              <span className="cmp-unit">日</span>
              <span className={`cmp-change-inline ${lDelta < 0 ? 'good' : lDelta > 0 ? 'bad' : ''}`.trim()} style={{ marginLeft: 'auto' }}>
                {lDelta === 0 ? '変化なし' : fmt.signed(lDelta, '日')}
              </span>
            </div>
          </div>

          {/* 待ち時間（自動導出） */}
          <div className="cmp-derived">
            <span className="cmp-derived-label">待ち時間 ＝ LT − 工数</span>
            <span className="cmp-derived-val">{fmt.days(waitToBe)}<small>（As-Is {fmt.days(waitAsIs)}）</small></span>
          </div>

          {/* 業務難易度 */}
          <div className="cmp-field">
            <span className="cmp-field-label">業務難易度<span className="asis-ref">As-Is: 中（中堅）</span></span>
            <DiffPicker value={row.toBe.diff} />
          </div>

          {/* 根拠 */}
          <div className="cmp-field">
            <span className="cmp-field-label">根拠（なぜ達成できるか）</span>
            <textarea className="cmp-textarea" defaultValue={row.basis} />
          </div>

          <IButton variant="primary" style={{ width: '100%', justifyContent: 'center' }}>To-Be を保存</IButton>
        </div>
      </div>
    </div>
  );
}

window.TobeInspector = TobeInspector;
