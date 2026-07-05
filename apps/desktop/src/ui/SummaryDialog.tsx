// サマリ / ダッシュボード。担当別の工数、自動化区分の割合、粒度別の工程数を一目で。
// 「どこに工数が偏っているか」「手作業がどれだけ残っているか」を改善提案の根拠に。
import { useEffect, useMemo, useRef } from 'react';
import type { ProcessLevel, Automation } from '@gantt-flow/core';
import { formatHours, computeProjectSummary } from '@gantt-flow/core';
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

  // 集計は core の純関数へ集約（Excel サマリシートと同一ロジックを共有）。
  // 粒度は core が large/medium/small/detail 順で返すので UI 用ラベルを合わせて付け直す。
  const data = useMemo(() => {
    const s = computeProjectSummary(project.core, project.details);
    const labelOf = new Map(LEVELS.map((l) => [l.key, l.label]));
    return {
      ...s,
      levelCounts: s.levelCounts.map((l) => ({ key: l.key, label: labelOf.get(l.key) ?? l.key, n: l.n })),
    };
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
