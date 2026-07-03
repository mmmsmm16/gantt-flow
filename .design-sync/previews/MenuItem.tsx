// ドロップダウン内の項目。開いた .menu パネル内に並べて見せる。
import { MenuItem } from '@gantt-flow/desktop';

const noop = () => {};

export const InPanel = () => (
  <div className="menu" role="menu" style={{ position: 'static', width: 240 }}>
    <MenuItem onClick={noop}>新規プロジェクト</MenuItem>
    <MenuItem onClick={noop}>開く…</MenuItem>
    <MenuItem onClick={noop}>名前を付けて保存</MenuItem>
    <MenuItem onClick={noop}>サンプルを開く</MenuItem>
  </div>
);
