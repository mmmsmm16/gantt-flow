// クリップボード貼り付けの列マッピング（pasteParse）の検証。
// 重点: 見出し誤検出でデータ行を落とさないこと・工数セルの各表記・位置マッピング互換。
import { describe, expect, it } from 'vitest';
import { parsePastedRows, parseEffortCell } from '../src/pasteParse';

describe('parseEffortCell', () => {
  it('時間表記・数値のみ・分表記を分へ換算', () => {
    expect(parseEffortCell('2h')).toBe(120);
    expect(parseEffortCell('2時間')).toBe(120);
    expect(parseEffortCell('0.5')).toBe(30); // 数値のみ＝時間
    expect(parseEffortCell('1.5H')).toBe(90);
    expect(parseEffortCell('90分')).toBe(90);
    expect(parseEffortCell('120min')).toBe(120);
  });
  it('空・非数・負値は undefined', () => {
    expect(parseEffortCell('')).toBeUndefined();
    expect(parseEffortCell('約2')).toBeUndefined();
    expect(parseEffortCell('-1')).toBeUndefined();
    expect(parseEffortCell('未定')).toBeUndefined();
  });
});

describe('parsePastedRows: 見出しあり', () => {
  it('見出し行（作業名/担当/工数）を判定して列を対応付け、データを [name, assignee, effortMin] へ正規化', () => {
    const text = ['作業名\t担当\t工数', '受注確認\t営業\t2h', '出荷\t物流\t30分'].join('\n');
    const res = parsePastedRows(text);
    expect(res.hadHeader).toBe(true);
    expect(res.rows).toEqual([
      ['受注確認', '営業', '120'],
      ['出荷', '物流', '30'],
    ]);
  });

  it('列順が違っても見出し名で対応付ける（担当が先頭でも名前列を正しく拾う）', () => {
    const text = ['担当\t工数\t作業名', '営業\t1時間\t受注登録'].join('\n');
    const res = parsePastedRows(text);
    expect(res.hadHeader).toBe(true);
    expect(res.columns).toMatchObject({ assignee: 0, effort: 1, name: 2 });
    expect(res.rows).toEqual([['受注登録', '営業', '60']]);
  });
});

describe('parsePastedRows: 見出し誤検出の回避（データ保全）', () => {
  it('作業名に「工程」を含む実データを見出しと誤判定して落とさない', () => {
    // 先頭行が「受注工程」など name 語を含んでも、担当/工数の構造見出しが無ければ見出し扱いしない。
    const text = ['受注工程\t営業', '出荷工程\t物流'].join('\n');
    const res = parsePastedRows(text);
    expect(res.hadHeader).toBe(false);
    expect(res.rows).toEqual([
      ['受注工程', '営業', ''],
      ['出荷工程', '物流', ''],
    ]);
  });
});

describe('parsePastedRows: 見出し無し（位置マッピング）', () => {
  it('従来どおり 0=名前・1=担当、加えて 2=工数を取り込む', () => {
    const text = ['受注確認\t営業\t2h', '梱包\t\t45分'].join('\n');
    const res = parsePastedRows(text);
    expect(res.hadHeader).toBe(false);
    expect(res.rows).toEqual([
      ['受注確認', '営業', '120'],
      ['梱包', '', '45'],
    ]);
  });

  it('空名の行は捨て、末尾の空行も無視する', () => {
    const text = ['\t営業', '受注\t営業', '\t\t', ''].join('\n');
    const res = parsePastedRows(text);
    expect(res.rows).toEqual([['受注', '営業', '']]);
  });

  it('空文字は空の結果', () => {
    expect(parsePastedRows('')).toEqual({ rows: [], hadHeader: false, columns: {} });
  });
});
