import type { SVGProps } from 'react';

// 同梱の inline SVG アイコン（16px・currentColor・lucide 風の手書きパス）。依存なし・オフライン可。
function Svg(props: SVGProps<SVGSVGElement>) {
  const { children, ...rest } = props;
  return (
    <svg
      width={16}
      height={16}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...rest}
    >
      {children}
    </svg>
  );
}

export const Undo = (p: SVGProps<SVGSVGElement>) => (
  <Svg {...p}>
    <path d="M9 14 4 9l5-5" />
    <path d="M4 9h11a5 5 0 0 1 0 10h-2" />
  </Svg>
);
export const Redo = (p: SVGProps<SVGSVGElement>) => (
  <Svg {...p}>
    <path d="m15 14 5-5-5-5" />
    <path d="M20 9H9a5 5 0 0 0 0 10h2" />
  </Svg>
);
export const FilePlus = (p: SVGProps<SVGSVGElement>) => (
  <Svg {...p}>
    <path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" />
    <path d="M14 2v5h5" />
    <path d="M12 18v-6M9 15h6" />
  </Svg>
);
export const Upload = (p: SVGProps<SVGSVGElement>) => (
  <Svg {...p}>
    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
    <path d="M7 9l5-5 5 5" />
    <path d="M12 4v12" />
  </Svg>
);
export const FolderOpen = (p: SVGProps<SVGSVGElement>) => (
  <Svg {...p}>
    <path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.5l-2-2H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2Z" />
  </Svg>
);
export const Save = (p: SVGProps<SVGSVGElement>) => (
  <Svg {...p}>
    <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2Z" />
    <path d="M17 21v-8H7v8" />
    <path d="M7 3v5h8" />
  </Svg>
);
export const Download = (p: SVGProps<SVGSVGElement>) => (
  <Svg {...p}>
    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
    <path d="M7 10l5 5 5-5" />
    <path d="M12 15V3" />
  </Svg>
);
export const ChevronDown = (p: SVGProps<SVGSVGElement>) => (
  <Svg width={13} height={13} {...p}>
    <path d="m6 9 6 6 6-6" />
  </Svg>
);
export const Eye = (p: SVGProps<SVGSVGElement>) => (
  <Svg {...p}>
    <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z" />
    <circle cx="12" cy="12" r="3" />
  </Svg>
);
export const EyeOff = (p: SVGProps<SVGSVGElement>) => (
  <Svg {...p}>
    <path d="M9.9 4.2A10.9 10.9 0 0 1 12 4c6.5 0 10 8 10 8a18.5 18.5 0 0 1-2.16 3.19" />
    <path d="M6.6 6.6A18.5 18.5 0 0 0 2 12s3.5 7 10 7a10.9 10.9 0 0 0 3.9-.7" />
    <path d="m3 3 18 18" />
    <path d="M9.9 9.9a3 3 0 0 0 4.2 4.2" />
  </Svg>
);
export const Columns = (p: SVGProps<SVGSVGElement>) => (
  <Svg {...p}>
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <path d="M9 4v16M15 4v16" />
  </Svg>
);
export const Sun = (p: SVGProps<SVGSVGElement>) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="4" />
    <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
  </Svg>
);
export const Moon = (p: SVGProps<SVGSVGElement>) => (
  <Svg {...p}>
    <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z" />
  </Svg>
);
export const Sparkles = (p: SVGProps<SVGSVGElement>) => (
  <Svg {...p}>
    <path d="M12 3l1.9 4.6L18.5 9.5 13.9 11.4 12 16l-1.9-4.6L5.5 9.5l4.6-1.9z" />
    <path d="M19 14l.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8z" />
  </Svg>
);
export const Search = (p: SVGProps<SVGSVGElement>) => (
  <Svg {...p}>
    <circle cx="11" cy="11" r="7" />
    <path d="m21 21-4.3-4.3" />
  </Svg>
);
export const Keyboard = (p: SVGProps<SVGSVGElement>) => (
  <Svg {...p}>
    <rect x="2" y="6" width="20" height="12" rx="2" />
    <path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M7 14h10" />
  </Svg>
);
export const Maximize = (p: SVGProps<SVGSVGElement>) => (
  <Svg {...p}>
    <path d="M8 3H5a2 2 0 0 0-2 2v3M16 3h3a2 2 0 0 1 2 2v3M16 21h3a2 2 0 0 0 2-2v-3M8 21H5a2 2 0 0 1-2-2v-3" />
  </Svg>
);
export const Wand = (p: SVGProps<SVGSVGElement>) => (
  <Svg {...p}>
    <path d="m3 21 12-12" />
    <path d="M15 4V2M15 10V8M19 6h2M11 6h-1M17.8 8.8l1.4 1.4M17.8 3.2l1.4-1.4" />
  </Svg>
);
export const Trash = (p: SVGProps<SVGSVGElement>) => (
  <Svg {...p}>
    <path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
  </Svg>
);
export const Filter = (p: SVGProps<SVGSVGElement>) => (
  <Svg {...p}>
    <path d="M3 5h18l-7 8v6l-4-2v-4Z" />
  </Svg>
);
export const ListChecks = (p: SVGProps<SVGSVGElement>) => (
  <Svg {...p}>
    <path d="M3 5l2 2 3-3M3 13l2 2 3-3M11 6h10M11 14h10M11 20h10" />
  </Svg>
);
export const ChartBar = (p: SVGProps<SVGSVGElement>) => (
  <Svg {...p}>
    <path d="M3 3v18h18" />
    <path d="M7 16v-5M12 16V8M17 16v-3" />
  </Svg>
);
export const Clock = (p: SVGProps<SVGSVGElement>) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 7v5l3 2" />
  </Svg>
);
// As-Is / To-Be 比較。長短2本のバー＝改善前後の対比。
export const Compare = (p: SVGProps<SVGSVGElement>) => (
  <Svg {...p}>
    <path d="M4 7h15M4 7l3-3M4 7l3 3" />
    <path d="M20 17H5M20 17l-3-3M20 17l-3 3" />
  </Svg>
);
export const MapIcon = (p: SVGProps<SVGSVGElement>) => (
  <Svg {...p}>
    <path d="M9 4 3 6v14l6-2 6 2 6-2V4l-6 2-6-2Z" />
    <path d="M9 4v14M15 6v14" />
  </Svg>
);
export const Printer = (p: SVGProps<SVGSVGElement>) => (
  <Svg {...p}>
    <path d="M6 9V3h12v6" />
    <path d="M6 18H4a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2h-2" />
    <path d="M6 14h12v7H6z" />
  </Svg>
);
export const Image = (p: SVGProps<SVGSVGElement>) => (
  <Svg {...p}>
    <rect x="3" y="3" width="18" height="18" rx="2" />
    <circle cx="9" cy="9" r="2" />
    <path d="m21 15-5-5L5 21" />
  </Svg>
);
export const Gear = (p: SVGProps<SVGSVGElement>) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="3.2" />
    <path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1.03 1.56V21a2 2 0 1 1-4 0v-.09a1.7 1.7 0 0 0-1.11-1.56 1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.7 1.7 0 0 0 .34-1.87 1.7 1.7 0 0 0-1.56-1.03H3a2 2 0 1 1 0-4h.09A1.7 1.7 0 0 0 4.65 8.85a1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.7 1.7 0 0 0 1.87.34h.01A1.7 1.7 0 0 0 10.05 3V3a2 2 0 1 1 4 0v.09a1.7 1.7 0 0 0 1.03 1.56 1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.87v.01c.26.63.87 1.03 1.56 1.03H21a2 2 0 1 1 0 4h-.09c-.69 0-1.3.41-1.51 1.05Z" />
  </Svg>
);

// --- フロー・パレット / アウトライン操作のアイコン（形＝種類）。キャンバスの記法と対応。 ---
// 工程の追加（角丸矩形＋プラス）。工程ノード＝角丸矩形に対応。
export const BoxPlus = (p: SVGProps<SVGSVGElement>) => (
  <Svg {...p}>
    <rect x="3" y="5" width="18" height="14" rx="3" />
    <path d="M12 9.5v5M9.5 12h5" />
  </Svg>
);
// 開始（スタジアム形のターミネータ）。▶ で「開始」を示し、終了（■）と区別。
export const Play = (p: SVGProps<SVGSVGElement>) => (
  <Svg {...p}>
    <path d="M8 5.5v13l11-6.5z" />
  </Svg>
);
// 終了（スタジアム形のターミネータ）。■ で「終了」を示し、開始（▶）と区別。
export const Stop = (p: SVGProps<SVGSVGElement>) => (
  <Svg {...p}>
    <rect x="6" y="6" width="12" height="12" rx="2.5" />
  </Svg>
);
// 判断（ひし形）。キャンバスの判断ノード＝ひし形に対応。
export const Diamond = (p: SVGProps<SVGSVGElement>) => (
  <Svg {...p}>
    <path d="M12 3l9 9-9 9-9-9z" />
  </Svg>
);
// 合流（複数の流れが一つに）。
export const Merge = (p: SVGProps<SVGSVGElement>) => (
  <Svg {...p}>
    <path d="M6 5l6 7 6-7" />
    <path d="M12 12v7" />
  </Svg>
);
// 付箋（折り返した角のメモ）。課題・付箋ノードに対応。
export const StickyNote = (p: SVGProps<SVGSVGElement>) => (
  <Svg {...p}>
    <path d="M4 4h10l6 6v10H4z" />
    <path d="M14 4v6h6" />
  </Svg>
);
// すべて展開（上下に開く）。
export const UnfoldVertical = (p: SVGProps<SVGSVGElement>) => (
  <Svg {...p}>
    <path d="M8 9l4-4 4 4" />
    <path d="M8 15l4 4 4-4" />
  </Svg>
);
// すべて折りたたみ（上下から閉じる）。
export const FoldVertical = (p: SVGProps<SVGSVGElement>) => (
  <Svg {...p}>
    <path d="M8 5l4 4 4-4" />
    <path d="M8 19l4-4 4 4" />
  </Svg>
);
// ズーム拡大。
export const Plus = (p: SVGProps<SVGSVGElement>) => (
  <Svg {...p}>
    <path d="M12 5v14M5 12h14" />
  </Svg>
);
// ズーム縮小。
export const Minus = (p: SVGProps<SVGSVGElement>) => (
  <Svg {...p}>
    <path d="M5 12h14" />
  </Svg>
);
// 表⇄フロー の入れ替え（案A: 詳細を開いている側を切替）。
export const Swap = (p: SVGProps<SVGSVGElement>) => (
  <Svg {...p}>
    <path d="M8 3 4 7l4 4" />
    <path d="M4 7h16" />
    <path d="m16 21 4-4-4-4" />
    <path d="M20 17H4" />
  </Svg>
);
