// gantt-flow As-Is / To-Be 比較 — 画面3 シナリオ切替の配置提案
const { BrandMark: SBrand, Segment: SSegment, Button: SButton, ChartBar: SChart, Columns: SColumns } = window.GantFlowDesign_cece4e;

function ScenSeg({ value }) {
  return (
    <span className="cmp-scenseg" role="group" aria-label="シナリオ切替">
      <button className={value === 'asis' ? 'on' : ''}><span className="sd" />As-Is</button>
      <button className={value === 'tobe' ? 'on' : ''}><span className="sd" />To-Be</button>
    </span>
  );
}

function ScenarioSwitch() {
  return (
    <div className="cmp-root" style={{ padding: 24, background: 'var(--bg)' }}>
      <div className="cmp-scn">

        {/* 推奨案 */}
        <div className="cmp-scn-opt">
          <div className="cmp-scn-opt-head">
            <span className="cmp-scn-badge">推奨</span>
            <span className="cmp-scn-opt-title">ビュー上部バーの左 — 粒度セレクタの隣</span>
            <span className="cmp-scn-note">常時見える・状態が明確</span>
          </div>
          <div className="cmp-scn-demo">
            <div className="cmp-mini-toolbar">
              <SBrand size={18} />
              <span className="cmp-mini-brand">gantt-flow</span>
              <span style={{ width: 1, height: 20, background: 'var(--line)', margin: '0 4px' }} />
              <span className="cmp-highlight-ring"><ScenSeg value="tobe" /></span>
              <span style={{ width: 1, height: 20, background: 'var(--line)', margin: '0 4px' }} />
              <SSegment options={['大', '中', '小', '詳細']} value="中" onChange={() => {}} />
              <span className="cmp-mini-spacer" />
              <span className="cmp-mini-ghost" style={{ width: 70 }} />
              <SButton size="sm"><SChart /><span style={{ marginLeft: 5 }}>比較</span></SButton>
            </div>
          </div>
          <div className="cmp-scn-why">
            <b>理由：</b>「いまどちらのシナリオを見ているか」は工程表・フロー両ビューの解釈を左右するため、最も視線が通るツールバー左に固定。粒度切替と同じ“ビュー全体の状態”なので隣接が自然。As-Is 表示中は編集ロック（閲覧）、To-Be で編集可、と状態に意味を持たせられる。工程表・工程フローの両ビューが同じシナリオに連動する。
          </div>
        </div>

        <div className="cmp-callout">
          <b>サマリへの動線：</b>ツールバー右の<b>「比較」</b>ボタン（または ⌘ ⇧ C）で画面1のサマリモーダルを開く。シナリオ切替は“ビューの表示”、比較ボタンは“効果の集計”と役割を分ける。
        </div>

      </div>
    </div>
  );
}

window.ScenarioSwitch = ScenarioSwitch;
