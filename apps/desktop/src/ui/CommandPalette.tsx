// コマンドパレット（Ctrl/⌘+K）。アクション実行 ＋ 工程名/工程No での検索ジャンプ。
// アプリ全体の発見性と速度を上げる単一の入口。ファイル系操作は App からハンドラを受け取る。
import { useEffect, useMemo, useRef, useState } from 'react';
import type { ProcessLevel } from '@gantt-flow/core';
import { computeCodes } from '@gantt-flow/core';
import { useApp } from '../store';
import { useUI } from './useUI';
import { useFocusTrap } from './useFocusTrap';
import * as Icons from './icons';

interface FileHandlers {
  onNew: () => void;
  onSave: () => void;
  onSaveAs: () => void;
  onOpen: () => void;
  onImport: () => void;
  onSample: () => void;
  onExportExcel: () => void;
  onExportCsv: () => void;
  onExportSvg: () => void;
  onExportPng: () => void;
  onPrint: () => void;
}

interface Cmd {
  id: string;
  label: string;
  keywords: string;
  hint?: string;
  run: () => void;
  available?: boolean;
}

const LEVEL_LABEL: Record<ProcessLevel, string> = { large: '大', medium: '中', small: '小', detail: '詳細' };

// 部分一致＋連続一致を軽く評価するファジー。query の全文字が順に現れれば一致。
function fuzzyScore(query: string, text: string): number | null {
  if (!query) return 0;
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  if (t.includes(q)) return 100 - t.indexOf(q); // 連続一致を優遇
  let qi = 0;
  let score = 0;
  let prev = -1;
  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] === q[qi]) {
      score += prev === ti - 1 ? 2 : 1;
      prev = ti;
      qi++;
    }
  }
  return qi === q.length ? score : null;
}

export function CommandPalette(handlers: FileHandlers) {
  const open = useUI((s) => s.overlay === 'palette');
  const project = useApp((s) => s.project);
  const canUndo = useApp((s) => s.canUndo);
  const canRedo = useApp((s) => s.canRedo);
  const selectedTaskId = useApp((s) => s.selectedTaskId);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  useFocusTrap(dialogRef, open);

  const close = () => useUI.getState().setOverlay(null);
  const runAndClose = (fn: () => void) => {
    close();
    fn();
  };

  useEffect(() => {
    if (open) {
      setQuery('');
      setActive(0);
      const t = setTimeout(() => inputRef.current?.focus(), 0);
      return () => clearTimeout(t);
    }
    return undefined;
  }, [open]);

  const commands: Cmd[] = useMemo(() => {
    const ui = useUI.getState();
    const app = useApp.getState();
    return [
      {
        id: 'add-task',
        label: selectedTaskId ? '工程を追加（選択の次に）' : '工程を追加',
        keywords: 'add task koutei tsuika 追加 行 ぎょう',
        run: () => {
          const a = useApp.getState();
          const sel = a.selectedTaskId;
          if (sel) {
            const nid = a.addSiblingOf(sel);
            if (nid) a.select(nid);
          } else {
            a.addRootTask('medium');
          }
        },
      },
      {
        id: 'duplicate-task',
        label: '選択中の工程を複製',
        keywords: 'duplicate fukusei 複製 コピー copy',
        available: !!selectedTaskId,
        run: () => {
          const a = useApp.getState();
          if (a.selectedTaskId) a.duplicateTask(a.selectedTaskId);
        },
      },
      {
        id: 'delete-task',
        label: '選択中の工程を削除',
        keywords: 'delete remove sakujo 削除 行 ぎょう',
        available: !!selectedTaskId,
        run: () => {
          const a = useApp.getState();
          const id = a.selectedTaskId;
          const t = id ? a.project.core.tasks[id] : undefined;
          if (!t) return;
          void useUI
            .getState()
            .confirm({
              title: '工程を削除',
              message: `「${t.name}」を削除します（配下の工程は1つ上の階層へ繰り上げて残します）。`,
              confirmLabel: '削除',
              danger: true,
            })
            .then((ok) => ok && a.removeTask(t.id));
        },
      },
      { id: 'save', label: '保存', keywords: 'save hozon ほぞん', hint: '⌘S', run: handlers.onSave },
      { id: 'save-as', label: '名前を付けて保存', keywords: 'save as namae 別名 betsumei copy', run: handlers.onSaveAs },
      { id: 'sample', label: 'サンプルを開く', keywords: 'sample デモ demo れい', run: handlers.onSample },
      { id: 'new', label: '新規プロジェクト', keywords: 'new shinki あたらしい', run: handlers.onNew },
      { id: 'import', label: 'CSV / Excel を取り込む', keywords: 'import torikomi excel csv', run: handlers.onImport },
      { id: 'open', label: '保存ファイルを開く', keywords: 'open hiraku json', run: handlers.onOpen },
      { id: 'export-excel', label: 'Excel に書き出す', keywords: 'export excel xlsx 出力 書き出し', run: handlers.onExportExcel },
      { id: 'export-csv', label: 'CSV に書き出す', keywords: 'export csv', run: handlers.onExportCsv },
      { id: 'export-png', label: '画像 (PNG) に書き出す', keywords: 'export png gazou 画像 図', run: handlers.onExportPng },
      { id: 'export-svg', label: '画像 (SVG) に書き出す', keywords: 'export svg gazou 画像', run: handlers.onExportSvg },
      { id: 'print', label: '印刷 / PDF（工程表＋フロー図）', keywords: 'print insatsu 印刷 pdf', hint: '⌘P', run: handlers.onPrint },
      { id: 'undo', label: '元に戻す', keywords: 'undo modosu もどす', hint: '⌘Z', run: app.undo, available: canUndo },
      { id: 'redo', label: 'やり直し', keywords: 'redo yarinaoshi', hint: '⌘Y', run: app.redo, available: canRedo },
      { id: 'theme', label: 'テーマを切り替え（ライト / ダーク）', keywords: 'theme dark light テーマ', run: ui.toggleTheme },
      { id: 'add-start', label: 'フロー: 開始ノードを追加', keywords: 'control start 開始 制御 ノード', run: () => useApp.getState().addControlNode('start') },
      { id: 'add-end', label: 'フロー: 終了ノードを追加', keywords: 'control end 終了 制御 ノード', run: () => useApp.getState().addControlNode('end') },
      { id: 'add-decision', label: 'フロー: 判断ノードを追加', keywords: 'control decision 判断 分岐 制御 ノード', run: () => useApp.getState().addControlNode('decision') },
      { id: 'add-merge', label: 'フロー: 合流ノードを追加', keywords: 'control merge 合流 制御 ノード', run: () => useApp.getState().addControlNode('merge') },
      { id: 'add-comment', label: 'フロー: 付箋を追加', keywords: 'comment fusen 付箋 メモ note', run: () => useApp.getState().addComment('メモ') },
      {
        id: 'tidy',
        label: 'フローを整列（自動配置）',
        keywords: 'tidy seiretsu 整列 layout 配置',
        run: () => {
          void useUI
            .getState()
            .confirm({
              title: 'フローを整列',
              message: '依存とレーンに基づいて配置を作り直します。手で整えた配置は失われます（Ctrl+Z で戻せます）。',
              confirmLabel: '整列する',
            })
            .then((ok) => ok && useApp.getState().tidyFlow());
        },
      },
      { id: 'issues', label: '課題レイヤの表示を切り替え', keywords: 'issue kadai 課題', run: app.toggleIssues },
      { id: 'wide', label: '表を広く / 分割に戻す', keywords: 'wide hyou table 表', run: ui.toggleTableWide },
      { id: 'issues', label: '課題一覧を開く', keywords: 'issue kadai 課題 一覧 list', run: () => ui.setOverlay('issues') },
      { id: 'summary', label: 'サマリを開く（工数・自動化）', keywords: 'summary dashboard サマリ 集計 工数', run: () => ui.setOverlay('summary') },
      { id: 'help', label: 'ショートカット一覧', keywords: 'help shortcut ヘルプ', hint: '?', run: () => ui.setOverlay('help') },
    ];
  }, [handlers, canUndo, canRedo, selectedTaskId]);

  const codes = useMemo(() => computeCodes(project.core), [project.core]);

  const { cmdHits, taskHits } = useMemo(() => {
    const cmds = commands.filter((c) => c.available !== false);
    const scoredCmds = cmds
      .map((c) => ({ c, s: fuzzyScore(query, `${c.label} ${c.keywords}`) }))
      .filter((x) => x.s !== null)
      .sort((a, b) => (b.s ?? 0) - (a.s ?? 0))
      .map((x) => x.c);

    const tasks = query
      ? Object.values(project.core.tasks)
          .map((t) => ({ t, s: fuzzyScore(query, `${codes[t.id] ?? ''} ${t.name}`) }))
          .filter((x) => x.s !== null && x.t.name)
          .sort((a, b) => (b.s ?? 0) - (a.s ?? 0))
          .slice(0, 12)
          .map((x) => x.t)
      : [];
    return { cmdHits: scoredCmds.slice(0, query ? 6 : 14), taskHits: tasks };
  }, [commands, project.core, codes, query]);

  const flat = useMemo(
    () => [
      ...cmdHits.map((c) => ({ kind: 'cmd' as const, c })),
      ...taskHits.map((t) => ({ kind: 'task' as const, t })),
    ],
    [cmdHits, taskHits],
  );

  useEffect(() => {
    if (active >= flat.length) setActive(0);
  }, [flat.length, active]);

  useEffect(() => {
    listRef.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  if (!open) return null;

  const openTask = (taskId: string) => {
    const app = useApp.getState();
    const t = app.project.core.tasks[taskId];
    if (!t) return;
    app.select(taskId);
    app.setLevel(t.level);
    app.setScope(t.parentId);
  };

  const runItem = (i: number) => {
    const item = flat[i];
    if (!item) return;
    if (item.kind === 'cmd') runAndClose(item.c.run);
    else runAndClose(() => openTask(item.t.id));
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((a) => Math.min(flat.length - 1, a + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((a) => Math.max(0, a - 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      runItem(active);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      close();
    }
  };

  return (
    <div className="modal-backdrop palette-backdrop" onMouseDown={close}>
      <div
        className="palette"
        role="dialog"
        aria-modal="true"
        aria-label="コマンドパレット"
        ref={dialogRef}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="palette-search">
          <Icons.Search />
          <input
            ref={inputRef}
            value={query}
            placeholder="コマンドを実行、または工程を検索…"
            aria-label="コマンドまたは工程を検索"
            onChange={(e) => {
              setQuery(e.target.value);
              setActive(0);
            }}
            onKeyDown={onKeyDown}
          />
          <kbd className="palette-esc">Esc</kbd>
        </div>

        <div className="palette-list" ref={listRef} role="listbox" aria-label="候補">
          {flat.length === 0 && <div className="palette-empty">一致する候補がありません</div>}

          {cmdHits.length > 0 && <div className="palette-section">操作</div>}
          {cmdHits.map((c, i) => (
            <button
              key={c.id}
              role="option"
              aria-selected={active === i}
              data-active={active === i}
              className={`palette-item${active === i ? ' active' : ''}`}
              onMouseMove={() => setActive(i)}
              onClick={() => runItem(i)}
            >
              <span className="pi-label">{c.label}</span>
              {c.hint && <kbd className="pi-hint">{c.hint}</kbd>}
            </button>
          ))}

          {taskHits.length > 0 && <div className="palette-section">工程へジャンプ</div>}
          {taskHits.map((t, j) => {
            const i = cmdHits.length + j;
            const assignee = t.assigneeId ? project.core.assignees[t.assigneeId]?.name : '';
            return (
              <button
                key={t.id}
                role="option"
                aria-selected={active === i}
                data-active={active === i}
                className={`palette-item${active === i ? ' active' : ''}`}
                onMouseMove={() => setActive(i)}
                onClick={() => runItem(i)}
              >
                <span className={`pi-code lvl-${t.level}`}>{codes[t.id]}</span>
                <span className="pi-badge">{LEVEL_LABEL[t.level]}</span>
                <span className="pi-label">{t.name}</span>
                {assignee && <span className="pi-assignee">{assignee}</span>}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
