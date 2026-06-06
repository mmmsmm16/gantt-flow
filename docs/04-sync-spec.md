# 04. Sync Spec（同期仕様）

本ツールの心臓部。**コアデータの変更を各粒度のフローへ反映**しつつ、
**フロー固有の構造（分岐・合流・手動配置・コメント）と手動レイアウトを壊さない。**

## 1. 同期の原則

1. **単一の真実はコア**（タスクの階層ツリー＋依存＋担当）。工程表詳細はコアの 1:1 サテライト。
   フローはコアの投影＋フロー固有オーバーレイ。
2. **同期の核**: ある粒度における **「表の 1 行 ⇄ フローの 1 ノード」**。
3. 方向:
   - **表 → フロー**（主）: 作業・担当・階層・流れの変更がフローへ反映。
   - **フロー → 表**（唯一の例外）: ノードのレーン移動 → 担当の更新。
   - 分岐・合流・配置・コメントは**フロー固有**でコアへ戻さない。
4. **純粋関数**として実装する（同入力＝同出力・冪等）。テスト容易性のため（`08-testing.md` のゴールデン/プロパティテスト）。

## 2. 主要シグネチャ

```ts
// 指定粒度（とスコープ）のフローレイアウトを、現在のコアに合わせて再構築する純粋関数。
// 既存の手動配置・分岐・合流・pinned エッジは保持する。flow は変更せず新しい値を返す。
function reconcileFlow(
  core: Core,
  details: Record<Id, TaskDetail>, // 帳票/課題オブジェクトの存在判定に使う（I/O・課題/方策が源泉）
  view: FlowLevelView,          // 対象の粒度ビュー（level, scopeParentId, 既存レイアウト）
  idGen: () => Id,              // テスト用に注入可能（ID 決定論化）
): { view: FlowLevelView; report: SyncReport };
```

`SyncReport` には「自動追加したノード」「親（タスク）削除で孤立したノード」「繋ぎ直し候補」等を入れ、UI が確認ダイアログ等に使う。

## 3. 対象タスクの抽出（粒度ビューの単位）

ある `FlowLevelView(level, scopeParentId)` が描くのは:
- `core.tasks` のうち **`level` が一致し、かつ `parentId === scopeParentId`** のタスク群（その粒度・そのスコープの兄弟）。
- それらを結ぶ依存（`Dependency.scopeParentId === scopeParentId`）。
- 親範囲バンドは、表示タスクの祖先から導出（`bands.ts`）。中工程・大工程の範囲帯を計算。

## 4. reconcile アルゴリズム（擬似コード）

```
function reconcileFlow(core, view):
  next = clone(view)
  targets = tasks in core where level == view.level and parentId == view.scopeParentId

  // 1. タスクノード: 対象タスク 1 件につきタスクノード 1 個を保証
  byTask = index(next.nodes where kind=="task", by node.taskId)
  for task in targets:
    if byTask[task.id] exists:
      node = byTask[task.id]
      // データ同期のみ。x/y は触らない（手動配置を保持）
      // 作業名はコアから live 表示するのでコピー不要
      // 担当が変わっていれば、対応するレーンへ laneId を更新（位置は据え置き or バンド内で再配置提案）
      ensureLaneForAssignee(next, task.assigneeId); node.laneId = laneId(task.assigneeId)
    else:
      // 新規タスク → 「担当レーン × 親バンド」へ自動配置
      node = makeTaskNode(task.id, pos = autoPlace(next, core, task))
      node.laneId = ensureLaneForAssignee(next, task.assigneeId)
      next.nodes[node.id] = node
      report.added.push(node.id)

  // 2. 孤立: 対象から外れた/削除されたタスクのノード
  for node in next.nodes where kind=="task":
    if core.tasks[node.taskId] is missing
       or core.tasks[node.taskId].level != view.level
       or core.tasks[node.taskId].parentId != view.scopeParentId:
      // 削除は「確認の上で普通に削除」方針。ここでは即削除せず report に積み、
      // コマンド側で前後の矢印の繋ぎ直し候補を添えて UI に確認させる（5 節）。
      report.orphans.push({ nodeId: node.id, reconnect: suggestReconnect(next, node) })

  // 3. 導出エッジ: コア依存を矢印として反映。ただし
  //    ・pinned（ユーザー）エッジは消さない
  //    ・ユーザーが A→判断→B の経路を作っていれば直接 A→B を張らない
  //    ・role=="ioLink"（同一帳票リンク）は「流れ」ではないので経路解決から除外
  for dep in core.dependencies where dep.scopeParentId == view.scopeParentId:
    s = taskNodeOf(dep.from); t = taskNodeOf(dep.to)
    if s and t and not userPathExists(next, s, t):   // userPathExists: role=="flow" の pinned/制御ノード経由のみ BFS（ioLink は無視）
      upsertDerivedEdge(next, dep.id, s, t)
  for e in next.edges where e.derivedFromDependencyId and not e.pinned:
    if dependency(e) removed or now superseded by user path:
      delete next.edges[e.id]

  // 4. I/O・課題オブジェクト: 表（TaskDetail）を源泉に存在を導出。配置/表示状態は保持
  //    安定 ID で突き合わせる（io: IoItem.id / issue: IssueItem.id）。複数 I/O・複数課題に対応
  //    I/O は IoItem.kind（doc=帳票/info=情報、中/小で変わる）で見た目が決まる。配置はレベル別
  for task in targets:
    d = details[task.id]
    // 4a. I/O: inputs[]/outputs[] の各 IoItem に I/O ノードを 1 個保証（過不足を解消）
    wantIoIds = { item.id for io in ["inputs","outputs"] for item in d[io] }
    for io in ["inputs","outputs"]:
      for item in d[io]:
        ensureDocNode(next, task.id, ioOf(io), item.id)  // 無ければ工程の近傍に自動配置、有れば x/y 据え置き
    for n in next.nodes where kind=="doc" and n.taskId==task.id:
      if n.ioId not in wantIoIds: remove n              // I/O が削除されたら対応ノードを撤去
    // 4b. 課題: issues[] の各 IssueItem に issue ノードを 1 個保証。対象を解決
    for item in d.issues:
      n = ensureIssueNote(next, task.id, item.id)        // 無ければ作成（visible 既定）
      n.targetNodeId = resolveTarget(next, task.id, item.target)  // task / 該当 doc ノード。消失時はタスクへ寄せる
    wantIssueIds = { item.id for item in d.issues }
    for n in next.nodes where kind=="issue" and n.taskId==task.id:
      if n.issueId not in wantIssueIds: remove n
  // 内容（本文）はコピーせず TaskDetail から live 表示。ここで保持するのは配置と visible のみ。
  // 複数 I/O は autoPlace で工程の入力側/出力側に縦に積んで初期配置（決定論）。

  // 5. レーン: 参照されている担当のレーンを保証。非空レーンは自動削除しない
  return { view: next, report }
```

### 決定論的な自動配置 `autoPlace`
- 新規タスクは、コア依存をたどって**最も近い先行ノードの右隣**（横向きなら）に置く。先行が無ければ
  当該**担当レーン × 親バンド**の右端の次の空き位置にグリッドスナップ。
- 決定論であること（テストのため）。同じ入力なら同じ座標。

## 5. 操作ごとの挙動（表 → フロー）

| 表での操作 | フローの結果 |
|---|---|
| 行を追加 | 対応粒度ビューにタスクノードを 1 個自動配置（担当レーン×親バンド）。 |
| 作業名を変更 | ノードのラベルが更新（コアから live 表示）。 |
| 担当を変更 | ノードが別レーンへ移動（位置はバンド内で再配置を提案）。 |
| 親（上位工程）を変更＝インデント変更 | 該当ノードが別の親バンドへ移動。粒度ビューの所属も更新。 |
| 前後関係（流れ）を変更 | 矢印（導出エッジ）が更新。ユーザー経路があれば尊重。 |
| インプット/アウトプットに I/O を追加/削除 | I/O 1 件ごとに**オブジェクト**（中=帳票形/小=情報チップ、入力色/出力色）を 1 個 自動配置／撤去（複数は積んで配置）。 |
| 課題を追加/削除 | 課題 1 件ごとに**赤四角の課題オブジェクト**を 1 個 作成／撤去。対象＝既定でそのタスク（特定の I/O も指定可）。 |
| 行を削除 | **確認ダイアログ**を出し、OK ならノード削除＋**前後の矢印を繋ぎ直し**（A→[削除]→B を A→B に）。付随する帳票/課題オブジェクトも撤去。 |

## 6. フロー → 表（唯一の逆方向同期）

- **ノードを別レーンへドラッグ** → そのレーンの `assigneeId` をタスクの担当に書き戻す（`setAssignee` コマンド）。
- これ以外のフロー操作（配置・分岐・合流・コメント・エッジ手描き）は**コアへ戻さない**。

## 7. フロー固有要素の保護（不変条件）

同期を何度実行しても、以下は壊れない:
- **制御ノード**（開始／終了／判断／合流）は削除・改変されない。
- **`pinned` エッジ**（ユーザーが描いた/編集した線）は削除されない。
- 生き残るタスクノードの **x/y 座標は、データだけの編集では変化しない**（手動配置の保持）。
- **帳票/課題オブジェクトの配置(x/y)・課題の表示状態(visible)・接続先**は、対象が生き続ける限り同期で保持される
  （内容は表が源泉のため都度 live 反映、レイアウトはオーバーレイとして不変）。
- 親範囲バンドはツリーから毎回導出するため、階層変更に追従しつつレイアウトを壊さない。

## 8. 不変条件（テストで担保 — `08-testing.md` 参照）
- 各粒度ビューで「対象タスク 1 件 ⇄ タスクノード 1 個」。
- `reconcile(reconcile(x)) == reconcile(x)`（冪等）。
- pinned エッジ・制御ノードは同期で消えない。
- I/O・課題オブジェクトは「IoItem 1 件 ⇔ I/O ノード 1 個」「IssueItem 1 件 ⇔ 課題ノード 1 個」（安定 ID で突き合わせ、再 reconcile で増殖しない）。
- 課題オブジェクトの `targetNodeId` は常に実在ノード（task/io）を指す（対象 I/O の消失時はタスクへ寄せる）。
- ダングリング参照を生まない。
