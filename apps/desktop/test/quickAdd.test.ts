// 工程クイック追加 DSL のパーサ。トークンの順不同・全省略・空白入りの名前・
// 前工程の不一致など、ヒアリング高速入力で踏む形を固定する。
import { describe, it, expect } from 'vitest';
import { parseQuickAdd, type QuickAddContext } from '../src/quickAdd';

const ctx: QuickAddContext = {
  assigneeNames: ['営業部', '経理'],
  predecessors: [
    { id: 't1', name: '受注登録', code: '1' },
    { id: 't2', name: '与信確認', code: '2' },
  ],
};

describe('parseQuickAdd', () => {
  it('フル指定（受注確認 @営業 #小 2h >受注登録）を解釈する', () => {
    const r = parseQuickAdd('受注確認 @営業 #小 2h >受注登録', ctx);
    expect(r.name).toBe('受注確認');
    expect(r.assignee).toEqual({ name: '営業部', isNew: false }); // 部分一致で既存へ解決
    expect(r.level).toBe('small');
    expect(r.effortHours).toBe(2);
    expect(r.predecessor?.matched?.id).toBe('t1');
  });

  it('トークンは順不同で同じ結果になる', () => {
    const r = parseQuickAdd('>受注 0.5h #詳細 @経理 受注確認', ctx);
    expect(r.name).toBe('受注確認');
    expect(r.assignee).toEqual({ name: '経理', isNew: false });
    expect(r.level).toBe('detail');
    expect(r.effortHours).toBe(0.5);
    expect(r.predecessor?.matched?.id).toBe('t1'); // 名称の部分一致
  });

  it('全省略は名前だけ / 空・空白のみは無題（name=\'\'）', () => {
    expect(parseQuickAdd('受注確認', ctx)).toEqual({ name: '受注確認' });
    expect(parseQuickAdd('', ctx)).toEqual({ name: '' });
    expect(parseQuickAdd('   ', ctx)).toEqual({ name: '' });
  });

  it('トークン以外の残りは空白 1 つで連結＝名前に空白を含められる', () => {
    const r = parseQuickAdd('見積 @営業部 作成', ctx);
    expect(r.name).toBe('見積 作成');
    expect(r.assignee).toEqual({ name: '営業部', isNew: false });
  });

  it('一致しない前工程は matched なし（依存は張らずチップで知らせる）', () => {
    const r = parseQuickAdd('入金 >存在しない工程', ctx);
    expect(r.predecessor?.input).toBe('存在しない工程');
    expect(r.predecessor?.matched).toBeUndefined();
  });

  it('前工程は工程コードの完全一致でも引ける', () => {
    expect(parseQuickAdd('>2', ctx).predecessor?.matched?.id).toBe('t2');
  });

  it('既存に一致しない担当は新規（isNew=true）', () => {
    expect(parseQuickAdd('@製造', ctx).assignee).toEqual({ name: '製造', isNew: true });
  });

  it('工数は 数値+h / 数値+時間（大文字 H・小数も可）', () => {
    expect(parseQuickAdd('組立 2時間', ctx).effortHours).toBe(2);
    expect(parseQuickAdd('組立 1.5H', ctx).effortHours).toBe(1.5);
  });

  it('未知の #タグ は粒度ではなく名前の一部として残す', () => {
    const r = parseQuickAdd('#特急 出荷', ctx);
    expect(r.name).toBe('#特急 出荷');
    expect(r.level).toBeUndefined();
  });

  it('「@」「>」だけ（入力途中）のトークンは無視され名前にも混ざらない', () => {
    expect(parseQuickAdd('出荷 @ >', ctx)).toEqual({ name: '出荷' });
  });

  it('同種トークンが複数なら後勝ち', () => {
    expect(parseQuickAdd('@営業 @経理 x', ctx).assignee?.name).toBe('経理');
    expect(parseQuickAdd('#大 #小 x', ctx).level).toBe('small');
  });
});
