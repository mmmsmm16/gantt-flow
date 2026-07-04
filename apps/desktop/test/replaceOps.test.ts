// #7 の再発防止: 新規/取り込み/サンプル/テンプレ/最近のファイルの「未保存なら確認」ゲート
// (replaceOps.ts)を、実際の呼び出し順序込みで検証する。
// 特に gatedImport は「confirmReplace が picker(ファイル選択 UI)を開くより必ず先に走り、
// キャンセル時は picker を一切開かない」という順序そのものが不変条件なので、
// openPicker をスパイして呼び出しタイミングを直接確認する。
import { describe, it, expect, vi } from 'vitest';
import { useApp } from '../src/store';
import { useUI } from '../src/ui/useUI';
import { confirmReplace, gatedImport } from '../src/replaceOps';

describe('replaceOps.confirmReplace', () => {
  it('クリーン(dirty でない)なら確認ダイアログを出さず即 true', async () => {
    useApp.getState().newProject(); // dirty=false
    expect(useApp.getState().dirty).toBe(false);
    const ok = await confirmReplace('新規プロジェクト');
    expect(ok).toBe(true);
    expect(useUI.getState().dialog).toBeNull();
  });

  it('dirty ならダイアログを出し、キャンセルで false・続行で true', async () => {
    useApp.getState().newProject();
    useApp.getState().addTask('受付'); // dirty=true にする
    expect(useApp.getState().dirty).toBe(true);

    let pr = confirmReplace('CSV / Excel を取り込む');
    expect(useUI.getState().dialog?.kind).toBe('confirm');
    expect(useUI.getState().dialog?.title).toBe('CSV / Excel を取り込む');
    expect(useUI.getState().dialog?.message).toContain('未保存の変更があります');
    useUI.getState().resolveDialog(false);
    expect(await pr).toBe(false);

    pr = confirmReplace('CSV / Excel を取り込む');
    expect(useUI.getState().dialog?.kind).toBe('confirm');
    useUI.getState().resolveDialog(true);
    expect(await pr).toBe(true);
  });
});

describe('replaceOps.gatedImport（取り込みの全入口が経由する実際のハンドラ連鎖）', () => {
  it('dirty のとき: openPicker は確認ダイアログが解決するまで一切呼ばれない', async () => {
    useApp.getState().newProject();
    useApp.getState().addTask('受付');
    expect(useApp.getState().dirty).toBe(true);

    const openPicker = vi.fn();
    const pr = gatedImport(openPicker);
    // 確認ダイアログが出た時点では、まだ picker は絶対に開かれていない。
    expect(useUI.getState().dialog?.kind).toBe('confirm');
    expect(openPicker).not.toHaveBeenCalled();

    useUI.getState().resolveDialog(true);
    expect(await pr).toBe(true);
    expect(openPicker).toHaveBeenCalledTimes(1);
  });

  it('dirty でキャンセル: openPicker は一度も呼ばれず、何も開かない・何も取り込まれない', async () => {
    useApp.getState().newProject();
    useApp.getState().addTask('受付');

    const openPicker = vi.fn();
    const pr = gatedImport(openPicker);
    expect(useUI.getState().dialog?.kind).toBe('confirm');
    useUI.getState().resolveDialog(false);
    expect(await pr).toBe(false);
    expect(openPicker).not.toHaveBeenCalled();
  });

  it('クリーンなら確認なしで即 openPicker を呼ぶ', async () => {
    useApp.getState().newProject();
    expect(useApp.getState().dirty).toBe(false);

    const openPicker = vi.fn();
    const ok = await gatedImport(openPicker);
    expect(ok).toBe(true);
    expect(openPicker).toHaveBeenCalledTimes(1);
    expect(useUI.getState().dialog).toBeNull();
  });
});
