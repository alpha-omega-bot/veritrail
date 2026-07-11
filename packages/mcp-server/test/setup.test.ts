import { describe, expect, it } from 'vitest';

import { printSetup } from '../src/setup.js';

/**
 * Extract every top-level JSON object embedded in a snippet by walking the
 * string and balancing braces. Each snippet is plain text with shell-style
 * comment lines around one or more JSON blocks, so brace-counting is enough.
 */
function extractJsonBlocks(snippet: string): unknown[] {
  const blocks: unknown[] = [];
  let depth = 0;
  let start = -1;
  for (let i = 0; i < snippet.length; i++) {
    const ch = snippet[i];
    if (ch === '{') {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0 && start !== -1) {
        blocks.push(JSON.parse(snippet.slice(start, i + 1)));
        start = -1;
      }
    }
  }
  return blocks;
}

function extractJson(snippet: string): unknown {
  const blocks = extractJsonBlocks(snippet);
  if (blocks.length === 0) throw new Error('no JSON object found in snippet');
  return blocks[0];
}

describe('printSetup', () => {
  it('returns both Claude Desktop and Cursor snippets by default', () => {
    const output = printSetup(undefined, {});
    expect(output).toContain('Claude Desktop');
    expect(output).toContain('Cursor');
    expect(output).toContain('claude_desktop_config.json');
    expect(output).toContain('.cursor/mcp.json');
    expect(output).toContain('@veritrail/mcp-server');
  });

  it('emits the bash one-liner for claude-code', () => {
    const output = printSetup('claude-code', { apiKey: 'vt_test_xyz' });
    expect(output).toContain('claude mcp add veritrail');
    expect(output).toContain('--command "npx -y @veritrail/mcp-server"');
    expect(output).toContain('--env VERITRAIL_API_KEY=vt_test_xyz');
    expect(output).not.toContain('mcpServers');
  });

  it('interpolates env vars into the JSON snippet', () => {
    const output = printSetup('claude-desktop', {
      apiKey: 'vt_live_abc123',
      apiUrl: 'https://veritrail.internal',
    });
    const parsed = extractJson(output) as {
      mcpServers: { veritrail: { env: Record<string, string> } };
    };
    expect(parsed.mcpServers.veritrail.env['VERITRAIL_API_KEY']).toBe('vt_live_abc123');
    expect(parsed.mcpServers.veritrail.env['VERITRAIL_API']).toBe('https://veritrail.internal');
  });

  it('shows a TODO placeholder when apiKey is missing', () => {
    const desktop = printSetup('claude-desktop', {});
    expect(desktop).toContain('TODO_REPLACE_WITH_VERITRAIL_API_KEY');
    const code = printSetup('claude-code', {});
    expect(code).toContain('TODO_REPLACE_WITH_VERITRAIL_API_KEY');
  });

  it('produces parseable JSON for every JSON-based host', () => {
    for (const host of ['claude-desktop', 'cursor', undefined] as const) {
      const output = printSetup(host, { apiKey: 'vt_test_key' });
      const blocks = extractJsonBlocks(output) as Array<{
        mcpServers: {
          veritrail: { command: string; args: string[]; env: Record<string, string> };
        };
      }>;
      expect(blocks.length).toBeGreaterThan(0);
      for (const parsed of blocks) {
        expect(parsed.mcpServers.veritrail.command).toBe('npx');
        expect(parsed.mcpServers.veritrail.args).toEqual(['-y', '@veritrail/mcp-server']);
        expect(parsed.mcpServers.veritrail.env['VERITRAIL_API_KEY']).toBe('vt_test_key');
      }
    }
  });

  it('defaults the API URL to the public cloud endpoint when omitted', () => {
    const output = printSetup('cursor', { apiKey: 'vt_test_key' });
    const parsed = extractJson(output) as {
      mcpServers: { veritrail: { env: Record<string, string> } };
    };
    expect(parsed.mcpServers.veritrail.env['VERITRAIL_API']).toBe('https://api.veritrail.io');
  });

  it('annotates the cursor snippet with the cursor-specific config path', () => {
    const output = printSetup('cursor', {});
    expect(output).toContain('Cursor');
    expect(output).toContain('.cursor/mcp.json');
    expect(output).not.toContain('Claude Desktop');
  });
});
