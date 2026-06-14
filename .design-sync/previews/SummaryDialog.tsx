// 集計サマリ(粒度別件数・工数・自動化区分など)。サンプルを seed し overlay='summary'。
import { SummaryDialog, useApp, useUI } from '@gantt-flow/desktop';

useApp.getState().loadSample();
useUI.getState().setOverlay('summary');

export const Open = () => (
  <div style={{ width: 920, height: 640, position: 'relative', background: 'var(--bg)' }}>
    <SummaryDialog />
  </div>
);
