// メニュー。トリガーボタン(label)を押すとドロップダウン(children)が開く。
// 静的プレビューでは閉じた状態なので、トリガー列と「開いたパネル」を別セルで見せる。
import { Menu, MenuItem, MenuCheckItem } from '@gantt-flow/desktop';

const noop = () => {};

export const Triggers = () => (
  <div style={{ display: 'flex', gap: 8, padding: 8, background: 'var(--toolbar-bg)' }}>
    <Menu label="ファイル" title="ファイル操作">
      <MenuItem onClick={noop}>新規プロジェクト</MenuItem>
    </Menu>
    <Menu label="表示">
      <MenuItem onClick={noop}>列の表示</MenuItem>
    </Menu>
    <Menu label="ヘルプ">
      <MenuItem onClick={noop}>キーボード操作</MenuItem>
    </Menu>
  </div>
);

// 開いた状態の見た目(.menu パネル内に実コンポーネントを並べる)。
export const OpenPanel = () => (
  <div className="menu" role="menu" style={{ position: 'static', width: 240 }}>
    <MenuItem onClick={noop}>新規プロジェクト</MenuItem>
    <MenuItem onClick={noop}>開く…</MenuItem>
    <MenuItem onClick={noop}>名前を付けて保存</MenuItem>
    <MenuCheckItem label="ダークテーマ" checked onChange={noop} />
    <MenuCheckItem label="自動保存" checked={false} onChange={noop} />
  </div>
);
