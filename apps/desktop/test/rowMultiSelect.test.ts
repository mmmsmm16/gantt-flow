// 行の複数選択（一括操作）の共有ロジック。DOM 非依存の遷移関数 nextMarked と、
// taskOps の一括担当設定 bulkSetAssignee（マイルストーン除外）を検証する。
import { describe, it, expect, beforeEach } from 'vitest';
import { nextMarked } from '../src/ui/useRowMultiSelect';
import { bulkSetAssignee } from '../src/taskOps';
import { useApp } from '../src/store';
import { useUI } from '../src/ui/useUI';

describe('nextMarked: 行クリックのマーク遷移', () => {
  const ids = ['a', 'b', 'c', 'd'];

  it('修飾なしのクリックは複数選択を解除し activate=true（単一選択へ）', () => {
    const r = nextMarked(new Set(['a', 'b']), 'a', ids, 'c', { shift: false, ctrl: false });
    expect([...r.marked]).toEqual([]);
    expect(r.anchor).toBe('c');
    expect(r.activate).toBe(true);
  });

  it('Ctrl/⌘ クリックはマークをトグルし、アンカーを更新（activate しない）', () => {
    const add = nextMarked(new Set(['a']), 'a', ids, 'b', { shift: false, ctrl: true });
    expect([...add.marked].sort()).toEqual(['a', 'b']);
    expect(add.anchor).toBe('b');
    expect(add.activate).toBe(false);

    const remove = nextMarked(new Set(['a', 'b']), 'b', ids, 'b', { shift: false, ctrl: true });
    expect([...remove.marked]).toEqual(['a']);
    expect(remove.anchor).toBe('b');
  });

  it('単一選択（marked 空）からの Ctrl/⌘ クリックは直前の行（anchor）も一緒にマークする', () => {
    // 「行 a をクリック → Ctrl+クリックで行 b」= a と b の 2 行が選択される（標準的な複数選択）。
    const r = nextMarked(new Set(), 'a', ids, 'b', { shift: false, ctrl: true });
    expect([...r.marked].sort()).toEqual(['a', 'b']);
    expect(r.anchor).toBe('b');
    expect(r.activate).toBe(false);
  });

  it('anchor が無い（未クリック）状態での Ctrl/⌘ クリックは当該行だけをマーク', () => {
    const r = nextMarked(new Set(), null, ids, 'c', { shift: false, ctrl: true });
    expect([...r.marked]).toEqual(['c']);
  });

  it('anchor と同じ行を Ctrl/⌘ クリックしても二重に足さず 1 行だけ', () => {
    const r = nextMarked(new Set(), 'a', ids, 'a', { shift: false, ctrl: true });
    expect([...r.marked]).toEqual(['a']);
  });

  it('Shift クリックはアンカーから当該行までを範囲マーク（順・逆どちらでも既存に和）', () => {
    const fwd = nextMarked(new Set(), 'b', ids, 'd', { shift: true, ctrl: false });
    expect([...fwd.marked].sort()).toEqual(['b', 'c', 'd']);
    expect(fwd.anchor).toBe('b'); // 範囲選択ではアンカーは動かさない

    const rev = nextMarked(new Set(['x']), 'd', ids, 'b', { shift: true, ctrl: false });
    expect([...rev.marked].sort()).toEqual(['b', 'c', 'd', 'x']);
  });

  it('Shift クリックでアンカーが可視行に無い（折りたたみ等で消えた）ときは何もしない', () => {
    const cur = new Set(['a']);
    const r = nextMarked(cur, 'zz', ids, 'c', { shift: true, ctrl: false });
    expect(r.marked).toBe(cur); // 同一参照＝変更なし
    expect(r.activate).toBe(false);
  });
});

const tasksByName = (name: string) =>
  Object.values(useApp.getState().project.core.tasks).find((t) => t.name === name)!;

describe('bulkSetAssignee: 担当の一括設定（マイルストーン除外）', () => {
  beforeEach(() => {
    useApp.getState().newProject();
    if (useUI.getState().dialog) useUI.getState().resolveDialog(false);
  });

  it('マイルストーンを対象から外して残りにだけ担当を設定する', async () => {
    useApp.getState().addTask('A');
    const a = tasksByName('A').id;
    const ms = useApp.getState().addMilestone()!;

    const pending = bulkSetAssignee([a, ms]);
    // プロンプトは対象件数（＝1、MS を除いた数）を示す。
    expect(useUI.getState().dialog?.kind).toBe('prompt');
    expect(useUI.getState().dialog?.message).toContain('1 件');
    useUI.getState().resolveDialog('担当X');
    expect(await pending).toBe(true);

    expect(useApp.getState().project.core.tasks[a]!.assigneeId).toBeDefined();
    expect(useApp.getState().project.core.tasks[ms]!.assigneeId).toBeUndefined();
  });

  it('マイルストーンだけの選択はプロンプトを出さず、案内トーストで false を返す', async () => {
    const ms = useApp.getState().addMilestone()!;
    const before = useUI.getState().toasts.length;

    const ok = await bulkSetAssignee([ms]);
    expect(ok).toBe(false);
    expect(useUI.getState().dialog).toBeNull();
    expect(useUI.getState().toasts.length).toBe(before + 1);
    expect(useApp.getState().project.core.tasks[ms]!.assigneeId).toBeUndefined();
  });

  it('キャンセルすると担当を変えず false を返す', async () => {
    useApp.getState().addTask('A');
    const a = tasksByName('A').id;

    const pending = bulkSetAssignee([a]);
    useUI.getState().resolveDialog(null);
    expect(await pending).toBe(false);
    expect(useApp.getState().project.core.tasks[a]!.assigneeId).toBeUndefined();
  });
});
