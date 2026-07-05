// persistence の保存/開く（Tauri バックエンド・競合検知・助言ロック）と CSV 読み込みのテスト。
// Tauri 環境は window.__TAURI__.core.invoke をモックして再現する（node 環境のため DOM 依存の
// エクスポート系: exportPngFile 等はここでは対象外）。
import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  createSampleProject,
  serializeProject,
  serializeContainer,
  deserializeContainer,
  type LockInfo,
  type Project,
} from '@gantt-flow/core';
import {
  saveProjectToFile,
  openProjectFromFile,
  forgetFileHandle,
  readTableFile,
  localDateYmd,
  missingReferencedAssets,
  exportHandbookFile,
} from '../src/persistence';
import { bytesToB64, b64ToBytes } from '../src/b64';
import { putAsset, __resetAssetStoreForTest } from '../src/assetStore';

const gen = (prefix: string) => {
  let n = 0;
  return () => `${prefix}-${++n}`;
};

// open_project は base64 文字列を返す（Task 2 の IPC 契約）。
// v2 = ZIP コンテナ、legacy = 旧単一 JSON（後方互換）の base64 をそれぞれ組み立てる。
const containerB64 = (p: Project): string => bytesToB64(serializeContainer(p));
const legacyJsonB64 = (p: Project): string => bytesToB64(new TextEncoder().encode(serializeProject(p)));

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
        saved.push(a['contentsB64'] as string);
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
    // save_project へは ZIP コンテナのバイト列を base64 で渡す。
    const bytes = b64ToBytes(saved[0]!);
    expect(bytes[0]).toBe(0x50); // 'P'
    expect(bytes[1]).toBe(0x4b); // 'K' → ZIP ヘッダ
    // 復号 → コンテナ展開で元のプロジェクトに戻せる（Zod パースでキー順は変わるため deep-equal）。
    expect(deserializeContainer(bytes).project).toEqual(p);

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

  it('保存中の保存は直列化され、自分のリネームで変わった mtime を競合と誤検出しない', async () => {
    let mtime = '1';
    let saveCalls = 0;
    let openGate!: (v: null) => void;
    const gate = new Promise<null>((res) => (openGate = res));
    installTauri({
      pick_save_path: () => '/tmp/serial.json',
      save_project: () => {
        saveCalls += 1;
        mtime = String(Number(mtime) + 1); // アトミック保存のリネームで mtime が変わる
        return saveCalls === 2 ? gate : null; // 2 回目の書き込みを途中で待たせる
      },
      stat_updated_at: () => mtime,
      acquire_lock: () => ({ ok: true }),
      refresh_lock: () => null,
      release_lock: () => null,
    });
    const p = createSampleProject(gen('s4'));
    await saveProjectToFile(p); // 1 回目: 保存先と mtime を記憶

    const second = saveProjectToFile(p); // 書き込み中…
    await new Promise((r) => setTimeout(r, 0)); // …save_project に到達（リネームで mtime は変化済み）
    const third = saveProjectToFile(p); // 完了前に重ねて保存（Ctrl+S 連打相当）
    openGate(null);
    expect((await second).kind).toBe('saved');
    // 直列化されていないと、2 回目のリネームで変わった mtime を 3 回目が競合と誤検出する
    expect((await third).kind).toBe('saved');
    expect(saveCalls).toBe(3);
  });

  it('保存先は pick_save_path の戻りを改変せず save_project へ渡す（拡張子付与と許可登録は Rust 側）', async () => {
    // .json 付与と保存先の許可リスト登録は Rust 側 pick_save_path が行う。フロントがパスを
    // 書き換えると、Rust の許可リストに載ったパスと一致せず save_project が弾かれてしまう。
    const calls = installTauri({
      pick_save_path: () => '/tmp/レポート.json',
      save_project: () => null,
      stat_updated_at: () => '1',
      acquire_lock: () => ({ ok: true }),
      refresh_lock: () => null,
      release_lock: () => null,
    });
    const r = await saveProjectToFile(createSampleProject(gen('s5')));
    expect(r).toEqual({ kind: 'saved', name: 'レポート.json' });
    expect(calls.find((c) => c.cmd === 'save_project')!.args['path']).toBe('/tmp/レポート.json');
  });

  it('新規保存の suggestedName は専用拡張子 .gflow を使う', async () => {
    const calls = installTauri({
      pick_save_path: () => '/tmp/サンプル.gflow',
      save_project: () => null,
      stat_updated_at: () => '1',
      acquire_lock: () => ({ ok: true }),
      refresh_lock: () => null,
      release_lock: () => null,
    });
    await saveProjectToFile(createSampleProject(gen('s5b')));
    const pick = calls.find((c) => c.cmd === 'pick_save_path')!;
    expect(String(pick.args['suggestedName'])).toMatch(/\.gflow$/);
  });

  it('保存後のロック取得が解決する前に保存先が変わったら、取得したロックは保持せず返す', async () => {
    let resolveAcquire!: (v: unknown) => void;
    const calls = installTauri({
      pick_save_path: () => '/tmp/late-lock.json',
      save_project: () => null,
      stat_updated_at: () => '1',
      acquire_lock: () => new Promise((res) => (resolveAcquire = res)),
      release_lock: () => null,
    });
    const r = await saveProjectToFile(createSampleProject(gen('s6')));
    expect(r.kind).toBe('saved'); // ロック取得は保存をブロックしない
    forgetFileHandle(); // 取得待ちの間に保存先が変わった（新規作成相当）
    resolveAcquire({ ok: true });
    await new Promise((res) => setTimeout(res, 0));
    // 古い対象のロックは beginHolding せず、そのまま返却される
    expect(
      calls.filter((c) => c.cmd === 'release_lock' && c.args['path'] === '/tmp/late-lock.json'),
    ).toHaveLength(1);
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
      open_project: () => containerB64(sample),
      acquire_lock: () => ({ ok: true }),
      release_lock: () => null,
      save_project: (a) => {
        saved.push(a['contentsB64'] as string);
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

  it('旧 JSON（v1 単一 JSON）ファイルも後方互換で開ける', async () => {
    const sample = createSampleProject(gen('o1b'));
    installTauri({
      pick_open_path: () => '/tmp/legacy.json',
      stat_updated_at: () => '1',
      // ZIP ではなく旧単一 JSON の base64（拡張前に保存されたファイル相当）。
      open_project: () => legacyJsonB64(sample),
      acquire_lock: () => ({ ok: true }),
      refresh_lock: () => null,
      release_lock: () => null,
    });
    const p = await openProjectFromFile();
    expect(p?.meta.id).toBe(sample.meta.id);
    expect(p).toEqual(sample); // 旧 JSON も現行と同じプロジェクトに復元される（キー順非依存）
  });

  it('他セッションが編集中（stale でない）→ cancel なら開かない', async () => {
    const sample = createSampleProject(gen('o2'));
    const calls = installTauri({
      pick_open_path: () => '/tmp/locked.json',
      stat_updated_at: () => '1',
      open_project: () => containerB64(sample),
      acquire_lock: () => ({ ok: false, held: heldByOther, stale: false }),
    });
    const seen: { stale: boolean }[] = [];
    const p = await openProjectFromFile({
      confirmLock: (held, stale) => {
        expect(held?.user).toBe('別のユーザー');
        seen.push({ stale });
        return Promise.resolve('cancel');
      },
    });
    expect(p).toBeNull();
    expect(seen).toEqual([{ stale: false }]);
    expect(calls.some((c) => c.cmd === 'steal_lock')).toBe(false);
  });

  it('保持者不明（held: null）のロックは null のまま confirmLock に渡り、奪取は試みない', async () => {
    const sample = createSampleProject(gen('o2n'));
    const calls = installTauri({
      pick_open_path: () => '/tmp/locked.json',
      stat_updated_at: () => '1',
      open_project: () => containerB64(sample),
      acquire_lock: () => ({ ok: false, held: null, stale: false }),
    });
    const seen: { held: unknown; stale: boolean }[] = [];
    const p = await openProjectFromFile({
      confirmLock: (held, stale) => {
        seen.push({ held, stale });
        // 奪取(takeover)を返しても期待値が無いので steal_lock は呼ばれず、取り直しになる。
        return Promise.resolve(seen.length < 2 ? 'takeover' : 'cancel');
      },
    });
    expect(p).toBeNull();
    expect(seen[0]).toEqual({ held: null, stale: false });
    expect(calls.some((c) => c.cmd === 'steal_lock')).toBe(false);
  });

  it('proceed ならロック無しで開ける（保存時の競合検知が安全網）', async () => {
    const sample = createSampleProject(gen('o3'));
    installTauri({
      pick_open_path: () => '/tmp/locked.json',
      stat_updated_at: () => '1',
      open_project: () => containerB64(sample),
      acquire_lock: () => ({ ok: false, held: heldByOther, stale: false }),
    });
    const p = await openProjectFromFile({ confirmLock: () => Promise.resolve('proceed') });
    expect(p?.meta.id).toBe(sample.meta.id);
  });

  it('同じファイルの開き直しは保持中のロックをそのまま使う（手放さない・取り直さない）', async () => {
    const sample = createSampleProject(gen('o5'));
    const calls = installTauri({
      pick_open_path: () => '/tmp/same.json',
      stat_updated_at: () => '1',
      open_project: () => containerB64(sample),
      acquire_lock: () => ({ ok: true }),
      refresh_lock: () => null,
      release_lock: () => null,
    });
    await openProjectFromFile(); // 1 回目: ロック取得
    expect(calls.filter((c) => c.cmd === 'acquire_lock')).toHaveLength(1);

    const p2 = await openProjectFromFile(); // 同じパスを開き直す
    expect(p2?.meta.id).toBe(sample.meta.id);
    expect(calls.filter((c) => c.cmd === 'acquire_lock')).toHaveLength(1); // 再取得しない
    expect(calls.filter((c) => c.cmd === 'release_lock')).toHaveLength(0); // 手放さない
  });

  it('別パスを開いてキャンセルしたら、前のファイルのロックは保持したまま', async () => {
    const sample = createSampleProject(gen('o6'));
    let pickPath = '/tmp/first.json';
    const calls = installTauri({
      pick_open_path: () => pickPath,
      stat_updated_at: () => '1',
      open_project: () => containerB64(sample),
      acquire_lock: (a) =>
        a['path'] === '/tmp/first.json' ? { ok: true } : { ok: false, held: heldByOther, stale: false },
      refresh_lock: () => null,
      release_lock: () => null,
    });
    await openProjectFromFile(); // first.json のロックを保持
    pickPath = '/tmp/second.json';
    const p2 = await openProjectFromFile({ confirmLock: () => Promise.resolve('cancel') });
    expect(p2).toBeNull(); // 開くのをやめる
    expect(calls.filter((c) => c.cmd === 'release_lock')).toHaveLength(0); // 旧ロックは失わない
  });

  it('別パスを開けたときは、新ロックの取得が確定してから旧ロックを返す（順序）', async () => {
    const sample = createSampleProject(gen('o7'));
    let pickPath = '/tmp/a.json';
    const calls = installTauri({
      pick_open_path: () => pickPath,
      stat_updated_at: () => '1',
      open_project: () => containerB64(sample),
      acquire_lock: () => ({ ok: true }),
      refresh_lock: () => null,
      release_lock: () => null,
    });
    await openProjectFromFile();
    pickPath = '/tmp/b.json';
    await openProjectFromFile();
    const releaseIdx = calls.findIndex((c) => c.cmd === 'release_lock');
    const acquireBIdx = calls.findIndex(
      (c) => c.cmd === 'acquire_lock' && c.args['path'] === '/tmp/b.json',
    );
    expect(acquireBIdx).toBeGreaterThanOrEqual(0);
    expect(releaseIdx).toBeGreaterThan(acquireBIdx); // 新ロック確定 → 旧ロック返却の順
    expect(calls[releaseIdx]!.args['path']).toBe('/tmp/a.json');
  });

  it('stale ロックは takeover で引き継いで開ける（expected には held を渡す）', async () => {
    const sample = createSampleProject(gen('o4'));
    const calls = installTauri({
      pick_open_path: () => '/tmp/stale.json',
      stat_updated_at: () => '1',
      open_project: () => containerB64(sample),
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

describe('保存時 assets 配線（ZIP assets/ 往復・保存時 GC・b64 多チャンク）', () => {
  const NOW = '2026-07-05T00:00:00.000Z';

  // 手順書に画像 1 枚を参照させた Project を作る（bytes は assetStore 側に putAsset 済み前提）。
  const withImageRef = (base: Project, taskId: string, file: string): Project => ({
    ...base,
    manual: {
      procedures: {
        [taskId]: {
          taskId,
          updatedAt: NOW,
          revisions: [],
          steps: [{ id: `${file}-s`, action: '手順', conds: [], refs: [], images: [{ id: `${file}-i`, file }] }],
        },
      },
      assets: {},
    },
  });

  afterEach(() => __resetAssetStoreForTest());

  it('>32KB 画像を貼って保存→読込で壊れない（bytesToB64 の CHUNK 境界回帰）', async () => {
    // 0x8000(32768) 境界を越える画像。ZIP 全体も >32KB になり b64 多チャンク経路を通す。
    const big = new Uint8Array(50000);
    for (let i = 0; i < big.length; i++) big[i] = (i * 31 + 7) & 0xff;
    const file = 'big-b64.png';
    putAsset(file, big);

    const base = createSampleProject(gen('imgbig'));
    const taskId = Object.keys(base.core.tasks)[0]!;
    const p = withImageRef(base, taskId, file);

    const saved: string[] = [];
    installTauri({
      pick_save_path: () => '/tmp/img.gflow',
      save_project: (a) => {
        saved.push(a['contentsB64'] as string);
        return null;
      },
      stat_updated_at: () => '1',
      acquire_lock: () => ({ ok: true }),
      refresh_lock: () => null,
      release_lock: () => null,
    });

    const r = await saveProjectToFile(p);
    expect(r.kind).toBe('saved');
    const bytes = b64ToBytes(saved[0]!);
    expect(bytes[0]).toBe(0x50); // 'PK'（ZIP）
    const out = deserializeContainer(bytes);
    // 画像 bytes がバイト同一で往復する
    expect(out.assets[file]).toEqual(big);
    // project 側は file 名だけを持つ（bytes は入れない）
    expect(out.project.manual.procedures[taskId]!.steps[0]!.images[0]!.file).toBe(file);
  });

  it('保存時 GC: 参照されない孤児 asset は ZIP へ書かれない（メモリは残る＝別テストの責務）', async () => {
    const referenced = 'ref.png';
    const orphan = 'orphan.png';
    putAsset(referenced, new Uint8Array([1, 2, 3]));
    putAsset(orphan, new Uint8Array([9, 9, 9])); // どのステップからも参照されない

    const base = createSampleProject(gen('imggc'));
    const taskId = Object.keys(base.core.tasks)[0]!;
    const p = withImageRef(base, taskId, referenced);

    const saved: string[] = [];
    installTauri({
      pick_save_path: () => '/tmp/gc.gflow',
      save_project: (a) => {
        saved.push(a['contentsB64'] as string);
        return null;
      },
      stat_updated_at: () => '1',
      acquire_lock: () => ({ ok: true }),
      refresh_lock: () => null,
      release_lock: () => null,
    });

    await saveProjectToFile(p);
    const out = deserializeContainer(b64ToBytes(saved[0]!));
    expect(Object.keys(out.assets)).toEqual([referenced]); // 参照分のみ・孤児は落ちる
  });
});

// migration-safety Important2: 保存前の欠落画像チェック（App の doSave が確認ダイアログに使う純関数）。
// 参照している画像の bytes がメモリに無いまま保存すると ZIP から永久に消えるため、事前に検出する。
describe('missingReferencedAssets（保存前の欠落画像検出）', () => {
  const NOW = '2026-07-05T00:00:00.000Z';
  const withImageRefs = (base: Project, taskId: string, files: string[]): Project => ({
    ...base,
    manual: {
      procedures: {
        [taskId]: {
          taskId,
          updatedAt: NOW,
          revisions: [],
          steps: [
            {
              id: `${taskId}-s`,
              action: '手順',
              conds: [],
              refs: [],
              images: files.map((file) => ({ id: `${file}-i`, file })),
            },
          ],
        },
      },
      assets: {},
    },
  });

  afterEach(() => __resetAssetStoreForTest());

  it('参照画像がすべて assetStore にあれば空配列（そのまま保存してよい）', () => {
    const base = createSampleProject(gen('miss-ok'));
    const taskId = Object.keys(base.core.tasks)[0]!;
    putAsset('a.png', new Uint8Array([1]));
    putAsset('b.png', new Uint8Array([2]));
    const p = withImageRefs(base, taskId, ['a.png', 'b.png']);
    expect(missingReferencedAssets(p)).toEqual([]);
  });

  it('bytes がメモリに無い参照画像を欠落として列挙する', () => {
    const base = createSampleProject(gen('miss-some'));
    const taskId = Object.keys(base.core.tasks)[0]!;
    putAsset('present.png', new Uint8Array([1])); // これだけメモリにある
    const p = withImageRefs(base, taskId, ['present.png', 'gone1.png', 'gone2.png']);
    expect(missingReferencedAssets(p).sort()).toEqual(['gone1.png', 'gone2.png']);
  });

  it('画像を参照しないプロジェクトは常に空配列', () => {
    const base = createSampleProject(gen('miss-none'));
    expect(missingReferencedAssets(base)).toEqual([]);
  });
});

// exportSvgFile 等と同じ private download()（Blob + <a download> のクリック）を経由する。
// document は node 環境に無いため最小スタブを張り、URL.createObjectURL/revokeObjectURL は
// clearAssetStore テスト（assetStore.test.ts）と同様に vi.spyOn で捕捉する（実装差し替えはしない）。
describe('exportHandbookFile（ハンドブック HTML の書き出し）', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    delete (globalThis as { document?: unknown }).document;
  });

  it('safeName(title)-handbook.html という名前・text/html;charset=utf-8 で download する', () => {
    const project = createSampleProject(gen('hb1'));
    const clicks: { name: string; href: string }[] = [];
    let capturedMime = '';
    vi.spyOn(URL, 'createObjectURL').mockImplementation((blob) => {
      capturedMime = (blob as Blob).type;
      return 'blob:mock-handbook';
    });
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    (globalThis as { document?: unknown }).document = {
      createElement: () => {
        const a: { href: string; download: string; click: () => void } = {
          href: '',
          download: '',
          click: () => clicks.push({ name: a.download, href: a.href }),
        };
        return a;
      },
    };

    const name = exportHandbookFile(project);

    expect(name).toMatch(/-handbook\.html$/);
    expect(name).not.toContain('：'); // safeName 通過(全角記号などは _ に置換済み)
    expect(clicks).toHaveLength(1);
    expect(clicks[0]).toEqual({ name, href: 'blob:mock-handbook' });
    expect(capturedMime).toBe('text/html;charset=utf-8');
  });
});

describe('localDateYmd', () => {
  it('ローカル日付の YYYY-MM-DD を返す（UTC の日付ではない）', () => {
    // ローカル時刻で組み立てた日時はタイムゾーンに依らず同じローカル日付になる。
    expect(localDateYmd(new Date(2026, 5, 11, 8, 30))).toBe('2026-06-11');
    expect(localDateYmd(new Date(2026, 0, 1, 0, 0))).toBe('2026-01-01');
  });
});
