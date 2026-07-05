// 印刷オプションダイアログ。印刷/PDF の前に「フロー粒度・課題レイヤ・課題一覧ページ」を選ばせる。
// 実際の印刷処理は App から渡す onPrint に委譲する（persistence.printProjectAndFlow を呼ぶ）。
import { useEffect, useRef, useState } from 'react';
import type { ProcessLevel } from '@gantt-flow/core';
import { useApp } from '../store';
import { useUI } from './useUI';
import { useFocusTrap } from './useFocusTrap';
import type { PrintOptions } from '../persistence';

const LEVELS: { key: ProcessLevel; label: string }[] = [
  { key: 'large', label: '大' },
  { key: 'medium', label: '中' },
  { key: 'small', label: '小' },
  { key: 'detail', label: '詳細' },
];

export function PrintDialog({ onPrint }: { onPrint: (level: ProcessLevel, opts: PrintOptions) => void }) {
  const open = useUI((s) => s.overlay === 'print');
  const close = () => useUI.getState().setOverlay(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const printBtnRef = useRef<HTMLButtonElement>(null);
  useFocusTrap(dialogRef, open);

  // 既定は現在の表示粒度・画面の課題レイヤ設定に合わせる。
  const currentLevel = useApp((s) => s.level);
  const currentShowIssues = useApp((s) => s.showIssues);
  const [level, setLevel] = useState<ProcessLevel>(currentLevel);
  const [includeIssues, setIncludeIssues] = useState(currentShowIssues);
  const [includeIssueListPage, setIncludeIssueListPage] = useState(false);

  // 開くたびに現在の状態へ初期化（前回の選択を持ち越さない）。
  useEffect(() => {
    if (open) {
      setLevel(currentLevel);
      setIncludeIssues(currentShowIssues);
      setIncludeIssueListPage(false);
      printBtnRef.current?.focus();
    }
  }, [open, currentLevel, currentShowIssues]);

  if (!open) return null;

  const doPrint = () => {
    close();
    onPrint(level, { includeIssues, includeIssueListPage });
  };

  return (
    <div className="modal-backdrop" onMouseDown={close}>
      <div
        className="modal print-modal"
        role="dialog"
        aria-modal="true"
        aria-label="印刷オプション"
        ref={dialogRef}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <h3 className="modal-title">印刷 / PDF のオプション</h3>
        <div className="print-opts">
          <label className="print-field">
            <span className="print-label">フロー図の粒度</span>
            <select
              className="print-select"
              value={level}
              onChange={(e) => setLevel(e.target.value as ProcessLevel)}
            >
              {LEVELS.map((l) => (
                <option key={l.key} value={l.key}>
                  {l.label}
                </option>
              ))}
            </select>
          </label>
          <label className="print-check">
            <input
              type="checkbox"
              checked={includeIssues}
              onChange={(e) => setIncludeIssues(e.target.checked)}
            />
            フロー図に課題（赤四角・注釈線）を載せる
          </label>
          <label className="print-check">
            <input
              type="checkbox"
              checked={includeIssueListPage}
              onChange={(e) => setIncludeIssueListPage(e.target.checked)}
            />
            課題一覧ページを追加する（工程横断の課題・方策の表）
          </label>
        </div>
        <div className="modal-actions">
          <button onClick={close}>キャンセル</button>
          <button ref={printBtnRef} className="primary" onClick={doPrint}>
            印刷 / PDF
          </button>
        </div>
      </div>
    </div>
  );
}
