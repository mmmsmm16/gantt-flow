// スイムレーン業務フロー図(表から自動同期)。サンプルを seed して描画。
import { FlowCanvas, useApp } from '@gantt-flow/desktop';

useApp.getState().loadSample();

export const WithSample = () => (
  <div style={{ height: 620, width: '100%', position: 'relative', overflow: 'hidden', background: 'var(--canvas-bg)' }}>
    <FlowCanvas />
  </div>
);
