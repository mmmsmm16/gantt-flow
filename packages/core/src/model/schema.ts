// 読込時の型境界（`docs/05-persistence.md` §4）。Zod スキーマは `model/types.ts` の構造を反映する。
import { z } from 'zod';

const ProcessLevel = z.enum(['large', 'medium', 'small', 'detail']);

const ProcessTask = z.object({
  id: z.string(),
  name: z.string(),
  parentId: z.string().optional(),
  level: ProcessLevel,
  order: z.number().finite(),
  assigneeId: z.string().optional(),
  code: z.string().optional(),
});

const Dependency = z.object({
  id: z.string(),
  from: z.string(),
  to: z.string(),
  type: z.literal('FS'),
  scopeParentId: z.string().optional(),
});

const Assignee = z.object({
  id: z.string(),
  name: z.string(),
  kind: z.enum(['person', 'department']),
});

const Core = z.object({
  tasks: z.record(z.string(), ProcessTask),
  dependencies: z.record(z.string(), Dependency),
  assignees: z.record(z.string(), Assignee),
});

const IoItem = z.object({
  id: z.string(),
  name: z.string(),
  kind: z.enum(['doc', 'info']),
  formInfo: z.string().optional(),
  source: z.string().optional(),
});

const IssueTarget = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('task') }),
  z.object({ kind: z.literal('io'), ioId: z.string() }),
]);

const IssueItem = z.object({
  id: z.string(),
  issue: z.string(),
  measure: z.string().optional(),
  target: IssueTarget.optional(),
});

const TaskDetail = z.object({
  taskId: z.string(),
  how: z.string().optional(),
  inputs: z.array(IoItem).optional(),
  outputs: z.array(IoItem).optional(),
  system: z.string().optional(),
  effortMinutes: z.number().finite().optional(),
  ltDays: z.number().finite().optional(),
  note: z.string().optional(),
  volume: z.string().optional(),
  issues: z.array(IssueItem).optional(),
  exception: z.string().optional(),
  automation: z.enum(['manual', 'system', 'partial']).optional(),
  dataLink: z.string().optional(),
  regulation: z.string().optional(),
  difficulty: z.enum(['H', 'M', 'L']).optional(),
  status: z.enum(['todo', 'heard', 'review', 'done']).optional(),
  fillColor: z.enum(['red', 'orange', 'yellow', 'green', 'teal', 'blue', 'purple', 'gray']).optional(),
  textColor: z.enum(['red', 'orange', 'yellow', 'green', 'teal', 'blue', 'purple', 'gray']).optional(),
  toBe: z
    .object({
      effortMinutes: z.number().finite().optional(),
      ltDays: z.number().finite().optional(),
      difficulty: z.enum(['H', 'M', 'L']).optional(),
      automation: z.enum(['manual', 'system', 'partial']).optional(),
      rationale: z.string().optional(),
    })
    .optional(),
});

// Infinity/NaN は JSON にできず座標計算も壊すため有限値に限る
const xy = { id: z.string(), x: z.number().finite(), y: z.number().finite() };

const FlowNode = z.discriminatedUnion('kind', [
  z.object({
    ...xy,
    kind: z.literal('task'),
    taskId: z.string(),
    laneId: z.string().optional(),
    pinned: z.boolean().optional(),
  }),
  z.object({
    ...xy,
    kind: z.literal('control'),
    control: z.enum(['start', 'end', 'decision', 'merge']),
    label: z.string().optional(),
    laneId: z.string().optional(),
  }),
  z.object({
    ...xy,
    kind: z.literal('doc'),
    io: z.enum(['input', 'output']),
    taskId: z.string(),
    ioId: z.string(),
    laneId: z.string().optional(),
  }),
  z.object({
    ...xy,
    kind: z.literal('issue'),
    taskId: z.string(),
    issueId: z.string(),
    targetNodeId: z.string(),
    visible: z.boolean(),
  }),
  z.object({ ...xy, kind: z.literal('comment'), text: z.string(), laneId: z.string().optional() }),
]);

const FlowEdge = z.object({
  id: z.string(),
  source: z.string(),
  target: z.string(),
  label: z.string().optional(),
  derivedFromDependencyId: z.string().optional(),
  pinned: z.boolean().optional(),
  role: z.enum(['flow', 'ioLink']).optional(),
});

const Swimlane = z.object({
  id: z.string(),
  assigneeId: z.string().optional(),
  title: z.string(),
  order: z.number().finite(),
  height: z.number().finite().optional(),
});

const FlowLevelView = z.object({
  level: ProcessLevel,
  scopeParentId: z.string().optional(),
  nodes: z.record(z.string(), FlowNode),
  edges: z.record(z.string(), FlowEdge),
  lanes: z.record(z.string(), Swimlane),
  orientation: z.enum(['horizontal', 'vertical']),
});

const FlowView = z.object({ byLevel: z.array(FlowLevelView) });

const ProjectMeta = z.object({
  id: z.string(),
  title: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  appVersion: z.string(),
});

export const ProjectSchema = z.object({
  schemaVersion: z.number().finite(),
  meta: ProjectMeta,
  core: Core,
  details: z.record(z.string(), TaskDetail),
  flow: FlowView,
  quarantine: z.array(z.unknown()).optional(),
});
