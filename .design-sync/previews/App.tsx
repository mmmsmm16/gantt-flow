// アプリ全体シェル(ツールバー + 工程表 / フロー図の分割 + ステータスバー)。
// サンプルを seed して、製品の実画面そのものをヒーローとして見せる。
import { App, useApp } from '@gantt-flow/desktop';

useApp.getState().loadSample();

export const FullApp = () => (
  <div style={{ width: 1360, height: 820, overflow: 'hidden', background: 'var(--bg)' }}>
    <App />
  </div>
);
