// 全項目フル表（完全な工程表ビュー）。全工程を行・全フィールドを列にした 1 枚の編集グリッド。
// 粒度は 大/中/小/詳細工程の 4 列（各行は自分の粒度の列に作業名、上位列に親の工程名を再掲）。
// 課題/方策は独立列。列の表示切替・並べ替え・幅のドラッグ調整、テキスト列は折り返して全文表示。
// 行操作（追加/削除/選択）と Enter でのセル移動をやりやすく。
import { useEffect, useRef, useState } from 'react';
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

// 列の定義順（No. と act は常時表示）。
const COL_ORDER = [
  'no', 'large', 'medium', 'small', 'detail', 'assignee', 'prev', 'effort',
  'how', 'system', 'inputs', 'outputs', 'issue', 'measure', 'note', 'volume',
  'exception', 'automation', 'dataLink', 'regulation', 'difficulty', 'act',
] as const;
const DEFAULT_W: Record<string, number> = {
  no: 48, large: 110, medium: 110, small: 110, detail: 110, assignee: 110, prev: 150,
  effort: 64, how: 200, system: 170, inputs: 168, outputs: 168, issue: 200, measure: 200,
  note: 200, volume: 130, exception: 180, automation: 108, dataLink: 140, regulation: 140,
  difficulty: 62, act: 64,
};
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
  const addIssueWithMeasure = useApp((s) => s.addIssueWithMeasure);
  const updateIssue = useApp((s) => s.updateIssue);
  const removeIssue = useApp((s) => s.removeIssue);
  const addDependency = useApp((s) => s.addDependency);
  const removeDependency = useApp((s) => s.removeDependency);
  const addRootTask = useApp((s) => s.addRootTask);
  const addSiblingOf = useApp((s) => s.addSiblingOf);
  const removeTask = useApp((s) => s.removeTask);
  const setAssigneeManyByName = useApp((s) => s.setAssigneeManyByName);
  const removeManyTasks = useApp((s) => s.removeManyTasks);
  const ftColumns = useUI((s) => s.ftColumns);
  const toggleFtColumn = useUI((s) => s.toggleFtColumn);
  const ftColWidths = useUI((s) => s.ftColWidths);
  const setFtColWidth = useUI((s) => s.setFtColWidth);

  const [sort, setSort] = useState<{ key: string; dir: 'asc' | 'desc' } | null>(null);
  const [resizing, setResizing] = useState<{ key: string; w: number } | null>(null);
  const [focusTask, setFocusTask] = useState<Id | null>(null);
  // 一括操作のための行マーク（複数選択）。Ctrl/⌘+クリックでトグル、Shift+クリックで範囲。
  const [marked, setMarked] = useState<Set<Id>>(new Set());
  const [anchor, setAnchor] = useState<Id | null>(null);
  const tableRef = useRef<HTMLTableElement>(null);

  const byId = project.core.tasks;
  const tasks = Object.values(byId);
  const codes = computeCodes(project.core);
  const deps = Object.values(project.core.dependencies);
  const assigneeNames = [...new Set(Object.values(project.core.assignees).map((a) => a.name))];
  const parentsWithChildren = new Set(tasks.map((t) => t.parentId).filter(Boolean) as Id[]);

  const vis = (k: string) => ftColumns[k] !== false;
  const width = (k: string) => (resizing?.key === k ? resizing.w : ftColWidths[k] ?? DEFAULT_W[k]!);
  const visibleCols = COL_ORDER.filter((k) => k === 'no' || k === 'act' || vis(k));
  const visLevels = LEVELS.filter((l) => vis(l.key));
  const levelLeft = (key: ProcessLevel) => {
    let x = width('no');
    for (const l of visLevels) {
      if (l.key === key) return x;
      x += width(l.key);
    }
    return x;
  };
  const lastStickyKey = visLevels.length ? visLevels[visLevels.length - 1]!.key : null;

  // 新規追加した工程の作業名にフォーカス（連続入力）。
  useEffect(() => {
    if (!focusTask) return;
    const el = tableRef.current?.querySelector<HTMLInputElement>(`input[data-task="${focusTask}"]`);
    el?.focus();
    setFocusTask(null);
  }, [focusTask, tasks.length]);

  const sortValue = (key: string, t: ProcessTask): number | string => {
    if (key === 'effort') return effortRollupMinutes(project.core, project.details, t.id);
    if (key === 'assignee') return t.assigneeId ? project.core.assignees[t.assigneeId]?.name ?? '' : '';
    if (key === 'difficulty') return DIFF_RANK[project.details[t.id]?.difficulty ?? ''] ?? 0;
    if (key === 'automation') return project.details[t.id]?.automation ?? '';
    if (key === 'large' || key === 'medium' || key === 'small' || key === 'detail')
      return ancestryNames(t, byId)[key] ?? '';
    return 0;
  };

  const flat = flatten(tasks);
  let rows = flat;
  if (sort) {
    rows = [...flat].sort((x, y) => {
      const a = sortValue(sort.key, x);
      const b = sortValue(sort.key, y);
      const c = typeof a === 'number' && typeof b === 'number' ? a - b : String(a).localeCompare(String(b), 'ja');
      return c * (sort.dir === 'asc' ? 1 : -1);
    });
  }

  const clickSort = (key: string) =>
    setSort((cur) => (cur?.key !== key ? { key, dir: 'asc' } : cur.dir === 'asc' ? { key, dir: 'desc' } : null));

  // 行クリック: 通常＝単一選択（インスペクタ）、Ctrl/⌘＝トグル、Shift＝アンカーからの範囲選択。
  const onRowClick = (e: React.MouseEvent, t: ProcessTask) => {
    if (e.shiftKey && anchor) {
      const ids = rows.map((r) => r.id);
      const a = ids.indexOf(anchor);
      const b = ids.indexOf(t.id);
      if (a >= 0 && b >= 0) {
        const [lo, hi] = a < b ? [a, b] : [b, a];
        const next = new Set(marked);
        for (let i = lo; i <= hi; i++) next.add(ids[i]!);
        setMarked(next);
      }
      return;
    }
    if (e.ctrlKey || e.metaKey) {
      const next = new Set(marked);
      if (next.has(t.id)) next.delete(t.id);
      else next.add(t.id);
      setMarked(next);
      setAnchor(t.id);
      return;
    }
    setMarked(new Set()); // 通常クリックは一括選択を解除
    setAnchor(t.id);
    select(t.id);
  };

  const clearMarked = () => setMarked(new Set());
  const bulkAssign = async () => {
    const name = await useUI.getState().promptText({
      title: '担当を一括設定',
      message: `選択中の ${marked.size} 件の担当を変更します（空欄で未割当）。`,
      placeholder: '担当（部門 / 個人）',
      confirmLabel: '設定',
    });
    if (name === null) return;
    setAssigneeManyByName([...marked], name);
    clearMarked();
  };
  const bulkDelete = async () => {
    const ok = await useUI.getState().confirm({
      title: '工程を一括削除',
      message: `選択中の ${marked.size} 件を削除します（配下の工程は1つ上の階層へ繰り上げて残します）。`,
      confirmLabel: '削除',
      danger: true,
    });
    if (ok) {
      removeManyTasks([...marked]);
      clearMarked();
    }
  };

  // 列幅のドラッグ調整。
  const startResize = (key: string, e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const startW = width(key);
    setResizing({ key, w: startW });
    const onMove = (ev: PointerEvent) => setResizing({ key, w: Math.max(40, startW + (ev.clientX - startX)) });
    const onUp = (ev: PointerEvent) => {
      setFtColWidth(key, Math.max(40, startW + (ev.clientX - startX)));
      setResizing(null);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  const taskOfEvent = (e: React.KeyboardEvent): Id | null =>
    (e.target as HTMLElement).closest('tr')?.getAttribute('data-taskid') ?? null;

  // キーボード操作:
  //  Ctrl/⌘+Enter … 現在行の次に行を追加（連続入力）
  //  Ctrl/⌘+Delete … 現在行を削除（確認あり）
  //  Enter（単一行の入力）… 同じ列の下のセルへ移動（textarea は改行優先）
  const onGridKeyDown = (e: React.KeyboardEvent) => {
    const el = e.target as HTMLElement;
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault();
      const id = taskOfEvent(e);
      if (id) {
        const nid = addSiblingOf(id);
        if (nid) setFocusTask(nid);
      }
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key === 'Delete') {
      e.preventDefault();
      const id = taskOfEvent(e);
      const t = id ? byId[id] : undefined;
      if (t) {
        void useUI
          .getState()
          .confirm({
            title: '工程を削除',
            message: `「${t.name}」を削除します（配下の工程は1つ上の階層へ繰り上げて残します）。`,
            confirmLabel: '削除',
            danger: true,
          })
          .then((ok) => ok && removeTask(t.id));
      }
      return;
    }
    if (e.key !== 'Enter' || el.tagName !== 'INPUT') return;
    const r = el.dataset.r;
    const c = el.dataset.c;
    if (r == null || !c) return;
    e.preventDefault();
    const next = tableRef.current?.querySelector<HTMLInputElement>(`input[data-r="${Number(r) + 1}"][data-c="${c}"]`);
    next?.focus();
    next?.select?.();
  };

  if (flat.length === 0) {
    return (
      <div className="ft-empty">
        <p>工程がありません。</p>
        <button className="primary" onClick={() => addRootTask('large')}>
          ＋ 大工程を追加
        </button>
      </div>
    );
  }

  const Th = ({ k, label, cls, style }: { k: string; label: string; cls?: string; style?: React.CSSProperties }) => {
    const active = sort?.key === k;
    return (
      <th className={`${cls ?? ''}${active ? ' sorted' : ''}`} style={style}>
        {SORTABLE.has(k) ? (
          <button className="ft-sort" onClick={() => clickSort(k)} title={`${label}で並べ替え`}>
            {label}
            <span className="ft-sortmark">{active ? (sort!.dir === 'asc' ? '▲' : '▼') : '⇅'}</span>
          </button>
        ) : (
          label
        )}
        <span className="ft-resize" onPointerDown={(e) => startResize(k, e)} title="ドラッグで列幅を調整" />
      </th>
    );
  };

  return (
    <div className={`ft-wrap${resizing ? ' resizing' : ''}`}>
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
          <button className="ft-clear-sort" onClick={() => setSort(null)} title="工程順に戻す">
            並べ替え解除
          </button>
        )}
        {marked.size > 0 ? (
          <span className="ft-bulk" role="group" aria-label="一括操作">
            <strong>{marked.size}件選択中</strong>
            <button onClick={bulkAssign}>担当を一括設定</button>
            <button className="danger" onClick={bulkDelete}>まとめて削除</button>
            <button className="ft-bulk-clear" onClick={clearMarked}>選択解除</button>
          </span>
        ) : (
          <span className="ft-hint">
            行クリックで選択 / Ctrl・Shift+クリックで複数選択 / Ctrl+Enter＝行追加・Ctrl+Delete＝削除 / 列はドラッグで幅調整。
          </span>
        )}
      </div>
      <datalist id="ft-assignees">
        {assigneeNames.map((n) => (
          <option key={n} value={n} />
        ))}
      </datalist>
      <div className="ft-scroll">
      <table className="ft" ref={tableRef} onKeyDown={onGridKeyDown}>
        <colgroup>
          {visibleCols.map((k) => (
            <col key={k} style={{ width: width(k) }} />
          ))}
        </colgroup>
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
            {vis('prev') && <Th k="prev" label="前工程" cls="ft-c-prev" />}
            {vis('effort') && <Th k="effort" label="工数" cls="ft-c-effort" />}
            {vis('how') && <Th k="how" label="業務内容" cls="ft-c-text" />}
            {vis('system') && <Th k="system" label="使用システム" cls="ft-c-text" />}
            {vis('inputs') && <Th k="inputs" label="インプット" cls="ft-c-io" />}
            {vis('outputs') && <Th k="outputs" label="アウトプット" cls="ft-c-io" />}
            {vis('issue') && <Th k="issue" label="課題" cls="ft-c-issue" />}
            {vis('measure') && <Th k="measure" label="方策" cls="ft-c-issue" />}
            {vis('note') && <Th k="note" label="備考" cls="ft-c-text" />}
            {vis('volume') && <Th k="volume" label="ボリューム" cls="ft-c-sm" />}
            {vis('exception') && <Th k="exception" label="例外対応" cls="ft-c-text" />}
            {vis('automation') && <Th k="automation" label="自動化" cls="ft-c-auto" />}
            {vis('dataLink') && <Th k="dataLink" label="データ連携先" cls="ft-c-sm" />}
            {vis('regulation') && <Th k="regulation" label="関連規程" cls="ft-c-sm" />}
            {vis('difficulty') && <Th k="difficulty" label="難易度" cls="ft-c-diff" />}
            <th className="ft-c-act ft-sticky-r"></th>
          </tr>
        </thead>
        <tbody>
          {rows.map((t, ri) => {
            const d = project.details[t.id];
            const hasChildren = parentsWithChildren.has(t.id);
            const assigneeName = t.assigneeId ? project.core.assignees[t.assigneeId]?.name ?? '' : '';
            const anc = ancestryNames(t, byId);
            const issues = d?.issues ?? [];
            const preds = deps.filter((dep) => dep.to === t.id);
            const predIds = new Set(preds.map((dep) => dep.from));
            const succIds = new Set(deps.filter((dep) => dep.from === t.id).map((dep) => dep.to));
            const siblings = tasks.filter(
              (o) => o.id !== t.id && (o.parentId ?? undefined) === (t.parentId ?? undefined) && o.level === t.level,
            );
            const prevCandidates = siblings.filter((o) => !predIds.has(o.id) && !succIds.has(o.id));
            return (
              <tr
                key={t.id}
                data-taskid={t.id}
                className={`${t.id === selectedTaskId ? 'sel' : ''}${hasChildren ? ' parent' : ''}${marked.has(t.id) ? ' marked' : ''}`}
                onClick={(e) => onRowClick(e, t)}
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
                          data-task={t.id}
                          key={`name-${t.name}`}
                          onBlur={(e) => e.target.value !== t.name && renameTask(t.id, e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') {
                              e.preventDefault();
                              if (e.currentTarget.value !== t.name) renameTask(t.id, e.currentTarget.value);
                              const id = addSiblingOf(t.id);
                              if (id) setFocusTask(id);
                            }
                          }}
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
                      data-r={ri}
                      data-c="assignee"
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
                          className="ft-add ft-add-sel"
                          value=""
                          aria-label="前工程を追加"
                          title="前工程を追加"
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
                        data-r={ri}
                        data-c="effort"
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
                {vis('how') && <WrapCell value={d?.how} onCommit={(v) => updateDetail(t.id, { how: v })} k={t.id} />}
                {vis('system') && <WrapCell value={d?.system} onCommit={(v) => updateDetail(t.id, { system: v })} k={t.id} />}
                {vis('inputs') && <IoCell items={d?.inputs ?? []} direction="in" onAdd={() => addIo(t.id, 'inputs', '帳票')} onRename={(id, name) => updateIo(t.id, id, { name })} onKind={(id, kind) => updateIo(t.id, id, { kind })} onRemove={(id) => removeIo(t.id, id)} />}
                {vis('outputs') && <IoCell items={d?.outputs ?? []} direction="out" onAdd={() => addIo(t.id, 'outputs', '帳票')} onRename={(id, name) => updateIo(t.id, id, { name })} onKind={(id, kind) => updateIo(t.id, id, { kind })} onRemove={(id) => removeIo(t.id, id)} />}
                {vis('issue') && (
                  <td className="ft-c-issue" onClick={(e) => e.stopPropagation()}>
                    <div className="ft-issues">
                      {issues.map((iss) => (
                        <div className="ft-issue-row" key={iss.id}>
                          <AutoTextarea value={iss.issue} placeholder="課題" onCommit={(v) => updateIssue(t.id, iss.id, { issue: v })} />
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
                          <AutoTextarea value={iss.measure ?? ''} placeholder="方策" onCommit={(v) => updateIssue(t.id, iss.id, { measure: v || undefined })} />
                        </div>
                      ))}
                      {issues.length === 0 && (
                        // 課題が無くても方策を直接入力できる（入力時に課題を起票）。
                        <AutoTextarea value="" placeholder="方策" onCommit={(v) => v.trim() && addIssueWithMeasure(t.id, v)} />
                      )}
                    </div>
                  </td>
                )}
                {vis('note') && <WrapCell value={d?.note} onCommit={(v) => updateDetail(t.id, { note: v || undefined })} k={t.id} />}
                {vis('volume') && <WrapCell value={d?.volume} onCommit={(v) => updateDetail(t.id, { volume: v || undefined })} k={t.id} />}
                {vis('exception') && <WrapCell value={d?.exception} onCommit={(v) => updateDetail(t.id, { exception: v || undefined })} k={t.id} />}
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
                {vis('dataLink') && <WrapCell value={d?.dataLink} onCommit={(v) => updateDetail(t.id, { dataLink: v || undefined })} k={t.id} />}
                {vis('regulation') && <WrapCell value={d?.regulation} onCommit={(v) => updateDetail(t.id, { regulation: v || undefined })} k={t.id} />}
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
                <td className="ft-c-act ft-sticky-r" onClick={(e) => e.stopPropagation()}>
                  <div className="ft-rowact">
                    <button
                      className="ft-rowbtn"
                      aria-label="次の行を追加"
                      title="次の行を追加（同じ粒度）"
                      onClick={() => {
                        const id = addSiblingOf(t.id);
                        if (id) setFocusTask(id);
                      }}
                    >
                      ＋
                    </button>
                    <button
                      className="ft-rowbtn danger"
                      aria-label={`「${t.name}」を削除`}
                      title="この行を削除"
                      onClick={async () => {
                        const ok = await useUI.getState().confirm({
                          title: '工程を削除',
                          message: `「${t.name}」を削除します（配下の工程は1つ上の階層へ繰り上げて残します）。`,
                          confirmLabel: '削除',
                          danger: true,
                        });
                        if (ok) removeTask(t.id);
                      }}
                    >
                      <Icons.Trash />
                    </button>
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      </div>
    </div>
  );
}

// 折り返し対応の自動伸縮テキストエリア（全文表示。Enter は改行）。
function AutoTextarea({
  value,
  onCommit,
  placeholder,
}: {
  value: string | undefined;
  onCommit: (v: string) => void;
  placeholder?: string;
}) {
  const grow = (el: HTMLTextAreaElement | null) => {
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 220)}px`;
  };
  return (
    <textarea
      className="ft-in ft-area"
      rows={1}
      placeholder={placeholder}
      defaultValue={value ?? ''}
      key={`v-${value ?? ''}`}
      ref={grow}
      onInput={(e) => grow(e.currentTarget)}
      onBlur={(e) => e.target.value !== (value ?? '') && onCommit(e.target.value)}
    />
  );
}

function WrapCell({ value, onCommit }: { value: string | undefined; onCommit: (v: string) => void; k: Id }) {
  return (
    <td className="ft-c-text" onClick={(e) => e.stopPropagation()}>
      <AutoTextarea value={value} onCommit={onCommit} />
    </td>
  );
}

function IoCell({
  items,
  direction,
  onAdd,
  onRename,
  onKind,
  onRemove,
}: {
  items: { id: Id; name: string; kind: IoKind }[];
  direction: 'in' | 'out';
  onAdd: () => void;
  onRename: (id: Id, name: string) => void;
  onKind: (id: Id, kind: IoKind) => void;
  onRemove: (id: Id) => void;
}) {
  return (
    <td className="ft-c-io" onClick={(e) => e.stopPropagation()}>
      <div className="ft-io">
        {items.map((it) => (
          // 色は入出力の向き（フローと統一）。種別(帳票/情報)はセレクトの値で区別。
          <span className={`ft-iochip ${direction}`} key={it.id}>
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
