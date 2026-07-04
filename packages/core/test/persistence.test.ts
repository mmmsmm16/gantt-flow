import { describe, it, expect } from 'vitest';
import { addTask, addAssignee, addIoItem, addIssueItem, setAssignee } from '../src/commands';
import { reconcileFlow } from '../src/sync/reconcileFlow';
import {
  serializeProject,
  deserializeProject,
  tryDeserializeProject,
  isSchemaVersionTooNewError,
  isProjectIntegrityError,
  ProjectIntegrityError,
} from '../src/persistence/json';
import { migrate, CURRENT_SCHEMA_VERSION, type Migration } from '../src/persistence/migrate';
import { ProjectSchema } from '../src/model/schema';
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

  it('工程カラー(fillColor/textColor)がラウンドトリップで保持される', () => {
    let p = sampleProject();
    const id = taskIdByName(p, '受付');
    p = { ...p, details: { ...p.details, [id]: { ...p.details[id]!, fillColor: 'red' as const, textColor: 'blue' as const } } };
    const back = deserializeProject(serializeProject(p));
    expect(back.details[id]!.fillColor).toBe('red');
    expect(back.details[id]!.textColor).toBe('blue');
    // 不正な色名はスキーマで弾かれる
    const raw = JSON.parse(serializeProject(p));
    raw.details[id].fillColor = 'magenta';
    expect(tryDeserializeProject(JSON.stringify(raw)).ok).toBe(false);
  });

  it('付箋(comment)の targetNodeId は保持され、旧ファイル(未設定)もそのまま読める', () => {
    const p = sampleProject();
    const view = p.flow.byLevel[0]!;
    const task = Object.values(view.nodes).find((n) => n.kind === 'task')!;
    view.nodes['cmt-old'] = { id: 'cmt-old', kind: 'comment', text: '旧メモ', x: 10, y: 10 };
    view.nodes['cmt-new'] = {
      id: 'cmt-new',
      kind: 'comment',
      text: '新メモ',
      x: 20,
      y: 20,
      targetNodeId: task.id,
    };
    const back = deserializeProject(serializeProject(p));
    const bv = back.flow.byLevel[0]!;
    const oldC = bv.nodes['cmt-old']!;
    const newC = bv.nodes['cmt-new']!;
    expect(oldC.kind === 'comment' && oldC.targetNodeId).toBeUndefined(); // 後方互換（未設定OK）
    expect(newC.kind === 'comment' && newC.targetNodeId).toBe(task.id); // 新フィールドは保持
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

describe('persistence: 新しすぎる schemaVersion の拒否', () => {
  it('schemaVersion が対応版より大きいファイルは読み込まない（未知フィールドの黙殺を防ぐ）', () => {
    const raw = JSON.parse(serializeProject(sampleProject()));
    raw.schemaVersion = CURRENT_SCHEMA_VERSION + 1;
    raw.futureField = { added: 'by-newer-app' }; // 新版が追加したフィールド（strip で消えてはいけない）
    const res = tryDeserializeProject(JSON.stringify(raw));
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(isSchemaVersionTooNewError(res.error)).toBe(true);
      expect((res.error as Error).message).toContain('新しいバージョンの gantt-flow');
    }
  });

  it('現行版ちょうどのファイルは読み込める', () => {
    const p = sampleProject();
    expect(p.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    expect(tryDeserializeProject(serializeProject(p)).ok).toBe(true);
  });

  it('注入したマイグレーションが対応する版までは新しい版でも読み込める', () => {
    const raw = JSON.parse(serializeProject(sampleProject()));
    raw.schemaVersion = CURRENT_SCHEMA_VERSION + 1;
    const list: Migration[] = [{ to: CURRENT_SCHEMA_VERSION + 1, up: (r) => r }];
    expect(tryDeserializeProject(JSON.stringify(raw), { migrations: list }).ok).toBe(true);
  });
});

describe('persistence: 参照整合性の検証（読込時）', () => {
  it('親子循環のあるファイルは ProjectIntegrityError で拒否する', () => {
    const raw = JSON.parse(serializeProject(sampleProject()));
    raw.core.tasks['x1'] = { id: 'x1', name: '循環A', parentId: 'x2', level: 'small', order: 0 };
    raw.core.tasks['x2'] = { id: 'x2', name: '循環B', parentId: 'x1', level: 'medium', order: 1 };
    const res = tryDeserializeProject(JSON.stringify(raw));
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(isProjectIntegrityError(res.error)).toBe(true);
      const err = res.error as ProjectIntegrityError;
      expect(err.message).toContain('参照整合性');
      expect(err.issues.some((i) => i.kind === 'task.cycle')).toBe(true);
    }
  });

  it('依存の端点が存在しないファイルは拒否する', () => {
    const p = sampleProject();
    const raw = JSON.parse(serializeProject(p));
    raw.core.dependencies['d-bad'] = {
      id: 'd-bad',
      from: 'ghost-task',
      to: taskIdByName(p, '受付'),
      type: 'FS',
    };
    const res = tryDeserializeProject(JSON.stringify(raw));
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(isProjectIntegrityError(res.error)).toBe(true);
      expect((res.error as ProjectIntegrityError).issues.some((i) => i.kind === 'dependency.from')).toBe(true);
    }
  });

  it('parentId が存在しないファイルは拒否する', () => {
    const raw = JSON.parse(serializeProject(sampleProject()));
    raw.core.tasks['x1'] = { id: 'x1', name: '迷子', parentId: 'ghost-parent', level: 'small', order: 0 };
    const res = tryDeserializeProject(JSON.stringify(raw));
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(isProjectIntegrityError(res.error)).toBe(true);
      expect((res.error as ProjectIntegrityError).issues.some((i) => i.kind === 'task.parent')).toBe(true);
    }
  });
});

describe('persistence: integrity "lenient"（復旧経路向け）', () => {
  it('参照破綻のあるデータも lenient なら読み込める（既定の strict は拒否）', () => {
    const p = sampleProject();
    const raw = JSON.parse(serializeProject(p));
    raw.core.dependencies['d-bad'] = {
      id: 'd-bad',
      from: 'ghost-task',
      to: taskIdByName(p, '受付'),
      type: 'FS',
    };
    const json = JSON.stringify(raw);
    const strict = tryDeserializeProject(json);
    expect(strict.ok).toBe(false); // 既定（明示的な「開く」）は従来どおり拒否
    if (!strict.ok) expect(isProjectIntegrityError(strict.error)).toBe(true);
    const back = deserializeProject(json, { integrity: 'lenient' });
    expect(back.core.dependencies['d-bad']).toBeDefined(); // 救出できる
  });

  it('lenient でも Zod の構造検証と版チェックは維持される', () => {
    // 構造不正は lenient でも弾く
    const bad = JSON.stringify({ meta: {}, core: {} });
    expect(tryDeserializeProject(bad, { integrity: 'lenient' }).ok).toBe(false);
    // 新しすぎる版も lenient でも弾く（未知フィールドの黙殺を防ぐ）
    const raw = JSON.parse(serializeProject(sampleProject()));
    raw.schemaVersion = CURRENT_SCHEMA_VERSION + 1;
    const res = tryDeserializeProject(JSON.stringify(raw), { integrity: 'lenient' });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(isSchemaVersionTooNewError(res.error)).toBe(true);
  });
});

describe('persistence: 数値フィールドの有限値検証', () => {
  // JSON は Infinity/NaN を表現できないので、メモリ上のオブジェクトを直接 parse して検証する
  it('effortMinutes の Infinity/NaN はスキーマで弾く', () => {
    const p = sampleProject();
    const id = taskIdByName(p, '受付');
    const inf = { ...p, details: { ...p.details, [id]: { ...p.details[id]!, effortMinutes: Infinity } } };
    expect(ProjectSchema.safeParse(inf).success).toBe(false);
    const nan = { ...p, details: { ...p.details, [id]: { ...p.details[id]!, effortMinutes: NaN } } };
    expect(ProjectSchema.safeParse(nan).success).toBe(false);
  });

  it('ノード座標の Infinity はスキーマで弾く', () => {
    const p = sampleProject();
    const raw = JSON.parse(serializeProject(p));
    const view = raw.flow.byLevel[0];
    const nodeId = Object.keys(view.nodes)[0]!;
    view.nodes[nodeId].x = Infinity;
    expect(ProjectSchema.safeParse(raw).success).toBe(false);
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
