// 小さな汎用ドロップダウン（出力メニュー等）。外側クリック / Esc で閉じる。
// キーボード操作は右クリックのコンテキストメニュー（FlowCanvas の ContextMenu）に合わせる:
// role=menu/menuitem＋↑↓（Home/End 追加）でロービングフォーカス、開いたら先頭項目へフォーカス。
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useUI } from './useUI';

// 項目要素自身がフォーカス可能ならそれを、そうでなければ内側の最初のフォーカス可能要素
// （MenuCheckItem は <label> なので中の <input>）を返す。
function focusableWithin(el: HTMLElement): HTMLElement {
  if (el.matches('button, input, [tabindex]')) return el;
  return el.querySelector<HTMLElement>('button, input, [tabindex]') ?? el;
}

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
  const menuRef = useRef<HTMLDivElement>(null);

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

  // 開いたら先頭項目へフォーカス（コンテキストメニューと同じ挙動）。閉じたら開く前の
  // フォーカスへ戻す（activeElement が body に落ちているときだけ＝項目クリックで別の
  // 入力へ移った場合は奪い返さない）。
  useEffect(() => {
    if (!open) return undefined;
    const prev = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const first = menuRef.current?.querySelector<HTMLElement>('.menu-item');
    if (first) focusableWithin(first).focus();
    return () => {
      if (prev?.isConnected && (document.activeElement === document.body || !document.activeElement)) {
        prev.focus();
      }
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
        <div
          ref={menuRef}
          className="menu"
          role="menu"
          onClick={() => setOpen(false)}
          onKeyDown={(e) => {
            // ↑↓/Home/End で項目間を巡回（ロービングフォーカス）。上位のキー操作へは流さない。
            if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return;
            e.preventDefault();
            e.stopPropagation();
            const items = Array.from(menuRef.current?.querySelectorAll<HTMLElement>('.menu-item') ?? []);
            if (items.length === 0) return;
            const focusables = items.map(focusableWithin);
            const i = focusables.indexOf(document.activeElement as HTMLElement);
            let next: number;
            if (e.key === 'Home') next = 0;
            else if (e.key === 'End') next = items.length - 1;
            else if (i < 0) next = e.key === 'ArrowDown' ? 0 : items.length - 1;
            else next = (i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
            focusables[next]!.focus();
          }}
        >
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
