// 表示専用ミラー窓（?mirror=flow|table）。主窓が BroadcastChannel で流す
// スナップショットを受信し、フローは buildFlowSvg、工程表は projectToRows を
// 使って読み取り専用で描く。操作 UI は持たず、ズームのみローカルで可能。
import { useEffect, useMemo, useState } from 'react';
import { projectToRows, type FlowLevelView, type ProcessLevel, type Project } from '@gantt-flow/core';
import { buildFlowSvg } from './flowSvg';
import { subscribeMirror, type MirrorKind, type MirrorState } from './mirror';

const LEVEL_LABEL: Record<ProcessLevel, string> = {
  large: '大',
  medium: '中',
  small: '小',
  detail: '詳細',
};

const KIND_LABEL: Record<MirrorKind, string> = { flow: '工程フロー', table: '工程表' };

// 主窓の store と同じ規約でビューを引く（scope 未指定は undefined 同士で一致）。
function findLevelView(
  project: Project,
  level: ProcessLevel,
  scopeParentId?: string,
): FlowLevelView | undefined {
  return project.flow.byLevel.find(
    (v) => v.level === level && (v.scopeParentId ?? undefined) === (scopeParentId ?? undefined),
  );
}

const escapeHtml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// 工程表ミラー: 印刷/出力と同じ行データ（前工程は作業名参照）から読み取り専用の表を作る。
function buildMirrorTableHtml(project: Project): string {
  const rows = projectToRows(project, { depRef: 'name' });
  const header = rows[0] ?? [];
  const body = rows.slice(1);
  const thead = `<tr>${header.map((h) => `<th>${escapeHtml(h)}</th>`).join('')}</tr>`;
  const tbody = body
    .map((r) => `<tr>${r.map((c) => `<td>${escapeHtml(c).replace(/\n/g, '<br>')}</td>`).join('')}</tr>`)
    .join('');
  return `<table class="mirror-table"><thead>${thead}</thead><tbody>${tbody}</tbody></table>`;
}

const ZOOM_MIN = 0.3;
const ZOOM_MAX = 3;
const clampZoom = (z: number) => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, +z.toFixed(2)));

export function MirrorView({ kind }: { kind: MirrorKind }) {
  const [state, setState] = useState<MirrorState | null>(null);
  const [live, setLive] = useState(false); // 主窓が接続中か（bye で false）
  const [zoom, setZoom] = useState(1);

  useEffect(() => {
    document.title = `${KIND_LABEL[kind]}（ミラー）· gantt-flow`;
    const stop = subscribeMirror({
      onState: (s) => {
        setState(s);
        setLive(true);
      },
      onBye: () => setLive(false),
    });
    return stop;
  }, [kind]);

  // 受信スナップショットから表示 HTML/SVG を組む（純関数・決定論）。
  const html = useMemo(() => {
    if (!state) return '';
    if (kind === 'table') return buildMirrorTableHtml(state.project);
    const view = findLevelView(state.project, state.level, state.scopeParentId);
    if (!view) return '';
    return buildFlowSvg(state.project, view, { includeIssues: state.showIssues });
  }, [state, kind]);

  const waiting = !state || !live; // 未接続 or 主窓が離脱

  return (
    <div className="mirror-root" data-kind={kind}>
      <div className="mirror-bar">
        <span className="mirror-badge" role="status">
          <span className="mirror-dot" aria-hidden="true" />
          閲覧専用ミラー · {KIND_LABEL[kind]}
          {state ? ` · ${LEVEL_LABEL[state.level]}粒度` : ''}
        </span>
        <span className="mirror-zoom" role="group" aria-label="ズーム">
          <button type="button" onClick={() => setZoom((z) => clampZoom(z - 0.1))} aria-label="縮小">
            −
          </button>
          <button type="button" onClick={() => setZoom(1)} aria-label="等倍に戻す">
            {Math.round(zoom * 100)}%
          </button>
          <button type="button" onClick={() => setZoom((z) => clampZoom(z + 0.1))} aria-label="拡大">
            ＋
          </button>
        </span>
      </div>
      <div className="mirror-scroll">
        {html ? (
          <div
            className="mirror-content"
            style={{ transform: `scale(${zoom})`, transformOrigin: 'top left' }}
            dangerouslySetInnerHTML={{ __html: html }}
          />
        ) : (
          !waiting && <div className="mirror-empty">表示できる内容がありません。</div>
        )}
      </div>
      {waiting && (
        <div className="mirror-waiting" role="status" aria-live="polite">
          <div className="mirror-waiting-card">
            <div className="mirror-spin" aria-hidden="true" />
            <p className="mirror-waiting-title">
              {state ? '主ウィンドウの接続を待っています…' : '主ウィンドウに接続しています…'}
            </p>
            <p className="mirror-waiting-sub">
              編集画面（主ウィンドウ）を開いたままにしてください。ここは閲覧専用です。
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
