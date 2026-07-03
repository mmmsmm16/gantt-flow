// 課題一覧。サンプルを seed し overlay='issues' を立てて開いた状態を見せる。
import { IssueListDialog, useApp, useUI } from '@gantt-flow/desktop';

useApp.getState().loadSample();
useUI.getState().setOverlay('issues');

export const Open = () => (
  <div style={{ width: 780, height: 580, position: 'relative', background: 'var(--bg)' }}>
    <IssueListDialog />
  </div>
);
