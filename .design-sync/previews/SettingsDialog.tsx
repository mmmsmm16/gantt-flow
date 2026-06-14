// 設定ダイアログ(一般 / キー / データのタブ)。overlay='settings' を立てて開いた状態を見せる。
import { SettingsDialog, useUI } from '@gantt-flow/desktop';

useUI.getState().setOverlay('settings');

export const Open = () => (
  <div style={{ width: 860, height: 600, position: 'relative', background: 'var(--bg)' }}>
    <SettingsDialog />
  </div>
);
