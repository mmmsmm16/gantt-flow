import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { MirrorView } from './MirrorView';
import { ErrorBoundary } from './ui/ErrorBoundary';
import { initAutosave } from './autosave';
import { parseMirrorParam } from './mirror';
import { parseWindowParam, startLeader, startFollower } from './dualwindow';
import './styles.css';

// 起動モードの分岐（同一オリジンの別ウィンドウで役割を変える）:
//  1) ?mirror=flow|table … 表示専用ミラー（従来どおり閲覧専用）。
//  2) ?window=edit       … 両窓編集同期のフォロワー（編集可・リーダーへ転送）。
//  3) それ以外           … 通常＝リーダー（唯一の真実。自動退避・外部監視はここだけ）。
const mirrorKind = parseMirrorParam(window.location.search);
const editWindow = parseWindowParam(window.location.search);

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
  // リーダーのみ自動退避（フォロワーはファイル/退避を持たない＝データはリーダーが真実）。
  if (editWindow) startFollower();
  else {
    startLeader();
    initAutosave(); // 未保存の変更を localStorage に自動退避（クラッシュ復旧用）
  }
  root.render(
    <React.StrictMode>
      <ErrorBoundary>
        <App />
      </ErrorBoundary>
    </React.StrictMode>,
  );
}
