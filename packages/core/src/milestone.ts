// マイルストーン判定の単一ヘルパ。ガード・集計・同期・描画のすべてがこれを参照する。
import type { Core, Id } from './model/types';

export function isMilestone(core: Core, id: Id | undefined): boolean {
  return !!id && core.tasks[id]?.kind === 'milestone';
}
