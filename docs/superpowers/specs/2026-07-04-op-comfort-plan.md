# 操作快適性 改善計画（実測監査統合・2026-07-04）

ミッション: 機能拡充なし。既存操作の摩擦を極限まで削減。40所見・freq×friction 順位付け。
詳細な実測根拠: 監査ワークフロー wf_40fc47e7-a77 の journal 参照。

## トップ10（要約）
1 追加直後Escapeでゴースト行残留（TableView） 2 自由記述のEscapeがコミットになる（Inspector/FullTable/TableView）
3 工数type=numberの3事故（カンマ黙殺/ホイール誤変更/Escape不可） 4 詳細開閉でフローのズーム/スクロール喪失
5 パレット検索ジャンプがフローを隠す 6 ＋子だけフォーカスが移らない 7 CSV取り込みが無警告置換（唯一のデータ喪失）
8 リネームのクリックが全選択されない 9 ファイル系ショートカット皆無（Ctrl+N/O/Shift+S）
10 undo/redo境界で完全無反応

## 横断パターン
P1 Escape=取り消しの一貫性 / P2 既定OFFキーの無言no-op（lowRisk付与+shift判定修正）/
P3 片方の経路だけ正しい（良い方へ統一）/ P4 確認モーダルの非対称（CSVに追加・無害側スキップ）/
P5 一時状態の揮発（zoom/scroll/フィルタをuseUIへ退避）/ P6 複数選択・段積みの経路間不一致

## バッチ
- B1 入力フィールド統一: TableView/FullTable/Inspector/parseEffort（#1,2,3,6,8＋datalist/AutoTextarea/×拡大等）
- B2 シェル層: keymap/useGlobalHotkeys/useRowMultiSelect/CommandPalette/App/StatusBar（#7,9＋lowRisk/mark/優先度）
- B3 フロー＋状態退避: FlowCanvas/store/useUI/taskOps/flowZoom/outlineFilter（#4,5,10,26＋段積み/付箋/整列）
