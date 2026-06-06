import { describe, it, expect } from 'vitest';
import { addTask, addAssignee, addIoItem, addIssueItem, setAssignee } from '../src/commands';
import { reconcileFlow } from '../src/sync/reconcileFlow';
import {
  serializeProject,
  deserializeProject,
  tryDeserializeProject,
} from '../src/persistence/json';
import { migrate, CURRENT_SCHEMA_VERSION, type Migration } from '../src/persistence/migrate';
import type { Project } from '../src/model/types';
import { counter, emptyProject, taskIdByName, assigneeIdByName } from './helpers';

// reconcile 済みのフローを含む、それなりに中身のある Project を作る
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

describe('persistence: JSON ラウンドトリップ', () => {
  it('serialize → deserialize で元と一致（updatedAt 等も含め同一）', () => {
    const p = sampleProject();
    const back = deserializeProject(serializeProject(p));
    expect(back).toEqual(p);
  });

  it('壊れた JSON / スキーマ不一致は弾く', () => {
    expect(tryDeserializeProject('{ not json').ok).toBe(false);
    // schemaVersion を欠いた不正データ
    const bad = JSON.stringify({ meta: {}, core: {} });
    expect(tryDeserializeProject(bad).ok).toBe(false);
  });

  it('必須フィールド欠落（task.level）を検出', () => {
    const p = sampleProject();
    const raw = JSON.parse(serializeProject(p));
    const firstTaskId = Object.keys(raw.core.tasks)[0]!;
    delete raw.core.tasks[firstTaskId].level;
    expect(tryDeserializeProject(JSON.stringify(raw)).ok).toBe(false);
  });
});

describe('persistence: マイグレーション', () => {
  it('現行版データのマイグレーションは no-op', () => {
    const p = sampleProject();
    const raw = JSON.parse(serializeProject(p));
    expect(migrate(raw)).toEqual(raw);
    expect(raw.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
  });

  it('注入したマイグレーションが版の昇順に適用され schemaVersion を引き上げる', () => {
    const list: Migration[] = [
      { to: 1, up: (r) => ({ ...r, a: 1 }) },
      { to: 2, up: (r) => ({ ...r, b: 2 }) },
    ];
    const out = migrate({ schemaVersion: 0 }, list);
    expect(out).toMatchObject({ a: 1, b: 2, schemaVersion: 2 });
  });

  it('deserialize は読込時にマイグレーションを適用する', () => {
    const p = sampleProject();
    const raw = JSON.parse(serializeProject(p));
    // 故意に古いデータを作る（v0 で title 欠落 → v1 で補完するマイグレーション）
    raw.schemaVersion = 0;
    delete raw.meta.title;
    const list: Migration[] = [
      { to: 1, up: (r) => ({ ...r, meta: { ...(r.meta as object), title: '復旧' } }) },
    ];
    const back = deserializeProject(JSON.stringify(raw), { migrations: list });
    expect(back.meta.title).toBe('復旧');
    expect(back.schemaVersion).toBe(1);
  });
});
