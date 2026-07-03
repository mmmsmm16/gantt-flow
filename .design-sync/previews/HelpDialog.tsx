// キーボード操作ヘルプ。overlay='help' を立てて開いた状態を見せる。
import { HelpDialog, useUI } from '@gantt-flow/desktop';

useUI.getState().setOverlay('help');

export const Open = () => (
  <div style={{ width: 920, height: 640, position: 'relative', background: 'var(--bg)' }}>
    <HelpDialog />
  </div>
);
