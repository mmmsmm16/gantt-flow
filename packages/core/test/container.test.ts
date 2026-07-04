import { describe, it, expect } from 'vitest';
import { strToU8, zipSync } from 'fflate';
import { addTask, addAssignee, addIoItem, addIssueItem, setAssignee } from '../src/commands';
import { reconcileFlow } from '../src/sync/reconcileFlow';
import { serializeProject } from '../src/persistence/json';
import {
  ContainerFormatError,
  deserializeContainer,
  detectContainerFormat,
  serializeContainer,
  tryDeserializeContainer,
} from '../src/persistence/container';
import type { Project } from '../src/model/types';
import { counter, emptyProject, taskIdByName, assigneeIdByName } from './helpers';

// reconcile 済みのフローを含む、それなりに中身のある Project を作る（persistence.test.ts と同じ手段）
function sampleProject(): Project {
  const g = counter();
  let p = emptyProject();
  p = addAssignee(p, { name: '営業', kind: 'department' }, g);
  p = addTask(p, { name: '受付', level: 'medium' }, g);
  p = setAssignee(p, taskIdByName(p, '受付'), assigneeIdByName(p, '営業'));
  const id = taskIdByName(p, '受付');
  p = addIoItem(p, id, 'inputs', { name: '注文書', kind: 'doc', formInfo: '様式A' }, g);
  p = addIoItem(p, id, 'outputs', { name: '受付票', kind: 'doc' }, g);
  p = addIssueItem(p, id, { issue: '確認漏れ', measure: 'チェックリスト' }, g);
  const r = reconcileFlow(p.core, p.details, {
    level: 'medium',
    nodes: {},
    edges: {},
    lanes: {},
    orientation: 'horizontal',
  }, counter('n'));
  p.flow.byLevel.push(r.view);
  return p;
}

describe('container', () => {
  it('ZIP ラウンドトリップ: serialize→deserialize が deep-equal / format=zip', () => {
    const p = sampleProject();
    const bytes = serializeContainer(p);
    expect(bytes[0]).toBe(0x50); // 'P'
    expect(bytes[1]).toBe(0x4b); // 'K'
    const out = deserializeContainer(bytes);
    expect(out.format).toBe('zip');
    expect(out.project).toEqual(p);
    expect(out.assets).toEqual({});
  });

  it('assets ラウンドトリップ: バイト列がそのまま戻る', () => {
    const img = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3]);
    const bytes = serializeContainer(sampleProject(), { 'img-001.png': img });
    const out = deserializeContainer(bytes);
    expect(Object.keys(out.assets)).toEqual(['img-001.png']);
    expect(Array.from(out.assets['img-001.png']!)).toEqual(Array.from(img));
  });

  it('旧形式（単一 JSON バイト列）を読める / format=json', () => {
    const p = sampleProject();
    const out = deserializeContainer(strToU8(serializeProject(p)));
    expect(out.format).toBe('json');
    expect(out.project).toEqual(p);
  });

  it('UTF-8 BOM 付き旧 JSON も読める', () => {
    const p = sampleProject();
    const raw = strToU8(serializeProject(p));
    const withBom = new Uint8Array(raw.length + 3);
    withBom.set([0xef, 0xbb, 0xbf]);
    withBom.set(raw, 3);
    expect(deserializeContainer(withBom).project).toEqual(p);
  });

  it('出力はバイト安定（同一入力→同一バイト列）', () => {
    const p = sampleProject();
    const a = serializeContainer(p, { 'b.png': new Uint8Array([2]), 'a.png': new Uint8Array([1]) });
    const b = serializeContainer(p, { 'a.png': new Uint8Array([1]), 'b.png': new Uint8Array([2]) });
    expect(Array.from(a)).toEqual(Array.from(b));
  });

  it('project.json の無い ZIP / 不明形式は ContainerFormatError', () => {
    const noEntry = zipSync({ 'x.txt': strToU8('hello') });
    expect(() => deserializeContainer(noEntry)).toThrowError(ContainerFormatError);
    expect(detectContainerFormat(new Uint8Array([0, 1, 2]))).toBeNull();
    const r = tryDeserializeContainer(new Uint8Array([0, 1, 2]));
    expect(r.ok).toBe(false);
  });

  it('assets サブディレクトリ名 (a/b.png) が往復する', () => {
    const img = new Uint8Array([1, 2, 3]);
    const bytes = serializeContainer(sampleProject(), { 'a/b.png': img });
    const out = deserializeContainer(bytes);
    expect(Object.keys(out.assets)).toEqual(['a/b.png']);
    expect(Array.from(out.assets['a/b.png']!)).toEqual([1, 2, 3]);
  });

  it('assets 省略 ≡ {} でバイト同一', () => {
    const p = sampleProject();
    expect(Array.from(serializeContainer(p))).toEqual(Array.from(serializeContainer(p, {})));
  });

  it('assets の .. / 絶対パスのエントリを無視する（path traversal 予防）', () => {
    const evil = zipSync({
      'project.json': strToU8(serializeProject(sampleProject())),
      'assets/ok.png': new Uint8Array([9]),
      'assets/../evil.png': new Uint8Array([6, 6, 6]),
      'assets//abs.png': new Uint8Array([7]),
    });
    const out = deserializeContainer(evil);
    expect(Object.keys(out.assets)).toEqual(['ok.png']); // evil/abs は落とす
  });
});
