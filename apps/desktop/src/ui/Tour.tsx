// 使い方ツアー（コーチマーク）。初回に 4 ステップでコア価値「表とフローの同期」を
// 体感させる。全導線（サンプル / テンプレート / 取り込み / 空スタート）で提示する。
// 各ステップは具体的な要素（最初の作業名セル・実ノード・パレット・検索ボタン）を
// 遅延探索してハイライトし、対象が無ければハイライトだけ省いてカードは可視域に出す。
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useUI } from './useUI';

const DONE_KEY = 'gf-tour-done-v1';

interface Step {
  // ハイライト対象の候補（先頭から探索し、最初に見つかった要素を使う）。
  // 具体要素（例: 最初の作業名セル）を先頭に、無いときのフォールバック（ペイン）を後ろに。
  selectors: string[];
  title: string;
  body: string;
}

// 各ステップの先頭は「具体的な要素」。見つからなければ後続のフォールバックへ落ちる。
export const TOUR_STEPS: Step[] = [
  {
    selectors: ['.outline .name-input', '.table-pane'],
    title: '1. 表で編集する',
    body: 'この作業名セルを書き換えてみてください。Enter で下のセル、Tab で右のセルへ移動できます。',
  },
  {
    selectors: ['.node.task', '.flow-canvas', '.flow-pane'],
    title: '2. フローに自動同期',
    body: '表の編集は、この工程ノードへ即座に反映されます。ノードはドラッグで動かせ、配置は編集後も保持されます。',
  },
  {
    selectors: ['.flow-palette .add-task', '.flow-palette', '.flow-pane'],
    title: '3. フローを育てる',
    body: 'ノード右の ○ をドラッグすると前後関係の矢印を引けます。判断・付箋の追加や自動整列もここから。',
  },
  {
    selectors: ['.toolbar [aria-label="コマンド・工程を検索"]', '.toolbar'],
    title: '4. 迷ったら Ctrl+K',
    body: 'コマンドパレット（Ctrl/⌘+K）から全操作の実行と工程の検索ができます。? でショートカット一覧。',
  },
];

export function tourDone(): boolean {
  try {
    return localStorage.getItem(DONE_KEY) === '1';
  } catch {
    return true; // localStorage 不可なら毎回出さない
  }
}
function markTourDone(): void {
  try {
    localStorage.setItem(DONE_KEY, '1');
  } catch {
    /* 無視 */
  }
}

// 空スタート経路で「最初の工程が作られた瞬間」にツアーを提示すべきか（初回のみ）。
// isEmpty の判定は呼び出し側（工程 0→1 の遷移）で済ませ、ここは保留中×未完了だけを見る。
export function shouldStartTourOnFirstTask(opts: { pending: boolean; done: boolean }): boolean {
  return opts.pending && !opts.done;
}

// 候補セレクタを先頭から探索。見つかった実在要素を返す（無ければ null）。
function locate(selectors: string[]): Element | null {
  for (const sel of selectors) {
    const el = document.querySelector(sel);
    if (el) return el;
  }
  return null;
}

function sameRect(a: DOMRect | null, b: DOMRect | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.left === b.left && a.top === b.top && a.width === b.width && a.height === b.height;
}

export function Tour() {
  const step = useUI((s) => s.tourStep);
  const setStep = useUI((s) => s.setTourStep);
  const [rect, setRect] = useState<DOMRect | null>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const [cardStyle, setCardStyle] = useState<React.CSSProperties>({
    left: '50%',
    top: '50%',
    transform: 'translate(-50%, -50%)',
  });

  const cur = step != null ? TOUR_STEPS[step] : undefined;

  // 対象要素の位置を遅延探索して追従（ステップ切替・リサイズ・レイアウト変化）。
  // 要素が無いステップでも落ちず、rect=null（ハイライト無し）で継続する。
  useEffect(() => {
    if (!cur) {
      setRect(null);
      return undefined;
    }
    const update = () => {
      const el = locate(cur.selectors);
      const next = el ? el.getBoundingClientRect() : null;
      setRect((prev) => (sameRect(prev, next) ? prev : next));
    };
    update();
    window.addEventListener('resize', update);
    const t = setInterval(update, 500); // ペイン開閉・スクロールなどの DOM 変化に追従（軽量ポーリング）
    return () => {
      window.removeEventListener('resize', update);
      clearInterval(t);
    };
  }, [cur]);

  // カードを常に可視域へ収める（flow-empty の見切れ対策と同方針: 実寸を測って両軸クランプ）。
  // 対象があればその下（収まらなければ上）へ、無ければ画面中央へ。useLayoutEffect で描画前に確定。
  useLayoutEffect(() => {
    if (step == null) return;
    const card = cardRef.current;
    if (!card) return;
    const m = 12;
    const cw = card.offsetWidth;
    const ch = card.offsetHeight;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const clampX = (x: number) => Math.max(m, Math.min(vw - cw - m, x));
    const clampY = (y: number) => Math.max(m, Math.min(vh - ch - m, y));
    if (!rect) {
      setCardStyle({ left: clampX((vw - cw) / 2), top: clampY((vh - ch) / 2) });
      return;
    }
    const left = clampX(rect.left + rect.width / 2 - cw / 2);
    const below = rect.bottom + m;
    const above = rect.top - ch - m;
    const top = below + ch + m <= vh ? below : above >= m ? above : clampY(below);
    setCardStyle({ left, top });
  }, [rect, step]);

  if (step == null || !cur) return null;

  const finish = () => {
    markTourDone();
    setStep(null);
  };
  const next = () => {
    if (step >= TOUR_STEPS.length - 1) finish();
    else setStep(step + 1);
  };

  return (
    <div className="tour-layer" role="dialog" aria-label="使い方ツアー">
      {rect && (
        <div
          className="tour-highlight"
          style={{ left: rect.left - 4, top: rect.top - 4, width: rect.width + 8, height: rect.height + 8 }}
        />
      )}
      <div className="tour-card" ref={cardRef} style={cardStyle}>
        <h4>{cur.title}</h4>
        <p>{cur.body}</p>
        <div className="tour-foot">
          <span className="tour-dots" aria-label={`ステップ ${step + 1} / ${TOUR_STEPS.length}`}>
            {TOUR_STEPS.map((_, i) => (
              <span key={i} className={`tour-dot${i === step ? ' on' : ''}`} />
            ))}
          </span>
          <span className="tour-actions">
            {/* autoFocus は付けない: 空スタートの教育瞬間に作業名入力からフォーカスを奪わないため。 */}
            <button className="tour-skip" onClick={finish}>
              閉じる
            </button>
            <button className="tour-next" onClick={next}>
              {step >= TOUR_STEPS.length - 1 ? '完了' : '次へ'}
            </button>
          </span>
        </div>
      </div>
    </div>
  );
}
