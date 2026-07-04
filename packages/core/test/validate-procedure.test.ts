import { describe, expect, it } from 'vitest';
import { counter, emptyProject } from './helpers';
import { addTask, upsertProcedure, addStep, addStepCond, addStepRef, deleteTaskKeepChildren } from '../src/commands';
import { validate } from '../src/validate';
import { deserializeProject, serializeProject } from '../src/persistence/json';

const NOW = '2026-07-05T00:00:00.000Z';

describe('validate: 手順書 warning 3 ルール', () => {
  it('procedure.nonLeaf: 子を持つ工程に手順書があると warning（FATAL ではない）', () => {
    const g = counter();
    let p = emptyProject();
    p = addTask(p, { name: '中', level: 'medium', id: 'M' }, g);
    p = addTask(p, { name: '小', level: 'small', parentId: 'M', id: 'A' }, g);
    const out = upsertProcedure(p, 'M', { purpose: 'x' }, NOW);

    const issues = validate(out);
    expect(issues.some((i) => i.kind === 'procedure.nonLeaf' && i.ref === 'M')).toBe(true);

    expect(() => deserializeProject(serializeProject(out), { integrity: 'strict' })).not.toThrow();
  });

  it('procedure.danglingTarget: cond の飛び先工程が消えても warning に留まる', () => {
    const g = counter();
    let p = emptyProject();
    p = addTask(p, { name: '中', level: 'medium', id: 'M' }, g);
    p = addTask(p, { name: 'A', level: 'small', parentId: 'M', id: 'A' }, g);
    p = addTask(p, { name: 'B', level: 'small', parentId: 'M', id: 'B' }, g);
    let out = upsertProcedure(p, 'A', {}, NOW);
    out = addStep(out, 'A', { action: '確認する' }, g, NOW);
    const stepId = out.manual.procedures.A!.steps[0]!.id;
    out = addStepCond(out, 'A', stepId, { when: '不備あり', thenMd: '差し戻す', targetTaskId: 'B' }, g, NOW);
    out = deleteTaskKeepChildren(out, 'B');

    const issues = validate(out);
    expect(issues.some((i) => i.kind === 'procedure.danglingTarget' && i.ref === stepId)).toBe(true);

    expect(() => deserializeProject(serializeProject(out), { integrity: 'strict' })).not.toThrow();
  });

  it('procedure.danglingAsset: 資料台帳に無い assetId 参照は warning に留まる', () => {
    const g = counter();
    let p = emptyProject();
    p = addTask(p, { name: 'A', level: 'medium', id: 'A' }, g);
    let out = upsertProcedure(p, 'A', {}, NOW);
    out = addStep(out, 'A', { action: '確認する' }, g, NOW);
    const stepId = out.manual.procedures.A!.steps[0]!.id;
    out = addStepRef(out, 'A', stepId, { kind: 'asset', assetId: 'ghost' }, NOW);

    const issues = validate(out);
    expect(issues.some((i) => i.kind === 'procedure.danglingAsset' && i.ref === stepId)).toBe(true);

    expect(() => deserializeProject(serializeProject(out), { integrity: 'strict' })).not.toThrow();
  });
});
