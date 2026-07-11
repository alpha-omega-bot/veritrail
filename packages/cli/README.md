# @veritrail/cli

Command-line interface for operating and inspecting a **Veritrail** ledger — the tamper-evident system of record for AI agent governance.

## Installation

```bash
npm install -g @veritrail/cli
# or run directly with npx
npx @veritrail/cli --help
```

## Commands

### Ledger Operations

```bash
# Verify ledger integrity
veritrail verify <ledger-path>

# Query events
veritrail query <ledger-path> [options]
  --type <event-type>    Filter by event type
  --agent <agent-id>     Filter by agent
  --after <timestamp>    Events after this time
  --limit <n>            Max events to return

# Append an event (for testing/development)
veritrail append <ledger-path> --type <type> --data <json>
```

### Policy Management

```bash
# List active policies
veritrail policy list

# Add a new policy
veritrail policy add <policy.json>

# Remove a policy
veritrail policy remove <policy-id>
```

### Budget Operations

```bash
# Show current spend status
veritrail budget status

# Set budget limits
veritrail budget set <scope> --limit <usd>

# Reset budget for a period
veritrail budget reset <scope>
```

## Configuration

The CLI reads from `~/.veritrail/config.json`:

```json
{
  "apiEndpoint": "http://localhost:8787",
  "apiKey": "your-api-key",
  "defaultLedgerPath": "./veritrail-ledger"
}
```

Or use environment variables:

```bash
export VERITRAIL_API=http://localhost:8787
export VERITRAIL_API_KEY=your-key
export VERITRAIL_LEDGER=/path/to/ledger
```

## Development

```bash
# Build from source
pnpm run build

# Run locally
pnpm start -- verify ./test-ledger

# Run tests
pnpm test
```

## Exit Codes

- `0` - Success
- `1` - Validation error or invalid arguments
- `2` - Integrity check failed (tamper detected)
- `3` - Storage error (file not found, permission denied)
- `4` - Network error (API unreachable)

## Examples

### Verify a ledger

```bash
veritrail verify ./production-ledger
# Output: ✓ Integrity verified: 1,287 events, hash a3f9c1d2...
```

### Query recent errors

```bash
veritrail query ./production-ledger \
  --severity error \
  --after 2026-06-01 \
  --limit 10
```

### Add a policy

```bash
veritrail policy add - <<EOF
{
  "name": "block-unallowlisted-hosts",
  "effect": "deny",
  "match": {
    "actionTypes": ["network.egress"],
    "resources": ["!allowlist:*"]
  }
}
EOF
```

## License

Apache-2.0 © The Veritrail Authors
