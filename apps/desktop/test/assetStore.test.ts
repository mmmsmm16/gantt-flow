import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  contentHashName,
  putAsset,
  getAssetBytes,
  getAssetUrl,
  hasAsset,
  snapshotAssets,
  ingestAssets,
  clearAssetStore,
  __resetAssetStoreForTest,
} from '../src/assetStore';

beforeEach(() => __resetAssetStoreForTest());

describe('contentHashName', () => {
  it('同一内容・同一 MIME なら同名（決定論）', () => {
    const a = new Uint8Array([1, 2, 3, 4, 5]);
    const b = new Uint8Array([1, 2, 3, 4, 5]);
    expect(contentHashName(a, 'image/png')).toBe(contentHashName(b, 'image/png'));
  });

  it('内容が違えば別名', () => {
    expect(contentHashName(new Uint8Array([1, 2, 3]), 'image/png')).not.toBe(
      contentHashName(new Uint8Array([1, 2, 4]), 'image/png'),
    );
  });

  it('MIME から安全な拡張子を付ける', () => {
    const bytes = new Uint8Array([9, 9, 9]);
    expect(contentHashName(bytes, 'image/png')).toMatch(/\.png$/);
    expect(contentHashName(bytes, 'image/jpeg')).toMatch(/\.jpg$/);
    expect(contentHashName(bytes, 'image/webp')).toMatch(/\.webp$/);
    expect(contentHashName(bytes, 'application/x-evil')).toMatch(/\.bin$/);
  });

  // migration-safety 要求2: 実ディスク展開に備え、名前は安全な文字のみで構成する。
  it('出力は [0-9a-z] の hex とドット付き拡張子のみ（path traversal 不能）', () => {
    const samples: [Uint8Array, string][] = [
      [new Uint8Array([0, 255, 128]), 'image/png'],
      [new Uint8Array(0), 'image/gif'],
      [new Uint8Array([1]), 'image/svg+xml'],
      [new Uint8Array([200, 100, 50, 25]), 'image/jpeg; charset=binary'],
    ];
    for (const [bytes, mime] of samples) {
      const name = contentHashName(bytes, mime);
      expect(name).toMatch(/^[0-9a-f]{16}\.[a-z0-9]+$/);
      expect(name).not.toContain('/');
      expect(name).not.toContain('..');
    }
  });
});

describe('put/get/has/snapshot/ingest', () => {
  it('put→get で同じバイト列', () => {
    const bytes = new Uint8Array([10, 20, 30]);
    putAsset('a.png', bytes);
    expect(getAssetBytes('a.png')).toBe(bytes);
    expect(hasAsset('a.png')).toBe(true);
    expect(hasAsset('missing.png')).toBe(false);
  });

  it('put は冪等（既存名は上書きしない＝重複共有）', () => {
    const first = new Uint8Array([1]);
    putAsset('x.png', first);
    putAsset('x.png', new Uint8Array([2])); // 同名は無視
    expect(getAssetBytes('x.png')).toBe(first);
  });

  it('snapshotAssets は参照分だけ抽出（存在しない名は無視）', () => {
    putAsset('a.png', new Uint8Array([1]));
    putAsset('b.png', new Uint8Array([2]));
    putAsset('c.png', new Uint8Array([3]));
    const snap = snapshotAssets(new Set(['a.png', 'c.png', 'nope.png']));
    expect(Object.keys(snap).sort()).toEqual(['a.png', 'c.png']);
  });

  it('ingestAssets は読み込んだ分を一括投入する', () => {
    ingestAssets({ 'p.png': new Uint8Array([7]), 'q.png': new Uint8Array([8]) });
    expect(getAssetBytes('p.png')).toEqual(new Uint8Array([7]));
    expect(getAssetBytes('q.png')).toEqual(new Uint8Array([8]));
  });
});

// レビュー指摘: プロジェクト切替（newProject/loadSample/loadTemplate/loadProject/restoreProject）で
// 前プロジェクトの画像がメモリに積み上がらないよう、store.ts から呼ぶクリア関数。
describe('clearAssetStore', () => {
  it('put → URL 生成 → clear で Map が空になり blob URL も revoke される（再 put は新規 URL）', () => {
    const revokeSpy = vi.spyOn(URL, 'revokeObjectURL');
    const bytes = new Uint8Array([1, 2, 3]);
    putAsset('clear.png', bytes);
    const url1 = getAssetUrl('clear.png');
    expect(url1).toBeTruthy();
    expect(hasAsset('clear.png')).toBe(true);

    clearAssetStore();

    expect(revokeSpy).toHaveBeenCalledWith(url1);
    expect(hasAsset('clear.png')).toBe(false);
    expect(getAssetBytes('clear.png')).toBeUndefined();

    // 再度同じ内容を put すれば通常どおり格納・URL 生成できる（キャッシュが生きたままでない）。
    putAsset('clear.png', bytes);
    const url2 = getAssetUrl('clear.png');
    expect(hasAsset('clear.png')).toBe(true);
    expect(url2).toBeTruthy();
    expect(url2).not.toBe(url1); // 古い URL はもう有効ではない前提の新規発行

    revokeSpy.mockRestore();
  });
});
