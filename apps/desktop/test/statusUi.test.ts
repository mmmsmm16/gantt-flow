import { describe, it, expect } from 'vitest';
import type { TaskDetail } from '@gantt-flow/core';
import { STATUS_OPTIONS, STATUS_LABEL, STATUS_ORDER, statusSelectClass, hearingNodeClass } from '../src/statusUi';

const detail = (partial: Partial<TaskDetail>): TaskDetail => ({ taskId: 't1', ...partial });

describe('statusUi: 状況ラベルの一元化', () => {
  it('STATUS_OPTIONS は先頭が未設定(—)＋todo/heard/review/done の順', () => {
    expect(STATUS_OPTIONS.map((s) => s.key)).toEqual(['', 'todo', 'heard', 'review', 'done']);
    expect(STATUS_OPTIONS.map((s) => s.label)).toEqual(['—', '未着手', 'ヒアリング済', '確認待ち', '確定']);
  });

  it('STATUS_LABEL は既存表記（聴取済/確認中は使わない）', () => {
    expect(STATUS_LABEL).toEqual({ todo: '未着手', heard: 'ヒアリング済', review: '確認待ち', done: '確定' });
    expect(STATUS_ORDER).toEqual(['todo', 'heard', 'review', 'done']);
  });
});

describe('statusUi: statusSelectClass（見た目は raw の status で決める）', () => {
  it('未設定は st-none で中立色', () => {
    expect(statusSelectClass(undefined)).toBe('st-none');
    expect(statusSelectClass(detail({}))).toBe('st-none');
  });
  it('各 status はそのまま st-* に', () => {
    expect(statusSelectClass(detail({ status: 'todo' }))).toBe('st-todo');
    expect(statusSelectClass(detail({ status: 'heard' }))).toBe('st-heard');
    expect(statusSelectClass(detail({ status: 'review' }))).toBe('st-review');
    expect(statusSelectClass(detail({ status: 'done' }))).toBe('st-done');
  });
});

describe('statusUi: hearingNodeClass（未ヒアリングだけ点線）', () => {
  it('未設定・todo は st-unheard（effectiveStatus で todo に寄る）', () => {
    expect(hearingNodeClass(undefined)).toBe(' st-unheard');
    expect(hearingNodeClass(detail({}))).toBe(' st-unheard');
    expect(hearingNodeClass(detail({ status: 'todo' }))).toBe(' st-unheard');
  });
  it('heard/review/done は空文字（実線のまま）', () => {
    expect(hearingNodeClass(detail({ status: 'heard' }))).toBe('');
    expect(hearingNodeClass(detail({ status: 'review' }))).toBe('');
    expect(hearingNodeClass(detail({ status: 'done' }))).toBe('');
  });
});
