# gantt-flow UI/UX 改善案カタログ（全80案・検証済み）

現状コードの調査（6領域）→ 6視点での案出し（85案）→ 実コードとの突合検証（既実装・実現性・重複チェック）を経て残った80案。
各案の「検証メモ」は実コードを読んだ上での裏付け・注意点。impact=業務効率への影響、effort=実装規模（S=数時間 / M=1日前後 / L=数日）。

## フロー図キャンバスの操作（17案）

### 1. フローで n キー「次工程を追加して接続」（表の n と対称）
**影響: 高 / 規模: M**

- **問題**: フロー上の工程追加は空白ダブルクリックか「工程＋」ボタン（FlowCanvas.tsx:843-854 の addTaskAt）のみで、追加後の依存接続・リネームは別操作。表には n（次に工程を追加して編集）があるが、keymap.ts の flow コンテキストに追加系キーは I/O（i/o）しかなく、フローをキーボードだけで組み立てられない。
- **提案**: flow コンテキストに flow.addNext（n）を追加。選択中の工程ノードの右隣（同レーン内・既存ノードと重ならない位置）へ新規工程を作成→選択ノードからの依存を自動接続→その場リネーム（既存 flow.rename の入力を流用）まで一気通貫で開始する。未選択時はビューポート中央に作成。Shift+N は「接続なしで追加」。store に「ノード基準位置＋自動接続付き追加」を1 undo で行うアクションを追加。
- **主な変更ファイル**: apps/desktop/src/FlowCanvas.tsx, apps/desktop/src/keymap.ts, apps/desktop/src/store.ts

### 2. 工程ノードの右クリックコンテキストメニュー
**影響: 高 / 規模: M**

- **問題**: ノード上で右クリックしても何も起きない（FlowCanvas.tsx の node div に onContextMenu がない）。リネームはダブルクリック、I/O追加は角の小さな＋、固定は📌、削除は Delete キーと操作が分散しており、初見ユーザーが到達しにくい。矢印は右クリック＝即削除（FlowCanvas.tsx:998-1001）で誤削除リスクもある。
- **提案**: ノード右クリックで浮動メニューを表示: 「名前を変更（F2）」「ここから接続（c）」「インプット/アウトプット追加」「固定/固定解除」「複製」「表で表示」「削除」。制御ノード・付箋は該当項目のみ。矢印の右クリックも即削除をやめ「ラベルを編集」「工程を挿入」「削除」のメニューに変更。メニューは useUI のレイヤ管理（closeTopLayer）に登録し Esc/外クリックで閉じる。各項目にショートカット表記を併記して発見性も上げる。
- **検証メモ**: 未実装を確認。アプリ全体で onContextMenu は1箇所のみ＝矢印の右クリック即削除（FlowCanvas.tsx:998-1001、確認なしで deleteEdge）。ノード div（1160-1221）に onContextMenu はなく、リネーム=ダブルクリック(1215)、I/O追加=角の＋(1276-1299)、固定=📌(1300)、削除=Delete と分散している指摘は正確。実装可能: 必要なアクションは全て既存（setEditingTaskId/kbConnect/addIoPrompt/toggleNodePin/duplicateTask/revealTask/confirmRemoveTasks/editEdgeLabel）。レイヤ管理は useUI.registerTransientLayer（useUI.ts:408-414、Esc は closeTopLayer 経由）がまさにこの用途で既存。唯一「工程を挿入」だけは新規 store アクションが必要（「矢印の途中への工程挿入」案と項目単位で重なるが、メニュー全体としては別物）。
- **主な変更ファイル**: apps/desktop/src/FlowCanvas.tsx, apps/desktop/src/ui/useUI.ts, apps/desktop/src/styles.css

### 3. 接続ドラッグを空白で離すと次工程を作成して接続
**影響: 高 / 規模: M**

- **問題**: ○ハンドルからの接続ドラッグは工程/制御ノードに落とした時だけ接続され、空白で離すと何も起きず操作が無駄になる（FlowCanvas.tsx:345-357 の onUp で target が無ければ破棄）。ヒアリング中に「次の工程」を連続して描く際、毎回 ダブルクリック→作成→ハンドルドラッグ→接続 の3操作が必要。
- **提案**: 接続ドラッグ中に空白上では破線プレビューの先端に「＋ 新しい工程」のゴーストチップを表示し、空白で離すとドロップ位置に工程を作成して起点からの依存を自動登録（作成＋接続を1 undo 単位にする store アクション connectToNew を追加。レーン判定・担当自動設定は addTaskAt の nearestLaneOrder ロジックを流用）。作成直後はインラインリネーム（editingTaskId）を開始し、Enter→そのまま新ノードの○ハンドルへ続けられるようにする。
- **検証メモ**: 未実装を確認。onUp（FlowCanvas.tsx:345-357）は工程/制御ノードに当たらなければ setConn(null) で破棄。実装可能: addTaskAt（store.ts:546-571）が「cAddTask→reconcile→ノード位置設定→history.push 1回＝1 undo」のパターンを実証済みで、これに cAddDependency を加えた connectToNew は素直に書ける。nearestLaneOrder による担当自動設定も流用可。editingTaskId によるインラインリネームも既存（1245-1270）。注意点: 起点が制御ノードの場合は依存でなく pinned エッジにする分岐が必要（connect:630-655 と同じ規則）。「フローで n キー『次工程を追加して接続』」とは store アクションを共有するがトリガーが別（ドラッグ vs キー）で実質同一ではない。リネーム開始部分は「キャンバス上の工程作成直後にその場リネーム開始」と重なる。
- **主な変更ファイル**: apps/desktop/src/FlowCanvas.tsx, apps/desktop/src/store.ts

### 4. 矢印の途中への工程挿入（A→Bの間に割り込み）
**影響: 高 / 規模: M**

- **問題**: 選択した矢印の edge-toolbar（FlowCanvas.tsx:1064-1089）は「ラベル編集」「削除」のみ。ヒアリングで「この2工程の間に実は承認が入る」と判明した場合、工程を作成→既存矢印を削除→2本引き直す、と4操作が必要で、依存の張り直しミスも起きやすい。
- **提案**: edge-toolbar に「＋工程を挿入」ボタンを追加。クリックすると (1) 矢印のラベル位置（route.label）付近に新規工程を作成、(2) 元エッジが導出エッジなら依存 A→B を削除して A→新規・新規→B の依存を登録、pinned エッジなら source/target を書き換えた2本に分割、(3) 全体を1 undo 単位にする store アクション insertTaskOnEdge として実装。挿入直後はインラインリネームを開始する。
- **検証メモ**: 未実装を確認。edge-toolbar(FlowCanvas.tsx:1064-1089) はラベル編集と削除のみで、insertTaskOnEdge は store/core に存在しない。実装基盤は揃っている: route.label(edgeRoute.ts:24)、derivedFromDependencyId(types.ts:156)、core コマンドの合成→commit で 1 undo にする前例(addTaskAt, duplicateTask)。注意点: 導出エッジは reconcile が新 id で再生成する(reconcileFlow.ts:270)ため、元エッジのラベルを引き継ぐなら明示的なコピーが要る。また粒度が違うノード間は pinned エッジになる規約(store.ts connect:630-655)との整合に注意。
- **主な変更ファイル**: apps/desktop/src/FlowCanvas.tsx, apps/desktop/src/store.ts, packages/core/src/commands/index.ts

### 5. 表⇔フローの双方向ビューポート追従ジャンプ
**影響: 高 / 規模: M**

- **問題**: 選択ハイライト（.selected）は表⇔フローで同期するが、画面の追従がない。フローで工程ノードをクリックしても表は該当行までスクロールせず（TableView.tsx / FullTable.tsx に selectedTaskId 連動の scrollIntoView が存在しない）、逆に表で行を選んでもフロー側のノードが画面外のままになる（FlowCanvas の scrollIntoView はキーボードナビ時の 143・462 行のみ）。2ペイン同期がこのアプリの核なのに、目視での突き合わせに毎回手動スクロールが要る。
- **提案**: store の select に選択の発生元ペイン（'table' | 'flow' | 'other'）を記録するフィールドを追加。TableView/FullTable は selectedTaskId 変更時、発生元が自分以外なら該当 tr を scrollIntoView({block:'nearest'})。FlowCanvas も同様に該当ノードを scrollIntoView。自分発の選択ではスクロールしないことでクリック時のガタつきを防ぐ。あわせてノードのコンテキストメニュー/インスペクタに「表で表示」を追加し、明示ジャンプもできるようにする。
- **検証メモ**: 未実装を確認。grep で TableView.tsx / FullTable.tsx に scrollIntoView は 0 件。FlowCanvas の scrollIntoView は :143(接続モード候補追従) と :462(キーボードナビの selectNodeById) のみで、表からの選択変更にフローは追従しない。store の select(store.ts:701) は selectedTaskId を set するだけで発生元フィールドは無い。提案の『発生元ペイン記録＋自分以外発のときだけ scrollIntoView』は Zustand への 1 フィールド追加と各ビューの useEffect で実装可能。類似案『パレット工程ジャンプのフロー追従』はパレット起点の単方向ジャンプで、本案（ペイン間双方向同期）とは別物と判断。
- **主な変更ファイル**: apps/desktop/src/store.ts, apps/desktop/src/FlowCanvas.tsx, apps/desktop/src/TableView.tsx, apps/desktop/src/FullTable.tsx

### 6. カーソル位置を基準にしたズーム（アンカー付きズーム）
**影響: 高 / 規模: S**

- **問題**: Ctrl/⌘+ホイールズーム（FlowCanvas.tsx:256-267）は setScale するだけで scrollLeft/scrollTop を補正しないため、拡大するとカーソル直下の工程が画面外へ流れてしまい、「見たい所を拡大する」のに毎回スクロールで追い直す必要がある。＋/−ボタン（zoomBy）も同様。
- **提案**: ホイールズーム時にカーソル直下の論理座標 (clientX/Y から relPoint で算出) が拡大後も同じ画面位置に来るよう、setScale と同時に scroller.scrollLeft/Top を `(論理座標×新scale − カーソルのビューポート内オフセット)` で補正する。＋/−ボタンと +/- キー（flow.zoomIn/Out）はビューポート中央をアンカーにする。clampScale で端に張り付いた時は補正をスキップ。
- **検証メモ**: 未実装を確認。ホイールズーム（FlowCanvas.tsx:257-267）は setScale のみで scrollLeft/Top 補正なし、zoomBy（125行）・flow.zoomIn/Out（501-506）も同様。実装可能: relPoint（244-254）が論理座標算出を、fitView（404-427）が「scale 設定→requestAnimationFrame で scrollLeft=論理座標×新scale」の補正パターンを既に実証しており、提案の補正式はこの既存規約と一致する。注意点: setScale は非同期なので新 scale 値をハンドラ内で先に計算して同じ値で補正すること（fitView と同じ rAF 方式）、および clampScale で scale が変わらなかった場合の補正スキップ（提案に明記済み）。重複なし。
- **主な変更ファイル**: apps/desktop/src/FlowCanvas.tsx

### 7. レーン移動による担当変更（逆同期）の明示トースト
**影響: 高 / 規模: S**

- **問題**: store.ts:503-525 の moveNode で、ノードを別レーンへドロップすると task.assigneeId が無音で書き換わる。フロー上の操作が表データを変更する唯一の逆同期なのに通知がなく、ユーザーが「ただ図を整えただけのつもり」で担当が変わったことに気づかないリスクがある。
- **提案**: moveNode 内で担当書き換えが発生したときだけ toast(「担当を「経理」に変更しました（レーン移動）」, 'info') を表示し、案3のアクション付きトーストと組み合わせて「元に戻す」ボタンを添える。同一レーン内の移動では出さない。トースト文言に旧担当→新担当を含め（「営業 → 経理」）、何が起きたかを1行で学習させる。
- **検証メモ**: 問題認識は正確。store.ts:503-525 の moveNode は lane.assigneeId で task.assigneeId を無音で書き換える（コメントにも「唯一の逆方向同期」と明記）。通知は一切無い。実装は容易: useUI は store.ts を import しないため store→useUI の import は循環しない（taskOps.ts が両方 import する前例あり）。旧担当名・新担当名は p.core.assignees から取得可能。注意点: (1) 現状の toast() はアクションボタン非対応（useUI.ts:417-420、message+tone のみ）なので「元に戻す」付与は別案「破壊的操作のトーストに「元に戻す」アクションボタン」の toast 拡張が前提。undo 自体は history.push 済みなので可能。(2) moveNodesBy（store.ts:529-543）は意図的に逆同期しないため対象は単体ドラッグのみで整合する。
- **主な変更ファイル**: apps/desktop/src/store.ts, apps/desktop/src/ui/useUI.ts

### 8. エッジ端点のドラッグ付け替え（再接続）
**影響: 中 / 規模: L**

- **問題**: 一度引いた矢印の接続先を変えるには削除して引き直すしかない（エッジは click=選択・dblclick=ラベル・右クリック=削除のみで端点操作が存在しない）。接続先を1つ隣の工程へ直すだけでも依存の削除→再作成の2 undo に分かれ、ラベルも消えてしまう。
- **提案**: 矢印を選択（sel.kind==='edge'）した時、経路の始点・終点に直径10px程度の円形グリップを描画。グリップをドラッグすると接続ドラッグと同じプレビュー（droppable/drop-active ハイライト）が出て、別の工程/制御ノードに落とすと付け替え。導出エッジは removeDependency+addDependency を1コミットで実行しラベル（分岐ラベル）は維持、pinned エッジは source/target を書き換え。無効な場所で離したら変更なし。
- **検証メモ**: 未実装を確認。エッジ操作は click=選択(:996)/dblclick=ラベル(:997)/右クリック=削除(:998-1001) のみで端点グリップは存在しない。接続ドラッグの droppable/drop-active ハイライトと落下判定(conn, :339-364, :717-734)、routeOf(e).points による端点座標取得は既存で流用可能。注意点: 『導出エッジのラベル維持』は、依存の削除＋再作成で導出エッジが新 id で再生成される(reconcileFlow.ts:270)ため、1 commit 内でのラベル転写処理が別途必要。removeDependency+addDependency の 1 commit 合成自体は commit(cRemoveDependency→cAddDependency) で可能。
- **主な変更ファイル**: apps/desktop/src/FlowCanvas.tsx, apps/desktop/src/store.ts, apps/desktop/src/styles.css

### 9. ドラッグ中の画面端オートスクロール
**影響: 中 / 規模: M**

- **問題**: ノードドラッグ・接続ドラッグ・範囲選択のいずれも、カーソルがキャンバスの端に達してもスクロールしない（FlowCanvas.tsx:269-297 / 339-364 はポインタ座標を relPoint で変換するだけ）。画面外の工程へ矢印を引く・遠くへノードを運ぶ操作が実質不可能で、いったんズームアウトする回避策を強いられる。
- **提案**: drag / conn / band のいずれかがアクティブな間、ポインタがスクロール容器の端 28px 以内に入ったら requestAnimationFrame ループで scrollLeft/Top を端からの距離に比例した速度（最大 ~14px/frame）で加算する。スクロール後は最新の scroll 量で relPoint を再評価してプレビュー位置がカーソルとずれないようにする。ポインタが内側へ戻るか pointerup で rAF を停止。
- **検証メモ**: 未実装を確認。ノードドラッグ(FlowCanvas.tsx:269-297)・接続ドラッグ(:339-364)・範囲選択(:183-194) はいずれも relPoint で座標変換するのみでオートスクロールは無い。.flow-canvas(canvasRef) 自身がスクロール容器で、relPoint は scrollLeft/Top をライブ参照する(:244-254)ため、提案の rAF ループ＋スクロール後の再評価という設計は現アーキテクチャに素直に乗る。ドラッグ系3箇所のハンドラが個別実装なので、共通フック化しないと3箇所への重複追加になる点だけ留意。
- **主な変更ファイル**: apps/desktop/src/FlowCanvas.tsx

### 10. 選択ノード限定の部分整列
**影響: 中 / 規模: M**

- **問題**: 「整列」ボタン（FlowCanvas.tsx:876-889 → store.ts:591-594 tidyFlow）はビュー全体を一括再配置するため、図の一角だけ崩れた場合でも手で整えた他の領域まで作り直されてしまう（確認ダイアログも『手で整えた配置は失われます』）。結果として整列機能が使われず手動ドラッグに頼りがちになる。
- **提案**: multiSel に2件以上ある状態では整列ボタンのラベルを「選択を整列」に切り替え、tidyFlowView 呼び出し時に非選択ノードを pinned 扱い（既存の固定機構を流用）として渡すオプションを tidy.ts に追加する。確認ダイアログ文言は「選択中の n 件だけを依存とレーンに基づいて再配置します」に変更。選択なしの時は従来の全体整列のまま。
- **検証メモ**: 未実装を確認。tidyFlow(store.ts:591-594) は常にビュー全体を tidyFlowView に渡し、選択限定オプションは無い。提案の根拠どおり tidy.ts:71 に「pinned ノードを整列対象から外す」既存機構があり、『非選択を pinned 扱いにするオプション追加』は設計に合致する。ただし追加の考慮が2点: (1) レーン高さの再計算(tidy.ts:88-91) が整列対象ノードのみ基準のため、部分整列だとレーンが縮む副作用が出る→高さ再計算のスキップ/限定が必要。(2) 帳票/課題の再吸着(:104-138) はビュー内全工程に走るため、非選択工程の手動配置した付随物まで動く→これも選択への限定が必要。いずれも修正範囲は tidy.ts 内に閉じ、現実的。
- **主な変更ファイル**: apps/desktop/src/FlowCanvas.tsx, apps/desktop/src/store.ts, packages/core/src/sync/tidy.ts

### 11. 接続ハンドルの四辺表示（逆方向・上下接続）
**影響: 中 / 規模: M**

- **問題**: 接続ハンドル（○）はノード右辺中央の1個のみ（FlowCanvas.tsx:1315-1321、startConnect 710-715 が右辺座標固定）。戻りの流れ（後工程→前工程）や縦方向のレーン間接続を引く際も必ず右辺から出発するため、プレビュー矢印が不自然に回り込み、ユーザーが「逆向きには引けない」と誤解しやすい（既知の問題点5）。
- **提案**: ノード hover 時に上下左右4辺の中央に小さめのハンドルを表示し、どこからでも接続ドラッグを開始できるようにする。startConnect に開始辺（'top'|'right'|'bottom'|'left'）を渡してプレビュー線の始点をその辺の中点にし、確定時は routeEdge に開始辺ヒントを渡して出発方向を制御（edgeRoute.ts が未対応なら第一セグメントの方向だけ強制する軽量対応でも可）。タッチ誤爆を避けるためハンドルは hover/フォーカス時のみ表示。
- **検証メモ**: 確認済み: FlowCanvas.tsx:1315-1321 でハンドルは span.handle 1個のみ、startConnect (710-715) は fx/fy を右辺中央 (p.x + s.w, p.y + s.h/2) に固定。routeEdge (packages/core/src/sync/edgeRoute.ts:81) も「source右辺中央→target左辺中央」のハードコードで辺ヒント引数なし。ノードはHTML div + エッジはSVGオーバーレイなので4辺ハンドル追加は容易。ただし注意点: (1) エッジに開始辺は永続化されず毎回 routeEdge で再計算されるため、確定後の矢印に開始辺を反映するなら edgeRoute のシグネチャ拡張と flowSvg.ts（画像出力）の追従が必要。プレビュー線のみの軽量対応なら FlowCanvas だけで完結。(2) 逆向き接続自体は現状でも後工程ノードから引けば可能で、これは見た目/発見性の改善。
- **主な変更ファイル**: apps/desktop/src/FlowCanvas.tsx, apps/desktop/src/styles.css, packages/core/src/sync/edgeRoute.ts

### 12. フロー図の空スコープにガイドオーバーレイ（次の行動を提示）
**影響: 中 / 規模: M**

- **問題**: 現在の粒度/スコープに工程ノードが1つもない場合、フロー図は空のレーンが並ぶだけで何の案内もない（FlowCanvas.tsx は view 不在時の「ビューがありません。」のみ）。粒度切替に慣れていないユーザーは「データが消えた」と誤解しうる。
- **提案**: タスクノード数が0のときキャンバス中央に半透明のガイドカードを表示:「この粒度（中工程）にはまだ工程がありません」＋アクションボタン2つ（「空白をダブルクリックで作成」の説明と「工程がある粒度へ切替」ボタン=タスクが存在する最初の粒度へ setLevel）。スコープ絞り込みが原因の場合は「スコープを全体に戻す」ボタンを出し分ける。ノードが追加されたら自動で消える。
- **検証メモ**: 前提に重大な事実誤認あり: 「空のレーンが並ぶだけで何の案内もない」は誤りで、FlowCanvas.tsx:1386-1391 に既にタスクノード0件時の .flow-empty オーバーレイがあり「ここをダブルクリックすると工程を作成できます。表で追加した工程も自動でここに表示されます。」を表示し、ノード追加で自動消滅する。つまり提案の (1) ガイドカード表示と (2) ダブルクリック作成の説明は実装済み。未実装なのは粒度名を含む文言・「工程がある粒度へ切替」ボタン・「スコープを全体に戻す」ボタンの出し分けのみ。その差分は実現容易（setLevel/setScope は store にあり、タスクが存在する最初の粒度の算出も project.core.tasks の走査で済む）。採用するなら既存 .flow-empty の拡張として再定義すべき。
- **主な変更ファイル**: apps/desktop/src/FlowCanvas.tsx, apps/desktop/src/store.ts, apps/desktop/src/styles.css

### 13. フロー図にヒアリング状態レイヤ（未確定工程の描き分け）
**影響: 中 / 規模: M**

- **問題**: フロー図では全工程ノードが同じ見た目で描かれ、「どの工程がまだヒアリングできていないか」が図から読めない。課題レイヤの表示/非表示トグルは既にある（FlowCanvas.tsx:369 showIssues）が、進捗の可視化レイヤは存在しない。顧客レビューの場で『この辺はまだ仮です』を口頭で補うしかない。
- **提案**: 課題レイヤと同列に「状態レイヤ」トグルを追加。ON のとき status=todo のノードは枠線を点線+彩度落とし、heard は通常、review は amber の細枠、done は左上に小さな✓バッジを描画。flowSvg.ts のエクスポートにも同じ描き分けを反映できるようオプション化。CSS クラス（.node.st-todo 等）でテーマ両対応にする。
- **検証メモ**: FlowCanvas.tsx:369 の showIssues フィルタは記載どおり実在し、状態レイヤは存在しない。キャンバスは SVG + className ベース描画（node issue 等のクラス付与を確認）なので .st-todo 等の CSS クラス追加は自然に収まる。1点注意: flowSvg.ts のエクスポートは CSS クラスではなく FLOW_LIGHT のインライン fill/stroke 属性で描いている（常にライト固定）ため、「CSS クラスでテーマ両対応」はキャンバス側のみの話で、エクスポート側は属性値の出し分けで実装することになる。トグル状態は store.ts の showIssues と同様に useApp へ追加すればよい。
- **主な変更ファイル**: apps/desktop/src/FlowCanvas.tsx, apps/desktop/src/flowSvg.ts, apps/desktop/src/ui/useUI.ts, apps/desktop/src/styles.css

### 14. レーンラベルのダブルクリックで担当名を一括リネーム
**影響: 中 / 規模: M**

- **問題**: スイムレーンのラベル（FlowCanvas.tsx:1400-1453）は並べ替え（▲▼）と高さ変更しかできず、担当（部門）名を変える手段がない。store にも担当のリネーム API がなく（ensureAssigneeId は名前一致検索のみ、store.ts:232-239）、部門名の変更（例: 組織改編で『購買部』→『調達部』）には全工程の担当セルを1つずつ打ち直すしかない。
- **提案**: レーンラベルをダブルクリックで input に切り替え、Enter 確定で store に新設する renameAssignee(assigneeId, name) を呼ぶ（assignee.name を更新する undo 対応コマンドを core/commands に追加）。同名の既存担当と衝突する場合は『統合しますか？』の確認を出して assigneeId を付け替え統合。表・課題一覧・サマリ・レーンタイトルは assignee 参照なので自動で追従する。
- **検証メモ**: 未実装を確認。レーンラベル（FlowCanvas.tsx:1400-1453）は並べ替え▲▼と高さ変更のみで、リネーム手段は無い。core/commands/index.ts には addAssignee/setAssignee のみで renameAssignee は無く、store の ensureAssigneeId（store.ts:232-240）も名前一致検索＋新規作成のみ。実装は現実的（レーンレールは HTML div なので input 化は容易、commit パイプラインで undo 対応も標準的）だが、提案に事実誤認が1点: lane.title はレーン生成時にのみ assignee 名からコピーされ（sync/reconcileFlow.ts:156-161）、既存レーンのタイトルは reconcile で更新されないため「レーンタイトルは assignee 参照なので自動で追従する」は誤り。renameAssignee コマンド側で全ビューの該当 lane.title も更新するか、reconcileFlow に既存レーンのタイトル再同期を追加する必要がある（表・課題一覧・サマリは assignee.name 直参照なので追従する）。また未割当擬似レーン（id '_'、FlowCanvas.tsx:1431 参照）はリネーム対象外にするガードが必要。同名衝突時の統合（assigneeId 付け替え＋旧担当と旧レーンの削除）も実装可能だが提案の見積もりよりやや作業が多い。
- **主な変更ファイル**: apps/desktop/src/FlowCanvas.tsx, apps/desktop/src/store.ts, packages/core/src/commands/index.ts, apps/desktop/src/styles.css

### 15. パレット工程ジャンプのフロー追従（ノード選択＋センタリング）
**影響: 中 / 規模: S**

- **問題**: パレットの工程検索ジャンプ（taskOps.ts:11-20 revealTask）は粒度・スコープを合わせてインスペクタを開くだけで、フロー側はパンしない。ズーム中だと選択されたノードが画面外のままで、フロー作業中の検索ジャンプとして機能しない。
- **提案**: revealTask 後、アクティブペインがフロー（または flowWide 状態）の場合は該当工程ノードへパンして画面中央に表示し、選択ハイライトを約1秒パルスさせて視線誘導する。useUI に「centerOnTask: Id | null」の一時状態を追加し、FlowCanvas が購読してパン実行後にクリアする方式で実装。
- **検証メモ**: 未実装を確認。revealTask（taskOps.ts:11-20）は select/setLevel/setScope/インスペクタ表示のみでフローはパンしない。FlowCanvas の scrollIntoView はキーボードナビ（selectNodeById:459-463）と接続モード（138-144）の内部操作時のみで、外部からの選択変更には追従しない。実装可能: fitView（404-427）が scrollLeft=論理座標×scale の換算を既に実証しており、useUI に一時状態を足して FlowCanvas が消費する方式は registerOverlayCloser 等の既存パターンと整合。ただしリスト内の「表⇔フローの双方向ビューポート追従ジャンプ」がフロー側センタリング機構（centerOnTask 相当）を完全に包含する上位互換案で、本案はその部分集合＝実質重複。
- **主な変更ファイル**: apps/desktop/src/taskOps.ts, apps/desktop/src/FlowCanvas.tsx, apps/desktop/src/ui/useUI.ts

### 16. キャンバス上の工程作成直後にその場リネーム開始
**影響: 中 / 規模: S**

- **問題**: 空白ダブルクリックやパレットの「工程＋」で作成される工程は既定名「新規工程」のまま（store.ts:546-571。コメントで『リネームは表/インスペクタで』と明記）。名前を付けるには作成後にもう一度ダブルクリックか F2 が必要で、連続して工程を起こすヒアリング場面では毎回2アクション余計にかかる。「新規工程」が量産されて後から区別できなくなる事故も起きやすい。
- **提案**: addTaskAt が新規タスク ID を返すように変更し（現在も selectedTaskId に同期済みなので互換は容易）、onCanvasDoubleClick とパレット「工程＋」の直後に setEditingTaskId(newId) を呼んで全選択状態のインライン入力を即表示する。Enter で確定、Esc なら既定名のまま残す（既存の commitNodeRename の規約どおり未変更 blur は履歴を汚さない）。
- **検証メモ**: 未実装を確認。store.ts:546-571 の addTaskAt は『新規工程』固定名で作成し（:553 のコメント『リネームは表/インスペクタで』も実在）、戻り値は void。FlowCanvas.tsx の onCanvasDoubleClick(:233-242) もパレット『工程＋』(:843-854) もリネームを開始しない。一方 setEditingTaskId(:111) と commitNodeRename(:73-75) は既存で、addTaskAt は既に selectedTaskId: newId を sync(:570) しているため Id を返す変更は互換的。addChildTask/addSiblingOf が Id を返す前例もあり、提案どおり小改修で実装可能。
- **主な変更ファイル**: apps/desktop/src/FlowCanvas.tsx, apps/desktop/src/store.ts

### 17. ミニマップの選択ハイライトとダブルクリック全体表示
**影響: 低 / 規模: S**

- **問題**: FlowMinimap（FlowCanvas.tsx:1472-1582）は全ノードを kind 別の同色矩形で描くだけで、選択中の工程・複数選択がどこにあるか俯瞰図から分からない。ズーム率が高い時に「選択ノードまで戻る」手段がミニマップ上に無く、当てずっぽうのクリックになる。
- **提案**: mm-node に selectedTaskId / multiSel / sel と照合した mm-selected クラスを付与しアクセント色（--accent）で塗る。これでミニマップが「選択がどこか」のレーダーになる。さらにミニマップのダブルクリックで fitView（全体表示）を実行、title ツールチップに現在ズーム率を併記。FlowMinimap への props は selectedIds: Set<string> を1つ足すだけで親の再レンダリング構造は維持する。
- **検証メモ**: 未実装を確認。FlowMinimap(FlowCanvas.tsx:1472-1582) の mm-node は kind 別クラスのみ(:1574)で選択ハイライト無し、ハンドラは pointerdown のパンのみ(:1550-1560)でダブルクリックも無い。実装は可能だが提案に2点の不正確さ: (1) 『props は selectedIds 1つだけ』とあるが、ダブルクリックで fitView を呼ぶには onFit コールバック props も必要（fitView は親に定義、:404）。(2) task ノードの選択は taskId 基準(selectedTaskId)・ミニマップ矩形は node id 基準なので、親側で node id への変換が必要。また pointerdown のパンが dblclick より先に2回発火するため、パン後にフィットで上書きされる挙動の調整が要る。
- **主な変更ファイル**: apps/desktop/src/FlowCanvas.tsx, apps/desktop/src/styles.css

## コマンドパレット・キーボード（8案）

### 18. パレットの工程クイック追加DSL（@担当・#粒度・工数を1行指定）
**影響: 高 / 規模: M**

- **問題**: パレットの「工程を追加」コマンド（CommandPalette.tsx:202-216）は無引数で、追加後に担当・粒度・工数・前工程を別コマンドや表で1つずつ設定する必要がある。ヒアリング中の高速入力では1工程あたり3〜4操作かかり、ユーザーが求める「コマンドで担当付き工程を即追加」ができない。
- **提案**: add-task を freeText の引数付きコマンドにし、「受注確認 @営業 #小 2h >受注登録」のようなトークンを解釈（@=担当・#=粒度・数値h=工数・>=前工程のコード/名称）。入力中に解釈結果を入力欄下にチップ（担当: 営業／粒度: 小／工数: 2h／前工程: 受注登録）でリアルタイム表示し、Enter で1 undo単位で作成。store に addTaskWithOptions を追加し cAddTask＋ensureAssigneeId＋cUpdateTaskDetail＋cAddDependency を合成。担当指定時はフロー側で該当レーンへ自動配置される（既存 reconcile に乗る）。
- **主な変更ファイル**: apps/desktop/src/ui/CommandPalette.tsx, apps/desktop/src/store.ts, apps/desktop/src/suggestions.ts, apps/desktop/test/commandPalette.test.ts

### 19. 直前コマンドのリピート実行（Ctrl+. と「もう一度」行）
**影響: 高 / 規模: M**

- **問題**: 引数コマンド（例: 担当を設定 "営業"）を複数の工程へ順に適用するには、行ごとに Ctrl+K→検索→引数入力の全手順を繰り返すしかない。CommandPalette.tsx に実行履歴の記録がなく、Vim の . に相当する再適用手段がない。
- **提案**: 最後に実行したコマンドID＋引数値を保持し、Ctrl+.（global バインド）で現在選択中の工程へ同じ値を再適用する。パレットを開いた直後の先頭に「もう一度: 担当を設定 "営業"」行を表示し Enter 一発で再実行。j→Ctrl+.→j→Ctrl+. の連打で実質的な一括適用が可能になる。再適用不能なコマンド（ファイル系等）は記録対象外。
- **主な変更ファイル**: apps/desktop/src/ui/CommandPalette.tsx, apps/desktop/src/keymap.ts, apps/desktop/src/ui/useGlobalHotkeys.ts

### 20. パレット引数コマンドの連続実行モード（Shift+Enterで開いたまま）
**影響: 高 / 規模: S**

- **問題**: 引数確定処理 commitArg（CommandPalette.tsx:707-717）は必ず close() でパレットを閉じる。課題・I/O・工程を複数件入力する場面では毎回 Ctrl+K→コマンド検索→引数入力をやり直すことになり、連続入力が成立しない。
- **提案**: 引数モード中の Shift+Enter を「確定して引数モードに留まる」にする。確定のたびに入力欄をクリアして次の入力を受け付け、コマンドチップの横に「3件追加」とカウンタを表示。空欄 Enter または Esc で終了。対象は freeText 系（課題を追加・インプット/アウトプット追加・付箋・工程クイック追加）。入力欄フッターに「Shift+Enter=連続追加」のキーヒントを常時表示。
- **主な変更ファイル**: apps/desktop/src/ui/CommandPalette.tsx

### 21. パレットの1行インライン引数（「担当 営業」で一発確定）
**影響: 中 / 規模: M**

- **問題**: 引数付きコマンドは必ず「コマンド選択→引数モード」の2段階（CommandPalette.tsx:675-684 enterArgMode）を踏む。頻用コマンドでもタイプ数と Enter 回数が減らせず、候補と自由入力の往復も Backspace/Esc 頼みで遠回り。
- **提案**: コマンド一覧モードで「コマンド名（の一部）＋スペース＋残り」を入力すると、残りを引数として解釈し候補行に「担当を設定: 営業」と実行プレビューを表示、Enter で2段階を踏まず即実行する。validate エラーは候補行直下に赤字でインライン表示（既存 palette-error を流用）。曖昧な場合は従来どおり引数モードへフォールバック。
- **検証メモ**: 未実装を確認。CommandPalette.tsx は厳密に2段階（runItem:727-729 で arg 付きコマンドは必ず enterArgMode:675-684 へ）。コマンド一覧モードに引数解釈は一切ない。実装は現実的: fuzzyScore・ArgSpec(options/validate/freeText)・palette-error(785行) が揃っており、cmdHits 生成時に「先頭トークン=コマンド一致＋残り=引数」を試す拡張は PaletteBody 内で完結する。注意点: ラベル・keywords に空白や日本語が混在するためトークン分割の曖昧性解決（提案どおり引数モードへのフォールバック）が必須。「パレットの工程クイック追加DSL」（工程追加専用の@/#記法）と思想は近いが対象が異なり重複ではない。
- **主な変更ファイル**: apps/desktop/src/ui/CommandPalette.tsx, apps/desktop/test/commandPalette.test.ts

### 22. キーボードでの行マーク（Space/Shift+j/k で複数選択）
**影響: 中 / 規模: M**

- **問題**: 全項目表の複数選択はマウス専用（Ctrl/Shift+クリック、FullTable.tsx:344-368）。せっかく j/k 行移動の選択モードがあるのに、キーボードから一括操作対象を組み立てられず、選択モード→マウス→選択モードの持ち替えが発生する。
- **提案**: table コンテキストに table.mark（x キー: 現在行のマークをトグルして次行へ）と table.markRange（Shift+J/K: 移動しながら範囲マーク）、table.markAll（表示中の全行マーク）を追加。runTableAction から FullTable の marked 状態を操作できるよう、RowSelectionOpts に onMark コールバックを追加。Space は既存の折りたたみと衝突するため x を既定にし、キーバインドエディタで変更可能に。
- **主な変更ファイル**: apps/desktop/src/ui/useRowSelectionKeys.ts, apps/desktop/src/FullTable.tsx, apps/desktop/src/keymap.ts

### 23. パレットに「最近使った操作」セクション＋頻度順ブースト
**影響: 中 / 規模: S**

- **問題**: 空クエリ時のコマンド一覧は定義順固定の先頭14件（CommandPalette.tsx:635 の slice）で、ユーザーがよく使うコマンドでも毎回検索文字を打つ必要がある。使用履歴・頻度の概念がない。
- **提案**: コマンド実行時に ID と回数を localStorage に記録（settings.ts の collectSettings/applySettings に含めて設定エクスポートにも乗せる）。空クエリ時は最上部に「最近」セクション（直近5件）を表示し、開いた直後に Enter だけで直前コマンドを再選択できる。検索時もファジースコア同点なら使用頻度の高い方を上位に出す。
- **検証メモ**: 未実装を確認。空クエリ時は定義順の先頭14件（CommandPalette.tsx:635 slice(0, query ? 6 : 14)）で、使用履歴・頻度の概念はコードベースのどこにもない（settings.ts の SettingsFile にも該当フィールドなし）。実装可能: runItem/commitArg で ID を localStorage に記録し、collectSettings/applySettings（settings.ts:105-127）への追加も「不明キーは無視」の検証ポリシーのため後方互換。注意: commands は available 付きで毎回再構築されるため、履歴 ID→コマンドの再解決時に available=false の除外が必要。「直前コマンドのリピート実行（Ctrl+. と「もう一度」行）」と『直前コマンドの再実行』部分が重なるが、あちらは引数込みの再実行、こちらは並び替えで別物。
- **主な変更ファイル**: apps/desktop/src/ui/CommandPalette.tsx, apps/desktop/src/settings.ts

### 24. 選択ノードへのズームフィット（Shift+F）
**影響: 中 / 規模: S**

- **問題**: fitView（FlowCanvas.tsx:403-427）は常に全ノードの外接矩形が対象で、「いま議論している3工程だけを画面いっぱいに見たい」ができない。大規模フローでは全体フィット後に手動でズーム＆パンし直すことになる。
- **提案**: fitView を矩形引数を取る fitTo(rect) に一般化し、multiSel（複数選択）または選択中の単一ノードの外接矩形＋余白56pxへズーム・スクロールする「選択にフィット」を追加。keymap.ts の flow コンテキストに Shift+F（action: flow.fitSelection）を登録し、パレットの「全体」ボタンは選択がある時だけ「選択」ボタンを隣に出す。選択が無ければ従来どおり全体フィットにフォールバック。
- **検証メモ**: 未実装を確認。fitView(FlowCanvas.tsx:403-427) は常に全ノードの外接矩形対象で矩形引数は取らず、keymap.ts の flow コンテキストは f=flow.fit(:134) のみで fitSelection は無い。矩形引数化＋multiSel/sel/selectedTaskId からの外接矩形計算は既存コードの素直な一般化で実装可能。修正提案: Shift+F は mod/alt なしの単キー扱いで isSingleKeyChord(keymap.ts:322-328) に該当し、既定（シングルキーOFF）では無効化される。既存の f と同条件なので一貫はするが、『既定で使えるキー』を意図するなら mod 付きにするか fixed 指定が必要。
- **主な変更ファイル**: apps/desktop/src/FlowCanvas.tsx, apps/desktop/src/keymap.ts

### 25. フローの全選択（Ctrl/⌘+A）と選択件数バッジ
**影響: 中 / 規模: S**

- **問題**: keymap.ts の flow コンテキストに全選択が存在せず、全ノードをまとめて動かす/消すには Shift+ドラッグで全域を囲むしかない。また複数選択中に「いま何個選んでいるか」を示す UI がなく（multi-sel クラスの枠線のみ）、大量ノードでは選択状態の把握が困難（既知の問題点4）。
- **提案**: keymap.ts に { action: 'flow.selectAll', context: 'flow', chord: { key: 'a', ctrl: true } } を追加し、task/control/comment 全件を multiSel に投入。あわせてパレット右端に複数選択中のみ「○件選択中 ｜ 解除」バッジを表示し、解除ボタンで multiSel をクリア。バッジは選択合計の移動・削除の操作対象を明示する役割も担う。
- **検証メモ**: 未実装を確認。grep で selectAll は 0 件、keymap.ts の flow コンテキストに全選択は無く、複数選択の件数表示 UI も無い（multi-sel クラスの枠線のみ、FlowCanvas.tsx:1100）。multiSel は FlowCanvas のローカル state だが、flowActionsRef 経由のアクション追加(:476-603) という既存パターンに乗るため実装は容易。パレットへのバッジ追加も flow-palette(:841-912) に kbConnect ヒントを出し分ける前例があり可能。修正提案: Chord 型に ctrl フィールドは無く mod を使う(keymap.ts:24)ため、提案の chord は { key: 'a', mod: true } が正。ブラウザ既定の全選択抑止に preventDefault も必要。
- **主な変更ファイル**: apps/desktop/src/keymap.ts, apps/desktop/src/FlowCanvas.tsx, apps/desktop/src/styles.css

## 工程表テーブルの編集体験（12案）

### 26. 全項目表の一括編集を主要列全体に拡大（粒度・工数・自動化・色）
**影響: 高 / 規模: M**

- **問題**: 複数選択時の一括操作が「担当を一括設定」「まとめて削除」の2つだけ（FullTable.tsx:371-385・503-509）。例えば20行の自動化区分や塗り色を揃えるには20回の個別セル編集が必要で、ヒアリング後の整理作業が遅い。
- **提案**: ft-bulk バーに「一括変更…」ドロップダウンを追加し、粒度／工数／自動化区分／難易度／塗り色／文字色を選ぶと値入力（promptText または選択メニュー）→マーク全件へ1 undo で適用。store に setLevelMany・updateDetailMany（複数IDへ同一パッチ）を追加し、適用後に「12件に適用しました」をトースト表示。同じアクションをパレットにも「選択行の粒度を一括変更…」として登録する。
- **主な変更ファイル**: apps/desktop/src/FullTable.tsx, apps/desktop/src/store.ts, apps/desktop/src/ui/CommandPalette.tsx

### 27. 編集中のEnter/Tabセル移動をExcel流に統一
**影響: 高 / 規模: M**

- **問題**: アウトラインの Enter は『確定して選択モードへ』（TableView.tsx:374-379）、全項目表は『同列の下セルへ移動』（FullTable.tsx:454-461）と挙動が割れている。さらに全項目表の下移動は担当・工数列にしか data-r/data-c が付いておらず、作業名・テキスト列では機能しない。Tab はブラウザ既定のフォーカス移動のため、I/O チップ内の種別 select や×ボタンに止まり、隣のセルへ素直に移動できない。
- **提案**: 両ビュー共通の編集中ナビゲーション規約を導入する。Enter=確定して同列の下セルへ、Shift+Enter=上セルへ、Tab/Shift+Tab=確定して右/左の編集可能セルへ移動（data-cell 属性を全編集セルに付与し、useRowSelectionKeys の focusCell を再利用して移動先を解決）。アウトラインの名前入力中 Tab=インデントは行選択モード（既存 table.indent）に一本化し、編集中はセル移動に統一。textarea セルだけは Enter=改行を維持し Ctrl+Enter は行追加のまま。
- **検証メモ**: 問題認識はほぼ正確: TableView.tsx:374-379 の Enter は確定+blur、FullTable.tsx:454-461 の Enter 下移動は data-r/data-c 依存で、付与されているのは担当 (686-687) と工数 (753-754) の input のみ。作業名は FullTable.tsx:652-658 で Enter=確定+blur（stopPropagation）なので「全項目表は下移動」は担当・工数列に限る点だけ補足。Tab はどちらのビューも編集中ハンドリングなし（アウトラインの名前入力のみ Tab=インデント TableView.tsx:384-389）。提案が再利用を想定する focusCell は useRowSelectionKeys.ts:71 に存在するがモジュール内 private なので export 化が必要。data-cell 属性は両ビューにすでに広く付与済みで、移動先解決の下地はある。実装可能。
- **主な変更ファイル**: apps/desktop/src/TableView.tsx, apps/desktop/src/FullTable.tsx, apps/desktop/src/ui/useRowSelectionKeys.ts

### 28. アウトラインのクイックフィルタと一致ハイライト
**影響: 高 / 規模: M**

- **問題**: フィルタ・検索は全項目表のみで、アウトラインは常に全行表示（TableView.tsx にフィルタ UI なし）。数百工程の案件では折りたたみと目視スクロールしか到達手段がなく、コマンドパレットの検索ジャンプは1件ずつしか飛べない。
- **提案**: outline-actions に検索ボックスを追加（Ctrl+F または / でフォーカス、Esc でクリア）。入力中は作業名・担当に部分一致する行とその祖先のみを buildOutline 結果からフィルタ表示し、一致文字列を <mark> でハイライト（name-input は読み取り表示に切替えず、input の背景ハイライトで代替可）。ヒット件数『12件一致』をボックス横に表示し、Enter で次の一致行へ選択ジャンプ。
- **検証メモ**: 確認済み: TableView.tsx にフィルタ/検索UIなし（絞り込みは FullTable.tsx:174-179, 516-571 のみ）。buildOutline 結果のフィルタ＋祖先保持は純粋関数で容易。実装可能。ただしキー割当に注意: '/' は既に global.palette に割当済み（keymap.ts:57 palette-slash）なので「/ でフォーカス」は競合する。Ctrl+F は未使用なのでそちらを推奨。また name-input は input 要素のため <mark> ハイライトは不可で、提案自身が認める背景ハイライト代替が現実解。
- **主な変更ファイル**: apps/desktop/src/TableView.tsx, apps/desktop/src/styles.css, apps/desktop/src/keymap.ts

### 29. datalist置き換えのカスタムオートコンプリート（担当・I/O名）
**影響: 中 / 規模: L**

- **問題**: 担当・I/O 名の補完はネイティブ datalist 依存で、部分一致の挙動がブラウザ実装任せ・候補のスタイル統一不可・タイプ中のリアルタイム絞り込みが弱い。collectIoNames（suggestions.ts:6-15）がせっかく頻度順で候補を返すのに、表示順に活かされない。表記ゆれ（受注伝票 vs 受注表）防止という本来の目的に届いていない。
- **提案**: 共有 Combobox コンポーネントを新設: 入力中に頻度順候補をリアルタイム部分一致で最大8件ポップ表示、↑↓+Enter で選択、完全一致がない場合は先頭に『新規: ○○』を表示して意図しない新名称作成を自覚させる。アウトライン/全項目表の担当セル・I/O チップ名の4箇所の datalist を置き換え。role=combobox + aria-activedescendant で a11y 維持。
- **検証メモ**: 確認済み: 補完は全てネイティブ datalist。collectIoNames (suggestions.ts:6-15) は確かに頻度順を返すが datalist の表示順はブラウザ任せ。Combobox 相当のコンポーネントは存在しない（grep で combobox 0件）。ただし「4箇所」は不正確: datalist 付き input は TableView担当(406)・FullTable担当(682)・FullTable I/O名(992) の3箇所＋Inspector に2箇所（insp-depts:303, insp-io-names:279）の計5箇所で、アウトラインの I/O チップ名 (TableView.tsx:504 io-chip-name) には現状 datalist が付いていない（ここは置き換えではなく新規追加になる）。共有 Combobox の新設は React で標準的なパターンであり実装可能。重複なし。
- **主な変更ファイル**: apps/desktop/src/TableView.tsx, apps/desktop/src/FullTable.tsx, apps/desktop/src/suggestions.ts, apps/desktop/src/styles.css

### 30. アウトラインにも複数選択（V で範囲マーク → 一括操作）
**影響: 中 / 規模: M**

- **問題**: 複数選択（marked）は全項目表のみで、アウトライン（TableView.tsx）には概念自体がない。連続する兄弟工程の削除・担当変更・インデントを1行ずつ繰り返す必要があり、行選択モード（j/k）の速度が活きない。
- **提案**: 行選択モードに V キーで「範囲マーク」を導入（Shift+J/K でも伸縮）。アンカー行から j/k で範囲を拡大縮小し、マーク行は背景ハイライト。マーク中は Delete=一括削除（既存 confirmRemoveTasks に複数ID）、a=担当一括設定、Tab/Shift+Tab=一括インデント/アウトデント、Esc=解除。マウスの Ctrl/Shift+クリックも全項目表と同じ挙動に統一する。
- **主な変更ファイル**: apps/desktop/src/TableView.tsx, apps/desktop/src/ui/useRowSelectionKeys.ts, apps/desktop/src/keymap.ts

### 31. 行ドラッグ&ドロップの視覚フィードバック強化
**影響: 中 / 規模: M**

- **問題**: ドロップ先は行高の上28%/下28%/中央でモードが切り替わる（TableView.tsx:269-291）が、ユーザーにはこの3分割が見えず、『並べ替えのつもりが子になった』事故が起きやすい。ドラッグゴーストもブラウザ既定の行スナップショットのままで、何をどこへ運んでいるか不明瞭。
- **提案**: (1) dragstart で setDragImage に行名+粒度バッジのカスタムゴーストを設定。(2) before/after は行間に 2px のアクセント色挿入線+左端に▶マーカー、child は対象行全体を枠ハイライト+『子にする』ラベルをカーソル付近に表示（既存 drop-* クラスの CSS を拡張）。(3) ドロップ確定後、移動した行を1秒間フラッシュして着地点を示す。
- **主な変更ファイル**: apps/desktop/src/TableView.tsx, apps/desktop/src/styles.css

### 32. アウトラインの列幅ドラッグ調整
**影響: 中 / 規模: M**

- **問題**: 列幅調整は全項目表のみ（startResize / ftColWidths）。アウトラインは固定幅（TableView.tsx:226 の minWidth 計算のみ）で、深い階層+長い作業名・複数の前工程名が見切れ、title ホバーでしか全文確認できない。
- **提案**: FullTable の startResize と useUI の ftColWidths/setFtColWidth と同型の outlineColWidths を useUI に追加し localStorage 永続化。担当・前工程・工数・I/O 列のヘッダ右端にリサイズハンドルを置き、最小40pxでドラッグ調整可能に。作業名列は残幅を使う flex のまま（リサイズ対象外）にして表全体の破綻を防ぐ。
- **主な変更ファイル**: apps/desktop/src/TableView.tsx, apps/desktop/src/ui/useUI.ts, apps/desktop/src/styles.css

### 33. 表末尾のゴースト行（クリック/Enterで新規工程入力）
**影響: 中 / 規模: M**

- **問題**: 行追加の入口がツールバーのボタン・各行の＋・Ctrl+Enter・n キーに分散しており、Excel ユーザーが最初に試す『一番下の空行に直接打ち込む』ができない。特に全項目表で最終行から Enter 下移動すると何も起きず行き止まり感がある。
- **提案**: 両ビューの tbody 末尾に常設のゴースト行（薄字プレースホルダ『＋ 新しい工程…』）を追加。クリックまたは最終行からの Enter 下移動でゴースト行の作業名入力にフォーカスし、文字を確定（blur/Enter）した時点で addRootTask または addSiblingOf（最終行と同じ親・粒度）を実行して通常行へ昇格、次のゴースト行へフォーカス継続（連続入力）。空のまま離脱したら何も追加しない。
- **主な変更ファイル**: apps/desktop/src/TableView.tsx, apps/desktop/src/FullTable.tsx, apps/desktop/src/styles.css

### 34. 課題一覧での課題・方策のインライン編集
**影響: 中 / 規模: M**

- **問題**: 課題一覧は読み取り専用で、行クリック=工程ジャンプのみ（IssueListDialog.tsx:99）。方策を一覧で見ながらまとめて書き込みたい場面（ヒアリング後の整理タイム）で、1件ごとに「ジャンプ→インスペクタで編集→課題一覧を開き直す」往復が必要。undo 対応の updateIssue API は store に既にある（store.ts:498）。
- **提案**: 課題セル・方策セルをクリックで textarea に切り替え、blur/Ctrl+Enter で updateIssue を呼んで確定（Esc でキャンセル）。工程ジャンプは行クリックから「工程名セルのクリック」に限定し、title 属性も更新。編集中はダイアログの Esc クローズを抑止（既存の closeTopLayer 優先度に編集状態を追加）。
- **検証メモ**: IssueListDialog は読み取り専用で行クリック=ジャンプ（99行）は記載どおり。updateIssue は store.ts:498 に実在し、シグネチャ Partial<Pick<IssueItem,'issue'|'measure'|'target'>> で課題・方策の編集に十分、undo 系 commit 経由も確認。Esc 抑止も useUI.registerOverlayCloser（useUI.ts:401、CommandPalette が同パターンを既用）という既存の差し込み口があり、提案の「closeTopLayer 優先度に編集状態を追加」はそのまま実現可能。Inspector.tsx:330-351 に同等の blur 確定パターンが既にあり流用できる。
- **主な変更ファイル**: apps/desktop/src/ui/IssueListDialog.tsx, apps/desktop/src/store.ts, apps/desktop/src/styles.css

### 35. Enter下移動が親行で止まる不具合の解消（次の編集可能セル探索）
**影響: 中 / 規模: S**

- **問題**: 全項目表の Enter 下移動は `input[data-r="N+1"][data-c]` を1行先だけ直接参照する（FullTable.tsx:459-461）。次の行が親工程の場合、工数セルはロールアップの span で input が存在せずフォーカス移動が無反応になる。連続して工数を入力していく作業（ヒアリング後の工数埋め）が親行のたびに途切れる。
- **提案**: data-r+1 固定参照をやめ、現在の tr から tbody 内の後続 tr を順に辿り、同じ data-c を持つ最初の input が見つかるまでスキップするループに変更（行 ID ベースで data-r 依存も解消）。逐次レンダ境界に達したら renderCount を1チャンク広げてから再試行。末尾に達したら『Ctrl+Enter で行を追加』のヒント toast を一度だけ表示。
- **検証メモ**: バグの実在を確認: FullTable.tsx:459-461 は `input[data-r="${r+1}"][data-c]` の1行先直接参照。親行の工数セルは hasChildren 時に span.ft-roll（FullTable.tsx:739-742）で input が存在せず、next が null になり focus が無反応になる。逐次レンダ（ROW_CHUNK=150, renderCount state あり）の境界対策も提案どおり renderCount 拡張で対応可能（focusTask の同等パターンが 301-312 に既存）。実装可能。案2（Enter/Tab統一）の Enter 下移動を完全実装すればこの探索ロジックを内包するため強い重なりはあるが、こちらは単独のバグ修正としてスコープが異なるので重複とまでは言えない。
- **主な変更ファイル**: apps/desktop/src/FullTable.tsx

### 36. 一括操作の結果トースト（担当一括設定の件数・内容フィードバック）
**影響: 中 / 規模: S**

- **問題**: 全項目表の担当一括設定（FullTable.tsx:371-381 bulkAssign）は setAssigneeManyByName 実行後に選択解除するだけで結果通知がない。選択も同時に消えるため、何件にどの担当が設定されたのかを確認する手段がなく、操作が成功したのか不安が残る。
- **提案**: bulkAssign 完了後に toast(「12 件の担当を「営業」に設定しました」, 'success')（空欄指定時は「12 件を未割当にしました」）を表示。案3導入後は「元に戻す」アクションも付ける。貼り付け追加（onPasteRows）と同じフィードバック様式に揃え、一括系操作は必ず件数つきで結果を返すという一貫ルールにする。
- **検証メモ**: 問題認識は正確。FullTable.tsx:371-381 の bulkAssign は setAssigneeManyByName → clearMarked のみでトースト無し。同ファイルの onPasteRows（line 396-399）は件数つき success トーストを出しており、提案どおり様式を揃えるのは数行の変更で済む。件数は marked.size を実行前に保持すれば取れる（setAssigneeManyByName は void 返し、store.ts:98）。空欄=未割当の分岐も prompt メッセージ（line 374「空欄で未割当」）と整合。「元に戻す」アクション部分のみ、toast() がアクション非対応（useUI.ts:417-420）のため別案「破壊的操作のトーストに「元に戻す」アクションボタン」の基盤に依存。
- **主な変更ファイル**: apps/desktop/src/FullTable.tsx, apps/desktop/src/ui/useUI.ts

### 37. 列幅リセットとダブルクリック既定幅復帰
**影響: 低 / 規模: S**

- **問題**: 全項目表の列幅はドラッグ調整のみで、既定に戻す手段がない。誤って最小40pxまで縮めた列（特にテキスト列）を元の感覚に戻すには手作業の再調整しかなく、ftColWidths が localStorage 永続のため作り直しても直らない。
- **提案**: ft-resize ハンドルのダブルクリックでその列を既定幅（FT_COLUMNS の width）へ復帰、列メニュー末尾に『列幅をすべてリセット』項目を追加（useUI に resetFtColWidths を追加して localStorage キーを削除）。ハンドルの title に『ドラッグで調整 / ダブルクリックで既定に戻す』と明記。
- **主な変更ファイル**: apps/desktop/src/FullTable.tsx, apps/desktop/src/ui/useUI.ts

## フィードバック・学習容易性（15案）

### 38. 表⇔フロー同期の変更箇所フラッシュハイライト（SyncReport の活用）
**影響: 高 / 規模: M**

- **問題**: 表を編集するとフロー図が自動同期されるのがアプリのコア価値だが、「フローのどこが変わったか」が視覚的に示されない。reconcileFlow は追加/削除ノードIDを SyncReport として返しているのに、reconcileProject.ts:12 で .view だけ取り出して report を捨てており、UI は一切活用していない。
- **提案**: reconcileProject が各ビューの SyncReport を返すようにし、store.ts の commit() で「現在表示中ビューの added ノードID」を lastSyncAdded として保持。FlowCanvas が該当ノードに .node-flash クラスを付与し、CSS キーフレームでアクセント色のアウトラインが約1.5秒かけてフェードアウトする。逆方向（レーン移動→担当更新）の場合は表側の担当セルにも同じフラッシュを適用。連続編集時は最新の変更のみ光らせる（タイマーリセット）。
- **主な変更ファイル**: packages/core/src/sync/reconcileProject.ts, packages/core/src/sync/reconcileFlow.ts, apps/desktop/src/store.ts, apps/desktop/src/FlowCanvas.tsx, apps/desktop/src/styles.css

### 39. Undo/Redo に「何を戻したか」のラベル付きトーストとツールチップ
**影響: 高 / 規模: M**

- **問題**: store.ts:717-721 の undo/redo は history.undo()/redo() を呼んで再描画するだけで、何が戻ったのか通知がない。大きな図で画面外の変更が戻った場合、ユーザーは「Ctrl+Z が効いたのか」「何が戻ったのか」を確認できない。ツールバーの戻すボタンの title も「戻す (Ctrl+Z)」固定（App.tsx:375）。
- **提案**: store.ts の commit()/editView() に操作ラベル（例:「工程を削除」「担当を一括設定」「ノードを移動」）を渡し、履歴と並行したラベルスタックを保持。undo 実行時に toast(「元に戻しました: 工程を削除」, 'info')、redo 時に「やり直しました: …」を表示。ツールバーボタンの title を「戻す: 工程を削除 (Ctrl+Z)」と次に戻る操作名入りに動的更新する。
- **主な変更ファイル**: apps/desktop/src/store.ts, apps/desktop/src/App.tsx, apps/desktop/src/ui/useUI.ts

### 40. 破壊的操作のトーストに「元に戻す」アクションボタン
**影響: 高 / 規模: M**

- **問題**: トーストは useUI.ts:417-420 の toast(message, tone) のみでアクションを持てない。特にフロー図の矢印右クリック削除は確認なしの即削除で、誤削除に気づいても Ctrl+Z を知らないユーザーは復帰手段が分からない（調査済みの誤削除リスク）。
- **提案**: ToastItem に任意の action?: { label: string; run: () => void } を追加し、Dialogs.tsx の ToastView にアクションボタン（例:「元に戻す」）を描画。クリックで run()（= useApp.getState().undo()）実行後にトーストを即時消去。適用箇所: 矢印右クリック削除（FlowCanvas）、工程削除・一括削除（taskOps.ts confirmRemoveTasks 後）、担当一括設定。アクション付きトーストは表示時間を6秒に延長する。
- **主な変更ファイル**: apps/desktop/src/ui/useUI.ts, apps/desktop/src/ui/Dialogs.tsx, apps/desktop/src/FlowCanvas.tsx, apps/desktop/src/taskOps.ts, apps/desktop/src/styles.css

### 41. プロジェクト検証パネル（整合性チェック＋業務リント）
**影響: 高 / 規模: M**

- **問題**: core の validate()（packages/core/src/validate.ts:10）はファイル読込時の strict エラー専用で、編集中に任意実行する UI がない。さらに参照整合性だけでなく『担当未設定の工程』『工数未入力の末端工程』『前後関係が1本もない孤立工程』『方策未記入の課題』のような納品前に潰すべき業務的な抜けを機械チェックする手段がなく、目視レビューに頼っている。
- **提案**: コマンドパレットとメニューに「プロジェクトを検証」を追加。実行すると validate() の結果＋業務リント（上記4種、core に lintProject() として純粋関数で追加）をダイアログに重要度別（エラー/警告）に一覧表示し、各行クリックで該当工程へジャンプ（IssueListDialog.tsx:42 の jump と同じ select+setLevel+setScope 方式）。0件なら「問題は見つかりませんでした」を表示。出力前（Excel/印刷）に警告があれば確認を挟むオプションも設定に追加。
- **検証メモ**: 未実装を確認。validate() は packages/core/src/validate.ts:10 にあり core の index.ts:15 からエクスポート済みだが、使用箇所は persistence/json.ts:80（読込時の致命エラー判定）のみで、編集中に任意実行する UI・パレットコマンドは存在しない。lintProject は core にも desktop にも無い。提案の実装方式は妥当: 業務リント4種（担当未設定・末端工数未入力・孤立工程・方策未記入）は project.core/details の純粋関数で判定可能、ジャンプは IssueListDialog.tsx:42-50 の select+setLevel+setScope パターンがそのまま流用できる。ダイアログは既存の modal 群（HelpDialog 等）と同型で追加容易。出力前警告オプションも settings.ts の検証ポリシー付き設定基盤に追加可能。アーキテクチャ（純粋TS core + React UI）と完全に整合し実現性は高い。
- **主な変更ファイル**: packages/core/src/validate.ts, apps/desktop/src/ui/CommandPalette.tsx, apps/desktop/src/App.tsx, apps/desktop/src/ui/useUI.ts, apps/desktop/src/styles.css

### 42. バリデーションエラーをセル上で可視化（入力値を消さない）
**影響: 高 / 規模: S**

- **問題**: 工数の不正値は toast 通知のみで、どのセルのエラーか分からない。さらに e.target.value を元の値へ巻き戻すため、ユーザーが打った内容（例: 『2時間』『1.5h』）が無言で破棄され、何が悪かったのか確認すらできない（TableView.tsx:474-480 / FullTable.tsx:756-762 / Inspector.tsx の工数欄も同様）。
- **提案**: 不正値はセルに残したまま aria-invalid=true と .invalid クラス（赤いリング+背景薄赤）を付け、blur 後もフォーカスをセルへ戻して修正を促す。エラー理由はセル直下の小さなポップ（title 併用）で『0以上の数値（時間）で入力してください』を表示し、確定（store への commit）だけをブロック。Esc で元値へ復帰。toast は廃止または補助に格下げ。共通化のため parseEffort の結果を {ok, message} 形式で返すヘルパを追加。
- **検証メモ**: 問題は3箇所とも確認: TableView.tsx:473-480 / FullTable.tsx:756-762 / Inspector.tsx:166-173 で parseEffortHoursToMinutes が null なら e.target.value を元値へ巻き戻し + error toast のみ。コードベースに aria-invalid / .invalid は一切存在しない。実装可能（クラス付与とポップは通常のReactで足りる）。ただし「blur後もフォーカスをセルへ戻す」はフォーカストラップ気味でやり過ぎの懸念あり（値を残して invalid 表示+commitブロックだけで十分）。全タイトル一覧の「工数などの不正入力をインライン表示（赤枠＋フィールド直下メッセージ）」と実質同一内容。
- **主な変更ファイル**: apps/desktop/src/TableView.tsx, apps/desktop/src/FullTable.tsx, apps/desktop/src/parseEffort.ts, apps/desktop/src/styles.css

### 43. ツールバーとウィンドウタイトルに現在ファイル名＋未保存マーカー表示
**影響: 高 / 規模: S**

- **問題**: persistence.ts:205 の currentFileName() が export されているのに UI のどこからも使われておらず、今どのファイルを開いて編集しているかが画面のどこにも出ない。共有フォルダで複数の .gflow を扱う運用では「保存＝どのファイルを上書きするのか」が分からず誤上書きの不安がある。document.title も固定のまま。
- **提案**: ツールバーのブランド表記の隣にファイル名チップ（例:「営業部_業務フロー.gflow」、未保存時は先頭に●を付け--amber系で着色）を表示。ファイル未割当（新規/サンプル/テンプレート）の場合は「未保存のプロジェクト」と表示。クリックでフルパス（Tauri時）を title 属性で確認可能。あわせて document.title を「ファイル名● - gantt-flow」に同期し、OSのタスクバー/タブからも未保存が分かるようにする。
- **主な変更ファイル**: apps/desktop/src/App.tsx, apps/desktop/src/persistence.ts, apps/desktop/src/styles.css

### 44. 矢印・図形削除の「元に戻す」アクション付きトースト
**影響: 中 / 規模: M**

- **問題**: 矢印の右クリック即削除（FlowCanvas.tsx:998-1001）や edge-toolbar の削除は確認なしで実行され、導出エッジの場合は表の前後関係まで消える（store.ts:687-698）。Ctrl+Z で戻せるがその導線が画面に出ないため、誤削除に気づかないまま保存するリスクがある（既知の問題点3）。一方で毎回確認ダイアログを挟むとテンポが落ちる。
- **提案**: useUI の toast にオプションの action: { label, onClick } を追加し（Toaster にボタン描画を追加）、エッジ削除時に「前後関係を削除しました ［元に戻す］」、付箋/制御ノード削除時に「付箋を削除しました ［元に戻す］」を表示。［元に戻す］は store の undo を1回呼ぶだけ。確認ダイアログは追加せず操作テンポを維持しつつ、誤操作の即時リカバリ導線を常に見せる。
- **検証メモ**: 未実装を確認。ToastItem は {id, message, tone} のみ(useUI.ts:86-90)、toast(message, tone) に action は無く、Toaster/ToastView(Dialogs.tsx:83-105) はボタンを描画しない（4200ms 自動消去のみ）。エッジ右クリック即削除(FlowCanvas.tsx:998-1001) と edge-toolbar 削除(:1077-1086) はトーストも確認も無し。deleteEdge の導出エッジ→依存削除(store.ts:687-698) と undo(:717-719) も提案の記述どおり。実装は useUI/Toaster の小改修＋削除箇所でのトースト呼び出しで可能。ただしトーストへの action 付与＋undo という機構自体は一覧の『破壊的操作のトーストに「元に戻す」アクションボタン』と実質同一で、本案はその適用対象（エッジ/付箋/制御ノード削除）を特定した個別事例。
- **主な変更ファイル**: apps/desktop/src/ui/useUI.ts, apps/desktop/src/ui/Dialogs.tsx, apps/desktop/src/FlowCanvas.tsx

### 45. 単一行削除を確認レスにし「元に戻す」付きトーストへ
**影響: 中 / 規模: M**

- **問題**: 行削除は1件でも毎回確認ダイアログが出る（taskOps.ts:26-44）ため、不要行を連続で消す整理作業のテンポが悪い。一方で undo（Ctrl+Z）の存在は削除後に案内されず、誤削除に気づいたユーザーがダイアログの再発防止に頼るしかない。
- **提案**: 子を持たない単一行の削除は確認ダイアログを省略して即削除し、代わりに『「○○」を削除しました［元に戻す］』のアクションボタン付き toast（6秒）を表示（ボタンで app.undo() 実行）。Toaster にアクション1個のサポートを追加（useUI の toast API に { actionLabel, onAction } を拡張）。子持ち・複数件の削除は現行の確認ダイアログを維持。
- **主な変更ファイル**: apps/desktop/src/taskOps.ts, apps/desktop/src/ui/Dialogs.tsx, apps/desktop/src/ui/useUI.ts

### 46. 自動退避（オートセーブ）の最終退避時刻をステータスバーに表示
**影響: 中 / 規模: M**

- **問題**: autosave.ts は dirty 変更を1秒デバウンスで localStorage に退避するが完全に無音で、write() の失敗（容量超過）も握りつぶす（autosave.ts:113-115）。ユーザーは「クラッシュしても大丈夫か」を知る術がなく、未保存状態の安心感がない。
- **提案**: autosave の write 成功時に useUI へ最終退避時刻を通知し、ステータスバーの「未保存」表示を「未保存（自動退避 14:32）」に拡張。title 属性で「クラッシュ時はこの時点から復元できます。ファイルへの保存は Ctrl+S」と説明。write 失敗時は退避時刻の代わりに「退避失敗」を--amber 系で表示し、クリックで容量超過の説明と「今すぐ保存」を促す confirm を開く。
- **検証メモ**: 問題認識は正確。StatusBar.tsx:76-79 は「未保存/保存済み」のみで時刻表示は無く、autosave.ts:109-116 の write() は catch で容量超過を完全に握りつぶす（コメント「容量超過/不可は無視」）。実装は容易: autosave.ts は既に useApp を import しており、useUI に lastAutosaveAt（成功時刻 or 失敗フラグ）を追加して write 内から set すればよい。StatusBar は useUI を購読済み。注意点: dirty→clean 遷移で clearAutosave が走るとき（autosave.ts:127-131）表示中の退避時刻もクリアする処理を忘れると「保存済み（自動退避 14:32）」という矛盾表示になる。
- **主な変更ファイル**: apps/desktop/src/autosave.ts, apps/desktop/src/ui/StatusBar.tsx, apps/desktop/src/ui/useUI.ts

### 47. コマンドのコンテキストバッジ表示と無効理由の明示
**影響: 中 / 規模: S**

- **問題**: available=false のコマンドはパレット一覧から黙って消える（CommandPalette.tsx:621 の filter）ため「なぜ出ないのか」が分からない。またフロー専用キー操作（c=接続モード、i/o=I/O追加、keymap.ts:137-142）はパレットに対応項目がなく、どのペインで何ができるかを列挙する場がない。
- **提案**: 各コマンドに「表」「フロー」「要選択」のコンテキストバッジを表示し、条件不成立のコマンドは非表示ではなくグレー表示＋「工程を選択すると使えます」のインラインヒント付きで残す（Enter は無効）。c・i・o などフローのキー操作に対応するパレット項目を追加し、hint 欄に実効キーマップ由来のキーを併記して、パレット自体をショートカットの発見導線にする。
- **検証メモ**: バッジ・グレー表示は未実装を確認（CommandPalette.tsx:620 の filter(c.available !== false) で黙って消える）。hint も '⌘S' 等のハードコードで keymap 由来ではない。ただし前提に誤りあり: 『c=接続モード、i/o=I/O追加 はパレットに対応項目がない』は不正確で、arg-connect「接続先を指定…」(480行)・arg-input(349行)・arg-output(365行) が機能的に対応する項目として既存（available=hasSel で隠れるため『見えない』のは事実だが、それ自体がこの提案の主訴）。実装は現実的: Cmd にコンテキスト/無効理由のメタデータを足してグレー描画＋Enter 無効化、キー表記は keymap.ts の getActiveKeymap()+chordKeys() で導出可能。
- **主な変更ファイル**: apps/desktop/src/ui/CommandPalette.tsx, apps/desktop/src/keymap.ts

### 48. エラートーストの表示時間延長とホバーで自動消去を一時停止
**影響: 中 / 規模: S**

- **問題**: Dialogs.tsx:103 で全トーストが一律4.2秒で自動消去される。エラーメッセージ（例:「ファイルを開けませんでした（形式が不正です）」）は読み終わる前に消えることがあり、読み返す手段もない。
- **提案**: ToastView のタイマーを tone 別にする（error=8秒、info/success=4.2秒）。マウスホバー中（onMouseEnter）はタイマーをクリアし、離れたら（onMouseLeave）残り時間で再開。エラートーストには tone アイコン（!マーク）を付け、role を 'status' から error 時のみ 'alert' に変えてスクリーンリーダーにも即時通知する。
- **検証メモ**: 問題認識は正確。Dialogs.tsx:103 で全トーストが一律 setTimeout 4200ms、role は常に 'status'（line 107）、ホバー停止もアイコンも無い。ToastView は自己完結コンポーネントなので tone 別タイマー＋onMouseEnter/Leave の残り時間管理はローカル state で完結し、実装は容易。注意点: (1) Toaster コンテナに aria-live="polite"（line 87）が付いているため、error 時に role='alert' へ変えるなら二重読み上げにならないようコンテナ側の調整も必要。(2) 「tone アイコンを付ける」の部分はリスト内の別案「トーストのトーン別アイコン表示」と重複するサブ項目（本案の主内容＝時間延長/ホバー停止/role 切替は独自なので duplicateOf 扱いにはしない）。
- **主な変更ファイル**: apps/desktop/src/ui/Dialogs.tsx, apps/desktop/src/styles.css

### 49. 復元提案ダイアログに退避内容の詳細（プロジェクト名・退避時刻・工程数）を表示
**影響: 中 / 規模: S**

- **問題**: 起動時の復元提案（App.tsx:333-353）は「保存されていない作業が見つかりました」とだけ表示し、どのプロジェクトのいつ時点のデータかが分からない。複数案件を扱うユーザーは「復元する」を押してよいか判断できず、「破棄すると元に戻せません」の選択が怖い。
- **提案**: autosave.ts の loadAutosave()/takeAutosaveForRestore() が { project, at } を返すよう拡張し、ダイアログ本文を「『○○業務フロー』（工程 42 件）の 6/11 14:32 時点の未保存データが見つかりました。」のように具体化。Entry.at と project.meta.name / Object.keys(core.tasks).length は既に取得可能。ボタンも「この内容を復元」「破棄して空で開始」と結果が分かる文言にする。
- **検証メモ**: 問題認識は正確。App.tsx:333-353 の復元提案は固定文言のみ。実装はほぼ提案どおり可能: autosave.ts の newestEntry()（line 45-61）は既に { key, at, project } を持っており、loadAutosave()/takeAutosaveForRestore()（line 64-81）が at を捨てて Project だけ返しているのを { project, at } 返却に変えるだけ。工程数は Object.keys(p.core.tasks).length（autosave.ts:54 で同式を使用済み）。1点事実誤認: プロジェクト名のフィールドは project.meta.name ではなく project.meta.title（packages/core/src/model/types.ts:186-192 の ProjectMeta は id/title/createdAt/updatedAt/appVersion）。
- **主な変更ファイル**: apps/desktop/src/autosave.ts, apps/desktop/src/App.tsx

### 50. ヘルプダイアログに学習導線フッター（ツアー再開・キー割当編集・全キー無効時フォールバック）
**影響: 中 / 規模: S**

- **問題**: 使い方ツアーの再開はコマンドパレット内のコマンド（CommandPalette.tsx:611）でしか呼べず、初心者ほど辿り着けない。HelpDialog はショートカット一覧のみで、キー割当を変えたい人への導線もない。さらに全キーバインドを無効化すると一覧が空になり、フォールバック表示がない（HelpDialog.tsx:86-150）。
- **提案**: HelpDialog のフッターにボタン2つを追加: 「使い方ツアーをもう一度見る」（close → setTourStep(0)）と「キー割り当てを変更…」（close → 設定ダイアログのショートカットタブを開く）。また groups が空（全キー無効）の場合は一覧の代わりに「有効なショートカットがありません。設定から初期化できます」＋「初期設定に戻す」ボタンを表示する。
- **検証メモ**: フッターボタンは未実装（HelpDialog.tsx:142-146 はシングルキー説明テキストのみ）で、ツアー再開がパレット限定（CommandPalette.tsx:611）なのも事実。実装は容易: setTourStep(0)・setSettingsTab('keys')+setOverlay('settings')・saveOverrides({})（keymap.ts:376）が全て既存 API。ただし1点事実誤認: 「全キーバインドを無効化すると一覧が空になる」は不正確。buildKeymapGroups() が空を返しても STATIC_GROUPS（編集中キー・マウス操作、HelpDialog.tsx:23-54）が常に連結される（line 96）ため一覧が完全に空になることはない。keymap 由来グループだけが消えるので、フォールバック表示の必要性は提案文より限定的（あっても害はない）。
- **主な変更ファイル**: apps/desktop/src/ui/HelpDialog.tsx, apps/desktop/src/ui/useUI.ts, apps/desktop/src/ui/SettingsDialog.tsx

### 51. トーストのトーン別アイコン表示
**影響: 低 / 規模: S**

- **問題**: トーストのトーン（error/success/info）の区別が左 3px のボーダー色のみ（styles.css:1594-1619）。作業に集中している周辺視では赤/緑/青の細線の判別が難しく、4.2 秒の自動消去（Dialogs.tsx:103）までに重要度を読み取りにくい。
- **提案**: Toaster コンポーネント（Dialogs.tsx:83-114）に tone 別のインライン SVG アイコン（error=アラート円、success=チェック円、info=インフォ円、いずれも 16px）を文頭に追加し、アイコン色を既存のボーダー意味色（--red/--ok/--accent）と揃える。アイコンは icons.tsx に追加して他画面でも再利用可能にする。既存の role 属性・自動消去ロジックは変更しない。
- **主な変更ファイル**: apps/desktop/src/ui/Dialogs.tsx, apps/desktop/src/ui/icons.tsx, apps/desktop/src/styles.css

### 52. 課題一覧ダイアログの空状態に行動ボタン（選択中の工程へ課題を追加）
**影響: 低 / 規模: S**

- **問題**: IssueListDialog.tsx:84 の空状態は「表やインスペクタで工程に課題を追加すると、ここに一覧されます」という説明文のみで、その場から課題追加へ進む手段がない。どこの「＋課題」を指すのか分からず、ダイアログを閉じて自力で探すことになる。
- **提案**: 空状態に主ボタン「選択中の工程に課題を追加」を追加: クリックでダイアログを閉じ、revealTask で選択工程のインスペクタを開き、課題セクションの追加入力欄へフォーカス移動（Inspector に focusIssueInput 相当のシグナルを useUI 経由で渡す）。工程未選択時はボタンを無効化し「先に表で工程を選んでください」と添える。
- **検証メモ**: 問題認識は正確。IssueListDialog.tsx:83-84 の空状態は説明文のみでアクション無し。部品は揃っている: revealTask（taskOps.ts:11-20）が選択＋粒度追従＋インスペクタ表示まで行い、selectedTaskId で無効化判定も可能。注意点が2つ: (1) Inspector の課題追加は常設入力欄ではなく「＋課題」ボタン（Inspector.tsx:327、addIssue で既定名の課題を作る方式）なので、「追加入力欄へフォーカス」は実際には「addIssue 実行＋新規課題の issue input へフォーカス」か「＋課題ボタンへフォーカス」に読み替えが必要（focusIssueInput シグナルを useUI に足せば実装可能）。(2) 全項目表モードではインスペクタ自体が描画されない（App.tsx:568 で !fullMode 条件）ため、fullMode 時は setTableMode('outline') も併せて行う必要がある。
- **主な変更ファイル**: apps/desktop/src/ui/IssueListDialog.tsx, apps/desktop/src/Inspector.tsx, apps/desktop/src/taskOps.ts, apps/desktop/src/ui/useUI.ts

## 業務ワークフロー支援（課題・出力・テンプレート）（15案）

### 53. 工程スニペット（部分テンプレート）の保存と挿入
**影響: 高 / 規模: L**

- **問題**: テンプレートはプロジェクト全体の雛形（Welcome の TEMPLATES／store.ts loadTemplate）のみで、「承認→差戻し→再申請」のような定型工程列を既存プロジェクトの途中に挿入する手段がない。複数案件で同じ業務パターンを毎回手入力するか、複製＋修正で代用している。
- **提案**: 選択中の工程（または全項目表のマーク行）を、パレット「スニペットとして保存…」で名前を付けて localStorage に保存（サブツリー＋詳細＋内部依存を含む）。「スニペットを挿入…」（引数モードで一覧から選択）で選択行の直後にID再発行で展開（1 undo、依存はスニペット内部のみ復元）。設定>データの JSON エクスポートに含め、社内共有フォルダ経由でチーム配布できるようにする。
- **検証メモ**: 未実装を確認。snippet/スニペットはコードベースに存在せず、テンプレートはプロジェクト全体の雛形のみ（store.ts:757-762 loadTemplate、Welcome.tsx が TEMPLATES を列挙）。duplicateTask（store.ts:373 以降）は単一工程の詳細複製のみでサブツリー・依存は写さないため、サブツリー＋内部依存の捕捉/展開は新規実装になる。ただし cAddTask/cAddIoItem/cAddIssueItem/cAddDependency と commit（1 undo）の部品は揃っており現実的。設定エクスポート同梱は SettingsFile のスキーマ拡張＋parseSettingsFile の検証追加が必要（バージョンポリシーは「不明キー無視」なので互換性は保てる）。規模は中程度だが実装可能。
- **主な変更ファイル**: apps/desktop/src/ui/CommandPalette.tsx, apps/desktop/src/store.ts, apps/desktop/src/settings.ts, apps/desktop/src/ui/SettingsDialog.tsx

### 54. 貼り付けプレビューと列マッピングダイアログ
**影響: 高 / 規模: L**

- **問題**: Excel 貼り付けは [作業名, 担当] の2列固定で、確認なしに即実行される（FullTable.tsx:387-400 / store.ts:418-440）。ヒアリングメモの列順は案件ごとに異なるため、列がずれたまま大量の誤った行が追加されるリスクが高い（undo はできるが気づきにくい）。
- **提案**: 『貼り付けで追加』実行時にプレビューダイアログを表示: 先頭5行をテーブル表示し、各列ヘッダに『作業名/担当/工数/業務内容/備考/取り込まない』の select を付ける（1列目=作業名を既定推測）。『1行目はヘッダ』チェックボックス、追加先（選択行の粒度/親）と件数『23件を中工程として追加します』を明示。確定で 1 undo 単位の一括追加、工数列は parseEffortHoursToMinutes で検証し不正セルは警告付きスキップ。
- **検証メモ**: 確認済み: onPasteRows (FullTable.tsx:388-400) は readText 後に即 pasteRowsAsTasks を呼び、store.ts:418-440 は [作業名, 担当] の2列固定・確認なし・単一 commit。プレビューダイアログは未実装。useUI に confirm/promptText のダイアログキュー基盤があり、SettingsDialog 等のモーダル前例もあるので専用ダイアログ追加は現実的。parseEffortHoursToMinutes も既存。pasteRowsAsTasks のシグネチャを列マッピング対応に拡張する必要あり（工数・業務内容等を受けるには cAddTask 後に updateDetail 相当のコマンド適用を足す）。実装可能。全タイトル一覧の「階層付きクリップボード貼り付け」とは貼り付けパイプラインを触る点で隣接するが、目的（列マッピング/確認 vs 階層保持）が異なり重複ではない。
- **主な変更ファイル**: apps/desktop/src/FullTable.tsx, apps/desktop/src/store.ts, apps/desktop/src/ui/Dialogs.tsx, apps/desktop/src/ui/useUI.ts

### 55. 課題に対応状況（未対応/対応中/解決済み）フィールドを追加
**影響: 高 / 規模: L**

- **問題**: IssueItem は issue/measure/target のみ（packages/core/src/model/types.ts:60-65）で、課題のライフサイクル（検討中→対応決定→解決）を表現できない。コンサル納品物の課題一覧表では「状況」列が定番であり、現状は解決済み課題を手で削除するか方策欄に追記するしかなく、履歴が残らない。
- **提案**: IssueItem に status?: 'open' | 'wip' | 'done' を追加（schema.ts の Zod も更新、未指定=open 扱いでマイグレーション不要）。インスペクタの課題行と課題一覧に3値のセグメントセレクタを表示し、done の課題はフロー図の課題ノードを半透明+取り消し線で描画（flowSvg にも反映）。課題一覧と Excel 出力に「状況」列を追加し、既定フィルタを「未対応+対応中」にする。
- **検証メモ**: IssueItem は id/issue/measure/target のみ（types.ts:60-65、schema.ts:49-54 の Zod も同様）で記載どおり未実装。optional フィールド追加＋未指定=open 扱いならマイグレーション不要という設計も妥当。注意点: store.ts:119 の updateIssue 型は Pick<'issue'|'measure'|'target'> なので 'status' を含めるよう core の updateIssueItem コマンドとともに拡張が必要（小規模）。タスクの status（案1）とは別フィールドで重複ではない。フロー図の課題ノード半透明化はキャンバス・flowSvg 双方で実装可能。
- **主な変更ファイル**: packages/core/src/model/types.ts, packages/core/src/model/schema.ts, apps/desktop/src/Inspector.tsx, apps/desktop/src/ui/IssueListDialog.tsx, apps/desktop/src/persistence.ts, apps/desktop/src/flowSvg.ts

### 56. セッション中のテンプレート新規作成と自社テンプレート保存
**影響: 高 / 規模: L**

- **問題**: 4つの業務テンプレート（templates.ts:200-225）は Welcome 画面＝工程0件のときしか選べず、作業中に次の案件をテンプレートから始めるには一度空にする回り道が要る。また「過去案件の構造を自社テンプレートとして再利用する」手段がなく、テンプレートはビルトイン固定。ヒアリング業務では前案件の構成流用が頻出する。
- **提案**: (1)ツールバーの「新規」を Menu 化し「空の新規 / テンプレートから… / 現在をテンプレートとして保存…」を提供。テンプレート選択は既存 onTemplate（未保存確認込み）へ接続。(2)「現在をテンプレートとして保存」は prompt で名前を聞き、現在の core+details（meta と flow 配置は除外し reconcileProject で再導出）を localStorage に保存。保存済みユーザーテンプレートは新規メニューと Welcome の一覧にビルトインの後ろに表示し、右側に削除ボタンを付ける。
- **検証メモ**: 未実装を確認。TEMPLATES は templates.ts:200-225 の4件固定で、テンプレート導線は Welcome.tsx:66-74（工程0件時）のみ。ツールバー「新規」は単一ボタン（App.tsx:390）。loadTemplate（store.ts:757-762）はビルトイン TEMPLATES.find のみでユーザーテンプレートの保存・読込機構は無い。実装は現実的: Menu 化は出力メニューと同型、confirmReplace/onTemplate（App.tsx:233-259）も再利用可能、reconcileProject は core からエクスポート済み。注意点: TemplateInfo.create は関数なので localStorage のデータ型テンプレートは loadTemplate の拡張（key 体系の分離か、保存 JSON を deserialize→reconcile する別経路）が必要。また useUI には confirm のみで文字列入力ダイアログが無いため、名前入力は window.prompt かパレットの引数入力流用になる。部分スニペット案（工程スニペット）とはスコープが異なり重複ではない。
- **主な変更ファイル**: apps/desktop/src/App.tsx, apps/desktop/src/ui/Welcome.tsx, apps/desktop/src/store.ts, packages/core/src/templates.ts, apps/desktop/src/ui/Menu.tsx

### 57. 階層付きクリップボード貼り付け（Excelのインデント/粒度列を保持）
**影響: 高 / 規模: M**

- **問題**: 「貼り付けで追加」は [作業名, 担当] のフラット行しか解釈しない（store.ts:418-440 pasteRowsAsTasks）。ヒアリングメモを Excel で大/中/小に階層整理していても、貼り付けると全行が同じ粒度・同じ親に並び、貼り付け後に手作業でインデントし直すことになる。
- **提案**: タブ区切りの先頭空セル数（または大/中/小/詳細の4列形式）を階層として解釈し、親子関係付きで一括追加（1 undo）。確定前に「12件・3階層を追加します（大2／中4／小6）」の確認ダイアログでプレビューし、解釈ミス時はキャンセルできる。階層解釈は既存 rowsToProject（packages/core/src/import/importCsv.ts）のロジックを部分挿入用に流用する。
- **検証メモ**: 未実装を確認。pasteRowsAsTasks（store.ts:418-440）は [作業名, 担当] のフラット解釈のみで、全行が同一 level・同一 parentId。実装可能だが「rowsToProject のロジック流用」は過大評価: rowsToProject（importCsv.ts:88-257）の親解決は『粒度列＋lastByRank』方式（149-189行）で、(1) 先頭空セル数のインデント解釈は新規実装、(2) 新規 Project を構築する関数のため部分挿入には親解決ループの抽出リファクタか再実装が必要。また選択中の工程の粒度より深い階層（detail 工程の下に3階層など）は表現不能でエラーハンドリング必須。確認ダイアログは useUI.confirm で容易。プレビュー部分は「貼り付けプレビューと列マッピングダイアログ」案と重なるが、階層解釈という核が異なり重複ではない。
- **主な変更ファイル**: apps/desktop/src/store.ts, apps/desktop/src/FullTable.tsx, packages/core/src/import/importCsv.ts

### 58. 「最近使ったファイル」をツールバーメニューとコマンドパレットから開けるようにする
**影響: 高 / 規模: M**

- **問題**: listRecentFiles()/openRecentFile()（persistence.ts:623-660）は実装済みだが、UIは Welcome 画面（空状態）のみ。一度プロジェクトを開くと最近のファイルへ切り替える手段がなく、共有フォルダ上の複数案件を行き来する業務コンサルの使い方に合わない。
- **提案**: 既存の Menu/MenuItem コンポーネント（ui/Menu.tsx）を再利用し、ツールバーの「開く」ボタンをドロップダウン化（クリック=従来の開く、▼=最近5件を名前+最終使用日で列挙）。あわせてコマンドパレットに引数付きコマンド「最近のファイルを開く」を追加し、ファイル名で絞り込み選択→Enter で開く。未保存変更がある場合は既存の confirmReplace 相当の確認を挟む。
- **検証メモ**: 問題認識は正確。persistence.ts:623-662 に listRecentFiles/openRecentFile が実装済みで、UI からの導線は Welcome.tsx（空状態のみ表示、listRecentFiles を line 19 で呼ぶ）と App.tsx:260 の onOpenRecent ハンドラだけ。ツールバーの「開く」は素のボタン（App.tsx:401-403）、コマンドパレットには 'open'（保存ファイルを開く、CommandPalette.tsx:539）しかなく最近ファイルのコマンドは無い。実装基盤は揃っている: Menu/MenuItem は出力メニューで実用済み（App.tsx:414-428）、パレットには ArgSpec による2段階引数コマンド機構が既にある（CommandPalette.tsx:30-62）、confirmReplace も App.tsx:233 に存在。注意点: recentFilesSupported()（persistence.ts:591-593）は File System Access API + IndexedDB 前提のため、Firefox/Safari ではメニュー自体を隠す分岐が必要。
- **主な変更ファイル**: apps/desktop/src/App.tsx, apps/desktop/src/ui/Menu.tsx, apps/desktop/src/ui/CommandPalette.tsx, apps/desktop/src/persistence.ts

### 59. ヒアリング状況（status）の編集UIを表とインスペクタに追加
**影響: 高 / 規模: M**

- **問題**: データモデルに TaskStatus（todo=未着手/heard=ヒアリング済/review=確認待ち/done=確定）が定義済み（packages/core/src/model/types.ts:45,82）で、store の updateDetail も status を受け付ける（store.ts:500、複製時もコピーされる store.ts:400）のに、編集・表示するUIが一切ない。業務ヒアリングの進行管理というアプリの中核ユースケースなのに、フィールドが完全に死んでいる。
- **提案**: 全項目表（FullTable）にオプション列「状況」を追加し、セルクリックで select（未着手/ヒアリング済/確認待ち/確定）をインライン表示。インスペクタにも同じセレクタを1行追加。アウトライン表の行頭には小さな色ドット（未着手=灰・ヒアリング済=青・確認待ち=amber・確定=緑）を表示。既存の updateDetail({status}) を呼ぶだけなのでコアの変更は不要。CSV/Excel 出力列（exportRows.ts）にも「状況」列を追加してラウンドトリップ可能にする。
- **検証メモ**: 事実関係はすべて正確。TaskStatus は types.ts:45・TaskDetail.status は :82 に定義済み、schema.ts:71 の Zod も対応済み、TaskDetailPatch は 'status' を含み（commands/index.ts:342）、store.ts:500 updateDetail と :400 の複製コピーも確認。一方 FullTable.tsx / Inspector.tsx / TableView.tsx に status・状況 の参照はゼロ、EXPORT_HEADER（exportRows.ts:12-25）にも状況列なし＝フィールドは完全に死んでいる。提案どおり updateDetail({status}) を呼ぶだけでコア変更不要。1点補足: CSV ラウンドトリップには exportRows.ts だけでなく importCsv.ts 側の列対応も必要（提案文は export 側しか触れていない）。
- **主な変更ファイル**: apps/desktop/src/FullTable.tsx, apps/desktop/src/Inspector.tsx, apps/desktop/src/TableView.tsx, packages/core/src/export/exportRows.ts, apps/desktop/src/styles.css

### 60. 印刷オプションダイアログ（課題一覧ページ・フロー粒度の選択）
**影響: 高 / 規模: M**

- **問題**: 印刷（persistence.ts:447 printProjectAndFlow）はボタン即実行で、内容は「全項目表＋現在表示中のフロー図」固定。課題一覧表（コンサル納品3点セットの1つ）が印刷物に含められず、フロー図も『今たまたま開いている粒度・スコープ』しか出せない。出力前の調整手段がゼロ。
- **提案**: 印刷ボタン押下時に小ダイアログを表示: (1)「工程表を含める」「フロー図を含める」「課題一覧を含める」チェック (2)フロー図の粒度（大/中/小/詳細）とスコープのセレクト（現在値を defaultValue）(3)「課題レイヤを含める」チェック。printProjectAndFlow を opts 引数化し、課題一覧は exportIssuesExcel と同じ行生成ロジックを HTML テーブルに流用。設定は localStorage に記憶して次回の既定値にする。
- **検証メモ**: printProjectAndFlow（persistence.ts:447）は (project, view) 固定で「工程表＋現在ビューのフロー図」をハードコード、App.tsx:313 からボタン即実行で呼ばれており記載どおりオプションなし。課題一覧の行生成は exportIssuesExcel と IssueListDialog に同一ロジックが重複しており、HTML テーブル化での3重化を避けるため共通関数への切り出しを推奨。opts 引数化・localStorage 記憶とも既存パターン（settings.ts）で実現可能。案8と printProjectAndFlow への課題レイヤ反映部分が重なるため、両方採用時は実装を調整すること（重複とまでは言えない: 本案は印刷内容の選択、案8は画像出力の WYSIWYG）。
- **主な変更ファイル**: apps/desktop/src/persistence.ts, apps/desktop/src/App.tsx, apps/desktop/src/ui/useUI.ts, apps/desktop/src/styles.css

### 61. バックアップ復元前の差分プレビュー
**影響: 高 / 規模: M**

- **問題**: BackupsDialog の世代一覧は日時・タイトル・工程数だけ（BackupsDialog.tsx:74-79）で、復元するとどの工程がどう変わるか分からないまま「復元する」を押すしかない。復元後に保存するまで確定しない安全策はあるが、5世代のどれを選ぶべきかは中身を当てずっぽうで選ぶ運用になっている。
- **提案**: 各世代に「差分を見る」ボタンを追加。クリックで現在のプロジェクトと比較し、「追加 3 / 削除 1 / 変更 5」のサマリ行＋工程単位の明細リスト（工程No・工程名・変更フィールド名: 例『工数 60→90分』『担当 経理部→営業部』）を同ダイアログ内に展開表示。明細はタスク ID で突合する純粋関数 diffProjects() として core か backups.ts 隣に新設（将来「保存前に変更内容を確認」へ再利用可能な形にする）。差分表示後の「この状態に復元」ボタンで既存の onRestore へ。
- **検証メモ**: BackupsDialog.tsx:74-79 は日時・タイトル・工程数＋最新バッジのみで差分表示なし、記載どおり。listBackups は json を意図的に省くが（backups.ts:53-56）、restoreBackup(index) が deserializeProject で完全な Project を返すため、差分用に同 index から復元して比較する構成は既存 API のままで成立する（lenient 復旧経路も流用可）。diffProjects() をタスク ID 突合の純粋関数として core か backups.ts 隣に置く設計は React + 純粋TS ドメイン層の方針に合致。唯一の注意は details（課題・I/O 配列）のフィールド差分表現の粒度設計だが実装可能。
- **主な変更ファイル**: apps/desktop/src/ui/BackupsDialog.tsx, apps/desktop/src/backups.ts, packages/core/src/index.ts, apps/desktop/src/styles.css

### 62. サマリとステータスバーにヒアリング進捗の集計を表示
**影響: 高 / 規模: S**

- **問題**: SummaryDialog は担当別工数・自動化区分・粒度別件数の3カードのみ（SummaryDialog.tsx:82-141）で、ヒアリングの消化状況（何工程が確定済みか）を知る手段がない。StatusBar も工程数・担当数・工数のみ（StatusBar.tsx:40-55）。コンサルが「今日のヒアリングでどこまで埋まったか」を報告する際に数えるしかない。
- **提案**: SummaryDialog に4枚目のカード「ヒアリング進捗」を追加し、todo/heard/review/done の積み上げ横棒（既存の sum-auto-bar と同じ部品流用）と「確定 12/45 工程（27%）」のテキストを表示。StatusBar にも「✓ 12/45」チップを追加し、ホバーで内訳ツールチップ、クリックでサマリを開く。status 編集UI（前案）とセットで効く。
- **検証メモ**: SummaryDialog.tsx は担当別工数・自動化区分・粒度別件数の3カードのみ（summary-grid 82-141行）で進捗カードなし。StatusBar.tsx も工程数・担当数・合計工数・表示中ビュー・保存状態のみで進捗チップなし。sum-auto-bar の積み上げ横棒部品は実在し流用可能。status データ自体はモデルに存在するため前案（編集UI）なしでも技術的には実装可能だが、入力手段がないと常に全件 todo 表示になる点は提案文の「セットで効く」のとおり。重複なし（前案は編集UI、本案は集計表示で対象が異なる）。
- **主な変更ファイル**: apps/desktop/src/ui/SummaryDialog.tsx, apps/desktop/src/ui/StatusBar.tsx, apps/desktop/src/styles.css

### 63. 課題一覧にフィルタと「方策未記入」の可視化を追加
**影響: 高 / 規模: S**

- **問題**: IssueListDialog は全課題をフラットに並べるだけで、フィルタ・検索が一切ない（IssueListDialog.tsx:86-109）。課題が数十件になると「方策がまだ書けていない課題」「特定部門の課題」を目視で探すことになる。方策列が空でも見た目上の区別がない。
- **提案**: ダイアログヘッダに (1)担当セレクト (2)「方策未記入のみ」チェックボックス (3)テキスト検索 input を追加し、rows の useMemo でクライアントフィルタ。方策が空のセルは amber 背景+「未記入」プレースホルダで表示。件数表示を「24件（うち方策未記入 7件）」形式に変更。Excel 出力（exportIssuesExcel）はフィルタ適用後の行を出すか選べるよう確認ダイアログを挟む。
- **検証メモ**: IssueListDialog.tsx を全文確認: rows は useMemo でフラット生成（20-33行）、テーブルは 86-108 行でフィルタ・検索 UI は皆無。方策空セルの視覚区別もなし（104行で素のまま表示）。件数表示は「{rows.length}件」のみ（64行）。rows は既にクライアント側 useMemo なのでフィルタ追加は提案どおり低コスト。exportIssuesExcel（persistence.ts:357）は project から直接行生成するため「フィルタ適用後の行を出す」には行リストを引数で渡せるようシグネチャ変更が必要（小規模）。
- **主な変更ファイル**: apps/desktop/src/ui/IssueListDialog.tsx, apps/desktop/src/persistence.ts, apps/desktop/src/styles.css

### 64. 前工程候補を同粒度全体に拡大（コード検索で別グループへ接続）
**影響: 中 / 規模: S**

- **問題**: 「前工程を設定…」と表の前工程セレクトの候補が同じ親・同じ粒度の兄弟に限定されている（suggestions.ts:19-35 prevCandidates）。実務で頻出する別の大工程を跨ぐ前後関係は、フローのドラッグ接続でしか張れずキーボードで完結しない。connect 側は同粒度なら別親の依存化を既に許可している（store.ts:630-647）ため、制約は候補生成のみ。
- **提案**: prevCandidates を「同粒度の全工程」に拡大し、引数モードの候補を「同じグループ」「他のグループ」のセクションに分けて表示（detail に工程コードと親名を併記）。パレットのファジー検索で工程コード（例: B2-3）でも絞り込めるようにし、別グループ選択時は候補行に「⚠ 別の親を跨ぐ依存」と注記を出す。表セレクト側も buildPrevCandidateIndex を同じ規則に揃える。
- **検証メモ**: 未実装・前提も正確と確認。prevCandidates（suggestions.ts:19-35）は同じ親＋同じ粒度に限定。一方 connect（store.ts:630-647）はコメントで「別の大工程を跨ぐ中工程の接続も可」と明記し同粒度なら別親の依存化を許可、addDependency（store.ts:349-353）にも親制約なし＝制約は候補生成のみという指摘は正しい。実装容易: フィルタ緩和＋ArgOption.detail に工程コード併記（fuzzyScore は既に detail も検索対象 643行）。注意点: (1) buildPrevCandidateIndex（suggestions.ts:42-74）との等価性はテストで固定されておりコメントも両方の同期を要求、必ず両方更新。(2) 引数モードの候補リストは現状フラット（セクション見出しなし）のため「同じグループ/他のグループ」のセクション表示は小規模なUI追加が要る。
- **主な変更ファイル**: apps/desktop/src/suggestions.ts, apps/desktop/src/ui/CommandPalette.tsx

### 65. 選択行のTSVコピー（Excelへの書き戻し）
**影響: 中 / 規模: S**

- **問題**: Excel→アプリの貼り付け取り込みはあるが、逆方向（表の行を Excel に貼る）が存在しない。Excel 出力は Phase 4 で未着手のため、社内共有フォルダ運用で『途中経過を Excel でレビューに回す』手段が皆無。
- **提案**: marked 行（未マーク時は選択行）で Ctrl+C → 表示中の列構成（visibleCols 準拠・ヘッダ行付き）をタブ区切りで navigator.clipboard.writeText に書き出す。一括操作バーにも『コピー』ボタンを追加。書き出し時は既存の CSV 数式インジェクション対策のサニタイズ関数を通す。完了時『n行をコピーしました』toast。
- **検証メモ**: 確認済み: アプリ内に navigator.clipboard.writeText の呼び出しは皆無（readText のみ FullTable.tsx:391）。visibleCols (FullTable.tsx:228) と marked は実在し、列構成準拠の書き出しは素直に組める。サニタイズは packages/core/src/export/exportRows.ts:91-92 に CSV_FORMULA_TRIGGER（export済み）と neutralizeFormula（未export・モジュール内private）があるため、neutralizeFormula の export 化か再実装が必要という小さな前提修正あり。Ctrl+C ハンドリングは 'table' コンテキストのキーマップ/registerContextHandler 基盤に乗せられる（編集中inputのコピーを奪わないガードは必要）。実装可能。重複なし。
- **主な変更ファイル**: apps/desktop/src/FullTable.tsx, apps/desktop/src/keymap.ts

### 66. SVG/PNG エクスポートにキャンバスの課題レイヤ設定を反映
**影響: 中 / 規模: S**

- **問題**: キャンバスには課題レイヤの表示/非表示トグルがある（FlowCanvas.tsx:369 showIssues でフィルタ）のに、buildFlowSvg（flowSvg.ts:28）にはオプション引数がなく、エクスポート画像には課題ノードが常に含まれる。『顧客向けには課題を伏せた図を出したい』という業務ニーズに応えられず、画面と出力の WYSIWYG が崩れている。
- **提案**: buildFlowSvg に opts: { showIssues?: boolean } を追加し、issue ノードと issue-line を出し分け。exportSvgFile / exportPngFile / printProjectAndFlow は useUI の課題レイヤ表示状態を引き回して渡す。エクスポート完了トーストに「課題レイヤ: 含む/含まない」を明記して気づきを与える。
- **検証メモ**: buildFlowSvg（flowSvg.ts:28）は記載どおり opts 引数なしで、issue ノード（183-198行）と issue-line（156-164行）を無条件描画。画面側は FlowCanvas.tsx:369 で showIssues フィルタ済みなので WYSIWYG 崩れの指摘は正しい。exportSvgFile/exportPngFile/printProjectAndFlow（App.tsx:296,305,313 から呼出）への引き回しも素直。1点訂正: showIssues は useUI ではなく useApp ストア（store.ts:85）にある。decorateFlowSvg の凡例にも課題項目があるため、非表示時は凡例からも課題を落とすのが筋（提案文は未言及）。
- **主な変更ファイル**: apps/desktop/src/flowSvg.ts, apps/desktop/src/persistence.ts, apps/desktop/src/App.tsx

### 67. Excel 出力を1ブック多シート化（工程表＋課題一覧＋サマリ）
**影響: 中 / 規模: S**

- **問題**: exportExcelFile は「工程表」1シートのみ（persistence.ts:379-388）、課題一覧は別ファイル（persistence.ts:357-377 exportIssuesExcel）として分かれて出力される。納品時に2ファイルを手で1ブックにまとめる作業が発生し、サマリ（担当別工数・自動化区分）に至っては Excel に出す手段自体がない。
- **提案**: exportExcelFile を拡張し、1つのワークブックに「工程表」「課題一覧」「サマリ」の3シートを book_append_sheet で同梱（XLSX ライブラリは既に使用中）。サマリシートは SummaryDialog の useMemo 集計ロジックを persistence 側へ関数として切り出して共有。課題一覧単独出力ボタンは互換のため残す。
- **検証メモ**: exportExcelFile は「工程表」1シートのみ（persistence.ts:379-388）、exportIssuesExcel は別ファイル出力（357-377）で記載どおり。XLSX ライブラリと book_append_sheet は既使用のため多シート化は機械的。サマリ集計は SummaryDialog.tsx:31-54 の useMemo 内にあり、提案どおり純粋関数として切り出せば共有可能（core の metrics.ts へ置くのがアーキテクチャ上は自然）。行番号の指摘もすべて一致。
- **主な変更ファイル**: apps/desktop/src/persistence.ts, apps/desktop/src/ui/SummaryDialog.tsx, apps/desktop/src/App.tsx

## ビジュアルデザイン（12案）

### 68. 未定義トークン --hover / --danger の補完（壊れたホバー・バー背景の修復）
**影響: 高 / 規模: S**

- **問題**: styles.css で var(--hover) が13箇所（Welcomeのテンプレート/最近ファイル項目 1773・1827、課題一覧の行ホバー・Excel出力ボタン 2106・2146、バックアップ項目 2306、キーバインドエディタ 2403・3799、サマリの工数バー軌道 .sum-bar-track/.sum-auto-bar 2456・2482・2542、エッジツールバー 2759 等）、var(--danger) が5箇所（ミニマップ課題ドット .mm-issue 1252 等）で参照されているが、:root にも [data-theme='dark'] にも定義が存在しない。宣言が無効化され、これらの要素はホバーしても背景が変わらず、サマリダイアログの工数バーの軌道は透明、ミニマップの課題ドットは黒で描画されるという実害が出ている。
- **提案**: :root と [data-theme='dark'] に --hover（ライト: #e8ecf2 系、ダーク: #2a3140 系）、--danger: var(--red)、--danger-soft: var(--red-fill) を定義する。既存の --row-hover と意味が重複するため「テーブル行=--row-hover / ボタン・リスト項目=--hover」という使い分けをトークン定義部のコメントで明文化し、サマリのバー軌道は意味的に正しい --panel-2 へ置き換える。
- **検証メモ**: 完全に裏付けあり。grep で var(--hover) は styles.css の 1773/1827/2106/2146/2306/2403/2456/2482/2542/2759/3045/3086/3799 の13箇所、var(--danger) は 1252/2610/2763/3048/3049 の5箇所を確認。:root（styles.css:6-77）にも [data-theme='dark']（79-130）にも theme.ts にも定義なし。.sum-bar-track/.sum-auto-bar の background: var(--hover)（2455-2483）は無効宣言で透明、.mm-node.mm-issue の fill: var(--danger)（1251-1253）は SVG 既定の黒になるという実害の説明も正確。トークン2行の追加＋既存セレクタの整理のみで実装可能。
- **主な変更ファイル**: apps/desktop/src/styles.css

### 69. 開始/終了ノードの BPMN 風視覚区分
**影響: 中 / 規模: M**

- **問題**: 制御ノードのうち判断・合流は菱形だが、開始・終了は他の制御ノードと同じ白地ピル（.node.control、styles.css:998-1005）でラベル文字でしか区別できない。フロー図を顧客に提示する際、流れの起点と終点が一目で判別できない。DOM には control-start / control-end クラスが既に出力されている（FlowCanvas.tsx:1119）のに対応する CSS が存在しない。
- **提案**: CSS のみで差別化する: .node.control-start は --accent 塗り＋--on-accent 白文字のピル、.node.control-end は太枠＋二重線（border 2px + box-shadow: inset 0 0 0 2.5px var(--canvas-bg)）のピルにし、BPMN の『開始=塗り・終了=太枠』慣習に寄せる。顧客共有用の SVG/PNG 出力（flowSvg.ts）にも同じ描き分けを反映してビューと出力の見た目を一致させる。
- **検証メモ**: 確認済み: FlowCanvas.tsx:1119 で `node control control-${n.control}` が出力され、ControlKind は start/end/decision/merge（packages/core/src/model/types.ts:101）。CSS には .node.control-decision / .node.control-merge のみ存在（styles.css:1006-1015、2712-2716）で control-start / control-end のルールは皆無 — 開始・終了は素の白地ピル（.node.control 998-1005）のまま。flowSvg.ts でも start/end は decision 以外の汎用 rect 描画（206-220）。CSS 追加＋flowSvg.ts の分岐追加で実装可能。--accent/--on-accent/--canvas-bg は全て定義済み。
- **主な変更ファイル**: apps/desktop/src/styles.css, apps/desktop/src/flowSvg.ts

### 70. 情報密度トグル（コンパクト/標準）の追加
**影響: 中 / 規模: M**

- **問題**: 行の縦パディングが固定（.grid td 5px、.ft-in 6px、styles.css:464-468・3239-3248）で body も 13px 固定のため、数百工程規模のヒアリング案件では一画面に収まる行数が不足し、スクロール往復が増える。密度設定は useUI に存在しない（コードベースに density 関連の実装なし）。
- **提案**: :root[data-density='compact'] で切り替わる --cell-pad-y / --cell-font トークンを導入し、.grid td / .ft-in / .ft th 等のパディングとフォントをトークン参照に置換。SettingsDialog の『一般』タブに『表示密度: 標準/コンパクト』トグルを追加して useUI（localStorage 永続化）で管理。コンパクト時は縦パディング 2〜3px・フォント 12px とし、表示行数を約25〜30%増やす。
- **検証メモ**: 確認済み: src 全体に density / data-density / --cell-pad の実装は一切なし。.grid td padding 5px 8px（styles.css:465）、.ft-in padding 6px 7px（3245）、body 13px 固定（styles.css:148）も正確。useUI.ts には theme で『localStorage 永続＋ document.documentElement.dataset へ反映』のパターン（applyTheme、81-83行）が既にあり、data-density も同型で実装できる。SettingsDialog.tsx も存在し、追加先として自然。実装可能性高。
- **主な変更ファイル**: apps/desktop/src/styles.css, apps/desktop/src/ui/useUI.ts, apps/desktop/src/ui/SettingsDialog.tsx

### 71. ダークテーマ意味色（I/O・課題・付箋）の導出規則統一
**影響: 中 / 規模: M**

- **問題**: ダークの --in-fill/--out-fill/--red-fill/--amber-fill は rgba 直書き（styles.css:100-109）なのに、工程カラーは color-mix で base から導出（styles.css:942-946）と二重規則になっている。さらに同じ fill 値をキャンバス背景 #161b23 上の I/O アイコンとパネル #222936 上のチップの両方で使うため、片方に最適化するともう片方のコントラストが崩れる。
- **提案**: ダークの意味色 fill を color-mix(in srgb, var(--in) 22%, var(--panel)) 系の導出規則に統一し、キャンバス上に置かれる I/O アイコン・出所チップ用には --canvas-bg を混ぜる専用トークン（--in-fill-canvas / --out-fill-canvas）を追加して .io-icon 系セレクタで参照。導出ルール（混合率の基準）をトークン定義部のコメントに一本化し属人化を解消する。
- **検証メモ**: 確認済み: ダークの --in-fill/--out-fill/--red-fill/--amber-fill は rgba 直書き（styles.css:101-107）、一方ダークの工程カラーは color-mix(in srgb, var(--task-base) 24%, var(--node-task-bg)) で導出（942-946）という二重規則の指摘は正確。--in-fill はキャンバス上の .io-icon（788-806）とパネル上のチップ（.ft-iochip 3292-3293 ほか）の両方で共用されている点も事実。color-mix は既にコードベースで多用されており、トークン追加＋セレクタ差し替えのみで実装可能。視覚回帰の確認は必要だが構造的リスクなし。
- **主な変更ファイル**: apps/desktop/src/styles.css

### 72. 全項目表へのゼブラストライプ導入
**影響: 中 / 規模: S**

- **問題**: 全項目表 .ft は全セルが --panel 一色（styles.css:3173-3178）で、業務内容・システム・I/O・課題など多数列を横スクロールしながら読む際、行の追跡手段が極細罫線（--line-faint）とホバーしかない。1画面に数十行表示されると視線が行ずれしやすい。
- **提案**: --row-alt トークン（ライト: #f7f9fb、ダーク: #1f2631 程度）を追加し、.ft tbody tr:nth-child(even) td { background: var(--row-alt) } を導入。sticky 列（td.ft-sticky / ft-sticky-r）にも同じ規則を適用して横スクロール時も縞が途切れないようにし、背景の優先順位は sel > marked > hover > parent > zebra を維持する。アウトラインはツリーガイド線があるため対象外とする。
- **検証メモ**: 確認済み: styles.css に nth-child / --row-alt / zebra は一切なし。.ft td は全て background: var(--panel)（3173-3179）、sticky 列も同様（td.ft-sticky 3204-3206）。提案が挙げる優先順位の各クラスは実在する（tr.marked 3135-3140、tr.sel 3183、tr.parent 3186、hover 3180）。FullTable はフィルタ済み行をフラットに描画するため nth-child(even) で視覚的な縞は成立する。CSS のみで実装可能。
- **主な変更ファイル**: apps/desktop/src/styles.css

### 73. 親行の左エッジを粒度色でコーディング（表⇄フローの視覚言語統一）
**影響: 中 / 規模: S**

- **問題**: フロー図の親範囲バンドは --lvl-large（橙）/--lvl-medium（青）/--lvl-small（緑）で粒度を色分け済み（styles.css:841-854）なのに、表側の親行は粒度に関わらずアクセント一色の淡背景（styles.css:2959-2960、3186-3188）。どの粒度の親かは『粒度』列のテキストを読まないと分からず、2つのビューで色の意味が揃っていない。
- **提案**: TableView/FullTable の tr に lvl-large 等のクラスを付与し（t.level は既に取得済み、TableView.tsx:259-267 の className 配列に1要素追加）、親行へ box-shadow: inset 3px 0 0 color-mix(in srgb, var(--lvl-large) 60%, transparent) のような左エッジを追加。折りたたみキャレット色・フローのバンド色と同一トークンで紐づけ、『色＝粒度』の一貫した視覚言語を表と図の両方に通す。
- **検証メモ**: 確認済み: フローのバンドは粒度色で色分け済み（styles.css:841-854）だが、表の親行は .grid tr.is-parent > td（2959-2961）も .ft tbody tr.parent td（3186-3189）も accent-soft の color-mix 一色で粒度の区別なし。TableView.tsx の tr className 配列（258-266）に is-parent/is-child はあるが lvl-* はなく、t.level は同コンポーネントで既に使用中（316行 lvl-${t.level}）なのでクラス1要素追加で済むという見積もりは正確。--lvl-* トークンはダーク値も定義済み（111-112）。実装容易。
- **主な変更ファイル**: apps/desktop/src/TableView.tsx, apps/desktop/src/FullTable.tsx, apps/desktop/src/styles.css

### 74. 親範囲バンドラベルのチップ化（ノード重なり対策）
**影響: 中 / 規模: S**

- **問題**: .band-label（styles.css:855-862）は透明背景の素のテキスト（11px・--muted）で、バンド左上にノードやエッジが配置されると文字が重なって読めなくなる。バンド本体は color-mix の淡塗りで問題ないが、ラベルだけが視認性のボトルネック。長い工程名の省略処理もない。
- **提案**: ラベルに background: color-mix(in srgb, var(--canvas-bg) 85%, transparent)、padding 1px 8px、border-radius 999px の半透明チップ背景を与え、文字色は各バンドの粒度色（band-large→--lvl-large 等）に変更してバンドとの帰属を明示。max-width＋text-overflow: ellipsis で長名を省略し、SVG/PNG 出力（flowSvg.ts）にも同じチップ描画を反映する。
- **検証メモ**: 確認済み: .band-label は position:absolute・11px・color: var(--muted) の素テキストで背景・max-width・ellipsis なし（styles.css:855-862）。flowSvg.ts でもバンドラベルは素の <text>（90行）。CSS 側のチップ化は確実に可能。flowSvg.ts への反映は SVG にチップ背景 rect を足す形になりテキスト幅の概算が必要（同ファイルに既に近似描画の前例あり 276行）で、実装可能だが画面と完全一致ではなく近似になる点だけ留意。
- **主な変更ファイル**: apps/desktop/src/styles.css, apps/desktop/src/FlowCanvas.tsx, apps/desktop/src/flowSvg.ts

### 75. theme.ts ⇄ styles.css トークン同期の自動テスト
**影響: 中 / 規模: S**

- **問題**: theme.ts:4 の『styles.css の :root はこの値に合わせる』がコメント運用のみで、FLOW_LIGHT・TASK_COLORS と CSS 変数（--in-fill・--canvas-bg・--edge 等）の乖離を検出する仕組みがない。乖離すると画面表示と SVG/PNG 出力（顧客提出物）で色が食い違う事故になるが、現状は目視でしか気づけない。
- **提案**: styles.css の :root ブロックを正規表現でパースし、theme.ts に export した『CSS変数名⇄正準値』対応表（例: '--in-fill': FLOW_LIGHT.ioIn.fill）と突き合わせる vitest を apps/desktop/test に新設（既存の commandPalette.test.ts と同じ実行枠組み）。値が一致しない場合はテストが落ちて差分箇所を表示する。
- **主な変更ファイル**: apps/desktop/src/theme.ts, apps/desktop/src/styles.css

### 76. アイコンコンポーネントの size prop 化と線幅補正
**影響: 低 / 規模: M**

- **問題**: icons.tsx は全アイコン 16px 固定で、ChevronDown だけ width/height=13 をハードコードで上書き（icons.tsx:69-73）、フローパレット内では CSS で 14px に縮小（styles.css:2785-2787 .palette-act svg）と、サイズ変更手段が三様に分散。縮小表示時は strokeWidth 1.7 が相対的に細くなり、小サイズで線が掠れて見える。
- **提案**: Svg ベースコンポーネントに size?: number prop を追加し、strokeWidth を size に応じて補正（16px→1.7、13〜14px→1.9）する光学補正ロジックを一元化。ChevronDown の個別上書きと .palette-act svg の CSS 縮小を撤去して prop 指定に置換。あわせて icons.tsx 冒頭にアイコン名と用途の対応コメントを整備し、Undo/Redo のパスを鏡映ペアに統一する。
- **検証メモ**: 確認済み: icons.tsx の Svg ベースは width/height=16・strokeWidth=1.7 固定（4-22行）、ChevronDown だけ width={13} height={13} をハードコード（69-73行）、.flow-palette .palette-act svg が CSS で 14px に縮小（styles.css:2785-2788）— サイズ指定が三様に分散しているという現状認識は正確。size prop 化は SVGProps を spread している現構造にそのまま足せるため実装容易。Undo/Redo のパス統一・コメント整備は純粋に表記の問題で支障なし。
- **主な変更ファイル**: apps/desktop/src/ui/icons.tsx, apps/desktop/src/styles.css, apps/desktop/src/App.tsx

### 77. 菱形ノードのレンダリングシャープ化と影の統一
**影響: 低 / 規模: S**

- **問題**: .control-diamond polygon は vector-effect: non-scaling-stroke のみ（styles.css:1024-1029）で、頂点が整数ピクセル境界に乗ると 1.6px の輪郭線がにじむ。また工程ノードには box-shadow: var(--shadow) の影がある（styles.css:931）のに、菱形は SVG 描画のため影がなく、キャンバス上の立体感が要素間で不揃い。
- **提案**: FlowCanvas の菱形 polygon 頂点座標を 0.5px オフセットでスナップし、svg 要素に shape-rendering='geometricPrecision' を指定。さらに .control-diamond に CSS filter: drop-shadow() で --shadow 相当の影（ライト/ダーク別の数値定義）を与え、工程ノードとエレベーションを揃える。
- **検証メモ**: 確認済み: .control-diamond polygon は vector-effect: non-scaling-stroke のみ（styles.css:1024-1029）、.node.task には box-shadow: var(--shadow)（925-932）があり菱形には影がない。drop-shadow / shape-rendering はコードベースに styles.css:174 の1箇所（無関係の要素）しかない。filter: drop-shadow と shape-rendering の付与は確実に実装可能。ただし注意: キャンバスは CSS transform でズームするため 0.5px 頂点スナップが効くのは等倍時のみで、にじみ解消の効果はズーム率依存（実装は可能だが効果は部分的）。
- **主な変更ファイル**: apps/desktop/src/styles.css, apps/desktop/src/FlowCanvas.tsx

### 78. テーマ追従のカスタムスクロールバー
**影響: 低 / 規模: S**

- **問題**: 多数のスクロール領域（.outline-scroll・.ft-scroll・.insp-scroll・.issues-scroll・フローキャンバス）が OS 既定スクロールバーのままで、styles.css に ::-webkit-scrollbar の定義が一切ない。特にダークテーマでは Windows（WebView2）の明るいスクロールバーが画面内に複数本浮き、配色の統一感を損なう。
- **提案**: ::-webkit-scrollbar { width/height: 10px }、thumb は color-mix(in srgb, var(--faint) 45%, transparent)・hover で 70% に濃く・border-radius 5px、track は透明、::-webkit-scrollbar-corner は --panel とするスタイルをグローバルに追加（Tauri の WebKit/WebView2 両対応）。color-scheme 指定は既存のため OS ネイティブ部分との齟齬もない。
- **主な変更ファイル**: apps/desktop/src/styles.css

### 79. ステータスバーのキーボードヒントの省略・応答対応
**影響: 低 / 規模: S**

- **問題**: .st-hint は white-space: nowrap の .st-item（styles.css:1950-1955）内にあり、折り返し・省略の対策がない。ウィンドウ幅が狭い場合や日本語ヒント文が長い場合、高さ 26px 固定のステータスバーから他の項目（保存状態ドット・工数合計）を押し出すか、はみ出す。
- **提案**: .st-hint に min-width: 0 / overflow: hidden / text-overflow: ellipsis を与えて省略表示にし、~900px 以下のメディアクエリではヒント自体を display: none に（『? キーで一覧』の title 属性は StatusBar.tsx:60 に既存のため情報は失われない）。保存状態・工数など業務上重要な左側項目の表示を常に優先する。
- **主な変更ファイル**: apps/desktop/src/styles.css, apps/desktop/src/ui/StatusBar.tsx

## アクセシビリティ（1案）

### 80. --faint 文字色のコントラスト改善（WCAG AA 監査と是正）
**影響: 高 / 規模: M**

- **問題**: テーブルヘッダ .grid th（11px・uppercase）が --faint #98a1af を白パネル上で使用しコントラスト比 2.61:1（AA 基準 4.5:1 未達、styles.css:451-463）。ライトの --amber #b9820a × --amber-fill #f6ecc6 も 2.83:1、ダークの --faint #6b7585 × --panel #222936 は 3.13:1。長時間ヒアリング内容を読み書きする業務アプリとして、最も頻繁に視認する列見出しが基準未達なのは疲労・可読性に直結する。
- **提案**: --faint をライト #7a8494 前後・ダーク #7e8a9c 前後（4.5:1 付近）へ引き上げ、罫線・装飾専用には別トークン --faint-deco を分離して現値を移す。テーブルヘッダ（.grid th / .ft th）は --muted に統一。amber 系の文字用途は既に AA を満たす --amber-ink（5.72:1）へ寄せる。検証として主要『文字色×背景色』ペアのコントラスト比を計算する vitest を apps/desktop/test に追加し、回帰を防ぐ。
- **検証メモ**: 主張の核は正しい: .grid th は color: var(--faint)（styles.css:451-463）で、--faint はライト #98a1af（:root:15）/ダーク #6b7585（:97）。コントラスト是正やコントラスト計算テストは存在しない（apps/desktop/test に contrast 関連テストなし）。ただし1点不正確: .ft th は既に color: var(--muted)（styles.css:3167）なので『.ft th を --muted に統一』は不要で、変更対象は .grid th のみ。vitest 環境は apps/desktop/test に既存13ファイルがあり追加は容易。なお『theme.ts ⇄ styles.css トークン同期の自動テスト』案とはテスト対象が異なり重複ではない。
- **主な変更ファイル**: apps/desktop/src/styles.css, apps/desktop/src/theme.ts
