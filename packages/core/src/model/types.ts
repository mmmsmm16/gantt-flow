// ドメイン型（`docs/02-data-model.md` に対応）。3 層: コア / 工程表詳細 / フロー詳細。

export type Id = string;
export type ProcessLevel = 'large' | 'medium' | 'small' | 'detail'; // 大/中/小/詳細

// ---- コア（単一の真実・同期対象） ----

export interface ProcessTask {
  id: Id;
  name: string;
  parentId?: Id; // 親タスク（無ければルート）
  level: ProcessLevel;
  order: number; // 同一親内の並び順
  assigneeId?: Id;
  code?: string; // 工程No の手動上書き（未設定なら木の位置から自動採番）
  /** 'milestone' = 節目マーカー。子・担当・工数・工程Noを持たず、出依存も張れない。省略時は通常工程。 */
  kind?: 'milestone';
}

export type DependencyType = 'FS'; // 当面は finish-start 相当（順序）のみ

export interface Dependency {
  id: Id;
  from: Id; // 先行
  to: Id; // 後続
  type: DependencyType;
  scopeParentId?: Id; // 流れが属するスコープ（= from/to の共通の親）
  /** どのシナリオに属する依存か。未指定=両方。As-Is 専用の依存を To-Be で外す（並行化）等に使う。 */
  phase?: 'asis' | 'tobe';
}

export interface Assignee {
  id: Id;
  name: string;
  kind: 'person' | 'department';
}

export interface Core {
  tasks: Record<Id, ProcessTask>;
  dependencies: Record<Id, Dependency>;
  assignees: Record<Id, Assignee>;
}

// ---- 工程表詳細（表が源泉・一部はフローへ投影） ----

export type Automation = 'manual' | 'system' | 'partial';
export type Difficulty = 'H' | 'M' | 'L';
/** ヒアリングの進行状態。未着手 / ヒアリング済 / 確認待ち / 確定。 */
export type TaskStatus = 'todo' | 'heard' | 'review' | 'done';
/** 工程カラー(名前付きプリセット)。仮説工程の色分けなど。実際の色値は UI 層が解決する。 */
export type TaskColor = 'red' | 'orange' | 'yellow' | 'green' | 'teal' | 'blue' | 'purple' | 'gray';
export type IoKind = 'doc' | 'info'; // 帳票 / 情報

export interface IoItem {
  id: Id;
  name: string;
  kind: IoKind;
  formInfo?: string; // 様式番号・保管（主に帳票）
  source?: string; // 出所（他部署など）。入力で「どこから来る帳票か」を示す
}

export type IssueTarget = { kind: 'task' } | { kind: 'io'; ioId: Id };

export interface IssueItem {
  id: Id;
  issue: string;
  measure?: string;
  target?: IssueTarget;
}

// To-Be（あるべき姿）の差分。未設定の項目は As-Is（同名の既存フィールド）と同一とみなす。
// As-Is/To-Be 比較（提言#1/#2/#8）。工数＝タッチタイム・LT＝リードタイム(経過日数)の2軸で見る。
export interface TaskDetailToBe {
  effortMinutes?: number; // To-Be 工数（分）
  ltDays?: number; // To-Be リードタイム（日）
  difficulty?: Difficulty; // To-Be 業務難易度（H=ベテラン依存→L=誰でも へ下げるのが改善の主役）
  automation?: Automation; // To-Be 自動化区分
  rationale?: string; // 根拠（なぜ達成できるか＝暗黙知の形式知化の内容）
  /** 工程のライフサイクル。未指定=維持(kept)。'added'=To-Be で新設 / 'removed'=To-Be で廃止。 */
  lifecycle?: 'added' | 'removed';
  /** To-Be での担当（レーン移動）。未指定=As-Is と同じ担当。 */
  assigneeId?: Id;
}

export interface TaskDetail {
  taskId: Id;
  how?: string;
  inputs?: IoItem[];
  outputs?: IoItem[];
  system?: string;
  effortMinutes?: number; // 工数（整数の「分」・末端に入力）＝タッチタイム（As-Is）
  ltDays?: number; // リードタイム（経過日数・末端に入力）＝着手〜完了の経過(待ち・停滞含む)（As-Is）
  note?: string;
  volume?: string;
  issues?: IssueItem[];
  exception?: string;
  automation?: Automation;
  dataLink?: string;
  regulation?: string;
  difficulty?: Difficulty;
  status?: TaskStatus; // ヒアリング進行管理（任意・未指定は未着手扱い）
  fillColor?: TaskColor; // 工程ノードの塗り色（任意・未指定は既定の白）
  textColor?: TaskColor; // 作業名の文字色（任意・未指定は既定のインク色）
  toBe?: TaskDetailToBe; // To-Be 差分（未設定なら As-Is と同一）
}

// ---- フロー詳細（図にだけある情報・同期で保持） ----

export type FlowNodeId = string;

export interface FlowTaskNode {
  id: FlowNodeId;
  kind: 'task';
  taskId: Id;
  x: number;
  y: number;
  laneId?: Id;
  pinned?: boolean; // 固定: 整列(tidy)で位置を動かさない
}

export type ControlKind = 'start' | 'end' | 'decision' | 'merge';

export interface FlowControlNode {
  id: FlowNodeId;
  kind: 'control';
  control: ControlKind;
  label?: string;
  x: number;
  y: number;
  laneId?: Id;
}

export interface FlowDocNode {
  id: FlowNodeId;
  kind: 'doc';
  io: 'input' | 'output';
  taskId: Id;
  ioId: Id; // -> IoItem.id
  x: number;
  y: number;
  laneId?: Id;
}

export interface FlowIssueNote {
  id: FlowNodeId;
  kind: 'issue';
  taskId: Id;
  issueId: Id; // -> IssueItem.id
  targetNodeId: FlowNodeId; // 細い薄線（矢頭なし）で結ぶ対象
  x: number;
  y: number;
  visible: boolean;
}

export interface FlowComment {
  id: FlowNodeId;
  kind: 'comment';
  text: string;
  x: number;
  y: number;
  laneId?: Id;
  /** 付箋を任意のノードへ結ぶ細い薄線（矢頭なし・課題の注釈線と同じ見た目）の対象。
      未指定＝どこにも結ばない。対象ノードが消えた場合は描画側で線を描かない（ダングリング禁止）。 */
  targetNodeId?: FlowNodeId;
}

export type FlowNode =
  | FlowTaskNode
  | FlowControlNode
  | FlowDocNode
  | FlowIssueNote
  | FlowComment;

export interface FlowEdge {
  id: Id;
  source: FlowNodeId;
  target: FlowNodeId;
  label?: string; // 分岐条件など
  derivedFromDependencyId?: Id; // コア依存から自動生成された線
  pinned?: boolean; // ユーザーが描いた/編集した線 → 同期で消さない
  role?: 'flow' | 'ioLink'; // 既定 flow。ioLink は経路解決に無関係
}

export interface Swimlane {
  id: Id;
  assigneeId?: Id;
  title: string;
  order: number;
  height?: number; // レーンの高さ（px）。未指定＝既定。並行工程で太く / 手動リサイズで保持。
}

export type Orientation = 'horizontal' | 'vertical';

export interface FlowLevelView {
  level: ProcessLevel;
  scopeParentId?: Id;
  nodes: Record<FlowNodeId, FlowNode>;
  edges: Record<Id, FlowEdge>;
  lanes: Record<Id, Swimlane>;
  orientation: Orientation;
}

export interface FlowView {
  byLevel: FlowLevelView[];
}

// ---- プロジェクト（保存ドキュメント） ----

export interface ProjectMeta {
  id: Id;
  title: string;
  createdAt: string;
  updatedAt: string;
  appVersion: string;
}

export interface Project {
  schemaVersion: number;
  meta: ProjectMeta;
  core: Core;
  details: Record<Id, TaskDetail>;
  flow: FlowView;
  quarantine?: unknown[];
}
