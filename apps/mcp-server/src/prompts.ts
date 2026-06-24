// MCP プロンプト。業務ヒアリング → 工程表/業務フロー化の進め方を AI に与えるテンプレート。
// gantt-flow のツール群（add_task / add_dependency / update_task_detail …）の使い方も示す。
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

export function registerPrompts(server: McpServer): void {
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
