/**
 * @veritrail/mcp-server
 *
 * Model Context Protocol (MCP) server that exposes Veritrail governance
 * primitives to any MCP-compatible host: Claude Code, Claude Desktop, Cursor,
 * Continue.dev, and any future tool that speaks MCP.
 *
 * Distribution funnel: agents using these hosts get tamper-evident governance
 * — audit, permissions, spend, forensics — with no library integration. The
 * host calls the MCP tools defined here over JSON-RPC stdio; the server
 * forwards each call to a Veritrail backend (cloud or self-hosted) via the
 * standard SDK.
 */

export { createMcpServer, type McpServerOptions } from './server.js';
export { TOOLS, type McpTool, type McpToolResult } from './tools.js';
export { runStdio } from './stdio.js';
export { printSetup, type SetupHost, type SetupEnv } from './setup.js';
