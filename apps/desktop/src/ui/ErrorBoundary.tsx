// 描画時の例外を捕捉し、白画面ではなく復旧画面を出す。ストアの project は生きているので、
// 作業をファイルに退避（ダウンロード）してから再読み込みできるようにする。
import { Component, type ReactNode } from 'react';
import { useApp } from '../store';
import { saveProjectToFile } from '../persistence';

interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: unknown): void {
    // 開発時の調査用にコンソールへ。送信はしない（オフライン前提）。
    console.error('UI error caught by ErrorBoundary:', error, info);
  }

  private rescue = () => {
    try {
      saveProjectToFile(useApp.getState().project);
    } catch (e) {
      console.error('rescue save failed', e);
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
            <button className="primary" onClick={this.rescue}>
              作業をファイルに保存
            </button>
            <button onClick={() => location.reload()}>再読み込み</button>
          </div>
        </div>
      </div>
    );
  }
}
