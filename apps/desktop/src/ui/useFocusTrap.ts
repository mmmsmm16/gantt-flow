// モーダル/オーバーレイ内に Tab フォーカスを閉じ込める（背面へ抜けない）。アクセシビリティ。
// 閉じたら開く前のフォーカス元へ戻す（キーボード操作の現在地を失わせない）。
import { useEffect, type RefObject } from 'react';

const FOCUSABLE =
  'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

// アクティブなトラップのスタック。複数同時（オーバーレイの上に確認ダイアログ等）でも
// 最前面（最後に開いたもの）だけが Tab を処理し、外側のトラップが横取りしないようにする。
const trapStack: HTMLElement[] = [];

export function useFocusTrap(ref: RefObject<HTMLElement>, active: boolean): void {
  useEffect(() => {
    if (!active) return undefined;
    const el = ref.current;
    if (!el) return undefined;
    // 開いた時点のフォーカス元を覚える（各ダイアログの初期フォーカス移動は
    // この effect より後に走るため、ここではまだ開く前の要素が取れる）。
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    trapStack.push(el);
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Tab') return;
      if (trapStack[trapStack.length - 1] !== el) return; // 最前面のトラップだけが処理する
      const items = Array.from(el.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
        (n) => n.offsetParent !== null || n === document.activeElement,
      );
      if (!items.length) return;
      const first = items[0]!;
      const last = items[items.length - 1]!;
      // モーダル要素ではなく document で受けるので、フォーカスが body 等モーダル外へ
      // 落ちてもトラップが無効化しない。外にいたら最初の要素へ引き戻す。
      if (!(document.activeElement instanceof HTMLElement) || !el.contains(document.activeElement)) {
        e.preventDefault();
        first.focus();
        return;
      }
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      const i = trapStack.lastIndexOf(el);
      if (i >= 0) trapStack.splice(i, 1);
      // 閉じたらフォーカス元へ戻す（モーダル内の要素ごと消えて body に落ちるのを防ぐ）。
      // フォーカス元自体が DOM から消えていたら何もしない。
      if (opener?.isConnected) opener.focus();
    };
  }, [ref, active]);
}
