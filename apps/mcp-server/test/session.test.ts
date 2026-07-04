import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  addTask,
  addDependency,
  updateTaskDetail,
  updateTaskToBe,
  serializeProject,
  computeCompare,
  uuid,
  type Project,
} from '@gantt-flow/core';
import { Workspace, NoProjectError } from '../src/session.js';
import { loadProjectFile } from '../src/fileio.js';
import type { FlowTaskNode } from '@gantt-flow/core';
import { formatTaskTree, formatCompare, formatFlowMermaid } from '../src/format.js';
import {
  setNodePosition,
  pinNode,
  autoLayout,
  setOrientation,
  findFlowView,
  formatFlowLayout,
} from '../src/geometry.js';

let dir: string;
const path = () => join(dir, 'proj.gflow');

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'gf-mcp-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** ディスクへ書き戻された Project を読み直す（write-through の検証用。v2 ZIP/旧 JSON 両対応）。 */
async function reload(p: string): Promise<Project> {
  return loadProjectFile(p);
}

describe('Workspace ライフサイクル', () => {
  it('未オープンで current() は NoProjectError', () => {
    const ws = new Workspace();
    expect(ws.has()).toBe(false);
    expect(() => ws.current()).toThrow(NoProjectError);
  });

  it('new_project: 空プロジェクトを作成・保存・再オープンできる（medium ビューを持つ）', async () => {
    const ws = new Workspace();
    const s = await ws.create(path(), { title: 'テスト' });
    expect(s.project.meta.title).toBe('テスト');
    // 保存済み: ディスクから厳密パースできる
    const onDisk = await reload(path());
    expect(onDisk.meta.title).toBe('テスト');
    // reconcile 済み: 何らかのフロービュー（medium）が用意されている
    expect(onDisk.flow.byLevel.length).toBeGreaterThan(0);
  });

  it('sample プロジェクトを作成できる', async () => {
    const ws = new Workspace();
    const s = await ws.create(path(), { sample: true });
    expect(Object.keys(s.project.core.tasks).length).toBeGreaterThan(0);
  });

  it('不正なファイルの open は throw する', async () => {
    await writeFile(path(), '{ not valid project }', 'utf8');
    const ws = new Workspace();
    await expect(ws.open(path())).rejects.toBeTruthy();
  });
});

describe('apply: write-through と reconcile 同期', () => {
  it('add_task → 依存追加でフローが同期され、ディスクへ保存される', async () => {
    const ws = new Workspace();
    const s = await ws.create(path(), { title: 'WT' });

    const a = uuid();
    const b = uuid();
    await s.apply((p) => addTask(p, { name: '工程A', level: 'medium', id: a }, uuid));
    await s.apply((p) => addTask(p, { name: '工程B', level: 'medium', id: b }, uuid));
    await s.apply((p) => addDependency(p, a, b, uuid));

    // メモリ上の状態
    expect(Object.keys(s.project.core.tasks)).toEqual(expect.arrayContaining([a, b]));
    expect(Object.values(s.project.core.dependencies).some((d) => d.from === a && d.to === b)).toBe(true);

    // ディスク上も一致（write-through）
    const onDisk = await reload(path());
    expect(Object.keys(onDisk.core.tasks)).toEqual(expect.arrayContaining([a, b]));

    // reconcile: medium ビューに A/B のタスクノードが生成されている
    const medium = onDisk.flow.byLevel.find((v) => v.level === 'medium');
    expect(medium).toBeTruthy();
    const taskNodeIds = Object.values(medium!.nodes)
      .filter((n) => n.kind === 'task')
      .map((n) => (n as { taskId: string }).taskId);
    expect(taskNodeIds).toEqual(expect.arrayContaining([a, b]));

    // updatedAt が更新される
    expect(onDisk.meta.updatedAt).toBeTruthy();
  });

  it('updateTaskDetail / updateTaskToBe が compare に反映される', async () => {
    const ws = new Workspace();
    const s = await ws.create(path(), { title: 'CMP' });
    const a = uuid();
    await s.apply((p) => addTask(p, { name: '作業', level: 'detail', id: a }, uuid));
    await s.apply((p) => updateTaskDetail(p, a, { effortMinutes: 120 }));
    await s.apply((p) => updateTaskToBe(p, a, { effortMinutes: 30 }));

    const c = computeCompare(s.project.core, s.project.details);
    expect(c.effortMinutes.asis).toBe(120);
    expect(c.effortMinutes.tobe).toBe(30);
    expect(c.effortMinutes.delta).toBe(-90);

    // フォーマッタが落ちない
    expect(formatCompare(s.project)).toContain('総工数');
    expect(formatTaskTree(s.project)).toContain('作業');
  });

  it('updateTaskToBe に null を渡すと差分が削除される', async () => {
    const ws = new Workspace();
    const s = await ws.create(path(), {});
    const a = uuid();
    await s.apply((p) => addTask(p, { name: 'x', level: 'detail', id: a }, uuid));
    await s.apply((p) => updateTaskToBe(p, a, { effortMinutes: 10 }));
    expect(s.project.details[a]?.toBe?.effortMinutes).toBe(10);
    // null（=undefined へ写像）で削除
    await s.apply((p) => updateTaskToBe(p, a, { effortMinutes: undefined }));
    expect(s.project.details[a]?.toBe?.effortMinutes).toBeUndefined();
  });

  it('get_flow_mermaid: 工程と依存が flowchart に出る', async () => {
    const ws = new Workspace();
    const s = await ws.create(path(), { title: 'FLOW' });
    const a = uuid();
    const b = uuid();
    await s.apply((p) => addTask(p, { name: '受注', level: 'medium', id: a }, uuid));
    await s.apply((p) => addTask(p, { name: '出荷', level: 'medium', id: b }, uuid));
    await s.apply((p) => addDependency(p, a, b, uuid));

    const mmd = formatFlowMermaid(s.project, 'medium');
    expect(mmd.startsWith('flowchart')).toBe(true);
    expect(mmd).toContain('受注');
    expect(mmd).toContain('出荷');
    expect(mmd).toContain('-->'); // A→B のエッジ
  });

  const taskNode = (p: Parameters<typeof findFlowView>[0], taskId: string) =>
    Object.values(findFlowView(p, 'medium')!.nodes).find(
      (n): n is FlowTaskNode => n.kind === 'task' && n.taskId === taskId,
    );

  it('set_node_position: 座標が reconcile/保存をまたいで保持される', async () => {
    const ws = new Workspace();
    const s = await ws.create(path(), { title: 'GEO' });
    const a = uuid();
    await s.apply((p) => addTask(p, { name: '受注', level: 'medium', id: a }, uuid));
    await s.apply(setNodePosition('medium', undefined, a, 333, 222));

    expect(taskNode(s.project, a)).toMatchObject({ x: 333, y: 222 });
    // ディスクからも同座標（reconcile が既存ノードの位置を保つ）
    const onDisk = await reload(path());
    const n2 = Object.values(onDisk.flow.byLevel.find((v) => v.level === 'medium')!.nodes).find(
      (n): n is FlowTaskNode => n.kind === 'task' && n.taskId === a,
    );
    expect(n2).toMatchObject({ x: 333, y: 222 });
  });

  it('pin_node・set_flow_orientation・auto_layout', async () => {
    const ws = new Workspace();
    const s = await ws.create(path(), {});
    const a = uuid();
    const b = uuid();
    await s.apply((p) => addTask(p, { name: 'A', level: 'medium', id: a }, uuid));
    await s.apply((p) => addTask(p, { name: 'B', level: 'medium', id: b }, uuid));
    await s.apply((p) => addDependency(p, a, b, uuid));

    await s.apply(pinNode('medium', undefined, a, true));
    expect(taskNode(s.project, a)?.pinned).toBe(true);

    await s.apply(setOrientation('medium', undefined, 'vertical'));
    expect(findFlowView(s.project, 'medium')!.orientation).toBe('vertical');

    await s.apply(autoLayout('medium', undefined)); // 例外なく整列でき、レイアウト文字列が得られる
    expect(formatFlowLayout(s.project, 'medium')).toContain('向き');
  });

  it('saveAs で別パスへ保存し追従先が変わる', async () => {
    const ws = new Workspace();
    await ws.create(path(), { title: 'A' });
    const other = join(dir, 'other.gflow');
    const s2 = await ws.saveAs(other);
    expect(s2.path).toBe(other);
    const onDisk = await loadProjectFile(other);
    expect(onDisk.meta.title).toBe('A');
  });

  it('旧 JSON ファイルを開け、保存で v2 (ZIP) になる', async () => {
    // 旧バージョンが書き出した単一 JSON ファイルを模す（seed で有効な Project を用意し、
    // 素の JSON テキストとして書き込む＝アプリを介さない「レガシー保存」相当）。
    const seedWs = new Workspace();
    const seed = await seedWs.create(join(dir, 'seed.gflow'), { title: 'レガシー' });
    const file = join(dir, 'legacy.gflow');
    await writeFile(file, serializeProject(seed.project), 'utf8');

    const ws = new Workspace();
    const s = await ws.open(file);
    expect(s.project.meta.title).toBe('レガシー');

    const a = uuid();
    await s.apply((p) => addTask(p, { name: '軽い編集', level: 'medium', id: a }, uuid));

    // ファイル先頭 2 バイトが 'PK'（保存で v2 ZIP 化された）
    const head = new Uint8Array(await readFile(file)).subarray(0, 2);
    expect(Array.from(head)).toEqual([0x50, 0x4b]);

    // 再オープンしても内容が一致（reload と deep-equal）
    const reopened = await ws.open(file);
    expect(reopened.project).toEqual(s.project);
  });
});
