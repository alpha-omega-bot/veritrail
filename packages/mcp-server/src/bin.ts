#!/usr/bin/env node
import { printSetup, type SetupHost } from './setup.js';
import { runStdio } from './stdio.js';

/**
 * Parse a tiny subset of CLI flags. We intentionally avoid a flag-parsing
 * dependency: the surface is two flags, and bootstrap code should not pull a
 * package off npm just to read its own argv.
 */
function parseArgs(argv: readonly string[]): { setup: boolean; host: SetupHost } {
  let setup = false;
  let host: SetupHost = undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--setup') {
      setup = true;
    } else if (arg === '--host') {
      const value = argv[i + 1];
      if (value === 'claude-desktop' || value === 'cursor' || value === 'claude-code') {
        host = value;
        i++;
      }
    }
  }
  return { setup, host };
}

const { setup, host } = parseArgs(process.argv.slice(2));

const baseUrl = process.env['VERITRAIL_API'] ?? undefined;
const apiKey = process.env['VERITRAIL_API_KEY'] ?? undefined;
const defaultAgentId = process.env['VERITRAIL_AGENT_ID'] ?? undefined;

if (setup) {
  process.stdout.write(
    printSetup(host, {
      ...(apiKey !== undefined ? { apiKey } : {}),
      ...(baseUrl !== undefined ? { apiUrl: baseUrl } : {}),
    }) + '\n',
  );
  process.exit(0);
}

runStdio({
  ...(baseUrl !== undefined ? { baseUrl } : {}),
  ...(apiKey !== undefined ? { apiKey } : {}),
  ...(defaultAgentId !== undefined ? { defaultAgentId } : {}),
}).catch((error: unknown) => {
  const message = error instanceof Error ? error.message : 'unknown error';
  process.stderr.write(`@veritrail/mcp-server: ${message}\n`);
  process.exit(1);
});
