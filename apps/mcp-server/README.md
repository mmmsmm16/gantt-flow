# @gantt-flow/mcp

gantt-flow を **MCP サーバ**として公開するパッケージです。Claude Desktop / Claude Code などの
MCP クライアントから、自然言語で **工程表（手順一覧）と業務フロー**を読み書きできます。

ドメインロジックは `@gantt-flow/core`（純粋 TS）をそのまま利用し、`.gflow`（中身は JSON）の
プロジェクトファイルを **Node から直接** 読み書きします。各編集は
「core コマンド → `reconcileProject`（フロー同期）→ `meta.updatedAt` 更新 → アトミック保存」
を 1 単位で適用するため（write-through）、表を編集するとフロー図（レーン・矢印）も同期して保存されます。
これはデスクトップ版の編集（commit）と同じ合成です。

## ビルド

```bash
npm install
npm run build -w @gantt-flow/mcp   # dist/index.js（単一バンドル・実行可能）を生成
```

開発中は `npm run dev -w @gantt-flow/mcp`（tsx で TS を直接実行）も使えます。

## 起動

トランスポートは **stdio**。クライアントが子プロセスとして起動します。手動確認なら:

```bash
node apps/mcp-server/dist/index.js [プロジェクトのパス]
```

- 第 1 引数、または環境変数 `GANTT_FLOW_PROJECT` にパスを渡すと、起動時にそのプロジェクトを自動で開きます。
- ログは stderr に出ます（stdout は JSON-RPC 専用）。

## クライアント設定例

### Claude Desktop（`claude_desktop_config.json`）

```json
{
  "mcpServers": {
    "gantt-flow": {
      "command": "node",
      "args": ["/絶対パス/gantt-flow/apps/mcp-server/dist/index.js"],
      "env": { "GANTT_FLOW_PROJECT": "/絶対パス/work/受発注.gflow" }
    }
  }
}
```

### Claude Code（プロジェクト直下の `.mcp.json`）

```json
{
  "mcpServers": {
    "gantt-flow": {
      "command": "node",
      "args": ["apps/mcp-server/dist/index.js"]
    }
  }
}
```

## ツール一覧（45）

**ファイル/ライフサイクル**: `open_project` / `new_project` / `save_project_as` / `import_csv`

**読み取り**: `get_summary` / `list_tasks` / `get_task` / `list_dependencies` / `get_flow_mermaid`
/ `list_flow_layout` / `list_assignees` / `get_metrics` / `compare_scenarios` / `validate_project` / `export_table_csv` / `get_project_json`

`get_flow_mermaid` は現在の業務フローを **Mermaid flowchart** で返します（担当レーン=subgraph）。
Mermaid 対応クライアントなら、チャット上に図として表示しながら編集を進められます。

**フロー図のデザイン微修正（幾何）**: `set_node_position` / `nudge_node` / `pin_node`
/ `set_flow_orientation` / `set_lane_height` / `auto_layout`

ノード位置・固定(pin)・レーン高さ・向きを編集できます（保存データのみ）。**矢印の経路はノード位置から
自動算出**されるため、ノードを動かせば矢印も追従します。「矢印の曲がり位置そのもの」の直接編集は
現状の保存形式に経由点が無いため未対応（将来 `FlowEdge` に経由点を追加する想定）。

**工程（構造）**: `add_task` / `rename_task` / `set_task_level` / `set_task_code` / `set_task_assignee`
/ `reorder_task` / `reparent_task` / `delete_task` / `add_parallel_task` / `make_parallel`

**依存（流れ）**: `add_dependency` / `remove_dependency` / `set_dependency_phase`

**担当**: `add_assignee`

**工程表詳細（As-Is / To-Be）**: `update_task_detail` / `update_task_tobe` / `copy_asis_to_tobe`

**入出力（帳票/情報）**: `add_io_item` / `update_io_item` / `remove_io_item`

**課題**: `add_issue_item` / `update_issue_item` / `remove_issue_item`

各読み取りツールの出力には編集に使う ID（`{id:…}` `{depId:…}` `{ioId:…}` `{issueId:…}`
`{assigneeId:…}`）を併記しています。

## リソース

- `gantt-flow://project` — 現在のプロジェクトの Project JSON 全体
- `gantt-flow://table.csv` — 現在のプロジェクトの工程表 CSV

## プロンプト

- `model_business_process` — 業務ヒアリングから工程表・業務フローへ落とし込む手順テンプレート

## 注意

- 助言ロックは未対応です。デスクトップ版で同じ `.gflow` を開いたまま MCP 側から編集すると、
  互いの保存が競合し得ます（同時編集は避けてください）。
- 工数は「分」、リードタイム（LT）は「日」です（As-Is/To-Be とも）。

## テスト・型チェック

```bash
npm run typecheck -w @gantt-flow/mcp
npm test -w @gantt-flow/mcp
```
