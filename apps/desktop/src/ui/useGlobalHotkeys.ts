// キーボードディスパッチの一元化。window keydown は原則ここ 1 本だけで受け、
// keymap.ts の実効キーマップで照合 → グローバルアクションは直接、table/flow コンテキストは
// 各コンポーネントが登録したハンドラへ委譲する(二重発火を構造的に防ぐ)。
//
// ガード順序(厳守):
//  1. IME 変換中(isComposing / keyCode 229)は何もしない
//  2. オーバーレイ/ダイアログ/ビジー/ツアー中は停止(パレットとヘルプのトグルだけ例外)
//  3. 編集中(input 等)は mod 付きの一部(パレット/保存/印刷)のみ。undo/redo はネイティブ優先
//  4. g リーダー → findBinding → dispatch
import { useEffect } from 'react';
import { useApp } from '../store';
import { useUI } from './useUI';
import {
  createLeaderTracker,
  findBinding,
  getActiveKeymap,
  isEditableTarget,
  type KeyBinding,
  type KeyContext,
} from '../keymap';

/** table / flow コンテキストのアクションを処理するハンドラ。true=処理した(preventDefault する)。 */
export type ContextActionHandler = (action: string, e: KeyboardEvent) => boolean;

const contextHandlers = new Map<KeyContext, ContextActionHandler>();

/** ペイン側(表/フロー)がアクション処理を登録する。アンマウント時に戻り値で解除。 */
export function registerContextHandler(ctx: KeyContext, handler: ContextActionHandler): () => void {
  contextHandlers.set(ctx, handler);
  return () => {
    if (contextHandlers.get(ctx) === handler) contextHandlers.delete(ctx);
  };
}

/** ペインをアクティブにし、必要ならレイアウトを直して見えるようにする(フォーカスも移す)。 */
export function activatePane(pane: 'table' | 'flow'): void {
  const ui = useUI.getState();
  if (pane === 'table') {
    if (ui.flowWide) ui.toggleFlowWide(); // 表が畳まれていたら開く
    ui.setActivePane('table');
    document.querySelector<HTMLElement>('#main-table')?.focus();
  } else {
    if (ui.tableWide) ui.toggleTableWide(); // フローが畳まれていたら開く
    if (ui.tableMode === 'full') ui.setTableMode('outline'); // 全項目表はフローを隠すため戻す
    ui.setActivePane('flow');
    document.querySelector<HTMLElement>('.flow-pane')?.focus();
  }
}

export interface GlobalHotkeyHandlers {
  onSave: () => void;
  onPrint: () => void;
}

export function useGlobalHotkeys(handlers: GlobalHotkeyHandlers): void {
  useEffect(() => {
    const leader = createLeaderTracker();

    const runGlobal = (action: string): boolean => {
      const ui = useUI.getState();
      const app = useApp.getState();
      switch (action) {
        case 'global.palette':
          ui.setOverlay(ui.overlay === 'palette' ? null : 'palette');
          return true;
        case 'global.save':
          handlers.onSave();
          return true;
        case 'global.print':
          handlers.onPrint();
          return true;
        case 'global.undo':
          app.undo();
          return true;
        case 'global.redo':
          app.redo();
          return true;
        case 'global.help':
          ui.setOverlay(ui.overlay === 'help' ? null : 'help');
          return true;
        case 'global.tableMode':
          ui.setTableMode(ui.tableMode === 'outline' ? 'full' : 'outline');
          return true;
        case 'global.settings':
          ui.setSettingsTab('general');
          ui.setOverlay('settings');
          return true;
        case 'pane.table':
          activatePane('table');
          return true;
        case 'pane.flow':
          activatePane('flow');
          return true;
        case 'pane.toggle':
          activatePane(ui.activePane === 'table' ? 'flow' : 'table');
          return true;
        case 'view.issues':
          ui.setOverlay('issues');
          return true;
        case 'view.summary':
          ui.setOverlay('summary');
          return true;
        case 'level.large':
        case 'level.medium':
        case 'level.small':
        case 'level.detail':
          app.setLevel(action.slice('level.'.length) as 'large' | 'medium' | 'small' | 'detail');
          return true;
        default:
          return false;
      }
    };

    const onKey = (e: KeyboardEvent) => {
      if (e.isComposing || e.keyCode === 229) return; // IME 変換中

      const ui = useUI.getState();
      const editable = isEditableTarget(document.activeElement);

      // オーバーレイ等の表示中は停止(パレットの Ctrl+K トグルと、ヘルプ表示中の ? だけ例外)。
      const blocked =
        ui.overlay !== null || ui.dialog !== null || ui.busy !== null || ui.tourStep !== null;
      if (blocked) {
        if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 'k') {
          e.preventDefault();
          ui.setOverlay(ui.overlay === 'palette' ? null : 'palette');
        } else if (e.key === '?' && !editable && ui.overlay === 'help') {
          e.preventDefault();
          ui.setOverlay(null);
        }
        leader.cancel();
        if (ui.leaderPending) ui.setLeaderPending(false);
        return;
      }

      const keymap = getActiveKeymap();
      const mod = e.ctrlKey || e.metaKey;
      const leaderActive = leader.isPending();

      // g 単打 → リーダー待機開始(編集外・修飾なしのみ。Shift+G は別バインド)。
      // シングルキー操作 OFF のときはリーダー自体を無効化(チップも出さない)。
      if (ui.singleKey && !editable && !leaderActive && !mod && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'g' && !e.repeat) {
        leader.arm();
        ui.setLeaderPending(true);
        e.preventDefault();
        return;
      }

      const contexts: KeyContext[] =
        ui.activePane === 'table' ? ['table', 'global'] : ['flow', 'global'];
      const binding = findBinding(e, keymap, contexts, leaderActive);

      if (leaderActive) {
        leader.consume();
        ui.setLeaderPending(false);
        if (binding) {
          e.preventDefault();
          dispatch(binding, e);
        }
        return; // リーダー 2 打目は(未割当でも)通常バインドへ流さない
      }

      if (!binding) return;

      // 編集中(input 等)は mod 付きのパレット/保存/印刷のみ通す。
      // Ctrl+Z/Y はネイティブのテキスト undo を優先(従来挙動)。単キーはすべて無効。
      if (editable) {
        const allowWhileEditing =
          binding.chord.mod === true &&
          (binding.action === 'global.palette' ||
            binding.action === 'global.save' ||
            binding.action === 'global.print');
        if (!allowWhileEditing) return;
      }

      if (dispatch(binding, e)) e.preventDefault();
    };

    const dispatch = (binding: KeyBinding, e: KeyboardEvent): boolean => {
      if (binding.context === 'global') return runGlobal(binding.action);
      const handler = contextHandlers.get(binding.context);
      return handler ? handler(binding.action, e) : false;
    };

    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      leader.cancel();
    };
    // handlers は App 内で毎レンダ作られるが、中身は getState ベースで安定なので初回登録のみで良い。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
