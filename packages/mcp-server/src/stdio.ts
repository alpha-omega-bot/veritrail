import { createInterface } from 'node:readline';

import { createMcpServer, type McpServerOptions } from './server.js';

/**
 * Minimal MCP stdio transport.
 *
 * The MCP spec uses newline-delimited JSON-RPC 2.0 over stdio. We implement
 * the four methods MCP hosts require to discover and call tools:
 *
 *   - `initialize`          handshake (server announces capabilities)
 *   - `tools/list`          list tool definitions
 *   - `tools/call`          execute a tool
 *   - `notifications/initialized` host signals it's ready (no-op response)
 *
 * Anything else gets a `Method not found` error per JSON-RPC. This keeps the
 * surface tiny: an MCP host can drop us into its config and immediately call
 * tools without a separate handshake library.
 */
export async function runStdio(options: McpServerOptions = {}): Promise<void> {
  const server = createMcpServer(options);
  const rl = createInterface({ input: process.stdin });

  const send = (msg: unknown): void => {
    process.stdout.write(JSON.stringify(msg) + '\n');
  };

  for await (const line of rl) {
    if (!line.trim()) continue;

    let req: { jsonrpc: string; id?: number | string; method: string; params?: unknown };
    try {
      req = JSON.parse(line);
    } catch {
      send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
      continue;
    }

    try {
      switch (req.method) {
        case 'initialize': {
          send({
            jsonrpc: '2.0',
            id: req.id,
            result: {
              protocolVersion: '2024-11-05',
              capabilities: { tools: {} },
              serverInfo: { name: '@veritrail/mcp-server', version: '0.1.0' },
            },
          });
          break;
        }
        case 'notifications/initialized': {
          // Notifications have no response per JSON-RPC 2.0.
          break;
        }
        case 'tools/list': {
          send({ jsonrpc: '2.0', id: req.id, result: { tools: server.listTools() } });
          break;
        }
        case 'tools/call': {
          const params = req.params as { name?: string; arguments?: unknown } | undefined;
          if (!params?.name) {
            send({
              jsonrpc: '2.0',
              id: req.id,
              error: { code: -32602, message: 'tools/call requires `name`' },
            });
            break;
          }
          const result = await server.callTool(params.name, params.arguments ?? {});
          send({ jsonrpc: '2.0', id: req.id, result });
          break;
        }
        default: {
          send({
            jsonrpc: '2.0',
            id: req.id ?? null,
            error: { code: -32601, message: `Method not found: ${req.method}` },
          });
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'unknown error';
      send({
        jsonrpc: '2.0',
        id: req.id ?? null,
        error: { code: -32603, message: `Internal error: ${message}` },
      });
    }
  }
}
