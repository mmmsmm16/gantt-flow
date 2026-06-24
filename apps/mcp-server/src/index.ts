// gantt-flow MCP サーバのエントリ（stdio）。
// 重要: stdout は JSON-RPC 専用。ログは必ず stderr(console.error) に出す。
// 起動時、環境変数 GANTT_FLOW_PROJECT か第1引数にパスがあればそのプロジェクトを自動で開く。
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createServer } from './server.js';

async function main(): Promise<void> {
  const { server, ws } = createServer();

  const initial = process.env.GANTT_FLOW_PROJECT ?? process.argv[2];
  if (initial) {
    try {
      const s = await ws.open(initial);
      console.error(`[gantt-flow-mcp] opened: ${s.path}`);
    } catch (e) {
      console.error(`[gantt-flow-mcp] failed to open ${initial}: ${e instanceof Error ? e.message : e}`);
    }
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('[gantt-flow-mcp] ready on stdio');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
