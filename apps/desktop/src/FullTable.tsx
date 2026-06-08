// 全項目フル表（完全な工程表）。全工程を行に、全フィールドを列にした 1 枚の編集グリッド。
// 粒度は「大工程/中工程/小工程/詳細工程」の 4 列で表現し、各行は自分の粒度の列に作業名を入力、
// 上位粒度の列には祖先（親）の名前を表示する（例: 同じ大工程に属する中工程は同じ大工程名を再掲）。
// 課題と方策はそれぞれ独立した列。アウトラインビューとはタブで切替（useUI.tableMode）。
import type { ProcessTask, ProcessLevel, Id, Automation, Difficulty, IoKind } from '@gantt-flow/core';
import { computeCodes, effortRollupMinutes, formatHours } from '@gantt-flow/core';
import { useApp } from './store';
import { useUI } from './ui/useUI';

const RANK: Record<ProcessLevel, number> = { large: 0, medium: 1, small: 2, detail: 3 };
const LEVELS: { key: ProcessLevel; label: string }[] = [
  { key: 'large', label: '大工程' },
  { key: 'medium', label: '中工程' },
  { key: 'small', label: '小工程' },
  { key: 'detail', label: '詳細工程' },
];
const AUTOMATION: { key: Automation | ''; label: string }[] = [
  { key: '', label: '—' },
  { key: 'manual', label: '手作業' },
  { key: 'system', label: 'システム自動' },
  { key: 'partial', label: '一部自動' },
];
const DIFFICULTY: (Difficulty | '')[] = ['', 'H', 'M', 'L'];

// 全工程を木の順（1, 1-1, 1-1-1, 1-2, 2 …）に平坦化。
function flatten(tasks: ProcessTask[]): ProcessTask[] {
  const byParent = new Map<Id | undefined, ProcessTask[]>();
  for (const t of tasks) {
    const k = t.parentId ?? undefined;
    const arr = byParent.get(k);
    if (arr) arr.push(t);
    else byParent.set(k, [t]);
  }
  for (const arr of byParent.values()) arr.sort((a, b) => a.order - b.order);
  const out: ProcessTask[] = [];
  const walk = (parentId: Id | undefined) => {
    for (const t of byParent.get(parentId) ?? []) {
      out.push(t);
      walk(t.id);
    }
  };
  walk(undefined);
  return out;
}

// 自分＋祖先の「粒度 → 作業名」。自分の粒度には自分の名、上位粒度には親の名が入る。
function ancestryNames(t: ProcessTask, byId: Record<Id, ProcessTask>): Partial<Record<ProcessLevel, string>> {
  const out: Partial<Record<ProcessLevel, string>> = {};
  let cur: ProcessTask | undefined = t;
  while (cur) {
    out[cur.level] = cur.name;
    cur = cur.parentId ? byId[cur.parentId] : undefined;
  }
  return out;
}

export function FullTable() {
  const project = useApp((s) => s.project);
  const selectedTaskId = useApp((s) => s.selectedTaskId);
  const select = useApp((s) => s.select);
  const renameTask = useApp((s) => s.renameTask);
  const setAssigneeByName = useApp((s) => s.setAssigneeByName);
  const updateDetail = useApp((s) => s.updateDetail);
  const addIo = useApp((s) => s.addIo);
  const updateIo = useApp((s) => s.updateIo);
  const removeIo = useApp((s) => s.removeIo);
  const addIssue = useApp((s) => s.addIssue);
  const updateIssue = useApp((s) => s.updateIssue);
  const removeIssue = useApp((s) => s.removeIssue);
  const addDependency = useApp((s) => s.addDependency);
  const removeDependency = useApp((s) => s.removeDependency);
  const addRootTask = useApp((s) => s.addRootTask);
  const removeTask = useApp((s) => s.removeTask);

  const byId = project.core.tasks;
  const tasks = Object.values(byId);
  const rows = flatten(tasks);
  const codes = computeCodes(project.core);
  const deps = Object.values(project.core.dependencies);
  const assigneeNames = [...new Set(Object.values(project.core.assignees).map((a) => a.name))];
  const parentsWithChildren = new Set(tasks.map((t) => t.parentId).filter(Boolean) as Id[]);

  if (rows.length === 0) {
    return (
      <div className="ft-empty">
        <p>工程がありません。</p>
        <button className="primary" onClick={() => addRootTask('large')}>
          ＋ 大工程を追加
        </button>
      </div>
    );
  }

  return (
    <div className="ft-wrap">
      <div className="ft-actions">
        <button className="primary" onClick={() => addRootTask('large')}>
          ＋ 大工程
        </button>
        <button onClick={() => addRootTask('medium')}>＋ 中工程</button>
        <span className="ft-hint">
          各工程は自分の粒度の列に入力（上位列には親の工程名を表示）。横スクロールで全列。
        </span>
      </div>
      <datalist id="ft-assignees">
        {assigneeNames.map((n) => (
          <option key={n} value={n} />
        ))}
      </datalist>
      <table className="ft">
        <thead>
          <tr>
            <th className="ft-c-no ft-sticky ft-st-no">No.</th>
            {LEVELS.map((l, i) => (
              <th key={l.key} className={`ft-c-level ft-sticky ft-st-l${i}`}>
                {l.label}
              </th>
            ))}
            <th className="ft-c-assignee">担当</th>
            <th className="ft-c-prev">前工程</th>
            <th className="ft-c-effort">工数</th>
            <th className="ft-c-text">業務内容</th>
            <th className="ft-c-text">使用システム</th>
            <th className="ft-c-io">インプット</th>
            <th className="ft-c-io">アウトプット</th>
            <th className="ft-c-issue">課題</th>
            <th className="ft-c-issue">方策</th>
            <th className="ft-c-text">備考</th>
            <th className="ft-c-sm">ボリューム</th>
            <th className="ft-c-text">例外対応</th>
            <th className="ft-c-auto">自動化</th>
            <th className="ft-c-sm">データ連携先</th>
            <th className="ft-c-sm">関連規程</th>
            <th className="ft-c-diff">難易度</th>
            <th className="ft-c-act"></th>
          </tr>
        </thead>
        <tbody>
          {rows.map((t) => {
            const d = project.details[t.id];
            const hasChildren = parentsWithChildren.has(t.id);
            const assigneeName = t.assigneeId ? project.core.assignees[t.assigneeId]?.name ?? '' : '';
            const anc = ancestryNames(t, byId);
            const issues = d?.issues ?? [];
            const preds = deps.filter((dep) => dep.to === t.id);
            const predIds = new Set(preds.map((dep) => dep.from));
            const succIds = new Set(deps.filter((dep) => dep.from === t.id).map((dep) => dep.to));
            const siblings = tasks.filter(
              (o) =>
                o.id !== t.id &&
                (o.parentId ?? undefined) === (t.parentId ?? undefined) &&
                o.level === t.level,
            );
            const prevCandidates = siblings.filter((o) => !predIds.has(o.id) && !succIds.has(o.id));
            return (
              <tr
                key={t.id}
                className={`${t.id === selectedTaskId ? 'sel' : ''}${hasChildren ? ' parent' : ''}`}
                onClick={() => select(t.id)}
              >
                <td className="ft-c-no ft-sticky ft-st-no" title={codes[t.id]}>
                  {codes[t.id]}
                </td>
                {LEVELS.map((l, i) => {
                  const own = l.key === t.level;
                  const name = anc[l.key];
                  return (
                    <td
                      key={l.key}
                      className={`ft-c-level ft-sticky ft-st-l${i} ${own ? 'own' : name ? 'anc' : 'blank'}`}
                      onClick={(e) => e.stopPropagation()}
                    >
                      {own ? (
                        <input
                          className={`ft-in ft-name lvl-${l.key}`}
                          defaultValue={t.name}
                          placeholder={l.label}
                          aria-label={l.label}
                          key={`name-${t.name}`}
                          onBlur={(e) => e.target.value !== t.name && renameTask(t.id, e.target.value)}
                        />
                      ) : name !== undefined ? (
                        <span className="ft-anc" title={name}>
                          {name}
                        </span>
                      ) : null}
                    </td>
                  );
                })}
                <td className="ft-c-assignee" onClick={(e) => e.stopPropagation()}>
                  <input
                    className="ft-in"
                    list="ft-assignees"
                    defaultValue={assigneeName}
                    placeholder="（未割当）"
                    aria-label="担当"
                    key={`asg-${assigneeName}`}
                    onBlur={(e) => e.target.value !== assigneeName && setAssigneeByName(t.id, e.target.value)}
                  />
                </td>
                <td className="ft-c-prev" onClick={(e) => e.stopPropagation()}>
                  <div className="ft-prev">
                    {preds.map((dep) => (
                      <span className="ft-pill" key={dep.id}>
                        {byId[dep.from]?.name ?? ''}
                        <button className="ft-x" aria-label="前工程を解除" onClick={() => removeDependency(dep.id)}>
                          ×
                        </button>
                      </span>
                    ))}
                    {prevCandidates.length > 0 && (
                      <select
                        className="ft-add-sel"
                        value=""
                        aria-label="前工程を追加"
                        onChange={(e) => e.target.value && addDependency(e.target.value, t.id)}
                      >
                        <option value="">＋</option>
                        {prevCandidates.map((o) => (
                          <option key={o.id} value={o.id}>
                            {o.name}
                          </option>
                        ))}
                      </select>
                    )}
                  </div>
                </td>
                <td className="ft-c-effort" onClick={(e) => e.stopPropagation()}>
                  {hasChildren ? (
                    <span className="ft-roll" title="子の合計（自動）">
                      {formatHours(effortRollupMinutes(project.core, project.details, t.id))}
                    </span>
                  ) : (
                    <input
                      className="ft-in ft-num"
                      type="number"
                      min={0}
                      step={0.5}
                      defaultValue={d?.effortMinutes != null ? d.effortMinutes / 60 : ''}
                      placeholder="h"
                      aria-label="工数（時間）"
                      key={`eff-${d?.effortMinutes ?? ''}`}
                      onBlur={(e) =>
                        updateDetail(t.id, {
                          effortMinutes: e.target.value ? Math.round(Number(e.target.value) * 60) : undefined,
                        })
                      }
                    />
                  )}
                </td>
                <TextCell value={d?.how} onCommit={(v) => updateDetail(t.id, { how: v })} taskKey={t.id} />
                <TextCell value={d?.system} onCommit={(v) => updateDetail(t.id, { system: v })} taskKey={t.id} />
                <IoCell items={d?.inputs ?? []} onAdd={() => addIo(t.id, 'inputs', '帳票')} onRename={(id, name) => updateIo(t.id, id, { name })} onKind={(id, kind) => updateIo(t.id, id, { kind })} onRemove={(id) => removeIo(t.id, id)} />
                <IoCell items={d?.outputs ?? []} onAdd={() => addIo(t.id, 'outputs', '帳票')} onRename={(id, name) => updateIo(t.id, id, { name })} onKind={(id, kind) => updateIo(t.id, id, { kind })} onRemove={(id) => removeIo(t.id, id)} />
                <td className="ft-c-issue" onClick={(e) => e.stopPropagation()}>
                  <div className="ft-issues">
                    {issues.map((iss) => (
                      <div className="ft-issue-row" key={iss.id}>
                        <input
                          className="ft-in"
                          defaultValue={iss.issue}
                          placeholder="課題"
                          key={`iss-${iss.issue}`}
                          onBlur={(e) => updateIssue(t.id, iss.id, { issue: e.target.value })}
                        />
                        <button className="ft-x" aria-label="課題を削除" onClick={() => removeIssue(t.id, iss.id)}>
                          ×
                        </button>
                      </div>
                    ))}
                    <button className="ft-add" onClick={() => addIssue(t.id, '課題')}>
                      ＋課題
                    </button>
                  </div>
                </td>
                <td className="ft-c-issue" onClick={(e) => e.stopPropagation()}>
                  <div className="ft-issues">
                    {issues.map((iss) => (
                      <div className="ft-issue-row" key={iss.id}>
                        <input
                          className="ft-in"
                          defaultValue={iss.measure ?? ''}
                          placeholder="方策"
                          key={`msr-${iss.measure ?? ''}`}
                          onBlur={(e) => updateIssue(t.id, iss.id, { measure: e.target.value || undefined })}
                        />
                      </div>
                    ))}
                  </div>
                </td>
                <TextCell value={d?.note} onCommit={(v) => updateDetail(t.id, { note: v || undefined })} taskKey={t.id} />
                <TextCell value={d?.volume} onCommit={(v) => updateDetail(t.id, { volume: v || undefined })} taskKey={t.id} small />
                <TextCell value={d?.exception} onCommit={(v) => updateDetail(t.id, { exception: v || undefined })} taskKey={t.id} />
                <td className="ft-c-auto" onClick={(e) => e.stopPropagation()}>
                  <select
                    className="ft-in"
                    value={d?.automation ?? ''}
                    aria-label="自動化区分"
                    onChange={(e) => updateDetail(t.id, { automation: (e.target.value || undefined) as Automation | undefined })}
                  >
                    {AUTOMATION.map((a) => (
                      <option key={a.key} value={a.key}>
                        {a.label}
                      </option>
                    ))}
                  </select>
                </td>
                <TextCell value={d?.dataLink} onCommit={(v) => updateDetail(t.id, { dataLink: v || undefined })} taskKey={t.id} small />
                <TextCell value={d?.regulation} onCommit={(v) => updateDetail(t.id, { regulation: v || undefined })} taskKey={t.id} small />
                <td className="ft-c-diff" onClick={(e) => e.stopPropagation()}>
                  <select
                    className="ft-in"
                    value={d?.difficulty ?? ''}
                    aria-label="難易度"
                    onChange={(e) => updateDetail(t.id, { difficulty: (e.target.value || undefined) as Difficulty | undefined })}
                  >
                    {DIFFICULTY.map((x) => (
                      <option key={x} value={x}>
                        {x || '—'}
                      </option>
                    ))}
                  </select>
                </td>
                <td className="ft-c-act" onClick={(e) => e.stopPropagation()}>
                  <button
                    className="ft-del"
                    aria-label={`「${t.name}」を削除`}
                    title="削除"
                    onClick={async () => {
                      const ok = await useUI.getState().confirm({
                        title: '工程を削除',
                        message: `「${t.name}」を削除します（配下の工程も削除されます）。`,
                        confirmLabel: '削除',
                        danger: true,
                      });
                      if (ok) removeTask(t.id);
                    }}
                  >
                    ×
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// スカラのテキストセル（uncontrolled・onBlur 確定。task 変更で defaultValue を作り直す）。
function TextCell({
  value,
  onCommit,
  taskKey,
  small,
}: {
  value: string | undefined;
  onCommit: (v: string) => void;
  taskKey: Id;
  small?: boolean;
}) {
  return (
    <td className={small ? 'ft-c-sm' : 'ft-c-text'} onClick={(e) => e.stopPropagation()}>
      <input
        className="ft-in"
        defaultValue={value ?? ''}
        key={`${taskKey}-${value ?? ''}`}
        onBlur={(e) => e.target.value !== (value ?? '') && onCommit(e.target.value)}
      />
    </td>
  );
}

// I/O セル（帳票/情報チップ。名前編集・種別・削除・追加）。
function IoCell({
  items,
  onAdd,
  onRename,
  onKind,
  onRemove,
}: {
  items: { id: Id; name: string; kind: IoKind }[];
  onAdd: () => void;
  onRename: (id: Id, name: string) => void;
  onKind: (id: Id, kind: IoKind) => void;
  onRemove: (id: Id) => void;
}) {
  return (
    <td className="ft-c-io" onClick={(e) => e.stopPropagation()}>
      <div className="ft-io">
        {items.map((it) => (
          <span className={`ft-iochip ${it.kind}`} key={it.id}>
            <input
              className="ft-io-name"
              defaultValue={it.name}
              key={`ion-${it.name}`}
              aria-label="名称"
              onBlur={(e) => onRename(it.id, e.target.value)}
            />
            <select
              className="ft-io-kind"
              value={it.kind}
              aria-label="種別"
              onChange={(e) => onKind(it.id, e.target.value as IoKind)}
            >
              <option value="doc">帳票</option>
              <option value="info">情報</option>
            </select>
            <button className="ft-x" aria-label="削除" onClick={() => onRemove(it.id)}>
              ×
            </button>
          </span>
        ))}
        <button className="ft-add" onClick={onAdd}>
          ＋
        </button>
      </div>
    </td>
  );
}
