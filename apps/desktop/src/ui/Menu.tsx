// 小さな汎用ドロップダウン（出力メニュー等）。外側クリック / Esc で閉じる。
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useUI } from './useUI';

export function Menu({
  label,
  title,
  className,
  children,
  onOpen,
}: {
  label: ReactNode;
  title?: string;
  className?: string;
  children: ReactNode;
  /** 開いた瞬間に呼ぶ。内容を開くたびに最新化したい場合（最近使ったファイル等）に使う。 */
  onOpen?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener('pointerdown', onDown);
    // Esc は useGlobalHotkeys の「最上位レイヤを閉じる」一元処理から、一時 UI として閉じてもらう。
    const unregister = useUI.getState().registerTransientLayer(() => setOpen(false));
    return () => {
      window.removeEventListener('pointerdown', onDown);
      unregister();
    };
  }, [open]);

  return (
    <div className="menu-wrap" ref={ref}>
      <button
        type="button"
        className={className}
        title={title}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => {
          if (!open) onOpen?.();
          setOpen(!open);
        }}
      >
        {label}
      </button>
      {open && (
        <div className="menu" role="menu" onClick={() => setOpen(false)}>
          {children}
        </div>
      )}
    </div>
  );
}

export function MenuItem({ children, onClick }: { children: ReactNode; onClick: () => void }) {
  return (
    <button type="button" className="menu-item" role="menuitem" onClick={onClick}>
      {children}
    </button>
  );
}

// チェックボックス項目。クリックでメニューを閉じない（複数列を続けてトグルできる）。
export function MenuCheckItem({
  label,
  checked,
  onChange,
}: {
  label: ReactNode;
  checked: boolean;
  onChange: () => void;
}) {
  return (
    <label
      className="menu-item menu-check"
      role="menuitemcheckbox"
      aria-checked={checked}
      onClick={(e) => e.stopPropagation()}
    >
      <input type="checkbox" checked={checked} onChange={onChange} />
      <span>{label}</span>
    </label>
  );
}
