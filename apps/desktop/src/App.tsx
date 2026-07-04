import { useEffect, useMemo, useRef, useState } from 'react';
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
import { ProcedureView } from './ProcedureView';
import { buildScenarioFlowSvg } from './scenarioFlow';
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
  currentFileName,
  listRecentFiles,
  recentFilesSupported,
  startExternalWatch,
  stopExternalWatch,
  acknowledgeExternalChange,
  isEmptyProjectForOutput,
} from './persistence';
import { formatWindowTitle, formatRecentTime, UNTITLED_LABEL } from './fileLabel';
import { useUI } from './ui/useUI';
import { Modal, Toaster, BusyOverlay } from './ui/Dialogs';
import * as Icons from './ui/icons';
import { Menu, MenuItem } from './ui/Menu';
import { Welcome } from './ui/Welcome';
import { HelpDialog } from './ui/HelpDialog';
import { IssueListDialog } from './ui/IssueListDialog';
import { SummaryDialog } from './ui/SummaryDialog';
import { ComparisonDialog } from './ui/ComparisonDialog';
import { StatusBar } from './ui/StatusBar';
import { CommandPalette } from './ui/CommandPalette';
import { takeAutosaveForRestore, clearAutosave } from './autosave';
import { confirmReplace, gatedImport, gatedOpen } from './replaceOps';
import { useGlobalHotkeys } from './ui/useGlobalHotkeys';
import { pushBackup } from './backups';
import { BackupsDialog } from './ui/BackupsDialog';
import { SettingsDialog } from './ui/SettingsDialog';
import { Tour, tourDone, shouldStartTourOnFirstTask } from './ui/Tour';
import { startMirrorPublisher, openMirrorWindow, pickMirrorState } from './mirror';
import { useDualWindow, openEditWindow } from './dualwindow';

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

// 分割 / 表 / フロー のビュー切替。ツールバー（上部）に一つだけ置き、どのレイアウトでも
// 常に切替先へ行けるようにする（各ペインのヘッダには持たせない）。
// 「場所の移動」は下線タブで示す（DESIGN D-2）。常設の操作部から塗りを除き、成果物＝
// フロー図と視覚的に競合させない。状態の選択（粒度など）は別形（.seg）を使う。
const PANE_LAYOUT_TABS: { value: 'split' | 'table' | 'flow'; label: string; title: string }[] = [
  { value: 'split', label: '分割', title: '工程表とフローを分割表示' },
  { value: 'table', label: '表', title: '工程表だけを全幅表示' },
  { value: 'flow', label: 'フロー', title: '工程フローだけを全幅表示' },
];

function PaneLayoutTabs({ current }: { current: 'split' | 'table' | 'flow' }) {
  const setPaneLayout = useUI((s) => s.setPaneLayout);
  const mainView = useUI((s) => s.mainView);
  const setMainView = useUI((s) => s.setMainView);
  const inProc = mainView === 'procedure';
  return (
    <span className="view-tabs" role="tablist" aria-label="表示ビュー">
      {PANE_LAYOUT_TABS.map((t) => (
        <button
          key={t.value}
          type="button"
          role="tab"
          aria-selected={!inProc && current === t.value}
          className={!inProc && current === t.value ? 'on' : ''}
          // 手順書から作業ビューへ戻す（分割操作が効かない事故を防ぐ）＋ペインレイアウトを設定。
          onClick={() => {
            setMainView('work');
            setPaneLayout(t.value);
          }}
          title={t.title}
        >
          {t.label}
        </button>
      ))}
      {/* 手順書タブ（第 3 のビュー）。常設ボタンとして分割/表/フローの隣に置く。 */}
      <button
        type="button"
        role="tab"
        aria-selected={inProc}
        className={inProc ? 'on' : ''}
        onClick={() => setMainView('procedure')}
        title="手順書（工程ごとの実施手順）"
      >
        手順書
      </button>
    </span>
  );
}

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
  // 両窓編集同期: この窓が編集フォロワーか、リーダーへ接続済みか。フォロワーはファイル系を
  // グレーアウトし、未接続（リーダー離脱/起動待ち）のあいだは編集をロックして接続待ちを出す。
  const windowRole = useDualWindow((s) => s.role);
  const syncConnected = useDualWindow((s) => s.connected);
  const isFollower = windowRole === 'follower';
  const followerWaiting = isFollower && !syncConnected;
  const isEmpty = Object.keys(project.core.tasks).length === 0;
  const fileName = useUI((s) => s.fileName);
  // Welcome は「工程 0 件」かつ「このセッションでまだ離れていない」ときだけ。
  // 空の編集画面（新規プロジェクト）や、全工程を削除した直後に突然戻さない。
  const welcomeDismissed = useUI((s) => s.welcomeDismissed);
  const showWelcome = isEmpty && !welcomeDismissed;
  // 工程が 1 件でもできたら離脱扱いにする(パレット等、Welcome のボタン以外の経路でも。
  // 以後は全工程を削除しても Welcome へは戻らない)。
  useEffect(() => {
    if (isEmpty) return;
    const ui = useUI.getState();
    ui.setWelcomeDismissed(true);
    // 空スタート経路: 最初の工程が生まれた瞬間（＝同期を体感できる瞬間）に初回ツアーを提示する。
    // サンプル/テンプレ/取り込みは各ハンドラが開いた直後に開始するので pending は使わない。
    if (ui.tourPendingFirstTask) {
      ui.setTourPendingFirstTask(false);
      if (shouldStartTourOnFirstTask({ pending: true, done: tourDone() })) ui.setTourStep(0);
    }
  }, [isEmpty]);
  const theme = useUI((s) => s.theme);
  const toggleTheme = useUI((s) => s.toggleTheme);
  const tobeEnabled = useUI((s) => s.tobeEnabled);
  const scenario = useUI((s) => s.scenario);
  const setScenario = useUI((s) => s.setScenario);
  // メインのフローを To-Be で表示中のとき、射影フローを SVG で描く（読み取り専用）。
  const tobeFlowSvg = useMemo(
    () => (tobeEnabled && scenario === 'tobe' ? buildScenarioFlowSvg(project, 'tobe', level, scopeParentId) : ''),
    [tobeEnabled, scenario, project, level, scopeParentId],
  );
  const mainView = useUI((s) => s.mainView);
  const tableWide = useUI((s) => s.tableWide);
  const flowWide = useUI((s) => s.flowWide);
  const chromeHidden = useUI((s) => s.chromeHidden);
  const toggleChrome = useUI((s) => s.toggleChrome);
  const tableMode = useUI((s) => s.tableMode);
  const setTableMode = useUI((s) => s.setTableMode);
  const activePane = useUI((s) => s.activePane);
  const setActivePane = useUI((s) => s.setActivePane);
  const inspectorOpen = useUI((s) => s.inspectorOpen);
  const fullMode = tableMode === 'full';
  // 現在のレイアウト（タブのハイライト用）。full は常にフロー非表示なので「表のみ」扱い。
  const paneLayout: 'split' | 'table' | 'flow' = flowWide ? 'flow' : tableWide || fullMode ? 'table' : 'split';
  // 案A: インスペクタ(詳細)はオンデマンド。3ペインは作らず、最大2ペイン。
  // 分割で詳細を開いたら「いま操作中のペイン(activePane)＋詳細」にして反対側を隠す。
  // 表のみ/フローのみ＋詳細はそのまま2ペイン。閉じれば元のレイアウトへ戻る。
  // 選択工程が実在するときだけ詳細を開く（削除直後に選択が残ると、空の詳細ペインが開いたまま
  // 固着し、分割表示でフローペインが消えてしまう＝H-2。store 側の選択解除と二重で防ぐ）。
  const showInspector =
    !fullMode && !!selectedTaskId && !!project.core.tasks[selectedTaskId] && inspectorOpen;
  const collapseForInspector = showInspector && paneLayout === 'split';
  const showTable = !flowWide && !(collapseForInspector && activePane === 'flow');
  const showFlow = !tableWide && !fullMode && !(collapseForInspector && activePane === 'table');
  const parentLevel = PARENT_LEVEL[level];
  const scopeOptions = parentLevel
    ? Object.values(project.core.tasks).filter((t) => t.level === parentLevel)
    : [];

  // PR6/item4: ビュー構成(分割/表/フロー)・インスペクタ開閉・粒度・課題レイヤを永続化し、
  // 再起動で前回の作業姿勢を復元する。選択工程(selectedTaskId)は別ファイルで無効IDになり
  // 混乱しうるため永続対象にしない（必要時は明示選択で開く）。
  const prefsRestored = useRef(false);
  useEffect(() => {
    if (!prefsRestored.current) {
      prefsRestored.current = true; // マウント時は復元のみ（初期値で上書き保存しない）
      try {
        const p = JSON.parse(localStorage.getItem('gf-ws-prefs') || '{}');
        const ui = useUI.getState();
        const app = useApp.getState();
        if (p.flowWide) ui.setPaneLayout('flow');
        else if (p.tableWide) ui.setPaneLayout('table');
        if (typeof p.inspectorOpen === 'boolean') ui.setInspectorOpen(p.inspectorOpen);
        if (['large', 'medium', 'small', 'detail'].includes(p.level) && p.level !== app.level) {
          app.setLevel(p.level);
        }
        if (typeof p.showIssues === 'boolean' && p.showIssues !== app.showIssues) app.toggleIssues();
      } catch {
        /* localStorage 不可/破損: 既定のまま */
      }
      return;
    }
    try {
      localStorage.setItem(
        'gf-ws-prefs',
        JSON.stringify({ tableWide, flowWide, inspectorOpen, level, showIssues }),
      );
    } catch {
      /* 保存不可は無視 */
    }
  }, [tableWide, flowWide, inspectorOpen, level, showIssues]);

  // persistence が覚えている保存先はモジュール変数で React から購読できないため、
  // 保存/開く等の「保存先が変わりうる操作」の完了時にここで useUI へ写す。
  const syncFileName = () => useUI.getState().setFileName(currentFileName());

  // 最近使ったファイル（▼メニュー用）。IndexedDB 読みは非同期のため、開く瞬間の取得
  // だけだと一瞬空で描画される。マウント時に先読みし、開くたびに最新化する。
  const recentSupported = recentFilesSupported();
  const [recentFiles, setRecentFiles] = useState<{ name: string; at: number }[]>([]);
  const refreshRecent = () => void listRecentFiles().then(setRecentFiles);
  useEffect(() => {
    if (recentFilesSupported()) refreshRecent();
  }, []);

  // 保存の再入ガード: 保存中の Ctrl+S 連打やパレットからの多重起動を無視する
  //（persistence 側でも直列化されるが、競合ダイアログ等の多重表示をここで防ぐ）。
  const savingRef = useRef(false);
  // 明示保存の実行中を保存ボタンに出す（完了は既存の成功/失敗トーストが担うので開始側だけ）。
  const [saving, setSaving] = useState(false);
  const doSave = async (opts: { saveAs?: boolean; force?: boolean } = {}) => {
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
        if (ok) await doSave({ ...opts, force: true });
        return;
      }
      useApp.getState().markSaved(snapshot);
      pushBackup(snapshot); // 直近世代をこの端末に残す（復元用）
      syncFileName(); // 名前を付けて保存で保存先が変わりうる
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
  const onSave = async (opts: { saveAs?: boolean; force?: boolean } = {}) => {
    if (savingRef.current) return; // 保存中の再実行は無視（完了後に改めて保存してもらう）
    savingRef.current = true;
    setSaving(true);
    try {
      await doSave(opts);
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };
  const onSaveAs = () => onSave({ saveAs: true });
  // 開く時に他セッションの編集ロックを見つけたときの判断（Tauri のみ呼ばれる）。
  const confirmLock = async (held: LockInfo | null, stale: boolean): Promise<'takeover' | 'proceed' | 'cancel'> => {
    // held: null は .lock が読めない（書き込み途中 or 破損）= 保持者不明。奪取は提示しない。
    const who = held ? `${held.user}（${held.host}）` : '別のセッション（保持者不明）';
    const heartbeat = held ? new Date(held.heartbeatAt).toLocaleString('ja-JP') : '不明';
    if (stale && held) {
      const ok = await useUI.getState().confirm({
        title: '前回のロックが残っています',
        message: `このファイルは ${who}が開いたまま終了した可能性があります（最終応答: ${heartbeat}）。\n編集ロックを引き継いで開きますか？`,
        confirmLabel: '引き継いで開く',
      });
      return ok ? 'takeover' : 'cancel';
    }
    const ok = await useUI.getState().confirm({
      title: '他のセッションが編集中',
      message: `このファイルは ${who}が編集中です（最終応答: ${heartbeat}）。\nこのまま開くと、保存時にお互いの変更を上書きする危険があります。続行しますか？`,
      confirmLabel: '続行して開く',
      danger: true,
    });
    return ok ? 'proceed' : 'cancel';
  };
  // 開く(Ctrl+O)も他の置換系(新規/取り込み/サンプル/テンプレ/最近のファイル)と同じ基準で、
  // 未保存があるときだけ確認する（gatedOpen が confirmReplace→openProjectFromFile の順序を
  // 保証する。openProjectFromFile はキャンセル時に一切呼ばれない＝ピッカーも開かない）。
  const onOpen = async () => {
    try {
      const p = await gatedOpen(() => openProjectFromFile({ confirmLock }));
      if (p) {
        useApp.getState().loadProject(p);
        useUI.getState().setOutlineCollapsed(new Set());
        useUI.getState().setWelcomeDismissed(true);
        syncFileName();
        useUI.getState().toast('開きました。', 'success');
      }
    } catch (err) {
      if (isSchemaVersionTooNewError(err) || isProjectIntegrityError(err)) {
        // 開けなかったときの復元導線: 「バックアップから復元」を選べば既存の BackupsDialog を開くだけ
        // （このファイルが壊れていても、この端末に残る直近世代から復旧できる）。
        const restore = await useUI.getState().confirm({
          title: 'ファイルを開けませんでした',
          message: err.message,
          confirmLabel: 'バックアップから復元',
          cancelLabel: '閉じる',
        });
        if (restore) useUI.getState().setOverlay('backups');
      } else {
        useUI.getState().toast('ファイルを開けませんでした（形式が不正です）。', 'error');
      }
    }
  };
  // サンプル/テンプレート/新規/取り込みで現在のプロジェクトを置き換える前の確認は
  // replaceOps.confirmReplace に集約(単体テスト対象。App のクロージャに埋めない)。
  const onNew = async () => {
    if (!(await confirmReplace('新規プロジェクト'))) return;
    forgetFileHandle(); // 新規は保存先を引き継がない
    useApp.getState().newProject();
    useUI.getState().setOutlineCollapsed(new Set());
    useUI.getState().setWelcomeDismissed(true); // Welcome に戻さず空の編集画面へ
    syncFileName();
  };
  const onImport = async () => {
    // 取り込みは新規プロジェクト生成＝現在の内容を丸ごと置換する(取り込み後は履歴も reset され
    // Ctrl+Z で戻せない)。他の置換系(サンプル/テンプレ/開く)と同じ基準で、未保存があるときだけ
    // 確認する(唯一のデータ喪失導線だったのを塞ぐ。UX#7)。gatedImport が
    // confirmReplace→openPicker の順序を保証する(openPicker はキャンセル時に一切呼ばれない)。
    await gatedImport(() => {
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
          syncFileName();
          const report = useApp.getState().importRows(await readTableFile(file));
          useUI.getState().setOutlineCollapsed(new Set());
          useUI.getState().setWelcomeDismissed(true);
          if (!tourDone()) useUI.getState().setTourStep(0); // 取り込み直後にも初回ツアーを提示（結果ダイアログの下層）
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
    });
  };
  const onSample = async () => {
    if (!(await confirmReplace('サンプルを開く'))) return;
    forgetFileHandle(); // サンプルに保存先を引き継がない（元ファイルへの誤上書き防止）
    syncFileName();
    useApp.getState().loadSample();
    useUI.getState().setOutlineCollapsed(new Set());
    useUI.getState().setWelcomeDismissed(true);
    if (!tourDone()) {
      useUI.getState().setTourStep(0); // 初回だけ使い方ツアーを開始
    } else {
      useUI.getState().toast('サンプルを開きました。表を編集するとフローに反映されます。', 'success');
    }
  };
  const onTemplate = async (key: string) => {
    if (!(await confirmReplace('テンプレートを開く'))) return;
    forgetFileHandle(); // テンプレートに保存先を引き継がない（元ファイルへの誤上書き防止）
    syncFileName();
    useApp.getState().loadTemplate(key);
    useUI.getState().setOutlineCollapsed(new Set());
    useUI.getState().setWelcomeDismissed(true);
    if (!tourDone()) {
      useUI.getState().setTourStep(0); // 初回だけ使い方ツアーを開始
    } else {
      useUI.getState().toast('テンプレートを開きました。自社の業務に合わせて編集してください。', 'success');
    }
  };
  const onOpenRecent = async (name: string) => {
    // Welcome 経由は工程 0 件＝dirty でないので確認は実質ツールバー/パレット経由のみ。
    if (!(await confirmReplace('最近のファイルを開く'))) return;
    try {
      const p = await openRecentFile(name);
      if (p) {
        useApp.getState().loadProject(p);
        useUI.getState().setOutlineCollapsed(new Set());
        useUI.getState().setWelcomeDismissed(true);
        syncFileName();
        useUI.getState().toast('開きました。', 'success');
      } else {
        useUI.getState().toast('このファイルを開けませんでした（権限が必要です）。', 'error');
      }
    } catch (err) {
      // onOpen と同様、版違い・参照整合性のエラーは具体的なメッセージをダイアログで伝える。
      // 「バックアップから復元」を選べば既存の BackupsDialog を開くだけ（復元導線）。
      if (isSchemaVersionTooNewError(err) || isProjectIntegrityError(err)) {
        const restore = await useUI.getState().confirm({
          title: 'ファイルを開けませんでした',
          message: err.message,
          confirmLabel: 'バックアップから復元',
          cancelLabel: '閉じる',
        });
        if (restore) useUI.getState().setOverlay('backups');
      } else {
        useUI.getState().toast('ファイルを開けませんでした。', 'error');
      }
    }
  };
  // 工程 0 件のまま無警告で出力/印刷が成功してしまうのを防ぐ（UX16位以下）。
  // 判定は persistence.isEmptyProjectForOutput（純関数）に任せ、ここでは確認ダイアログの表示だけ。
  const confirmEmptyOutput = async (): Promise<boolean> => {
    if (!isEmptyProjectForOutput(useApp.getState().project)) return true;
    return useUI.getState().confirm({
      message: '工程がありません。空のまま出力しますか？',
      confirmLabel: '出力する',
      cancelLabel: 'キャンセル',
    });
  };
  const onExportExcel = async () => {
    if (!(await confirmEmptyOutput())) return;
    const n = exportExcelFile(useApp.getState().project);
    useUI.getState().toast(`出力しました（${n}）`, 'success');
  };
  const onExportCsv = async () => {
    if (!(await confirmEmptyOutput())) return;
    const n = exportCsvFile(useApp.getState().project);
    useUI.getState().toast(`出力しました（${n}）`, 'success');
  };
  const onExportSvg = async () => {
    if (!(await confirmEmptyOutput())) return;
    const st = useApp.getState();
    const view = findView(st.project, st.level, st.scopeParentId);
    if (view) {
      const name = exportSvgFile(st.project, view);
      useUI.getState().toast(`出力しました（${name}）`, 'success');
    }
  };
  const onExportPng = async () => {
    if (!(await confirmEmptyOutput())) return;
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
  const onPrint = async () => {
    if (!(await confirmEmptyOutput())) return;
    const st = useApp.getState();
    printProjectAndFlow(st.project, findView(st.project, st.level, st.scopeParentId));
  };

  // Welcome から空の編集画面へ（プロジェクトは既に空＝作り直し不要。フラグだけ立てる）。
  // 初回なら、最初の工程を作った瞬間にツアーを提示するため保留フラグを立てる。
  const onStartEmpty = () => {
    useUI.getState().setWelcomeDismissed(true);
    if (!tourDone()) useUI.getState().setTourPendingFirstTask(true);
  };

  // グローバルショートカット(キーマップ駆動)。keymap.ts が単一の真実、
  // ディスパッチは useGlobalHotkeys に一元化(IME・編集中・オーバーレイのガード込み)。
  useGlobalHotkeys({
    onSave: () => void onSave(),
    onPrint,
    onNew: () => void onNew(),
    onOpen: () => void onOpen(),
    onSaveAs: () => void onSaveAs(),
  });

  // タブ/タスクバーでも「どのファイルを編集中か・未保存か」が分かるようにタイトルへ同期。
  useEffect(() => {
    document.title = formatWindowTitle(fileName, dirty);
  }, [fileName, dirty]);

  // 未保存のまま閉じようとしたら確認（データ消失の防止）。フォロワー窓はファイルを持たない
  //（データはリーダーが真実）ので警告しない。
  useEffect(() => {
    if (isFollower) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (useApp.getState().dirty) {
        e.preventDefault();
        e.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [isFollower]);

  // 表示専用ミラー窓（マルチディスプレイ）への発行を開始。project/粒度/スコープ/課題レイヤが
  // 変わるたびデバウンスしてスナップショットを流す（ミラーが接続すれば即応答）。編集は主窓のみ。
  // フォロワー窓は真実でないためミラーへは発行しない（リーダーだけが発行元）。
  useEffect(() => {
    if (isFollower) return;
    return startMirrorPublisher({
      subscribe: (l) => useApp.subscribe(l),
      getState: () => pickMirrorState(useApp.getState()),
    });
  }, [isFollower]);

  // 外部（MCP/AI など別プロセス）のファイル更新をポーリング検知して反映する片方向ライブ同期
  //（Tauri のみ）。未保存(dirty)でないときは自動反映、未保存があるときは破棄確認を挟む。
  // フォロワー窓はファイルを開かない＝外部監視もしない（リーダーが反映すれば同期で届く）。
  useEffect(() => {
    if (isFollower) return;
    startExternalWatch(async (incoming) => {
      if (!useApp.getState().dirty) {
        useApp.getState().reloadFromExternal(incoming);
        acknowledgeExternalChange();
        useUI.getState().toast('外部の変更を反映しました（AI 編集など）。', 'success');
        return;
      }
      const ok = await useUI.getState().confirm({
        title: '外部でファイルが変更されました',
        message:
          '別のプロセス（AI/MCP など）がこのファイルを更新しました。再読込すると、こちらの未保存の変更は失われます。',
        confirmLabel: '再読込する',
        cancelLabel: 'そのまま編集',
      });
      if (ok) useApp.getState().reloadFromExternal(incoming);
      acknowledgeExternalChange(); // 再読込しない場合も同じ変更を二度は問わない
    });
    return () => stopExternalWatch();
  }, [isFollower]);

  // 起動時: 自動退避データがあれば復元を提案（クラッシュ/誤クローズからの復旧）。
  // フォロワー窓は自動退避を持たない（main.tsx で initAutosave を呼ばない）ので提案もしない。
  useEffect(() => {
    if (isFollower) return;
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
        useUI.getState().setWelcomeDismissed(true); // 復元した作業（工程 0 件でも）を Welcome で覆わない
        useUI.getState().toast('前回の未保存データを復元しました。保存をお忘れなく。', 'success');
      } else {
        clearAutosave();
      }
    })();
  }, [isFollower]);

  return (
    <div className={`app${chromeHidden ? ' focus-mode' : ''}`}>
      <a className="skip-link" href="#main-table">
        工程表へスキップ
      </a>
      {chromeHidden && (
        <button
          className="chrome-reveal"
          onClick={toggleChrome}
          aria-label="集中モードを解除（ツールバー・操作バーを表示）"
          title="集中モードを解除（Ctrl/⌘+\）"
        >
          <Icons.ChevronDown />
        </button>
      )}
      <header className="toolbar" role="banner" hidden={chromeHidden}>
        <span className="brand">
          <svg className="brand-mark" width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
            <defs>
              <linearGradient id="brandmark-grad" x1="0" y1="0" x2="1" y2="1">
                <stop offset="0" stopColor="#5271a5" />
                <stop offset="1" stopColor="#3f5a89" />
              </linearGradient>
            </defs>
            <rect className="bg" width="18" height="18" rx="4" fill="url(#brandmark-grad)" />
            <rect className="bar" x="3.5" y="3.8" width="8" height="2.2" rx="1.1" />
            <rect className="bar b2" x="6" y="7.9" width="8.5" height="2.2" rx="1.1" />
            <rect className="bar b3" x="3.5" y="12" width="6" height="2.2" rx="1.1" />
          </svg>
          <span className="brand-name">
            gantt-<span className="brand-accent">flow</span>
          </span>
        </span>
        <span
          className="file-chip"
          title={`${fileName ?? UNTITLED_LABEL}${dirty ? '（未保存の変更あり）' : ''}${
            isFollower ? '（編集用サブウィンドウ）' : ''
          }`}
        >
          {dirty && (
            <span className="file-chip-dot" aria-label="未保存の変更あり">
              ●
            </span>
          )}
          <span className="file-chip-name">{fileName ?? UNTITLED_LABEL}</span>
          {isFollower && (
            <span className="file-chip-sub" role="status">
              · 編集サブ窓{followerWaiting ? '（接続待ち）' : ''}
            </span>
          )}
        </span>
        <PaneLayoutTabs current={paneLayout} />
        <span className="spacer" />

        <span className="tool-group" role="group" aria-label="履歴">
          {/* 編集用サブ窓の undo/redo はリーダーへ転送して適用する（両窓で履歴を共有）。 */}
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

        <span className={`tool-group${recentSupported ? ' has-menu' : ''}`} role="group" aria-label="ファイル">
          <button
            className="icon-btn"
            onClick={onNew}
            disabled={isFollower}
            aria-label="新規"
            title={isFollower ? 'ファイル操作はメインウィンドウで行ってください' : '新規プロジェクト'}
          >
            <Icons.FilePlus />
          </button>
          <button
            className="icon-btn"
            onClick={onImport}
            disabled={isFollower}
            aria-label="取り込み"
            title={isFollower ? 'ファイル操作はメインウィンドウで行ってください' : '取り込み（CSV / Excel）'}
          >
            <Icons.Upload />
          </button>
          <button
            className="icon-btn"
            onClick={onOpen}
            disabled={isFollower}
            aria-label="開く"
            title={isFollower ? 'ファイル操作はメインウィンドウで行ってください' : '開く'}
          >
            <Icons.FolderOpen />
          </button>
          {recentSupported && !isFollower && (
            <Menu
              className="icon-btn menu-trigger"
              title="最近使ったファイル"
              label={<Icons.ChevronDown />}
              onOpen={refreshRecent}
            >
              {recentFiles.length === 0 && (
                <div className="menu-empty">最近使ったファイルはありません</div>
              )}
              {recentFiles.slice(0, 5).map((r) => (
                <MenuItem key={r.name} onClick={() => void onOpenRecent(r.name)}>
                  <span className="recent-row" title={r.name}>
                    <span className="recent-name">{r.name}</span>
                    <span className="recent-at">{formatRecentTime(r.at)}</span>
                  </span>
                </MenuItem>
              ))}
              {/* 誤操作からの回復導線。パニック時に検索語を思い出さずに済むよう、最近ファイルの
                  末尾に常設する（この端末に残る直近世代から復旧＝BackupsDialog を開くだけ）。 */}
              <div className="menu-sep" aria-hidden="true" />
              <MenuItem onClick={() => useUI.getState().setOverlay('backups')}>
                バックアップから復元…
              </MenuItem>
            </Menu>
          )}
          <button
            className={`icon-btn${dirty ? ' has-unsaved' : ''}`}
            onClick={() => onSave()}
            disabled={saving || isFollower}
            aria-label={saving ? '保存中…' : dirty ? '保存（未保存の変更あり）' : '保存'}
            title={isFollower ? 'ファイル操作はメインウィンドウで行ってください' : saving ? '保存中…' : '保存 (Ctrl+S)'}
          >
            {saving ? <span className="icon-spinner" aria-hidden="true" /> : <Icons.Save />}
          </button>
        </span>

        {/* 出力・印刷はファイル系＝リーダー専用（フォロワーでは非表示）。 */}
        {!isFollower && (
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
        )}

        {!isFollower && (
          <button className="icon-btn" onClick={onPrint} aria-label="印刷 / PDF" title="印刷 / PDF（工程表＋フロー図）">
            <Icons.Printer />
          </button>
        )}

        <button
          className="icon-btn"
          onClick={() => useUI.getState().setOverlay('palette')}
          aria-label="コマンド・工程を検索"
          title="コマンド・工程を検索 (⌘K)"
        >
          <Icons.Search />
        </button>

        <span className="tool-group" role="group" aria-label="ビュー">
          {collapseForInspector && (
            <button
              className="icon-btn"
              onClick={() => setActivePane(activePane === 'table' ? 'flow' : 'table')}
              aria-label="工程表とフローを入れ替え"
              title={`${activePane === 'table' ? '工程フロー' : '工程表'}＋詳細に切り替え`}
            >
              <Icons.Swap />
            </button>
          )}
          <button
            className={`icon-btn toggle-btn${showInspector ? ' on' : ''}`}
            onClick={() => {
              const ui = useUI.getState();
              if (showInspector) {
                ui.setInspectorOpen(false);
                return;
              }
              ui.setInspectorOpen(true);
              if (!selectedTaskId) {
                const tasks = Object.values(project.core.tasks);
                const first = tasks.find((t) => t.level === 'large') ?? tasks[0];
                if (first) useApp.getState().select(first.id);
              }
            }}
            aria-pressed={showInspector}
            aria-label="詳細インスペクタの表示切替"
            title={showInspector ? '詳細を閉じる' : '詳細を開く（選択工程の全項目）'}
          >
            <Icons.Columns />
          </button>
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
          {tobeEnabled && (
            <button
              className="icon-btn"
              onClick={() => useUI.getState().setOverlay('comparison')}
              aria-label="改善効果サマリ（As-Is / To-Be 比較）"
              title="改善効果サマリ（As-Is / To-Be 比較） (⌘⇧C)"
            >
              <Icons.Compare />
            </button>
          )}
          <Menu
            className="icon-btn menu-trigger"
            title="別ウィンドウで表示（マルチディスプレイ）"
            label={
              <>
                <Icons.NewWindow />
                <Icons.ChevronDown />
              </>
            }
          >
            <MenuItem onClick={() => openEditWindow()}>
              編集用のサブウィンドウを開く（両窓で同時編集）
            </MenuItem>
            <div className="menu-sep" aria-hidden="true" />
            <MenuItem onClick={() => openMirrorWindow('flow')}>
              フローを別ウィンドウで表示（閲覧専用）
            </MenuItem>
            <MenuItem onClick={() => openMirrorWindow('table')}>
              工程表を別ウィンドウで表示（閲覧専用）
            </MenuItem>
          </Menu>
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
        <button
          className="icon-btn"
          onClick={toggleChrome}
          aria-label="集中モード（ツールバーと各ビューの操作バーを隠す）"
          title="集中モード: 作業エリアを最大化（ツールバー＋各ビューの操作バーを隠す）Ctrl/⌘+\"
        >
          <Icons.Maximize />
        </button>
      </header>
      {showWelcome ? (
        <Welcome
          onSample={onSample}
          onImport={onImport}
          onOpen={onOpen}
          onOpenRecent={onOpenRecent}
          onTemplate={onTemplate}
          onStartEmpty={onStartEmpty}
        />
      ) : mainView === 'procedure' ? (
        <ProcedureView />
      ) : (
        <div
          className={`panes${showInspector ? ' with-inspector' : ''}${
            tableWide || fullMode ? ' table-wide' : ''
          }${flowWide ? ' flow-wide' : ''}`}
        >
          {showTable && (
          <section
            className={`pane table-pane${fullMode ? ' full' : ''}${activePane === 'table' ? ' pane-active' : ''}`}
            id="main-table"
            tabIndex={-1}
            aria-label="工程表（手順一覧表）"
            onPointerDownCapture={() => setActivePane('table')}
          >
            <div className="table-head">
              <h2>
                <span className="pane-dot table" aria-hidden="true" />
                工程表（手順一覧表）
              </h2>
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
          {showFlow && (
            <section
              className={`pane flow-pane${activePane === 'flow' ? ' pane-active' : ''}`}
              tabIndex={-1}
              aria-label="工程フロー図"
              onPointerDownCapture={() => setActivePane('flow')}
            >
              <div className="flow-head">
                <h2>
                  <span className="pane-dot flow" aria-hidden="true" />
                  工程フロー
                </h2>
                {tobeEnabled && (
                  <span className="seg scenario-seg" role="group" aria-label="シナリオ">
                    <button
                      className={scenario === 'asis' ? 'on' : ''}
                      onClick={() => setScenario('asis')}
                      title="現状（As-Is）を表示・編集"
                    >
                      As-Is
                    </button>
                    <button
                      className={scenario === 'tobe' ? 'on' : ''}
                      onClick={() => setScenario('tobe')}
                      title="改善後（To-Be）を読み取り専用で表示。編集はインスペクタの「To-Be」か、比較の一括入力で。"
                    >
                      To-Be
                    </button>
                  </span>
                )}
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
              </div>
              {tobeEnabled && scenario === 'tobe' ? (
                <div className="flow-tobe-ro" role="img" aria-label="To-Be（改善後）の工程フロー（読み取り専用）">
                  <div className="flow-tobe-banner">
                    To-Be（改善後）を表示中 — 読み取り専用。編集はインスペクタの「To-Be」か、比較 › 一括入力で。
                  </div>
                  <div className="flow-tobe-svg" dangerouslySetInnerHTML={{ __html: tobeFlowSvg }} />
                </div>
              ) : (
                <FlowCanvas />
              )}
            </section>
          )}
          {showInspector && (
            <section className="pane inspector-pane">
              <Inspector />
            </section>
          )}
        </div>
      )}
      {!showWelcome && <StatusBar />}
      <CommandPalette
        onNew={onNew}
        onSave={onSave}
        onSaveAs={onSaveAs}
        onOpen={onOpen}
        onOpenRecent={(name) => void onOpenRecent(name)}
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
      <ComparisonDialog />
      <BackupsDialog />
      <SettingsDialog />
      <Tour />
      <Modal />
      <BusyOverlay />
      <Toaster />
      {followerWaiting && (
        <div className="mirror-waiting" role="status" aria-live="polite">
          <div className="mirror-waiting-card">
            <div className="mirror-spin" aria-hidden="true" />
            <p className="mirror-waiting-title">メインウィンドウとの接続を待っています…</p>
            <p className="mirror-waiting-sub">
              編集用サブウィンドウです。メインウィンドウ（工程表を開いた最初の窓）を開いたままにしてください。
              接続すると、この窓でも編集でき、変更は両方の窓に同期されます。
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
