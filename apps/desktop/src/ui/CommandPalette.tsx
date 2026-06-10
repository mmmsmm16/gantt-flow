// コマンドパレット（Ctrl/⌘+K）。アクション実行 ＋ 工程名/工程No での検索ジャンプ ＋
// 引数付きコマンド（2 段階方式: コマンド選択 → 入力欄が引数モードに変わり、候補選択 or 自由入力で確定）。
// アプリ全体の発見性と速度を上げる単一の入口。ファイル系操作は App からハンドラを受け取る。
import { useEffect, useMemo, useRef, useState } from 'react';
import type { ProcessLevel, ProcessTask } from '@gantt-flow/core';
import { computeCodes } from '@gantt-flow/core';
import { useApp, findView } from '../store';
import { collectIoNames, prevCandidates } from '../suggestions';
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

/** 引数モードの候補。value が確定値（runWithArg に渡る）。 */
export interface ArgOption {
  value: string;
  label: string;
  detail?: string;
}

/** 引数付きコマンドの仕様。候補は実行時に評価（プロジェクトの最新状態を見る）。 */
export interface ArgSpec {
  placeholder: string;
  /** 候補に無い自由入力で確定できるか。 */
  freeText?: boolean;
  options?: () => ArgOption[];
  defaultValue?: () => string;
  /** null=OK / 文字列=エラーメッセージ（確定を中止して表示）。 */
  validate?: (value: string) => string | null;
}

interface Cmd {
  id: string;
  label: string;
  keywords: string;
  hint?: string;
  available?: boolean;
  run?: () => void;
  /** 指定すると「選択 → 引数入力」の 2 段階コマンドになる。 */
  arg?: ArgSpec;
  runWithArg?: (value: string, opt?: ArgOption) => void;
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
  // 引数モード: 選択中のコマンド（null=コマンド一覧）。Esc / 空欄 Backspace で一覧へ戻る。
  const [argCmd, setArgCmd] = useState<Cmd | null>(null);
  const [argError, setArgError] = useState<string | null>(null);
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
      setArgCmd(null);
      setArgError(null);
      const t = setTimeout(() => inputRef.current?.focus(), 0);
      return () => clearTimeout(t);
    }
    return undefined;
  }, [open]);

  const commands: Cmd[] = useMemo(() => {
    const ui = useUI.getState();
    const app = useApp.getState();
    const hasSel = !!selectedTaskId;
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
      // ---- 引数付きコマンド（選択中の工程に対する編集） ----
      {
        id: 'arg-assignee',
        label: '担当を設定…',
        keywords: 'assignee tantou 担当 部署 設定 set',
        available: hasSel,
        arg: {
          placeholder: '担当（部門 / 個人）。空欄で未割当',
          freeText: true,
          options: () =>
            Object.values(useApp.getState().project.core.assignees).map((a) => ({
              value: a.name,
              label: a.name,
            })),
        },
        runWithArg: (v) => {
          const a = useApp.getState();
          if (a.selectedTaskId) a.setAssigneeByName(a.selectedTaskId, v);
        },
      },
      {
        id: 'arg-level',
        label: '粒度を変更…',
        keywords: 'level ryuudo 粒度 大 中 小 詳細 granularity',
        available: hasSel,
        arg: {
          placeholder: '粒度を選択（大 / 中 / 小 / 詳細）',
          options: () =>
            (['large', 'medium', 'small', 'detail'] as const).map((l) => ({
              value: l,
              label: `${LEVEL_LABEL[l]}工程`,
            })),
        },
        runWithArg: (v) => {
          const a = useApp.getState();
          if (a.selectedTaskId) a.setTaskLevel(a.selectedTaskId, v as ProcessLevel);
        },
      },
      {
        id: 'arg-effort',
        label: '工数を設定…',
        keywords: 'effort kousuu 工数 時間 hours',
        available: hasSel,
        arg: {
          placeholder: '工数（時間・0.5 刻み）。空欄で解除',
          freeText: true,
          validate: (v) => {
            if (!v.trim()) return null; // 空=解除
            const n = Number(v);
            return Number.isFinite(n) && n >= 0 ? null : '0 以上の数値（時間）を入力してください';
          },
        },
        runWithArg: (v) => {
          const a = useApp.getState();
          if (!a.selectedTaskId) return;
          a.updateDetail(a.selectedTaskId, {
            effortMinutes: v.trim() ? Math.round(Number(v) * 60) : undefined,
          });
        },
      },
      {
        id: 'arg-rename',
        label: '工程名を変更…',
        keywords: 'rename namae 名前 工程名 リネーム',
        available: hasSel,
        arg: {
          placeholder: '新しい工程名',
          freeText: true,
          defaultValue: () => {
            const a = useApp.getState();
            return a.selectedTaskId ? a.project.core.tasks[a.selectedTaskId]?.name ?? '' : '';
          },
        },
        runWithArg: (v) => {
          const a = useApp.getState();
          if (a.selectedTaskId) a.renameTask(a.selectedTaskId, v);
        },
      },
      {
        id: 'arg-issue',
        label: '課題を追加…',
        keywords: 'issue kadai 課題 追加',
        available: hasSel,
        arg: { placeholder: '課題の内容', freeText: true },
        runWithArg: (v) => {
          const a = useApp.getState();
          if (a.selectedTaskId && v.trim()) a.addIssue(a.selectedTaskId, v.trim());
        },
      },
      {
        id: 'arg-measure',
        label: '方策を追加…',
        keywords: 'measure housaku 方策 改善 対策',
        available: hasSel,
        arg: { placeholder: '方策（改善案）の内容', freeText: true },
        runWithArg: (v) => {
          const a = useApp.getState();
          if (a.selectedTaskId && v.trim()) a.addIssueWithMeasure(a.selectedTaskId, v.trim());
        },
      },
      {
        id: 'arg-input',
        label: 'インプットを追加…',
        keywords: 'input nyuuryoku インプット 入力 帳票 io',
        available: hasSel,
        arg: {
          placeholder: '帳票 / 情報の名称',
          freeText: true,
          options: () =>
            collectIoNames(useApp.getState().project).map((n) => ({ value: n, label: n })),
        },
        runWithArg: (v) => {
          const a = useApp.getState();
          if (a.selectedTaskId && v.trim()) a.addIo(a.selectedTaskId, 'inputs', v.trim());
        },
      },
      {
        id: 'arg-output',
        label: 'アウトプットを追加…',
        keywords: 'output shutsuryoku アウトプット 出力 帳票 io',
        available: hasSel,
        arg: {
          placeholder: '帳票 / 情報の名称',
          freeText: true,
          options: () =>
            collectIoNames(useApp.getState().project).map((n) => ({ value: n, label: n })),
        },
        runWithArg: (v) => {
          const a = useApp.getState();
          if (a.selectedTaskId && v.trim()) a.addIo(a.selectedTaskId, 'outputs', v.trim());
        },
      },
      {
        id: 'arg-pred',
        label: '前工程を設定…',
        keywords: 'pred zenkoutei 前工程 依存 dependency 順序',
        available: hasSel,
        arg: {
          placeholder: '前工程にする工程を選択',
          options: () => {
            const a = useApp.getState();
            if (!a.selectedTaskId) return [];
            const codes2 = computeCodes(a.project.core);
            return prevCandidates(a.project, a.selectedTaskId).map((t) => ({
              value: t.id,
              label: t.name || '（無題）',
              detail: codes2[t.id],
            }));
          },
        },
        runWithArg: (v) => {
          const a = useApp.getState();
          if (a.selectedTaskId) a.addDependency(v, a.selectedTaskId);
        },
      },
      {
        id: 'arg-scope',
        label: 'スコープを切替…',
        keywords: 'scope sukoopu スコープ 親 表示範囲',
        arg: {
          placeholder: '表示するスコープ（親工程）を選択',
          options: () => {
            const a = useApp.getState();
            const parentLevel = ({ large: null, medium: 'large', small: 'medium', detail: 'small' } as const)[
              a.level
            ];
            if (!parentLevel) return [{ value: '', label: '（全体）' }];
            return [
              { value: '', label: '（全体）' },
              ...Object.values(a.project.core.tasks)
                .filter((t) => t.level === parentLevel)
                .sort((x, y) => x.order - y.order)
                .map((t) => ({ value: t.id, label: t.name || '（無題）' })),
            ];
          },
        },
        runWithArg: (v) => useApp.getState().setScope(v || undefined),
      },
      {
        id: 'arg-comment',
        label: '付箋を追加…',
        keywords: 'comment fusen 付箋 メモ note 追加',
        arg: { placeholder: '付箋のテキスト', freeText: true },
        runWithArg: (v) => {
          if (v.trim()) useApp.getState().addComment(v.trim());
        },
      },
      {
        id: 'arg-connect',
        label: '接続先を指定…（選択工程から矢印）',
        keywords: 'connect setsuzoku 接続 矢印 依存 つなぐ',
        available: hasSel,
        arg: {
          placeholder: '接続先の工程 / 制御ノードを選択',
          options: () => {
            const a = useApp.getState();
            const view = findView(a.project, a.level, a.scopeParentId);
            if (!view || !a.selectedTaskId) return [];
            const from = Object.values(view.nodes).find(
              (n) => n.kind === 'task' && n.taskId === a.selectedTaskId,
            );
            if (!from) return [];
            const ctrlLabel: Record<string, string> = { start: '開始', end: '終了', decision: '判断', merge: '合流' };
            return Object.values(view.nodes).flatMap((n) => {
              if (n.id === from.id) return [];
              if (n.kind === 'task')
                return [{ value: n.id, label: a.project.core.tasks[n.taskId]?.name || '（無題）' }];
              if (n.kind === 'control')
                return [{ value: n.id, label: `${ctrlLabel[n.control] ?? n.control}（制御ノード）` }];
              return [];
            });
          },
        },
        runWithArg: (v) => {
          const a = useApp.getState();
          const view = findView(a.project, a.level, a.scopeParentId);
          const from = view
            ? Object.values(view.nodes).find((n) => n.kind === 'task' && n.taskId === a.selectedTaskId)
            : undefined;
          if (from) a.connect(from.id, v);
        },
      },
      {
        id: 'duplicate-task',
        label: '選択中の工程を複製',
        keywords: 'duplicate fukusei 複製 コピー copy',
        available: hasSel,
        run: () => {
          const a = useApp.getState();
          if (a.selectedTaskId) a.duplicateTask(a.selectedTaskId);
        },
      },
      {
        id: 'delete-task',
        label: '選択中の工程を削除',
        keywords: 'delete remove sakujo 削除 行 ぎょう',
        available: hasSel,
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
      {
        id: 'add-child',
        label: '子工程を追加（選択の下）',
        keywords: 'child ko 子 工程 追加 下',
        available: hasSel,
        run: () => {
          const a = useApp.getState();
          if (!a.selectedTaskId) return;
          const nid = a.addChildTask(a.selectedTaskId);
          if (nid) a.select(nid);
        },
      },
      {
        id: 'collapse-all',
        label: 'アウトラインを全折りたたみ',
        keywords: 'collapse fold tatamu 折りたたみ 閉じる',
        run: () => {
          const parents = new Set(
            Object.values(useApp.getState().project.core.tasks)
              .map((t) => t.parentId)
              .filter((p): p is string => !!p),
          );
          useUI.getState().setOutlineCollapsed(parents);
        },
      },
      {
        id: 'expand-all',
        label: 'アウトラインを全展開',
        keywords: 'expand unfold hiraku 展開 開く',
        run: () => useUI.getState().setOutlineCollapsed(new Set()),
      },
      { id: 'table-mode', label: '表モード切替（アウトライン ⇄ 全項目表）', keywords: 'table mode hyou 表 切替 アウトライン 全項目', run: () => ui.setTableMode(useUI.getState().tableMode === 'outline' ? 'full' : 'outline') },
      { id: 'issues-layer', label: '課題レイヤの表示を切り替え', keywords: 'issue kadai 課題 レイヤ', run: app.toggleIssues },
      { id: 'wide', label: '表を広く / 分割に戻す', keywords: 'wide hyou table 表', run: ui.toggleTableWide },
      { id: 'flow-wide', label: 'フローを広く / 分割に戻す', keywords: 'wide flow フロー 全幅 広く', run: ui.toggleFlowWide },
      { id: 'backups', label: 'バックアップから復元', keywords: 'backup fukugen 復元 バックアップ 世代 restore', run: () => ui.setOverlay('backups') },
      { id: 'issues', label: '課題一覧を開く', keywords: 'issue kadai 課題 一覧 list', run: () => ui.setOverlay('issues') },
      { id: 'summary', label: 'サマリを開く（工数・自動化）', keywords: 'summary dashboard サマリ 集計 工数', run: () => ui.setOverlay('summary') },
      { id: 'help', label: 'ショートカット一覧', keywords: 'help shortcut ヘルプ', hint: '?', run: () => ui.setOverlay('help') },
      { id: 'settings-open', label: '設定を開く', keywords: 'settings settei 設定 環境設定 preferences', hint: '⌘,', run: () => { ui.setSettingsTab('general'); ui.setOverlay('settings'); } },
      { id: 'keybindings', label: 'ショートカット設定（キーの変更）', keywords: 'keybind shortcut settei ショートカット 設定 カスタマイズ キー vim', run: () => { ui.setSettingsTab('keys'); ui.setOverlay('settings'); } },
      { id: 'settings-export', label: '設定をエクスポート / インポート', keywords: 'export import settei 設定 書き出し 取り込み 引き継ぎ', run: () => { ui.setSettingsTab('data'); ui.setOverlay('settings'); } },
      { id: 'tour', label: '使い方ツアーを開始', keywords: 'tour tsukaikata 使い方 ガイド guide オンボーディング', run: () => ui.setTourStep(0) },
    ];
  }, [handlers, canUndo, canRedo, selectedTaskId]);

  const codes = useMemo(() => computeCodes(project.core), [project.core]);

  // ---- コマンド一覧モードの候補 ----
  const { cmdHits, taskHits } = useMemo(() => {
    if (argCmd) return { cmdHits: [] as Cmd[], taskHits: [] as ProcessTask[] };
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
  }, [commands, project.core, codes, query, argCmd]);

  // ---- 引数モードの候補（自由入力の確定行 ＋ 絞り込んだ候補） ----
  const argFlat = useMemo(() => {
    if (!argCmd?.arg) return [] as { kind: 'free' | 'opt'; opt: ArgOption }[];
    const all = argCmd.arg.options?.() ?? [];
    const hits = all
      .map((o) => ({ o, s: fuzzyScore(query, `${o.label} ${o.value} ${o.detail ?? ''}`) }))
      .filter((x) => x.s !== null)
      .sort((a, b) => (b.s ?? 0) - (a.s ?? 0))
      .slice(0, 12)
      .map((x) => ({ kind: 'opt' as const, opt: x.o }));
    // 自由入力可: 入力が候補と完全一致しないとき、先頭に「"◯◯" として確定」を出す。
    if (argCmd.arg.freeText && query.trim() && !all.some((o) => o.value === query.trim())) {
      return [{ kind: 'free' as const, opt: { value: query.trim(), label: `「${query.trim()}」として確定` } }, ...hits];
    }
    return hits;
  }, [argCmd, query]);

  const flat = useMemo(
    () =>
      argCmd
        ? argFlat.map((a) => ({ kind: 'arg' as const, a }))
        : [
            ...cmdHits.map((c) => ({ kind: 'cmd' as const, c })),
            ...taskHits.map((t) => ({ kind: 'task' as const, t })),
          ],
    [argCmd, argFlat, cmdHits, taskHits],
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

  // 引数モードへ入る（defaultValue をプリセットして全選択）。
  const enterArgMode = (c: Cmd) => {
    setArgCmd(c);
    setArgError(null);
    setQuery(c.arg?.defaultValue?.() ?? '');
    setActive(0);
    setTimeout(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    }, 0);
  };

  const exitArgMode = () => {
    setArgCmd(null);
    setArgError(null);
    setQuery('');
    setActive(0);
  };

  // 引数を確定して実行（validate → runWithArg → 閉じる）。
  const commitArg = (value: string, opt?: ArgOption) => {
    if (!argCmd) return;
    const err = argCmd.arg?.validate?.(value) ?? null;
    if (err) {
      setArgError(err);
      return;
    }
    const fn = argCmd.runWithArg;
    close();
    fn?.(value, opt);
  };

  const runItem = (i: number) => {
    const item = flat[i];
    if (!item) {
      // 引数モードで候補が無い: 自由入力可なら入力値で確定（空欄の確定も許す＝担当解除など）。
      if (argCmd?.arg?.freeText) commitArg(query.trim());
      return;
    }
    if (item.kind === 'arg') commitArg(item.a.opt.value, item.a.kind === 'opt' ? item.a.opt : undefined);
    else if (item.kind === 'cmd') {
      if (item.c.arg) enterArgMode(item.c);
      else if (item.c.run) runAndClose(item.c.run);
    } else runAndClose(() => openTask(item.t.id));
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
      if (argCmd) exitArgMode(); // 引数モード → 一覧へ戻る（もう一度 Esc で閉じる）
      else close();
    } else if (e.key === 'Backspace' && argCmd && query === '') {
      e.preventDefault();
      exitArgMode();
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
          {argCmd && (
            <span className="palette-chip" title="Esc で一覧に戻る">
              {argCmd.label.replace(/…$/, '')}
            </span>
          )}
          <input
            ref={inputRef}
            value={query}
            placeholder={argCmd?.arg ? argCmd.arg.placeholder : 'コマンドを実行、または工程を検索…'}
            aria-label={argCmd?.arg ? argCmd.arg.placeholder : 'コマンドまたは工程を検索'}
            onChange={(e) => {
              setQuery(e.target.value);
              setActive(0);
              setArgError(null);
            }}
            onKeyDown={onKeyDown}
          />
          <kbd className="palette-esc">Esc</kbd>
        </div>
        {argError && <div className="palette-error">{argError}</div>}

        <div className="palette-list" ref={listRef} role="listbox" aria-label="候補">
          {flat.length === 0 && (
            <div className="palette-empty">
              {argCmd?.arg?.freeText
                ? 'Enter で入力値を確定します'
                : '一致する候補がありません'}
            </div>
          )}

          {argCmd &&
            flat.map((item, i) => {
              if (item.kind !== 'arg') return null;
              const { a } = item;
              return (
                <button
                  key={`${a.kind}-${a.opt.value}`}
                  role="option"
                  aria-selected={active === i}
                  data-active={active === i}
                  className={`palette-item${active === i ? ' active' : ''}${a.kind === 'free' ? ' free' : ''}`}
                  onMouseMove={() => setActive(i)}
                  onClick={() => runItem(i)}
                >
                  <span className="pi-label">{a.opt.label}</span>
                  {a.opt.detail && <span className="pi-assignee">{a.opt.detail}</span>}
                </button>
              );
            })}

          {!argCmd && cmdHits.length > 0 && <div className="palette-section">操作</div>}
          {!argCmd &&
            cmdHits.map((c, i) => (
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
                {c.arg && <span className="pi-arg-mark" aria-hidden="true">›</span>}
                {c.hint && <kbd className="pi-hint">{c.hint}</kbd>}
              </button>
            ))}

          {!argCmd && taskHits.length > 0 && <div className="palette-section">工程へジャンプ</div>}
          {!argCmd &&
            taskHits.map((t, j) => {
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
