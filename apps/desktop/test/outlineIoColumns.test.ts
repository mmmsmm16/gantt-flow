import { describe, it, expect } from 'vitest';
import { outlineIoItems, outlineIssueItems } from '../src/TableView';
import type { TaskDetail } from '@gantt-flow/core';

// 実機FB: アウトラインの「入/出・課題」1列を「入出」「課題」の2列へ分離。
// 各セルのポップオーバーが並べる項目の契約（順序・使うフィールド）を固定する。
const detail = (partial: Partial<TaskDetail>): TaskDetail => ({ taskId: 't1', ...partial });

describe('アウトラインの入出/課題ポップオーバー項目', () => {
  it('入出は入力→出力の順で id/name/io を並べる（Inspector の該当 I/O へ寄せる手掛かり）', () => {
    const d = detail({
      inputs: [
        { id: 'i1', name: '申請書', kind: 'doc' },
        { id: 'i2', name: '受付簿', kind: 'doc' },
      ],
      outputs: [{ id: 'o1', name: '受理通知', kind: 'doc' }],
    });
    expect(outlineIoItems(d)).toEqual([
      { id: 'i1', name: '申請書', io: 'inputs' },
      { id: 'i2', name: '受付簿', io: 'inputs' },
      { id: 'o1', name: '受理通知', io: 'outputs' },
    ]);
  });

  it('入出力なしは空配列（セルは「—」表示・ポップオーバーを出さない）', () => {
    expect(outlineIoItems(undefined)).toEqual([]);
    expect(outlineIoItems(detail({}))).toEqual([]);
  });

  it('課題は課題文(issue)だけを id 付きで並べる（方策 measure はここには出さない）', () => {
    const d = detail({
      issues: [
        { id: 's1', issue: '手戻りが多い', measure: 'チェックリスト化' },
        { id: 's2', issue: '属人化' },
      ],
    });
    expect(outlineIssueItems(d)).toEqual([
      { id: 's1', text: '手戻りが多い' },
      { id: 's2', text: '属人化' },
    ]);
  });

  it('課題なしは空配列（セルは「—」表示）', () => {
    expect(outlineIssueItems(undefined)).toEqual([]);
    expect(outlineIssueItems(detail({}))).toEqual([]);
  });
});
