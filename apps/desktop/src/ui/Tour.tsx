// 使い方ツアー（コーチマーク）。サンプルを初めて開いたときに 4 ステップで
// コア価値「表とフローの同期」を体感させる。対象要素をハイライトし、カードで案内する。
import { useEffect, useState } from 'react';
import { useUI } from './useUI';

const DONE_KEY = 'gf-tour-done-v1';

interface Step {
  selector: string; // ハイライトする要素
  title: string;
  body: string;
}

const STEPS: Step[] = [
  {
    selector: '.table-pane',
    title: '1. 表で編集する',
    body: '工程表の作業名をクリックして書き換えてみてください。Enter で次の行、Tab で子工程にできます。',
  },
  {
    selector: '.flow-pane',
    title: '2. フローに自動同期',
    body: '表の編集は即座にフロー図へ反映されます。ノードはドラッグで動かせて、配置は編集後も保持されます。',
  },
  {
    selector: '.flow-palette',
    title: '3. フローを育てる',
    body: 'ノード右の ○ をドラッグすると前後関係の矢印を引けます。判断・付箋の追加や自動整列もここから。',
  },
  {
    selector: '.toolbar',
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

export function Tour() {
  const step = useUI((s) => s.tourStep);
  const setStep = useUI((s) => s.setTourStep);
  const [rect, setRect] = useState<DOMRect | null>(null);

  const cur = step != null ? STEPS[step] : undefined;

  // 対象要素の位置を追従（ステップ切替・リサイズ・レイアウト変化）。
  useEffect(() => {
    if (!cur) {
      setRect(null);
      return undefined;
    }
    const update = () => {
      const el = document.querySelector(cur.selector);
      setRect(el ? el.getBoundingClientRect() : null);
    };
    update();
    window.addEventListener('resize', update);
    const t = setInterval(update, 500); // ペイン開閉などの DOM 変化に追従（軽量ポーリング）
    return () => {
      window.removeEventListener('resize', update);
      clearInterval(t);
    };
  }, [cur]);

  if (step == null || !cur) return null;

  const finish = () => {
    markTourDone();
    setStep(null);
  };
  const next = () => {
    if (step >= STEPS.length - 1) finish();
    else setStep(step + 1);
  };

  // カードはハイライトの下（収まらなければ上）に置く。
  const cardW = 340;
  const margin = 12;
  let cardStyle: React.CSSProperties = { left: '50%', bottom: 24, transform: 'translateX(-50%)' };
  if (rect) {
    const left = Math.max(12, Math.min(window.innerWidth - cardW - 12, rect.left + rect.width / 2 - cardW / 2));
    const below = rect.bottom + margin;
    cardStyle =
      below + 150 < window.innerHeight
        ? { left, top: below }
        : { left, top: Math.max(12, rect.top - 150 - margin) };
  }

  return (
    <div className="tour-layer" role="dialog" aria-label="使い方ツアー">
      {rect && (
        <div
          className="tour-highlight"
          style={{ left: rect.left - 4, top: rect.top - 4, width: rect.width + 8, height: rect.height + 8 }}
        />
      )}
      <div className="tour-card" style={cardStyle}>
        <h4>{cur.title}</h4>
        <p>{cur.body}</p>
        <div className="tour-foot">
          <span className="tour-dots" aria-label={`ステップ ${step + 1} / ${STEPS.length}`}>
            {STEPS.map((_, i) => (
              <span key={i} className={`tour-dot${i === step ? ' on' : ''}`} />
            ))}
          </span>
          <span className="tour-actions">
            <button className="tour-skip" onClick={finish}>
              閉じる
            </button>
            <button className="tour-next" onClick={next} autoFocus>
              {step >= STEPS.length - 1 ? '完了' : '次へ'}
            </button>
          </span>
        </div>
      </div>
    </div>
  );
}
