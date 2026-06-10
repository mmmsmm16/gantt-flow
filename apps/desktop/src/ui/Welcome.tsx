// 初回体験。工程が 0 件のときにペイン全体の代わりに表示するオンボーディング。
// 「サンプルで試す」を主導線に、空作成 / 取り込み / 開く を並べる。
import { useEffect, useState } from 'react';
import * as Icons from './icons';
import { listRecentFiles } from '../persistence';

interface Props {
  onSample: () => void;
  onImport: () => void;
  onOpen: () => void;
  onOpenRecent: (name: string) => void;
}

export function Welcome({ onSample, onImport, onOpen, onOpenRecent }: Props) {
  const [recent, setRecent] = useState<{ name: string; at: number }[]>([]);
  useEffect(() => {
    void listRecentFiles().then(setRecent);
  }, []);

  return (
    <div className="welcome" role="region" aria-label="はじめに">
      <div className="welcome-card">
        <div className="welcome-brand">
          <svg width="34" height="34" viewBox="0 0 18 18" aria-hidden="true" className="brand-mark">
            <rect className="bg" width="18" height="18" rx="5" />
            <rect className="bar" x="3.5" y="3.8" width="8" height="2.2" rx="1.1" />
            <rect className="bar b2" x="6" y="7.9" width="8.5" height="2.2" rx="1.1" />
            <rect className="bar b3" x="3.5" y="12" width="6" height="2.2" rx="1.1" />
          </svg>
          <div>
            <h1>
              gantt-<span className="brand-accent">flow</span>
            </h1>
            <p className="welcome-tagline">工程表とフロー図を、ひとつのデータで。</p>
          </div>
        </div>

        <p className="welcome-lead">
          作業手順を表で書くと、スイムレーンの業務フロー図が自動で同期します。
          まずはサンプルを開いて、表とフローが連動する様子を試してみてください。
        </p>

        <div className="welcome-actions">
          <button className="welcome-primary" onClick={onSample} autoFocus>
            <Icons.Sparkles />
            サンプルを開いて試す
          </button>
          <button className="welcome-secondary" onClick={onImport}>
            <Icons.Upload />
            CSV / Excel を取り込む
          </button>
          <button className="welcome-secondary" onClick={onOpen}>
            <Icons.FolderOpen />
            保存ファイルを開く
          </button>
        </div>

        {recent.length > 0 && (
          <div className="welcome-recent">
            <h2 className="welcome-recent-title">
              <Icons.Clock />
              最近開いたファイル
            </h2>
            <ul>
              {recent.map((r) => (
                <li key={r.name}>
                  <button className="welcome-recent-item" onClick={() => onOpenRecent(r.name)} title={r.name}>
                    <Icons.FolderOpen />
                    <span className="wr-name">{r.name}</span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}

        <ul className="welcome-points">
          <li>
            <strong>表で編集</strong>
            <span>作業・担当・前後関係・I/O・課題を一覧表で入力。</span>
          </li>
          <li>
            <strong>図に同期</strong>
            <span>担当はレーン、前後関係は矢印に。手で動かした配置は保持。</span>
          </li>
          <li>
            <strong>そのまま納品</strong>
            <span>Excel・CSV・画像（SVG）に書き出し。往復は JSON。</span>
          </li>
        </ul>

        <p className="welcome-foot">
          空の状態から始めるには、上部ツールバーの <Icons.FilePlus /> 新規、または下の表から作業を追加します。
        </p>
      </div>
    </div>
  );
}
