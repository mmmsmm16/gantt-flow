// 選択タスクの詳細編集(担当・I/O・課題・依存・コード)。サンプルを seed し、
// I/O や課題が最も多いタスクを選択してリッチな状態を見せる。
import { Inspector, useApp } from '@gantt-flow/desktop';

useApp.getState().loadSample();
{
  const p = useApp.getState().project;
  const tasks = Object.values(p.core.tasks);
  const score = (t: { id: string }) => {
    const d = (p.details as Record<string, { io?: unknown[]; issues?: unknown[] }>)?.[t.id];
    return (d?.io?.length ?? 0) + (d?.issues?.length ?? 0);
  };
  const pick = tasks.slice().sort((a, b) => score(b) - score(a))[0] ?? tasks[0];
  if (pick) useApp.getState().select(pick.id);
}

export const Selected = () => (
  <div style={{ width: 380, height: 620, overflow: 'auto', background: 'var(--panel)', borderLeft: '1px solid var(--line)' }}>
    <Inspector />
  </div>
);
