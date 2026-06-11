// 描画時の例外を捕捉し、白画面ではなく復旧画面を出す。ストアの project は生きているので、
// 作業をファイルに退避（ダウンロード）してから再読み込みできるようにする。
import { Component, type ReactNode } from 'react';
import { useApp } from '../store';
import { saveProjectToFile, downloadProjectJson } from '../persistence';

interface State {
  error: Error | null;
  /** 退避操作の結果メッセージ（成功/フォールバックをユーザーに伝える）。 */
  rescueNote: string | null;
}

export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { error: null, rescueNote: null };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  componentDidCatch(error: Error, info: unknown): void {
    // 開発時の調査用にコンソールへ。送信はしない（オフライン前提）。
    console.error('UI error caught by ErrorBoundary:', error, info);
  }

  // 作業をファイルへ退避。saveProjectToFile は失敗で throw / Tauri では conflict を返すため、
  // クラッシュ文脈では確認 UI を出せない代わりに、最終手段としてダウンロード退避へ切り替える。
  private rescue = async (): Promise<void> => {
    const project = useApp.getState().project;
    try {
      const r = await saveProjectToFile(project);
      if (r.kind === 'cancelled') return; // ピッカーのキャンセル＝ユーザーの意思（何もしない）
      if (r.kind === 'conflict') {
        // 他セッションの変更を黙って上書きはしない。失わないことを優先してダウンロードへ。
        const name = downloadProjectJson(project);
        this.setState({ rescueNote: `ファイルが他で変更されていたため、ダウンロードに退避しました（${name}）。` });
        return;
      }
      this.setState({
        rescueNote:
          r.kind === 'downloaded'
            ? `ダウンロードに保存しました（${r.name}）。`
            : `保存しました（${r.name}）。`,
      });
    } catch (e) {
      console.error('rescue save failed', e);
      try {
        const name = downloadProjectJson(project);
        this.setState({ rescueNote: `ファイルへの保存に失敗したため、ダウンロードに退避しました（${name}）。` });
      } catch {
        this.setState({
          rescueNote: '保存に失敗しました。再読み込み後、自動退避データからの復元をお試しください。',
        });
      }
    }
  };

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="crash">
        <div className="crash-card" role="alert">
          <h1>予期しないエラーが発生しました</h1>
          <p>
            画面の描画中に問題が起きました。お手数ですが、作業内容をファイルに退避してから
            再読み込みしてください。データはこの端末内にのみ保存され、外部には送信されません。
          </p>
          <pre className="crash-detail">{this.state.error.message}</pre>
          <div className="crash-actions">
            <button className="primary" onClick={() => void this.rescue()}>
              作業をファイルに保存
            </button>
            <button onClick={() => location.reload()}>再読み込み</button>
          </div>
          {this.state.rescueNote && <p role="status">{this.state.rescueNote}</p>}
        </div>
      </div>
    );
  }
}
