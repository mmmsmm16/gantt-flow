import type { CSSProperties } from 'react';
import { useLayoutEffect, useRef, useState } from 'react';
import type { Automation, Difficulty, Id, IoItem, IoKind, IssueItem, ProcessLevel, TaskColor, TaskStatus } from '@gantt-flow/core';
import { computeCodes, effortRollupMinutes, effortMinutesToHours, formatHours, deriveParentBridges, isMilestone } from '@gantt-flow/core';
import { useApp } from './store';
import { useUI } from './ui/useUI';
import { parseEffortHoursToMinutes, validateEffort, markEffortInvalid, clearEffortInvalid } from './parseEffort';
import { collectIoNames, prevCandidates } from './suggestions';
import { PrevCandidateOptions } from './PrevCandidateOptions';
import { TASK_COLORS, TASK_COLOR_KEYS, TASK_COLOR_LABELS } from './theme';

// 色スウォッチの 1 行(塗り/文字色で共用)。選択中は枠で強調、「なし」で解除。
function ColorSwatchRow({
  value,
  styleOf,
  onChange,
  ariaLabel,
}: {
  value: TaskColor | undefined;
  styleOf: (c: TaskColor) => CSSProperties;
  onChange: (c: TaskColor | undefined) => void;
  ariaLabel: string;
}) {
  return (
    <div className="swatch-row" role="group" aria-label={ariaLabel}>
      {TASK_COLOR_KEYS.map((c) => (
        <button
          key={c}
          className={`swatch${value === c ? ' on' : ''}`}
          style={styleOf(c)}
          aria-pressed={value === c}
          aria-label={TASK_COLOR_LABELS[c]}
          title={TASK_COLOR_LABELS[c]}
          onClick={() => onChange(value === c ? undefined : c)}
        />
      ))}
      <button
        className={`swatch swatch-none${value === undefined ? ' on' : ''}`}
        aria-pressed={value === undefined}
        aria-label="色なし"
        title="色なし（既定に戻す）"
        onClick={() => onChange(undefined)}
      >
        ×
      </button>
    </div>
  );
}

export function Inspector() {
  const project = useApp((s) => s.project);
  const taskId = useApp((s) => s.selectedTaskId);
  const updateDetail = useApp((s) => s.updateDetail);
  const addIo = useApp((s) => s.addIo);
  const updateIo = useApp((s) => s.updateIo);
  const removeIo = useApp((s) => s.removeIo);
  const addIssue = useApp((s) => s.addIssue);
  const updateIssue = useApp((s) => s.updateIssue);
  const removeIssue = useApp((s) => s.removeIssue);
  const setTaskCode = useApp((s) => s.setTaskCode);
  const addDependency = useApp((s) => s.addDependency);
  const removeDependency = useApp((s) => s.removeDependency);
  const setAssigneeByName = useApp((s) => s.setAssigneeByName);
  const setTaskLevel = useApp((s) => s.setTaskLevel);
  const updateToBe = useApp((s) => s.updateToBe);
  const copyAsIsToToBe = useApp((s) => s.copyAsIsToToBe);
  const addToBePredecessor = useApp((s) => s.addToBePredecessor);
  const removeToBePredecessor = useApp((s) => s.removeToBePredecessor);
  const tobeEnabled = useUI((s) => s.tobeEnabled);

  // 入出力/課題を追加した直後、その新しい入力欄へフォーカス＆全選択（既定文字が選択され打てば置換）。
  const asideRef = useRef<HTMLElement>(null);
  const [addFocus, setAddFocus] = useState<'io-in' | 'io-out' | 'issue' | null>(null);
  useLayoutEffect(() => {
    if (!addFocus) return;
    const root = asideRef.current;
    if (root) {
      const sel = addFocus === 'issue' ? '.iss-text' : `.io-row.${addFocus === 'io-in' ? 'in' : 'out'} .io-name`;
      const xs = root.querySelectorAll<HTMLInputElement>(sel);
      const el = xs.length ? xs[xs.length - 1]! : null;
      if (el) {
        el.focus();
        el.select();
      }
    }
    setAddFocus(null);
  }, [addFocus, project]);

  if (!taskId) return null;
  const task = project.core.tasks[taskId];
  if (!task) return null;
  // マイルストーンは子工程・担当・工数・I/O・課題を持たない（spec:
  // docs/superpowers/specs/2026-07-04-milestone-design.md §確定UX）。名前・前工程（対象工程）・
  // 備考だけに絞る（担当/工数は core が拒否するわけではなく、単に UI 側で入口を出さない）。
  const ms = isMilestone(project.core, taskId);
  const d = project.details[taskId];
  const assigneeName = task.assigneeId ? project.core.assignees[task.assigneeId]?.name ?? '' : '';
  const LEVEL_JP: Record<ProcessLevel, string> = { large: '大', medium: '中', small: '小', detail: '詳細' };
  const hasChildren = Object.values(project.core.tasks).some((t) => t.parentId === taskId);
  const rollup = effortRollupMinutes(project.core, project.details, taskId);
  const ios: { item: IoItem; io: 'inputs' | 'outputs' }[] = [
    ...(d?.inputs ?? []).map((item) => ({ item, io: 'inputs' as const })),
    ...(d?.outputs ?? []).map((item) => ({ item, io: 'outputs' as const })),
  ];
  const deptNames = [...new Set(Object.values(project.core.assignees).map((a) => a.name))];
  const ioNames = collectIoNames(project);

  const deps = Object.values(project.core.dependencies);
  const preds = deps.filter((dep) => dep.to === taskId);
  const succs = deps.filter((dep) => dep.from === taskId);
  // 表セレクト・パレットと同じ候補導出（order 順）を共用し、ビューごとのずれを防ぐ。
  const depCandidates = prevCandidates(project, taskId);
  const nameOf = (id: Id) => project.core.tasks[id]?.name ?? '（不明）';

  // 触れただけの blur で履歴と未保存フラグを汚さないため、変化があるときだけ書き込む。
  const commitText = (current: string, next: string, write: (v: string) => void) => {
    if (next !== current) write(next);
  };
  // 任意のテキスト項目用: 空欄は undefined（未設定）に正規化して比較・保存する。
  const commitOptText = (
    current: string | undefined,
    next: string,
    write: (v: string | undefined) => void,
  ) => {
    const v = next || undefined;
    if (v !== (current || undefined)) write(v);
  };
  // 親(大)同士の接続から導出される前/次工程(フローのブリッジと同じ)。読み取り専用で表示。
  const bridges = deriveParentBridges(project.core, task.level);
  const bridgePredsOf = bridges.filter((b) => b.to === taskId);
  const bridgeSuccsOf = bridges.filter((b) => b.from === taskId);

  return (
    <aside className="inspector" key={taskId} ref={asideRef}>
      <div className="insp-head">
        <div className="insp-head-main">
          <div className="insp-eyebrow">
            <span className={`lvl-badge lvl-${task.level}`}>{LEVEL_JP[task.level]}</span>
            <span className="insp-code">No. {ms ? '—' : computeCodes(project.core)[taskId] ?? task.code ?? '—'}</span>
            {ms ? (
              <span className="insp-chip ms-chip">マイルストーン</span>
            ) : assigneeName ? (
              <span className="insp-chip">{assigneeName}</span>
            ) : (
              <span className="insp-chip warn">未割当</span>
            )}
          </div>
          <strong className="insp-title">{task.name || '（無題）'}</strong>
        </div>
        <button
          className="x"
          aria-label="詳細パネルを閉じる（選択は維持）"
          title="詳細を閉じる（選択は維持）"
          onClick={() => useUI.getState().setInspectorOpen(false)}
        >
          ×
        </button>
      </div>

      <div className="insp-scroll">
        {/* マイルストーンは名前(ヘッダ)・前工程(次のセクション)・備考だけに絞る。 */}
        {!ms && (
        <section>
          <h3>基本</h3>
          <div className="two-col">
            <div>
              <label>担当 / 部署</label>
              <select
                value={assigneeName}
                onChange={(e) => {
                  if (e.target.value !== assigneeName) setAssigneeByName(taskId, e.target.value);
                }}
              >
                <option value="">（未割当）</option>
                {deptNames.map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label>粒度</label>
              <select
                value={task.level}
                onChange={(e) => {
                  const lv = e.target.value as ProcessLevel;
                  if (lv !== task.level) setTaskLevel(taskId, lv);
                }}
              >
                <option value="large">大工程</option>
                <option value="medium">中工程</option>
                <option value="small">小工程</option>
                <option value="detail">詳細工程</option>
              </select>
            </div>
          </div>
          <label>状況（ヒアリング進行）</label>
          <select
            className={`insp-status st-${d?.status ?? 'none'}`}
            value={d?.status ?? ''}
            aria-label="状況（ヒアリング進行）"
            onChange={(e) => updateDetail(taskId, { status: (e.target.value || undefined) as TaskStatus | undefined })}
          >
            <option value="">—（未着手）</option>
            <option value="todo">未着手</option>
            <option value="heard">ヒアリング済</option>
            <option value="review">確認待ち</option>
            <option value="done">確定</option>
          </select>
          <label>塗り色（フローのノード）</label>
          <ColorSwatchRow
            value={d?.fillColor}
            styleOf={(c) => ({ background: TASK_COLORS[c].fill, borderColor: TASK_COLORS[c].base })}
            onChange={(c) => {
              if (c !== d?.fillColor) updateDetail(taskId, { fillColor: c });
            }}
            ariaLabel="塗り色"
          />
          <label>文字色（作業名）</label>
          <ColorSwatchRow
            value={d?.textColor}
            styleOf={(c) => ({ background: TASK_COLORS[c].text, borderColor: TASK_COLORS[c].text })}
            onChange={(c) => {
              if (c !== d?.textColor) updateDetail(taskId, { textColor: c });
            }}
            ariaLabel="文字色"
          />
          <label>工程No（空欄で自動採番）</label>
          <input
            defaultValue={task.code ?? ''}
            placeholder={computeCodes(project.core)[taskId] ?? ''}
            onBlur={(e) => commitOptText(task.code, e.target.value.trim(), (v) => setTaskCode(taskId, v))}
          />
          <label>業務内容（どうやって）</label>
          <textarea
            defaultValue={d?.how ?? ''}
            onBlur={(e) => commitOptText(d?.how, e.target.value, (v) => updateDetail(taskId, { how: v }))}
          />
          <label>使用システム</label>
          <textarea
            defaultValue={d?.system ?? ''}
            onBlur={(e) => commitOptText(d?.system, e.target.value, (v) => updateDetail(taskId, { system: v }))}
          />
          <label>工数（時間・0.5刻み）</label>
          {hasChildren ? (
            <div className="insp-effort-box">
              <div className="insp-effort">{formatHours(rollup)}</div>
              <div className="insp-derived">子工程の合計（自動集計）</div>
            </div>
          ) : (
            <input
              type="number"
              min={0}
              step={0.5}
              placeholder="例: 2 / 0.5"
              defaultValue={d?.effortMinutes != null ? effortMinutesToHours(d.effortMinutes) : ''}
              onBlur={(e) => {
                const res = validateEffort(e.target.value);
                if (!res.ok) {
                  // 不正値: 打った文字は残し、不正表示にして commit だけブロック（理由はトーストで即提示）。
                  markEffortInvalid(e.target, res.message);
                  useUI.getState().toast(`${res.message}（例: 2 や 0.5）`, 'error');
                  return;
                }
                clearEffortInvalid(e.target);
                if (res.minutes !== d?.effortMinutes) updateDetail(taskId, { effortMinutes: res.minutes });
              }}
            />
          )}
          <label>備考</label>
          <textarea
            defaultValue={d?.note ?? ''}
            onBlur={(e) => commitOptText(d?.note, e.target.value, (v) => updateDetail(taskId, { note: v }))}
          />
        </section>
        )}

        <section>
          <h3>{ms ? '対象工程（前工程）' : '前工程 / 次工程'}</h3>
          <label>{ms ? 'このマイルストーンまでに終わらせる工程' : '前工程（この工程の前に行う）'}</label>
          {preds.length === 0 && bridgePredsOf.length === 0 && <p className="hint">なし</p>}
          {bridgePredsOf.map((b) => (
            <div className="dep-row derived" key={`br-${b.from}`} title="大工程同士の接続から自動で繋がっています（解除は大工程側の接続を削除）">
              <span className="dep-name">⤷ {nameOf(b.from)}</span>
              <span className="dep-note">親の接続</span>
            </div>
          ))}
          {preds.map((dep) => (
            <div className="dep-row" key={dep.id}>
              <span className="dep-name">{nameOf(dep.from)}</span>
              <button className="x" aria-label="前工程を解除" title="前工程を解除" onClick={() => removeDependency(dep.id)}>
                ×
              </button>
            </div>
          ))}
          {depCandidates.length > 0 && (
            <select
              className="dep-add"
              value=""
              aria-label="前工程を追加"
              onChange={(e) => {
                if (e.target.value) addDependency(e.target.value, taskId);
              }}
            >
              <option value="">＋ 前工程を追加…</option>
              <PrevCandidateOptions
                candidates={depCandidates}
                parentName={(pid) => (pid ? nameOf(pid) : '最上位')}
              />
            </select>
          )}

          {/* マイルストーンから出る依存は禁止（core ガード）。UI にも次工程の入口は出さない。 */}
          {!ms && (
            <>
              <label>次工程（この工程の後に行う）</label>
              {succs.length === 0 && bridgeSuccsOf.length === 0 && <p className="hint">なし</p>}
              {bridgeSuccsOf.map((b) => (
                <div className="dep-row derived" key={`bs-${b.to}`} title="大工程同士の接続から自動で繋がっています">
                  <span className="dep-name">⤷ {nameOf(b.to)}</span>
                  <span className="dep-note">親の接続</span>
                </div>
              ))}
              {succs.map((dep) => (
                <div className="dep-row" key={dep.id}>
                  <span className="dep-name">{nameOf(dep.to)}</span>
                  <button className="x" aria-label="次工程を解除" title="次工程を解除" onClick={() => removeDependency(dep.id)}>
                    ×
                  </button>
                </div>
              ))}
              {depCandidates.length > 0 && (
                <select
                  className="dep-add"
                  value=""
                  aria-label="次工程を追加"
                  onChange={(e) => {
                    if (e.target.value) addDependency(taskId, e.target.value);
                  }}
                >
                  <option value="">＋ 次工程を追加…</option>
                  <PrevCandidateOptions
                    candidates={depCandidates}
                    parentName={(pid) => (pid ? nameOf(pid) : '最上位')}
                  />
                </select>
              )}
            </>
          )}
        </section>

        {ms && (
          <section>
            <h3>備考</h3>
            <textarea
              defaultValue={d?.note ?? ''}
              onBlur={(e) => commitOptText(d?.note, e.target.value, (v) => updateDetail(taskId, { note: v }))}
            />
          </section>
        )}

        {!ms && (
        <section>
          <h3>
            入力 / 出力
            {ios.length > 0 && <span className="insp-count">{ios.length}</span>}
            <span className="add-inline">
              <button onClick={() => { addIo(taskId, 'inputs', '帳票'); setAddFocus('io-in'); }}>＋入力</button>
              <button onClick={() => { addIo(taskId, 'outputs', '帳票'); setAddFocus('io-out'); }}>＋出力</button>
            </span>
          </h3>
          {ios.length === 0 && <p className="hint">入力/出力を追加できます。</p>}
          <datalist id="insp-depts">
            {deptNames.map((n) => (
              <option key={n} value={n} />
            ))}
          </datalist>
          <datalist id="insp-io-names">
            {ioNames.map((n) => (
              <option key={n} value={n} />
            ))}
          </datalist>
          {ios.map(({ item, io }) => (
            <div className={`io-row ${io === 'inputs' ? 'in' : 'out'}`} key={item.id}>
              <span className="io-tag">{io === 'inputs' ? '入' : '出'}</span>
              <input
                className="io-name"
                list="insp-io-names"
                defaultValue={item.name}
                key={`ion-${item.name}`}
                onBlur={(e) => commitText(item.name, e.target.value, (v) => updateIo(taskId, item.id, { name: v }))}
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
                onBlur={(e) =>
                  commitOptText(item.formInfo, e.target.value, (v) => updateIo(taskId, item.id, { formInfo: v }))
                }
              />
              {io === 'inputs' && (
                <input
                  className="io-form io-source-in"
                  placeholder="出所(他部署)"
                  list="insp-depts"
                  defaultValue={item.source ?? ''}
                  key={`src-${item.source ?? ''}`}
                  title="この帳票がどの部署から来るか（工程が無くてもフローに出所を描きます）"
                  onBlur={(e) =>
                    commitOptText(item.source, e.target.value, (v) => updateIo(taskId, item.id, { source: v }))
                  }
                />
              )}
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
        )}

        {!ms && (
        <section>
          <h3>
            課題 / 方策
            {(d?.issues?.length ?? 0) > 0 && <span className="insp-count">{(d?.issues ?? []).length}</span>}
            <span className="add-inline">
              <button onClick={() => { addIssue(taskId, '課題'); setAddFocus('issue'); }}>＋課題</button>
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
                  onBlur={(e) => commitText(iss.issue, e.target.value, (v) => updateIssue(taskId, iss.id, { issue: v }))}
                />
                <input
                  className="iss-measure"
                  defaultValue={iss.measure ?? ''}
                  placeholder="方策"
                  onBlur={(e) =>
                    commitOptText(iss.measure, e.target.value, (v) => updateIssue(taskId, iss.id, { measure: v }))
                  }
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
        )}

        {!ms && (
        <section>
          <h3>任意</h3>
          <label>処理件数・ボリューム</label>
          <input
            defaultValue={d?.volume ?? ''}
            onBlur={(e) => commitOptText(d?.volume, e.target.value, (v) => updateDetail(taskId, { volume: v }))}
          />
          <label>例外・イレギュラー</label>
          <textarea
            defaultValue={d?.exception ?? ''}
            onBlur={(e) => commitOptText(d?.exception, e.target.value, (v) => updateDetail(taskId, { exception: v }))}
          />
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
          <input
            defaultValue={d?.dataLink ?? ''}
            onBlur={(e) => commitOptText(d?.dataLink, e.target.value, (v) => updateDetail(taskId, { dataLink: v }))}
          />
          <label>関連規程・統制</label>
          <input
            defaultValue={d?.regulation ?? ''}
            onBlur={(e) => commitOptText(d?.regulation, e.target.value, (v) => updateDetail(taskId, { regulation: v }))}
          />
        </section>
        )}

        {tobeEnabled && !ms &&
          (() => {
            const tb = d?.toBe;
            const removed = tb?.lifecycle === 'removed';
            const added = tb?.lifecycle === 'added';
            const asisEffH = d?.effortMinutes != null ? effortMinutesToHours(d.effortMinutes) : undefined;
            const tobeEffH = tb?.effortMinutes != null ? effortMinutesToHours(tb.effortMinutes) : undefined;
            const asisLt = d?.ltDays;
            const tobeLt = tb?.ltDays;
            const r1 = (v: number) => Math.round(v * 10) / 10;
            const sd = (v: number, u: string) => `${v > 0 ? '+' : '−'}${Math.abs(r1(v))}${u}`;
            const assignees = Object.values(project.core.assignees);
            return (
              <section className="section tobe-section" key={`tobe-${taskId}-${JSON.stringify(tb ?? {})}`}>
                <div className="tobe-head">
                  <h4>To-Be（改善後）{added && <span className="tobe-badge added">新規</span>}</h4>
                  <button className="tobe-copy" onClick={() => copyAsIsToToBe(taskId)} title="As-Is の現状値を To-Be の起点へコピー">
                    現状を複製
                  </button>
                </div>
                {!added && (
                  <>
                    <label>状態</label>
                    <div className="seg tobe-life">
                      <button className={!removed ? 'on' : ''} onClick={() => updateToBe(taskId, { lifecycle: undefined })}>維持</button>
                      <button className={removed ? 'on' : ''} onClick={() => updateToBe(taskId, { lifecycle: 'removed' })}>廃止</button>
                    </div>
                  </>
                )}
                {!removed && (
                  <>
                    <div className="two-col">
                      <div>
                        <label>To-Be 工数（時間）</label>
                        <input
                          type="text"
                          inputMode="decimal"
                          defaultValue={tobeEffH ?? ''}
                          placeholder={asisEffH != null ? `現状 ${r1(asisEffH)}h` : '—'}
                          onBlur={(e) =>
                            updateToBe(taskId, {
                              effortMinutes: e.target.value.trim() === '' ? undefined : parseEffortHoursToMinutes(e.target.value) ?? undefined,
                            })
                          }
                        />
                        {tobeEffH != null && asisEffH != null && tobeEffH !== asisEffH && (
                          <small className="tobe-delta">{sd(tobeEffH - asisEffH, 'h')}</small>
                        )}
                      </div>
                      <div>
                        <label>To-Be リードタイム（日）</label>
                        <input
                          type="text"
                          inputMode="decimal"
                          defaultValue={tobeLt ?? ''}
                          placeholder={asisLt != null ? `現状 ${asisLt}日` : '—'}
                          onBlur={(e) =>
                            updateToBe(taskId, { ltDays: e.target.value.trim() === '' ? undefined : Number(e.target.value) })
                          }
                        />
                        {tobeLt != null && asisLt != null && tobeLt !== asisLt && (
                          <small className="tobe-delta">{sd(tobeLt - asisLt, '日')}</small>
                        )}
                      </div>
                    </div>
                    <div className="two-col">
                      <div>
                        <label>To-Be 難易度</label>
                        <select
                          defaultValue={tb?.difficulty ?? ''}
                          onChange={(e) => updateToBe(taskId, { difficulty: (e.target.value || undefined) as Difficulty | undefined })}
                        >
                          <option value="">（現状と同じ）</option>
                          <option value="H">H</option>
                          <option value="M">M</option>
                          <option value="L">L</option>
                        </select>
                      </div>
                      <div>
                        <label>To-Be 担当（移動）</label>
                        <select
                          defaultValue={tb?.assigneeId ?? ''}
                          onChange={(e) => updateToBe(taskId, { assigneeId: e.target.value || undefined })}
                        >
                          <option value="">（現状と同じ）</option>
                          {assignees.map((a) => (
                            <option key={a.id} value={a.id}>
                              {a.name}
                            </option>
                          ))}
                        </select>
                      </div>
                    </div>
                  </>
                )}
                <label>根拠（なぜ達成できるか）</label>
                <textarea
                  defaultValue={tb?.rationale ?? ''}
                  rows={2}
                  onBlur={(e) => updateToBe(taskId, { rationale: e.target.value.trim() || undefined })}
                />
                <label>前工程（To-Be）</label>
                {(() => {
                  // To-Be の前工程 = As-Is専用('asis')でない依存（両方/tobe）。直接 追加・削除できる。
                  const tobePreds = deps.filter((dp) => dp.to === taskId && dp.phase !== 'asis');
                  const tobePredIds = new Set(tobePreds.map((dp) => dp.from));
                  const cands = Object.values(project.core.tasks).filter(
                    (o) => o.id !== taskId && o.level === task.level && !tobePredIds.has(o.id),
                  );
                  return (
                    <>
                      {tobePreds.length === 0 && <p className="hint">なし（To-Be では先頭から開始）</p>}
                      {tobePreds.map((dp) => (
                        <div className="dep-row" key={`tobe-${dp.from}`}>
                          <span className="dep-name">{nameOf(dp.from)}</span>
                          <button
                            className="x"
                            aria-label="To-Be の前工程から外す"
                            title="To-Be の前工程から外す（As-Is は保持＝並行化）"
                            onClick={() => removeToBePredecessor(taskId, dp.from)}
                          >
                            ×
                          </button>
                        </div>
                      ))}
                      {cands.length > 0 && (
                        <select
                          className="dep-add"
                          value=""
                          aria-label="To-Be 前工程を追加"
                          onChange={(e) => {
                            if (e.target.value) addToBePredecessor(taskId, e.target.value);
                          }}
                        >
                          <option value="">＋ To-Be 前工程を追加…</option>
                          {cands.map((o) => (
                            <option key={o.id} value={o.id}>
                              {o.name}
                            </option>
                          ))}
                        </select>
                      )}
                    </>
                  );
                })()}
              </section>
            );
          })()}
      </div>
    </aside>
  );
}
