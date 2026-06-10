// persistence の保存/開く（Tauri バックエンド・競合検知・助言ロック）と CSV 読み込みのテスト。
// Tauri 環境は window.__TAURI__.core.invoke をモックして再現する（node 環境のため DOM 依存の
// エクスポート系: exportPngFile 等はここでは対象外）。
import { describe, it, expect, afterEach } from 'vitest';
import { createSampleProject, serializeProject, type LockInfo } from '@gantt-flow/core';
import {
  saveProjectToFile,
  openProjectFromFile,
  forgetFileHandle,
  readTableFile,
  localDateYmd,
} from '../src/persistence';

const gen = (prefix: string) => {
  let n = 0;
  return () => `${prefix}-${++n}`;
};

type Handler = (args: Record<string, unknown>) => unknown;

// window.__TAURI__ のモックを張る。テスト後は forgetFileHandle() → removeTauri() の順で片付ける。
function installTauri(handlers: Record<string, Handler>): { cmd: string; args: Record<string, unknown> }[] {
  const calls: { cmd: string; args: Record<string, unknown> }[] = [];
  (globalThis as { window?: unknown }).window = {
    __TAURI__: {
      core: {
        invoke: (cmd: string, args: Record<string, unknown> = {}) => {
          calls.push({ cmd, args });
          const h = handlers[cmd];
          if (!h) return Promise.reject(`コマンド未モック: ${cmd}`);
          try {
            return Promise.resolve(h(args));
          } catch (e) {
            return Promise.reject(e);
          }
        },
      },
    },
  };
  return calls;
}

afterEach(async () => {
  forgetFileHandle(); // 覚えたパス/ロック/ハートビートを片付ける（window が残っているうちに）
  await Promise.resolve(); // releaseHeldLock の invoke を流す
  delete (globalThis as { window?: unknown }).window;
});

describe('saveProjectToFile（Tauri: アトミック保存＋競合検知）', () => {
  it('保存→他者が変更→conflict、force で上書きできる', async () => {
    let mtime = '100';
    const saved: string[] = [];
    installTauri({
      pick_save_path: () => '/tmp/プロジェクト.json',
      save_project: (a) => {
        saved.push(a['contents'] as string);
        mtime = String(Number(mtime) + 1);
        return null;
      },
      stat_updated_at: () => mtime,
      acquire_lock: () => ({ ok: true }),
      release_lock: () => null,
    });
    const p = createSampleProject(gen('s1'));

    const r1 = await saveProjectToFile(p);
    expect(r1).toEqual({ kind: 'saved', name: 'プロジェクト.json' });
    expect(saved).toHaveLength(1);
    expect(saved[0]).toBe(serializeProject(p));

    // 2 回目: 変更なし → そのまま上書きできる
    const r2 = await saveProjectToFile(p);
    expect(r2.kind).toBe('saved');
    expect(saved).toHaveLength(2);

    // 他者がディスク上のファイルを更新 → conflict（書き込まない）
    mtime = '99999';
    const r3 = await saveProjectToFile(p);
    expect(r3).toEqual({ kind: 'conflict' });
    expect(saved).toHaveLength(2);

    // force で上書き
    const r4 = await saveProjectToFile(p, { force: true });
    expect(r4.kind).toBe('saved');
    expect(saved).toHaveLength(3);
  });

  it('保存ダイアログのキャンセルは cancelled（書き込まない）', async () => {
    const calls = installTauri({ pick_save_path: () => null });
    const r = await saveProjectToFile(createSampleProject(gen('s2')));
    expect(r).toEqual({ kind: 'cancelled' });
    expect(calls.some((c) => c.cmd === 'save_project')).toBe(false);
  });

  it('save_project の失敗は throw（成功と紛れない）', async () => {
    installTauri({
      pick_save_path: () => '/tmp/p.json',
      stat_updated_at: () => '1',
      save_project: () => {
        throw 'ディスクに書き込めません';
      },
    });
    await expect(saveProjectToFile(createSampleProject(gen('s3')))).rejects.toBe('ディスクに書き込めません');
  });
});

describe('openProjectFromFile（Tauri: 助言ロック）', () => {
  const heldByOther: LockInfo = {
    user: '別のユーザー',
    host: 'PC-02',
    sessionId: 'other-session',
    openedAt: 1,
    heartbeatAt: 2,
    appVersion: '0.0.0',
  };

  it('ロックが取れたらそのまま開き、mtime を記録して以後の保存で競合検知できる', async () => {
    const sample = createSampleProject(gen('o1'));
    let mtime = '500';
    const saved: string[] = [];
    installTauri({
      pick_open_path: () => '/tmp/open.json',
      stat_updated_at: () => mtime,
      open_project: () => serializeProject(sample),
      acquire_lock: () => ({ ok: true }),
      release_lock: () => null,
      save_project: (a) => {
        saved.push(a['contents'] as string);
        return null;
      },
      pick_save_path: () => {
        throw new Error('開いたファイルがあるのにピッカーが出た');
      },
    });
    const p = await openProjectFromFile();
    expect(p?.meta.id).toBe(sample.meta.id);

    // 開いた後に他者が変更 → 保存は conflict
    mtime = '501';
    const r = await saveProjectToFile(sample);
    expect(r).toEqual({ kind: 'conflict' });
    expect(saved).toHaveLength(0);
  });

  it('他セッションが編集中（stale でない）→ cancel なら開かない', async () => {
    const sample = createSampleProject(gen('o2'));
    const calls = installTauri({
      pick_open_path: () => '/tmp/locked.json',
      stat_updated_at: () => '1',
      open_project: () => serializeProject(sample),
      acquire_lock: () => ({ ok: false, held: heldByOther, stale: false }),
    });
    const seen: { stale: boolean }[] = [];
    const p = await openProjectFromFile({
      confirmLock: (held, stale) => {
        expect(held.user).toBe('別のユーザー');
        seen.push({ stale });
        return Promise.resolve('cancel');
      },
    });
    expect(p).toBeNull();
    expect(seen).toEqual([{ stale: false }]);
    expect(calls.some((c) => c.cmd === 'steal_lock')).toBe(false);
  });

  it('proceed ならロック無しで開ける（保存時の競合検知が安全網）', async () => {
    const sample = createSampleProject(gen('o3'));
    installTauri({
      pick_open_path: () => '/tmp/locked.json',
      stat_updated_at: () => '1',
      open_project: () => serializeProject(sample),
      acquire_lock: () => ({ ok: false, held: heldByOther, stale: false }),
    });
    const p = await openProjectFromFile({ confirmLock: () => Promise.resolve('proceed') });
    expect(p?.meta.id).toBe(sample.meta.id);
  });

  it('stale ロックは takeover で引き継いで開ける（expected には held を渡す）', async () => {
    const sample = createSampleProject(gen('o4'));
    const calls = installTauri({
      pick_open_path: () => '/tmp/stale.json',
      stat_updated_at: () => '1',
      open_project: () => serializeProject(sample),
      acquire_lock: () => ({ ok: false, held: heldByOther, stale: true }),
      steal_lock: (a) => {
        expect(a['expected']).toEqual(heldByOther);
        return true;
      },
      refresh_lock: () => null,
      release_lock: () => null,
    });
    const p = await openProjectFromFile({
      confirmLock: (_held, stale) => Promise.resolve(stale ? 'takeover' : 'cancel'),
    });
    expect(p?.meta.id).toBe(sample.meta.id);
    expect(calls.some((c) => c.cmd === 'steal_lock')).toBe(true);
  });
});

describe('saveProjectToFile（ブラウザ: File System Access）', () => {
  it('上書き書き込みの失敗は throw する（ダウンロード成功に化けない）', async () => {
    (globalThis as { window?: unknown }).window = {
      showSaveFilePicker: () =>
        Promise.resolve({
          name: 'p.json',
          createWritable: () => Promise.reject(new DOMException('権限がありません', 'NotAllowedError')),
        }),
    };
    await expect(saveProjectToFile(createSampleProject(gen('b1')))).rejects.toMatchObject({
      name: 'NotAllowedError',
    });
  });

  it('ピッカーのキャンセルは cancelled', async () => {
    (globalThis as { window?: unknown }).window = {
      showSaveFilePicker: () => Promise.reject(new DOMException('cancel', 'AbortError')),
    };
    const r = await saveProjectToFile(createSampleProject(gen('b2')));
    expect(r).toEqual({ kind: 'cancelled' });
  });
});

describe('readTableFile（CSV）', () => {
  it('RFC 4180 のクオート（カンマ・改行・"" エスケープ）を正しく読み戻す', async () => {
    const csv = '工程No,作業名\r\n"1","受注, 確認"\r\n2,"1行目\n2行目"\r\n3,"said ""hi"""';
    const rows = await readTableFile(new File([csv], 'test.csv', { type: 'text/csv' }));
    expect(rows).toEqual([
      ['工程No', '作業名'],
      ['1', '受注, 確認'],
      ['2', '1行目\n2行目'],
      ['3', 'said "hi"'],
    ]);
  });

  it('エクスポート同様の BOM 付き CSV でも先頭ヘッダが化けない', async () => {
    const csv = '﻿工程No,作業名\nA1,受注';
    const rows = await readTableFile(new File([csv], 'bom.csv', { type: 'text/csv' }));
    expect(rows[0]![0]).toBe('工程No'); // File.text() の UTF-8 デコードで BOM は除去される
  });
});

describe('localDateYmd', () => {
  it('ローカル日付の YYYY-MM-DD を返す（UTC の日付ではない）', () => {
    // ローカル時刻で組み立てた日時はタイムゾーンに依らず同じローカル日付になる。
    expect(localDateYmd(new Date(2026, 5, 11, 8, 30))).toBe('2026-06-11');
    expect(localDateYmd(new Date(2026, 0, 1, 0, 0))).toBe('2026-01-01');
  });
});
