// コマンドパレット(⌘K)。overlay='palette' を立て、サンプルを seed して開いた状態を見せる。
import { CommandPalette, useApp, useUI } from '@gantt-flow/desktop';

useApp.getState().loadSample();
useUI.getState().setOverlay('palette');

export const Open = () => (
  <div style={{ width: 900, height: 600, position: 'relative', background: 'var(--bg)' }}>
    <CommandPalette />
  </div>
);
