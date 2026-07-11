/**
 * Setup snippet generator for the Veritrail MCP server.
 *
 * Popular MCP hosts each ingest a slightly different shape of configuration:
 * Claude Desktop and Cursor want a JSON block keyed by `mcpServers`, while
 * Claude Code is driven by a one-shot CLI command. This helper emits whichever
 * snippet the user asks for so `npx @veritrail/mcp-server --setup` is enough
 * to copy/paste into any supported host.
 */

/**
 * Identifier for a supported MCP host. `undefined` means "print snippets for
 * every JSON-based host we know about" so a fresh user sees the full menu.
 */
export type SetupHost = 'claude-desktop' | 'cursor' | 'claude-code' | undefined;

/**
 * Environment values to interpolate into the generated snippet. Both fields
 * are optional; missing values are replaced with a clearly-marked TODO so the
 * user knows exactly which placeholder to swap.
 */
export interface SetupEnv {
  /** Veritrail API key (e.g. `vt_live_...`). */
  apiKey?: string;
  /** Veritrail backend URL. Defaults to the public cloud endpoint. */
  apiUrl?: string;
}

const DEFAULT_API_URL = 'https://api.veritrail.io';
const TODO_API_KEY = 'TODO_REPLACE_WITH_VERITRAIL_API_KEY';

/**
 * Render the JSON config snippet used by Claude Desktop and Cursor.
 *
 * The same shape works for both hosts; only the surrounding prose changes.
 */
function renderJsonSnippet(env: SetupEnv): string {
  const config = {
    mcpServers: {
      veritrail: {
        command: 'npx',
        args: ['-y', '@veritrail/mcp-server'],
        env: {
          VERITRAIL_API: env.apiUrl ?? DEFAULT_API_URL,
          VERITRAIL_API_KEY: env.apiKey ?? TODO_API_KEY,
        },
      },
    },
  };
  return JSON.stringify(config, null, 2);
}

/**
 * Render the bash one-liner that registers the Veritrail server with the
 * `claude` CLI (Claude Code).
 */
function renderClaudeCodeSnippet(env: SetupEnv): string {
  const apiKey = env.apiKey ?? TODO_API_KEY;
  const apiUrl = env.apiUrl ?? DEFAULT_API_URL;
  return [
    'claude mcp add veritrail \\',
    '  --command "npx -y @veritrail/mcp-server" \\',
    `  --env VERITRAIL_API_KEY=${apiKey} \\`,
    `  --env VERITRAIL_API=${apiUrl}`,
  ].join('\n');
}

/**
 * Produce the setup snippet for the requested host.
 *
 * - `'claude-desktop'` and `'cursor'` each return the JSON block annotated for
 *   that host.
 * - `'claude-code'` returns the bash one-liner.
 * - `undefined` returns sections for every JSON-based host so a fresh user can
 *   see the whole menu in one go.
 */
export function printSetup(host: SetupHost, env: SetupEnv): string {
  if (host === 'claude-code') {
    return ['# Claude Code: register the Veritrail MCP server', renderClaudeCodeSnippet(env)].join(
      '\n',
    );
  }

  const jsonBlock = renderJsonSnippet(env);

  if (host === 'claude-desktop') {
    return ['# Claude Desktop', '# Paste into claude_desktop_config.json', jsonBlock].join('\n');
  }

  if (host === 'cursor') {
    return [
      '# Cursor',
      '# Paste into ~/.cursor/mcp.json (or the Cursor Settings > MCP panel)',
      jsonBlock,
    ].join('\n');
  }

  return [
    '# Claude Desktop',
    '# Paste into claude_desktop_config.json',
    jsonBlock,
    '',
    '# Cursor',
    '# Paste into ~/.cursor/mcp.json (or the Cursor Settings > MCP panel)',
    jsonBlock,
  ].join('\n');
}
