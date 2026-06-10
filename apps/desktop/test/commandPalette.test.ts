// パレットの自由入力コマンド共通形（textArgCommand / detailTextCommand）。
// trim と「空欄=解除」の規約が 1 箇所に集約されていることを検証する。
import { describe, it, expect, beforeEach } from 'vitest';
import { useApp } from '../src/store';
import { textArgCommand, detailTextCommand } from '../src/ui/CommandPalette';

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
