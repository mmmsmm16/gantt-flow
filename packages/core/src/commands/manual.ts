// 手順書（Manual）コマンド群。すべて純粋: (project, ...) => project'（manual のみ更新。core/details/flow は触らない）。
// commands/index.ts の流儀（clone=structuredClone、read-merge-write の updateTaskToBe）に合わせる。
import type {
  Project,
  Id,
  ProcedureDoc,
  ProcedureStep,
  StepCond,
  StepRef,
  StepImage,
  AssetLocator,
  AssetRef,
} from '../model/types';
import type { IdGen } from '../ids';

const clone = <T>(x: T): T => structuredClone(x);

// 対象工程の手順書を確保する。工程が実在しない場合は作らず null を返す（呼び出し側は no-op で返す）。
function ensureProc(p: Project, taskId: Id): ProcedureDoc | null {
  if (!p.core.tasks[taskId]) return null;
  let d = p.manual.procedures[taskId];
  if (!d) {
    d = { taskId, steps: [], updatedAt: '', revisions: [] };
    p.manual.procedures[taskId] = d;
  }
  return d;
}

const findStep = (d: ProcedureDoc, stepId: Id): ProcedureStep | undefined =>
  d.steps.find((s) => s.id === stepId);

// キー存在ベース read-merge-write（updateTaskToBe と同じ規約: 値が undefined のキーは削除、
// patch に無いキーは保持する）。
function mergePatch<T extends object>(target: T, patch: Partial<Record<keyof T, unknown>>): void {
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) delete (target as Record<string, unknown>)[k];
    else (target as Record<string, unknown>)[k] = v;
  }
}

// ---- ProcedureDoc レベル ----

export function upsertProcedure(p: Project, taskId: Id, patch: { purpose?: string }, now: string): Project {
  const next = clone(p);
  const d = ensureProc(next, taskId);
  if (!d) return next;
  if ('purpose' in patch) {
    if (patch.purpose === undefined || patch.purpose === '') delete d.purpose;
    else d.purpose = patch.purpose;
  }
  d.updatedAt = now;
  return next;
}

export function deleteProcedure(p: Project, taskId: Id): Project {
  const next = clone(p);
  delete next.manual.procedures[taskId];
  return next;
}

export function addProcedureRevision(
  p: Project,
  taskId: Id,
  rev: { note?: string; by?: string },
  now: string,
): Project {
  const next = clone(p);
  const d = ensureProc(next, taskId);
  if (!d) return next;
  d.revisions.push({ at: now, ...(rev.note ? { note: rev.note } : {}), ...(rev.by ? { by: rev.by } : {}) });
  d.updatedAt = now;
  return next;
}

// ---- Step ----

export function addStep(
  p: Project,
  taskId: Id,
  args: { action: string; why?: string; bodyMd?: string; id?: Id; atIndex?: number },
  idGen: IdGen,
  now: string,
): Project {
  const next = clone(p);
  const d = ensureProc(next, taskId);
  if (!d) return next;
  const step: ProcedureStep = {
    id: args.id ?? idGen(),
    action: args.action,
    ...(args.why ? { why: args.why } : {}),
    ...(args.bodyMd ? { bodyMd: args.bodyMd } : {}),
    conds: [],
    refs: [],
    images: [],
  };
  const at = args.atIndex ?? d.steps.length;
  d.steps.splice(Math.max(0, Math.min(d.steps.length, at)), 0, step);
  d.updatedAt = now;
  return next;
}

export function updateStep(
  p: Project,
  taskId: Id,
  stepId: Id,
  patch: { action?: string; why?: string; bodyMd?: string },
  now: string,
): Project {
  const next = clone(p);
  const d = next.manual.procedures[taskId];
  const s = d && findStep(d, stepId);
  if (!d || !s) return next;
  mergePatch(s, patch);
  d.updatedAt = now;
  return next;
}

export function removeStep(p: Project, taskId: Id, stepId: Id, now: string): Project {
  const next = clone(p);
  const d = next.manual.procedures[taskId];
  if (!d) return next;
  d.steps = d.steps.filter((s) => s.id !== stepId);
  d.updatedAt = now;
  return next;
}

export function moveStep(p: Project, taskId: Id, stepId: Id, toIndex: number, now: string): Project {
  const next = clone(p);
  const d = next.manual.procedures[taskId];
  if (!d) return next;
  const from = d.steps.findIndex((s) => s.id === stepId);
  if (from < 0) return next;
  const to = Math.max(0, Math.min(d.steps.length - 1, toIndex));
  if (to === from) return next;
  const [m] = d.steps.splice(from, 1);
  d.steps.splice(to, 0, m!);
  d.updatedAt = now;
  return next;
}

// ---- StepCond ----

export function addStepCond(
  p: Project,
  taskId: Id,
  stepId: Id,
  args: { when: string; thenMd: string; targetTaskId?: Id; id?: Id },
  idGen: IdGen,
  now: string,
): Project {
  const next = clone(p);
  const d = next.manual.procedures[taskId];
  const s = d && findStep(d, stepId);
  if (!d || !s) return next;
  const cond: StepCond = {
    id: args.id ?? idGen(),
    when: args.when,
    thenMd: args.thenMd,
    ...(args.targetTaskId ? { targetTaskId: args.targetTaskId } : {}),
  };
  s.conds.push(cond);
  d.updatedAt = now;
  return next;
}

export function updateStepCond(
  p: Project,
  taskId: Id,
  stepId: Id,
  condId: Id,
  patch: { when?: string; thenMd?: string; targetTaskId?: Id },
  now: string,
): Project {
  const next = clone(p);
  const d = next.manual.procedures[taskId];
  const s = d && findStep(d, stepId);
  const c = s?.conds.find((c) => c.id === condId);
  if (!d || !s || !c) return next;
  mergePatch(c, patch);
  d.updatedAt = now;
  return next;
}

export function removeStepCond(p: Project, taskId: Id, stepId: Id, condId: Id, now: string): Project {
  const next = clone(p);
  const d = next.manual.procedures[taskId];
  const s = d && findStep(d, stepId);
  if (!d || !s) return next;
  s.conds = s.conds.filter((c) => c.id !== condId);
  d.updatedAt = now;
  return next;
}

// ---- StepRef（StepRef は id を持たないので index で削除） ----

export function addStepRef(p: Project, taskId: Id, stepId: Id, ref: StepRef, now: string): Project {
  const next = clone(p);
  const d = next.manual.procedures[taskId];
  const s = d && findStep(d, stepId);
  if (!d || !s) return next;
  const dup = s.refs.some((r) => JSON.stringify(r) === JSON.stringify(ref));
  if (dup) return next; // 完全一致の重複は張らない（no-op）
  s.refs.push(ref);
  d.updatedAt = now;
  return next;
}

export function removeStepRef(p: Project, taskId: Id, stepId: Id, index: number, now: string): Project {
  const next = clone(p);
  const d = next.manual.procedures[taskId];
  const s = d && findStep(d, stepId);
  if (!d || !s) return next;
  if (index < 0 || index >= s.refs.length) return next;
  s.refs.splice(index, 1);
  d.updatedAt = now;
  return next;
}

// ---- StepImage ----

export function addStepImage(
  p: Project,
  taskId: Id,
  stepId: Id,
  img: { file: string; caption?: string; id?: Id },
  idGen: IdGen,
  now: string,
): Project {
  const next = clone(p);
  const d = next.manual.procedures[taskId];
  const s = d && findStep(d, stepId);
  if (!d || !s) return next;
  const image: StepImage = {
    id: img.id ?? idGen(),
    file: img.file,
    ...(img.caption ? { caption: img.caption } : {}),
  };
  s.images.push(image);
  d.updatedAt = now;
  return next;
}

export function updateStepImage(
  p: Project,
  taskId: Id,
  stepId: Id,
  imageId: Id,
  patch: { caption?: string },
  now: string,
): Project {
  const next = clone(p);
  const d = next.manual.procedures[taskId];
  const s = d && findStep(d, stepId);
  const img = s?.images.find((i) => i.id === imageId);
  if (!d || !s || !img) return next;
  mergePatch(img, patch);
  d.updatedAt = now;
  return next;
}

export function removeStepImage(p: Project, taskId: Id, stepId: Id, imageId: Id, now: string): Project {
  const next = clone(p);
  const d = next.manual.procedures[taskId];
  const s = d && findStep(d, stepId);
  if (!d || !s) return next;
  s.images = s.images.filter((i) => i.id !== imageId);
  d.updatedAt = now;
  return next;
}

// ---- 資料台帳 assets ----

export function upsertAsset(
  p: Project,
  args: { id?: Id; name: string; desc?: string; locator?: AssetLocator },
  idGen: IdGen,
): Project {
  const next = clone(p);
  const id = args.id ?? idGen();
  const asset: AssetRef = {
    id,
    name: args.name,
    ...(args.desc ? { desc: args.desc } : {}),
    ...(args.locator ? { locator: args.locator } : {}),
  };
  next.manual.assets[id] = asset;
  return next;
}

export function updateAsset(
  p: Project,
  assetId: Id,
  patch: { name?: string; desc?: string; locator?: AssetLocator | undefined },
): Project {
  const next = clone(p);
  const a = next.manual.assets[assetId];
  if (!a) return next;
  mergePatch(a, patch);
  return next;
}

export function removeAsset(p: Project, assetId: Id): Project {
  const next = clone(p);
  delete next.manual.assets[assetId];
  return next;
}
