// バックアップ（世代）からの復元ダイアログ。保存のたびに残した直近世代を一覧し、
// クリックで復元（現在の状態は未保存扱いになるため、保存して確定するまで上書きしない）。
import { useEffect, useMemo, useRef } from 'react';
import { useApp } from '../store';
import { useUI } from './useUI';
import { useFocusTrap } from './useFocusTrap';
import { listBackups, restoreBackup } from '../backups';

const fmt = (iso: string) => {
  const d = new Date(iso);
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(
    d.getMinutes(),
  ).padStart(2, '0')}`;
};

export function BackupsDialog() {
  const open = useUI((s) => s.overlay === 'backups');
  const close = () => useUI.getState().setOverlay(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  useFocusTrap(dialogRef, open);

  const backups = useMemo(() => (open ? listBackups() : []), [open]);

  // Esc は useGlobalHotkeys の「最上位レイヤを閉じる」一元処理が担う。復元の confirm が
  // 重なっているときは confirm(最上位)だけが閉じ、このダイアログは残る。
  useEffect(() => {
    if (open) closeRef.current?.focus();
  }, [open]);

  if (!open) return null;

  const onRestore = async (index: number, label: string) => {
    const ok = await useUI.getState().confirm({
      title: 'バックアップから復元',
      message: `${label} の状態に戻します。現在の内容は復元後に保存するまで確定しません。`,
      confirmLabel: '復元する',
    });
    if (!ok) return;
    const p = restoreBackup(index);
    if (p) {
      useApp.getState().restoreProject(p); // 未保存(dirty)として読み込む＝保存して確定
      useUI.getState().toast('バックアップを復元しました。内容を確認して保存してください。', 'success');
      close();
    } else {
      useUI.getState().toast('このバックアップは復元できませんでした。', 'error');
    }
  };

  return (
    <div className="modal-backdrop" onMouseDown={close}>
      <div
        className="modal backups-modal"
        role="dialog"
        aria-modal="true"
        aria-label="バックアップから復元"
        ref={dialogRef}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="help-head">
          <h3 className="modal-title">バックアップから復元</h3>
          <button ref={closeRef} className="x" aria-label="閉じる" onClick={close}>
            ×
          </button>
        </div>
        {backups.length === 0 ? (
          <p className="issues-empty">
            バックアップがまだありません。保存（Ctrl+S）のたびに直近 5 世代をこの端末に残します。
          </p>
        ) : (
          <ul className="backup-list">
            {backups.map((b, i) => (
              <li key={b.at}>
                <button className="backup-item" onClick={() => void onRestore(i, fmt(b.at))}>
                  <span className="bk-when">{fmt(b.at)}</span>
                  <span className="bk-title">{b.title}</span>
                  <span className="bk-meta">工程 {b.taskCount} 件</span>
                  {i === 0 && <span className="bk-latest">最新</span>}
                </button>
              </li>
            ))}
          </ul>
        )}
        <p className="backup-foot">保存のたびに自動で残します（この端末の localStorage・最大 5 世代）。</p>
      </div>
    </div>
  );
}
