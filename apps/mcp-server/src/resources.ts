// MCP リソース。現在開いているプロジェクトを読み取り専用で公開する（クライアントが添付できる）。
// 未オープン時は current() が throw → 読み取りエラーとしてクライアントへ伝わる。
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { projectToCsv } from '@gantt-flow/core';
import type { Workspace } from './session.js';

export function registerResources(server: McpServer, ws: Workspace): void {
  server.registerResource(
    'project-json',
    'gantt-flow://project',
    {
      title: '現在のプロジェクト (JSON)',
      description: '開いている gantt-flow プロジェクトの Project ドキュメント全体。',
      mimeType: 'application/json',
    },
    (uri) => ({
      contents: [
        { uri: uri.href, mimeType: 'application/json', text: JSON.stringify(ws.current().project) },
      ],
    }),
  );

  server.registerResource(
    'table-csv',
    'gantt-flow://table.csv',
    {
      title: '工程表 (CSV)',
      description: '開いているプロジェクトの工程表を CSV(RFC4180) で。',
      mimeType: 'text/csv',
    },
    (uri) => ({
      contents: [{ uri: uri.href, mimeType: 'text/csv', text: projectToCsv(ws.current().project) }],
    }),
  );
}
