// gantt-flow As-Is / To-Be 比較 — 画面2b To-Be 一括入力テーブル
// インスペクタを1工程ずつ開かずに、全工程の To-Be をまとめて入力する。
const { TextInput: BkInput, Select: BkSelect, Button: BkButton, Download: BkDownload } = window.GantFlowDesign_cece4e;

const DIFF_LABEL = { H: '高', M: '中', L: '低' };

function DiffBadge({ d }) {
  return <span className={`cmp-bulk-diffbadge ${d.toLowerCase()}`}>{DIFF_LABEL[d]}</span>;
}

function BulkInput() {
  const { rows, totals } = window.GF_CMP;

  return (
    <div className="cmp-bulk">
      <div className="cmp-bulk-card">
        <div className="cmp-bulk-head">
          <div>
            <h3 className="cmp-bulk-title">To-Be 一括入力</h3>
            <span className="cmp-bulk-sub">工程表のインライン編集 ・ 全工程の To-Be をまとめて入力</span>
          </div>
          <span style={{ marginLeft: 'auto' }} />
          <BkButton size="sm"><BkDownload /><span style={{ marginLeft: 5 }}>取込</span></BkButton>
          <BkButton size="sm" variant="primary">保存</BkButton>
        </div>

        <div className="cmp-bulk-tip">
          <span>各工程の <b>As-Is（薄字）→ To-Be（入力）</b> を横に並べて一覧編集。詳細はインスペクタへ。Tab / ↓ で次のセルへ移動。</span>
        </div>

        <div className="cmp-bulk-scroll">
          <table className="cmp-bulk-table">
            <thead>
              <tr>
                <th>工程</th>
                <th>担当</th>
                <th className="grp" colSpan="2">工数（h）</th>
                <th className="grp" colSpan="2">リードタイム（日）</th>
                <th className="grp" colSpan="2">難易度</th>
                <th className="grp">根拠</th>
              </tr>
              <tr>
                <th></th><th></th>
                <th style={{ color: 'var(--faint)' }}>As-Is</th><th>To-Be</th>
                <th style={{ color: 'var(--faint)' }}>As-Is</th><th>To-Be</th>
                <th style={{ color: 'var(--faint)' }}>As-Is</th><th>To-Be</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const eDelta = r.toBe.effort - r.asIs.effort;
                const lDelta = r.toBe.ltDays - r.asIs.ltDays;
                return (
                  <tr key={r.id}>
                    <td className="nm">{r.name}</td>
                    <td className="ow">{r.owner}</td>
                    {/* 工数 */}
                    <td className="cmp-bulk-asis cmp-bulk-cell-grp">{r.asIs.effort}</td>
                    <td>
                      <span className="cmp-bulk-pair">
                        <span className="cmp-bulk-in"><BkInput size="sm" defaultValue={r.toBe.effort} /></span>
                        <span className={`cmp-bulk-delta ${eDelta < 0 ? 'good' : 'flat'}`}>{eDelta === 0 ? '±0' : (eDelta > 0 ? '+' : '−') + Math.abs(eDelta)}</span>
                      </span>
                    </td>
                    {/* LT */}
                    <td className="cmp-bulk-asis cmp-bulk-cell-grp">{r.asIs.ltDays}</td>
                    <td>
                      <span className="cmp-bulk-pair">
                        <span className="cmp-bulk-in"><BkInput size="sm" defaultValue={r.toBe.ltDays} /></span>
                        <span className={`cmp-bulk-delta ${lDelta < 0 ? 'good' : 'flat'}`}>{lDelta === 0 ? '±0' : (lDelta > 0 ? '+' : '−') + Math.abs(lDelta)}</span>
                      </span>
                    </td>
                    {/* 難易度 */}
                    <td className="cmp-bulk-cell-grp"><DiffBadge d={r.asIs.diff} /></td>
                    <td>
                      <span className="cmp-bulk-diff">
                        <BkSelect size="sm" defaultValue={r.toBe.diff}>
                          <option value="H">高</option>
                          <option value="M">中</option>
                          <option value="L">低</option>
                        </BkSelect>
                      </span>
                    </td>
                    {/* 根拠 */}
                    <td className="cmp-bulk-cell-grp cmp-bulk-basis">
                      <BkInput size="sm" defaultValue={r.basis} placeholder="なぜ達成できるか（形式知化の内容）" />
                    </td>
                  </tr>
                );
              })}
            </tbody>
            <tfoot>
              <tr className="cmp-bulk-foot">
                <td colSpan="2">合計</td>
                <td className="num cmp-bulk-asis cmp-bulk-cell-grp">{totals.effort.asIs}</td>
                <td className="num">{totals.effort.toBe}h <span className="cmp-bulk-delta good">−{Math.abs(totals.effort.delta)}</span></td>
                <td className="num cmp-bulk-asis cmp-bulk-cell-grp">{totals.lt.asIs}</td>
                <td className="num">{totals.lt.toBe}日 <span className="cmp-bulk-delta good">−{Math.abs(totals.lt.delta)}</span></td>
                <td className="cmp-bulk-cell-grp" colSpan="3" style={{ color: 'var(--faint)', fontWeight: 'var(--fw-regular)' }}>高難度 3→1 工程</td>
              </tr>
            </tfoot>
          </table>
        </div>
      </div>
    </div>
  );
}

window.BulkInput = BulkInput;
