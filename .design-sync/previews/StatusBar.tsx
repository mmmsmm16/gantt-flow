// 画面下部のステータスバー(粒度別件数・合計工数・保存状態など)。サンプルを seed。
import { StatusBar, useApp } from '@gantt-flow/desktop';

useApp.getState().loadSample();

export const WithSample = () => (
  <div style={{ width: '100%', background: 'var(--panel)', borderTop: '1px solid var(--line)' }}>
    <StatusBar />
  </div>
);
