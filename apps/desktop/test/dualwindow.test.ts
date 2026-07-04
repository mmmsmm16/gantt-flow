import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createAppStore } from '../src/store';
import {
  parseWindowParam,
  classifyAction,
  ACTION_CLASS,
  pickSnapshot,
  snapshotChanged,
  createLeaderSync,
  createFollowerSync,
  installForwarding,
  applyForwardedAction,
  shouldHandleFocus,
  runFocusHint,
  type SyncChannel,
  type SyncMessage,
} from '../src/dualwindow';
import { serializeProject } from '@gantt-flow/core';
import { useApp, type RemoteSnapshot } from '../src/store';
import { useUI } from '../src/ui/useUI';

// テスト用の双方向チャネル。post したメッセージを相手の onmessage へ即配送する。
function pairChannels(): { a: SyncChannel; b: SyncChannel; closed: () => number } {
  let closes = 0;
  const a: SyncChannel = { postMessage: (m) => b.onmessage?.(m), onmessage: null, close: () => void closes++ };
  const b: SyncChannel = { postMessage: (m) => a.onmessage?.(m), onmessage: null, close: () => void closes++ };
  return { a, b, closed: () => closes };
}
function recorder(): { ch: SyncChannel; sent: SyncMessage[]; emit: (m: SyncMessage) => void } {
  const sent: SyncMessage[] = [];
  const ch: SyncChannel = { postMessage: (m) => sent.push(m), onmessage: null, close: vi.fn() };
  return { ch, sent, emit: (m) => ch.onmessage?.(m) };
}

describe('dualwindow: parseWindowParam', () => {
  it('window=edit のみ受け付け、それ以外・未指定は null', () => {
    expect(parseWindowParam('?window=edit')).toBe('edit');
    expect(parseWindowParam('?window=view')).toBeNull();
    expect(parseWindowParam('?mirror=flow')).toBeNull();
    expect(parseWindowParam('')).toBeNull();
  });
});

describe('dualwindow: アクション分類の網羅性（新アクション追加時の分類漏れ検出）', () => {
  it('store の全アクション（関数フィールド）が明示的に分類済み', () => {
    const s = createAppStore();
    const unclassified = Object.entries(s.getState())
      .filter(([, v]) => typeof v === 'function')
      .map(([k]) => k)
      .filter((k) => !(k in ACTION_CLASS));
    expect(unclassified).toEqual([]);
  });

  it('分類の代表例（forward / ensureView / local / leaderOnly）', () => {
    expect(classifyAction('addTaskAt')).toBe('forward');
    expect(classifyAction('undo')).toBe('forward');
    expect(classifyAction('setLevel')).toBe('ensureView');
    expect(classifyAction('setScope')).toBe('ensureView');
    expect(classifyAction('select')).toBe('local');
    expect(classifyAction('toggleIssues')).toBe('local');
    expect(classifyAction('loadProject')).toBe('leaderOnly');
    expect(classifyAction('markSaved')).toBe('leaderOnly');
    // 未知アクションは安全側（leaderOnly＝フォロワーで実行させない）にフォールバック
    expect(classifyAction('someBrandNewAction')).toBe('leaderOnly');
  });
});

describe('dualwindow: snapshotChanged（発行対象の差分だけ検知）', () => {
  const P = { tag: 'p' } as never; // 共有 project 参照（不変更新なので参照比較で足りる）
  const base = (over: Partial<RemoteSnapshot> = {}): RemoteSnapshot => ({
    project: P,
    canUndo: false,
    canRedo: false,
    dirty: false,
    lastSyncAdded: { ids: [], seq: 0 },
    lastAssigneeSync: { ids: [], seq: 0 },
    focusHint: null,
    ...over,
  });
  it('初回は常に変化あり', () => expect(snapshotChanged(null, base())).toBe(true));
  it('同一 project 参照＋同一フラグなら変化なし', () =>
    expect(snapshotChanged(base(), base())).toBe(false));
  it('project 参照・dirty・履歴フラグ・focusHint.seq の変化を検知', () => {
    const a = base();
    expect(snapshotChanged(a, base({ project: { tag: 'q' } as never }))).toBe(true);
    expect(snapshotChanged(a, base({ dirty: true }))).toBe(true);
    expect(snapshotChanged(a, base({ canUndo: true }))).toBe(true);
    expect(snapshotChanged(a, base({ focusHint: { origin: 'x', intent: 'rename', seq: 1 } }))).toBe(true);
  });
});

describe('dualwindow: applyRemoteSnapshot（受信反映が表示状態・履歴を汚さない）', () => {
  it('project/dirty/canUndo/canRedo だけ反映し、選択・粒度・スコープ・課題レイヤ・履歴は不変', () => {
    const s = createAppStore();
    s.getState().addTask('A'); // 履歴を進めておく（canUndo=true）
    s.getState().select(Object.keys(s.getState().project.core.tasks)[0]);
    s.getState().setLevel('large');
    s.getState().toggleIssues(); // showIssues=false
    const keepSel = s.getState().selectedTaskId;

    // 別ストア（リーダー相当）で 2 件の状態を作る。
    const leader = createAppStore();
    leader.getState().addTask('X');
    leader.getState().addTask('Y');
    const snap = pickSnapshot(leader.getState());

    s.getState().applyRemoteSnapshot(snap);

    expect(Object.values(s.getState().project.core.tasks).map((t) => t.name).sort()).toEqual(['X', 'Y']);
    expect(s.getState().canUndo).toBe(true);
    // 表示状態は据え置き（窓ごと独立）
    expect(s.getState().selectedTaskId).toBe(keepSel);
    expect(s.getState().level).toBe('large');
    expect(s.getState().showIssues).toBe(false);
  });
});

describe('dualwindow: リーダー配信 / フォロワー受信（skeleton）', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('リーダーは編集のたびデバウンスして最新スナップショットを配る（hello には即応答）', () => {
    const leader = createAppStore();
    const { ch, sent, emit } = recorder();
    createLeaderSync(leader, { channel: ch, debounceMs: 40 });

    emit({ type: 'hello' }); // 接続時に即応答
    expect(sent.filter((m) => m.type === 'snapshot')).toHaveLength(1);

    leader.getState().addTask('A');
    leader.getState().addTask('B');
    vi.advanceTimersByTime(40);
    const snaps = sent.filter((m): m is Extract<SyncMessage, { type: 'snapshot' }> => m.type === 'snapshot');
    expect(snaps.length).toBeGreaterThanOrEqual(2);
    // 最新スナップショットにはリーダーの現在 project が載る
    expect(snaps.at(-1)!.snapshot.project).toBe(leader.getState().project);
  });

  it('フォロワーは snapshot を受けて project を反映し、接続済みになる', () => {
    const leader = createAppStore();
    leader.getState().addTask('受付');
    const follower = createAppStore();
    const { a, b } = pairChannels();
    createLeaderSync(leader, { channel: a, debounceMs: 0 });
    createFollowerSync(follower, { channel: b, readOnly: true });
    // createFollowerSync が hello を送り、リーダーが即応答 → フォロワーへ現在状態が届く
    expect(Object.values(follower.getState().project.core.tasks).map((t) => t.name)).toEqual(['受付']);
  });
});

describe('dualwindow S2: 編集アクションの汎用転送（両窓編集同期）', () => {
  const wiring = (post: (m: SyncMessage) => void, pane: 'table' | 'flow' = 'flow') => ({
    windowId: 'w-follower',
    activePane: () => pane,
    post,
    connected: () => true,
  });

  it('forward アクションはローカル適用せずリーダーへ転送する（作成系は focus 付き）', () => {
    const follower = createAppStore();
    const sent: SyncMessage[] = [];
    installForwarding(follower, wiring((m) => sent.push(m)));

    follower.getState().addTask('X'); // forward・focus なし
    follower.getState().addTaskAt(300, 40); // forward・rename focus

    expect(Object.keys(follower.getState().project.core.tasks)).toHaveLength(0); // ローカルは不変
    const actions = sent.filter((m): m is Extract<SyncMessage, { type: 'action' }> => m.type === 'action');
    expect(actions.map((a) => a.name)).toEqual(['addTask', 'addTaskAt']);
    expect(actions[0]!.focus).toBeUndefined();
    expect(actions[1]!.focus).toEqual({ intent: 'rename', surface: 'flow' });
    expect(actions.every((a) => a.origin === 'w-follower')).toBe(true);
  });

  it('leaderOnly アクションは転送せず握りつぶす（フォロワーでファイルを触らせない）', () => {
    const follower = createAppStore();
    const sent: SyncMessage[] = [];
    installForwarding(follower, wiring((m) => sent.push(m)));
    follower.getState().newProject();
    follower.getState().loadSample();
    expect(sent.filter((m) => m.type === 'action')).toHaveLength(0);
  });

  it('setLevel/setScope は表示をローカルに切替え、ensureView だけ転送する', () => {
    const follower = createAppStore();
    const sent: SyncMessage[] = [];
    installForwarding(follower, wiring((m) => sent.push(m)));

    follower.getState().setLevel('large');
    expect(follower.getState().level).toBe('large'); // 表示はローカルに変わる
    follower.getState().setScope('parent-x');
    expect(follower.getState().scopeParentId).toBe('parent-x');

    const actions = sent.filter((m): m is Extract<SyncMessage, { type: 'action' }> => m.type === 'action');
    expect(actions.map((a) => [a.name, ...a.args])).toEqual([
      ['ensureView', 'large', undefined],
      ['ensureView', 'large', 'parent-x'],
    ]);
  });

  it('リーダーは転送アクションを適用し、自窓の選択は動かさない（表示は窓ごと独立）', () => {
    const leader = createAppStore();
    // リーダーは何も選択していない状態
    expect(leader.getState().selectedTaskId).toBeUndefined();
    applyForwardedAction(
      leader,
      { type: 'action', name: 'addTaskAt', args: [300, 40], origin: 'w-follower', focus: { intent: 'rename', surface: 'flow' } },
      'w-leader',
    );
    // 工程は作られるが、リーダー自身の選択は addTaskAt が動かした後で元(undefined)へ戻す
    expect(Object.keys(leader.getState().project.core.tasks)).toHaveLength(1);
    expect(leader.getState().selectedTaskId).toBeUndefined();
    // 発信元窓向けの focusHint が立つ（作成 id と origin 付き）
    const hint = leader.getState().focusHint!;
    expect(hint.origin).toBe('w-follower');
    expect(hint.intent).toBe('rename');
    expect(hint.taskId).toBe(Object.keys(leader.getState().project.core.tasks)[0]);
  });

  it('ensureView は冪等（2 回目は project が実質不変）', () => {
    const leader = createAppStore();
    leader.getState().ensureView('large', undefined);
    const once = serializeProject(leader.getState().project);
    leader.getState().ensureView('large', undefined);
    const twice = serializeProject(leader.getState().project);
    expect(twice).toBe(once);
    expect(
      leader.getState().project.flow.byLevel.filter((v) => v.level === 'large' && !v.scopeParentId),
    ).toHaveLength(1);
  });

  it('往復: フォロワーの編集がリーダーで適用され、両窓へ反映される', () => {
    const leader = createAppStore();
    const follower = createAppStore();
    const { a, b } = pairChannels();
    createLeaderSync(leader, { channel: a, debounceMs: 0 });
    createFollowerSync(follower, { channel: b, windowId: 'w-follower' });

    follower.getState().addTask('受付'); // 転送 → リーダー適用 → snapshot 返送
    expect(Object.values(leader.getState().project.core.tasks).map((t) => t.name)).toEqual(['受付']);
    expect(Object.values(follower.getState().project.core.tasks).map((t) => t.name)).toEqual(['受付']);
    expect(follower.getState().canUndo).toBe(true); // リーダーの履歴状態が届く
  });

  it('shouldHandleFocus は origin 一致の窓だけ true', () => {
    expect(shouldHandleFocus({ origin: 'w1', intent: 'rename', seq: 1 }, 'w1')).toBe(true);
    expect(shouldHandleFocus({ origin: 'w1', intent: 'rename', seq: 1 }, 'w2')).toBe(false);
    expect(shouldHandleFocus(null, 'w1')).toBe(false);
  });
});

describe('dualwindow S3: 発信元フォーカスヒントの後処理', () => {
  beforeEach(() => {
    useUI.setState({ renameRequest: null, inspectorOpen: false });
    useApp.getState().newProject();
  });

  it('rename: 対象ペインへ renameRequest を立てる（surface を引き継ぐ）', () => {
    runFocusHint({ taskId: 't1', origin: 'w', intent: 'rename', surface: 'table', seq: 3 });
    expect(useUI.getState().renameRequest).toMatchObject({ taskId: 't1', surface: 'table' });
    runFocusHint({ taskId: 't2', origin: 'w', intent: 'rename', surface: 'flow', seq: 4 });
    expect(useUI.getState().renameRequest).toMatchObject({ taskId: 't2', surface: 'flow' });
  });

  it('inspector: 対象を選択して詳細を開く / select: 選択のみ', () => {
    useApp.getState().addTask('A');
    const id = Object.keys(useApp.getState().project.core.tasks)[0]!;
    runFocusHint({ taskId: id, origin: 'w', intent: 'inspector', seq: 1 });
    expect(useApp.getState().selectedTaskId).toBe(id);
    expect(useUI.getState().inspectorOpen).toBe(true);

    useUI.setState({ inspectorOpen: false });
    useApp.getState().select(undefined);
    runFocusHint({ taskId: id, origin: 'w', intent: 'select', seq: 2 });
    expect(useApp.getState().selectedTaskId).toBe(id);
    expect(useUI.getState().inspectorOpen).toBe(false); // select は詳細を開かない
  });

  it('往復: フォロワーのフロー作成でリーダーが focusHint を返し、発信元窓が renameRequest を得る', () => {
    const leader = createAppStore();
    const follower = createAppStore();
    const { a, b } = pairChannels();
    createLeaderSync(leader, { channel: a, debounceMs: 0 });
    createFollowerSync(follower, { channel: b, windowId: 'w-follower', activePane: () => 'flow' });
    useUI.setState({ renameRequest: null });

    follower.getState().addTaskAt(300, 40); // フロー面での作成（rename intent・surface=flow）
    // リーダーで作成され、両窓へ反映され、発信元（フォロワー窓＝この JS 実行文脈）が renameRequest を得る
    const created = Object.keys(leader.getState().project.core.tasks)[0]!;
    expect(Object.keys(follower.getState().project.core.tasks)).toContain(created);
    expect(useUI.getState().renameRequest).toMatchObject({ taskId: created, surface: 'flow' });
  });

  it('別窓（origin 不一致）の focusHint では発火しない', () => {
    const leader = createAppStore();
    const follower = createAppStore();
    const { a, b } = pairChannels();
    createLeaderSync(leader, { channel: a, debounceMs: 0 });
    createFollowerSync(follower, { channel: b, windowId: 'w-A', activePane: () => 'flow' });
    useUI.setState({ renameRequest: null });

    // リーダー側で別窓 origin の focusHint を直接立てて配信 → follower(w-A) は origin 不一致で無視
    leader.setState({ focusHint: { taskId: 'zzz', origin: 'w-OTHER', intent: 'rename', surface: 'flow', seq: 99 } });
    leader.getState().addTask('trigger'); // 変化を起こして snapshot を配らせる
    expect(useUI.getState().renameRequest).toBeNull();
  });
});
