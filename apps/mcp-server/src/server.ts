// McpServer の組み立て。ツール・リソース・プロンプトを登録して返す。トランスポートは index.ts。
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Workspace } from './session.js';
import { registerTools } from './tools.js';
import { registerResources } from './resources.js';
import { registerPrompts } from './prompts.js';

export function createServer(): { server: McpServer; ws: Workspace } {
  const server = new McpServer({ name: 'gantt-flow', version: '0.0.0' });
  const ws = new Workspace();
  registerTools(server, ws);
  registerResources(server, ws);
  registerPrompts(server);
  return { server, ws };
}
