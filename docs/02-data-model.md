# 02. Data Model

## 1. 設計の核となる考え方

**コアデータ（タスクの階層ツリー＋依存＋担当）を「単一の真実」とし、
工程表とフローはその投影（プロジェクション）＋各ビュー固有のオーバーレイ**として持つ。

データは概念的に **3 層**に分離する。

| 層 | 役割 | 同期 |
|---|---|---|
| **コア** | 作業（階層ツリー）・流れ（依存）・担当。両ビューの土台。 | 同期対象 |
| **工程表詳細** | 工数・使用システム等の表専用項目＋ I/O・課題（表が源泉でフローにもオブジェクト投影）。 | 大半は表のみ／I/O・課題は表→フロー |
| **フロー詳細** | ノード座標・判断/合流ノード・コメント等、**図にだけ**ある情報。 | フローのみ（同期で保持） |

> 重要: **工程表の全項目をフローへ反映するわけではない。**
> フローに出るのは「作業名・担当・階層／流れ」＋**インプット/アウトプット（帳票オブジェクト）**・**課題/方策（課題オブジェクト）**。
> 工数・使用システム・どうやって・備考などは表の中だけで完結する（詳細は §7）。

## 2. コア（単一の真実・同期対象）

タスクは **大 > 中 > 小 > 詳細** の階層ツリー。**4 階層は「型」、深さは枝ごとに可変**。

```ts
type Id = string;                       // app 生成 UUID（例 "task_<uuid>"）。prefix はデバッグ用、ロジックで解釈しない
type ProcessLevel = "large" | "medium" | "small" | "detail"; // 大/中/小/詳細

interface ProcessTask {
  id: Id;
  name: string;                         // 作業名
  parentId?: Id;                        // 親タスク（無ければルート）。木構造を作る
  level: ProcessLevel;                  // この作業の粒度
  order: number;                        // 同一親内の並び順（安定ソートキー）
  assigneeId?: Id;                      // -> Assignee.id（担当＝レーン軸）
  code?: string;                        // 工程No の手動上書き。未設定なら木の位置から自動採番（1 / 1-2 / 1-2-3）
}

type DependencyType = "FS";             // 当面は finish-start 相当（順序）のみ。将来拡張可

interface Dependency {
  id: Id;
  from: Id;                             // -> ProcessTask.id（先行）
  to: Id;                               // -> ProcessTask.id（後続）
  type: DependencyType;
  scopeParentId?: Id;                   // 流れが属するスコープ（= from/to の共通の親）。粒度ビューの単位
}

interface Assignee {
  id: Id;
  name: string;                         // 担当者名 or 部署名
  kind: "person" | "department";
}

interface Core {
  tasks: Record<Id, ProcessTask>;
  dependencies: Record<Id, Dependency>;
  assignees: Record<Id, Assignee>;
}
```

### 階層と粒度の規則
- 親は常に子より粗い粒度（大の子は中、中の子は小…）。**枝の深さは可変**（小で止まる枝があってよい）。
- レベルスキップ（大の直下に小、など）を許すかは **TBD**（`07-open-questions.md`）。当面は許さない前提で実装し、許容する場合は緩める。
- **依存（流れ）は同一粒度・同一親スコープ内**で張る。`scopeParentId` が同じタスク同士をつなぐ。
  - これにより「大工程の流れ」「ある大工程に属する中工程の流れ」のように、粒度ごとのフローが定義できる。

## 3. 工程表詳細（表のみ・フロー非表示）

```ts
type Automation = "manual" | "system" | "partial";   // 手作業 / システム自動 / 一部自動
type Difficulty = "H" | "M" | "L";                   // 作業難易度

// I/O 1 件（帳票 or 情報）。複数に対応するため配列要素にする。
// 粒度は工程の粒度に連動する: 中工程では帳票(doc)、小工程では情報(info)が単位になりやすい。
// 「情報が集まって帳票になる」包含関係（帳票 ⊃ 情報）はあるが、当面はデータ上で繋がない＝フラット。
// 将来この連動を明示したくなったら info に partOfDocId? を足して昇格できる（YAGNI）。
interface IoItem {
  id: Id;                               // 安定ID。フロー帳票/情報オブジェクトの突き合わせ・課題の接続先に使う
  name: string;                         // 帳票名／情報名（例 "注文書" / "顧客名"）
  kind: "doc" | "info";                 // 帳票（中で多い）/ 情報（小で多い）。見た目（帳票形/情報チップ）を分ける
  formInfo?: string;                    // 帳票様式・保管（様式番号・保管場所/期間）。任意・kind:"doc" で主に使う
}

// 課題（1 件）。各々が方策と「線を引く対象」を持つ。
type IssueTarget =
  | { kind: "task" }                    // 工程ノード本体へ（既定）
  | { kind: "io"; ioId: Id };           // 特定の帳票/情報（IoItem.id）へ
interface IssueItem {
  id: Id;                               // 安定ID。フロー課題オブジェクトの突き合わせに使う
  issue: string;                        // 課題
  measure?: string;                     // 方策（課題への対応策）。任意
  target?: IssueTarget;                 // 線を引く対象（未指定なら工程ノード）
}

interface TaskDetail {
  taskId: Id;                           // -> ProcessTask.id（1:1）

  // --- 標準（一部は表が源泉でフローにオブジェクト投影） ---
  how?: string;                         // 業務内容（どうやって・手順・方法）
  inputs?: IoItem[];                    // インプット（帳票/情報 0..n）→ フローに入力色オブジェクト
  outputs?: IoItem[];                   // アウトプット（帳票/情報 0..n）→ フローに出力色オブジェクト
  system?: string;                      // 使用システム／ツール（複数は改行で列挙）
  effortMinutes?: number;               // 工数。整数の「分」で保持（表示は分/時間切替）。末端ノードに入力（主に中工程）。親は子の合計を集計（導出・下記）
  note?: string;                        // 備考

  // --- 任意（採用済み） ---
  volume?: string;                      // 処理件数・ボリューム（1回/月あたり等）
  issues?: IssueItem[];                 // 課題（0..n。各々 方策・対象を持つ）→ フローに赤四角オブジェクト
  exception?: string;                   // 例外・イレギュラー対応（複数は改行で列挙）
  automation?: Automation;              // 自動化区分（手/自動/一部）
  dataLink?: string;                    // データ連携先（複数は改行で列挙）
  regulation?: string;                  // 関連規程・統制（複数は改行で列挙）
  difficulty?: Difficulty;              // 作業難易度（H/M/L）
}
```

> **複数値の持ち方の原則**: フローにオブジェクトとして出る **I/O と課題は、安定ID付きの構造化リスト**（個々をフロー側で参照・配置・接続するため）。
> それ以外の「表のみ」の複数値（使用システム・データ連携先・関連規程・例外対応）は**自由テキスト（改行で複数記入）**に留める。
> 個別参照や集計・連携が必要になった列は、後から `string[]` や構造化リストへ昇格できる（YAGNI）。
> **I/O 粒度は工程粒度に連動**: 中工程は帳票(`kind:"doc"`)、小工程は情報(`kind:"info"`)が単位になりやすい。`帳票 ⊃ 情報` の包含は当面**繋がない（フラット）**。必要になれば info に `partOfDocId?` を足して昇格。
> **帳票様式・保管**は独立列をやめ、各 I/O（`IoItem.formInfo`、主に帳票）の任意属性に統合。
> **工数**は整数の「分」で保持（表示は分/時間を切替）。**入力は末端ノード（主な作業レベル＝中工程）**、
> 親（大、または小に分解された中）の工数は**子孫の末端工数の合計を導出**（保存せず計算。`02` §4 のバンド導出と同じ思想）。工程No は `ProcessTask.code`（自動採番＋手動上書き）。

## 4. フロー詳細（フローのみ・同期で保持）

```ts
type FlowNodeId = string;

// タスクの図上の表現（粒度ごとに 1 タスク 1 ノード）
interface FlowTaskNode {
  id: FlowNodeId;                       // node_<uuid>（taskId とは別 ID）
  kind: "task";
  taskId: Id;                           // -> ProcessTask.id
  x: number; y: number;                 // 手動配置（同期で保持）
  laneId?: Id;                          // -> Swimlane.id（担当レーン）
}

// 図にしか無い制御ノード（対応するタスクは無い）
type ControlKind = "start" | "end" | "decision" | "merge";
interface FlowControlNode {
  id: FlowNodeId;
  kind: "control";
  control: ControlKind;                 // 分岐(decision) は「フローでだけ描く」
  label?: string;
  x: number; y: number;
  laneId?: Id;
}

// I/O（帳票/情報）オブジェクト。表の I/O 列の IoItem が源泉（§3）。
// I/O 1 件＝ノード 1 個（複数なら複数並ぶ）。内容は IoItem を live 表示（コピーしない）。
// 見た目は IoItem.kind で分ける（doc=帳票形 / info=情報チップ）、色は入力/出力で分ける。
// 存在は IoItem の有無で導出、配置(x/y)はフローオーバーレイとして同期で保持。
// I/O の単位がレベルで変わる（中=帳票, 小=情報）ため、ノードは粒度ビューごとに別物＝配置もレベル別が自然。
interface FlowDocNode {
  id: FlowNodeId;
  kind: "doc";                          // 内部種別。表示形状は参照先 IoItem.kind で決める
  io: "input" | "output";               // 色は入力/出力で分ける
  taskId: Id;                           // -> ProcessTask.id（どの工程の I/O か）
  ioId: Id;                             // -> IoItem.id（複数 I/O を区別する安定キー）
  x: number; y: number;
  laneId?: Id;
}

// 課題オブジェクト（赤四角）。表の IssueItem が源泉（§3）。課題 1 件＝ノード 1 個。
// 対象（工程ノード or 帳票ノード）へ注釈線で接続。表示/非表示を切替可能。
interface FlowIssueNote {
  id: FlowNodeId;
  kind: "issue";
  taskId: Id;                           // 内容（課題/方策）の源泉が属する工程
  issueId: Id;                          // -> IssueItem.id（複数課題を区別する安定キー）
  targetNodeId: FlowNodeId;             // 線を引く対象（IssueItem.target を解決した task/doc ノード。control/エッジ不可）
  x: number; y: number;
  visible: boolean;                     // 個別の表示/非表示（ビュー側の一括トグルと併用、§03）
}

type FlowNode = FlowTaskNode | FlowControlNode | FlowDocNode | FlowIssueNote;

interface FlowEdge {
  id: Id;
  source: FlowNodeId;
  target: FlowNodeId;
  label?: string;                       // 分岐条件 "OK"/"NG" など
  derivedFromDependencyId?: Id;         // コア依存から自動生成された線
  pinned?: boolean;                     // ユーザーが描いた/編集した線 → 同期で消さない
  role?: "flow" | "ioLink";             // 既定 "flow"。"ioLink"=同一帳票リンク（装飾・経路解決に無関係。03 §2-4）
}

interface Swimlane {
  id: Id;
  assigneeId?: Id;                      // -> Assignee.id（このレーンが表す担当/部署）
  title: string;
  order: number;
}

// 粒度ごとにビュー状態を持つ（大/中/小/詳細それぞれのレイアウト）
interface FlowLevelView {
  level: ProcessLevel;
  scopeParentId?: Id;                   // どのスコープのフローか（中工程フロー等は親=大工程を持つ）
  nodes: Record<FlowNodeId, FlowNode>;
  edges: Record<Id, FlowEdge>;
  lanes: Record<Id, Swimlane>;
  orientation: "horizontal" | "vertical";
}

interface FlowView {
  byLevel: FlowLevelView[];             // 粒度（とスコープ）ごとのレイアウト
}
```

### 親範囲バンド（大/中工程の帯）は「導出」する
- 細かい粒度ビューで表示する **親範囲のバンドはツリーから計算**する（保存しない）。
  - 例: 小工程ビューでは、各小工程ノードの祖先をたどり、中工程・大工程ごとに範囲（帯）を引く。
- 保存するのはビュー設定（向き・どの粒度を見ているか等）のみ。詳細は `03-view-spec.md`。

## 5. プロジェクト（保存ドキュメント）

```ts
interface Project {
  schemaVersion: number;
  meta: { id: Id; title: string; createdAt: string; updatedAt: string; appVersion: string };
  core: Core;
  details: Record<Id, TaskDetail>;      // taskId -> 工程表詳細
  flow: FlowView;
  quarantine?: unknown[];               // 読込時に壊れていた参照を退避（クラッシュさせない）
}
```

## 6. ID と参照整合性

- すべての ID は app 生成の **UUID v4 文字列**。prefix（`task_` 等）は人間／デバッグ用で、ロジックで解釈しない。
- コアが `taskId` / `dependencyId` の権威。オーバーレイは**参照のみ**で、新しいコア ID を発明しない。
- **外部→内部 ID の発番が起こるのは Importer のみ**（Excel/CSV の初回取り込み時に UUID を採番。`05-persistence.md` §6）。それ以外でアプリ起動後に外部キーへ依存しない。
- `validate(project)` で次を保証し、壊れた参照は `quarantine` へ退避（共有フォルダ上で手編集・破損し得るため落とさない）:
  - 各 `Dependency.from/to`・`TaskDetail.taskId`・`FlowTaskNode.taskId` が実在タスクを指す。
  - `ProcessTask.parentId` が実在し、循環が無い（木である）。
  - 制御ノードはタスクを参照しない。
  - `IoItem.id`・`IssueItem.id` は `TaskDetail` 内で一意。`FlowDocNode.ioId`・`FlowIssueNote.issueId` が実在の IoItem/IssueItem を指す。
  - `IssueItem.target`（kind:"io"）と `FlowIssueNote.targetNodeId` が実在の I/O（帳票/情報）/タスクノードを指す（消失時はタスクへ寄せる）。

## 7. 同期される項目／されない項目（一覧）

| 項目 | 区分 | 同期 |
|---|---|---|
| 作業名 | コア | ✅ 表⇄フロー（フローはラベル表示） |
| 担当 | コア | ✅ 表→フロー（レーン）。**レーン移動→表 の逆方向も可（唯一）** |
| 階層（親子・粒度） | コア | ✅ 表→フロー（粒度ビュー・親バンド） |
| 流れ（依存） | コア | ✅ 表→フロー（矢印） |
| インプット／アウトプット | 表詳細 | ✅ 表→フロー（**I/O オブジェクト 0..n**。各 IoItem が 1 個。中=帳票/小=情報、配置はレベル別・手動で同期保持） |
| 帳票様式・保管 | 表詳細 | I/O（IoItem、主に帳票）の属性。オブジェクトに付随表示 |
| 課題／方策 | 表詳細 | ✅ 表→フロー（**赤四角の課題オブジェクト 0..n**。各 IssueItem が 1 個。対象＝工程/帳票、表示トグル） |
| 工数 | 表詳細 | ⛔ 表のみ |
| 使用システム | 表詳細 | ⛔ 表のみ |
| どうやって／備考 | 表詳細 | ⛔ 表のみ |
| ノード座標・レーン配置 | フロー詳細 | フローのみ（同期で保持） |
| 帳票/課題オブジェクトの配置・表示状態 | フロー詳細 | フローのみ（内容は表が源泉、レイアウトは同期で保持） |
| 分岐（判断）・合流 | フロー詳細 | フローのみ（表には持たない） |
| コメント | フロー詳細 | フローのみ |
