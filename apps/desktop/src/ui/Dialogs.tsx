// 自前の Modal（confirm / prompt）と Toaster。素の window.confirm/prompt/alert を置き換える。
// App 直下に <Modal /> と <Toaster /> を一度だけ置く。状態は useUI が保持。
import { useEffect, useRef, useState } from 'react';
import { useUI } from './useUI';

export function Modal() {
  const dialog = useUI((s) => s.dialog);
  const resolveDialog = useUI((s) => s.resolveDialog);
  const [value, setValue] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  // prompt を開いたら初期値を流し込み、入力にフォーカス。
  useEffect(() => {
    if (dialog?.kind === 'prompt') {
      setValue(dialog.defaultValue ?? '');
      const t = setTimeout(() => inputRef.current?.select(), 0);
      return () => clearTimeout(t);
    }
    return undefined;
  }, [dialog]);

  // Esc で取消。
  useEffect(() => {
    if (!dialog) return undefined;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') resolveDialog(dialog.kind === 'confirm' ? false : null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [dialog, resolveDialog]);

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
              if (e.key === 'Enter') ok();
            }}
          />
        )}
        <div className="modal-actions">
          <button onClick={cancel}>{dialog.cancelLabel ?? 'キャンセル'}</button>
          <button className={okClass} onClick={ok}>
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

function ToastView({
  item,
  onDone,
}: {
  item: { id: number; message: string; tone: string };
  onDone: (id: number) => void;
}) {
  useEffect(() => {
    const t = setTimeout(() => onDone(item.id), 4200);
    return () => clearTimeout(t);
  }, [item.id, onDone]);
  return (
    <div className={`toast toast-${item.tone}`} role="status">
      <span>{item.message}</span>
      <button className="toast-x" aria-label="閉じる" onClick={() => onDone(item.id)}>
        ×
      </button>
    </div>
  );
}
