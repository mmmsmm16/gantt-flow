// サマリ / ダッシュボード。担当別の工数、自動化区分の割合、粒度別の工程数を一目で。
// 「どこに工数が偏っているか」「手作業がどれだけ残っているか」を改善提案の根拠に。
import { useEffect, useMemo, useRef } from 'react';
import type { ProcessLevel, Automation } from '@gantt-flow/core';
import { formatHours } from '@gantt-flow/core';
import { useApp } from '../store';
import { useUI } from './useUI';
import { useFocusTrap } from './useFocusTrap';

const LEVELS: { key: ProcessLevel; label: string }[] = [
  { key: 'large', label: '大' },
  { key: 'medium', label: '中' },
  { key: 'small', label: '小' },
  { key: 'detail', label: '詳細' },
];
const AUTO: { key: Automation | 'none'; label: string; cls: string }[] = [
  { key: 'manual', label: '手作業', cls: 'manual' },
  { key: 'partial', label: '一部自動', cls: 'partial' },
  { key: 'system', label: 'システム自動', cls: 'system' },
  { key: 'none', label: '未設定', cls: 'none' },
];

export function SummaryDialog() {
  const open = useUI((s) => s.overlay === 'summary');
  const project = useApp((s) => s.project);
  const close = () => useUI.getState().setOverlay(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  useFocusTrap(dialogRef, open);

  const data = useMemo(() => {
    const tasks = Object.values(project.core.tasks);
    const hasChild = new Set(tasks.map((t) => t.parentId).filter(Boolean) as string[]);
    const leaves = tasks.filter((t) => !hasChild.has(t.id)); // 工数は末端で集計
    // 担当別の工数（分）
    const byAssignee = new Map<string, number>();
    let totalMin = 0;
    for (const t of leaves) {
      const min = project.details[t.id]?.effortMinutes ?? 0;
      const name = t.assigneeId ? project.core.assignees[t.assigneeId]?.name ?? '（未割当）' : '（未割当）';
      byAssignee.set(name, (byAssignee.get(name) ?? 0) + min);
      totalMin += min;
    }
    const assignees = [...byAssignee.entries()].map(([name, min]) => ({ name, min })).sort((a, b) => b.min - a.min);
    // 自動化区分の割合（末端ベース）
    const autoCounts: Record<string, number> = { manual: 0, partial: 0, system: 0, none: 0 };
    for (const t of leaves) {
      const a = project.details[t.id]?.automation;
      autoCounts[a ?? 'none'] = (autoCounts[a ?? 'none'] ?? 0) + 1;
    }
    // 粒度別の工程数
    const levelCounts = LEVELS.map((l) => ({ ...l, n: tasks.filter((t) => t.level === l.key).length }));
    return { assignees, totalMin, autoCounts, leafCount: leaves.length, levelCounts, taskCount: tasks.length };
  }, [project]);

  // Esc は useGlobalHotkeys の「最上位レイヤを閉じる」一元処理が担う(個別リスナー不要)。
  useEffect(() => {
    if (open) closeRef.current?.focus();
  }, [open]);

  if (!open) return null;

  const maxAssignee = Math.max(1, ...data.assignees.map((a) => a.min));

  return (
    <div className="modal-backdrop" onMouseDown={close}>
      <div
        className="modal summary-modal"
        role="dialog"
        aria-modal="true"
        aria-label="サマリ"
        ref={dialogRef}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="help-head">
          <h3 className="modal-title">サマリ</h3>
          <button ref={closeRef} className="x" aria-label="閉じる" title="閉じる" onClick={close}>
            ×
          </button>
        </div>

        <div className="summary-grid">
          <section className="summary-card">
            <h4>担当別の工数</h4>
            {data.assignees.length === 0 ? (
              <p className="summary-empty">工数の入力がありません。</p>
            ) : (
              <ul className="sum-bars">
                {data.assignees.map((a) => (
                  <li key={a.name}>
                    <span className="sum-bar-label" title={a.name}>{a.name}</span>
                    <span className="sum-bar-track">
                      <span className="sum-bar-fill" style={{ width: `${(a.min / maxAssignee) * 100}%` }} />
                    </span>
                    <span className="sum-bar-val">{formatHours(a.min)}</span>
                  </li>
                ))}
              </ul>
            )}
            <p className="summary-total">合計 {formatHours(data.totalMin)}</p>
          </section>

          <section className="summary-card">
            <h4>自動化区分（末端 {data.leafCount} 工程）</h4>
            <div className="sum-auto-bar" role="img" aria-label="自動化区分の割合">
              {AUTO.map((a) => {
                const n = data.autoCounts[a.key] ?? 0;
                const pct = data.leafCount ? (n / data.leafCount) * 100 : 0;
                if (pct === 0) return null;
                return <span key={a.key} className={`sum-auto-seg auto-${a.cls}`} style={{ width: `${pct}%` }} title={`${a.label}: ${n}`} />;
              })}
            </div>
            <ul className="sum-auto-legend">
              {AUTO.map((a) => {
                const n = data.autoCounts[a.key] ?? 0;
                const pct = data.leafCount ? Math.round((n / data.leafCount) * 100) : 0;
                return (
                  <li key={a.key}>
                    <span className={`sum-auto-dot auto-${a.cls}`} />
                    {a.label} <strong>{n}</strong>（{pct}%）
                  </li>
                );
              })}
            </ul>
          </section>

          <section className="summary-card">
            <h4>粒度別の工程数</h4>
            <ul className="sum-levels">
              {data.levelCounts.map((l) => (
                <li key={l.key}>
                  <span className={`sum-level-badge lvl-${l.key}`}>{l.label}</span>
                  <strong>{l.n}</strong>
                </li>
              ))}
              <li className="sum-level-total">
                <span>合計</span>
                <strong>{data.taskCount}</strong>
              </li>
            </ul>
          </section>
        </div>
      </div>
    </div>
  );
}
