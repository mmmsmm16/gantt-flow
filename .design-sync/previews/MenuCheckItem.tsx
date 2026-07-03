// チェック付きメニュー項目(トグル)。開いた .menu パネル内に並べて見せる。
import { MenuCheckItem } from '@gantt-flow/desktop';

const noop = () => {};

export const InPanel = () => (
  <div className="menu" role="menu" style={{ position: 'static', width: 240 }}>
    <MenuCheckItem label="ダークテーマ" checked onChange={noop} />
    <MenuCheckItem label="自動保存" checked={false} onChange={noop} />
    <MenuCheckItem label="ミニマップを表示" checked onChange={noop} />
  </div>
);
