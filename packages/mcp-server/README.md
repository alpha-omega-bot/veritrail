# @veritrail/mcp-server

**Plug-and-play AI agent governance for any MCP host** — Claude Code, Claude Desktop, Cursor, Continue.dev, or any future tool that speaks the [Model Context Protocol](https://modelcontextprotocol.io). Tamper-evident audit, permissions, spend caps, and incident forensics with two lines of config.

## Why

If your editor or assistant supports MCP, your agent already has tool-calling. But the actions it takes — searching the web, writing files, calling paid APIs — happen unaudited and uncapped. This server turns Veritrail into MCP tools so every interesting agent action is **gated by policy, capped by budget, and recorded on a hash-chained ledger** without a single line of integration code.

## Install

```bash
npx @veritrail/mcp-server
```

The first run prints the config snippet to paste into your MCP host.

Need just the snippet? Run `npx @veritrail/mcp-server --setup` to print the Claude Desktop and Cursor JSON, or `npx @veritrail/mcp-server --setup --host claude-code` for the `claude mcp add` one-liner.

## Configure (Claude Code / Claude Desktop)

Add to your `claude_desktop_config.json` (or equivalent):

```json
{
  "mcpServers": {
    "veritrail": {
      "command": "npx",
      "args": ["-y", "@veritrail/mcp-server"],
      "env": {
        "VERITRAIL_API": "https://api.veritrail.io",
        "VERITRAIL_API_KEY": "vt_live_...",
        "VERITRAIL_AGENT_ID": "my-agent"
      }
    }
  }
}
```

## Configure (Cursor / Continue.dev)

Same pattern — point `command` at `npx @veritrail/mcp-server` and pass the env vars.

## Tools Exposed

| Tool                         | Use when                                                                                 |
| ---------------------------- | ---------------------------------------------------------------------------------------- |
| `veritrail.record_decision`  | The agent picks one option over another and the choice should be auditable.              |
| `veritrail.check_permission` | Before any side-effecting action (network, file write, spend). Deny-by-default.          |
| `veritrail.request_budget`   | Before a paid API call. Hard-stops if the budget is exhausted.                           |
| `veritrail.note_evidence`    | When the agent uses external content (web page, doc) — content is hashed for provenance. |
| `veritrail.query_audit`      | Reviewing past actions, building context, investigating a correlation id.                |
| `veritrail.verify_integrity` | Proving to a user or auditor that no event was altered.                                  |

## Free Tier

10,000 events/month per project, free forever. [Sign up](https://veritrail.io).

## Self-hosted

Point `VERITRAIL_API` at your own deployment. See the main [README](../../README.md) for setup.
