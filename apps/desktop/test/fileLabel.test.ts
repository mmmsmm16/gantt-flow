// ファイル名表示の純粋ロジック（ウィンドウタイトル / 最近使ったファイルの最終使用日）。
import { describe, it, expect } from 'vitest';
import { formatWindowTitle, formatRecentTime, UNTITLED_LABEL } from '../src/fileLabel';

describe('formatWindowTitle', () => {
  it('ファイル名 + 未保存マーカー（●）+ アプリ名', () => {
    expect(formatWindowTitle('営業部_業務フロー.json', false)).toBe('営業部_業務フロー.json - gantt-flow');
    expect(formatWindowTitle('営業部_業務フロー.json', true)).toBe('営業部_業務フロー.json● - gantt-flow');
  });

  it('保存先が未割当のときは「未保存のプロジェクト」', () => {
    expect(formatWindowTitle(null, false)).toBe(`${UNTITLED_LABEL} - gantt-flow`);
    expect(formatWindowTitle(null, true)).toBe(`${UNTITLED_LABEL}● - gantt-flow`);
  });
});

describe('formatRecentTime', () => {
  const now = new Date(2026, 5, 11, 14, 30); // 2026-06-11 14:30

  it('当日は時刻（HH:MM・ゼロ埋め）', () => {
    expect(formatRecentTime(new Date(2026, 5, 11, 9, 5).getTime(), now)).toBe('09:05');
  });

  it('昨日は「昨日」（時刻は不問）', () => {
    expect(formatRecentTime(new Date(2026, 5, 10, 23, 59).getTime(), now)).toBe('昨日');
    expect(formatRecentTime(new Date(2026, 5, 10, 0, 0).getTime(), now)).toBe('昨日');
  });

  it('月初・年初をまたぐ「昨日」も正しく判定する', () => {
    expect(formatRecentTime(new Date(2026, 5, 30, 10, 0).getTime(), new Date(2026, 6, 1, 8, 0))).toBe('昨日');
    expect(formatRecentTime(new Date(2025, 11, 31, 10, 0).getTime(), new Date(2026, 0, 1, 8, 0))).toBe('昨日');
  });

  it('同年は M/D、それ以前は YYYY/M/D', () => {
    expect(formatRecentTime(new Date(2026, 0, 3).getTime(), now)).toBe('1/3');
    expect(formatRecentTime(new Date(2025, 11, 31).getTime(), now)).toBe('2025/12/31');
  });
});
