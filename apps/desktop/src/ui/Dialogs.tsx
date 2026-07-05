// 自前の Modal（confirm / prompt）と Toaster。素の window.confirm/prompt/alert を置き換える。
// App 直下に <Modal /> と <Toaster /> を一度だけ置く。状態は useUI が保持。
import { useEffect, useRef, useState } from 'react';
import { useUI, TOAST_DURATION_MS, createPausableTimer, type ToastItem } from './useUI';
import { useFocusTrap } from './useFocusTrap';
import { isImeKeyEvent } from '../keymap';

export function Modal() {
  const dialog = useUI((s) => s.dialog);
  const resolveDialog = useUI((s) => s.resolveDialog);
  const [value, setValue] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const okRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  useFocusTrap(dialogRef, !!dialog);

  // 開いたら prompt は入力(初期値を選択)、confirm は OK ボタンへフォーカス。
  // autoFocus 属性ではなく effect で行う = useFocusTrap がフォーカス元を覚えた後に移す。
  useEffect(() => {
    if (!dialog) return undefined;
    if (dialog.kind === 'prompt') {
      setValue(dialog.defaultValue ?? '');
      const t = setTimeout(() => inputRef.current?.select(), 0);
      return () => clearTimeout(t);
    }
    okRef.current?.focus();
    return undefined;
  }, [dialog]);

  // Esc の取消は useGlobalHotkeys の「最上位レイヤを閉じる」一元処理(closeTopLayer)が担う。

  if (!dialog) return null;

  const cancel = () => resolveDialog(dialog.kind === 'confirm' ? false : null);
  const ok = () => resolveDialog(dialog.kind === 'confirm' ? true : value);
  const okClass = dialog.kind === 'confirm' && dialog.danger ? 'danger-solid' : 'primary';

  return (
    <div className="modal-backdrop" onMouseDown={cancel}>
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label={dialog.title ?? '確認'}
        ref={dialogRef}
        onMouseDown={(e) => e.stopPropagation()}
      >
        {dialog.title && <h3 className="modal-title">{dialog.title}</h3>}
        {dialog.message && <p className="modal-msg">{dialog.message}</p>}
        {dialog.kind === 'prompt' && (
          <input
            ref={inputRef}
            className="modal-input"
            value={value}
            placeholder={dialog.placeholder}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (isImeKeyEvent(e)) return; // IME 変換の確定 Enter をダイアログの確定にしない
              if (e.key === 'Enter') {
                // 確定でダイアログが同期的に消えるため、伝播させると window のグローバル
                // キー処理が「ダイアログ無し」として同じ Enter を再解釈してしまう
                // (例: フローで工程名の編集が開く)。ここで止める。
                e.preventDefault();
                e.stopPropagation();
                ok();
              }
            }}
          />
        )}
        <div className="modal-actions">
          {!(dialog.kind === 'confirm' && dialog.hideCancel) && (
            <button onClick={cancel}>{dialog.cancelLabel ?? 'キャンセル'}</button>
          )}
          <button ref={okRef} className={okClass} onClick={ok}>
            {dialog.confirmLabel ?? (dialog.kind === 'confirm' ? 'OK' : '追加')}
          </button>
        </div>
      </div>
    </div>
  );
}

export function Toaster() {
  const toasts = useUI((s) => s.toasts);
  const dismiss = useUI((s) => s.dismissToast);
  return (
    <div className="toaster" aria-live="polite">
      {toasts.map((t) => (
        <ToastView key={t.id} item={t} onDone={dismiss} />
      ))}
    </div>
  );
}

function ToastView({ item, onDone }: { item: ToastItem; onDone: (id: number) => void }) {
  // hover で消えるまでの時間を一時停止（読んでいる間に消えてしまうのを防ぐ）。
  // タイマー本体は useUI 側の純粋実装（createPausableTimer）に committed し、ここでは配線のみ。
  const timerRef = useRef<ReturnType<typeof createPausableTimer> | null>(null);
  useEffect(() => {
    const timer = createPausableTimer(TOAST_DURATION_MS[item.tone] ?? 4200, () => onDone(item.id));
    timerRef.current = timer;
    return () => timer.cancel();
  }, [item.id, item.tone, onDone]);
  return (
    <div
      className={`toast toast-${item.tone}`}
      role="status"
      onMouseEnter={() => timerRef.current?.pause()}
      onMouseLeave={() => timerRef.current?.resume()}
    >
      <span>{item.message}</span>
      {item.count && item.count > 1 && (
        <span className="toast-count" aria-label={`${item.count} 件`}>×{item.count}</span>
      )}
      {item.action && (
        <button
          className="toast-action"
          onClick={() => {
            item.action?.run();
            onDone(item.id);
          }}
        >
          {item.action.label}
        </button>
      )}
      <button className="toast-x" aria-label="閉じる" title="閉じる" onClick={() => onDone(item.id)}>
        ×
      </button>
    </div>
  );
}

// 重い処理中の全画面スピナー（取り込みなど）。useUI.setBusy(message) で表示する。
export function BusyOverlay() {
  const busy = useUI((s) => s.busy);
  if (!busy) return null;
  return (
    <div className="busy-overlay" role="status" aria-live="polite">
      <div className="busy-card">
        <span className="busy-spinner" aria-hidden="true" />
        <span>{busy}</span>
      </div>
    </div>
  );
}
