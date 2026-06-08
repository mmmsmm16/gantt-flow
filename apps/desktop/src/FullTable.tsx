// 全項目フル表（完全な工程表ビュー）。全工程を行・全フィールドを列にした 1 枚の編集グリッド。
// 粒度は 大/中/小/詳細工程の 4 列で表現（各行は自分の粒度の列に作業名、上位列には親の工程名を再掲）。
// 課題と方策は独立列。列は表示/非表示を切替（列メニュー）、ヘッダクリックで並べ替え（工数・担当ほか）。
import { useMemo, useState } from 'react';
import type { ProcessTask, ProcessLevel, Id, Automation, Difficulty, IoKind } from '@gantt-flow/core';
import { computeCodes, effortRollupMinutes, formatHours } from '@gantt-flow/core';
import { useApp } from './store';
import { useUI } from './ui/useUI';
import { Menu, MenuCheckItem } from './ui/Menu';
import * as Icons from './ui/icons';

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
const DIFF_RANK: Record<string, number> = { H: 3, M: 2, L: 1, '': 0 };

// 列メニューに出す（＝表示/非表示できる）列。No. は常時表示。
const TOGGLE_COLS: { key: string; label: string }[] = [
  ...LEVELS,
  { key: 'assignee', label: '担当' },
  { key: 'prev', label: '前工程' },
  { key: 'effort', label: '工数' },
  { key: 'how', label: '業務内容' },
  { key: 'system', label: '使用システム' },
  { key: 'inputs', label: 'インプット' },
  { key: 'outputs', label: 'アウトプット' },
  { key: 'issue', label: '課題' },
  { key: 'measure', label: '方策' },
  { key: 'note', label: '備考' },
  { key: 'volume', label: 'ボリューム' },
  { key: 'exception', label: '例外対応' },
  { key: 'automation', label: '自動化' },
  { key: 'dataLink', label: 'データ連携先' },
  { key: 'regulation', label: '関連規程' },
  { key: 'difficulty', label: '難易度' },
];
const SORTABLE = new Set(['large', 'medium', 'small', 'detail', 'assignee', 'effort', 'difficulty', 'automation']);

const NO_W = 48;
const LEVEL_W = 104;

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
  const ftColumns = useUI((s) => s.ftColumns);
  const toggleFtColumn = useUI((s) => s.toggleFtColumn);

  const [sort, setSort] = useState<{ key: string; dir: 'asc' | 'desc' } | null>(null);

  const byId = project.core.tasks;
  const tasks = Object.values(byId);
  const codes = computeCodes(project.core);
  const deps = Object.values(project.core.dependencies);
  const assigneeNames = [...new Set(Object.values(project.core.assignees).map((a) => a.name))];
  const parentsWithChildren = new Set(tasks.map((t) => t.parentId).filter(Boolean) as Id[]);

  const vis = (k: string) => ftColumns[k] !== false;
  const visLevels = LEVELS.filter((l) => vis(l.key));
  const levelLeft = (key: ProcessLevel) => NO_W + visLevels.findIndex((l) => l.key === key) * LEVEL_W;
  const lastStickyKey = visLevels.length ? visLevels[visLevels.length - 1]!.key : null;

  const sortValue = (key: string, t: ProcessTask): number | string => {
    if (key === 'effort') return effortRollupMinutes(project.core, project.details, t.id);
    if (key === 'assignee') return t.assigneeId ? project.core.assignees[t.assigneeId]?.name ?? '' : '';
    if (key === 'difficulty') return DIFF_RANK[project.details[t.id]?.difficulty ?? ''] ?? 0;
    if (key === 'automation') return project.details[t.id]?.automation ?? '';
    if (key === 'large' || key === 'medium' || key === 'small' || key === 'detail')
      return ancestryNames(t, byId)[key] ?? '';
    return 0;
  };

  const rows = useMemo(() => {
    const flat = flatten(tasks);
    if (!sort) return flat;
    const arr = [...flat];
    arr.sort((x, y) => {
      const a = sortValue(sort.key, x);
      const b = sortValue(sort.key, y);
      const c = typeof a === 'number' && typeof b === 'number' ? a - b : String(a).localeCompare(String(b), 'ja');
      return c * (sort.dir === 'asc' ? 1 : -1);
    });
    return arr;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tasks, sort, project.details, project.core.assignees]);

  const clickSort = (key: string) =>
    setSort((cur) =>
      cur?.key !== key ? { key, dir: 'asc' } : cur.dir === 'asc' ? { key, dir: 'desc' } : null,
    );

  if (flatten(tasks).length === 0) {
    return (
      <div className="ft-empty">
        <p>工程がありません。</p>
        <button className="primary" onClick={() => addRootTask('large')}>
          ＋ 大工程を追加
        </button>
      </div>
    );
  }

  // ソート可能なヘッダ（ラベル＋▲▼）。
  const Th = ({ k, label, cls, style }: { k: string; label: string; cls?: string; style?: React.CSSProperties }) => {
    const active = sort?.key === k;
    const sortable = SORTABLE.has(k);
    return (
      <th className={`${cls ?? ''}${active ? ' sorted' : ''}`} style={style}>
        {sortable ? (
          <button className="ft-sort" onClick={() => clickSort(k)} title={`${label}で並べ替え`}>
            {label}
            <span className="ft-sortmark">{active ? (sort!.dir === 'asc' ? '▲' : '▼') : '⇅'}</span>
          </button>
        ) : (
          label
        )}
      </th>
    );
  };

  return (
    <div className="ft-wrap">
      <div className="ft-actions">
        <button className="primary" onClick={() => addRootTask('large')}>
          ＋ 大工程
        </button>
        <button onClick={() => addRootTask('medium')}>＋ 中工程</button>
        <Menu
          className="icon-btn menu-trigger col-menu"
          title="表示する列"
          label={
            <>
              <Icons.Columns />列<Icons.ChevronDown />
            </>
          }
        >
          {TOGGLE_COLS.map((c) => (
            <MenuCheckItem key={c.key} label={c.label} checked={vis(c.key)} onChange={() => toggleFtColumn(c.key)} />
          ))}
        </Menu>
        {sort && (
          <button className="ft-clear-sort" onClick={() => setSort(null)} title="並べ替えを解除（工程順に戻す）">
            並べ替え解除
          </button>
        )}
        <span className="ft-hint">列の表示/非表示・ヘッダクリックで並べ替え。横スクロールで全列。</span>
      </div>
      <datalist id="ft-assignees">
        {assigneeNames.map((n) => (
          <option key={n} value={n} />
        ))}
      </datalist>
      <table className="ft">
        <thead>
          <tr>
            <th className="ft-c-no ft-sticky" style={{ left: 0 }} title="工程順に戻す">
              <button className="ft-sort" onClick={() => setSort(null)}>
                No.
              </button>
            </th>
            {LEVELS.map(
              (l) =>
                vis(l.key) && (
                  <Th
                    key={l.key}
                    k={l.key}
                    label={l.label}
                    cls={`ft-c-level ft-sticky${l.key === lastStickyKey ? ' ft-sticky-last' : ''}`}
                    style={{ left: levelLeft(l.key) }}
                  />
                ),
            )}
            {vis('assignee') && <Th k="assignee" label="担当" cls="ft-c-assignee" />}
            {vis('prev') && <th className="ft-c-prev">前工程</th>}
            {vis('effort') && <Th k="effort" label="工数" cls="ft-c-effort" />}
            {vis('how') && <th className="ft-c-text">業務内容</th>}
            {vis('system') && <th className="ft-c-text">使用システム</th>}
            {vis('inputs') && <th className="ft-c-io">インプット</th>}
            {vis('outputs') && <th className="ft-c-io">アウトプット</th>}
            {vis('issue') && <th className="ft-c-issue">課題</th>}
            {vis('measure') && <th className="ft-c-issue">方策</th>}
            {vis('note') && <th className="ft-c-text">備考</th>}
            {vis('volume') && <th className="ft-c-sm">ボリューム</th>}
            {vis('exception') && <th className="ft-c-text">例外対応</th>}
            {vis('automation') && <Th k="automation" label="自動化" cls="ft-c-auto" />}
            {vis('dataLink') && <th className="ft-c-sm">データ連携先</th>}
            {vis('regulation') && <th className="ft-c-sm">関連規程</th>}
            {vis('difficulty') && <Th k="difficulty" label="難易度" cls="ft-c-diff" />}
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
                <td className="ft-c-no ft-sticky" style={{ left: 0 }} title={codes[t.id]}>
                  {codes[t.id]}
                </td>
                {LEVELS.map((l) => {
                  if (!vis(l.key)) return null;
                  const own = l.key === t.level;
                  const name = anc[l.key];
                  return (
                    <td
                      key={l.key}
                      className={`ft-c-level ft-sticky${l.key === lastStickyKey ? ' ft-sticky-last' : ''} ${own ? 'own' : name ? 'anc' : 'blank'}`}
                      style={{ left: levelLeft(l.key) }}
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
                {vis('assignee') && (
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
                )}
                {vis('prev') && (
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
                )}
                {vis('effort') && (
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
                )}
                {vis('how') && <TextCell value={d?.how} onCommit={(v) => updateDetail(t.id, { how: v })} taskKey={t.id} />}
                {vis('system') && <TextCell value={d?.system} onCommit={(v) => updateDetail(t.id, { system: v })} taskKey={t.id} />}
                {vis('inputs') && <IoCell items={d?.inputs ?? []} onAdd={() => addIo(t.id, 'inputs', '帳票')} onRename={(id, name) => updateIo(t.id, id, { name })} onKind={(id, kind) => updateIo(t.id, id, { kind })} onRemove={(id) => removeIo(t.id, id)} />}
                {vis('outputs') && <IoCell items={d?.outputs ?? []} onAdd={() => addIo(t.id, 'outputs', '帳票')} onRename={(id, name) => updateIo(t.id, id, { name })} onKind={(id, kind) => updateIo(t.id, id, { kind })} onRemove={(id) => removeIo(t.id, id)} />}
                {vis('issue') && (
                  <td className="ft-c-issue" onClick={(e) => e.stopPropagation()}>
                    <div className="ft-issues">
                      {issues.map((iss) => (
                        <div className="ft-issue-row" key={iss.id}>
                          <input className="ft-in" defaultValue={iss.issue} placeholder="課題" key={`iss-${iss.issue}`} onBlur={(e) => updateIssue(t.id, iss.id, { issue: e.target.value })} />
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
                )}
                {vis('measure') && (
                  <td className="ft-c-issue" onClick={(e) => e.stopPropagation()}>
                    <div className="ft-issues">
                      {issues.map((iss) => (
                        <div className="ft-issue-row" key={iss.id}>
                          <input className="ft-in" defaultValue={iss.measure ?? ''} placeholder="方策" key={`msr-${iss.measure ?? ''}`} onBlur={(e) => updateIssue(t.id, iss.id, { measure: e.target.value || undefined })} />
                        </div>
                      ))}
                    </div>
                  </td>
                )}
                {vis('note') && <TextCell value={d?.note} onCommit={(v) => updateDetail(t.id, { note: v || undefined })} taskKey={t.id} />}
                {vis('volume') && <TextCell value={d?.volume} onCommit={(v) => updateDetail(t.id, { volume: v || undefined })} taskKey={t.id} small />}
                {vis('exception') && <TextCell value={d?.exception} onCommit={(v) => updateDetail(t.id, { exception: v || undefined })} taskKey={t.id} />}
                {vis('automation') && (
                  <td className="ft-c-auto" onClick={(e) => e.stopPropagation()}>
                    <select className="ft-in" value={d?.automation ?? ''} aria-label="自動化区分" onChange={(e) => updateDetail(t.id, { automation: (e.target.value || undefined) as Automation | undefined })}>
                      {AUTOMATION.map((a) => (
                        <option key={a.key} value={a.key}>
                          {a.label}
                        </option>
                      ))}
                    </select>
                  </td>
                )}
                {vis('dataLink') && <TextCell value={d?.dataLink} onCommit={(v) => updateDetail(t.id, { dataLink: v || undefined })} taskKey={t.id} small />}
                {vis('regulation') && <TextCell value={d?.regulation} onCommit={(v) => updateDetail(t.id, { regulation: v || undefined })} taskKey={t.id} small />}
                {vis('difficulty') && (
                  <td className="ft-c-diff" onClick={(e) => e.stopPropagation()}>
                    <select className="ft-in" value={d?.difficulty ?? ''} aria-label="難易度" onChange={(e) => updateDetail(t.id, { difficulty: (e.target.value || undefined) as Difficulty | undefined })}>
                      {DIFFICULTY.map((x) => (
                        <option key={x} value={x}>
                          {x || '—'}
                        </option>
                      ))}
                    </select>
                  </td>
                )}
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
      <input className="ft-in" defaultValue={value ?? ''} key={`${taskKey}-${value ?? ''}`} onBlur={(e) => e.target.value !== (value ?? '') && onCommit(e.target.value)} />
    </td>
  );
}

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
            <input className="ft-io-name" defaultValue={it.name} key={`ion-${it.name}`} aria-label="名称" onBlur={(e) => onRename(it.id, e.target.value)} />
            <select className="ft-io-kind" value={it.kind} aria-label="種別" onChange={(e) => onKind(it.id, e.target.value as IoKind)}>
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
