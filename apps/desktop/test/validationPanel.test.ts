// 検証パネルの純ロジック（groupLintIssues / planLintJump / summarizeForExport）。
import { describe, it, expect } from 'vitest';
import type { Core, LintIssue } from '@gantt-flow/core';
import { groupLintIssues, planLintJump, summarizeForExport } from '../src/validationPanel';

const issue = (over: Partial<LintIssue>): LintIssue => ({
  kind: 'x',
  category: 'procedure',
  severity: 'warn',
  ref: 'r',
  message: 'm',
  ...over,
});

const coreWith = (tasks: Core['tasks']): Core => ({ tasks, dependencies: {}, assignees: {} });

describe('groupLintIssues', () => {
  it('固定順（integrity→procedure→assignee→effort→issue）で束ね、0件セクションは省略', () => {
    const issues: LintIssue[] = [
      issue({ category: 'issue', taskId: 'A', ref: 'i1' }),
      issue({ category: 'integrity', taskId: 'B', ref: 'g1' }),
      issue({ category: 'assignee', taskId: 'C', ref: 'c1' }),
    ];
    const groups = groupLintIssues(issues);
    expect(groups.map((g) => g.category)).toEqual(['integrity', 'assignee', 'issue']);
    expect(groups.map((g) => g.label)).toEqual(['整合性', '担当未割当', '方策未記入']);
    // procedure/effort は 0 件なので現れない。
    expect(groups.every((g) => g.issues.length > 0)).toBe(true);
  });

  it('空配列は空のセクション配列', () => {
    expect(groupLintIssues([])).toEqual([]);
  });
});

describe('planLintJump', () => {
  it('procedure カテゴリは手順書タブへ（midId は midOf 由来）', () => {
    // A は M の子（葉）→ midId=M。
    const core = coreWith({
      M: { id: 'M', name: 'M', level: 'medium', order: 0 },
      A: { id: 'A', name: 'A', level: 'small', order: 0, parentId: 'M' },
    });
    expect(planLintJump(issue({ category: 'procedure', taskId: 'A' }), core)).toEqual({
      kind: 'procedure',
      taskId: 'A',
      midId: 'M',
    });
  });

  it('procedure 以外で taskId 実在なら工程表ジャンプ', () => {
    const core = coreWith({ A: { id: 'A', name: 'A', level: 'medium', order: 0 } });
    expect(planLintJump(issue({ category: 'assignee', taskId: 'A' }), core)).toEqual({
      kind: 'table',
      taskId: 'A',
    });
  });

  it('taskId 未解決（整合性の孤児など）はジャンプ不可', () => {
    const core = coreWith({ A: { id: 'A', name: 'A', level: 'medium', order: 0 } });
    expect(planLintJump(issue({ category: 'integrity', taskId: undefined }), core)).toEqual({
      kind: 'none',
    });
    // 実在しない taskId も none。
    expect(planLintJump(issue({ category: 'integrity', taskId: 'ghost' }), core)).toEqual({
      kind: 'none',
    });
  });
});

describe('summarizeForExport', () => {
  it('0 件は null', () => {
    expect(summarizeForExport([])).toBeNull();
  });

  it('固定順で「ラベル n件」を・で連結', () => {
    const issues: LintIssue[] = [
      issue({ category: 'procedure', taskId: 'A' }),
      issue({ category: 'procedure', taskId: 'B' }),
      issue({ category: 'procedure', taskId: 'C' }),
      issue({ category: 'assignee', taskId: 'A' }),
      issue({ category: 'assignee', taskId: 'B' }),
    ];
    expect(summarizeForExport(issues)).toBe('手順書未作成 3件・担当未割当 2件');
  });
});
