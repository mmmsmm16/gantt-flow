// MCP プロンプト。業務ヒアリング → 工程表/業務フロー化の進め方を AI に与えるテンプレート。
// gantt-flow のツール群（add_task / add_dependency / update_task_detail …）の使い方も示す。
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

export function registerPrompts(server: McpServer): void {
  server.registerPrompt(
    'build_from_minutes',
    {
      title: '議事録/ヒアリングメモから工程表を作る',
      description: '会議の議事録や文字起こし・ヒアリングメモなど非構造テキストから、業務工程を抽出して apply_batch で一気に組む手順を提示する（暗黙知の形式知化を主眼）。',
      argsSchema: {
        businessName: z.string().optional().describe('対象業務（例: 受発注、月次決算）'),
      },
    },
    ({ businessName }) => ({
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text: [
              `これから渡す議事録/ヒアリングメモ（${businessName ? `「${businessName}」の` : ''}業務）を読み、gantt-flow の工程表・業務フローに落とし込みます。`,
              '',
              '抽出の方針（暗黙知の形式知化が施策の主役。お金/効果額より、工数・リードタイム・手順・難易度を重視）:',
              '1. 業務ステップを洗い出し、粒度（large=業務全体 / medium=工程 / small / detail=実作業）に分類する。',
              '2. 時間的な前後関係を依存（前工程→後工程）として捉える。',
              '3. 各ステップの担当（部署/人）、手順(how)、工数（分=タッチタイム）、リードタイム（日=待ち含む）、難易度（H=ベテラン依存/M/L=誰でも）、自動化区分、入出力（帳票/情報）、課題を、テキストから読み取れる範囲で拾う。',
              '4. テキストに無い数値（工数・LT 等）は推測で埋めず、未設定のままにする（後で audit_completeness が「聞くべき質問」を出す）。',
              '',
              '組み立て方:',
              '- new_project（または既存を open_project）した上で、抽出結果を **apply_batch で一括投入**する。add_task に ref を付け、後続の add_dependency / set_detail / add_io / add_issue から ref で参照する。担当は assignee 名で指定すれば自動作成される。',
              '- まず apply_batch を dryRun:true で実行してツリーを確認 → 問題なければ dryRun なしで確定する。',
              '- 投入後、get_flow_mermaid で図を見せ、audit_completeness で未入力（手順/難易度/工数/LT 等）と「次に聞くべき質問」を提示し、ヒアリングを促す。',
              '',
              '不明点や曖昧さ（担当が読み取れない、順序が不確か等）は推測で確定せず、ユーザーに質問してから埋めること。',
            ].join('\n'),
          },
        },
      ],
    }),
  );


  server.registerPrompt(
    'model_business_process',
    {
      title: '業務ヒアリングから工程表を作る',
      description: '対象業務をヒアリングして gantt-flow の工程表・業務フローに落とし込む手順を提示する。',
      argsSchema: {
        businessName: z.string().optional().describe('対象業務の名前（例: 受発注、月次決算）'),
      },
    },
    ({ businessName }) => ({
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text: [
              `あなたは業務改革コンサルタントです。${businessName ? `「${businessName}」` : 'ある業務'}を gantt-flow の工程表と業務フロー図に落とし込みます。`,
              '',
              '進め方:',
              '1. new_project で空のプロジェクトを作る（または open_project で既存を開く）。',
              '2. 関係者・部署を add_assignee で登録する。',
              '3. 大きな流れを large/medium の工程として add_task で作り、add_dependency で順序（前→後）を繋ぐ。',
              '4. 各工程を get_task で確認しつつ、update_task_detail で As-Is（手順 how・工数 effortMinutes[分]・リードタイム ltDays[日]・自動化 automation・難易度 difficulty）を埋める。',
              '5. 帳票・情報の受け渡しは add_io_item、業務課題は add_issue_item で記録する。',
              '6. あるべき姿は update_task_tobe で To-Be 差分（工数削減・自動化・難易度の引き下げ）を入れ、compare_scenarios で効果を確認する。',
              '',
              'ヒアリングは一度に詰め込まず、不明点は質問で埋めてください。各工程の「分」と「日」を必ず区別すること（工数=実作業のタッチタイム、LT=待ちを含む経過日数）。',
            ].join('\n'),
          },
        },
      ],
    }),
  );
}
