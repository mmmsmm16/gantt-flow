// パレットの自由入力コマンド共通形（textArgCommand / detailTextCommand）と、
// クイック追加 DSL（add-task）・直前コマンドのリピート（mod+. / もう一度行）。
import { describe, it, expect, beforeEach } from 'vitest';
import { useApp } from '../src/store';
import {
  textArgCommand,
  detailTextCommand,
  renameTaskCommand,
  addTaskQuickCommand,
  improvementReportCommands,
} from '../src/ui/CommandPalette';
import {
  recordLastCommand,
  getLastCommand,
  repeatLastCommand,
  clearLastCommand,
  formatRepeatDisplay,
} from '../src/ui/lastCommand';

const selectFirstTask = (): string => {
  useApp.getState().addTask('受付');
  const id = Object.values(useApp.getState().project.core.tasks)[0]!.id;
  useApp.getState().select(id);
  return id;
};

beforeEach(() => {
  useApp.getState().newProject();
});

describe('textArgCommand', () => {
  it('入力を trim してから write へ渡す（工程名の前後空白を保存しない）', () => {
    selectFirstTask();
    let got: string | null = null;
    const cmd = textArgCommand({
      id: 'x',
      label: 'x',
      keywords: '',
      placeholder: '',
      available: true,
      read: () => '',
      write: (_tid, v) => {
        got = v;
      },
    });
    cmd.runWithArg?.('  受注処理  ');
    expect(got).toBe('受注処理');
  });

  it('未選択のときは read/write とも呼ばれない', () => {
    let called = false;
    const cmd = textArgCommand({
      id: 'x',
      label: 'x',
      keywords: '',
      placeholder: '',
      available: false,
      read: () => {
        called = true;
        return '';
      },
      write: () => {
        called = true;
      },
    });
    expect(cmd.arg?.defaultValue?.()).toBe('');
    cmd.runWithArg?.('値');
    expect(called).toBe(false);
  });
});

describe('renameTaskCommand（工程名を変更…）', () => {
  it('trim した値で改名し、現在の名前を defaultValue で読み出せる', () => {
    const id = selectFirstTask();
    const cmd = renameTaskCommand(true);
    cmd.runWithArg?.('  受注登録  ');
    expect(useApp.getState().project.core.tasks[id]?.name).toBe('受注登録');
    expect(cmd.arg?.defaultValue?.()).toBe('受注登録');
  });

  it('空白のみの入力は no-op（名前を空にしない）', () => {
    const id = selectFirstTask();
    const cmd = renameTaskCommand(true);
    cmd.runWithArg?.('   ');
    expect(useApp.getState().project.core.tasks[id]?.name).toBe('受付');
  });
});

describe('addTaskQuickCommand（工程クイック追加 DSL）', () => {
  const orderedNames = () =>
    Object.values(useApp.getState().project.core.tasks)
      .sort((x, y) => x.order - y.order)
      .map((t) => t.name);

  it('担当・工数・前工程を合成して 1 undo 単位で作成し、新工程を選択する', () => {
    const baseId = selectFirstTask(); // 「受付」(medium)
    addTaskQuickCommand(true).runWithArg?.('受注確認 @営業 2h >受付');

    const s = useApp.getState();
    const created = Object.values(s.project.core.tasks).find((t) => t.name === '受注確認')!;
    expect(created).toBeDefined();
    expect(created.level).toBe('medium'); // 粒度未指定＝選択工程と同じ
    expect(s.selectedTaskId).toBe(created.id);
    expect(s.project.core.assignees[created.assigneeId!]?.name).toBe('営業'); // 既存なし→新規作成
    expect(s.project.details[created.id]?.effortMinutes).toBe(120);
    const deps = Object.values(s.project.core.dependencies);
    expect(deps).toHaveLength(1);
    expect(deps[0]).toMatchObject({ from: baseId, to: created.id });

    // 作成＋担当＋工数＋依存が 1 回の undo でまとめて戻る
    useApp.getState().undo();
    const after = useApp.getState().project;
    expect(Object.values(after.core.tasks)).toHaveLength(1);
    expect(Object.values(after.core.dependencies)).toHaveLength(0);
    expect(Object.values(after.core.assignees)).toHaveLength(0);
  });

  it('選択中の工程の直下（次の兄弟）に挿入する', () => {
    useApp.getState().addTask('A');
    useApp.getState().addTask('B');
    const a = Object.values(useApp.getState().project.core.tasks).find((t) => t.name === 'A')!;
    useApp.getState().select(a.id);
    addTaskQuickCommand(true).runWithArg?.('C');
    expect(orderedNames()).toEqual(['A', 'C', 'B']);
  });

  it('#粒度 の指定が選択工程の粒度より優先され、未選択時の既定は表示粒度', () => {
    addTaskQuickCommand(false).runWithArg?.('準備'); // 未選択 → 表示粒度(medium)
    expect(
      Object.values(useApp.getState().project.core.tasks).find((t) => t.name === '準備')?.level,
    ).toBe('medium');
    addTaskQuickCommand(true).runWithArg?.('手順確認 #詳細'); // 選択(medium)より # を優先
    expect(
      Object.values(useApp.getState().project.core.tasks).find((t) => t.name === '手順確認')?.level,
    ).toBe('detail');
  });

  it('空欄の確定は無題で 1 件追加（旧・無引数コマンドの代替）', () => {
    selectFirstTask();
    addTaskQuickCommand(true).runWithArg?.('');
    const s = useApp.getState();
    const created = Object.values(s.project.core.tasks).find((t) => t.name === '');
    expect(created).toBeDefined();
    expect(s.selectedTaskId).toBe(created!.id);
  });

  it('一致しない前工程では依存を作らない（作成自体は成功する）', () => {
    selectFirstTask();
    addTaskQuickCommand(true).runWithArg?.('出荷 >存在しない名前');
    const s = useApp.getState();
    expect(Object.values(s.project.core.tasks).some((t) => t.name === '出荷')).toBe(true);
    expect(Object.values(s.project.core.dependencies)).toHaveLength(0);
  });

  it('マイルストーンは前工程候補から除外される（同名指定でも依存を作らない）', () => {
    selectFirstTask(); // 「受付」(medium) を選択→同じ粒度・親でマイルストーンを追加
    const msId = useApp.getState().addMilestone();
    expect(useApp.getState().project.core.tasks[msId!]?.kind).toBe('milestone');
    addTaskQuickCommand(true).runWithArg?.('出荷 >新規マイルストーン');
    const s = useApp.getState();
    expect(Object.values(s.project.core.tasks).some((t) => t.name === '出荷')).toBe(true);
    // MS は前工程候補に出ないため名前が一致しても解決されず、依存は作られない（無言の無視を防ぐ）。
    expect(Object.values(s.project.core.dependencies)).toHaveLength(0);
  });
});

describe('直前コマンドのリピート（mod+. / もう一度行）', () => {
  beforeEach(() => clearLastCommand());

  it('未記録は no-op(false)。記録後は再実行できる', () => {
    expect(repeatLastCommand()).toBe(false);
    let n = 0;
    recordLastCommand({
      id: 'arg-assignee',
      display: '担当を設定 "営業"',
      run: () => {
        n += 1;
      },
    });
    expect(getLastCommand()?.display).toBe('担当を設定 "営業"');
    expect(repeatLastCommand()).toBe(true);
    expect(n).toBe(1);
  });

  it('選択を移してから再実行すると「いま選択中の工程」へ同じ引数が適用される', () => {
    useApp.getState().addTask('受付');
    useApp.getState().addTask('出荷');
    const [t1, t2] = Object.values(useApp.getState().project.core.tasks).sort(
      (x, y) => x.order - y.order,
    );
    useApp.getState().select(t1!.id);
    // パレットの commitArg が記録するのと同じ形: 実行時に getState を読むクロージャ
    recordLastCommand({
      id: 'arg-assignee',
      display: '担当を設定 "営業"',
      run: () => {
        const s = useApp.getState();
        if (s.selectedTaskId) s.setAssigneeByName(s.selectedTaskId, '営業');
      },
    });
    repeatLastCommand();
    useApp.getState().select(t2!.id);
    repeatLastCommand();
    const s = useApp.getState();
    const nameOf = (id?: string) => (id ? s.project.core.assignees[id]?.name : undefined);
    expect(nameOf(s.project.core.tasks[t1!.id]?.assigneeId)).toBe('営業');
    expect(nameOf(s.project.core.tasks[t2!.id]?.assigneeId)).toBe('営業');
  });

  it('プロジェクト境界（新規/開く＝adopt）で記録は破棄される（前プロジェクトの工程 id を持ち越さない）', () => {
    recordLastCommand({ id: 'arg-pred', display: '前工程を設定 "受付"', run: () => {} });
    expect(getLastCommand()).not.toBeNull();
    useApp.getState().newProject();
    expect(getLastCommand()).toBeNull();
    expect(repeatLastCommand()).toBe(false);
  });

  it('formatRepeatDisplay は末尾の … を外し、引数は候補ラベル優先で引用表示', () => {
    expect(formatRepeatDisplay('担当を設定…', '営業')).toBe('担当を設定 "営業"');
    expect(formatRepeatDisplay('粒度を変更…', 'small', '小工程')).toBe('粒度を変更 "小工程"');
    expect(formatRepeatDisplay('選択中の工程を複製')).toBe('選択中の工程を複製');
    expect(formatRepeatDisplay('担当を設定…', '   ')).toBe('担当を設定'); // 空欄(解除)は引数表示なし
  });
});

describe('improvementReportCommands（改善効果レポート出力）', () => {
  const handlers = { onExportImprovementReport: () => {}, onExportImprovementExcel: () => {} };

  it('HTML / Excel の 2 コマンドを返し、available は tobeEnabled に従う', () => {
    const on = improvementReportCommands(handlers, true);
    expect(on.map((c) => c.id)).toEqual(['export-improvement-report', 'export-improvement-excel']);
    expect(on.every((c) => c.available === true)).toBe(true);

    const off = improvementReportCommands(handlers, false);
    expect(off.every((c) => c.available === false)).toBe(true);
  });

  it('run は対応する出力ハンドラを呼ぶ', () => {
    let html = 0;
    let excel = 0;
    const cmds = improvementReportCommands(
      { onExportImprovementReport: () => (html += 1), onExportImprovementExcel: () => (excel += 1) },
      true,
    );
    cmds.find((c) => c.id === 'export-improvement-report')!.run!();
    cmds.find((c) => c.id === 'export-improvement-excel')!.run!();
    expect(html).toBe(1);
    expect(excel).toBe(1);
  });
});

describe('detailTextCommand（備考/業務内容/使用システム）', () => {
  it('trim して保存し、現在値を defaultValue で読み出せる', () => {
    const id = selectFirstTask();
    const cmd = detailTextCommand('arg-note', 'note', '備考を設定…', '', '備考', true);
    cmd.runWithArg?.('  メモ  ');
    expect(useApp.getState().project.details[id]?.note).toBe('メモ');
    expect(cmd.arg?.defaultValue?.()).toBe('メモ');
  });

  it('空欄（空白のみ含む）は解除＝undefined', () => {
    const id = selectFirstTask();
    const cmd = detailTextCommand('arg-how', 'how', '業務内容を設定…', '', '業務内容', true);
    cmd.runWithArg?.('手順');
    expect(useApp.getState().project.details[id]?.how).toBe('手順');
    cmd.runWithArg?.('   ');
    expect(useApp.getState().project.details[id]?.how).toBeUndefined();
  });
});
