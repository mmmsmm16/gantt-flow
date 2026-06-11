// キーボードディスパッチの一元化。window keydown は原則ここ 1 本だけで受け、
// keymap.ts の実効キーマップで照合 → グローバルアクションは直接、table/flow コンテキストは
// 各コンポーネントが登録したハンドラへ委譲する(二重発火を構造的に防ぐ)。
//
// ガード順序(厳守):
//  1. IME 変換中(isImeKeyEvent)は何もしない
//  2. Esc は useUI.closeTopLayer で「最上位レイヤを 1 つだけ閉じる」(dialog > overlay > 一時 UI)。
//     各ダイアログ/メニューは個別の window Esc リスナーを持たない(1 押下で多重に閉じない)
//  3. オーバーレイ/ダイアログ/ビジー/ツアー中は停止(パレットとヘルプのトグルだけ例外)
//  4. Esc のフォーカス規則(planEscFocus): モーダルコンテキスト(接続モード等)の Esc が最優先 →
//     入力系(isEditableTarget)は blur のみ → 非編集のフォーカスは blur しつつ同じ押下で
//     バインディング(flow.clear / table.clear 等)へ落とす
//  5. 編集中(input 等)は mod 付きの一部(パレット/保存/印刷)のみ。undo/redo はネイティブ優先
//  6. g リーダー → findBinding(pushKeyContext した 'connect' 等が最優先) → dispatch
import { useEffect } from 'react';
import type { TaskColor } from '@gantt-flow/core';
import { useApp } from '../store';
import { useUI } from './useUI';
import {
  createLeaderTracker,
  findBinding,
  getActiveKeymap,
  isEditableTarget,
  isImeKeyEvent,
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

// モーダルに最優先となる追加コンテキスト(接続モード等)。後から push したものほど優先。
const modalContexts: KeyContext[] = [];

/** 'connect' のようなモーダルなキーコンテキストを有効化する。有効中は通常の
    table/flow/global より優先して照合される(IME・ダイアログ・編集中ガードは共通のまま)。
    モード終了時に戻り値で必ず解除すること。 */
export function pushKeyContext(ctx: KeyContext): () => void {
  modalContexts.unshift(ctx);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const i = modalContexts.indexOf(ctx);
    if (i >= 0) modalContexts.splice(i, 1);
  };
}

/** Esc 押下時のフォーカス周りの扱い(onKey から呼ぶ純粋関数。keymap.ts の Esc 規則と対応)。
 *  - 'modal-binding'    : モーダルコンテキスト(接続モード等)の Esc バインドが最優先。
 *                         blur せず照合へ＝ノードにフォーカスがあっても 1 押下でキャンセルが効く
 *  - 'blur-only'        : 入力系(isEditableTarget)は blur だけで完結し選択は維持(解除はもう一度 Esc)
 *  - 'blur-and-binding' : 非編集要素(ノード div・ボタン等)は blur しつつ、同じ押下で
 *                         バインディング(flow.clear / table.clear 等)へも落とす
 *  - 'binding'          : blur 対象なし(body / ペイン自体)。通常のバインディング照合へ */
export type EscFocusPlan = 'modal-binding' | 'blur-only' | 'blur-and-binding' | 'binding';

export function planEscFocus(opts: {
  /** activeElement が body / SECTION(ペイン自体)以外＝blur で離れられる要素か。 */
  blurrable: boolean;
  /** isEditableTarget(activeElement)。入力系は blur 優先(編集中ガードとも整合)。 */
  editable: boolean;
  /** モーダルコンテキスト(接続モード等)に Esc のバインドが見つかったか。 */
  hasModalBinding: boolean;
}): EscFocusPlan {
  // 入力系は常に blur が先(モーダル中でも入力からの離脱を優先。編集中は単キーの
  // バインディングを通さない editable ガードとも一致させる)。
  if (opts.editable) return opts.blurrable ? 'blur-only' : 'binding';
  if (opts.hasModalBinding) return 'modal-binding';
  return opts.blurrable ? 'blur-and-binding' : 'binding';
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
      // 工程カラーのクイック変更(選択中の工程が対象。未選択なら何もしない)。
      const setColor = (field: 'fillColor' | 'textColor', value: TaskColor | undefined): boolean => {
        const a = useApp.getState();
        if (!a.selectedTaskId) return false;
        a.updateDetail(a.selectedTaskId, { [field]: value });
        return true;
      };
      switch (action) {
        case 'color.fillNone':
          return setColor('fillColor', undefined);
        case 'color.fillBlue':
          return setColor('fillColor', 'blue');
        case 'color.fillRed':
          return setColor('fillColor', 'red');
        case 'color.textNone':
          return setColor('textColor', undefined);
        case 'color.textBlue':
          return setColor('textColor', 'blue');
        case 'color.textRed':
          return setColor('textColor', 'red');
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
      if (isImeKeyEvent(e)) return; // IME 変換中

      const ui = useUI.getState();
      const editable = isEditableTarget(document.activeElement);

      // Esc は常に「最上位レイヤを 1 つだけ閉じる」(dialog > overlay > 一時 UI)。
      // ここが唯一の Esc クローズ処理(各ダイアログは個別リスナーを持たない)。
      // 独自の Esc を持つ UI(パレットの引数モード等)は stopPropagation か
      // registerOverlayCloser で差し込む。busy/ツアーは Esc 対象外(下の blocked で停止)。
      if (e.key === 'Escape' && ui.closeTopLayer()) {
        e.preventDefault();
        leader.cancel();
        if (ui.leaderPending) ui.setLeaderPending(false);
        return;
      }

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

      // フォーカス中の Esc = そのコントロールを離れて選択モードへ戻る(表・フロー共通)。
      // 優先順位は planEscFocus に集約: モーダルコンテキスト(接続モード等)の Esc が最優先
      // (blur せず下の照合へ＝1 押下でキャンセル) → 入力系は blur だけで完結 → 非編集要素
      // (ノード div・ボタン等)は blur しつつ同じ押下でバインディングへも落とす。
      // 独自 Esc 処理を持つ入力は stopPropagation でここに来ない(ダイアログ/オーバーレイは
      // 上の closeTopLayer が先に閉じている)。
      const ae = document.activeElement;
      if (e.key === 'Escape' && ae instanceof HTMLElement) {
        const plan = planEscFocus({
          blurrable: ae !== document.body && ae.tagName !== 'SECTION',
          editable,
          hasModalBinding:
            modalContexts.length > 0 && findBinding(e, keymap, modalContexts, false) !== undefined,
        });
        if (plan === 'blur-only' || plan === 'blur-and-binding') {
          ae.blur();
          e.preventDefault();
          if (plan === 'blur-only') return;
        }
      }

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

      // pushKeyContext で有効化されたモーダルコンテキスト(接続モード等)が最優先。
      const contexts: KeyContext[] = [
        ...modalContexts,
        ...(ui.activePane === 'table' ? (['table', 'global'] as const) : (['flow', 'global'] as const)),
      ];
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
