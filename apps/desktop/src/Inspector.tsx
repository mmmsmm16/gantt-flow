import type { Automation, Difficulty, IoItem, IoKind, IssueItem } from '@gantt-flow/core';
import { effortRollupMinutes, formatMinutes } from '@gantt-flow/core';
import { useApp } from './store';

export function Inspector() {
  const project = useApp((s) => s.project);
  const taskId = useApp((s) => s.selectedTaskId);
  const select = useApp((s) => s.select);
  const updateDetail = useApp((s) => s.updateDetail);
  const addIo = useApp((s) => s.addIo);
  const updateIo = useApp((s) => s.updateIo);
  const removeIo = useApp((s) => s.removeIo);
  const addIssue = useApp((s) => s.addIssue);
  const updateIssue = useApp((s) => s.updateIssue);
  const removeIssue = useApp((s) => s.removeIssue);

  if (!taskId) return null;
  const task = project.core.tasks[taskId];
  if (!task) return null;
  const d = project.details[taskId];
  const hasChildren = Object.values(project.core.tasks).some((t) => t.parentId === taskId);
  const rollup = effortRollupMinutes(project.core, project.details, taskId);
  const ios: { item: IoItem; io: 'inputs' | 'outputs' }[] = [
    ...(d?.inputs ?? []).map((item) => ({ item, io: 'inputs' as const })),
    ...(d?.outputs ?? []).map((item) => ({ item, io: 'outputs' as const })),
  ];

  return (
    <aside className="inspector" key={taskId}>
      <div className="insp-head">
        <div>
          <span className={`lvl-badge lvl-${task.level}`}>
            {task.level === 'large' ? '大' : task.level === 'medium' ? '中' : task.level === 'small' ? '小' : '詳細'}
          </span>
          <strong>{task.name || '（無題）'}</strong>
        </div>
        <button className="x" aria-label="インスペクタを閉じる" onClick={() => select(undefined)}>
          ×
        </button>
      </div>

      <div className="insp-scroll">
        <section>
          <h3>基本</h3>
          <label>業務内容（どうやって）</label>
          <textarea defaultValue={d?.how ?? ''} onBlur={(e) => updateDetail(taskId, { how: e.target.value })} />
          <label>使用システム</label>
          <textarea defaultValue={d?.system ?? ''} onBlur={(e) => updateDetail(taskId, { system: e.target.value })} />
          <label>工数（分）</label>
          {hasChildren ? (
            <div className="readonly">{formatMinutes(rollup)}（子の合計・自動）</div>
          ) : (
            <input
              type="number"
              defaultValue={d?.effortMinutes ?? ''}
              onBlur={(e) =>
                updateDetail(taskId, { effortMinutes: e.target.value ? Number(e.target.value) : undefined })
              }
            />
          )}
          <label>備考</label>
          <textarea defaultValue={d?.note ?? ''} onBlur={(e) => updateDetail(taskId, { note: e.target.value })} />
        </section>

        <section>
          <h3>
            インプット / アウトプット
            <span className="add-inline">
              <button onClick={() => addIo(taskId, 'inputs', '帳票')}>＋入力</button>
              <button onClick={() => addIo(taskId, 'outputs', '帳票')}>＋出力</button>
            </span>
          </h3>
          {ios.length === 0 && <p className="hint">入力/出力を追加できます。</p>}
          {ios.map(({ item, io }) => (
            <div className={`io-row ${io === 'inputs' ? 'in' : 'out'}`} key={item.id}>
              <span className="io-tag">{io === 'inputs' ? '入' : '出'}</span>
              <input
                className="io-name"
                defaultValue={item.name}
                onBlur={(e) => updateIo(taskId, item.id, { name: e.target.value })}
              />
              <select
                value={item.kind}
                onChange={(e) => updateIo(taskId, item.id, { kind: e.target.value as IoKind })}
              >
                <option value="doc">帳票</option>
                <option value="info">情報</option>
              </select>
              <input
                className="io-form"
                placeholder="様式・保管"
                defaultValue={item.formInfo ?? ''}
                onBlur={(e) => updateIo(taskId, item.id, { formInfo: e.target.value || undefined })}
              />
              <button
                className="x"
                aria-label={`${item.name || '項目'}を削除`}
                onClick={() => removeIo(taskId, item.id)}
              >
                ×
              </button>
            </div>
          ))}
        </section>

        <section>
          <h3>
            課題 / 方策
            <span className="add-inline">
              <button onClick={() => addIssue(taskId, '課題')}>＋課題</button>
            </span>
          </h3>
          {(d?.issues ?? []).map((iss: IssueItem) => {
            const targetValue = iss.target?.kind === 'io' ? iss.target.ioId : 'task';
            return (
              <div className="issue-row" key={iss.id}>
                <input
                  className="iss-text"
                  defaultValue={iss.issue}
                  placeholder="課題"
                  onBlur={(e) => updateIssue(taskId, iss.id, { issue: e.target.value })}
                />
                <input
                  className="iss-measure"
                  defaultValue={iss.measure ?? ''}
                  placeholder="方策"
                  onBlur={(e) => updateIssue(taskId, iss.id, { measure: e.target.value || undefined })}
                />
                <select
                  value={targetValue}
                  onChange={(e) =>
                    updateIssue(taskId, iss.id, {
                      target: e.target.value === 'task' ? { kind: 'task' } : { kind: 'io', ioId: e.target.value },
                    })
                  }
                >
                  <option value="task">対象: 工程</option>
                  {ios.map(({ item }) => (
                    <option key={item.id} value={item.id}>
                      対象: {item.name}
                    </option>
                  ))}
                </select>
                <button
                  className="x"
                  aria-label="この課題を削除"
                  onClick={() => removeIssue(taskId, iss.id)}
                >
                  ×
                </button>
              </div>
            );
          })}
        </section>

        <section>
          <h3>任意</h3>
          <label>処理件数・ボリューム</label>
          <input defaultValue={d?.volume ?? ''} onBlur={(e) => updateDetail(taskId, { volume: e.target.value || undefined })} />
          <label>例外・イレギュラー</label>
          <textarea defaultValue={d?.exception ?? ''} onBlur={(e) => updateDetail(taskId, { exception: e.target.value || undefined })} />
          <div className="two-col">
            <div>
              <label>自動化区分</label>
              <select
                defaultValue={d?.automation ?? ''}
                onChange={(e) => updateDetail(taskId, { automation: (e.target.value || undefined) as Automation | undefined })}
              >
                <option value="">—</option>
                <option value="manual">手作業</option>
                <option value="system">システム自動</option>
                <option value="partial">一部自動</option>
              </select>
            </div>
            <div>
              <label>難易度</label>
              <select
                defaultValue={d?.difficulty ?? ''}
                onChange={(e) => updateDetail(taskId, { difficulty: (e.target.value || undefined) as Difficulty | undefined })}
              >
                <option value="">—</option>
                <option value="H">H</option>
                <option value="M">M</option>
                <option value="L">L</option>
              </select>
            </div>
          </div>
          <label>データ連携先</label>
          <input defaultValue={d?.dataLink ?? ''} onBlur={(e) => updateDetail(taskId, { dataLink: e.target.value || undefined })} />
          <label>関連規程・統制</label>
          <input defaultValue={d?.regulation ?? ''} onBlur={(e) => updateDetail(taskId, { regulation: e.target.value || undefined })} />
        </section>
      </div>
    </aside>
  );
}
