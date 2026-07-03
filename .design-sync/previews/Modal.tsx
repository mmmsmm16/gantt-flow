// 確認/入力ダイアログ。useUI.dialog を立てて確認モーダルを開いた状態を見せる。
import { Modal, useUI } from '@gantt-flow/desktop';

useUI.setState({
  dialog: {
    kind: 'confirm',
    title: '大工程を削除しますか?',
    message: 'この大工程と配下の中工程・小工程をすべて削除します。元に戻すには取り消し（⌘Z）を使ってください。',
    confirmLabel: '削除',
    cancelLabel: 'キャンセル',
    danger: true,
    resolve: () => {},
  },
});

export const Confirm = () => (
  <div style={{ width: 640, height: 340, position: 'relative' }}>
    <Modal />
  </div>
);
