// A minimal, well-behaved stdio MCP server: one tool, clean handshake.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

const server = new McpServer({ name: 'ok-server', version: '1.2.3' });

server.registerTool('ping', { description: 'Replies with pong.' }, async () => ({
  content: [{ type: 'text', text: 'pong' }]
}));

await server.connect(new StdioServerTransport());
