import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { MirrorView } from './MirrorView';
import { ErrorBoundary } from './ui/ErrorBoundary';
import { initAutosave } from './autosave';
import { parseMirrorParam } from './mirror';
import './styles.css';

// ?mirror=flow|table で開かれた窓は「表示専用ミラー」として起動する（マルチディスプレイ用）。
// ミラーは閲覧専用＝編集・自動退避は行わず、主窓の発行を受信して描くだけ。
const mirrorKind = parseMirrorParam(window.location.search);

const root = createRoot(document.getElementById('root')!);
if (mirrorKind) {
  root.render(
    <React.StrictMode>
      <ErrorBoundary>
        <MirrorView kind={mirrorKind} />
      </ErrorBoundary>
    </React.StrictMode>,
  );
} else {
  initAutosave(); // 未保存の変更を localStorage に自動退避（クラッシュ復旧用）
  root.render(
    <React.StrictMode>
      <ErrorBoundary>
        <App />
      </ErrorBoundary>
    </React.StrictMode>,
  );
}
