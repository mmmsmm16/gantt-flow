// 全列の編集テーブル(粒度・担当・前後関係・I/O・課題・工数)。サンプルを seed して描画。
import { FullTable, useApp } from '@gantt-flow/desktop';

useApp.getState().loadSample();

export const WithSample = () => (
  <div style={{ height: 580, overflow: 'auto', background: 'var(--bg)' }}>
    <FullTable />
  </div>
);
