// モーダル/オーバーレイ内に Tab フォーカスを閉じ込める（背面へ抜けない）。アクセシビリティ。
// 閉じたら開く前のフォーカス元へ戻す（キーボード操作の現在地を失わせない）。
import { useEffect, type RefObject } from 'react';

const FOCUSABLE =
  'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

export function useFocusTrap(ref: RefObject<HTMLElement>, active: boolean): void {
  useEffect(() => {
    if (!active) return undefined;
    const el = ref.current;
    if (!el) return undefined;
    // 開いた時点のフォーカス元を覚える（各ダイアログの初期フォーカス移動は
    // この effect より後に走るため、ここではまだ開く前の要素が取れる）。
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Tab') return;
      const items = Array.from(el.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
        (n) => n.offsetParent !== null || n === document.activeElement,
      );
      if (!items.length) return;
      const first = items[0]!;
      const last = items[items.length - 1]!;
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    el.addEventListener('keydown', onKey);
    return () => {
      el.removeEventListener('keydown', onKey);
      // 閉じたらフォーカス元へ戻す（モーダル内の要素ごと消えて body に落ちるのを防ぐ）。
      // フォーカス元自体が DOM から消えていたら何もしない。
      if (opener?.isConnected) opener.focus();
    };
  }, [ref, active]);
}
