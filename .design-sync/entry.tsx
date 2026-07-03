// design-sync バンドルのエントリ(barrel)。
// アプリの本来の起動点 main.tsx はトップレベルで createRoot().render() する副作用を
// 持つため、合成エントリ(全 .tsx を export *)には混ぜられない。ここで必要な
// コンポーネントだけを明示的に re-export し、window.<globalName> に載せる。
// プレビューでストアを seed できるよう useApp / useUI も併せて公開する。

// アイコン(純粋 SVG、ストア非依存)
export {
  Undo, Redo, FilePlus, Upload, FolderOpen, Save, Download, ChevronDown,
  Eye, EyeOff, Columns, Sun, Moon, Sparkles, Search, Keyboard, Maximize,
  Wand, Trash, Filter, ListChecks, ChartBar, Clock, MapIcon, Printer, Image, Gear,
} from '../apps/desktop/src/ui/icons';

// 主要画面
export { App } from '../apps/desktop/src/App';
export { FlowCanvas } from '../apps/desktop/src/FlowCanvas';
export { FullTable } from '../apps/desktop/src/FullTable';
export { TableView } from '../apps/desktop/src/TableView';
export { Inspector } from '../apps/desktop/src/Inspector';
export { StatusBar } from '../apps/desktop/src/ui/StatusBar';
export { Welcome } from '../apps/desktop/src/ui/Welcome';
export { CommandPalette } from '../apps/desktop/src/ui/CommandPalette';

// UI プリミティブ
export { Menu, MenuItem, MenuCheckItem } from '../apps/desktop/src/ui/Menu';
export { Modal, Toaster, BusyOverlay } from '../apps/desktop/src/ui/Dialogs';
export { Tour } from '../apps/desktop/src/ui/Tour';
export { ErrorBoundary } from '../apps/desktop/src/ui/ErrorBoundary';

// ダイアログ
export { BackupsDialog } from '../apps/desktop/src/ui/BackupsDialog';
export { HelpDialog } from '../apps/desktop/src/ui/HelpDialog';
export { SettingsDialog } from '../apps/desktop/src/ui/SettingsDialog';
export { SummaryDialog } from '../apps/desktop/src/ui/SummaryDialog';
export { IssueListDialog } from '../apps/desktop/src/ui/IssueListDialog';
export { KeybindingsEditor } from '../apps/desktop/src/ui/KeybindingsEditor';

// プレビューでのストア seed 用(コンポーネントではないが window.<global> に載せる)
export { useApp } from '../apps/desktop/src/store';
export { useUI } from '../apps/desktop/src/ui/useUI';
