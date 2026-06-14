// 工程表(粒度スコープ付きの編集テーブル)。空ストアだと空表になるため、
// core のサンプルプロジェクトを store に流し込んでから描画する。
import { TableView, useApp } from '@gantt-flow/desktop';

// モジュール評価時に1度だけ seed(各プレビューは独立ページで読み込まれる singleton)。
useApp.getState().loadSample();

export const WithSample = () => (
  <div style={{ height: 560, overflow: 'hidden', background: 'var(--bg)' }}>
    <TableView />
  </div>
);
