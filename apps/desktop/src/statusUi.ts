// 「状況（ヒアリング進行）」の表示定義を一元化する（React 非依存）。
// FullTable / Inspector / FlowCanvas / StatusBar / Summary が同じラベル・クラス・選択肢を共有し、
// 文言や色クラスの表記ゆれを防ぐ。ステータスの意味論（未指定→todo）は core の effectiveStatus に委譲。
import type { TaskDetail, TaskStatus } from '@gantt-flow/core';
import { effectiveStatus } from '@gantt-flow/core';

// 状況の並び順（select の選択肢・凡例で共通）。
export const STATUS_ORDER: readonly TaskStatus[] = ['todo', 'heard', 'review', 'done'];

// 各状況の表示名（既存表記に従う。「聴取済/確認中」は使わない）。
export const STATUS_LABEL: Record<TaskStatus, string> = {
  todo: '未着手',
  heard: 'ヒアリング済',
  review: '確認待ち',
  done: '確定',
};

// select の選択肢（先頭の '' は「未設定」＝ '—'）。
export const STATUS_OPTIONS: { key: TaskStatus | ''; label: string }[] = [
  { key: '', label: '—' },
  ...STATUS_ORDER.map((key) => ({ key, label: STATUS_LABEL[key] })),
];

// select の色分けクラス（未設定は st-none で中立色）。見た目は従来どおり raw の status で決める。
export function statusSelectClass(detail: TaskDetail | undefined): string {
  return `st-${detail?.status ?? 'none'}`;
}

// フローの工程ノード用の描き分けクラス。未ヒアリング（effectiveStatus==='todo'）のみ点線。
export function hearingNodeClass(detail: TaskDetail | undefined): '' | ' st-unheard' {
  return effectiveStatus(detail) === 'todo' ? ' st-unheard' : '';
}
