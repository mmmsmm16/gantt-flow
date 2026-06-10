import { describe, it, expect } from 'vitest';
import { TEMPLATES } from '../src/templates';
import { validate } from '../src/validate';
import { ProjectSchema } from '../src/model/schema';
import { counter } from './helpers';

describe('TEMPLATES（業務テンプレート集）', () => {
  it('4 種類のテンプレートがあり key が一意', () => {
    expect(TEMPLATES.length).toBeGreaterThanOrEqual(4);
    expect(new Set(TEMPLATES.map((t) => t.key)).size).toBe(TEMPLATES.length);
  });

  for (const tpl of TEMPLATES) {
    it(`${tpl.title}: スキーマ適合・参照整合・決定論`, () => {
      const p = tpl.create(counter());
      expect(() => ProjectSchema.parse(p)).not.toThrow(); // 保存可能な正しい形
      expect(validate(p)).toEqual([]); // 参照整合性（壊れた依存・親などが無い）
      expect(tpl.create(counter())).toEqual(p); // 同じ idGen 入力なら同一出力

      // 実用最低限の中身: 部門レーン・複数の工程・前後関係・課題を含む
      const tasks = Object.values(p.core.tasks);
      expect(Object.keys(p.core.assignees).length).toBeGreaterThanOrEqual(3);
      expect(tasks.filter((t) => t.level === 'large').length).toBeGreaterThanOrEqual(3);
      expect(tasks.filter((t) => t.level === 'medium').length).toBeGreaterThanOrEqual(8);
      expect(Object.keys(p.core.dependencies).length).toBeGreaterThanOrEqual(3);
      expect(Object.values(p.details).some((d) => (d.issues?.length ?? 0) > 0)).toBe(true);
      // 既定で開く中ビューが用意されている
      expect(p.flow.byLevel.some((v) => v.level === 'medium')).toBe(true);
    });
  }
});
