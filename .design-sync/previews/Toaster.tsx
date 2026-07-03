// トースト通知。useUI.toast() で 3 トーン(success / info / error)を積んで見せる。
import { Toaster, useUI } from '@gantt-flow/desktop';

const ui = useUI.getState();
ui.toast('プロジェクトを保存しました', 'success');
ui.toast('表とフロー図を同期しました', 'info');
ui.toast('保存に失敗しました（書き込み権限を確認）', 'error');

export const Toasts = () => (
  <div style={{ width: 460, height: 220, position: 'relative' }}>
    <Toaster />
  </div>
);
