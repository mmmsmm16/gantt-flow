import { useEffect } from 'react';
import { findView, useApp } from './store';
import {
  isProjectIntegrityError,
  isSchemaVersionTooNewError,
  type LockInfo,
  type ProcessLevel,
} from '@gantt-flow/core';
import { TableView } from './TableView';
import { FullTable } from './FullTable';
import { FlowCanvas } from './FlowCanvas';
import { Inspector } from './Inspector';
import {
  saveProjectToFile,
  openProjectFromFile,
  readTableFile,
  exportExcelFile,
  exportCsvFile,
  exportSvgFile,
  exportPngFile,
  printProjectAndFlow,
  forgetFileHandle,
  openRecentFile,
} from './persistence';
import { useUI } from './ui/useUI';
import { Modal, Toaster, BusyOverlay } from './ui/Dialogs';
import * as Icons from './ui/icons';
import { Menu, MenuItem } from './ui/Menu';
import { Welcome } from './ui/Welcome';
import { HelpDialog } from './ui/HelpDialog';
import { IssueListDialog } from './ui/IssueListDialog';
import { SummaryDialog } from './ui/SummaryDialog';
import { StatusBar } from './ui/StatusBar';
import { CommandPalette } from './ui/CommandPalette';
import { takeAutosaveForRestore, clearAutosave } from './autosave';
import { useGlobalHotkeys } from './ui/useGlobalHotkeys';
import { pushBackup } from './backups';
import { BackupsDialog } from './ui/BackupsDialog';
import { SettingsDialog } from './ui/SettingsDialog';
import { Tour, tourDone } from './ui/Tour';

const LEVELS: { key: ProcessLevel; label: string }[] = [
  { key: 'large', label: '大' },
  { key: 'medium', label: '中' },
  { key: 'small', label: '小' },
  { key: 'detail', label: '詳細' },
];
const PARENT_LEVEL: Record<ProcessLevel, ProcessLevel | null> = {
  large: null,
  medium: 'large',
  small: 'medium',
  detail: 'small',
};

export function App() {
  const project = useApp((s) => s.project);
  const level = useApp((s) => s.level);
  const scopeParentId = useApp((s) => s.scopeParentId);
  const showIssues = useApp((s) => s.showIssues);
  const canUndo = useApp((s) => s.canUndo);
  const canRedo = useApp((s) => s.canRedo);
  const dirty = useApp((s) => s.dirty);

  const setLevel = useApp((s) => s.setLevel);
  const setScope = useApp((s) => s.setScope);
  const toggleIssues = useApp((s) => s.toggleIssues);
  const undo = useApp((s) => s.undo);
  const redo = useApp((s) => s.redo);

  const selectedTaskId = useApp((s) => s.selectedTaskId);
  const isEmpty = Object.keys(project.core.tasks).length === 0;
  const theme = useUI((s) => s.theme);
  const toggleTheme = useUI((s) => s.toggleTheme);
  const tableWide = useUI((s) => s.tableWide);
  const flowWide = useUI((s) => s.flowWide);
  const toggleFlowWide = useUI((s) => s.toggleFlowWide);
  const tableMode = useUI((s) => s.tableMode);
  const setTableMode = useUI((s) => s.setTableMode);
  const activePane = useUI((s) => s.activePane);
  const setActivePane = useUI((s) => s.setActivePane);
  const inspectorOpen = useUI((s) => s.inspectorOpen);
  const fullMode = tableMode === 'full';
  const parentLevel = PARENT_LEVEL[level];
  const scopeOptions = parentLevel
    ? Object.values(project.core.tasks).filter((t) => t.level === parentLevel)
    : [];

  const onSave = async (opts: { saveAs?: boolean; force?: boolean } = {}) => {
    // 保存した内容そのものを markSaved に渡す（書き込み待ちの間の編集を保存済み扱いにしない）。
    const snapshot = useApp.getState().project;
    try {
      const result = await saveProjectToFile(snapshot, opts);
      if (result.kind === 'cancelled') return; // ピッカーをキャンセル
      if (result.kind === 'conflict') {
        const ok = await useUI.getState().confirm({
          title: '保存の競合',
          message:
            'ファイルが他で変更されています。上書きしますか？\n（他のセッションが保存した内容は失われます）',
          confirmLabel: '上書き保存',
          danger: true,
        });
        if (ok) await onSave({ ...opts, force: true });
        return;
      }
      useApp.getState().markSaved(snapshot);
      pushBackup(snapshot); // 直近世代をこの端末に残す（復元用）
      useUI
        .getState()
        .toast(
          result.kind === 'downloaded'
            ? `ダウンロードに保存しました（${result.name}）` // 上書き不可の環境（成功と区別して伝える）
            : `保存しました（${result.name}）`,
          'success',
        );
    } catch (err) {
      // 書き込み失敗は成功と紛れさせない: dirty と復旧データはそのまま残る。
      const detail = err instanceof Error ? err.message : typeof err === 'string' ? err : '';
      void useUI.getState().confirm({
        title: '保存できませんでした',
        message: `ファイルへの保存に失敗しました。未保存の変更はこのまま残っています。\n「名前を付けて保存」で別の場所への保存をお試しください。${
          detail ? `\n\n詳細: ${detail}` : ''
        }`,
        confirmLabel: '閉じる',
        hideCancel: true,
      });
    }
  };
  const onSaveAs = () => onSave({ saveAs: true });
  // 開く時に他セッションの編集ロックを見つけたときの判断（Tauri のみ呼ばれる）。
  const confirmLock = async (held: LockInfo, stale: boolean): Promise<'takeover' | 'proceed' | 'cancel'> => {
    const heartbeat = new Date(held.heartbeatAt).toLocaleString('ja-JP');
    if (stale) {
      const ok = await useUI.getState().confirm({
        title: '前回のロックが残っています',
        message: `このファイルは ${held.user}（${held.host}）が開いたまま終了した可能性があります（最終応答: ${heartbeat}）。\n編集ロックを引き継いで開きますか？`,
        confirmLabel: '引き継いで開く',
      });
      return ok ? 'takeover' : 'cancel';
    }
    const ok = await useUI.getState().confirm({
      title: '他のセッションが編集中',
      message: `このファイルは ${held.user}（${held.host}）が編集中です（最終応答: ${heartbeat}）。\nこのまま開くと、保存時にお互いの変更を上書きする危険があります。続行しますか？`,
      confirmLabel: '続行して開く',
      danger: true,
    });
    return ok ? 'proceed' : 'cancel';
  };
  const onOpen = async () => {
    try {
      const p = await openProjectFromFile({ confirmLock });
      if (p) {
        useApp.getState().loadProject(p);
        useUI.getState().setOutlineCollapsed(new Set());
        useUI.getState().toast('開きました。', 'success');
      }
    } catch (err) {
      if (isSchemaVersionTooNewError(err) || isProjectIntegrityError(err)) {
        void useUI.getState().confirm({
          title: 'ファイルを開けませんでした',
          message: err.message,
          confirmLabel: '閉じる',
          hideCancel: true,
        });
      } else {
        useUI.getState().toast('ファイルを開けませんでした（形式が不正です）。', 'error');
      }
    }
  };
  const onNew = async () => {
    const ok = await useUI.getState().confirm({
      title: '新規プロジェクト',
      message: '新規プロジェクトを作成します。未保存の変更は失われます。',
      confirmLabel: '作成',
      danger: true,
    });
    if (ok) {
      forgetFileHandle(); // 新規は保存先を引き継がない
      useApp.getState().newProject();
      useUI.getState().setOutlineCollapsed(new Set());
    }
  };
  const onImport = () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.csv,.xlsx,text/csv';
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;
      try {
        useUI.getState().setBusy('取り込んでいます…');
        // スピナーを描画してから重い処理へ（同期処理で固まる前に 1 フレーム譲る）。
        await new Promise((r) => requestAnimationFrame(() => r(undefined)));
        forgetFileHandle(); // 取り込みは新規プロジェクト＝保存先を引き継がない
        const report = useApp.getState().importRows(await readTableFile(file));
        useUI.getState().setOutlineCollapsed(new Set());
        const c = report.created;
        let msg = `工程 ${c.tasks} / 入出力 ${c.ios} / 課題 ${c.issues} / 依存 ${c.dependencies} を取り込みました。`;
        if (report.unresolvedDeps.length)
          msg += `\n\n未解決の前工程: ${report.unresolvedDeps.length}件（行 ${report.unresolvedDeps
            .map((u) => u.row)
            .join(', ')}）`;
        if (report.hierarchyIssues.length) msg += `\n粒度/親の問題: ${report.hierarchyIssues.length}件`;
        if (report.warnings.length) msg += `\n警告: ${report.warnings.join(' / ')}`;
        void useUI.getState().confirm({
          title: '取り込み結果',
          message: msg,
          confirmLabel: '閉じる',
          hideCancel: true,
        });
      } catch {
        useUI.getState().toast('取り込みに失敗しました（CSV / Excel を確認してください）。', 'error');
      } finally {
        useUI.getState().setBusy(null);
      }
    };
    input.click();
  };
  // サンプル/テンプレートで現在のプロジェクトを置き換える前の確認（未保存があるときだけ）。
  const confirmReplace = async (title: string): Promise<boolean> => {
    if (!useApp.getState().dirty) return true;
    return useUI.getState().confirm({
      title,
      message: '未保存の変更があります。続行すると失われます。よろしいですか？',
      confirmLabel: '続行',
      danger: true,
    });
  };
  const onSample = async () => {
    if (!(await confirmReplace('サンプルを開く'))) return;
    forgetFileHandle(); // サンプルに保存先を引き継がない（元ファイルへの誤上書き防止）
    useApp.getState().loadSample();
    useUI.getState().setOutlineCollapsed(new Set());
    if (!tourDone()) {
      useUI.getState().setTourStep(0); // 初回だけ使い方ツアーを開始
    } else {
      useUI.getState().toast('サンプルを開きました。表を編集するとフローに反映されます。', 'success');
    }
  };
  const onTemplate = async (key: string) => {
    if (!(await confirmReplace('テンプレートを開く'))) return;
    forgetFileHandle(); // テンプレートに保存先を引き継がない（元ファイルへの誤上書き防止）
    useApp.getState().loadTemplate(key);
    useUI.getState().setOutlineCollapsed(new Set());
    useUI.getState().toast('テンプレートを開きました。自社の業務に合わせて編集してください。', 'success');
  };
  const onOpenRecent = async (name: string) => {
    try {
      const p = await openRecentFile(name);
      if (p) {
        useApp.getState().loadProject(p);
        useUI.getState().setOutlineCollapsed(new Set());
        useUI.getState().toast('開きました。', 'success');
      } else {
        useUI.getState().toast('このファイルを開けませんでした（権限が必要です）。', 'error');
      }
    } catch {
      useUI.getState().toast('ファイルを開けませんでした。', 'error');
    }
  };
  const onExportExcel = () => {
    const n = exportExcelFile(useApp.getState().project);
    useUI.getState().toast(`出力しました（${n}）`, 'success');
  };
  const onExportCsv = () => {
    const n = exportCsvFile(useApp.getState().project);
    useUI.getState().toast(`出力しました（${n}）`, 'success');
  };
  const onExportSvg = () => {
    const st = useApp.getState();
    const view = findView(st.project, st.level, st.scopeParentId);
    if (view) {
      const name = exportSvgFile(st.project, view);
      useUI.getState().toast(`出力しました（${name}）`, 'success');
    }
  };
  const onExportPng = async () => {
    const st = useApp.getState();
    const view = findView(st.project, st.level, st.scopeParentId);
    if (!view) return;
    try {
      const name = await exportPngFile(st.project, view);
      useUI.getState().toast(`出力しました（${name}）`, 'success');
    } catch {
      useUI.getState().toast('PNG の出力に失敗しました。', 'error');
    }
  };
  const onPrint = () => {
    const st = useApp.getState();
    printProjectAndFlow(st.project, findView(st.project, st.level, st.scopeParentId));
  };

  // グローバルショートカット(キーマップ駆動)。keymap.ts が単一の真実、
  // ディスパッチは useGlobalHotkeys に一元化(IME・編集中・オーバーレイのガード込み)。
  useGlobalHotkeys({ onSave: () => void onSave(), onPrint });

  // 未保存のまま閉じようとしたら確認（データ消失の防止）。
  useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (useApp.getState().dirty) {
        e.preventDefault();
        e.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, []);

  // 起動時: 自動退避データがあれば復元を提案（クラッシュ/誤クローズからの復旧）。
  useEffect(() => {
    const saved = takeAutosaveForRestore();
    if (!saved) return;
    void (async () => {
      const ok = await useUI.getState().confirm({
        title: '前回の作業を復元しますか？',
        message:
          '保存されていない作業が見つかりました（自動退避）。復元するとその状態から再開できます。破棄すると元に戻せません。',
        confirmLabel: '復元する',
        cancelLabel: '破棄',
      });
      if (ok) {
        clearAutosave(); // 提案したエントリは消費（復元後は dirty になり改めて退避される）
        useApp.getState().restoreProject(saved);
        useUI.getState().setOutlineCollapsed(new Set());
        useUI.getState().toast('前回の未保存データを復元しました。保存をお忘れなく。', 'success');
      } else {
        clearAutosave();
      }
    })();
  }, []);

  return (
    <div className="app">
      <a className="skip-link" href="#main-table">
        工程表へスキップ
      </a>
      <header className="toolbar" role="banner">
        <span className="brand">
          <svg className="brand-mark" width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
            <rect className="bg" width="18" height="18" rx="5" />
            <rect className="bar" x="3.5" y="3.8" width="8" height="2.2" rx="1.1" />
            <rect className="bar b2" x="6" y="7.9" width="8.5" height="2.2" rx="1.1" />
            <rect className="bar b3" x="3.5" y="12" width="6" height="2.2" rx="1.1" />
          </svg>
          <span className="brand-name">
            gantt-<span className="brand-accent">flow</span>
          </span>
        </span>
        <span className="spacer" />

        <span className="tool-group" role="group" aria-label="履歴">
          <button className="icon-btn" onClick={undo} disabled={!canUndo} aria-label="戻す" title="戻す (Ctrl+Z)">
            <Icons.Undo />
          </button>
          <button
            className="icon-btn"
            onClick={redo}
            disabled={!canRedo}
            aria-label="やり直し"
            title="やり直し (Ctrl+Y)"
          >
            <Icons.Redo />
          </button>
        </span>

        <span className="tool-group" role="group" aria-label="ファイル">
          <button className="icon-btn" onClick={onNew} aria-label="新規" title="新規プロジェクト">
            <Icons.FilePlus />
          </button>
          <button
            className="icon-btn"
            onClick={onImport}
            aria-label="取り込み"
            title="取り込み（CSV / Excel）"
          >
            <Icons.Upload />
          </button>
          <button className="icon-btn" onClick={onOpen} aria-label="開く" title="開く">
            <Icons.FolderOpen />
          </button>
          <button
            className={`icon-btn${dirty ? ' has-unsaved' : ''}`}
            onClick={() => onSave()}
            aria-label={dirty ? '保存（未保存の変更あり）' : '保存'}
            title="保存 (Ctrl+S)"
          >
            <Icons.Save />
          </button>
        </span>

        <Menu
          className="icon-btn menu-trigger"
          title="出力"
          label={
            <>
              <Icons.Download />
              <Icons.ChevronDown />
            </>
          }
        >
          <MenuItem onClick={onExportExcel}>Excel (.xlsx)</MenuItem>
          <MenuItem onClick={onExportCsv}>CSV (.csv)</MenuItem>
          <MenuItem onClick={onExportPng}>画像 (PNG)</MenuItem>
          <MenuItem onClick={onExportSvg}>画像 (SVG)</MenuItem>
        </Menu>

        <button className="icon-btn" onClick={onPrint} aria-label="印刷 / PDF" title="印刷 / PDF（工程表＋フロー図）">
          <Icons.Printer />
        </button>

        <span className="tool-group" role="group" aria-label="ビュー">
          <button
            className="icon-btn"
            onClick={() => useUI.getState().setOverlay('issues')}
            aria-label="課題一覧"
            title="課題一覧（工程横断）"
          >
            <Icons.ListChecks />
          </button>
          <button
            className="icon-btn"
            onClick={() => useUI.getState().setOverlay('summary')}
            aria-label="サマリ"
            title="サマリ（担当別工数・自動化など）"
          >
            <Icons.ChartBar />
          </button>
        </span>

        <button
          className="icon-btn"
          onClick={toggleTheme}
          aria-label={theme === 'dark' ? 'ライトテーマに切替' : 'ダークテーマに切替'}
          title={theme === 'dark' ? 'ライトに切替' : 'ダークに切替'}
        >
          {theme === 'dark' ? <Icons.Sun /> : <Icons.Moon />}
        </button>
        <button
          className="icon-btn"
          onClick={() => {
            useUI.getState().setSettingsTab('general');
            useUI.getState().setOverlay('settings');
          }}
          aria-label="設定"
          title="設定（テーマ / ショートカット / エクスポート）"
        >
          <Icons.Gear />
        </button>
        <button
          className="icon-btn"
          onClick={() => useUI.getState().setOverlay('help')}
          aria-label="キーボードショートカット"
          title="キーボードショートカット (?)"
        >
          <Icons.Keyboard />
        </button>
      </header>
      {isEmpty ? (
        <Welcome onSample={onSample} onImport={onImport} onOpen={onOpen} onOpenRecent={onOpenRecent} onTemplate={onTemplate} />
      ) : (
        <div
          className={`panes${!fullMode && selectedTaskId && inspectorOpen ? ' with-inspector' : ''}${
            tableWide || fullMode ? ' table-wide' : ''
          }${flowWide ? ' flow-wide' : ''}`}
        >
          {!flowWide && (
          <section
            className={`pane table-pane${fullMode ? ' full' : ''}${activePane === 'table' ? ' pane-active' : ''}`}
            id="main-table"
            tabIndex={-1}
            aria-label="工程表（手順一覧表）"
            onPointerDownCapture={() => setActivePane('table')}
          >
            <div className="table-head">
              <h2>工程表（手順一覧表）</h2>
              <span className="seg table-mode-seg" role="group" aria-label="表示モード">
                <button className={!fullMode ? 'on' : ''} onClick={() => setTableMode('outline')}>
                  アウトライン
                </button>
                <button className={fullMode ? 'on' : ''} onClick={() => setTableMode('full')}>
                  全項目表
                </button>
              </span>
            </div>
            {fullMode ? <FullTable /> : <TableView />}
          </section>
          )}
          {!tableWide && !fullMode && (
            <section
              className={`pane flow-pane${activePane === 'flow' ? ' pane-active' : ''}`}
              tabIndex={-1}
              aria-label="工程フロー図"
              onPointerDownCapture={() => setActivePane('flow')}
            >
              <div className="flow-head">
                <h2>工程フロー</h2>
                <span className="seg" role="group" aria-label="粒度">
                  {LEVELS.map((l) => (
                    <button
                      key={l.key}
                      className={l.key === level ? 'on' : ''}
                      onClick={() => setLevel(l.key)}
                      title={`${l.label}工程の粒度で表示`}
                    >
                      {l.label}
                    </button>
                  ))}
                </span>
                {parentLevel && (
                  <select
                    className="scope"
                    value={scopeParentId ?? ''}
                    onChange={(e) => setScope(e.target.value || undefined)}
                    title="表示するスコープ（親工程）"
                  >
                    <option value="">（スコープ: 全体）</option>
                    {scopeOptions.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.name}
                      </option>
                    ))}
                  </select>
                )}
                <button
                  className={`icon-btn toggle-btn${showIssues ? ' on' : ''}`}
                  onClick={toggleIssues}
                  aria-pressed={showIssues}
                  aria-label="課題レイヤの表示切替"
                  title={showIssues ? '課題レイヤを隠す' : '課題レイヤを表示'}
                >
                  {showIssues ? <Icons.Eye /> : <Icons.EyeOff />}
                </button>
                <button
                  className="wide-toggle flow-wide-toggle"
                  onClick={toggleFlowWide}
                  aria-pressed={flowWide}
                  title={flowWide ? '表を表示して分割に戻す' : '表を畳んでフローを全幅にする'}
                >
                  {flowWide ? '↔ 分割に戻す' : '⤢ フローを広く'}
                </button>
              </div>
              <FlowCanvas />
            </section>
          )}
          {!fullMode && selectedTaskId && inspectorOpen && (
            <section className="pane inspector-pane">
              <Inspector />
            </section>
          )}
        </div>
      )}
      {!isEmpty && <StatusBar />}
      <CommandPalette
        onNew={onNew}
        onSave={onSave}
        onSaveAs={onSaveAs}
        onOpen={onOpen}
        onImport={onImport}
        onSample={onSample}
        onExportExcel={onExportExcel}
        onExportCsv={onExportCsv}
        onExportSvg={onExportSvg}
        onExportPng={onExportPng}
        onPrint={onPrint}
      />
      <HelpDialog />
      <IssueListDialog />
      <SummaryDialog />
      <BackupsDialog />
      <SettingsDialog />
      <Tour />
      <Modal />
      <BusyOverlay />
      <Toaster />
    </div>
  );
}
